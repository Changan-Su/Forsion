import { hasNativeFeature, amadeusAvailable } from '../features/runtime'
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
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton, UI_MODE,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel, LayoutBlob } from '@lcl/engine'
import { lazyRetry, preloadWhenIdle } from '../lazyRetry'
import { registerMessages } from '../i18n'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { SpaceButton } from '../components/SpaceButton'
import { CalendarDashboardCard, TodoDashboardCard } from '../views/DashboardCompactViews'

const CalendarView = lazyRetry(() => import('../views/CalendarView').then((m) => ({ default: m.CalendarView })))
const TodoListView = lazyRetry(() => import('../views/TodoListView').then((m) => ({ default: m.TodoListView })))
const CalendarConfigView = lazyRetry(() => import('../views/CalendarConfigView').then((m) => ({ default: m.CalendarConfigView })))
const CalendarSide = lazyRetry(() => import('../views/calendar/CalendarSide').then((m) => ({ default: m.CalendarSide })))

registerMessages({
  'calendar.builtinDesc': {
    zh: '日历 Space：汇总全库多维表的日期与待办属性，支持 .ics 订阅。',
    en: 'Calendar Space: aggregates date and to-do properties across your vault, with .ics subscriptions.',
  },
})

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** 手机(单列壳)/ 桌面两套侧栏。数据来自全库多维表的 todo / calendarDate 属性(dbAggregateStore)。
 *  · 桌面(2026-10-16 用户定):左 = 小月历 + 日历列表;右 = calendar-side(平时是待办,选中事件换成详情)。
 *  · 手机这一轮不动:左抽屉 = 待办,右抽屉 = 日历配置。手机走 `UI_MODE === 'mobile' || window.tangu.mobile`。
 *  老存档里两侧还是旧摆法 → spaces.tsx 的 forsion_calendar_layout_v2 一次性重建本 Space 的布局(同图像工作室那条)。 */
const singleColumn = (): boolean => UI_MODE === 'mobile' || !!window.tangu?.mobile
const PHONE_SIDES: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'todo-list', params: {} }],
  right: [{ type: 'calendar-config', params: {} }],
}
const DESKTOP_SIDES: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'calendar-config', params: {} }],
  right: [{ type: 'calendar-side', params: {} }],
}
const sides = (): Record<'left' | 'right', PersistedPanel[]> => (singleColumn() ? PHONE_SIDES : DESKTOP_SIDES)

/** 这份存档整份还是 10-16 之前的默认摆法吗(左只有待办、右只有日历设置、主区只有日历、底栏空;收起的一侧看暂存)。
 *  是 → 启动时重建本 Space 的布局换成新摆法;用户动过任何一处(多开了标签 / 分屏 / 底栏终端、换过边)= false,
 *  整份不动 —— 重建会连主区与单列存档一起清掉(Codex 评审 P1)。 */
export function calendarSidesAreOld(blob: LayoutBlob | null): boolean {
  if (!blob) return false
  const panels = Object.values((blob.dockview as { panels?: Record<string, { params?: { __loc?: string; __type?: string } }> } | null)?.panels ?? {})
  const at = (side: 'left' | 'right'): string[] => {
    const live = panels.filter((p) => p.params?.__loc === side).map((p) => p.params?.__type ?? '').filter((x) => x !== 'sidebar-empty')
    return live.length ? live : blob.sidebars[side].stash.map((v) => v.type)
  }
  const only = (xs: string[], type: string): boolean => xs.length <= 1 && xs.every((x) => x === type)
  const l = at('left'), r = at('right')
  const rest = panels.filter((p) => p.params?.__loc !== 'left' && p.params?.__loc !== 'right').map((p) => p.params?.__type ?? '')
  return l.length + r.length > 0 && only(l, 'todo-list') && only(r, 'calendar-config') && only(rest, 'calendar') && !blob.sidebars.bottom?.stash.length
}

export const calendarSpace: SpaceDefinition = {
  id: 'calendar',
  mini: { name: 'ToDo List', view: { type: 'mini-todo' }, mainView: { type: 'todo-list' } },
  name: () => app().tr('space.calendar'),
  icon: CalendarDays,
  get sidebarDefaults() { return sides() },
  listFirst: false, // 手机上先看日历:左栏是待办,不是「点开一项进主区」的列表
  get pinned() {
    return singleColumn()
      ? { main: [{ type: 'calendar', params: {} }], left: [{ type: 'todo-list', params: {} }] }
      // 桌面两侧不固定:没被迁移的老布局(用户动过)按区补固定项会在两侧各多出一份(左多日历设置、右多待办)。
      : { main: [{ type: 'calendar', params: {} }] }
  },
  // 待办在本 Space 里住左栏,但单独开成一个标签同样成立(原先启动器里就有这张卡)。
  launcherViews: [{ type: 'calendar', params: {} }, { type: 'todo-list', params: {} }],
  build() {
    const s = sides()
    ws().setSidebarDefaults(s)
    ws().openView('calendar', {}, 'main')
    ws().openView(s.left[0].type, {}, 'left')
    ws().openView(s.right[0].type, {}, 'right')
  },
}

/** 宿主具备条件才谈得上装:产品档案点名 + Amadeus 文件系统桥(跨库聚合走 vault)。
 *  Tangu Web / 单品档案没有它 → 插件卡整个不出现,SPACES 里也不带。 */
export const calendarAvailable = (): boolean => hasNativeFeature('calendar') && amadeusAvailable()

/** 三个视图的注册(启动 + 运行时开启共用)。 */
export function installCalendarViews(): void {
  if (!calendarAvailable()) return
  // 空闲预热(U-40)。分块的 CSS 会随之提前注入整页:Astryx 重置已收进 @scope(theme/astryxReset.css),
  // 不再作用到日历以外 —— 以前是全局 `:where(*)`,预热会让别处样式跟着变(check:projectdetails 9c 错位 4px)。
  preloadWhenIdle(CalendarView, TodoListView, CalendarConfigView, CalendarSide)
  // ⚠️ 待办视图**吃 params 且非 singleton**(与另外两个不同,刻意的):
  //  · factory 必须把 params 透传下去 —— 从前写的是 `() => <TodoListView />`,把 ViewProps 整个丢了,
  //    于是 Dashboard 卡片上 `db:`/`src:` 这些键落了盘也没人读(dashboardViewCard 早就在传了)。
  //  · 去 singleton **只解锁主区多开**:侧栏是「同侧同类型唯一」(dockviewStore 的 openView),
  //    左栏仍旧一个类型一个 —— 别把这两件事说成一件。
  // dashboard: 仪表盘嵌卡契约(尺寸档 + 紧凑卡面)跟着注册点走 —— 视图注册在哪,契约就声明在哪。
  registerView({
    type: 'todo-list', kind: 'collection', embeddable: true,
    intelligent: { description: 'Live saved Forsion tasks, ordered by due date. Users can mark tasks complete. Does not create tasks.', render: () => <TodoDashboardCard size="lg" /> },
    displayName: () => app().tr('view.todo'), icon: ListTodo,
    factory: ({ params, leaf }) => <Suspense fallback={<Skeleton variant="list" />}><TodoListView params={params} leaf={leaf} /></Suspense>,
    dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'lg', surface: 'summary', factory: (_props, ctx) => <TodoDashboardCard size={ctx.size} /> },
  })
  registerView({
    type: 'calendar', kind: 'collection', embeddable: true,
    // 右栏主视图规则(lcl rightRules.ts):日历做主区前台时右栏 = 待办 / 事件详情(calendar-side),不分 Space。
    rightCompanions: [{ type: 'calendar-side', params: {} }],
    intelligent: { description: 'Live Forsion calendar agenda for the next 31 days, including configured calendars. Does not create events.', render: () => <CalendarDashboardCard size="lg" /> },
    displayName: () => app().tr('view.calendar'), icon: CalendarDays,
    factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><CalendarView leafId={props.leaf.id} /></Suspense>, singleton: true,
    dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'lg', surface: 'summary', factory: (_props, ctx) => <CalendarDashboardCard size={ctx.size} /> },
  })
  // 日历右栏:待办 ↔ 选中事件的详情 ↔ 新建草稿(见 views/calendar/CalendarSide)。只在日历 Space 的右栏用,不进启动器。
  registerView({ type: 'calendar-side', kind: 'page', displayName: () => app().tr('view.todo'), icon: ListTodo, factory: () => <Suspense fallback={<Skeleton variant="list" />}><CalendarSide /></Suspense>, singleton: true })
  registerView({ type: 'calendar-config', kind: 'page', displayName: () => app().tr('view.calendarConfig'), icon: Settings, factory: () => <Suspense fallback={<Skeleton variant="list" />}><CalendarConfigView /></Suspense>, singleton: true })
}

/** Space + ribbon 图标(幂等:启动那次由 registerSpaces 按槽位注册过就不重复)。 */
export function installCalendarSpace(): void {
  if (!calendarAvailable()) return
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
