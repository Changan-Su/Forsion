/** Display the real parent chain within the visible group, without rewriting records. */
import type { RowStatus } from '../../../../../tangu-agent/src/contracts/sessionStatus'
export { mergeStatus, rowStatus, type RowStatus } from '../../../../../tangu-agent/src/contracts/sessionStatus'

export interface TreeNode<T> { s: T; kids: Array<TreeNode<T>> }
type SessionLink = { id: string; parent_session_id?: string | null }

/** Root-first ancestry. Missing / cyclic links terminate safely and remain unchanged on disk. */
export function sessionAncestors<T extends SessionLink>(item: T, items: readonly T[]): { ancestors: T[]; missing: boolean; cyclic: boolean } {
  const byId = new Map(items.map((s) => [s.id, s]))
  const seen = new Set([item.id])
  const ancestors: T[] = []
  let id = item.parent_session_id
  while (id) {
    if (seen.has(id)) return { ancestors: ancestors.reverse(), missing: false, cyclic: true }
    seen.add(id)
    const parent = byId.get(id)
    if (!parent) return { ancestors: ancestors.reverse(), missing: true, cyclic: false }
    ancestors.push(parent)
    id = parent.parent_session_id
  }
  return { ancestors: ancestors.reverse(), missing: false, cyclic: false }
}

export function sessionDescendants<T>(node: TreeNode<T>): T[] {
  const out: T[] = []
  const pending = [...node.kids]
  while (pending.length) {
    const n = pending.pop()!
    out.push(n.s)
    pending.push(...n.kids)
  }
  return out
}

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

export function nestSessions<T extends { id: string; parent_session_id?: string | null; created_at?: string | null; updated_at?: string | null }>(items: T[], detached?: ReadonlySet<string>): Array<TreeNode<T>> {
  const nodes = new Map(items.map((s) => [s.id, { s, kids: [] } as TreeNode<T>]))
  const parents = new Map<string, string>()
  for (const { s } of nodes.values()) if (!detached?.has(s.id) && s.parent_session_id && nodes.has(s.parent_session_id)) parents.set(s.id, s.parent_session_id)
  // Cut one display edge per cycle. This includes self-links and never mutates a session.
  const done = new Set<string>()
  for (const id of nodes.keys()) {
    const path = new Set<string>()
    let at: string | undefined = id
    while (at && !done.has(at)) {
      if (path.has(at)) { parents.delete(at); break }
      path.add(at)
      at = parents.get(at)
    }
    for (const x of path) done.add(x)
  }
  const roots: Array<TreeNode<T>> = []
  for (const [id, node] of nodes) {
    const parent = parents.get(id)
    if (parent) nodes.get(parent)!.kids.push(node)
    else roots.push(node)
  }
  for (const node of nodes.values()) node.kids.sort((a, b) => newestFirst(a.s, b.s))
  return roots
}

