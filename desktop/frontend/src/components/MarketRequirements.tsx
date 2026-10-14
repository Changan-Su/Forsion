import { useEffect, useState } from 'react'
import { APP_VERSION } from '../changelog'
import { registerMessages, useI18n } from '../i18n'
import { marketplaceCompatibility, type MarketplaceRequirements } from '../../../shared/marketplace'

registerMessages({
  'market.compatible': { zh: '适配当前版本', en: 'Compatible' },
  'market.requiresUpdate': { zh: '版本不兼容', en: 'Version incompatible' },
  'market.platformUnavailable': { zh: '当前端不可用', en: 'Unavailable here' },
  'market.requirementsUnknown': { zh: '未声明版本要求', en: 'Requirements unspecified' },
  'market.forsionVersion': { zh: 'Forsion 版本要求', en: 'Forsion requirements' },
})
export const marketPlatform = () => window.tangu?.mobile ? 'android' : window.tangu?.marketInstall ? (window.tangu.platform === 'darwin' ? 'macos' : window.tangu.platform === 'win32' ? 'windows' : window.tangu.platform === 'linux' ? 'linux' : 'desktop') : 'web'
export function useMarketVersion() {
  const [version, setVersion] = useState(APP_VERSION)
  useEffect(() => { let alive = true; void window.tangu?.appVersion?.().then(v => { if (alive) setVersion(v) }).catch(() => {}); return () => { alive = false } }, [])
  return version
}
export const requirementsText = (item: MarketplaceRequirements) => item.minAppVersion
  ? `${item.minAppVersion}${item.maxAppVersion ? ` ≤ Forsion < ${item.maxAppVersion}` : '+'}` : item.maxAppVersion ? `< ${item.maxAppVersion}` : '—'
export function MarketRequirements({ item, version }: { item: MarketplaceRequirements & { tags?: string[] }; version: string }) {
  const { t } = useI18n()
  const state = marketplaceCompatibility(item, version, marketPlatform())
  const key = state === 'compatible' ? 'market.compatible' : state === 'version' ? 'market.requiresUpdate' : state === 'platform' ? 'market.platformUnavailable' : 'market.requirementsUnknown'
  return <span className={`mk-compat is-${state}`} data-market-compat={state} title={`${t('market.forsionVersion')}: ${requirementsText(item)} · ${version}`}>{t(key)}</span>
}
