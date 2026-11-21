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

/** 手机(宿主画底部导航栏 × 竖屏单列)上「⋯」只装这一页自己的事(2026-11-18):原来住在里面的全局项各有一个去处 ——
 *   - 两个全局开关(明暗、命令面板)跟着设置进**头像菜单**;
 *   - 其余点得了的入口(商店、成就、反馈、首方的 Ribbon 入口…)进 Dock「全部」那张半屏的最后一组(allSheetItems);
 *   - 没处去的才留在「⋯」:带 component 的项(原生半屏画不了)、没有头像时的设置和那两个开关、Dock 没有「全部」格时的入口。
 *  「一项要么在这三处之一,不会都没有」是这三个函数共同守的口径,改一个要看另外两个。平板横屏(并排左栏)不算手机,照旧。
 *  2026-11-19 起(方向 E 第 1 步)手机上头像菜单和「全部」半屏换成了 Dock 的「应用」「我」两整页(MoreSeats.pages):
 *  三处变成「应用」页、「我」页、「⋯」,口径不变(phonePageItems)。 */
export interface MoreSeats {
  /** 手机:宿主画底部导航栏 × 竖屏单列。 */
  phone: boolean
  /** Dock 上有「全部」那一格(Space 多过 Dock 的格数)—— 没有它,「全部」半屏无从打开。 */
  allCell: boolean
  /** 手机上 Dock 是固定五格、有「应用」「我」两整页(phoneDock.ts,2026-11-19 方向 E):上面说的头像菜单与「全部」半屏都不在了,
   *  原来进那两处的项改进这两页(phonePageItems)。没有这两页时(平台没装)照旧是上面那套。 */
  pages?: boolean
}
const NO_SEATS: MoreSeats = { phone: false, allCell: false }
const pagesNow = (seats: MoreSeats): boolean => seats.phone && !!seats.pages

/** 「我」页里排在设置那一组后面的三个入口(成就、活动、反馈);活动是首方插件登记的 Ribbon 入口。其余点得了的入口进「应用」页。 */
const ME_LAUNCHERS = ['rb-achievements', 'rb-plugin-events', 'rb-feedback']
/** 手机两整页各收哪些 ribbon 项(MoreSeats.pages)。点得了、没有 component 的底部项(账号除外)恰好进其中一处:
 *   - me.settings:设置、mobileFoot 项(在哪运行 / 互联设备)、明暗、命令面板;
 *   - me.launchers:成就、活动、反馈;
 *   - apps:其余(商店、首方插件的入口…),商店排第一。
 *  点不了的、带 component 的仍留在「⋯」(moreItems)。不是这种形态时三组都空。 */
export interface PhonePageItems { apps: RibbonItem[]; me: { settings: RibbonItem[]; launchers: RibbonItem[] } }
export function phonePageItems(all: readonly RibbonItem[], seats: MoreSeats): PhonePageItems {
  if (!pagesNow(seats)) return { apps: [], me: { settings: [], launchers: [] } }
  const usable = all.filter((i) => i.side === 'bottom' && i.id !== 'rb-account' && !!i.onClick && !i.component)
  const settings = [...usable.filter((i) => i.id === 'rb-settings'), ...usable.filter((i) => !!i.mobileFoot), ...usable.filter(isAccountSwitch)]
  const launchers = ME_LAUNCHERS.map((id) => usable.find((i) => i.id === id)).filter((i): i is RibbonItem => !!i)
  const me = new Set([...settings, ...launchers])
  const apps = usable.filter((i) => !me.has(i))
  return { apps: [...apps.filter((i) => i.id === 'rb-market'), ...apps.filter((i) => i.id !== 'rb-market')], me: { settings, launchers } }
}
/** 跟着设置进头像菜单的全局开关(手机)。 */
const ACCOUNT_SWITCHES: ReadonlySet<string> = new Set(['rb-mode', 'rb-cmd'])
const isAccountSwitch = (i: RibbonItem): boolean => i.side === 'bottom' && ACCOUNT_SWITCHES.has(i.id)

/** 头像菜单替左栏底部那一排收下的 ribbon 项(原生底栏 × 有账号项);其余宿主形态为空。手机上再带两个全局开关,排在后面
 *  (带 component 的不收:头像菜单只画图标和名字,组件里的东西会丢 —— 留在「⋯」)。 */
export function accountMenuItems(all: readonly RibbonItem[], nativeSpaces: boolean, phone = false, pages = false): RibbonItem[] {
  // 手机有「我」页时没有头像菜单(头像成了 Dock 的「我」那格):这些行在「我」页里(phonePageItems)。
  if (!nativeSpaces || (phone && pages) || !all.some((i) => i.id === 'rb-account')) return []
  const usable = all.filter((i) => !!i.onClick)
  return [...usable.filter(isFootItem), ...(phone ? usable.filter((i) => !isFootItem(i) && isAccountSwitch(i) && !i.component) : [])]
}

/** 手机上从「⋯」挪进「全部」半屏最后一组的入口(见 MoreSeats 上方);不是手机或 Dock 没有「全部」格时为空。 */
export function allSheetItems(all: readonly RibbonItem[], seats: MoreSeats): RibbonItem[] {
  if (!seats.phone || !seats.allCell || pagesNow(seats)) return []
  return all.filter((i) => i.side === 'bottom' && i.id !== 'rb-account' && !isFootItem(i) && !isAccountSwitch(i) && !!i.onClick && !i.component)
}

/** 「⋯」菜单收哪些 ribbon 项:底部区,去掉账号与住在别处的项(见上)。原生底栏下没处去的 foot 项排最前。 */
export function moreItems(all: readonly RibbonItem[], nativeSpaces: boolean, seats: MoreSeats = NO_SEATS): RibbonItem[] {
  const pages = phonePageItems(all, seats)
  const elsewhere = new Set(nativeSpaces
    ? [...accountMenuItems(all, true, seats.phone, seats.pages), ...allSheetItems(all, seats), ...pages.apps, ...pages.me.settings, ...pages.me.launchers]
    : all.filter(isFootItem))
  const items = all.filter((i) => i.side === 'bottom' && i.id !== 'rb-account' && !elsewhere.has(i))
  return nativeSpaces ? [...items.filter(isFootItem), ...items.filter((i) => !isFootItem(i))] : items
}

export interface MoreCommandGroup { id: string; title: string; commands: Command[] }

/** `phone` = 手机上「⋯」只装这一页的事:声明了 `moreGroup.when` 的组只在它答 true 时列出(插件的命令只在那个插件自己的
 *  页面上;求值抛错按 false)。不是手机(抽屉形态、平板横屏)不看 `when`,照旧全列。 */
export function moreCommandGroups(commands: readonly Command[], phone = false): MoreCommandGroup[] {
  const groups = new Map<string, MoreCommandGroup>()
  const here = new Map<string, boolean>() // 一组问一次:整组跟第一条命令的 when 走(同 title),后面几条写没写都一样
  for (const c of commands) {
    const g = c.moreGroup
    if (!g || typeof g.id !== 'string' || !g.id) continue
    let ok = here.get(g.id)
    if (ok === undefined) {
      ok = true
      if (phone && g.when) { try { ok = !!g.when() } catch { ok = false } }
      here.set(g.id, ok)
    }
    if (!ok) continue
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
