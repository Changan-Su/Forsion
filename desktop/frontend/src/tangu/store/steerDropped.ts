/** 用户说出去、最后却没进对话的那几句(插话 / 排队消息):被用户撤回,或 run 中止时退回输入框。
 *  发了一次就记一笔「已发」的地方(顺便问传话卡,views/chat2/btwRelay.ts)听这个,把那笔撤掉、卡片恢复成可发。
 *  带等待项 id(传话记录按它认是哪一次)和正文(排队项发不出去会换 id 重排,id 对不上时按正文认)。 */
export interface DroppedSteer { id: string; text: string }
type Listener = (sessionId: string, items: DroppedSteer[]) => void
const listeners = new Set<Listener>()

export function onSteerDropped(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function notifySteerDropped(sessionId: string, items: DroppedSteer[]): void {
  if (!items.length) return
  listeners.forEach((fn) => { try { fn(sessionId, items) } catch { /* 听的人出错不影响撤回本身 */ } })
}
