// 标题 / 列表折叠的三条命令(B-13,评审 2026-09-27):进 Amadeus 的引擎命令集(amadeusCommands 的 CMDS),
// 命令面板可见、进设置里的快捷键表、可改键。
//
// 缺省只给「切换折叠」一颗 mod+alt+enter:引擎按 e.key 比对热键,mac 上 Option 会把字母 / 符号键改成
// 别的字(⌥T = †),Enter 不受影响;Windows 上 Ctrl+Alt+字母 还会撞 AltGr 字符。另两条先不占键,用户按需绑。
// 避开的键:Mod-Enter(待办勾选 / 新段)、Mod-Shift-↑↓ 与 Mod-Alt-↑↓(搬块)、mod+shift+[ ](前进后退)。
//
// ⚠️ 焦点在正文里时,引擎的全局热键**收不到**带 Enter 的组合:PM 对 Enter 一律 preventDefault
//    (prosemirror-view captureKeyDown),引擎见 defaultPrevented 就跳过。所以编辑器内由 foldActions 的
//    handleKeyDown 按**同一份生效热键**(effectiveHotkey,含用户改键)接住;焦点不在正文时走引擎分发。
// ⚠️ 本模块开机即被 amadeusCommands 引入,**不许**静态依赖 Milkdown / 编辑器模块:动作在 foldActions.ts,
//    执行时懒取(编辑器已挂着时它早在内存里,拿到的是同一份记账)。
import type { Command } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'
import type { FoldCommandKind } from './foldActions'

registerMessages({
  'foldcmd.toggle': { zh: '切换折叠', en: 'Toggle fold' },
  'foldcmd.foldAll': { zh: '全部折叠', en: 'Fold all' },
  'foldcmd.unfoldAll': { zh: '全部展开', en: 'Unfold all' },
})

/** 三条命令的定义表:引擎命令(FOLD_COMMANDS)与编辑器内的按键兜底(foldActions 的 handleKeyDown)同源。 */
export const FOLD_BINDINGS: ReadonlyArray<{ id: string; kind: FoldCommandKind; hotkey?: string }> = [
  { id: 'amadeus-fold-toggle', kind: 'toggle', hotkey: 'mod+alt+enter' },
  { id: 'amadeus-fold-all', kind: 'foldAll' },
  { id: 'amadeus-unfold-all', kind: 'unfoldAll' },
]

const TITLE: Record<FoldCommandKind, string> = { toggle: 'foldcmd.toggle', foldAll: 'foldcmd.foldAll', unfoldAll: 'foldcmd.unfoldAll' }
const KEYWORDS: Record<FoldCommandKind, string> = {
  toggle: 'fold unfold collapse expand toggle heading section list 折叠 展开 收起 小节 标题 列表 zhedie',
  foldAll: 'fold all collapse headings lists 全部折叠 收起 zhedie',
  unfoldAll: 'unfold all expand headings lists 全部展开 zhankai',
}

export const FOLD_COMMANDS: Command[] = FOLD_BINDINGS.map((b) => ({
  id: b.id,
  title: () => translate(TITLE[b.kind]),
  keywords: KEYWORDS[b.kind],
  ...(b.hotkey ? { hotkey: b.hotkey } : {}),
  run: (): Promise<void> => import('./foldActions').then((m) => m.runFoldCommand(b.kind)),
}))
