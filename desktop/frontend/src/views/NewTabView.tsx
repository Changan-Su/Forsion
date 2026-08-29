/** 新建标签页(空白启动器):点主区标签栏末尾的 ＋ 打开,所有 Space 统一用它。
 *  分区:最近使用(会话/笔记/文件/视图)→ Forsion 原生 → 每个插件一组(按视图来源分类,不再按主/侧区)。
 *  卡片单击=在其默认位置打开(多数主区 Tab;侧栏类视图在侧栏);可拖入 tab bar / side bar「落点即开」。 */
import { type ReactNode } from 'react'
import { Plus, SquarePen, Bot, MessageCircle, FileText, CalendarDays, Mail, ListTodo, Code2, Workflow, Network, PenTool, Globe, TerminalSquare, LayoutDashboard, House } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { openSpecial } from './SpecialViews'
import { useWorkspace, useSpaceStore, getActiveSpace, getView, label, startOpenDrag } from '@lcl/engine'
import { AMADEUS_ENABLED } from '../spaces'
import { useRecentViews, type RecentView } from '../recentViews'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { usePageStore } from '@amadeus/store/pageStore'
import { openNote, openDb, openPdf, openDrawing, openDashboard, openImage, openFile, createDrawing, createDashboard } from '../amadeusNav'
import { openDailyNote } from '../amadeusTemplates'
import { openNewChat, openSession } from '../sessionNav'
import { useI18n } from '../i18n'
import { pluginDisplayName } from '../amadeus/plugins/display'
import { openBrowser, openTerminal } from '../builtins'
import type { ViewProps } from '@lcl/engine/types'
import { useShallow } from 'zustand/react/shallow'

/** drag 有值 = 卡片可拖入 tab/side bar 落点即开(type/params 交给 openView);无值 = 仅单击(动作类/特殊视图)。 */
interface Item { key: string; icon: ReactNode; label: string; run: () => void; show: boolean; drag?: { type: string; params?: Record<string, unknown> } }

export function NewTabView({ leaf }: ViewProps) {
  const { t, locale } = useI18n()
  const zh = document.documentElement.lang.startsWith('zh')
  const s = useApp(useShallow((state) => ({
    specialEnabled: state.specialEnabled,
    sessions: state.sessions,
    setActiveId: state.setActiveId,
    setNewChatWs: state.setNewChatWs,
    setNewChatCfg: state.setNewChatCfg,
    setNewChatModel: state.setNewChatModel,
  })))
  useSpaceStore((state) => state.activeSpaceId) // 换 Space 重渲(原生段的侧栏项取自当前 Space 的 defaults)
  const recents = useRecentViews((state) => state.items)
  const pluginViews = usePluginStore((state) => state.views)
  const pluginCreators = usePluginStore((state) => state.fileCreators)
  const plugins = usePluginStore((state) => state.plugins)
  const vaultRoot = usePageStore((state) => state.vaultRoot)
  const pages = usePageStore((state) => state.pages)
  const hasBackend = !!window.tangu?.backendStatus
  const amadeusOn = !!window.amadeus && AMADEUS_ENABLED // 笔记/文件项跟随 Amadeus 门控(与 Space 注册同纪律)
  const ws = () => useWorkspace.getState()

  // 门面统一在 sessionNav:站在这张空白页里点「新对话」就该开在**这个**标签,不是跳回老聊天把它清空。
  const newChat = (): void => { openNewChat() }
  // 落点面板一律由 openNote 门面现算(createPage / openDailyNote 内部都走它):它会把**当前这个新标签**
  // 就地切成编辑器。这里别再预开一个空编辑器 tab —— 已有编辑器时那份是白开的,新建仍落在别处。
  const newNote = (): void => {
    if (vaultRoot) void usePageStore.getState().createPage()
  }

  // Forsion 原生 —— 主区入口(跨 Space 全量列出)。动作类(新建笔记/今日)不带 drag;视图类带 drag 可拖入侧栏。
  const nativeMain: Item[] = [
    // 主页来自「主页」内置插件:插件页关掉即反注册 → getView 落空 → 这张卡自动消失(同下面的日历/浏览器/终端)。
    { key: 'homepage', icon: <House size={20} />, label: t('space.home'), run: () => ws().openView('homepage', {}, 'main'), show: !!getView('homepage'), drag: { type: 'homepage' } },
    // 「新对话」「新建笔记」「今日日记」是动作(清 activeId/草稿、创建文件)→ 只单击、不带 drag:
    // 拖拽走 openView 会绕过动作,chat 又是 singleton(reuseKey:'primary')→ 只会聚焦旧对话而非新建。
    { key: 'chat', icon: <MessageCircle size={20} />, label: t('sidebar.newChat'), run: newChat, show: PRODUCT.spaces.includes('tangu') },
    { key: 'new-note', icon: <SquarePen size={20} />, label: t('newtab.newNote'), run: newNote, show: amadeusOn },
    { key: 'daily', icon: <CalendarDays size={20} />, label: t('newtab.today'), run: () => { void openDailyNote() }, show: amadeusOn && !!vaultRoot },
    // 内置文件类型的「新建」入口:与文件树右键、命令面板、笔记里的斜杠项并列的第四条主路径 ——
    // 这些视图都靠 params 认领具体文件,没有「裸开一个空视图」的形态,所以只能以动作卡出现、
    // 不带 drag(拖进去会开出一个没有文件的空视图)。插件声明的创建器同理,见下面 pluginGroups。
    { key: 'new-drawing', icon: <PenTool size={20} />, label: zh ? '新建白板' : 'New whiteboard', run: () => { void createDrawing('') }, show: amadeusOn && !!vaultRoot },
    { key: 'new-dashboard', icon: <LayoutDashboard size={20} />, label: zh ? '新建仪表盘' : 'New dashboard', run: () => { void createDashboard('') }, show: amadeusOn && !!vaultRoot },
    // 日历/待办来自「日历」内置插件:在插件页关掉即反注册 → getView 落空 → 这两块自动消失(同下面的浏览器/终端)。
    { key: 'calendar', icon: <CalendarDays size={20} />, label: t('view.calendar'), run: () => ws().openView('calendar', {}, 'main'), show: !!getView('calendar'), drag: { type: 'calendar' } },
    { key: 'todo-list', icon: <ListTodo size={20} />, label: t('view.todo'), run: () => ws().openView('todo-list', {}, 'main'), show: !!getView('todo-list'), drag: { type: 'todo-list' } },
    { key: 'inbox', icon: <Mail size={20} />, label: t('inbox.reader'), run: () => ws().openView('inbox-reader', {}, 'main'), show: hasBackend, drag: { type: 'inbox-reader' } },
    { key: 'agents', icon: <Bot size={20} />, label: t('special.agents.title'), run: () => openSpecial('agents'), show: hasBackend && (s.specialEnabled.historian || s.specialEnabled.muse) },
    // Coding / Automation Space 的主视图(单例);仅其注册(产品档案 + 能力门控)后出现,drag 可拖入任意区。
    { key: 'code-studio', icon: <Code2 size={20} />, label: t('view.codeStudio'), run: () => ws().openView('code-studio', {}, 'main'), show: !!getView('code-studio'), drag: { type: 'code-studio' } },
    { key: 'automation-detail', icon: <Workflow size={20} />, label: t('view.automationDetail'), run: () => ws().openView('automation-detail', {}, 'main'), show: !!getView('automation-detail'), drag: { type: 'automation-detail' } },
    // 内置插件的两个视图:在插件页关掉即反注册 → getView 落空 → 这两块自动消失。
    { key: 'browser', icon: <Globe size={20} />, label: t('browser.title'), run: () => openBrowser(), show: !!getView('browser'), drag: { type: 'browser' } },
    { key: 'terminal', icon: <TerminalSquare size={20} />, label: t('terminal.title'), run: () => openTerminal(), show: !!getView('terminal'), drag: { type: 'terminal' } },
  ]

  // Forsion 原生 —— 侧栏视图 = 当前 Space 的 sidebarDefaults(名称/图标查注册表)。单击开在其所属侧;
  // 收起态先 toggleSidebar 展开(还原 stash 全部视图——直接 openView 会覆盖成单视图),再 openView 激活/补开。
  const space = getActiveSpace()
  const nativeSide: Item[] = (['left', 'right'] as const).flatMap((loc) =>
    (space?.sidebarDefaults[loc] ?? []).map((p) => {
      const def = getView(p.type)
      const Icon = def?.icon
      return {
        key: `${loc}:${p.type}`,
        icon: Icon ? <Icon size={20} /> : <FileText size={20} />,
        label: def ? label(def.displayName) : p.type,
        run: () => {
          const w = useWorkspace.getState()
          const visible = loc === 'left' ? w.leftVisible : w.rightVisible
          if (!visible) w.toggleSidebar(loc)
          ws().openView(p.type, p.params, loc) // 带上该 Space 声明的默认 params(如 Coding 侧栏 chat 的 followActive/reuseKey)
        },
        show: !!def,
        drag: { type: p.type, params: p.params }, // 拖入 tab bar → 主区;拖入另一侧 → 该侧;params 随行
      }
    }),
  )

  // 每个插件一组:插件视图(plugin:<id>:<viewId>)按 pluginId 分组,组标题 = 插件名。
  const pluginGroups: { pluginId: string; name: string; items: Item[] }[] = []
  const groupFor = (pluginId: string): { pluginId: string; name: string; items: Item[] } => {
    let g = pluginGroups.find((x) => x.pluginId === pluginId)
    if (!g) { g = { pluginId, name: (() => { const pp = plugins.find((p) => p.id === pluginId); return pp ? pluginDisplayName(pp, locale) : pluginId })(), items: [] }; pluginGroups.push(g) }
    return g
  }
  for (const o of pluginViews) {
    const type = `plugin:${o.pluginId}:${o.item.id}`
    const Icon = getView(type)?.icon
    groupFor(o.pluginId).items.push({
      key: type,
      icon: Icon ? <Icon size={20} /> : <FileText size={20} />,
      label: o.item.title,
      run: () => ws().openView(type, {}, 'main'),
      show: true,
      drag: { type },
    })
  }
  // 插件声明的「新建 …」(registerFileCreator)同样进新建标签页 —— 内置的「新建白板」在这儿,
  // 插件的就也该在这儿:两者的差别只应该是「谁提前装好了」。没有库就没处新建,故跟着 vaultRoot 显示。
  // 是动作不是视图 → 不带 drag(同上面的内置创建器)。
  for (const o of pluginCreators) {
    groupFor(o.pluginId).items.push({
      key: `creator:${o.pluginId}:${o.item.id}`,
      icon: <span style={{ fontSize: 20, lineHeight: '20px', display: 'inline-flex' }}>{resolveIcon(o.item.icon, '＋')}</span>,
      label: o.item.label,
      run: () => { void Promise.resolve(o.item.run('')).catch((e) => console.error('[amadeus] 插件新建失败', e)) },
      show: amadeusOn && !!vaultRoot,
    })
  }

  /** 重开一条「最近使用」:按 kind 分派到专属门面 / openView。 */
  const openRecent = (r: RecentView): void => {
    if (r.kind === 'note') { void openNote(r.id); return }
    // 会话走门面(认领已开的标签 / 落进当前这张空白页 / 冻结老聊天),别在这儿另写一套 —— 另写的
    // 那套恒复用主聊天 = 在新标签里点最近会话,内容跑到老标签里去了。
    if (r.kind === 'chat') { openSession(r.id); return }
    if (r.kind === 'file') {
      switch (r.viewType) {
        case 'amadeus-db': openDb(r.id); break
        case 'amadeus-pdf': openPdf(r.id); break
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
  const recentItems: Item[] = recents
    .filter((r) => {
      if (r.kind === 'note') return amadeusOn && pages.includes(r.id)
      if (r.kind === 'chat') return s.sessions.some((x) => x.id === r.id)
      if (r.kind === 'file') return amadeusOn && !!r.viewType && !!getView(r.viewType)
      if (r.kind === 'view') return !!r.viewType && !!getView(r.viewType)
      return false
    })
    .slice(0, 8)
    .map((r) => {
      const vt = r.viewType || (r.kind === 'note' ? 'amadeus-editor' : 'chat')
      const Icon = getView(vt)?.icon
      return {
        key: r.key,
        icon: Icon ? <Icon size={20} /> : <FileText size={20} />,
        // kind='view' 的标题**按注册表实时求值**,不用快照:`record` 存的是当时的 `label(displayName)`,
        // 而冷启动恢复布局那一下跑在 LocaleProvider 挂载**之前** —— 那时 appStore.tr 还是缺省的
        // `(k) => k`,存进去的就是裸 i18n 键(实测:退出时停在日历 → 下次启动这里显示「view.calendar」)。
        // 文件/笔记/会话的标题是真名字不是译文,照旧用快照。
        label: (r.kind === 'chat' && s.sessions.find((x) => x.id === r.id)?.title)
          || (r.kind === 'view' ? label(getView(vt)?.displayName ?? r.title) : r.title),
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

  const section = (title: string, items: Item[], key: string = title): ReactNode => {
    const shown = items.filter((i) => i.show)
    if (!shown.length) return null
    return (
      <div className="newtab-sec" key={key}>
        <div className="newtab-sec-title">{title}</div>
        <div className="newtab-grid">
          {shown.map((it) => (
            <button
              key={it.key}
              className="newtab-card"
              title={it.label}
              draggable={!!it.drag}
              style={it.drag ? { cursor: 'grab' } : undefined}
              onDragStart={it.drag ? (e) => startOpenDrag(e.dataTransfer, it.drag!) : undefined}
              onClick={() => pick(it)}
            >
              <span className="newtab-card-ic">{it.icon}</span>
              <span className="newtab-card-label">{it.label}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="newtab">
      <div className="newtab-inner">
        <div className="newtab-head"><Plus size={18} /> <span>{t('newtab.title')}</span></div>
        {section(t('newtab.recentSection'), recentItems)}
        {section(zh ? 'Forsion 原生' : 'Forsion', [...nativeMain, ...nativeSide])}
        {pluginGroups.map((g) => section(g.name, g.items, `plugin:${g.pluginId}`))}
      </div>
    </div>
  )
}
