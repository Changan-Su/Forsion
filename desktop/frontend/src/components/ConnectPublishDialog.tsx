/** Forsion Connect 发布对话框 —— 把 Coding Space 项目发布成 {cloud}/apps/<slug>/ 公开链接。
 *  真源在服务端(connect:list);项目根 .forsion-connect.json 记住 slug 供 republish 预填。
 *  登录态走桌面全局 Forsion 账号(auth.json),未登录时引导 device flow。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Loader2, X } from 'lucide-react'
import { useI18n } from '../i18n'

interface ConnectApp { slug: string; name: string; entry: string; status: string; total_bytes: number; updated_at?: string }
interface ListResp { ok: boolean; code?: string; detail?: string; base?: string; apps?: ConnectApp[]; used?: number; limit?: number; tier?: string; handle?: string | null }

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})?[a-z0-9]$/

// 首次发布须同意内容发布规范；一次同意后本机不再弹（localStorage 标记）。
// ponytail: 客户端闸满足「首次发布弹窗」需求；要服务端审计凭证再落库记录。
const TERMS_KEY = 'forsion_connect_terms_v1'
const hasAcceptedTerms = (): boolean => { try { return localStorage.getItem(TERMS_KEY) === '1' } catch { return false } }
const rememberTerms = (): void => { try { localStorage.setItem(TERMS_KEY, '1') } catch { /* ignore */ } }

function suggestSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
  if (s.length >= 3 && SLUG_RE.test(s)) return s
  const rand = Math.random().toString(36).slice(2, 6)
  return s ? `${s}-${rand}`.slice(0, 32) : `app-${rand}`
}

export function ConnectPublishDialog(props: {
  root: string
  projectName: string
  entry: string | null
  htmlFiles: string[]
  onClose: () => void
}) {
  const { t } = useI18n()
  const { root, projectName, htmlFiles, onClose } = props

  const [phase, setPhase] = useState<'loading' | 'login' | 'form'>('loading')
  const [busy, setBusy] = useState<'' | 'login' | 'publish' | 'unpublish'>('')
  const [err, setErr] = useState('')
  const [base, setBase] = useState('')
  const [handle, setHandle] = useState<string | null>(null)
  const [slots, setSlots] = useState<{ used: number; limit: number; tier: string } | null>(null)
  const [published, setPublished] = useState<ConnectApp | null>(null)
  const [name, setName] = useState(projectName)
  const [slug, setSlug] = useState('')
  const [entry, setEntry] = useState(props.entry || 'index.html')
  const [doneUrl, setDoneUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [termsChecked, setTermsChecked] = useState(false)
  const initialized = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    setErr('')
    const meta: { slug?: string } = (await window.tangu?.connectMeta?.(root).catch(() => ({}))) || {}
    let r: ListResp
    try {
      r = (await window.tangu?.connectList?.()) ?? { ok: false, code: 'error', detail: 'unavailable' }
    } catch (e) {
      r = { ok: false, code: 'error', detail: String((e as Error)?.message || e) }
    }
    if (!r.ok) {
      if (r.code === 'not_logged_in') { setPhase('login'); return }
      setErr(r.detail || 'error')
      setPhase('form')
      return
    }
    setBase(r.base || '')
    setHandle(r.handle || null)
    setSlots({ used: r.used ?? 0, limit: r.limit ?? 1, tier: r.tier || 'free' })
    const mine = (r.apps || []).find((a) => a.slug === meta.slug) || null
    setPublished(mine)
    // 表单只在首次载入时预填,后续刷新(发布后重载)不覆盖用户输入。
    if (!initialized.current) {
      initialized.current = true
      if (mine) {
        setName(mine.name)
        setSlug(mine.slug)
        if (mine.entry && (htmlFiles.length === 0 || htmlFiles.includes(mine.entry))) setEntry(mine.entry)
      } else {
        setSlug(meta.slug || suggestSlug(projectName))
      }
    }
    setPhase('form')
  }, [root, projectName, htmlFiles])

  useEffect(() => { void load() }, [load])

  // htmlFiles 异步到达（scanHtml 慢于云端列表）后校正 entry：当前 entry 不在列表里就改回 props.entry 或首个。
  // 否则会卡在不存在的入口上，发布稳定被服务端 400。
  useEffect(() => {
    if (htmlFiles.length && !htmlFiles.includes(entry)) {
      setEntry(props.entry && htmlFiles.includes(props.entry) ? props.entry : htmlFiles[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [htmlFiles])

  const login = async (): Promise<void> => {
    setBusy('login'); setErr('')
    try {
      await window.tangu?.forsionLogin?.()
      await load()
    } catch (e) {
      setErr((e as Error)?.message || String(e))
    } finally { setBusy('') }
  }

  // 首次发布先过内容规范同意闸；已同意直接发。
  const publish = (): void => {
    if (!hasAcceptedTerms()) { setTermsChecked(false); setShowTerms(true); return }
    void doPublish()
  }
  const confirmTerms = (): void => {
    if (!termsChecked) return
    rememberTerms(); setShowTerms(false); void doPublish()
  }

  const doPublish = async (): Promise<void> => {
    if (!window.tangu?.connectPublish) return
    setBusy('publish'); setErr(''); setDoneUrl(null)
    try {
      const r = await window.tangu.connectPublish({ dir: root, name: name.trim(), slug: slug.trim(), entry })
      if (!r.ok) {
        if (r.code === 'not_logged_in') { setPhase('login'); return }
        setErr(r.detail || 'error')
        return
      }
      setDoneUrl(r.url || null)
      await load()
    } catch (e) {
      setErr((e as Error)?.message || String(e))
    } finally { setBusy('') }
  }

  const unpublish = async (): Promise<void> => {
    if (!published || !window.tangu?.connectUnpublish) return
    if (!confirmDel) { setConfirmDel(true); return }
    setBusy('unpublish'); setErr(''); setConfirmDel(false)
    try {
      const r = await window.tangu.connectUnpublish(published.slug)
      if (!r.ok) { setErr(r.detail || 'error'); return }
      setDoneUrl(null)
      setPublished(null)
      await load()
    } catch (e) {
      setErr((e as Error)?.message || String(e))
    } finally { setBusy('') }
  }

  const publicUrl = doneUrl || (published && base && handle ? `${base}/apps/${handle}/${published.slug}/` : null)
  // ponytail: 内容发布规范暂指向服务条款页（含禁止内容条款）；有独立《内容发布规范》文档后改此一行。
  const guidelinesUrl = base ? `${base}/legal/?slug=terms` : ''
  const slugOk = SLUG_RE.test(slug) && slug.length >= 3
  const canPublish = phase === 'form' && !busy && slugOk && !!name.trim() && htmlFiles.length > 0 && htmlFiles.includes(entry)

  const copy = async (): Promise<void> => {
    if (!publicUrl) return
    try { await navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }

  return (
    <div className="csx-pub-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="csx-pub-card" role="dialog" aria-modal="true">
        <div className="csx-pub-head">
          <Globe size={15} />
          <span className="csx-pub-title">{showTerms ? t('coding.termsTitle') : t('coding.publishTitle')}</span>
          <button className="icon-btn" onClick={onClose} title="close"><X size={15} /></button>
        </div>

        {showTerms ? (
          <div className="csx-pub-terms">
            <p className="csx-pub-desc">{t('coding.termsIntro')}</p>
            <ul className="csx-pub-terms-list">
              <li>{t('coding.termsLi1')}</li>
              <li>{t('coding.termsLi2')}</li>
              <li>{t('coding.termsLi3')}</li>
            </ul>
            <p className="csx-pub-desc">{t('coding.termsManage')}</p>
            <label className="csx-pub-agree">
              <input type="checkbox" checked={termsChecked} onChange={(e) => setTermsChecked(e.target.checked)} />
              <span>
                {t('coding.termsAgreePre')}
                {guidelinesUrl
                  ? <a href={guidelinesUrl} target="_blank" rel="noreferrer">{t('coding.termsGuidelines')}</a>
                  : <strong>{t('coding.termsGuidelines')}</strong>}
              </span>
            </label>
            <div className="csx-pub-actions">
              <button className="csx-pub-ghost" onClick={() => setShowTerms(false)}>{t('coding.cancel')}</button>
              <span className="csx-pub-spacer" />
              <button className="csx-pub-primary" disabled={!termsChecked} onClick={confirmTerms}>{t('coding.termsConfirm')}</button>
            </div>
          </div>
        ) : (
        <>
        <p className="csx-pub-desc">{t('coding.publishDesc')}</p>

        {phase === 'loading' && <div className="csx-pub-busy"><Loader2 size={15} className="csx-spin" /></div>}

        {phase === 'login' && (
          <div className="csx-pub-login">
            <span>{t('coding.publishNeedLogin')}</span>
            <button className="csx-pub-primary" disabled={busy === 'login'} onClick={() => void login()}>
              {busy === 'login' ? <><Loader2 size={13} className="csx-spin" />{t('coding.loginWaiting')}</> : t('coding.loginNow')}
            </button>
          </div>
        )}

        {phase === 'form' && (
          <>
            <div className="csx-pub-row">
              <label>{t('coding.publishName')}</label>
              <input className="csx-newinput" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="csx-pub-row">
              <label>{t('coding.publishSlug')}</label>
              <input
                className="csx-newinput csx-pub-mono" value={slug} maxLength={32} spellCheck={false}
                disabled={!!published}
                onChange={(e) => { setSlug(e.target.value.toLowerCase()); setErr('') }}
              />
            </div>
            {!published && !slugOk && slug !== '' && <div className="csx-pub-hint csx-pub-warn">{t('coding.publishSlugHint')}</div>}
            <div className="csx-pub-row">
              <label>{t('coding.publishEntry')}</label>
              {htmlFiles.length > 0
                ? (
                  <select className="csx-entry" value={entry} onChange={(e) => setEntry(e.target.value)}>
                    {htmlFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                )
                : <span className="csx-pub-hint csx-pub-warn">{t('coding.publishNoEntry')}</span>}
            </div>

            {slots && (
              <div className="csx-pub-hint">
                {t('coding.publishSlots', { used: slots.used, limit: slots.limit, tier: slots.tier })}
              </div>
            )}
            <div className="csx-pub-hint">{t('coding.publishHint')}</div>

            {publicUrl && (
              <div className="csx-pub-url">
                <a href={publicUrl} target="_blank" rel="noreferrer" title={t('coding.openLink')}>
                  {publicUrl.replace(/^https?:\/\//, '')}<ExternalLink size={12} />
                </a>
                <button className="icon-btn" title={t('coding.copyLink')} onClick={() => void copy()}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            )}

            {err && <div className="csx-pub-err">{err}</div>}

            <div className="csx-pub-actions">
              {published && (
                <button className="csx-pub-danger" disabled={!!busy} onClick={() => void unpublish()}>
                  {busy === 'unpublish' ? <Loader2 size={13} className="csx-spin" /> : confirmDel ? t('coding.unpublishConfirm') : t('coding.unpublish')}
                </button>
              )}
              <span className="csx-pub-spacer" />
              <button className="csx-pub-primary" disabled={!canPublish} onClick={() => void publish()}>
                {busy === 'publish'
                  ? <><Loader2 size={13} className="csx-spin" />{t('coding.publishing')}</>
                  : published ? t('coding.publishUpdate') : t('coding.publishBtn')}
              </button>
            </div>
          </>
        )}
        </>
        )}
      </div>
    </div>
  )
}
