// Dev status line: model │ task │ project │ git │ last test │ ports  [meter]
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { CheckRun, CiStatus, GitDetail, GitInfo, GitOperation, Lang, MeterView, ServicePort, StatusLine, TaskLabels, UsageLimit, Worktree } from '../types'
import type { GitDirs } from './format/git'
import {
  ciFinished,
  failedLogExcerpt,
  isCiStale,
  parseGhPr,
  parseGhRuns,
  parseOrUndefined,
  triggersCi,
  withFailedLog,
} from './format/ci'
import {
  cleanText,
  detectOperation,
  FILTER_CONFIG_REGEX,
  isPlainBranch,
  MAX_PANE_WORKTREES,
  OPERATION_MARKERS,
  parseGitDirs,
  parseGitLog,
  parseGitStatus,
  parseNumstat,
  parseWorktreeList,
  pickExe,
} from './format/git'
import { usablePercent } from './format/meter'
import { buttonPrompt, readOptions } from './format/options'
import type { DevbarOptions } from './format/options'
import {
  isSamePath,
  mergePorts,
  parseCommandLines,
  DOCKER_PS_FORMAT,
  parseDockerPs,
  parseLsof,
  parseNetstat,
  parsePs,
  parseSs,
  portLabel,
  projectPorts,
  trackDownPorts,
} from './format/ports'
import { basename, checkLabel, shortModel } from './format/session'
import { langFromLocale, TEXT } from './format/text'
import { drawStatusLine } from './line'
import { drawGitPane } from './pane'

const WARN_AT_PCT = 80
const PROBE_TIMEOUT_MS = 5000
// Every git call from devbar is read-only and runs alongside Claude's own commits:
// --no-optional-locks: `git status` does not write the index, so it never fights a `git commit` for index.lock.
// core.fsmonitor=false: in someone else's repo, fsmonitor can point at an executable inside the repo.
const GIT = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
// The same fsmonitor=false through the environment (git 2.31+), for every process: gh runs git on its own,
// without the -c above. For anything that is not git, the variables do nothing.
const NO_FSMONITOR_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' }
const TOAST_MS = 8000
const REDRAW_EVERY_MS = 60_000 // keeps "3 min ago" and "resets in 2h" current while the terminal is idle
// Fallback to the redraw check for noticing /cd (e.g. the worktree "enter" button), which starts no turn;
// classic.CwdChanged does not fire when going back to the starting folder (seen on Windows). Reading the
// session folder stays inside the engine, no program runs.
const ROOT_CHECK_MS = 3_000

const labels = atom({ plugin: 'devbar', key: 'labels' } as const, {} as TaskLabels)
const current = atom({ plugin: 'devbar', key: 'current' } as const, '')
const hasWarned = atom({ plugin: 'devbar', key: 'hasWarned' } as const, false)
const line = atom({ plugin: 'devbar', key: 'line' } as const, null as StatusLine | null)
const view = atom({ plugin: 'devbar', key: 'view' } as const, 'context' as MeterView)
const lastCheck = atom({ plugin: 'devbar', key: 'lastCheck' } as const, null as CheckRun | null)
const lang = atom({ plugin: 'devbar', key: 'lang' } as const, 'en' as Lang)
// Button showing "copied" right now (its key); back to null after COPIED_FEEDBACK_MS.
const copied = atom({ plugin: 'devbar', key: 'copied' } as const, null as string | null)
const COPIED_FEEDBACK_MS = 1500
const lastRequestAt = atom({ plugin: 'devbar', key: 'lastRequestAt' } as const, null as number | null)
const effort = atom({ plugin: 'devbar', key: 'effort' } as const, null as string | null)
const ci = atom({ plugin: 'devbar', key: 'ci' } as const, null as CiStatus | null)
const isGitPaneOpen = atom({ plugin: 'devbar', key: 'isGitPaneOpen' } as const, false)
const gitDetail = atom({ plugin: 'devbar', key: 'gitDetail' } as const, { log: [], stats: [], worktrees: [] } as GitDetail)
const GIT_PANE = 'devbar-git'
const GIT_LOG_COUNT = '8'
// One `git status` per worktree while the panel is open: past this many, the rest get no count.
const MAX_WORKTREE_STATUS = 10
// Counts are reused for this long by end-of-turn refreshes; opening the panel reads them again.
const WORKTREE_STATUS_TTL_MS = 60_000

// Copies and switches the label of button `key` to "copied" for a moment (line and panel).
// A new click cancels the previous timer: otherwise the second "copied" would vanish too early.
let copiedTimer: Timer | null = null
async function copyAndConfirm($: EngineInterface, key: string, value: string, surface: RenderSurface): Promise<void> {
  const { isCopied } = await $.ui.copy({ text: value, surface })
  if (!isCopied) return
  await update($, copied, () => key)
  copiedTimer?.cancel()
  copiedTimer = $.clock.after(COPIED_FEEDBACK_MS, () => update($, copied, was => (was === key ? null : was)))
}

// Every button fills the prompt through here. A slash command (/cd, /compact, /code-review) only runs at the
// start of the prompt: with a draft in the box, it would land inside the draft and reach the model as plain text.
// Then it does not fill and shows a toast; everything else (plain requests) goes in at the cursor.
async function fillPrompt($: EngineInterface, text: string, language: Lang): Promise<void> {
  if (text.startsWith('/')) {
    const command = text.split(/\s/)[0] ?? text
    // If the box cannot be read, there is no way to know whether it has a draft: do not fill (fail closed).
    const box = await $.prompt.read().catch(() => undefined)
    if (box === undefined || box.text.trim() !== '') {
      const message = box === undefined ? TEXT[language].promptUnreadable(command) : TEXT[language].clearPromptFirst(command)
      $.ui.toast(message, { timeoutMs: TOAST_MS })
      return
    }
  }
  await $.prompt.fill({ text, mode: 'insert' })
}

// Merge/rebase/cherry-pick/revert in progress, from the markers git leaves in the .git folder.
async function readOperation($: EngineInterface, root: string): Promise<GitOperation | undefined> {
  const gitDir = (await runQuiet($, [...GIT, 'rev-parse', '--git-dir'], root))?.trim()
  if (!gitDir) return undefined
  const base = /^([a-zA-Z]:)?[\\/]/.test(gitDir) ? gitDir : `${root}/${gitDir}`
  const keys = Object.keys(OPERATION_MARKERS) as (keyof typeof OPERATION_MARKERS)[]
  const found = await Promise.all(keys.map(k => $.fs.exists(`${base}/${OPERATION_MARKERS[k]}`)))
  const has = Object.fromEntries(keys.map((k, i) => [k, found[i] === true])) as Record<keyof typeof OPERATION_MARKERS, boolean>
  const readQuiet = (name: string) => $.fs.read(`${base}/${OPERATION_MARKERS.rebaseMerge}/${name}`).then(String, () => undefined)
  const [step, total] = has.rebaseMerge ? await Promise.all([readQuiet('msgnum'), readQuiet('end')]) : [undefined, undefined]
  return detectOperation(has, step, total)
}

// What the git panel shows besides the status: recent commits, +/- lines per file and any operation in progress.
// `isFresh`: the panel was just opened, so no cached worktree counts.
// Returns the status it read, so the refresh publishes this one (the newest) instead of its own older read.
async function loadGitDetail($: EngineInterface, root: string, isFresh = false): Promise<GitInfo | undefined> {
  const git = (...args: string[]) => runQuiet($, [...GIT, ...args], root)
  // diff compares content and would run a repo filter (see hasContentFilters); log does not compare content.
  // --no-ext-diff and --no-textconv: no diff program defined by the repo, even without a filter.
  const canDiff = !(await hasContentFilters($, root))
  // The status is read again alongside: the file list and the +/- numbers must come from the same moment.
  const [status, log, numstat, operation, worktrees] = await Promise.all([
    probeGit($, root),
    git('log', `-n${GIT_LOG_COUNT}`, '--format=%h%x09%s%x09%cr'),
    canDiff ? git('diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD') : none(undefined),
    readOperation($, root),
    readWorktrees($, root, isFresh),
  ])
  // The session changed folder (/cd) during the read: the result belongs to the old folder and is dropped.
  if ((await $.session.root()) !== root) return undefined
  if (status !== undefined) await update($, line, prev => (prev !== null && prev.root === root ? { ...prev, git: status } : prev))
  await update($, gitDetail, () => ({
    log: log === undefined ? [] : parseGitLog(log),
    stats: numstat === undefined ? [] : parseNumstat(numstat),
    operation,
    // The current one uses the status just read (the count cache can be up to a minute old).
    worktrees: worktrees.map(w => (w.isCurrent && status !== undefined && !status.isRestricted ? { ...w, changed: status.changed } : w)),
  }))
  return status
}

// Changed-file counts per worktree from the last read. A module variable on purpose:
// it is only a cache (a mod reload loses it and reads again).
let worktreeCounts: { at: number; byPath: ReadonlyMap<string, number | undefined> } | null = null

// The repo's worktrees, each with its number of changed files. Only when there is more than one (the main
// one always shows up); a stale one (folder deleted) has nowhere to run git status.
async function readWorktrees($: EngineInterface, root: string, isFresh: boolean): Promise<Worktree[]> {
  const listArgv = [...GIT, 'worktree', 'list', '--porcelain']
  // -z (git 2.36+) gives the raw path; without it, a path with quotes or accents would come escaped.
  const [stdout, dirs] = await Promise.all([
    runQuiet($, [...listArgv, '-z'], root).then(out => out ?? runQuiet($, listArgv, root)),
    probeGitDirs($, root),
  ])
  const all = stdout === undefined ? [] : parseWorktreeList(stdout, dirs?.top ?? root)
  if (all.length < 2) return []
  // Only the ones the panel shows are read (status, exists); the rest go into the "and N more" count.
  const list = all.slice(0, MAX_PANE_WORKTREES)
  const rest = all.slice(MAX_PANE_WORKTREES)
  const now = Date.now()
  const cached = worktreeCounts
  const isCacheValid =
    !isFresh && cached !== null && now - cached.at < WORKTREE_STATUS_TTL_MS && list.every(wt => cached.byPath.has(wt.path))
  const counts = isCacheValid
    ? list.map(wt => cached.byPath.get(wt.path))
    : await Promise.all(
        list.map(async (wt, i) =>
          wt.isPrunable || wt.isNetwork || i >= MAX_WORKTREE_STATUS ? undefined : (await probeGit($, wt.path))?.changed,
        ),
      )
  if (!isCacheValid) worktreeCounts = { at: now, byPath: new Map(list.map((wt, i) => [wt.path, counts[i]])) }
  // A locked worktree is usually on an external disk: check the folder is there before offering "enter".
  const missing = await Promise.all(
    list.map(wt => (wt.isLocked && !wt.isNetwork ? $.fs.exists(wt.path).then(isThere => !isThere, () => true) : false)),
  )
  return [...list.map((wt, i) => ({ ...wt, changed: counts[i], isMissing: missing[i] === true })), ...rest]
}

// Working folder and, in a linked worktree, the repo and worktree names. It does not change within the same
// root: read once per root (a failure is not cached and is retried on the next refresh).
let gitDirsCache: { root: string; dirs: GitDirs | undefined } | null = null
async function probeGitDirs($: EngineInterface, root: string): Promise<GitDirs | undefined> {
  if (gitDirsCache?.root === root) return gitDirsCache.dirs
  const argv = [...GIT, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']
  const stdout = await runQuiet($, argv, root)
  if (stdout === undefined) return undefined
  const dirs = parseGitDirs(stdout, root)
  gitDirsCache = { root, dirs }
  return dirs
}
type Listener = { port: number; pid: number }

// Host command output, or undefined if it is missing, fails or times out.
async function runQuiet($: EngineInterface, argv: string[], cwd?: string): Promise<string | undefined> {
  const ran = await runHost($, argv, cwd)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

// Runs through the executable's full path (resolveExe); undefined if not found or it did not run.
async function runHost($: EngineInterface, argv: string[], cwd?: string): Promise<{ exitCode: number; stdout: string } | undefined> {
  const [name, ...args] = argv
  const exe = name === undefined ? undefined : await resolveExe($, name)
  if (exe === undefined) return undefined
  return $.process.run([exe, ...args], { cwd, env: NO_FSMONITOR_ENV, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined)
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

// On Windows, a bare name ("git") is looked up in the current folder first, before PATH: a git.exe
// inside the repo would run instead of the real one. So the full path is found once by
// where.exe running inside System32 (its current folder is the system's, not the repo's) and reused.
// On macOS and Linux the lookup skips the current folder: the name is passed as is.
const exePaths = new Map<string, string>()
async function resolveExe($: EngineInterface, name: string): Promise<string | undefined> {
  if (!(await isWindows($))) return name
  const known = exePaths.get(name)
  if (known !== undefined) return known
  const system32 = `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32`
  const ran = await $.process.run([`${system32}\\where.exe`, name], { cwd: system32, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined)
  // A failure is not cached: the tool may get installed mid-session.
  const found = ran?.exitCode === 0 ? pickExe(ran.stdout) : undefined
  if (found !== undefined) exePaths.set(name, found)
  return found
}

// System language: on Windows, the UI language (Get-UICulture); on macOS and Linux, LC_ALL or LANG.
async function detectLang($: EngineInterface): Promise<Lang> {
  if (await isWindows($)) {
    const culture = await runQuiet($, ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name'])
    return langFromLocale(culture?.trim())
  }
  return langFromLocale((await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

// git, netstat, lsof etc. are informational: if they fail (no repo, tool missing), the item just leaves the line.
async function probeGit($: EngineInterface, root: string): Promise<GitInfo | undefined> {
  if (await hasContentFilters($, root)) {
    // Only the branch, read from HEAD (no content comparison, so no filter runs).
    // No branch (git missing, outside a repo or detached HEAD): the item disappears, like any failed read.
    const branch = (await runQuiet($, [...GIT, 'symbolic-ref', '--short', '-q', 'HEAD'], root))?.trim()
    if (!branch) return undefined
    return { branch: cleanText(branch), changed: 0, ahead: 0, behind: 0, files: [], isRestricted: true }
  }
  const argv = [...GIT, 'status', '--porcelain=v1', '--branch']
  const stdout = await runQuiet($, argv, root)
  return stdout === undefined ? undefined : parseGitStatus(stdout)
}

// Does the repo's own config (.git/config and config.worktree, with the files they include) define a content
// filter? A filter runs a program on every git status/diff; fsmonitor=false does not cover that. Reading
// config runs nothing. Only the repo's config counts: the user's global one (e.g. git-lfs) is theirs and trusted.
// One check per folder per session; if git config did not even run, treat it as filtered (fail closed).
const filterChecks = new Map<string, boolean>()
async function hasContentFilters($: EngineInterface, root: string): Promise<boolean> {
  const known = filterChecks.get(root)
  if (known !== undefined) return known
  const check = (scope: string) => runHost($, [...GIT, 'config', scope, '--includes', '--get-regexp', FILTER_CONFIG_REGEX], root)
  const [local, worktree] = await Promise.all([check('--local'), check('--worktree')])
  if (local === undefined) return true
  // Exit 0 with lines = filter found; 1 = none; any other code (e.g. a git without --worktree) = ignored.
  const found = [local, worktree].some(r => r?.exitCode === 0 && r.stdout.trim() !== '')
  filterChecks.set(root, found)
  return found
}

// Windows: netstat gives port and PID; PowerShell gives each PID's command line.
// undefined = the query failed (not the same as "no ports": nothing is marked as down).
async function windowsListeners($: EngineInterface): Promise<[Listener[], Map<number, string>] | undefined> {
  // No "-p TCP": it only lists IPv4, and a server listening only on ::1 (Vite on Node 17+) would vanish.
  // The full list includes TCPv6 and UDP; the parser keeps only the LISTENING (TCP) lines.
  const netstat = await runQuiet($, ['netstat', '-ano'])
  if (netstat === undefined) return undefined
  const listeners = parseNetstat(netstat)
  if (listeners.length === 0) return [[], new Map()]
  const filter = [...new Set(listeners.map(l => `ProcessId=${l.pid}`))].join(' OR ')
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
  const processes = await runQuiet($, ['powershell', '-NoProfile', '-Command', script])
  return processes === undefined ? undefined : [listeners, parseCommandLines(processes)]
}

// macOS and Linux: lsof (or ss, on Linux without lsof) gives port and PID; ps gives the command line.
async function unixListeners($: EngineInterface): Promise<[Listener[], Map<number, string>] | undefined> {
  const lsof = await runQuiet($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])
  const ss = lsof === undefined ? await runQuiet($, ['ss', '-ltnpH']) : undefined
  if (lsof === undefined && ss === undefined) return undefined
  const listeners = lsof !== undefined ? parseLsof(lsof) : parseSs(ss ?? '')
  if (listeners.length === 0) return [[], new Map()]
  const pids = [...new Set(listeners.map(l => l.pid))].join(',')
  const ps = await runQuiet($, ['ps', '-o', 'pid=,args=', '-p', pids])
  return ps === undefined ? undefined : [listeners, parsePs(ps)]
}

// Ports listened on by processes started from inside the project; undefined if the query failed.
// Skipped in the home folder: every user process would be "inside" it.
async function probeProcessPorts($: EngineInterface, root: string): Promise<ServicePort[] | undefined> {
  const onWindows = await isWindows($)
  const home = onWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  if (home !== undefined && isSamePath(home, root)) return []
  const found = onWindows ? await windowsListeners($) : await unixListeners($)
  return found === undefined ? undefined : projectPorts(found[0], found[1], root)
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

// This project's Docker Compose containers, labeled with the service name. Read through `docker ps` and the
// Compose labels (see DOCKER_PS_FORMAT): no repo file is read. compose.yaml is only looked for
// (exists or not) to avoid calling Docker in a project that does not use it.
// Docker stopped counts as "no containers up": then the database really is down.
async function probeComposePorts($: EngineInterface, root: string): Promise<ServicePort[]> {
  const found = await Promise.all(COMPOSE_FILES.map(f => $.fs.stat(`${root}/${f}`).then(() => true, () => false)))
  if (!found.includes(true)) return []
  const stdout = await runQuiet($, ['docker', 'ps', '--filter', 'label=com.docker.compose.project', '--format', DOCKER_PS_FORMAT])
  return stdout === undefined ? [] : parseDockerPs(stdout, root)
}

// CI and PR of the current branch through `gh`; at most every few minutes (isCiStale), unless `force`.
// One read at a time: the CI watch and the end-of-turn refresh can ask together, and two
// simultaneous reads would both see the same "running → passed" change and toast twice.
let githubRead: Promise<void> | null = null
function refreshGithub($: EngineInterface, root: string, git: GitInfo | undefined, force = false): Promise<void> {
  if (githubRead !== null) return githubRead
  githubRead = readGithub($, root, git, force).finally(() => {
    githubRead = null
  })
  return githubRead
}

async function readGithub($: EngineInterface, root: string, git: GitInfo | undefined, force: boolean): Promise<void> {
  // The git status just failed (a timeout, for example): keep the previous CI; the drawing only shows it
  // if it matches the line's folder and branch.
  if (git === undefined) return
  if (!isPlainBranch(git.branch)) {
    await update($, ci, () => null)
    return
  }
  const now = Date.now()
  const previousCi = await read($, ci)
  if (!force && !isCiStale(previousCi, root, git.branch, now)) return

  const hasWorkflows = await $.fs.stat(`${root}/.github/workflows`).then(() => true, () => false)
  const runFields = 'status,conclusion,event,url,databaseId'
  const runArgv = ['gh', 'run', 'list', `--branch=${git.branch}`, '--limit', '10', '--json', runFields]
  const prArgv = ['gh', 'pr', 'view', '--json', 'number,state,isDraft,reviewDecision,url']
  const shouldReadRuns = config.showCi && hasWorkflows
  const [runs, pr] = await Promise.all([
    shouldReadRuns ? runQuiet($, runArgv, root) : none(undefined),
    config.showPr ? runQuiet($, prArgv, root) : none(undefined),
  ])
  // Folder changed during the read: the result belongs to the old folder and is dropped.
  if ((await $.session.root()) !== root) return
  const isSameBranch = previousCi?.root === root && previousCi.branch === git.branch
  // gh failed (network, rate limit, timeout): with no runs at all gh returns "[]", so
  // undefined is a failure. Keep the previous state so the "finished" toast and the watch carry on.
  const isRunReadFailed = shouldReadRuns && runs === undefined && isSameBranch
  const run = isRunReadFailed
    ? previousCi.state === undefined ? undefined : { state: previousCi.state, id: previousCi.runId, url: previousCi.runUrl }
    : parseOrUndefined(runs, parseGhRuns)
  const finished = isSameBranch && !isRunReadFailed ? ciFinished(previousCi.state, run?.state) : undefined
  if (finished !== undefined) $.ui.toast(TEXT[await read($, lang)].ciDone(finished, git.branch), { timeoutMs: TOAST_MS })
  await update($, ci, () => ({
    root,
    branch: git.branch,
    state: run?.state,
    runId: run?.id,
    runUrl: run?.url,
    pr: parseOrUndefined(pr, parseGhPr),
    checkedAt: now,
  }))
  if (run?.state === 'running') watchCi($)
}

// While CI runs, check again every CI_WATCH_MS even with the conversation idle, so the
// "CI passed/failed" toast comes right away. Right after a push, the new run can take a while to show up:
// the first CI_WATCH_GRACE checks continue even without seeing "running".
const CI_WATCH_MS = 30_000
const CI_WATCH_MAX = 40 // 20 min
const CI_WATCH_GRACE = 4
const CI_AFTER_PUSH_MS = 15_000
let isWatchingCi = false
function watchCi($: EngineInterface, delayMs = CI_WATCH_MS): void {
  if (isWatchingCi || !config.showCi) return
  isWatchingCi = true
  let tries = 0
  const tick = async () => {
    tries += 1
    // Any error ends the watch instead of leaving it "active" forever (isWatchingCi).
    let keepGoing = false
    try {
      const status = await read($, line)
      if (status?.git !== undefined) await refreshGithub($, status.root, status.git, true)
      const state = (await read($, ci))?.state
      keepGoing = tries < CI_WATCH_MAX && (state === 'running' || tries < CI_WATCH_GRACE)
    } catch (error) {
      $.ui.log(`devbar: CI watch failed: ${String(error)}`, { to: 'debug' })
    }
    if (keepGoing) $.clock.after(CI_WATCH_MS, tick)
    else isWatchingCi = false
  }
  $.clock.after(delayMs, tick)
}

// CI "fix": fetches the failed log excerpt and appends it to the prompt (without a log, only the text goes).
async function ciFixPrompt($: EngineInterface, language: Lang): Promise<string> {
  const base = buttonPrompt('ciFix', config.prompts, language)
  const status = await read($, ci)
  if (status?.runId === undefined) return base
  const log = await runQuiet($, ['gh', 'run', 'view', String(status.runId), '--log-failed'], status.root)
  return withFailedLog(base, log === undefined ? '' : failedLogExcerpt(log), language)
}

// User options; the engine runs `register` again (and resets this) when they change.
let config: DevbarOptions = readOptions({})

const none = <T,>(value: T) => Promise.resolve(value)

// Language read once per mod load (a reload resets module variables and fires session.start again).
let isLangKnown = false

async function refresh($: EngineInterface): Promise<void> {
  if (!isLangKnown) {
    const detected = config.language === 'auto' ? await detectLang($) : config.language
    await update($, lang, () => detected)
    isLangKnown = true
  }
  const root = await $.session.root()
  // An item that is off runs no query. git also serves CI and PR (current branch).
  const [model, usage, git, dirs, processPorts, composePorts, previous] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    config.showGit || config.showCi || config.showPr ? probeGit($, root) : none(undefined),
    config.showGit ? probeGitDirs($, root) : none(undefined),
    config.showPorts ? probeProcessPorts($, root) : none([]),
    config.showPorts ? probeComposePorts($, root) : none([]),
    read($, line),
  ])
  if (config.showCi || config.showPr) await refreshGithub($, root, git)
  // With the panel open, it reads the status again along with the rest; that one is newer than the one above
  // and is the one that goes to the line (otherwise the refresh would undo what the panel just showed).
  const paneGit = git !== undefined && (await read($, isGitPaneOpen)) ? await loadGitDetail($, root) : undefined
  const latestGit = paneGit ?? git

  // Same folder: compare with the previous read to find ports that went down. If the process query
  // failed, keep the previous ports instead of marking all of them down.
  const before = previous?.root === root ? previous : null
  const ports = processPorts === undefined ? (before?.ports ?? []) : mergePorts(composePorts, processPorts)
  const downPorts =
    processPorts === undefined ? (before?.downPorts ?? [])
    : trackDownPorts(before?.ports ?? [], before?.downPorts ?? [], ports, Date.now())
  // Toast as soon as a project server goes down (the color alone goes unnoticed).
  const newlyDown = downPorts.filter(p => !(before?.downPorts ?? []).some(d => d.port === p.port))
  if (before !== null && newlyDown.length > 0) {
    $.ui.toast(TEXT[await read($, lang)].portsDown(newlyDown.map(portLabel).join(', ')), { timeoutMs: TOAST_MS })
  }

  const percent = usage.context.percent
  const used = percent === undefined ? undefined : usablePercent(percent)
  const limits: UsageLimit[] = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  await update($, line, () => ({
    root,
    project: dirs?.linked?.repo ?? cleanText(basename(root)),
    worktree: dirs?.linked?.worktree,
    model: shortModel(model),
    used,
    tokens: usage.context.tokens,
    window: usage.context.window,
    limits,
    costUsd: usage.cost?.usd,
    git: latestGit,
    ports,
    downPorts,
  }))

  if (used === undefined) return
  const warned = await read($, hasWarned)
  if (used >= WARN_AT_PCT && !warned) {
    $.ui.toast(TEXT[await read($, lang)].contextWarning(used), { timeoutMs: TOAST_MS })
  }
  if ((used >= WARN_AT_PCT) !== warned) await update($, hasWarned, () => used >= WARN_AT_PCT)
}

// The read (git, ports, CI) runs on a timer, outside the turn: the turn ends without waiting for it.
// One read at a time; a request in the middle of one (e.g. /cd during the refresh) is kept and runs right
// after, so the line does not stay on the old folder until the next turn.
let isRefreshing = false
let isRefreshPending = false
function scheduleRefresh($: EngineInterface): void {
  $.clock.after(0, async () => {
    if (isRefreshing) {
      isRefreshPending = true
      return
    }
    isRefreshing = true
    try {
      await refresh($)
    } catch (error) {
      $.ui.log(`devbar: refresh failed: ${String(error)}`, { to: 'debug' })
    } finally {
      isRefreshing = false
      if (isRefreshPending) {
        isRefreshPending = false
        scheduleRefresh($)
      }
    }
  })
}

// One read per new folder: if it fails, the redraw (on every keystroke) does not trigger another each time.
let movedTo: string | undefined
function refreshIfMoved($: EngineInterface, root: string, shownRoot: string): void {
  if (root === shownRoot || root === movedTo) return
  movedTo = root
  scheduleRefresh($)
}

export const register: Register = (on, options) => {
  config = readOptions(options)

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    // The language is read in the refresh (timer): on Windows it opens a PowerShell, which must not hold up the session.
    isLangKnown = false
    scheduleRefresh($)
    $.clock.every(REDRAW_EVERY_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(ROOT_CHECK_MS, async () => {
      const [root, status] = await Promise.all([$.session.root(), read($, line)])
      if (status !== null) refreshIfMoved($, root, status.root)
    })
    return ran
  })

  // Folder change reported by the engine: refresh right away, without waiting for the periodic check.
  on('classic.CwdChanged', async ($, e, next) => {
    scheduleRefresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    // A main-conversation turn that reached the model: the prompt cache counts from here.
    if (e.agentId === undefined && e.usage !== undefined) await update($, lastRequestAt, () => Date.now())
    scheduleRefresh($)
    return ran
  })

  // Reasoning effort of the turn: Claude Code reports it at the end of every answer.
  on('classic.Stop', async ($, e, next) => {
    const level = e.effort?.level
    if (typeof level === 'string' && /^[a-z]{1,10}$/.test(level)) await update($, effort, () => level)
    return next(e)
  })
    // A failure here must never hold up the end of the answer.
    .catch(($, e, next) => next(e))

  // Git panel closed (by the user or the engine): stop reading git log.
  on('ui.close', { id: GIT_PANE }, async ($, e, next) => {
    await update($, isGitPaneOpen, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: GIT_PANE }, async ($, e) => {
    const [status, detail, language, justCopied] = await Promise.all([
      read($, line),
      read($, gitDetail),
      read($, lang),
      read($, copied),
    ])
    const ui = $.ui.resolve(e)
    const git = status?.git
    if (status === null || git === undefined) return <ui.Text dimColor>{TEXT[language].pane.noRepo}</ui.Text>
    return drawGitPane(
      ui,
      { root: status.root, git, detail, language, justCopied, rows: e.viewport?.rows, options: config },
      {
        ask: prompt => fillPrompt($, prompt, language),
        copy: (key, value, surface) => copyAndConfirm($, key, value, surface),
      },
    )
  })

  // In tool hooks, the .catch makes sure a mod failure never blocks the tool.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Successful push/merge: watch the CI it triggered (the run takes a few seconds to show up).
    if (ran.deny === undefined && ran.isError !== true && triggersCi(e.command)) watchCi($, CI_AFTER_PUSH_MS)
    const label = checkLabel(e.command)
    if (label === undefined || ran.deny !== undefined) return ran
    const isOk = ran.isError !== true
    // Running in the background: no result yet.
    if (ran.isError !== true && ran.result.backgroundTaskId !== undefined) return ran
    await update($, lastCheck, () => ({ label, isOk, at: Date.now() }))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const active = e.todos.find(t => t.status === 'in_progress')
    await update($, current, () => cleanText(active?.activeForm ?? ''))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const id = ran.result.task.id
      await update($, labels, all => ({ ...all, [id]: cleanText(e.activeForm ?? e.subject) }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const all = await read($, labels)
    // The previous label counts too: a task can finish with a new text ("X" becomes "Y" at the end),
    // while the line shows the old one.
    const previous = all[e.taskId]
    const label = cleanText(e.activeForm ?? e.subject ?? previous ?? '')
    if (e.activeForm ?? e.subject) await update($, labels, prev => ({ ...prev, [e.taskId]: label }))
    if (e.status === 'in_progress') await update($, current, () => label)
    if (e.status === 'completed' || e.status === 'deleted') {
      const shown = await read($, current)
      if (shown === label || shown === previous) await update($, current, () => '')
    }
    // A deleted task leaves the label list (otherwise it only grows during the session).
    if (e.status === 'deleted') {
      await update($, labels, prev => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== e.taskId)))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Keeps the engine's hint line intact and puts the status line on its own line below it.
  // The mode (bypass etc.) is drawn by the engine outside this component, so the line cannot go above it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const status = await read($, line)
    if (status === null) return engineLine
    // /cd redraws the prompt box: if the session folder is no longer the line's, read again now
    // (going back to the starting folder fires no CwdChanged; the periodic check is the fallback).
    refreshIfMoved($, await $.session.root(), status.root)

    const [task, chosenView, check, language, justCopied, storedCi, currentEffort, lastRequest] = await Promise.all([
      read($, current),
      read($, view),
      read($, lastCheck),
      read($, lang),
      read($, copied),
      read($, ci),
      read($, effort),
      read($, lastRequestAt),
    ])
    const ui = $.ui.resolve(e)
    // Mark it open only after the panel opens: if the open fails, ui.close would never come
    // to clear it, and every refresh would read the panel's git for nothing.
    const openGitPane = async () => {
      const isOpened = await $.ui.open({ id: GIT_PANE, title: 'git' }).then(() => true, () => false)
      if (!isOpened) return
      await update($, isGitPaneOpen, () => true)
      await loadGitDetail($, status.root, true)
    }
    const statusLine = drawStatusLine(
      ui,
      {
        status,
        task,
        chosenView,
        check,
        ci: storedCi,
        effort: currentEffort,
        lastRequestAt: lastRequest,
        language,
        justCopied,
        now: Date.now(),
        options: config,
      },
      {
        ask: prompt => fillPrompt($, prompt, language),
        askCiFix: async () => fillPrompt($, await ciFixPrompt($, language), language),
        copy: (key, value, surface) => copyAndConfirm($, key, value, surface),
        openGitPane,
        showView: async shown => { await update($, view, () => shown) },
      },
    )
    return (
      <ui.Box flexDirection="column">
        {engineLine}
        {statusLine}
      </ui.Box>
    )
  })
}
