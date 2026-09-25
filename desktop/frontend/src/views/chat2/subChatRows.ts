/**
 * 对话右栏「子会话」行的合并口径(SubChatStatus 用;纯函数,单测钉住)。
 *
 * - teamwork 走团队车道,这里永不列。
 * - historian 子会话(引擎每个父会话一条,uuidv5)在 Historian 开着时由 HistorianStatus 那一行代表,
 *   再列一行就是「同名两行 Historian」(UIUX 评审 U-04);关着时它不挂载,旧记录照旧在这里列出。
 * - ⚠️ live(subChatsBySession)去重必须对**全部** saved 行做,包括被隐藏的 historian:RightViews 的
 *   subchats 视图会把 /background 的行(含 historian 那条的 runId)并进 live,只拿「可见行」去重,
 *   被藏掉的 Historian 会从 live 那头原样漏回来。
 */
import type { BackgroundSessionInfo } from '../../services/backendService'
import type { SubChat } from '../../types'

export interface SubChatRow { id: string; title: string; sessionId: string; runId?: string; streaming: boolean }

export function subChatRows(saved: readonly BackgroundSessionInfo[], live: readonly SubChat[] | undefined, historianOn: boolean): SubChatRow[] {
  const hidden = saved.filter((r) => historianOn && r.kind === 'historian')
  const rows: SubChatRow[] = saved
    .filter((r) => r.kind !== 'teamwork' && !hidden.includes(r))
    .map((r) => ({ id: r.sessionId, title: r.title || r.kind, sessionId: r.sessionId, runId: r.runId || undefined, streaming: r.runStatus === 'running' || r.runStatus === 'queued' }))
  for (const l of live || []) {
    if (hidden.some((h) => h.sessionId === l.sessionId || (!!h.runId && h.runId === l.runId))) continue
    // 去重口径沿用原 SubChatStatus(含其对无 sessionId 行的既有行为),本条只加上面那道 hidden 闸。
    if (!rows.some((r) => r.sessionId === l.sessionId || (r.runId && r.runId === l.runId))) rows.push({ id: l.id, title: l.title, sessionId: l.sessionId!, runId: l.runId, streaming: l.streaming })
  }
  return rows
}
