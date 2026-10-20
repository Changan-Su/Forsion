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
import { useWorkspace, activeMainPanel, useSpaceStore, getView, useListFirst, useNativeChromeExtras, startOpenDrag, mainOpensBeside } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, ListFilter, MoreHorizontal, Pencil, Plus, Search, X } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListAction, ListDropTarget, ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { LIST_ROW_MIME, ancestorsOf, buildListTree, dropCandidates, fitsPhoneList, flattenLeaves, groupFold, isFolder, isGroupHead, leafCount, type GroupFold, type ListDropPosition, type ListNode } from '@amadeus/plugins/listTree'
import { folderPadLeft, nameLeft } from '@amadeus/lib/treeIndent'
import { initialFor } from '../components/agentInitial'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import { readTanguSidebarModes } from '../amadeus/plugins/tanguSeam'
import { TocView } from '@tangu/ui/views/RightViews'
import { FilesPanel } from '@tangu/ui/views/chat2/FilesPanel'
import { PATHS_MIME as DRAG_MIME } from '../components/chatDragRef'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { AmadeusPagesView, AmadeusOutlineView, ScopedPageOutline } from '../amadeusViews'
import { usePageStore } from '@amadeus/store/pageStore'
import type { WorkspaceDescriptor } from '../types'
import { autoWorkspaceMode, resolveWorkspaceModes, workspaceKeyForPath, type WorkspaceModeEx } from './workspaceMode'
import { useCodeStudio } from '../stores/codeStudioStore'
import { VaultSideSwitch } from '../components/VaultSideSwitch'
import { SidebarRow } from '../components/SidebarRow'
import { CapabilityMenu } from '../components/CapabilityMenu'
import { ListChips, ListFab, ListHint, PullHint, SwipeRow, closeOtherSwipes, usePullToSearch, type SwipeAction } from '../components/phoneList'
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
  // 手机的整屏列表:首次提示把这张列表自己的动作念一遍(动作名来自列表源)
  'wsview.closeSearch': { zh: '关闭搜索', en: 'Close search' },
  'wsview.phone.join': { zh: '、', en: ', ' },
  'wsview.phone.hintSwipe': { zh: '向左滑动一行：{actions}。', en: 'Swipe a row left: {actions}.' },
  'wsview.phone.hintHold': { zh: '长按右下角的按钮：{more}。', en: 'Press and hold the button at the bottom right: {more}.' },
  'wsview.phone.hintBoth': { zh: '向左滑动一行：{actions}。长按右下角的按钮：{more}。', en: 'Swipe a row left: {actions}. Press and hold the button at the bottom right: {more}.' },
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
  // 悬停预览里点的 / 从列表拖出来的(见引擎 openBeside.ts)不喂工作台:那是就地换掉它正开着的文件,走文件视图开成新标签。
  const onOpenPreview = mainType === 'code-studio'
    ? (target: PreviewTarget, opts?: { newTab?: boolean }): void => {
        if (mainOpensBeside()) s.setFilePreview(target, opts)
        else if (target.path) useCodeStudio.getState().openFile(target.path)
      }
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
  // 轨道 / 会话列表两种模式是 Tangu 交出来的(核心插件化 2e-5)。老档案(products/amadeus.json)上 sessionsAvailable() 缺省为真、
  // Tangu 却没激活:只看前者会落一片空白侧栏,所以两样都要有才算有会话模式,没有就改道到笔记 / 文件
  const tangu = readTanguSidebarModes()
  const hasSessions = sessionsAvailable() && !!tangu
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
    : mode === 'orbits' ? (tangu && <tangu.Orbits sideFilter={sideFilter} />)
    : mode === 'sessions' ? (tangu && <tangu.Sessions sideFilter={sideFilter} />)
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

/** 组头(ListItem.folderStyle: 'group')的前导:和工作区一级行同一个 30px 的槽 —— 有图用圆头像,
 *  给了词表图标就是方块里的图标,都没有就是名字的首字(同 Agent 行的兜底)。图取不到时往后退一档。 */
function GroupLead({ item }: { item: ListItem }): ReactNode {
  const [failed, setFailed] = useState(false)
  // 尺寸写在标签上(同 OrbitsView 的头像):不写的话图片按原始像素撑开
  if (item.iconUrl && !failed) return <span className="t2o-lead"><img className="t2o-avatar" width={30} height={30} src={item.iconUrl} alt="" onError={() => setFailed(true)} /></span>
  const icon = resolveIcon(item.icon)
  return icon && typeof icon !== 'string'
    ? <span className="t2o-lead t2sw-plug-gtile">{icon}</span>
    : <span className="t2o-lead"><span className="t2o-avatar t2o-avatar-text">{typeof icon === 'string' ? icon : initialFor(item.title)}</span></span>
}
/** 组头的开合记在这里:只活这一次运行(见 listTree 的 groupFold)。键 = 开合记忆的 stateKey + 行 key。 */
const GROUP_FOLDS = new Map<string, GroupFold>()
/** 一组先列几条,再多收在「查看更多」后面(和工作区每组列几条会话是同一个数)。 */
const GROUP_PAGE = 5
/** 组头前导槽 30 + 与名字的间距 8(orbits.css 的 .t2o-row)。 */
const GROUP_LEAD = 38

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
/** 方向键能走到的行:普通行、文件夹行、组头、分组头。 */
const NAV_ROWS = '.t2s-srow, .t2s-folder-row, .t2sw-plug-ghead, .t2sw-plug-sec'

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
  const [searching, setSearching] = useState(false) // 手机:搜索框平时不在,点胶囊上的搜索钮 / 下拉才出来
  // 行在列表里被拖动:dragover 阶段读不到载荷,正在拖的那几行记在这里(只认本列表发起的拖动)。
  const dragKeys = useRef<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ key: string; position: ListDropPosition } | null>(null)
  const [more, setMore] = useState<ReadonlySet<string>>(new Set()) // 点过「查看更多」的组
  // 源换了(插件切换/禁用重启)→ 过滤态跟着重置,免得拿旧源的分组键去查新源。
  useEffect(() => { setQuery(''); setGroup(null); setMenu(null); setRenaming(null); setSearching(false); setMore(new Set()) }, [src])

  const groups = src.groups?.() ?? []
  const activeGroup = groups.find((item) => item.key === group)
  // Sources may remove an empty category after archive/delete; never leave a hidden stale filter.
  useEffect(() => { if (group && !activeGroup) setGroup(null) }, [group, activeGroup?.key])
  const items = src.items({ query: query || undefined, group: activeGroup?.key })
  // 文件夹的开合:普通文件夹落盘(缺省收起);组头只记这一次运行,由插件的 defaultOpen 带着走。
  // 键带上当前的筛选:同一个源在「全部」和「已归档」里是两张不同的列表(同一个发信人在两边该不该开着并不一样),
  // 两处同时显示这个源、筛选不同的时候也就不会互相改对方的开合。
  const foldScope = `${stateKey ?? src.id}\n${activeGroup?.key ?? ''}\n`
  const foldId = (it: ListItem): string => foldScope + it.key
  // 每次渲染把这一屏所有组头的 defaultOpen 都过一遍(不只是画出来的那些:组头可能收在别的分区里);
  // 不在这一屏的组解除「已亮过」,它带着 defaultOpen 回来时算一次新的打开。搜索时列表是压平的,不动。
  if (!query) {
    const here = new Set<string>()
    for (const it of items) if (isGroupHead(it)) { here.add(foldId(it)); groupFold(GROUP_FOLDS, foldId(it), it) }
    for (const [id, fold] of GROUP_FOLDS) if (id.startsWith(foldScope) && !here.has(id)) fold.armed = false
  }
  const folderOpen = (it: ListItem): boolean => isGroupHead(it) ? groupFold(GROUP_FOLDS, foldId(it), it).open : open.isOpen('f:' + it.key, false)
  const setFolderOpen = (it: ListItem, next: boolean): void => {
    if (!isGroupHead(it)) { open.setOpen('f:' + it.key, next); return }
    groupFold(GROUP_FOLDS, foldId(it), it).open = next
    force()
  }
  const actions = src.actions ?? []
  const primary = actions.find((action) => action.primary) ?? actions[0]
  const secondary = [...actions.filter((action) => action !== primary).map((action) => ({ ...action, id: `action:${action.id}` })),
    ...(src.groupActions ?? []).map((action) => ({ ...action, id: `group:${action.id}` }))]
  const activeKey = src.activeKey?.() ?? null
  // 手机的整屏列表(布局「二」:分类胶囊、图标块 + 两行的行、左滑出操作、右下角主按钮 —— 与会话 / 笔记列表同一套零件,
  // 见 components/phoneList)。只给平铺的源,外加最多一层组头(fitsPhoneList):带普通文件夹 / 更深层级的源照旧画树
  // (树的缩进、拖放在那套版式里没有位置)。
  // 看的是没筛过的那一份 —— 筛出来的结果恰好全是顶层行时,不能因此换一套版式。
  const phone = useListFirst()
  const flatNow = phone && fitsPhoneList(query || activeGroup ? src.items() : items)
  // 正在改名时不换版式:换了行的外壳,输入框会重挂,打到一半的名字就没了(订阅推来一个文件夹时会碰上)。
  const flatHeld = useRef(flatNow)
  if (!renaming) flatHeld.current = flatNow
  const flat = flatHeld.current
  // 已经开着时再点一次搜索钮:状态没变,效果不会重跑,所以这里直接把光标放回去(键盘被收起之后还能再叫出来)
  const openSearch = (): void => { setSearching(true); searchRef.current?.focus() }
  useEffect(() => { if (searching) searchRef.current?.focus() }, [searching])
  usePullToSearch(listRef, flat && src.search ? openSearch : undefined)
  useNativeChromeExtras(flat && src.search ? { where: 'list', search: { label: t('wsview.search', { source: src.title }), run: openSearch } } : null)
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
    // 搜索时列表是压平的,没有可展开的上级,也不记「已经展开过」:在搜索结果里点开的那一行,清掉搜索词之后还要把它的组打开
    if (query || !activeKey || revealed.current === activeKey) return
    const self = items.find((it) => it.key === activeKey)
    if (!self) return
    revealed.current = activeKey
    const ups = ancestorsOf(items, activeKey)
    for (const key of ups) { const up = items.find((it) => it.key === key); if (up) setFolderOpen(up, true) }
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
  /** 叶子行(能开 View 的):不收行拖动的源也能拖 —— 拖进标签栏 / 主区正文 = 在落点开它(开法同点击)。 */
  const leafDragProps = (it: ListItem): Record<string, unknown> => {
    const base = dragProps(it)
    if (renaming === it.key) return base
    const start = base.onDragStart as ((e: React.DragEvent<HTMLElement>) => void) | undefined
    return {
      ...base,
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLElement>) => {
        if (start) start(e); else e.stopPropagation()
        startOpenDrag(e.dataTransfer, { open: () => src.open(it, { newTab: false }) })
      },
    }
  }
  /** 指针在这一行上时落在哪:按行内位置给出候选,逐个问插件,第一个被接受的算数。
   *  不落在自己身上,也不落进自己下面。 */
  const landing = (e: React.DragEvent<HTMLElement>, it: ListItem): ListDropTarget | null => {
    const keys = dragKeys.current
    // 拖到一半列表源换了(换成不收行的那种):不把上一个源的行交给它
    if (!keys || !src.drop?.accepts.includes('items')) return null
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

  /** 左滑出来的是只有图标的圆钮(用户 2026-10-10:不带文字),所以只收带图标的动作;其余的仍在长按菜单里。 */
  const swipeFor = (list: ListAction[]): SwipeAction[] => list.flatMap((action) => {
    const icon = action.id === '__rename' ? <Pencil /> : resolveIcon(action.icon)
    // 词表里没有的名字 → null;不是词表键形状的(emoji)会被原样当字形返回 —— 圆钮里只要线性图标
    if (!icon || typeof icon === 'string') return []
    return [{ id: action.id, label: action.label, icon, tone: action.danger ? 'danger' as const : undefined, run: action.run }]
  })
  /** 手机整屏列表里的行:图标块 + 标题与时间 / 第二行;样式全在 phoneList.css(命中 = 列表根上的 data-timeline)。
   *  不接行的拖放(刻意):触屏上拖动是从长按起手的,而长按在这里是「这一行的菜单」;与笔记的「最近」列表同一个取舍。 */
  const phoneRow = (it: ListItem, inGroup: boolean): ReactNode => {
    const actions = menuFor(it)
    const editing = renaming === it.key
    return <div className="t2sw-plug-item" key={it.key}>
      <SwipeRow actions={editing ? [] : swipeFor(actions)}>
        <SidebarRow as={editing ? 'div' : 'button'} data-row-key={it.key} title={it.title} style={{ paddingLeft: undefined }}
          className={cls(activeKey === it.key && 'active', it.unread && 'is-unread', inGroup && 't2sw-plug-kid')}
          lead={inGroup ? unreadDot(it) : <><LeadIcon key={it.iconUrl ?? ''} item={it} />{it.unread && <span className="t2s-dot unread" title={t('sidebar.unread')} />}</>}
          onClick={editing ? undefined : () => src.open(it, { newTab: false })}
          onContextMenu={contextMenu(actions)}
        >{editing ? renameInput(it) : <span className="t2s-srow-text">
          {/* 时间收在标题那一行里(不像会话行那样在行尾自成一列):第二行因此用满整行,多显示十来个字 */}
          <span className="pl-row-top"><span className="t2s-srow-title">{it.title}</span>{it.hint && <span className="t2s-srow-time">{it.hint}</span>}</span>
          {it.subtitle && <span className="t2s-srow-sub">{it.subtitle}</span>}
        </span>}</SidebarRow>
      </SwipeRow>
    </div>
  }
  /** 组里的行不画自己的图标(组头已经说了是谁的),前导槽里只留未读的圆点;槽照留,标题才和组头的名字对齐。 */
  const unreadDot = (it: ListItem): ReactNode => it.unread ? <span className="t2sw-plug-udot" title={t('sidebar.unread')} /> : null
  // Keep the shared row, with independent sibling buttons (never nest buttons).
  const row = (it: ListItem, depth: number, inGroup = false): ReactNode => {
    if (flat) return phoneRow(it, inGroup)
    const actions = menuFor(it)
    const editing = renaming === it.key
    // 指针停在行上时行尾出的图标钮:和手机上左滑出来的是同一份(带图标的动作),「更多」里仍是带名字的全部动作。
    const quick = editing ? [] : swipeFor(actions)
    // 有副标题的行画两行(标题 + 一行淡字);改名时退回一行,输入框只改标题。
    // 两行时右边的 hint 收进第一行里,第二行才能用满整行的宽 —— 手机上一行只有四百来宽,让出时间那一列就少显示十来个字。
    const two = !editing && !!it.subtitle
    const at = dropAt?.key === it.key ? dropAt.position : null
    return <div className={cls('t2sw-plug-item', at === 'before' && 'drop-before', at === 'after' && 'drop-after', dragging === it.key && 'dragging')} key={it.key}>
      {/* 改名时行里是输入框,input 不能嵌在 button 里 → 换成 div */}
      <SidebarRow as={editing ? 'div' : 'button'} depth={depth} data-row-key={it.key}
        title={it.title}
        className={`${activeKey === it.key ? 'active' : ''}${it.unread ? ' is-unread' : ''}${dropKey === `i:${it.key}` ? ' amx-drop-into' : ''}${actions.length ? ' has-actions' : ''}${quick.length ? ' has-quick' : ''}${two ? ' t2s-deep' : ''}`.trim() || undefined}
        style={quick.length ? { '--quick': quick.length } as React.CSSProperties : undefined}
        {...rowDropProps(it)} {...leafDragProps(it)}
        lead={inGroup ? unreadDot(it) : <><LeadIcon key={it.iconUrl ?? ''} item={it} />{it.unread && <span className="t2s-dot unread" title={t('sidebar.unread')} />}</>}
        trailing={!editing && !two && it.hint ? <span className="t2s-count">{it.hint}</span> : undefined}
        onClick={editing ? undefined : (e) => src.open(it, { newTab: e.metaKey || e.ctrlKey })}
        onContextMenu={contextMenu(actions)}
      >{editing ? renameInput(it) : two
        ? <span className="t2s-deep-col">
            <span className="t2sw-plug-top"><span className="t2s-srow-title">{it.title}</span>{it.hint && <span className="t2s-count">{it.hint}</span>}</span>
            <span className="t2sw-plug-sub">{it.subtitle}</span>
          </span>
        : <span className="t2s-srow-title">{it.title}</span>}</SidebarRow>
      {!!quick.length && <span className="t2sw-plug-row-quick">{quick.map((action) =>
        <button key={action.id} type="button" className={cls('t2sw-plug-row-act', action.tone === 'danger' && 'danger')} data-action={action.id}
          title={action.label} aria-label={action.label} onClick={() => action.run()}>{action.icon}</button>)}</span>}
      {!!actions.length && !editing && <CapabilityMenu label={t('wsview.itemActions', { title: it.title })} className="t2sw-plug-row-menu"
        items={menuItems(actions)}><MoreHorizontal size={14} /></CapabilityMenu>}
    </div>
  }
  /** 正开着的那一行和它上面的各级:「查看更多」不能把它们收在后面。 */
  const activePath = activeKey ? [activeKey, ...ancestorsOf(items, activeKey)] : []
  // 组头(folderStyle: 'group'):工作区一级行那一套 —— 30px 的前导、名字、行尾的数;点一下开合。桌面和手机是同一份标记,
  // 手机上的尺寸在 phoneList.css。组里先列 GROUP_PAGE 条;正开着的那一条排在后面时整组列全,免得它被收在「查看更多」里。
  const groupHead = (n: ListNode): ReactNode => {
    const it = n.item
    const isOpen = folderOpen(it)
    const all = more.has(it.key) || n.children.findIndex((child) => activePath.includes(child.item.key)) >= GROUP_PAGE
    const shown = all ? n.children : n.children.slice(0, GROUP_PAGE)
    const at = dropAt?.key === it.key ? dropAt.position : null
    return <div key={it.key} className="t2sw-plug-group">
      {/* 拖放和普通文件夹同一套落点(前 / 后 / 放进去);手机的整屏列表不接行的拖放(同 phoneRow) */}
      <button type="button" className={cls('t2o-row t2sw-plug-ghead', it.hint && 'has-hint', at === 'into' && 'amx-drop-into', at === 'before' && 'drag-over', at === 'after' && 'drag-over below', dragging === it.key && 'dragging')}
        data-row-key={it.key} title={it.title} aria-expanded={isOpen}
        style={flat ? undefined : { paddingLeft: nameLeft(2) - GROUP_LEAD }} {...(flat ? {} : { ...rowDropProps(it), ...dragProps(it) })}
        onClick={() => setFolderOpen(it, !isOpen)} onContextMenu={contextMenu(menuFor(it))}>
        <GroupLead key={it.iconUrl ?? ''} item={it} />
        <span className="t2sw-plug-gname"><span className="t2o-name">{it.title}</span><span className={`t2s-chev${isOpen ? ' open' : ''}`}><ChevronRight size={12} /></span></span>
        {it.hint && <span className="t2s-count">{it.hint}</span>}
      </button>
      {isOpen && <div className="t2s-group-sessions">
        {shown.map((child) => node(child, 2, true))}
        {shown.length < n.children.length && <button type="button" className="t2s-viewmore" style={flat ? undefined : { marginLeft: nameLeft(2) - 6 }}
          onClick={() => setMore((prev) => new Set(prev).add(it.key))}>{t('sidebar.viewMore')} · {n.children.length - shown.length}</button>}
      </div>}
    </div>
  }
  // 文件夹行:与笔记树的文件夹同一套结构与类名(前导槽里图标 ↔ 悬停换箭头,行尾「更多」和「+」)。
  const folder = (n: ListNode, depth: number): ReactNode => {
    const it = n.item
    // 正在改名的组头临时画成普通文件夹行:行内输入框只在那一套里有
    if (isGroupHead(it) && renaming !== it.key) return groupHead(n)
    const isOpen = folderOpen(it)
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
  const node = (n: ListNode, depth: number, inGroup = false): ReactNode =>
    isFolder(n.item) ? folder(n, depth)
    : n.children.length ? <Fragment key={n.item.key}>{row(n.item, depth, inGroup)}{n.children.map((child) => node(child, depth + 1))}</Fragment>
    : row(n.item, depth, inGroup)
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

  /** 搜索框。桌面常显,右边的叉只清字;手机上是点了搜索才出来的一行,叉 = 清字并收起。 */
  const searchField = (closes: boolean): ReactNode => <div className="t2s-search">
    <Search size={13} className="t2s-dim" />
    <input ref={searchRef} aria-label={t('wsview.search', { source: src.title })} placeholder={t('wsview.searchShort')}
      value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery('') }
        if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>(NAV_ROWS)?.focus() }
      }} />
    {closes
      ? <button type="button" aria-label={t('wsview.closeSearch')} title={t('wsview.closeSearch')} onClick={() => { setQuery(''); setSearching(false) }}><X size={12} /></button>
      : query && <button type="button" aria-label={t('wsview.clearSearch')} title={t('wsview.clearSearch')}
        onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={12} /></button>}
  </div>
  // 手机的首次提示:把这张列表自己的动作念一遍(左滑有哪几颗、长按主按钮还有什么),名字来自列表源。
  const phoneHint = ((): string => {
    if (!flat) return ''
    const join = t('wsview.phone.join')
    const first = items.find((it) => !isFolder(it))
    const actions = first ? swipeFor(menuFor(first)).map((a) => a.label).join(join) : ''
    const more = primary ? secondary.map((a) => a.label).join(join) : ''
    return actions && more ? t('wsview.phone.hintBoth', { actions, more }) : actions ? t('wsview.phone.hintSwipe', { actions }) : more ? t('wsview.phone.hintHold', { more }) : ''
  })()
  const moreMenu = (at: { x: number; y: number }): void => {
    menuOpener.current = null
    setMenu({ x: at.x, y: at.y, items: secondary.map((action) => ({ label: action.label, danger: action.danger, run: action.run })) })
  }
  const fabIcon = ((): ReactNode => { const icon = resolveIcon(primary?.icon); return icon && typeof icon !== 'string' ? icon : <Plus /> })()

  return (
    <div className="t2sw-plug" data-timeline={flat ? '' : undefined}>
      {/* 手机:分类是一排胶囊(不是菜单);搜索在胶囊上的搜索钮和下拉里,点了才出这一行 */}
      {flat && !!groups.length && <ListChips label={t('wsview.filter')}
        items={[{ id: '__all', label: t('wsview.all') }, ...groups.map((g) => ({ id: `g:${g.key}`, label: g.title }))]}
        value={activeGroup ? `g:${activeGroup.key}` : '__all'} onChange={(id) => setGroup(id === '__all' ? null : id.slice(2))} />}
      {/* 有搜索词时这一行一定在:横屏里打了字再转回竖屏,不能剩一张筛过的列表却看不见筛的是什么 */}
      {flat && src.search && (searching || !!query) && <div className="t2sw-plug-toolbar">{searchField(true)}</div>}
      {!flat && (src.search || primary || secondary.length > 0) && <div className="t2sw-plug-toolbar">
        {src.search && searchField(false)}
        {primary && <button type="button" className="t2sw-plug-btn" title={primary.label} onClick={() => primary.run()}>{primary.label}</button>}
        {!!secondary.length && <CapabilityMenu label={t('wsview.actions', { source: src.title })} className="t2sw-plug-overflow"
          items={secondary.map((action) => ({ id: action.id, label: action.label, danger: action.danger, onSelect: action.run }))}><MoreHorizontal size={15} /></CapabilityMenu>}
      </div>}
      {!flat && !!groups.length && <div className="t2sw-plug-filterbar">
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
        <span className="t2sw-plug-total" aria-live="polite">{t('wsview.resultCount', { count: items.filter((it) => !isFolder(it)).length })}</span>
      </div>}
      <div ref={listRef} className={`t2sw-plug-list${dropKey === 'list' ? ' amx-drop-into' : ''}`} data-under-dock=""
        {...dropProps('list', { group: activeGroup?.key })}
        onTouchStart={flat ? closeOtherSwipes : undefined}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches(NAV_ROWS)) return
          const key = event.target.dataset.rowKey
          const it = key === undefined ? undefined : items.find((item) => item.key === key)
          if (event.key === 'F2' && it && src.rename && it.renamable) { event.preventDefault(); setRenaming(it.key); return }
          if (it && isFolder(it) && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault(); setFolderOpen(it, event.key === 'ArrowRight'); return
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(NAV_ROWS))
          const index = rows.indexOf(event.target as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          event.preventDefault(); rows[next]?.focus()
        }}>
        {flat && src.search && <PullHint />}
        {flat && phoneHint && <ListHint id={`list:${src.id}`}>{phoneHint}</ListHint>}
        {sections ? sections.map(([g, list]) => section(g, list)) : roots.map((n) => node(n, 1))}
        {items.length === 0 && <div className="t2sw-empty">{query ? t('wsview.noMatches') : t('wsview.empty')}</div>}
      </div>
      {/* 手机:源的常用动作是右下角的主按钮,其余动作在它的长按菜单里 */}
      {flat && primary && <ListFab label={primary.label} icon={fabIcon} onClick={() => primary.run()}
        onMenu={secondary.length ? moreMenu : undefined} />}
      {/* 没有常用动作、只有分类动作的源:主按钮就是那张菜单的入口(否则工具栏收掉之后这些动作无处可点) */}
      {flat && !primary && !!secondary.length && <ListFab label={t('wsview.actions', { source: src.title })} icon={<MoreHorizontal />}
        onClick={() => moreMenu({ x: window.innerWidth - 32, y: window.innerHeight - 180 })} onMenu={moreMenu} />}
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
