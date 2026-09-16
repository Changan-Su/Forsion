import { useEffect } from 'react'
import { useWorkspace } from '@lcl/engine'
import { onNotePathGone } from '@amadeus/store/pageStore'

/** 文件类标签(插件文件 / 白板 / 多维表 / PDF / 图片 / 媒体)攥着的库路径被树上改名、挪走 → 跟到新路径;
 *  被删 → 关掉标签。同 DashboardView 那条:remapScopePaths 只改 scope 的 activePage,不改 leaf 参数,
 *  而这几个视图只认参数(2026-09-16)。
 *  · 只动**工作区里的标签**(leafById 查得到的):同一批视图也活在仪表盘卡(ViewCard)与 Agent Desk 里,
 *    卡片的 close() = removeCard —— 删一个 PDF 不该顺手把引用它的卡从仪表盘里删掉并落盘。
 *  · 参数在广播那一刻现取:effect 闭包里的 leaf 是挂载时的快照,拿它回写会把此后改过的 view/page/at 退回去。
 *  · 删除只关不重装:web(cloudBridge.loadOrCreate)与移动端 loadPage 缺文件即新建。关标签走 store 的
 *    closeLeaf,不走 leaf.close():dockview 的 leaf.close() 是裸 panel.api.close(),绕过「最后一个主标签就地
 *    变 home 占位 / 侧栏补空占位 / 清导航史」那套收尾(标签栏的关闭按钮走的也是 closeLeaf)。 */
export function useFollowPathGone(leafId: string, key: string, path: string): void {
  useEffect(() => {
    if (!path) return
    return onNotePathGone((from, kind, to) => {
      if (!(kind === 'file' ? path === from : path === from || path.startsWith(`${from}/`))) return
      const ws = useWorkspace.getState()
      const leaf = ws.leafById(leafId)
      if (!leaf) return
      if (to) leaf.setParams({ ...leaf.params, [key]: kind === 'file' ? to : to + path.slice(from.length) })
      else ws.closeLeaf(leafId)
    })
  }, [leafId, key, path])
}
