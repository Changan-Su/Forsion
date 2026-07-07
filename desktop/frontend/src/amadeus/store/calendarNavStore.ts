/** Calendar 的跨组件状态:①视图模式(持久化 → 离开 Space 再回来不重置,任务1)
 *  ②主区 Calendar 当前可见日期区间 + ③mini 日历「跳到某日」请求(右栏 mini ↔ 主区 Calendar
 *  的唯一通道,任务3)。区间/跳转是内存态(不持久化);模式落 localStorage。 */
import { create } from 'zustand'

export type CalMode = 'month' | 'week' | '3day' | 'day'
const MODE_KEY = 'amadeus.calendar.mode'
// 默认「周」而非「月」:只有时间视图才有 24h 时间轴 + 当前时间线,首启就落在能看到时间线的视图。
const loadMode = (): CalMode => {
  const m = localStorage.getItem(MODE_KEY)
  return m === 'week' || m === '3day' || m === 'day' || m === 'month' ? m : 'week'
}

interface CalNavState {
  mode: CalMode
  setMode(m: CalMode): void
  /** 主区 Calendar 当前可见首/末日('YYYY-MM-DD');null = Calendar 未挂载。mini 据此画淡区间条。 */
  visibleStart: string | null
  visibleEnd: string | null
  setVisibleRange(start: string | null, end: string | null): void
  /** mini 点某日 → 主区丝滑跳转;nonce 递增触发主区订阅(值相同也能重复跳)。 */
  jumpDate: string | null
  jumpNonce: number
  requestJump(date: string): void
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
  visibleStart: null,
  visibleEnd: null,
  setVisibleRange: (visibleStart, visibleEnd) => set({ visibleStart, visibleEnd }),
  jumpDate: null,
  jumpNonce: 0,
  requestJump: (jumpDate) => set((s) => ({ jumpDate, jumpNonce: s.jumpNonce + 1 })),
}))
