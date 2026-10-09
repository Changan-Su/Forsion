/**
 * Forsion Market 渲染端服务:全部转发到主进程 IPC（浏览公开、安装走本地 fs，token 留主进程）。
 */
import { registerMessages, translate } from '../i18n'
import type { MarketCard, MarketDetail, MarketInstallProgress } from '../types'

registerMessages({
  'marketsvc.desktopOnly': { zh: '商店仅在桌面端可用', en: 'The store is only available on desktop' },
  'marketsvc.resolveFailed': { zh: '没能从 Forsion 服务器拿到下载地址（{detail}）', en: 'Couldn’t get the download link from the Forsion server ({detail})' },
})

/** 商店的保留标签:这个包要用到电脑上才有的东西(本机程序、本机引擎、桌面浮窗…),手机上装了也用不了。
 *  走标签而不是新字段:线上条目有锁版本的、跟着仓库最新提交的、直接上传的三种,服务端并不是每种都读得到包里的
 *  manifest;标签是投稿时就能写、后台随时能改的现成元数据,老客户端把它当普通标签显示也说得通。
 *  包自己的 manifest `isDesktopOnly` 仍是手机端安装时的硬闸(mobileMarket),这枚标签只是让人在下载之前就知道。 */
export const DESKTOP_ONLY_TAG = 'desktop-only'
export const isDesktopOnlyItem = (item: Pick<MarketCard, 'tags'>): boolean => !!item.tags?.includes(DESKTOP_ONLY_TAG)

function bridge(): NonNullable<typeof window.tangu> {
  const t = window.tangu
  if (!t?.marketList) throw new Error(translate('marketsvc.desktopOnly'))
  return t
}

export const listMarket = (type?: string): Promise<MarketCard[]> =>
  bridge().marketList!(type).then((r) => r.items || [])

export const getMarketDetail = (id: string): Promise<MarketDetail> => bridge().marketDetail!(id)

// ipcRenderer.invoke 的拒绝会被 Electron 包成 "Error invoking remote method 'market:install': Error: …",原样上屏全是噪音。
// 主进程只给语言中立的原因码(`resolve: HTTP 502`、`github.com: timeout · …`),这里套上中英文案。
const unwrapIpcError = (e: unknown): never => {
  const msg = ((e as Error)?.message || String(e)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
  const resolve = /^resolve: (.+)$/.exec(msg)
  // stage='resolve' = 卡在 Forsion 服务器这一步,界面据此不附「开代理 / 开镜像」那条 GitHub 网络指引(那会自相矛盾)。
  throw resolve ? Object.assign(new Error(translate('marketsvc.resolveFailed', { detail: resolve[1] })), { stage: 'resolve' as const }) : new Error(msg)
}

export const installMarket = (id: string): Promise<{ ok: boolean; path: string; type: string; slug: string; id?: string }> =>
  bridge().marketInstall!(id).catch(unwrapIpcError)

/** 订阅安装进度(旧主进程没有这个事件 → 空退订,按钮退化成只转圈)。 */
export const onInstallProgress = (cb: (p: MarketInstallProgress) => void): (() => void) =>
  window.tangu?.onMarketInstallProgress?.(cb) ?? (() => {})

export type InstalledItem = { slug: string; version: string | null }
export const listInstalled = (): Promise<Record<string, InstalledItem[]>> =>
  window.tangu?.marketInstalled?.() ?? Promise.resolve({})
