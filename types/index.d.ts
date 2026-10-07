export type TaskLabels = Record<string, string>
export type UsageLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type ServicePort = { port: number; label?: string }
// Port that was up and disappeared: stays on the line in red until it comes back or expires.
export type DownPort = ServicePort & { since: number }
// One `git status` file: two-letter code (M, A, D, R, ??...) and path.
export type GitFile = { code: string; path: string }
// `isRestricted`: the repo's .git/config defines content filters, which would run a program on every
// git status; then only the branch is read and the rest (changes, ahead/behind) stays unknown.
export type GitInfo = { branch: string; changed: number; ahead: number; behind: number; files: GitFile[]; isRestricted?: boolean }
export type GitCommit = { hash: string; subject: string; when: string }
// Added/removed lines per file (git diff --numstat); a binary file has no numbers.
export type DiffStat = { path: string; added?: number; removed?: number }
// Merge, rebase etc. in progress; `step`/`total` only for a rebase.
export type GitOperation = { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'; step?: number; total?: number }
// One repo worktree (git worktree list). `path` is the raw path, to run git in it; `name` is the one shown.
// `changed`: modified files, from a `git status` in it (undefined when it could not be read).
export type Worktree = {
  path: string
  name: string
  branch?: string
  isMain: boolean
  isCurrent: boolean
  isLocked: boolean
  isPrunable: boolean
  // Locked with its folder unavailable (e.g. an unplugged external drive): no "enter".
  isMissing?: boolean
  // Network folder (\\server\...): no git status, exists or /cd there.
  isNetwork: boolean
  changed?: number
}
export type GitDetail = { log: GitCommit[]; stats: DiffStat[]; operation?: GitOperation; worktrees: Worktree[] }
export type StatusLine = {
  root: string
  project: string
  model: string
  used?: number
  // Tokens in use and window size, for "N left to compact".
  tokens?: number
  window?: number
  limits: UsageLimit[]
  costUsd?: number
  git?: GitInfo
  ports: ServicePort[]
  downPorts: DownPort[]
  // Name of the linked worktree the session is in; then `project` is the repo name.
  worktree?: string
}
export type CheckRun = { label: string; isOk: boolean; at: number }
export type CiState = 'ok' | 'fail' | 'running'
export type PrReview = 'approved' | 'changes' | 'review' | 'draft'
export type PullRequest = { number: number; review: PrReview; url: string }
// Last GitHub read (CI and PR): which project and branch, and when, so it is not queried on every turn.
export type CiStatus = {
  root: string
  branch: string
  state?: CiState
  runId?: number
  runUrl?: string
  pr?: PullRequest
  checkedAt: number
}
export type MeterView = 'context' | 'five_hour' | 'seven_day' | 'cost'
export type Lang = 'pt' | 'en'

declare module 'claude-code' {
  interface PluginState {
    'devbar': {
      labels: TaskLabels
      current: string
      hasWarned: boolean
      line: StatusLine | null
      view: MeterView
      lastCheck: CheckRun | null
      lang: Lang
      // Key of the button that shows "copied" right now; back to null after a moment.
      copied: string | null
      // End of the last model call (the prompt cache counts from there) and the reasoning effort.
      lastRequestAt: number | null
      effort: string | null
      ci: CiStatus | null
      // Git pane: open or not, and what it shows beyond the status (only read while the pane is open).
      isGitPaneOpen: boolean
      gitDetail: GitDetail
    }
  }
}
