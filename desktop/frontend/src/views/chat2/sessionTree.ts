/**
 * 会话列表的父子树(方案「子会话与任务卡」2026-10-17,左栏 A):主会话用 start_session 开出的子会话挂在它下面一层。
 * 只认**同一组里**列出来的主会话 —— 主会话在别的组 / 没列出来(归档、分页外)时子会话照普通行平铺,不级联。只一层:引擎不让子会话再开子会话,
 * 万一数据里有孙会话,它按普通行平铺(树线只画一层)。
 */
import type { RowStatus } from '../../../../../tangu-agent/src/contracts/sessionStatus'
export { mergeStatus, rowStatus, type RowStatus } from '../../../../../tangu-agent/src/contracts/sessionStatus'

export interface TreeNode<T> { s: T; kids: T[] }

/** 时间串 → ms(SQLite 的 `YYYY-MM-DD HH:MM:SS` 也认);解析不了 = 0。 */
function timeAt(raw: string | null | undefined): number {
  const v = String(raw || '').trim()
  if (!v) return 0
  const n = Date.parse(v.includes('T') ? v : v.replace(' ', 'T'))
  return Number.isFinite(n) ? n : 0
}

/** 子会话的次序 = 与主会话列表同口径:最近活动(updated_at)在上;同时刻按开出的先后,新的在上。
 *  (2026-11-07 用户:「工作区子会话列表也按照最新排序」;此前是按开出的先后升序。) */
function newestFirst<T extends { updated_at?: string | null; created_at?: string | null }>(a: T, b: T): number {
  return timeAt(b.updated_at) - timeAt(a.updated_at) || timeAt(b.created_at) - timeAt(a.created_at)
}

export function nestSessions<T extends { id: string; parent_session_id?: string | null; created_at?: string | null; updated_at?: string | null }>(items: T[]): Array<TreeNode<T>> {
  const byId = new Map(items.map((x) => [x.id, x] as const))
  const isTop = (x: T): boolean => !x.parent_session_id || !byId.has(x.parent_session_id) || x.parent_session_id === x.id
  const kids = new Map<string, T[]>()
  for (const x of items) {
    if (isTop(x)) continue
    const parent = byId.get(x.parent_session_id!)!
    if (!isTop(parent)) continue // 孙会话:平铺
    const list = kids.get(parent.id) || []
    list.push(x)
    kids.set(parent.id, list)
  }
  const nested = new Set([...kids.values()].flat().map((x) => x.id))
  return items.filter((x) => !nested.has(x.id)).map((s) => ({
    s, kids: (kids.get(s.id) || []).slice().sort(newestFirst),
  }))
}

