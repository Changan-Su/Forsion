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

/** 落在「商店」上面。Ribbon 按注册序排,用户排过序的按 bottomOrder 排,两处都要插;bottomOrder 里已有就尊重用户的位置。 */
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
