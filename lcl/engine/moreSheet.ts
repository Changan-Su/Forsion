/** 手机单列壳「⋯」菜单的命令分组(Web sheet 与原生底单共用一份整形)。
 *  命令声明了 `moreGroup` 就按组列进「⋯」:同组 id 一节,节序 = 命令注册表里首次出现的顺序。
 *  宿主用它把**没有 ribbon 图标**的来源(外置插件的命令)摆到手机的「⋯」里;桌面 Ribbon / 命令面板不读它。 */
import { label, type Command, type RibbonItem } from './types'

/** 手机单列壳里没有固定座位的两样:设置,以及 mobileFoot 项(互联设备)。账号(rb-account)在哪,它们就跟到哪:
 *   - 抽屉形态(Web / 手机浏览器 / 没有原生外壳的 App):三样都在左抽屉底部常驻那一排 → 都不进「⋯」;
 *   - 原生宿主画底部导航栏(Android,左栏没有那一排):账号是顶栏右侧的头像,这两样进**头像菜单**(accountMenuItems)
 *     → 也不进「⋯」(用户 2026-10-05 拍板,同微信「我 → 设置」);
 *   - 同上但宿主没有账号项(没装账号桥 = 没有头像),或某一项点不了(没有 onClick,进不了菜单)→ 留在「⋯」最前。 */
const isFootItem = (i: RibbonItem): boolean => i.id === 'rb-settings' || !!i.mobileFoot

/** 头像菜单替左栏底部那一排收下的 ribbon 项(原生底栏 × 有账号项);其余宿主形态为空。 */
export function accountMenuItems(all: readonly RibbonItem[], nativeSpaces: boolean): RibbonItem[] {
  return nativeSpaces && all.some((i) => i.id === 'rb-account') ? all.filter((i) => isFootItem(i) && !!i.onClick) : []
}

/** 「⋯」菜单收哪些 ribbon 项:底部区,去掉账号与住在别处的 foot 项(见上)。原生底栏下没处去的 foot 项排最前。 */
export function moreItems(all: readonly RibbonItem[], nativeSpaces: boolean): RibbonItem[] {
  const elsewhere = new Set(nativeSpaces ? accountMenuItems(all, true) : all.filter(isFootItem))
  const items = all.filter((i) => i.side === 'bottom' && i.id !== 'rb-account' && !elsewhere.has(i))
  return nativeSpaces ? [...items.filter(isFootItem), ...items.filter((i) => !isFootItem(i))] : items
}

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

/** ribbon 项在「⋯」里的行文案。它的 tooltip 是给桌面 hover 写的,末尾常带键盘快捷键(「命令面板 (⌘K)」);
 *  手机没有键盘,那段只是噪音 → 剥掉**末尾**括号里的快捷键。括号里有修饰键才剥,普通括注原样;
 *  桌面 Ribbon / 命令面板不经过这里,文案不变。 */
export function moreRowLabel(text: string): string {
  return text.replace(/\s*[(（][^()（）]*(?:[⌘⌃⌥⇧]|\b(?:Ctrl|Cmd|Alt|Shift)\b)[^()（）]*[)）]\s*$/, '') || text
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
