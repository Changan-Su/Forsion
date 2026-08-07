/**
 * Forsion 应用市场:全屏 overlay(复刻设置页外壳 .settings-page)。
 * 四类:技能 / 智能体 / 插件(卡片浏览 → 详情 README → 一键安装到 ~/.tangu)+ 投稿(跳网页个人中心)。
 * 浏览/安装全走主进程 IPC(marketService),token 不下发渲染层。
 */
import { useEffect, useState, useCallback } from 'react'
import { ArrowLeft, Download, Check, Loader2, ExternalLink, PackageOpen, RefreshCw, Settings, Globe } from 'lucide-react'
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

type Tab = 'skill' | 'agent' | 'plugin' | 'space' | 'theme' | 'amadeus-plugin' | 'webapp' | 'updates' | 'submit'
const CONTENT_TABS: Tab[] = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin']
// 笔记插件 tab 只在带 Amadeus 的产品档案里露出(与设置页同门禁);updates 扫描仍扫全类型,无害。
// 网站应用(用户上架的 Connect 网页 app)不装东西只打开,不进 CONTENT_TABS 的安装/更新机器。
const NAV_TABS: Tab[] = [
  ...CONTENT_TABS.filter((tp) => tp !== 'amadeus-plugin' || !!window.amadeus),
  ...(window.tangu?.connectStore ? (['webapp'] as Tab[]) : []),
]

interface WebApp { name: string; summary: string; handle: string; slug: string; url: string; updatedAt?: string }

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
  const [webApps, setWebApps] = useState<{ base: string; items: WebApp[] } | null>(null)

  const [scanning, setScanning] = useState(true)

  // 扫描可更新:拉已装版本 + 三类市场卡片,比对每个已装项的 manifest 版本 vs 市场最新版本。
  const scanUpdates = useCallback(async () => {
    const inst = await listInstalled().catch(() => ({} as Record<string, InstalledItem[]>))
    setInstalled(inst)
    const lists = await Promise.all(CONTENT_TABS.map((tp) => listMarket(tp).catch(() => [])))
    const ups = lists.flat().filter((c) => {
      // 插件家族跨两目录找(后端可能误标 plugin↔amadeus-plugin),与 installedInfo 同口径:声明类型优先,再回退另一目录。
      const pools = (c.type === 'plugin' || c.type === 'amadeus-plugin')
        ? [...(inst[c.type] || []), ...(inst[c.type === 'plugin' ? 'amadeus-plugin' : 'plugin'] || [])]
        : (inst[c.type] || [])
      const e = pools.find((x) => x.slug === c.installSlug)
      return !!e && isNewer(c.latestVersion, e.version)
    })
    setUpdatable(ups)
    setScanning(false)
  }, [])

  useEffect(() => { void scanUpdates() }, [scanUpdates])

  useEffect(() => {
    if (tab === 'submit' || tab === 'updates') return // 投稿跳网页;可更新用 updatable(已扫描),都不走列表拉取
    setDetail(null)
    setErr('')
    setLoading(true)
    if (tab === 'webapp') {
      // 网站应用走 Connect 公开列表(主进程拉云端),与 market_items 管线无关。
      window.tangu!.connectStore!()
        .then((r) => {
          if (!r.ok) throw new Error(r.detail || 'error')
          setWebApps({ base: r.base || '', items: r.items || [] })
        })
        .catch((e) => setErr(t('market.loadFail', { e: e?.message || String(e) })))
        .finally(() => setLoading(false))
      return
    }
    listMarket(tab)
      .then(setItems)
      .catch((e) => setErr(t('market.loadFail', { e: e?.message || String(e) })))
      .finally(() => setLoading(false))
  }, [tab, t])

  // 已装查找:插件家族按**实际安装目录**判真类型(后端可能误标 plugin↔amadeus-plugin,装到哪就是哪类),
  // 故跨两个插件目录找;非插件类型照常按 c.type。realType 供详情「打开设置」路由到正确的设置页。
  const installedInfo = (c: MarketCard): { entry: InstalledItem; realType: string } | null => {
    const find = (tp: string) => (installed[tp] || []).find((x) => x.slug === c.installSlug)
    // 先按卡片声明的类型找:正确标注时精准命中,两个同 slug 跨类型插件各归各(不互相误配);
    // 找不到再回退插件家族的另一目录 —— 这才是「后端把 Forsion 插件误标成 plugin」的补救路径。
    const primary = find(c.type)
    if (primary) return { entry: primary, realType: c.type }
    if (c.type === 'plugin' || c.type === 'amadeus-plugin') {
      const other = c.type === 'plugin' ? 'amadeus-plugin' : 'plugin'
      const e = find(other)
      if (e) return { entry: e, realType: other }
    }
    return null
  }
  const installedEntry = (c: MarketCard): InstalledItem | undefined => installedInfo(c)?.entry
  const isInstalled = (c: MarketCard): boolean => !!installedEntry(c)
  const hasUpdate = (c: MarketCard): boolean => isNewer(c.latestVersion, installedEntry(c)?.version ?? null)
  // 详情里「打开设置」:按真类型跳到对应设置页(引擎插件→plugins;Forsion 插件→amadeus-plugins)。
  // 「打开设置」是否可用:插件家族且已装;Forsion 插件需当前产品带 Amadeus(否则 amadeus-plugins 设置页被门禁掉,跳过去是空白)。
  const canOpenSettings = (c: MarketCard): boolean => {
    const rt = installedInfo(c)?.realType
    if (rt === 'amadeus-plugin') return !!window.amadeus
    return rt === 'plugin'
  }
  const openPluginSettings = (c: MarketCard): void => {
    const info = installedInfo(c)
    if (!info || !canOpenSettings(c)) return
    close()
    // 插件家族统一入口:引擎插件与 Forsion 插件同在 amadeus-plugins 页(两区一页)。
    useApp.getState().openSettings('amadeus-plugins')
  }

  const onInstall = async (c: MarketCard): Promise<void> => {
    setInstalling(c.id)
    try {
      const res = await installMarket(c.id)
      // 真类型以主进程实测为准(后端 category 可能把 Forsion 插件误标成引擎 'plugin');据此走对应装后流程。
      const effType = ((res?.type as MarketCard['type']) || c.type)
      track('market.install'); act('market.install', { id: c.id })
      if (effType === 'plugin') {
        // 引擎插件:重扫免重启出现 + 装即启用 + toast「已安装」(不再自动跳设置)。
        await useApp.getState().onPluginInstalled()
      } else if (effType === 'space') {
        // 数据 Space:装完热注册,ribbon 顶部实时出现,无需重启。
        await loadUserSpaces()
        toast(t('market.spaceInstalled', { name: c.name }))
      } else if (effType === 'theme') {
        // 主题:装完热重载磁盘主题,设置 → 主题 里即时可选,无需重启。
        await useTheme.getState().reloadThemes()
        toast(t('market.themeInstalled', { name: c.name }))
      } else if (effType === 'amadeus-plugin') {
        // Forsion 插件:落全局目录(~/.forsion/plugins),重载外部插件即生效,免 vault。
        if (window.amadeus) {
          installAmadeusPlugins()
          const before = new Set(usePluginStore.getState().plugins.map((p) => p.id))
          await usePluginStore.getState().reloadExternal()
          const state = usePluginStore.getState()
          const freshAll = state.plugins.filter((p) => !before.has(p.id))
          // 捆绑包装后流程:内嵌引擎插件 → 引擎重扫+装即启用;内嵌 Space → 热注册(幂等,ribbon 实时出现)。
          // 重扫条件看「装后现存」而非「本次新增」:更新/重装同 id 时 freshAll 为空,但新版可能新增了
          // 内嵌引擎插件(codex P1-7);重扫幂等,已知 id 会被跳过。原地代码升级仍需重启,由重扫 toast 提示。
          if (state.plugins.some((p) => p.bundle?.enginePlugins?.length)) await useApp.getState().onPluginInstalled()
          await loadUserSpaces() // 内含「同 owner 配方变更 → 注销重注册」,更新的 Space 布局即时生效
          // 新装且带引导声明的插件:装完即弹就绪卡(用户注意力正在场;更新/重装不弹)。
          const fresh = freshAll.find((p) => state.activeIds.includes(p.id) && needsOnboarding(p))
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
    webapp: t('market.tab.webapps'),
    updates: t('market.tab.updates'),
    submit: t('market.tab.submit'),
  }

  // 网站应用卡片:在内置浏览器打开(关着/mini 窗自动退回系统浏览器),并收起市场回到工作台。
  const openWebApp = (w: WebApp): void => {
    if (!webApps) return
    openBrowser(webApps.base + w.url)
    close()
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
            scanning ? (
              <Skeleton variant="list" /> // 扫描未完不许闪「全部最新」假答案
            ) : updatable.length === 0 ? (
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
          ) : tab === 'webapp' ? (
            loading ? (
              <Skeleton variant="list" />
            ) : err ? (
              <div className="mk-state mk-error">{err}</div>
            ) : !webApps || webApps.items.length === 0 ? (
              <div className="mk-state mk-muted">{t('market.empty')}</div>
            ) : (
              <>
                <p className="mk-web-hint">{t('market.webHint')}</p>
                <div className="mk-grid">
                  {webApps.items.map((w) => (
                    <div key={`${w.handle}/${w.slug}`} className="mk-card" onClick={() => openWebApp(w)}>
                      <div className="mk-card-title">{w.name}</div>
                      <div className="mk-card-summary">{w.summary || ''}</div>
                      <div className="mk-card-foot">
                        <span className="mk-card-meta">{t('market.author')} {w.handle}</span>
                        <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); openWebApp(w) }}>
                          <Globe size={13} /> {t('market.webOpen')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {canOpenSettings(detail) && (
                    <button className="btn sm" onClick={() => openPluginSettings(detail)}>
                      <Settings size={13} /> {t('market.openSettings')}
                    </button>
                  )}
                  {installBtn(detail)}
                </div>
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
            <Skeleton variant={detailLoading ? 'document' : 'list'} />
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
