// The project's ports: who listens (netstat, lsof, ss), whose process it is, Docker Compose and ports that went down.
import type { DownPort, ServicePort } from '../../types'

const SYSTEM_PID = 4
const MAX_PORT = 65535
const MAX_SERVICE_NAME = 24
const FIRST_EPHEMERAL_PORT = 49152
const DOWN_PORT_TTL_MS = 15 * 60_000

// Leaves out what is not a dev server: system PIDs (0 to 4) and ephemeral ports.
function keepDevPort(found: Map<number, number>, port: number, pid: number): void {
  if (pid > SYSTEM_PID && port > 0 && port < FIRST_EPHEMERAL_PORT) found.set(port, pid)
}

function toListeners(found: Map<number, number>): { port: number; pid: number }[] {
  return [...found].map(([port, pid]) => ({ port, pid }))
}

// Output of `netstat -ano` (Windows): port and PID of each listener (TCP and TCPv6; UDP has no LISTENING).
// The PIDs become the filter of a PowerShell script: hence digits only (\d+), never text.
export function parseNetstat(stdout: string): { port: number; pid: number }[] {
  const found = new Map<number, number>()
  for (const match of stdout.matchAll(/[:.](\d+)\s+\S+\s+LISTENING\s+(\d+)/g)) {
    keepDevPort(found, Number(match[1]), Number(match[2]))
  }
  return toListeners(found)
}

// Output of `lsof -nP -iTCP -sTCP:LISTEN -F pn` (macOS and Linux): "p<pid>" lines followed by "n<address>:<port>".
export function parseLsof(stdout: string): { port: number; pid: number }[] {
  const found = new Map<number, number>()
  let pid = 0
  for (const row of stdout.split(/\r?\n/)) {
    if (row.startsWith('p')) pid = Number(row.slice(1))
    if (row.startsWith('n')) keepDevPort(found, Number(row.slice(row.lastIndexOf(':') + 1)), pid)
  }
  return toListeners(found)
}

// Output of `ss -ltnpH` (Linux without lsof): '... 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=123,fd=3))'.
export function parseSs(stdout: string): { port: number; pid: number }[] {
  const found = new Map<number, number>()
  for (const row of stdout.split(/\r?\n/)) {
    const local = row.trim().split(/\s+/)[3] ?? ''
    const pid = /pid=(\d+)/.exec(row)?.[1]
    if (pid !== undefined) keepDevPort(found, Number(local.slice(local.lastIndexOf(':') + 1)), Number(pid))
  }
  return toListeners(found)
}

// Output of `ps -o pid=,args= -p <pids>` (macOS and Linux): "  123 node /proj/node_modules/.bin/vite".
export function parsePs(stdout: string): Map<number, string> {
  const lines = new Map<number, string>()
  for (const row of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row)
    if (match?.[1] !== undefined) lines.set(Number(match[1]), match[2] ?? '')
  }
  return lines
}

// PowerShell output: "PID<tab>command line", one per process.
export function parseCommandLines(stdout: string): Map<number, string> {
  const lines = new Map<number, string>()
  for (const row of stdout.split(/\r?\n/)) {
    const [pid, ...command] = row.split('\t')
    if (pid && /^\d+$/.test(pid.trim())) lines.set(Number(pid), command.join('\t'))
  }
  return lines
}

// A Windows path (drive letter or \\server): case-insensitive, with \ equal to /.
// On Linux and macOS, Proj and proj are different folders and \ is a valid name character.
function isWindowsPath(path: string): boolean {
  return /^([a-zA-Z]:|\\\\)/.test(path)
}

function normalizePath(path: string, isWindows: boolean): string {
  const unified = isWindows ? path.replace(/\\/g, '/').toLowerCase() : path
  return unified.normalize('NFC').replace(/\/+$/, '')
}

export function isSamePath(a: string, b: string): boolean {
  const isWindows = isWindowsPath(a) || isWindowsPath(b)
  return normalizePath(a, isWindows) === normalizePath(b, isWindows)
}

// A process belongs to the project when its command line mentions a path inside the root
// (e.g. C:\proj\node_modules\next\...\start-server.js).
// The root must start a path in the line (at the start, or after a space, quote or "="), not sit inside
// another one: with the root /srv/proj, "node /other/srv/proj/server.js" is not the project's.
export function isProjectCommand(command: string, root: string): boolean {
  const isWindows = isWindowsPath(root)
  const line = normalizePath(command, isWindows)
  const prefix = `${normalizePath(root, isWindows)}/`
  // Root "/" (or "C:\"): every process would be "inside" it.
  if (prefix.length <= 3) return false
  for (let at = line.indexOf(prefix); at >= 0; at = line.indexOf(prefix, at + 1)) {
    if (at === 0 || /[\s"'=]/.test(line.charAt(at - 1))) return true
  }
  return false
}

// Server kind from the command line; with no guess, only the port shows.
const WEB_SERVER = /\b(?:next|vite|astro|nuxt|svelte-kit|remix|webpack-dev-server|react-scripts)\b/i
const API_SERVER = /\b(?:nest|uvicorn|gunicorn|hypercorn|fastapi|flask|manage\.py|express|fastify|hono|rails|puma)\b/i

export function serviceKind(command: string): string | undefined {
  if (WEB_SERVER.test(command)) return 'web'
  if (API_SERVER.test(command)) return 'api'
  return undefined
}

export function projectPorts(
  listeners: { port: number; pid: number }[],
  commands: Map<number, string>,
  root: string,
): ServicePort[] {
  return listeners
    .filter(({ pid }) => isProjectCommand(commands.get(pid) ?? '', root))
    .map(({ port, pid }) => ({ port, label: serviceKind(commands.get(pid) ?? '') }))
}

// `docker ps` format for Compose containers: project folder, service and ports, tab-separated.
// Compose labels every container with these; reading them through `docker ps` opens no repo file
// (`docker compose ps` read compose.yaml, .env and includes, which can fetch things from the network).
export const DOCKER_PS_FORMAT =
  '{{.Label "com.docker.compose.project.working_dir"}}{{"\\t"}}{{.Label "com.docker.compose.service"}}{{"\\t"}}{{.Ports}}'

// Output of `docker ps --filter label=com.docker.compose.project --format DOCKER_PS_FORMAT`:
// "C:\proj<tab>db<tab>0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp". Only this folder's containers;
// the label is the service name. A port without "->" is not published on the host and is left out.
export function parseDockerPs(stdout: string, root: string): ServicePort[] {
  return stdout.split(/\r?\n/).flatMap(row => {
    const [workingDir, service, ports] = row.split('\t')
    if (workingDir === undefined || ports === undefined || !isSamePath(workingDir, root)) return []
    const label = serviceName(service)
    return [...ports.matchAll(/:(\d+)->/g)]
      .map(m => Number(m[1]))
      .filter(port => Number.isInteger(port) && port > 0 && port <= MAX_PORT)
      .map(port => ({ port, label }))
  })
}

// The service name comes from the repo's compose.yaml (which may be someone else's), through the container
// label: only what is really a name is kept.
function serviceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[^\w.-]/g, '').slice(0, MAX_SERVICE_NAME)
  return clean === '' ? undefined : clean
}

// Merges the sources without repeating a port; the first source with a label wins.
export function mergePorts(...sources: ServicePort[][]): ServicePort[] {
  const byPort = new Map<number, ServicePort>()
  for (const item of sources.flat()) {
    const known = byPort.get(item.port)
    if (known === undefined || (known.label === undefined && item.label !== undefined)) byPort.set(item.port, item)
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

export function portLabel(port: ServicePort): string {
  return port.label ? `${port.label} :${port.port}` : `:${port.port}`
}

// Ports that went down: up on the previous read and gone on this one. They stay marked until they come
// back or until DOWN_PORT_TTL_MS, so they do not stay red forever.
export function trackDownPorts(
  previousAlive: readonly ServicePort[],
  previousDown: readonly DownPort[],
  alive: readonly ServicePort[],
  now: number,
): DownPort[] {
  const isAlive = (port: number) => alive.some(p => p.port === port)
  const justDown = previousAlive.filter(p => !isAlive(p.port)).map(p => ({ ...p, since: now }))
  const stillDown = previousDown.filter(p => !isAlive(p.port) && now - p.since < DOWN_PORT_TTL_MS)
  const byPort = new Map<number, DownPort>()
  for (const p of [...stillDown, ...justDown]) if (!byPort.has(p.port)) byPort.set(p.port, p)
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}
