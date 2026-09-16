import { useEffect } from 'react'
import { useWorkspace } from '@lcl/engine'
import { onNotePathGone, usePageStore } from '@amadeus/store/pageStore'

/** 各文件类视图认领文件的参数名(见 features/amadeus.tsx 的 registerView idParam)。 */
const PATH_PARAM: Record<string, string> = {
  'amadeus-editor': 'notePath',
  'amadeus-plugin-file': 'filePath',
  'amadeus-drawing': 'drawingPath',
  'amadeus-db': 'dbPath',
  'amadeus-pdf': 'pdfPath',
  'amadeus-image': 'imagePath',
  'amadeus-media': 'path',
  dashboard: 'dashPath',
}

let installed = false

/** 文件类标签攥着的库路径被树上改名、挪走 → 跟到新路径;被删 → 关掉标签(2026-09-16)。
 *  remapScopePaths 只改 scope 的 activePage,不改 leaf 参数,而这些视图只认参数。
 *  · 在 **store 层**跟,不在视图里订阅:视图没挂载就收不到 —— 折叠侧栏的面板被序列化进 stash、
 *    移动端单列壳只渲染当前那一个 leaf、崩进错误边界的视图已卸载(Codex 评审)。展开 / 切回来时
 *    它们会拿着旧路径重装,而 web(cloudBridge.loadOrCreate)与移动端 loadPage 缺文件即新建。
 *  · 只动**工作区里的 leaf**:同一批视图也活在仪表盘卡(ViewCard,close() = removeCard 并落盘)与
 *    Agent Desk 里,那些宿主不在 store 里,天然碰不到。
 *  · 删除只关不重装,关走 store 的 closeLeaf(最后一个主标签就地变 home 等收尾)。编辑器例外:
 *    与挂载中的编辑器同一回落,改指到库里还活着的一篇,一篇都没有就回欢迎页。
 *  · 别的窗口(分离窗 / Mini 卡)发起的改名删除经主进程转进本窗的同一条广播(pageStore 的 onPathGone)。 */
export function installLeafPathFollow(): void {
  if (installed) return
  installed = true
  onNotePathGone((from, kind, to) => {
    const dead = (p: string): boolean => (kind === 'file' ? p === from : p === from || p.startsWith(`${from}/`))
    useWorkspace.getState().remapLeaves((type, params) => {
      const key = PATH_PARAM[type]
      const path = key ? params[key] : undefined
      if (typeof path !== 'string' || !dead(path)) return undefined
      if (to) return { [key]: kind === 'file' ? to : to + path.slice(from.length) }
      if (type === 'amadeus-editor') return { notePath: usePageStore.getState().pages.find((p) => !dead(p)) }
      return null
    })
  })
}

/** 视图级的同一条跟随。工作区 leaf 已由 installLeafPathFollow 在 store 层统一处理,两者幂等;
 *  新代码不要再用它。 */
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
