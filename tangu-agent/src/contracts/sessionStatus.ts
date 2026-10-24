/**
 * 会话行的状态与运行耗时的显示(纯函数)。界面热更新 3d 从 Tangu 界面挪来:宿主的提醒汇总(attentionStore)与手机灵动岛也要用,
 * 宿主不再直引 Tangu 模块。Tangu 侧 sessionTree / RunStatsLine 原样转出。
 */
export type RowStatus = 'wait' | 'run' | 'done' | ''

/** 行尾状态:审批 / 询问在等 > 在跑(本端订阅的 run 或引擎报 busy)> 模型说在等回答 > 做完了没看。
 *  awaiting_user 是列表快照,新一轮起跑时引擎已清掉、本端要等下次刷新 —— 所以排在「在跑」后面。 */
export function rowStatus(s: { busy?: boolean; awaiting_user?: boolean }, attention: boolean, running: boolean, unread: boolean): RowStatus {
  return attention ? 'wait' : running || s.busy ? 'run' : s.awaiting_user ? 'wait' : unread ? 'done' : ''
}

/** 收起的主会话行尾冒上来的状态:等你 > 在跑 > 做完了没看。 */
export function mergeStatus(list: RowStatus[]): RowStatus {
  return list.includes('wait') ? 'wait' : list.includes('run') ? 'run' : list.includes('done') ? 'done' : ''
}

/** 33s / 17m 33s / 1h 02m */
export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}
