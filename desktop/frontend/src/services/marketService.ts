/**
 * Forsion Market 渲染端服务:全部转发到主进程 IPC（浏览公开、安装走本地 fs，token 留主进程）。
 */
import type { MarketCard, MarketDetail } from '../types'

function bridge(): NonNullable<typeof window.tangu> {
  const t = window.tangu
  if (!t?.marketList) throw new Error('应用市场仅在桌面端可用')
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
