/**
 * Forsion 商店(原「应用市场」,2026-10-05 改名;标识符 / i18n key / CSS 类仍是 market / mk-*):
 * 发现首页 + 分类目录 + 安装管理 + 商品详情。
 * 浏览/安装全走主进程 IPC(marketService),token 不下发渲染层。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, ArrowLeft, ArrowRight, Bot, Check, Clock, Coins, Compass, Crown, Download, ExternalLink,
  GitBranch, Globe, LayoutGrid, Library, Loader2, Monitor, Package, PackageOpen, Palette, Puzzle,
  RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Trash2, Wrench, X,
} from 'lucide-react'
import { Skeleton, useNativeChromeClaim, useNativeChromeInstalled } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { formatDate as formatDateLabel } from '../format/time'
import { useApp } from '../stores/appStore'
import { Markdown } from './Markdown'
import { listMarket, getMarketDetail, installMarket, listInstalled, onInstallProgress, isDesktopOnlyItem, DESKTOP_ONLY_TAG, type InstalledItem } from '../services/marketService'
import { forgetUserSpace, loadUserSpaces } from '../userSpaces'
import { useTheme } from '../stores/themeStore'
import { unmetPluginDeps, usePluginStore } from '@amadeus/plugins/pluginStore'
import { announceExtensionsChanged, reloadPluginsAndAnnounce } from '../amadeusPlugins'
import { afterMarketInstall, canRestartBackend, restartBackend } from '../marketPostInstall'
import { isGate, promptIfPending } from '../stores/pluginOnboardingStore'
import { track } from '../achievements/store'
import { act } from '../activity/log'
import { openBrowser } from '../builtins'
import type { MarketCard, MarketDetail, MarketInstallProgress } from '../types'
import { PluginSettingsView } from './AmadeusPluginsTab'
import { isPlacedSettingsView } from '../amadeus/plugins/display'
import { MarketPluginAutoUpdate, useMarketPluginUpdates } from './MarketPluginAutoUpdate'
import { compareMarketVersions } from '../../../shared/marketPluginUpdates'

registerMessages({
  'market.submissionsDescription': { zh: '投稿内容，查看审核结果并管理版本更新。', en: 'Submit your work, view review results and manage version updates.' },
  'market.group.more': { zh: '更多', en: 'More' },
})

type MarketType = MarketCard['type']

/** 左栏里由插件提供的页(ctx.registerStoreView)的图标词表;认不出回落 Package(不把名字当文字画出来)。 */
const STORE_VIEW_ICONS: Record<string, typeof Package> = { crown: Crown, coins: Coins, package: Package, sparkles: Sparkles, globe: Globe, palette: Palette, wrench: Wrench, bot: Bot }
const storeViewIcon = (name?: string): typeof Package => (name && Object.hasOwn(STORE_VIEW_ICONS, name) ? STORE_VIEW_ICONS[name] : Package)
const resolveText = (v: string | (() => string) | undefined): string => { try { return (typeof v === 'function' ? v() : v) || '' } catch { return '' } }
type Tab = 'discover' | MarketType | 'webapp' | 'installed' | 'updates' | 'submit'
type SortMode = 'popular' | 'latest' | 'name'

const CONTENT_TABS: MarketType[] = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin']

registerMessages({
  // 宿主只声明了部分可装类型(Android App:只有 Forsion 插件)时,发现页顶上的一句说明
  'market.scopeHint': {
    zh: '这里只列出可以在本设备上安装的插件。技能、Agent、引擎插件、主题与 Space 请在 Forsion 桌面端安装。',
    en: 'Only plugins that can be installed on this device are listed here. Install skills, agents, engine plugins, themes and Spaces from Forsion for desktop.',
  },
})

/** 本宿主能装的类型(window.tangu.marketTypes;缺省 = 全部)。**在组件里求值**:模块求值时宿主桥可能还没装好。 */
function hostContentTypes(): MarketType[] {
  const declared = window.tangu?.marketTypes
  return Array.isArray(declared) ? CONTENT_TABS.filter((tp) => declared.includes(tp)) : CONTENT_TABS
}

/** 「插件」分类下一起列出的类型(2026-10-05):Agent / Space 不再各占一格导航,并进「插件」。
 *  ⚠️ 只是浏览层的归并 —— 服务端 type、安装目录映射、详情页的类型名都不变,所以 CONTENT_TABS
 *  (拉目录 / 判已装)与 navLabel(卡片与详情页上的类型字样)仍是全量,别跟着删。 */
const PLUGIN_TAB_TYPES: MarketType[] = ['plugin', 'amadeus-plugin', 'agent', 'space']

/** 左栏分类:PLUGIN_TAB_TYPES 都并在「插件」一栏里,本宿主其中任一可装就给「插件」;其余类型本宿主可装才列。 */
function categoryTabsFor(types: MarketType[]): Tab[] {
  return [
    ...CONTENT_TABS.filter((tp) => tp === 'plugin' ? PLUGIN_TAB_TYPES.some((x) => types.includes(x)) : !PLUGIN_TAB_TYPES.includes(tp) && types.includes(tp)),
    ...(window.tangu?.connectStore ? (['webapp'] as Tab[]) : []),
  ]
}

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
  return (compareMarketVersions(latest, installed) ?? 0) > 0
}

function timeValue(value?: string | null): number {
  if (!value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

/** 去掉 map 里的一个 id(按 id 记账的「安装中 / 进度」各自收尾,互不清掉别人的)。 */
function omit<T>(map: Record<string, T>, id: string): Record<string, T> {
  const next = { ...map }
  delete next[id]
  return next
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return formatDateLabel(date, { year: 'always' })
}

export function MarketModal({ onClose, initialQuery }: { onClose?: () => void; initialQuery?: string } = {}) {
  const { t } = useI18n()
  const pluginUpdates = useMarketPluginUpdates()
  const settingsViews = usePluginStore((s) => s.settingsViews)
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const submissionView = !window.tangu?.unitPage && window.tangu?.cloudInvoke
    ? settingsViews.find((o) => o.pluginId === 'forsion-extend' && o.item.id === 'submission' && activeIds.includes(o.pluginId) && isPlacedSettingsView(plugins.find((p) => p.id === o.pluginId), o.item))
    : undefined
  // 插件提供的页:只认已启用的首方内置包(locked),设备页不显示。按 group 分组,组与页都保持注册顺序。
  const allStoreViews = usePluginStore((s) => s.storeViews)
  const storeViews = useMemo(() => (window.tangu?.unitPage ? [] : allStoreViews.filter((o) => activeIds.includes(o.pluginId) && !!plugins.find((p) => p.id === o.pluginId)?.locked)), [allStoreViews, activeIds, plugins])
  const [storeViewKey, setStoreViewKey] = useState<string | null>(null)
  const storeViewKeyOf = (o: { pluginId: string; item: { id: string } }): string => `${o.pluginId}:${o.item.id}`
  // 页面所属的插件被停用 / 卸载 → 找不到了,自然退回 tab 指着的那页
  const storeView = storeViewKey ? storeViews.find((o) => storeViewKeyOf(o) === storeViewKey) ?? null : null
  const storeClose = useApp((s) => s.closeMarket)
  const close = onClose ?? storeClose
  // 市场住在独立浮窗(桌面)或全屏覆盖层(主窗)里:全局通知在浮窗不渲染、在主窗被 overlayOpen 挡住,
  // 所以安装/卸载的结果只能由市场自己说 —— 这条提示条就是那个出口(09-21 用户实报「点安装只转圈没反馈」)。
  // restart = 引擎只能重启后才生效的那几种(插件贡献了路由 / 原地更新 / 卸载):给按钮,别让用户自己去找「重启」。
  const [notice, setNotice] = useState<{ text: string; error: boolean; hint?: string; restart?: 'idle' | 'running' } | null>(null)
  // 普通提示不覆盖还挂着的错误(并发安装时,后完成的「已安装」会在几百毫秒内把前一个的失败原因顶掉)。
  const toast = useCallback((text: string, error = false, hint?: string) => setNotice((cur) => (cur?.error && !error ? cur : { text, error, hint })), [])
  useEffect(() => {
    if (!notice || notice.error || notice.restart) return // 错误与待点的重启常驻到手动关 / 下一条提示
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const offerRestart = (text: string): void => {
    // 与 toast 同一条规则:不顶掉并发安装还挂着的失败提示。
    if (canRestartBackend()) setNotice((cur) => (cur?.error ? cur : { text, error: false, hint: t('market.restartBackendHint'), restart: 'idle' }))
    else toast(text)
  }
  const onRestartBackend = async (): Promise<void> => {
    setNotice((cur) => cur && { ...cur, restart: 'running' }) // 按钮留着、置灰,直到有结果
    const ok = await restartBackend()
    // 成功直接替换(它就是这条提示要解决的事);失败保留按钮,让「请重试」真的能重试。
    setNotice(ok ? { text: t('market.backendRestarted'), error: false } : { text: t('market.backendRestartFailed'), error: true, restart: 'idle' })
  }
  const contentTypes = useMemo(hostContentTypes, [])
  const categoryTabs = useMemo(() => categoryTabsFor(contentTypes), [contentTypes])
  const scopeLimited = contentTypes.length < CONTENT_TABS.length
  const [tab, setTab] = useState<Tab>('discover')
  const [catalog, setCatalog] = useState<MarketCard[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [updatable, setUpdatable] = useState<MarketCard[]>([])
  const [detail, setDetail] = useState<MarketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // 按 id 记账:下载现在最长要等几十秒,先后点两个安装时,先完成的那个不能把另一个的「安装中」清掉(清掉 = 可以再点一次同一项、两路并发解压进同一目录)。
  const [installing, setInstalling] = useState<Record<string, true>>({})
  const [progress, setProgress] = useState<Record<string, MarketInstallProgress>>({})
  const [failed, setFailed] = useState<Record<string, true>>({})
  useEffect(() => onInstallProgress((p) => setProgress((m) => ({ ...m, [p.id]: p }))), [])
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [webApps, setWebApps] = useState<{ base: string; items: WebApp[] } | null>(null)
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [scanning, setScanning] = useState(true)
  const [query, setQuery] = useState(initialQuery ?? '')
  const [sort, setSort] = useState<SortMode>('popular')
  // Automatic checks run in main even while this window is closed. Refresh the local installed snapshot after activation/mutations.
  useEffect(() => { void listInstalled().then(setInstalled).catch(() => {}) }, [pluginUpdates])

  // 一次拉全目录:发现/分类/搜索/更新共用同一份快照,避免切 tab 重复请求和闪烁。
  const scanCatalog = useCallback(async () => {
    setScanning(true)
    setCatalogError('')
    const inst = await listInstalled().catch(() => ({} as Record<string, InstalledItem[]>))
    setInstalled(inst)
    const settled = await Promise.allSettled(contentTypes.map((tp) => listMarket(tp)))
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
  }, [t, contentTypes])

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
  const autoUpdate = (c: MarketCard) => (c.type === 'plugin' || c.type === 'amadeus-plugin') && isInstalled(c)
    ? <MarketPluginAutoUpdate id={c.id} item={pluginUpdates.items.find((x) => x.id === c.id)} disabled={!!installing[c.id] || uninstalling === c.id} onError={(text) => toast(text, true)} /> : null

  const canOpenSettings = (c: MarketCard): boolean => {
    const realType = installedInfo(c)?.realType
    if (realType === 'amadeus-plugin') return !!window.amadeus
    return realType === 'plugin'
  }

  const openPluginSettings = (c: MarketCard): void => {
    const info = installedInfo(c)
    if (!info || !canOpenSettings(c)) return
    close()
    // 直达那个插件自己的页,不停在插件页首屏。id = 装载 id(目录名可以与它不同;老宿主不给时按目录名)。
    // 落不到的(id 对不上 / 引擎插件没启用、没设置项)由设置页自己落回对应的列表。
    useApp.getState().openSettings(`${info.realType === 'amadeus-plugin' ? 'fplugin' : 'plugin'}:${info.entry.id ?? c.installSlug}`)
  }

  const onInstall = async (c: MarketCard): Promise<void> => {
    setInstalling((m) => ({ ...m, [c.id]: true }))
    setProgress((m) => omit(m, c.id))
    setFailed((m) => omit(m, c.id))
    setNotice(null) // 新一轮安装 = 用户已看过上一条(失败的那项按钮仍是「重试」)
    const wasInstalled = isInstalled(c)
    try {
      const res = await installMarket(c.id)
      const effectiveType = ((res?.type as MarketType) || c.type)
      track('market.install')
      act('market.install', { id: c.id })
      // 本窗热重载 + 通知主窗等其余窗口(市场是独立浮窗)+ 判断要不要重启后端,与插件引导卡共用。
      const { restart, fresh } = await afterMarketInstall(effectiveType, res, wasInstalled, toast)
      // 装完 = 注意力在场:逐个实测新插件(连 check),第一个确有未满足的才弹检查卡。
      const state = usePluginStore.getState()
      for (const p of fresh) if (state.activeIds.includes(p.id) && isGate(p) && await promptIfPending(p.id)) break
      if (restart) offerRestart(t('market.pluginInstalledRestartHint'))
      else if (effectiveType === 'space') toast(t('market.spaceInstalled', { name: c.name }))
      else if (effectiveType === 'theme') toast(t('market.themeInstalled', { name: c.name }))
      else if (effectiveType === 'amadeus-plugin') {
        // 装上了但前置没齐(装着、开不了):别报「已加载」,说清还缺什么 —— 插件详情页有「在市场中查找」
        const p = usePluginStore.getState().plugins.find((x) => x.id === res?.id)
        const plugins = usePluginStore.getState().plugins
        const missing = p ? unmetPluginDeps(p).map((u) => plugins.find((x) => x.id === u.dep.id)?.name || u.dep.name || u.dep.id) : []
        toast(missing.length ? t('market.amadeusPluginNeedsDeps', { name: c.name, list: missing.join(t('common.listSep')) }) : t('market.amadeusPluginInstalled', { name: c.name }))
      }
      else if (effectiveType !== 'plugin') toast(t('market.installOk', { name: c.name })) // 引擎插件的结果 onPluginInstalled 已经说过
      await scanCatalog()
    } catch (e: any) {
      setFailed((m) => ({ ...m, [c.id]: true }))
      toast(t('market.installFailNamed', { name: c.name, e: e?.message || String(e) }), true, c.source === 'github' && e?.stage !== 'resolve' ? t('market.installHintGithub') : undefined)
    } finally {
      setInstalling((m) => omit(m, c.id))
      setProgress((m) => omit(m, c.id))
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
      const removedItem = await window.tangu!.marketUninstall!(info.realType, c.installSlug)
      act('market.uninstall', { id: c.id })
      // 热重载与安装侧对称:装完刷新了什么,卸完就要刷新什么,否则界面上那一项还在(其余窗口同理靠广播)。
      // 引擎插件的工具/路由**无法运行期反注册**,删目录后仍要重启后端才真正消失(同设置页卸载口径)。
      let restart = info.realType === 'plugin'
      if (info.realType === 'space') {
        // loadUserSpaces 只增不撤用户 Space:按配方 id 走删除那条路(本窗撤 + 主窗 space-removed)。
        if (removedItem?.id) { forgetUserSpace(removedItem.id); window.tangu?.requestMainAction?.('space-removed', removedItem.id) }
        await loadUserSpaces(); announceExtensionsChanged('space')
      }
      else if (info.realType === 'theme') { await useTheme.getState().reloadThemes(); announceExtensionsChanged('theme') }
      else if (info.realType === 'amadeus-plugin') {
        if (window.amadeus) {
          const { removed } = await reloadPluginsAndAnnounce()
          restart = removed.some((p) => p.bundle?.enginePlugins?.length)
          await loadUserSpaces()
        }
      } else if (info.realType === 'skill' || info.realType === 'agent') {
        window.tangu?.requestMainAction?.(info.realType === 'skill' ? 'skills-changed' : 'agents-changed')
      }
      if (restart) offerRestart(t('market.uninstalledNeedsRestart', { name: c.name }))
      else toast(t('market.uninstalled', { name: c.name }))
      await scanCatalog()
    } catch (e: any) {
      toast(t('market.uninstallFail', { e: e?.message || String(e) }), true)
    } finally {
      setUninstalling(null)
    }
  }

  // Android 原生顶栏(lcl nativeChrome 的可选宿主)在场时由它画标题 + 返回(page 模式),与设置页同一口径:
  // 列表页「返回」= 退出市场;详情页「返回」= 回列表、「×」= 退出市场。Web 页头(返回钮 + 品牌)让位(data-native-chrome),
  // 分类药丸行留着。没装宿主(桌面、Web、手机浏览器)时声明为 null = 空操作。
  const nativeChrome = useNativeChromeInstalled()
  useNativeChromeClaim(!nativeChrome ? null : detail
    ? { mode: 'page', title: detail.name, back: t('market.detailBack'), onBack: () => setDetail(null), close: t('settings.backToApp'), onClose: close }
    : { mode: 'page', title: t('market.title'), back: t('settings.backToApp'), onBack: close })

  // Android 返回键(MobileRoot 先派发 forsion:mobile-back):详情页开着 → 先回列表,不关整个市场。
  useEffect(() => {
    if (!detail) return
    const onBack = (e: Event): void => { setDetail(null); e.preventDefault() }
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [detail])

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
    setStoreViewKey(null)
    setDetail(null)
    setQuery('')
  }

  /** 按钮上的进度:准备 → 连接(第 n/m 个地址)→ 百分比或已收字节(多数 github 响应不给长度)→ 解压。 */
  const busyLabel = (p: MarketInstallProgress | undefined): string => {
    if (!p || p.phase === 'resolve') return t('market.phase.resolve')
    if (p.phase === 'install') return t('market.installing')
    if (p.received) return p.total ? t('market.phase.percent', { n: Math.min(99, Math.floor((p.received / p.total) * 100)) }) : t('market.phase.bytes', { size: formatBytes(p.received) })
    return (p.attempts ?? 1) > 1 ? t('market.phase.connectN', { n: p.attempt ?? 1, m: p.attempts ?? 1 }) : t('market.phase.connect')
  }

  // 「仅桌面」的包(商店的保留标签):桌面端只多一枚标记;手机上按钮直接说装不了,不让人下载完再看报错。
  const desktopOnlyHere = (c: MarketCard): boolean => isDesktopOnlyItem(c) && !!window.tangu?.mobile
  const desktopBadge = (c: MarketCard) => isDesktopOnlyItem(c)
    ? <span className="mk-desktop-badge" data-market-desktop-only={c.id} title={t('market.desktopOnlyHint')}><Monitor size={11} />{t('market.desktopOnly')}</span> : null
  /** 给人看的标签:保留标签已经画成标记了,不再当普通标签重复一遍。 */
  const shownTags = (c: MarketCard): string[] => (c.tags || []).filter((tag) => tag !== DESKTOP_ONLY_TAG)

  const installBtn = (c: MarketCard, extraClass = '') => {
    if (desktopOnlyHere(c)) {
      return <button className={`btn sm ${extraClass}`.trim()} disabled data-market-install={c.id} data-install-state="desktop-only" title={t('market.desktopOnlyHint')}><Monitor size={13} />{t('market.desktopOnlyInstall')}</button>
    }
    const state = pluginUpdates.items.find((x) => x.id === c.id)
    const busy = !!installing[c.id] || state?.phase === 'downloading'
    const pending = !!state?.pendingVersion
    const done = isInstalled(c)
    const update = hasUpdate(c)
    const inst = installedEntry(c)
    const retry = !busy && !!failed[c.id]
    const p = busy ? progress[c.id] : undefined
    return (
      <button
        className={`btn sm ${update || !done ? 'primary' : ''} ${extraClass}`.trim()}
        disabled={busy}
        data-market-install={c.id}
        data-install-state={busy ? (state?.phase === 'downloading' ? 'download' : p?.phase || 'resolve') : retry ? 'failed' : undefined}
        title={p?.host || (update ? t('market.updateTitle', { from: inst?.version || '?', to: c.latestVersion || '?' }) : undefined)}
        onClick={(e) => { e.stopPropagation(); if (pending) void window.tangu?.restartForUpdate?.().catch((error) => toast(String(error?.message || error), true)); else void onInstall(c) }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : retry || update ? <RefreshCw size={13} /> : done ? <Check size={13} /> : <Download size={13} />}
        {pending ? t('restartUpdate.button') : busy ? state?.phase === 'downloading' ? t('market.autoUpdateDownloading') : busyLabel(p) : retry ? t('market.installRetry') : update ? t('market.update') : done ? t('market.reinstall') : t('market.install')}
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
        disabled={busy || !!installing[c.id]}
        data-market-uninstall={c.id}
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
    return [c.name, c.summary, c.author, c.installSlug, ...(c.tags || [])]
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
            ? PLUGIN_TAB_TYPES.includes(c.type)
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
          {desktopBadge(c)}
        </div>
        <button className="mk-card-title" onClick={(e) => { e.stopPropagation(); openDetail(c) }}>{c.name}</button>
        <div className="mk-card-summary">{c.summary || t('market.summaryFallback')}</div>
        {!!shownTags(c).length && <div className="mk-tags">{shownTags(c).slice(0, compact ? 2 : 3).map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <div className="mk-card-foot">
          <span className="mk-card-meta">{c.author}<span aria-hidden="true"> · </span>{t('market.downloadsShort', { n: c.downloads })}</span>
          {installBtn(c)}
          {uninstallBtn(c)}
        </div>
        {autoUpdate(c)}
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

  const showSearch = !detail && !storeView && tab !== 'submit'
  const showSort = !detail && !storeView && tab !== 'submit' && tab !== 'webapp'
  /** 左栏高亮:开着插件页时内置入口都不亮。 */
  const navTab: Tab | null = storeView ? null : tab
  const openStoreView = (key: string): void => { setStoreViewKey(key); setDetail(null); setQuery('') }
  const storeGroups: Array<{ label: string; views: typeof storeViews }> = []
  for (const o of storeViews) {
    const label = resolveText(o.item.group) || t('market.group.more')
    const g = storeGroups.find((x) => x.label === label)
    if (g) g.views.push(o); else storeGroups.push({ label, views: [o] })
  }

  return (
    <div className="settings-page mk-page" data-native-chrome={nativeChrome ? '' : undefined}>
      <aside className="settings-nav" aria-label={t('market.title')}>
        <div className="settings-nav-top">
          <button className="settings-back" onClick={close}><ArrowLeft size={15} /> {t('settings.backToApp')}</button>
          <div className="mk-nav-brand"><div className="mk-nav-mark"><Sparkles size={17} /></div><div><strong>{t('market.title')}</strong><span>{t('market.navSubtitle')}</span></div></div>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group"><div className="settings-nav-grouphead">{t('market.group.discover')}</div><button className={navTab === 'discover' ? 'active' : ''} onClick={() => switchTab('discover')}><Compass size={15} />{navLabel.discover}</button></div>
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.categories')}</div>
            {categoryTabs.map((id) => <button key={id} className={navTab === id ? 'active' : ''} onClick={() => switchTab(id)}><TypeGlyph type={id as MarketType | 'webapp'} size={15} />{navLabel[id]}</button>)}
          </div>
          {storeGroups.map((g) => (
            <div key={g.label} className="settings-nav-group" data-store-group>
              <div className="settings-nav-grouphead">{g.label}</div>
              {g.views.map((o) => { const Icon = storeViewIcon(o.item.icon); const key = storeViewKeyOf(o); return <button key={key} data-store-view={key} className={storeView && storeViewKeyOf(storeView) === key ? 'active' : ''} onClick={() => openStoreView(key)}><Icon size={15} />{resolveText(o.item.title)}</button> })}
            </div>
          ))}
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.manage')}</div>
            <button className={navTab === 'installed' ? 'active' : ''} onClick={() => switchTab('installed')}><Library size={15} />{navLabel.installed}</button>
            <button className={navTab === 'updates' ? 'active' : ''} onClick={() => switchTab('updates')}><RefreshCw size={15} />{navLabel.updates}{updatable.length > 0 && <span className="mk-nav-count">{updatable.length}</span>}</button>
            {/* Extend 的投稿页同时挂在市场与云端设置中;旧包仍可打开网页个人中心。 */}
            {(!!submissionView || !!window.tangu?.openAccountCenter) && <button className={navTab === 'submit' ? 'active' : ''} onClick={() => switchTab('submit')}><Send size={15} />{navLabel.submit}</button>}
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head mk-main-head">
          <div className="mk-title-block"><div className="settings-main-title">{detail ? detail.name : storeView ? resolveText(storeView.item.title) : navLabel[tab]}</div><div className="mk-title-subtitle">{detail ? t('market.detailSubtitle') : storeView ? resolveText(storeView.item.description) : tab === 'discover' ? t('market.subtitle') : tab === 'submit' ? t('market.submissionsDescription') : tab === 'plugin' ? t('market.pluginsSubtitle') : t('market.sectionSubtitle', { section: navLabel[tab] })}</div></div>
          {showSearch && <label className="mk-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('market.searchPlaceholder')} />{query && <button onClick={() => setQuery('')} aria-label={t('market.clearSearch')}>×</button>}</label>}
          {showSort && <label className="mk-sort"><span>{t('market.sort.label')}</span><select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}><option value="popular">{t('market.sort.popular')}</option><option value="latest">{t('market.sort.latest')}</option><option value="name">{t('market.sort.name')}</option></select></label>}
        </div>

        {notice && (
          <div className={`mk-notice${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'} data-market-notice={notice.error ? 'error' : 'ok'}>
            {notice.error ? <AlertCircle size={15} /> : <Check size={15} />}
            <div className="mk-notice-body"><span>{notice.text}</span>{notice.hint && <small>{notice.hint}</small>}</div>
            {notice.restart && <button className="btn sm primary" data-market-restart disabled={notice.restart === 'running'} onClick={() => void onRestartBackend()}>{notice.restart === 'running' ? t('market.backendRestarting') : t('market.restartBackend')}</button>}
            <button className="mk-notice-close" onClick={() => setNotice(null)} aria-label={t('common.close')}><X size={13} /></button>
          </div>
        )}

        <div className="settings-body mk-body">
          {detail ? (
            <div className="mk-detail">
              <button className="settings-back mk-detail-back" onClick={() => setDetail(null)}><ArrowLeft size={14} />{t('market.detailBack')}</button>
              <div className="mk-detail-hero"><div className="mk-detail-icon"><ItemIcon url={detail.iconUrl} type={detail.type} size={36} /></div><div className="mk-detail-intro"><span className="mk-detail-kind">{navLabel[detail.type]}</span><h2>{detail.name}</h2><p>{detail.summary || t('market.summaryFallback')}</p><div className="mk-detail-byline">{t('market.author')} {detail.author}<span aria-hidden="true"> · </span>{t('market.downloads', { n: detail.downloads })}</div></div></div>
              <div className="mk-detail-layout">
                <main className="mk-detail-main"><div className="mk-detail-section-title">{t('market.overview')}</div>{!!shownTags(detail).length && <div className="mk-tags">{shownTags(detail).map((tag) => <span key={tag}>{tag}</span>)}</div>}<div className="mk-readme">{detail.readme ? <Markdown content={detail.readme} /> : <span className="mk-muted">{t('market.readmeEmpty')}</span>}</div></main>
                <aside className="mk-detail-sidebar">
                  <div className="mk-detail-actions">{installBtn(detail, 'mk-wide-btn')}{uninstallBtn(detail)}{canOpenSettings(detail) && <button className="btn sm mk-wide-btn" onClick={() => openPluginSettings(detail)}><Settings size={13} />{t('market.openSettings')}</button>}{autoUpdate(detail)}</div>
                  <div className="mk-trust-row"><ShieldCheck size={17} /><div><strong>{t('market.reviewed')}</strong><span>{t('market.reviewedHint')}</span></div></div>
                  <dl className="mk-facts"><div><dt>{t('market.type')}</dt><dd>{navLabel[detail.type]}</dd></div><div><dt>{t('market.version')}</dt><dd>{detail.latestVersion ? `v${detail.latestVersion}` : t('market.unknown')}</dd></div>{isDesktopOnlyItem(detail) && <div><dt>{t('market.platform')}</dt><dd>{t('market.desktopOnly')}</dd></div>}<div><dt>{t('market.source')}</dt><dd>{detail.source === 'github' ? 'GitHub' : detail.source === 'npm' ? 'npm' : t('market.sourceUpload')}</dd></div>{!!formatDate(detail.updatedAt || detail.createdAt) && <div><dt>{t('market.updated')}</dt><dd>{formatDate(detail.updatedAt || detail.createdAt)}</dd></div>}</dl>
                  {detail.npmPackage && <a className="mk-repo-link" href={`https://www.npmjs.com/package/${encodeURIComponent(detail.npmPackage)}`} target="_blank" rel="noreferrer"><Package size={14} />{detail.npmPackage}<ExternalLink size={12} /></a>}
                  {detail.githubRepoUrl && <a className="mk-repo-link" href={detail.githubRepoUrl} target="_blank" rel="noreferrer"><GitBranch size={14} />{t('market.openRepo')}<ExternalLink size={12} /></a>}
                </aside>
              </div>
            </div>
          ) : detailLoading ? <Skeleton variant="document" />
            : storeView ? <PluginSettingsView key={storeViewKeyOf(storeView)} pluginId={storeView.pluginId} def={storeView.item} bare />
            : tab === 'discover' ? (
              scanning ? <Skeleton variant="document" /> : catalogError && catalog.length === 0 ? catalogState([]) : query ? (
                <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.searchResults')}</h2><p>{t('market.resultCount', { n: visibleCatalog.length })}</p></div></div>{catalogState(visibleCatalog)}</section>
              ) : catalog.length === 0 ? catalogState([]) : (
                <div className="mk-discover">
                  {scopeLimited && <p className="mk-web-hint" data-market-scope-hint>{t('market.scopeHint')}</p>}
                  {featured && <section className="mk-featured" onClick={() => openDetail(featured)}><div className="mk-featured-copy"><span className="mk-featured-label"><Sparkles size={13} />{t('market.featured')}</span><h2>{featured.name}</h2><p>{featured.summary || t('market.summaryFallback')}</p><div className="mk-featured-meta">{navLabel[featured.type]}<span aria-hidden="true"> · </span>{featured.author}<span aria-hidden="true"> · </span>{t('market.downloadsShort', { n: featured.downloads })}</div><div className="mk-featured-actions"><button className="btn sm" onClick={(e) => { e.stopPropagation(); openDetail(featured) }}>{t('market.viewDetails')}<ArrowRight size={13} /></button>{installBtn(featured)}</div></div><div className="mk-featured-art" aria-hidden="true"><ItemIcon url={featured.iconUrl} type={featured.type} size={58} /><span>{navLabel[featured.type]}</span></div></section>}
                  {recent.length > 0 && <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.recent')}</h2><p>{t('market.recentHint')}</p></div><Clock size={18} /></div><div className="mk-recent-grid">{recent.map((item) => card(item, true))}</div></section>}
                  {popular.length > 0 && <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.popular')}</h2><p>{t('market.popularHint')}</p></div><Package size={18} /></div><div className="mk-grid">{popular.map((item) => card(item))}</div></section>}
                </div>
              )
            ) : tab === 'webapp' ? (
              webLoading ? <Skeleton variant="list" /> : webError ? <div className="mk-state-card"><PackageOpen size={28} /><strong>{webError}</strong><button className="btn sm" onClick={() => { setWebApps(null); setWebError('') }}>{t('market.retry')}</button></div> : visibleWebApps.length === 0 ? <div className="mk-state-card"><Globe size={28} /><strong>{query ? t('market.noResults') : t('market.empty')}</strong><span>{query ? t('market.noResultsHint') : t('market.webHint')}</span></div> : (
                <div className="mk-webapps"><p className="mk-web-hint">{t('market.webHint')}</p><div className="mk-grid">{visibleWebApps.map((item) => <article key={`${item.handle}/${item.slug}`} className="mk-card" onClick={() => openWebApp(item)}><div className="mk-card-visual"><Globe size={24} /></div><div className="mk-card-content"><div className="mk-card-eyeline"><span>{navLabel.webapp}</span></div><button className="mk-card-title" onClick={(e) => { e.stopPropagation(); openWebApp(item) }}>{item.name}</button><div className="mk-card-summary">{item.summary || t('market.summaryFallback')}</div><div className="mk-card-foot"><span className="mk-card-meta">{item.handle}</span><button className="btn sm primary" onClick={(e) => { e.stopPropagation(); openWebApp(item) }}><Globe size={13} />{t('market.webOpen')}</button></div></div></article>)}</div></div>
              )
            ) : tab === 'submit' ? (submissionView
              ? <PluginSettingsView pluginId={submissionView.pluginId} def={submissionView.item} bare />
              : <section className="mk-submit"><div className="mk-submit-copy"><span>{t('market.submitKicker')}</span><h2>{t('market.submitTitle')}</h2><p>{t('market.submitHint')}</p><button className="btn primary" onClick={() => void window.tangu?.openAccountCenter?.('submission')}><ExternalLink size={15} />{t('market.submitOpen')}</button></div><div className="mk-submit-art"><PackageOpen size={44} /><strong>{t('market.submitArtTitle')}</strong><span>{t('market.submitArtHint')}</span></div></section>
            ) : (
              <section className="mk-section"><div className="mk-section-head"><div><h2>{navLabel[tab]}</h2><p>{t('market.resultCount', { n: visibleCatalog.length })}</p></div>{tab === 'updates' && window.tangu?.marketCheckUpdates ? <button className="btn sm" disabled={pluginUpdates.checking} onClick={() => void window.tangu!.marketCheckUpdates!().then(scanCatalog).catch((error) => toast(String(error?.message || error), true))}><RefreshCw size={14} />{t('market.autoUpdateCheck')}</button> : tab === 'updates' ? <RefreshCw size={18} /> : tab === 'installed' ? <Library size={18} /> : <TypeGlyph type={tab as MarketType} size={18} />}</div>{tab === 'updates' && !scanning && updatable.length === 0 && !query ? <div className="mk-state-card"><Check size={28} /><strong>{t('market.allUpToDate')}</strong><span>{t('market.allUpToDateHint')}</span></div> : catalogState(visibleCatalog)}</section>
            )}
        </div>
      </section>
    </div>
  )
}
