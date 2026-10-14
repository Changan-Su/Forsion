/**
 * 划线条(选中文字后浮出来的那一条)的应用层逻辑:插件动作在哪个视图里该不该列、怎么跑、条的排法偏好。
 * 纯逻辑,不碰 DOM / React —— 聊天(components/selectionBar)、笔记(UnifiedPage)、插件视图(ctx.ui.mountSelectionBar)
 * 三处都从这里取,单测直接断言。注册表就是 usePluginStore.selectionActions;内置的「问 Tangu」「翻译」由各视图自己摆。
 */
import type { SelectionBarOrder } from '@lcl/components'
import { registerMessages, translate } from './i18n'
import { broadcastPrefs } from './uiPrefsBus'
import { SELECTION_BAR_ORDER_KEY } from './types'
import type { SelectionActionContribution } from './amadeus/plugins/types'

registerMessages({
  'selbar.more': { zh: '更多', en: 'More' },
  'selbar.plugins': { zh: '插件', en: 'Plugins' },
  'selbar.err.notString': { zh: 'run() 必须返回字符串，实际是 {type}', en: 'run() must return a string, but returned {type}' },
  'selbar.err.controlChars': { zh: 'run() 返回内容含控制字符', en: 'run() returned content containing control characters' },
  'selbar.err.gone': { zh: '这个动作已经不在了（插件被停用或重载）', en: 'This action is no longer available (the plugin was disabled or reloaded).' },
  'selbar.failed': { zh: '「{title}」没有完成：{e}', en: '"{title}" did not finish: {e}' },
})

export interface OwnedSelectionAction { pluginId: string; item: SelectionActionContribution }

/** 视图报给动作表的三样。view:'note' | 'chat' | '<插件 id>:<视图 id>';editable:选中的字能不能被结果替换。 */
export interface SelectionWhere { view: string; editable: boolean; length: number }

/** 条上 / ⋯ 里一项的 id(`data-ai`),也是宿主找回这个动作用的键。 */
export const selectionActionKey = (o: OwnedSelectionAction): string => `plugin:${o.pluginId}:${o.item.id}`

/** scope 认不认这个视图。缺省 'note';'own' = 这个插件自己的视图;数组里的一项匹配整个 id 或它的前缀段
 *  ('pdf-reader' 认 'pdf-reader:reader')。写错的 scope(不是这几种)当不匹配,不猜。 */
export function selectionScopeMatches(scope: SelectionActionContribution['scope'], pluginId: string, view: string): boolean {
  if (scope == null || scope === 'note') return view === 'note'
  if (scope === 'all') return true
  if (scope === 'own') return view.startsWith(`${pluginId}:`)
  return Array.isArray(scope) && scope.some((s) => typeof s === 'string' && !!s && (view === s || view.startsWith(`${s}:`)))
}

/** 这次该列哪些插件动作:scope 不认、when 说不要(或抛错)的不列 —— 不画一个点了没反应的按钮。
 *  按插件 id 排(同一个插件的保持注册顺序),⋯ 里同一个插件的挨在一起。 */
export function listSelectionActions(all: readonly OwnedSelectionAction[], where: SelectionWhere): OwnedSelectionAction[] {
  return all
    .filter((o) => {
      if (!selectionScopeMatches(o.item.scope, o.pluginId, where.view)) return false
      if (typeof o.item.when !== 'function') return true
      try { return !!o.item.when({ ...where }) } catch { return false }
    })
    .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))
}

/** 跑一个插件动作,返回要放进结果卡的 markdown('' = 没有要给人看的)。插件是第三方代码,返回值当外部输入校验
 *  (与 slash 的 run 同一套闸:非字符串会毒化文档,控制字符会污染笔记文件)。output: 'none' 的返回值不看。 */
export async function runSelectionAction(o: OwnedSelectionAction, cx: Parameters<SelectionActionContribution['run']>[0]): Promise<string> {
  const md = await o.item.run(cx)
  if (o.item.output === 'none' || md == null || md === '') return ''
  if (typeof md !== 'string') throw new Error(translate('selbar.err.notString', { type: typeof md }))
  // 控制字符逐码点判(放行 \t \n):正则字面量写法会把真控制字节带进源文件。
  if (Array.from(md).some((c) => c.charCodeAt(0) < 32 && c !== String.fromCharCode(9) && c !== String.fromCharCode(10))) {
    throw new Error(translate('selbar.err.controlChars'))
  }
  return md
}

/** 条的排法。没存过 = 'tools'(本视图的工具在前;2026-10-13 用户定),设置 → 外观里能换成 'actions'(动作在前)。
 *  条每次出现时现读,不用订阅。 */
export function selectionBarOrder(): SelectionBarOrder {
  try { return localStorage.getItem(SELECTION_BAR_ORDER_KEY) === 'actions' ? 'actions' : 'tools' } catch { return 'tools' }
}
export function setSelectionBarOrder(order: SelectionBarOrder): void {
  try { localStorage.setItem(SELECTION_BAR_ORDER_KEY, order) } catch { /* private mode */ }
  broadcastPrefs()
}
