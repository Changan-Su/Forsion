/** 通知「查看」要打开左栏那行的同步面板:挂着的面板在这里登记(VaultSyncChip),没有就由调用方回落同步设置。
 *  单独一个文件:通知接线(stores/)只要这一点,不拉组件和样式。 */
const panelOpeners = new Set<() => void>()

export function registerVaultSyncPanel(open: () => void): () => void {
  panelOpeners.add(open)
  return () => { panelOpeners.delete(open) }
}

/** 打开左栏那行的同步面板;那行此刻不在(别的 Space、窗口收起)返回 false。 */
export function requestVaultSyncPanel(): boolean {
  const open = [...panelOpeners].pop()
  if (!open) return false
  open()
  return true
}
