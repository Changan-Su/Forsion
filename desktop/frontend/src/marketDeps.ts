/**
 * 商店一键补前置(2026-10-30):把插件缺的前置对到商店条目上,算出哪些能装、哪些不能、为什么。纯函数,界面在 MarketModal。
 *
 * 只按 slug 精确对:条目的 installSlug 等于 dep.market,或等于 dep.id。商店目录里没有包的 manifest id,这里绝不按显示名猜 ——
 * 显示名可以重复,猜错就是替用户装了别的插件。新上架条目的 slug 是 market-<ID>,作者没写 market 就对不上,所以「商店里没有」
 * 那一行要留「在商店中查找」。install_slug 没有唯一约束(线上有两个 `item`),一个 slug 命中多条 = 没对上。
 * 引擎插件不在这里:引擎的 manifest 消毒不留 market 字段,且目录里 `plugin` 类型的条目满足不了 Forsion 插件的前置。
 */
import { cmpVersion } from '@amadeus-shared/ipc'
import type { PluginDependency } from '@amadeus-shared/ipc'
import { marketplaceCompatibility } from '../../shared/marketplace'
import type { UnmetDependency } from './amadeus/plugins/pluginDeps'
import type { MarketCard } from './types'

/** absent 商店里没有 · low 商店的版本也不够 · incompatible 这台设备 / 这版 Forsion 装不了 ·
 *  mismatch 商店那一项已经装上,前置却还是没有(条目不是它要的那个包)。 */
export type DepSkip = 'absent' | 'low' | 'incompatible' | 'mismatch'

export interface DepPlan {
  unmet: UnmetDependency
  card?: MarketCard
  /** 有值 = 这一项装不了;card 只用来说明(low 要写商店里是哪个版本)。 */
  skip?: DepSkip
}

export interface DepPlanContext {
  appVersion: string
  platform: string
  isInstalled(card: MarketCard): boolean
}

/** 依次试 dep.market、dep.id,只认 Forsion 插件条目;一个 slug 命中多条算没对上,不再往下试。 */
export function depCard(dep: PluginDependency, catalog: readonly MarketCard[]): MarketCard | undefined {
  const pool = catalog.filter((c) => c.type === 'amadeus-plugin')
  for (const slug of [dep.market, dep.id]) {
    if (!slug) continue
    const hits = pool.filter((c) => c.installSlug === slug)
    if (hits.length) return hits.length === 1 ? hits[0] : undefined
  }
  return undefined
}

/** 关着 / 被门禁挡 / 成环 / 在等的前置商店帮不上,照原因留着(界面给「启用」或只写状态),不算 skip。 */
export function planDeps(unmet: readonly UnmetDependency[], catalog: readonly MarketCard[], ctx: DepPlanContext): DepPlan[] {
  return unmet.map((u): DepPlan => {
    if (u.reason !== 'missing' && u.reason !== 'version') return { unmet: u }
    const card = depCard(u.dep, catalog)
    if (!card) return { unmet: u, skip: 'absent' }
    const compatibility = marketplaceCompatibility(card, ctx.appVersion, ctx.platform)
    if (compatibility === 'version' || compatibility === 'platform') return { unmet: u, card, skip: 'incompatible' }
    if (u.dep.minVersion && card.latestVersion && cmpVersion(card.latestVersion, u.dep.minVersion) < 0) return { unmet: u, card, skip: 'low' }
    if (u.reason === 'missing' && ctx.isInstalled(card)) return { unmet: u, card, skip: 'mismatch' }
    return { unmet: u, card }
  })
}

/** 这次真能装的那些条目,顺序同 plan。 */
export const installableDeps = (plan: readonly DepPlan[]): MarketCard[] => plan.flatMap((x) => (x.card && !x.skip ? [x.card] : []))
