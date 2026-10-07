// /config options (plugin.json userConfig) and the texts the buttons put in the prompt.
import type { Lang } from '../../types'
import type { CacheTtl } from './meter'
import { TEXT } from './text'

// The user's options, with the default when a value is missing or invalid.
export type DevbarOptions = {
  showModel: boolean
  showGit: boolean
  showLastCheck: boolean
  showCi: boolean
  showPr: boolean
  showPorts: boolean
  language: 'auto' | Lang
  cacheTtl: CacheTtl
  // Which button groups have no brackets (the "Plain ... button" options).
  plain: Record<ButtonGroup, boolean>
  // Texts the buttons put in the prompt, when the person wrote their own in /config.
  prompts: CustomPrompts
}

export const BUTTON_GROUPS = ['branch', 'ports', 'ci', 'pr', 'fix', 'meter', 'compact', 'paneActions', 'hashes', 'model', 'effort', 'project'] as const
export type ButtonGroup = (typeof BUTTON_GROUPS)[number]

// Buttons as "[ label ]" (the terminal default) or bare text, per the group's "Plain ..." option.
// No brackets by default: "compact" (it sits mid-sentence, "45k to compact") and the model, effort and
// folder (text that reads as text). Without brackets a button is white, never gray: that color is what
// shows it can be clicked (exception: the commit hash, always gray next to the subject).
export function buttonStyle(plain: Readonly<Record<ButtonGroup, boolean>>, group: ButtonGroup): { plain?: true } {
  return plain[group] ? { plain: true } : {}
}
// Each option's name in plugin.json.
const PLAIN_OPTION: Record<ButtonGroup, string> = {
  branch: 'plainBranch',
  ports: 'plainPorts',
  ci: 'plainCi',
  pr: 'plainPr',
  fix: 'plainFix',
  meter: 'plainMeter',
  compact: 'plainCompact',
  paneActions: 'plainPaneActions',
  hashes: 'plainHashes',
  model: 'plainModel',
  effort: 'plainEffort',
  project: 'plainProject',
}
const PLAIN_BY_DEFAULT: readonly ButtonGroup[] = ['compact', 'model', 'effort', 'project']

// Every button that fills the prompt has its own text, editable in /config: everyone asks in their own way.
export type CustomPrompts = {
  commit?: string
  review?: string
  testFix?: string
  ciFix?: string
  compact?: string
  worktreeEnter?: string
  worktreeRemove?: string
  worktreePrune?: string
  model?: string
  effort?: string
}

const MAX_PROMPT_LENGTH = 2000
const DEFAULT_REVIEW_PROMPT = '/code-review high'
const DEFAULT_COMPACT_PROMPT = '/compact'
const DEFAULT_ENTER_PROMPT = '/cd {path}'
const DEFAULT_MODEL_PROMPT = '/model'
const DEFAULT_EFFORT_PROMPT = '/effort'

// Free text from /config: no control characters and a length limit; empty means the default.
export function customPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH)
  return clean === '' ? undefined : clean
}

export function readOptions(options: Readonly<Record<string, unknown>>): DevbarOptions {
  const flag = (key: string) => options[key] !== false
  const language = options.language === 'pt' || options.language === 'en' ? options.language : 'auto'
  return {
    showModel: flag('showModel'),
    showGit: flag('showGit'),
    showLastCheck: flag('showLastCheck'),
    showCi: flag('showCi'),
    // PR starts off: the line is already long and not everyone uses pull requests.
    showPr: options.showPr === true,
    showPorts: flag('showPorts'),
    language,
    cacheTtl: options.cacheTtl === '5m' ? '5m' : '1h',
    plain: Object.fromEntries(
      BUTTON_GROUPS.map(g => [g, PLAIN_BY_DEFAULT.includes(g) ? options[PLAIN_OPTION[g]] !== false : options[PLAIN_OPTION[g]] === true]),
    ) as Record<ButtonGroup, boolean>,
    prompts: {
      commit: customPrompt(options.commitPrompt),
      review: customPrompt(options.reviewPrompt),
      testFix: customPrompt(options.testFixPrompt),
      ciFix: customPrompt(options.ciFixPrompt),
      compact: customPrompt(options.compactPrompt),
      worktreeEnter: customPrompt(options.worktreeEnterPrompt),
      worktreeRemove: customPrompt(options.worktreeRemovePrompt),
      worktreePrune: customPrompt(options.worktreePrunePrompt),
      model: customPrompt(options.modelPrompt),
      effort: customPrompt(options.effortPrompt),
    },
  }
}

// Each button's text: the person's own, if any; otherwise the language default.
// `vars` fills the text's variables: {command} (the command that failed) in the test fix, {worktree} in
// "remove" and "enter", {path} (path relative to the session) in "enter".
export function buttonPrompt(
  kind: keyof CustomPrompts,
  prompts: CustomPrompts,
  lang: Lang,
  vars: Readonly<Record<string, string>> = {},
): string {
  const text = TEXT[lang]
  const fallback: Record<keyof CustomPrompts, string> = {
    commit: text.pane.commitPrompt,
    review: DEFAULT_REVIEW_PROMPT,
    testFix: text.fixPrompt('{command}'),
    ciFix: text.ciFixPrompt,
    compact: DEFAULT_COMPACT_PROMPT,
    worktreeEnter: DEFAULT_ENTER_PROMPT,
    worktreeRemove: text.pane.removePrompt('{worktree}'),
    worktreePrune: text.pane.prunePrompt,
    model: DEFAULT_MODEL_PROMPT,
    effort: DEFAULT_EFFORT_PROMPT,
  }
  // A function as replacement: with a string, replaceAll would read "$&" and "$1" in the value as patterns.
  return Object.entries(vars).reduce((prompt, [name, value]) => prompt.replaceAll(`{${name}}`, () => value), prompts[kind] ?? fallback[kind])
}
