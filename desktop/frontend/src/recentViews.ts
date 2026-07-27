/** 「最近使用」精准视图登记:会话 / 笔记 / 各类文件 / 功能视图的快捷跳转,喂给新建标签页启动器。
 *  记带身份的主区项(chat/note/文件路径/视图类型),localStorage 持久化,LRU 去重。 */
import { create } from 'zustand'

export interface RecentView {
  /** 去重键:'chat:<sessionId>' | 'note:<notePath>' | 'file:<viewType>:<path>' | 'view:<viewType>' */
  key: string
  /** chat/note = 会话/笔记(专属重开逻辑);file = 带路径的文件视图(db/pdf/白板/图片/插件文件);view = 功能视图(日历/待办/收件箱/插件视图) */
  kind: 'chat' | 'note' | 'file' | 'view'
  /** sessionId / 笔记路径 / 文件路径 / 视图类型(kind=view) */
  id: string
  /** kind=file|view 时的 LCL 视图类型(重开时按它分派门面 / openView) */
  viewType?: string
  /** 记录时的标题快照;渲染端可用实时标题覆盖 */
  title: string
  ts: number
}

const LS_KEY = 'forsion_tangu_recent_views'
const CAP = 24

function load(): RecentView[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]') as RecentView[]
    return Array.isArray(v) ? v.filter((i) => i && i.key && i.id) : []
  } catch {
    return []
  }
}

export const useRecentViews = create<{
  items: RecentView[]
  record(v: Omit<RecentView, 'ts'>): void
  remove(key: string): void
}>((set) => ({
  items: load(),
  record: (v) =>
    set((s) => {
      const items = [{ ...v, ts: Date.now() }, ...s.items.filter((i) => i.key !== v.key)].slice(0, CAP)
      try { localStorage.setItem(LS_KEY, JSON.stringify(items)) } catch { /* private mode */ }
      return { items }
    }),
  remove: (key) =>
    set((s) => {
      const items = s.items.filter((i) => i.key !== key)
      try { localStorage.setItem(LS_KEY, JSON.stringify(items)) } catch { /* private mode */ }
      return { items }
    }),
}))
