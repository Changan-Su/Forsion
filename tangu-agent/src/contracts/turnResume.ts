/**
 * 「继续生成」行(2026-11-10):回答因报错 / 额度用完停在半截时,用户点「继续生成」发出的 user 行。
 * 和「重新生成」(删掉这一轮、从上一条用户消息重发)是两条路:这里什么都不删,失败那一轮已落库的正文、
 * 工具调用与结果原样留在上下文里,模型接着往下写。
 *
 * 正文给模型看(英文,措辞照 agentLoop 的 <stream_resume>);对人渲染成一条轻分隔线,↑ 历史召回、画布树、
 * 重试 / 重新生成找「最后一条用户消息」时都当机器行跳过。走普通发送,老引擎 / 远端引擎不认识它也照样能续。
 */
export const TURN_RESUME_OPEN = '<turn_resume>'

export const TURN_RESUME_MARKER =
  `${TURN_RESUME_OPEN}\n` +
  'Your previous response stopped because of an error (not because the user interrupted it). Everything produced before the error — text, tool calls and their results — was kept and is shown above. ' +
  'Continue exactly where it stopped: do not repeat what you already wrote and do not restart the task. ' +
  'If a tool call was cut off or has no result, check the current state before running it again.\n' +
  '</turn_resume>'

/** 不是用户输入、而是「接着上一轮」的机器行:找「最后一条用户消息」重发时要越过它们,否则会把标记本身当问题重发。 */
export function isContinuationRow(content: string): boolean {
  return content.startsWith(TURN_RESUME_OPEN) || content.startsWith('<turn_interrupted>')
}
