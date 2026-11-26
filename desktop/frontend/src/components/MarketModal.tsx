import { capabilityLabels } from './pluginCapabilityLabels'
import { marketplaceCompatibility } from '../../../shared/marketplace'
import { MarketRequirements, marketPlatform, requirementsText, useMarketVersion } from './MarketRequirements'
import { MarketDiscussion, MarketVersions } from './MarketDiscussion'
import './MarketUpgrade.css'
/**
 * Forsion 商店(原「应用市场」,2026-10-05 改名;标识符 / i18n key / CSS 类仍是 market / mk-*):
 * 发现首页 + 分类目录 + 安装管理 + 商品详情。
 * 浏览/安装全走主进程 IPC(marketService),token 不下发渲染层。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle, ArrowLeft, ArrowRight, Bot, Check, Clock, Coins, Compass, Crown, Download, ExternalLink,
  GitBranch, Globe, KeyRound, LayoutGrid, Library, Loader2, Monitor, Package, PackageOpen, Palette, Puzzle,
  RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Trash2, Wrench, X, ChevronDown, Plug,
} from 'lucide-react'
import { Skeleton, useNativeChromeClaim, useNativeChromeInstalled } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { formatDate as formatDateLabel } from '../format/time'
import { useApp } from '../stores/appStore'
import { Markdown } from './Markdown'
import { listMarket, getMarketDetail, installMarket, listInstalled, onInstallProgress, isDesktopOnlyItem, isReservedMarketTag, itemEntitlement, type InstalledItem } from '../services/marketService'
import { forgetUserSpace, loadUserSpaces } from '../userSpaces'
import { useTheme } from '../stores/themeStore'
import { pluginVaultFolder, pluginWanted, runningDependents, unmetPluginDeps, usePluginStore } from '@amadeus/plugins/pluginStore'
import { dependentsOf, unmetClosure } from '@amadeus/plugins/pluginDeps'
import { pluginDataSyncOn } from '@amadeus/plugins/pluginDataSync'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { AgentUninstallDialog, PluginUninstallDialog, SkillUninstallDialog } from './UninstallDialog'
import { uninstallEnginePlugin, uninstallForsionPlugin } from './pluginUninstall'
import { PanelNotice } from './PanelNotice'
import { listPlugins, listSkillCatalog } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { announceExtensionsChanged, installAmadeusPlugins, reloadPluginsAndAnnounce } from '../amadeusPlugins'
import { afterMarketInstall, canRestartBackend, restartBackend } from '../marketPostInstall'
import { reportDepsChain, trackMarketInstall } from '../telemetryInstall'
import { sendTelemetry } from '../telemetrySend'
import { isGate, promptIfPending } from '../stores/pluginOnboardingStore'
import { track } from '../achievements/store'
import { act } from '../activity/log'
import { openBrowser } from '../builtins'
import type { MarketCard, MarketDetail, MarketInstallProgress } from '../types'
import { PluginSettingsView, RequiredPlugins, type RequiredPluginsStore } from './AmadeusPluginsTab'
import { isPlacedSettingsView, pluginDisplayName } from '../amadeus/plugins/display'
import { installableDeps, planDeps, type DepPlan } from '../marketDeps'
import { AutoUpdateAllRow, PinnedChip, PluginVersionBlock, useMarketPluginUpdates } from './MarketPluginAutoUpdate'
import { ipcErrorText } from '../ipcError'
import { compareMarketVersions } from '../../../shared/marketPluginUpdates'
import { ConnectorStore } from './Connectors'
import { connectorsSupported } from '../services/connectorService'
import { SkillAgentPicker, applySkillAgentChoice, skillAgentsSupported, useSkillAgents, type SkillAgentChoice } from './MarketSkillAgents'
import { CODE_TYPES, needsSignIn, SourceConfirm, SourceInfoRow, SourceNavGroup, SourceState, SourceTrustRow, sourceErrorText, useStoreSources } from './MarketSources'
import { isSourceCardId, type StoreSourceCatalog } from '../../../shared/storeSources'
import { ackOf, compactCount, confirmNeededOf, confirmOf, installPlan, isBuiltinCard, publisherOf, upstreamGone, type InstallStep } from '../services/marketCollected'
import { splitFrontmatter } from '../services/fileKinds' // 收录技能的正文就是 SKILL.md:frontmatter 不当正文画
import { AdaptationTab, CollectedFacts, CollectedNeeds, CollectedTrustRow, CountChip, PublisherChip, requirementText, ScriptsConfirmText, SkillsShLink } from './MarketLabels'
import { sanitizeNetworkPatterns } from '../../../shared/pluginNetwork'

registerMessages({
  // 插件声明的 ctx.net 域名(manifest network,2026-11-16+):装好的按本机 manifest 列,目录里带了的也列
  'market.network': { zh: '会访问', en: 'Accesses' },
  'market.capabilities': { zh: '可以', en: 'Can' },
  'market.submissionsDescription': { zh: '投稿内容，查看审核结果并管理版本更新。', en: 'Submit your work, view review results and manage version updates.' },
  'market.group.more': { zh: '更多', en: 'More' },
  // 卡片与详情页上的类型字样:一张卡是一个东西，英文用单数(左栏分类仍是复数的 market.tab.*)
  'market.tagLabel': { zh: '标签', en: 'Tags' },
  'market.tagAllShort': { zh: '全部', en: 'All' },
  // 一键补前置:装好的插件在等前置时,提示条与详情页右栏给的那一步
  'market.deps.install': { zh: '安装前置插件', en: 'Install required plugin' },
  'market.deps.installN': { zh: '安装前置插件（{n}）', en: 'Install required plugins ({n})' },
  'market.deps.update': { zh: '更新前置插件', en: 'Update required plugins' },
  'market.deps.installing': { zh: '正在安装 {name}（{n}/{total}）', en: 'Installing {name} ({n} of {total})' },
  'market.deps.willRun': { zh: '装好后「{name}」会自动开始运行。', en: '"{name}" starts on its own once these are installed.' },
  'market.deps.ready': { zh: '前置插件已装好，「{name}」已开始运行。', en: 'Required plugins are installed and "{name}" is running.' },
  'market.deps.notReady': { zh: '「{name}」还不能运行，还差：{list}', en: '"{name}" still can\'t run. It needs: {list}' },
  'market.deps.notRunning': { zh: '前置插件已装好，但「{name}」还没有运行，可以在插件设置里查看原因。', en: 'Required plugins are installed, but "{name}" isn\'t running. Check its plugin settings for the reason.' },
  'market.deps.installableHint': { zh: '{list} 可以从商店直接安装。', en: '{list} can be installed from the store.' },
  'market.deps.absentHint': { zh: '{list} 商店里没有，需要向插件作者确认安装方式。', en: '{list} isn\'t in the store. Ask the plugin\'s author how to install it.' },
  'market.deps.inStore': { zh: '商店有 {version}', en: '{version} in the store' },
  'market.deps.inStoreAny': { zh: '商店里有', en: 'In the store' },
  'market.deps.absent': { zh: '商店里没有', en: 'Not in the store' },
  'market.deps.tooLow': { zh: '商店里最高 {version}，版本还不够', en: 'The store only has {version}' },
  'market.deps.incompatible': { zh: '商店里的版本不能装在这里', en: 'The store version can\'t be installed here' },
  'market.deps.mismatch': { zh: '商店里的条目不是它要的插件', en: 'The store listing isn\'t the plugin it needs' },
  'market.deps.queued': { zh: '等待安装', en: 'Waiting to install' },
  // 技能分类「全部」按来源分区(2026-11-23 方案 B):Forsion 在前,内置的 skills.sh,再是用户加的来源
  'market.section.forsionDesc': { zh: '官方与开发者投稿 · 经上架审核 · {n} 项', en: 'Official and developer submissions · Reviewed for listing · {n} items' },
  'market.section.builtinDesc': { zh: 'Forsion 从 skills.sh 收录 · 已核对能装 · {n} 项', en: 'Collected by Forsion from skills.sh · Checked to install · {n} items' },
  'market.section.sourceDesc': { zh: '第三方来源 · 未经审核 · {n} 项', en: 'Third-party source · Unreviewed · {n} items' },
  'market.section.more': { zh: '查看全部 {n} 项', en: 'View all {n}' },
  'market.section.builtinDescPlain': { zh: 'Forsion 从 skills.sh 收录', en: 'Collected by Forsion from skills.sh' },
  'market.section.builtinUnavailable': { zh: 'skills.sh 的收录暂时读不到，稍后再试。', en: 'Couldn\'t load the skills.sh collection. Try again later.' },
  'market.section.filterLabel': { zh: '按来源', en: 'By source' },
})

type MarketType = MarketCard['type']

/** 左栏里由插件提供的页(ctx.registerStoreView)的图标词表;认不出回落 Package(不把名字当文字画出来)。 */
const STORE_VIEW_ICONS: Record<string, typeof Package> = { crown: Crown, coins: Coins, package: Package, sparkles: Sparkles, globe: Globe, palette: Palette, wrench: Wrench, bot: Bot }
const storeViewIcon = (name?: string): typeof Package => (name && Object.hasOwn(STORE_VIEW_ICONS, name) ? STORE_VIEW_ICONS[name] : Package)
const resolveText = (v: string | (() => string) | undefined): string => { try { return (typeof v === 'function' ? v() : v) || '' } catch { return '' } }
type Tab = 'discover' | MarketType | 'webapp' | 'connector' | 'installed' | 'updates' | 'submit'
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
    // 连接器只在桌面(本机引擎)上能连:宿主给了 connectorsList 才有这一栏(照「网页」那条的先例)
    ...(connectorsSupported() ? (['connector'] as Tab[]) : []),
  ]
}

/** url 是后端那一侧的相对路径(老客户端拼 base);publicUrl 是 server 给的规范地址(forsion.app 上线后是 forsion.app/<地址>/<作品>/),老 server 没有、没配时是相对路径 */
interface WebApp { name: string; summary: string; handle: string; slug: string; url: string; publicUrl?: string; updatedAt?: string }

function TypeGlyph({ type, size = 20 }: { type: MarketType | 'webapp' | 'connector'; size?: number }) {
  const Icon = type === 'connector' ? Plug : type === 'skill' ? Wrench
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

export function MarketModal({ onClose, initialQuery, initialItemId, initialDetailTab, initialTab, initialStoreView }: { onClose?: () => void; initialQuery?: string; initialItemId?: string; initialDetailTab?: string; initialTab?: string; initialStoreView?: string } = {}) {
  const { t, locale } = useI18n()
  const pluginUpdates = useMarketPluginUpdates()
  const settingsViews = usePluginStore((s) => s.settingsViews)
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const disabledIds = usePluginStore((s) => s.disabledIds)
  // 账号类的页(投稿 / 会员 / 积分)属于本页登录的那个人:桌面与服务器 Unit 的网页主入口给,看别的设备的设备页不给。
  const ownAccount = !window.tangu?.unitPage || !!window.tangu?.unitPublicEntry
  // 网页主入口上 Extend 的通道在它自己的页内适配层里,不经 window.tangu.cloudInvoke。
  const submissionView = ownAccount && (window.tangu?.unitPublicEntry || (window.tangu?.mobile && window.tangu?.extendMobile && window.tangu?.account) || window.tangu?.cloudInvoke)
    ? settingsViews.find((o) => o.pluginId === 'forsion-extend' && o.item.id === 'submission' && activeIds.includes(o.pluginId) && isPlacedSettingsView(plugins.find((p) => p.id === o.pluginId), o.item))
    : undefined
  // 插件提供的页:只认已启用的首方内置包(locked),设备页不显示。按 group 分组,组与页都保持注册顺序。
  const allStoreViews = usePluginStore((s) => s.storeViews)
  const storeViews = useMemo(() => (!ownAccount ? [] : allStoreViews.filter((o) => activeIds.includes(o.pluginId) && !!plugins.find((p) => p.id === o.pluginId)?.locked)), [ownAccount, allStoreViews, activeIds, plugins])
  // initialStoreView = `<pluginId>:<viewId>`(如 Forsion Extend 的「买额度包」落到物品页);只认下面那份首方内置包的页,认不出就是商店首页
  const [storeViewKey, setStoreViewKey] = useState<string | null>(initialStoreView && /^[a-z0-9-]+:[a-z0-9-]+$/i.test(initialStoreView) ? initialStoreView : null)
  const storeViewKeyOf = (o: { pluginId: string; item: { id: string } }): string => `${o.pluginId}:${o.item.id}`
  // 页面所属的插件被停用 / 卸载 → 找不到了,自然退回 tab 指着的那页
  const storeView = storeViewKey ? storeViews.find((o) => storeViewKeyOf(o) === storeViewKey) ?? null : null
  const storeClose = useApp((s) => s.closeMarket)
  const close = onClose ?? storeClose
  // 市场住在独立浮窗(桌面)或全屏覆盖层(主窗)里:全局通知在浮窗不渲染、在主窗被 overlayOpen 挡住,
  // 所以安装/卸载的结果只能由市场自己说 —— 这条提示条就是那个出口(09-21 用户实报「点安装只转圈没反馈」)。
  // restart = 引擎只能重启后才生效的那几种(插件贡献了路由 / 原地更新 / 卸载):给按钮,别让用户自己去找「重启」。
  // deps = 这条提示挂着哪个插件的一键补前置按钮。
  const [notice, setNotice] = useState<{ text: string; error: boolean; hint?: string; restart?: 'idle' | 'running'; deps?: string } | null>(null)
  // 普通提示不覆盖还挂着的错误(并发安装时,后完成的「已安装」会在几百毫秒内把前一个的失败原因顶掉)。
  const toast = useCallback((text: string, error = false, hint?: string) => setNotice((cur) => (cur?.error && !error ? cur : { text, error, hint })), [])
  useEffect(() => {
    if (!notice || notice.error || notice.restart || notice.deps) return // 错误与待点的按钮常驻到手动关 / 下一条提示
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
  // 本宿主一类都装不了(网页版):没有目录可逛,商店只剩插件提供的页和投稿。
  const storeOnly = contentTypes.length === 0
  const [tab, setTab] = useState<Tab>(initialTab === 'connector' && connectorsSupported() ? 'connector' : 'discover')
  // 只剩插件页时落在第一张上(Extend 的页晚于商店挂载才注册,所以跟着 storeViews 再判);一张都没有、有投稿就落投稿。
  const firstStoreView = storeOnly && tab === 'discover' && !storeViewKey ? storeViews[0] : undefined
  useEffect(() => {
    if (firstStoreView) setStoreViewKey(storeViewKeyOf(firstStoreView))
    else if (storeOnly && tab === 'discover' && !storeViewKey && submissionView) setTab('submit')
  }, [firstStoreView, storeOnly, tab, storeViewKey, submissionView])
  const [catalog, setCatalog] = useState<MarketCard[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [updatable, setUpdatable] = useState<MarketCard[]>([])
  const [detail, setDetail] = useState<MarketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const appVersion = useMarketVersion()
  const [detailTab, setDetailTab] = useState(initialDetailTab === 'comments' ? 'comments' : 'overview')
  const [tagFilter, setTagFilter] = useState('')
  const [compatibleOnly, setCompatibleOnly] = useState(false)
  useEffect(() => { if (!initialItemId) return; let alive = true; setDetailLoading(true); void getMarketDetail(initialItemId).then(item => { if (alive) setDetail(item) }).catch(e => { if (alive) toast(e.message, true) }).finally(() => { if (alive) setDetailLoading(false) }); return () => { alive = false } }, [initialItemId, toast])
  // 按 id 记账:下载现在最长要等几十秒,先后点两个安装时,先完成的那个不能把另一个的「安装中」清掉(清掉 = 可以再点一次同一项、两路并发解压进同一目录)。
  const [installing, setInstalling] = useState<Record<string, true>>({})
  const [progress, setProgress] = useState<Record<string, MarketInstallProgress>>({})
  const [failed, setFailed] = useState<Record<string, true>>({})
  useEffect(() => onInstallProgress((p) => setProgress((m) => ({ ...m, [p.id]: p }))), [])
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  // 一键补前置在跑:哪个插件的、正在装哪一项、第几个。
  const [depsRun, setDepsRun] = useState<{ pluginId: string; card: MarketCard; n: number; total: number } | null>(null)
  // 商店在独立浮窗:没进过设置页时这个窗口的插件 store 可能还是空的,详情页的前置块靠它
  useEffect(() => { if (window.amadeus) installAmadeusPlugins() }, [])
  const [webApps, setWebApps] = useState<{ base: string; items: WebApp[] } | null>(null)
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [scanning, setScanning] = useState(true)
  const [query, setQuery] = useState(initialQuery ?? '')
  const [sort, setSort] = useState<SortMode>('popular')
  // 商店来源(第三方目录,左栏「来源」分组):选中哪个、它的目录、哪一项在等首装确认。
  const sources = useStoreSources()
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const [sourceCat, setSourceCat] = useState<StoreSourceCatalog | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [trusting, setTrusting] = useState(false)
  // 主进程按包实数出来、目录没说的脚本 / 审计警告:按「要装的那一项 → 其中哪一步」记,确认块据此再问一次
  const [confirmFound, setConfirmFound] = useState<Record<string, Record<string, { scripts: number; audit: boolean }>>>({})
  // 收录技能连同前置一起装:正在装哪一个前置
  const [prereqRun, setPrereqRun] = useState<{ parent: string; name: string; n: number; total: number } | null>(null)
  // 所有开着的来源的目录(技能分类的分区、搜索、可更新、已安装的标签都读它);来源页自己那份仍是 sourceCat
  const [srcCats, setSrcCats] = useState<Record<string, StoreSourceCatalog>>({})
  const [srcCatsLoading, setSrcCatsLoading] = useState(false)
  // 技能分类顶上的来源筛选:all = 分区;forsion / 来源 id = 只看那一个
  const [skillFilter, setSkillFilter] = useState<string>('all')
  const activeSource = sourceKey ? sources.sources.find((s) => s.id === sourceKey) ?? null : null
  const sourceOf = (c: MarketCard) => (c.origin ? sources.sources.find((s) => s.id === c.origin!.sourceId) : undefined)
  const removedSourceCards = useMemo(() => new Set(sources.installs.filter((r) => r.removed).map((r) => r.cardId)), [sources.installs])
  // 登录 / 换号的代数:换号之前发出去的来源请求,回来时不再上屏(私有来源的目录是上一个账号的)
  const authGen = useRef(0)
  const loadSource = useCallback(async (id: string, refresh = false) => {
    const gen = authGen.current
    setSourceLoading(true)
    try {
      const cat = await window.tangu!.marketSourcesCatalog!(id, { refresh, locale })
      if (gen !== authGen.current) return
      setSourceCat(cat)
      // 技能分类的混排也用这份(例如登录后才读得出的 Forsion Git 来源)
      if (cat.items.length) setSrcCats((m) => ({ ...m, [id]: cat }))
    }
    catch (e) { if (gen === authGen.current) { setSourceCat(null); toast(sourceErrorText(e, t) ?? String((e as Error)?.message || e), true) } }
    finally { if (gen === authGen.current) setSourceLoading(false) }
  }, [locale, t, toast])
  // 换了账号:Forsion Git 私有来源的目录和详情属于上一个账号,收掉,按现在的账号重读
  const sourceList = sources.sources
  useEffect(() => window.tangu?.onAuthChanged?.(() => {
    authGen.current++
    const isGit = (sourceId?: string) => sourceList.find((s) => s.id === sourceId)?.kind === 'forsion-git'
    setDetail((d) => (d?.origin && isGit(d.origin.sourceId) ? null : d))
    if (activeSource?.kind === 'forsion-git') { setSourceCat(null); void loadSource(activeSource.id, true) }
  }), [activeSource, sourceList, loadSource])
  // 选中的来源不见了(插件停用 / 被移除):退回原来那页
  useEffect(() => { if (sourceKey && sources.loaded && !activeSource) setSourceKey(null) }, [sourceKey, sources.loaded, activeSource])
  // 开着的来源各读一份目录(主进程有 10 分钟缓存与磁盘副本;读失败的来源保留上一份,不当成空)
  const openSourceIds = sourceList.filter((s) => !s.disabled).map((s) => s.id).join(',')
  const loadSourceCats = useCallback(async (refresh = false) => {
    const tg = window.tangu
    if (!tg?.marketSourcesCatalog || !openSourceIds) { setSrcCats({}); return }
    const gen = authGen.current
    setSrcCatsLoading(true)
    const ids = openSourceIds.split(',')
    const got = await Promise.all(ids.map((id) => tg.marketSourcesCatalog!(id, { refresh, locale }).catch(() => null)))
    if (gen !== authGen.current) return
    setSrcCats((was) => {
      const next: Record<string, StoreSourceCatalog> = {}
      ids.forEach((id, i) => { const cat = got[i]; if (cat && (cat.items.length || !was[id]?.items.length)) next[id] = cat; else if (was[id]) next[id] = { ...was[id], stale: true, error: cat?.error ?? was[id].error } })
      return next
    })
    setSrcCatsLoading(false)
  }, [openSourceIds, locale])
  // 换了账号:混排里 Forsion Git 来源的条目属于上一个账号,先收掉再按现在的账号重读
  useEffect(() => window.tangu?.onAuthChanged?.(() => {
    setSrcCats((m) => Object.fromEntries(Object.entries(m).filter(([id]) => sourceList.find((s) => s.id === id)?.kind !== 'forsion-git')))
    void loadSourceCats()
  }), [sourceList, loadSourceCats])
  useEffect(() => { if (sources.loaded) void loadSourceCats() }, [sources.loaded, loadSourceCats])
  // Automatic checks run in main even while this window is closed. Refresh the local installed snapshot after activation/mutations.
  useEffect(() => { void listInstalled().then(setInstalled).catch(() => {}) }, [pluginUpdates])

  // 一次拉全目录:发现/分类/搜索/更新共用同一份快照,避免切 tab 重复请求和闪烁。
  const reloadSources = sources.reload
  const scanCatalog = useCallback(async () => {
    void reloadSources().catch(() => {}) // 来源装过的东西(「已安装」页的出处)跟着刷新
    setScanning(true)
    setCatalogError('')
    const inst = await listInstalled().catch(() => ({} as Record<string, InstalledItem[]>))
    setInstalled(inst)
    const settled = await Promise.allSettled(contentTypes.map((tp) => listMarket(tp)))
    const lists = settled.map((result) => result.status === 'fulfilled' ? result.value : [])
    const all = lists.flat()
    setCatalog(all)
    if (settled.length && settled.every((result) => result.status === 'rejected')) setCatalogError(t('market.loadFailShort'))
    const ups = all.filter((c) => {
      const pools = (c.type === 'plugin' || c.type === 'amadeus-plugin')
        ? [...(inst[c.type] || []), ...(inst[c.type === 'plugin' ? 'amadeus-plugin' : 'plugin'] || [])]
        : (inst[c.type] || [])
      const entry = pools.find((x) => x.slug === c.installSlug)
      return !!entry && isNewer(c.latestVersion, entry.version)
    })
    setUpdatable(ups)
    setScanning(false)
  }, [t, contentTypes, reloadSources])

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
  /** 这个条目装上的 Forsion 插件(目录名可以与装载 id 不同)。 */
  const installedPlugin = (c: MarketCard): AmadeusPlugin | undefined => {
    const info = installedInfo(c)
    if (info?.realType !== 'amadeus-plugin') return undefined
    return plugins.find((p) => p.id === (info.entry.id ?? c.installSlug) || p.bundle?.dir === c.installSlug)
  }
  /** p 缺的前置(连前置自己缺的)逐条对到商店上。读 getState:一键补前置的循环要拿到上一步装完之后的状态。 */
  const depPlan = (p: AmadeusPlugin): DepPlan[] => {
    const s = usePluginStore.getState()
    return planDeps(unmetClosure(p, s.plugins, (x) => unmetPluginDeps(x, s)), catalog, { appVersion, platform: marketPlatform(), isInstalled: (c) => (installed['amadeus-plugin'] || []).some((x) => x.slug === c.installSlug) })
  }
  const depLabel = (x: DepPlan): string => x.card?.name || x.unmet.dep.name || x.unmet.dep.id
  // 目录没拉到插件这一类(离线 / 这一类请求失败)时不知道有没有,不能说「商店里没有」。
  const pluginsListed = catalog.some((c) => c.type === 'amadeus-plugin')
  /** 提示条第二行:只有一部分能装时才需要说哪些能、哪些不能。 */
  const depsHint = (plan: DepPlan[]): string | undefined => {
    const can = plan.filter((x) => x.card && !x.skip).map(depLabel), absent = plan.filter((x) => x.skip === 'absent').map(depLabel)
    if (!absent.length || !pluginsListed) return undefined
    const sep = t('common.listSep')
    return [can.length ? t('market.deps.installableHint', { list: can.join(sep) }) : '', t('market.deps.absentHint', { list: absent.join(sep) })].filter(Boolean).join(' ')
  }
  const isInstalled = (c: MarketCard): boolean => !!installedEntry(c)
  const hasUpdate = (c: MarketCard): boolean => isNewer(c.latestVersion, installedEntry(c)?.version ?? null)
  /** A card of a source, from the catalogs in hand (the open source page first). */
  const sourceCard = (id: string): MarketCard | null => {
    const sid = id.slice(4, 12)
    return ((sourceCat?.source.id === sid ? sourceCat.items : srcCats[sid]?.items ?? []).find((x) => x.id === id) as MarketCard | undefined) ?? null
  }
  const skillInstalled = (slug: string): boolean => (installed.skill || []).some((x) => x.slug === slug)
  /** Installs for one item: prerequisites not installed yet, then the item. */
  const planOf = (c: MarketCard) => installPlan(c, { installed: skillInstalled, lookup: sourceCard })
  /** What installing `c` asks the user to confirm (scripts / audit of it and its prerequisites, and what main counted). */
  const scriptsConfirm = (c: MarketCard) => isSourceCardId(c.id) && c.type === 'skill' ? confirmOf(planOf(c).steps, confirmFound[c.id]) : null
  const publisher = (c: MarketCard) => publisherOf(c, sources.supported ? sources.sources : undefined, removedSourceCards.has(c.id))
  const updateItem = (c: MarketCard) => pluginUpdates.items.find((x) => x.id === c.id)
  /** 本机版本库里这一项留着的旧版本(按真实装在哪个插件目录找)。 */
  const keptOf = (c: MarketCard) => {
    const info = installedInfo(c)
    return updateItem(c)?.keptVersions ?? pluginUpdates.local.find((x) => x.type === info?.realType && x.slug === c.installSlug)?.keptVersions ?? []
  }
  /** 回退到本机留着的版本:换目录、不联网;之后走和安装同一条装后重载。 */
  const onRollback = async (c: MarketCard, version: string): Promise<void> => {
    const info = installedInfo(c)
    if (!info || !window.tangu?.marketRollback) return
    setNotice(null)
    try {
      const res = await window.tangu.marketRollback(info.realType, c.installSlug, version, { id: c.id, name: c.name })
      if (res.deferred) { toast(t('market.rollbackDeferred', { name: c.name, version: `v${version}` })); return }
      const { restart } = await afterMarketInstall(res.type, res, true, toast)
      if (restart) offerRestart(t('market.pluginInstalledRestartHint'))
      else toast(t('market.rolledBack', { name: c.name, version: `v${version}` }))
      await scanCatalog()
    } catch (e) { toast(t('market.rollbackFailed', { error: ipcErrorText(e) }), true) }
  }
  const versionBlock = (c: MarketCard) => (c.type === 'plugin' || c.type === 'amadeus-plugin') && isInstalled(c)
    ? <PluginVersionBlock id={c.id} item={updateItem(c)} installedVersion={installedEntry(c)?.version} kept={keptOf(c)} autoUpdateAll={pluginUpdates.autoUpdateAll}
      disabled={!!installing[c.id] || uninstalling === c.id} onError={(text) => toast(text, true)} onRollback={(version) => onRollback(c, version)} /> : null

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

  // 技能「装给哪些 Agent」:按条目记,缺省 null = 所有 Agent;只在首次安装时生效
  const [skillChoice, setSkillChoice] = useState<Record<string, SkillAgentChoice>>({})
  const skillAgents = useSkillAgents(true)
  /** quiet = 一键补前置 / 收录技能前置的一步:结果由那条链统一说,这里不报成功。
   *  ack = 用户对这一项确认过的脚本 / 审计;parent = 连同前置一起装时,用户点的那一项(主进程要确认时回到它的详情页问)。 */
  const onInstall = async (c: MarketCard, version?: string, quiet = false, opts: { ack?: { scripts: number; audit: boolean }; parent?: MarketCard } = {}): Promise<{ ok: boolean; restart: boolean }> => {
    setInstalling((m) => ({ ...m, [c.id]: true }))
    setProgress((m) => omit(m, c.id))
    setFailed((m) => omit(m, c.id))
    if (!quiet) setNotice(null) // 新一轮安装 = 用户已看过上一条(失败的那项按钮仍是「重试」)
    const wasInstalled = isInstalled(c)
    const tele = trackMarketInstall(quiet ? 'deps' : 'store', c) // 匿名遥测:商店条目 id + 阶段 / 结果的枚举,报错原文不发
    try {
      const res = await installMarket(c.id, version, isSourceCardId(c.id) ? { type: c.type, ...(opts.ack ? { ack: opts.ack } : {}) } : undefined)
      const effectiveType = ((res?.type as MarketType) || c.type)
      if (effectiveType === 'skill' && !wasInstalled && skillAgentsSupported()) {
        await applySkillAgentChoice(res?.slug || c.installSlug, skillChoice[c.id] ?? null)
          .catch((e) => toast(t('market.skillAgents.applyFailed', { e: e?.message || String(e) }), true))
      }
      track('market.install')
      act('market.install', { id: c.id })
      // 本窗热重载 + 通知主窗等其余窗口(市场是独立浮窗)+ 判断要不要重启后端,与插件引导卡共用。
      const { restart, fresh } = await afterMarketInstall(effectiveType, res, wasInstalled, toast)
      tele.done({ type: effectiveType, pluginId: res?.id, restart })
      // 装完 = 注意力在场:逐个实测新插件(连 check),第一个确有未满足的才弹检查卡。
      const state = usePluginStore.getState()
      for (const p of fresh) if (state.activeIds.includes(p.id) && isGate(p) && await promptIfPending(p.id)) break
      if (quiet) { await scanCatalog(); return { ok: true, restart } }
      if (restart) offerRestart(t('market.pluginInstalledRestartHint'))
      else if (effectiveType === 'space') toast(t('market.spaceInstalled', { name: c.name }))
      else if (effectiveType === 'theme') toast(t('market.themeInstalled', { name: c.name }))
      else if (effectiveType === 'amadeus-plugin') {
        // 装上了但前置没齐(装着、开不了):别报「已加载」,说清还缺什么;能从商店装的给一键按钮,提示条不自动消失
        const p = usePluginStore.getState().plugins.find((x) => x.id === res?.id)
        const plan = p ? depPlan(p) : []
        if (p && plan.length) {
          const text = t('market.amadeusPluginNeedsDeps', { name: c.name, list: plan.map(depLabel).join(t('common.listSep')) })
          setNotice((cur) => (cur?.error ? cur : { text, error: false, hint: depsHint(plan), deps: installableDeps(plan).length ? p.id : undefined }))
        } else toast(t('market.amadeusPluginInstalled', { name: c.name }))
      }
      else if (effectiveType !== 'plugin') toast(t('market.installOk', { name: c.name })) // 引擎插件的结果 onPluginInstalled 已经说过
      await scanCatalog()
      return { ok: true, restart }
    } catch (e: any) {
      tele.fail(e)
      // 包里有脚本 / 审计有警告,用户还没在这一项上确认过(目录没说,或说少了):回到详情页按主进程数出来的问一次
      const need = confirmNeededOf(e)
      if (need) {
        const p = opts.parent ?? c
        setConfirmFound((m) => ({ ...m, [p.id]: { ...m[p.id], [c.id]: need } }))
        setConfirming(p.id)
        if (detail?.id !== p.id) openDetail(p, true)
        return { ok: false, restart: false }
      }
      setFailed((m) => ({ ...m, [c.id]: true }))
      toast(t('market.installFailNamed', { name: c.name, e: sourceErrorText(e, t) ?? (e?.message || String(e)) }), true, c.source === 'github' && e?.stage !== 'resolve' ? t('market.installHintGithub') : undefined)
      return { ok: false, restart: false }
    } finally {
      setInstalling((m) => omit(m, c.id))
      setProgress((m) => omit(m, c.id))
    }
  }

  /**
   * Install one item: a collected skill brings its prerequisites (same source) first, each through the same pipeline;
   * `acks` = what the user confirmed per step. A step that fails stops the chain (what was installed stays).
   */
  const startInstall = async (c: MarketCard, version?: string, acks: Record<string, { scripts: number; audit: boolean }> = {}): Promise<void> => {
    const { steps, missing } = isSourceCardId(c.id) && !version ? planOf(c) : { steps: [] as InstallStep[], missing: [] as string[] }
    const pre = steps.slice(0, -1)
    if (!pre.length) {
      const r = await onInstall(c, version, false, { ack: acks[c.id] })
      if (r.ok && missing.length) toast(t('market.prereqMissing', { list: missing.join(t('common.listSep')) }))
      return
    }
    setInstalling((m) => ({ ...m, [c.id]: true }))
    try {
      for (const [i, step] of pre.entries()) {
        setPrereqRun({ parent: c.id, name: step.name, n: i + 1, total: pre.length })
        const card = sourceCard(step.id) ?? { id: step.id, type: 'skill' as const, source: 'github' as const, name: step.name, summary: '', author: c.author, installSlug: step.installSlug, downloads: 0, latestVersion: null, origin: c.origin }
        const r = await onInstall(card, undefined, true, { ack: acks[step.id], parent: c })
        if (!r.ok) return
      }
    } finally { setPrereqRun(null); setInstalling((m) => omit(m, c.id)) }
    const r = await onInstall(c, version, false, { ack: acks[c.id] })
    if (r.ok && missing.length) toast(t('market.prereqMissing', { list: missing.join(t('common.listSep')) }))
  }

  /** 把 p 缺的前置一个个装上。每步重算:装完 B 才知道 B 还缺 C。依赖方恢复不在这里 —— 装完的重载走到 pluginStore 的 reconcile。 */
  const onInstallDeps = async (p: AmadeusPlugin): Promise<void> => {
    const name = pluginDisplayName(p, locale)
    const tried = new Set<string>() // 同一条目一轮只试一次:装上了前置却还是不齐(条目不是它要的包)时不能原地打转
    const live = (): AmadeusPlugin | undefined => usePluginStore.getState().plugins.find((x) => x.id === p.id)
    // 不盖掉并发安装还挂着的失败(同 toast);自己这条链的错误(带 deps)可以被下一步换掉。
    const say = (next: NonNullable<typeof notice>): void => setNotice((cur) => (cur?.error && cur.deps !== p.id ? cur : next))
    let restart = false
    let installedN = 0
    for (;;) {
      const self = live() // 每步重读:装的途中它可能被别的窗口卸载或换了版本
      if (!self) break
      const todo = installableDeps(depPlan(self)).filter((c) => !tried.has(c.id))
      const card = todo[0]
      if (!card) break
      tried.add(card.id)
      const step = { n: tried.size, total: tried.size + todo.length - 1 }
      setDepsRun({ pluginId: p.id, card, ...step })
      say({ text: t('market.deps.installing', { name: card.name, n: String(step.n), total: String(step.total) }), error: false, hint: t('market.deps.willRun', { name }), deps: p.id })
      const r = await onInstall(card, undefined, true)
      if (!r.ok) { // onInstall 已报错(常驻);这颗按钮此时是「重试」
        reportDepsChain({ total: tried.size + todo.length - 1, installed: installedN, failedAt: tried.size, outcome: 'failed' })
        setDepsRun(null)
        setNotice((cur) => (cur ? { ...cur, deps: p.id } : cur))
        return
      }
      installedN++
      restart ||= r.restart
    }
    setDepsRun(null)
    const self = live()
    if (!self) { setNotice((cur) => (cur?.deps === p.id ? null : cur)); return } // 它自己没了,这条提示也没有意义了
    const depsOutcome = usePluginStore.getState().activeIds.includes(p.id) ? 'ready' : depPlan(self).length ? 'not-ready' : 'not-running'
    reportDepsChain({ total: tried.size, installed: installedN, outcome: depsOutcome })
    if (usePluginStore.getState().activeIds.includes(p.id)) { // 只有真跑起来才这么说
      if (restart) offerRestart(t('market.pluginInstalledRestartHint'))
      else say({ text: t('market.deps.ready', { name }), error: false })
      if (isGate(self)) void promptIfPending(p.id) // 和普通安装同一条:装完 = 注意力在场
      return
    }
    const left = depPlan(self)
    if (left.length) say({ text: t('market.deps.notReady', { name, list: left.map(depLabel).join(t('common.listSep')) }), error: false, hint: depsHint(left), deps: p.id })
    else say({ text: t('market.deps.notRunning', { name }), error: false, deps: p.id })
  }

  // Agent / 技能 / 插件走统一卸载确认框(components/UninstallDialog,10-28 手动卸载规范):逐项写去向、进回收站、6 秒内可撤销,
  // 与设置页同一条路;Space 与主题没有留下的东西,照旧一句确认后删目录。
  const [asking, setAsking] = useState<
    | { kind: 'agent'; c: MarketCard; slug: string }
    | { kind: 'skill'; c: MarketCard; slug: string; key: string }
    | { kind: 'plugin'; c: MarketCard; id: string; warning?: string }
    | { kind: 'amadeus-plugin'; c: MarketCard; plugin: AmadeusPlugin; warning?: string }
    | null>(null)
  // 设置页两处同一句:还在跑、依赖它的插件写进确认框
  const dependentsWarning = (name: string, dependents: Array<Parameters<typeof pluginDisplayName>[0]>): string | undefined =>
    dependents.length ? t('settings.plugins.uninstallDependents', { name, list: dependents.map((x) => pluginDisplayName(x, locale)).join(t('common.listSep')) }) : undefined
  const afterDialogUninstall = async (c: MarketCard, type: string, slug: string): Promise<void> => {
    act('market.uninstall', { id: c.id })
    // 插件两类的卸载那条已在 pluginUninstall 里报过(带商店条目 id);Agent / 技能在这里报
    if (type === 'agent' || type === 'skill') sendTelemetry('plugin_lifecycle', { pluginId: c.id, pluginOfficial: true, action: 'uninstall' })
    if (type === 'agent' || type === 'skill') void window.tangu?.marketForget?.(type, slug).catch(() => {})
    await scanCatalog()
  }

  const onUninstall = async (c: MarketCard): Promise<void> => {
    const info = installedInfo(c)
    if (!info) return
    const slug = c.installSlug
    try {
      if (info.realType === 'agent') { setAsking({ kind: 'agent', c, slug }); return }
      if (info.realType === 'skill') {
        // 商店技能装在用户技能目录的 <installSlug>/:按目录名找到它在技能目录里的那一行(确认框要 key)
        const row = (await listSkillCatalog(homeTarget())).find((r) => r.scope === 'user' && r.slug === slug && r.provenance === 'user')
        if (row) { setAsking({ kind: 'skill', c, slug, key: row.key }); return }
      } else if (info.realType === 'plugin') {
        const hit = (await window.tangu?.pluginsUserInstalled?.())?.find((p) => p.slug === slug)
        if (hit) {
          const engine = await listPlugins(homeTarget())
          const dependents = dependentsOf(hit.id, engine.map((x) => ({ id: x.id, version: x.version ?? '', requiresPlugins: x.requiresPlugins })))
            .map((n) => engine.find((x) => x.id === n.id)!).filter((x) => x.active ?? x.enabled)
          setAsking({ kind: 'plugin', c, id: hit.id, warning: dependentsWarning(c.name, dependents) })
          return
        }
      } else if (info.realType === 'amadeus-plugin') {
        const plugin = usePluginStore.getState().plugins.find((p) => p.bundle?.dir === slug || p.id === slug)
        if (plugin) { setAsking({ kind: 'amadeus-plugin', c, plugin, warning: dependentsWarning(c.name, runningDependents(plugin.id)) }); return }
      }
    } catch {
      // 查不了(引擎还没起来等):报错别卸 —— 老路是直接删目录,不进回收站
      toast(t('uninstall.engineDown'), true)
      return
    }
    await legacyUninstall(c, info) // 查得到列表却没有这一份(目录多半已经不在):走老路撤记录
  }

  const legacyUninstall = async (c: MarketCard, info: NonNullable<ReturnType<typeof installedInfo>>): Promise<void> => {
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
      sendTelemetry('plugin_lifecycle', { pluginId: c.id, pluginOfficial: true, action: 'uninstall' })
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
    const onBack = (e: Event): void => { e.preventDefault(); if (!(e as CustomEvent<{ probe?: boolean } | null>).detail?.probe) setDetail(null) } // probe:只答「我接」,不动手
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [detail])

  const openDetail = (c: MarketCard, keepConfirm = false): void => {
    if (removedSourceCards.has(c.id)) return // 来源已移除:没有地方读详情
    if (!keepConfirm && confirming !== c.id) setConfirming(null)
    setDetailTab('overview')
    setDetailLoading(true)
    setDetail(null)
    getMarketDetail(c.id)
      .then(setDetail)
      .catch((e) => toast(t('market.loadFail', { e: e?.message || String(e) }), true))
      .finally(() => setDetailLoading(false))
  }

  const switchTab = (next: Tab): void => {
    setTab(next)
    setSkillFilter('all')
    setStoreViewKey(null)
    setSourceKey(null)
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
  /** 需要账号权益的包(保留标签 entitlement:<name>):一枚标记,不挡安装。 */
  const entitlementLabel = (c: MarketCard): string | null => {
    const name = itemEntitlement(c)
    return !name ? null : name === 'business' ? t('market.requiresBusiness') : t('market.requiresEntitlement', { name })
  }
  /** 这个条目会让插件联网访问哪些域名:装好了以本机那份 manifest 为准(主进程放行认的就是它),否则看目录给没给。 */
  const networkOf = (c: MarketCard): string[] => installedPlugin(c)?.network ?? sanitizeNetworkPatterns(c.network).patterns
  /** 这个条目声明的能力(能读写哪些用户数据、要不要内部接口):装好了以本机 manifest 为准,否则看服务端从包里读到的(2026-11-16+)。 */
  const capsOf = (c: MarketCard): string[] => capabilityLabels(installedPlugin(c)?.capabilities ?? c.capabilities, t)
  const entitlementBadge = (c: MarketCard) => {
    const label = entitlementLabel(c)
    return label ? <span className="mk-desktop-badge" data-market-entitlement={c.id} title={t('market.requiresHint')}><KeyRound size={11} />{label}</span> : null
  }
  /** 给人看的标签:保留标签已经画成标记了,不再当普通标签重复一遍。 */
  const shownTags = (c: MarketCard): string[] => (c.tags || []).filter((tag) => !isReservedMarketTag(tag))

  /** 来源条目要先确认:这个来源第一次装东西,会运行代码的条目第一次装,或技能(连同前置)带脚本 / 审计有警告(内置来源也问,逐个问)。 */
  const needsConfirm = (c: MarketCard): boolean => isSourceCardId(c.id) && ((!isInstalled(c) && (!sourceOf(c)?.trusted || CODE_TYPES.has(c.type))) || (!isInstalled(c) && !!scriptsConfirm(c)))
  const onConfirmSourceInstall = async (c: MarketCard): Promise<void> => {
    const s = sourceOf(c)
    setTrusting(true)
    try {
      if (s && !s.trusted) { await window.tangu?.marketSourcesTrust?.(s.id); await sources.reload() }
      // 确认的是确认块上写的那些:每一步按目录 + 主进程数出来的取大
      const found = confirmFound[c.id] ?? {}
      const acks = Object.fromEntries(planOf(c).steps.map((st) => [st.id, ackOf(st, found[st.id])]))
      setConfirming(null)
      void startInstall(c, undefined, acks)
    } catch (e) { toast(sourceErrorText(e, t) ?? String((e as Error)?.message || e), true) } finally { setTrusting(false) }
  }
  const installBtn = (c: MarketCard, extraClass = '') => {
    if (isSourceCardId(c.id) && removedSourceCards.has(c.id)) return null // 来源已移除:不再更新,卡片角标说明
    // 上游仓库已删:没装的不给装(下不到了),装着的照常用
    if (isBuiltinCard(c) && !isInstalled(c) && upstreamGone(c, sources.installs)) return <button className={`btn sm ${extraClass}`.trim()} disabled data-market-install={c.id} title={t('market.upstreamDeletedHint')}>{t('market.upstreamDeleted')}</button>
    // 「仅桌面」先判:通用兼容性也把这枚保留标签算作 platform,排在前面的话手机上只剩一句「当前端不可用」,
    // 说不出装不了的原因(手机 e2e:plugins 4b 钉着这枚按钮)。
    if (desktopOnlyHere(c)) {
      return <button className={`btn sm ${extraClass}`.trim()} disabled data-market-install={c.id} data-install-state="desktop-only" title={t('market.desktopOnlyHint')}><Monitor size={13} />{t('market.desktopOnlyInstall')}</button>
    }
    const compatibility = marketplaceCompatibility(c, appVersion, marketPlatform())
    if (compatibility === 'version' || compatibility === 'platform') return <button className={`btn sm ${extraClass}`} disabled data-market-install={c.id}><MarketRequirements item={c} version={appVersion} /></button>
    const state = pluginUpdates.items.find((x) => x.id === c.id)
    const busy = !!installing[c.id] || state?.phase === 'downloading'
    const pending = !!state?.pendingVersion
    const done = isInstalled(c)
    const update = hasUpdate(c)
    const inst = installedEntry(c)
    const retry = !busy && !!failed[c.id]
    const p = busy ? progress[c.id] : undefined
    const run = prereqRun?.parent === c.id ? prereqRun : null
    // 详情页的宽按钮写明连同几个前置(卡片上放不下,只写「安装」)
    const withPre = !done && !busy && extraClass.includes('mk-wide-btn') && isSourceCardId(c.id) ? planOf(c).steps.length - 1 : 0
    return (
      <button
        className={`btn sm ${update || !done ? 'primary' : ''} ${extraClass}`.trim()}
        disabled={busy}
        data-market-install={c.id}
        data-install-state={busy ? (state?.phase === 'downloading' ? 'download' : p?.phase || 'resolve') : retry ? 'failed' : undefined}
        title={p?.host || (update ? t('market.updateTitle', { from: inst?.version || '?', to: c.latestVersion || '?' }) : undefined)}
        onClick={(e) => {
          e.stopPropagation()
          if (pending) void window.tangu?.restartForUpdate?.().catch((error) => toast(String(error?.message || error), true))
          else if (needsConfirm(c)) { setConfirming(c.id); if (detail?.id !== c.id) openDetail(c, true) }
          else void startInstall(c)
        }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : retry || update ? <RefreshCw size={13} /> : done ? <Check size={13} /> : <Download size={13} />}
        {pending ? t('restartUpdate.button') : run ? t('market.prereqInstalling', { name: run.name, n: run.n, total: run.total }) : busy ? state?.phase === 'downloading' ? t('market.autoUpdateDownloading') : busyLabel(p) : retry ? t('market.installRetry') : update ? t('market.update') : done ? t('market.reinstall') : withPre === 1 ? t('market.installWithPrereq') : withPre > 1 ? t('market.installWithPrereqs', { n: withPre }) : t('market.install')}
      </button>
    )
  }

  /** 一键补前置:提示条与详情页右栏同一颗。这次真能装的一个都没有就不出现,不假装能装。 */
  const depsBtn = (p: AmadeusPlugin, extraClass = ''): ReactNode => {
    const run = depsRun?.pluginId === p.id ? depsRun : null
    const plan = depPlan(p), todo = installableDeps(plan)
    if (!run && !todo.length) return null
    const retry = !run && todo.some((c) => failed[c.id])
    const update = plan.every((x) => !x.card || x.skip || x.unmet.reason === 'version')
    return (
      <button className={`btn sm primary ${extraClass}`.trim()} disabled={!!depsRun} data-market-deps-install={p.id} onClick={() => void onInstallDeps(p)}>
        {run ? <Loader2 size={13} className="mk-spin" /> : retry ? <RefreshCw size={13} /> : <Download size={13} />}
        {run ? busyLabel(progress[run.card.id]) : retry ? t('market.installRetry') : update ? t('market.deps.update') : todo.length > 1 ? t('market.deps.installN', { n: String(todo.length) }) : t('market.deps.install')}
      </button>
    )
  }

  /** 「商店里没有」那一行的查找:对不上 slug 不等于真没有(见 marketDeps.ts),留一条按名字搜的路。 */
  const findInStore = (q: string): void => { switchTab('discover'); setQuery(q) }

  const depsStore = (p: AmadeusPlugin): RequiredPluginsStore => {
    const plan = depPlan(p)
    const run = depsRun?.pluginId === p.id ? depsRun : null
    const noteOf = (x: DepPlan): string | undefined => {
      if (x.skip === 'absent') return pluginsListed ? t('market.deps.absent') : undefined
      if (x.skip === 'low') return t('market.deps.tooLow', { version: x.card?.latestVersion ?? '' })
      if (x.skip === 'incompatible') return t('market.deps.incompatible')
      if (x.skip === 'mismatch') return t('market.deps.mismatch')
      if (!x.card) return undefined
      if (run) return x.card.id === run.card.id ? busyLabel(progress[run.card.id]) : t('market.deps.queued')
      return x.card.latestVersion ? t('market.deps.inStore', { version: x.card.latestVersion }) : t('market.deps.inStoreAny')
    }
    return {
      unmet: plan.map((x) => x.unmet),
      row: (dep) => { const x = plan.find((y) => y.unmet.dep.id === dep.id); return x ? { note: noteOf(x), find: x.skip === 'absent' && pluginsListed } : {} },
      find: findInStore,
      foot: depsBtn(p, 'mk-wide-btn'),
    }
  }

  /** 列表卡片:装着却在等前置(只算用户想开的;用户自己关掉的不是在等)。 */
  const waitingDeps = (c: MarketCard): boolean => {
    const p = installedPlugin(c)
    return !!p && !p.blocked && pluginWanted(p, disabledIds) && !activeIds.includes(p.id) && unmetPluginDeps(p, { plugins, activeIds, disabledIds }).length > 0
  }

  /** 卸载按钮:只对已安装项出现;webapp 没有本地安装目录,不在此列。 */
  const uninstallBtn = (c: MarketCard, labeled = false) => {
    if (!isInstalled(c)) return null
    const busy = uninstalling === c.id
    return (
      <button
        className={labeled ? 'mk-uninstall-text' : 'btn sm ghost'}
        disabled={busy || !!installing[c.id]}
        data-market-uninstall={c.id}
        title={t('market.uninstall')}
        aria-label={t('market.uninstall')}
        onClick={(e) => { e.stopPropagation(); void onUninstall(c) }}
      >
        {busy ? <Loader2 size={13} className="mk-spin" /> : <Trash2 size={13} />}{labeled && t('market.uninstall')}
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
    connector: t('connectors.tab'),
    installed: t('market.tab.installed'),
    updates: t('market.tab.updates'),
    submit: t('market.tab.submit'),
  }
  const kindLabel: Record<MarketType, string> = {
    skill: t('market.kind.skill'),
    agent: t('market.kind.agent'),
    plugin: t('market.kind.plugin'),
    space: t('market.kind.space'),
    theme: t('market.kind.theme'),
    'amadeus-plugin': t('market.kind.plugin'),
  }

  const matchesQuery = useCallback((c: MarketCard): boolean => {
    const needle = query.trim().toLocaleLowerCase()
    if (tagFilter && !c.tags?.includes(tagFilter)) return false
    if (compatibleOnly && marketplaceCompatibility(c, appVersion, marketPlatform()) !== 'compatible') return false
    if (!needle) return true
    return [c.id, c.name, c.summary, c.description || '', c.author, c.installSlug, ...(c.tags || [])]
      .some((value) => value.toLocaleLowerCase().includes(needle))
  }, [query, tagFilter, compatibleOnly, appVersion])

  const sortCards = useCallback((cards: MarketCard[], mode = sort): MarketCard[] => {
    const copy = [...cards]
    if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name))
    if (mode === 'latest') return copy.sort((a, b) => timeValue(b.updatedAt || b.createdAt) - timeValue(a.updatedAt || a.createdAt))
    return copy.sort((a, b) => b.downloads - a.downloads)
  }, [sort])

  /** 从来源装的东西(出处记录):「已安装」页里和商店条目排在一起,带来源角标。 */
  const sourceInstalledCards = useMemo(() => sources.installs.map((r): MarketCard => ((sourceCat?.source.id === r.sourceId ? sourceCat.items : srcCats[r.sourceId]?.items ?? []).find((c) => c.id === r.cardId) as MarketCard | undefined)
    ?? { id: r.cardId, type: r.type as MarketType, source: 'zip', name: r.name, summary: r.summary || '', author: r.author || '', installSlug: r.slug, downloads: 0, latestVersion: r.version, tags: [], origin: { sourceId: r.sourceId, sourceTitle: r.sourceTitle ?? '' } }), [sources.installs, sourceCat, srcCats])
  /** 来源装的东西里有新版本的(按出处记录的版本比;来源停用 / 已不收录的不算) —— 「可更新」与它的计数。 */
  const sourceUpdatable = useMemo(() => sources.installs.flatMap((r) => {
    if (r.removed || r.delisted) return []
    const c = (srcCats[r.sourceId]?.items ?? []).find((x) => x.id === r.cardId) as MarketCard | undefined
    return c && installedInfo(c) && isNewer(c.latestVersion, installedInfo(c)!.entry.version) ? [c] : []
  }), [sources.installs, srcCats, installedInfo])
  const allUpdatable = useMemo(() => [...updatable, ...sourceUpdatable.filter((c) => !updatable.some((u) => u.id === c.id))], [updatable, sourceUpdatable])
  /** 开着的来源里的技能,按来源分组(内置的 skills.sh 在前,其余按左栏顺序)。这一期只有技能进分类。 */
  const sourceSkillGroups = useMemo(() => sources.sources.filter((src) => !src.disabled).map((src) => ({
    source: src, cat: srcCats[src.id] as StoreSourceCatalog | undefined, items: ((srcCats[src.id]?.items ?? []) as MarketCard[]).filter((c) => c.type === 'skill'),
  })), [sources.sources, srcCats])
  const sourceCards = useMemo(() => (activeSource && sourceCat?.source.id === activeSource.id ? sourceCat.items as MarketCard[] : []), [activeSource, sourceCat])
  const visibleSource = useMemo(() => sourceCards.filter(matchesQuery), [sourceCards, matchesQuery])
  const visibleCatalog = useMemo(() => {
    let cards = tab === 'installed'
      ? [...catalog.filter((c) => !!installedInfo(c)), ...sourceInstalledCards.filter((c) => !!installedInfo(c))]
      : tab === 'updates'
        ? allUpdatable
        : CONTENT_TABS.includes(tab as MarketType)
          ? catalog.filter((c) => tab === 'plugin'
            ? PLUGIN_TAB_TYPES.includes(c.type)
            : c.type === tab)
          : catalog
    cards = cards.filter(matchesQuery)
    return sortCards(cards)
  }, [catalog, installedInfo, matchesQuery, sortCards, tab, allUpdatable, sourceInstalledCards])
  /** Forsion 的排在前面:官方再开发者,各按当前排序。 */
  const forsionFirst = useCallback((cards: MarketCard[]): MarketCard[] => [...sortCards(cards.filter((c) => c.publisher === 'official')), ...sortCards(cards.filter((c) => c.publisher !== 'official'))], [sortCards])
  /** 技能分类:Forsion 的技能 + 各来源一组,都已按筛选 / 搜索过滤、组内排好序。 */
  const skillGroups = useMemo(() => {
    const forsion = forsionFirst(catalog.filter((c) => c.type === 'skill' && matchesQuery(c)))
    return { forsion, sources: sourceSkillGroups.map((g) => ({ ...g, visible: sortCards(g.items.filter(matchesQuery)) })) }
  }, [catalog, sourceSkillGroups, matchesQuery, sortCards, forsionFirst])
  /** 混排(搜索时 / 选了一个来源):Forsion 在前,再按来源顺序;各来源内按各自的数排,不跨来源比数。 */
  const skillMixed = useMemo(() => {
    if (skillFilter === 'forsion') return skillGroups.forsion
    if (skillFilter !== 'all') return skillGroups.sources.find((g) => g.source.id === skillFilter)?.visible ?? []
    return [...skillGroups.forsion, ...skillGroups.sources.flatMap((g) => g.visible)]
  }, [skillGroups, skillFilter])
  /** 商店首页的搜索:Forsion 的结果后面接上各来源里匹配的技能。 */
  const sourceSearchHits = useMemo(() => (query.trim() ? skillGroups.sources.flatMap((g) => g.visible) : []), [query, skillGroups])

  const featured = useMemo(() => sortCards(catalog.filter(matchesQuery), 'popular')[0], [catalog, matchesQuery, sortCards])
  const recent = useMemo(() => sortCards(catalog.filter(matchesQuery), 'latest').slice(0, 4), [catalog, matchesQuery, sortCards])
  const popular = useMemo(() => sortCards(catalog.filter(matchesQuery), 'popular').filter((c) => c.id !== featured?.id).slice(0, 6), [catalog, featured?.id, matchesQuery, sortCards])
  const visibleWebApps = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (webApps?.items || []).filter((item) => !needle || [item.name, item.summary, item.handle].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [query, webApps])

  const openWebApp = (w: WebApp): void => {
    if (!webApps) return
    openBrowser(w.publicUrl && /^https?:\/\//i.test(w.publicUrl) ? w.publicUrl : webApps.base + w.url)
    close()
  }

  /** 来源条目在它自己的来源页上不再标来源(整页都是它)。 */
  const showPublisher = (c: MarketCard): boolean => !isSourceCardId(c.id) || c.origin?.sourceId !== sourceKey
  /** 卡片右上角的数:Forsion 的下载数、skills.sh 的安装数;用户加的来源没有数。 */
  const showCount = (c: MarketCard): boolean => (!isSourceCardId(c.id) || (isBuiltinCard(c) && !!c.collected)) && !removedSourceCards.has(c.id)
  const gone = (c: MarketCard): boolean => isBuiltinCard(c) && upstreamGone(c, sources.installs)
  const delisted = (c: MarketCard): boolean => sources.installs.some((r) => r.cardId === c.id && r.delisted)
  const card = (c: MarketCard, compact = false) => (
    <article key={c.id} className={`mk-card ${compact ? 'compact' : ''}`} onClick={() => openDetail(c)}>
      <div className="mk-card-visual" aria-hidden="true"><ItemIcon url={c.iconUrl} type={c.type} size={compact ? 20 : 24} /></div>
      <div className="mk-card-content">
        <div className="mk-card-eyeline" data-has-tier={requirementText(c.collected, t) ? '' : undefined}>
          <span>{kindLabel[c.type]}</span>
          {!!requirementText(c.collected, t) && <span className="mk-tier" data-market-tier={c.id} title={requirementText(c.collected, t)}>{requirementText(c.collected, t)}</span>}
          {isInstalled(c) && <span className="mk-installed-badge"><Check size={11} />{t('market.installed')}</span>}
          {gone(c) && <span className="mk-waiting-badge" data-market-upstream-deleted={c.id} title={t('market.upstreamDeletedHint')}>{t('market.upstreamDeleted')}</span>}
          {!gone(c) && delisted(c) && isInstalled(c) && <span className="mk-waiting-badge" data-market-delisted={c.id} title={t('market.delistedHint')}>{t('market.delisted')}</span>}
          {isInstalled(c) && <PinnedChip item={updateItem(c)} />}
          {waitingDeps(c) && <span className="mk-waiting-badge" data-market-waiting={c.id}>{t('settings.amadeusPlugins.waitingDeps')}</span>}
          {desktopBadge(c)}
          {entitlementBadge(c)}
          {/* 「未声明」对挑插件没帮助，只在详情页的「Forsion 版本要求」里写(DESIGN §6 插件商店) */}
          {marketplaceCompatibility(c, appVersion, marketPlatform()) !== 'unknown' && <MarketRequirements item={c} version={appVersion} />}
          {showCount(c) && <CountChip c={c} collected={isBuiltinCard(c)} />}
        </div>
        <button className="mk-card-title" onClick={(e) => { e.stopPropagation(); openDetail(c) }}>{c.name}</button>
        <div className="mk-card-summary">{c.summary || t('market.summaryFallback')}</div>
        {!!shownTags(c).length && <div className="mk-tags">{shownTags(c).slice(0, compact ? 2 : 3).map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <div className="mk-card-foot">
          {/* 作者名先截,来源标签不截 */}
          <span className="mk-card-meta mk-card-by">{!!c.author && <span className="mk-card-author">{c.author}</span>}{showPublisher(c) && <PublisherChip label={publisher(c)} id={c.id} />}{isSourceCardId(c.id) && !isBuiltinCard(c) && !showPublisher(c) && !!c.latestVersion && <span className="mk-card-author">v{c.latestVersion}</span>}</span>
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

  /** 技能分类有没有来源可分(没有来源的宿主 / 都停用了:还是原来那一张网格)。 */
  const skillSectioned = tab === 'skill' && !activeSource && sources.supported && sourceSkillGroups.some((g) => g.items.length || g.source.origin === 'builtin')
  const skillCount = skillGroups.forsion.length + skillGroups.sources.reduce((n, g) => n + g.visible.length, 0)
  const SECTION_CARDS = window.tangu?.mobile ? 3 : 6
  /** 顶上那排来源筛选:全部 / Forsion / 各来源(带数目)。 */
  const skillChips = () => (
    <div className="mk-src-chips" role="group" aria-label={t('market.section.filterLabel')} data-market-source-chips>
      {[{ id: 'all', label: t('market.tagAllShort'), n: skillCount }, { id: 'forsion', label: 'Forsion', n: skillGroups.forsion.length },
        ...skillGroups.sources.filter((g) => g.items.length || g.source.origin === 'builtin').map((g) => ({ id: g.source.id, label: g.source.title, n: g.visible.length }))]
        .map((x) => <button key={x.id} type="button" className="mk-filter-chip" aria-pressed={skillFilter === x.id} data-market-source-chip={x.id} onClick={() => setSkillFilter(x.id)}>{x.label}<small>{x.n}</small></button>)}
    </div>
  )
  /** 一个分区:标题 + 说明 + 前几张卡 +「查看全部」(切到只看这一个来源)。 */
  const skillSection = (key: string, title: string, desc: string, cards: MarketCard[], extra?: ReactNode) => (
    <div key={key} className="mk-src-section" data-market-section={key}>
      <div className="mk-src-section-head"><b>{title}</b><span>{desc}</span>
        {cards.length > SECTION_CARDS && <button type="button" className="mk-src-section-more" data-market-section-more={key} onClick={() => setSkillFilter(key)}>{t('market.section.more', { n: cards.length })}<ArrowRight size={13} /></button>}
      </div>
      {extra}
      {cards.length > 0 && <div className="mk-grid">{cards.slice(0, SECTION_CARDS).map((item) => card(item))}</div>}
    </div>
  )
  const skillBody = () => {
    if (scanning && !catalog.length) return <Skeleton variant="list" />
    // 搜索 / 只看一个来源:一张网格,Forsion 在前
    if (query.trim() || skillFilter !== 'all') return skillMixed.length ? <div className="mk-grid">{skillMixed.map((item) => card(item))}</div> : catalogState([])
    const parts: ReactNode[] = []
    if (skillGroups.forsion.length || !skillGroups.sources.length) parts.push(skillSection('forsion', 'Forsion', t('market.section.forsionDesc', { n: skillGroups.forsion.length }), skillGroups.forsion))
    for (const g of skillGroups.sources) {
      const builtin = g.source.origin === 'builtin'
      const desc = t(builtin ? 'market.section.builtinDesc' : 'market.section.sourceDesc', { n: g.visible.length })
      const stale = g.cat?.stale && g.cat.fetchedAt ? <p className="mk-src-note">{t('market.sources.stale', { time: formatDate(new Date(g.cat.fetchedAt).toISOString()) })}</p> : null
      if (g.visible.length) parts.push(skillSection(g.source.id, g.source.title, desc, g.visible, stale))
      // 读不到(新客户端 × 老服务器 404、断网)且没有副本:写明稍后再试,不当成空,也不动装着的
      // 读不到时不写「0 项」
      else if (builtin && !g.items.length) parts.push(skillSection(g.source.id, g.source.title, t('market.section.builtinDescPlain'), [], g.cat?.error || (!g.cat && !srcCatsLoading)
        ? <div className="mk-src-unavailable" data-market-builtin-unavailable><span>{t('market.section.builtinUnavailable')}</span><button className="btn sm" onClick={() => void loadSourceCats(true)}><RefreshCw size={13} />{t('market.retry')}</button></div>
        : <Skeleton variant="list" />))
    }
    return parts.length ? parts : catalogState([])
  }

  const showSearch = !storeOnly && !detail && !storeView && tab !== 'submit'
  const showSort = !storeOnly && !detail && !storeView && !activeSource && tab !== 'submit' && tab !== 'webapp' && tab !== 'connector'
  /** 左栏高亮:开着插件页时内置入口都不亮。 */
  const navTab: Tab | null = storeView || activeSource ? null : tab
  const openStoreView = (key: string): void => { setStoreViewKey(key); setSourceKey(null); setDetail(null); setQuery('') }
  const openSource = (id: string): void => {
    setSourceKey(id); setStoreViewKey(null); setDetail(null); setQuery(''); setTagFilter(''); setSourceCat(null)
    void loadSource(id)
  }
  const sourcePlugin = activeSource?.pluginId ? plugins.find((p) => p.id === activeSource.pluginId) : undefined
  const onToggleSource = (on: boolean): void => {
    if (!activeSource) return
    void window.tangu?.marketSourcesSetDisabled?.(activeSource.id, !on).then(() => sources.reload()).then(() => { if (on) void loadSource(activeSource.id) })
      .catch((e) => toast(sourceErrorText(e, t) ?? String(e?.message || e), true))
  }
  const onRemoveSource = (): void => {
    if (!activeSource || !window.confirm(t('market.sources.removeConfirm', { name: activeSource.title }))) return
    void window.tangu?.marketSourcesRemove?.(activeSource.id).then(() => { setSourceKey(null); return sources.reload() })
      .catch((e) => toast(sourceErrorText(e, t) ?? String(e?.message || e), true))
  }
  const detailSource = detail ? sourceOf(detail) : undefined
  const noticePlugin = notice?.deps ? plugins.find((p) => p.id === notice.deps) : undefined
  const detailPlugin = detail ? installedPlugin(detail) : undefined
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
          {!storeOnly && <>
          <div className="settings-nav-group"><div className="settings-nav-grouphead">{t('market.group.discover')}</div><button className={navTab === 'discover' ? 'active' : ''} onClick={() => switchTab('discover')}><Compass size={15} />{navLabel.discover}</button></div>
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.categories')}</div>
            {categoryTabs.map((id) => <button key={id} className={navTab === id ? 'active' : ''} onClick={() => switchTab(id)}><TypeGlyph type={id as MarketType | 'webapp' | 'connector'} size={15} />{navLabel[id]}</button>)}
          </div>
          {sources.supported && <SourceNavGroup sources={sources.sources} activeId={sourceKey} onOpen={openSource}
            onAdded={(s) => { toast(t('market.sources.added', { name: s.title })); void sources.reload().then(() => openSource(s.id)) }} onError={(text) => toast(text, true)} />}
          </>}
          {storeGroups.map((g) => (
            <div key={g.label} className="settings-nav-group" data-store-group>
              <div className="settings-nav-grouphead">{g.label}</div>
              {g.views.map((o) => { const Icon = storeViewIcon(o.item.icon); const key = storeViewKeyOf(o); return <button key={key} data-store-view={key} className={storeView && storeViewKeyOf(storeView) === key ? 'active' : ''} onClick={() => openStoreView(key)}><Icon size={15} />{resolveText(o.item.title)}</button> })}
            </div>
          ))}
          <div className="settings-nav-group">
            <div className="settings-nav-grouphead">{t('market.group.manage')}</div>
            {!storeOnly && <button className={navTab === 'installed' ? 'active' : ''} onClick={() => switchTab('installed')}><Library size={15} />{navLabel.installed}</button>}
            {!storeOnly && <button className={navTab === 'updates' ? 'active' : ''} onClick={() => switchTab('updates')}><RefreshCw size={15} />{navLabel.updates}{allUpdatable.length > 0 && <span className="mk-nav-count">{allUpdatable.length}</span>}</button>}
            {/* Extend 的投稿页同时挂在市场与云端设置中;旧包仍可打开网页个人中心。 */}
            {(!!submissionView || !!window.tangu?.openAccountCenter) && <button className={navTab === 'submit' ? 'active' : ''} onClick={() => switchTab('submit')}><Send size={15} />{navLabel.submit}</button>}
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-main-head mk-main-head">
          <div className="mk-title-block"><div className="settings-main-title">{detail ? detail.name : activeSource ? activeSource.title : storeView ? resolveText(storeView.item.title) : navLabel[tab]}</div><div className="mk-title-subtitle">{detail ? t('market.detailSubtitle') : activeSource ? [t(activeSource.origin === 'builtin' ? 'market.sources.builtinSubtitle' : 'market.sources.subtitle', { n: visibleSource.length }), sourcePlugin ? t('market.sources.byPlugin', { name: pluginDisplayName(sourcePlugin, locale) }) : ''].filter(Boolean).join(' · ') : storeView ? resolveText(storeView.item.description) : tab === 'discover' ? t('market.subtitle') : tab === 'submit' ? t('market.submissionsDescription') : `${tab === 'plugin' ? t('market.pluginsSubtitle') : tab === 'connector' ? t('connectors.subtitle') : t('market.sectionSubtitle', { section: navLabel[tab] })}${tab === 'webapp' ? '' : ` · ${t('market.resultCount', { n: skillSectioned ? skillCount : visibleCatalog.length })}`}`}</div></div>
          {showSearch && <label className="mk-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('market.searchPlaceholder')} />{query && <button onClick={() => setQuery('')} aria-label={t('market.clearSearch')}>×</button>}</label>}
          {showSort && <label className="mk-sort"><span>{t('market.sort.label')}</span><select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}><option value="popular">{t('market.sort.popular')}</option><option value="latest">{t('market.sort.latest')}</option><option value="name">{t('market.sort.name')}</option></select></label>}
        </div>

        {notice && (
          <div className={`mk-notice${notice.error ? ' is-error' : ''}${noticePlugin ? ' has-action' : ''}`} role={notice.error ? 'alert' : 'status'} data-market-notice={notice.error ? 'error' : 'ok'}>
            {notice.error ? <AlertCircle size={15} /> : <Check size={15} />}
            <div className="mk-notice-body"><span>{notice.text}</span>{notice.hint && <small>{notice.hint}</small>}</div>
            {noticePlugin && depsBtn(noticePlugin)}
            {notice.restart && <button className="btn sm primary" data-market-restart disabled={notice.restart === 'running'} onClick={() => void onRestartBackend()}>{notice.restart === 'running' ? t('market.backendRestarting') : t('market.restartBackend')}</button>}
            <button className="mk-notice-close" onClick={() => setNotice(null)} aria-label={t('common.close')}><X size={13} /></button>
          </div>
        )}

        <PanelNotice />
        {asking?.kind === 'agent' && <AgentUninstallDialog slug={asking.slug} name={asking.c.name} onClose={() => setAsking(null)} onDone={() => void afterDialogUninstall(asking.c, 'agent', asking.slug)} />}
        {asking?.kind === 'skill' && <SkillUninstallDialog skillKey={asking.key} name={asking.c.name} onClose={() => setAsking(null)} onDone={() => void afterDialogUninstall(asking.c, 'skill', asking.slug)} />}
        {asking?.kind === 'plugin' && <PluginUninstallDialog name={asking.c.name} warning={asking.warning} onClose={() => setAsking(null)}
          onConfirm={(opts) => { const a = asking; void uninstallEnginePlugin(a.id, a.c.name, opts, a.c.id).then((ok) => { if (ok) return afterDialogUninstall(a.c, 'plugin', a.c.installSlug) }) }} />}
        {asking?.kind === 'amadeus-plugin' && <PluginUninstallDialog name={asking.c.name} warning={asking.warning} vaultFolder={pluginVaultFolder(asking.plugin.id, asking.plugin.name)} cloudData={pluginDataSyncOn(asking.plugin)}
          skills={asking.plugin.bundle?.skills.length ?? 0} agents={asking.plugin.bundle?.agents ?? []} superseded={asking.plugin.supersedes} onClose={() => setAsking(null)}
          onConfirm={(opts) => { const a = asking; void uninstallForsionPlugin(a.plugin, a.c.name, opts, { engine: true, storeItemId: a.c.id }).then((ok) => { if (ok) return afterDialogUninstall(a.c, 'amadeus-plugin', a.c.installSlug) }) }} />}

        {!storeOnly && !detail && !detailLoading && !storeView && (!!activeSource || tab !== 'connector') && <div className={`mk-upgrade-filters${skillSectioned ? ' has-src-chips' : ''}`}>
          {skillSectioned && <>{skillChips()}<span className="mk-src-divider" aria-hidden="true" /></>}
          {(!activeSource || (sourceCards.length > 0 && !activeSource.disabled)) && <label className="mk-filter-pill"><span>{t('market.tagLabel')}</span><select aria-label={t('market.tagLabel')} value={tagFilter} onChange={e => setTagFilter(e.target.value)}><option value="">{t('market.tagAllShort')}</option>{[...new Set((activeSource ? sourceCards : skillSectioned ? [...catalog, ...sourceSkillGroups.flatMap((g) => g.items)] : catalog).flatMap(c => shownTags(c)))].sort().map(tag => <option key={tag} value={tag}>{tag}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>}
          {activeSource ? <SourceInfoRow source={activeSource} catalog={sourceCat} pluginName={sourcePlugin ? pluginDisplayName(sourcePlugin, locale) : undefined} onRefresh={() => void loadSource(activeSource.id, true)} onToggle={onToggleSource} onRemove={onRemoveSource} /> : <>
          <button type="button" className="mk-filter-chip" aria-pressed={compatibleOnly} data-market-compat-filter onClick={() => setCompatibleOnly(!compatibleOnly)}><Check size={13} aria-hidden="true" />{t('market.compatibleOnly')}</button>
          <span className="mk-filter-version">Forsion {appVersion}</span>
          </>}
        </div>}
        <div className="settings-body mk-body">
          {detail ? (
            <div className="mk-detail">
              <button className="settings-back mk-detail-back" onClick={() => setDetail(null)}><ArrowLeft size={14} />{t('market.detailBack')}</button>
              <div className="mk-detail-hero"><div className="mk-detail-icon"><ItemIcon url={detail.iconUrl} type={detail.type} size={36} /></div><div className="mk-detail-intro"><span className="mk-detail-kind">{kindLabel[detail.type]}{!!requirementText(detail.collected, t) && <span className="mk-tier"> · {requirementText(detail.collected, t)}</span>}</span><h2>{detail.name}</h2><p>{detail.summary || t('market.summaryFallback')}</p><div className="mk-detail-byline">{!!detail.author && <>{t('market.author')} {detail.author} </>}<PublisherChip label={publisher(detail)} id={detail.id} />{!isSourceCardId(detail.id) ? <><span aria-hidden="true"> · </span>{t('market.downloads', { n: detail.downloads })}</> : isBuiltinCard(detail) && detail.collected ? <><span aria-hidden="true"> · </span>{t('market.count.installsLong', { n: compactCount(detail.downloads, locale) })}</> : null}</div></div></div>
              <div className="mk-detail-layout">
                <main className="mk-detail-main"><nav className="mk-detail-tabs" aria-label={t('market.viewDetails')}>{(isSourceCardId(detail.id) ? ['overview', ...(detail.collected?.adapted || detail.adapt ? ['adapt'] : []), 'versions'] : ['overview', 'comments', 'versions']).map(tab => <button key={tab} className={`btn sm ghost ${detailTab === tab ? 'active' : ''}`} aria-pressed={detailTab === tab} data-market-detail-tab={tab} onClick={() => setDetailTab(tab)}>{tab === 'adapt' ? t('market.adapt.tab') : t(`market.${tab}`)}</button>)}</nav>
                  {detailTab === 'adapt' && detail.collected ? <AdaptationTab c={detail.collected} adapt={detail.adapt} prereqNames={Object.fromEntries((detail.prereqs ?? []).map((p) => [p.itemId, p.name]))} /> : detailTab === 'comments' ? <MarketDiscussion key={detail.id} item={detail} /> : detailTab === 'versions' ? <MarketVersions key={detail.id} item={detail} appVersion={appVersion} installing={!!installing[detail.id]} onInstall={version => void onInstall(detail, version)} installedVersion={installedEntry(detail)?.version} pinnedVersion={updateItem(detail)?.pinnedVersion} kept={keptOf(detail)} onRollback={version => void onRollback(detail, version)} /> : <><div className="mk-detail-section-title">{t('market.overview')}</div>{!!shownTags(detail).length && <div className="mk-tags">{shownTags(detail).map(tag => <span key={tag}>{tag}</span>)}</div>}{detail.description && <p className="mk-description">{detail.description}</p>}<div className="mk-readme md-body">{detail.readme ? <Markdown content={splitFrontmatter(detail.readme).body} /> : <span className="mk-muted">{t('market.readmeEmpty')}</span>}</div></>}
                </main>
                <aside className="mk-detail-sidebar">
                  <div className="mk-detail-actions">{confirming === detail.id && isSourceCardId(detail.id) && (!isInstalled(detail) || !!scriptsConfirm(detail))
                    ? <SourceConfirm sourceTitle={detail.origin?.sourceTitle ?? ''} kindLabel={kindLabel[detail.type]} code={CODE_TYPES.has(detail.type)} first={!isInstalled(detail) && !detailSource?.trusted} busy={trusting || !!installing[detail.id]} onCancel={() => setConfirming(null)} onConfirm={() => void onConfirmSourceInstall(detail)}
                      scripts={scriptsConfirm(detail) ? <ScriptsConfirmText steps={scriptsConfirm(detail)!.items} collected={detail.collected} sourceTitle={isBuiltinCard(detail) ? undefined : detail.origin?.sourceTitle} /> : undefined} />
                    : installBtn(detail, 'mk-wide-btn')}{uninstallBtn(detail, true)}{canOpenSettings(detail) && <button className="btn sm mk-wide-btn" onClick={() => openPluginSettings(detail)}><Settings size={13} />{t('market.openSettings')}</button>}{versionBlock(detail)}</div>
                  {detailPlugin && <RequiredPlugins p={detailPlugin} store={depsStore(detailPlugin)} />}
                  {detail.type === 'skill' && !isInstalled(detail) && <SkillAgentPicker hint agents={skillAgents} choice={skillChoice[detail.id] ?? null} disabled={!!installing[detail.id]} onChange={(next) => setSkillChoice((m) => ({ ...m, [detail.id]: next }))} />}
                  {isBuiltinCard(detail) && detail.collected && <CollectedNeeds c={detail.collected} />}
                  {isBuiltinCard(detail) ? <CollectedTrustRow /> : isSourceCardId(detail.id) ? <SourceTrustRow sourceTitle={detail.origin?.sourceTitle ?? ''} /> : <div className="mk-trust-row"><ShieldCheck size={17} /><div><strong>{t('market.reviewed')}</strong><span>{t('market.reviewedHint')}</span></div></div>}
                  <MarketRequirements item={detail} version={appVersion} /><dl className="mk-facts"><div><dt>{t('market.forsionVersion')}</dt><dd>{requirementsText(detail)}</dd></div>{!isBuiltinCard(detail) && <div><dt>ID</dt><dd className="mk-id-value">{detail.id}<button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(detail.id)}>{t('market.copyId')}</button></dd></div>}{!!detail.platforms?.length && <div><dt>{t('market.platform')}</dt><dd>{detail.platforms.join(' · ')}</dd></div>}<div><dt>{t('market.type')}</dt><dd>{kindLabel[detail.type]}</dd></div>{!isBuiltinCard(detail) && <div><dt>{t('market.version')}</dt><dd>{detail.latestVersion ? `v${detail.latestVersion}` : t('market.unknown')}</dd></div>}{isDesktopOnlyItem(detail) && <div><dt>{t('market.platform')}</dt><dd>{t('market.desktopOnly')}</dd></div>}{!!entitlementLabel(detail) && <div data-market-entitlement-fact={detail.id}><dt>{t('market.access')}</dt><dd title={t('market.requiresHint')}>{entitlementLabel(detail)}</dd></div>}{networkOf(detail).length > 0 && <div data-market-network={detail.id}><dt>{t('market.network')}</dt><dd className="mk-id-value">{networkOf(detail).join(t('common.listSep'))}</dd></div>}{capsOf(detail).length > 0 && <div data-market-capabilities={detail.id}><dt>{t('market.capabilities')}</dt><dd>{capsOf(detail).join(t('common.listSep'))}</dd></div>}<div><dt>{t('market.source')}</dt><dd>{isSourceCardId(detail.id) && detail.origin ? t('market.sources.factSource', { name: detail.origin.sourceTitle, kind: detail.source === 'github' ? 'GitHub' : detail.source === 'npm' ? 'npm' : t('market.sources.kind.url') }) : detail.source === 'github' ? 'GitHub' : detail.source === 'npm' ? 'npm' : t('market.sourceUpload')}</dd></div>{detailSource && detailSource.origin !== 'builtin' && <div data-store-source-address><dt>{t('market.sources.factAddress')}</dt><dd className="mk-id-value">{detailSource.uri.replace(/^https?:\/\//, '')}</dd></div>}{!!formatDate(detail.updatedAt || detail.createdAt) && <div><dt>{t('market.updated')}</dt><dd>{formatDate(detail.updatedAt || detail.createdAt)}</dd></div>}{isBuiltinCard(detail) && detail.collected && <CollectedFacts c={detail.collected} commit={detail.commit} updatedAt={detail.updatedAt} />}{gone(detail) && <div data-market-upstream-deleted-fact><dt>{t('market.upstreamDeleted')}</dt><dd>{t('market.upstreamDeletedHint')}</dd></div>}</dl>
                  {detail.npmPackage && <a className="mk-repo-link" href={`https://www.npmjs.com/package/${encodeURIComponent(detail.npmPackage)}`} target="_blank" rel="noreferrer"><Package size={14} />{detail.npmPackage}<ExternalLink size={12} /></a>}
                  {detail.githubRepoUrl && <a className="mk-repo-link" href={detail.githubRepoUrl} target="_blank" rel="noreferrer"><GitBranch size={14} />{t('market.openRepo')}<ExternalLink size={12} /></a>}
                  {isBuiltinCard(detail) && detail.collected?.pageUrl && <SkillsShLink url={detail.collected.pageUrl} />}
                </aside>
              </div>
            </div>
          ) : detailLoading ? <Skeleton variant="document" />
            : activeSource ? (
              <section className="mk-section" data-store-source-page={activeSource.id}>
                {activeSource.disabled ? <SourceState kind="disabled" onEnable={() => onToggleSource(true)} />
                  : sourceLoading && !sourceCards.length ? <Skeleton variant="list" />
                  : sourceCat?.error && !sourceCards.length && needsSignIn(sourceCat.error) ? <SourceState kind="signin" onRetry={() => void loadSource(activeSource.id, true)} />
                  : sourceCat?.error && !sourceCards.length ? <SourceState kind="error" error={sourceCat.error} builtin={activeSource.origin === 'builtin'} onRetry={() => void loadSource(activeSource.id, true)} />
                  : !sourceCards.length ? <SourceState kind="empty" />
                  : <>
                    {sourceCat?.truncated && <p className="mk-src-note">{t('market.sources.truncated')}</p>}
                    {visibleSource.length ? <div className="mk-grid">{visibleSource.map((item) => card(item))}</div>
                      : <div className="mk-state-card"><Search size={28} /><strong>{t('market.noResults')}</strong><span>{t('market.noResultsHint')}</span><button className="btn sm" onClick={() => { setQuery(''); setTagFilter('') }}>{t('market.clearSearch')}</button></div>}
                  </>}
              </section>
            )
            : storeView ? <PluginSettingsView key={storeViewKeyOf(storeView)} pluginId={storeView.pluginId} def={storeView.item} bare />
            : tab === 'discover' ? (
              scanning ? <Skeleton variant="document" /> : catalogError && catalog.length === 0 ? catalogState([]) : query ? (
                <section className="mk-section"><div className="mk-section-head"><div><h2>{t('market.searchResults')}</h2><p>{t('market.resultCount', { n: visibleCatalog.length + sourceSearchHits.length })}</p></div></div>{catalogState([...forsionFirst(visibleCatalog), ...sourceSearchHits])}</section>
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
            ) : tab === 'connector' ? (
              <ConnectorStore query={query} onNotice={setNotice} />
            ) : tab === 'submit' ? (submissionView
              ? <PluginSettingsView pluginId={submissionView.pluginId} def={submissionView.item} bare />
              : <section className="mk-submit"><div className="mk-submit-copy"><span>{t('market.submitKicker')}</span><h2>{t('market.submitTitle')}</h2><p>{t('market.submitHint')}</p><button className="btn primary" onClick={() => void window.tangu?.openAccountCenter?.('submission')}><ExternalLink size={15} />{t('market.submitOpen')}</button></div><div className="mk-submit-art"><PackageOpen size={44} /><strong>{t('market.submitArtTitle')}</strong><span>{t('market.submitArtHint')}</span></div></section>
            ) : (
              <section className="mk-section">{/* 只有一个分区:页标题已说了是哪一类、计数在副标题里，不再画分区标题;「可更新」只留检查按钮 */}{tab === 'updates' && window.tangu?.marketCheckUpdates && <div className="mk-section-head mk-section-tools"><AutoUpdateAllRow state={pluginUpdates} onError={(text) => toast(text, true)}><button className="btn sm" disabled={pluginUpdates.checking} onClick={() => void window.tangu!.marketCheckUpdates!().then(() => Promise.all([scanCatalog(), loadSourceCats(true)])).catch((error) => toast(String(error?.message || error), true))}><RefreshCw size={14} />{t('market.autoUpdateCheck')}</button></AutoUpdateAllRow></div>}{tab === 'updates' && !scanning && allUpdatable.length === 0 && !query ? <div className="mk-state-card"><Check size={28} /><strong>{t('market.allUpToDate')}</strong><span>{t('market.allUpToDateHint')}</span></div> : skillSectioned ? skillBody() : catalogState(visibleCatalog)}</section>
            )}
        </div>
      </section>
    </div>
  )
}
