/**
 * 托盘 / 菜单栏「在跑 / 等你」的渲染层一半(方案「借鉴 Comma」第三轮 2.6):会话名册在渲染层,主进程没有。
 * 会话列表 / 运行中 / 未读 / 待批索引一变,就(去抖后)把在跑 / 等你的会话精简成 {id,title,state}[] 经 tray:sessions 报给主进程;
 * 内容没变不发。主进程只认主窗报上来的那份,菜单与菜单栏的数在 electron/tray.ts。web / 移动端没有这个接缝 → no-op。
 * 状态与侧栏行尾、子会话块同一个 rowStatus(等你 = 审批 / 询问在等,或模型说它在等回答;在跑 = 订阅着的 run 或引擎报 busy)。
 */
import type { SessionRecord } from '../../../tangu-agent/src/contracts/clientTypes'
import { rowStatus } from '../../../tangu-agent/src/contracts/sessionStatus'
import { useApp } from './stores/appStore'
import { attentionIndex, mergeAttention, useAttention } from './stores/attentionStore'
import { displaySessionTitle } from './sessionTitle'

export interface TrayReportRow { id: string; title: string; state: 'run' | 'wait' }

/** 纯函数:在跑 / 等你的会话,等你在前,各自按最近更新排;最多 max 条(主进程只列 5 条,多送的用来算总数)。 */
export function traySessionRows(
  sessions: readonly SessionRecord[],
  attention: Map<string, unknown>,
  running: Record<string, string>,
  unread: ReadonlySet<string>,
  t: (key: string) => string,
  max = 100,
): TrayReportRow[] {
  const rows: Array<TrayReportRow & { at: string }> = []
  for (const s of sessions) {
    const st = rowStatus(s, attention.has(s.id), !!running[s.id], unread.has(s.id))
    if (st !== 'run' && st !== 'wait') continue
    rows.push({ id: s.id, title: displaySessionTitle(s.title, t), state: st, at: String(s.updated_at || '') })
  }
  rows.sort((a, b) => (a.state === b.state ? b.at.localeCompare(a.at) : a.state === 'wait' ? -1 : 1))
  return rows.slice(0, max).map(({ id, title, state }) => ({ id, title, state }))
}

const DEBOUNCE_MS = 400

/** 装上即报一次;返回卸载(语言变了重装,标题跟着换)。 */
export function installTraySessionsReport(t: (key: string) => string): () => void {
  const send = window.tangu?.setTraySessions
  if (!send) return () => {}
  let last = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    const app = useApp.getState()
    const attention = mergeAttention(attentionIndex(useAttention.getState().byTarget), app.messagesBySession, app.runningBySession)
    const rows = traySessionRows(app.sessions, attention, app.runningBySession, app.unread, t)
    const sig = JSON.stringify(rows)
    if (sig === last) return
    last = sig
    try { send(rows) } catch { /* 主进程不在 */ }
  }
  const schedule = (): void => { if (!timer) timer = setTimeout(flush, DEBOUNCE_MS) }
  // messagesBySession 每个 token 都换引用:这里只排一个定时器,真正的计算 400ms 一次
  const offApp = useApp.subscribe((s, prev) => {
    if (s.sessions !== prev.sessions || s.runningBySession !== prev.runningBySession || s.unread !== prev.unread || s.messagesBySession !== prev.messagesBySession) schedule()
  })
  const offAttention = useAttention.subscribe((s, prev) => { if (s.byTarget !== prev.byTarget) schedule() })
  flush()
  return () => {
    offApp()
    offAttention()
    if (timer) clearTimeout(timer)
  }
}
