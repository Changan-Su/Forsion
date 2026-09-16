// .db 文件改名的渲染端编排器:树重命名与 DatabaseEmbed title 提交共用。
// 顺序有讲究:flush 在 IPC 前(防 pending 防抖把数据写回旧路径复活文件),
// dropByPath 在 IPC 后(防 stale entry 重挂 timer 再写旧路径)。
import { amadeus } from '../api'
import { remapScopePaths, usePageStore } from '../store/pageStore'
import { useDbStore } from '../store/dbStore'
import { useCalendarConfig } from '../store/calendarConfigStore'

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
  // 已开的独立 db 标签跟着换路径:走与树上移动/删除同一条路径广播(AmadeusDbView 的 useFollowPathGone)。
  // 原先逐个 navigateLeaf —— 清空全部参数(正在看的视图 view 丢了)还把标签抢到前台,移动端无 api 直接不跟。
  remapScopePaths(oldPath, newPath, 'file')
  return newPath
}
