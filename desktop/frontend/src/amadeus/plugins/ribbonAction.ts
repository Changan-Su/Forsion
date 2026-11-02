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

/** 落在「商店」下面 —— 明暗原来的位置(2026-11-02 用户定,明暗挪到了最后)。Ribbon 按注册序排,用户排过序的按 bottomOrder 排,
 *  两处都要插;bottomOrder 里已有就尊重用户的位置。 */
export function addRibbonAction(opts: RibbonActionOpts): () => void {
  const id = `${RIBBON_ACTION_PREFIX}${opts.id}`
  const rb = useRibbonStore.getState()
  const rest = rb.items.filter((item) => item.id !== id)
  const at = rest.findIndex((item) => item.id === 'rb-market') + 1
  const item = { id, side: 'bottom' as const, icon: ICONS[opts.icon] ?? Gift, tooltip: opts.title, onClick: () => opts.run(), dot: opts.dot }
  useRibbonStore.setState({ items: at <= 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)] })
  const market = rb.bottomOrder.indexOf('rb-market') + 1
  if (market > 0 && !rb.bottomOrder.includes(id)) rb.setZoneOrder('bottom', [...rb.bottomOrder.slice(0, market), id, ...rb.bottomOrder.slice(market)])
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
