import { amadeusAvailable, sessionsAvailable } from '../features/runtime'
/**
 * 统一「工作区」视图 + 统一「大纲」视图 —— 会话列表 / 工作区文件 / 笔记库(以及 目录 / Amadeus 大纲)
 * 底层合并为两套共享视图,按 (所在侧栏左右 × focus 的主视图类型) 自动切换模式,也可手动切换。
 *
 * 模式体全部**包裹复用**现有组件(SessionsView / FilesPanel / AmadeusPagesView / TocView /
 * AmadeusOutlineView),本文件只提供:模式状态(存 leaf params,随布局持久化)+ 头部切换器 + 自动跟随。
 * 自动规则两级(见 workspaceMode.ts):主视图**硬规则**优先且跨 Space 一致(chat → 左=会话、右=文件;
 * Amadeus 文档家族(编辑器/图/多维表/PDF)→ 左=笔记、右=文件,定位到笔记所在目录;code-studio → 文件);
 * 无硬规则 → 落**本 Space 的默认档**(SpaceDefinition.autoWorkspaceMode,如 Amadeus → 笔记)。右栏恒为文件。
 */
import { useMemo, useState, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { useWorkspace, activeMainPanel, scheduleWorkspaceSave, useSpaceStore, getView } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { Check, ChevronDown, FileText, ListFilter, MoreHorizontal, Search, X } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import { SessionsView } from './SessionsView'
// TODO(簇 C):OrbitsView = 新版会话侧栏(轨道体系 P1),由另一簇创建;契约 props = { sideFilter?: 'local' | 'cloud' }。
import { OrbitsView } from './OrbitsView'
import { TocView } from './RightViews'
import { FilesPanel } from './chat2/FilesPanel'
import { PATHS_MIME as DRAG_MIME } from './chat2/chatDragRef'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { AmadeusPagesView, AmadeusOutlineView, ScopedPageOutline } from '../amadeusViews'
import { usePageStore } from '@amadeus/store/pageStore'
import type { WorkspaceDescriptor } from '../types'
import { autoWorkspaceMode, resolveWorkspaceModes, workspaceKeyForPath, type WorkspaceMode, type WorkspaceModeEx } from './workspaceMode'
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
  'wsview.clearSearch': { zh: '清空搜索', en: 'Clear search' },
  'wsview.filter': { zh: '筛选分类', en: 'Filter by category' },
  'wsview.clearFilter': { zh: '显示全部', en: 'Show all' },
  'wsview.actions': { zh: '{source}操作', en: '{source} actions' },
  'wsview.itemActions': { zh: '{title}的操作', en: 'Actions for {title}' },
  'wsview.resultCount': { zh: '{count} 项', en: '{count} items' },
  // 新旧两个会话档并存:新档(轨道侧栏)占「会话」这个名字,旧档降为「会话(旧)」——
  // 档位 id 仍是 'sessions'(布局持久化键,发版即冻结),只改文案。
  'workspace.mode.orbits': { zh: '会话', en: 'Sessions' },
  'workspace.mode.sessionsLegacy': { zh: '会话（旧）', en: 'Sessions (legacy)' },
  // 旧档顶部的升级提示条(存量用户手选过旧档 → 不迁移 params.mode,只给一条可点的路,方案 §11 ⑥)。
  'workspace.legacyHint': { zh: '已有新版会话侧栏', en: 'A new sessions sidebar is available' },
  'workspace.legacyHint.switch': { zh: '切换', en: 'Switch' },
  // 纯图标的 × 需要可访问名;消隐只管这一次会话,故 zh 写「关闭」而非「不再提示」(后者是持久化承诺)。
  'workspace.legacyHint.dismiss': { zh: '关闭', en: 'Dismiss' },
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

const MODE_KEYS: Array<{ id: WorkspaceMode | 'auto'; label: string }> = [
  { id: 'auto', label: 'workspace.mode.auto' },
  { id: 'orbits', label: 'workspace.mode.orbits' },
  { id: 'sessions', label: 'workspace.mode.sessionsLegacy' },
  { id: 'files', label: 'workspace.mode.files' },
  { id: 'notes', label: 'workspace.mode.notes' },
]

/** 档位 → 文案键:必须查 MODE_KEYS 而不是拼 `workspace.mode.${mode}` —— 旧档的键名(sessions)
 *  与文案键(sessionsLegacy)从此不同名,拼串会让触发器把旧档也显示成「会话」,与新档撞名。
 *  插件列表源不在表内,回落原来的拼串路(它们本来就由 src.title 接管,不走这里)。 */
const modeLabelKey = (mode: WorkspaceModeEx): string =>
  MODE_KEYS.find((m) => m.id === mode)?.label ?? `workspace.mode.${mode}`

export function WorkspaceView({ leaf, defaultMode }: ViewProps & { defaultMode?: WorkspaceModeEx }) {
  const { t } = useI18n()
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  // 旧档提示条的消隐:**只管这一次会话**(React state,不落盘)—— 存量用户手选过的档位不迁移,
  // 提示条是他们唯一那条可点的路,下次开窗还得给。
  const [legacyHintDismissed, setLegacyHintDismissed] = useState(false)
  const modePickerRef = useRef<HTMLDivElement>(null)
  const modeTriggerRef = useRef<HTMLButtonElement>(null)
  const hasNotes = amadeusAvailable()
  const hasSessions = sessionsAvailable()
  const mainType = useActiveMainType()
  const loc = leaf.loc
  // 插件列表源(P2):活着的源集合 —— override/auto 落到已死的源(插件被禁)时回退,
  // 不渲染死模式(与 layoutViewsAllRegistered 同类防线:params.mode 随布局持久化,可能指向已卸载的源)。
  const liveSources = usePluginStore((s) => s.listSources)
  const sourceAlive = (id: string): boolean => liveSources.some((o) => `plugin:${o.pluginId}:${o.item.id}` === id)
  // 手动覆盖存 leaf params(随布局持久化);'auto'(默认)跟随主视图。
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
  const automaticMode = availableMode(resolvedModes.automatic)
  const mode = availableMode(resolvedModes.active)
  // 生效档是旧「会话(旧)」时给一行升级提示(方案 §11 ⑥:不迁 params.mode,只给一条可点的路)。
  // 只对手选过旧档的存量用户(leaf.params.mode==='sessions')露提示条;仅仅是自动落到 sessions 的别的 Space 不算(§11 ⑥)。
  const showLegacyHint = override === 'sessions' && hasSessions && !legacyHintDismissed

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

  const modeOptions = [
    ...MODE_KEYS.filter((m) => (m.id !== 'notes' || hasNotes) && ((m.id !== 'sessions' && m.id !== 'orbits') || hasSessions)).map((m) => ({ id: m.id as WorkspaceModeEx | 'auto', text: t(m.label) })),
    ...liveSources.map((o) => ({ id: `plugin:${o.pluginId}:${o.item.id}` as WorkspaceModeEx, text: o.item.title })),
  ]
  const effectiveModeText = pluginSrc?.title ?? t(modeLabelKey(mode))
  const automaticPluginSrc = automaticMode.startsWith('plugin:')
    ? liveSources.find((o) => `plugin:${o.pluginId}:${o.item.id}` === automaticMode)?.item ?? null
    : null
  const automaticModeText = automaticPluginSrc?.title ?? t(modeLabelKey(automaticMode))
  const modeTriggerText = override === 'auto'
    ? `${t('workspace.mode.auto')} · ${automaticModeText}`
    : effectiveModeText

  // 选择菜单沿用其它 app 内下拉的行为:点外部 / Esc 关闭；打开后把焦点交给当前项，
  // 方向键可在选项间移动。菜单就地叠在工作区 body 上方，不参与纵向布局。
  useEffect(() => {
    if (!modeMenuOpen) return
    const raf = requestAnimationFrame(() => {
      modePickerRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus()
    })
    const closeOutside = (event: MouseEvent): void => {
      if (!modePickerRef.current?.contains(event.target as Node)) setModeMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setModeMenuOpen(false)
      modeTriggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [modeMenuOpen])

  const moveModeFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'))
    if (!options.length) return
    event.preventDefault()
    const current = options.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
      : event.key === 'ArrowUp' ? (current <= 0 ? options.length - 1 : current - 1)
      : (current + 1) % options.length
    options[next]?.focus()
  }

  const pickMode = (id: WorkspaceModeEx | 'auto'): void => {
    leaf.setParams({ mode: id })
    scheduleWorkspaceSave()
    setModeMenuOpen(false)
    modeTriggerRef.current?.focus()
  }

  const body: ReactNode =
    pluginSrc ? <PluginListBody key={mode} src={pluginSrc} />
    : mode === 'orbits' ? <OrbitsView sideFilter={sideFilter} />
    : mode === 'sessions' ? <SessionsView sideFilter={sideFilter} />
    : mode === 'files' ? <FilesBody vaultCtx={vaultCtx} sideFilter={sideFilter} />
    : hasNotes ? <AmadeusPagesView />
    : <div className="t2sw-empty">{t('workspace.notesUnavailable')}</div>

  return (
    <div className="t2sw">
      {loc === 'left' && <VaultSideSwitch />}
      {/* Sub list = 内置三档 + **每个活着的插件列表源各一项**(P2),源随插件启停动态增减。
          单个选择器替代横向胶囊条：名称再多也只在菜单内纵向滚动，不撑宽工作区。 */}
      <div className="t2sw-mode-slot">
        <div className={`t2sw-mode-picker${modeMenuOpen ? ' is-open' : ''}`} ref={modePickerRef}>
          <button
            ref={modeTriggerRef}
            type="button"
            className={`t2sw-mode-trigger${modeMenuOpen ? ' is-open' : ''}`}
            title={modeTriggerText}
            aria-haspopup="listbox"
            aria-expanded={modeMenuOpen}
            onClick={() => setModeMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              setModeMenuOpen(true)
            }}
          >
            <span className="t2sw-mode-label">{effectiveModeText}</span>
            <ChevronDown size={13} aria-hidden />
          </button>
          {/* 常驻 DOM 才能同时拥有展开与收起动画；关闭时 aria-hidden + tabIndex=-1 隔离交互。 */}
          <div className={`t2sw-mode-reveal${modeMenuOpen ? ' is-open' : ''}`} aria-hidden={!modeMenuOpen}>
            <div className="t2sw-mode-clip">
              <div
                className="t2sw-mode-menu"
                role="listbox"
                aria-label={t('view.workspace')}
                onKeyDown={moveModeFocus}
              >
                {modeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    data-workspace-mode={option.id}
                    tabIndex={modeMenuOpen ? 0 : -1}
                    aria-selected={override === option.id}
                    className={`project-menu-item t2sw-mode-item${override === option.id ? ' is-selected' : ''}`}
                    title={option.id === 'auto' ? t('workspace.mode.autoTip') : option.text}
                    onClick={() => pickMode(option.id)}
                  >
                    <span className="project-menu-name">
                      {option.text}
                      {option.id === 'auto' && <span className="t2sw-auto-now">· {automaticModeText}</span>}
                    </span>
                    <span className="project-menu-check">{override === option.id ? <Check size={13} /> : null}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* 旧档升级提示条(26.8px = 工作区行基准)。放在 `.t2sw-body` **之前**:body 的
          `> * { flex: 1 }` 会把任何直接子元素撑成半屏。
          TODO(CSS):`.t2sw-legacyhint` 的几何暂用内联样式 —— sidebar2.css 本轮归别的簇改,
          解锁后把这几条搬进 CSS(类名已就位);颜色一律走 token,不写死色值。 */}
      {showLegacyHint && (
        <div
          className="t2sw-legacyhint"
          style={{ flex: '0 0 26.8px', height: '26.8px', display: 'flex', alignItems: 'center', gap: 6, padding: '0 7.5px', background: 'var(--overlay-light, rgba(127, 127, 127, 0.08))' }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '11.5px', fontWeight: 400 }}>
            {t('workspace.legacyHint')}
          </span>
          {/* 与档位菜单同一条路:pickMode 已经做了 setParams + scheduleWorkspaceSave。
              两枚小按钮借同文件内的 `.t2sw-plug-mini`(本视图的小文字按钮)**只为 hover 底色** ——
              它的 `margin-left:auto` 与 `:hover{color:var(--text)}` 都被这里的内联值压掉。 */}
          <button
            type="button"
            className="t2sw-legacyhint-btn t2sw-plug-mini"
            style={{ marginLeft: 0, color: 'var(--accent-ink)', fontSize: '11.5px' }}
            onClick={() => pickMode('orbits')}
          >
            {t('workspace.legacyHint.switch')}
          </button>
          <button
            type="button"
            className="t2sw-legacyhint-x t2sw-plug-mini"
            style={{ marginLeft: 0, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}
            title={t('workspace.legacyHint.dismiss')}
            aria-label={t('workspace.legacyHint.dismiss')}
            onClick={() => setLegacyHintDismissed(true)}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}
      <div className="t2sw-body">{body}</div>
    </div>
  )
}

/** 插件列表源的渲染体(P2):**统一左栏 UI 承载插件数据** —— 顶部动作、可选中分组(文件夹)、
 *  搜索、条目行、右键菜单,全部用会话/笔记列表同一套类(t2s-srow / t2s-search / t2s-lead),
 *  插件只出数据不出 UI。搜索词与选中分组由宿主持有,经 items({query, group}) 回传给插件,
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

export function PluginListBody({ src }: { src: ListSourceContribution }) {
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
  // 源换了(插件切换/禁用重启)→ 过滤态跟着重置,免得拿旧源的分组键去查新源。
  useEffect(() => { setQuery(''); setGroup(null); setMenu(null) }, [src])

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
  // 无 groups() 声明时,退回按 item.group 的静态分区(老契约行为)。
  const sections = useMemo(() => {
    if (groups.length) return null
    const m = new Map<string, ListItem[]>()
    for (const it of items) {
      const g = it.group ?? ''
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(it)
    }
    return [...m.entries()]
  }, [items, groups.length])

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

  const closeMenu = (): void => {
    setMenu(null)
    menuOpener.current?.focus({ preventScroll: true })
  }
  // Keep the shared row, with an independent sibling menu button (never nest buttons).
  const row = (it: ListItem): ReactNode => {
    const actions = src.itemMenu?.(it) ?? []
    return <div className="t2sw-plug-item" key={it.key}>
      <SidebarRow as="button"
        title={it.title}
        className={`${activeKey === it.key ? 'active' : ''}${it.unread ? ' is-unread' : ''}${dropKey === `i:${it.key}` ? ' amx-drop-into' : ''}${actions.length ? ' has-actions' : ''}`.trim() || undefined}
        {...dropProps(`i:${it.key}`, { item: it })}
        lead={<><LeadIcon key={it.iconUrl ?? ''} item={it} />{it.unread && <span className="t2s-dot unread" title={t('sidebar.unread')} />}</>}
        trailing={it.hint ? <span className="t2s-count">{it.hint}</span> : undefined}
        onClick={(e) => src.open(it, { newTab: e.metaKey || e.ctrlKey })}
        onContextMenu={(e) => {
          if (!actions.length) return
          e.preventDefault(); e.stopPropagation()
          menuOpener.current = e.currentTarget
          setMenu({ x: e.clientX, y: e.clientY, items: actions.map((action) => ({ label: action.label, danger: action.danger, run: action.run })) })
        }}
      ><span className="t2s-srow-title">{it.title}</span></SidebarRow>
      {!!actions.length && <CapabilityMenu label={t('wsview.itemActions', { title: it.title })} className="t2sw-plug-row-menu"
        items={actions.map((action) => ({ id: action.id, label: action.label, danger: action.danger, onSelect: action.run }))}><MoreHorizontal size={14} /></CapabilityMenu>}
    </div>
  }

  return (
    <div className="t2sw-plug">
      {(src.search || primary || secondary.length > 0) && <div className="t2sw-plug-toolbar">
        {src.search && <div className="t2s-search">
          <Search size={13} className="t2s-dim" />
          <input ref={searchRef} aria-label={t('wsview.search', { source: src.title })} placeholder={t('wsview.search', { source: src.title })}
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
      <div ref={listRef} className={`t2sw-plug-list${dropKey === 'list' ? ' amx-drop-into' : ''}`}
        {...dropProps('list', { group: activeGroup?.key })}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches('.t2s-srow')) return
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.t2s-srow'))
          const index = rows.indexOf(event.target as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          event.preventDefault(); rows[next]?.focus()
        }}>
        {sections ? sections.map(([g, list]) => g === '' ? <div key="__flat">{list.map(row)}</div> : <div key={g}>
          <div className="t2sw-plug-sec"><span className="t2s-group-label">{g}</span><span className="t2s-count">{list.length}</span></div>
          {list.map(row)}
        </div>) : items.map(row)}
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
