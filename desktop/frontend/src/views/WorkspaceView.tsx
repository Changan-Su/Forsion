import { amadeusAvailable, sessionsAvailable } from '../features/runtime'
/**
 * 统一「工作区」视图 + 统一「大纲」视图 —— 会话列表 / 工作区文件 / 笔记库(以及 目录 / Amadeus 大纲)
 * 底层合并为两套共享视图。模式体全部**包裹复用**现有组件(SessionsView / FilesPanel / AmadeusPagesView /
 * TocView / AmadeusOutlineView),本文件只负责按档位挑哪一个来渲染。
 *
 * **档位由 Space 写死**(2026-10-03 锁档,用户拍板):条目的 `params.mode`(内置 Space 与配方都这么写)
 * 就是这个视图显示什么,不再跟着主区活动标签换档,头部那个切档菜单也一并撤了 —— 固定 View 的前提是
 * 「左栏永远是这个 Space 的那张列表」。条目没带 mode(老的插件配方)才回落旧的自动规则(workspaceMode.ts):
 * 主视图硬规则 → 本 Space 的默认档(SpaceDefinition.autoWorkspaceMode);右栏恒为文件。
 */
import { Fragment, useMemo, useState, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { useWorkspace, activeMainPanel, useSpaceStore, getView } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, ListFilter, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListAction, ListDropTarget, ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { LIST_ROW_MIME, ancestorsOf, buildListTree, dropCandidates, flattenLeaves, isFolder, leafCount, type ListDropPosition, type ListNode } from '@amadeus/plugins/listTree'
import { folderPadLeft } from '@amadeus/lib/treeIndent'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import { SessionsView } from './SessionsView'
import { OrbitsView } from './OrbitsView'
import { TocView } from './RightViews'
import { FilesPanel } from './chat2/FilesPanel'
import { PATHS_MIME as DRAG_MIME } from './chat2/chatDragRef'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { AmadeusPagesView, AmadeusOutlineView, ScopedPageOutline } from '../amadeusViews'
import { usePageStore } from '@amadeus/store/pageStore'
import type { WorkspaceDescriptor } from '../types'
import { autoWorkspaceMode, resolveWorkspaceModes, workspaceKeyForPath, type WorkspaceModeEx } from './workspaceMode'
import { useCodeStudio } from '../stores/codeStudioStore'
import { VaultSideSwitch } from '../components/VaultSideSwitch'
import { SidebarRow } from '../components/SidebarRow'
import { CapabilityMenu } from '../components/CapabilityMenu'
import { ContextMenu, type CtxMenu } from '../components/RightPanel'
import { resolveIcon } from '@amadeus/components/icons'
import { ensureAmadeusReady } from '../amadeusPlugins'

registerMessages({
  'wsview.all': { zh: '全部', en: 'All' },
  'wsview.noMatches': { zh: '没有匹配项', en: 'No matches' },
  'wsview.empty': { zh: '暂无内容', en: 'Nothing here yet' },
  'wsview.search': { zh: '搜索{source}', en: 'Search {source}' },
  // 占位只写「搜索」:带上源名的话,英文长名在窄栏里会被硬裁成「Search Autom」(W-14)
  'wsview.searchShort': { zh: '搜索', en: 'Search' },
  'wsview.clearSearch': { zh: '清空搜索', en: 'Clear search' },
  'wsview.filter': { zh: '筛选分类', en: 'Filter by category' },
  'wsview.clearFilter': { zh: '显示全部', en: 'Show all' },
  'wsview.actions': { zh: '{source}操作', en: '{source} actions' },
  'wsview.itemActions': { zh: '{title}的操作', en: 'Actions for {title}' },
  'wsview.resultCount': { zh: '{count} 项', en: '{count} items' },
  'wsview.rename': { zh: '重命名', en: 'Rename' },
  'wsview.renameLabel': { zh: '重命名{title}', en: 'Rename {title}' },
})

/** 当前活动主 leaf 的视图类型(订阅 mainTabs 驱动重算;焦点在侧栏时 activeMainPanel 有组内回退)。 */
function useActiveMainType(): string | null {
  useWorkspace((s) => s.mainTabs)
  const api = useWorkspace.getState().api
  const am = api ? activeMainPanel(api) : null
  return am ? (((am.params ?? {}) as { __type?: string }).__type ?? null) : null
}

/** 当前主区打开的文件绝对路径 —— 文件面板据此把它所在的工作区置顶。
 *  两个来源就够:文件预览标签页(params.path)与 Coding Space 当前文件。
 *  Amadeus 文档族不走这里:它们由 vaultCtx 合成 vault 工作区并已在顶上(见 FilesBody)。
 *  ponytail: 认不出来就 null,面板自己退回「进入的工作区」,不做视图类型穷举。 */
function useCurrentFilePath(): string | null {
  useWorkspace((s) => s.mainTabs)
  const api = useWorkspace.getState().api
  const am = api ? activeMainPanel(api) : null
  const p = (am?.params ?? {}) as { path?: unknown }
  const codeFile = useCodeStudio((s) => s.activeFile)
  if (typeof p.path === 'string' && p.path) return p.path
  return codeFile ?? null
}

/** 文件模式体:appStore 接线(≈ 原 FilesView),编辑器场景注入合成的 vault 工作区并定位笔记目录。
 *  vault 场景「进入的工作区」用本地 state(初始/跟随 vault),不写全局 activeWorkspaceKey(那是会话侧的联动)。
 *  sideFilter(左栏胶囊):cloud=只看云端工作区,local=只看本地(不混);undefined=不过滤(右栏)。 */
function FilesBody({ vaultCtx, sideFilter }: { vaultCtx: { root: string; noteDir: string | null } | null; sideFilter?: 'local' | 'cloud' }) {
  const s = useApp(useShallow((state) => ({
    workspaces: state.workspaces,
    setFilePreview: state.setFilePreview,
    activeWorkspaceKey: state.activeWorkspaceKey,
    setActiveWorkspaceKey: state.setActiveWorkspaceKey,
  })))
  const vaultKey = vaultCtx ? `vault:${vaultCtx.root}` : null
  // s.workspaces() 会读活动 Vault 快照;这里显式订阅,否则非编辑器场景切 Vault 时 useMemo 不会失效。
  const amadeusRoot = usePageStore((state) => state.vaultRoot)
  const [localKey, setLocalKey] = useState<string | null>(vaultKey)
  useEffect(() => { setLocalKey(vaultKey) }, [vaultKey])
  const workspaces = useMemo<WorkspaceDescriptor[]>(() => {
    const base = s.workspaces()
    const merged = (() => {
      if (!vaultCtx) return base
      const vaultWs: WorkspaceDescriptor = {
        key: vaultKey!,
        name: vaultCtx.root.split(/[\\/]/).filter(Boolean).pop() || 'Vault',
        kind: 'local',
        path: vaultCtx.root,
      }
      return [vaultWs, ...base.filter((w) => w.path !== vaultCtx.root)] // 同目录已是会话工作区 → 去重
    })()
    if (!sideFilter) return merged
    return merged.filter((w) => (sideFilter === 'cloud' ? w.kind === 'cloud' : w.kind !== 'cloud' && w.kind !== 'rootless'))
  }, [s, vaultCtx, vaultKey, sideFilter, amadeusRoot])
  // Coding Space:主区 focus 为工作台时,点文件不另开 wsfile tab,而是喂给主区 Code 面板(codeStudioStore)。
  const mainType = useActiveMainType()
  const onOpenPreview = mainType === 'code-studio'
    ? (target: PreviewTarget): void => { if (target.path) useCodeStudio.getState().openFile(target.path) }
    : s.setFilePreview
  // 置顶「当前打开文件所在的工作区」;编辑器场景的 vault 工作区本来就排在首位,直接用它。
  const curFile = useCurrentFilePath()
  const pinnedWorkspaceKey = vaultKey ?? workspaceKeyForPath(workspaces, curFile)
  return (
    <FilesPanel
      workspaces={workspaces}
      onOpenPreview={onOpenPreview}
      activeWorkspaceKey={vaultCtx ? localKey : s.activeWorkspaceKey}
      onEnterWorkspace={(key) => (vaultCtx ? setLocalKey(key) : s.setActiveWorkspaceKey(key))}
      expandToPath={vaultCtx?.noteDir ?? null}
      pinnedWorkspaceKey={pinnedWorkspaceKey}
    />
  )
}

export function WorkspaceView({ leaf, defaultMode }: ViewProps & { defaultMode?: WorkspaceModeEx }) {
  const { t } = useI18n()
  const hasNotes = amadeusAvailable()
  const hasSessions = sessionsAvailable()
  const mainType = useActiveMainType()
  const loc = leaf.loc
  // 插件列表源(P2):活着的源集合 —— 写死的档 / 回落档落到已死的源(插件被禁)时回退,
  // 不渲染死模式(与 layoutViewsAllRegistered 同类防线:params.mode 随布局持久化,可能指向已卸载的源)。
  const liveSources = usePluginStore((s) => s.listSources)
  const sourceAlive = (id: string): boolean => liveSources.some((o) => `plugin:${o.pluginId}:${o.item.id}` === id)
  // 档位 = 条目上写死的 mode(Space 定义 / 配方给的,随布局持久化);没写(= 'auto')才走下面的回落规则。
  // defaultMode:宿主给某个视图类型钉的起始档(如 inbox-list → 收件箱),布局里没存 mode 时用它(Codex 09-11 P1)。
  const raw = leaf.params.mode ?? defaultMode
  const override: WorkspaceModeEx | 'auto' =
    ((raw === 'sessions' || raw === 'orbits') && hasSessions) || raw === 'files' || (raw === 'notes' && hasNotes) ? raw
    : typeof raw === 'string' && raw.startsWith('plugin:') && sourceAlive(raw) ? (raw as WorkspaceModeEx)
    : 'auto'
  // 主视图无硬规则时落本 Space 的默认档(如 Amadeus → 笔记、Inbox → 收件箱列表源);缺省 sessions = 与其它 Space 一致。
  // 默认档指向列表源而源已死(宿主没注册 / 插件被禁)→ 当没设,退回缺省档(与 declaredLive 同一道防线)。
  const spaceAutoRaw = useSpaceStore((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId)?.autoWorkspaceMode)
  const spaceAuto = spaceAutoRaw && (!spaceAutoRaw.startsWith('plugin:') || sourceAlive(spaceAutoRaw)) ? spaceAutoRaw : undefined
  // 声明式联动(P2):主视图注册时声明的 workspaceSource(如青鸟视频视图 → 它的收藏夹源)优先于硬规则;
  // 指向的插件源已死同样回退 auto 常规路。
  const declared = mainType ? getView(mainType)?.workspaceSource ?? null : null
  const declaredLive = declared && (!declared.startsWith('plugin:') || sourceAlive(declared)) ? declared : null
  const auto = autoWorkspaceMode(loc, mainType, spaceAuto, declaredLive)
  const resolvedModes = resolveWorkspaceModes(override, auto, hasNotes)
  const availableMode = (mode: WorkspaceModeEx): WorkspaceModeEx => (mode === 'sessions' || mode === 'orbits') && !hasSessions
    ? hasNotes ? 'notes' : liveSources.length ? `plugin:${liveSources[0].pluginId}:${liveSources[0].item.id}` : 'files'
    : mode
  const mode = availableMode(resolvedModes.active)

  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath) // v4 不设 activePage
  // 编辑器场景的文件模式:定位到笔记所在目录(顶层笔记 → 工作区根,无需展开)。
  const vaultCtx = useMemo(() => {
    if (mode !== 'files' || mainType !== 'amadeus-editor' || !vaultRoot) return null
    const segs = (activePage ?? '').split(/[\\/]/).filter(Boolean)
    segs.pop()
    return { root: vaultRoot, noteDir: segs.length ? `${vaultRoot}/${segs.join('/')}` : null }
  }, [mode, mainType, vaultRoot, activePage])

  // 左栏胶囊(Local|Cloud):全局切笔记 vault + 过滤会话/文件到对应侧(不混);右栏不显示、不过滤。
  const vaultSide = usePageStore((s) => s.vaultSide)
  const sideFilter = loc === 'left' && window.amadeusSync ? vaultSide : undefined

  const pluginSrc = mode.startsWith('plugin:')
    ? liveSources.find((o) => `plugin:${o.pluginId}:${o.item.id}` === mode)?.item ?? null
    : null

  const body: ReactNode =
    pluginSrc ? <PluginListBody key={mode} src={pluginSrc} stateKey={mode} />
    : mode === 'orbits' ? <OrbitsView sideFilter={sideFilter} />
    : mode === 'sessions' ? <SessionsView sideFilter={sideFilter} />
    : mode === 'files' ? <FilesBody vaultCtx={vaultCtx} sideFilter={sideFilter} />
    : hasNotes ? <AmadeusPagesView />
    : <div className="t2sw-empty">{t('workspace.notesUnavailable')}</div>

  return (
    <div className="t2sw">
      {loc === 'left' && <VaultSideSwitch />}
      <div className="t2sw-body">{body}</div>
    </div>
  )
}

/** 插件列表源的渲染体(P2):**统一左栏 UI 承载插件数据** —— 顶部动作、可选中分组(文件夹)、
 *  搜索、条目行、右键菜单,全部用会话/笔记列表同一套类(t2s-srow / t2s-search / t2s-lead),
 *  插件只出数据不出 UI。行可以带层级(`parent` + 文件夹行,画法与笔记树的文件夹相同)、
 *  可以在列表里拖动、可以就地改名;静态分组头可以开合。开合状态由宿主记,移动与改名由插件做。搜索词与选中分组由宿主持有,经 items({query, group}) 回传给插件,
 *  插件对 UI 保持无状态。
 *  拖放同理:落区由宿主判形/点亮/解析落点,**接不接由插件自己声明**(可选的 `drop` 字段,
 *  不声明就完全没有 DnD)—— 宿主不替插件决定它的列表意味着什么。 */
/** 列表源行首图标:有 iconUrl 就画远程小图(平台 favicon),取不到再退词表图标。
 *  key={iconUrl} 由调用方给 —— 换了地址要重新试一次,别让上一张的失败态粘住。 */
function LeadIcon({ item }: { item: ListItem }): ReactNode {
  const [failed, setFailed] = useState(false)
  if (item.iconUrl && !failed) {
    // ⚠️ 尺寸必须内联:`.t2s-lead-icon` 的宽高规则挂在 `.t2s-side` 下,而列表源容器是 `.t2sw-plug`
    //    (dockview 面板,外面没有 `.t2s-side`)—— 只给类名,favicon 会按 .ico 原始尺寸(32/48px)撑爆行。
    //    1em 两边都对:无 `.t2s-side` 时 = 行字号 13px(与词表 svg 同大),有则 = --t2s-icon。
    return <img className="t2s-lead-icon" style={{ width: '1em', height: '1em', objectFit: 'contain', borderRadius: 3 }} src={item.iconUrl} alt="" onError={() => setFailed(true)} />
  }
  return resolveIcon(item.icon, <FileText className="t2s-lead-icon t2s-dim" />)
}

const OPEN_KEY = 'amx.plug.open.'
/** 分组与文件夹的开合记忆。纯本地的观感偏好,和 sectionOpen.ts 一样只存 localStorage。
 *  id 由调用处拼:`s:<分组名>` / `f:<行 key>`;没存过的用调用处给的缺省(分组展开、文件夹收起)。 */
function useOpenState(stateKey: string): { isOpen(id: string, fallback: boolean): boolean; setOpen(id: string, open: boolean): void } {
  const [map, setMap] = useState<Record<string, boolean>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(OPEN_KEY + stateKey) || '{}')
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, boolean>) : {}
    } catch { return {} }
  })
  const setOpen = (id: string, open: boolean): void => setMap((m) => {
    if (m[id] === open) return m
    const next = { ...m, [id]: open }
    try { localStorage.setItem(OPEN_KEY + stateKey, JSON.stringify(next)) } catch { /* 隐私模式 / 配额满:记不住也别崩 */ }
    return next
  })
  return { isOpen: (id, fallback) => (typeof map[id] === 'boolean' ? map[id] : fallback), setOpen }
}

/** 行内改名的输入框:回车 / 失焦提交,Esc 取消;输入法组词时的回车不算提交。只回报一次。 */
function RenameInput({ title, label, onDone }: { title: string; label: string; onDone(next: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const finish = (next: string | null): void => { if (done.current) return; done.current = true; onDone(next) }
  return <input ref={ref} className="t2s-rename" aria-label={label} defaultValue={title}
    onClick={(e) => e.stopPropagation()}
    onBlur={(e) => finish(e.currentTarget.value)}
    onKeyDown={(e) => {
      e.stopPropagation() // 列表的方向键导航不接管输入框里的按键
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value) }
      if (e.key === 'Escape') { e.preventDefault(); finish(null) }
    }} />
}

const cls = (...parts: Array<string | false | null | undefined>): string | undefined => parts.filter(Boolean).join(' ') || undefined
/** 方向键能走到的行:普通行、文件夹行、分组头。 */
const NAV_ROWS = '.t2s-srow, .t2s-folder-row, .t2sw-plug-sec'

/** stateKey:开合记忆按它分开存(WorkspaceView 给 `plugin:<插件>:<源>`);不给就用源自己的 id。 */
export function PluginListBody({ src, stateKey }: { src: ListSourceContribution; stateKey?: string }) {
  const { t } = useI18n()
  const [, force] = useReducer((x: number) => x + 1, 0)
  // ⚠️vault 懒引导 × 插件在启动期激活 = 列表源恒空(2026-08-28 用户实报,青鸟收藏夹):
  //   插件在 bootstrapEngine 就装好了,那一刻还没有活动库,它启动时那次索引读取拿到的是
  //   `readTextFile` 的**静默 null**(主进程 `if (!vault.getRoot()) return null`),此后无人重读。
  //   两道一起补:①这里 ensureAmadeusReady() 把库唤起来(与 AgentDesk 同一处方);
  //   ②订阅 effect 以 vaultRoot 为键 —— 库落地/切库(Local↔Cloud)都重订阅,插件借机重读。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  useEffect(() => { if (amadeusAvailable()) ensureAmadeusReady() }, [])
  useEffect(() => src.subscribe(() => force()), [src, vaultRoot])
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const menuOpener = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const open = useOpenState(stateKey ?? src.id)
  const [renaming, setRenaming] = useState<string | null>(null)
  // 行在列表里被拖动:dragover 阶段读不到载荷,正在拖的那几行记在这里(只认本列表发起的拖动)。
  const dragKeys = useRef<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ key: string; position: ListDropPosition } | null>(null)
  // 源换了(插件切换/禁用重启)→ 过滤态跟着重置,免得拿旧源的分组键去查新源。
  useEffect(() => { setQuery(''); setGroup(null); setMenu(null); setRenaming(null) }, [src])

  const groups = src.groups?.() ?? []
  const activeGroup = groups.find((item) => item.key === group)
  // Sources may remove an empty category after archive/delete; never leave a hidden stale filter.
  useEffect(() => { if (group && !activeGroup) setGroup(null) }, [group, activeGroup?.key])
  const items = src.items({ query: query || undefined, group: activeGroup?.key })
  const actions = src.actions ?? []
  const primary = actions.find((action) => action.primary) ?? actions[0]
  const secondary = [...actions.filter((action) => action !== primary).map((action) => ({ ...action, id: `action:${action.id}` })),
    ...(src.groupActions ?? []).map((action) => ({ ...action, id: `group:${action.id}` }))]
  const activeKey = src.activeKey?.() ?? null
  // 层级:行靠 parent 挂到上一级下面。搜索时不画层级,去掉文件夹、按行平铺(和笔记树搜索时一样)。
  const tree = buildListTree(items)
  const roots: ListNode[] = query ? flattenLeaves(tree).map((item) => ({ item, children: [] })) : tree
  // 无 groups() 声明时,退回按 item.group 的静态分区(老契约行为);分区看的是最上面那一级的 group。
  const sections = useMemo(() => {
    if (groups.length) return null
    const m = new Map<string, ListNode[]>()
    for (const node of roots) {
      const g = node.item.group ?? ''
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(node)
    }
    return [...m.entries()]
  }, [items, groups.length, query])

  // 当前打开的那一行换了 → 把它上面的各级文件夹和所在分组展开一次,免得它藏在收起的文件夹里。
  // 只在换行时做:之后用户自己收起来就让它收着。行还没到(异步加载)就等它到了再开。
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!activeKey || revealed.current === activeKey) return
    const self = items.find((it) => it.key === activeKey)
    if (!self) return
    revealed.current = activeKey
    const ups = ancestorsOf(items, activeKey)
    for (const key of ups) open.setOpen('f:' + key, true)
    const top = ups.length ? items.find((it) => it.key === ups[ups.length - 1]) : self
    if (top?.group) open.setOpen('s:' + top.group, true)
  })

  // 落区接缝:dragover 阶段浏览器不让读 getData(只给 types),故点亮看 types、真取数据在 drop。
  const canTake = (dt: DataTransfer): boolean => {
    const acc = src.drop?.accepts ?? []
    const types = Array.from(dt.types ?? [])
    return (acc.includes('files') && types.includes('Files')) || (acc.includes('paths') && types.includes(DRAG_MIME))
  }
  const payloadOf = (dt: DataTransfer): { files?: File[]; paths?: string[] } | null => {
    const acc = src.drop?.accepts ?? []
    const files = Array.from(dt.files ?? [])
    if (acc.includes('files') && files.length) return { files }
    if (acc.includes('paths')) {
      try {
        const paths: unknown = JSON.parse(dt.getData(DRAG_MIME) || 'null')
        if (Array.isArray(paths) && paths.length) return { paths: paths as string[] }
      } catch { /* 不是本家载荷,当没有 */ }
    }
    return null
  }
  /** 一个落区的三件套;插件没声明 drop 就是空对象 = 这一层完全没有 DnD。 */
  const dropProps = (key: string, target: { group?: string; item?: ListItem }): Record<string, unknown> =>
    src.drop
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!canTake(e.dataTransfer)) return
            e.preventDefault(); e.stopPropagation()
            e.dataTransfer.dropEffect = 'copy'
            if (dropKey !== key) setDropKey(key)
          },
          onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
          onDrop: (e: React.DragEvent) => {
            if (!canTake(e.dataTransfer)) return
            e.preventDefault(); e.stopPropagation()
            setDropKey(null)
            const p = payloadOf(e.dataTransfer)
            if (p) void src.drop!.onDrop(p, target)
          },
        }
      : {}

  // ── 行在列表里拖动('items')。宿主只判落点、画提示,真正的移动由插件在 onDrop 里做。──
  const takesItems = !!src.drop?.accepts.includes('items')
  const endDrag = (): void => { dragKeys.current = null; setDragging(null); setDropAt(null) }
  /** 搜索时列表是压平的,前后关系没有意义,不让拖;正在改名的那一行也不拖。 */
  const dragProps = (it: ListItem): Record<string, unknown> =>
    takesItems && it.draggable && !query && renaming !== it.key
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent<HTMLElement>) => {
            e.stopPropagation()
            e.dataTransfer.setData(LIST_ROW_MIME, it.key)
            e.dataTransfer.effectAllowed = 'move'
            // 用行自身作拖影并按抓取点对齐(同笔记树:默认拖影会让内容与光标错位)。
            const r = e.currentTarget.getBoundingClientRect()
            e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
            dragKeys.current = [it.key]
            setDragging(it.key)
          },
          onDragEnd: endDrag,
        }
      : {}
  /** 指针在这一行上时落在哪:按行内位置给出候选,逐个问插件,第一个被接受的算数。
   *  不落在自己身上,也不落进自己下面。 */
  const landing = (e: React.DragEvent<HTMLElement>, it: ListItem): ListDropTarget | null => {
    const keys = dragKeys.current
    if (!keys || !src.drop) return null
    if (keys.includes(it.key) || ancestorsOf(items, it.key).some((key) => keys.includes(key))) return null
    const r = e.currentTarget.getBoundingClientRect()
    for (const position of dropCandidates(r.height ? (e.clientY - r.top) / r.height : 0.5, isFolder(it))) {
      const target: ListDropTarget = { item: it, position }
      if (src.drop.canDrop?.({ items: keys }, target) !== false) return target
    }
    return null
  }
  /** 一行的落区:本列表里拖来的行走 landing;外面拖来的文件 / 路径仍走 dropProps。 */
  const rowDropProps = (it: ListItem): Record<string, unknown> => {
    const outer = dropProps(`i:${it.key}`, { item: it }) as {
      onDragOver?(e: React.DragEvent): void; onDragLeave?(): void; onDrop?(e: React.DragEvent): void
    }
    if (!src.drop) return {}
    return {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!dragKeys.current) { outer.onDragOver?.(e); return }
        const to = landing(e, it)
        if (!to) { setDropAt((d) => (d?.key === it.key ? null : d)); return }
        e.preventDefault(); e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropAt((d) => (d && d.key === it.key && d.position === to.position ? d : { key: it.key, position: to.position! }))
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        outer.onDragLeave?.()
        // 在这一行内部的子元素之间移动不算离开
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDropAt((d) => (d?.key === it.key ? null : d))
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        const keys = dragKeys.current
        if (!keys) { outer.onDrop?.(e); return }
        const to = landing(e, it)
        endDrag()
        if (!to) return
        e.preventDefault(); e.stopPropagation()
        void src.drop!.onDrop({ items: keys }, to)
      },
    }
  }

  const closeMenu = (): void => {
    setMenu(null)
    menuOpener.current?.focus({ preventScroll: true })
  }
  /** 一行的菜单 = 插件给的动作 + 宿主的「重命名」(排在危险动作之前)。 */
  const menuFor = (it: ListItem): ListAction[] => {
    const own = src.itemMenu?.(it) ?? []
    if (!src.rename || !it.renamable) return own
    const rename: ListAction = { id: '__rename', label: t('wsview.rename'), run: () => setRenaming(it.key) }
    const cut = own.findIndex((action) => action.danger)
    return cut < 0 ? [...own, rename] : [...own.slice(0, cut), rename, ...own.slice(cut)]
  }
  const contextMenu = (actions: ListAction[]) => (e: React.MouseEvent<HTMLElement>): void => {
    if (!actions.length) return
    e.preventDefault(); e.stopPropagation()
    menuOpener.current = e.currentTarget
    setMenu({ x: e.clientX, y: e.clientY, items: actions.map((action) => ({ label: action.label, danger: action.danger, run: action.run })) })
  }
  const menuItems = (actions: ListAction[]) => actions.map((action) => ({ id: action.id, label: action.label, danger: action.danger, onSelect: action.run }))
  const finishRename = (it: ListItem, next: string | null): void => {
    setRenaming(null)
    const title = next?.trim()
    if (title && title !== it.title) void src.rename?.(it, title)
  }
  const renameInput = (it: ListItem): ReactNode =>
    <RenameInput title={it.title} label={t('wsview.renameLabel', { title: it.title })} onDone={(next) => finishRename(it, next)} />

  // Keep the shared row, with an independent sibling menu button (never nest buttons).
  const row = (it: ListItem, depth: number): ReactNode => {
    const actions = menuFor(it)
    const editing = renaming === it.key
    const at = dropAt?.key === it.key ? dropAt.position : null
    return <div className={cls('t2sw-plug-item', at === 'before' && 'drop-before', at === 'after' && 'drop-after', dragging === it.key && 'dragging')} key={it.key}>
      {/* 改名时行里是输入框,input 不能嵌在 button 里 → 换成 div */}
      <SidebarRow as={editing ? 'div' : 'button'} depth={depth} data-row-key={it.key}
        title={it.title}
        className={`${activeKey === it.key ? 'active' : ''}${it.unread ? ' is-unread' : ''}${dropKey === `i:${it.key}` ? ' amx-drop-into' : ''}${actions.length ? ' has-actions' : ''}`.trim() || undefined}
        {...rowDropProps(it)} {...dragProps(it)}
        lead={<><LeadIcon key={it.iconUrl ?? ''} item={it} />{it.unread && <span className="t2s-dot unread" title={t('sidebar.unread')} />}</>}
        trailing={!editing && it.hint ? <span className="t2s-count">{it.hint}</span> : undefined}
        onClick={editing ? undefined : (e) => src.open(it, { newTab: e.metaKey || e.ctrlKey })}
        onContextMenu={contextMenu(actions)}
      >{editing ? renameInput(it) : <span className="t2s-srow-title">{it.title}</span>}</SidebarRow>
      {!!actions.length && !editing && <CapabilityMenu label={t('wsview.itemActions', { title: it.title })} className="t2sw-plug-row-menu"
        items={menuItems(actions)}><MoreHorizontal size={14} /></CapabilityMenu>}
    </div>
  }
  // 文件夹行:与笔记树的文件夹同一套结构与类名(前导槽里图标 ↔ 悬停换箭头,行尾「更多」和「+」)。
  const folder = (n: ListNode, depth: number): ReactNode => {
    const it = n.item
    const isOpen = open.isOpen('f:' + it.key, false)
    const actions = menuFor(it)
    const add = actions.find((action) => action.primary)
    const at = dropAt?.key === it.key ? dropAt.position : null
    const icon = it.icon ? resolveIcon(it.icon, <Folder className="t2s-lead-icon" />) : isOpen ? <FolderOpen className="t2s-lead-icon" /> : <Folder className="t2s-lead-icon" />
    return <div key={it.key}>
      <div className={cls('t2s-group', at === 'into' && 'amx-drop-into', at === 'before' && 'drag-over', at === 'after' && !isOpen && 'drag-over below', dragging === it.key && 'dragging')}
        style={{ paddingLeft: folderPadLeft(depth) }} {...rowDropProps(it)} {...dragProps(it)} onContextMenu={contextMenu(actions)}>
        {renaming === it.key
          ? <div className="t2s-group-toggle t2s-folder-row"><span className="t2s-lead">{icon}</span>{renameInput(it)}</div>
          : <button type="button" className="t2s-group-toggle t2s-folder-row" data-row-key={it.key} title={it.title} aria-expanded={isOpen}
              onClick={() => open.setOpen('f:' + it.key, !isOpen)}>
              <span className="t2s-lead">{icon}<span className={`t2s-chev t2s-lead-chev${isOpen ? ' open' : ''}`}><ChevronRight size={12} /></span></span>
              <span className="t2s-group-label">{it.title}</span>
              {it.hint && <span className="t2s-count">{it.hint}</span>}
            </button>}
        {/* 只有「+」那一项时不再画「更多」(右键菜单里照样有) */}
        {actions.some((action) => !action.primary) && <CapabilityMenu label={t('wsview.itemActions', { title: it.title })} className="t2s-group-add"
          items={menuItems(actions)}><MoreHorizontal size={14} /></CapabilityMenu>}
        {add && <button type="button" className="t2s-group-add" title={add.label} aria-label={add.label}
          onClick={() => { open.setOpen('f:' + it.key, true); add.run() }}><Plus size={14} /></button>}
      </div>
      {/* 展开着的文件夹,「排在它后面」的线画在它整块的下沿 */}
      {isOpen && <div className={cls('t2s-group-sessions', at === 'after' && 'drag-over-end')}>{n.children.map((child) => node(child, depth + 1))}</div>}
    </div>
  }
  const node = (n: ListNode, depth: number): ReactNode =>
    isFolder(n.item) ? folder(n, depth)
    : n.children.length ? <Fragment key={n.item.key}>{row(n.item, depth)}{n.children.map((child) => node(child, depth + 1))}</Fragment>
    : row(n.item, depth)
  // 分组头:点一下开合并记住;缺省展开(老列表不变样)。搜索时一律展开,不改记下的状态。
  const section = (g: string, list: ListNode[]): ReactNode => {
    if (g === '') return <div key="__flat">{list.map((n) => node(n, 1))}</div>
    const isOpen = !!query || open.isOpen('s:' + g, true)
    return <div key={g}>
      <button type="button" className="t2sw-plug-sec" aria-expanded={isOpen} onClick={() => { if (!query) open.setOpen('s:' + g, !isOpen) }}>
        <span className="t2sw-plug-sec-name"><span className="t2s-group-label">{g}</span><span className={`t2s-chev${isOpen ? ' open' : ''}`}><ChevronRight size={12} /></span></span>
        <span className="t2s-count">{leafCount(list)}</span>
      </button>
      {isOpen && list.map((n) => node(n, 1))}
    </div>
  }

  return (
    <div className="t2sw-plug">
      {(src.search || primary || secondary.length > 0) && <div className="t2sw-plug-toolbar">
        {src.search && <div className="t2s-search">
          <Search size={13} className="t2s-dim" />
          <input ref={searchRef} aria-label={t('wsview.search', { source: src.title })} placeholder={t('wsview.searchShort')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery('') }
              if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>('.t2s-srow')?.focus() }
            }} />
          {query && <button type="button" aria-label={t('wsview.clearSearch')} title={t('wsview.clearSearch')}
            onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={12} /></button>}
        </div>}
        {primary && <button type="button" className="t2sw-plug-btn" title={primary.label} onClick={() => primary.run()}>{primary.label}</button>}
        {!!secondary.length && <CapabilityMenu label={t('wsview.actions', { source: src.title })} className="t2sw-plug-overflow"
          items={secondary.map((action) => ({ id: action.id, label: action.label, danger: action.danger, onSelect: action.run }))}><MoreHorizontal size={15} /></CapabilityMenu>}
      </div>}
      {!!groups.length && <div className="t2sw-plug-filterbar">
        <CapabilityMenu label={t('wsview.filter')} className="t2sw-plug-filter" selection acceptsDrag={src.drop ? canTake : undefined}
          searchLabel={groups.length > 8 ? t('wsview.filter') : undefined}
          items={[
            { id: '__all', label: t('wsview.all'), selected: !activeGroup, onSelect: () => setGroup(null), ...dropProps('g:all', {}) },
            ...groups.map((g) => ({ id: `group:${g.key}`, label: g.title, hint: g.count === undefined ? undefined : String(g.count),
              icon: resolveIcon(g.icon), selected: group === g.key, onSelect: () => setGroup(g.key),
              dropActive: dropKey === `g:${g.key}`, ...dropProps(`g:${g.key}`, { group: g.key }),
            })),
          ]}>
          <ListFilter size={13} /><span>{activeGroup?.title ?? t('wsview.all')}</span><ChevronDown size={12} />
        </CapabilityMenu>
        {activeGroup && <button type="button" className="t2sw-plug-reset" title={t('wsview.clearFilter')} aria-label={t('wsview.clearFilter')} onClick={() => setGroup(null)}><X size={12} /></button>}
        <span className="t2sw-plug-total" aria-live="polite">{t('wsview.resultCount', { count: items.length })}</span>
      </div>}
      <div ref={listRef} className={`t2sw-plug-list${dropKey === 'list' ? ' amx-drop-into' : ''}`} data-under-dock=""
        {...dropProps('list', { group: activeGroup?.key })}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches(NAV_ROWS)) return
          const key = event.target.dataset.rowKey
          const it = key === undefined ? undefined : items.find((item) => item.key === key)
          if (event.key === 'F2' && it && src.rename && it.renamable) { event.preventDefault(); setRenaming(it.key); return }
          if (it && isFolder(it) && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault(); open.setOpen('f:' + it.key, event.key === 'ArrowRight'); return
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(NAV_ROWS))
          const index = rows.indexOf(event.target as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          event.preventDefault(); rows[next]?.focus()
        }}>
        {sections ? sections.map(([g, list]) => section(g, list)) : roots.map((n) => node(n, 1))}
        {items.length === 0 && <div className="t2sw-empty">{query ? t('wsview.noMatches') : t('wsview.empty')}</div>}
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} autoFocus />}
    </div>
  )
}

/** 统一「大纲」视图:主视图=chat → 会话目录(DOM 扫描);=编辑器 → 笔记标题大纲(块模型);其他 → 空态。
 *
 *  `params.sourcePath` 在场 = **自带身份**(仪表盘大纲卡):不跟随活动主视图,直接给那篇笔记开大纲。
 *  没有它的时候,这个视图在仪表盘里必然落空态(`useActiveMainType()` 读到的是 'dashboard')——
 *  那正是 2026-08-25 用户实报的「大纲卡永远空白」,见方案 §6.4 C 类。 */
export function OutlineView(props: Partial<ViewProps> = {}) {
  const { t } = useI18n()
  const mainType = useActiveMainType()
  const src = typeof props.params?.sourcePath === 'string' ? props.params.sourcePath : ''
  if (src && amadeusAvailable()) return <ScopedPageOutline path={src} scope={`${props.leaf?.id ?? 'outline'}::src`} />
  if (mainType === 'chat') return <TocView />
  if (mainType === 'amadeus-editor' && amadeusAvailable()) return <AmadeusOutlineView />
  return <div className="t2sw-empty">{t('outline.empty')}</div>
}
