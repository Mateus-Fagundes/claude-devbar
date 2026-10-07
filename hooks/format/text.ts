// UI texts in both languages, and the system language.
import type { Lang } from '../../types'

// Line texts per language; a language without a translation falls back to English.
export const TEXT = {
  pt: {
    views: { context: 'Contexto', five_hour: '5 horas', seven_day: 'Semana', cost: 'Custo' },
    now: 'agora',
    minutesAgo: (n: number) => `há ${n} min`,
    hoursAgo: (n: number) => `há ${n}h`,
    resetsIn: (span: string) => `reinicia em ${span}`,
    exhaustsIn: (span: string) => `acaba em ${span} nesse ritmo`,
    toCompact: (tokens: string) => `${tokens} até`,
    compactWord: 'compactar',
    cacheLeft: (span: string) => `cache ${span}`,
    cacheCold: 'cache frio',
    noReading: 'sem leitura ainda',
    contextWarning: (pct: number) => `Contexto em ${pct}%: hora de compactar ou abrir sessão nova.`,
    copied: 'copiado',
    clearPromptFirst: (command: string) => `Esvazie o prompt para usar ${command}: comando de barra só funciona no começo.`,
    promptUnreadable: (command: string) => `Não deu para conferir o prompt; ${command} não foi colocado. Digite-o com a caixa vazia.`,
    // No branch name: it comes from the repo and could carry instructions to the model.
    ciFixPrompt: 'O CI do branch atual falhou. Veja o log com `gh run view --log-failed`, ache a causa e corrija.',
    fix: 'corrigir',
    fixPrompt: (label: string) => `O \`${label}\` falhou. Investiga a causa e corrige.`,
    review: { approved: 'aprovado', changes: 'alterações pedidas', review: 'em revisão', draft: 'rascunho' },
    pane: {
      changes: (n: number) => `Modificados (${n})`,
      clean: 'Nada modificado.',
      commits: 'Últimos commits',
      noCommits: 'Nenhum commit ainda.',
      noRepo: 'Esta pasta não é um repositório git.',
      more: (n: number) => `... e mais ${n}`,
      sync: (ahead: number, behind: number) =>
        ahead === 0 && behind === 0 ? 'em dia com o remoto' : `${ahead} à frente, ${behind} atrás do remoto`,
      operation: (kind: string, step?: number, total?: number) =>
        `${kind} em andamento${step !== undefined && total !== undefined ? ` (${step}/${total})` : ''}`,
      commit: 'commitar',
      review: 'revisar',
      commitPrompt:
        'Faça o commit das mudanças atuais. Veja o `git log` para seguir o padrão de mensagem do projeto, ' +
        'separe em mais de um commit se houver mudanças sem relação entre si, e me pergunte antes de incluir ' +
        'arquivos que pareçam acidentais (dados de teste regravados, `.env`, arquivos de build).',
      restricted:
        'Este repo define filtros de conteúdo no .git/config, que rodam um programa a cada git status. ' +
        'Status desligado por segurança: confira o .git/config antes de confiar no repo.',
      worktrees: (n: number) => `Worktrees (${n})`,
      noBranch: 'sem branch',
      locked: 'travado',
      prunable: 'abandonado',
      enter: 'entrar',
      remove: 'remover',
      prune: 'limpar abandonados',
      removePrompt: (name: string) =>
        `Remova o worktree \`${name}\` (ache o caminho com \`git worktree list\`) com \`git worktree remove\`. ` +
        'Antes, confira se ele tem mudanças sem commit ou commits que não estão em nenhum outro branch e me pergunte ' +
        'se tiver. Não use `--force` sem eu pedir.',
      prunePrompt:
        'Rode `git worktree prune --dry-run --verbose`, me mostre o que seria limpo e, se eu concordar, rode `git worktree prune`.',
    },
    worktreeTag: 'wt',
    ciDone: (state: 'ok' | 'fail', branch: string) => `CI ${state === 'ok' ? 'passou' : 'falhou'} no ${branch}`,
    portsDown: (names: string) => `Caiu: ${names}`,
  },
  en: {
    views: { context: 'Context', five_hour: '5 hours', seven_day: 'Week', cost: 'Cost' },
    now: 'now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    resetsIn: (span: string) => `resets in ${span}`,
    exhaustsIn: (span: string) => `runs out in ${span} at this pace`,
    toCompact: (tokens: string) => `${tokens} to`,
    compactWord: 'compact',
    cacheLeft: (span: string) => `cache ${span}`,
    cacheCold: 'cache cold',
    noReading: 'no reading yet',
    contextWarning: (pct: number) => `Context at ${pct}%: time to compact or start a new session.`,
    copied: 'copied',
    clearPromptFirst: (command: string) => `Clear the prompt to use ${command}: a slash command only works at the start.`,
    promptUnreadable: (command: string) => `Could not check the prompt; ${command} was not added. Type it with the box empty.`,
    ciFixPrompt: 'CI failed on the current branch. Read the log with `gh run view --log-failed`, find the cause and fix it.',
    fix: 'fix',
    fixPrompt: (label: string) => `\`${label}\` failed. Find the cause and fix it.`,
    review: { approved: 'approved', changes: 'changes requested', review: 'in review', draft: 'draft' },
    pane: {
      changes: (n: number) => `Changed (${n})`,
      clean: 'Nothing changed.',
      commits: 'Recent commits',
      noCommits: 'No commits yet.',
      noRepo: 'This folder is not a git repository.',
      more: (n: number) => `... and ${n} more`,
      sync: (ahead: number, behind: number) =>
        ahead === 0 && behind === 0 ? 'up to date with remote' : `${ahead} ahead, ${behind} behind remote`,
      operation: (kind: string, step?: number, total?: number) =>
        `${kind} in progress${step !== undefined && total !== undefined ? ` (${step}/${total})` : ''}`,
      commit: 'commit',
      review: 'review',
      commitPrompt:
        'Commit the current changes. Check `git log` to follow the project message convention, ' +
        'split into several commits if there are unrelated changes, and ask me before including ' +
        'files that look accidental (regenerated test data, `.env`, build output).',
      restricted:
        'This repo defines content filters in .git/config, which run a program on every git status. ' +
        'Status is off for safety: check .git/config before trusting the repo.',
      worktrees: (n: number) => `Worktrees (${n})`,
      noBranch: 'no branch',
      locked: 'locked',
      prunable: 'stale',
      enter: 'enter',
      remove: 'remove',
      prune: 'prune stale',
      removePrompt: (name: string) =>
        `Remove the worktree \`${name}\` (find its path with \`git worktree list\`) with \`git worktree remove\`. ` +
        'First check whether it has uncommitted changes or commits that are on no other branch, and ask me if it ' +
        'does. Do not use `--force` unless I ask.',
      prunePrompt:
        'Run `git worktree prune --dry-run --verbose`, show me what would be pruned and, if I agree, run `git worktree prune`.',
    },
    worktreeTag: 'wt',
    ciDone: (state: 'ok' | 'fail', branch: string) => `CI ${state === 'ok' ? 'passed' : 'failed'} on ${branch}`,
    portsDown: (names: string) => `Down: ${names}`,
  },
} satisfies Record<Lang, unknown>

// "pt-BR", "pt_PT.UTF-8" -> pt; anything else -> en.
export function langFromLocale(locale: string | undefined): Lang {
  return locale?.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}
