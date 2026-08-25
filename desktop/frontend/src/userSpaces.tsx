/** 用户自定义 Space(L0 数据 Space):~/.tangu/spaces/<slug>/space.json → registerSpace。
 *  设计:Space=纯数据布局配方(只组合已注册视图,无信任问题,可自建/market 分发);
 *  新视图代码/后端能力属于 Space App(L1:前端编进主包由包门控,后端走 tangu-plugin),不在此层。
 *  本文件只做 L0:装载 / 另存为 / 删除;market 装完 type='space' 由 MarketModal 再调 loadUserSpaces() 热注册。
 *  仅桌面(window.tangu.spacesList);Tangu Web 缺省不装载。 */
import {
  Bot, Inbox, Mail, NotebookText, BookOpen, Briefcase, CalendarDays, MessageCircle, Folder, FolderOpen,
  FileText, Star, Heart, Home, Target, Zap, Globe, Music, Image, Video, Code, Terminal, LayoutGrid, Sparkles,
  Boxes, ListTree,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon, setActiveSpace, useSpaceStore,
  useWorkspace, deleteNamedLayout, getActiveSpace, getView, label, spaceLayoutName,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel } from '@lcl/engine'
import { SpaceButton } from './spaces'
import { parseSpaceJson, slugifyId, uniqueId, type SpaceSpec, type SpacePanelSpec } from '@lcl/spaces/userSpaces.core'
import { useApp } from './stores/appStore'
import { currentLocale } from './i18n'
import { track } from './achievements/store'
import { act } from './activity/log'
import { readDisabledPluginIds } from '@amadeus/plugins/pluginStore'

const BUILTIN_IDS = ['tangu', 'inbox', 'amadeus'] as const
/** 精选图标表(space.json 的 icon 字段按名取):刻意不做 lucide 全量动态查找(bundle 爆炸)。 */
const SPACE_ICONS: Record<string, LucideIcon> = {
  bot: Bot, inbox: Inbox, mail: Mail, 'notebook-text': NotebookText, 'book-open': BookOpen, briefcase: Briefcase,
  'calendar-days': CalendarDays, 'message-circle': MessageCircle, folder: Folder, 'folder-open': FolderOpen,
  'file-text': FileText, star: Star, heart: Heart, home: Home, target: Target, zap: Zap, globe: Globe,
  music: Music, image: Image, video: Video, code: Code, terminal: Terminal, 'layout-grid': LayoutGrid,
  sparkles: Sparkles, boxes: Boxes, 'list-tree': ListTree,
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

export const isUserSpace = (id: string): boolean => userIds.has(id)

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
  if (!spec.version) return // 没声明版本 = 老配方,不介入(丢布局的代价比不更新大)
  let map: Record<string, string> = {}
  try { map = JSON.parse(localStorage.getItem(RECIPE_VER_KEY) || '{}') } catch { /* 坏值当空 */ }
  if (typeof map !== 'object' || !map) map = {}
  const prev = map[spec.id]
  if (prev === spec.version) return
  // 首见(prev === undefined)也算「换过」:这份配方此前从没按版本记过,可能正是升级前装的那版。
  // 但只有**确实存在保存布局**时才需要丢——否则下次进入本来就会 build()。
  if (useWorkspace.getState().namedLayouts().includes(spaceLayoutName(spec.id))) {
    deleteNamedLayout(spaceLayoutName(spec.id))
    // 正在这个 Space 里 → 立刻按新配方重建,不必等用户切走再切回。
    if (useSpaceStore.getState().activeSpaceId === spec.id) useWorkspace.getState().resetLayout()
  }
  map[spec.id] = spec.version
  try { localStorage.setItem(RECIPE_VER_KEY, JSON.stringify(map)) } catch { /* 配额满:下次再试 */ }
}

function specToDefinition(spec: SpaceSpec): SpaceDefinition {
  const sides: SpaceDefinition['sidebarDefaults'] = { left: toPanels(spec.layout.left), right: toPanels(spec.layout.right) }
  return {
    id: spec.id,
    name: specName(spec),
    icon: SPACE_ICONS[spec.icon ?? ''] ?? Boxes,
    sidebarDefaults: sides,
    build() {
      ws().setSidebarDefaults(sides)
      for (const p of spec.layout.main) ws().openView(p.type, p.params ?? {}, 'main')
      for (const side of ['left', 'right'] as const) {
        for (const p of sides[side]) ws().openView(p.type, p.params, side)
        if (!sides[side].length) ws().initializeSidebar(side, false) // 无默认内容 → 收起(toggle 展开落占位)
      }
    },
  }
}

function installUserSpace(spec: SpaceSpec, dirSlug: string = spec.id): void {
  migrateRecipeLayout(spec)
  const def = specToDefinition(spec)
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
function installPluginSpace(spec: SpaceSpec, pluginId: string): void {
  migrateRecipeLayout(spec)
  const def = specToDefinition(spec)
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
async function loadUserSpacesOnce(): Promise<void> {
  const list = await window.tangu?.spacesList?.().catch(() => null)
  if (!list) return // 无桥(Web/移动)→ 不装载;空数组仍需走注销分支(最后一个插件被卸时清干净)
  const appVersion = await window.tangu?.appVersion?.().catch(() => null) ?? null
  const disabled = new Set(readDisabledPluginIds())

  // 想要的最终集合:解析全部配方,禁用插件的条目排除;同 spec id 先到先得(用户目录在前)。
  const wanted = new Map<string, { spec: SpaceSpec; dirSlug: string; plugin?: string; raw: string }>()
  for (const { slug, json, plugin } of list) {
    if (plugin && disabled.has(plugin)) continue
    const r = parseSpaceJson(json, { isViewRegistered: (t) => !!getView(t), appVersion, reservedIds: BUILTIN_IDS })
    if (!r.ok) { console.warn(`[spaces] 跳过 ${slug}: ${r.error}`); continue }
    if (!wanted.has(r.spec.id)) wanted.set(r.spec.id, { spec: r.spec, dirSlug: slug, plugin, raw: json })
  }

  // 先注销:此前注册的插件 Space,如今主人被禁用/卸载、文件消失,或**配方内容变了**(插件更新,
  // codex P1-7)→ 撤下;内容不变则不动。用户 Space 不在此列(删除走 deleteUserSpace)。
  for (const [id, owner] of [...pluginSpaceOwner]) {
    const w = wanted.get(id)
    if (!w || w.plugin !== owner || pluginSpaceJson.get(id) !== w.raw) removePluginSpace(id)
  }

  const taken = new Set(useSpaceStore.getState().spaces.map((s) => s.id))
  for (const [id, w] of wanted) {
    if (taken.has(id)) continue // 已注册(重复 reload / 两目录同 id,先到先得)
    taken.add(id)
    if (w.plugin) {
      installPluginSpace(w.spec, w.plugin)
      pluginSpaceJson.set(id, w.raw)
    } else {
      installUserSpace(w.spec, w.dirSlug) // 目录名可与 id 不同(market 目录来自上架名称 slug)
    }
  }
  // 启动恢复时活动 Space 可能正是刚注册的用户 Space:installEngine 曾按 fallback(tangu)设过侧栏默认,补正。
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
    const loc = (params.__loc as 'main' | 'left' | 'right' | undefined) ?? 'main'
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

/** 删除用户 Space:活动中则先切回 tangu,再 注销+撤 ribbon+清命名布局+删磁盘目录(按 id→目录映射)。 */
export async function deleteUserSpace(id: string): Promise<void> {
  const dirSlug = userIds.get(id)
  if (!dirSlug) return
  if (useSpaceStore.getState().activeSpaceId === id) setActiveSpace('tangu')
  unregisterSpace(id)
  removeRibbonIcon(`space:${id}`)
  deleteNamedLayout(spaceLayoutName(id))
  userIds.delete(id)
  try { await window.tangu?.spacesDelete?.(dirSlug) } catch (e) { app().toast(String(e)) }
}
