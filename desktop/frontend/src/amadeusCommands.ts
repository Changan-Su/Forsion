/** Amadeus Space 的命令集:进入 Space 时注册进 engine 命令面板(mod+k),离开时撤销
 *  (engine 命令是全局平面列表,没有 Space 作用域,只能 add/remove 手动圈地)。
 *  mod+n 在 Space 内让位给「新建笔记」:进入时摘下 new-chat、离开时原样放回;
 *  若进入时 new-chat 尚未注册(启动即恢复到 Amadeus),它随后注册也排在本命令集之后,分发仍先命中这里。 */
import { useCommandStore, useSpaceStore, useWorkspace } from '@lcl/engine'
import type { Command } from '@lcl/engine'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiOverlay } from './amadeusOverlayStore'
import { amadeus } from '@amadeus/api'
import { openDailyNote } from './amadeusTemplates'
import { openTutorial } from './amadeusTutorial'
import { useAmadeusPrefs } from './amadeusPrefs'
import { createDashboard, createDrawing } from './amadeusNav'
import { setWikiFilesEnabled, wikiFilesEnabled } from '@amadeus/lib/wikiFiles'
import { translate } from './i18n'

const ps = () => usePageStore.getState()
const ws = () => useWorkspace.getState()
const cs = () => useCommandStore.getState()

const CMDS: Command[] = [
  { id: 'amadeus-new-note', title: () => translate('amadeus.new.note'), keywords: 'new note create 新建 笔记', hotkey: 'mod+n', run: () => { if (ps().vaultRoot) void ps().createPage() } },
  { id: 'amadeus-new-drawing', title: () => translate('amadeus.new.drawing'), keywords: 'new drawing whiteboard canvas excalidraw 新建 白板 画板 baiban', run: () => { if (ps().vaultRoot) void createDrawing('') } },
  { id: 'amadeus-new-dashboard', title: () => translate('amadeus.new.dashboard'), keywords: 'new dashboard canvas grid widget 新建 仪表盘 面板 看板 yibiaopan', run: () => { if (ps().vaultRoot) void createDashboard('') } },
  { id: 'amadeus-quick-switcher', title: () => translate('amadeus.cmd.quickSwitch'), keywords: 'quick switcher open jump 快速 切换 跳转', hotkey: 'mod+p', run: () => useUiOverlay.getState().open('switcher') },
  { id: 'amadeus-search', title: () => translate('amadeus.cmd.search'), keywords: 'search full text 搜索 全文', hotkey: 'mod+shift+f', run: () => openSearchView() },
  { id: 'amadeus-tutorial', title: () => translate('amadeus.cmd.tutorial'), keywords: 'tutorial guide help onboarding 教程 使用教程 帮助 入门 新手 jiaocheng bangzhu', run: () => void openTutorial() },
  { id: 'amadeus-daily-note', title: () => translate('amadeus.cmd.dailyNote'), keywords: 'daily note today journal 日记 今天 riji', run: () => void openDailyNote() },
  { id: 'amadeus-toggle-star', title: () => translate('amadeus.cmd.toggleStar'), keywords: 'star favorite bookmark 收藏 星标 shoucang', run: () => { const p = ps().activePage; if (p) useAmadeusPrefs.getState().toggleStar(p) } },
  { id: 'amadeus-toggle-source', title: () => translate('amadeus.cmd.toggleSource'), keywords: 'source markdown wysiwyg toggle 源码 可视', run: () => useUiOverlay.getState().toggleEditorMode() },
  { id: 'amadeus-open-vault', title: () => translate('amadeus.cmd.openVault'), keywords: 'vault open folder 打开 仓库 文件夹', run: () => void ps().openVault() },
  { id: 'amadeus-reveal', title: () => translate('amadeus.cmd.reveal'), keywords: 'reveal finder explorer 文件管理器 显示', run: () => { const p = ps().activePage; if (p) void amadeus.revealInFileManager(p) } },
  { id: 'amadeus-reindex', title: () => translate('amadeus.cmd.reindex'), keywords: 'reindex search index 索引 重建', run: () => void amadeus.reindex() },
  {
    id: 'amadeus-toggle-wiki-files',
    title: () => translate('amadeus.cmd.toggleWikiFiles'),
    keywords: 'wikilink attachment database toggle 双链 附件 数据库 补全 切换 fujian shujuku',
    run: () => {
      const next = !wikiFilesEnabled()
      setWikiFilesEnabled(next) // 先就地生效,再落盘(设置页读的是 config)
      void window.tangu?.setConfig?.({ notesWikiIncludeFiles: next })
      window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate(next ? 'amadeus.cmd.wikiFilesOn' : 'amadeus.cmd.wikiFilesOff') } }))
    },
  },
]

/** 打开(或聚焦)左栏全文搜索。旧引擎只激活已存在面板,后半段保留为跨版本兜底。 */
export function openSearchView(): void {
  ws().showSideView('left', 'amadeus-search')
  const st = useWorkspace.getState()
  const api = (st as unknown as { api?: { panels: Array<{ params?: Record<string, unknown> }> } }).api
  if (st.leftVisible && !api?.panels.some((p) => p.params?.__type === 'amadeus-search')) {
    ws().openView('amadeus-search', {}, 'left')
  }
}

let stashedNewChat: Command | undefined

function enter(): void {
  const st = cs()
  stashedNewChat = st.commands.find((c) => c.id === 'new-chat')
  if (stashedNewChat) st.removeCommand('new-chat')
  for (const c of CMDS) st.addCommand(c)
}

function leave(): void {
  const st = cs()
  for (const c of CMDS) st.removeCommand(c.id)
  if (stashedNewChat) { st.addCommand(stashedNewChat); stashedNewChat = undefined }
}

let installed = false
/** 由 registerSpaces() 在 window.amadeus && dev-gate 内调用一次。 */
export function installAmadeusCommands(): void {
  if (installed) return
  installed = true
  const apply = (id: string | null | undefined): void => { if (id === 'amadeus') enter(); else leave() }
  // 初始应用推迟一拍:registerSpaces 在 installEngine 里先于内置命令注册,
  // 启动即在 Amadeus 时同步 enter() 会摘不到 new-chat(其后注册 → 面板里「新对话」与「新建笔记」并存)。
  setTimeout(() => apply(useSpaceStore.getState().activeSpaceId), 0)
  useSpaceStore.subscribe((s, p) => { if (s.activeSpaceId !== p.activeSpaceId) apply(s.activeSpaceId) })
}
