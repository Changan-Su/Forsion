/**
 * Forsion 应用市场:发现首页 + 分类目录 + 安装管理 + 商品详情。
 * 浏览/安装全走主进程 IPC(marketService),token 不下发渲染层。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Bot, Check, Clock, Compass, Download, ExternalLink,
  GitBranch, Globe, LayoutGrid, Library, Loader2, Package, PackageOpen, Palette, Puzzle,
  RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Trash2, Wrench,
} from 'lucide-react'
import { Skeleton } from '@lcl/engine'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { Markdown } from './Markdown'
import { listMarket, getMarketDetail, installMarket, listInstalled, type InstalledItem } from '../services/marketService'
import { loadUserSpaces } from '../userSpaces'
import { useTheme } from '../stores/themeStore'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { installAmadeusPlugins } from '../amadeusPlugins'
import { usePluginOnboarding, needsOnboarding } from '../stores/pluginOnboardingStore'
import { track } from '../achievements/store'
import { act } from '../activity/log'
import { openBrowser } from '../builtins'
import type { MarketCard, MarketDetail } from '../types'

type MarketType = MarketCard['type']
type Tab = 'discover' | MarketType | 'webapp' | 'installed' | 'updates' | 'submit'
type SortMode = 'popular' | 'latest' | 'name'

const CONTENT_TABS: MarketType[] = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin']
const CATEGORY_TABS: Tab[] = [
  ...CONTENT_TABS.filter((tp) => tp !== 'amadeus-plugin'),
  ...(window.tangu?.connectStore ? (['webapp'] as Tab[]) : []),
]

interface WebApp { name: string; summary: string; handle: string; slug: string; url: string; updatedAt?: string }

function TypeGlyph({ type, size = 20 }: { type: MarketType | 'webapp'; size?: number }) {
  const Icon = type === 'skill' ? Wrench
    : type === 'agent' ? Bot
      : type === 'plugin' || type === 'amadeus-plugin' ? Puzzle
        : type === 'space' ? LayoutGrid
          : type === 'theme' ? Palette
            : Globe
  return <Icon size={size} strokeWidth={1.7} />
}

/** 卡片图标:投稿包里的 icon.png(服务端已校验 PNG/正方形/64~512px)。
 *  没有图标、或图片加载失败(离线/被删)→ 回落到类型字形,绝不留白框。 */
function ItemIcon({ url, type, size }: { url?: string | null; type: MarketType | 'webapp'; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <TypeGlyph type={type} size={size} />
  return <img className="mk-icon-img" src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
}

/** 最新版本是否比已装的新(仅数值 semver 比较;不可比/未知已装版本 → 不提示,避免误报)。 */
function isNewer(latest: string | null | undefined, installed: string | null): boolean {
  if (!latest || !installed) return false
  const norm = (s: string) => s.trim().replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10))
  const a = norm(latest), b = norm(installed)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x > y
  }
  return false
}

function timeValue(value?: string | null): number {
  if (!value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

export function MarketModal() {
  const { t } = useI18n()
  const close = useApp((s) => s.closeMarket)
  const toast = useApp((s) => s.toast)
  const [tab, setTab] = useState<Tab>('discover')
  const [catalog, setCatalog] = useState<MarketCard[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [updatable, setUpdatable] = useState<MarketCard[]>([])
  const [detail, setDetail] = useState<MarketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [webApps, setWebApps] = useState<{ base: string; items: WebApp[] } | null>(null)
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [scanning, setScanning] = useState(true)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('popular')

  // 一次拉全目录:发现/分类/搜索/更新共用同一份快照,避免切 tab 重复请求和闪烁。
  const scanCatalog = useCallback(async () => {
    setScanning(true)
    setCatalogError('')
    const inst = await listInstalled().catch(() => ({} as Record<string, InstalledItem[]>))
    setInstalled(inst)
    const settled = await Promise.allSettled(CONTENT_TABS.map((tp) => listMarket(tp)))
    const lists = settled.map((result) => result.status === 'fulfilled' ? result.value : [])
    const all = lists.flat()
    setCatalog(all)
    if (settled.every((result) => result.status === 'rejected')) setCatalogError(t('market.loadFailShort'))
    const ups = all.filter((c) => {
      const pools = (c.type === 'plugin' || c.type === 'amadeus-plugin')
        ? [...(inst[c.type] || []), ...(inst[c.type === 'plugin' ? 'amadeus-plugin' : 'plugin'] || [])]
        : (inst[c.type] || [])
      const entry = pools.find((x) => x.slug === c.installSlug)
      return !!entry && isNewer(c.latestVersion, entry.version)
    })
    setUpdatable(ups)
    setScanning(false)
  }, [t])

  useEffect(() => { void scanCatalog() }, [scanCatalog])

  useEffect(() => {
    if (tab !== 'webapp' || webApps || webLoading || webError) return
    setWebLoading(true)
    setWebError('')
    window.tangu!.connectStore!()
      .then((r) => {
        if (!r.ok) throw new Error(r.detail || 'error')
        setWebApps({ base: r.base || '', items: r.items || [] })
      })
      .catch((e) => setWebError(t('market.loadFail', { e: e?.message || String(e) })))
      .finally(() => setWebLoading(false))
  }, [tab, t, webApps, webError, webLoading])

  const installedInfo = useCallback((c: MarketCard): { entry: InstalledItem; realType: string } | null => {
    const find = (tp: string) => (installed[tp] || []).find((x) => x.slug === c.installSlug)
    const primary = find(c.type)
    if (primary) return { entry: primary, realType: c.type }
    if (c.type === 'plugin' || c.type === 'amadeus-plugin') {
      const other = c.type === 'plugin' ? 'amadeus-plugin' : 'plugin'
      const entry = find(other)
      if (entry) return { entry, realType: other }
    }
    return null
  }, [installed])

  const installedEntry = (c: MarketCard): InstalledItem | undefined => installedInfo(c)?.entry
  const isInstalled = (c: MarketCard): boolean => !!installedEntry(c)
  const hasUpdate = (c: MarketCard): boolean => isNewer(c.latestVersion, installedEntry(c)?.version ?? null)

  const canOpenSettings = (c: MarketCard): boolean => {
    const realType = installedInfo(c)?.realType
    if (realType === 'amadeus-plugin') return !!window.amadeus
    return realType === 'plugin'
  }

  const openPluginSettings = (c: MarketCard): void => {
    if (!installedInfo(c) || !canOpenSettings(c)) return
    close()
    useApp.getState().openSettings('amadeus-plugins')
  }

  const onInstall = async (c: MarketCard): Promise<void> => {
    setInstalling(c.id)
    try {
      const res = await installMarket(c.id)
      const effectiveType = ((res?.type as MarketType) || c.type)
      track('market.install')
      act('market.install', { id: c.id })
      if (effectiveType === 'plugin') {
        await useApp.getState().onPluginInstalled()
      } else if (effectiveType === 'space') {
        await loadUserSpaces()
        toast(t('market.spaceInstalled', { name: c.name }))
      } else if (effectiveType === 'theme') {
        await useTheme.getState().reloadThemes()
        toast(t('market.themeInstalled', { name: c.name }))
      } else if (effectiveType === 'amadeus-plugin') {
        if (window.amadeus) {
          installAmadeusPlugins()
          const before = new Set(usePluginStore.getState().plugins.map((p) => p.id))
          await usePluginStore.getState().reloadExternal()
          const state = usePluginStore.getState()
          const freshAll = state.plugins.filter((p) => !before.has(p.id))
          if (state.plugins.some((p) => p.bundle?.enginePlugins?.length)) await useApp.getState().onPluginInstalled()
          await loadUserSpaces()
          const fresh = freshAll.find((p) => state.activeIds.includes(p.id) && needsOnboarding(p))
          if (fresh) usePluginOnboarding.getState().open(fresh.id)
        }
        toast(t('market.amadeusPluginInstalled', { name: c.name }))
      } else {
        toast(t('market.installOk', { name: c.name }))
      }
      await scanCatalog()
    } catch (e: any) {
      toast(t('market.installFail', { e: e?.message || String(e) }), true)
    } finally {
      setInstalling(null)
    }
  }

  const onUninstall = async (c: MarketCard): Promise<void> => {
    const info = installedInfo(c)
    if (!info) return
    // agent 与 skill 落地后是**活体**(agent 带自己的 MEMORY/LOG,技能可能被用户改过),
    // 删目录 = 连用户数据一起没。确认文案对这两类单独加重,别用一句通用的「确定卸载吗」糊过去。
    const warn = info.realType === 'agent' ? t('market.uninstallWarnAgent')
      : info.realType === 'skill' ? t('market.uninstallWarnSkill')
      : ''
    if (!window.confirm(t('market.uninstallConfirm', { name: c.name }) + (warn ? `\n\n${warn}` : ''))) return
    setUninstalling(c.id)
    try {
      await window.tangu!.marketUninstall!(info.realType, c.installSlug)
      act('market.uninstall', { id: c.id })
      // 热重载与安装侧对称:装完刷新了什么,卸完就要刷新什么,否则界面上那一项还在。
      if (info.realType === 'space') await loadUserSpaces()
      else if (info.realType === 'theme') await useTheme.getState().reloadThemes()
      else if (info.realType === 'amadeus-plugin') {
        if (window.amadeus) { await usePluginStore.getState().reloadExternal(); await loadUserSpaces() }
      }
      // 引擎插件的工具/路由**无法运行期反注册**,删目录后仍要重启后端才真正消失(同设置页卸载口径)。
      toast(info.realType === 'plugin'
        ? t('market.uninstalledNeedsRestart', { name: c.name })
        : t('market.uninstalled', { name: c.name }))
      await scanCatalog()
    } catch (e: any) {
      toast(t('market.uninstallFail', { e: e?.message || String(e) }), true)
    } finally {
      setUninstalling(null)
    }
  }

  const openDetail = (c: MarketCard): void => {
    setDetailLoading(true)
    setDetail(null)
    getMarketDetail(c.id)
      .then(setDetail)
      .catch((e) => toast(t('market.loadFail', { e: e?.message || String(e) }), true))
      .finally(() => setDetailLoading(false))
  }

  const switchTab = (next: Tab): void => {
    setTab(next)
    setDetail(null)
    setQuery('')
  }

  const installBtn = (c: MarketCard, extraClass = '') => {
    const busy = installing === c.id
    const done = isInstalled(c)
    const update = hasUpdate(c)
    const inst = installedEntry(c)
    return (
      <button
        className={`btn sm ${update || !done ? 'primary' : ''} ${extraClass}`.trim()}
        disabled={busy}
        title={update ? t('market.updateTitle', { from: inst?.version || '?', to: c.latestVersion || '?' }) : undefined}
        onClick={(e) => { e.stopPropagation(); void onInstall(c) }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : update ? <RefreshCw size={13} /> : done ? <Check size={13} /> : <Download size={13} />}
        {busy ? t('market.installing') : update ? t('market.update') : done ? t('market.reinstall') : t('market.install')}
      </button>
    )
  }

  /** 卸载按钮:只对已安装项出现;webapp 没有本地安装目录,不在此列。 */
  const uninstallBtn = (c: MarketCard, extraClass = '') => {
    if (!isInstalled(c)) return null
    const busy = uninstalling === c.id
    return (
      <button
        className={`btn sm ghost ${extraClass}`.trim()}
        disabled={busy || installing === c.id}
        title={t('market.uninstall')}
        aria-label={t('market.uninstall')}
        onClick={(e) => { e.stopPropagation(); void onUninstall(c) }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : <Trash2 size={13} />}
      </button>
    )
  }

  const navLabel: Record<Tab, string> = {
    discover: t('market.tab.discover'),
    skill: t('market.tab.skills'),
    agent: t('market.tab.agents'),
    plugin: t('market.tab.plugins'),
    space: t('market.tab.spaces'),
    theme: t('market.tab.themes'),
    'amadeus-plugin': t('market.tab.plugins'),
    webapp: t('market.tab.webapps'),
    installed: t('market.tab.installed'),
    updates: t('market.tab.updates'),
    submit: t('market.tab.submit'),
  }

  const matchesQuery = useCallback((c: MarketCard): boolean => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return true
    return [c.name, c.summary, c.author, ...(c.tags || [])]
      .some((value) => value.toLocaleLowerCase().includes(needle))
  }, [query])

  const sortCards = useCallback((cards: MarketCard[], mode = sort): MarketCard[] => {
    const copy = [...cards]
    if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name))
    if (mode === 'latest') return copy.sort((a, b) => timeValue(b.updatedAt || b.createdAt) - timeValue(a.updatedAt || a.createdAt))
    return copy.sort((a, b) => b.downloads - a.downloads)
  }, [sort])

  const visibleCatalog = useMemo(() => {
    let cards = tab === 'installed'
      ? catalog.filter((c) => !!installedInfo(c))
      : tab === 'updates'
        ? updatable
        : CONTENT_TABS.includes(tab as MarketType)
          ? catalog.filter((c) => tab === 'plugin'
            ? c.type === 'plugin' || c.type === 'amadeus-plugin'
            : c.type === tab)
          : catalog
    cards = cards.filter(matchesQuery)
    return sortCards(cards)
  }, [catalog, installedInfo, matchesQuery, sortCards, tab, updatable])

  const featured = useMemo(() => sortCards(catalog.filter(matchesQuery), 'popular')[0], [catalog, matchesQuery, sortCards])
  const recent = useMemo(() => sortCards(catalog.filter(matchesQuery), 'latest').slice(0, 4), [catalog, matchesQuery, sortCards])
  const popular = useMemo(() => sortCards(catalog.filter(matchesQuery), 'popular').filter((c) => c.id !== featured?.id).slice(0, 6), [catalog, featured?.id, matchesQuery, sortCards])
  const visibleWebApps = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (webApps?.items || []).filter((item) => !needle || [item.name, item.summary, item.handle].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [query, webApps])

  const openWebApp = (w: WebApp): void => {
    if (!webApps) return
    openBrowser(webApps.base + w.url)
    close()
  }

  const card = (c: MarketCard, compact = false) => (
    <article key={c.id} className={`mk-card ${compact ? 'compact' : ''}`} onClick={() => openDetail(c)}>
      <div className="mk-card-visual" aria-hidden="true"><ItemIcon url={c.iconUrl} type={c.type} size={compact ? 20 : 24} /></div>
      <div className="mk-card-content">
        <div className="mk-card-eyeline">
          <span>{navLabel[c.type]}</span>
          {isInstalled(c) && <span className="mk-installed-badge"><Check size={11} />{t('market.installed')}</span>}
        </div>
        <button className="mk-card-title" onClick={(e) => { e.stopPropagation(); openDetail(c) }}>{c.name}</button>
        <div className="mk-card-summary">{c.summary || t('market.summaryFallback')}</div>
        {!!c.tags?.length && <div className="mk-tags">{c.tags.slice(0, compact ? 2 : 3).map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <div className="mk-card-foot">
          <span className="mk-card-meta">{c.author}<span aria-hidden="true"> · </span>{t('market.downloadsShort', { n: c.downloads })}</span>
          {installBtn(c)}
          {uninstallBtn(c)}
        </div>
      </div>
    </article>
  )

  const catalogState = (cards: MarketCard[]) => {
    if (scanning) return <Skeleton variant="list" />
    if (catalogError && catalog.length === 0) return (
      <div className="mk-state-card"><PackageOpen size={28} /><strong>{catalogError}</strong><button className="btn sm" onClick={() => void scanCatalog()}><RefreshCw size={13} />{t('market.retry')}</button></div>
    )
    if (cards.length === 0) return (
      <div className="mk-state-card">
        <Search size={28} />
        <strong>{query ? t('market.noResults') : tab === 'installed' ? t('market.noInstalled') : t('market.empty')}</strong>
        <span>{query ? t('market.noResultsHint') : t('market.emptyHint')}</span>
        {(query || tab === 'installed') && <button className="btn sm" onClick={() => query ? setQuery('') : switchTab('discover')}>{query ? t('market.clearSearch') : t('market.browse')}</button>}
      </div>
    )
    return <div className="mk-grid">{cards.map((item) => card(item))}</div>
  }

  const showSearch = !detail && tab !== 'submit'
  const showSort = !detail && tab !== 'submit' && tab !== 'webapp'

  return (
    <div className="settings-page mk-page">
      <aside className="settings-nav" aria-label="Market navigation">
        <div className="settings-nav-top">
          <button className="settings-back" onClick={close}><ArrowLeft size={15} /> {t('settings.backToApp')}</button>
          <div className="mk-nav-brand"><div className="mk-nav-mark"><Sparkles size={17} /></div><div><strong>{t('market.title')}</strong><span>{t('market.navSubtitle')}</span></div></div>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group"><div className="settings-nav-grouphead">{t('market.group.discover')}</div><button className={tab === 'discover' ? 'active' : ''} onClick={() => switchTab('discover')}><Compass size={15} />{navLabel.discover}</button></div>
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.categories')}</div>
            {CATEGORY_TABS.map((id) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => switchTab(id)}><TypeGlyph type={id as MarketType | 'webapp'} size={15} />{navLabel[id]}</button>)}
          </div>
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.manage')}</div>
            <button className={tab === 'installed' ? 'active' : ''} onClick={() => switchTab('installed')}><Library size={15} />{navLabel.installed}</button>
            <button className={tab === 'updates' ? 'active' : ''} onClick={() => switchTab('updates')}><RefreshCw size={15} />{navLabel.updates}{updatable.length > 0 && <span className="mk-nav-count">{updatable.length}</span>}</button>
            <button className={tab === 'submit' ? 'active' : ''} onClick={() => switchTab('submit')}><Send size={15} />{navLabel.submit}</button>
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head mk-main-head">
          <div className="mk-title-block"><div className="settings-main-title">{detail ? detail.name : navLabel[tab]}</div><div className="mk-title-subtitle">{detail ? t('market.detailSubtitle') : tab === 'discover' ? t('market.subtitle') : t('market.sectionSubtitle', { section: navLabel[tab] })}</div></div>
          {showSearch && <label className="mk-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('market.searchPlaceholder')} />{query && <button onClick={() => setQuery('')} aria-label={t('market.clearSearch')}>×</button>}</label>}
          {showSort && <label className="mk-sort"><span>{t('market.sort.label')}</span><select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}><option value="popular">{t('market.sort.popular')}</option><option value="latest">{t('market.sort.latest')}</option><option value="name">{t('market.sort.name')}</option></select></label>}
        </div>

        <div className="settings-body mk-body">
          {detail ? (
            <div className="mk-detail">
              <button className="settings-back mk-detail-back" onClick={() => setDetail(null)}><ArrowLeft size={14} />{t('market.detailBack')}</button>
              <div className="mk-detail-hero"><div className="mk-detail-icon"><ItemIcon url={detail.iconUrl} type={detail.type} size={36} /></div><div className="mk-detail-intro"><span className="mk-detail-kind">{navLabel[detail.type]}</span><h2>{detail.name}</h2><p>{detail.summary || t('market.summaryFallback')}</p><div className="mk-detail-byline">{t('market.author')} {detail.author}<span aria-hidden="true"> · </span>{t('market.downloads', { n: detail.downloads })}</div></div></div>
              <div className="mk-detail-layout">
                <main className="mk-detail-main"><div className="mk-detail-section-title">{t('market.overview')}</div>{!!detail.tags?.length && <div className="mk-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}<div className="mk-readme">{detail.readme ? <Markdown content={detail.readme} /> : <span className="mk-muted">{t('market.readmeEmpty')}</span>}</div></main>
                <aside className="mk-detail-sidebar">
                  <div className="mk-detail-actions">{installBtn(detail, 'mk-wide-btn')}{uninstallBtn(detail)}{canOpenSettings(detail) && <button className="btn sm mk-wide-btn" onClick={() => openPluginSettings(detail)}><Settings size={13} />{t('market.openSettings')}</button>}</div>
                  <div className="mk-trust-row"><ShieldCheck size={17} /><div><strong>{t('market.reviewed')}</strong><span>{t('market.reviewedHint')}</span></div></div>
                  <dl className="mk-facts"><div><dt>{t('market.type')}</dt><dd>{navLabel[detail.type]}</dd></div><div><dt>{t('market.version')}</dt><dd>{detail.latestVersion ? `v${detail.latestVersion}` : t('market.unknown')}</dd></div><div><dt>{t('market.source')}</dt><dd>{detail.source === 'github' ? 'GitHub' : t('market.sourceUpload')}</dd></div>{!!formatDate(detail.updatedAt || detail.createdAt) && <div><dt>{t('market.updated')}</dt><dd>{formatDate(detail.updatedAt || detail.createdAt)}</dd></div>}</dl>
                  {detail.githubRepoUrl && <a className="mk-repo-link" href={detail.githubRepoUrl} target="_blank" rel="noreferrer"><GitBranch size={14} />{t('market.openRepo')}<ExternalLink size={12} /></a>}
                </aside>
              </div>
            </div>
          ) : detailLoading ? <Skeleton variant="document" />
            : tab === 'discover' ? (
              scanning ? <Skeleton variant="document" /> : catalogError && catalog.length === 0 ? catalogState([]) : query ? (
                <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.searchResults')}</h2><p>{t('market.resultCount', { n: visibleCatalog.length })}</p></div></div>{catalogState(visibleCatalog)}</section>
              ) : catalog.length === 0 ? catalogState([]) : (
                <div className="mk-discover">
                  {featured && <section className="mk-featured" onClick={() => openDetail(featured)}><div className="mk-featured-copy"><span className="mk-featured-label"><Sparkles size={13} />{t('market.featured')}</span><h2>{featured.name}</h2><p>{featured.summary || t('market.summaryFallback')}</p><div className="mk-featured-meta">{navLabel[featured.type]}<span aria-hidden="true"> · </span>{featured.author}<span aria-hidden="true"> · </span>{t('market.downloadsShort', { n: featured.downloads })}</div><div className="mk-featured-actions"><button className="btn sm" onClick={(e) => { e.stopPropagation(); openDetail(featured) }}>{t('market.viewDetails')}<ArrowRight size={13} /></button>{installBtn(featured)}</div></div><div className="mk-featured-art" aria-hidden="true"><ItemIcon url={featured.iconUrl} type={featured.type} size={58} /><span>{navLabel[featured.type]}</span></div></section>}
                  {recent.length > 0 && <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.recent')}</h2><p>{t('market.recentHint')}</p></div><Clock size={18} /></div><div className="mk-recent-grid">{recent.map((item) => card(item, true))}</div></section>}
                  {popular.length > 0 && <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.popular')}</h2><p>{t('market.popularHint')}</p></div><Package size={18} /></div><div className="mk-grid">{popular.map((item) => card(item))}</div></section>}
                </div>
              )
            ) : tab === 'webapp' ? (
              webLoading ? <Skeleton variant="list" /> : webError ? <div className="mk-state-card"><PackageOpen size={28} /><strong>{webError}</strong><button className="btn sm" onClick={() => { setWebApps(null); setWebError('') }}>{t('market.retry')}</button></div> : visibleWebApps.length === 0 ? <div className="mk-state-card"><Globe size={28} /><strong>{query ? t('market.noResults') : t('market.empty')}</strong><span>{query ? t('market.noResultsHint') : t('market.webHint')}</span></div> : (
                <div className="mk-webapps"><p className="mk-web-hint">{t('market.webHint')}</p><div className="mk-grid">{visibleWebApps.map((item) => <article key={`${item.handle}/${item.slug}`} className="mk-card" onClick={() => openWebApp(item)}><div className="mk-card-visual"><Globe size={24} /></div><div className="mk-card-content"><div className="mk-card-eyeline"><span>{navLabel.webapp}</span></div><button className="mk-card-title" onClick={(e) => { e.stopPropagation(); openWebApp(item) }}>{item.name}</button><div className="mk-card-summary">{item.summary || t('market.summaryFallback')}</div><div className="mk-card-foot"><span className="mk-card-meta">{item.handle}</span><button className="btn sm primary" onClick={(e) => { e.stopPropagation(); openWebApp(item) }}><Globe size={13} />{t('market.webOpen')}</button></div></div></article>)}</div></div>
              )
            ) : tab === 'submit' ? (
              <section className="mk-submit"><div className="mk-submit-copy"><span>{t('market.submitKicker')}</span><h2>{t('market.submitTitle')}</h2><p>{t('market.submitHint')}</p><button className="btn primary" onClick={() => void window.tangu?.openAccountCenter?.('submission')}><ExternalLink size={15} />{t('market.submitOpen')}</button></div><div className="mk-submit-art"><PackageOpen size={44} /><strong>{t('market.submitArtTitle')}</strong><span>{t('market.submitArtHint')}</span></div></section>
            ) : (
              <section className="mk-section"><div className="mk-section-head"><div><h2>{navLabel[tab]}</h2><p>{t('market.resultCount', { n: visibleCatalog.length })}</p></div>{tab === 'updates' ? <RefreshCw size={18} /> : tab === 'installed' ? <Library size={18} /> : <TypeGlyph type={tab as MarketType} size={18} />}</div>{tab === 'updates' && !scanning && updatable.length === 0 && !query ? <div className="mk-state-card"><Check size={28} /><strong>{t('market.allUpToDate')}</strong><span>{t('market.allUpToDateHint')}</span></div> : catalogState(visibleCatalog)}</section>
            )}
        </div>
      </section>
    </div>
  )
}
