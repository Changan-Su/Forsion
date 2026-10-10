/** 新建标签页(空白启动器):点主区标签栏末尾的 ＋ 打开,所有 Space 统一用它;关掉主区最后一个标签也落到这里。
 *  按「要干什么」分段(2026-10-09,方案图 docs/ToBeImproved/新建标签页方案_2026-10-09):
 *    搜索(快速查找的入口)→ 最近使用 → 新建(动作,只能点)→ 打开(一个 Space 一格 + 不属于任何 Space 的视图)→ 当前 Space 的侧栏面板。
 *  单击 = 开在这个标签里(侧栏面板开在其所属侧);视图类可拖入 tab bar / side bar「落点即开」。
 *  ⚠️每个可点项都带 .newtab-card / .newtab-card-label:十来个 e2e 按这两个类 + 文案找入口,长相由 .nt-* 修饰类决定(base.css)。 */
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Bot, FileText, Globe, TerminalSquare, Search, ChevronDown, ArrowUpRight, PanelLeft, PanelRight } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { hasNativeFeature, amadeusAvailable } from '../features/runtime'
import { openSpecial } from './SpecialViews'
import { useWorkspace, useSpaceStore, useRibbonStore, getActiveSpace, setActiveSpace, getView, label, startOpenDrag, rankIds, OverlayAt, formatHotkey, effectiveHotkey, isMacPlatform, type PersistedPanel } from '@lcl/engine'
import { AMADEUS_ENABLED } from '../spaces'
import { pluginOfSpace } from '../userSpaces'
import { homeSlotSpaceId } from '../homeSlot'
import { useRecentViews, type RecentView } from '../recentViews'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { openNote, openDb, openDrawing, openDashboard, openImage, openFile, createDrawing, createDashboard } from '../amadeusNav'
import { openDailyNote } from '../amadeusTemplates'
import { openNewChat, openSession } from '../sessionNav'
import { useQuickFind } from '../quickFind'
import { useI18n, registerMessages } from '../i18n'
import { launcherTiles } from './newTabModel'
import type { ViewProps } from '@lcl/engine/types'
import { useShallow } from 'zustand/react/shallow'

registerMessages({
  'newtab.newDrawing': { zh: '新建白板', en: 'New whiteboard' },
  'newtab.newDashboard': { zh: '新建仪表盘', en: 'New dashboard' },
  'newtab.createSection': { zh: '新建', en: 'New' },
  'newtab.openSection': { zh: '打开', en: 'Open' },
  'newtab.openHint': { zh: '可拖到标签栏或侧栏', en: 'Drag to the tab bar or a side panel' },
  'newtab.standalone': { zh: '不属于任何 Space', en: 'Not part of a Space' },
  'newtab.sidePanels': { zh: '{space} 的侧栏面板', en: '{space} side panels' },
  'newtab.enterSpace': { zh: '进入「{space}」Space', en: 'Go to the {space} Space' },
  'newtab.moreViews': { zh: '{space} 的全部视图', en: 'All {space} views' },
  'newtab.panel.sessions': { zh: '会话', en: 'Sessions' },
  'newtab.panel.files': { zh: '文件', en: 'Files' },
  'newtab.panel.notes': { zh: '笔记', en: 'Notes' },
})

/** drag 有值 = 可拖入 tab/side bar 落点即开(type/params 交给 openView);无值 = 仅单击(动作类/特殊视图)。
 *  views = Space 格子的展开菜单(该 Space 的各个视图,末尾另有「进入 Space」)。 */
interface Item { key: string; icon: ReactNode; label: string; run: () => void; show: boolean; drag?: { type: string; params?: Record<string, unknown> }; meta?: string; spaceId?: string; views?: Item[] }

export function NewTabView({ leaf }: ViewProps) {
  const { t } = useI18n()
  const s = useApp(useShallow((state) => ({
    specialEnabled: state.specialEnabled,
    sessions: state.sessions,
    setActiveId: state.setActiveId,
    setNewChatWs: state.setNewChatWs,
    setNewChatCfg: state.setNewChatCfg,
    setNewChatModel: state.setNewChatModel,
  })))
  const spaces = useSpaceStore((state) => state.spaces) // 插件 / 用户 Space 是异步注册的,订阅着才会补出格子
  useSpaceStore((state) => state.activeSpaceId) // 换 Space 重渲(侧栏面板取自当前 Space 的 defaults)
  const ribbonOrder = useRibbonStore((state) => state.order)
  useRibbonStore((state) => state.items) // 主位槽换 Space 时条目会重挂 → 重渲(下面 homeSlotSpaceId 是现读的)
  const recents = useRecentViews((state) => state.items)
  const pluginViews = usePluginStore((state) => state.views)
  const pluginCreators = usePluginStore((state) => state.fileCreators)
  const vaultRoot = usePageStore((state) => state.vaultRoot)
  const pages = usePageStore((state) => state.pages)
  const hasBackend = !!window.tangu?.backendStatus
  const amadeusOn = amadeusAvailable() && AMADEUS_ENABLED // 笔记/文件项跟随 Amadeus 门控(与 Space 注册同纪律)
  const ws = () => useWorkspace.getState()
  const [menu, setMenu] = useState<{ x: number; y: number; item: Item } | null>(null)
  // 关菜单走 window 监听(与 homeSlot / amadeusViews 的 ctx-menu 同款),不铺 scrim。
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [menu])

  // 门面统一在 sessionNav:站在这张空白页里点「新对话」就该开在**这个**标签,不是跳回老聊天把它清空。
  const newChat = (): void => { openNewChat() }
  // 落点面板一律由 openNote 门面现算(createPage / openDailyNote 内部都走它):它会把**当前这个新标签**
  // 就地切成编辑器。这里别再预开一个空编辑器 tab —— 已有编辑器时那份是白开的,新建仍落在别处。
  const newNote = (): void => {
    if (vaultRoot) void usePageStore.getState().createPage()
  }

  // 新建 —— 都是动作(清 activeId/草稿、创建文件),只单击、不带 drag:拖拽走 openView 会绕过动作,
  // chat 又是 singleton(reuseKey:'primary')→ 只会聚焦旧对话而非新建;文件类视图靠 params 认领具体文件,
  // 没有「裸开一个空视图」的形态。插件声明的创建器(registerFileCreator)同理 —— 内置的和插件的差别只应该是
  // 「谁提前装好了」;没有库就没处新建,故跟着 vaultRoot 显示。
  const plus = <Plus size={14} />
  const createItems: Item[] = [
    { key: 'chat', icon: plus, label: t('sidebar.newChat'), run: newChat, show: hasNativeFeature('tangu') },
    { key: 'new-note', icon: plus, label: t('newtab.newNote'), run: newNote, show: amadeusOn },
    { key: 'daily', icon: plus, label: t('newtab.today'), run: () => { void openDailyNote() }, show: amadeusOn && !!vaultRoot },
    { key: 'new-drawing', icon: plus, label: t('newtab.newDrawing'), run: () => { void createDrawing('') }, show: amadeusOn && !!vaultRoot },
    { key: 'new-dashboard', icon: plus, label: t('newtab.newDashboard'), run: () => { void createDashboard('') }, show: amadeusOn && !!vaultRoot },
    ...pluginCreators.map((o): Item => ({
      key: `creator:${o.pluginId}:${o.item.id}`,
      icon: plus,
      label: o.item.label,
      run: () => { void Promise.resolve(o.item.run('')).catch((e) => console.error('[amadeus] 插件新建失败', e)) },
      show: amadeusOn && !!vaultRoot,
    })),
  ]

  /** 一个视图项:entity 视图(配方里钉死的那份文件)用文件名当名字,其余用注册表里的视图名。 */
  const viewItem = (p: PersistedPanel, key: string): Item => {
    const def = getView(p.type)
    const Icon = def?.icon
    const id = def?.kind === 'entity' && def.idParam ? p.params?.[def.idParam] : undefined
    return {
      key,
      icon: Icon ? <Icon size={16} /> : <FileText size={16} />,
      label: typeof id === 'string' ? (id.split('/').pop() || id) : def ? label(def.displayName) : p.type,
      run: () => ws().openView(p.type, p.params, 'main'),
      show: !!def,
      drag: { type: p.type, params: p.params },
    }
  }

  // 打开 —— 一个 Space 一格,顺序跟 Ribbon 一致(归属规则见 newTabModel)。内置的和插件带来的不再区分;
  // 名字、图标用 Space 自己的。单击 = 开它的第一个视图(开在这个标签里);多视图的在展开菜单里选。
  // 主位槽里的那个 Space 在 Ribbon 上恒排最前(不看它在持久顺序里的名次)。
  const homeId = homeSlotSpaceId()
  const ranked = rankIds(spaces.map((sp) => `space:${sp.id}`), ribbonOrder).flatMap((id) => spaces.find((sp) => `space:${sp.id}` === id) ?? [])
  const ordered = [...ranked.filter((sp) => sp.id === homeId), ...ranked.filter((sp) => sp.id !== homeId)]
  const { tiles, free } = launcherTiles(ordered, getView, pluginOfSpace, pluginViews.map((o) => `plugin:${o.pluginId}:${o.item.id}`))
  const spaceItems: Item[] = tiles.map(({ space, views }) => {
    const vs = views.map((p, i) => viewItem(p, `view:${space.id}:${i}`))
    const SpIcon = space.icon
    return { ...vs[0], key: `space:${space.id}`, icon: SpIcon ? <SpIcon size={16} /> : vs[0].icon, label: label(space.name), spaceId: space.id, views: vs }
  })
  // 不属于任何 Space:浏览器 / 终端(内置插件的两个视图,插件页关掉即反注册 → getView 落空 → 自动消失;
  // 和别的格子一样就地开在这个标签里,所以不走 builtins 那两个「恒另开标签」的门面)、
  // 后台 Agent 详情(特殊视图,不带 drag),以及没带 Space 的插件视图。
  const freeItems: Item[] = [
    { key: 'browser', icon: <Globe size={16} />, label: t('browser.title'), run: () => ws().openView('browser', {}, 'main'), show: !!getView('browser'), drag: { type: 'browser' } },
    { key: 'terminal', icon: <TerminalSquare size={16} />, label: t('terminal.title'), run: () => ws().openView('terminal', {}, 'main'), show: !!getView('terminal'), drag: { type: 'terminal' } },
    { key: 'agents', icon: <Bot size={16} />, label: t('special.agents.title'), run: () => openSpecial('agents'), show: hasBackend && (s.specialEnabled.historian || s.specialEnabled.muse) },
    ...free.map((type) => viewItem({ type, params: {} }, type)),
  ]

  // 当前 Space 的侧栏面板 = 它的 sidebarDefaults(名称查注册表)。单击开在其所属侧;
  // 收起态先 toggleSidebar 展开(还原 stash 全部视图——直接 openView 会覆盖成单视图),再 openView 激活/补开。
  // 「工作区」视图的档位由 Space 写死在条目上(spaces.tsx),同一个 Space 里可以有两张 → 按档位叫名字,不然两张都叫「工作区」。
  const space = getActiveSpace()
  const panelName = (p: PersistedPanel): string | undefined => {
    const mode = p.type === 'workspace' ? p.params?.mode : undefined
    if (mode === 'orbits' || mode === 'sessions') return t('newtab.panel.sessions')
    if (mode === 'files') return t('newtab.panel.files')
    if (mode === 'notes') return t('newtab.panel.notes')
    const def = getView(p.type)
    return def ? label(def.displayName) : undefined
  }
  const sideItems: Item[] = (['left', 'right'] as const).flatMap((loc) =>
    (space?.sidebarDefaults[loc] ?? []).map((p): Item => ({
      key: `${loc}:${p.type}:${String(p.params?.mode ?? '')}`,
      icon: loc === 'left' ? <PanelLeft size={14} /> : <PanelRight size={14} />,
      label: panelName(p) ?? p.type,
      run: () => {
        const w = useWorkspace.getState()
        const visible = loc === 'left' ? w.leftVisible : w.rightVisible
        if (!visible) w.toggleSidebar(loc)
        ws().openView(p.type, p.params, loc) // 带上该 Space 声明的默认 params(如 Coding 侧栏 chat 的 followActive/reuseKey)
      },
      show: !!getView(p.type),
      drag: { type: p.type, params: p.params }, // 拖入 tab bar → 主区;拖入另一侧 → 该侧;params 随行
    })),
  )

  /** 重开一条「最近使用」:按 kind 分派到专属门面 / openView。 */
  const openRecent = (r: RecentView): void => {
    if (r.kind === 'note') { void openNote(r.id); return }
    // 会话走门面(认领已开的标签 / 落进当前这张空白页 / 冻结老聊天),别在这儿另写一套 —— 另写的
    // 那套恒复用主聊天 = 在新标签里点最近会话,内容跑到老标签里去了。
    if (r.kind === 'chat') { openSession(r.id); return }
    if (r.kind === 'file') {
      switch (r.viewType) {
        case 'amadeus-db': openDb(r.id); break
        case 'amadeus-pdf': openFile(r.id); break // 经 openFile:插件接管了 PDF 就进插件视图,否则(及库外 PDF)仍是内置阅读器
        case 'amadeus-drawing': openDrawing(r.id); break
        case 'amadeus-dashboard': // legacy:旧「最近使用」条目仍记着老类型 → 同样开进新画布版
        case 'dashboard': openDashboard(r.id); break
        case 'amadeus-image': openImage(r.id); break
        case 'wsfile': ws().openView('wsfile', { path: r.id, name: r.title }, 'main', { newTab: true }); break // 同布局恢复重建 wsfile 面板的路径(bare path,不需 openWsFile 的 load 闭包)
        default: openFile(r.id)
      }
      return
    }
    // kind === 'view'
    if (r.viewType === 'agents-detail') { openSpecial('agents'); return }
    if (r.viewType) ws().openView(r.viewType, {}, 'main')
  }

  // 最近使用:会话/笔记/文件/视图,跨 Space。只显示仍有效的目标:
  // - 笔记须仍在 pages(避免 loadPage「缺文件即新建」把删掉的复活成空文件);会话须仍存在;
  // - 文件/视图按注册表存在性 + Amadeus 门控过滤(文件路径存活由门面自兜底,不在此硬校验)。
  // 每行右侧的灰字 = 它是什么 · 属于哪个 Space(和标题重复的那半不写;笔记只写 Space —— 它的视图名是「编辑器」)。
  const spaceName = (id: string): string | undefined => { const sp = spaces.find((x) => x.id === id); return sp ? label(sp.name) : undefined }
  const spaceOfView = new Map<string, string>()
  for (const { space: sp, views } of tiles) for (const v of views) if (!spaceOfView.has(v.type)) spaceOfView.set(v.type, label(sp.name))
  const recentItems: Item[] = recents
    .filter((r) => {
      if (r.kind === 'note') return amadeusOn && pages.includes(r.id)
      if (r.kind === 'chat') return s.sessions.some((x) => x.id === r.id)
      if (r.kind === 'file') return amadeusOn && !!r.viewType && !!getView(r.viewType)
      if (r.kind === 'view') return !!r.viewType && !!getView(r.viewType)
      return false
    })
    .slice(0, 6)
    .map((r) => {
      const vt = r.viewType || (r.kind === 'note' ? 'amadeus-editor' : 'chat')
      const def = getView(vt)
      const Icon = def?.icon
      // kind='view' 的标题**按注册表实时求值**,不用快照:`record` 存的是当时的 `label(displayName)`,
      // 而冷启动恢复布局那一下跑在 LocaleProvider 挂载**之前** —— 那时 appStore.tr 还是缺省的
      // `(k) => k`,存进去的就是裸 i18n 键(实测:退出时停在日历 → 下次启动这里显示「view.calendar」)。
      // 文件/笔记/会话的标题是真名字不是译文,照旧用快照。
      const title = (r.kind === 'chat' && s.sessions.find((x) => x.id === r.id)?.title)
        || (r.kind === 'view' ? label(def?.displayName ?? r.title) : r.title)
      const what = (r.kind === 'chat' || r.kind === 'file') && def ? label(def.displayName) : undefined
      const where = r.kind === 'chat' ? spaceName('tangu') : r.kind === 'view' ? spaceOfView.get(vt) : vt === 'wsfile' ? undefined : spaceName('amadeus')
      return {
        key: r.key,
        icon: Icon ? <Icon size={16} /> : <FileText size={16} />,
        label: title,
        meta: [...new Set([what, where])].filter((x) => x && x !== title).join(' · '),
        run: () => openRecent(r),
        show: true,
      }
    })

  // 选中:主区项经 openView 的「就地导航」直接把本空白页变成目标视图(不可再关,否则关掉的是刚
  // 切好的视图);run 后本页仍是 launcher 的情形(侧栏项 / 跳去既有 tab 的项)才关掉自己,维持
  // 「空白页消失」的旧观感。closeLeaf 带「主区关空即回填」兜底,不裸关。
  const pick = (it: Item): void => {
    it.run()
    const p = useWorkspace.getState().api?.getPanel(leaf.id)
    if (p && ((p.params ?? {}) as { __type?: string }).__type === 'launcher') useWorkspace.getState().closeLeaf(leaf.id)
  }

  const card = (it: Item, cls: string): ReactNode => (
    <button
      key={it.key}
      className={`newtab-card ${cls}`}
      title={it.label}
      draggable={!!it.drag}
      style={it.drag ? { cursor: 'grab' } : undefined}
      onDragStart={it.drag ? (e) => startOpenDrag(e.dataTransfer, it.drag!) : undefined}
      onClick={() => pick(it)}
    >
      <span className="newtab-card-ic">{it.icon}</span>
      <span className="newtab-card-label">{it.label}</span>
      {it.meta && <span className="nt-meta">{it.meta}</span>}
    </button>
  )
  /** Space 格子:右键、或(多视图时)点右边的箭头,出展开菜单。事件不让冒到 window —— 那边的监听会把刚开的菜单关掉。 */
  const tile = (it: Item): ReactNode => {
    if (!it.views) return <div className="nt-tile" key={it.key}>{card(it, 'nt-tilebtn')}</div>
    const more = it.views.length > 1
    return (
      <div
        key={it.key}
        className={`nt-tile${more ? ' has-more' : ''}`}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, item: it }) }}
      >
        {card(it, 'nt-tilebtn')}
        {more && (
          <button
            className="nt-more"
            title={t('newtab.moreViews', { space: it.label })}
            aria-label={t('newtab.moreViews', { space: it.label })}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.parentElement!.getBoundingClientRect()
              setMenu({ x: r.left, y: r.bottom + 4, item: it })
            }}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>
    )
  }
  const shown = (items: Item[]): Item[] => items.filter((i) => i.show)
  const section = (title: string, body: ReactNode, hint?: string): ReactNode => (
    <div className="newtab-sec">
      <div className="newtab-sec-title nt-head">{title}{hint && <span className="nt-hint">{hint}</span>}</div>
      {body}
    </div>
  )
  const recent = shown(recentItems), create = shown(createItems), spaceTiles = shown(spaceItems), freeTiles = shown(freeItems), side = shown(sideItems)
  // 手机上没有键盘,不标快捷键;桌面读用户改过的那一份。
  const hotkey = window.tangu?.mobile ? '' : formatHotkey(effectiveHotkey({ id: 'quick-find', hotkey: 'mod+p' }), isMacPlatform())

  return (
    <div className="newtab">
      <div className="newtab-inner nt">
        <button className="nt-search" onClick={() => useQuickFind.getState().openPalette()}>
          <Search size={16} />
          <span>{t('quickfind.placeholder')}</span>
          {hotkey && <kbd className="nt-kbd">{hotkey}</kbd>}
        </button>
        {recent.length > 0 && section(t('newtab.recentSection'), <div className="nt-rows">{recent.map((it) => card(it, 'nt-row'))}</div>)}
        {create.length > 0 && section(t('newtab.createSection'), <div className="nt-chips">{create.map((it) => card(it, 'nt-chip'))}</div>)}
        {spaceTiles.length + freeTiles.length > 0 && section(t('newtab.openSection'), (
          <>
            {spaceTiles.length > 0 && <div className="nt-tiles">{spaceTiles.map(tile)}</div>}
            {freeTiles.length > 0 && spaceTiles.length > 0 && <div className="nt-sub">{t('newtab.standalone')}</div>}
            {freeTiles.length > 0 && <div className="nt-tiles">{freeTiles.map(tile)}</div>}
          </>
        ), t('newtab.openHint'))}
        {side.length > 0 && space && (
          <div className="nt-side">
            <span>{t('newtab.sidePanels', { space: label(space.name) })}</span>
            {side.map((it) => card(it, 'nt-pchip'))}
          </div>
        )}
      </div>
      {menu && menu.item.views && createPortal(
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          {menu.item.views.map((v) => (
            // 菜单里的视图同样可拖(待办原先是一张可拖的卡);拖完收起菜单 —— 拖拽不产生 click,window 那条监听关不掉它。
            <button
              key={v.key}
              draggable={!!v.drag}
              onDragStart={v.drag ? (e) => startOpenDrag(e.dataTransfer, v.drag!) : undefined}
              onDragEnd={() => setMenu(null)}
              onClick={() => { setMenu(null); pick(v) }}
            >{v.icon}{v.label}</button>
          ))}
          <div className="ctx-separator" />
          <button onClick={() => { const id = menu.item.spaceId; setMenu(null); if (id) setActiveSpace(id) }}>
            <ArrowUpRight size={16} />{t('newtab.enterSpace', { space: menu.item.label })}
          </button>
        </OverlayAt>,
        document.body,
      )}
    </div>
  )
}
