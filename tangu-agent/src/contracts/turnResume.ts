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

export type TurnResumeReason = 'error' | 'length' | 'stopped'

const RESUME_WHY: Record<TurnResumeReason, string> = {
  error: 'Your previous response stopped because of an error (not because the user interrupted it). Everything produced before the error — text, tool calls and their results — was kept and is shown above. ',
  length: 'Your previous response was cut off because it reached the output length limit. Everything produced before the cut — text, tool calls and their results — was kept and is shown above. ',
  stopped: 'The user stopped your previous response and now asks you to continue it. Everything produced before the stop — text, tool calls and their results — was kept and is shown above. ',
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

/** 不是用户输入、而是「接着上一轮」的机器行:找「最后一条用户消息」重发时要越过它们,否则会把标记本身当问题重发。 */
export function isContinuationRow(content: string): boolean {
  return content.startsWith(TURN_RESUME_OPEN) || content.startsWith('<turn_interrupted>')
}
