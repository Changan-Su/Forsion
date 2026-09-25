/**
 * 收件箱里的反馈线程面板(2026-09-22):挂在带 thread={kind:'feedback'} 的服务端信件正文之下。
 *
 * 线程真身按 ticketId 从 Forsion 服务端现拉(`GET /api/feedback/:id`,票主与管理员共用,服务端按 role 定 viewer),
 * 信件正文只是通知。这里渲整条对话(票 + 历次回复 + 各自附件)+ 回复框(文字 + 附件),发 `POST /api/feedback/:id/replies`;
 * 对方那侧由服务端再投一封定向广播进收件箱。打开即 `POST …/read` 标已读(反馈中心 / 收件箱两边的未读点同源)。
 * 只在有 `window.tangu.cloudFetch` 的桌面壳出现(token 留主进程);Web / 移动端只看到信件正文。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquareReply, Paperclip, Send, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { formatDateTime } from '../../format/time'
import {
  attachmentDataUrl, checkAttachments, fileToAttachment, fmtKb, isImageMime,
  type FeedbackAttachmentInput, type FeedbackThreadData,
} from './feedbackThreadLib'

type Load = 'loading' | { error: 'signIn' | 'missing' | 'loadFail' } | { data: FeedbackThreadData }

export function feedbackThreadAvailable(): boolean {
  return typeof window.tangu?.cloudFetch === 'function'
}

export function FeedbackThread({ ticketId, event }: { ticketId: string; event?: string }) {
  const { t } = useI18n()
  const [load, setLoad] = useState<Load>('loading')
  const [tick, setTick] = useState(0)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FeedbackAttachmentInput[]>([])
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    setLoad('loading')
    void (async () => {
      const r = await window.tangu!.cloudFetch!({ path: `/feedback/${encodeURIComponent(ticketId)}` })
      if (!alive) return
      if (r.status === 200 && r.json?.ticket) {
        setLoad({ data: r.json as FeedbackThreadData })
        void window.tangu!.cloudFetch!({ path: `/feedback/${encodeURIComponent(ticketId)}/read`, method: 'POST', body: {} }).catch(() => {})
      } else if (r.status === 401 || r.error === 'not_signed_in' || r.error === 'no_cloud_url') setLoad({ error: 'signIn' })
      else if (r.status === 404) setLoad({ error: 'missing' })
      else setLoad({ error: 'loadFail' })
    })()
    return () => { alive = false }
  }, [ticketId, tick])

  const pick = useCallback(async (arr: File[]) => {
    if (!arr.length) return
    const bad = checkAttachments(files.length, arr)
    if (bad) { setErr(t(`inbox.feedback.${bad.code}`, { name: bad.name })); return }
    setErr('')
    try { const conv = await Promise.all(arr.map(fileToAttachment)); setFiles((prev) => prev.concat(conv)) } catch (e: any) { setErr(String(e?.message || e)) }
  }, [files.length, t])

  const send = async () => {
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    setErr('')
    try {
      const r = await window.tangu!.cloudFetch!({
        path: `/feedback/${encodeURIComponent(ticketId)}/replies`, method: 'POST',
        body: { content, attachments: files }, timeoutMs: 90_000,
      })
      if (r.status === 201 || r.status === 200) {
        setText(''); setFiles([]); setTick((n) => n + 1)
      } else {
        setErr(t('inbox.feedback.sendFail', { e: r.json?.detail || r.error || `HTTP ${r.status}` }))
      }
    } finally { setSending(false) }
  }

  const eventKey = event === 'created' || event === 'user_reply' || event === 'admin_reply' ? `inbox.feedback.event.${event}` : null
  return (
    <div className="ibx-fb" data-feedback-thread={ticketId}>
      <div className="ibx-fb-head">
        <MessageSquareReply size={14} />
        <span>{t('inbox.feedback.title')}</span>
        {eventKey && <span className="ibx-fb-event">{t(eventKey)}</span>}
        {load !== 'loading' && 'data' in load && (
          <span className={`ibx-fb-status st-${load.data.ticket.status}`}>{t(`inbox.feedback.status.${load.data.ticket.status}`)}</span>
        )}
      </div>
      {load === 'loading' ? (
        <div className="ibx-fb-note">{t('inbox.feedback.loading')}</div>
      ) : 'error' in load ? (
        <div className="ibx-fb-note">
          {t(`inbox.feedback.${load.error}`)}
          {load.error === 'loadFail' && <button className="ibx-fb-link" onClick={() => setTick((n) => n + 1)}>{t('inbox.feedback.retry')}</button>}
        </div>
      ) : (
        <>
          <Messages data={load.data} />
          <div className="ibx-fb-composer">
            <textarea
              className="ibx-fb-input" rows={3} value={text} placeholder={t('inbox.feedback.replyPh')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() } }}
            />
            {files.length > 0 && (
              <div className="ibx-fb-chips">
                {files.map((f, i) => (
                  <span key={i} className="ibx-fb-chip">
                    <Paperclip size={11} /> {f.filename} · {fmtKb(f.size)}
                    <button title={t('inbox.feedback.remove')} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="ibx-fb-actions">
              <input ref={fileRef} type="file" multiple hidden accept="image/*,text/*,application/json,.json,.txt,.log,.md,.csv"
                onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; void pick(files) }} />
              <button className="ibx-fb-link" title={t('inbox.feedback.attachHint')} onClick={() => fileRef.current?.click()}>
                <Paperclip size={12} /> {t('inbox.feedback.attach')}
              </button>
              <span className="ibx-fb-spacer" />
              {err && <span className="ibx-fb-err">{err}</span>}
              <button className="ibx-claim-btn ibx-fb-send" disabled={!text.trim() || sending} onClick={() => void send()}>
                <Send size={12} /> {sending ? t('inbox.feedback.sending') : t('inbox.feedback.send')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 票 + 回复按时间正序;「我」= 服务端裁定的 viewer 那一侧。附件按 reply_id 归到各自那条(NULL = 票本身)。 */
function Messages({ data }: { data: FeedbackThreadData }) {
  const { t } = useI18n()
  const viewer = data.viewer === 'admin' ? 'admin' : 'user'
  const ownerName = data.ticket.nickname || data.ticket.username || t('inbox.feedback.user')
  const who = (side: 'user' | 'admin'): { name: string; me: boolean } => {
    const me = side === viewer
    return { name: me ? t('inbox.feedback.you') : side === 'admin' ? t('inbox.feedback.support') : ownerName, me }
  }
  const attsOf = (replyId: string | null) => data.attachments.filter((a) => (a.reply_id || null) === replyId)
  type Item = { id: string; side: 'user' | 'admin'; text: string; at: string; atts: FeedbackThreadData['attachments'] }
  const head: Item = { id: data.ticket.id, side: 'user', text: data.ticket.description, at: data.ticket.created_at, atts: attsOf(null) }
  const items: Item[] = [head].concat(data.replies.map((r): Item => ({ id: r.id, side: r.author_role, text: r.content, at: r.created_at, atts: attsOf(r.id) })))
  return (
    <div className="ibx-fb-msgs">
      {items.map((m) => {
        const w = who(m.side)
        return (
          <div key={m.id} className={`ibx-fb-msg${w.me ? ' me' : ''}`}>
            <div className="ibx-fb-meta"><b>{w.name}</b><span>{fmtTime(m.at)}</span></div>
            <div className="ibx-fb-text">{m.text}</div>
            {m.atts.length > 0 && (
              <div className="ibx-fb-atts">
                {m.atts.map((a) => isImageMime(a.mime_type)
                  ? <img key={a.id} className="ibx-fb-img" src={attachmentDataUrl(a)} alt={a.filename || ''} title={a.filename || ''} onClick={(e) => e.currentTarget.classList.toggle('big')} />
                  : <button key={a.id} className="ibx-fb-file" onClick={() => download(a)}>
                      <Paperclip size={11} /> {a.filename || 'attachment'} · {fmtKb(a.size)} · {t('inbox.feedback.download')}
                    </button>)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fmtTime(s: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`)
  return formatDateTime(d) || s
}

/** 文本类附件存盘:一律 octet-stream(别让渲染层按 mime 就地打开);Blob URL 押后 revoke。 */
function download(a: { filename: string | null; data_base64: string }): void {
  let bin: string
  try { bin = atob((a.data_base64 || '').replace(/\s+/g, '')) } catch { return }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = String(a.filename || 'attachment').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
