// git output (status, log, numstat, operation in progress) and what the panel and the line show from it.
import type { DiffStat, GitCommit, GitInfo, GitOperation, Worktree } from '../../types'
import { isSamePath } from './ports'
import { basename } from './session'

const MAX_PANE_FILES = 50
const MAX_PANE_TEXT = 200
const MAX_PROMPT_NAME = 64
const MAX_PROMPT_PATH = 260
// With spaces a path can be a sentence; kept short, there is little room for a hidden instruction.
const MAX_PROMPT_PATH_WITH_SPACES = 120
// Worktrees the panel shows and reads (git status, exists); the rest become "and N more".
export const MAX_PANE_WORKTREES = 20

// Output of `git status --porcelain=v1 --branch`.
export function parseGitStatus(stdout: string): GitInfo | undefined {
  const [head, ...rest] = stdout.split('\n')
  if (head === undefined || !head.startsWith('## ')) return undefined
  const ref = head.slice(3)
  const branch = ref.startsWith('No commits yet on ')
    ? ref.slice('No commits yet on '.length)
    : (ref.split(/\.\.\.|\s/)[0] ?? ref)
  const ahead = Number(/ahead (\d+)/.exec(ref)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(ref)?.[1] ?? 0)
  const rows = rest.map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '')
  // Conflicts first, before the cut: in a big merge the conflicting files must not be left out.
  const ordered = [...rows].sort((a, b) => Number(isConflict(b.slice(0, 2).trim())) - Number(isConflict(a.slice(0, 2).trim())))
  const files = ordered.slice(0, MAX_PANE_FILES).map(l => ({ code: l.slice(0, 2).trim(), path: cleanText(l.slice(3)) }))
  return { branch: cleanText(branch), changed: rows.length, ahead, behind, files }
}

// Path that matches a file against numstat: for a rename ("old -> new"), the new one.
export function statusPathKey(path: string): string {
  return path.split(' -> ').pop() ?? path
}

// A rename in numstat: "a => b" or "src/{old.ts => new.ts}" (and "{ => sub}"): keeps the new path.
function renameDestination(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (braced !== null) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/')
  const [, destination] = path.split(' => ')
  return destination ?? path
}

// Text from the repo (file names, branches, commit messages) is only drawn on screen. Every control goes
// (Cc: C0, DEL and C1, which some terminals read as escapes) and every invisible formatting character
// (Cf: zero width, direction overrides, tags), which would hide or scramble what the person sees.
// The cut is per character, not per UTF-16 unit, so an emoji is never split in half.
export function cleanText(text: string): string {
  return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, MAX_PANE_TEXT).join('')
}

// `git log --format=%h%x09%s%x09%cr`: hash, subject and "how long ago", separated by tabs.
// The subject may contain tabs: the hash runs to the first one, the "when" comes after the last.
export function parseGitLog(stdout: string): GitCommit[] {
  return stdout.split(/\r?\n/).flatMap(row => {
    const first = row.indexOf('\t')
    const last = row.lastIndexOf('\t')
    const hash = row.slice(0, first)
    if (first < 0 || last <= first || !/^[0-9a-f]{4,40}$/.test(hash)) return []
    return [{ hash, subject: cleanText(row.slice(first + 1, last).replace(/\t/g, ' ')), when: cleanText(row.slice(last + 1)) }]
  })
}

// `git diff --numstat HEAD`: "added<tab>removed<tab>path"; binary files come as "-".
export function parseNumstat(stdout: string): DiffStat[] {
  return stdout
    .split(/\r?\n/)
    .map(row => row.split('\t'))
    .filter((cols): cols is [string, string, string] => cols.length >= 3)
    .map(([added, removed, path]) => ({
      path: cleanText(renameDestination(path)),
      added: /^\d+$/.test(added) ? Number(added) : undefined,
      removed: /^\d+$/.test(removed) ? Number(removed) : undefined,
    }))
}

export function statLabel(added: number | undefined, removed: number | undefined): string {
  return added === undefined && removed === undefined ? '' : `+${added ?? 0} −${removed ?? 0}`
}

export function totalStats(stats: readonly DiffStat[]): { added: number; removed: number } {
  return stats.reduce((sum, s) => ({ added: sum.added + (s.added ?? 0), removed: sum.removed + (s.removed ?? 0) }), {
    added: 0,
    removed: 0,
  })
}

// Files git leaves in the .git folder during each operation.
export const OPERATION_MARKERS = {
  rebaseMerge: 'rebase-merge',
  rebaseApply: 'rebase-apply',
  merge: 'MERGE_HEAD',
  cherryPick: 'CHERRY_PICK_HEAD',
  revert: 'REVERT_HEAD',
} as const

// Which operation is in progress, from the markers present; for a rebase, the current step and the total.
export function detectOperation(
  has: Readonly<Record<keyof typeof OPERATION_MARKERS, boolean>>,
  step?: string,
  total?: string,
): GitOperation | undefined {
  if (has.rebaseMerge || has.rebaseApply) {
    const toNumber = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined)
    return { kind: 'rebase', step: toNumber(step), total: toNumber(total) }
  }
  if (has.merge) return { kind: 'merge' }
  if (has.cherryPick) return { kind: 'cherry-pick' }
  if (has.revert) return { kind: 'revert' }
  return undefined
}

// A conflicted file (UU, AA, DD, AU, UA, DU, UD): listed first in the panel.
export function isConflict(code: string): boolean {
  return /U/.test(code) || code === 'AA' || code === 'DD'
}

// Color of the `git status` code in the panel: new green, deleted red, conflict red, the rest yellow.
export function fileColor(code: string): 'success' | 'error' | 'warning' {
  if (code === '??' || code.includes('A')) return 'success'
  if (code.includes('D') || code.includes('U')) return 'error'
  return 'warning'
}

// A "plain" branch name. A cloned repo may have a branch with backticks, $, ; and so on: that one does
// not go into the gh command line (nor one starting with "-", so it cannot become a flag).
export function isPlainBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith('-')
}

export function gitLabel(git: GitInfo): string {
  if (git.isRestricted) return `${git.branch} ⚠`
  const sync = `${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''}`
  const changes = git.changed > 0 ? ` ±${git.changed}` : ''
  return `${git.branch}${git.changed > 0 ? '*' : ''}${sync}${changes}`
}

// A relative git path (e.g. "../.git") joined to the folder git ran in, with "." and ".." resolved.
// Backslashes become "/" only in Windows paths (with a drive letter): on Linux and macOS a backslash is a
// valid name character. NFC: macOS may hand over "ã" decomposed while git has it composed.
function absolutePath(path: string, cwd: string): string {
  const isWindows = hasDrive(path) || hasDrive(cwd)
  const slash = (p: string) => (isWindows ? p.replace(/\\/g, '/') : p).normalize('NFC')
  const slashed = slash(path)
  const isAbsolute = /^([a-zA-Z]:)?\//.test(slashed)
  const parts = (isAbsolute ? slashed : `${slash(cwd)}/${slashed}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

// The session's working folder and, in a linked worktree, the repo name and the worktree name.
export type GitDirs = { top: string; linked?: { repo: string; worktree: string } }

// `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`, run in `cwd` (options from git 2.13+;
// --path-format=absolute is from 2.31, and an older git echoes it back as an output line).
// In a linked worktree, the git-dir (.git/worktrees/<name>) differs from the git-common-dir (the main .git):
// then the line shows the repo name (the main folder) and the worktree name, not just the folder name.
export function parseGitDirs(stdout: string, cwd: string): GitDirs | undefined {
  const lines = stdout.split(/\r?\n/).map(l => l.trim())
  const [top, gitDir, commonDir] = lines
  if (!top || !gitDir || !commonDir || lines.some(l => l.startsWith('-'))) return undefined
  const common = absolutePath(commonDir, cwd)
  if (isSamePath(absolutePath(gitDir, cwd), common)) return { top }
  // Regular main worktree: <repo>/.git. Bare repo: <repo>.git.
  const repo = cleanText(common.endsWith('/.git') ? basename(common.slice(0, -'/.git'.length)) : basename(common).replace(/\.git$/, ''))
  const worktree = cleanText(basename(top))
  return repo === '' || worktree === '' ? { top } : { top, linked: { repo, worktree } }
}

// `git worktree list --porcelain -z` (fields separated by NUL, records by a double NUL) or, on a git without
// -z, blocks separated by a blank line. The main one comes first; a bare repo is left out (it has no folder).
// `top` is the session's working folder (rev-parse), not the root: the session may be in a subfolder.
// With -z, NUL is the only separator: a path with a newline cannot forge another record or field.
export function parseWorktreeList(stdout: string, top: string): Worktree[] {
  const blocks = stdout.includes('\0')
    ? stdout.split('\0\0').map(record => record.split('\0'))
    : stdout.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/))
  return blocks.flatMap((lines, index) => {
    const field = (name: string) => lines.find(l => l === name || l.startsWith(`${name} `))
    const path = field('worktree')?.slice('worktree '.length)
    if (!path || field('bare') !== undefined) return []
    const branch = field('branch')?.slice('branch '.length).replace(/^refs\/heads\//, '')
    return [{
      path,
      name: cleanText(basename(path)),
      branch: branch === undefined ? undefined : cleanText(branch),
      isMain: index === 0,
      isCurrent: isSamePath(path, top),
      isLocked: field('locked') !== undefined,
      isPrunable: field('prunable') !== undefined,
      // Network folder (\\server\...): a hostile .git could point there and, on Windows, any access
      // (git status, exists, /cd) opens an SMB connection and hands over the login hash. It is never touched.
      isNetwork: isUncPath(path),
    }]
  })
}

function hasDrive(path: string): boolean {
  return /^[a-zA-Z]:/.test(path)
}

export function isUncPath(path: string): boolean {
  return /^(\/\/|\\\\)/.test(path)
}

// `git config --get-regexp` for filters: non-empty output means a filter is defined (clean, smudge or process).
// A filter runs a program whenever git compares file content (status, diff): in a .git downloaded with the
// repo, that would be the repo's code running every turn, without the person asking.
export const FILTER_CONFIG_REGEX = '^filter\\..*\\.(clean|smudge|process)$'

// The first .exe path in the `where.exe` output (one per line). No .exe (only .cmd/.bat) gives undefined:
// those only run through a shell, and devbar uses none.
export function pickExe(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => /^[a-zA-Z]:\\.+\.exe$/i.test(l))
}

// Path of `to` as seen from `from` (e.g. "../feature-x"), for the "enter" /cd: shorter than the absolute
// one in the prompt. Another drive on Windows or a network folder (//server/...): the absolute one, as given.
// Case only folds on Windows; on Linux, Proj and proj are different folders.
export function relativePath(from: string, to: string): string {
  if (isUncPath(from) || isUncPath(to)) return to
  const isWindows = hasDrive(from) || hasDrive(to)
  const a = absolutePath(from, '/').split('/')
  const b = absolutePath(to, '/').split('/')
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s)
  const same = (x: string | undefined, y: string | undefined) => x !== undefined && y !== undefined && fold(x) === fold(y)
  if (!same(a[0], b[0])) return b.join('/')
  let common = 0
  while (same(a[common], b[common])) common += 1
  const rel = [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/')
  return rel === '' ? '.' : rel
}

// A path that may go into the "enter" /cd: no quotes, backticks, $ or controls, and not starting with "~" or
// "-" (/cd could read it as the home folder or an option). /cd reads the rest of the line as the path, spaces
// included (quotes become part of the name). Spaces only with `allowSpaces`: the default /cd never reaches
// the model, but a text the person edited may, and a path with spaces from the repo could carry a sentence.
export function isPlainCdPath(path: string, allowSpaces: boolean): boolean {
  const chars = allowSpaces ? /^[\p{L}\p{M}\p{N}._/\\:~() -]+$/u : /^[\p{L}\p{M}\p{N}._/\\:~()-]+$/u
  const maxLength = allowSpaces ? MAX_PROMPT_PATH_WITH_SPACES : MAX_PROMPT_PATH
  return path.length <= maxLength && path.trim() === path && !/^[~-]/.test(path) && chars.test(path)
}

// A worktree name that may go into the "remove" prompt: a single short word (no spaces).
// The name comes from the local .git, but a repo downloaded with its .git folder could bring one with
// instructions; the full path never goes: Claude finds it with `git worktree list`.
export function isPlainName(name: string): boolean {
  return name.length <= MAX_PROMPT_NAME && /^[\p{L}\p{N}._-]+$/u.test(name)
}
