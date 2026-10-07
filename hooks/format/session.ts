// From the session: folder name, short model name and the last test or build Claude ran.

export function basename(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

// "claude-opus-5-5" -> "opus 5.5"; any other format stays as it came.
export function shortModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)\b/.exec(model)
  return match ? `${match[1]} ${match[2]}.${match[3]}` : model
}

// Segments of a command line (split on &&, ||, ; and newlines), without leading environment variables
// ("CI=1 npm test" → "npm test"). Each segment records whether it is piped into something ("|").
export function commandSegments(command: string): { head: string; isPiped: boolean }[] {
  return command.split(/&&|\|\||;|\r?\n/).map(segment => {
    const [head = '', ...piped] = segment.split('|')
    return { head: head.trim().replace(/^(?:\w+=\S*\s+)+/, ''), isPiped: piped.length > 0 }
  })
}

// Commands whose result is worth showing: tests, builds, typecheck and lint. They must start the segment:
// "pip install pytest" or "grep jest package.json" are not tests.
const CHECK_COMMANDS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|typecheck|lint)\b/,
  /^python3?\s+-m\s+pytest\b/,
  /^(?:pytest|vitest|jest|tsc)\b/,
  /^go\s+(?:test|build|vet)\b/,
  /^cargo\s+(?:test|build|check)\b/,
  /^claude\s+plugin\s+test\b/,
]
// npx with options before the tool ("npx -y -p typescript@5 tsc"): the label becomes "npx tsc".
const NPX_CHECK = /^(npx|bunx)\s+(?:(?:-p|--package)\s+\S+\s+|-\S+\s+)*(tsc|vitest|jest|playwright\s+test)\b/

// Label of the first test or build in the command line, or undefined. A piped one ("npm test | tail") does
// not count: the exit code is the last command's, and a ✓ on a failed test would be worse than nothing.
export function checkLabel(command: string): string | undefined {
  for (const { head, isPiped } of commandSegments(command)) {
    const npx = NPX_CHECK.exec(head)
    const label = npx !== null ? `${npx[1]} ${npx[2]}` : CHECK_COMMANDS.map(re => re.exec(head)?.[0]).find(m => m !== undefined)
    if (label !== undefined) return isPiped ? undefined : label.replace(/\s+/g, ' ')
  }
  return undefined
}
