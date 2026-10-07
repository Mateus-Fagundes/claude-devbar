// Draws the dev line: model │ task │ folder │ git │ last test │ CI │ PR │ ports │ meter.
// No `$`, like pane.tsx: it gets the surface elements, the data read from the atoms and the actions
// already built in register.tsx (the engine validator does not follow `$` across imports). Side effects
// only through the actions.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { CheckRun, CiStatus, Lang, MeterView, StatusLine } from '../types'
import { CI_COLOR, CI_SYMBOL, PR_COLOR } from './format/ci'
import { gitLabel } from './format/git'
import { ago, barColor, cacheLeft, contextBar, contextNote, effectiveView, meter, nextView } from './format/meter'
import { buttonPrompt, buttonStyle } from './format/options'
import type { ButtonGroup, DevbarOptions } from './format/options'
import { portLabel } from './format/ports'
import { TEXT } from './format/text'

const SEPARATOR = ' │ '

export type StatusLineInput = {
  status: StatusLine
  task: string
  // View chosen with the meter button (a quota alert can take the place of "ctx").
  chosenView: MeterView
  check: CheckRun | null
  ci: CiStatus | null
  effort: string | null
  lastRequestAt: number | null
  language: Lang
  // Key of the button that shows "copied" right now.
  justCopied: string | null
  now: number
  options: DevbarOptions
}

// They return the promise: onPress hands it to the engine, which waits for it and sees any error.
export type StatusLineActions = {
  ask: (prompt: string) => Promise<void>
  // The CI "fix" text needs the run log, read from the host in register.tsx.
  askCiFix: () => Promise<void>
  copy: (key: string, value: string, surface: RenderSurface) => Promise<void>
  openGitPane: () => Promise<void>
  showView: (view: MeterView) => Promise<void>
}

type Piece = { key: string; isSub?: boolean; node: RenderElement }

export function drawStatusLine(ui: ElementTable, input: StatusLineInput, actions: StatusLineActions): RenderElement {
  const { status, task, check, effort, lastRequestAt, language, justCopied, now, options } = input
  const { Box, Button, Text } = ui
  const text = TEXT[language]
  // CI and PR only when they belong to the folder and branch the line shows (the gh read may lag behind).
  const ciStatus = input.ci !== null && input.ci.root === status.root && input.ci.branch === status.git?.branch ? input.ci : null
  const ciState = ciStatus?.state
  const shownView = effectiveView(input.chosenView, status, now)
  const shown = meter(status, shownView, now, language)
  const style = (group: ButtonGroup) => buttonStyle(options.plain, group)
  // Copies and swaps the button label to "copied" for a moment.
  const copyButton = (key: string, label: string, url: string, group: ButtonGroup) => (
    <Button key={key} {...style(group)} label={justCopied === key ? text.copied : label} onPress={press => actions.copy(key, url, press.surface)} />
  )

  // Order: model │ task │ folder; the dev items come after the folder.
  // `isSub` continues the previous piece (separated by a space, no "│").
  // With a pane open, the width the engine reports (e.viewport) is the conversation column's, not this
  // line's; so nothing is hidden to fit: the line wraps wherever the terminal wraps it.
  const pieces: Piece[] = []
  const add = (key: string, node: RenderElement, isSub = false) => pieces.push({ key, node, isSub })

  if (options.showModel) {
    // Model and effort are buttons: they fill /model and /effort.
    const askModel = () => actions.ask(buttonPrompt('model', options.prompts, language))
    const askEffort = () => actions.ask(buttonPrompt('effort', options.prompts, language))
    add('model-effort', (
      <Box>
        <Button key="model" {...style('model')} label={status.model} onPress={askModel} />
        {effort !== null && <Text dimColor> · </Text>}
        {effort !== null && <Button key="effort" {...style('effort')} label={effort} onPress={askEffort} />}
      </Box>
    ))
  }
  if (task !== '') add('task', <Text bold>{task}</Text>)
  // The folder is a button: it copies the session's full path.
  add('project-copy', (
    <Button
      key="project"
      {...style('project')}
      label={justCopied === 'project' ? text.copied : status.project}
      onPress={press => actions.copy('project', status.root, press.surface)}
    />
  ))
  if (status.worktree !== undefined) {
    // In a linked worktree: "repo wt name"; otherwise the line would only show the worktree folder name.
    add('worktree', <Box><Text dimColor>{`${text.worktreeTag} `}</Text><Text bold>{status.worktree}</Text></Box>, true)
  }
  if (options.showGit && status.git) {
    // The branch is a button: it opens the git pane (opened by a click, it shows at any width).
    add('git', <Button key="git" {...style('branch')} label={gitLabel(status.git)} onPress={actions.openGitPane} />)
  }
  if (options.showLastCheck && check !== null) {
    add('check', (
      <Box>
        <Text dimColor>{check.label} </Text>
        <Text color={check.isOk ? 'success' : 'error'}>{check.isOk ? '✓' : '✗'}</Text>
      </Box>
    ))
    add('check-ago', <Text dimColor>{ago(check.at, now, language)}</Text>, true)
    if (!check.isOk) {
      const askTestFix = () => actions.ask(buttonPrompt('testFix', options.prompts, language, { command: check.label }))
      add('check-fix', <Button key="fix" {...style('fix')} label={text.fix} onPress={askTestFix} />, true)
    }
  }
  if (options.showCi && ciState !== undefined) {
    // "CI" is a button when there is a run link: clicking copies it.
    const runUrl = ciStatus?.runUrl
    add('ci', (
      <Box>
        {runUrl !== undefined ? copyButton('ci', 'CI', runUrl, 'ci') : <Text dimColor>CI</Text>}
        <Text color={CI_COLOR[ciState]}>{` ${CI_SYMBOL[ciState]}`}</Text>
      </Box>
    ))
    if (ciState === 'fail') {
      add('ci-fix', <Button key="ci-fix" {...style('fix')} label={text.fix} onPress={actions.askCiFix} />, true)
    }
  }
  const pr = ciStatus?.pr
  if (options.showPr && pr !== undefined) {
    add('pr', (
      <Box>
        {copyButton('pr', `PR #${pr.number}`, pr.url, 'pr')}
        <Text color={PR_COLOR[pr.review]} dimColor={pr.review === 'draft'}>{` ${text.review[pr.review]}`}</Text>
      </Box>
    ))
  }
  if (options.showPorts) {
    // In port order: the live ones are buttons (they copy the URL); the ones that went down keep the
    // same button shape, in red with ✗, so the line keeps a single look.
    const all = [...status.ports.map(p => ({ ...p, isDown: false })), ...status.downPorts.map(p => ({ ...p, isDown: true }))]
    all.sort((a, b) => a.port - b.port)
    all.forEach((p, i) => {
      const node = p.isDown ? (
        <Text color="error">{options.plain.ports ? `${portLabel(p)} ✗` : `[ ${portLabel(p)} ✗ ]`}</Text>
      ) : (
        copyButton(`port-${p.port}`, portLabel(p), `http://localhost:${p.port}`, 'ports')
      )
      add(`${p.isDown ? 'down' : 'port'}-${p.port}`, node, i > 0)
    })
  }

  add('meter', (
    <Box>
      <Button key="view" {...style('meter')} label={text.views[shownView]} onPress={() => actions.showView(nextView(shownView))} />
      {shown === undefined && <Text dimColor> {text.noReading}</Text>}
      {shown?.used !== undefined && <Text color={barColor(shown.used)}> {contextBar(shown.used)}</Text>}
    </Box>
  ))
  if (shownView === 'context') {
    // Context: "45k to" in gray and the word "compact" as a bracketless button (fills /compact);
    // then the cache time.
    const note = contextNote(status, cacheLeft(lastRequestAt, options.cacheTtl, now), language)
    if (note.compact !== undefined) {
      const askCompact = () => actions.ask(buttonPrompt('compact', options.prompts, language))
      add('compact', (
        <Box>
          <Text dimColor>{`${note.compact} `}</Text>
          <Button key="compact" {...style('compact')} label={text.compactWord} onPress={askCompact} />
        </Box>
      ), true)
    }
    if (note.cache !== undefined) {
      const cache = note.cache
      const node = note.isCacheWarn ? <Text color="warning">{cache}</Text> : <Text dimColor>{cache}</Text>
      add('cache', <Box><Text dimColor>{note.compact !== undefined ? '· ' : ''}</Text>{node}</Box>, true)
    }
  } else if (shown !== undefined && shown.note !== '') {
    const note = shown.isPaceHigh ? <Text color="warning">{shown.note}</Text> : <Text dimColor>{shown.note}</Text>
    add('meter-note', note, true)
  }

  return (
    <Box flexWrap="wrap">
      {pieces.map((p, i) => (
        <Box key={p.key} flexShrink={0}>
          {i > 0 && <Text dimColor>{p.isSub ? ' ' : SEPARATOR}</Text>}
          {p.node}
        </Box>
      ))}
    </Box>
  )
}
