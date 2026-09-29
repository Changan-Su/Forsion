// 「切换文档 / 画布」命令(评审 V-20):进 Amadeus 的引擎命令集(amadeusCommands 的 CMDS),命令面板可见、
// 进设置里的快捷键表、可自行绑键。缺省不占键(同 FOLD_COMMANDS 另两条:用户按需绑)。
//
// 落点 = **最近用过的那一篇**(同 setFocusedBlockApply 的口径):UnifiedPage 挂载时认领一次,焦点 / 指针进入本实例、
// 或所属 leaf 成为活动面板时再认领;卸载只撤自己那份。没有实例认领(不在笔记里)= 空操作。
// ⚠️ 本模块开机即被 amadeusCommands 引入,**不许**依赖编辑器模块 —— 只有一个认领槽。
import type { Command } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'canvascmd.toggle': { zh: '切换文档 / 画布', en: 'Toggle document / canvas' },
})

let target: (() => void) | null = null

/** 本实例成为命令的落点(挂载 / 焦点进入 / 活动面板切到它)。 */
export function claimCanvasToggle(fn: () => void): void {
  target = fn
}

/** 卸载时撤销自己那份;别人已经认领了就不动。 */
export function releaseCanvasToggle(fn: () => void): void {
  if (target === fn) target = null
}

export const CANVAS_COMMANDS: Command[] = [{
  id: 'amadeus-toggle-canvas',
  title: () => translate('canvascmd.toggle'),
  keywords: 'canvas document whiteboard board view toggle switch 画布 文档 白板 视图 切换 huabu wendang',
  run: () => { target?.() },
}]
