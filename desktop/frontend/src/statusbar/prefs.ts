/** 状态栏用户偏好(显示开关/隐藏项/自定义顺序),localStorage 持久化。
 *  项目本体注册在 LCL statusRegistry(内置项 items.tsx;插件项经 pluginStatusBridge)。 */
import { create } from 'zustand'

const KEY = 'forsion.sb.prefs'

interface SbPrefs {
  enabled: boolean
  hidden: string[]
  order: string[]
}
interface SbPrefsState extends SbPrefs {
  setEnabled(on: boolean): void
  setHidden(id: string, hide: boolean): void
  setOrder(ids: string[]): void
}

/** 没有存档时(新用户 / 从没动过状态栏设置)的缺省隐藏项。收件箱未读与 Ribbon 收件箱角标重复,
 *  缺省收起(09-25 评审 U-23 拍板);**只改缺省** —— 已存偏好原样读回,老用户勾过的不动。 */
export const DEFAULT_HIDDEN: readonly string[] = ['inbox.unread']

function read(): SbPrefs {
  try {
    const v = localStorage.getItem(KEY)
    if (v) return { enabled: true, hidden: [], order: [], ...(JSON.parse(v) as Partial<SbPrefs>) }
  } catch { /* ignore */ }
  return { enabled: true, hidden: [...DEFAULT_HIDDEN], order: [] }
}
function persist(s: SbPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify({ enabled: s.enabled, hidden: s.hidden, order: s.order })) } catch { /* ignore */ }
}

export const useSbPrefs = create<SbPrefsState>((set, get) => ({
  ...read(),
  setEnabled: (on) => {
    set({ enabled: on })
    persist(get())
  },
  setHidden: (id, hide) => {
    set((s) => ({ hidden: hide ? [...new Set([...s.hidden, id])] : s.hidden.filter((x) => x !== id) }))
    persist(get())
  },
  setOrder: (ids) => {
    set({ order: ids })
    persist(get())
  },
}))
