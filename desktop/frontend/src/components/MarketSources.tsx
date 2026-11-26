/**
 * 商店来源(第三方目录)在商店里的那几块:左栏「来源」分组 + 添加来源浮层、来源页顶上的信息行与菜单、
 * 详情页的信任栏与首装确认。数据与安装都在主进程(electron/storeSources.ts),规则见 shared/storeSources.ts;
 * 卡片、详情、安装按钮仍是 MarketModal 那一套(来源条目的卡片 id 是 `src_…`)。
 * 方案:docs/ToBeImproved/商店来源接口方案_2026-11-08(选 A)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle, Bot, Coins, Copy, Crown, Download, ExternalLink, GitBranch, Globe, Image as ImageIcon, Layers, Loader2, Lock, MoreHorizontal,
  LogIn, Package, Palette, Plus, Power, RefreshCw, ScanLine, ShieldAlert, Sparkles, Trash2, Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { OverlayAt } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { formatRelative } from '../format/time'
import { ContextMenu, type CtxMenu } from './RightPanel'
import type { StoreSourceCatalog, StoreSourceInfo, StoreSourceInstall } from '../../../shared/storeSources'
import './MarketSources.css'

registerMessages({
  'market.sources.group': { zh: '来源', en: 'Sources' },
  'market.sources.add': { zh: '添加来源', en: 'Add source' },
  'market.sources.addHint': {
    zh: '贴一个地址：GitHub 或 Forsion Git 仓库、npm 包，或 forsion-store.json 的链接。读得到目录才能添加。',
    en: 'Paste an address: a GitHub or Forsion Git repository, an npm package, or a link to a forsion-store.json file. It is added once its catalog can be read.',
  },
  'market.sources.addPlaceholder': { zh: 'github.com/作者/仓库', en: 'github.com/owner/repo' },
  'market.sources.addChecking': { zh: '正在读取目录…', en: 'Reading the catalog…' },
  'market.sources.addFound': { zh: '{kind} · {n} 项', en: '{kind} · {n} items' },
  'market.sources.addConfirm': { zh: '添加', en: 'Add' },
  'market.sources.added': { zh: '已添加来源「{name}」', en: 'Added the source "{name}"' },
  'market.sources.kind.github': { zh: 'GitHub', en: 'GitHub' },
  'market.sources.kind.npm': { zh: 'npm', en: 'npm' },
  'market.sources.kind.url': { zh: '链接', en: 'Link' },
  'market.sources.kind.forsion-git': { zh: 'Forsion Git', en: 'Forsion Git' },
  'market.sources.subtitle': { zh: '第三方来源 · 共 {n} 项内容', en: 'Third-party source · {n} items' },
  'market.sources.byPlugin': { zh: '由插件「{name}」提供', en: 'Added by the plugin "{name}"' },
  'market.sources.unreviewed': { zh: '未经 Forsion 审核', en: 'Not reviewed by Forsion' },
  'market.sources.synced': { zh: '{time}同步', en: 'Synced {time}' },
  'market.sources.stale': { zh: '没连上来源，显示的是 {time}的副本', en: 'Couldn\'t reach the source. Showing the copy from {time}' },
  'market.sources.truncated': { zh: '目录超过 1000 项，只显示前 1000 项。', en: 'The catalog has more than 1,000 items. Only the first 1,000 are shown.' },
  'market.sources.menu': { zh: '来源菜单', en: 'Source menu' },
  'market.sources.refresh': { zh: '立即同步', en: 'Sync now' },
  'market.sources.copy': { zh: '复制来源地址', en: 'Copy source address' },
  'market.sources.open': { zh: '在浏览器打开', en: 'Open in browser' },
  'market.sources.disable': { zh: '停用这个来源', en: 'Turn off this source' },
  'market.sources.enable': { zh: '启用这个来源', en: 'Turn on this source' },
  'market.sources.keepInstalled': { zh: '已装的保留', en: 'Installed items stay' },
  'market.sources.remove': { zh: '移除这个来源', en: 'Remove this source' },
  'market.sources.removeConfirm': {
    zh: '移除来源「{name}」？从它装的东西会留着，但不再更新。',
    en: 'Remove the source "{name}"? Items installed from it stay, but they won\'t be updated.',
  },
  'market.sources.disabledTitle': { zh: '这个来源已停用', en: 'This source is turned off' },
  'market.sources.disabledHint': { zh: '停用期间不显示它的内容。从它装的东西照常能用，但不再更新。', en: 'Its items are hidden while it\'s off. Items installed from it keep working, but they won\'t be updated.' },
  'market.sources.emptyTitle': { zh: '这个来源还没有内容', en: 'This source has no items yet' },
  'market.sources.emptyHint': { zh: '来源作者往目录里加了内容，这里就会出现。', en: 'Items appear here once the source\'s author adds them to the catalog.' },
  'market.sources.retry': { zh: '重试', en: 'Try again' },
  'market.sources.signinTitle': { zh: '登录后才能看这个来源', en: 'Sign in to see this source' },
  'market.sources.signinHint': {
    zh: '它在 Forsion Git 的私有仓库里，Forsion 用你的账号去读。只有你有读权限的仓库才读得到。',
    en: 'It\'s in a private repository on Forsion Git. Forsion reads it with your account, so only repositories you can read will open.',
  },
  'market.sources.signin': { zh: '登录 Forsion', en: 'Sign in to Forsion' },
  'market.sources.trustTitle': { zh: '未经 Forsion 审核', en: 'Not reviewed by Forsion' },
  'market.sources.trustHint': {
    zh: '来自第三方来源「{name}」。安装、更新、卸载仍由 Forsion 管，装进去的文件照常检查。',
    en: 'From the third-party source "{name}". Forsion still installs, updates and removes it, and checks its files as usual.',
  },
  'market.sources.factSource': { zh: '{name} · {kind}', en: '{name} · {kind}' },
  // 内置来源 skills.sh(2026-11-23):Forsion 运营,不能移除、能停用,不用「信任这个来源」
  'market.sources.builtinTail': { zh: '内置', en: 'Built-in' },
  'market.sources.builtinSubtitle': { zh: 'Forsion 每天从 skills.sh 收录 · 共 {n} 项内容', en: 'Collected by Forsion from skills.sh every day · {n} items' },
  'market.sources.builtinFlag': { zh: 'Forsion 收录 · 未经人工审核', en: 'Collected by Forsion · Not manually reviewed' },
  'market.sources.builtinUnavailable': { zh: 'skills.sh 的收录暂时读不到，稍后再试。', en: 'Couldn\'t load the skills.sh collection. Try again later.' },
  'market.sources.builtinOffHint': { zh: '停用后，技能分类和搜索里不再列出它的技能，对话里推荐到的也装不了；已经装的保留。', en: 'While it\'s off, its skills don\'t show in the skills category or search and can\'t be installed from chat. Installed skills stay.' },
  'market.sources.factAddress': { zh: '来源地址', en: 'Source address' },
})

import { sourceErrorText } from './marketSourceErrors'
export { SourceConfirm } from './MarketLabels'
export { sourceErrorText }

/** 没登录(或登录过期)读不了 Forsion Git:给登录引导,不当报错。 */
export const needsSignIn = (e: unknown): boolean => /forsion-git-signin\b/.test(typeof e === 'string' ? e : (e as { raw?: string })?.raw || (e as Error)?.message || String(e))
/** 走 Forsion 账号登录(Extend 提供;没装 Extend 时没有这个入口 → undefined)。 */
const forsionLogin = (): (() => Promise<unknown>) | undefined => { const login = window.tangu?.forsionLogin; return login ? () => login() : undefined }

/** 左栏图标:插件声明的图标词 → 图标;用户加的按种类。认不出回落 Package。 */
const ICONS: Record<string, typeof Package> = { image: ImageIcon, crown: Crown, coins: Coins, package: Package, sparkles: Sparkles, globe: Globe, palette: Palette, wrench: Wrench, bot: Bot, layers: Layers }
export function sourceIcon(s: Pick<StoreSourceInfo, 'icon' | 'kind'>): typeof Package {
  if (s.icon && Object.hasOwn(ICONS, s.icon)) return ICONS[s.icon]
  return s.kind === 'npm' ? Package : s.kind === 'url' ? Globe : GitBranch
}
const shortUri = (uri: string) => uri.replace(/^https?:\/\//, '')
export { CODE_TYPES } from '../services/marketCollected'

/** 来源表 + 来源装过的东西;主进程广播变化(插件开关在主窗、商店在独立浮窗)时重读。 */
export function useStoreSources() {
  const { locale } = useI18n()
  const supported = !!window.tangu?.marketSourcesList
  const [sources, setSources] = useState<StoreSourceInfo[]>([])
  const [installs, setInstalls] = useState<StoreSourceInstall[]>([])
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(async () => {
    const tg = window.tangu
    if (!tg?.marketSourcesList) return
    const [s, i] = await Promise.all([tg.marketSourcesList(locale), tg.marketSourcesInstalls?.(locale) ?? Promise.resolve([])])
    setSources(s); setInstalls(i); setLoaded(true)
  }, [locale])
  useEffect(() => {
    void reload().catch((e) => console.warn('[store-sources] 读取来源失败', e))
    return window.tangu?.onMarketSourcesChanged?.(() => void reload().catch(() => {}))
  }, [reload])
  return { supported, sources, installs, loaded, reload }
}

/** 左栏「来源」分组:一个来源一条,分组标题旁的 + 是用户自己贴地址添加。 */
export function SourceNavGroup({ sources, activeId, onOpen, onAdded, onError }: {
  sources: StoreSourceInfo[]
  activeId: string | null
  onOpen: (id: string) => void
  onAdded: (s: StoreSourceInfo) => void
  onError: (text: string) => void
}) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <div className="settings-nav-group" data-store-sources>
      <div className="settings-nav-grouphead mk-src-head">
        <span>{t('market.sources.group')}</span>
        <button type="button" className={`mk-src-add${anchor ? ' is-open' : ''}`} data-store-source-add title={t('market.sources.add')} aria-label={t('market.sources.add')}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}><Plus size={13} /></button>
      </div>
      {sources.map((s) => {
        const Icon = sourceIcon(s)
        return (
          <button key={s.id} type="button" data-store-source={s.id} className={`${activeId === s.id ? 'active' : ''}${s.disabled ? ' mk-src-off' : ''}`.trim()} onClick={() => onOpen(s.id)}>
            <Icon size={15} />{s.title}{s.kind === 'forsion-git' && <span className="mk-src-lock"><Lock size={12} /></span>}{s.origin === 'builtin' && <span className="mk-src-tail">{t('market.sources.builtinTail')}</span>}
          </button>
        )
      })}
      {anchor && <AddSourcePopover anchor={anchor} onClose={() => setAnchor(null)} onAdded={(s) => { setAnchor(null); onAdded(s) }} onError={onError} />}
    </div>
  )
}

type Probe = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; title: string; kind: string; count: number; duplicate?: string } | { state: 'error'; text: string; signin?: boolean }

function AddSourcePopover({ anchor, onClose, onAdded, onError }: { anchor: DOMRect; onClose: () => void; onAdded: (s: StoreSourceInfo) => void; onError: (text: string) => void }) {
  const { t, locale } = useI18n()
  const [value, setValue] = useState('')
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const [adding, setAdding] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as Element)?.closest?.('[data-store-source-add]')) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  // 停手 600ms 读一次目录,先给一行预览再让人点「添加」
  useEffect(() => {
    const input = value.trim()
    const n = ++seq.current
    if (!input) { setProbe({ state: 'idle' }); return }
    setProbe({ state: 'checking' })
    const timer = setTimeout(() => {
      void window.tangu!.marketSourcesProbe!(input, locale)
        .then((r) => { if (n === seq.current) setProbe({ state: 'ok', title: r.title, kind: r.kind, count: r.count, duplicate: r.duplicate }) })
        .catch((e) => { if (n === seq.current) setProbe({ state: 'error', text: sourceErrorText(e, t) ?? String((e as Error)?.message || e), signin: needsSignIn(e) }) })
    }, 600)
    return () => clearTimeout(timer)
  }, [value, locale, t, attempt])
  const login = forsionLogin()
  const signIn = login && (async () => { try { await login() } catch { /* 取消或失败:留在原处 */ } setAttempt((x) => x + 1) })
  const submit = async (): Promise<void> => {
    if (probe.state !== 'ok' || probe.duplicate || adding) return
    setAdding(true)
    try { onAdded(await window.tangu!.marketSourcesAdd!(value.trim(), locale)) } catch (e) {
      const text = sourceErrorText(e, t) ?? String((e as Error)?.message || e)
      setProbe({ state: 'error', text }); onError(text)
    } finally { setAdding(false) }
  }
  const ready = probe.state === 'ok' && !probe.duplicate
  return createPortal(
    <OverlayAt className="mk-src-pop" x={anchor.right + 10} y={anchor.top - 6} innerRef={(el) => { box.current = el }} role="dialog" aria-label={t('market.sources.add')}>
      <h4>{t('market.sources.add')}</h4>
      <p>{t('market.sources.addHint')}</p>
      <label className="mk-search mk-src-input">
        <input autoFocus value={value} placeholder={t('market.sources.addPlaceholder')} spellCheck={false} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      </label>
      {probe.state === 'checking' && <div className="mk-src-probe is-muted"><Loader2 size={14} className="mk-spin" />{t('market.sources.addChecking')}</div>}
      {probe.state === 'ok' && (
        <div className="mk-src-probe" data-store-source-probe>
          <div className="mk-src-probe-icon"><GitBranch size={15} /></div>
          <div><b>{probe.title}</b><span>{probe.duplicate ? t('market.sources.err.duplicate') : t('market.sources.addFound', { kind: t(`market.sources.kind.${probe.kind}`), n: probe.count })}</span></div>
        </div>
      )}
      {probe.state === 'error' && (
        <div className="mk-src-probe is-error" data-store-source-probe-error>
          <AlertCircle size={14} /><span className="mk-src-probe-text">{probe.text}</span>
          {probe.signin && signIn && <button type="button" className="btn sm mk-src-signin" data-store-source-signin-btn onClick={() => void signIn()}><LogIn size={13} />{t('market.sources.signin')}</button>}
        </div>
      )}
      <div className="mk-src-acts">
        <button type="button" className="btn sm" onClick={onClose}>{t('market.sources.cancel')}</button>
        <button type="button" className="btn sm primary" disabled={!ready || adding} data-store-source-confirm onClick={() => void submit()}>
          {adding ? <Loader2 size={13} className="mk-spin" /> : null}{t('market.sources.addConfirm')}
        </button>
      </div>
    </OverlayAt>,
    document.body,
  )
}

/** 来源页顶上一行:未审核标记、来源地址、同步时间、⋯ 菜单。 */
export function SourceInfoRow({ source, catalog, pluginName, onRefresh, onToggle, onRemove }: {
  source: StoreSourceInfo
  catalog: StoreSourceCatalog | null
  pluginName?: string
  onRefresh: () => void
  onToggle: (on: boolean) => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const [menu, setMenu] = useState<CtxMenu>(null)
  const builtin = source.origin === 'builtin'
  const Kind = builtin ? Layers : source.kind === 'npm' ? Package : source.kind === 'url' ? Globe : GitBranch
  // 内置来源的地址是 Forsion 服务器上的目录接口;给人看、给人打开的是 skills.sh 本身
  const shown = builtin ? 'https://skills.sh' : source.uri
  const time = catalog?.fetchedAt ? formatRelative(catalog.fetchedAt) : ''
  const open = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.right - 220, y: r.bottom + 6, anchorTop: r.top,
      items: [
        { label: t('market.sources.refresh'), icon: <RefreshCw size={14} />, run: onRefresh, disabled: source.disabled },
        ...(builtin ? [] : [{ label: t('market.sources.copy'), icon: <Copy size={14} />, run: () => void navigator.clipboard.writeText(source.uri) }]),
        { label: t('market.sources.open'), icon: <ExternalLink size={14} />, run: () => { window.open(shown, '_blank', 'noopener') } },
        source.origin === 'user'
          ? { label: t('market.sources.remove'), icon: <Trash2 size={14} />, danger: true, separatorBefore: true, run: onRemove }
          : source.disabled
            ? { label: t('market.sources.enable'), icon: <Power size={14} />, separatorBefore: true, run: () => onToggle(true), detail: pluginName ? t('market.sources.byPlugin', { name: pluginName }) : undefined }
            : { label: t('market.sources.disable'), icon: <Power size={14} />, separatorBefore: true, run: () => onToggle(false), detail: builtin ? t('market.sources.builtinOffHint') : t('market.sources.keepInstalled') },
      ],
    })
  }
  return (
    <div className="mk-src-info" data-store-source-info={source.id}>
      <span className="mk-src-flag">{builtin ? <ScanLine size={13} /> : <ShieldAlert size={13} />}{builtin ? t('market.sources.builtinFlag') : t('market.sources.unreviewed')}</span>
      <a className="mk-src-url" href={shown} target="_blank" rel="noreferrer"><Kind size={12} />{shortUri(shown)}</a>
      {catalog?.stale && time ? <span className="mk-src-stale">{t('market.sources.stale', { time })}</span> : time ? <span>{t('market.sources.synced', { time })}</span> : null}
      <button type="button" className="mk-src-more" aria-label={t('market.sources.menu')} title={t('market.sources.menu')} onClick={open}><MoreHorizontal size={16} /></button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** 详情页信任栏:来源条目没过 Forsion 审核。 */
export function SourceTrustRow({ sourceTitle }: { sourceTitle: string }) {
  const { t } = useI18n()
  return <div className="mk-trust-row mk-src-trust" data-store-source-trust><ShieldAlert size={17} /><div><strong>{t('market.sources.trustTitle')}</strong><span>{t('market.sources.trustHint', { name: sourceTitle })}</span></div></div>
}

/** 首装确认:每个来源第一次装东西时,和每个会运行代码的条目第一次装时,在侧栏原地确认。 */

/** 来源页的空 / 停用 / 读不到 / 要登录状态卡。 */
export function SourceState({ kind, error, onRetry, onEnable, builtin }: { kind: 'disabled' | 'error' | 'empty' | 'signin'; error?: string; onRetry?: () => void; onEnable?: () => void; builtin?: boolean }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  if (kind === 'signin') {
    const login = forsionLogin()
    const signIn = login && (async () => { setBusy(true); try { await login() } catch { /* 取消或失败 */ } finally { setBusy(false) } onRetry?.() })
    return (
      <div className="mk-state-card" data-store-source-signin>
        <Lock size={28} /><strong>{t('market.sources.signinTitle')}</strong><span>{t('market.sources.signinHint')}</span>
        {signIn && <button className="btn sm primary" disabled={busy} data-store-source-signin-btn onClick={() => void signIn()}>{busy ? <Loader2 size={13} className="mk-spin" /> : <LogIn size={13} />}{t('market.sources.signin')}</button>}
      </div>
    )
  }
  if (kind === 'disabled') return <div className="mk-state-card"><Power size={28} /><strong>{t('market.sources.disabledTitle')}</strong><span>{t('market.sources.disabledHint')}</span>{onEnable && <button className="btn sm" onClick={onEnable}><Power size={13} />{t('market.sources.enable')}</button>}</div>
  if (kind === 'error') return <div className="mk-state-card"><AlertCircle size={28} /><strong>{builtin ? t('market.sources.builtinUnavailable') : (error && sourceErrorText(error, t)) || error}</strong>{onRetry && <button className="btn sm" onClick={onRetry}><RefreshCw size={13} />{t('market.sources.retry')}</button>}</div>
  return <div className="mk-state-card"><Package size={28} /><strong>{t('market.sources.emptyTitle')}</strong><span>{t('market.sources.emptyHint')}</span></div>
}
