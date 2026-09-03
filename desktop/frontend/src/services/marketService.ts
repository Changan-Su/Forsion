/**
 * Forsion Market 渲染端服务:全部转发到主进程 IPC（浏览公开、安装走本地 fs，token 留主进程）。
 */
import { registerMessages, translate } from '../i18n'
import type { MarketCard, MarketDetail } from '../types'

registerMessages({
  'marketsvc.desktopOnly': { zh: '应用市场仅在桌面端可用', en: 'The app market is only available on desktop' },
})

function bridge(): NonNullable<typeof window.tangu> {
  const t = window.tangu
  if (!t?.marketList) throw new Error(translate('marketsvc.desktopOnly'))
  return t
}

export const listMarket = (type?: string): Promise<MarketCard[]> =>
  bridge().marketList!(type).then((r) => r.items || [])

export const getMarketDetail = (id: string): Promise<MarketDetail> => bridge().marketDetail!(id)

export const installMarket = (id: string): Promise<{ ok: boolean; path: string; type: string; slug: string }> =>
  bridge().marketInstall!(id)

export type InstalledItem = { slug: string; version: string | null }
export const listInstalled = (): Promise<Record<string, InstalledItem[]>> =>
  window.tangu?.marketInstalled?.() ?? Promise.resolve({})
