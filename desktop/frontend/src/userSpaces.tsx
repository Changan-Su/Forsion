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

export const isUserSpace = (id: string): boolean => userIds.has(id)

function specName(spec: SpaceSpec): () => string {
  return () => {
    if (typeof spec.name === 'string') return spec.name
    const n = currentLocale() === 'zh' ? (spec.name.zh ?? spec.name.en) : (spec.name.en ?? spec.name.zh)
    return n ?? spec.id
  }
}

const toPanels = (list: SpacePanelSpec[]): PersistedPanel[] => list.map((p) => ({ type: p.type, params: p.params ?? {} }))

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

/** 扫 ~/.tangu/spaces 装载全部合法配方(幂等:已注册 id 跳过)。market 装完 space 后再调即热注册。 */
export async function loadUserSpaces(): Promise<void> {
  const list = await window.tangu?.spacesList?.().catch(() => null)
  if (!list?.length) return
  const appVersion = await window.tangu?.appVersion?.().catch(() => null) ?? null
  const taken = new Set(useSpaceStore.getState().spaces.map((s) => s.id))
  for (const { slug, json } of list) {
    const r = parseSpaceJson(json, { isViewRegistered: (t) => !!getView(t), appVersion, reservedIds: BUILTIN_IDS })
    if (!r.ok) { console.warn(`[spaces] 跳过 ${slug}: ${r.error}`); continue }
    if (taken.has(r.spec.id)) continue // 已注册(重复 reload / 两目录同 id,先到先得)
    taken.add(r.spec.id)
    installUserSpace(r.spec, slug) // 目录名可与 id 不同(market 目录来自上架名称 slug)
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
  track('space.save')
  installUserSpace(spec)
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
