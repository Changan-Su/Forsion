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
import { useMemo, useState, useEffect, useReducer, type ReactNode } from 'react'
import { useWorkspace, activeMainPanel, scheduleWorkspaceSave, useSpaceStore, getView } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { FileText, Folder, Search } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListAction, ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import { SessionsView } from './SessionsView'
import { TocView } from './RightViews'
import { FilesPanel } from './chat2/FilesPanel'
import { PATHS_MIME as DRAG_MIME } from './chat2/chatDragRef'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { AmadeusPagesView, AmadeusOutlineView, ScopedPageOutline } from '../amadeusViews'
import { usePageStore } from '@amadeus/store/pageStore'
import type { WorkspaceDescriptor } from '../types'
import { autoWorkspaceMode, workspaceKeyForPath, type WorkspaceMode, type WorkspaceModeEx } from './workspaceMode'
import { useCodeStudio } from '../stores/codeStudioStore'
import { VaultSideSwitch } from '../components/VaultSideSwitch'
import { PillBar } from '../components/EnginePicker'
import { SidebarRow } from '../components/SidebarRow'
import { resolveIcon } from '@amadeus/components/icons'
import { ensureAmadeusReady } from '../amadeusPlugins'

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
  { id: 'sessions', label: 'workspace.mode.sessions' },
  { id: 'files', label: 'workspace.mode.files' },
  { id: 'notes', label: 'workspace.mode.notes' },
]

export function WorkspaceView({ leaf }: ViewProps) {
  const { t } = useI18n()
  const hasNotes = !!window.amadeus
  const mainType = useActiveMainType()
  const loc = leaf.loc
  // 插件列表源(P2):活着的源集合 —— override/auto 落到已死的源(插件被禁)时回退,
  // 不渲染死模式(与 layoutViewsAllRegistered 同类防线:params.mode 随布局持久化,可能指向已卸载的源)。
  const liveSources = usePluginStore((s) => s.listSources)
  const sourceAlive = (id: string): boolean => liveSources.some((o) => `plugin:${o.pluginId}:${o.item.id}` === id)
  // 手动覆盖存 leaf params(随布局持久化);'auto'(默认)跟随主视图。
  const raw = leaf.params.mode
  const override: WorkspaceModeEx | 'auto' =
    raw === 'sessions' || raw === 'files' || (raw === 'notes' && hasNotes) ? raw
    : typeof raw === 'string' && raw.startsWith('plugin:') && sourceAlive(raw) ? (raw as WorkspaceModeEx)
    : 'auto'
  // 主视图无硬规则时落本 Space 的默认档(如 Amadeus → 笔记);缺省 sessions = 与其它 Space 一致。
  const spaceAuto = useSpaceStore((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId)?.autoWorkspaceMode)
  // 声明式联动(P2):主视图注册时声明的 workspaceSource(如青鸟视频视图 → 它的收藏夹源)优先于硬规则;
  // 指向的插件源已死同样回退 auto 常规路。
  const declared = mainType ? getView(mainType)?.workspaceSource ?? null : null
  const declaredLive = declared && (!declared.startsWith('plugin:') || sourceAlive(declared)) ? declared : null
  const auto = autoWorkspaceMode(loc, mainType, spaceAuto, declaredLive)
  const mode: WorkspaceModeEx = override === 'auto' ? (auto === 'notes' && !hasNotes ? 'files' : auto) : override

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
    pluginSrc ? <PluginListBody src={pluginSrc} />
    : mode === 'sessions' ? <SessionsView sideFilter={sideFilter} />
    : mode === 'files' ? <FilesBody vaultCtx={vaultCtx} sideFilter={sideFilter} />
    : hasNotes ? <AmadeusPagesView />
    : <div className="t2sw-empty">{t('workspace.notesUnavailable')}</div>

  return (
    <div className="t2sw">
      {loc === 'left' && <VaultSideSwitch />}
      {/* 档位 = 内置三档 + **每个活着的插件列表源各一档**(P2),源随插件启停增减 → 动态生成。
          放不下时**只有胶囊层横向滚动 + ⋯ 翻页**,绝不让整个侧栏跟着横滚(用户实报)——
          复用 chat 的 PillBar(同一套溢出检测与翻页数学 pillBar.ts,仪器 check:pillbar)。 */}
      <PillBar label={t('workspace.mode.auto')}>
        {[
          ...MODE_KEYS.filter((m) => m.id !== 'notes' || hasNotes).map((m) => ({ id: m.id as WorkspaceModeEx | 'auto', text: t(m.label) })),
          ...liveSources.map((o) => ({ id: `plugin:${o.pluginId}:${o.item.id}` as WorkspaceModeEx, text: o.item.title })),
        ].map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={override === m.id}
            className={`t2sw-seg${override === m.id ? ' on' : ''}`}
            title={m.id === 'auto' ? t('workspace.mode.autoTip') : m.text}
            onClick={() => { leaf.setParams({ mode: m.id }); scheduleWorkspaceSave() }}
          >
            {m.text}
            {m.id === 'auto' && override === 'auto' && (
              <span className="t2sw-auto-now">·{pluginSrc ? pluginSrc.title : t(`workspace.mode.${mode}`)}</span>
            )}
          </button>
        ))}
      </PillBar>
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
  const [, force] = useReducer((x: number) => x + 1, 0)
  // ⚠️vault 懒引导 × 插件在启动期激活 = 列表源恒空(2026-08-28 用户实报,青鸟收藏夹):
  //   插件在 bootstrapEngine 就装好了,那一刻还没有活动库,它启动时那次索引读取拿到的是
  //   `readTextFile` 的**静默 null**(主进程 `if (!vault.getRoot()) return null`),此后无人重读。
  //   两道一起补:①这里 ensureAmadeusReady() 把库唤起来(与 AgentDesk 同一处方);
  //   ②订阅 effect 以 vaultRoot 为键 —— 库落地/切库(Local↔Cloud)都重订阅,插件借机重读。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => src.subscribe(() => force()), [src, vaultRoot])
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; actions: ListAction[] } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  // 源换了(插件切换/禁用重启)→ 过滤态跟着重置,免得拿旧源的分组键去查新源。
  useEffect(() => { setQuery(''); setGroup(null) }, [src])

  const groups = src.groups?.() ?? []
  const items = src.items({ query: query || undefined, group: group ?? undefined })
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

  // 行 = 共享 SidebarRow(与会话/笔记行**同一个组件**,几何与状态类一致);插件只出数据。
  // 行首图标走宿主图标词表(resolveIcon),插件按名取 —— 既统一又保留辨识度(如平台角标)。
  const row = (it: ListItem): ReactNode => (
    <SidebarRow
      key={it.key}
      title={it.title}
      className={dropKey === `i:${it.key}` ? 'amx-drop-into' : undefined}
      {...dropProps(`i:${it.key}`, { item: it })}
      lead={<LeadIcon key={it.iconUrl ?? ''} item={it} />}
      trailing={it.hint ? <span className="t2s-count">{it.hint}</span> : undefined}
      onClick={(e) => src.open(it, { newTab: e.metaKey || e.ctrlKey })}
      onContextMenu={(e) => {
        const acts = src.itemMenu?.(it) ?? []
        if (!acts.length) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, actions: acts })
      }}
    >
      <span className="t2s-srow-title">{it.title}</span>
    </SidebarRow>
  )

  return (
    <div className="t2sw-plug">
      {!!src.actions?.length && (
        <div className="t2sw-plug-acts">
          {src.actions.map((a) => (
            <button key={a.id} className="t2sw-plug-btn" onClick={() => a.run()}>{a.label}</button>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <>
          <div className="t2sw-plug-sec">
            <span className="t2s-group-label">{src.title}</span>
            {src.groupActions?.map((a) => (
              <button key={a.id} className="t2sw-plug-mini" title={a.label} onClick={() => a.run()}>＋</button>
            ))}
          </div>
          <SidebarRow
            className={group === null ? 'active' : undefined}
            lead={<Folder className="t2s-lead-icon t2s-dim" />}
            onClick={() => setGroup(null)}
          >
            <span className="t2s-srow-title">{t2sAll()}</span>
          </SidebarRow>
          {groups.map((g) => (
            <SidebarRow
              key={g.key}
              className={`${group === g.key ? 'active' : ''}${dropKey === `g:${g.key}` ? ' amx-drop-into' : ''}`.trim() || undefined}
              title={g.title}
              {...dropProps(`g:${g.key}`, { group: g.key })}
              lead={resolveIcon(g.icon, <Folder className="t2s-lead-icon t2s-dim" />)}
              trailing={g.count !== undefined ? <span className="t2s-count">{g.count}</span> : undefined}
              onClick={() => setGroup(g.key)}
            >
              <span className="t2s-srow-title">{g.title}</span>
            </SidebarRow>
          ))}
        </>
      )}

      {src.search && (
        <div className="t2s-search">
          <Search size={13} className="t2s-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={src.title} />
        </div>
      )}

      <div
        className={`t2sw-plug-list${dropKey === 'list' ? ' amx-drop-into' : ''}`}
        {...dropProps('list', { group: group ?? undefined })}
      >
        {sections
          ? sections.map(([g, list]) =>
              g === '' ? <div key="__flat">{list.map(row)}</div> : (
                <div key={g}>
                  <div className="t2sw-plug-sec"><span className="t2s-group-label">{g}</span><span className="t2s-count">{list.length}</span></div>
                  {list.map(row)}
                </div>
              ))
          : items.map(row)}
        {items.length === 0 && <div className="t2sw-empty">{query ? '没有匹配项' : src.title}</div>}
      </div>

      {menu && (
        <>
          <div className="t2sw-plug-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="t2sw-plug-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 40 - menu.actions.length * 28) }}>
            {menu.actions.map((a) => (
              <div key={a.id} onClick={() => { setMenu(null); a.run() }}>{a.label}</div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const t2sAll = (): string => (document.documentElement.lang.startsWith('zh') ? '全部' : 'All')

/** 统一「大纲」视图:主视图=chat → 会话目录(DOM 扫描);=编辑器 → 笔记标题大纲(块模型);其他 → 空态。
 *
 *  `params.sourcePath` 在场 = **自带身份**(仪表盘大纲卡):不跟随活动主视图,直接给那篇笔记开大纲。
 *  没有它的时候,这个视图在仪表盘里必然落空态(`useActiveMainType()` 读到的是 'dashboard')——
 *  那正是 2026-08-25 用户实报的「大纲卡永远空白」,见方案 §6.4 C 类。 */
export function OutlineView(props: Partial<ViewProps> = {}) {
  const { t } = useI18n()
  const mainType = useActiveMainType()
  const src = typeof props.params?.sourcePath === 'string' ? props.params.sourcePath : ''
  if (src && window.amadeus) return <ScopedPageOutline path={src} scope={`${props.leaf?.id ?? 'outline'}::src`} />
  if (mainType === 'chat') return <TocView />
  if (mainType === 'amadeus-editor' && window.amadeus) return <AmadeusOutlineView />
  return <div className="t2sw-empty">{t('outline.empty')}</div>
}
