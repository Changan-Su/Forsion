// 「打开光标处链接」两条命令(评审 L-20):进 Amadeus 的引擎命令集(amadeusCommands 的 CMDS),命令面板可见、
// 进设置里的快捷键表、可改键。口径照 foldCommands.ts:
//  · 缺省键 alt+enter(Obsidian 同键)/ alt+shift+enter(新标签页)。mod+alt+enter 已归「切换折叠」(B-13),
//    Mod-Enter 归待办勾选 / 在下方新建段(拍板 #3)—— 都避开。
//  · 焦点在正文里时,引擎的全局热键收不到带 Enter 的组合(PM 对 Enter 一律 preventDefault):编辑器内由
//    MarkdownBlock 的 handleKeyDown 按**同一份生效热键**(effectiveHotkey,含用户改键)接住;命令面板 / 焦点不在
//    正文时走 run(),作用在最近一次聚焦过的编辑器上(linkFollow 的记账)。
// ⚠️ 本模块开机即被 amadeusCommands 引入,**不许**静态依赖 Milkdown / 编辑器模块:动作在 blocks/markdown/linkFollow.ts,执行时懒取。
import type { Command } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'linkcmd.follow': { zh: '打开光标处链接', en: 'Open link at cursor' },
  'linkcmd.followNewTab': { zh: '在新标签页打开光标处链接', en: 'Open link at cursor in new tab' },
})

export type LinkCommandKind = 'follow' | 'followNewTab'

/** 两条命令的定义表:引擎命令(LINK_COMMANDS)与编辑器内的按键兜底(MarkdownBlock → linkFollow.linkKindOfEvent)同源。 */
export const LINK_BINDINGS: ReadonlyArray<{ id: string; kind: LinkCommandKind; hotkey: string }> = [
  { id: 'amadeus-follow-link', kind: 'follow', hotkey: 'alt+enter' },
  { id: 'amadeus-follow-link-new-tab', kind: 'followNewTab', hotkey: 'alt+shift+enter' },
]

const TITLE: Record<LinkCommandKind, string> = { follow: 'linkcmd.follow', followNewTab: 'linkcmd.followNewTab' }
const KEYWORDS: Record<LinkCommandKind, string> = {
  follow: 'open follow link wikilink cursor jump 打开 跟随 链接 双链 光标 跳转 dakai lianjie',
  followNewTab: 'open follow link new tab wikilink cursor 新标签 新标签页 打开 链接 双链 光标 biaoqian',
}

export const LINK_COMMANDS: Command[] = LINK_BINDINGS.map((b) => ({
  id: b.id,
  title: () => translate(TITLE[b.kind]),
  keywords: KEYWORDS[b.kind],
  hotkey: b.hotkey,
  run: (): Promise<void> => import('../blocks/markdown/linkFollow').then((m) => m.runLinkCommand(b.kind)),
}))
