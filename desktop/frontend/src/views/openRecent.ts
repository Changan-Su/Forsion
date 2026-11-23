/** 重开一条「最近使用」(recentViews.ts):按 kind 分派到专属门面 / openView。新建标签页的「最近使用」和手机主页的「继续」共用。 */
import { useWorkspace } from '@lcl/engine'
import { readTanguShell } from '../amadeus/plugins/tanguSeam'
import { openNote, openDb, openDrawing, openDashboard, openImage, openFile } from '../amadeusNav'
import { openSession } from '../sessionNav'
import type { RecentView } from '../recentViews'

export function openRecent(r: Pick<RecentView, 'kind' | 'id' | 'viewType' | 'title'>): void {
  const ws = useWorkspace.getState()
  if (r.kind === 'note') { void openNote(r.id); return }
  // 会话走门面(认领已开的标签 / 落进当前这张空白页 / 冻结老聊天),别在这儿另写一套 —— 另写的
  // 那套恒复用主聊天 = 在新标签里点最近会话,内容跑到老标签里去了。
  if (r.kind === 'chat') { openSession(r.id); return }
  if (r.kind === 'file') {
    switch (r.viewType) {
      case 'amadeus-db': openDb(r.id); break
      case 'amadeus-pdf': openFile(r.id); break // 经 openFile:插件接管了 PDF 就进插件视图,否则(及库外 PDF)仍是内置阅读器
      case 'amadeus-drawing': openDrawing(r.id); break
      case 'amadeus-dashboard': // legacy:旧「最近使用」条目仍记着老类型 → 同样开进新画布版
      case 'dashboard': openDashboard(r.id); break
      case 'amadeus-image': openImage(r.id); break
      case 'wsfile': ws.openView('wsfile', { path: r.id, name: r.title }, 'main', { newTab: true }); break // 同布局恢复重建 wsfile 面板的路径(bare path,不需 openWsFile 的 load 闭包)
      default: openFile(r.id)
    }
    return
  }
  // kind === 'view'
  if (r.viewType === 'agents-detail') { readTanguShell()?.openSpecial('agents'); return }
  if (r.viewType) ws.openView(r.viewType, {}, 'main')
}
