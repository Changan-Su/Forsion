/**
 * 单列 workspace store：桌面 Dockview store(./dockviewStore)的**单列替身**,住在引擎里。
 * 两条路都用它:① mobile 构建 vite engineSwap 把 `engine/workspaceStore` 换成本文件;
 * ② desktop/web 的 workspaceStore 选择器在 UI_MODE==='mobile' 时指向本文件。views/spaceRegistry
 * 经 barrel 拿到的 `useWorkspace` 即本单列实现,上层源零改。
 *
 * 模型:三桶 leaf(main / left / right) + 各自 activeId;主区一次显示一个 active leaf(全屏),
 * 左右侧栏 = 侧滑抽屉(visible 控制)。`navigateLeaf` = 原地换视图(一屏换一屏),`splitActive` = 开新主 leaf。
 * 只实现被 views / spaceRegistry / bootstrapEngine / spaces.build 真正消费的方法;桌面独有的
 * 布局序列化 / 命名布局 / Dockview api 在移动端退化为 no-op / 空(见各方法注释)。
 */
import { create } from 'zustand'
import { routeMiniView } from './miniPanel'
import { IS_MINI_PANEL, IS_TRANSIENT_MINI_PANEL } from './uiMode'
import type { ExtendViewPresenter } from './extendView'
import { nativeExtendTargets } from './nativeExtendView'
import type { Leaf, ViewLocation, SidebarDefaults } from './types'
import { identitySig, label } from './types'
import { getView } from './viewRegistry'
import { useNav } from './navStore'
import type { PersistedPanel } from './layoutPersist'
import { contentStorageKey } from './contentStorageScope'
import { isLastPinned, isPinned, missingPinned, type PinnedViews } from './pinnedViews'
import { arrangeRight, planRight, rightGroupFor, type RightRef } from './rightRules'

/** 主区 leaf 快照(供顶栏/读者)。字段与桌面同名以兼容读者 —— ⚠️ 桌面 dockviewStore 那份加字段时
 *  这里必须同步:移动构建把整个 workspaceStore 换成本文件,漏一个字段就是静默少功能(typecheck 也不红,
 *  因为读者读的是可选属性)。`filePath` 见桌面版同名字段的注释。 */
export interface MainTab { id: string; type: string; title: string; active: boolean; closable: boolean; sessionId?: string; followActive: boolean; filePath?: string; front: boolean; sig: string }
/** 侧栏视图快照。 */
export interface SideTab { type: string; title: string; active: boolean; closable: boolean }

/** `by: 'rule'` = 右栏主视图规则开出来的(rightRules.ts;桌面那边记在面板参数 __by 里,这里单列一个字段,不混进视图的 params)。 */
interface LeafRec { id: string; type: string; loc: ViewLocation; params: Record<string, unknown>; title: string; by?: 'rule' }

function bucketOf(loc: ViewLocation): 'mainLeaves' | 'leftLeaves' | 'rightLeaves' {
  return loc === 'left' ? 'leftLeaves' : loc === 'right' ? 'rightLeaves' : 'mainLeaves'
}
function activeKeyOf(loc: ViewLocation): 'activeMainId' | 'leftActiveId' | 'rightActiveId' {
  return loc === 'left' ? 'leftActiveId' : loc === 'right' ? 'rightActiveId' : 'activeMainId'
}

function makeId(type: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  let n = 1
  while (used.has(`${type}#${n}`)) n++
  return `${type}#${n}`
}

/* ── 布局持久化 ────────────────────────────────────────────────────────────────
 * 桌面靠 Dockview 的 toJSON/fromJSON,单列这边没有 api —— 三桶 leaf 本身就是纯数据,直接序列化。
 * **不与桌面共用键**:两边的 blob 形状互不兼容,而 layoutPersist 的命名表在写入时会把校验不过的
 * 条目顺手丢掉(同源同 origin 的 web 端可能两种壳都跑过)→ 各用各的键,谁也别踩谁。
 */
/** 卫星窗(mini 悬浮卡 / detached)按 `?window=` 各自命名空间 —— 与 layoutPersist.computeLayoutKey
 *  同一套语义。不隔离的话:主窗切到 mobile UI 预览时和 mini 卡共用一份存档,两个 realm 各 200ms
 *  节流写同一个键,后写的整份盖掉前一个(Codex 评审抓的 Medium)。同 origin 开两个普通标签页仍共用
 *  —— 那和桌面 LAYOUT_KEY 的天花板一样(没有可区分的窗口 id),不另造。 */
function scKey(base: string): string {
  try {
    const w = new URLSearchParams(location.search).get('window')
    return w && w !== 'main' ? `${base}_${w}` : base
  } catch { return base } // node 测试无 location
}
const SC_LAYOUT_KEY = contentStorageKey(scKey('lcl_sc_layout_v1'))
const SC_NAMED_KEY = contentStorageKey(scKey('lcl_sc_named_layouts_v1'))

interface SCBlob {
  v: 1
  /** 这份布局是给哪个 Space 摆的(与布局同一次写盘;同桌面信封的 space,可选、不升版本)。冷启动交接按它认主
   *  (adoptSingleColumnLayoutCold)。老存档没有 = 不知道,照旧信「上次退出在哪」。 */
  space?: string
  main: LeafRec[]
  left: LeafRec[]
  right: LeafRec[]
  activeMainId: string | null
  leftActiveId: string | null
  rightActiveId: string | null
  /** 存它时右栏对到的组(同桌面信封的 sidebars.right.rule,可选、不升版本)。 */
  rightRule?: string
}

/** 丢掉本窗的单列布局存档(当前布局 + 各 Space 的命名槽)。spaceRegistry.resetSpaceLayouts 的单列半身。
 *  给了 `only` 就只丢那一个 Space 的:命名槽按名字丢;当前布局认它自己记的归属,老存档没记才看主区里摆没摆着
 *  `mainTypes`(那个 Space 的固定主视图)之一,认不出就留着。 */
export function clearSingleColumnLayouts(only?: { space: string; mainTypes: readonly string[] }): void {
  try {
    const cur = only ? readJSON<SCBlob>(SC_LAYOUT_KEY) : null
    const main = cur?.main
    const stamp = stampOf(cur)
    const mine = !only || (stamp ? stamp === only.space
      : Array.isArray(main) && main.some((leaf) => only.mainTypes.includes((leaf as { type?: string } | null)?.type ?? '')))
    if (mine) localStorage.removeItem(SC_LAYOUT_KEY)
    const all = readJSON<Record<string, unknown>>(SC_NAMED_KEY)
    if (!all) return
    for (const name of Object.keys(all)) if (only ? name === `space:${only.space}` : name.startsWith('space:')) delete all[name]
    localStorage.setItem(SC_NAMED_KEY, JSON.stringify(all))
  } catch { /* 私密模式 */ }
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch { return null } // 私密模式 / 坏 JSON
}
function writeJSON(key: string, value: unknown): void {
  if (IS_TRANSIENT_MINI_PANEL) return // Automatic panels never overwrite the user's Mini layout.
  // 出声再吞:配额满 / 私密模式 / 某个 leaf 的 params 塞了循环引用 —— 任一情形都是「布局从此不再持久化」,
  // 静默失败的话下次只会收到一句「进去又是新页」,查无对证。
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { console.warn('[lcl] 单列布局存盘失败', key, e) }
}

function isBlob(v: unknown): v is SCBlob {
  const b = v as Partial<SCBlob> | null
  return !!b && b.v === 1 && Array.isArray(b.main) && Array.isArray(b.left) && Array.isArray(b.right)
}
/** blob 自己记的归属(没记 / 手改坏了 = null)。 */
const stampOf = (b: SCBlob | null): string | null => (typeof b?.space === 'string' && b.space ? b.space : null)

/** 逐个剔除不能用的 leaf:①结构坏的(手改 localStorage、旧版本残留 —— `isBlob` 只查三个桶是不是
 *  数组,桶里塞了 `null` 就会在这炸,而这里没有 catch,壳会进错误边界而不是回落默认布局);
 *  ②视图未注册的(端间差异:Tangu Web 没有 amadeus-*;插件视图可能已卸载)。
 *  桌面那边是「有一个未注册就整份回退」,单列这边逐个剔更稳:剩下的还能用。 */
const knownLeaves = (arr: LeafRec[]): LeafRec[] =>
  arr.filter((r): r is LeafRec =>
    !!r && typeof r === 'object'
    && typeof r.id === 'string' && typeof r.type === 'string'
    && !!r.params && typeof r.params === 'object'
    && !!getView(r.type))

let autoSaveArmed = false

/** 宿主钩子:主区布局**整份换新**之后调(冷启动还原 / 切 Space / 重置 / 关掉最后一个主区视图)。
 *  SingleColumnHost 的两级导航用它落回「列表层」。做成钩子而不是让宿主去订阅 activeSpaceId:切 Space 是一串
 *  同步 set,钩子跑在同一拍里,React 只提交终态 —— 不会先画一帧主区再滑出列表。
 *  判据(原生底栏在不在、该 Space 认不认)全在宿主那边:本文件 import spaceRegistry 会成环。 */
let afterLayout: (() => void) | null = null
export function setAfterLayoutHook(fn: (() => void) | null): void { afterLayout = fn }

/** 宿主钩子:主区要开一个视图**之前**调。SingleColumnHost 用它把「一页式 Space(主页)里开别的 Space 的视图」先带到
 *  那个 Space 去(同步切 Space),本次 openView 接着在新布局上照常开。同上,本文件 import spaceRegistry 会成环。 */
let beforeMainOpen: ((type: string) => boolean) | null = null
export function setBeforeMainOpenHook(fn: ((type: string) => boolean) | null): void { beforeMainOpen = fn }

/** 冷启动还原上次的三桶 leaf + 各自激活项。成功 true;首启/整份不可用返回 false,调用方 build 默认布局。
 *  同时是自动存盘的**发令枪** —— 还原之前 bootstrap 的那些 setSidebarDefaults 之类的 set() 不该
 *  把一份空布局先写回去,把真正要还原的东西冲掉。
 *  壳挂上之前已经摆上了布局(异步 Space 的补定位 / 桌面快捷方式抢先换了 Space):照用、返回 true,不拿在用的那份盖它;
 *  发令枪照样要响 —— 以前是壳自己跳过这一步,那一程的改动一个都不落盘(Codex 评审抓的 High)。 */
export function restoreSingleColumnLayout(): boolean {
  if (useWorkspace.getState().mainLeaves.length) { autoSaveArmed = true; saveSoon(); return true }
  restoredOwner = undefined
  const raw = readJSON<unknown>(SC_LAYOUT_KEY)
  const ok = applySCBlob(raw)
  if (ok) restoredOwner = stampOf(raw as SCBlob)
  autoSaveArmed = true
  return ok
}

/* ── 归属(同桌面 dockviewStore 的 restoredOwner / sideProfileKey,语义逐条照它)────────────────────────
 * 屏上这份布局是给哪个 Space 摆的:平时 = 最近一次 setSideProfile 的 Space(切 Space / 启动 / 补定位都先设它,再还原或重建);
 * 启动还原出来的那份自带归属时以它为准 —— 唯一不同的情形:点名的 Space 是异步就位的插件 / 用户 Space,还原时活动 id 还是回落值,
 * 屏上却是它的现场。三态:undefined = 不是启动还原的那份 → 归画像;string = 那份自带的;null = 老存档没记 → 不知道,存盘也不写。 */
let profileKey: string | null = null
/** 右栏主视图规则最近一次对账到的组(同桌面 dockviewStore 的 rightKey):null = 换了整份布局、还没对过。 */
let rightKey: string | null = null
let rightQueued = false
const usableRight = (type: string): boolean => { const def = getView(type); return !!def && def.kind !== 'entity' }
function rightGroupNow(s: { mainLeaves: LeafRec[]; activeMainId: string | null; sidebarDefaults: Record<'left' | 'right', PersistedPanel[]> }): ReturnType<typeof rightGroupFor> {
  const main = s.mainLeaves.find((r) => r.id === s.activeMainId)
  return rightGroupFor(main?.type, main ? getView(main.type)?.rightCompanions : undefined, s.sidebarDefaults.right, usableRight)
}
let restoredOwner: string | null | undefined
/** 壳还没还原(发令枪没响)、店里也还是空的:这一程的现场只在在用的键里。挂载之前有人切 Space / 补定位时据此
 *  认归属、存槽,而不是拿一家空店说事(同桌面:Dockview 就绪之前 saveNamed / saveCurrent 不写空布局)。 */
const notLaidOut = (): boolean => !autoSaveArmed && !useWorkspace.getState().mainLeaves.length
/** 屏上这份布局是给哪个 Space 摆的(= 存盘时写进 blob 的 space)。null = 不知道。
 *  还没摆(notLaidOut)时认在用那份自己记的归属:拿画像键去比,补定位抢在挂载之前跑时会把「在用的正是它的现场」
 *  误判成对不上(Codex 评审)。 */
export const liveLayoutOwner = (): string | null => {
  if (notLaidOut()) { const b = readJSON<unknown>(SC_LAYOUT_KEY); return isBlob(b) ? stampOf(b) : null }
  return restoredOwner === undefined ? profileKey : restoredOwner
}

/** spaceRegistry.adoptSpaceLayoutCold 的单列半身:手机 App 的冷启动交接,纯 Storage 搬运(须在 SingleColumnHost 还原之前)。
 *  口径逐条照桌面那份(那边的注释讲了每条的来历):
 *  ① 在用的布局先归档进它主人的槽(主人 = blob 自己记的,老存档没记才信 fromId)—— 会话中只有切走才写槽,
 *     不补这一手,上次退出的那个 Space(比如 Tangu)每次启动都丢一次现场;
 *  ② 再把目标 Space 的槽搬进在用的键,没有就清掉 → SingleColumnHost 还原落空,按它的默认建。不搬的话启动 Space 穿着
 *     上次退出那个 Space 的布局(主区标签 + 两侧面板)。
 *  from === to 只归档。归属对不上(上一程点名的 Space 没就位,屏上一直是回落 Space)只在主人的槽空着时归档,且布局正是
 *  此刻活动 Space(activeId)自己的就原样留着。归档读回来**逐字**对上之前不动在用的键:那是仅存的一份。
 *  只查形状、不滤视图:插件在这之后才装,滤了就把插件视图丢了。 */
export function adoptSingleColumnLayoutCold(fromId: string, toId: string, activeId: string): void {
  const raw = readJSON<unknown>(SC_LAYOUT_KEY)
  const cur = isBlob(raw) ? raw : null
  const owner = stampOf(cur) ?? fromId
  const slot = `space:${owner}`
  const named = (): Record<string, unknown> => readJSON<Record<string, unknown>>(SC_NAMED_KEY) ?? {}
  const mismatch = owner !== fromId
  const archive = !!cur && (!mismatch || !isBlob(named()[slot]))
  if (archive) writeJSON(SC_NAMED_KEY, { ...named(), [slot]: cur })
  if (owner === toId) return
  if (mismatch && owner === activeId) return
  if (archive && JSON.stringify(named()[slot]) !== JSON.stringify(cur)) return
  const next = named()[`space:${toId}`]
  if (isBlob(next)) writeJSON(SC_LAYOUT_KEY, { ...next, space: toId })
  else try { localStorage.removeItem(SC_LAYOUT_KEY) } catch { /* 私密模式 */ }
}

function applySCBlob(raw: unknown): boolean {
  if (!isBlob(raw)) return false
  const main = knownLeaves(raw.main)
  // 主区空、或只剩 `home` 空态占位 = 没什么可还原的,交回 buildDefault(= 该 Space 的落地页)。
  // ⚠️ 占位也要算「空」:主页 Space 的落地页被关掉后就地变成占位,存盘再还原 = 每次开机都是
  // 那张只有 logo 的空页,而且自己再也回不来(2026-08-30 用户实报「默认 Homepage 空白」)。
  if (main.every((r) => r.type === 'home')) return false
  const left = knownLeaves(raw.left)
  const right = knownLeaves(raw.right)
  const pick = (want: string | null, pool: LeafRec[]): string | null =>
    pool.some((r) => r.id === want) ? want : pool[pool.length - 1]?.id ?? null
  // 换布局:旧 leaf id 的历史全失效(还原出来的 id 与旧布局重合 = 安卓返回退进别的 Space 的内容)。
  // 须在下面 refreshTabs 之前,那一刷给前台文件视图记的栈底要留着。
  useNav.getState().reset()
  rightKey = typeof raw.rightRule === 'string' ? raw.rightRule : null // 同组就不再对账(见桌面 applyLayout)
  useWorkspace.setState({
    mainLeaves: main, leftLeaves: left, rightLeaves: right,
    activeMainId: pick(raw.activeMainId, main),
    leftActiveId: pick(raw.leftActiveId, left),
    rightActiveId: pick(raw.rightActiveId, right),
    // ponytail: 抽屉开合不还原,冷启动一律收起 —— 单列的侧栏是全屏浮层不是版面的一部分,
    // 「上次退出时抽屉开着」还原成开着 = 一进 app 先看到侧栏。宽屏并排的左栏除外,见 dockLeftIfWide。
    leftVisible: false, rightVisible: false,
    focusedChatLeafId: main.find((r) => r.type === 'chat')?.id ?? null,
  })
  dockLeftIfWide()
  useWorkspace.getState().refreshTabs()
  afterLayout?.()
  return true
}

/** 宽屏(横屏平板 / 手机)的左栏是与主区并排的版面,不是抽屉:布局整份换新(切 Space / 冷启动还原 / 重置)之后
 *  这个 Space 有左栏视图就展开 —— Host 里「进宽屏左栏默认展开」那条 effect 只在宽窄变化时跑,换 Space 不跑。
 *  走 toggleSidebar:桶空时按 sidebarDefaults 填。须在 afterLayout 之前:一页式 Space(主页)的落点随后会把面板关掉、左栏收回。 */
function dockLeftIfWide(): void {
  const s = useWorkspace.getState()
  if (s.wideMode && !s.leftVisible && (s.leftLeaves.length > 0 || s.sidebarDefaults.left.length > 0)) s.toggleSidebar('left')
}

function snapshot(): SCBlob {
  const s = useWorkspace.getState()
  const active = (side: 'left' | 'right'): string | null => {
    const leaves = s[bucketOf(side)].filter((r) => r.type !== '__extend')
    return leaves.find((r) => r.id === s[activeKeyOf(side)])?.id
      ?? leaves.find((r) => r.id === drawerExtensions[side]?.previousId)?.id ?? leaves[0]?.id ?? null
  }
  const space = liveLayoutOwner()
  return {
    v: 1,
    ...(space ? { space } : {}),
    main: s.mainLeaves, left: s.leftLeaves.filter((r) => r.type !== '__extend'), right: s.rightLeaves.filter((r) => r.type !== '__extend'),
    activeMainId: s.activeMainId, leftActiveId: active('left'), rightActiveId: active('right'),
    ...(rightKey !== null ? { rightRule: rightKey } : {}),
  }
}

/** scheduleWorkspaceSave:桌面由 Dockview 的 onDidLayoutChange 驱动,单列这边**订阅 store**
 *  (见文件末尾)—— 少一个「新加的 mutation 忘了调 save」的坑。保留导出以满足 barrel。 */
export function scheduleWorkspaceSave(): void { saveSoon() }

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveSoon(): void {
  if (!autoSaveArmed || saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; useWorkspace.getState().saveCurrent() }, 200)
}
/** 节流窗口内关掉页面/卡片 = 这一下改动没落盘(「开了个新标签立刻退出,回来它不在」)。
 *  `pagehide` 是移动端唯一可靠的收尾事件(iOS 后台化不发 beforeunload/unload)。 */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!autoSaveArmed || !saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    useWorkspace.getState().saveCurrent()
  })
}

/** activeMainPanel:桌面签名 (DockviewApi)=>panel;移动端 api 恒 null,bootstrapEngine 的 navGo 以
 *  `api ?` 守卫故从不真正调用。保留导出以满足 barrel / bootstrapEngine 的 import。 */
export function activeMainPanel(): null { return null }

/** bootLayoutFellThrough / namedLayoutRestorable:冷启动补定位(userSpaces.settleAsyncStartupSpace)用,手机 App 也走那条路
 *  (UI_MODE 在那里是 'desktop')。单列的还原逐个剔除认不出的视图、剩下的照用,不报桌面那种「整份落空」:还原不了(在用的键
 *  空着,或主区的视图一个都还没注册)屏上就是活动 Space 的默认布局,归属随之是它(liveLayoutOwner)—— 补定位按「归属对不上」
 *  那条路把目标 Space 的归档接回来。
 *  ponytail: 剔掉了一部分(插件视图比还原晚注册)的那份照用、照存,目标 Space 的插件标签这一程就没了;要保住得把
 *  「剔过」也报成落空,让补定位从归档还原。 */
export function bootLayoutFellThrough(): boolean { return false }
/** 命名槽此刻还原得了吗:存在、成形,引用的视图都已注册(口径同桌面版)。 */
export function namedLayoutRestorable(name: string): boolean {
  const b = (readJSON<Record<string, unknown>>(SC_NAMED_KEY) ?? {})[name]
  if (!isBlob(b)) return false
  const all = [...b.main, ...b.left, ...b.right]
  return knownLeaves(all).length === all.length
}
/** 桌面 Space 窗口挂 Dockview 前用;单列壳没有这种窗口。保留导出以满足 barrel。 */
export function savedLayoutRestorable(): boolean { return true }

interface WS {
  api: null
  mainLeaves: LeafRec[]
  leftLeaves: LeafRec[]
  rightLeaves: LeafRec[]
  activeMainId: string | null
  leftActiveId: string | null
  rightActiveId: string | null
  leftVisible: boolean
  rightVisible: boolean
  focusedChatLeafId: string | null
  chatSurfaces: Record<string, HTMLDivElement>
  sidebarDefaults: Record<'left' | 'right', PersistedPanel[]>
  mainTabs: MainTab[]
  leftTabs: SideTab[]
  rightTabs: SideTab[]
  defaultBuilder: (() => void) | null
  /** 同桌面版:当前 Space 的固定 View(pinnedViews.ts)。迷你面板只有一个内容面,不认固定。 */
  pinned: PinnedViews
  setPinned(pins: PinnedViews | undefined): void
  isPinnedLeaf(id: string): boolean
  ensurePinned(): void
  /** 同桌面版:右栏主视图规则对账一次(rightRules.ts)。收着的抽屉只改桶里的内容,不替用户打开。 */
  applyRightRules(): void

  setApi(api: unknown): void
  setDefaultBuilder(fn: () => void): void
  setSidebarDefaults(d: SidebarDefaults): void
  setSideProfile(key: string, free: { left?: boolean; right?: boolean }, scale?: { left?: number; right?: number }): void
  initializeSidebar(side: 'left' | 'right', visible: boolean): void
  registerChatSurface(id: string, el: HTMLDivElement | null): void
  syncPanelState(): void
  refreshTabs(): void
  /** opts.split:单列壳没有分屏,不认(照旧就地打开);签名与 dockviewStore 对齐。 */
  openView(type: string, params?: Record<string, unknown>, loc?: ViewLocation, opts?: { newTab?: boolean; split?: boolean }): Leaf | null
  navigateLeaf(leafId: string, type: string, params?: Record<string, unknown>): Leaf | null
  getActiveLeaf(): Leaf | null
  getActiveSideLeaf(side: 'left' | 'right'): Leaf | null
  leafById(id: string): Leaf | null
  /** 宽屏(≥4:3)并排形态标记(Host 按 useWideAspect 同步)。窄屏抽屉=全屏接管,主区导航时自动收回;宽屏 docked 左栏不收。 */
  wideMode: boolean
  setWideMode(v: boolean): void
  splitActive(direction: 'right' | 'down', paramsOverride?: Record<string, unknown>): Leaf | null
  toggleSidebar(side: 'left' | 'right'): void
  showSideView(side: 'left' | 'right', type: string): void
  activateLeaf(id: string): void
  closeLeaf(id: string, force?: boolean): void
  closeViewsOfType(type: string, force?: boolean): void
  /** 同桌面版:原地换类型(抽屉里的视图收着也照换,不替用户打开抽屉),sidebarDefaults 跟着换;返回换掉的个数。 */
  replaceViewsOfType(from: string, to: string, params?: Record<string, unknown>): number
  /** 同桌面版:三桶里的 leaf 一个不漏(单列壳只渲染当前那个,后台的视图没挂载、自己收不到任何广播)。 */
  remapLeaves(fn: (type: string, params: Record<string, unknown>) => Record<string, unknown> | null | undefined): void
  resetLayout(): void
  saveCurrent(): void
  saveNamed(name: string): void
  applyNamed(name: string): boolean
  namedLayouts(): string[]
}

export const useWorkspace = create<WS>((set, get) => {
  const allRecs = (): LeafRec[] => [...get().mainLeaves, ...get().leftLeaves, ...get().rightLeaves]
  const find = (id: string): LeafRec | undefined => allRecs().find((r) => r.id === id)
  const pins = (): PinnedViews => (IS_MINI_PANEL ? {} : get().pinned)
  /** 固定 View 里「区内最后一个」:关不掉、不被别的类型顶掉(同桌面版 guarded)。 */
  const guarded = (rec: LeafRec): boolean => isLastPinned(pins(), allRecs(), rec.loc, rec.type)

  const leaf = (rec: LeafRec): Leaf => ({
    id: rec.id,
    type: rec.type,
    loc: rec.loc,
    get params() { return find(rec.id)?.params ?? rec.params },
    // 幂等:标题/参数未变不 set()——桌面版 panel.api.setTitle 天生幂等,移动版若无条件 set 会让
    // 订阅方重渲染→视图再调 setTitle→无限循环(React #185)。
    setTitle: (t: string) => {
      const cur = find(rec.id)
      if (!cur || cur.title === t) return
      set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === rec.id ? { ...r, title: t } : r) } as Partial<WS>))
      // 让 mainTabs 标题跟随(主视图 tab 条按 mainTabs 渲染)。仅真变更时到这(上面幂等守卫已 return),
      // 且 refreshTabs 只重渲订阅 mainTabs 的 MainTabs、不碰 LeafHost/视图,故不会回激 setTitle 循环。
      get().refreshTabs()
    },
    setParams: (p: Record<string, unknown>) => {
      const cur = find(rec.id)
      if (!cur) return
      const merged = { ...cur.params, ...p }
      const keys = new Set([...Object.keys(cur.params), ...Object.keys(merged)])
      let changed = false
      for (const k of keys) if (cur.params[k] !== merged[k]) { changed = true; break }
      if (!changed) return
      set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === rec.id ? { ...r, params: merged } : r) } as Partial<WS>))
      get().refreshTabs()
    },
    close: () => get().closeLeaf(rec.id),
  })

  /** 把某 loc 桶里某 id 设为该桶 active(主区=切主屏;侧栏=切抽屉当前视图)。 */
  const setActive = (loc: ViewLocation, id: string): void => {
    set({ [activeKeyOf(loc)]: id } as Partial<WS>)
    if (loc === 'main') {
      const rec = find(id)
      if (rec?.type === 'chat') set({ focusedChatLeafId: id })
    }
  }

  /** 主区导航/激活后自动收抽屉:窄屏抽屉=全屏接管,选中条目即收回(用户拍板);
   *  宽屏 docked 左栏不收(wideMode 由 Host 同步),右栏恒浮层恒收。 */
  const autoCloseDrawers = (): void => {
    const s = get()
    const patch: Partial<WS> = {}
    if (!s.wideMode && s.leftVisible) patch.leftVisible = false
    if (s.rightVisible) patch.rightVisible = false
    if (Object.keys(patch).length) set(patch)
  }

  /** 就地把 leaf 换成另一种视图(navigateLeaf 的本体,不带固定守卫)。 */
  const swapRec = (rec: LeafRec, type: string, params: Record<string, unknown>): Leaf | null => {
    const def = getView(type)
    if (!def) return null
    const wasChat = rec.type === 'chat'
    const nextRec: LeafRec = { ...rec, type, params: { ...params }, title: label(def.displayName) }
    set((s) => ({ [bucketOf(rec.loc)]: s[bucketOf(rec.loc)].map((r) => r.id === rec.id ? nextRec : r) } as Partial<WS>))
    if (type === 'chat') set({ focusedChatLeafId: rec.id })
    else if (wasChat && get().focusedChatLeafId === rec.id) {
      const otherChat = get().mainLeaves.find((r) => r.id !== rec.id && r.type === 'chat')
      set({ focusedChatLeafId: otherChat?.id ?? null })
    }
    if (rec.loc === 'main') autoCloseDrawers()
    get().refreshTabs()
    return leaf(nextRec)
  }

  return {
    api: null,
    mainLeaves: [],
    leftLeaves: [],
    rightLeaves: [],
    activeMainId: null,
    leftActiveId: null,
    rightActiveId: null,
    leftVisible: false,
    rightVisible: false,
    wideMode: false,
    focusedChatLeafId: null,
    chatSurfaces: {},
    sidebarDefaults: { left: [], right: [] },
    mainTabs: [],
    leftTabs: [],
    rightTabs: [],
    defaultBuilder: null,
    pinned: {},

    setPinned: (p) => { set({ pinned: p ?? {} }); get().refreshTabs() },
    isPinnedLeaf: (id) => { const rec = find(id); return !!rec && guarded(rec) },
    ensurePinned: () => {
      // 抽屉桶空 = 还没按 sidebarDefaults 填过(toggleSidebar 打开时才填)→ 默认里有就算在。
      const refs: Array<{ loc: string; type: string }> = [...allRecs()]
      for (const side of ['left', 'right'] as const) {
        if (!get()[bucketOf(side)].length) for (const v of get().sidebarDefaults[side]) refs.push({ loc: side, type: v.type })
      }
      const missing = missingPinned(pins(), refs, (t) => !!getView(t))
      if (!missing.length) return
      for (const pin of missing) {
        const bkey = bucketOf(pin.loc)
        const here = get()[bkey]
        // 主区只剩空态占位 → 就地换成它
        if (pin.loc === 'main' && here.length === 1 && here[0].type === 'home') { swapRec(here[0], pin.type, pin.params); continue }
        const def = getView(pin.type)!
        const rec: LeafRec = { id: def.singleton && !find(pin.type) ? pin.type : makeId(pin.type, allRecs().map((r) => r.id)), type: pin.type, loc: pin.loc, params: pin.params, title: label(def.displayName) }
        // 排到桶首、不抢当前显示的那个;桶原本是空的才让它当 active
        set({ [bkey]: [rec, ...here], ...(here.length ? {} : { [activeKeyOf(pin.loc)]: rec.id }) } as Partial<WS>)
      }
      get().refreshTabs()
    },

    applyRightRules: () => {
      if (IS_MINI_PANEL) return
      const s = get()
      const g = rightGroupNow(s)
      if (!g || g.key === rightKey) return
      const changed = rightKey !== null
      rightKey = g.key
      const defaults = s.sidebarDefaults.right
      const extras = s.rightLeaves.filter((r) => r.type === '__extend') // 抽屉里的临时 View 跟它的主人走,不归规则
      const real = s.rightLeaves.filter((r) => r.type !== '__extend' && r.type !== 'sidebar-empty')
      // 桶空 = 抽屉打开时按缺省填(toggleSidebar),按缺省对账;对完和缺省一样就不写,桶照旧空着。
      const list: LeafRec[] = real.length ? real
        : defaults.filter((v) => !!getView(v.type)).map((v, i) => ({ id: `\0default${i}`, type: v.type, loc: 'right', params: v.params ?? {}, title: '' }))
      const refs: RightRef[] = list.map((r) => ({ id: r.id, type: r.type, tagged: r.by === 'rule', active: r.id === s.rightActiveId }))
      const elsewhere = new Set([...s.mainLeaves, ...s.leftLeaves].map((r) => r.type).filter((t) => getView(t)?.singleton)) // 同桌面版:只认单例
      const plan = planRight({ group: g.group, pinned: pins().right ?? [], spaceDefaults: defaults, current: refs, changed, elsewhere })
      if (!plan.open.length && !plan.close.length && !plan.activate) return
      const used = new Set(allRecs().map((r) => r.id))
      const realRec = (type: string, params: Record<string, unknown>, by?: 'rule'): LeafRec => {
        const def = getView(type)!
        const id = def.singleton && !used.has(type) ? type : makeId(type, used)
        used.add(id)
        return { id, type, loc: 'right', params: { ...params }, title: label(def.displayName), ...(by ? { by } : {}) }
      }
      const kept = list.filter((r) => !plan.close.includes(r.id)).map((r) => (real.length ? r : realRec(r.type, r.params)))
      const next = arrangeRight(g.group, kept, (t) => {
        const o = plan.open.find((x) => x.type === t)
        return o ? realRec(o.type, o.params ?? {}, 'rule') : undefined
      })
      const wantFront = plan.activate ? next.find((r) => r.type === plan.activate)?.id : undefined
      const stillThere = next.some((r) => r.id === s.rightActiveId) || extras.some((r) => r.id === s.rightActiveId)
      set({ rightLeaves: [...next, ...extras], rightActiveId: wantFront ?? (stillThere ? s.rightActiveId : next[0]?.id ?? null) })
      get().refreshTabs()
    },
    setApi: () => { /* 移动端无 Dockview api，恒 null */ },
    setWideMode: (v) => set({ wideMode: v }),
    setDefaultBuilder: (fn) => set({ defaultBuilder: fn }),
    setSidebarDefaults: (d) => set({ sidebarDefaults: d }),
    // Dockview「可拖宽侧栏画像」:单列无侧栏宽度,只认 key —— 它就是屏上布局的归属(同桌面版:画像重设 = 布局从此归这个 Space,
    // 调用方紧接着还原 / 重建 / 认领它)。模块变量不进 store:不触发重渲与自动存盘。
    setSideProfile: (key) => { profileKey = key; restoredOwner = undefined },
    initializeSidebar: (side, visible) => set({ [side === 'left' ? 'leftVisible' : 'rightVisible']: visible } as Partial<WS>),
    registerChatSurface: (id, el) => set((s) => {
      const next = { ...s.chatSurfaces }
      if (el) next[id] = el; else delete next[id]
      return { chatSurfaces: next }
    }),
    syncPanelState: () => { /* 无 Dockview 异步布局，无需回同步 */ },

    refreshTabs: () => {
      const s = get()
      const mk = (r: LeafRec, active: boolean): MainTab => {
        const def = getView(r.type)
        return {
          id: r.id, type: r.type,
          title: r.title || (def ? label(def.displayName) : r.type),
          active, closable: def?.closable !== false && !guarded(r),
          sessionId: typeof r.params.sessionId === 'string' ? r.params.sessionId : undefined,
          followActive: r.params.followActive !== false,
          filePath: typeof r.params.notePath === 'string' ? r.params.notePath : typeof r.params.path === 'string' ? r.params.path : undefined,
          front: active, // 单列壳同一时刻只显示一个主区 leaf → 前台即活动
          sig: identitySig(r.params), // 就地换文件也算一次跳转,见桌面版同名字段
        }
      }
      const side = (arr: LeafRec[], activeId: string | null): SideTab[] => arr.map((r) => {
        const def = getView(r.type)
        return { type: r.type, title: r.title || (def ? label(def.displayName) : r.type), active: r.id === activeId, closable: def?.closable !== false && !guarded(r) }
      })
      set({
        mainTabs: s.mainLeaves.map((r) => mk(r, r.id === s.activeMainId)),
        leftTabs: side(s.leftLeaves, s.leftActiveId),
        rightTabs: side(s.rightLeaves, s.rightActiveId),
      })
      // 主区前台视图的组变了 → 右栏按主视图规则对账(推一拍:这里常在开 / 换视图的半路上)
      const rg = IS_MINI_PANEL ? null : rightGroupNow(get())
      if (rg && rg.key !== rightKey && !rightQueued) {
        rightQueued = true
        queueMicrotask(() => {
          rightQueued = false
          try { get().applyRightRules() } catch (e) { console.error('[lcl] right panel rules', e) }
        })
      }
    },

    openView(type, params = {}, loc = 'main', opts) {
      if (IS_MINI_PANEL) {
        const target = routeMiniView({ type, params })
        if (!target) return null
        type = target.type
        params = target.params ?? {}
        loc = 'main'
        opts = undefined // Mini has one content surface, never tabs or drawers.
      }
      // 可能同步换了 Space(moved):下面一律现读 get()
      const moved = loc === 'main' && !IS_MINI_PANEL && beforeMainOpen?.(type) === true
      const def = getView(type)
      // singleton 复用(跨桶;reuseKey 语义对齐桌面)
      if (def?.singleton) {
        const reuseKey = params.reuseKey
        const existing = allRecs().find((r) => {
          if (r.type !== type) return false
          if (reuseKey === undefined) return true
          return r.params.reuseKey === reuseKey || (reuseKey === 'primary' && r.params.reuseKey === undefined && r.params.followActive !== false)
        })
        if (existing) {
          // 被带到这个 Space 来开的(moved),而这里现成的那个钉着另一份(聊天钉住了别的会话):就地换成要开的这份。
          // 只切过去的话显示的还是原来那份。跟随档的不动 —— 它本来就随「当前会话」显示要开的那条。
          const idp = def.idParam
          if (moved && idp && params[idp] != null && existing.params.followActive === false && existing.params[idp] !== params[idp]) { setActive(existing.loc, existing.id); return swapRec(existing, type, params) }
          if (IS_MINI_PANEL || reuseKey === 'primary') { set((s) => ({ [bucketOf(existing.loc)]: s[bucketOf(existing.loc)].map((r) => r.id === existing.id ? { ...r, params: { ...r.params, ...params } } : r) } as Partial<WS>)) }
          setActive(existing.loc, existing.id)
          if (existing.loc === 'main') autoCloseDrawers()
          get().refreshTabs()
          return leaf(existing)
        }
      }
      // 主区默认「就地导航」:替换当前 active 主 leaf(浏览器/Obsidian 式;newTab 显式新建)。
      if (loc === 'main' && !opts?.newTab && get().activeMainId) {
        return get().navigateLeaf(get().activeMainId as string, type, params)
      }
      // 侧栏同侧同类型复用
      if (loc !== 'main') {
        const bucket = get()[bucketOf(loc)]
        const ex = bucket.find((r) => r.type === type)
        if (ex) { setActive(loc, ex.id); get().refreshTabs(); return leaf(ex) }
      }
      // 新建 leaf
      const rec: LeafRec = {
        id: def?.singleton ? type : makeId(type, allRecs().map((r) => r.id)),
        type, loc, params, title: def ? label(def.displayName) : type,
      }
      set((s) => ({ [bucketOf(loc)]: [...s[bucketOf(loc)], rec] } as Partial<WS>))
      set({ [activeKeyOf(loc)]: rec.id } as Partial<WS>)
      if (type === 'chat') set({ focusedChatLeafId: rec.id })
      if (loc === 'main') autoCloseDrawers()
      get().refreshTabs()
      return leaf(rec)
    },

    navigateLeaf(leafId, type, params = {}) {
      if (IS_MINI_PANEL) {
        const target = routeMiniView({ type, params })
        if (!target) return null
        type = target.type
        params = target.params ?? {}
      }
      const rec = find(leafId)
      if (!rec || !getView(type)) return null
      // 固定 View 不被别的类型顶掉:主区改开一个新的主 leaf(同类照旧就地换);抽屉里的固定视图直接拒绝。
      if (rec.type !== type && guarded(rec)) return rec.loc === 'main' ? get().openView(type, params, 'main', { newTab: true }) : null
      return swapRec(rec, type, params)
    },

    getActiveLeaf() {
      const id = get().activeMainId
      const rec = id ? find(id) : undefined
      return rec ? leaf(rec) : null
    },
    getActiveSideLeaf(sideName) {
      const id = sideName === 'left' ? get().leftActiveId : get().rightActiveId
      const rec = id ? find(id) : undefined
      // 抽屉当前视图缺 active 指针时回退该侧第一个
      const first = (sideName === 'left' ? get().leftLeaves : get().rightLeaves)[0]
      const r = rec ?? first
      return r ? leaf(r) : null
    },
    leafById(id) { const r = find(id); return r ? leaf(r) : null },

    splitActive(_direction, paramsOverride) {
      // 移动端「分屏」= 开一个新主 leaf(全屏),复制当前 active 主 leaf 的 type+params。
      const cur = get().activeMainId ? find(get().activeMainId as string) : undefined
      if (!cur) return null
      return get().openView(cur.type, { ...cur.params, ...paramsOverride }, 'main', { newTab: true })
    },

    toggleSidebar(sideName) {
      const visKey = sideName === 'left' ? 'leftVisible' : 'rightVisible'
      const visible = get()[visKey]
      if (visible) { set({ [visKey]: false } as Partial<WS>); return }
      // 打开:桶空则按 sidebarDefaults 填充
      const bucket = get()[bucketOf(sideName)]
      if (bucket.length === 0) {
        for (const v of get().sidebarDefaults[sideName]) get().openView(v.type, v.params, sideName)
      }
      set({ [visKey]: true } as Partial<WS>)
      get().refreshTabs()
    },
    showSideView(sideName, type) {
      const visKey = sideName === 'left' ? 'leftVisible' : 'rightVisible'
      if (!get()[visKey]) get().toggleSidebar(sideName)
      const rec = get()[bucketOf(sideName)].find((r) => r.type === type)
      if (rec) setActive(sideName, rec.id); else get().openView(type, {}, sideName)
      get().refreshTabs()
    },

    activateLeaf(id) {
      const rec = find(id)
      if (!rec) return
      setActive(rec.loc, id)
      if (rec.loc === 'main') autoCloseDrawers()
      get().refreshTabs()
    },

    closeLeaf(id, force) {
      const rec = find(id)
      if (!rec) return
      if (rec.type === '__extend') {
        const lease = drawerExtensions[rec.loc as 'left' | 'right']
        lease?.dismiss(); lease?.dispose(); return
      }
      if (rec.type === 'home') return // 主区空态占位,不可关
      if (!force && guarded(rec)) return // 固定 View:区内最后一个关不掉(force = 清场路径)
      // 主区关掉最后一个 → 就地变 home 空态(不销毁主屏)。不走 navigateLeaf:force 关固定 View 时会被守卫拦成「另开一个 home」。
      // 两级导航下随即回列表层(空态页没什么可看),见 setAfterLayoutHook。
      if (!IS_MINI_PANEL && rec.loc === 'main' && get().mainLeaves.length <= 1) { swapRec(rec, 'home', {}); afterLayout?.(); return }
      const bkey = bucketOf(rec.loc)
      const rest = get()[bkey].filter((r) => r.id !== id)
      set({ [bkey]: rest } as Partial<WS>)
      useNav.getState().drop(id) // 同桌面版:导航历史随标签销毁(leaf id 会被下一个同类标签复用,留着的话返回键会翻出旧页)
      // 重挑该桶 active
      const akey = activeKeyOf(rec.loc)
      if (get()[akey] === id) set({ [akey]: rest[rest.length - 1]?.id ?? null } as Partial<WS>)
      if (get().focusedChatLeafId === id) {
        const otherChat = get().mainLeaves.find((r) => r.type === 'chat')
        set({ focusedChatLeafId: otherChat?.id ?? null })
      }
      get().refreshTabs()
    },

    closeViewsOfType(type, force) {
      for (const rec of allRecs().filter((r) => r.type === type)) get().closeLeaf(rec.id, force)
    },

    replaceViewsOfType(from, to, params = {}) {
      if (from === to || !getView(to)) return 0
      let n = 0
      // 同桌面版:固定 View 不被顶掉(`to` 加在它旁边,不弹开抽屉),往回换时摘掉 `from`;只有真新开 / 真摘掉才计数;
      // 固定在那一侧的默认项也不换。
      const def = getView(to)!
      for (const rec of allRecs().filter((r) => r.type === from)) {
        const keepFrom = guarded(rec)
        const bkey = bucketOf(rec.loc)
        // 「一区一个」:抽屉恒如此;主区多开同类是常态,只有牵涉固定 View 才这么算
        const unique = rec.loc !== 'main' || keepFrom || isPinned(pins(), 'main', to)
        const there = unique ? get()[bkey].find((r) => r.id !== rec.id && r.type === to) : undefined
        const wasFront = get()[activeKeyOf(rec.loc)] === rec.id
        if (there) {
          if (Object.keys(params).length) leaf(there).setParams(params)
          if (wasFront) setActive(rec.loc, there.id)
          if (!keepFrom) { get().closeLeaf(rec.id); n++ }
          continue
        }
        if (!keepFrom) { if (get().navigateLeaf(rec.id, to, params)) n++; continue }
        // ⚠️不走 openView:它的跨桶单例复用会抓到**别的桶**里的同类 leaf,把参数并过去却一个都没新开 —— Coding 的
        // studio 参数就这样漏到主区聊天上,回项目索引时那张主区聊天被当成 Coding 的对话误关(Codex 评审用真 store 复现)。
        const ids = allRecs().map((r) => r.id)
        const added: LeafRec = { id: def.singleton && !ids.includes(to) ? to : makeId(to, ids), type: to, loc: rec.loc, params: { ...params }, title: label(def.displayName) }
        set((s) => ({ [bkey]: [...s[bkey], added] } as Partial<WS>))
        if (wasFront) setActive(rec.loc, added.id)
        n++
      }
      get().refreshTabs()
      const swap = (side: 'left' | 'right', list: PersistedPanel[]): PersistedPanel[] =>
        isPinned(pins(), side, from) ? list : list.map((v) => (v.type === from ? { type: to, params: { ...params } } : v))
      const d = get().sidebarDefaults
      set({ sidebarDefaults: { left: swap('left', d.left), right: swap('right', d.right) } })
      return n
    },

    remapLeaves(fn) {
      for (const rec of allRecs()) {
        const next = fn(rec.type, rec.params)
        if (next === null) get().closeLeaf(rec.id, true) // 指向的东西没了:固定 View 也关,下面补一个空白的回来
        else if (next) leaf(rec).setParams(next)
      }
      get().ensurePinned()
    },

    resetLayout() {
      restoredOwner = undefined // 默认布局按当前画像的 Space 建,不再是启动时还原出来的那份
      rightKey = null
      set({
        mainLeaves: [], leftLeaves: [], rightLeaves: [],
        activeMainId: null, leftActiveId: null, rightActiveId: null,
        leftVisible: false, rightVisible: false, focusedChatLeafId: null,
      })
      useNav.getState().reset() // 同桌面版:布局重建,旧 leaf id 的历史全失效;须在重建之前,重建时记下的栈底要留着
      get().defaultBuilder?.() // = getActiveSpace().build()（切 Space 时 spaceRegistry 已先切 id）
      dockLeftIfWide()
      // 壳挂上之前(还没有构建器)要的是默认布局:在用的那份是上一个 Space 的(切走时已原样存进它的槽),留着就会被壳还原到
      // 这个 Space 头上。清掉,挂载时落空 → 按它的默认建。只在它确实原样躺在某个槽里时清:存槽失败(配额满)时清掉就是丢了
      // 仅存的一份,宁可让它这一次穿错 Space(Codex 评审)。
      if (notLaidOut() && !IS_MINI_PANEL) try {
        const raw = localStorage.getItem(SC_LAYOUT_KEY)
        if (raw && Object.values(readJSON<Record<string, unknown>>(SC_NAMED_KEY) ?? {}).some((b) => JSON.stringify(b) === raw)) localStorage.removeItem(SC_LAYOUT_KEY)
      } catch { /* 私密模式 */ }
      get().refreshTabs()
      afterLayout?.()
    },

    saveCurrent() { if (!notLaidOut()) writeJSON(SC_LAYOUT_KEY, snapshot()) }, // 还没摆就存 = 拿空布局盖掉要还原的那份
    // 命名布局 = spaceRegistry 的每-Space 布局槽(`space:<id>`):切走时存、切回来时还原。
    saveNamed(name) {
      // 壳还没还原就切 Space(桌面快捷方式 / 补定位抢在挂载之前):这一程的现场还在在用的键里 ——
      // 存它原样,不存空快照(空快照会把冷启动刚归档的现场盖掉)。
      const blob = notLaidOut() ? readJSON<unknown>(SC_LAYOUT_KEY) : snapshot()
      if (!isBlob(blob)) return
      const all = readJSON<Record<string, SCBlob>>(SC_NAMED_KEY) ?? {}
      all[name] = blob
      writeJSON(SC_NAMED_KEY, all)
    },
    applyNamed(name) {
      return applySCBlob((readJSON<Record<string, unknown>>(SC_NAMED_KEY) ?? {})[name])
    },
    namedLayouts() { return Object.keys(readJSON<Record<string, SCBlob>>(SC_NAMED_KEY) ?? {}) },
  }
})

// 自动存盘:订阅整个 store(节流 200ms),而不是往每个 mutation 里插一行 save。
// 发令枪是 restoreSingleColumnLayout(),见其注释。
useWorkspace.subscribe(saveSoon)

/** The mobile host puts the same temporary leaf in its ordinary drawer View selector. */
const drawerExtensions: Partial<Record<'left' | 'right', { previousId: string | null; dismiss(reason?: 'dismiss' | 'layout'): void; dispose(): void }>> = {}
let extensionSerial = 0
export const presentDrawerExtension: ExtendViewPresenter = (options, dismiss) => {
  // The mobile shell has two panels. Bottom requests use its right drawer.
  const side = options.side === 'left' ? 'left' : 'right'
  drawerExtensions[side]?.dismiss('layout') // another view's extension takes this drawer
  drawerExtensions[side]?.dispose()
  const before = useWorkspace.getState()
  const bucket = side === 'left' ? 'leftLeaves' : 'rightLeaves'
  const activeKey = side === 'left' ? 'leftActiveId' : 'rightActiveId'
  const visibleKey = side === 'left' ? 'leftVisible' : 'rightVisible'
  const id = `__extend-mobile-${++extensionSerial}`
  const element = document.createElement('div')
  element.className = 'wb-extend-target'
  const rec: LeafRec = { id, type: '__extend', loc: side, params: {}, title: typeof options.title === 'function' ? options.title() : options.title }
  let disposed = false
  let unsubscribe: (() => void) | undefined
  const lease = { previousId: before[activeKey], dismiss, dispose() {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    if (drawerExtensions[side] === lease) delete drawerExtensions[side]
    nativeExtendTargets.delete(id)
    element.remove()
    const current = useWorkspace.getState()
    // A navigation/reset may already have replaced this bucket. Never restore the old Space.
    if (!current[bucket].some((r) => r.id === id)) return
    const rest = current[bucket].filter((r) => r.id !== id)
    useWorkspace.setState({ [bucket]: rest,
      [activeKey]: current[activeKey] === id ? (rest.find((r) => r.id === before[activeKey])?.id ?? rest[0]?.id ?? null) : current[activeKey],
      [visibleKey]: current[visibleKey] && (before[visibleKey] || rest.length > before[bucket].length),
    })
    useWorkspace.getState().refreshTabs()
  } }
  drawerExtensions[side] = lease
  nativeExtendTargets.set(id, element)
  useWorkspace.setState({ [bucket]: [...before[bucket], rec], [activeKey]: id,
    ...(side === 'left' ? { leftVisible: true, rightVisible: false } : { rightVisible: true, ...(!before.wideMode ? { leftVisible: false } : {}) }) })
  useWorkspace.getState().refreshTabs()
  unsubscribe = useWorkspace.subscribe((current) => {
    // The drawer was closed, or a navigation / reset replaced its Views: taken with its place, not closed on its own.
    if (!current[visibleKey] || !current[bucket].some((r) => r.id === id)) { dismiss('layout'); lease.dispose() }
  })
  return { element, titled: true, activate: () => { if (!disposed) useWorkspace.getState().activateLeaf(id) }, dispose: lease.dispose }
}
