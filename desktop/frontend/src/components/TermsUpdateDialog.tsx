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
import { useEffect, useRef, useState } from 'react'
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

/** 15 秒没回 = 失败(网页版的 cloudJson 自己不设超时;挂住的请求会让按钮一直禁用、卡和后面的弹窗都堵着)。 */
const TIMEOUT_MS = 15_000

async function cloud(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CloudResult | null> {
  const t = window.tangu
  const req = path === '/auth/terms' && t?.termsStatus ? t.termsStatus()
    : path === '/auth/terms/agree' && t?.termsAgree ? t.termsAgree((body as { version: string }).version)
    : t?.cloudFetch ? t.cloudFetch({ path, method, ...(body !== undefined ? { body } : {}) })
    : null
  if (!req) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), TIMEOUT_MS) })
  try { return await Promise.race([req.catch(() => null), timeout]) } finally { clearTimeout(timer) }
}

/** 拿这个账号的协议状态。'none' = 不用弹(含老服务端 404);'error' = 没查成(断网、5xx、超时)。 */
export async function loadTermsStatus(): Promise<TermsStatus | 'none' | 'error'> {
  const r = await cloud('GET', '/auth/terms')
  if (!r || r.status === 0 || r.status >= 500) return 'error'
  const j = r.status === 200 ? r.json : null
  if (!j || j.required !== true || typeof j.latest !== 'string' || !j.latest) return 'none'
  const changes = j.changes && typeof j.changes.zh === 'string' && typeof j.changes.en === 'string' ? { zh: j.changes.zh, en: j.changes.en } : null
  return { latest: j.latest, required: true, mode: j.mode === 'consent' ? 'consent' : 'notice', changes }
}

/** 登录后那一次:没查成就这次先不弹(下次登录 / 启动再查)。 */
export async function fetchTermsStatus(): Promise<TermsStatus | null> {
  const r = await loadTermsStatus()
  return typeof r === 'string' ? null : r
}

/** 同意 / 确认看过。'stale' = 服务端版本又变了(该重新拉一次)。 */
export async function agreeTerms(version: string): Promise<'ok' | 'stale' | 'failed'> {
  const r = await cloud('POST', '/auth/terms/agree', { version })
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
  // 卡里的请求可能跨过换号 / 登出才回来:回包只认发起时那个账号(否则 A 迟到的成功会关掉 B 的卡)
  const current = useRef(account)
  current.current = account
  useEffect(() => {
    setStatus(null)
    if (!account || windowKind() !== 'main' || window.tangu?.unitPage) return
    let alive = true
    void fetchTermsStatus().then((s) => { if (alive) setStatus(s) })
    return () => { alive = false }
  }, [account])
  const turn = usePopupTurn('terms', !!status, POPUP_PRIORITY.terms)
  if (!turn || !status) return null
  const mine = account
  const forMe = (fn: () => void): void => { if (current.current === mine) fn() }
  return (
    <TermsUpdateDialog
      key={`${account}:${status.latest}`}
      status={status}
      onDone={() => forMe(() => setStatus(null))}
      onReplace={(next) => forMe(() => setStatus(next))}
    />
  )
}

export function TermsUpdateDialog({ status, onDone, onReplace }: { status: TermsStatus; onDone: () => void; onReplace: (next: TermsStatus | null) => void }) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState<'agree' | 'decline' | null>(null)
  const [failed, setFailed] = useState(false)
  const consent = status.mode === 'consent'
  const changes = status.changes ? (locale === 'en' ? status.changes.en : status.changes.zh) : ''

  const agree = async (): Promise<void> => {
    setBusy('agree'); setFailed(false)
    try {
      const r = await agreeTerms(status.latest)
      if (r === 'ok') return onDone()
      if (r === 'stale') {
        // 服务端版本又变了:换成新的那版;重拉没成功就留着这张卡让用户重试,不能当成「不用再确认」放过去
        const next = await loadTermsStatus()
        if (next === 'error') return setFailed(true)
        return onReplace(next === 'none' ? null : next)
      }
      // 记账失败:只提醒的那档照样关(没记上,下次启动再提醒一次);要同意的那档留着卡,可以重试或不同意
      if (!consent) return onDone()
      setFailed(true)
    } finally {
      setBusy(null)
    }
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
