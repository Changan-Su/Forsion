/** Space 左面板悬停预览的纯判定(2026-10-13):指针停在 Ribbon 的 Space 图标上 → 条右侧浮出一张卡,
 *  里面是那个 Space 的左面板,可以直接操作。左面板展开着也弹(10-14),只有当前 Space 不弹 —— 它的左栏就在眼前。
 *  接线在 Ribbon.tsx,卡片在 SpacePeek.tsx;这里只放能单测的两条规则。 */
import type { PersistedPanel } from './layoutPersist'

/** 停多久才弹:比名字浮签(1s)短,比「路过」长 —— 顺着条往下扫不该闪出一张通高的卡。已经弹着时换图标不等。 */
export const PEEK_OPEN_DELAY = 300
/** 指针离开图标和卡片多久才收:够它跨过条与卡之间那道缝(同收纳夹浮层)。 */
export const PEEK_CLOSE_DELAY = 150

/** 卡里放哪些 View。当前 Space = 收起时暂存的那份,空了回落默认(同 toggleSidebar 的展开分支,所以看到的就是展开后会有的);
 *  别的 Space = 它的默认左栏。没注册的类型滤掉(收起期间插件可能已停用),滤完没剩 = 不弹。
 *  ponytail: 别的 Space 只认默认左栏,用户在那边拖改过的不认;要认就读 loadNamedLayout(spaceLayoutName(id)) 里的左栏。 */
export function peekViews(o: { active: boolean; stash: PersistedPanel[]; defaults: PersistedPanel[]; known(type: string): boolean }): PersistedPanel[] {
  const ok = (v: PersistedPanel): boolean => o.known(v.type)
  const live = o.active ? o.stash.filter(ok) : []
  return live.length ? live : o.defaults.filter(ok)
}

/** 指针此刻落在哪:卡片里 / Ribbon 上的某个 Space 图标 / 应用界面的别处 / 应用外壳之外(挂到 body 的菜单、弹窗)。 */
export type PeekZone = 'card' | 'trigger' | 'shell' | 'overlay'

/** 该不该开始收。只有指针真的回到应用界面别处才收:
 *  · 外壳之外的浮层多半是卡里的 View 自己弹出来的(右键菜单、确认框)—— 卡一收,View 卸载,菜单的回调就落空;
 *  · 按着键 = 正从卡里往外拖东西;
 *  · 卡里有输入框拿着焦点 = 正在改名 / 搜索,指针滑出去一点不该把打了一半的字丢掉。 */
export function peekShouldClose(o: { zone: PeekZone; buttons: number; typing: boolean }): boolean {
  return o.zone === 'shell' && o.buttons === 0 && !o.typing
}
