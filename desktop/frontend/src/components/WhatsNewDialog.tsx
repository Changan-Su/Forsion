/**
 * What's new:两栏弹窗。左栏 = 版本列表(新 → 旧,含全部历史版本),右栏 = 那一版的官网更新文章(forsion.net/releases)。
 * 官网没有文章的版本、或官网连不上时,右栏显示打包进来的 CHANGELOG 那一节。
 *
 * 入口:① 检测到新版本时自动弹出(bootstrap,只在主窗);② 设置 → 关于「What's new」。
 * 设置是独立浮窗 —— 在那里点会经主进程转到主窗弹(window.tangu.openWhatsNew),不在设置窗里弹。
 * 方案页:docs/ToBeImproved/更新弹窗方案_2026-10-17/(用户选 B,并要求历史版本也能看)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { ArrowUpRight, X } from 'lucide-react'
import { renderPublicMarkdown } from '@amadeus-shared/publishing/publicMarkdown'
import { mountPublishedMedia } from '@amadeus-shared/publishing/mediaPlayer'
import { buildWhatsNewEntries, parseWebsiteReleases, WEBSITE_ORIGIN, WEBSITE_RELEASES_URL, websiteReleaseUrl, type WebsiteRelease, type WhatsNewEntry } from '../../../shared/websiteReleases'
import { APP_VERSION, changelogFor, changelogMarkdown } from '../changelog'
import { registerMessages, useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { POPUP_PRIORITY, usePopupTurn } from '../stores/popupQueue'
import { Markdown } from './Markdown'
import { UpdateActions, UpdateSourceNote } from './UpdateActions'
import type { UpdaterStatusInfo } from '../types'
import './whatsNew.css'

registerMessages({
  'whatsNew.title': { zh: '更新内容', en: "What's new" },
  'whatsNew.updateTitle': { zh: 'Forsion {version} 已发布', en: 'Forsion {version} is out' },
  'whatsNew.current': { zh: '当前 {version}', en: 'Current {version}' },
  'whatsNew.groupNew': { zh: '新版本', en: 'New' },
  'whatsNew.groupHistory': { zh: '历史版本', en: 'Earlier versions' },
  'whatsNew.installed': { zh: '正在用', en: 'Installed' },
  'whatsNew.later': { zh: '稍后', en: 'Later' },
  'whatsNew.skip': { zh: '跳过这个版本', en: 'Skip this version' },
  'whatsNew.close': { zh: '关闭', en: 'Close' },
  'whatsNew.onWebsite': { zh: '在官网查看', en: 'View on website' },
  'whatsNew.offline': { zh: '连不上 forsion.net，先显示更新日志。', en: "Couldn't reach forsion.net. Showing the changelog instead." },
  'whatsNew.loading': { zh: '正在加载…', en: 'Loading…' },
  'whatsNew.open': { zh: '更新内容', en: "What's new" },
})

const SKIP_KEY = 'forsion_update_skipped_version'
const shownThisRun = new Set<string>()

// status:bootstrap 收到的每一次更新状态都记在这里,弹窗直接读(触发弹出的那次广播在弹窗挂载之前就到了)
const useWhatsNew = create<{ open: boolean; status: UpdaterStatusInfo }>(() => ({ open: false, status: { phase: 'idle' } }))

/** 打开 What's new。主窗以外(设置浮窗等)转到主窗弹。 */
export function openWhatsNew(): void {
  if (windowKind() !== 'main' && window.tangu?.openWhatsNew) { window.tangu.openWhatsNew(); return }
  useWhatsNew.setState({ open: true })
}

/**
 * 检测到新版本时要不要自动弹:只在主窗;点过「跳过这个版本」的不弹;同一次运行里每个版本只弹一次
 * (6 小时定时检查 / 唤醒检查不重复打扰)。「稍后」= 下次启动再提醒。
 */
export function maybeAutoOpenWhatsNew(st: UpdaterStatusInfo): void {
  useWhatsNew.setState({ status: st })
  if ((st.phase !== 'available' && st.phase !== 'downloaded') || !st.version || windowKind() !== 'main') return
  if (shownThisRun.has(st.version)) return
  try { if (localStorage.getItem(SKIP_KEY) === st.version) return } catch { /* 读不到就照常弹 */ }
  shownThisRun.add(st.version)
  useWhatsNew.setState({ open: true })
}

export function WhatsNewHost() {
  const open = useWhatsNew((s) => s.open)
  // 排队:协议更新 / 插件公告正在显示时等它关了再出(stores/popupQueue)
  const turn = usePopupTurn('whatsNew', open, POPUP_PRIORITY.whatsNew)
  useEffect(() => window.tangu?.onOpenWhatsNew?.(() => useWhatsNew.setState({ open: true })), [])
  return turn ? <WhatsNewDialog onClose={() => useWhatsNew.setState({ open: false })} /> : null
}

async function loadWebsiteReleases(): Promise<WebsiteRelease[] | null> {
  if (window.tangu?.getWebsiteReleases) return window.tangu.getWebsiteReleases().catch(() => null)
  try { // 网页版 / 手机:直接拉(服务端按来源回 CORS 头)
    const res = await fetch(WEBSITE_RELEASES_URL, { signal: AbortSignal.timeout(10_000) })
    return res.ok ? parseWebsiteReleases(await res.json()) : null
  } catch { return null }
}

function openLink(url: string): void {
  if (window.tangu?.openExternal) void window.tangu.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

function WhatsNewDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n()
  const lang = locale === 'en' ? 'en' : 'zh'
  const [website, setWebsite] = useState<WebsiteRelease[] | null | undefined>(undefined) // undefined = 加载中
  const upd = useWhatsNew((s) => s.status)
  const [installed, setInstalled] = useState(APP_VERSION)
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void loadWebsiteReleases().then((list) => { if (alive) setWebsite(list) })
    void window.tangu?.appVersion?.().then((v) => { if (alive && v) setInstalled(v) }).catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasUpdate = (upd.phase === 'available' || upd.phase === 'downloading' || upd.phase === 'downloaded') && !!upd.version
  const entries = useMemo(() => buildWhatsNewEntries({
    website: website ?? null, changelog: changelogFor(locale), installed, locale: lang,
    update: hasUpdate ? { version: upd.version, notes: (lang === 'en' && upd.releaseNotesEn) || upd.releaseNotes } : undefined,
  }), [website, locale, lang, installed, hasUpdate, upd.version, upd.releaseNotes, upd.releaseNotesEn])
  const current = entries.find((e) => e.version === picked) ?? entries[0]
  const fresh = entries.filter((e) => e.isNew), history = entries.filter((e) => !e.isNew)

  const skip = (): void => {
    try { if (upd.version) localStorage.setItem(SKIP_KEY, upd.version) } catch { /* ignore */ }
    onClose()
  }
  const item = (e: WhatsNewEntry) => (
    <button key={e.version} type="button" className={`wn-ver${e === current ? ' on' : ''}`} onClick={() => setPicked(e.version)} aria-current={e === current}>
      <span className="wn-ver-name">{e.displayVersion || e.version}{e.installed && <i>{t('whatsNew.installed')}</i>}</span>
      {(e.date || e.scope) && <small>{[e.date.replace(/-/g, '/'), e.scope?.split('\n')[0]].filter(Boolean).join(' · ')}</small>}
    </button>
  )

  return (
    <div className="u-backdrop wn-backdrop" onMouseDown={onClose}>
      <div className="modal wn-modal" role="dialog" aria-modal="true" aria-label={t('whatsNew.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wn-head">
          <b>{hasUpdate ? t('whatsNew.updateTitle', { version: upd.version! }) : t('whatsNew.title')}</b>
          <small>{t('whatsNew.current', { version: installed })}</small>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label={t('whatsNew.close')} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="wn-body">
          <nav className="wn-vers">
            {fresh.length > 0 && <div className="wn-group">{t('whatsNew.groupNew')}</div>}
            {fresh.map(item)}
            {history.length > 0 && <div className="wn-group">{t('whatsNew.groupHistory')}</div>}
            {history.map(item)}
          </nav>
          <div className="wn-scroll">
            {website === null && <div className="wn-note">{t('whatsNew.offline')}</div>}
            {current ? <WhatsNewArticle key={current.version} entry={current} /> : <div className="hint">{t('whatsNew.loading')}</div>}
          </div>
        </div>
        <div className="wn-foot">
          {current && <button type="button" className="btn ghost sm" onClick={() => openLink(current.markdown ? websiteReleaseUrl(current.version) : `${WEBSITE_ORIGIN}/releases/`)}>
            <ArrowUpRight size={12} /> {t('whatsNew.onWebsite')}
          </button>}
          <span className="grow" />
          {hasUpdate && <UpdateSourceNote upd={upd} />}
          {/* mac 点过「下载安装包」:下一步在浏览器和 Finder 里,这里只留关闭 */}
          {hasUpdate && upd.phase !== 'downloaded' && !upd.opened && <button type="button" className="btn ghost sm" onClick={skip}>{t('whatsNew.skip')}</button>}
          <button type="button" className="btn ghost sm" onClick={onClose}>{hasUpdate && !upd.opened ? t('whatsNew.later') : t('whatsNew.close')}</button>
          {hasUpdate && !upd.opened && <UpdateActions upd={upd} />}
        </div>
      </div>
    </div>
  )
}

function WhatsNewArticle({ entry }: { entry: WhatsNewEntry }) {
  const { locale } = useI18n()
  const lang = locale === 'en' ? 'en' : 'zh'
  const ref = useRef<HTMLDivElement>(null)
  const published = useMemo(() => entry.markdown
    ? renderPublicMarkdown(entry.markdown, { locale: lang, baseUrl: WEBSITE_ORIGIN, idPrefix: `wn-${entry.version.replace(/\./g, '-')}`, priorityFirstImage: true })
    : null, [entry.markdown, entry.version, lang])
  useEffect(() => (ref.current && published ? mountPublishedMedia(ref.current, lang) : undefined), [published, lang])
  // 正文里的链接一律去系统浏览器:在 Electron 里直接跟随会把整个窗口导航走。捕获阶段拦下并停止传播,
  // 免得回退正文(<Markdown> 的 ChatWebLink)自己再开一次(Codex 评审 P2)。
  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (!a || a.getAttribute('href')!.startsWith('#')) return
    e.preventDefault(); e.stopPropagation()
    openLink(a.href)
  }
  return (
    <article className="wn-article md-body" onClickCapture={onClick}>
      <div className="wn-kick">
        {entry.date && <span>{entry.date.replace(/-/g, '/')}</span>}
        {entry.scope && <i>{entry.scope.split('\n')[0]}</i>}
      </div>
      <h2 className="wn-title">{entry.displayVersion ? `Forsion ${entry.displayVersion}` : published?.title || `Forsion ${entry.version}`}</h2>
      {published ? <div ref={ref} className="amadeus-published" dangerouslySetInnerHTML={{ __html: published.html }} />
        : entry.lines ? <Markdown content={changelogMarkdown(entry.lines)} />
        : entry.notes ? <Markdown content={entry.notes} />
        : null}
    </article>
  )
}
