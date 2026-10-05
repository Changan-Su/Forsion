import { windowKind } from './windowKind'
/** 用户自定义 Space(L0 数据 Space):~/.tangu/spaces/<slug>/space.json → registerSpace。
 *  设计:Space=纯数据布局配方(只组合已注册视图,无信任问题,可自建/market 分发);
 *  新视图代码/后端能力属于 Space App(L1:前端编进主包由包门控,后端走 tangu-plugin),不在此层。
 *  本文件只做 L0:装载 / 另存为 / 删除;market 装完 type='space' 由 MarketModal 再调 loadUserSpaces() 热注册。
 *  仅桌面(window.tangu.spacesList);Tangu Web 缺省不装载。 */
import {
  Bot, Inbox, Mail, NotebookText, BookOpen, Briefcase, CalendarDays, MessageCircle, Folder, FolderOpen,
  FileText, Star, Heart, Home, Target, Zap, Globe, Music, Image, Video, Code, Terminal, LayoutGrid, Sparkles,
  Boxes, ListTree, Server, ServerCog,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon, setActiveSpace, useSpaceStore,
  useWorkspace, deleteNamedLayout, clearLayout, getActiveSpace, getView, label, spaceLayoutName,
  setActiveSpaceCold, BOOT_ACTIVE_SPACE_ID, UI_MODE,
  spaceLayoutsWereReset, bootLayoutFellThrough, namedLayoutRestorable, liveLayoutOwner,
} from '@lcl/engine'
import type { Leaf, SpaceDefinition, SpaceIcon, PersistedPanel } from '@lcl/engine'
import { SpaceButton } from './components/SpaceButton'
import { panelToast } from './components/PanelNotice'
import { ipcErrorText } from './ipcError'
import { parseSpaceJson, planMainPanels, slugifyId, uniqueId, recipeBucketOf, type SpaceSpec, type SpacePanelSpec } from '@lcl/spaces/userSpaces.core'
import { useApp } from './stores/appStore'
import { currentLocale } from './i18n'
import { track } from './achievements/store'
import { act } from './activity/log'
import { readDisabledPluginIds } from '@amadeus/plugins/pluginStore'
import { hasBottomPanel } from './pluginViews'
import { PRODUCT } from './product'
import { LAST_EXIT_SPACE, awaitedStartupSpace, resolveStartupTarget, startupSpacePref } from './spaces'

// 保留 id:用户/市场的 space.json 不许占用宿主 Space 的 id。calendar 现在是内置插件(关掉即不注册),
// 更要留着 —— 否则关掉期间被别人占了 id,重新启用时两份 Space 撞车。
const BUILTIN_IDS = ['tangu', 'inbox', 'amadeus', 'calendar', 'muse'] as const

/** 精选图标表(space.json 的 icon 字段按名取):刻意不做 lucide 全量动态查找(bundle 爆炸)。 */
const SPACE_ICONS: Record<string, LucideIcon> = {
  bot: Bot, inbox: Inbox, mail: Mail, 'notebook-text': NotebookText, 'book-open': BookOpen, briefcase: Briefcase,
  'calendar-days': CalendarDays, 'message-circle': MessageCircle, folder: Folder, 'folder-open': FolderOpen,
  'file-text': FileText, star: Star, heart: Heart, home: Home, target: Target, zap: Zap, globe: Globe,
  music: Music, image: Image, video: Video, code: Code, terminal: Terminal, 'layout-grid': LayoutGrid,
  sparkles: Sparkles, boxes: Boxes, 'list-tree': ListTree, server: Server, 'server-cog': ServerCog,
}

/** 自绘图标(space.json 的 `iconFile`;主进程验过并读成 data URL)→ 与 lucide 同签名的组件,渲染点零改动。
 *  SVG = 单色蒙版:只取轮廓,颜色走 currentColor,明暗主题与选中态照常;PNG = 原色小图。
 *  两种都只当图片消费(<img> / CSS mask),SVG 里的脚本与外链不会执行。 */
/** 只收主进程产出的那两种形状。设备页的清单来自对端主机(/unit/spaces),别把任意串放进 src / mask。 */
const ICON_URL_RE = /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/

export function imageIcon(url: string): SpaceIcon {
  const mask = `url("${url}") center / contain no-repeat`
  return url.startsWith('data:image/svg+xml')
    ? ({ size = 18 }) => <span aria-hidden="true" style={{ display: 'inline-block', flex: 'none', width: size, height: size, background: 'currentColor', mask, WebkitMask: mask }} />
    : ({ size = 18 }) => <img aria-hidden="true" alt="" src={url} width={size} height={size} draggable={false} style={{ flex: 'none', borderRadius: '22%', objectFit: 'cover' }} />
}

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()
/** 本进程内经此文件注册的用户 Space:id → 磁盘目录名。market 安装目录名来自上架名称的 slug,
 *  可与 space.json 的 id 不一致,删除必须按映射删目录,否则残留目录重启后复活。 */
const userIds = new Map<string, string>()
/** 插件捆绑包内嵌的 Space:spec id → 所属插件 id。随插件启停显隐,不落 userIds(不可单独删,卸载随插件走)。 */
const pluginSpaceOwner = new Map<string, string>()
/** 已注册插件 Space 的原始 space.json:配方变了(插件更新)才注销重注册,不变则不动(防 ribbon 无谓抖动)。 */
const pluginSpaceJson = new Map<string, string>()
/** 已注册插件 Space 的自绘图标:只换了图就原地重注册(不走注销那条 —— 它会把正在用的 Space 打回 tangu)。 */
const pluginSpaceIcon = new Map<string, string | undefined>()
let pluginOnlyStartupResolved = false
/** Recipe migrations can happen after WorkspaceHost has already restored the previous run's current layout:
 * plugin views and their bundled Spaces are loaded asynchronously. Keep the migration pending until the
 * startup target is actually registered, then clear/rebuild the live workbench in one step. */
const pendingRecipeLayouts = new Set<string>()
let asyncStartupSpaceResolved = false
/** 启动点名的 Space 还没注册,人先落在回落 Space 上等它(补定位没结案)。 */
let parkedOnFallback = false

export const isUserSpace = (id: string): boolean => userIds.has(id)

/** bootstrapEngine 把人落在回落 Space 上之后调:此后活动 Space 一变 —— 用户自己切(哪怕又切了回来)、宿主把他带去别处 ——
 *  就算他接管了导航,补定位结案,点名的那个到了也不拽他。从落位那一刻就记,不等第一趟补定位(配方装载慢的时候,那之前的
 *  一次往返会漏掉;Codex 评审)。补定位自己把人带过去时也会触发,那时本来就该结案。 */
export function parkOnStartupFallback(): void {
  parkedOnFallback = true
  const off = useSpaceStore.subscribe((s, p) => { if (s.activeSpaceId !== p.activeSpaceId) { off(); asyncStartupSpaceResolved = true } })
}

function specName(spec: SpaceSpec): () => string {
  return () => {
    if (typeof spec.name === 'string') return spec.name
    const n = currentLocale() === 'zh' ? (spec.name.zh ?? spec.name.en) : (spec.name.en ?? spec.name.zh)
    return n ?? spec.id
  }
}

const toPanels = (list: SpacePanelSpec[]): PersistedPanel[] => list.map((p) => ({ type: p.type, params: p.params ?? {} }))

/** 配方版本迁移:`space.json` 的 layout 换了新版,但 setActiveSpace 恒「有保存布局就用保存布局」
 *  (刻意设计:进 Space 回到上次的样子)——于是**用过该 Space 的用户永远看不到新配方**。
 *  这里在注册前比对已应用的配方版本,变了就丢弃该 Space 的命名布局,让下次进入走 build() 重建。
 *  只在 version 真的变化时动手:用户自己调的布局照常保存,不受影响。 */
const RECIPE_VER_KEY = 'forsion_space_recipe_ver'
function migrateRecipeLayout(spec: SpaceSpec): void {
  if (windowKind() === 'mini') return // Mini never migrates or resets full workspace layouts.
  if (!spec.version) return // 没声明版本 = 老配方,不介入(丢布局的代价比不更新大)
  let map: Record<string, string> = {}
  try { map = JSON.parse(localStorage.getItem(RECIPE_VER_KEY) || '{}') } catch { /* 坏值当空 */ }
  if (typeof map !== 'object' || !map) map = {}
  const prev = map[spec.id]
  if (prev === spec.version) return
  // 首见(prev === undefined)也算「换过」:这份配方此前从没按版本记过,可能正是升级前装的那版。
  // deleteNamedLayout 对空槽幂等；无论有没有命名槽都记 pending，因为上次退出的 Space 还可能只剩
  // 一份「当前布局」并已在插件异步注册前被 WorkspaceHost 恢复。
  deleteNamedLayout(spaceLayoutName(spec.id))
  pendingRecipeLayouts.add(spec.id)
  // 已经完整注册且正在使用的普通热更新仍可当场重建。启动期异步 Space 此时通常被暂时
  // 归一到了产品默认 Space，交给 settleAsyncStartupSpace() 在冷定位后再重建。
  if (useSpaceStore.getState().activeSpaceId === spec.id) useWorkspace.getState().resetLayout()
  map[spec.id] = spec.version
  try { localStorage.setItem(RECIPE_VER_KEY, JSON.stringify(map)) } catch { /* 配额满:下次再试 */ }
}

function specToDefinition(spec: SpaceSpec, iconUrl?: string): SpaceDefinition {
  const sides: SpaceDefinition['sidebarDefaults'] = { left: toPanels(spec.layout.left), right: toPanels(spec.layout.right), bottom: toPanels(spec.layout.bottom ?? []) }
  return {
    id: spec.id,
    mini: spec.mini ? { ...spec.mini, name: spec.mini.name ? specName({ ...spec, name: spec.mini.name }) : undefined } : undefined,
    name: specName(spec),
    icon: iconUrl ? imageIcon(iconUrl) : SPACE_ICONS[spec.icon ?? ''] ?? Boxes,
    sidebarDefaults: sides,
    // 配方条目上的 pinned:true → 固定 View(引擎按 Space 声明现判,不进布局存档)
    pinned: { main: toPanels(spec.layout.main.filter((p) => p.pinned)), left: toPanels(spec.layout.left.filter((p) => p.pinned)), right: toPanels(spec.layout.right.filter((p) => p.pinned)) },
    bottomSpan: spec.layout.bottomSpan,
    build() {
      ws().setSidebarDefaults(sides)
      // 主区默认仍是兼容旧配方的「同组标签」。条目显式写 split:right/down 时,先复制上一项的原生
      // Dockview 组,再把复制出的 leaf 就地导航成目标视图 —— 这样分栏、拖宽、标签与持久化全走宿主原语,
      // 不在插件 DOM 里再造一套假分栏。splitFrom 可指定前面某一项,表达「左侧上下、右侧通高」。
      const opened: Leaf[] = []
      for (const step of planMainPanels(spec.layout.main)) {
        let leaf = null
        if (step.mode === 'first') leaf = ws().openView(step.panel.type, step.panel.params ?? {}, 'main')
        else if (step.mode === 'tab') leaf = ws().openView(step.panel.type, step.panel.params ?? {}, 'main', { newTab: true })
        else {
          const anchor = opened[step.from]
          if (anchor) ws().activateLeaf(anchor.id)
          const shell = anchor ? ws().splitActive(step.direction) : null
          leaf = shell
            ? ws().navigateLeaf(shell.id, step.panel.type, step.panel.params ?? {})
            : ws().openView(step.panel.type, step.panel.params ?? {}, 'main', { newTab: true })
        }
        if (leaf) opened.push(leaf)
      }
      if (opened.length > 1 && opened[0]) ws().activateLeaf(opened[0].id)
      for (const side of ['left', 'right'] as const) {
        for (const p of sides[side]) ws().openView(p.type, p.params, side)
        if (!sides[side].length) ws().initializeSidebar(side, false) // 无默认内容 → 收起(toggle 展开落占位)
      }
      // 配方声明了底部内容 = 主视图要和它一起用(如视频时间线)→ 默认展开;没声明则照旧不碰底部。
      // 用户关掉后 mod+J 按 sidebarDefaults.bottom 把它开回来。单列壳没有底部面板(它的 bucketOf 把 bottom
      // 归进主区,开出来会把主视图导航走)→ 不开;按 store 实判,安卓原生构建的 UI_MODE 可能仍是 desktop。
      if (hasBottomPanel()) for (const p of sides.bottom ?? []) ws().openView(p.type, p.params, 'bottom')
    },
  }
}

function installUserSpace(spec: SpaceSpec, dirSlug: string = spec.id, iconUrl?: string): void {
  migrateRecipeLayout(spec)
  const def = specToDefinition(spec, iconUrl)
  registerSpace(def)
  userIds.set(spec.id, dirSlug)
  addRibbonIcon({
    id: `space:${spec.id}`,
    side: 'top',
    component: ({ expanded }) => (
      <span
        style={{ display: 'contents' }}
        onContextMenu={(e) => {
          e.preventDefault()
          if (window.confirm(app().tr('spaces.deleteConfirm', { name: label(def.name) }))) void deleteUserSpace(spec.id)
        }}
      >
        <SpaceButton space={def} expanded={expanded} />
      </span>
    ),
  })
}

/** 插件 Space 注册:同 installUserSpace 但不进 userIds(不可右键删除——生命周期随插件),悬停提示来源。 */
function installPluginSpace(spec: SpaceSpec, pluginId: string, iconUrl?: string): void {
  migrateRecipeLayout(spec)
  const def = specToDefinition(spec, iconUrl)
  registerSpace(def)
  pluginSpaceOwner.set(spec.id, pluginId)
  addRibbonIcon({
    id: `space:${spec.id}`,
    side: 'top',
    component: ({ expanded }) => <SpaceButton space={def} expanded={expanded} />,
  })
}

/** 注销一个插件 Space(不删磁盘,不清命名布局——重新启用插件即原样回来)。 */
function removePluginSpace(id: string): void {
  if (useSpaceStore.getState().activeSpaceId === id) setActiveSpace('tangu')
  unregisterSpace(id)
  removeRibbonIcon(`space:${id}`)
  pluginSpaceOwner.delete(id)
  pluginSpaceJson.delete(id)
  pluginSpaceIcon.delete(id)
}

/** 扫 ~/.tangu/spaces + 各插件捆绑包 spaces/ 装载全部合法配方(幂等:已注册 id 跳过;
 *  用户目录条目在列表前面,同 id 用户版本胜)。插件 Space 随插件启停显隐:本函数每次调用都会
 *  把「主人被禁用/已卸载」的插件 Space 注销,故插件启停/卸载后重调即同步。market 装完 space 后再调即热注册。 */
let loadChain: Promise<void> = Promise.resolve()
export function loadUserSpaces(): Promise<void> {
  // 串行化:现在有多个触发点(启动、插件装载完、market/设置/引导),并发跑会「一边注销一边注册」——
  // removePluginSpace 顺手把活动 Space 打回 tangu,用户会看到闪一下。排队跑即无此窗口。
  loadChain = loadChain.catch(() => {}).then(loadUserSpacesOnce)
  return loadChain
}

/** Finish startup after an asynchronous user/plugin Space becomes available.
 *
 * This used to live only in bootstrapEngine's first `loadUserSpaces()` callback. A bundled Space whose
 * required plugin view registered later missed that callback: its id was cold-restored afterwards while
 * Dockview kept the already-restored legacy layout. Recipe version had nevertheless been stamped, so the
 * stale UI survived every restart. Both bootstrap and the external-plugin completion path call this helper;
 * it resolves exactly once, and a pending recipe migration clears persistence before rebuilding.
 * A pass that only finds the fallback of a named-but-unregistered startup Space does not count as that once. */
export function settleAsyncStartupSpace(): void {
  if (asyncStartupSpaceResolved || windowKind() !== 'main' || UI_MODE === 'mobile') return
  const want = resolveStartupTarget(BOOT_ACTIVE_SPACE_ID)
  const state = useSpaceStore.getState()
  if (!state.spaces.some((space) => space.id === want)) return

  // 固定档 / 主位档点名的 Space 还没注册 → want 只是回落值,启动已经落在它上面(bootstrapEngine,只改内存)。这一趟照常往下走
  // (纯插件产品的画像在下面补),但**不结案**:插件比第一趟配方装载晚装完时(两者只差几毫秒,真 Electron 重载 60 次里 2 次),
  // 点名的那个到下一趟才注册 —— 以前在这里结了案,它注册上来也没人再把用户带过去,窗口停在回落 Space(10-04 实报)。
  // 它永远不来(插件已删)就一直不结案,每一趟都是空转。等的这段时间里用户接管了导航 → parkOnStartupFallback 的订阅结案,
  // 走不到这里。结案只进不退:下面只在 final 时置真,从不写回假。
  const final = awaitedStartupSpace() === null
  // 回落之后才等到它,屏上是回落 Space 的现场(Dockview 没就绪就谈不上现场),用户可能已经在里面动过(多开了标签)。
  const late = final && parkedOnFallback && !!ws().api

  // 「上次退出」档下,盘上的活动 id 在补定位之前只有用户自己切 Space(setActiveSpace)才会变 —— 回落只改内存。
  // 变了 = 屏上是他刚选的那个 Space 的现场:不再把他拽回去,更不能拿归档 / 重建盖掉它(那份现场只在布局键里,
  // 盖了就丢;Codex 评审)。
  if (startupSpacePref() === LAST_EXIT_SPACE) {
    let onDisk: string | null = null
    try { onDisk = localStorage.getItem('forsion_tangu_active_space') } catch { /* 隐私模式:当没动过 */ }
    if (onDisk !== null && onDisk !== want) { asyncStartupSpaceResolved = true; return }
  }

  // 配方升了版本 → 重建。升级那次的一次性重置(spaces.tsx registerSpaces)同理:当前布局键已清,onReady 摆出来的是
  // **回落 Space** 的默认布局,不是本 Space 的现场 —— 只换活动 id 的话界面标着本 Space、内容却是回落 Space 的,
  // 切走时还会把它存进 space:<本 Space>(Codex 评审)。
  const migrated = pendingRecipeLayouts.delete(want) || (spaceLayoutsWereReset() && state.activeSpaceId !== want)
  const configure = (): void => {
    const space = getActiveSpace()
    if (!space) return
    ws().setSidebarDefaults(space.sidebarDefaults)
    ws().setSideProfile(space.id, space.resizableSides ?? {}, space.sideDefaultScale, space.bottomSpan)
    ws().setPinned(space.pinned)
  }

  // late 不走这条:「清布局键 + 重建」是给「屏上是本 Space 的旧布局」准备的,屏上是回落 Space 的现场时会把用户在回落期间的
  // 改动一起丢掉(Codex 评审;check:spacefallback 的 R)。走下面的正常切换 —— setActiveSpace 先把它存进它自己的槽,
  // 本 Space 的槽已被迁移 / 重置清掉,照新配方重建。
  if (migrated && !late) {
    // Clear the current-layout blob too, not only `space:<id>`. If Dockview is already mounted resetLayout
    // replaces the live legacy tree; if it is not, onReady sees the cleared blob and builds the new recipe.
    clearLayout()
    if (state.activeSpaceId !== want) setActiveSpaceCold(want)
    configure()
    ws().resetLayout()
    if (final) asyncStartupSpaceResolved = true
    return
  }

  if (state.activeSpaceId !== want) {
    if (startupSpacePref() === LAST_EXIT_SPACE && !late) {
      const liveOwner = liveLayoutOwner() // 屏上这份布局是给谁摆的。取在 configure() 之前:它一重设画像,归属就成了 want
      setActiveSpaceCold(want)
      configure()
      // 「布局键里本来就是它的现场」只在屏上那份布局确实归它时才成立(纯内置视图的用户 Space:onReady 原样还原出来)。另两种不是:
      //  · 现场里有插件视图、而插件比 Dockview 就绪得晚(实测就是这个顺序)→ 那次还原落空,屏上是回落 Space 的默认布局;
      //  · 上一程本 Space 始终没就位(插件没装上 / 没等到它就退出了)→ 布局键里是回落 Space 的,onReady 原样还原了**它**。
      // 只换 id 的话界面标着本 Space、内容是回落 Space 的,下次启动还会把它归档进 space:<本 Space>。把归档的那份现场
      // (adoptSpaceLayoutCold 在本 Space 最后一次是主人的那一程写的)补还原回来;归档里还有别的没注册上的视图(另一个
      // 插件这次没装上)就不硬套,按本 Space 的默认重建 —— 口径同启动还原。
      // liveOwner 为 null = 还原的是老存档(没记归属):照升级前,信它就是本 Space 的。
      // ponytail: 屏上那份回落 Space 的布局不存进它的槽(分不清是原样的默认还是用户动过的,见 adoptSpaceLayoutCold)。
      if (bootLayoutFellThrough() || (liveOwner !== null && liveOwner !== want)) {
        const archived = spaceLayoutName(want)
        if (namedLayoutRestorable(archived) && ws().applyNamed(archived)) { ws().ensurePinned(); ws().saveCurrent() }
        else ws().resetLayout()
      } else {
        // onReady 已按回落 Space 的 bottomSpan 摆过还原出来的布局 → 按本 Space 重摆(Dockview 未就绪则 no-op)
        ws().realignRegions?.()
      }
    } else setActiveSpace(want)
  } else if (ws().sideProfileKey !== want) {
    // 纯插件产品(PRODUCT.spaces 为空):bootstrap 时一个 Space 都没有,画像(含 bottomSpan)从没按它设过(Codex 评审)
    configure()
    ws().realignRegions?.()
  }
  if (final) asyncStartupSpaceResolved = true
}
async function loadUserSpacesOnce(): Promise<void> {
  const list = await window.tangu?.spacesList?.().catch(() => null)
  if (!list) return // 无桥(Web/移动)→ 不装载;空数组仍需走注销分支(最后一个插件被卸时清干净)
  const appVersion = await window.tangu?.appVersion?.().catch(() => null) ?? null
  const disabled = new Set(readDisabledPluginIds())

  // 想要的最终集合:解析全部配方,禁用插件的条目排除;同 spec id 先到先得(用户目录在前)。
  const wanted = new Map<string, { spec: SpaceSpec; dirSlug: string; plugin?: string; raw: string; iconUrl?: string }>()
  for (const { slug, json, plugin, iconUrl: rawIcon } of list) {
    const iconUrl = typeof rawIcon === 'string' && ICON_URL_RE.test(rawIcon) ? rawIcon : undefined
    if (plugin && disabled.has(plugin)) continue
    const r = parseSpaceJson(json, { isViewRegistered: (t) => !!getView(t), appVersion, reservedIds: BUILTIN_IDS })
    if (!r.ok) { console.warn(`[spaces] 跳过 ${slug}: ${r.error}`); continue }
    if (!wanted.has(r.spec.id)) wanted.set(r.spec.id, { spec: r.spec, dirSlug: slug, plugin, raw: json, iconUrl })
  }

  // 先注销:此前注册的插件 Space,如今主人被禁用/卸载、文件消失,或**配方内容变了**(插件更新,
  // codex P1-7)→ 撤下;内容不变则不动。用户 Space 不在此列(删除走 deleteUserSpace)。
  for (const [id, owner] of [...pluginSpaceOwner]) {
    const w = wanted.get(id)
    if (!w || w.plugin !== owner || pluginSpaceJson.get(id) !== w.raw) removePluginSpace(id)
  }

  const taken = new Set(useSpaceStore.getState().spaces.map((s) => s.id))
  for (const [id, w] of wanted) {
    if (taken.has(id)) { // 已注册(重复 reload / 两目录同 id,先到先得)
      // 插件更新只换了图(space.json 一字未动):registerSpace / addRibbonIcon 都按 id 替换,原地重装即可,
      // 活动 Space、用户排的位置都不动。
      if (w.plugin && pluginSpaceOwner.get(id) === w.plugin && pluginSpaceIcon.get(id) !== w.iconUrl) {
        installPluginSpace(w.spec, w.plugin, w.iconUrl)
        pluginSpaceIcon.set(id, w.iconUrl)
      }
      continue
    }
    taken.add(id)
    if (w.plugin) {
      installPluginSpace(w.spec, w.plugin, w.iconUrl)
      pluginSpaceJson.set(id, w.raw)
      pluginSpaceIcon.set(id, w.iconUrl)
    } else {
      installUserSpace(w.spec, w.dirSlug, w.iconUrl) // 目录名可与 id 不同(market 目录来自上架名称 slug)
    }
  }
  // 启动恢复时活动 Space 可能正是刚注册的用户 Space:installEngine 曾按 fallback(tangu)设过侧栏默认,补正。
  // A plugin-only product has no synchronous fallback Space. Activate its default
  // once plugin views and recipes are ready, using the ordinary Space switch path.
  if (!pluginOnlyStartupResolved && PRODUCT.spaces.length === 0
    && useSpaceStore.getState().spaces.some((s) => s.id === PRODUCT.defaultSpace)) {
    pluginOnlyStartupResolved = true
    if (useSpaceStore.getState().activeSpaceId !== PRODUCT.defaultSpace) setActiveSpace(PRODUCT.defaultSpace)
    // mainTabs is shared by Dockview and SingleColumnHost (whose api is always null).
    else if (ws().mainTabs.length === 0) ws().resetLayout()
  }
  const sp = getActiveSpace()
  if (sp) ws().setSidebarDefaults(sp.sidebarDefaults)
}

/** 各视图类型允许进配方的 params(其余如 sessionId/notePath/path 是机器特定状态,不进配方)。 */
const PARAM_KEEP: Record<string, string[]> = { workspace: ['mode'], chat: ['followActive', 'reuseKey'] }
/** 不进配方的视图:临时页(launcher)/机器特定内容页(wsfile)/占位(sidebar-empty、主区空态 home)。 */
const SKIP_TYPES = new Set(['launcher', 'wsfile', 'sidebar-empty', 'home'])

/** 把当前布局序列化成配方并落盘+注册(另存为 Space)。 */
export async function saveCurrentAsSpace(name: string): Promise<void> {
  const api = ws().api
  if (!api || !window.tangu?.spacesSave) return
  const layout: SpaceSpec['layout'] = { main: [], left: [], right: [] }
  const seen = new Set<string>()
  for (const p of api.panels) {
    const params = (p.params ?? {}) as Record<string, unknown>
    // 落桶判定抽到 @lcl/spaces(纯函数 + 单测):这里以前是 `as 'main'|'left'|'right'` 硬转,
    // 断言骗过了类型检查 —— 引擎加了 'bottom' 之后 layout['bottom'] 是 undefined,`.push` 当场抛。
    const loc = recipeBucketOf(params.__loc)
    if (!loc) continue // bottom 不进配方(见 recipeBucketOf 注释)
    const type = typeof params.__type === 'string' ? params.__type : ''
    if (!type || SKIP_TYPES.has(type) || seen.has(`${loc}:${type}`)) continue
    seen.add(`${loc}:${type}`)
    const keep: Record<string, unknown> = {}
    for (const k of PARAM_KEEP[type] ?? []) if (params[k] !== undefined) keep[k] = params[k]
    layout[loc].push(Object.keys(keep).length ? { type, params: keep } : { type })
  }
  if (!layout.main.length) layout.main.push({ type: 'chat', params: { followActive: true, reuseKey: 'primary' } })
  const taken = new Set<string>([...BUILTIN_IDS, ...useSpaceStore.getState().spaces.map((s) => s.id)])
  const id = uniqueId(slugifyId(name), taken)
  const spec: SpaceSpec = { id, name, icon: 'boxes', layout }
  await window.tangu.spacesSave(id, JSON.stringify(spec, null, 2))
  track('space.save'); act('space.save', { id })
  installUserSpace(spec)
  app().toast(app().tr('spaces.saved', { name }))
}

/** 新建空白 Space:落一个只含启动器的配方 + 注册 + 切过去,用户往里摆视图(布局自动记住)。 */
export async function createBlankSpace(name: string): Promise<void> {
  if (!window.tangu?.spacesSave) return
  const taken = new Set<string>([...BUILTIN_IDS, ...useSpaceStore.getState().spaces.map((s) => s.id)])
  const id = uniqueId(slugifyId(name) || 'space', taken)
  const spec: SpaceSpec = { id, name, icon: 'boxes', layout: { main: [{ type: 'launcher' }], left: [], right: [] } }
  await window.tangu.spacesSave(id, JSON.stringify(spec, null, 2))
  track('space.save'); act('space.save', { id, blank: true })
  installUserSpace(spec)
  setActiveSpace(id)
  app().toast(app().tr('spaces.saved', { name }))
}

/** 删除用户 Space:先删磁盘目录(按 id→目录映射),成功后再 活动中则切回 tangu + 注销 + 撤 ribbon + 清命名布局。
 *  磁盘先行:删失败(权限 / 占用)时 Space 原样留着、可以重试 —— 反过来先撤界面的话,目录还在、
 *  入口却没了,要重启才冒回来(Codex 评审)。返回是否删成,设置页据此决定报不报「已卸载」。 */
export async function deleteUserSpace(id: string): Promise<boolean> {
  const dirSlug = userIds.get(id)
  if (!dirSlug) return false
  try { await window.tangu?.spacesDelete?.(dirSlug) } catch (e) { panelToast(ipcErrorText(e), true); return false }
  forgetUserSpace(id)
  // 设置是独立浮窗(每窗一份注册表 / ribbon):主窗那份由主窗自己撤。主窗自己删时这条会回到自己,forget 幂等。
  window.tangu?.requestMainAction?.('space-removed', id)
  return true
}

/** 撤掉本窗口里已删用户 Space 的痕迹(活动中则切回 tangu + 注销 + 撤 ribbon + 清命名布局);不认识的 id 不动。 */
export function forgetUserSpace(id: string): void {
  if (!userIds.has(id)) return
  if (useSpaceStore.getState().activeSpaceId === id) setActiveSpace('tangu')
  unregisterSpace(id)
  removeRibbonIcon(`space:${id}`)
  deleteNamedLayout(spaceLayoutName(id))
  userIds.delete(id)
}
