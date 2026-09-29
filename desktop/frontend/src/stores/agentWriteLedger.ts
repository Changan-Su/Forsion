/**
 * Agent 写文件的**归属账本**(评审 G3-03):appStore 在写类工具的 tool_call / tool_result 上记账,
 * UnifiedPage 回灌外部改动时查「这次是不是 Tangu 写的」,是就把改动画出来(agentChanges.ts)。
 *
 * 叶子模块,零 import:amadeus 那侧不许 import appStore(`pluginStore → appStore → SettingsModal → pluginStore`
 * 是真环,见 tanguSeam.ts 顶注),两边只经这张表见面。
 *
 * 口径:文件监听(→ onExternalChange → 等打字静默 → 读盘)与 SSE 的 tool_call / tool_result 谁先到不确定,
 * 所以两头都记 —— tool_call(参数完整、写盘还没发生)记「在途」,tool_result 成功则关闭并留一段宽限、失败立即撤销;
 * 挂起的审批(审批托盘)可能让一次调用在途很久,在途有上限,run 被中止收不到结果时不会永远挂着。
 * 收紧(Codex 复核 P0):每次写入只归属一次;带完整内容 / new_string 的写入要核得上盘上正文(claimAgentWrite)。
 * 查不到 / 核不上就是「不是 Tangu 写的」—— 回落到从前的静默回灌,不误标。
 */

/** 工具结束后仍算「刚写过」的窗口:覆盖 watcher 去抖 + 打字静默闸的常见延迟。 */
export const AGENT_WRITE_GRACE_MS = 15_000
/** 在途上限:收不到 tool_result(run 中止 / 断线)的调用,过了这么久就不再算数。 */
export const AGENT_WRITE_OPEN_MAX_MS = 30 * 60_000

/** 一次写入的目标 + 盘上内容的可核对特征(Codex 复核 P0 ③)。 */
export interface AgentWriteTarget {
  /** 已解析的绝对路径。 */
  path: string
  /** write_file 的完整内容:回灌读到的盘上正文必须与之一致(统一换行、去尾空白后比)。 */
  full?: string
  /** edit_file / multi_edit 的 new_string:盘上正文必须都包含(空串不算)。 */
  includes?: string[]
}
interface Target extends AgentWriteTarget {
  /** 已被哪一版盘上正文认领(Codex 复核 P0 ②:每次写入只归属一次);null = 还没认领。 */
  claimed: string | null
}
interface Call { targets: Target[]; started: number; ended: number | null }
const calls = new Map<string, Call>()

/** 「Tangu 正在改这篇」的提示窗口(评审 G3-05):流式阶段 / 在途超过这么久还没下文(run 中止、断线、审批一直挂着)就不再提示。 */
export const AGENT_EDITING_MAX_MS = 2 * 60_000
/** 流式阶段(tool_stream:参数还在生成、目标路径已经流出来)的写入意图。**只给提示用,不参与归属认领** ——
 *  认领要核盘上正文(Codex 复核 P0 ③),完整参数要等 tool_call;混进 calls 的话 noteAgentWriteStart 见 id 已在就早退,核对内容就丢了。 */
const live = new Map<string, { path: string; at: number }>()
const listeners = new Set<() => void>()
function changed(): void {
  for (const l of [...listeners]) {
    try { l() } catch (e) { console.error('[agentWriteLedger] listener failed', e) }
  }
}
/** 过了提示窗口要让订阅者重算一次(否则一个中止的写入会让「正在修改」一直挂着)。 */
function expireLater(): void {
  if (typeof setTimeout === 'function') setTimeout(changed, AGENT_EDITING_MAX_MS + 50)
}

/** 比对口径:分隔符统一成 `/`、叠斜杠压成一个、去尾斜杠。 */
export function normAgentPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}
const normText = (s: string): string => s.replace(/\r\n?/g, '\n')

function prune(now: number): void {
  for (const [id, c] of calls) {
    if (c.ended != null ? now - c.ended > AGENT_WRITE_GRACE_MS : now - c.started > AGENT_WRITE_OPEN_MAX_MS) calls.delete(id)
  }
}

/** 写类工具开始(tool_call,参数已完整)。同一 id 重放(SSE 至少一次投递)只记一份。字符串 = 只有路径、没有可核对的内容。 */
export function noteAgentWriteStart(callId: string, targets: Array<string | AgentWriteTarget>, now = Date.now()): void {
  prune(now)
  if (!callId || !targets.length || calls.has(callId)) return
  calls.set(callId, {
    targets: targets.map((t) => (typeof t === 'string' ? { path: normAgentPath(t), claimed: null } : { ...t, path: normAgentPath(t.path), claimed: null })),
    started: now,
    ended: null,
  })
  live.delete(callId)
  changed()
  expireLater()
}

/** 写类工具的参数还在流式生成、目标路径已经完整流出来(tool_stream)。只登记「正在改哪篇」给编辑器提示用(G3-05)。 */
export function noteAgentWriteLive(callId: string, absPath: string, now = Date.now()): void {
  if (!callId || calls.has(callId) || live.has(callId)) return
  live.set(callId, { path: normAgentPath(absPath), at: now })
  changed()
  expireLater()
}

/** 这次调用已经登记过(流式或在途):调用方据此跳过每个 delta 都重扫一遍参数。 */
export function agentWriteKnown(callId: string): boolean {
  return live.has(callId) || calls.has(callId)
}

/** Tangu 此刻是不是正在改这个路径:参数流式生成中,或工具已发出、结果还没回来(含等审批);都有 AGENT_EDITING_MAX_MS 上限。 */
export function agentEditing(absPath: string, now = Date.now()): boolean {
  const p = normAgentPath(absPath)
  for (const l of live.values()) if (l.path === p && now - l.at <= AGENT_EDITING_MAX_MS) return true
  for (const c of calls.values()) {
    if (c.ended == null && now - c.started <= AGENT_EDITING_MAX_MS && c.targets.some((t) => t.path === p)) return true
  }
  return false
}

/** 账本变了(开始 / 结束 / 流式登记 / 过期)的通知 —— 编辑器的「正在修改」提示订阅它。 */
export function subscribeAgentWrites(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 写类工具结束(tool_result)。成功:从现在起再算 GRACE 这么久;**失败(isError)立即撤销**(Codex 复核 P0 ①)——
 *  没写成的调用不该在接下来的 15 秒里把别人的改动认成 Tangu 的。 */
export function noteAgentWriteEnd(callId: string, ok = true, now = Date.now()): void {
  if (live.delete(callId)) changed()
  const c = calls.get(callId)
  if (!c) return
  if (!ok) calls.delete(callId)
  else if (c.ended == null) c.ended = now
  changed()
}

/** 这份盘上正文是不是这次写入写出来的(③:带了完整内容 / new_string 的写入逐项核对;只有路径的照旧放行)。 */
function matches(t: Target, text: string): boolean {
  if (t.full != null && normText(t.full).trimEnd() !== text.trimEnd()) return false
  if (t.includes?.some((s) => !!s && !text.includes(normText(s)))) return false
  return true
}

/** 回灌认领(Codex 复核 P0):这个路径的这份盘上正文算不算「Tangu 写的」。
 *  - 只认在途或宽限期内、内容核得上的写入;
 *  - **每次写入只归属一次**:第一笔核得上的回灌认领后即消费,之后同路径**内容不同**的回灌不再归属。同一份正文
 *    再来一遍(watcher 重复通知、同一篇开在两个标签里各自回灌)仍算 —— 那是同一次写入被看见两回;
 *  - 核不上的不消费:真正的那次写入可能还在后面(审批中 / 监听晚到)。 */
export function claimAgentWrite(absPath: string, diskText: string, now = Date.now()): boolean {
  prune(now)
  const p = normAgentPath(absPath)
  const text = normText(diskText)
  let hit = false
  for (const c of calls.values()) {
    for (const t of c.targets) {
      if (t.path !== p) continue
      if (t.claimed != null) { if (t.claimed === text) hit = true; continue }
      if (!matches(t, text)) continue
      t.claimed = text
      hit = true
    }
  }
  return hit
}

/** 测试 / 台架用:清空账本。 */
export function resetAgentWriteLedger(): void {
  calls.clear()
  live.clear()
  changed()
}
