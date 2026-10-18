/**
 * 会话列表的父子树(方案「子会话与任务卡」2026-10-17,左栏 A):主会话用 start_session 开出的子会话挂在它下面一层。
 * 只认**同一组里**列出来的主会话 —— 主会话在别的组 / 没列出来(归档、分页外)时子会话照普通行平铺,不级联。只一层:引擎不让子会话再开子会话,
 * 万一数据里有孙会话,它按普通行平铺(树线只画一层)。
 */
export type RowStatus = 'wait' | 'run' | 'done' | ''

export interface TreeNode<T> { s: T; kids: T[] }

export function nestSessions<T extends { id: string; parent_session_id?: string | null; created_at?: string }>(items: T[]): Array<TreeNode<T>> {
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
    s, kids: (kids.get(s.id) || []).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))),
  }))
}

/** 行尾状态:审批 / 询问在等 > 在跑(本端订阅的 run 或引擎报 busy)> 模型说在等回答 > 做完了没看。
 *  awaiting_user 是列表快照,新一轮起跑时引擎已清掉、本端要等下次刷新 —— 所以排在「在跑」后面。 */
export function rowStatus(s: { busy?: boolean; awaiting_user?: boolean }, attention: boolean, running: boolean, unread: boolean): RowStatus {
  return attention ? 'wait' : running || s.busy ? 'run' : s.awaiting_user ? 'wait' : unread ? 'done' : ''
}

/** 收起的主会话行尾冒上来的状态:等你 > 在跑 > 做完了没看。 */
export function mergeStatus(list: RowStatus[]): RowStatus {
  return list.includes('wait') ? 'wait' : list.includes('run') ? 'run' : list.includes('done') ? 'done' : ''
}
