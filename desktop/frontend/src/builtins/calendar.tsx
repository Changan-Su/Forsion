/**
 * 内置插件「日历」= Calendar Space + 日历 / 待办清单 / 日历设置 三个视图。
 *
 * 为什么是宿主原生视图而不是真外置插件(同 browser/terminal 那条理由):外置插件 API 是
 * `new Function(setup(ctx))` + 纯 DOM mount,而这三个视图直接吃 dbAggregateStore 的全库多维表聚合、
 * pageStore、跨库日历成员表。所以做成宿主原生形态,只在插件页以插件卡露出并可开关 ——
 * 关掉 = 三个视图反注册 + Space 撤下(ribbon 图标消失),用户看到的形态与卸载一个插件一致。
 *
 * ⚠️两处注册点(刻意的不对称,与 registerSpaces / userSpaces 的分工同源):
 *  · **启动** = `spaces.tsx` 的 SPACES 里按开关声明式带上 —— 保住 ribbon 的默认槽位(注册序 = 默认序),
 *    也保住「上次退出停在日历」的启动恢复(registerSpaces 的 fallback 会把**未注册**的活动 Space
 *    打回产品默认并持久化,移动端更是整段跳过启动块 → 每次重启都被踢回 Tangu)。
 *  · **运行时开关** = installCalendarSpace / removeCalendarSpace(builtins/index 的 applyBuiltin 调,
 *    含跨窗 storage 事件)。installCalendarSpace 幂等,启动那次注册过就不再动。
 *
 * 视图一律 lazyRetry:这个模块被 builtins/index 静态引,而 index 要能在 node 单测里导入
 * (CalendarView 那一坨 amadeus store 在 node 里活不下来)。顺带日历那 900 行也不再进首屏包。
 */
import { Suspense } from 'react'
import { CalendarDays, ListTodo, Settings } from 'lucide-react'
import {
  registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon,
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { registerMessages } from '../i18n'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { SpaceButton } from '../components/SpaceButton'
import { CalendarDashboardCard, TodoDashboardCard } from '../views/DashboardCompactViews'

const CalendarView = lazyRetry(() => import('../views/CalendarView').then((m) => ({ default: m.CalendarView })))
const TodoListView = lazyRetry(() => import('../views/TodoListView').then((m) => ({ default: m.TodoListView })))
const CalendarConfigView = lazyRetry(() => import('../views/CalendarConfigView').then((m) => ({ default: m.CalendarConfigView })))

registerMessages({
  'calendar.builtinDesc': {
    zh: '日历 Space:汇总全库多维表的日期与待办属性,支持 .ics 订阅。',
    en: 'Calendar Space: aggregates date and to-do properties across your vault, with .ics subscriptions.',
  },
})

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** Calendar Space:左=待办清单;主=日历;右=日历配置(颜色/显隐/默认库)。
 *  数据来自全库多维表的 todo / calendarDate 属性(dbAggregateStore)。 */
const CALENDAR_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'todo-list', params: {} }],
  right: [{ type: 'calendar-config', params: {} }],
}

export const calendarSpace: SpaceDefinition = {
  id: 'calendar',
  name: () => app().tr('space.calendar'),
  icon: CalendarDays,
  sidebarDefaults: CALENDAR_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(CALENDAR_SIDE_VIEWS)
    ws().openView('calendar', {}, 'main')
    ws().openView('todo-list', {}, 'left')
    ws().openView('calendar-config', {}, 'right')
  },
}

/** 宿主具备条件才谈得上装:产品档案点名 + Amadeus 文件系统桥(跨库聚合走 vault)。
 *  Tangu Web / 单品档案没有它 → 插件卡整个不出现,SPACES 里也不带。 */
export const calendarAvailable = (): boolean => PRODUCT.spaces.includes('calendar') && !!window.amadeus

/** 三个视图的注册(启动 + 运行时开启共用)。 */
export function installCalendarViews(): void {
  // ⚠️ 待办视图**吃 params 且非 singleton**(与另外两个不同,刻意的):
  //  · factory 必须把 params 透传下去 —— 从前写的是 `() => <TodoListView />`,把 ViewProps 整个丢了,
  //    于是 Dashboard 卡片上 `db:`/`src:` 这些键落了盘也没人读(dashboardViewCard 早就在传了)。
  //  · 去 singleton **只解锁主区多开**:侧栏是「同侧同类型唯一」(dockviewStore 的 openView),
  //    左栏仍旧一个类型一个 —— 别把这两件事说成一件。
  // dashboard: 仪表盘嵌卡契约(尺寸档 + 紧凑卡面)跟着注册点走 —— 视图注册在哪,契约就声明在哪。
  registerView({
    type: 'todo-list', kind: 'collection', embeddable: true,
    displayName: () => app().tr('view.todo'), icon: ListTodo,
    factory: ({ params }) => <Suspense fallback={<Skeleton variant="list" />}><TodoListView params={params} /></Suspense>,
    dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'lg', surface: 'summary', factory: (_props, ctx) => <TodoDashboardCard size={ctx.size} /> },
  })
  registerView({
    type: 'calendar', kind: 'collection', embeddable: true,
    displayName: () => app().tr('view.calendar'), icon: CalendarDays,
    factory: () => <Suspense fallback={<Skeleton variant="document" />}><CalendarView /></Suspense>, singleton: true,
    dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'lg', surface: 'summary', factory: (_props, ctx) => <CalendarDashboardCard size={ctx.size} /> },
  })
  registerView({ type: 'calendar-config', kind: 'page', displayName: () => app().tr('view.calendarConfig'), icon: Settings, factory: () => <Suspense fallback={<Skeleton variant="list" />}><CalendarConfigView /></Suspense>, singleton: true })
}

/** Space + ribbon 图标(幂等:启动那次由 registerSpaces 按槽位注册过就不重复)。 */
export function installCalendarSpace(): void {
  if (useSpaceStore.getState().spaces.some((s) => s.id === calendarSpace.id)) return
  registerSpace(calendarSpace)
  addRibbonIcon({
    id: `space:${calendarSpace.id}`,
    side: 'top',
    component: ({ expanded }) => <SpaceButton space={calendarSpace} expanded={expanded} />,
  })
}

/** 撤下 Space:停在日历里就先切走(切走会顺手把该 Space 的布局存进命名槽)。
 *  **不删命名布局** —— 重新启用即原样回来(同 userSpaces.removePluginSpace 的纪律)。 */
export function removeCalendarSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === calendarSpace.id) setActiveSpace(PRODUCT.defaultSpace)
  unregisterSpace(calendarSpace.id)
  removeRibbonIcon(`space:${calendarSpace.id}`)
}
