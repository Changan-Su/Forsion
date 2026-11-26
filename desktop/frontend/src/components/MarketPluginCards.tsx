import { compareMarketVersions } from '../../../shared/marketPluginUpdates'
import { useEffect, useState } from 'react'
import { Check, Download, Loader2, Puzzle } from 'lucide-react'
import type { MarketCard, MarketInstallProgress, ToolEvent } from '../types'
import { marketplaceCompatibility, marketplaceItemsOf, MARKETPLACE_RECOMMENDATION_TOOL } from '../../../shared/marketplace'
import { isSourceCardId, splitSourceCardId, type StoreSourceInfo } from '../../../shared/storeSources'
import { installMarket, listInstalled, onInstallProgress, installedMarketItem, type InstalledItem } from '../services/marketService'
import { ackOf, chatItemExtras, CODE_TYPES, confirmNeededOf, confirmOf, fetchPlanCards, installPlan, isBuiltinCard, publisherOf, type InstallStep } from '../services/marketCollected'
import { trackMarketInstall } from '../telemetryInstall'
// 安装后处理按需加载:它经 userSpaces 拉进 spaces.tsx(模块加载期读 window),静态导入会让所有引到聊天消息的 node 测试整文件挂掉。
const postInstall = () => import('../marketPostInstall')
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { MarketRequirements, marketPlatform, useMarketVersion } from './MarketRequirements'
import { SkillAgentPicker, applySkillAgentChoice, skillAgentsSupported, useSkillAgents, type SkillAgentChoice } from './MarketSkillAgents'
import { CountChip, PublisherChip, ScriptsConfirmText, SourceConfirm } from './MarketLabels'
import { sourceErrorText } from './marketSourceErrors'
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
  'market.cardSourceOff': { zh: '来源已停用', en: 'Source turned off' },
  'market.cardSourceOffHint': { zh: '在商店的来源菜单里打开它之后才能安装。', en: 'Turn it on in the store\'s sources menu to install.' },
})
const KIND_KEY: Record<string, string> = {
  skill: 'market.kind.skill', agent: 'market.kind.agent', plugin: 'market.kind.plugin', 'amadeus-plugin': 'market.kind.plugin', space: 'market.kind.space', theme: 'market.kind.theme',
}
type Ack = { scripts: number; audit: boolean }
/** A source item waiting for the user (first install from the source / code / scripts or an audit warning). */
interface PendingConfirm { id: string; steps: InstallStep[]; found: Record<string, Ack>; first: boolean; sourceId?: string; sourceTitle: string; card: MarketCard }

export const isMarketplaceTool = (event: ToolEvent) => event.name === MARKETPLACE_RECOMMENDATION_TOOL
export function openMarketItem(item: { id: string; name: string }, comments = false): void {
  if (window.tangu?.openFloatingPanel) void window.tangu.openFloatingPanel({ id: 'market', title: item.name, builtin: 'market', params: { itemId: item.id, detailTab: comments ? 'comments' : 'overview', nonce: Date.now() } })
  else useApp.getState().openMarket(undefined, { itemId: item.id, detailTab: comments ? 'comments' : 'overview', nonce: Date.now() })
}
/** entry = 匿名遥测里记的安装入口(对话里的插件卡 / Muse 卡);onInstalled = 装成之后(Muse 卡据此回写卡片结果)。 */
export function MarketPluginCards({ event, onDismiss, entry = 'chat-card', onInstalled }: { event: ToolEvent; onDismiss?: () => void; entry?: 'chat-card' | 'muse-card'; onInstalled?: (item: MarketCard) => void }) {
  const { t, locale } = useI18n()
  const version = useMarketVersion()
  const [installed, setInstalled] = useState<Record<string, InstalledItem[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<MarketInstallProgress | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [canReboot, setCanReboot] = useState(false)
  const [skillChoice, setSkillChoice] = useState<Record<string, SkillAgentChoice>>({})
  // 来自商店来源(含内置 skills.sh)的条目:本机的来源表(标签 / 停用 / 已移除)与各条完整卡片(前置、安装数)
  const [sources, setSources] = useState<StoreSourceInfo[] | null>(null)
  const [srcCards, setSrcCards] = useState<Record<string, MarketCard | null>>({})
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [trusting, setTrusting] = useState(false)
  const [prereqRun, setPrereqRun] = useState<{ name: string; n: number; total: number } | null>(null)
  const items = event.done && !event.isError ? marketplaceItemsOf(event.result) : []
  const srcKey = items.filter((i) => isSourceCardId(i.id)).map((i) => i.id).join(',')
  const skillAgents = useSkillAgents(items.some((i) => i.type === 'skill'))
  const refresh = () => listInstalled().then(setInstalled).catch(() => {})
  const loadSources = () => window.tangu?.marketSourcesList?.(locale).then(setSources).catch(() => {})
  useEffect(() => { void refresh(); const listener = () => { void refresh() }; window.addEventListener('focus', listener); window.addEventListener('forsion:extensions-changed', listener); const off = onInstallProgress(p => setProgress(p)); return () => { off(); window.removeEventListener('focus', listener); window.removeEventListener('forsion:extensions-changed', listener) } }, [])
  useEffect(() => {
    const getCard = window.tangu?.marketSourcesItem
    if (!srcKey || !getCard) return
    let live = true
    void loadSources()
    const fetchCard = (id: string) => getCard(id, locale).then((c) => c as unknown as MarketCard)
    for (const id of srcKey.split(',')) {
      void fetchCard(id).then(async (card) => {
        const more = await fetchPlanCards(card, fetchCard).catch(() => new Map<string, MarketCard>())
        if (live) setSrcCards((m) => ({ ...m, ...Object.fromEntries(more), [id]: card }))
      }).catch(() => { if (live) setSrcCards((m) => ({ ...m, [id]: null })) })
    }
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, locale])
  if (event.isError) return null
  if (!event.done) return <div className="mk-chat-search" role="status"><Loader2 size={14} className="spin" />{t('market.cardSearching')}</div>

  const skillInstalled = (slug: string): boolean => (installed.skill || []).some((x) => x.slug === slug)
  const sourceOf = (id: string): StoreSourceInfo | undefined => { const p = splitSourceCardId(id); return p ? sources?.find((s) => s.id === p.source) : undefined }

  /** One install through main; a source item says the type it expects and what the user confirmed for it. */
  const installOne = async (card: Pick<MarketCard, 'id' | 'type' | 'installSlug'>, ack: Ack | undefined, choice: SkillAgentChoice | null) => {
    const wasInstalled = !!installedMarketItem(card, installed)
    const result = await installMarket(card.id, undefined, isSourceCardId(card.id) ? { type: card.type, ...(ack ? { ack } : {}) } : undefined)
    // 技能:首次安装按卡上的「装给」写各 Agent;分配失败不算装失败,只提示
    if (result.type === 'skill' && !wasInstalled && skillAgentsSupported()) await applySkillAgentChoice(result.slug || card.installSlug, choice).catch((e) => setError(t('market.skillAgents.applyFailed', { e: e?.message || String(e) })))
    const post = await postInstall()
    const { restart } = await post.afterMarketInstall(result.type, result, wasInstalled, text => setError(text))
    return { result, restart, post }
  }

  /**
   * Install a card. Items from store sources take the store page's path: the full card from the source's catalog, its
   * prerequisites first (same source), and the confirmation the store page asks for (first install from the source, code,
   * scripts or an audit warning). `confirmed` = the user said yes to `acks`; main still refuses what it counts beyond them.
   */
  const install = async (item: MarketCard, opts: { confirmed?: boolean; acks?: Record<string, Ack>; found?: Record<string, Ack> } = {}) => {
    if (busy) return
    setBusy(item.id); setProgress(null); setError(''); setNotice(''); setConfirm(null)
    const wasInstalled = !!installedMarketItem(item, installed)
    let steps: InstallStep[] = [], missing: string[] = [], current = item.id
    let card: MarketCard = item, extra = new Map<string, MarketCard>(), src: StoreSourceInfo | undefined
    let tele: ReturnType<typeof trackMarketInstall> | null = null
    try {
      if (isSourceCardId(item.id)) {
        const getCard = window.tangu?.marketSourcesItem
        if (!getCard) throw new Error(t('market.cardUnavailable'))
        const fetchCard = (id: string) => getCard(id, locale).then((c) => c as unknown as MarketCard)
        const [full, list] = await Promise.all([fetchCard(item.id), window.tangu?.marketSourcesList?.(locale).catch(() => null) ?? null])
        card = full
        if (list) setSources(list)
        src = (list ?? sources ?? undefined)?.find((s) => s.id === splitSourceCardId(item.id)?.source)
        if (isBuiltinCard(card) && card.collected?.upstreamDeleted && !wasInstalled) throw new Error(t('market.upstreamDeletedHint'))
        extra = await fetchPlanCards(card, fetchCard)
        setSrcCards((m) => ({ ...m, ...Object.fromEntries(extra), [item.id]: card }))
        ;({ steps, missing } = installPlan(card, { installed: skillInstalled, lookup: (id) => extra.get(id) ?? null }))
        const found = opts.found ?? {}
        const scripts = confirmOf(steps, found)
        if (!opts.confirmed && !wasInstalled && (!src?.trusted || CODE_TYPES.has(card.type) || scripts)) {
          setConfirm({ id: item.id, steps, found, first: !src?.trusted, sourceId: src?.id, sourceTitle: src?.title || card.origin?.sourceTitle || '', card })
          return
        }
      }
      tele = trackMarketInstall(entry, item)
      const acks = opts.acks ?? {}
      const pre = steps.slice(0, -1)
      for (const [i, s] of pre.entries()) {
        current = s.id
        setPrereqRun({ name: s.name, n: i + 1, total: pre.length })
        await installOne({ id: s.id, type: s.type, installSlug: s.installSlug }, acks[s.id], null)
      }
      setPrereqRun(null)
      current = item.id
      const { result, restart, post } = await installOne(card, acks[item.id], skillChoice[item.id] ?? null)
      tele.done({ type: result.type, pluginId: result.id, restart })
      try { onInstalled?.(item) } catch { /* 回写失败不影响安装 */ }
      if (missing.length) setNotice(t('market.prereqMissing', { list: missing.join(t('common.listSep')) }))
      setCanReboot(post.canRestartBackend()); setNeedsRestart(restart); await refresh()
    } catch (e: any) {
      // 主进程在包里数到没确认过的脚本 / 审计警告:按它数出来的在卡上再问一次
      const need = confirmNeededOf(e)
      if (need && steps.length) {
        tele?.fail(e)
        const found = { ...opts.found, [current]: need }
        setConfirm({ id: item.id, steps, found, first: !src?.trusted && !opts.confirmed, sourceId: src?.id, sourceTitle: src?.title || card.origin?.sourceTitle || '', card })
      } else {
        tele?.fail(e)
        setError(sourceErrorText(e, t) ?? (e?.message || String(e)))
      }
      await refresh()
    } finally { setBusy(null); setProgress(null); setPrereqRun(null) }
  }
  const confirmInstall = async (item: MarketCard) => {
    const c = confirm
    if (!c) return
    setTrusting(true)
    try {
      if (c.first && c.sourceId) { await window.tangu?.marketSourcesTrust?.(c.sourceId); void loadSources() }
      // 确认的是确认块上写的那些:每一步按目录 + 主进程数出来的取大
      const acks = Object.fromEntries(c.steps.map((s) => [s.id, ackOf(s, c.found[s.id])]))
      setTrusting(false)
      await install(item, { confirmed: true, acks, found: c.found })
    } catch (e) { setError(sourceErrorText(e, t) ?? String((e as Error)?.message || e)) } finally { setTrusting(false) }
  }
  const reboot = async () => { if (!(await (await postInstall()).restartBackend())) setError(t('market.cardRestartFailed')); else setNeedsRestart(false) }
  return <div className="mk-chat-results" data-marketplace-cards={event.id}>
    {!items.length && <p className="mk-muted">{t('market.cardNoResults')}</p>}
    {items.map(raw => {
      const item = raw as MarketCard
      const extras = chatItemExtras(raw)
      const isSrc = isSourceCardId(item.id)
      const full = isSrc ? srcCards[item.id] ?? null : null
      const src = isSrc ? sourceOf(item.id) : undefined
      const label = publisherOf({ id: item.id, publisher: extras.publisher, origin: extras.origin ?? full?.origin }, isSrc && sources ? sources : undefined)
      const entry = installedMarketItem(item, installed)
      const done = !!entry
      const update = !!entry?.version && !!item.latestVersion && (compareMarketVersions(item.latestVersion, entry.version) || 0) > 0
      const state = marketplaceCompatibility(item, version, marketPlatform())
      const sourceOff = !!src?.disabled
      const gone = isSrc && !done && isBuiltinCard(item) && !!full?.collected?.upstreamDeleted
      const unavailable = !window.tangu?.marketInstall || (window.tangu?.marketTypes && !window.tangu.marketTypes.includes(item.type)) || state === 'version' || state === 'platform'
        || (isSrc && (!window.tangu?.marketSourcesItem || label.kind === 'removed'))
      const blocked = !!unavailable || sourceOff || gone
      const working = busy === item.id
      const p = working && progress?.id === item.id ? progress : null
      // 角上的数:Forsion 条目的下载数 / skills.sh 的安装数;第三方来源没有可比的数,写版本
      const count = isSrc ? (isBuiltinCard(item) ? full?.downloads ?? extras.downloads : undefined) : extras.downloads
      const pre = isSrc && full && !done ? installPlan(full, { installed: skillInstalled, lookup: (id) => srcCards[id] ?? null }).steps.length - 1 : 0
      const confirming = confirm?.id === item.id ? confirm : null
      const scripts = confirming ? confirmOf(confirming.steps, confirming.found) : null
      // 收录技能的版本是日期戳,不往按钮上写
      const idle = done && !update ? `${t('market.cardInstalled')}${entry?.version && !isBuiltinCard(item) ? ` v${entry.version}` : ''}`
        : unavailable ? t('market.cardUnavailable') : sourceOff ? t('market.cardSourceOff') : gone ? t('market.upstreamDeleted')
          : update ? t('market.update') : pre === 1 ? t('market.installWithPrereq') : pre > 1 ? t('market.installWithPrereqs', { n: pre }) : t('market.cardInstall')
      const busyText = prereqRun ? t('market.prereqInstalling', prereqRun)
        : p?.phase === 'download' && p.total ? `${Math.round((p.received || 0) / p.total * 100)}%` : t(p?.phase === 'install' ? 'market.installPhaseInstall' : 'market.installPhaseResolve')
      return <article key={item.id} className="mk-chat-card" data-marketplace-item={item.id}>
        <div className="mk-chat-card-top"><div className="mk-chat-icon"><Puzzle size={22} /></div><div><strong>{item.name}</strong>
          <span className="mk-chat-meta"><span className="mk-card-author">{item.author}</span><PublisherChip label={label} id={item.id} />
            {typeof count === 'number' && count > 0 ? <><span aria-hidden="true">·</span><CountChip c={{ downloads: count }} collected={isBuiltinCard(item)} /></>
              : item.latestVersion ? <><span aria-hidden="true">·</span><span>v{item.latestVersion}</span></> : null}
          </span></div><MarketRequirements item={item} version={version} /></div>
        <p>{item.summary || item.description}</p>
        {!!item.tags?.length && <div className="mk-tags">{item.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>}
        {confirming
          ? <div className="mk-chat-confirm" data-market-card-confirm={item.id}>
            <SourceConfirm sourceTitle={confirming.sourceTitle} kindLabel={t(KIND_KEY[item.type] ?? 'market.kind.plugin')} code={CODE_TYPES.has(item.type)} first={confirming.first} busy={trusting || working}
              onCancel={() => setConfirm(null)} onConfirm={() => void confirmInstall(item)}
              scripts={scripts ? <ScriptsConfirmText steps={scripts.items} collected={confirming.card.collected} sourceTitle={isBuiltinCard(item) ? undefined : confirming.sourceTitle} /> : undefined} />
          </div>
          : <div className="mk-chat-card-actions">{item.type === 'skill' && !done && !blocked && <SkillAgentPicker agents={skillAgents} choice={skillChoice[item.id] ?? null} disabled={!!busy} onChange={(next) => setSkillChoice((m) => ({ ...m, [item.id]: next }))} />}{onDismiss && <button className="btn sm ghost" data-market-card-dismiss={item.id} onClick={onDismiss}>{t('museCard.notInterested')}</button>}<button className="btn sm" onClick={() => openMarketItem(item)}>{t('market.cardDetails')}</button><button className={`btn sm ${done ? '' : 'primary'}`} disabled={!!busy || (done && !update) || blocked} title={sourceOff ? t('market.cardSourceOffHint') : gone ? t('market.upstreamDeletedHint') : undefined} onClick={() => void install(item)} data-market-card-install={item.id}>
            {working ? <Loader2 size={13} className="spin" /> : done ? <Check size={13} /> : <Download size={13} />}
            {working ? busyText : idle}
          </button></div>}
      </article>
    })}
    {notice && <p className="mk-muted" role="status">{notice}</p>}
    {error && <p className="mk-chat-error" role="alert">{error}</p>}
    {needsRestart && <div role="status">{t('market.cardRestart')}{canReboot && <button className="btn sm" onClick={() => void reboot()}>{t('market.restartBackend')}</button>}</div>}
  </div>
}
