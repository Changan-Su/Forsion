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

/** Space 声明了 landOnPinned(types.ts)时,进它该切到前台的那个主区 leaf 的 id;不用动返回 null
 *  (没声明、区里没有它的固定主视图、或它已经在前台)。只换前台,别的标签不关。 */
export function pinnedLanding(
  space: { landOnPinned?: boolean; pinned?: PinnedViews } | undefined,
  mainLeaves: Array<{ id: string; type: string }>,
  activeMainId: string | null,
): string | null {
  const type = space?.landOnPinned ? space.pinned?.main?.[0]?.type : undefined
  const rec = type ? mainLeaves.find((r) => r.type === type) : undefined
  return rec && rec.id !== activeMainId ? rec.id : null
}
