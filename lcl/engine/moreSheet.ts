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

/** 原生「⋯」半屏里点了一条命令:只认**呈现时**的那一条。半屏开着的时候插件可能重注册同 id 的命令(重载 / 启停 /
 *  换了处理器):按 id 去活的注册表里跑,用户看到的是 A、执行的却是 B。注册表里那个 id 已经不是呈现时的对象
 *  (被换掉 / 已注销)→ null,调用方什么都不做(Web sheet 是活的列表,换了会当场重画,没有这个问题)。 */
export function presentedCommand(presented: readonly Command[], live: readonly Command[], id: string): Command | null {
  const shown = presented.find((c) => c.id === id)
  return shown && live.find((c) => c.id === id) === shown ? shown : null
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
