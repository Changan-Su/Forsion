/**
 * 收件箱里的审批提醒信(设备能力 MCP 方案 P1 · K3):执行设备(桌面)上的远程会话等了 60s 还没人批 / 答,桌面主进程经 unit-hub
 * 投的一封定向信(服务端 notifyInbox thread {kind:'approval', unitId, sessionId, event:'pending'})。手机收件箱据此在正文下挂「打开会话」。
 *
 * 信任口径与反馈线程同(feedbackThreadLib.inboxThreadOf):只认服务端广播落下来的(sender_kind==='server')、形状完整的 thread;
 * 两个 id 都得是 uuid。id 只是路由提示,打开时照常过属主校验(hub 逐请求校验 owner),伪造最坏得 404。
 */
import type { InboxMessage } from '../../services/backendService'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function approvalThreadOf(msg: Pick<InboxMessage, 'sender_kind' | 'thread'>): { unitId: string; sessionId: string } | null {
  if (msg.sender_kind !== 'server' || !msg.thread) return null
  let t: unknown = msg.thread
  if (typeof t === 'string') { try { t = JSON.parse(t) } catch { return null } }
  const o = t as { kind?: unknown; unitId?: unknown; sessionId?: unknown; event?: unknown } | null
  if (!o || typeof o !== 'object' || o.kind !== 'approval' || o.event !== 'pending') return null
  if (typeof o.unitId !== 'string' || !UUID_RE.test(o.unitId) || typeof o.sessionId !== 'string' || !UUID_RE.test(o.sessionId)) return null
  return { unitId: o.unitId.toLowerCase(), sessionId: o.sessionId.toLowerCase() }
}
