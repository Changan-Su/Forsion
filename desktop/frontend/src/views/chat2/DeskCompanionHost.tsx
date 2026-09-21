/** Agent Desk 伴随面的挂载点(ctx.desk.registerCompanion 的宿主那半)。
 *  挂载纪律:同一个 (伴随面 key, surface) **只 mount 一次** —— 首条消息发出(草稿 null → 真会话 id)、
 *  切会话、always ↔ idle 切模式都不重挂(重挂 = 插件重新解析模型 / 重建 WebGL 上下文),
 *  会话变化只经 host.onStatus 推一份新状态。第三方回调一律 try/catch:插件炸了只打日志,卡片照常活着。 */
import { useEffect, useRef } from 'react'
import type { DeskCompanionEntry, DeskCompanionHost as HostApi, DeskCompanionSurface } from '@amadeus/plugins/deskCompanion'
import { idleAgentStatus, readTangu, type TanguAgentStatus } from '@amadeus/plugins/tanguSeam'

const statusOf = (sid: string | null): TanguAgentStatus => readTangu()?.agentStatus?.(sid) ?? idleAgentStatus(sid)

export function DeskCompanionHost({ entry, surface, sessionId }: { entry: DeskCompanionEntry; surface: DeskCompanionSurface; sessionId: string | null }) {
  const elRef = useRef<HTMLDivElement>(null)
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId
  const listeners = useRef(new Set<(s: TanguAgentStatus) => void>())

  const emit = (s: TanguAgentStatus): void => {
    for (const cb of [...listeners.current]) {
      try { cb(s) } catch (e) { console.error('[desk-companion] onStatus callback failed', entry.key, e) }
    }
  }

  // 挂载:只认 (key, mount, surface)。mode 变了 entry 换对象但 mount 引用不变 → 不重挂;
  // 插件以同 key 重新注册(换了 mount)才重挂。
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const subs = listeners.current
    const host: HostApi = {
      surface,
      sessionId: () => sidRef.current,
      status: () => statusOf(sidRef.current),
      onStatus: (cb) => {
        subs.add(cb)
        return () => { subs.delete(cb) }
      },
    }
    let dispose: void | (() => void)
    try {
      dispose = entry.mount(el, host)
    } catch (e) {
      console.error('[desk-companion] mount failed', entry.key, e)
    }
    return () => {
      try { if (typeof dispose === 'function') dispose() } catch (e) { console.error('[desk-companion] dispose failed', entry.key, e) }
      subs.clear()
      el.replaceChildren()
    }
  }, [entry.key, entry.mount, surface]) // eslint-disable-line react-hooks/exhaustive-deps

  // 状态订阅:按会话重订;会话变了(不是首次)立刻推一份新会话的快照 —— 插件不必自己盯 sessionId。
  // 比较上一次订阅的会话而不是「是否首跑」:StrictMode 的双跑不该多推一份。
  const subbedSid = useRef(sessionId)
  useEffect(() => {
    const off = readTangu()?.subscribeAgentStatus?.(emit, sessionId)
    if (subbedSid.current !== sessionId) {
      subbedSid.current = sessionId
      emit(statusOf(sessionId))
    }
    return () => { try { off?.() } catch (e) { console.error('[desk-companion] unsubscribe failed', e) } }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={elRef}
      className="agent-desk-companion-slot"
      data-companion={entry.key}
      data-surface={surface}
      // 布局写在行内:伴随面也要能挂进没有 chat2.css 的台架(?plugview),撑满规则不能只活在样式表里。
      style={{ position: 'relative', flex: '1 1 0', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
    />
  )
}
