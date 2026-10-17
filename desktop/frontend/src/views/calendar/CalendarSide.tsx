/** 日历 Space 的右栏:待办。
 *  10-16 方案 B 先做成「选中事件换成详情、新建换成草稿面板」,同日用户改口 ——
 *  编辑事件回到事件旁的浮卡(./EventCard、./DraftCard),右栏只放待办。
 *  方案页:docs/ToBeImproved/Calendar交互与待办右栏方案_2026-10-16/。 */
import { useEffect, useRef } from 'react'
import { TodoListView } from '../TodoListView'
import { useCalendarNav } from '../../amadeus/store/calendarNavStore'

export function CalendarSide() {
  const setSideEl = useCalendarNav((s) => s.setSideEl)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSideEl(ref.current)
    return () => { if (useCalendarNav.getState().sideEl === ref.current) setSideEl(null) }
  }, [setSideEl])
  return (
    <div className="amx-calside2" ref={ref}>
      <TodoListView params={{ side: true }} />
    </div>
  )
}
