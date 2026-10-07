// Draws the git pane: branch, operation in progress, files with +/-, commits and worktrees.
// No `$`: it gets the surface elements, the data and the actions already built in register.tsx (the
// engine validator does not follow `$` across imports). Side effects only through the actions (fill the
// prompt, copy), never directly.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { GitCommit, GitDetail, GitInfo, Lang, Worktree } from '../types'
import { fileColor, isPlainCdPath, isPlainName, MAX_PANE_WORKTREES, relativePath, statLabel, statusPathKey, totalStats } from './format/git'
import { buttonPrompt, buttonStyle } from './format/options'
import type { ButtonGroup, CustomPrompts, DevbarOptions } from './format/options'
import { TEXT } from './format/text'

export type GitPaneInput = {
  root: string
  git: GitInfo
  detail: GitDetail
  language: Lang
  // Key of the button that shows "copied" right now.
  justCopied: string | null
  rows: number | undefined
  options: DevbarOptions
}

// They return the promise: onPress hands it to the engine, which waits for it and sees any error.
export type GitPaneActions = {
  ask: (prompt: string) => Promise<void>
  copy: (key: string, value: string, surface: RenderSurface) => Promise<void>
}

type Pane = {
  ui: ElementTable
  text: (typeof TEXT)[Lang]
  justCopied: string | null
  style: (group: ButtonGroup) => { plain?: true }
  askFor: (kind: keyof CustomPrompts, vars?: Readonly<Record<string, string>>) => Promise<void>
  copy: GitPaneActions['copy']
}

export function drawGitPane(ui: ElementTable, input: GitPaneInput, actions: GitPaneActions): RenderElement {
  const { git, detail, language, options } = input
  const pane: Pane = {
    ui,
    text: TEXT[language],
    justCopied: input.justCopied,
    style: group => buttonStyle(options.plain, group),
    askFor: (kind, vars) => actions.ask(buttonPrompt(kind, options.prompts, language, vars)),
    copy: actions.copy,
  }
  // Fit the pane height: files first, then commits and worktrees.
  const room = Math.max(4, (input.rows ?? 30) - 10)
  const fileRows = Math.max(1, room - detail.log.length - worktreeRows(detail.worktrees) - 2)
  const { Box } = ui
  return (
    <Box flexDirection="column">
      {drawHeader(pane, git, detail)}
      {drawFiles(pane, git, detail, fileRows)}
      {drawCommits(pane, detail.log)}
      {drawWorktrees(pane, detail.worktrees, input.root, options)}
    </Box>
  )
}

// Rows the worktree section takes (zero when it is not shown).
function worktreeRows(worktrees: readonly Worktree[]): number {
  if (worktrees.length === 0) return 0
  const shown = Math.min(worktrees.length, MAX_PANE_WORKTREES)
  return shown + 2 + (worktrees.some(w => w.isPrunable) ? 1 : 0) + (worktrees.length > shown ? 1 : 0)
}

// Operation in progress, branch, sync (or the restricted repo warning) and the commit/review buttons.
function drawHeader({ ui, text, style, askFor }: Pane, git: GitInfo, detail: GitDetail): RenderElement {
  const { Box, Button, Text } = ui
  const op = detail.operation
  return (
    <Box flexDirection="column">
      {op !== undefined && <Text color="error" bold>{text.pane.operation(op.kind, op.step, op.total)}</Text>}
      <Text bold>{git.branch}</Text>
      {git.isRestricted ? <Text color="warning">{text.pane.restricted}</Text> : <Text dimColor>{text.pane.sync(git.ahead, git.behind)}</Text>}
      {git.changed > 0 && (
        <Box marginTop={1}>
          <Button key="commit" {...style('paneActions')} label={text.pane.commit} onPress={() => askFor('commit')} />
          <Text> </Text>
          <Button key="review" {...style('paneActions')} label={text.pane.review} onPress={() => askFor('review')} />
        </Box>
      )}
    </Box>
  )
}

// Files with their +/- lines (from git diff --numstat). Renamed: the status shows "old -> new" and
// numstat has only the new one. Conflicts already come first from parseGitStatus (before the cut at 50).
function drawFiles({ ui, text }: Pane, git: GitInfo, detail: GitDetail, maxRows: number): RenderElement {
  const { Box, Text } = ui
  const statOf = (path: string) => detail.stats.find(s => s.path === statusPathKey(path))
  const total = totalStats(detail.stats)
  const totalLabel = statLabel(total.added, total.removed)
  const shownFiles = git.files.slice(0, maxRows)
  const hidden = git.changed - shownFiles.length
  return (
    <Box flexDirection="column">
      <Text> </Text>
      {/* Restricted: the changes were not read, so no "Nothing changed". */}
      {!git.isRestricted && (
        <Box>
          <Text bold>{git.changed === 0 ? text.pane.clean : text.pane.changes(git.changed)}</Text>
          {totalLabel !== '' && <Text dimColor>{`  ${totalLabel}`}</Text>}
        </Box>
      )}
      {shownFiles.map(f => {
        const stat = statOf(f.path)
        const label = statLabel(stat?.added, stat?.removed)
        return (
          <Box key={`file-${f.path}`}>
            {/* Fixed width for the code and a margin instead of a space: the space disappears when the row shrinks. */}
            <Box flexShrink={0} width={2} marginRight={1}>
              <Text color={fileColor(f.code)}>{f.code}</Text>
            </Box>
            <Text wrap="truncate-start">{f.path}</Text>
            {label !== '' && (
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{label}</Text>
              </Box>
            )}
          </Box>
        )
      })}
      {hidden > 0 && <Text dimColor>{text.pane.more(hidden)}</Text>}
    </Box>
  )
}

// Recent commits. The hash is a button: it copies. Only the subject shrinks; hash and "when" stay whole.
function drawCommits({ ui, text, style, justCopied, copy }: Pane, log: readonly GitCommit[]): RenderElement {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text bold>{text.pane.commits}</Text>
      {log.length === 0 && <Text dimColor>{text.pane.noCommits}</Text>}
      {log.map(c => {
        const key = `hash-${c.hash}`
        return (
          <Box key={`commit-${c.hash}`}>
            <Box flexShrink={0} marginRight={1}>
              <Button
                key={key}
                {...style('hashes')}
                dimColor
                label={justCopied === key ? text.copied : c.hash}
                onPress={press => copy(key, c.hash, press.surface)}
              />
            </Box>
            <Text wrap="truncate-end">{c.subject}</Text>
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{`· ${c.when}`}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// Worktrees, only when there is more than one (readWorktrees returns [] otherwise), with "prune stale".
function drawWorktrees(pane: Pane, worktrees: readonly Worktree[], root: string, options: DevbarOptions): RenderElement {
  const { Box, Button, Text } = pane.ui
  if (worktrees.length === 0) return <Box />
  const shown = worktrees.slice(0, MAX_PANE_WORKTREES)
  const hidden = worktrees.length - shown.length
  // A repeated name does not go into the "remove" prompt: Claude would not know which one.
  const isUniqueName = (name: string) => worktrees.filter(w => w.name === name).length === 1
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text bold>{pane.text.pane.worktrees(worktrees.length)}</Text>
      {worktrees.some(w => w.isPrunable) && (
        <Box>
          <Button key="wt-prune" {...pane.style('paneActions')} label={pane.text.pane.prune} onPress={() => pane.askFor('worktreePrune')} />
        </Box>
      )}
      {shown.map((w, i) => drawWorktree(pane, w, i, root, options, isUniqueName(w.name)))}
      {hidden > 0 && <Text dimColor>{pane.text.pane.more(hidden)}</Text>}
    </Box>
  )
}

// One worktree row: current marker, name, branch, changes, locked/stale, enter and remove.
function drawWorktree(
  { ui, text, style, askFor }: Pane,
  w: Worktree,
  i: number,
  root: string,
  options: DevbarOptions,
  isUniqueName: boolean,
): RenderElement {
  const { Box, Button, Text } = ui
  // The main and the current one are not removed from here; a stale one goes with "prune stale";
  // git only removes a locked one with a double --force, which the prompt does not ask for.
  const canRemove = !w.isMain && !w.isCurrent && !w.isPrunable && !w.isLocked && !w.isNetwork && isPlainName(w.name) && isUniqueName
  // "enter" fills /cd with the path as seen from the session; a stale one has no folder to go to.
  const enterPath = relativePath(root, w.path)
  // Spaces in the path only with the default text (/cd, which never reaches the model); `.` is the
  // folder the session is already in.
  const canEnter =
    !w.isCurrent && !w.isPrunable && !w.isMissing && !w.isNetwork && enterPath !== '.' &&
    isPlainCdPath(enterPath, options.prompts.worktreeEnter === undefined)
  const enterVars = { path: enterPath, worktree: isPlainName(w.name) ? w.name : '' }
  const tag = (color: 'warning' | 'error', label: string) => (
    <Box flexShrink={0} marginLeft={1}>
      <Text color={color}>{label}</Text>
    </Box>
  )
  return (
    <Box key={`wt-${i}`}>
      <Box flexShrink={0} width={2}>
        <Text color="claude">{w.isCurrent ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end" bold={w.isCurrent}>{w.name}</Text>
      <Box flexShrink={0} marginLeft={1}>
        <Text dimColor>{w.branch ?? text.pane.noBranch}</Text>
      </Box>
      {w.changed !== undefined && w.changed > 0 && tag('warning', `±${w.changed}`)}
      {w.isLocked && tag('warning', text.pane.locked)}
      {w.isPrunable && tag('error', text.pane.prunable)}
      {canEnter && (
        <Box flexShrink={0} marginLeft={1}>
          <Button key={`wt-enter-${i}`} {...style('paneActions')} label={text.pane.enter} onPress={() => askFor('worktreeEnter', enterVars)} />
        </Box>
      )}
      {canRemove && (
        <Box flexShrink={0} marginLeft={1}>
          <Button key={`wt-remove-${i}`} {...style('paneActions')} label={text.pane.remove} onPress={() => askFor('worktreeRemove', { worktree: w.name })} />
        </Box>
      )}
    </Box>
  )
}
