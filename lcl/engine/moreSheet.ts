/** 手机单列壳「⋯」菜单的命令分组(Web sheet 与原生底单共用一份整形)。
 *  命令声明了 `moreGroup` 就按组列进「⋯」:同组 id 一节,节序 = 命令注册表里首次出现的顺序。
 *  宿主用它把**没有 ribbon 图标**的来源(外置插件的命令)摆到手机的「⋯」里;桌面 Ribbon / 命令面板不读它。 */
import { label, type Command } from './types'

export interface MoreCommandGroup { id: string; title: string; commands: Command[] }

export function moreCommandGroups(commands: readonly Command[]): MoreCommandGroup[] {
  const groups = new Map<string, MoreCommandGroup>()
  for (const c of commands) {
    const g = c.moreGroup
    if (!g || typeof g.id !== 'string' || !g.id) continue
    let entry = groups.get(g.id)
    if (!entry) {
      entry = { id: g.id, title: safeLabel(g.title, ''), commands: [] }
      groups.set(g.id, entry)
    }
    entry.commands.push(c)
  }
  return [...groups.values()]
}

/** 命令在「⋯」里的行文案(title 求值抛错 → 退回 id,不让一条坏命令拖垮整张菜单)。 */
export function moreCommandTitle(c: Command): string { return safeLabel(c.title, c.id) }

/** 开关类命令此刻是否「开」;没声明 checked 或读取抛错 = false(只有开着才画勾)。 */
export function moreCommandOn(c: Command): boolean {
  if (!c.checked) return false
  try { return !!c.checked() } catch { return false }
}

function safeLabel(v: string | (() => string), fallback: string): string {
  try { return label(v) || fallback } catch { return fallback }
}
