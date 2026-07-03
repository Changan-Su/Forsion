/** 统一「工作区」视图的模式模型(纯函数,无 React/amadeus 依赖 → node 环境可测)。 */
export type WorkspaceMode = 'sessions' | 'files' | 'notes'

/** 自动模式 = f(所在侧, 活动主视图类型, 上一模式):
 *  chat → 左=会话、右=文件;编辑器 → 左=笔记、右=文件;其他主视图维持上一模式(不来回跳)。 */
export function autoWorkspaceMode(loc: 'left' | 'right' | 'main', mainType: string | null, prev: WorkspaceMode): WorkspaceMode {
  if (mainType === 'chat') return loc === 'right' ? 'files' : 'sessions'
  if (mainType === 'amadeus-editor') return loc === 'right' ? 'files' : 'notes'
  return prev
}
