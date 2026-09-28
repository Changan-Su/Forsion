// K-10(评审 2026-09-27):表格里的回车族。preset-gfm 的 tableKeymap 把 Enter 和 Mod-Enter 都绑成 exitTable
// (在任意单元格回车 = 表后插一段并跳出),Shift-Enter 又被 hardbreakFilterNodes(缺省含 table)挡成哑键。
// 这里整组接管,原语在 blocks/markdown/tableEdit.ts:
//  · Enter       = 下一行同列(Excel / Obsidian);末行先加一行再过去。
//  · Shift-Enter = 格内换行,落盘 `<br>`(D-06 同一编码)。
//  · Mod-Enter   = 跳出表格(表后新建空段)。顶层表格原本经 keyboard.ts 的 modEnterCmd 已是这样;这里自己接,
//                  嵌在引用 / 列表里的表格才不会落进「引用内换行」「拆列表项」两支把单元格写坏。
// 挂在 keyboardPlugins **最前**:unified 的 enterCmd 链里有 enterRunsTrigger,单元格里只有 `-` / `#` / `|`
// 时回车会先被当成块级触发符 —— 表格回车必须先赢。不在表格里一律 return false,交回原链。
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { tableEnter, tableExit, tableHardBreak } from '../blocks/markdown/tableEdit'

export const tableKeyPlugins: MilkdownPlugin[] = [
  $prose(() => keymap({ Enter: tableEnter, 'Shift-Enter': tableHardBreak, 'Mod-Enter': tableExit })),
].flat()
