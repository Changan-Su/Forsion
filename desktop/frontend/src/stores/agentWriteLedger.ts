/**
 * Agent 写文件的**归属账本**(评审 G3-03):appStore 在写类工具的 tool_call / tool_result 上记账,
 * UnifiedPage 回灌外部改动时查「这次是不是 Tangu 写的」,是就把改动画出来(agentChanges.ts)。
 *
 * 叶子模块,零 import:amadeus 那侧不许 import appStore(`pluginStore → appStore → SettingsModal → pluginStore`
 * 是真环,见 tanguSeam.ts 顶注),两边只经这张表见面。
 *
 * 口径:文件监听(→ onExternalChange → 等打字静默 → 读盘)与 SSE 的 tool_call / tool_result 谁先到不确定,
 * 所以两头都记 —— tool_call(参数完整、写盘还没发生)记「在途」,tool_result 关闭并留一段宽限;查询时
 * 在途或宽限内都算。挂起的审批(审批托盘)可能让一次调用在途很久,在途有上限,run 被中止收不到结果时不会永远挂着。
 * 查不到就是「不是 Tangu 写的」—— 回落到从前的静默回灌,不误标。
 */

/** 工具结束后仍算「刚写过」的窗口:覆盖 watcher 去抖 + 打字静默闸的常见延迟。 */
export const AGENT_WRITE_GRACE_MS = 15_000
/** 在途上限:收不到 tool_result(run 中止 / 断线)的调用,过了这么久就不再算数。 */
export const AGENT_WRITE_OPEN_MAX_MS = 30 * 60_000

interface Call { paths: string[]; started: number; ended: number | null }
const calls = new Map<string, Call>()

/** 比对口径:分隔符统一成 `/`、叠斜杠压成一个、去尾斜杠。 */
export function normAgentPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

function prune(now: number): void {
  for (const [id, c] of calls) {
    if (c.ended != null ? now - c.ended > AGENT_WRITE_GRACE_MS : now - c.started > AGENT_WRITE_OPEN_MAX_MS) calls.delete(id)
  }
}

/** 写类工具开始(tool_call,参数已完整):paths = 已解析的绝对路径。同一 id 重放(SSE 至少一次投递)只记一份。 */
export function noteAgentWriteStart(callId: string, paths: string[], now = Date.now()): void {
  prune(now)
  if (!callId || !paths.length || calls.has(callId)) return
  calls.set(callId, { paths: paths.map(normAgentPath), started: now, ended: null })
}

/** 写类工具结束(tool_result,成功或失败都关):从现在起再算 GRACE 这么久。 */
export function noteAgentWriteEnd(callId: string, now = Date.now()): void {
  const c = calls.get(callId)
  if (c && c.ended == null) c.ended = now
}

/** 这个绝对路径此刻算不算「Tangu 刚写的 / 正在写」。 */
export function agentWroteRecently(absPath: string, now = Date.now()): boolean {
  prune(now)
  const p = normAgentPath(absPath)
  for (const c of calls.values()) if (c.paths.includes(p)) return true
  return false
}

/** 测试 / 台架用:清空账本。 */
export function resetAgentWriteLedger(): void {
  calls.clear()
}
