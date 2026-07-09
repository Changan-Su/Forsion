// .db 文件改名的渲染端编排器:树重命名与 DatabaseEmbed title 提交共用。
// 顺序有讲究:flush 在 IPC 前(防 pending 防抖把数据写回旧路径复活文件),
// dropByPath 在 IPC 后(防 stale entry 重挂 timer 再写旧路径)。
import { useWorkspace } from '@lcl/engine'
import { amadeus } from '../api'
import { usePageStore } from '../store/pageStore'
import { useDbStore } from '../store/dbStore'
import { useCalendarConfig } from '../store/calendarConfigStore'

interface PanelLike { id: string; params?: Record<string, unknown> }

/** 同目录重命名 .db(含内部 name 同步 + 全库引用重写),返回新 vault 相对路径。失败原样抛(调用方提示)。 */
export async function renameDb(oldPath: string, newBase: string): Promise<string> {
  await usePageStore.getState().flushSave()
  await useDbStore.getState().flushAll()
  const { newPath, rewrittenPages } = await amadeus.renameDbFile(oldPath, newBase)
  if (newPath === oldPath) return newPath
  useDbStore.getState().dropByPath(oldPath)
  await usePageStore.getState().refreshStructure()
  // 主进程重写的 .md 是自写(watcher 静默),activePage 必须显式 reconcile,不能依赖树视图的订阅。
  const active = usePageStore.getState().activePage
  if (active && rewrittenPages.includes(active)) await usePageStore.getState().reconcileExternal(active)
  const vault = usePageStore.getState().vaultRoot
  if (vault) useCalendarConfig.getState().migratePath(vault, oldPath, newPath)
  // 已开的独立 db 视图跟着换路径
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  for (const p of api?.panels ?? []) {
    if (p.params?.__type === 'amadeus-db' && p.params?.dbPath === oldPath) {
      ws.navigateLeaf(p.id, 'amadeus-db', { dbPath: newPath })
    }
  }
  return newPath
}
