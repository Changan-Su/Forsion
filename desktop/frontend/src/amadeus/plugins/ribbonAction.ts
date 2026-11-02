import { Gift, type LucideIcon } from 'lucide-react'
import { moveTo, removeRibbonIcon, useRibbonStore } from '@lcl/engine'

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
/** 老存档(用户动过底部区)里明暗还停在旧默认位(紧跟商店)→ 只挪一次到区末尾,打标记后用户再拖到哪算哪(同 bootstrapEngine 里反馈那条)。
 *  ponytail: 只认「明暗紧跟商店、不在收纳夹里」的形状,别的摆法是用户自己定的,不动。 */
export function moveModeLastOnce(): void {
  try { if (localStorage.getItem(MODE_LAST_KEY)) return } catch { return }
  const rb = useRibbonStore.getState()
  const at = rb.bottomOrder.indexOf('rb-mode')
  if (at > 0 && rb.bottomOrder[at - 1] === 'rb-market' && !rb.folders.some((f) => f.items.includes('rb-mode'))) rb.setZoneOrder('bottom', moveTo(rb.bottomOrder, 'rb-mode', rb.bottomOrder.length - 1))
  try { localStorage.setItem(MODE_LAST_KEY, '1') } catch { /* ignore */ }
}
