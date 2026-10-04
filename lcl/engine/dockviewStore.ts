/**
 * Workspace store(≈ Obsidian workspace)。在已集成的 Dockview 之上建薄 API:
 * openView / getActiveLeaf / splitActive / toggleSidebar / saveLayout↔restore / 命名布局。
 * 单个 Dockview 实例托管四区:左侧栏 / 主区 / 右侧栏 / 底部面板,由 panel.params.__loc 标记区分。
 * 左右按**宽**折叠(黄金分割钉宽 pinSides);底部横跨 Main 与右栏,按**高**折叠且恒 free,
 * 收起时组留在网格里藏起来(parkBottom),不删组 —— 删组会重挂主区整列,里面的 iframe 全部重载。
 * 视图「参数驱动可重建」:panel 存 {component:type, params} → 刷新/恢复时 Dockview 据此重建。
 */
import { create } from 'zustand'
import type { ExtendViewPresenter } from './extendView'
import { nativeExtendTargets } from './nativeExtendView'
import { withoutTransientPanels } from './transientLayout'
import { layoutMetrics, sameLayoutMetrics, type LayoutMetrics } from './layoutMetrics'
import { alignWorkspaceRegions, captureRegionTree, restoreRegionProportions, type BottomSpan, type RegionTree } from './regionLayout'
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import type { DockSide, Leaf, SidebarDefaults, ViewLocation } from './types'
import { getView } from './viewRegistry'
import { identitySig, label } from './types'
import { computeSideWidth, computeBottomHeight, computeTransientSideWidth } from './sideWidth'
import { shouldRecordSideWidth } from './sideCapture'
import { locOf, type DropTarget } from './dropModel'
import { isLastPinned, isPinned, missingPinned, type PanelRef, type PinnedViews } from './pinnedViews'
import { useNav } from './navStore'
import { ribbonActions } from './ribbonRegistry'
import { engineTr } from './i18nSeam'
import {
  LAYOUT_KEY, saveLayout, loadLayout, clearLayout, saveNamedLayout, loadNamedLayout, listNamedLayouts,
  type LayoutEnvelopeV4, type PersistedPanel,
} from './layoutPersist'

/** Dockview panel.params 里引擎私有字段(双下划线避免与视图 params 撞名)。 */
interface PanelMeta {
  __loc?: ViewLocation
  __type?: string
}

/** 恢复布局后也必须扫描现有 id；模块级 seq 会在重启后回零并撞上 chat#1。 */
export function nextPanelId(ids: Iterable<string>, type: string): string {
  const used = new Set(ids)
  let n = 1
  while (used.has(`${type}#${n}`)) n++
  return `${type}#${n}`
}

function nextId(api: DockviewApi, type: string): string {
  return nextPanelId(api.panels.map((p) => p.id), type)
}

/** 侧栏开合补间动画期间,pinSides 跳过该侧 —— 让 tween 独占其宽度,免被钉宽 setSize 打断。
 *  bottom 同理(它的补间量的是高),另外还挡住 captureSideWidths 记下补间中间高。 */
const sidebarAnimating: Record<DockSide, boolean> = { left: false, right: false, bottom: false }
const toggleReleases: Partial<Record<DockSide, () => void>> = {}
const extensions: Partial<Record<DockSide, { dismiss(): void; dispose(instant?: boolean): void | Promise<void>; id: string; previousId?: string; defaultWidth?: number }>> = {}
const dismissExtensions = (): void => {
  for (const side of ['left', 'right', 'bottom'] as const) { extensions[side]?.dismiss(); extensions[side]?.dispose(true) } // layout is being rebuilt: no tween
}


/** 布局结构一变(加/减一个组),Dockview 会把幸存的那一支**摘下来重新挂**到新的父节点上 ——
 *  DOM 节点、React 树都不变,但**元素重新入 DOM 会让其中所有 CSS 动画从头重播**。于是各视图自己的
 *  入场动画(主页的 hp-rise、聊天输入区、图标……)在收/展面板时集体重放一遍 = 用户实报的
 *  「不是整页在闪,是一些组件闪一下」。实测:收起前三个 hp-rise 都是 finished(t=250/310/370),
 *  收起后同一批变成 running(t=50)。
 *
 *  这不是我们的动画,也枚举不完(每个视图都可能有自己的入场效果),所以按**时机**掐:结构变化那一帧,
 *  把工作区内刚起头的动画直接推到终态。既有的 lastMainViewType 是同一个意图的窄版(只管 wb-view-enter)。
 *  ⚠️无限循环动画(加载转圈)必须跳过 —— finish() 对它们会抛,而且它们本来就该继续转。 */
/** 除了动画,重挂还会**把所有滚动容器的位置抹成 0**(同一个 DOM 节点,scrollTop 照样归零 ——
 *  实测 1500 → 0)。用户实报「日历里日期退回到 4 月 3 号左右」就是它:日历的当前日期由滚动位置决定,
 *  被滚回区间开头就显示成那个日期。聊天记录等一切滚动视图同受其害。
 *
 *  故结构变化必须**成对**包起来:变化前快照,变化后还原 + 掐掉误重播的动画。
 *  返回的收尾函数在结构变化之后调用。
 *  ⚠️ 救不了 iframe:节点一离开文档帧就被卸掉,重挂 = 重载(帧内状态全丢、先黑一下)。所以能不重挂就别重挂 ——
 *  底部面板开合已改成藏组不删组(parkBottom);左右栏开合仍走删组,仍会重挂。 */
function preserveAcrossRestructure(): () => void {
  const root = typeof document !== 'undefined' ? document.querySelector('.wb-dockview') : null
  if (!root) return () => { /* 无 DOM(测试) */ }
  // 只记真的滚过的容器(绝大多数元素 scrollTop 为 0,不必留档)。toggle 才走这条,遍历成本可接受。
  const scrolls: Array<{ el: Element; top: number; left: number }> = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const top = el.scrollTop, left = el.scrollLeft
    if (top || left) scrolls.push({ el, top, left })
  }
  const restoreScroll = (): void => {
    for (const s of scrolls) {
      // 节点在重挂后依然是同一个对象(实测),故直接写回即可;内容还没铺好时写不进去,靠下面再补一帧。
      if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top
      if (s.el.scrollLeft !== s.left) s.el.scrollLeft = s.left
    }
  }
  const settleAnimations = (): void => {
    const el = root as Element & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] }
    for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
      if (a.effect?.getTiming().iterations === Infinity) continue // 转圈之类,别掐
      if (Number(a.currentTime ?? 0) > 80) continue               // 不是这一帧刚重播的,放过
      try { a.finish() } catch { /* 有些动画不可 finish */ }
    }
  }
  return () => {
    restoreScroll()   // 同步先写一次
    // 重播/回流发生在重挂之后的下一帧,故再补一帧:动画那时才起头,滚动位置那时才写得进去。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { restoreScroll(); settleAnimations() })
    else settleAnimations()
  }
}

/** 每个区一轮开合的代号。补间是异步的(200ms),期间用户再点一次就会有两条 tween 同时在跑 ——
 *  收尾回调必须先比代号,不是自己那一轮的就整段放弃。否则旧那轮的 finish() 会去 close 新那轮刚开出来的
 *  panel:实测抛 dockview 的 'invalid operation'(未捕获),还会把 pinSides / 释放约束 / 存布局一起带跑偏。 */
const toggleGen: Record<DockSide, number> = { left: 0, right: 0, bottom: 0 }

/** Dockview 组的默认最小尺寸(dockviewGroupPanel.ts 的 MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH/HEIGHT)。
 *  展开补间必须先把它放开到 0,否则起步的 setSize(1) 被钳在这里 —— 见 toggleSidebar 展开分支。 */
const DV_GROUP_MIN = 100

/** 折叠区 → 其 visible 状态键。 */
function visKeyOf(side: DockSide): 'leftVisible' | 'rightVisible' | 'bottomVisible' {
  return side === 'left' ? 'leftVisible' : side === 'right' ? 'rightVisible' : 'bottomVisible'
}

/** pinSides 的延迟钉宽窗口标记:置位期间 captureSideWidths 一律不记宽(防把系统过渡态当用户拖宽写进
 *  localStorage → 焊死错宽 = 侧栏抽风根因 R1)。pinGen 让「最后一次 pin」负责清旗,多次 pin 叠加时
 *  不被先到的 setTimeout 提前解锁。 */
let pinPending = false
let pinGen = 0

/** 某侧栏的目标宽 = computeSideWidth(纯几何,见 sideWidth.ts)喂上当前 Space 的画像。
 *  pinSides 与折叠/展开动画都以此为准,故记住宽度即被尊重(不被重钉回黄金分割)= 持久化。 */
function sideTargetWidth(api: DockviewApi, loc: 'left' | 'right'): number {
  const st = useWorkspace.getState()
  const regular = computeSideWidth(api.width, loc, { free: st.sideFree[loc], saved: st.sideWidths[loc], scale: st.sideScale[loc] })
  // 新建的临时二级 View 默认略宽；一旦用户拖出自己的宽度，立即以用户记录为准。
  return st.sideWidths[loc] == null ? (extensions[loc]?.defaultWidth ?? regular) : regular
}

/** 底部面板的目标高(纯几何在 sideWidth.computeBottomHeight)。底部不进 pinSides 体系:
 *  没有「钉回黄金分割」这回事,只有「记住的高 / 首次 32%」。 */
function bottomTargetHeight(api: DockviewApi): number {
  return computeBottomHeight(api.height, useWorkspace.getState().sideWidths.bottom)
}

/** 正在沉降的底部组(pinPending 的纵向版)。从建组到 settleBottomHeight 落地的这一小段,它的高是 Dockview 的出生高
 *  (~50%,缺省拓扑下更高)= 系统态,captureSideWidths 不得当成「用户拖出来的」记下 —— 记了,目标高从此取它,
 *  面板一直半屏高(2026-10-04 实测:不经折叠钮直接 openView 到底部,通栏 450/900、缺省拓扑 700 → 钳到 540;
 *  折叠钮那条路有 sidebarAnimating 挡着,所以一直是好的)。记组不记时间:换了 api / 组自然失效,不留残值。 */
let bottomSettling: unknown = null

/** 刚建出的底部组按 Dockview 默认高(~50%)诞生 → 把它落到目标高。≈pinSides 的纵向版,但**只在建组时用一次**
 *  (底部恒 free,用户拖多高就是多高,不做持续钉高)。补间动画期间跳过,让 tween 独占。 */
function settleBottomHeight(api: DockviewApi): void {
  const apply = (): void => {
    if (sidebarAnimating.bottom) return
    try { panelsAt(api, 'bottom')[0]?.group.api.setSize({ height: bottomTargetHeight(api) }) } catch { /* 跨版本兜底 */ }
  }
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => f()
  const group = bottomSettling = panelsAt(api, 'bottom')[0]?.group ?? null
  apply() // 当场先落一次:出生高一帧都不上屏
  raf(() => raf(apply))
  // 同 pinSides:rAF 偶尔早于 Dockview 内部 resize。这是最后一次落地,之后的高才算用户的。
  setTimeout(() => { apply(); if (bottomSettling === group) bottomSettling = null }, 60)
}

/** 记住「可自由拖宽」侧栏的当前宽度(WorkspaceHost 在布局变更时调):用户拖动 sash 后即被捕获 +
 *  写 localStorage,下次 pinSides/展开都用它 → 拖宽持久。动画期间跳过(避免记下补间中间值)。 */
export function captureSideWidths(api: DockviewApi): void {
  const st = useWorkspace.getState()
  if (!st.sideProfileKey) return
  let changed = false
  const next: Record<DockSide, number | null> = { ...st.sideWidths }
  for (const loc of ['left', 'right'] as const) {
    if (!st.sideFree[loc] || sidebarAnimating[loc]) continue
    const w = (panelsAt(api, loc)[0] as { group?: SizableGroup } | undefined)?.group?.api?.width
    if (typeof w !== 'number') continue
    // 「这是不是用户拖出来的、该记的宽」抽到 sideCapture.shouldRecordSideWidth(纯函数,可单测)。
    // 关键:pinPending 期(pinSides 延迟落地前的过渡宽)绝不记,否则污染 → 抽风(见 sideCapture 注释)。
    if (!shouldRecordSideWidth({ measured: w, target: sideTargetWidth(api, loc), prev: next[loc], pinPending })) continue
    next[loc] = Math.round(w)
    changed = true
  }
  // 底部面板高度:恒 free,判定复用同一个 shouldRecordSideWidth(pinPending 恒 false —— 底部的沉降窗口由 bottomSettling 挡),
  // 于是「贴近目标高 = 系统设的」「<120 = 收起补间中间值」「与已记值几乎相同」三条豁免自动生效。
  const bottomGroup = (panelsAt(api, 'bottom')[0] as { group?: SizableGroup } | undefined)?.group
  if (!sidebarAnimating.bottom && bottomGroup !== bottomSettling) { // 沉降中的组:出生高是系统态(见 bottomSettling)
    const h = bottomGroup?.api?.height
    if (typeof h === 'number'
      && shouldRecordSideWidth({ measured: h, target: bottomTargetHeight(api), prev: next.bottom, pinPending: false })) {
      next.bottom = Math.round(h)
      changed = true
    }
  }
  if (changed) {
    useWorkspace.setState({ sideWidths: next })
    // 底部高写 bottomH,不写 bottom(见 setSideProfile:旧字段被出生高污染过)
    try { localStorage.setItem(`lcl.sideWidth2.${st.sideProfileKey}`, JSON.stringify({ left: next.left, right: next.right, bottomH: next.bottom })) } catch { /* private mode */ }
  }
}

type SizableGroup = { api: { setSize: (s: { width?: number; height?: number }) => void; width?: number; height?: number; setConstraints?: (c: { minimumWidth?: number; maximumWidth?: number; minimumHeight?: number; maximumHeight?: number }) => void } }

/** 临时锁住指定侧栏的宽度(min=max=目标宽),让 close 释放的空白只被中间主区吸收 ——
 *  Dockview 默认把腾出的宽度按比例摊给所有组,侧栏会「突然变宽」而剩下的主区纹丝不动。
 *  返回释放函数(布局沉降后调,恢复可手动拖宽)。 */
function lockSides(api: DockviewApi, sides: ('left' | 'right')[], keepCurrent = false): () => void {
  const locked: SizableGroup[] = []
  for (const s of sides) {
    const g = (panelsAt(api, s)[0] as { group?: SizableGroup } | undefined)?.group
    if (!g) continue
    // keepCurrent:钉「此刻的宽」= 用户要的「侧栏纹丝不动」。收栏那条路径必须钉目标宽 —— 它随后
    // 就要 pinSides 纠正漂移,钉当前宽会把漂移一起锁死。
    const w = (keepCurrent ? g.api.width : 0) || sideTargetWidth(api, s)
    try { g.api.setConstraints?.({ minimumWidth: w, maximumWidth: w }) } catch { /* 跨版本兜底 */ }
    locked.push(g)
  }
  return () => { for (const g of locked) { try { g.api.setConstraints?.({ minimumWidth: 0, maximumWidth: Number.MAX_SAFE_INTEGER }) } catch { /* ignore */ } } }
}
/** 收起一侧期间锁住**另一**侧(空白只给主区,免另一侧变宽再被 pinSides 弹回 = 收栏闪屏)。 */
const lockOtherSide = (api: DockviewApi, side: 'left' | 'right'): (() => void) => lockSides(api, [side === 'left' ? 'right' : 'left'])

/** rAF 把某组的一个维度(width|height)从 from 平滑补间到 to(ease-out cubic),done 收尾。
 *  无 rAF(测试)时直接收尾。 */
function tweenGroupSize(group: SizableGroup, key: 'width' | 'height', from: number, to: number, done: () => void, cancelled?: () => boolean): void {
  if (typeof requestAnimationFrame !== 'function' || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)) { if (cancelled?.()) return; try { group.api.setSize({ [key]: to }) } catch { /* ignore */ } done(); return }
  const DURATION = 200
  const ease = (k: number): number => 1 - Math.pow(1 - k, 3)
  let startTs = 0
  const step = (ts: number): void => {
    // 被后一次开合接管 → **立刻停帧**。只在收尾回调里判 stale 不够:这条 tween 会继续每帧 setSize,
    // 和新那条反向的 tween 逐帧对打(实测「收起途中再点一下」因此停在关闭态,反向展开不生效)。
    if (cancelled?.()) return
    if (!startTs) startTs = ts
    const k = Math.min(1, (ts - startTs) / DURATION)
    try { group.api.setSize({ [key]: Math.round(from + (to - from) * ease(k)) }) } catch { /* 跨版本兜底 */ }
    if (k < 1) requestAnimationFrame(step)
    else done()
  }
  requestAnimationFrame(step)
}

/** 把**两侧**侧栏组宽度都钉为 0.191×容器宽(黄金分割;中间自得 0.618)。
 *  必须两侧一起钉:只钉一侧时,另一侧 toggle 释放/重建会让这一侧吃掉空白而漂移(0.191→0.333)。
 *  Dockview split/setSize 异步竞争 → rAF + setTimeout 双重兜底,在布局沉降后再钉。
 *  正在补间动画的一侧跳过(sidebarAnimating),避免钉宽打断丝滑过渡。 */
function pinSides(api: DockviewApi): void {
  const gen = ++pinGen
  pinPending = true // 钉宽落地前 captureSideWidths 不记宽(防过渡态污染)
  const apply = (): void => {
    const W = api.width
    if (!W) return
    for (const loc of ['left', 'right'] as const) {
      if (sidebarAnimating[loc]) continue
      try { panelsAt(api, loc)[0]?.group.api.setSize({ width: sideTargetWidth(api, loc) }) } catch { /* 跨版本兜底 */ }
    }
  }
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => f()
  raf(() => raf(apply))
  // Dockview 布局沉降后再钉一次(rAF 偶尔早于其内部 resize);顺带关闭 pin 窗口(仅最后一次 pin 清旗)。
  setTimeout(() => { apply(); if (gen === pinGen) pinPending = false }, 60)
}

/** 读 panel 的视图类型:优先 params.__type(可靠),回退 Dockview 的 component(跨版本不保证暴露,
 *  曾因其 undefined 导致 toggle 暂存出空 type → 重开 addPanel('') 报错+白屏)。 */
function panelType(p: IDockviewPanel): string {
  const t = ((p.params ?? {}) as PanelMeta).__type
  return t || (p as { component?: string }).component || ''
}

/** 视图自己 setTitle 过的面板(会话名、笔记名……):按语言重取默认名时跳过它们。不落盘 —— 重载后视图挂载时会再 setTitle。 */
const selfTitled = new Set<string>()
export function markSelfTitled(id: string): void { selfTitled.add(id) }
/** 没被视图改过名的面板,标题按当前语言重取 displayName(W-10)。标题是建面板那一刻快照进布局的:
 *  切了语言、或拿旧语言存下的布局重载后,「主页」这类静态名会一直停在旧语言。宿主在语言变更时调;
 *  布局还原(fromJSON)之后引擎自己调。 */
export function retitleDefaultPanels(api: DockviewApi | null = useWorkspace.getState().api): void {
  if (!api) return
  for (const p of api.panels) {
    if (selfTitled.has(p.id)) continue
    const def = getView(panelType(p))
    if (!def) continue
    const title = label(def.displayName)
    if (p.title !== title) p.api.setTitle(title)
  }
  useWorkspace.getState().refreshTabs()
}

/** 把一个 Dockview panel 包装为引擎 Leaf。 */
function makeLeaf(panel: IDockviewPanel): Leaf {
  const raw = (panel.params ?? {}) as Record<string, unknown>
  const { __loc, __type, ...userParams } = raw as PanelMeta & Record<string, unknown>
  void __type
  return {
    id: panel.id,
    type: panelType(panel),
    loc: __loc ?? 'main',
    params: userParams,
    setTitle: (t) => { selfTitled.add(panel.id); panel.api.setTitle(t) },
    // params 是布局的一部分(重建视图就靠它),改完必须记账 —— Dockview 的 onDidLayoutChange
    // 只认结构变化,不认参数变化,不主动存就会在下次结构事件前被旧快照覆盖(如「钉住会话」重启后又变回跟随档)。
    // ⚠️ 必须连 refreshTabs 一起发:视图**就地换自己指向的文件**(编辑器认领新笔记、阅读器换 PDF)
    //    走的就是这条,不刷 mainTabs 的话订阅方看不见这次跳转 → 前进后退不记账(2026-08-20 实报)。
    setParams: (p) => {
      panel.api.updateParameters({ ...(panel.params ?? {}), ...p })
      useWorkspace.getState().refreshTabs()
      scheduleWorkspaceSave()
    },
    // 走 closeLeaf 而不是裸 panel.api.close():各区的收尾(主区最后一个 → home、侧栏补占位…)与固定 View 的守卫
    // 都在那里;单列 store 的 leaf.close 一直如此。
    close: () => useWorkspace.getState().closeLeaf(panel.id),
  }
}

function panelsAt(api: DockviewApi, loc: ViewLocation): IDockviewPanel[] {
  return api.panels.filter((p) => ((p.params ?? {}) as PanelMeta).__loc === loc)
}

const locOfPanel = (p: IDockviewPanel): ViewLocation => ((p.params ?? {}) as PanelMeta).__loc ?? 'main'
const panelRefs = (api: DockviewApi): PanelRef[] => api.panels.map((p) => ({ loc: locOfPanel(p), type: panelType(p) }))

/** 固定 View 里「区内最后一个」:关不掉、拖不出本区、不被别的类型顶掉(判定见 pinnedViews.ts)。 */
function guarded(api: DockviewApi, panel: IDockviewPanel): boolean {
  return isLastPinned(useWorkspace.getState().pinned, panelRefs(api), locOfPanel(panel), panelType(panel))
}

/** 落点可不可以落:固定 View 不许跨区(区内排序、分屏照常)。提示层与提交层共用,拖动中就不给假落点。 */
export function dropAllowed(api: DockviewApi, panelId: string, target: DropTarget): boolean {
  const panel = api.getPanel(panelId)
  return !panel || locOf(target.group) === locOfPanel(panel) || !guarded(api, panel)
}

/** 主区新标签,开在 beside 那一组(openView 的 newTab 落在第一个主区组,分屏时会跑到另一半屏)。 */
function openTabBeside(api: DockviewApi, beside: IDockviewPanel, type: string, params: Record<string, unknown>): Leaf {
  const def = getView(type)
  const panel = api.addPanel({
    id: def?.singleton && !api.getPanel(type) ? type : nextId(api, type),
    component: '__frame',
    title: def ? label(def.displayName) : type,
    params: { ...params, __loc: 'main', __type: type },
    position: { referencePanel: beside.id, direction: 'within' } as never,
  })
  if (type === 'chat') useWorkspace.setState({ focusedChatLeafId: panel.id })
  scheduleWorkspaceSave()
  return makeLeaf(panel)
}

/** 就地把 panel 换成另一种视图(navigateLeaf 的本体,不带固定守卫)。旧视图参数全清,不残留。 */
function swapLeaf(api: DockviewApi, panel: IDockviewPanel, type: string, params: Record<string, unknown>): Leaf | null {
  const def = getView(type)
  if (!def) return null
  const { focusedChatLeafId, refreshTabs } = useWorkspace.getState()
  const old = (panel.params ?? {}) as PanelMeta & Record<string, unknown>
  const sameType = panelType(panel) === type
  // dockview updateParameters 是 merge 语义,但值为 undefined 的键会被显式删除(dockviewPanel.update)
  // → 旧视图参数全部映射为 undefined,防 followActive/reuseKey 之类残留污染新视图。
  const cleared: Record<string, unknown> = {}
  for (const k of Object.keys(old)) cleared[k] = undefined
  panel.api.updateParameters({ ...cleared, ...params, __loc: old.__loc ?? 'main', __type: type })
  selfTitled.delete(panel.id) // 换成的新视图还没自己改过名(Codex r3a-2)
  panel.api.setTitle(label(def.displayName))
  panel.api.setActive()
  // 就地切换不触发 onDidActivePanelChange(panel 未变)→ 自补簿记。
  if (type === 'chat') useWorkspace.setState({ focusedChatLeafId: panel.id })
  else if (!sameType && focusedChatLeafId === panel.id) {
    // 本 leaf 从 chat 切走 → 焦点会话 leaf 移交给其他 chat panel(无则清空,右栏目录等显示空态)。
    const otherChat = panelsAt(api, 'main').find((p) => p.id !== panel.id && panelType(p) === 'chat')
    useWorkspace.setState({ focusedChatLeafId: otherChat?.id ?? null })
  }
  refreshTabs()
  scheduleWorkspaceSave()
  return makeLeaf(panel)
}

/** 最后一次作为全局 activePanel 出现的主区 panel 所在的**组**(refreshTabs 维护,换布局清空)。
 *  记组不记 panel:侧栏聚焦期间关掉那张标签,同组顶上来的照样认得;拖放后 refreshTabs 会重记(Codex 复审)。 */
let lastMainGroupId: string | null = null

/** 主区「当前显示」的 panel:全局 activePanel 若在主区用它;否则(焦点在侧栏,如点了侧栏自己的标签头)
 *  取主区组内的 activePanel,优先**最后聚焦的那一组** —— 分屏时不认它就回落成 panels 里第一组(左组),
 *  树行高亮 / 箭头落到另一半屏(09-16 Codex 评审)。就地导航/前进后退都以它为作用对象。 */
export function activeMainPanel(api: DockviewApi): IDockviewPanel | null {
  const mains = panelsAt(api, 'main')
  const global = api.activePanel
  if (global && mains.some((p) => p.id === global.id)) return global
  const groupOf = (p: IDockviewPanel) => (p as { group?: { id?: string; activePanel?: { id?: string } } }).group
  const fronts = mains.filter((p) => groupOf(p)?.activePanel?.id === p.id)
  return fronts.find((p) => groupOf(p)?.id === lastMainGroupId) ?? fronts[0] ?? mains[0] ?? null
}

/** New shell groups start at the outer edge, then alignRegions places them around the entire
 * Main subtree. Referencing a Main leaf here would cut a sidebar into that one split. */
function positionFor(api: DockviewApi, loc: ViewLocation): Record<string, unknown> | undefined {
  const sameLoc = panelsAt(api, loc)
  if (sameLoc.length) return { referencePanel: sameLoc[0].id, direction: 'within' }
  if (loc === 'main') return undefined // 首个主区 panel
  const parked = loc === 'bottom' ? parkedBottom(api) : undefined
  if (parked) {
    // 开回收起时藏着的那个组:不新建组 = 网格不收支 = 主区不重挂。先亮出来再开 panel,视图挂载时量得到尺寸。
    try {
      parked.api.setVisible(true)
      if (!sidebarAnimating.bottom) parked.api.setConstraints({ minimumHeight: DV_GROUP_MIN }) // 补间期由补间自己管 min
    } catch { /* 跨版本兜底 */ }
    return { referenceGroup: parked.id, direction: 'within' }
  }
  return { direction: loc === 'bottom' ? 'below' : loc }
}

type Group = IDockviewPanel['group']

/** 收起后藏在网格里的空底部组(见 parkBottom)。桩 api 没有 groups → 恒无。 */
function parkedBottom(api: DockviewApi): Group | undefined {
  return api.groups?.find((g) => g.panels.length === 0 && g.api.isVisible === false)
}

/** 关 panel 但留下空组。panel.api.close() 关掉组里最后一个 = Dockview 连组一起删。
 *  ponytail: 走 DockviewComponent 私有的 removePanel 选项,钉在 dockview 7.x;没了它就退回 close()
 *  (行为退回「开合重挂主区」,不坏)。正路是迁到 dockview 的 edge group / shell。 */
function closeKeepingGroup(api: DockviewApi, panel: IDockviewPanel): void {
  const component = (api as unknown as { component?: { removePanel?: (p: IDockviewPanel, o: { removeEmptyGroup: boolean }) => void } }).component
  if (component?.removePanel) component.removePanel(panel, { removeEmptyGroup: false })
  else panel.api.close()
}

/** 收起底部面板:关掉内容,但把组**留在网格里藏起来**(setVisible(false) 只把这一格缩成 0,不动树)。
 *  删组会让 Dockview 归一化网格(主区那一列的 branch 少一个孩子)→ 主区整列 DOM 摘下重挂 → 里面每个 iframe
 *  重载:PDF / 预览 / 插件舞台黑一下、帧内状态全丢(2026-10-02 Video Studio 实测每次 ⌘J 黑 0.15–0.6s)。
 *  内容照旧进 stash、panel 照旧销毁 —— 空组没有 panel,panelsAt / syncPanelState / 信封的「可见」口径一概不变。
 *  下次展开由 positionFor 开回这个组。同在底部的其它组(用户左右分过屏)照常删:它们的兄弟只是底部那一支。 */
function parkBottom(api: DockviewApi, group: Group, panels: IDockviewPanel[]): void {
  for (const p of panels) {
    try { if (p.group === group) closeKeepingGroup(api, p); else p.api.close() } catch { /* 已经不在了 */ }
  }
  if (!api.groups?.includes(group) || group.panels.length) return // 组已被删(补间途中 × 掉了最后一个)/ 没关干净
  try {
    // 焦点别停在看不见的空组上。⚠️激活**组**不激活 panel:panel.api.setActive() 会让 Dockview 把它的内容
    // 摘下再挂回(renderPanel),帧照样重载 —— 实测这一句就是修完还剩的那一次重挂。
    if (api.activeGroup === group) activeMainPanel(api)?.group.api.setActive()
    group.api.setVisible(false)
  } catch { /* 跨版本兜底 */ }
}

/** Repair region boundaries without reloading any View. The snapshot before insertion keeps
 * Main proportions intact; the same path also heals old persisted, interleaved layouts. */
function alignRegions(api: DockviewApi, before?: RegionTree | null): void {
  const snapshot = before ?? captureRegionTree(api)
  const restore = preserveAcrossRestructure()
  pinSides(api)
  try {
    alignWorkspaceRegions(api, snapshot, useWorkspace.getState().bottomSpan)
    if (panelsAt(api, 'bottom').length) settleBottomHeight(api)
    setTimeout(() => {
      if (useWorkspace.getState().api === api && !Object.values(sidebarAnimating).some(Boolean)) restoreRegionProportions(api, snapshot)
    }, 80)
  } finally { restore() }
}

type Stashed = PersistedPanel

/** onReady 还原出来的那份布局自带的归属(信封里的 space)。只在一种情形下与画像键不同:「上次退出」档 × 纯内置视图的
 *  用户 Space —— 布局还原成了,活动 id 却还是内存里的回落 Space(它的配方异步装载)。此时屏上是**它**的现场,存盘得
 *  继续记在它名下;画像一重设(补定位 / 切 Space)或布局被重建成默认,就回到「画像键说了算」。
 *  三态:undefined = 屏上不是启动还原出来的那份 → 归画像键;string = 还原出来的那份自带的归属;
 *  null = 还原的是老存档(没记归属)→ **不知道**:存盘也不写,一切照升级前(信「上次退出」的活动 id)。不在这里替它
 *  推定一个 —— 推定值得靠一次写盘传过来,写盘失败(配额满)时就成了「归画像键」,补定位会拿旧归档盖掉屏上更新的现场。 */
let restoredOwner: string | null | undefined
/** 屏上这份布局是给哪个 Space 摆的(= 存盘时写进信封的归属)。null = 不知道(老存档,或还没有任何 Space 画像)。 */
export const liveLayoutOwner = (): string | null => restoredOwner === undefined ? useWorkspace.getState().sideProfileKey : restoredOwner

function envelope(api: DockviewApi, state: Pick<WorkspaceState, 'leftVisible' | 'rightVisible' | 'stash' | 'sideProfileKey'>): LayoutEnvelopeV4 {
  const space = restoredOwner === undefined ? state.sideProfileKey : restoredOwner
  return {
    version: 4,
    ...(space ? { space } : {}),
    dockview: withoutTransientPanels(api.toJSON(), Object.fromEntries(Object.values(extensions).filter((lease) => lease.previousId).map((lease) => [lease.id, lease.previousId!]))),
    sidebars: {
      // 真实 panel 是唯一真源；状态事件可能落后于 Dockview 的异步布局沉降。
      left: { visible: panelsAt(api, 'left').some((p) => panelType(p) !== '__extend'), stash: state.stash.left },
      right: { visible: panelsAt(api, 'right').some((p) => panelType(p) !== '__extend'), stash: state.stash.right },
      bottom: { visible: panelsAt(api, 'bottom').some((p) => panelType(p) !== '__extend'), stash: state.stash.bottom },
    },
  }
}

/** resetLayout 的撤销快照(一次性)。profile = 拍快照时的 Space 画像键(sideProfileKey),api = 当时的 Dockview 实例;
 *  shape = 重置刚完成时的布局结构指纹(layoutShape),metrics = 尺寸 / 排列指纹(layoutMetrics,不含侧栏宽度),
 *  settleUntil = 重置自身的布局沉降窗口(这段里的回调只刷新 metrics 基线,不判作废),dismiss = 收回那条「撤销」提示。 */
let layoutUndo: {
  env: LayoutEnvelopeV4; api: DockviewApi; profile: string | null; owner: typeof restoredOwner; stashActive: WorkspaceState['stashActive']
  shape: string; metrics: LayoutMetrics; settleUntil: number; dismiss?: () => void
} | null = null
/** 重置后多久内的布局回调算「重置自己在沉降」(默认布局建完后 Dockview 异步派发的那批 + 双 raf 钉侧栏宽)。 */
const RESET_SETTLE_MS = 600
/** 撤销快照是否仍对应当前布局:结构一致,且(沉降窗口过后)尺寸 / 排列在容差内一致。 */
function undoStillMatches(u: NonNullable<typeof layoutUndo>, api: DockviewApi): boolean {
  if (u.api !== api || layoutShape(api) !== u.shape) return false
  return Date.now() < u.settleUntil || sameLayoutMetrics(layoutMetrics(api), u.metrics)
}

/** 布局结构指纹:每个组里有哪些面板(id,按组内顺序)。不含尺寸(尺寸 / 排列另由 layoutMetrics 管,且不含侧栏宽度);
 *  新开 / 关掉标签、分屏、挪组都会变。重置后用它判断用户是否已在默认布局上动过手(Codex 第一轮 C-1)。 */
function layoutShape(api: DockviewApi): string {
  try { return api.groups.map((g) => g.panels.map((p) => p.id).join(',')).join('|') } catch { return '' }
}

/** 作废撤销快照,并收回还挂着的「撤销」提示(免得留一个点了没反应的按钮)。 */
function dropLayoutUndo(): void {
  const u = layoutUndo
  layoutUndo = null
  try { u?.dismiss?.() } catch { /* 宿主收回失败不影响作废 */ }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleWorkspaceSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    useWorkspace.getState().saveCurrent()
  }, 100)
}

/** 主区 leaf 的轻量快照,供顶栏内嵌标签条渲染(Obsidian 式单行标签)。 */
export interface MainTab {
  id: string
  type: string
  title: string
  active: boolean
  closable: boolean
  sessionId?: string
  followActive: boolean
  /** 这个 tab 承载的文件(笔记 notePath / 工作区文件 path);无文件的视图(启动器、日历…)为 undefined。
   *  「主区当前打开的是哪个文件」全靠它对外传导(侧栏对话的默认引用等)。
   *  (2026-08-20 起就地换文件也发 refreshTabs —— 见 setParams 与 sig。) */
  filePath?: string
  /** 本组内的**前台** tab(组自己的 activePanel)。`active` 比的是跨三区唯一的 api.activePanel ——
   *  焦点一旦落在侧栏,主区就一个 active 都没有;要问「主区现在显示的是哪个」只能看这个。 */
  front: boolean
  /** 这个 tab 现在指着哪个对象(所有 *Path / sessionId 类参数的指纹)。**只用来比对**:
   *  「同一个 tab 里换一个文件」(A.pdf → B.pdf、笔记 → PDF → 笔记)是纯参数变化,不进比对的话
   *  mainTabs 引用不变 → 订阅方(导航历史/最近使用)整片看不见,前进后退于是「无法识别」
   *  (2026-08-20 用户实报)。 */
  sig: string
}

/** 侧栏视图的轻量快照,供顶栏两侧的视图图标渲染。收起态也列(从 stash),点击可重开。 */
export interface SideTab {
  type: string
  title: string
  active: boolean
  closable: boolean
}

interface WorkspaceState {
  api: DockviewApi | null
  /** 最近聚焦的 Chat leaf；点击右栏 tab 时仍保持其上下文。 */
  focusedChatLeafId: string | null
  /** 主区打开的 leaf(顶栏标签条用);随布局/激活变化刷新。 */
  mainTabs: MainTab[]
  /** 左右侧栏的视图图标(顶栏两侧用);收起态从 stash 取。 */
  leftTabs: SideTab[]
  rightTabs: SideTab[]
  /** Chat DOM 只登记在 workspace 引擎，不进入业务 app state。 */
  chatSurfaces: Record<string, HTMLDivElement>
  leftVisible: boolean
  rightVisible: boolean
  /** 底部面板是否展开(主区下方那一条;≈ VS Code 的 Panel)。 */
  bottomVisible: boolean
  /** 收起侧栏/底部面板时暂存其内容,展开时还原。 */
  stash: Record<DockSide, Stashed[]>
  /** 收起时记住的活动 tab 类型,展开后据此还原选中(否则按 openView 顺序落到最后一个)。 */
  stashActive: Record<DockSide, string | null>
  /** 各区默认内容。bottom 恒 [] ——「通用停靠区,默认空」,展开无内容即空占位;
   *  真有 Space 要给底部预置视图时再给 SpaceDefinition 加 bottom 字段(现在加 = 零消费者的投机抽象)。 */
  sidebarDefaults: Record<DockSide, Stashed[]>
  /** 默认布局构建器(WorkspaceHost 从 buildDefault prop 注入,供 resetLayout 复用)。 */
  defaultBuilder: (() => void) | null
  /** 可自由拖宽 + 持久化的侧栏。**2026-08-14 起默认两侧全开**(用户要求「拖过就常驻」);
   *  SpaceDefinition.resizableSides 从「开哪侧」变成「关哪侧」(显式 false 才钉黄金分割)。 */
  sideFree: Record<'left' | 'right', boolean>
  /** 记住的侧栏宽度(仅 sideFree 侧生效;null=用「黄金分割 × sideScale」默认宽)。按当前 Space 从 localStorage 载。
   *  bottom 存的是**高**(恒生效,底部无 free 开关)。 */
  sideWidths: Record<DockSide, number | null>
  /** 各侧「首次无记录」默认宽相对黄金分割的系数(= 当前 Space 的 sideDefaultScale;缺省 1)。 */
  sideScale: Record<'left' | 'right', number>
  /** 当前宽度持久化归属键(= 活动 Space id);切 Space 时重载对应记忆。 */
  sideProfileKey: string | null
  /** 底部面板横跨哪几列(= 当前 Space 的 bottomSpan;缺省 'right')。alignRegions 按它摆壳拓扑。 */
  bottomSpan: BottomSpan
  /** 当前 Space 的固定 View(= SpaceDefinition.pinned;判定见 pinnedViews.ts)。随 Space 画像一起载入,卫星窗恒空。 */
  pinned: PinnedViews
  setPinned(pins: PinnedViews | undefined): void
  /** 该 leaf 是不是固定 View 里「区内最后一个」(关不掉 / 拖不出本区 / 不被别的类型顶掉)。 */
  isPinnedLeaf(id: string): boolean
  /** 当前 Space 的固定 View 缺了就补(切 Space 还原出已存布局之后调)。收起的侧栏只补进暂存,不替用户展开。 */
  ensurePinned(): void
  setApi(api: DockviewApi | null): void
  setDefaultBuilder(fn: () => void): void
  setSidebarDefaults(defaults: SidebarDefaults): void
  /** 设置「可自由拖宽」侧栏画像(切 Space 时调):载入该 Space 记住的宽度。
   *  free 缺省 = true(两侧都记宽);只有显式传 false 的那侧才回到「钉黄金分割」。 */
  setSideProfile(key: string, free: { left?: boolean; right?: boolean }, scale?: { left?: number; right?: number }, bottomSpan?: BottomSpan): void
  initializeSidebar(side: DockSide, visible: boolean): void
  setFocusedLeaf(panel: IDockviewPanel | null | undefined): void
  registerChatSurface(leafId: string, el: HTMLDivElement | null): void
  syncPanelState(): void
  /** 重算主区标签条 + 两侧侧栏图标(布局/激活变化时调)。 */
  refreshTabs(): void
  /** 没被视图改过名的面板按当前语言重取标题(W-10);宿主在语言变更时调。单列 store 没有它,调用方用 `?.()`。 */
  retitleDefaults(): void
  /** 按当前 bottomSpan 重摆壳拓扑。切 Space 的 applyNamed / resetLayout 自带;只有冷启动「活动 Space 晚于
   *  布局还原才定下」(异步注册的插件 / 用户 Space)要补调。单列 store 没有它,调用方用 `?.()`。 */
  realignRegions(): void
  /** 顶栏标签点击 → 激活该 leaf。 */
  activateLeaf(id: string): void
  /** 顶栏标签关闭。固定 View(区内最后一个)关不掉;force = 清场路径(视图注销 / 指向的文件已删)放行。 */
  closeLeaf(id: string, force?: boolean): void
  /** 受控拖放落子:把 panelId 视图按 computeDropTarget 的结果并入/分屏到目标组,并继承目标面板身份(__loc)。 */
  dropView(panelId: string, target: DropTarget): void
  /** 顶栏侧栏图标点击 → 展开该侧(若收起)并显示该视图。 */
  showSideView(side: DockSide, type: string): void
  /** 关闭某侧的某视图(右键菜单)。**一次只关该侧第一个匹配** —— 要清场请用 closeViewsOfType。 */
  closeSideView(side: DockSide, type: string): void
  /** 关掉**所有区**里该类型的全部实例(反注册插件/内置视图前的清场)。
   *  调用方从前是各自 `mainTabs + closeSideView('left') + closeSideView('right')` 手写一遍 —— 加了
   *  bottom 之后那种写法会漏掉停在底部的实例:视图被 unregisterView 之后 panel 还活着(cleanup 不跑、
   *  插件 UI 继续存活),且这个已不存在的类型会留在持久化布局里 → 下次启动 layoutViewsAllRegistered
   *  判定失败,**整份布局被丢弃回默认**。清场必须以 api.panels 为准,不能按位置手写枚举。
   *  force = 视图要注销了,固定 View 也一并关掉;不传(插件自己的 ctx.closeView)则留下区内最后一个固定的。 */
  closeViewsOfType(type: string, force?: boolean): void
  /** 把该类型的全部实例**原地**换成另一个视图(2026-10-02,插件 `ctx.replaceView` 的引擎半身;Coding 进出项目
   *  换左栏的同一件事):主区活 panel 走 navigateLeaf(__frame 宿主按 __type 重挂内层);侧栏 / 底部的活 panel
   *  是按类型的组件,改 __type 换不掉 → 在原位旁开一个新的再摘掉旧的(同组同位,组不空、零结构变化,所以
   *  不会重挂主区那一列,列里的 iframe 不重载);收起侧栏 stash 里的条目一并换,该侧**保持收起**(不替用户把面板弹出来);当前 Space 的
   *  sidebarDefaults 同步换(否则关空再展开回到旧视图)。活动 panel 还给原主人 —— 换一个侧栏视图不该把
   *  焦点从主区抢走。返回换掉的实例数(活的 + stash 里的);`to` 没注册则什么都不动、返回 0。
   *  `from` 是固定 View(区内最后一个)时不顶掉它:`to` 作为新标签开在它旁边(收起的侧栏则排进 stash,照旧
   *  保持收起),`from` 原先在前台就让 `to` 顶到前台;计数只算新开出来的 —— `to` 已经在那儿就是 0。 */
  replaceViewsOfType(from: string, to: string, params?: Record<string, unknown>): number
  /** 按参数改写 / 关掉 leaf,**含没挂载的**:折叠侧栏序列化进 stash 的条目(无 id → 就地改写或摘掉)。
   *  fn 返回 undefined = 不动;null = 关掉(走 closeLeaf 的收尾,不是裸 panel.api.close());对象 = 合并进参数。
   *  引擎不懂参数语义,改哪个键由调用方定(文件改名 / 删除跟随见 frontend views/followPathGone.ts)。 */
  remapLeaves(fn: (type: string, params: Record<string, unknown>) => Record<string, unknown> | null | undefined): void
  /** 恢复默认布局:清空 → 重建默认(黄金分割 中 0.618 / 两侧各 0.191)→ 清持久化。
   *  undoable = **用户亲手点的**(右上角钮 / 命令 / 设置):拍快照并弹「撤销」。自动路径(进一个没存档的 Space、
   *  用户 Space 重建…)不传 —— 那时 Dockview 里还是**上一个 Space** 的布局,给撤销就会把它灌进新 Space。 */
  resetLayout(opts?: { undoable?: boolean }): void
  /** 撤销最近一次 resetLayout(还原清空前的标签、分屏与侧栏开合)。快照一次性,换 Space / 换 api /
   *  应用命名布局后作废。还原成功 true。 */
  undoResetLayout(): boolean
  /** 布局变更回调(WorkspaceHost 的 onDidLayoutChange 调):重置之后用户第一次动了布局结构(新开标签、分屏…),
   *  撤销快照即作废 —— 否则再点仍挂着的「撤销」会把重置前的快照整份灌回,新开的标签连同未存的界面状态一起丢。 */
  noteLayoutChange(): void
  /** 整份应用一个布局信封(applyNamed 与撤销共用)。成功 true;损坏 false。 */
  applyLayout(blob: LayoutEnvelopeV4): boolean
  /** 按当前容器宽把两侧栏重钉回目标宽(容器 resize 后调,补 dockview 不自动重算黄金分割的缺口)。 */
  repinSides(): void
  /** 开/聚焦一个视图。singleton 已存在则聚焦(**除非显式 newTab**——那是「我明确要再来一个」,
   *  见下方 singleton 分支上的注释);主区默认**就地替换**当前活动 leaf(浏览器/Obsidian 式,
   *  opts.newTab 显式新建);侧栏同侧同类型复用。返回 leaf。 */
  openView(type: string, params?: Record<string, unknown>, loc?: ViewLocation, opts?: { newTab?: boolean }): Leaf | null
  /** 就地把某 leaf 切换为另一视图类型(同 tab 内导航的原语)。旧视图参数全清,不残留。 */
  navigateLeaf(leafId: string, type: string, params?: Record<string, unknown>): Leaf | null
  getActiveLeaf(): Leaf | null
  /** 按 id 取 leaf(含 params)。store 形状无关的参数读法——移动单列壳 api 恒 null,getPanel 不可用。 */
  leafById(id: string): Leaf | null
  /** 把当前活动视图分屏到一侧(同 type+params 复制一份)。 */
  splitActive(direction: 'right' | 'down', paramsOverride?: Record<string, unknown>): Leaf | null
  /** 折叠/展开一个区。左右量宽、bottom 量高;收起前暂存内容,展开时还原。 */
  toggleSidebar(side: DockSide): void
  saveCurrent(): void
  saveNamed(name: string): void
  /** 应用命名布局。成功 true;缺失/损坏返回 false(调用方可回退 resetLayout)。 */
  applyNamed(name: string): boolean
  namedLayouts(): string[]
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  api: null,
  focusedChatLeafId: null,
  mainTabs: [],
  leftTabs: [],
  rightTabs: [],
  chatSurfaces: {},
  leftVisible: true,
  rightVisible: true,
  bottomVisible: false, // 底部面板默认收起(用户按需展开,同 VS Code)
  stash: { left: [], right: [], bottom: [] },
  stashActive: { left: null, right: null, bottom: null },
  sidebarDefaults: { left: [], right: [], bottom: [] },
  defaultBuilder: null,
  sideFree: { left: false, right: false },
  sideWidths: { left: null, right: null, bottom: null },
  sideScale: { left: 1, right: 1 },
  sideProfileKey: null,
  bottomSpan: 'right',
  pinned: {},

  setApi: (api) => {
    // 面板关掉后 id 会被 nextId 复用:别让新面板继承旧面板「自己改过名」的标记(Codex r3a-2)
    api?.onDidRemovePanel?.((p) => selfTitled.delete(p.id))
    set({ api })
  },
  setDefaultBuilder: (fn) => set({ defaultBuilder: fn }),
  // bottom 显式兜底成 []:不能写 `{ bottom: [], ...defaults }` —— 若调用方带了 `bottom: undefined`
  // 这个**存在但为 undefined** 的键,展开时 `sidebarDefaults[side].filter` 会当场炸。
  setSidebarDefaults: (defaults) => set({ sidebarDefaults: { left: defaults.left, right: defaults.right, bottom: defaults.bottom ?? [] } }),
  setSideProfile: (key, free, scale, bottomSpan) => {
    let widths: Record<DockSide, number | null> = { left: null, right: null, bottom: null }
    try {
      // v1 key(lcl.sideWidth.)被「布局变更即记宽」污染过:×1.2 时代把系统钉的 336 当用户记忆存了。
      // 升版丢弃 = 全员回默认一次(golden × sideDefaultScale),真拖过的用户重拖一次即可。
      localStorage.removeItem(`lcl.sideWidth.${key}`)
      const raw = localStorage.getItem(`lcl.sideWidth2.${key}`)
      // 底部高读 bottomH。旧字段 bottom 弃读:直接开在底部的视图把 Dockview 的出生高(~50%)当成用户拖的记了进去
      // (见 bottomSettling),记录里分不出哪些是真拖的 —— 回默认一次(32%),真拖过的重拖一次即可;左右宽不受影响。
      if (raw) { const p = JSON.parse(raw) as Record<string, unknown>; widths = { left: typeof p.left === 'number' ? p.left : null, right: typeof p.right === 'number' ? p.right : null, bottom: typeof p.bottomH === 'number' ? p.bottomH : null } }
    } catch { /* private mode */ }
    // 缺省 true:此前只有声明了 resizableSides 的那侧记宽,其余一律被 pinSides 钉回黄金分割 ——
    // 用户拖完、一折一开就打回原形(实报)。现在两侧默认都记,显式 false 才钉。
    // ⚠️ 一并清 stashActive:它是全局单份、只在「折叠某侧」时写。不清的话,在 A 空间折叠右栏(记下
    // outline)→ 切到 B 空间首次展开右栏,会拿 A 的 outline 顶掉 B 配方的默认首项(B 里也有 outline
    // 就更隐蔽)。stash 本身在 applyNamed/resetLayout 已重置,这条是它漏下的那半。
    restoredOwner = undefined // 画像重设 = 屏上的布局从此归这个 Space(调用方紧接着还原 / 重建 / 认领它)
    set({
      sideProfileKey: key,
      sideFree: { left: free.left !== false, right: free.right !== false },
      sideWidths: widths,
      sideScale: { left: scale?.left ?? 1, right: scale?.right ?? 1 },
      bottomSpan: bottomSpan ?? 'right',
      stashActive: { left: null, right: null, bottom: null },
    })
  },
  initializeSidebar: (side, visible) => set((s) => ({
    [visKeyOf(side)]: visible,
    stash: visible ? s.stash : { ...s.stash, [side]: s.sidebarDefaults[side] },
  } as Partial<WorkspaceState>)),
  setFocusedLeaf: (panel) => {
    if (panel && panelType(panel) === 'chat') set({ focusedChatLeafId: panel.id })
  },
  registerChatSurface: (leafId, el) => set((s) => {
    const next = { ...s.chatSurfaces }
    if (el) next[leafId] = el
    else delete next[leafId]
    return { chatSurfaces: next }
  }),
  syncPanelState: () => {
    const api = get().api
    if (!api) return
    const leftVisible = panelsAt(api, 'left').length > 0
    const rightVisible = panelsAt(api, 'right').length > 0
    // 底部没有占位兜底(关掉最后一个视图 = 关掉面板),故它的可见态更依赖这条同步 —— 折叠钮的亮/灭全看它。
    const bottomVisible = panelsAt(api, 'bottom').length > 0
    if (leftVisible !== get().leftVisible || rightVisible !== get().rightVisible || bottomVisible !== get().bottomVisible) {
      set({ leftVisible, rightVisible, bottomVisible })
    }
  },

  retitleDefaults: () => retitleDefaultPanels(get().api),
  realignRegions: () => { const api = get().api; if (api) alignRegions(api) },
  setPinned: (pins) => { set({ pinned: pins ?? {} }); get().refreshTabs() }, // 标签的可关态跟着换
  isPinnedLeaf: (id) => {
    const api = get().api
    const panel = api?.getPanel(id)
    return !!api && !!panel && guarded(api, panel)
  },
  ensurePinned: () => {
    const api = get().api
    if (!api) return
    // 收起着的侧栏:暂存里有就算在(暂存空 → 展开时回落 sidebarDefaults,同 toggleSidebar)。
    const refs = panelRefs(api)
    const stashOf = (side: 'left' | 'right'): Stashed[] => (get().stash[side].length ? get().stash[side] : get().sidebarDefaults[side])
    for (const side of ['left', 'right'] as const) {
      if (!panelsAt(api, side).length) for (const v of stashOf(side)) refs.push({ loc: side, type: v.type })
    }
    const missing = missingPinned(get().pinned, refs, (t) => !!getView(t))
    if (!missing.length) return
    for (const pin of missing) {
      const here = panelsAt(api, pin.loc)
      if (pin.loc !== 'main' && !here.length) { // 收起着:只补进暂存,不替用户把面板弹出来
        const side = pin.loc
        set((s) => ({ stash: { ...s.stash, [side]: [{ type: pin.type, params: pin.params }, ...stashOf(side)] } }))
        continue
      }
      // 主区只剩空态占位 → 就地换成它,不在占位旁边再开一个
      if (here.length === 1 && panelType(here[0]) === 'home') { swapLeaf(api, here[0], pin.type, pin.params); continue }
      const def = getView(pin.type)!
      // 排到组首、不抢焦点(inactive):用户此刻在看的标签不动。
      api.addPanel({
        id: def.singleton && !api.getPanel(pin.type) ? pin.type : nextId(api, pin.type),
        component: pin.loc === 'main' ? '__frame' : pin.type,
        title: label(def.displayName),
        params: { ...pin.params, __loc: pin.loc, __type: pin.type },
        position: (here.length ? { referencePanel: here[0], index: 0 } : positionFor(api, pin.loc)) as never,
        inactive: here.length > 0,
      })
      here.filter((p) => panelType(p) === 'sidebar-empty').forEach((p) => p.api.close()) // 占位退位
    }
    get().refreshTabs()
    scheduleWorkspaceSave()
  },
  refreshTabs: () => {
    const api = get().api
    if (!api) { if (get().mainTabs.length) set({ mainTabs: [] }); return }
    const activeId = api.activePanel?.id
    if (api.activePanel && ((api.activePanel.params ?? {}) as PanelMeta).__loc === 'main') {
      lastMainGroupId = (api.activePanel as { group?: { id?: string } }).group?.id ?? null
    }
    const pins = get().pinned
    const refs = panelRefs(api)
    const tabs: MainTab[] = panelsAt(api, 'main').map((p) => {
      const type = panelType(p)
      const params = (p.params ?? {}) as Record<string, unknown>
      const def = getView(type)
      return {
        id: p.id,
        type,
        title: p.title || (def ? label(def.displayName) : type),
        active: p.id === activeId,
        closable: def?.closable !== false && !isLastPinned(pins, refs, 'main', type),
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        followActive: params.followActive !== false,
        // notePath = Amadeus 编辑器;path = 工作区文件预览(wsfile)。两者都是「这个 tab 是哪个文件」。
        filePath: typeof params.notePath === 'string' ? params.notePath : typeof params.path === 'string' ? params.path : undefined,
        front: (p as { group?: { activePanel?: { id?: string } } }).group?.activePanel?.id === p.id,
        sig: identitySig(params),
      }
    })
    const prev = get().mainTabs
    const same = prev.length === tabs.length && prev.every((t, i) =>
      t.id === tabs[i].id && t.active === tabs[i].active && t.title === tabs[i].title
      && t.filePath === tabs[i].filePath && t.front === tabs[i].front && t.sig === tabs[i].sig && t.closable === tabs[i].closable)
    if (!same) set({ mainTabs: tabs })

    // 两侧侧栏图标:可见时从 live panel(active=组内当前显示),收起时从 stash(无 active)。
    const sideTabsFor = (side: 'left' | 'right'): SideTab[] => {
      const visible = side === 'left' ? get().leftVisible : get().rightVisible
      const mk = (type: string, active: boolean): SideTab => {
        const def = getView(type)
        // 侧栏按类型一个 tab,收起着的(暂存里)同样:固定了就不可关
        const pinnedHere = visible ? isLastPinned(pins, refs, side, type) : isPinned(pins, side, type)
        return { type, title: def ? label(def.displayName) : type, active, closable: def?.closable !== false && !pinnedHere }
      }
      if (visible) {
        return panelsAt(api, side).map((p) => {
          const grp = (p as { group?: { activePanel?: { id?: string } } }).group
          return { ...mk(panelType(p), grp?.activePanel?.id === p.id), title: p.title ?? panelType(p) }
        })
      }
      const stashed = get().stash[side].length ? get().stash[side] : get().sidebarDefaults[side]
      return stashed.map((v) => mk(v.type, false))
    }
    const sideEq = (a: SideTab[], b: SideTab[]): boolean =>
      a.length === b.length && a.every((t, i) => t.type === b[i].type && t.active === b[i].active && t.closable === b[i].closable)
    const left = sideTabsFor('left')
    const right = sideTabsFor('right')
    if (!sideEq(get().leftTabs, left)) set({ leftTabs: left })
    if (!sideEq(get().rightTabs, right)) set({ rightTabs: right })
  },
  activateLeaf: (id) => {
    get().api?.getPanel(id)?.api.setActive()
    get().refreshTabs()
  },
  closeLeaf: (id, force) => {
    const api = get().api
    const panel = api?.getPanel(id)
    if (!api || !panel) return
    if (panelType(panel) === '__extend') {
      const lease = Object.values(extensions).find((entry) => entry?.id === id)
      lease?.dismiss(); lease?.dispose()
      return
    }
    if (panelType(panel) === 'home') return // home 是主区空态占位,不可关(无 close 入口,防御性)
    if (!force && guarded(api, panel)) return // 固定 View:区内最后一个关不掉
    const loc = ((panel.params ?? {}) as PanelMeta).__loc ?? 'main'
    // 主区关掉「最后一个」view → 就地把它变成 home 空态占位(Forsion 品牌图 + 新建),而非
    // close→addPanel。后者会销毁主区组,让侧栏瞬间回流吞掉主区宽再弹回 = 侧栏「被关」+卡顿(本次修复的 bug)。
    // navigateLeaf 复用同一 panel/组,只换 __type → 零组结构变化,侧栏纹丝不动。
    // 分屏 / 多 tab(主区还有别的 panel)走默认 close:Dockview 自动移除空组 = 关掉那个分屏 panel。
    if (loc === 'main' && panelsAt(api, 'main').length <= 1) {
      useNav.getState().drop(id)      // 旧 tab 导航史销毁(panel 复用,仅清栈)
      swapLeaf(api, panel, 'home', {}) // 内部已 refreshTabs;不走 navigateLeaf:force 关固定 View 时不能再被守卫拦成「旁边开个 home」
      return
    }
    // 侧栏关空 → 补「空侧栏」占位(保住 group 作拖放靶;toggleSidebar 折叠不走 closeLeaf,不受影响)。
    const wasLastSide = (loc === 'left' || loc === 'right')
      && panelType(panel) !== 'sidebar-empty' && panelsAt(api, loc).length <= 1
    // 底部面板反过来:关掉最后一个视图 = 关掉整个面板(VS Code 观感,不补占位;Dockview 自动移除空组,
    // syncPanelState 随即把 bottomVisible 翻假)。**stash 必须一并清空** —— 否则「折叠→展开→×关掉→
    // 再折叠→展开」会把用户已经明确关掉的视图从 stash 里复活(左右栏有占位撑着,不会走到这一步)。
    const wasLastBottom = loc === 'bottom' && panelsAt(api, 'bottom').length <= 1
    // 关掉分屏的一半 → 腾出的宽度必须全给剩下的主区。不锁两侧的话 Dockview 按比例摊给所有组:
    // 侧栏被强行拉宽、剩下的主区纹丝不动(用户实报)。180ms 后释放,恢复手动拖宽。
    const release = loc === 'main' ? lockSides(api, ['left', 'right'], true) : () => {}
    // 先关再填:占位可能与被关视图同 type,open-first 会复用到正被关的那个。
    // 底部最后一个 = 收起面板:同 ⌘J 藏组不删组,免主区重挂。
    if (wasLastBottom) parkBottom(api, panel.group, [panel])
    else panel.api.close()
    if (wasLastSide) get().openView('sidebar-empty', {}, loc)
    if (wasLastBottom) set((st) => ({ stash: { ...st.stash, bottom: [] }, stashActive: { ...st.stashActive, bottom: null }, bottomVisible: false }))
    useNav.getState().drop(id) // 该 tab 的导航历史随之销毁
    get().refreshTabs()
    setTimeout(release, 180)
  },
  dropView: (panelId, target) => {
    const api = get().api
    const panel = api?.getPanel(panelId)
    if (!api || !panel) return
    const loc = locOf(target.group) // 目标面板身份 → 落子后视图继承(侧栏=图标 / 主区=tab+标题)
    if (!dropAllowed(api, panelId, target)) return // 固定 View 拖不出本区(提示层已不给落点,这里兜底)
    // 拖出主区要记住源组:moveTo 会同步激活落点组里的它,那一刻 __loc 还是 main → refreshTabs 把落点组
    // 记成「最后的主区组」,下面改完 __loc 再刷也改不回来(Codex 复审)。
    const srcMainGroup = ((panel.params ?? {}) as PanelMeta).__loc === 'main' ? (panel as { group?: { id?: string } }).group?.id ?? null : null
    // 拖动前各侧计数:占位进退判定不能依赖 visible 标志(moveTo 触发的 syncPanelState 可能已翻转它)。
    const sideBefore = { left: panelsAt(api, 'left').length, right: panelsAt(api, 'right').length, bottom: panelsAt(api, 'bottom').length }
    try {
      if (target.mode === 'tab') panel.api.moveTo({ group: target.group, position: 'center', index: target.index })
      else panel.api.moveTo({ group: target.group, position: target.dir }) // 方向 = 面板内分屏并新建组
    } catch { return }
    panel.api.updateParameters({ ...(panel.params ?? {}), __loc: loc })
    if (srcMainGroup && loc !== 'main') lastMainGroupId = srcMainGroup
    // 把最后一个主区 view 拖去侧栏 → 主区空:补 home 空态占位(与关掉最后一个 tab 同观感,不留空白)。
    if (panelsAt(api, 'main').length === 0) get().openView('home', {}, 'main')
    // 侧栏占位进退:某侧被拖空 → 补占位(保住 drop 靶);拖入真实 tab 的一侧若有占位 → 占位退位。
    for (const side of ['left', 'right'] as const) {
      const now = panelsAt(api, side)
      if (sideBefore[side] > 0 && now.length === 0) get().openView('sidebar-empty', {}, side)
      else if (now.length > 1) now.filter((p) => panelType(p) === 'sidebar-empty').forEach((p) => p.api.close())
    }
    // 底部无占位:被拖空 = 面板关闭(同 closeLeaf 的 wasLastBottom,stash 一并清,免复活已关视图)。
    const bottomNow = panelsAt(api, 'bottom')
    if (sideBefore.bottom > 0 && bottomNow.length === 0) set((st) => ({ stash: { ...st.stash, bottom: [] }, stashActive: { ...st.stashActive, bottom: null }, bottomVisible: false }))
    else if (bottomNow.length > 1) bottomNow.filter((p) => panelType(p) === 'sidebar-empty').forEach((p) => p.api.close())
    pinSides(api) // 侧栏可能变动 → 重钉黄金分割宽
    get().refreshTabs()
    scheduleWorkspaceSave()
  },
  showSideView: (side, type) => {
    const api = get().api
    if (!api) return
    const visible = get()[visKeyOf(side)]
    // 已显示该视图时再点 = 收起该侧(开合切换);否则展开(若收起)并激活该视图。
    if (visible) {
      const cur = panelsAt(api, side).find((p) => {
        const grp = (p as { group?: { activePanel?: { id?: string } } }).group
        return grp?.activePanel?.id === p.id
      })
      if (cur && panelType(cur) === type) { get().toggleSidebar(side); get().refreshTabs(); return }
    } else {
      get().toggleSidebar(side) // 展开 → openView 同步还原 stash
    }
    const sidePanels = panelsAt(get().api!, side)
    const target = sidePanels.find((p) => panelType(p) === type)
    if (target) target.api.setActive()
    else {
      // 旧布局 / 被用户关掉过的侧栏 tab 不在 stash 里:点击明确目标时应把它补回来,
      // 与 singleColumnStore 的同名方法对齐。否则命令看似执行,侧栏却只展示别的 tab。
      get().openView(type, {}, side)
      const now = panelsAt(get().api!, side)
      if (now.length > 1) now.filter((p) => panelType(p) === 'sidebar-empty').forEach((p) => p.api.close())
    }
    get().refreshTabs()
  },
  closeSideView: (side, type) => {
    const api = get().api
    if (!api) return
    const hit = panelsAt(api, side).find((p) => panelType(p) === type)
    if (hit && !guarded(api, hit)) hit.api.close()
    get().refreshTabs()
  },

  closeViewsOfType(type, force) {
    const api = get().api
    if (!api) return
    // 先拍下名单再逐个关(close 会就地改 api.panels)。一律走 closeLeaf 而不是 panel.api.close(),
    // 这样各区的收尾语义都对:主区最后一个 → 就地换 home;侧栏最后一个 → 回填占位;底部最后一个 → 连 stash 一起清、面板收起。
    for (const p of api.panels.filter((x) => panelType(x) === type)) get().closeLeaf(p.id, force)
    get().refreshTabs()
  },

  replaceViewsOfType(from, to, params = {}) {
    const api = get().api
    if (!api || from === to || !getView(to)) return 0
    const keep = api.activePanel?.id
    const def = getView(to)!
    let n = 0, side = 0, stole = false, giveBack = true
    const pins = get().pinned
    for (const p of [...api.panels]) {
      if (panelType(p) !== from) continue
      const loc = ((p.params ?? {}) as PanelMeta).__loc ?? 'main'
      const keepFrom = guarded(api, p) // 固定 View 不许被换掉:`to` 开在它旁边,它留着(见 pinnedViews.ts)
      // 固定的那个本身就是活动 panel:`to` 顶上来之后不许再把它激活回去(否则等于没换,Codex 评审复现)
      if (keepFrom && keep === p.id) giveBack = false
      // 「一区一个」:侧栏 / 底部恒如此(openView 同侧同类型复用)。主区多开同类标签是常态、平时一律就地换;只有牵涉
      // 固定 View 才这么算 —— 否则对固定的 A 连换两次得到 [A,B,B],往回换又把 B 变成第二个 A,而不是摘掉它。
      const unique = loc !== 'main' || keepFrom || isPinned(pins, 'main', to)
      if (loc === 'main' && !(unique && panelsAt(api, 'main').some((x) => x !== p && panelType(x) === to))) {
        if (get().navigateLeaf(p.id, to, params)) n++ // 固定的由 navigateLeaf 自己认(同组新标签,不顶掉它)
        continue
      }
      // 侧栏 / 底部挂的是按类型的组件(component = 类型名,见 openView),改 __type 换不掉已经画出来的那个
      // (2026-10-02 真 Electron:返回 1,左栏照旧是旧视图)→ 在原位旁开新的再摘掉旧的:组一直不空,不触发重排。
      const group = p.group as { panels?: IDockviewPanel[]; activePanel?: IDockviewPanel } | undefined
      // 侧栏按类型一个 tab(openView 同侧同类型复用):`to` 已开在这一侧就让它顶上,只摘掉旧的,不开第二个
      const there = panelsAt(api, loc).find((x) => x !== p && panelType(x) === to)
      if (there) {
        if (Object.keys(params).length) there.api.updateParameters({ ...(there.params ?? {}), ...params }) // 调用方给的参数不丢
        if (group?.activePanel === p) { there.api.setActive(); stole = true }
        if (keepFrom) continue
        if (loc === 'main') get().closeLeaf(p.id) // 主区走 closeLeaf:导航史、分屏收尾都在那里
        else api.removePanel(p)
        n++; side++; continue
      }
      const index = group?.panels?.indexOf(p) ?? -1
      api.addPanel({
        id: def.singleton && !api.getPanel(to) ? to : nextId(api, to), component: to, title: label(def.displayName),
        params: { ...params, __loc: loc, __type: to },
        position: { referencePanel: p, ...(index >= 0 ? { index: keepFrom ? index + 1 : index } : {}) },
        inactive: group?.activePanel !== p,
      })
      if (!keepFrom) api.removePanel(p)
      n++; side++
    }
    if (side) { get().refreshTabs(); scheduleWorkspaceSave() }
    // 活动 panel 还给原主人(navigateLeaf / 新开的 panel 抢走了它;被换掉的侧栏 panel 已不在则作罢)。
    // ⚠️已在组里最前的 panel 再 setActive,dockview 7 会重绘它(openPanel → renderPanel 摘下再挂回,iframe 重载;
    // 底部面板修复会话 10-02 用 removeChild 栈抓到)→ 那种只切活动组。
    const back = keep ? api.getPanel(keep) : undefined
    if ((n || stole) && back && giveBack) {
      if ((back.group as { activePanel?: IDockviewPanel } | undefined)?.activePanel === back) back.group.api.setActive()
      else back.api.setActive()
    }
    // 同活 panel 那条:一侧按类型一个 tab —— `to` 已暂存在这一侧就只摘掉被换的、参数并进它,否则侧栏图标会出两个
    const swap = (side: DockSide, list: Stashed[]): Stashed[] => {
      if (isPinned(pins, side, from) || !list.some((v) => v.type === from)) return list // 固定在这一侧的不换(见 beside)
      const kept = list.find((v) => v.type === to)
      if (kept) return list.filter((v) => v.type !== from).map((v) => (v === kept ? { ...v, params: { ...(v.params ?? {}), ...params } } : v))
      const at = list.findIndex((v) => v.type === from)
      return list.filter((v, i) => v.type !== from || i === at).map((v) => (v.type === from ? { type: to, params: { ...params } } : v))
    }
    const { stash, stashActive, sidebarDefaults } = get()
    let stashed = (['left', 'right', 'bottom'] as const).reduce((sum, side) => sum + (isPinned(pins, side, from) ? 0 : stash[side].filter((v) => v.type === from).length), 0)
    // 固定在这一侧(收起着):`to` 排到它后面,它留着。默认项不动 —— 固定的那个关不掉,轮不到按默认项重建。
    const beside = (side: DockSide): Stashed[] => {
      const list = stash[side], at = list.findIndex((v) => v.type === from)
      if (at < 0 || !isPinned(pins, side, from)) return list
      // `to` 已经暂存在这一侧:不再加,但调用方给的参数要并进去(展开着的那条路径也并)
      if (list.some((v) => v.type === to)) return Object.keys(params).length ? list.map((v) => (v.type === to ? { ...v, params: { ...(v.params ?? {}), ...params } } : v)) : list
      stashed++
      return [...list.slice(0, at + 1), { type: to, params: { ...params } }, ...list.slice(at + 1)]
    }
    set({
      stash: { left: swap('left', beside('left')), right: swap('right', beside('right')), bottom: swap('bottom', stash.bottom) },
      stashActive: Object.fromEntries((['left', 'right', 'bottom'] as const).map((side) => [side, stashActive[side] === from ? to : stashActive[side]])) as WorkspaceState['stashActive'],
      sidebarDefaults: { left: swap('left', sidebarDefaults.left), right: swap('right', sidebarDefaults.right), bottom: swap('bottom', sidebarDefaults.bottom) },
    })
    if (stashed) { get().refreshTabs(); scheduleWorkspaceSave() } // 活的那些 navigateLeaf 已各自刷过、存过
    return n + stashed
  },

  remapLeaves(fn) {
    for (const p of [...(get().api?.panels ?? [])]) { // 快照:closeLeaf 会就地改 api.panels
      const { __loc, __type, ...params } = (p.params ?? {}) as PanelMeta & Record<string, unknown>
      void __loc
      void __type
      const next = fn(panelType(p), params)
      if (next === null) get().closeLeaf(p.id, true) // 指向的东西没了:固定 View 也关,下面补一个空白的回来
      else if (next) makeLeaf(p).setParams(next)
    }
    let changed = false
    const stash = Object.fromEntries(Object.entries(get().stash).map(([side, list]) => [side, list.flatMap((v) => {
      const next = fn(v.type, v.params)
      if (next === undefined) return [v]
      changed = true
      return next === null ? [] : [{ ...v, params: { ...v.params, ...next } }]
    })])) as WorkspaceState['stash']
    if (changed) {
      set({ stash })
      get().refreshTabs() // 收起态的侧栏图标从 stash 取
      scheduleWorkspaceSave()
    }
    // 最后才补:暂存里的固定项也可能刚被摘掉(先补的话它那时还在,补完才被删,展开后就没了 —— Codex 评审复现)
    get().ensurePinned()
  },

  resetLayout(opts) {
    const api = get().api
    if (!api) return
    // 清空前拍快照(同存档信封,不含临时扩展视图;另记收起侧栏的「当前项」),给「撤销」用。
    // 只有用户亲手重置才拍;拍不下来就不给撤销,重置照做。自动重置同时作废旧快照。
    let snap: Omit<NonNullable<typeof layoutUndo>, 'shape' | 'metrics' | 'settleUntil' | 'dismiss'> | null = null
    if (opts?.undoable) {
      try { snap = { env: envelope(api, get()), api, profile: get().sideProfileKey, owner: restoredOwner, stashActive: { ...get().stashActive } } } catch { snap = null }
    }
    dropLayoutUndo() // 旧快照(连同它的提示)先作废:自动重置不给撤销,手动重置换一份新的
    dismissExtensions()
    try { api.clear() } catch { /* ignore */ }
    clearLayout()
    restoredOwner = undefined // 默认布局是按当前画像的 Space 建的,不再是启动时还原出来的那份
    useNav.getState().reset() // 布局重建,旧 leaf id 全失效
    lastMainGroupId = null // 组 id 同样会被新布局复用
    set({ stash: { left: [], right: [], bottom: [] }, stashActive: { left: null, right: null, bottom: null }, leftVisible: true, rightVisible: true, bottomVisible: false, focusedChatLeafId: null })
    get().defaultBuilder?.() // 重建默认;openView 的 firstOfSide → sizeSide 按黄金分割钉宽
    scheduleWorkspaceSave()
    if (snap) {
      // 指纹在默认布局同步建完这一刻取:Dockview 的 onDidLayoutChange 是批量异步派发,重置本身引起的那批
      // 回调稍后才到 —— 它们的结构与这里一致,不会误伤撤销;之后真变了才作废。
      const undo: NonNullable<typeof layoutUndo> = { ...snap, shape: layoutShape(api), metrics: layoutMetrics(api), settleUntil: Date.now() + RESET_SETTLE_MS }
      layoutUndo = undo
      const dismiss = ribbonActions.notify?.(engineTr('lcl.layout.restored'), { label: engineTr('lcl.layout.undo'), run: () => { get().undoResetLayout() } })
      if (typeof dismiss === 'function' && layoutUndo === undo) undo.dismiss = dismiss
    }
  },

  noteLayoutChange() {
    const u = layoutUndo
    if (!u) return
    const api = get().api
    if (!api || !undoStillMatches(u, api)) { dropLayoutUndo(); return }
    // 沉降窗口里(重置自己引起的回调):尺寸以沉降后的为准,刷新基线;之后用户再拖分隔线才算改了布局(Codex 第三轮 H1-3)。
    if (Date.now() < u.settleUntil) u.metrics = layoutMetrics(api)
  },

  undoResetLayout() {
    const u = layoutUndo
    layoutUndo = null
    const api = get().api
    // 快照只对拍它的那份 api、那个 Space 有效:切过 Space 再点通知里的「撤销」= 静默作废,不把别的 Space 的布局灌进来。
    // 重置后布局结构 / 分屏尺寸已被用户改过(布局回调还没来得及作废它时)同样作废;只拖侧栏宽不算(Codex 第三轮 H1-3)。
    if (!u || !api || u.profile !== get().sideProfileKey || !undoStillMatches(u, api)) return false
    const ok = get().applyLayout(u.env)
    if (ok) {
      restoredOwner = u.owner // 撤回来的是重置前那份:归属也回到拍快照那一刻的(画像没变过,上面刚核过)
      set({ stashActive: u.stashActive }) // 信封不带它:不还原的话,展开收起的侧栏会落到第一个视图而不是原来选中的那个
      scheduleWorkspaceSave()
    }
    return ok
  },

  repinSides: () => { const api = get().api; if (api) pinSides(api) },

  openView(type, params = {}, loc = 'main', opts) {
    const api = get().api
    if (!api) return null
    const def = getView(type)
    // ⚠️ singleton 复用必须给显式 newTab 让路:reuseKey 没给时下面那句「命中任意同类型 panel」会把
    // ⌘点击「在新标签页打开」整个吞掉(setActive 就返回了)—— chat 多标签就卡在这一句上。
    // 单例语义只管「顺手开一个」,不管「我明确要再来一个」;笔记/PDF/白板那些非 singleton 视图一直是这个行为。
    if (def?.singleton && !opts?.newTab) {
      const reuseKey = params.reuseKey
      const existing = api.panels.find((p) => {
        if (panelType(p) !== type) return false
        if (reuseKey === undefined) return true
        const panelParams = (p.params ?? {}) as Record<string, unknown>
        return panelParams.reuseKey === reuseKey
          || (reuseKey === 'primary' && panelParams.reuseKey === undefined && panelParams.followActive !== false)
      })
      if (existing) {
        if (reuseKey === 'primary') existing.api.updateParameters({ ...(existing.params ?? {}), ...params })
        existing.api.setActive()
        return makeLeaf(existing)
      }
    }
    if (loc === 'main' && !opts?.newTab) {
      // 主区默认「就地导航」:替换当前活动主 leaf(浏览器/Obsidian 式;singleton 已在上方被捕获激活)。
      // ＋按钮/兜底填充等显式 newTab;主区为空(Space build 期)时自然落到下方新建。
      const cur = activeMainPanel(api)
      if (cur) return get().navigateLeaf(cur.id, type, params)
    }
    if (loc !== 'main' && !opts?.newTab) {
      // 侧栏同侧同类型复用(非 singleton 也复用):侧栏 tab 按类型唯一,如左右各一个「工作区」视图。
      // 显式 newTab 让路(与主区同语义):代码块「运行」每次都要一个新的底部终端 tab。
      const existingSide = panelsAt(api, loc).find((p) => panelType(p) === type)
      if (existingSide) {
        existingSide.api.setActive()
        return makeLeaf(existingSide)
      }
    }
    // newTab 开出来的第二份 singleton 必须换 id:裸 type 已被第一份占着,重名 addPanel 会炸。
    const id = def?.singleton && !opts?.newTab ? type : nextId(api, type)
    const title = def ? label(def.displayName) : type
    const firstOfSide = loc !== 'main' && panelsAt(api, loc).length === 0
    const before = firstOfSide ? captureRegionTree(api) : null
    const restore = firstOfSide ? preserveAcrossRestructure() : () => {}
    const panel = api.addPanel({
      id,
      // 主区 panel 一律挂 __frame 宿主(就地切视图靠 updateParameters 换 __type);侧栏保持 per-type 组件。
      component: loc === 'main' ? '__frame' : type,
      title,
      params: { ...params, __loc: loc, __type: type },
      position: positionFor(api, loc) as never,
    })
    if (firstOfSide) {
      alignRegions(api, before)
      if (loc === 'bottom') settleBottomHeight(api)
      restore()
    }
    if (loc !== 'main') set({ [visKeyOf(loc)]: true } as Partial<WorkspaceState>)
    if (type === 'chat') set({ focusedChatLeafId: panel.id })
    scheduleWorkspaceSave()
    return makeLeaf(panel)
  },

  navigateLeaf(leafId, type, params = {}) {
    const api = get().api
    const panel = api?.getPanel(leafId)
    if (!api || !panel || !getView(type)) return null
    // 固定 View 不被别的类型顶掉:改在它那一组开新标签(同类照旧就地换,如聊天 → 另一个会话)。
    // 侧栏 panel 本来就不能就地换类型(按类型挂的组件),固定的直接拒绝。
    if (panelType(panel) !== type && guarded(api, panel)) return locOfPanel(panel) === 'main' ? openTabBeside(api, panel, type, params) : null
    return swapLeaf(api, panel, type, params)
  },

  getActiveLeaf() {
    const api = get().api
    const active = api?.activePanel
    return active ? makeLeaf(active) : null
  },

  leafById(id) {
    const p = get().api?.getPanel(id)
    return p ? makeLeaf(p) : null
  },

  splitActive(direction, paramsOverride) {
    const api = get().api
    const active = api?.activePanel
    if (!api || !active) return null
    const type = panelType(active)
    if (type === '__extend') return null // 临时 View 没有可重建的内容(无 lease / 挂载目标),分屏只会克隆出一块关不掉的空白
    const { __loc, __type, ...userParams } = (active.params ?? {}) as PanelMeta & Record<string, unknown>
    void __type
    // 左右侧栏严禁左右分屏(与拖拽路径 dropModel.splitDirection 同一铁律):焦点在侧栏时向右分一律折叠成向下。
    // 底部面板不在此列 —— 它是横着的宽条,左右分屏才是自然动作(≈ VS Code 终端分栏)。
    const inSidebar = __loc === 'left' || __loc === 'right'
    const panel = api.addPanel({
      id: nextId(api, type),
      component: __loc && __loc !== 'main' ? type : '__frame', // 主区分屏 panel 同样挂 frame 宿主(支持就地切视图);非主区(含 bottom)保持 per-type 组件,与 openView 一致
      title: active.title ?? type,
      params: { ...userParams, ...paramsOverride, __loc: __loc ?? 'main', __type: type },
      position: { referencePanel: active.id, direction: direction === 'right' && !inSidebar ? 'right' : 'below' } as never,
    })
    if (type === 'chat') set({ focusedChatLeafId: panel.id })
    scheduleWorkspaceSave()
    return makeLeaf(panel)
  },

  toggleSidebar(side) {
    const api = get().api
    if (!api) return
    const beforeToggle = captureRegionTree(api)
    // 唯一的轴向差异集中在这几行:左右量宽 / 底部量高。其余(暂存、还原、补间、沉降)两轴共用一份。
    const vert = side === 'bottom'
    const sizeKey = vert ? 'height' : 'width'
    const readSize = (g: SizableGroup): number | undefined => (vert ? g.api.height : g.api.width)
    const targetSize = (): number => (vert ? bottomTargetHeight(api) : sideTargetWidth(api, side))
    const setSize = (g: SizableGroup, v: number): void => { try { g.api.setSize({ [sizeKey]: v }) } catch { /* 跨版本兜底 */ } }
    // 沉降后重钉:只有横向有「黄金分割钉宽」这回事;底部恒 free,拖多高就是多高,钉了反而把用户的高抹掉。
    const settleSizes = (): void => {
      if (!vert) pinSides(api)
      setTimeout(() => { if (!stale()) restoreRegionProportions(api, beforeToggle) }, 80)
    }
    // 收起/展开期锁死**对侧**只对横向有意义:底部吞吐的高只在主区那一列内部流动,左右栏宽度纹丝不动。
    const lockNeighbour = (): (() => void) => (vert ? () => {} : lockOtherSide(api, side))
    const visKey = visKeyOf(side)
    const panels = panelsAt(api, side)
    // 本轮代号 + 「我这一轮是不是已经被后一次点击接管了」。
    const gen = ++toggleGen[side]
    const stale = (): boolean => gen !== toggleGen[side]
    // ⚠️已知局限(左右栏自古如此,非本次引入):补间的 200ms 内 panel 还在,故「收起途中再点一下」
    // 会被判成「还开着」→ 再收一次,而不是反向展开;终态是关闭、状态与实况一致、不报错(实测),
    // 只是少了一次反向。真要做反向得把 tween 做成可接管的双向动画,不是改这一行能了的 ——
    // 试过按意图态判(sidebarAnimating ? get()[visKey] : …),两条 tween 仍会打架,反向依旧不生效。
    const visible = panels.length > 0
    if (visible) {
      // 收起:暂存内容,先把该区尺寸补间到 0(丝滑),动画结束再移除 panel。占位不入 stash
      // (空 stash 展开时回落 sidebarDefaults —— 折叠空侧栏再展开会复活默认视图,有意为之)。
      const stashed: Stashed[] = panels.filter((p) => !['sidebar-empty', '__extend'].includes(panelType(p))).map((p) => {
        const { __loc, __type, ...userParams } = (p.params ?? {}) as PanelMeta & Record<string, unknown>
        void __loc
        void __type
        return { type: panelType(p), params: userParams }
      })
      // 记住当前活动 tab(组内 activePanel),展开时据此还原选中 —— 否则 openView 顺序会落到最后一个视图。
      const activeP = panels.find((p) => {
        const grp = (p as { group?: { activePanel?: { id?: string } } }).group
        return grp?.activePanel?.id === p.id
      })
      const activeType = activeP && !['sidebar-empty', '__extend'].includes(panelType(activeP)) ? panelType(activeP) : get().stashActive[side]
      // Folding a temporary-only group must not replace the user's collapsed-panel recipe.
      if (panels.every((p) => panelType(p) === '__extend')) stashed.push(...get().stash[side])
      set((s) => ({ stash: { ...s.stash, [side]: stashed }, stashActive: { ...s.stashActive, [side]: activeType }, [visKey]: false } as Partial<WorkspaceState>))
      const group = (panels[0] as { group?: SizableGroup }).group
      // 另一侧**全程**锁死:补间每帧吐出的宽和 close 释放的空白都会被 Dockview 按比例摊给所有组,
      // 只锁 close 那一下的话,对侧仍会在这 200ms 里一路鼓起来、收尾再被 pinSides 弹回 = 抽闪。
      toggleReleases[side]?.()
      const unlock = lockNeighbour()
      const release = (): void => { unlock(); if (toggleReleases[side] === release) delete toggleReleases[side] }
      toggleReleases[side] = release
      const finish = (): void => {
        if (stale()) return // 已被后一次点击接管:那一轮会自己收尾,这里再动手就是去关别人的 panel
        // 逐个 try:这批 panel 可能已被新一轮 / closeLeaf 关掉,dockview 对重复 close 抛 'invalid operation'。
        // 左右:组被移除 → 网格收支 → 幸存的那一支被摘下重挂:滚动位置会归零、入场动画会重播。成对包住。
        // 底部:组藏起来不删(parkBottom),主区不重挂 —— iframe 不重载,这对包装只剩兜底。
        const restore = preserveAcrossRestructure()
        if (vert) parkBottom(api, panels[0].group, panels)
        else panels.forEach((p) => { try { p.api.close() } catch { /* 已经不在了 */ } })
        restore()
        settleSizes() // 收起后另一侧会吃掉空白漂移 → 重新钉回 0.191
        setTimeout(release, 180) // 布局沉降后释放,恢复可手动拖宽
        scheduleWorkspaceSave()
      }
      if (group) {
        sidebarAnimating[side] = true
        // 放开最小尺寸,补间能到 0
        try { group.api.setConstraints?.(vert ? { minimumHeight: 0 } : { minimumWidth: 0 }) } catch { /* ignore */ }
        const from = readSize(group) ?? targetSize()
        tweenGroupSize(group, sizeKey, from, 0, () => { if (stale()) return; sidebarAnimating[side] = false; finish() }, stale)
      } else finish()
    } else {
      // 展开:还原暂存内容(pinSides 跳过本侧),把该区尺寸从 ~0 补间到目标值。
      // stash 与 defaults 都为空(如无该侧默认的自定义 Space、或底部这种恒空默认)→ 开占位:
      // 否则不建任何 panel,syncPanelState 又按「无 panel」把 visible 复位,toggle 变成永远空转的死键。
      // ⚠️**收起期间该视图可能已被反注册**(关掉内置插件 / 禁用外置插件 / 换产品档案)——
      // 侧栏 panel 的 component 就是视图名,Dockview 的表里没有它就当场抛
      // (「Only React.memo… are accepted as components」,一次未捕获异常打断整次展开)。
      // 在**使用点**过滤而不是在 applyNamed/存档时剔除:stash 原样留在布局里,插件开回来即原样复活。
      const known = (v: Stashed): boolean => !!getView(v.type)
      const live = get().stash[side].filter(known)
      const defaults = get().sidebarDefaults[side].filter(known)
      const restored = live.length ? live : defaults
      const stashed: Stashed[] = restored.length ? restored : [{ type: 'sidebar-empty', params: {} }]
      set({ [visKey]: true } as Partial<WorkspaceState>)
      // ⚠️必须在 openView **之前**置位:新组按 Dockview 默认尺寸(~50%)诞生,这一帧的尺寸既不能被
      // settleBottomHeight/pinSides 当真、也不能被 captureSideWidths 当成用户拖出来的记下。
      sidebarAnimating[side] = true
      // ⚠️同样必须在 openView **之前**锁对侧:新组按 ~50% 诞生、紧接着被 setSize(1) 压回去,这一进一出
      // 都是按比例摊给所有组的 → 对侧先被顶宽,补间收尾 pinSides 再把它弹回,就是「左栏抽闪一下」。
      toggleReleases[side]?.()
      const unlock = lockNeighbour()
      const release = (): void => { unlock(); if (toggleReleases[side] === release) delete toggleReleases[side] }
      toggleReleases[side] = release
      const restoreOpen = preserveAcrossRestructure() // 同收起:新增组一样会让主区被摘下重挂(底部有藏着的组时不新增)
      stashed.forEach((v) => get().openView(v.type, v.params, side))
      restoreOpen()
      // 还原折叠前的活动 tab(openView 会把最后打开的设为活动,故此处显式拉回用户上次所在的视图)。
      // 无记忆(从没展开过 / 默认折叠的 Space 首次展开)→ 取**首项**:openView 顺序落到最后一个纯属副作用,
      // 「侧栏默认第一位 = 默认视图」才是配方作者(sidebarDefaults / space.json)写下的意思。
      const wantActive = get().stashActive[side] ?? stashed[0]?.type ?? null
      if (wantActive) {
        const p = panelsAt(api, side).find((x) => panelType(x) === wantActive)
        if (p) get().activateLeaf(p.id)
      }
      const group = (panelsAt(api, side)[0] as { group?: SizableGroup } | undefined)?.group
      const settle = (): void => {
        if (stale()) return // 同 finish:后一次点击接管后,本轮不再碰 animating/约束/布局
        sidebarAnimating[side] = false
        settleSizes()
        setTimeout(release, 180) // 布局沉降后释放,恢复可手动拖宽
        scheduleWorkspaceSave()
      }
      if (group) {
        // ⚠️必须先放开最小尺寸再起步:Dockview 组自带 100px 的默认最小宽/高,`setSize(1)` 会被**钳在 100**
        // → 补间还没开始,相邻的主区就已经被一帧挤掉 100px,然后才从 100 平滑到目标值。用户实报
        // 「底部面板出来的时候上面的面板会闪一下,很奇怪,不连贯」就是这一下(实测轨迹首帧 bottom 直接 =100、
        // main 900→800,补间的前 1/3 全被钳平吃掉)。收起分支早就放开了 min,展开这侧一直漏掉。
        try { group.api.setConstraints?.(vert ? { minimumHeight: 0 } : { minimumWidth: 0 }) } catch { /* 跨版本兜底 */ }
        setSize(group, 1) // 起点贴 0,免首帧闪到默认尺寸
        tweenGroupSize(group, sizeKey, 1, targetSize(), () => {
          if (stale()) return // 新一轮已接管这个组的尺寸,别把 min 还回去打断它
          // 补间结束再把最小尺寸还回去:0 会让用户手动拖 sash 时把这一区拖到彻底消失。
          try { group.api.setConstraints?.(vert ? { minimumHeight: DV_GROUP_MIN } : { minimumWidth: DV_GROUP_MIN }) } catch { /* 跨版本兜底 */ }
          settle()
        }, stale)
      } else settle()
    }
  },

  saveCurrent() {
    const api = get().api
    if (api) saveLayout(envelope(api, get()))
  },

  saveNamed(name) {
    const api = get().api
    if (api) saveNamedLayout(name, envelope(api, get()))
  },

  applyNamed(name) {
    const blob = loadNamedLayout(name)
    if (!get().api || !blob) return false
    dropLayoutUndo() // 换了一整份布局(切 Space 走这里):之前的「恢复默认」快照作废
    return get().applyLayout(blob)
  },

  applyLayout(blob) {
    const api = get().api
    if (!api) return false
    try {
      migrateLayoutBlob(blob)
      dismissExtensions()
      selfTitled.clear() // 新布局会复用 leaf id(如 launcher#1),旧的「自己改过名」标记不能带过去
      api.fromJSON(blob.dockview as never)
      alignRegions(api)
      retitleDefaultPanels()
      // 布局整体更换,旧 leaf id 全失效。⚠️ 放在 fromJSON **之后**:拆旧建新途中的激活事件也会让订阅方记账,
      // 挪到前面的话,途中记下的条目会留在新布局复用的 leaf id(如 launcher#1)上。
      useNav.getState().reset()
      lastMainGroupId = null // 组 id 也会被新布局复用;下面的 refreshTabs 按新布局的全局 activePanel 重记
      set({
        leftVisible: blob.sidebars.left.visible,
        rightVisible: blob.sidebars.right.visible,
        // bottom 是后加的可选字段:老布局没有它 = 底部收起(见 layoutPersist 的信封注释)。
        bottomVisible: blob.sidebars.bottom?.visible ?? false,
        stash: { left: blob.sidebars.left.stash, right: blob.sidebars.right.stash, bottom: blob.sidebars.bottom?.stash ?? [] },
      })
      pinSides(api)
      // 重置之后必须让订阅方再跑一遍,给还原出来的前台文件/功能视图补栈底;不补 = 切 Space 往返后后退恒灰,
      // 就地开别的笔记再也退不回来(09-16 active-tab.e2e)。⚠️ 先清空再刷:拆建途中的激活事件通常已把
      // mainTabs 刷成终态(那时记下的栈底刚被上面的 reset 清掉),直接 refreshTabs 会判「无变化」不 set(探针实测)。
      set({ mainTabs: [] })
      get().refreshTabs()
      return true
    } catch {
      return false // 损坏布局:调用方回退 resetLayout
    }
  },

  namedLayouts: () => Object.keys(listNamedLayouts()),
}))

/** 启动时尝试恢复上次布局(给 WorkspaceHost.onReady 用)。成功返回 true。 */
/** 布局引用的所有视图当前是否都已注册。Tangu Web 无 window.amadeus → amadeus-* 未注册;
 *  若旧布局引用了它们,dockview.fromJSON 会异步挂载未知组件、在其 effect 里 deref undefined 崩溃
 *  (越过下面的 try/catch)。故先校验:有未注册视图即丢弃整份布局 → 回退默认布局。 */
function layoutViewsAllRegistered(dockview: unknown): boolean {
  const panels = (dockview as { panels?: Record<string, { params?: { __type?: string } }> } | null)?.panels
  if (!panels) return true
  for (const p of Object.values(panels)) {
    const t = p?.params?.__type
    if (t && !getView(t)) return false
  }
  return true
}

/** 退役视图 → 统一视图(2026-07-03):会话列表/工作区文件/笔记库 并入 'workspace',
 *  目录/Amadeus 大纲 并入 'outline'。迁移后旧注册删除,launcher/palette 不再出现旧名。 */
/** 值 = 新类型,或 `{ type, params }`:迁移时顺手补参数 —— 只补布局里没有的键,不覆盖用户存过的。 */
type RetiredTarget = string | { type: string; params: Record<string, unknown> }
const RETIRED_VIEW_MAP: Record<string, RetiredTarget> = {
  sessions: 'workspace',
  files: 'workspace',
  'amadeus-pages': 'workspace',
  toc: 'outline',
  'amadeus-outline': 'outline',
  // 收件箱左栏并入统一工作区(2026-09-11):老布局里的独立 inbox-list → workspace,并钉 mode = 收件箱列表源 ——
  // 旧叶子可能不在 Inbox Space(用户手摆到别处),光改类型会落到当前 Space 的自动档(会话 / 笔记)(Codex 09-11 P1)。
  // inbox-list 类型仍注册着(仪表盘卡片引用它),其整页渲染同样钉这个档(bootstrapEngine 的 defaultMode)。
  'inbox-list': { type: 'workspace', params: { mode: 'plugin:inbox:messages' } },
}

function retiredTarget(t: string | undefined): { type: string; params: Record<string, unknown> } | null {
  const n = t ? RETIRED_VIEW_MAP[t] : undefined
  return !n ? null : typeof n === 'string' ? { type: n, params: {} } : n
}

/** 历史布局就地迁移(幂等,载入时跑):①退役视图改名(dockview panels + 侧栏 stash;同侧重复由
 *  openView 的「同侧同类型复用」自然合并);②主区 panel 组件统一为 '__frame' 宿主(params.__type
 *  早已持久化,v3→v4 迁移即为此铺垫)。新代码保存的布局天然已是终态。 */
export function migrateLayoutBlob(layout: Pick<LayoutEnvelopeV4, 'dockview' | 'sidebars'>): void {
  const panels = (layout.dockview as { panels?: Record<string, { contentComponent?: string; params?: { __loc?: string; __type?: string } }> } | null)?.panels
  if (panels) {
    for (const p of Object.values(panels)) {
      if (!p || typeof p !== 'object') continue
      const params = (p.params ??= {})
      const next = retiredTarget(params.__type)
      if (next) {
        params.__type = next.type
        p.contentComponent = next.type
        const bag = params as Record<string, unknown>
        for (const [k, v] of Object.entries(next.params)) if (bag[k] === undefined) bag[k] = v
      }
      if ((params.__loc ?? 'main') === 'main') p.contentComponent = '__frame'
    }
  }
  for (const side of ['left', 'right', 'bottom'] as const) {
    const sb = layout.sidebars?.[side]
    if (!sb) continue
    sb.stash = sb.stash.map((v) => {
      const next = retiredTarget(v.type)
      return next ? { ...v, type: next.type, params: { ...next.params, ...(v.params ?? {}) } } : v
    })
  }
}

/** onReady 那次还原的结局:null = 还没跑;false = 落空(没有存档 / 存档引用了当时尚未注册的视图),屏上摆的是默认布局。 */
let bootRestored: boolean | null = null
/** 启动还原落空了:此刻屏上是「当时的活动 Space」的默认布局,不是布局键里原来那份现场。
 *  异步就位的 Space(插件比 Dockview 就绪得晚)据此补还原自己的现场,而不是只换个活动 id。 */
export const bootLayoutFellThrough = (): boolean => bootRestored === false

export function tryRestoreLayout(api: DockviewApi): boolean {
  bootRestored = restoreLayout(api)
  return bootRestored
}

/** 命名布局此刻还原得了吗:存在,且引用的视图都已注册(口径同 tryRestoreLayout;applyNamed 自己不查)。 */
export function namedLayoutRestorable(name: string): boolean {
  const blob = loadNamedLayout(name)
  if (!blob) return false
  migrateLayoutBlob(blob)
  return layoutViewsAllRegistered(blob.dockview)
}

function restoreLayout(api: DockviewApi): boolean {
  restoredOwner = undefined
  const layout = loadLayout()
  if (!layout) return false
  migrateLayoutBlob(layout) // 必须先迁移再校验:退役视图(sessions 等)已无注册,迁移前校验会误丢整份布局
  if (!layoutViewsAllRegistered(layout.dockview)) return false
  const known = (v: PersistedPanel): boolean => !!getView(v.type) // 收起态 stash 也剔除未注册视图,防展开时重开死视图
  try {
    selfTitled.clear()
    api.fromJSON(layout.dockview as never)
    alignRegions(api)
    retitleDefaultPanels(api) // 恢复发生在 onReady 里,store 里的 api 可能还没挂上 → 直接传
    useWorkspace.setState({
      leftVisible: layout.sidebars.left.visible,
      rightVisible: layout.sidebars.right.visible,
      bottomVisible: layout.sidebars.bottom?.visible ?? false,
      stash: {
        left: layout.sidebars.left.stash.filter(known),
        right: layout.sidebars.right.stash.filter(known),
        bottom: (layout.sidebars.bottom?.stash ?? []).filter(known),
      },
    })
    const focused = api.activePanel && panelType(api.activePanel) === 'chat'
      ? api.activePanel
      : api.panels.find((p) => panelType(p) === 'chat')
    useWorkspace.getState().setFocusedLeaf(focused)
    pinSides(api)
    if (!api.panels.length) return false
    restoredOwner = layout.space || null
    return true
  } catch {
    return false
  }
}

export { LAYOUT_KEY }

/** Create a native temporary leaf. The owner retains its content across ordinary side-tab switches.
 *  A brand-new side group opens with the same 200ms tween as the sidebar toggle, and collapses with it when the
 *  temporary View was the group's only panel; joining a group that already has Views is instant, like adding a tab. */
let extensionSerial = 0
export const presentDockedExtension: ExtendViewPresenter = (options, dismiss) => {
  const api = useWorkspace.getState().api
  if (!api) throw new Error('Workbench is not ready')
  const beforeExtension = captureRegionTree(api)
  const side = options.side ?? 'right'
  extensions[side]?.dismiss()
  extensions[side]?.dispose(true) // replacing: swap in place, never a collapse/expand pair
  ++toggleGen[side]
  toggleReleases[side]?.()
  const cutTween = sidebarAnimating[side] // a sidebar toggle was mid-tween: its group is parked at an intermediate size
  sidebarAnimating[side] = false
  const existing = panelsAt(api, side)
  const previous = existing.find((p) => p.group.activePanel === p)
  const element = document.createElement('div')
  element.className = 'wb-extend-target'
  const id = `__extend-${++extensionSerial}`
  const vert = side === 'bottom'
  const sizeKey = vert ? 'height' : 'width'
  const minOff = vert ? { minimumHeight: 0 } : { minimumWidth: 0 }
  const minOn = vert ? { minimumHeight: DV_GROUP_MIN } : { minimumWidth: DV_GROUP_MIN }
  const canTween = typeof requestAnimationFrame === 'function'
  const defaultWidth = side === 'bottom' || existing.length > 0 || useWorkspace.getState().sideWidths[side] != null
    ? undefined
    : computeTransientSideWidth(api.width, sideTargetWidth(api, side))
  /** Hold the neighbouring panels while this side changes size; released after the layout settles (same as toggleSidebar). */
  const holdNeighbour = (): (() => void) => {
    toggleReleases[side]?.()
    const unlock = vert ? lockSides(api, ['left', 'right'], true) : lockOtherSide(api, side)
    const release = (): void => { unlock(); if (toggleReleases[side] === release) delete toggleReleases[side] }
    toggleReleases[side] = release
    return release
  }
  let panel: IDockviewPanel | undefined
  let removed: { dispose(): void } | undefined
  let disposed = false
  let opening = false
  let closing: Promise<void> | null = null
  let release: (() => void) | null = null // the neighbour hold taken for the open tween; assigned before addPanel
  const lease = {
    id, dismiss, previousId: previous?.id, defaultWidth,
    dispose(instant = false): void | Promise<void> {
      if (disposed) return closing ?? undefined
      disposed = true
      removed?.dispose()
      if (opening) { opening = false; sidebarAnimating[side] = false; ++toggleGen[side]; release?.() } // stop the expand tween and free the neighbour lock it held
      const wasActive = panel?.group.activePanel === panel
      if (extensions[side] === lease) delete extensions[side]
      nativeExtendTargets.delete(id)
      const finish = (): void => {
        pinSides(api)
        const restore = preserveAcrossRestructure()
        if (panel && api.getPanel(id) === panel) { if (vert) parkBottom(api, panel.group, [panel]); else panel.api.close() }
        if (wasActive && previous && api.getPanel(previous.id) === previous) previous.api.setActive()
        restore()
        element.remove()
        useWorkspace.getState().syncPanelState()
        useWorkspace.getState().refreshTabs()
        pinSides(api)
        setTimeout(() => restoreRegionProportions(api, beforeExtension), 80)
        scheduleWorkspaceSave()
      }
      // Only a group about to vanish collapses with a tween; a tab leaving a shared group just closes.
      const group = panel?.group as unknown as SizableGroup | undefined
      // Judge by the panel's real group, not by side params: an empty side would make every() vacuously true.
      const solo = !!panel && api.getPanel(id) === panel && ((panel.group as unknown as { panels?: unknown[] }).panels?.length ?? 0) === 1
      const from = group ? ((vert ? group.api.height : group.api.width) ?? 0) : 0
      if (instant || !solo || !group || from < 2 || !canTween) { finish(); return }
      const gen = ++toggleGen[side]
      const stale = (): boolean => gen !== toggleGen[side]
      const closeRelease = holdNeighbour()
      sidebarAnimating[side] = true
      try { group.api.setConstraints?.(minOff) } catch { /* 跨版本兜底 */ }
      closing = new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          sidebarAnimating[side] = false
          finish()
          setTimeout(closeRelease, 180)
          resolve()
        }
        tweenGroupSize(group, sizeKey, from, 0, done, stale)
        setTimeout(done, 260) // taken over by a sidebar toggle mid-tween: still close, so the owner drops its content
      })
      return closing
    },
  }
  extensions[side] = lease
  nativeExtendTargets.set(id, element)
  const restore = preserveAcrossRestructure()
  release = holdNeighbour()
  const before = !existing.length ? captureRegionTree(api) : null
  try {
    // A real leaf in the ordinary native tab group, even when that group already has other Views.
    panel = api.addPanel({ id, component: '__extend',
      title: typeof options.title === 'function' ? options.title() : options.title,
      params: { __loc: side, __type: '__extend' }, position: positionFor(api, side) as never })
    if (!existing.length) {
      // Born at Dockview's default (~50%): start near 0 and tween to the target, exactly like toggleSidebar's expand
      // (min size released first, or setSize(1) is clamped to 100 and the main area jumps by that much in one frame).
      alignRegions(api, before)
      const group = panel.group as unknown as SizableGroup
      const gen = toggleGen[side]
      const stale = (): boolean => gen !== toggleGen[side] || disposed
      const target = vert ? bottomTargetHeight(api) : sideTargetWidth(api, side)
      opening = canTween
      sidebarAnimating[side] = canTween
      try { group.api.setConstraints?.(minOff) } catch { /* 跨版本兜底 */ }
      try { group.api.setSize({ [sizeKey]: 1 }) } catch { /* 跨版本兜底 */ }
      tweenGroupSize(group, sizeKey, 1, target, () => {
        if (stale()) return
        opening = false
        sidebarAnimating[side] = false
        try { group.api.setConstraints?.(minOn) } catch { /* 跨版本兜底 */ }
        if (vert) settleBottomHeight(api); else pinSides(api)
        setTimeout(() => { if (!disposed) restoreRegionProportions(api, beforeExtension) }, 80)
        setTimeout(() => release?.(), 180)
        scheduleWorkspaceSave()
      }, stale)
    } else {
      panel.group.api.setConstraints(minOn)
      if (cutTween) { // finish the interrupted toggle: park the group at its target instead of the clamped mid-tween size
        try { (panel.group as unknown as SizableGroup).api.setSize({ [sizeKey]: vert ? bottomTargetHeight(api) : sideTargetWidth(api, side) }) } catch { /* 跨版本兜底 */ }
        if (vert) settleBottomHeight(api); else pinSides(api)
      }
    }
    removed = api.onDidRemovePanel((event) => { if (event === panel) { dismiss(); lease.dispose() } })
    useWorkspace.getState().syncPanelState()
    useWorkspace.getState().refreshTabs()
    scheduleWorkspaceSave()
    // Bottom tabs are named and closable; left/right tabs are icon-only, so the extension draws its own header there.
    return { element, titled: vert, activate: () => { if (!disposed) panel?.api.setActive() }, dispose: lease.dispose }
  } catch (error) { lease.dispose(true); throw error }
  finally { restore(); if (!opening) release?.() }
}
