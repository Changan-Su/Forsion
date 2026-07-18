/**
 * Forsion 应用市场:全屏 overlay(复刻设置页外壳 .settings-page)。
 * 四类:技能 / 智能体 / 插件(卡片浏览 → 详情 README → 一键安装到 ~/.tangu)+ 投稿(跳网页个人中心)。
 * 浏览/安装全走主进程 IPC(marketService),token 不下发渲染层。
 */
import { useEffect, useState, useCallback } from 'react'
import { ArrowLeft, Download, Check, Loader2, ExternalLink, PackageOpen, RefreshCw } from 'lucide-react'
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
import type { MarketCard, MarketDetail } from '../types'

type Tab = 'skill' | 'agent' | 'plugin' | 'space' | 'theme' | 'amadeus-plugin' | 'updates' | 'submit'
const CONTENT_TABS: Tab[] = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin']
// 笔记插件 tab 只在带 Amadeus 的产品档案里露出(与设置页同门禁);updates 扫描仍扫全类型,无害。
const NAV_TABS: Tab[] = CONTENT_TABS.filter((tp) => tp !== 'amadeus-plugin' || !!window.amadeus)

/** 最新版本是否比已装的新(仅数值 semver 比较;不可比/未知已装版本 → 不提示,避免误报)。 */
function isNewer(latest: string | null | undefined, installed: string | null): boolean {
  if (!latest || !installed) return false
  const norm = (s: string) => s.trim().replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10))
  const a = norm(latest), b = norm(installed)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false // 含非数字段 → 不可靠比较,不提示
    if (x !== y) return x > y
  }
  return false
}

export function MarketModal() {
  const { t } = useI18n()
  const close = useApp((s) => s.closeMarket)
  const toast = useApp((s) => s.toast)
  const [tab, setTab] = useState<Tab>('skill')
  const [items, setItems] = useState<MarketCard[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [updatable, setUpdatable] = useState<MarketCard[]>([])
  const [detail, setDetail] = useState<MarketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  // 扫描可更新:拉已装版本 + 三类市场卡片,比对每个已装项的 manifest 版本 vs 市场最新版本。
  const scanUpdates = useCallback(async () => {
    const inst = await listInstalled().catch(() => ({} as Record<string, InstalledItem[]>))
    setInstalled(inst)
    const lists = await Promise.all(CONTENT_TABS.map((tp) => listMarket(tp).catch(() => [])))
    const ups = lists.flat().filter((c) => {
      const e = (inst[c.type] || []).find((x) => x.slug === c.installSlug)
      return !!e && isNewer(c.latestVersion, e.version)
    })
    setUpdatable(ups)
  }, [])

  useEffect(() => { void scanUpdates() }, [scanUpdates])

  useEffect(() => {
    if (tab === 'submit' || tab === 'updates') return // 投稿跳网页;可更新用 updatable(已扫描),都不走列表拉取
    setDetail(null)
    setErr('')
    setLoading(true)
    listMarket(tab)
      .then(setItems)
      .catch((e) => setErr(t('market.loadFail', { e: e?.message || String(e) })))
      .finally(() => setLoading(false))
  }, [tab, t])

  const installedEntry = (c: MarketCard): InstalledItem | undefined => (installed[c.type] || []).find((x) => x.slug === c.installSlug)
  const isInstalled = (c: MarketCard): boolean => !!installedEntry(c)
  const hasUpdate = (c: MarketCard): boolean => isNewer(c.latestVersion, installedEntry(c)?.version ?? null)

  const onInstall = async (c: MarketCard): Promise<void> => {
    setInstalling(c.id)
    try {
      await installMarket(c.id)
      track('market.install'); act('market.install', { id: c.id })
      if (c.type === 'plugin') {
        // 插件:重扫免重启出现 + 装即启用 + 跳转设置(在 onPluginInstalled 内 toast)。
        await useApp.getState().onPluginInstalled()
      } else if (c.type === 'space') {
        // 数据 Space:装完热注册,ribbon 顶部实时出现,无需重启。
        await loadUserSpaces()
        toast(t('market.spaceInstalled', { name: c.name }))
      } else if (c.type === 'theme') {
        // 主题:装完热重载磁盘主题,设置 → 主题 里即时可选,无需重启。
        await useTheme.getState().reloadThemes()
        toast(t('market.themeInstalled', { name: c.name }))
      } else if (c.type === 'amadeus-plugin') {
        // 笔记插件:落全局目录(~/.tangu/amadeus/plugins),重载外部插件即生效,免 vault。
        if (window.amadeus) {
          installAmadeusPlugins()
          const before = new Set(usePluginStore.getState().plugins.map((p) => p.id))
          await usePluginStore.getState().reloadExternal()
          // 新装且带引导声明的插件:装完即弹就绪卡(用户注意力正在场;更新/重装不弹)。
          const state = usePluginStore.getState()
          const fresh = state.plugins.find((p) => !before.has(p.id) && state.activeIds.includes(p.id) && needsOnboarding(p))
          if (fresh) usePluginOnboarding.getState().open(fresh.id)
        }
        toast(t('market.amadeusPluginInstalled', { name: c.name }))
      } else {
        toast(t('market.installOk', { name: c.name }))
      }
      await scanUpdates() // 刷新已装版本 + 重算可更新
    } catch (e: any) {
      toast(t('market.installFail', { e: e?.message || String(e) }), true)
    } finally {
      setInstalling(null)
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

  const installBtn = (c: MarketCard) => {
    const busy = installing === c.id
    const done = isInstalled(c)
    const upd = hasUpdate(c)
    const inst = installedEntry(c)
    return (
      <button
        className={`btn sm ${upd || !done ? 'primary' : ''}`}
        disabled={busy}
        title={upd ? t('market.updateTitle', { from: inst?.version || '?', to: c.latestVersion || '?' }) : undefined}
        onClick={(e) => { e.stopPropagation(); void onInstall(c) }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : upd ? <RefreshCw size={13} /> : done ? <Check size={13} /> : <Download size={13} />}
        {busy ? t('market.installing') : upd ? t('market.update') : done ? t('market.reinstall') : t('market.install')}
      </button>
    )
  }

  const navLabel: Record<Tab, string> = {
    skill: t('market.tab.skills'),
    agent: t('market.tab.agents'),
    plugin: t('market.tab.plugins'),
    space: t('market.tab.spaces'),
    theme: t('market.tab.themes'),
    'amadeus-plugin': t('market.tab.amadeusPlugins'),
    updates: t('market.tab.updates'),
    submit: t('market.tab.submit'),
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label="Market navigation">
        <div className="settings-nav-top">
          <button className="settings-back" onClick={close}>
            <ArrowLeft size={15} /> {t('settings.backToApp')}
          </button>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.title')}</div>
            {NAV_TABS.map((id) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{navLabel[id]}</button>
            ))}
            <button className={tab === 'updates' ? 'active' : ''} onClick={() => setTab('updates')}>
              {navLabel.updates}{updatable.length > 0 ? ` (${updatable.length})` : ''}
            </button>
            <button className={tab === 'submit' ? 'active' : ''} onClick={() => setTab('submit')}>{navLabel.submit}</button>
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head">
          <div className="settings-main-title">{detail ? detail.name : navLabel[tab]}</div>
        </div>
        <div className="settings-body">
          {tab === 'updates' ? (
            updatable.length === 0 ? (
              <div className="mk-state mk-muted">{t('market.allUpToDate')}</div>
            ) : (
              <div className="mk-grid">
                {updatable.map((c) => (
                  <div key={c.id} className="mk-card" onClick={() => openDetail(c)}>
                    <div className="mk-card-title">{c.name}</div>
                    <div className="mk-card-summary">{c.summary || ''}</div>
                    <div className="mk-card-foot">
                      <span className="mk-card-meta">{navLabel[c.type as Tab]} · v{installedEntry(c)?.version || '?'} → v{c.latestVersion}</span>
                      {installBtn(c)}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : tab === 'submit' ? (
            <div className="mk-submit">
              <PackageOpen size={40} className="mk-submit-ic" />
              <p className="mk-submit-hint">{t('market.submitHint')}</p>
              <button className="btn primary" onClick={() => void window.tangu?.openAccountCenter?.('submission')}>
                <ExternalLink size={15} /> {t('market.submitOpen')}
              </button>
            </div>
          ) : detail ? (
            <div className="mk-detail">
              <button className="settings-back mk-detail-back" onClick={() => setDetail(null)}>
                <ArrowLeft size={14} /> {t('market.detailBack')}
              </button>
              <div className="mk-detail-head">
                <div>
                  <div className="mk-detail-title">{detail.name}</div>
                  <div className="mk-card-meta">
                    {t('market.author')} {detail.author} · {t('market.downloads', { n: detail.downloads })}
                  </div>
                </div>
                {installBtn(detail)}
              </div>
              {detail.githubRepoUrl && (
                <a className="mk-repo-link" href={detail.githubRepoUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> {t('market.openRepo')}
                </a>
              )}
              <div className="mk-readme">
                {detail.readme ? <Markdown content={detail.readme} /> : <span className="mk-muted">{t('market.readmeEmpty')}</span>}
              </div>
            </div>
          ) : loading || detailLoading ? (
            <div className="mk-state"><Loader2 size={20} className="mk-spin" /></div>
          ) : err ? (
            <div className="mk-state mk-error">{err}</div>
          ) : items.length === 0 ? (
            <div className="mk-state mk-muted">{t('market.empty')}</div>
          ) : (
            <div className="mk-grid">
              {items.map((c) => (
                <div key={c.id} className="mk-card" onClick={() => openDetail(c)}>
                  <div className="mk-card-title">{c.name}</div>
                  <div className="mk-card-summary">{c.summary || ''}</div>
                  <div className="mk-card-foot">
                    <span className="mk-card-meta">{t('market.author')} {c.author} · {t('market.downloads', { n: c.downloads })}</span>
                    {installBtn(c)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
