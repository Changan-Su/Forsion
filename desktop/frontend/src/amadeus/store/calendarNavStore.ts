/** Calendar 的跨组件状态:①视图模式(持久化 → 离开 Space 再回来不重置,任务1)
 *  ②主区 Calendar 当前可见日期区间 + ③mini 日历「跳到某日」请求(右栏 mini ↔ 主区 Calendar
 *  的唯一通道,任务3)。区间/跳转是内存态(不持久化);模式落 localStorage。 */
import { create } from 'zustand'
import type { CardTarget } from '../../views/calendar/EventCard'

export type CalMode = 'month' | 'week' | '3day' | 'day'
const MODE_KEY = 'amadeus.calendar.mode'
// 默认「周」而非「月」:只有时间视图才有 24h 时间轴 + 当前时间线,首启就落在能看到时间线的视图。
const loadMode = (): CalMode => {
  const m = localStorage.getItem(MODE_KEY)
  return m === 'week' || m === '3day' || m === 'day' || m === 'month' ? m : 'week'
}

// ④时间轴缩放:每小时像素高(持久化)。CSS 网格线经 --amx-hour-px 变量同步(见 TimeScroll 注入)。
export const HOUR_PX_DEFAULT = 44
const HOUR_PX_KEY = 'amadeus.calendar.hourPx'
export const clampHourPx = (px: number): number => Math.max(28, Math.min(120, Math.round(px)))
const loadHourPx = (): number => {
  const v = Number(localStorage.getItem(HOUR_PX_KEY))
  return Number.isFinite(v) && v > 0 ? clampHourPx(v) : HOUR_PX_DEFAULT
}

/** 新建中的事件(草稿):**不落盘**,标题打完 Enter / 点走才写进多维表,Esc 或空标题点走 = 丢弃。
 *  day = 起始日 'YYYY-MM-DD';startMin = null 表示全天(此时 endDay = 末日,含);否则 [startMin, endMin) 分钟。 */
export interface CalDraft {
  day: string
  startMin: number | null
  endMin: number
  endDay: string
  title: string
  /** 落在哪个日历(多维表路径);null = 默认日历。 */
  dbPath: string | null
}

interface CalNavState {
  mode: CalMode
  setMode(m: CalMode): void
  /** 时间视图每小时像素高(28–120,持久化);月视图不受影响。 */
  hourPx: number
  setHourPx(px: number): void
  /** 主区 Calendar 当前可见首/末日('YYYY-MM-DD');null = Calendar 未挂载。mini 据此画淡区间条。 */
  visibleStart: string | null
  visibleEnd: string | null
  setVisibleRange(start: string | null, end: string | null): void
  /** mini 点某日 → 主区丝滑跳转;nonce 递增触发主区订阅(值相同也能重复跳)。 */
  jumpDate: string | null
  jumpNonce: number
  requestJump(date: string): void
  /** 高亮着的事件(刚建 / 刚复制的那条;点开的事件走浮卡,不在这里):Delete / ⌘D 对它生效,Enter 在它旁边开卡。target 由 CalendarView 随数据刷新重写。 */
  selection: { key: string; target: CardTarget } | null
  setSelection(sel: { key: string; target: CardTarget } | null): void
  draft: CalDraft | null
  setDraft(draft: CalDraft | null): void
  /** 草稿的保存 / 丢弃(主区日历挂载时登记;草稿卡的按钮走这里)。 */
  draftApi: { commit(): void; cancel(): void } | null
  setDraftApi(api: { commit(): void; cancel(): void } | null): void
  /** 日历右栏(待办)的根节点(挂载时登记):焦点在右栏里时,日历的快捷键照样生效。 */
  sideEl: HTMLElement | null
  setSideEl(el: HTMLElement | null): void
}

export const useCalendarNav = create<CalNavState>((set) => ({
  mode: loadMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* ignore */
    }
    set({ mode })
  },
  hourPx: loadHourPx(),
  setHourPx: (px) => {
    const hourPx = clampHourPx(px)
    try {
      localStorage.setItem(HOUR_PX_KEY, String(hourPx))
    } catch {
      /* ignore */
    }
    set({ hourPx })
  },
  visibleStart: null,
  visibleEnd: null,
  setVisibleRange: (visibleStart, visibleEnd) => set({ visibleStart, visibleEnd }),
  jumpDate: null,
  jumpNonce: 0,
  requestJump: (jumpDate) => set((s) => ({ jumpDate, jumpNonce: s.jumpNonce + 1 })),
  selection: null,
  setSelection: (selection) => set({ selection }),
  draft: null,
  setDraft: (draft) => set({ draft }),
  draftApi: null,
  setDraftApi: (draftApi) => set({ draftApi }),
  sideEl: null,
  setSideEl: (sideEl) => set({ sideEl }),
}))
