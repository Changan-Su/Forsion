import { compareMarketVersions } from '../../../shared/marketPluginUpdates'
import { useEffect, useState } from 'react'
import { Check, Download, Loader2, Puzzle } from 'lucide-react'
import type { MarketCard, MarketInstallProgress, ToolEvent } from '../types'
import { marketplaceCompatibility, marketplaceItemsOf } from '../../../shared/marketplace'
import { installMarket, listInstalled, onInstallProgress, installedMarketItem, type InstalledItem } from '../services/marketService'
import { afterMarketInstall, canRestartBackend, restartBackend } from '../marketPostInstall'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { MarketRequirements, marketPlatform, useMarketVersion } from './MarketRequirements'
import './MarketUpgrade.css'

registerMessages({
  'market.installPhaseInstall': { zh: '正在安装…', en: 'Installing…' },
  'market.installPhaseResolve': { zh: '正在准备…', en: 'Preparing…' },
  'market.cardSearching': { zh: '正在查询商店…', en: 'Searching the store…' },
  'market.cardNoResults': { zh: '商店中没有找到匹配项', en: 'No matching store entries' },
  'market.cardInstall': { zh: '安装', en: 'Install' },
  'market.cardInstalled': { zh: '已安装', en: 'Installed' },
  'market.cardDetails': { zh: '详情', en: 'Details' },
  'market.cardUnavailable': { zh: '当前端不可安装', en: 'Installation unavailable here' },
  'market.cardRestart': { zh: '重启引擎以启用', en: 'Restart engine to activate' },
  'market.cardRestartFailed': { zh: '引擎重启失败，请重试', en: 'Engine restart failed. Try again.' },
})
export const isMarketplaceTool = (event: ToolEvent) => ['search_marketplace', 'get_marketplace_plugin'].includes(event.name)
export function openMarketItem(item: { id: string; name: string }, comments = false): void {
  if (window.tangu?.openFloatingPanel) void window.tangu.openFloatingPanel({ id: 'market', title: item.name, builtin: 'market', params: { itemId: item.id, detailTab: comments ? 'comments' : 'overview', nonce: Date.now() } })
  else useApp.getState().openMarket(undefined, { itemId: item.id, detailTab: comments ? 'comments' : 'overview', nonce: Date.now() })
}
export function MarketPluginCards({ event }: { event: ToolEvent }) {
  const { t } = useI18n()
  const version = useMarketVersion()
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<MarketInstallProgress | null>(null)
  const [error, setError] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)
  const refresh = () => listInstalled().then(setInstalled).catch(() => {})
  useEffect(() => { void refresh(); const listener = () => { void refresh() }; window.addEventListener('focus', listener); window.addEventListener('forsion:extensions-changed', listener); const off = onInstallProgress(p => setProgress(p)); return () => { off(); window.removeEventListener('focus', listener); window.removeEventListener('forsion:extensions-changed', listener) } }, [])
  if (event.isError) return null
  if (!event.done) return <div className="mk-chat-search" role="status"><Loader2 size={14} className="spin" />{t('market.cardSearching')}</div>
  const items = marketplaceItemsOf(event.result)
  const install = async (item: MarketCard) => {
    if (busy) return
    setBusy(item.id); setProgress(null); setError('')
    try {
      const wasInstalled = !!installedMarketItem(item, installed)
      const result = await installMarket(item.id)
      const { restart } = await afterMarketInstall(result.type, result, wasInstalled, text => setError(text))
      setNeedsRestart(restart); await refresh()
    } catch (e: any) { setError(e.message) } finally { setBusy(null); setProgress(null) }
  }
  const reboot = async () => { if (!(await restartBackend())) setError(t('market.cardRestartFailed')); else setNeedsRestart(false) }
  return <div className="mk-chat-results" data-marketplace-cards={event.id}>
    {!items.length && <p className="mk-muted">{t('market.cardNoResults')}</p>}
    {items.map(raw => {
      const item = raw as MarketCard
      const entry = installedMarketItem(item, installed)
      const done = !!entry
      const update = !!entry?.version && !!item.latestVersion && (compareMarketVersions(item.latestVersion, entry.version) || 0) > 0
      const state = marketplaceCompatibility(item, version, marketPlatform())
      const unavailable = !window.tangu?.marketInstall || (window.tangu?.marketTypes && !window.tangu.marketTypes.includes(item.type)) || state === 'version' || state === 'platform'
      const working = busy === item.id
      const p = working && progress?.id === item.id ? progress : null
      return <article key={item.id} className="mk-chat-card" data-marketplace-item={item.id}>
        <div className="mk-chat-card-top"><div className="mk-chat-icon"><Puzzle size={22} /></div><div><strong>{item.name}</strong><span>{item.author} · {item.latestVersion ? `v${item.latestVersion}` : '—'}</span></div><MarketRequirements item={item} version={version} /></div>
        <p>{item.summary || item.description}</p>
        {!!item.tags?.length && <div className="mk-tags">{item.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>}
        <div className="mk-chat-card-actions"><button className="btn sm" onClick={() => openMarketItem(item)}>{t('market.cardDetails')}</button><button className={`btn sm ${done ? '' : 'primary'}`} disabled={!!busy || (done && !update) || !!unavailable} onClick={() => void install(item)} data-market-card-install={item.id}>
          {working ? <Loader2 size={13} className="spin" /> : done ? <Check size={13} /> : <Download size={13} />}
          {working ? p?.phase === 'download' && p.total ? `${Math.round((p.received || 0) / p.total * 100)}%` : t(p?.phase === 'install' ? 'market.installPhaseInstall' : 'market.installPhaseResolve') : done && !update ? `${t('market.cardInstalled')}${entry?.version ? ` v${entry.version}` : ''}` : unavailable ? t('market.cardUnavailable') : update ? t('market.update') : t('market.cardInstall')}
        </button></div>
      </article>
    })}
    {error && <p className="mk-chat-error" role="alert">{error}</p>}
    {needsRestart && <div role="status">{t('market.cardRestart')}{canRestartBackend() && <button className="btn sm" onClick={() => void reboot()}>{t('market.restartBackend')}</button>}</div>}
  </div>
}
