/**
 * 右上角通知系统(升级自旧 appStore.toast):小卡片从右侧滑入、按序向下堆叠、hover 暂停、
 * error 常驻手动关;事件级开关 + 插件来源开关在设置「通知与状态栏」里管理(localStorage)。
 * 纯逻辑 store(无 DOM/i18n 依赖):文案由调用方(wiring / appStore.tr / 插件)传入;
 * 渲染在 components/NotificationHost(仅主窗 Root 挂载,与旧 toast-wrap 同决策)。
 */
import { create } from 'zustand'

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error'

export interface NotifyInput {
  text: string
  title?: string
  level?: NotifyLevel
  /** 事件类型(设置里按它开关);缺省 'system.generic';插件来源 = 'plugin:<id>'。 */
  event?: string
  /** 来源小字(插件名等),渲染在标题行。 */
  sourceLabel?: string
  /** 相同 key 的通知合并为一条(更新文案 + 计数 + 重置停留),防轰炸。 */
  dedupeKey?: string
  /** 常驻(手动关);缺省 error 常驻、其余按 level 自动消失。 */
  sticky?: boolean
  /** 无视开关强制弹出(仅设置页「发送测试通知」用,预览位置/样式)。 */
  force?: boolean
  action?: { label: string; run(): void }
}

export interface AppNotification {
  id: string
  text: string
  title?: string
  level: NotifyLevel
  event: string
  sourceLabel?: string
  createdAt: number
  sticky: boolean
  count: number
  dedupeKey?: string
  action?: { label: string; run(): void }
}

/** 内置事件注册表(设置页开关列表的数据源;插件事件 plugin:<id> 动态出现,默认开)。 */
export const NOTIFY_EVENTS: Array<{ id: string; labelKey: string; defaultOn: boolean }> = [
  { id: 'system.generic', labelKey: 'ntf.event.system', defaultOn: true },
  { id: 'sync.error', labelKey: 'ntf.event.syncError', defaultOn: true },
  { id: 'sync.done', labelKey: 'ntf.event.syncDone', defaultOn: true }, // 用户方向:默认开(dedupeKey 合并防轰炸)
  { id: 'agent.done', labelKey: 'ntf.event.agentDone', defaultOn: true },
  { id: 'inbox.message', labelKey: 'ntf.event.inbox', defaultOn: true },
]

export function eventDefaultOn(event: string): boolean {
  const def = NOTIFY_EVENTS.find((e) => e.id === event)
  return def ? def.defaultOn : true // 未注册(含 plugin:*)默认开
}

const MAX_VISIBLE = 4
/** 停留时长(ms);0 = 常驻。 */
const DURATION: Record<NotifyLevel, number> = { success: 3200, info: 5000, warning: 8000, error: 0 }

const PREFS_KEY = 'forsion.ntf.prefs'
interface NtfPrefs {
  enabled: boolean
  /** 系统(OS)通知:与应用内通知同步发,窗口在后台时弹。默认开。 */
  osEnabled: boolean
  /** 事件 id → 开关;缺省回落 eventDefaultOn。 */
  events: Record<string, boolean>
}
function readPrefs(): NtfPrefs {
  try {
    const v = localStorage.getItem(PREFS_KEY)
    if (v) return { enabled: true, osEnabled: true, events: {}, ...(JSON.parse(v) as Partial<NtfPrefs>) }
  } catch { /* ignore */ }
  return { enabled: true, osEnabled: true, events: {} }
}
function writePrefs(p: NtfPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

interface NtfState {
  /** 可见堆叠(时间序:最旧在上,新的排下面;最上面的先到期消失,下面自动上移补位)。 */
  items: AppNotification[]
  /** 溢出队列(同屏超过 MAX_VISIBLE 条时排队,腾位后按序顶上)。 */
  queue: AppNotification[]
  prefs: NtfPrefs
  paused: boolean
  notify(input: NotifyInput): string | null
  dismiss(id: string): void
  dismissAll(): void
  setEnabled(on: boolean): void
  setOsEnabled(on: boolean): void
  setEventOn(event: string, on: boolean): void
  pause(): void
  resume(): void
}

// 定时器簿记(React/zustand 外):active = {handle,deadline};paused = {handle:null,remaining}。
type TimerRec = { handle: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }
const timers = new Map<string, TimerRec>()
function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t?.handle) clearTimeout(t.handle)
  timers.delete(id)
}
let seq = 0

export const useNotifications = create<NtfState>((set, get) => {
  const startTimer = (id: string, ms: number): void => {
    clearTimer(id)
    if (ms <= 0) return
    if (get().paused) {
      timers.set(id, { handle: null, deadline: 0, remaining: ms })
      return
    }
    timers.set(id, { handle: setTimeout(() => get().dismiss(id), ms), deadline: Date.now() + ms, remaining: 0 })
  }

  return {
    items: [],
    queue: [],
    prefs: readPrefs(),
    paused: false,

    notify: (input) => {
      const level: NotifyLevel = input.level && ['info', 'success', 'warning', 'error'].includes(input.level) ? input.level : 'info'
      const event = input.event ?? 'system.generic'
      const st = get()
      if (!input.force) {
        if (!st.prefs.enabled) return null
        if (!(st.prefs.events[event] ?? eventDefaultOn(event))) return null
      }
      const sticky = input.sticky ?? level === 'error'
      const text = String(input.text ?? '').slice(0, 500) // 防插件超长字符串撑爆卡片
      const title = input.title ? String(input.title).slice(0, 120) : undefined

      // 去重合并:同 dedupeKey 更新原条(计数 + 文案 + 重置停留),可见或排队中皆然。
      if (input.dedupeKey) {
        const found = st.items.find((n) => n.dedupeKey === input.dedupeKey) || st.queue.find((n) => n.dedupeKey === input.dedupeKey)
        if (found) {
          const visible = st.items.some((n) => n.id === found.id)
          const upd: AppNotification = {
            ...found, text, title: title ?? found.title, level, count: found.count + 1,
            createdAt: Date.now(), sticky: sticky || found.sticky, action: input.action ?? found.action,
          }
          set((s) => ({
            items: s.items.map((n) => (n.id === found.id ? upd : n)),
            queue: s.queue.map((n) => (n.id === found.id ? upd : n)),
          }))
          if (visible) {
            if (upd.sticky) clearTimer(found.id)
            else startTimer(found.id, DURATION[level])
          }
          return found.id
        }
      }

      const n: AppNotification = {
        id: `ntf-${++seq}-${Date.now()}`, text, title, level, event,
        sourceLabel: input.sourceLabel, createdAt: Date.now(), sticky, count: 1,
        dedupeKey: input.dedupeKey, action: input.action,
      }
      // 系统通知:与应用内通知同步发(所有事件,不止收件箱);仅窗口在后台时(前台已有卡片,免重复横幅);
      // osEnabled 门控。web/mobile 无 window.tangu.notify → 可选链忽略。dedupe 合并不重发(上面已 return)。
      if (st.prefs.osEnabled && typeof document !== 'undefined' && !document.hasFocus()) {
        const osTitle = title || input.sourceLabel || 'Forsion'
        try { window.tangu?.notify?.(osTitle, text) } catch { /* 无桥/web 忽略 */ }
      }
      if (st.items.length < MAX_VISIBLE) {
        set((s) => ({ items: [...s.items, n] }))
        if (!sticky) startTimer(n.id, DURATION[level])
      } else {
        set((s) => ({ queue: [...s.queue, n] }))
      }
      return n.id
    },

    dismiss: (id) => {
      clearTimer(id)
      const s = get()
      let items = s.items.filter((n) => n.id !== id)
      let queue = s.queue.filter((n) => n.id !== id)
      if (items.length === s.items.length && queue.length === s.queue.length) return
      // 补位:队列头按序顶上(保持时间序,最上面的仍是最旧)。
      const promoted: AppNotification[] = []
      while (items.length < MAX_VISIBLE && queue.length) {
        const nx = queue[0]
        queue = queue.slice(1)
        items = [...items, nx]
        promoted.push(nx)
      }
      set({ items, queue })
      for (const nx of promoted) if (!nx.sticky) startTimer(nx.id, DURATION[nx.level])
    },

    dismissAll: () => {
      for (const id of [...timers.keys()]) clearTimer(id)
      set({ items: [], queue: [] })
    },

    setEnabled: (on) => {
      const prefs = { ...get().prefs, enabled: on }
      set({ prefs })
      writePrefs(prefs)
    },

    setOsEnabled: (on) => {
      const prefs = { ...get().prefs, osEnabled: on }
      set({ prefs })
      writePrefs(prefs)
    },

    setEventOn: (event, on) => {
      const prefs = { ...get().prefs, events: { ...get().prefs.events, [event]: on } }
      set({ prefs })
      writePrefs(prefs)
    },

    // hover 暂停:冻结全部在飞定时器记剩余;移出后续走剩余(下限 800ms,防恢复即消失)。
    pause: () => {
      if (get().paused) return
      set({ paused: true })
      for (const [id, t] of timers) {
        if (t.handle) {
          clearTimeout(t.handle)
          timers.set(id, { handle: null, deadline: 0, remaining: Math.max(800, t.deadline - Date.now()) })
        }
      }
    },
    resume: () => {
      if (!get().paused) return
      set({ paused: false })
      for (const [id, t] of timers) {
        if (!t.handle) {
          const ms = t.remaining || 1500
          timers.set(id, { handle: setTimeout(() => get().dismiss(id), ms), deadline: Date.now() + ms, remaining: 0 })
        }
      }
    },
  }
})

/** 便捷入口(store 外调用:appStore.toast 垫片 / wiring / 插件宿主)。 */
export const notifyApp = (input: NotifyInput): string | null => useNotifications.getState().notify(input)
