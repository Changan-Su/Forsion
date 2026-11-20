/**
 * 「继续生成」行(2026-11-10):回答因报错 / 额度用完停在半截时,用户点「继续生成」发出的 user 行。
 * 和「重新生成」(删掉这一轮、从上一条用户消息重发)是两条路:这里什么都不删,失败那一轮已落库的正文、
 * 工具调用与结果原样留在上下文里,模型接着往下写。
 *
 * 正文给模型看(英文,措辞照 agentLoop 的 <stream_resume>);对人渲染成一条轻分隔线,↑ 历史召回、画布树、
 * 重试 / 重新生成找「最后一条用户消息」时都当机器行跳过。走普通发送,老引擎 / 远端引擎不认识它也照样能续。
 *
 * 11-15 起按停下的原因分三句(借鉴 DeepSeek chat-demo 方案 ①):出错(原句,一字不改)、写到输出上限、用户按了停止。
 * 开头都是同一个 <turn_resume>,isContinuationRow 照旧认得。
 */
export const TURN_RESUME_OPEN = '<turn_resume>'

// ── 不是用户按停的中断(2026-11-20 中断任务续跑方案 B,docs/ToBeImproved/中断任务续跑方案_2026-11-20)──
/**
 * 中断原因。桌面停引擎前把 app_quit / app_update / engine_restart / account_change 写进 shutdown-intent.json
 * (contracts/shutdownIntent.ts),引擎收到 SIGTERM 时读它;没有意图文件的 SIGTERM 记 engine_stop;
 * 持有进程已死、行还在跑、没有停止请求也没有意图文件 = crash。worker_restart 留给云端(方案第 4 步)。
 * 只有 AUTO_RESUMABLE 里的能自动续跑;其余只给「继续生成」按钮。用户按停 / 急停 / 团队级联 / 通道下线不在这张表里(仍是 aborted)。
 */
export type InterruptReason = 'app_quit' | 'app_update' | 'engine_restart' | 'account_change' | 'engine_stop' | 'crash' | 'worker_restart'
export const INTERRUPT_REASONS: readonly InterruptReason[] = ['app_quit', 'app_update', 'engine_restart', 'account_change', 'engine_stop', 'crash', 'worker_restart']
export const AUTO_RESUMABLE: ReadonlySet<InterruptReason> = new Set<InterruptReason>(['app_quit', 'app_update', 'engine_restart', 'crash', 'worker_restart'])
export function isInterruptReason(x: unknown): x is InterruptReason {
  return typeof x === 'string' && (INTERRUPT_REASONS as readonly string[]).includes(x)
}

const INTERRUPT_WHY: Record<InterruptReason, string> = {
  app_quit: 'The app was quit while you were working',
  app_update: 'The app was restarted to install an update while you were working',
  engine_restart: 'The agent engine was restarted after a settings change while you were working',
  account_change: 'The signed-in account changed while you were working',
  engine_stop: 'The agent engine was stopped while you were working',
  crash: 'The agent engine stopped unexpectedly while you were working',
  worker_restart: 'The server running this task restarted while you were working',
}

export type TurnResumeReason = 'error' | 'length' | 'stopped' | InterruptReason

const RESUME_WHY: Record<TurnResumeReason, string> = {
  error: 'Your previous response stopped because of an error (not because the user interrupted it). Everything produced before the error — text, tool calls and their results — was kept and is shown above. ',
  length: 'Your previous response was cut off because it reached the output length limit. Everything produced before the cut — text, tool calls and their results — was kept and is shown above. ',
  stopped: 'The user stopped your previous response and now asks you to continue it. Everything produced before the stop — text, tool calls and their results — was kept and is shown above. ',
  ...(Object.fromEntries(INTERRUPT_REASONS.map((r) => [r,
    `${INTERRUPT_WHY[r]}, so your previous response stopped there; the user did not stop it, and now asks you to continue. Everything recorded before the stop — text, tool calls and their results — is shown above. `,
  ])) as Record<InterruptReason, string>),
}

/** 「继续生成」那一行的正文。error 一句与 11-10 的 TURN_RESUME_MARKER 逐字相同(老会话、台架都按它比对)。 */
export function turnResumeMarker(reason: TurnResumeReason = 'error'): string {
  return `${TURN_RESUME_OPEN}\n` +
    RESUME_WHY[reason] +
    'Continue exactly where it stopped: do not repeat what you already wrote and do not restart the task. ' +
    // 「只写续写本身」:11-15 live 里 stopped 那句 4 次有 2 次把自查漏进正文(「6. 麻雀? Hmm already.」)
    (reason === 'error' ? '' : 'If it stopped mid-sentence, begin with the rest of that sentence. Write only the continuation itself, with no notes, checks or comments about it. ') +
    'If a tool call was cut off or has no result, check the current state before running it again.\n' +
    '</turn_resume>'
}

export const TURN_RESUME_MARKER = turnResumeMarker('error')

/**
 * 引擎内的自动续写(agentLoop):纯文字回答写到输出上限、停在半句时,引擎自己接着写一次。
 * 只进本 run 的上下文,不落库不上屏(同 <stream_resume>);接上的正文直接粘在断处,所以要它从半句接、不加开场白。
 */
export const LENGTH_RESUME_CHECK =
  '<length_resume>\nYour previous message reached the output length limit and was cut off. Everything you wrote was kept and shown to the user. ' +
  'Continue exactly where you stopped: if you stopped mid-sentence or mid-word, begin with the rest of it; do not repeat anything you already wrote, ' +
  'do not add a preamble or a heading, keep the remainder concise, and write only the continuation itself, with no notes, checks or comments about it.\n</length_resume>'

const AUTO_TAG = /^\[auto-resume: ([a-z_]+)\]$/m
const REASON_TAG = /^\[reason: ([a-z_]+)\]$/m
const OUTCOME_HINT = 'Tool calls whose result says the outcome is unknown may or may not have taken effect: check the current state before relying on them or running them again.'

/**
 * 引擎自动续跑时插的那一行(user 行、不是用户说的话)。开头仍是 <turn_resume>,老界面照旧画成一条细线、isContinuationRow 照旧认得;
 * 第二行 `[auto-resume: <原因>]` 给新界面挑文案。「已经做完就什么都别做」是 Claude / Codex 续跑提示的共同做法:替代「从原始输入重放」。
 */
export function autoResumeMarker(reason: InterruptReason): string {
  return `${TURN_RESUME_OPEN}\n[auto-resume: ${reason}]\n` +
    `${INTERRUPT_WHY[reason]}, so your previous turn stopped there. The user did not stop it; this message was sent automatically. ` +
    'Everything recorded before the stop — text, tool calls and their results — is shown above. ' +
    'If the task was already finished, reply briefly and do nothing else. Otherwise continue from where it stopped without repeating completed work. ' +
    `${OUTCOME_HINT}\n</turn_resume>`
}

/**
 * 中断了、但没自动续(没过门控 / 原因不可续)时插的那一行。开头仍是 <turn_interrupted>,老界面画成「已在此处打断」;
 * 第二行 `[reason: <原因>]` 让新界面换成说原因的那条线 + 「继续生成」。措辞写明不是用户按的停(D1)。
 */
export function interruptedNoticeMarker(reason: InterruptReason): string {
  return `<turn_interrupted>\n[reason: ${reason}]\n` +
    `${INTERRUPT_WHY[reason]}, so this turn stopped before it finished. The user did not press stop. ` +
    `The task above is likely unfinished. ${OUTCOME_HINT}\n</turn_interrupted>`
}

/** 自动续跑行 → 原因;不是自动续跑行(含用户点的「继续生成」)→ null。 */
export function parseAutoResume(content: string): InterruptReason | null {
  if (!content.startsWith(TURN_RESUME_OPEN)) return null
  const m = AUTO_TAG.exec(content)
  return m && isInterruptReason(m[1]) ? m[1] : null
}

/** 带原因的中断行 → 原因;用户按停留下的老式 <turn_interrupted> → null。 */
export function parseInterruptedNotice(content: string): InterruptReason | null {
  if (!content.startsWith('<turn_interrupted>')) return null
  const m = REASON_TAG.exec(content)
  return m && isInterruptReason(m[1]) ? m[1] : null
}

/** 不是用户输入、而是「接着上一轮」的机器行:找「最后一条用户消息」重发时要越过它们,否则会把标记本身当问题重发。 */
export function isContinuationRow(content: string): boolean {
  return content.startsWith(TURN_RESUME_OPEN) || content.startsWith('<turn_interrupted>')
}
