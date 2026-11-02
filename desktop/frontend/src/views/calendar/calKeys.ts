/** Calendar 视图键盘映射(纯函数,便于单测):
 *  - D/W/3/M 切模式(Notion Calendar 式,原有);
 *  - ←/→ 翻上/下一周期(任务3,复用工具条 prev/next);
 *  - Cmd/Ctrl+C/V 复制/粘贴选中事件、Delete/Backspace 删除(任务2);
 *  - 2026-10-16:Cmd/Ctrl+Z 撤销最近一次删除/改时间,Cmd/Ctrl+D 复制选中,C 新建,T 回今天,Enter 改标题,Esc 取消选中/草稿。
 *  输入控件劫持排除留在调用方(依赖 DOM,这里只认键)。 */
import type { CalMode } from '../../amadeus/store/calendarNavStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'calkeys.modeDay': { zh: '日', en: 'Day' },
  'calkeys.modeWeek': { zh: '周', en: 'Week' },
  'calkeys.mode3day': { zh: '3 日', en: '3 days' },
  'calkeys.modeMonth': { zh: '月', en: 'Month' },
})

/** ⚠️ label 必须是 getter,不能写字面量:模块级表在加载时求值一次,写死的文案会**冻结**在
 *  首屏语言上,切语言不更新。getter 让调用方(CalendarView 读 `m.label`)在渲染时才求值,
 *  同时保住 `label: string` 的调用契约。`key`/`id` 是标识符(键盘映射 + 模式枚举),永不翻译。 */
export const MODE_ITEMS: Array<{ id: CalMode; label: string; key: string }> = [
  { id: 'day', get label() { return translate('calkeys.modeDay') }, key: 'd' },
  { id: '3day', get label() { return translate('calkeys.mode3day') }, key: '3' },
  { id: 'week', get label() { return translate('calkeys.modeWeek') }, key: 'w' },
  { id: 'month', get label() { return translate('calkeys.modeMonth') }, key: 'm' },
]

export type CalKeyAction =
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'delete' }
  | { kind: 'prev' }
  | { kind: 'next' }
  | { kind: 'mode'; mode: CalMode }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'menu' }
  | { kind: 'duplicate' }
  | { kind: 'new' }
  | { kind: 'today' }
  | { kind: 'rename' }
  | { kind: 'escape' }

/** 只看按键 + 修饰键定动作;不认识的返回 null(调用方不 preventDefault)。 */
export function classifyCalKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey?: boolean }): CalKeyAction | null {
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey
  if (mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y')) return { kind: 'redo' }
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) return { kind: 'undo' }
  if (mod && e.key.toLowerCase() === 'x') return { kind: 'cut' }
  if (mod && (e.key === 'd' || e.key === 'D')) return { kind: 'duplicate' }
  if (mod && (e.key === 'c' || e.key === 'C')) return { kind: 'copy' }
  if (mod && (e.key === 'v' || e.key === 'V')) return { kind: 'paste' }
  if (e.metaKey || e.ctrlKey || e.altKey) return null // 其它修饰组合不劫持(留给浏览器/系统)
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) return { kind: 'menu' }
  if (e.key === 'Delete' || e.key === 'Backspace') return { kind: 'delete' }
  if (e.key === 'ArrowLeft') return { kind: 'prev' }
  if (e.key === 'ArrowRight') return { kind: 'next' }
  if (e.key === 'Escape') return { kind: 'escape' }
  if (e.key === 'Enter') return { kind: 'rename' }
  if (e.key === 'c' || e.key === 'C') return { kind: 'new' }
  if (e.key === 't' || e.key === 'T') return { kind: 'today' }
  const hit = MODE_ITEMS.find((m) => m.key === e.key.toLowerCase())
  return hit ? { kind: 'mode', mode: hit.id } : null
}
