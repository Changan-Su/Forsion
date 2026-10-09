import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { getView, subscribeViews, useWorkspace } from '@lcl/engine'
import { ArrowUpRight, LayoutGrid, Search, Link as LinkIcon } from 'lucide-react'
import { registerMessages, useI18n, translate } from '../i18n'
import { getIntelligentSources, subscribeIntelligentSources, type PluginIntelligentSource } from '../services/intelligentCardCatalog'
import { notePluginGesture, usePluginStore } from '../amadeus/plugins/pluginStore'
import { pluginDisplayName } from '../amadeus/plugins/display'
import { resolveIcon } from '../amadeus/components/icons'
import { PluginLogo } from './PluginLogo'
import { usePageStore } from '../amadeus/store/pageStore'
import type { ListItem } from '../amadeus/plugins/types'
import './IntelligentAppCard.css'

registerMessages({
  'iui.cardLive': { zh: '实时', en: 'Live' },
  'iui.cardUnavailable': { zh: '此卡片暂不可用，请启用对应功能或插件。', en: 'This card is unavailable. Enable its feature or plugin.' },
  'iui.cardFailed': { zh: '卡片加载失败，请重试。', en: 'Card failed to load. Try again.' },
  'iui.cardRetry': { zh: '重试', en: 'Retry' },
  'iui.cardOpen': { zh: '打开完整视图', en: 'Open full view' },
  'iui.cardEmpty': { zh: '没有匹配的条目', en: 'No matching items' },
  'iui.cardSearch': { zh: '搜索此列表', en: 'Search this list' },
  'iui.cardMore': { zh: '还有 {n} 项，可在完整视图中查看', en: '{n} more in the full view' },
})
class CardBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div role="status">{translate('iui.cardFailed')} <button onClick={() => this.setState({ failed: false })}>{translate('iui.cardRetry')}</button></div> : this.props.children }
}
function NativeSurface({ render }: { render: () => React.ReactNode }) {
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    void import('../amadeusPlugins').then(m => m.ensureAmadeusReady()).then(() => { if (alive) setReady(true) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])
  if (failed) throw new Error('Native data source unavailable')
  return ready ? render() : <div role="status">{translate('dashcompact.loading')}</div>
}
/** Row icon by the shared list-source contract: the item's favicon, else its vocabulary icon, else a generic link. */
function RowIcon({ row }: { row: ListItem }) {
  const [failed, setFailed] = useState(false)
  return <span className="iui-app-row-icon">{row.iconUrl && !failed ? <img src={row.iconUrl} alt="" onError={() => setFailed(true)} /> : resolveIcon(row.icon, <LinkIcon />)}</span>
}
function PluginList({ source, initialQuery }: { source: PluginIntelligentSource; initialQuery?: string }) {
  const { t } = useI18n(), { item, pluginId } = source
  const vault = usePageStore(s => s.vaultRoot)
  const [query, setQuery] = useState(initialQuery || ''), [, refresh] = useState(0), [failed, setFailed] = useState(false)
  useEffect(() => {
    const off = item.subscribe(() => refresh(n => n + 1))
    refresh(n => n + 1)
    return off
  }, [item, vault])
  const rows = item.items(item.search ? { query } : undefined)
  const open = (row: ListItem, trusted: boolean) => {
    if (trusted) notePluginGesture(pluginId)
    setFailed(false)
    try { void Promise.resolve(item.open(row)).catch(() => setFailed(true)) } catch { setFailed(true) }
  }
  return <div className="iui-app-list">
    {item.search && <label className="iui-app-search"><Search size={14} /><input aria-label={t('iui.cardSearch')} placeholder={t('iui.cardSearch')} value={query} onChange={e => setQuery(e.target.value)} /></label>}
    {rows.slice(0, 6).map(row => <button type="button" className="iui-app-row" key={row.key} onClick={e => open(row, e.isTrusted)}><RowIcon key={row.iconUrl ?? ''} row={row} /><span>{row.title}</span><small>{row.hint}</small></button>)}
    {!rows.length && <p className="iui-app-empty">{t('iui.cardEmpty')}</p>}
    {rows.length > 6 && <p className="iui-app-empty">{t('iui.cardMore', { n: rows.length - 6 })}</p>}
    {failed && <p role="status">{t('iui.cardFailed')}</p>}
  </div>
}
export function IntelligentAppCard({ cardId, query }: { cardId: string; query?: string }) {
  const { t, locale } = useI18n()
  const sources = useSyncExternalStore(subscribeIntelligentSources, getIntelligentSources)
  const native = useSyncExternalStore(subscribeViews, () => cardId.startsWith('native:') ? getView(cardId.slice(7)) : undefined)
  const source = sources.find(s => `plugin:${s.pluginId}:${s.item.id}` === cardId)
  const target = native?.intelligent ? native.type : source ? `plugin:${source.pluginId}:${source.item.intelligent!.viewId}` : ''
  const fullView = useSyncExternalStore(subscribeViews, () => getView(target))
  const plugin = usePluginStore(s => source ? s.plugins.find(p => p.id === source.pluginId) : undefined)
  if ((!native?.intelligent && !source) || (query !== undefined && !source?.item.search)) return <div className="iui-status" data-card-unavailable={cardId} role="status">{t('iui.cardUnavailable')}</div>
  // The card is named by the app it shows, never by the model: a plugin card leads with the plugin's name,
  // unless one name already says the other (青鸟收藏夹 + 收藏夹).
  const owner = plugin && pluginDisplayName(plugin, locale), list = source?.item.title || ''
  const title = native ? (typeof native.displayName === 'function' ? native.displayName() : native.displayName) : !owner || list.includes(owner) ? list : owner.includes(list) ? owner : `${owner} · ${list}`
  const Icon = (native ?? fullView)?.icon ?? LayoutGrid
  return <section className="iui-app-card" data-app-card={cardId} aria-label={title}>
    <header>
      {plugin?.iconUrl ? <PluginLogo url={plugin.iconUrl} size={16} /> : <Icon size={15} className="iui-app-icon" aria-hidden="true" />}
      <strong>{title}</strong><span className="iui-live"><i />{t('iui.cardLive')}</span>
      {fullView && <button type="button" className="iui-app-open" aria-label={t('iui.cardOpen')} title={t('iui.cardOpen')} onClick={() => useWorkspace.getState().openView(target, {}, 'main', { newTab: true })}><ArrowUpRight size={15} /></button>}
    </header>
    <CardBoundary><div className="iui-app-body"><NativeSurface render={() => native?.intelligent ? native.intelligent.render() : <PluginList source={source!} initialQuery={query} />} /></div></CardBoundary>
  </section>
}
