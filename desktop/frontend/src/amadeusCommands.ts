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
import { useAmadeusPrefs } from './amadeusPrefs'

const ps = () => usePageStore.getState()
const ws = () => useWorkspace.getState()
const cs = () => useCommandStore.getState()

const CMDS: Command[] = [
  { id: 'amadeus-new-note', title: '新建笔记', keywords: 'new note create 新建 笔记', hotkey: 'mod+n', run: () => { if (ps().vaultRoot) void ps().createPage() } },
  { id: 'amadeus-quick-switcher', title: '快速切换笔记', keywords: 'quick switcher open jump 快速 切换 跳转', hotkey: 'mod+p', run: () => useUiOverlay.getState().open('switcher') },
  { id: 'amadeus-search', title: '搜索笔记(全文)', keywords: 'search full text 搜索 全文', hotkey: 'mod+shift+f', run: () => openSearchView() },
  { id: 'amadeus-daily-note', title: '打开今天的日记', keywords: 'daily note today journal 日记 今天 riji', run: () => void openDailyNote() },
  { id: 'amadeus-toggle-star', title: '收藏 / 取消收藏当前笔记', keywords: 'star favorite bookmark 收藏 星标 shoucang', run: () => { const p = ps().activePage; if (p) useAmadeusPrefs.getState().toggleStar(p) } },
  { id: 'amadeus-toggle-source', title: '切换 源码 / 可视 编辑', keywords: 'source markdown wysiwyg toggle 源码 可视', run: () => useUiOverlay.getState().toggleEditorMode() },
  { id: 'amadeus-open-vault', title: '打开 Vault…', keywords: 'vault open folder 打开 仓库 文件夹', run: () => void ps().openVault() },
  { id: 'amadeus-reveal', title: '在文件管理器中显示当前笔记', keywords: 'reveal finder explorer 文件管理器 显示', run: () => { const p = ps().activePage; if (p) void amadeus.revealInFileManager(p) } },
  { id: 'amadeus-reindex', title: '重建全文索引', keywords: 'reindex search index 索引 重建', run: () => void amadeus.reindex() },
]

/** 打开(或聚焦)左栏全文搜索:showSideView 只会激活「已存在」的面板——用户右键关掉过该 tab 时要重开。 */
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
