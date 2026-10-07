import { describe, expect, mock, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

type RunInput = { readonly argv: readonly string[]; readonly init?: ProcessRunInit }
type RunAnswer = { value: ProcessRunResult }

// On Windows devbar finds each program's full path with where.exe (run in System32) before running it.
// Here every program lives in C:\bin, and the test handler sees only the name ("git", "powershell").
function byName(handler: (e: RunInput) => RunAnswer | Promise<RunAnswer>) {
  return async (_$: unknown, e: RunInput): Promise<RunAnswer> => {
    const [exe = '', ...args] = e.argv
    if (/\\System32\\where\.exe$/i.test(exe)) {
      expect(e.init?.cwd).toMatch(/\\System32$/i)
      return { value: { exitCode: 0, stdout: `C:\\bin\\${args[0]}.exe\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const name = /^C:\\bin\\(.+)\.exe$/.exec(exe)?.[1] ?? exe
    return handler({ ...e, argv: [name, ...args] })
  }
}

describe('button in the hint line', () => {
  test('the terminal accepts the button and a click switches the meter', async ($, on) => {
    on('session.model', async () => ({ value: 'm' }))
    mock.env(on, { USERPROFILE: 'C:/x', LANG: 'pt_BR.UTF-8' })
    const clock = mock.clock(on)
    on('session.root', async () => ({ value: 'C:/x/d' }))
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] },
    }))
    on('session.start', async () => ({ cwd: 'C:/x/d' }))
    on('ui.status', async () => ({ value: undefined }))
    // The engine's line, which the mod gets from next(e).
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/x/d', surface: 'terminal', isInteractive: true })
    await clock.advance(0) // the reading runs on a timer, outside the turn

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await ui.find({ key: 'view' }))?.text).toContain('Contexto')
    await ui.press({ key: 'view' })
    expect((await ui.find({ key: 'view' }))?.text).toContain('5 horas')
    expect(await ui.find({ type: 'Text', text: /40%/ })).toBeDefined()
    await ui.unmount()
  })

  test('clicking a port copies the URL and clicking fix fills the prompt', async ($, on) => {
    const copied: string[] = []
    const filled: string[] = []
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('process.run', byName(async e => {
      const out = (stdout: string) => ({
        value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'netstat') return out('  TCP    0.0.0.0:13000   0.0.0.0:0   LISTENING   777')
      if (e.argv[0] === 'powershell' && String(e.argv[3]).includes('Win32_Process')) {
        return out('777\tnode C:/Users/u/proj/node_modules/vite/bin/vite.js')
      }
      return out('pt-BR')
    }))
    on('ui.copy', async (_$, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    on('ui.toast', async () => ({ value: undefined }))
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('tool.call', { tool: 'Bash' }, async () => ({ result: 'exit code 1', isError: true }))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    await $.tool.call({ tool: 'Bash', command: 'pytest -q' })

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await ui.find({ key: 'port-13000' }))?.text).toContain('web :13000')
    await ui.press({ key: 'port-13000' })
    expect(copied).toEqual(['http://localhost:13000'])
    expect((await ui.find({ key: 'port-13000' }))?.text).toContain('copiado')
    // The folder is a button without brackets by default: copies the session's full path.
    const project = await ui.find({ key: 'project' })
    expect(project?.props?.plain).toBe(true)
    expect(project?.props?.dimColor).toBeUndefined()
    await ui.press({ key: 'project' })
    expect(copied).toEqual(['http://localhost:13000', 'C:/Users/u/proj'])
    expect((await ui.find({ key: 'project' }))?.text).toBe('copiado')
    await clock.advance(1500)
    expect((await ui.find({ key: 'port-13000' }))?.text).toContain('web :13000')
    await ui.press({ key: 'fix' })
    expect(filled[0]).toContain('pytest')
    expect((await ui.find({ key: 'model' }))?.text).toContain('opus 5.5')
    await ui.unmount()

    // 40-column terminal: nothing is hidden (the line wraps in the terminal), the meter is still there.
    const narrow = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
      viewport: { columns: 40, rows: 24 },
    })
    expect(await narrow.find({ key: 'model' })).toBeDefined()
    expect(await narrow.find({ key: 'port-13000' })).toBeDefined()
    expect((await narrow.find({ key: 'project' }))?.text).toBe('proj')
    expect(await narrow.find({ key: 'view' })).toBeDefined()
    await narrow.unmount()
  })

  test('PR and CI: a click copies the link and confirms with "copied"', { options: { showPr: true } }, async ($, on) => {
    const copied: string[] = []
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    // Only the .github/workflows folder exists.
    on('fs.stat', async (_$, e) =>
      /\.github[\\/]workflows$/.test(String(e.path))
        ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
        : { deny: 'not found' },
    )
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      const [cmd, sub] = e.argv
      if (cmd === 'powershell') return out('pt-BR')
      if (cmd === 'git' && e.argv.includes('status')) return out('## main...origin/main\n')
      if (cmd === 'gh' && sub === 'run') {
        return out(JSON.stringify([{ status: 'completed', conclusion: 'failure', event: 'push', url: 'https://github.com/o/r/actions/runs/7' }]))
      }
      if (cmd === 'gh' && sub === 'pr') {
        return out(JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', url: 'https://github.com/o/r/pull/42' }))
      }
      return out('', 1)
    }))
    on('ui.copy', async (_$, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await ui.find({ key: 'pr' }))?.text).toContain('PR #42')
    expect(await ui.find({ type: 'Text', text: /aprovado/ })).toBeDefined()
    await ui.press({ key: 'pr' })
    expect((await ui.find({ key: 'pr' }))?.text).toContain('copiado')
    await ui.press({ key: 'ci' })
    expect(copied).toEqual(['https://github.com/o/r/pull/42', 'https://github.com/o/r/actions/runs/7'])
    await ui.unmount()
  })

  test('clicking the branch opens the git panel with files and commits', async ($, on) => {
    const opened: string[] = []
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'powershell') return out('pt-BR')
      if (e.argv.includes('status')) return out('## main...origin/main [ahead 1]\n M src/app.ts\n?? src/new.ts\n')
      if (e.argv.includes('log')) return out('583421a\tfeat: search by name\t28 hours ago\n')
      if (e.argv.includes('--numstat')) return out('42\t7\tsrc/app.ts\n3\t0\tsrc/new.ts\n')
      return out('', 1)
    }))
    const filled: string[] = []
    const copiedValues: string[] = []
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('ui.copy', async (_$, e) => {
      copiedValues.push(e.text)
      return { value: { isCopied: true } }
    })
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const line = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await line.find({ key: 'git' }))?.text).toContain('main* ↑1 ±2')
    await line.press({ key: 'git' })
    expect(opened).toEqual(['devbar-git'])
    await line.unmount()

    const pane = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'devbar-git',
      props: {
        title: 'git',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await pane.find({ type: 'Text', text: 'Modificados (2)' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'src/new.ts' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'feat: search by name' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '+42 −7' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\+45 −7/ })).toBeDefined()
    await pane.press({ key: 'commit' })
    expect(filled[0]).toContain('commit')
    // The hash stays gray: visual hierarchy, the commit subject is read first.
    expect((await pane.find({ key: 'hash-583421a' }))?.props?.dimColor).toBe(true)
    await pane.press({ key: 'hash-583421a' })
    expect(copiedValues).toEqual(['583421a'])
    expect((await pane.find({ key: 'hash-583421a' }))?.text).toContain('copiado')
    await pane.unmount()
  })

  test('effort next to the model; context with tokens, cache and the compact button', async ($, on) => {
    const filled: string[] = []
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    // 790k of 1M: 79% raw, above 50% usable.
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { window: 1_000_000, tokens: 790_000, percent: 79 }, rateLimits: [] },
    }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('process.run', byName(async e => ({
      value: { exitCode: e.argv[0] === 'powershell' ? 0 : 1, stdout: 'pt-BR', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })))
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    let draft = ''
    const toasts: string[] = []
    on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }))
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('classic.Stop', async () => ({}))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await $.classic.Stop({ stop_hook_active: false, effort: { level: 'high' } })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    // Model and effort are buttons without brackets by default: they fill /model and /effort.
    const modelButton = await ui.find({ key: 'model' })
    expect(modelButton?.text).toContain('opus 5.5')
    expect(modelButton?.props?.plain).toBe(true)
    const effortButton = await ui.find({ key: 'effort' })
    expect(effortButton?.text).toContain('high')
    expect(effortButton?.props?.plain).toBe(true)
    // A button without brackets stays white (gray looks like text and hides that it is clickable).
    expect(modelButton?.props?.dimColor).toBeUndefined()
    expect(effortButton?.props?.dimColor).toBeUndefined()
    expect((await ui.find({ key: 'compact', type: 'Button' }))?.props?.dimColor).toBeUndefined()
    // "45k até" in gray; only the word "compactar" is the button (without brackets) that fills /compact.
    expect(await ui.find({ type: 'Text', text: /45k até/ })).toBeDefined()
    expect((await ui.find({ key: 'compact' }))?.text).toContain('compactar')
    // With a draft in the box, /compact would land mid-text and go to the model: no fill, a warning instead.
    draft = 'fix the bug'
    await ui.press({ key: 'compact' })
    expect(filled).toEqual([])
    expect(toasts.at(-1)).toBe('Esvazie o prompt para usar /compact: comando de barra só funciona no começo.')
    draft = ''
    await ui.press({ key: 'compact' })
    expect(filled).toEqual(['/compact'])
    await ui.press({ key: 'model' })
    await ui.press({ key: 'effort' })
    expect(filled).toEqual(['/compact', '/model', '/effort'])
    await ui.unmount()
  })

  test('Plain per button: only the group turned on loses its brackets', { options: { plainMeter: true, plainModel: false, plainProject: false } }, async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    // Only git status answers (the branch becomes a button); the filter check finds nothing.
    on('process.run', byName(async e => ({
      value: {
        exitCode: e.argv[0] === 'git' && e.argv.includes('status') ? 0 : 1,
        stdout: e.argv[0] === 'git' && e.argv.includes('status') ? '## main\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    })))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    const viewButton = await ui.find({ key: 'view', type: 'Button' })
    expect(viewButton?.props?.plain).toBe(true)
    // The branch group was not turned on: it keeps its brackets.
    const gitButton = await ui.find({ key: 'git', type: 'Button' })
    expect(gitButton?.text).toContain('main')
    expect(gitButton?.props?.plain).toBeUndefined()
    // Model and folder with brackets turned back on: with brackets they stay white too.
    for (const key of ['model', 'project']) {
      const button = await ui.find({ key, type: 'Button' })
      expect(button).toBeDefined()
      expect(button?.props?.plain).toBeUndefined()
      expect(button?.props?.dimColor).toBeUndefined()
    }
    await ui.unmount()
  })

  test('an item turned off in the options does not show or run its query', { options: { showModel: false, showPorts: false } }, async ($, on) => {
    const commands: string[] = []
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('process.run', byName(async e => {
      commands.push(String(e.argv[0]))
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect(await ui.find({ key: 'model' })).toBeUndefined()
    expect((await ui.find({ key: 'project' }))?.text).toBe('proj')
    expect(commands).not.toContain('netstat')
    expect(commands).not.toContain('docker')
    await ui.unmount()
  })

  test('worktree: the line shows repo and worktree; the panel lists, removes and prunes stale ones', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/dev/feature-x' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/dev/feature-x' }))
    const list = [
      'worktree C:/dev/main-repo\nHEAD abc\nbranch refs/heads/master',
      'worktree C:/dev/feature-x\nHEAD abc\nbranch refs/heads/feature-x',
      'worktree C:/dev/loose\nHEAD abc\ndetached',
      'worktree C:/dev/gone\nHEAD abc\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location',
      'worktree C:/dev/frozen\nHEAD abc\nbranch refs/heads/frozen\nlocked external disk',
      'worktree C:/dev/offline\nHEAD abc\nbranch refs/heads/offline\nlocked',
      // Network folder from a hostile .git: no git status, exists or /cd on it.
      'worktree \\\\nas\\share\\wt\nHEAD abc\nbranch refs/heads/network',
    ].join('\n\n')
    const statusAt: string[] = []
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'powershell') return out('pt-BR')
      if (e.argv.includes('--git-common-dir')) return out('C:/dev/feature-x\nC:/dev/main-repo/.git/worktrees/feature-x\nC:/dev/main-repo/.git\n')
      if (e.argv.includes('worktree')) return out(`${list}\n`)
      if (e.argv.includes('status')) {
        statusAt.push(e.init?.cwd ?? '')
        return out(e.init?.cwd === 'C:/dev/loose' ? '## HEAD (no branch)\n M a.ts\n?? b.ts\n' : '## feature-x\n')
      }
      return out('', 1)
    }))
    const filled: string[] = []
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    // Only the locked "offline" one has its folder unavailable (external drive unplugged).
    const existsAt: string[] = []
    on('fs.exists', async (_$, e) => {
      existsAt.push(String(e.path))
      return { value: !String(e.path).includes('offline') }
    })
    // Empty prompt box: the /cd of "enter" can go in.
    on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/dev/feature-x', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const line = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await line.find({ key: 'project' }))?.text).toBe('main-repo')
    expect((await line.find({ key: 'worktree' }))?.text).toContain('wt feature-x')
    await line.press({ key: 'git' })
    await line.unmount()

    const pane = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'devbar-git',
      props: { title: 'git', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: 'Worktrees (7)' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'sem branch' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '±2' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'abandonado' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'travado' })).toBeDefined()
    // The stale one has no folder: no git status on it.
    expect(statusAt).not.toContain('C:/dev/gone')
    expect(statusAt.some(p => p.startsWith('\\'))).toBe(false)
    expect(existsAt.some(p => p.startsWith('\\'))).toBe(false)
    // Main, current, stale, locked and network worktrees get no "remove".
    for (const i of [0, 1, 3, 4, 5, 6]) expect(await pane.find({ key: `wt-remove-${i}` })).toBeUndefined()
    await pane.press({ key: 'wt-remove-2' })
    // The name goes, not the path: Claude finds the path with git worktree list.
    expect(filled[0]).toContain('`loose`')
    expect(filled[0]).not.toContain('C:/dev')
    expect(filled[0]).toContain('git worktree remove')
    await pane.press({ key: 'wt-prune' })
    expect(filled[1]).toContain('git worktree prune --dry-run')
    // "enter": on all but the current, the stale and the unavailable locked one, with the path seen from the session.
    for (const i of [1, 3, 5, 6]) expect(await pane.find({ key: `wt-enter-${i}` })).toBeUndefined()
    expect(await pane.find({ key: 'wt-enter-4' })).toBeDefined()
    await pane.press({ key: 'wt-enter-0' })
    expect(filled[2]).toBe('/cd ../main-repo')
    await pane.unmount()
  })

  test('repo with a content filter in .git/config: no status or diff, only the branch and the warning', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/dev/hostile' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/dev/hostile' }))
    const gitCalls: string[] = []
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'powershell') return out('pt-BR')
      if (e.argv[0] !== 'git') return out('', 1)
      gitCalls.push(e.argv.join(' '))
      // The .git/config downloaded with the repo defines a filter that runs a script from the repo itself.
      if (e.argv.includes('config') && e.argv.includes('--local')) return out('filter.x.clean ./tools/x.sh\n')
      if (e.argv.includes('symbolic-ref')) return out('main\n')
      if (e.argv.includes('log')) return out('583421a\tfeat: x\t2 hours ago\n')
      return out('', 1)
    }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/dev/hostile', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const line = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await line.find({ key: 'git' }))?.text).toContain('main ⚠')
    await line.press({ key: 'git' })
    await line.unmount()

    const pane = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'devbar-git',
      props: { title: 'git', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: /filtros de conteúdo no \.git\/config/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Nada modificado.' })).toBeUndefined()
    // Commits still show: log does not compare file content.
    expect(await pane.find({ type: 'Text', text: 'feat: x' })).toBeDefined()
    // No reading that compares content (it would run the filter).
    expect(gitCalls.some(c => / status( |$)/.test(c) || / diff /.test(c))).toBe(false)
    await pane.unmount()
  })

  test('CI: a passing gh failure in the middle neither erases the state nor loses the "passed" notice', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('fs.stat', async (_$, e) =>
      /\.github[\\/]workflows$/.test(String(e.path))
        ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
        : { deny: 'not found' },
    )
    // `gh run list` answers in sequence: running, failure (network), passed.
    const runs: (string | undefined)[] = [
      JSON.stringify([{ status: 'in_progress', event: 'push', url: 'https://github.com/o/r/actions/runs/7', databaseId: 7 }]),
      undefined,
      JSON.stringify([{ status: 'completed', conclusion: 'success', event: 'push', url: 'https://github.com/o/r/actions/runs/7', databaseId: 7 }]),
    ]
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'powershell') return out('pt-BR')
      if (e.argv[0] === 'git' && e.argv.includes('status')) return out('## main...origin/main\n')
      if (e.argv[0] === 'gh' && e.argv[1] === 'run') {
        const next = runs.shift()
        return next === undefined ? out('', 1) : out(next)
      }
      return out('', 1)
    }))
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0) // CI running: the watch checks again every 30 s
    await clock.advance(30_000) // gh fails: the "running" state stays
    expect(toasts).toEqual([])
    await clock.advance(30_000)
    expect(toasts).toEqual(['CI passou no main'])
  })

  test('/cd (folder change without a turn) updates the line right away', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    let root = 'C:/dev/old'
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: root }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: root }))
    on('process.run', byName(async () => ({
      value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })))
    on('classic.CwdChanged', async () => ({}))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    root = 'C:/dev/new'
    await $.classic.CwdChanged({ old_cwd: 'C:/dev/old', new_cwd: root })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await ui.find({ key: 'project' }))?.text).toBe('new')
    await ui.unmount()
  })

  test('folder changed without CwdChanged or a turn (/cd in a real session): the line updates within seconds', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    let root = 'C:/dev/old'
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: root }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: root }))
    on('process.run', byName(async () => ({
      value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    root = 'C:/dev/new'
    await clock.advance(5_000)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    expect((await ui.find({ key: 'project' }))?.text).toBe('new')
    await ui.unmount()
  })

  test('folder changed without notice: the line redraw notices and updates right away', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    let root = 'C:/dev/old'
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: root }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: root }))
    on('process.run', byName(async () => ({
      value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    root = 'C:/dev/new'
    const mount = () => $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    const before = await mount() // /cd redraws the prompt box
    await before.unmount()
    await clock.advance(0)

    const after = await mount()
    expect((await after.find({ key: 'project' }))?.text).toBe('new')
    await after.unmount()
  })

  test('a panel that did not open is not marked open (no git log on refreshes)', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000, percent: 10 }, rateLimits: [] } }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    const gitCalls: string[] = []
    on('process.run', byName(async e => {
      const out = (stdout: string, exitCode = 0) => ({
        value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (e.argv[0] === 'git') gitCalls.push(e.argv.join(' '))
      if (e.argv[0] === 'powershell') return out('pt-BR')
      if (e.argv[0] === 'git' && e.argv.includes('status')) return out('## main\n')
      return out('', 1)
    }))
    on('ui.open', async () => ({ deny: 'no room' }))
    on('classic.CwdChanged', async () => ({}))
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)
    const line = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    await line.press({ key: 'git' })
    await line.unmount()
    // A refresh after the click: with the pane marked open, it would read git log.
    await $.classic.CwdChanged({ old_cwd: 'C:/Users/u/proj', new_cwd: 'C:/Users/u/proj' })
    await clock.advance(0)
    expect(gitCalls.some(c => c.includes(' log '))).toBe(false)
  })

  test('slash command with the prompt read refused: does not fill and warns', async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LANG: 'pt_BR' })
    const clock = mock.clock(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.root', async () => ({ value: 'C:/Users/u/proj' }))
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { window: 1_000_000, tokens: 100_000, percent: 10 }, rateLimits: [] },
    }))
    on('session.start', async () => ({ cwd: 'C:/Users/u/proj' }))
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    const filled: string[] = []
    const toasts: string[] = []
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('prompt.read', async () => ({ deny: 'no prompt access' }))
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: 'C:/Users/u/proj', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    const ui = await $.ui.mount({
      plugin: 'devbar',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '' },
    })
    await ui.press({ key: 'compact' })
    expect(filled).toEqual([])
    // Without PowerShell in the test, the language falls back to English.
    expect(toasts.at(-1)).toBe('Could not check the prompt; /compact was not added. Type it with the box empty.')
    await ui.unmount()
  })
})
