/**
 * 协议更新提示(2026-10-19):登录后查一次 server 的 GET /auth/terms,这个账号最近同意 / 确认过的版本不是最新的就弹一张卡。
 * 两档由 server 按版本定(server/src/config/legal.ts 的 LEGAL_CHANGES):
 *   - notice:只提醒,一个「知道了」。隐私政策第 11 节、服务条款第 14 节的口径(重大变更通知,继续使用视为接受)。
 *   - consent:依法要重新同意的变更。「同意」/「不同意并退出登录」;不同意就地退出,下次登录再问。
 * 「知道了」和「同意」都记到账号上(POST /auth/terms/agree),换设备 / 换客户端不再弹。
 *
 * 只在主窗(桌面 / 网页 / 手机各一份);排在弹窗队列最前面(stores/popupQueue),但不抢已经在显示的那张。
 * 不能点外面或按 Esc 关掉:关掉等于没表态,下次启动照样弹。
 * 通道:桌面(Extend)与 Android 走 cloudFetch,网页版走 webShim 的 termsStatus / termsAgree(网页版不给 cloudFetch,
 * 有它会顺带打开成就 / 插件数据同步这些只给桌面的功能)。老服务端没有这两个端点 → 404 → 不弹。
 */
import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { POPUP_PRIORITY, usePopupTurn } from '../stores/popupQueue'
import { registerMessages, useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { FORSION_PRIVACY_URL, FORSION_TERMS_URL } from '../appCompliance'
import './termsUpdate.css'

registerMessages({
  'terms.noticeTitle': { zh: '服务条款与隐私政策已更新', en: 'Our Terms and Privacy Policy have changed' },
  'terms.consentTitle': { zh: '请确认更新后的服务条款与隐私政策', en: 'Please review our updated Terms and Privacy Policy' },
  'terms.noticeBody': { zh: '你可以随时查看全文。继续使用即表示你接受更新后的内容。', en: 'You can read the full text at any time. By continuing to use Forsion, you accept the updated terms.' },
  'terms.consentBody': { zh: '继续使用前，请阅读并同意更新后的服务条款与隐私政策。', en: 'Before you continue, please read and accept the updated Terms of Service and Privacy Policy.' },
  'terms.changes': { zh: '这次的变化：{text}', en: 'What changed: {text}' },
  'terms.version': { zh: '版本 {version}', en: 'Version {version}' },
  'terms.terms': { zh: '服务条款', en: 'Terms of Service' },
  'terms.privacy': { zh: '隐私政策', en: 'Privacy Policy' },
  'terms.ok': { zh: '知道了', en: 'Got it' },
  'terms.agree': { zh: '同意', en: 'Accept' },
  'terms.decline': { zh: '不同意并退出登录', en: 'Decline and sign out' },
  'terms.declineHint': { zh: '不同意会退出登录，下次登录时会再询问你。', en: "If you decline, you'll be signed out and asked again the next time you sign in." },
  'terms.failed': { zh: '没能提交，请检查网络后重试。', en: "Couldn't submit. Check your connection and try again." },
})

export interface TermsStatus {
  latest: string
  required: boolean
  mode: 'notice' | 'consent'
  changes: { zh: string; en: string } | null
}

type CloudResult = { status: number; json?: any }

function cloud(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CloudResult> | null {
  const t = window.tangu
  if (path === '/auth/terms' && t?.termsStatus) return t.termsStatus()
  if (path === '/auth/terms/agree' && t?.termsAgree) return t.termsAgree((body as { version: string }).version)
  if (t?.cloudFetch) return t.cloudFetch({ path, method, ...(body !== undefined ? { body } : {}) })
  return null
}

/** 拿这个账号的协议状态;不用弹 / 查不到(未登录、老服务端、断网)= null。 */
export async function fetchTermsStatus(): Promise<TermsStatus | null> {
  const r = await cloud('GET', '/auth/terms')?.catch(() => null)
  const j = r?.status === 200 ? r.json : null
  if (!j || j.required !== true || typeof j.latest !== 'string' || !j.latest) return null
  const changes = j.changes && typeof j.changes.zh === 'string' && typeof j.changes.en === 'string' ? { zh: j.changes.zh, en: j.changes.en } : null
  return { latest: j.latest, required: true, mode: j.mode === 'consent' ? 'consent' : 'notice', changes }
}

/** 同意 / 确认看过。'stale' = 服务端版本又变了(该重新拉一次)。 */
export async function agreeTerms(version: string): Promise<'ok' | 'stale' | 'failed'> {
  const r = await cloud('POST', '/auth/terms/agree', { version })?.catch(() => null)
  return r?.status === 200 ? 'ok' : r?.status === 409 ? 'stale' : 'failed'
}

function openLink(url: string): void {
  if (window.tangu?.openExternal) void window.tangu.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

export function TermsUpdateHost() {
  // 换账号也要重查:按账号认,不只看登录与否
  const account = useApp((s) => (s.authInfo?.loggedIn ? s.authInfo.accountId || s.authInfo.username || '?' : null))
  const [status, setStatus] = useState<TermsStatus | null>(null)
  useEffect(() => {
    setStatus(null)
    if (!account || windowKind() !== 'main' || window.tangu?.unitPage) return
    let alive = true
    void fetchTermsStatus().then((s) => { if (alive) setStatus(s) })
    return () => { alive = false }
  }, [account])
  const turn = usePopupTurn('terms', !!status, POPUP_PRIORITY.terms)
  if (!turn || !status) return null
  return (
    <TermsUpdateDialog
      key={status.latest}
      status={status}
      onDone={() => setStatus(null)}
      onStale={() => void fetchTermsStatus().then(setStatus)}
    />
  )
}

export function TermsUpdateDialog({ status, onDone, onStale }: { status: TermsStatus; onDone: () => void; onStale: () => void }) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState<'agree' | 'decline' | null>(null)
  const [failed, setFailed] = useState(false)
  const consent = status.mode === 'consent'
  const changes = status.changes ? (locale === 'en' ? status.changes.en : status.changes.zh) : ''

  const agree = async (): Promise<void> => {
    setBusy('agree'); setFailed(false)
    const r = await agreeTerms(status.latest)
    setBusy(null)
    if (r === 'ok') onDone()
    else if (r === 'stale') onStale()
    else setFailed(true)
  }
  const decline = async (): Promise<void> => {
    setBusy('decline')
    try { await window.tangu?.forsionLogout?.() } catch { /* 退出失败:卡片留着,用户可以再点 */ }
    setBusy(null)
    // 退出成功后 authInfo 变空,宿主会把卡收掉;这里不提前关,免得退出失败时用户什么都没表态就进去了
  }

  return (
    <div className="u-backdrop terms-backdrop">
      <div className="modal terms-modal" role="dialog" aria-modal="true" aria-labelledby="terms-title" aria-describedby="terms-body">
        <div className="terms-head">
          <b id="terms-title">{t(consent ? 'terms.consentTitle' : 'terms.noticeTitle')}</b>
          <small>{t('terms.version', { version: status.latest })}</small>
        </div>
        <div className="terms-body" id="terms-body">
          {changes && <p className="terms-changes">{t('terms.changes', { text: changes })}</p>}
          <p>{t(consent ? 'terms.consentBody' : 'terms.noticeBody')}</p>
          <div className="terms-links">
            <button type="button" className="btn ghost sm" onClick={() => openLink(FORSION_TERMS_URL)}><ArrowUpRight size={12} /> {t('terms.terms')}</button>
            <button type="button" className="btn ghost sm" onClick={() => openLink(FORSION_PRIVACY_URL)}><ArrowUpRight size={12} /> {t('terms.privacy')}</button>
          </div>
          {consent && <p className="terms-hint">{t('terms.declineHint')}</p>}
          {failed && <p className="terms-error" role="alert">{t('terms.failed')}</p>}
        </div>
        <div className="terms-foot">
          <span className="grow" />
          {consent && <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void decline()}>{t('terms.decline')}</button>}
          <button type="button" className="btn primary sm" autoFocus disabled={!!busy} onClick={() => void agree()}>{t(consent ? 'terms.agree' : 'terms.ok')}</button>
        </div>
      </div>
    </div>
  )
}
