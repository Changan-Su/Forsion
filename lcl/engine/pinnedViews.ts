/**
 * 固定 View(Space 级声明)的判定,纯函数,无 DOM / 无 store —— 桌面 Dockview store 与单列 store 共用。
 *
 * 不变量只有一条:**该区内始终至少留一个这种 View**。由此得到(两份 store 各自接线):
 *  · 关不掉、拖不出本区 —— 区内最后一个受保护;多开的同类标签照常可关。
 *  · 不被别的类型顶掉 —— 在最后一个上打开别的类型 → 同组新标签;同类照旧就地换(聊天 → 另一个会话)。
 *  · 进入 Space 时缺了就补(spaceRegistry.setActiveSpace → ensurePinned)。
 *
 * 固定是 Space 的属性,**不在面板上盖章、不进布局存档**:每次按当前 Space 的声明现判。盖章要穿过
 * navigateLeaf 的清参、分屏复制、收起暂存、替换视图四条路径,每条都是漏点;而且「主聊天」的身份本来
 * 就会在标签之间转移(sessionNav.freezeMainPrimary),认定某一个面板会和它打架。
 * 底部面板不支持固定:它「关掉最后一个 = 收起面板」,与这条不变量冲突。
 */
import type { PersistedPanel } from './layoutPersist'

export type PinnedLoc = 'main' | 'left' | 'right'
/** 区 → 固定的视图;params = 缺了补回时的重建参数。 */
export type PinnedViews = Partial<Record<PinnedLoc, PersistedPanel[]>>
/** 判定只看每个面板在哪个区、是什么类型。 */
export interface PanelRef { loc: string; type: string }

export function isPinned(pins: PinnedViews, loc: string, type: string): boolean {
  return !!pins[loc as PinnedLoc]?.some((p) => p.type === type)
}

/** 受保护 = (区, 类型) 被固定,且区内只剩这一个。 */
export function isLastPinned(pins: PinnedViews, panels: PanelRef[], loc: string, type: string): boolean {
  return isPinned(pins, loc, type) && panels.filter((p) => p.loc === loc && p.type === type).length <= 1
}

/** 固定了、类型已注册、但该区没有的条目。panels 由调用方给全:活面板 + 收起侧栏里暂存着的。 */
export function missingPinned(pins: PinnedViews, panels: PanelRef[], known: (type: string) => boolean): Array<PersistedPanel & { loc: PinnedLoc }> {
  const out: Array<PersistedPanel & { loc: PinnedLoc }> = []
  for (const loc of ['main', 'left', 'right'] as const) {
    for (const pin of pins[loc] ?? []) {
      if (known(pin.type) && !panels.some((p) => p.loc === loc && p.type === pin.type)) out.push({ ...pin, loc })
    }
  }
  return out
}

/** 一页式 Space(types.ts 的 onePage)进来时的落点:该到前台的那个主区 leaf 的 id(已经在前台是 null),和该关掉的
 *  东西 —— 多余的标签,以及两边抽屉里的面板(`sideLeaves`)。一页式 Space 没有侧栏:抽屉里有东西只可能是带进来的
 *  (手机只存一份「正在用」的布局、不记是哪个 Space 的,启动却固定进主页 → 上次退出时那个 Space 的左栏跟着进了主页),
 *  而左栏里有面板,两级导航就把这个 Space 当成「先看列表」的,那一页被压在列表后面。宿主自己挂的抽屉扩展(`__extend`)不算。
 *  没声明、或区里没有它的那一页时什么都不动(两项都空)—— 没有那一页就没有东西可落,别把别的关光。 */
export function onePageLanding(
  space: { onePage?: boolean; pinned?: PinnedViews } | undefined,
  mainLeaves: Array<{ id: string; type: string }>,
  activeMainId: string | null,
  sideLeaves: Array<{ id: string; type: string }> = [],
): { activate: string | null; close: string[] } {
  const type = space?.onePage ? space.pinned?.main?.[0]?.type : undefined
  const rec = type ? mainLeaves.find((r) => r.type === type) : undefined
  if (!rec) return { activate: null, close: [] }
  return {
    activate: rec.id !== activeMainId ? rec.id : null,
    close: [...mainLeaves.filter((r) => r.id !== rec.id), ...sideLeaves.filter((r) => r.type !== '__extend')].map((r) => r.id),
  }
}

/** 有默认主页的 Space(types.ts 的 mainPage)进来时的落点:主区已有这种视图 → `activate` 它(已在前台是 null);
 *  没有 → `open` 它,主区只剩空态占位时就地换掉(`newTab: false`),否则另开标签。没声明是空操作。 */
export function mainPageLanding(
  space: { mainPage?: PersistedPanel } | undefined,
  mainTabs: Array<{ id: string; type: string; front: boolean }>,
): { activate: string | null; open: (PersistedPanel & { newTab: boolean }) | null } {
  const page = space?.mainPage
  if (!page) return { activate: null, open: null }
  const tab = mainTabs.find((t) => t.type === page.type)
  if (tab) return { activate: tab.front ? null : tab.id, open: null }
  return { activate: null, open: { ...page, newTab: mainTabs.some((t) => t.type !== 'home') } }
}

/** 引擎自己的占位视图:不是内容,哪个 Space 都不算它的主人。 */
const PLACEHOLDER_VIEWS = new Set(['launcher', 'home', 'sidebar-empty'])

/** 一页式 Space 里要开 `type` 这种视图:该带去哪个 Space 开。不用带(当前不是一页式、开的就是它自己那一页、占位视图、
 *  认不出主人)返回 undefined。主人 = 注册顺序里第一个把它固定在主区、或列在 launcherViews 里的别的 Space。 */
export function onePageRedirect(
  spaces: Array<{ id: string; onePage?: boolean; pinned?: PinnedViews; launcherViews?: PersistedPanel[] }>,
  activeId: string,
  type: string,
): string | undefined {
  const from = spaces.find((s) => s.id === activeId)
  if (!from?.onePage || PLACEHOLDER_VIEWS.has(type) || from.pinned?.main?.some((p) => p.type === type)) return undefined
  return spaces.find((s) => s.id !== activeId && [...(s.pinned?.main ?? []), ...(s.launcherViews ?? [])].some((p) => p.type === type))?.id
}
