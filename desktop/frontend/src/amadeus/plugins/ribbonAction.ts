import { Gift, type LucideIcon } from 'lucide-react'
import { removeRibbonIcon, useRibbonStore } from '@lcl/engine'

export const RIBBON_ACTION_PREFIX = 'rb-plugin-'
// ponytail: 只给首方包,现在只有活动中心一个用户;要第二个图标时在这里加一个词
const ICONS: Record<string, LucideIcon> = { gift: Gift }

export interface RibbonActionOpts {
  id: string
  icon: string
  title: string | (() => string)
  run(): void
  dot?: { get(): boolean; subscribe(cb: () => void): () => void; label?: () => string }
}

/** 落在「商店」上面、明暗下面(2026-11-07 用户定;11-02 那版在商店下面)。Ribbon 按注册序排,用户排过序的按 bottomOrder 排,
 *  两处都要插;bottomOrder 里已有就尊重用户的位置。 */
export function addRibbonAction(opts: RibbonActionOpts): () => void {
  const id = `${RIBBON_ACTION_PREFIX}${opts.id}`
  const rb = useRibbonStore.getState()
  const rest = rb.items.filter((item) => item.id !== id)
  const at = rest.findIndex((item) => item.id === 'rb-market')
  const item = { id, side: 'bottom' as const, icon: ICONS[opts.icon] ?? Gift, tooltip: opts.title, onClick: () => opts.run(), dot: opts.dot }
  useRibbonStore.setState({ items: at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)] })
  const market = rb.bottomOrder.indexOf('rb-market')
  if (market >= 0 && !rb.bottomOrder.includes(id)) rb.setZoneOrder('bottom', [...rb.bottomOrder.slice(0, market), id, ...rb.bottomOrder.slice(market)])
  return () => removeRibbonIcon(id)
}

const MODE_LAST_KEY = 'forsion_ribbon_mode_last'
const OLD_DEFAULT = ['rb-market', 'rb-mode', 'rb-cmd', 'rb-settings'].join()
/** 老存档(用户动过底部区)还是旧默认的「商店 → 明暗 → 命令面板 → 设置」→ 只挪一次:明暗到区末尾,旧版存在商店上一格的首方图标挪到商店下面;
 *  打标记后用户再拖到哪算哪(同 bootstrapEngine 里反馈那条)。
 *  ponytail: 只认这四格原样相连(首方图标不算)、明暗不在收纳夹里;这四格动过任一格就是用户自己定的,不动。 */
export function moveModeLastOnce(): void {
  try { if (localStorage.getItem(MODE_LAST_KEY)) return } catch { return }
  const rb = useRibbonStore.getState()
  const order = rb.bottomOrder
  const core = order.filter((id) => !id.startsWith(RIBBON_ACTION_PREFIX))
  const m = core.indexOf('rb-market')
  if (m >= 0 && core.slice(m, m + 4).join() === OLD_DEFAULT && !rb.folders.some((f) => f.items.includes('rb-mode'))) {
    let s = order.indexOf('rb-market')
    while (s > 0 && order[s - 1]!.startsWith(RIBBON_ACTION_PREFIX)) s--
    const moved = order.slice(s, order.indexOf('rb-market'))
    const rest = order.filter((id) => id !== 'rb-mode' && !moved.includes(id))
    const at = rest.indexOf('rb-market') + 1
    rb.setZoneOrder('bottom', [...rest.slice(0, at), ...moved, ...rest.slice(at), 'rb-mode'])
  }
  try { localStorage.setItem(MODE_LAST_KEY, '1') } catch { /* ignore */ }
}

const REORDER_KEY = 'forsion_ribbon_order_20261107'
/** 11-02 默认(上 → 下)与 11-07 默认。首方图标(活动)按前缀算在「活动」那格。 */
const ORDER_1102 = ['rb-feedback', 'rb-market', '@action', 'rb-cmd', 'rb-settings', 'rb-mode']
const ORDER_1107 = ['rb-mode', '@action', 'rb-market', 'rb-feedback', 'rb-cmd', 'rb-settings']
/** 老存档(用户动过底部区)的命令格还是 11-02 默认「反馈 → 商店 →(活动)→ 命令面板 → 设置 → 明暗」→ 只换一次成 11-07 默认
 *  「明暗 →(活动)→ 商店 → 反馈 → 命令面板 → 设置」;成就 / 设备等其他格原地不动。打标记后用户再拖到哪算哪。
 *  ponytail: 只认这几格的相对顺序原样(缺哪格就跳过哪格,如网页没反馈)、这几格都不在收纳夹里;其余摆法是用户自己定的,不动。 */
export function reorderCommandsOnce(): void {
  try { if (localStorage.getItem(REORDER_KEY)) return } catch { return }
  const rb = useRibbonStore.getState()
  // 顺序表里缺明暗时 rankIds 把它排到区末尾 —— 看上去就是 11-02 默认的「明暗最后」,按在末尾算(Codex P2)。
  const order = rb.bottomOrder.includes('rb-mode') ? rb.bottomOrder : [...rb.bottomOrder, 'rb-mode']
  const slot = (id: string): string => (id.startsWith(RIBBON_ACTION_PREFIX) ? '@action' : id)
  const at = order.map((id, i) => (ORDER_1102.includes(slot(id)) ? i : -1)).filter((i) => i >= 0)
  const mine = at.map((i) => order[i]!)
  const shape = mine.map(slot)
  const expect = ORDER_1102.filter((s) => shape.includes(s))
  const folded = rb.folders.some((f) => f.items.some((id) => ORDER_1102.includes(slot(id))))
  if (mine.length >= 2 && order.length > 1 && shape.join() === expect.join() && !folded) {
    const rank = (id: string): number => ORDER_1107.indexOf(slot(id))
    const sorted = [...mine].sort((a, b) => rank(a) - rank(b))
    const next = [...order]
    at.forEach((i, k) => { next[i] = sorted[k]! })
    rb.setZoneOrder('bottom', next)
  }
  try { localStorage.setItem(REORDER_KEY, '1') } catch { /* ignore */ }
}
