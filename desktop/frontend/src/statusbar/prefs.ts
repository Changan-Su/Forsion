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

function read(): SbPrefs {
  try {
    const v = localStorage.getItem(KEY)
    if (v) return { enabled: true, hidden: [], order: [], ...(JSON.parse(v) as Partial<SbPrefs>) }
  } catch { /* ignore */ }
  return { enabled: true, hidden: [], order: [] }
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
