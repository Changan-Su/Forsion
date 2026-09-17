/** Feedback keeps its draft, shows exactly which diagnostics will be sent, and never silently drops a large attachment. */
import React, { useEffect, useRef, useState } from 'react'
import { X, MessageSquare, Loader2, MessagesSquare, Bug, Lightbulb, Check, FileText, ArrowLeft, RefreshCw } from 'lucide-react'
import { useWorkspace } from '@lcl/engine'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { buildFeedbackReport, FEEDBACK_LOG_LIMIT, FEEDBACK_TEXT_LIMIT, type FeedbackReport } from '../services/feedbackReport'
import type { SessionRecord, TanguDesktopConfig } from '../types'
import './feedbackMessages'
import './feedback.css'

export const FeedbackModal: React.FC<{
  cfg: TanguDesktopConfig
  activeSession: SessionRecord | null
  onClose: () => void
}> = ({ cfg, activeSession, onClose }) => {
  const { t } = useI18n()
  // Freeze the originating session: changing the active tab must not attach a different conversation.
  const [context] = useState(() => ({ cfg, session: activeSession }))
  const text = useApp((s) => s.feedbackDraft)
  const [kind, setKind] = useState<'bug' | 'idea' | 'other'>('bug')
  const [diagnostics, setDiagnostics] = useState(true)
  const [conversation, setConversation] = useState(false)
  const [activity, setActivity] = useState(false)
  const [revision, setRevision] = useState(0)
  const [prepared, setPrepared] = useState<{ key: string; report?: FeedbackReport; failed?: boolean } | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ id?: string | null; attachmentSkipped?: boolean } | null>(null)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const submitting = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const wantsLog = diagnostics || conversation || activity
  const selectionKey = `${diagnostics}:${conversation}:${activity}:${revision}`
  const current = prepared?.key === selectionKey ? prepared : null
  const preparing = wantsLog && !current
  const report = wantsLog ? current?.report : undefined
  const tooLarge = !!report && report.bytes > FEEDBACK_LOG_LIMIT
  const tooLong = text.trim().length > FEEDBACK_TEXT_LIMIT
  const canSubmit = !!text.trim() && !tooLong && !busy && !result && !preparing && !tooLarge && (!wantsLog || !!report)
  const close = (): void => { if (!submitting.current) closeRef.current() }

  useEffect(() => {
    if (!wantsLog) return
    let alive = true
    void buildFeedbackReport(context.cfg, context.session, { diagnostics, conversation, activity })
      .then((value) => { if (alive) setPrepared({ key: selectionKey, report: value }) })
      .catch(() => { if (alive) setPrepared({ key: selectionKey, failed: true }) })
    return () => { alive = false }
  }, [context, diagnostics, conversation, activity, revision, selectionKey, wantsLog])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (!submitting.current) closeRef.current()
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])
          .filter((node) => node.getClientRects().length > 0)
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (!first) { event.preventDefault(); dialog.current?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [])

  const submit = async (): Promise<void> => {
    if (!canSubmit || submitting.current) return
    if (!window.tangu?.submitFeedback) { setError(t('feedback.errUnavailable')); return }
    submitting.current = true; setBusy(true); setError('')
    try {
      const response = await window.tangu.submitFeedback({
        description: `[Tangu · ${t(`feedback.${kind}`)}]\n\n${text.trim()}`,
        ...(report ? { sessionLogJson: report.json, sessionLogName: report.filename } : {}),
      })
      if (!response.ok) {
        setError(response.error === 'attachment-too-large' ? t('feedback.tooLarge') : t('feedback.errFail', { err: response.error === 'not-logged-in' ? t('feedback.errNotLoggedIn') : response.error || 'Unknown error' }))
      } else {
        setResult(response)
        useApp.setState({ feedbackDraft: '' })
      }
    } catch (err) {
      setError(t('feedback.errFail', { err: String((err as Error)?.message || err) }))
    } finally { submitting.current = false; setBusy(false) }
  }

  const diagnoseViaChat = (): void => {
    if (!text.trim() || busy) return
    useApp.getState().setPendingDraft(t('feedback.diagnosePrompt', { description: text.trim() }))
    useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    close()
  }
  const size = report ? `${(report.bytes / 1024).toFixed(1)} KB` : ''

  return (
    <div className="memv-modal feedback-overlay" onClick={(event) => { if (event.target === event.currentTarget) close() }}>
      <div ref={dialog} className="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title" tabIndex={-1}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
        }}>
        <div className="modal-head feedback-head">
          <div className="feedback-heading"><MessageSquare size={19} /><div><h2 id="feedback-title">{t('feedback.title')}</h2><p>{t('feedback.subtitle')}</p></div></div>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label={t('settings.btn.cancel')}><X size={18} /></button>
        </div>
        {result ? <>
          <div className="modal-body feedback-success" role="status">
            <span className="feedback-success-icon"><Check size={28} /></span>
            <h3>{t('feedback.successTitle')}</h3><p>{t('feedback.successHint')}</p>
            {result.id && <code>{t('feedback.ticket', { id: result.id })}</code>}
            {result.attachmentSkipped && <p className="feedback-warning">{t('feedback.okNoLog')}</p>}
          </div>
          <div className="feedback-footer">
            {window.tangu?.openAccountCenter && <button className="btn ghost" onClick={() => { void window.tangu!.openAccountCenter!('feedback').catch(() => useApp.getState().toast(t('feedback.errUnavailable'), true)) }}>{t('feedback.viewFeedback')}</button>}
            <span className="grow" /><button autoFocus className="btn primary" onClick={close}>{t('feedback.done')}</button>
          </div>
        </> : <>
          <div className="modal-body feedback-body">
            {preview ? <>
              <button className="btn ghost sm feedback-back" onClick={() => setPreview(false)}><ArrowLeft size={14} />{t('feedback.backToForm')}</button>
              <div className="feedback-file"><FileText size={15} /><span>{report?.filename}</span><span>{size}</span></div>
              <pre className="feedback-preview" tabIndex={0}>{report?.json}</pre>
            </> : <>
              <div className="feedback-kinds" role="group" aria-label={t('feedback.kind')}>
                {([{ id: 'bug', Icon: Bug }, { id: 'idea', Icon: Lightbulb }, { id: 'other', Icon: MessageSquare }] as const).map(({ id, Icon }) => (
                  <button key={id} className="btn ghost" aria-pressed={kind === id} disabled={busy} onClick={() => setKind(id)}><Icon size={15} />{t(`feedback.${id}`)}</button>
                ))}
              </div>
              <div className="feedback-description">
                <label htmlFor="feedback-description">{kind === 'bug' ? t('feedback.description') : t('feedback.label')}</label>
                <textarea id="feedback-description" value={text} onChange={(event) => { useApp.setState({ feedbackDraft: event.target.value }); setError('') }}
                  placeholder={t(`feedback.${kind}Placeholder`)} disabled={busy} aria-invalid={tooLong} aria-describedby="feedback-count" />
                <span id="feedback-count" className={tooLong ? 'feedback-warning' : 'feedback-count'}>{text.trim().length.toLocaleString()} / {FEEDBACK_TEXT_LIMIT.toLocaleString()}</span>
              </div>
              <section className="feedback-context" aria-labelledby="feedback-context-title">
                <div className="feedback-section-heading"><h3 id="feedback-context-title">{t('feedback.context')}</h3><code>/feedback</code></div>
                <p className="feedback-session">{context.session ? t('feedback.sessionContext', { name: context.session.title || context.session.id.slice(0, 8) }) : t('feedback.withoutSession')}</p>
                {([
                  { id: 'diagnostics', checked: diagnostics, change: setDiagnostics, unavailable: false },
                  { id: 'conversation', checked: conversation, change: setConversation, unavailable: !context.session },
                  { id: 'activity', checked: activity, change: setActivity, unavailable: !window.tangu?.exportActivity },
                ] as const).map((option) => <label key={option.id} className="feedback-option" data-disabled={option.unavailable || undefined}>
                  <input type="checkbox" checked={option.checked} onChange={(event) => option.change(event.target.checked)} disabled={busy || option.unavailable} />
                  <span><strong>{t(`feedback.${option.id}`)}</strong><small>{t(`feedback.${option.id}Hint`)}</small></span>
                </label>)}
              </section>
              <div className="feedback-report-status" role="status">
                <span>{preparing ? <><Loader2 size={13} className="spin" />{t('feedback.preparing')}</> : report ? <><FileText size={13} />{t('feedback.ready', { size })}</> : !wantsLog ? t('feedback.textOnly') : t('feedback.prepareFailed')}</span>
                <div>{report && <button className="btn ghost sm" onClick={() => setPreview(true)} disabled={busy}>{t('feedback.preview')}</button>}
                  {wantsLog && <button className="icon-btn" onClick={() => setRevision((n) => n + 1)} disabled={busy || preparing} aria-label={t('feedback.refresh')} title={t('feedback.refresh')}><RefreshCw size={13} /></button>}</div>
              </div>
              {!!report?.missing.length && <p className="feedback-warning">{t('feedback.partial', { sources: report.missing.map((source) => t(`feedback.source.${source}`)).join(', ') })}</p>}
              {report?.truncated && <p className="feedback-note">{t('feedback.truncated')}</p>}
              {wantsLog && <p className="feedback-note">{t('feedback.privacy')}</p>}
            </>}
            {tooLarge && <p className="feedback-warning" role="alert">{t('feedback.tooLarge')}</p>}
            {tooLong && <p className="feedback-warning" role="alert">{t('feedback.limit', { max: FEEDBACK_TEXT_LIMIT })}</p>}
            {error && <p className="feedback-warning" role="alert">{error}</p>}
          </div>
          <div className="feedback-footer">
            <button className="btn ghost feedback-diagnose" onClick={diagnoseViaChat} disabled={busy || !text.trim()} title={t('feedback.diagnoseViaChatHint')}><MessagesSquare size={15} />{t('feedback.diagnoseViaChat')}</button>
            <span className="grow" />
            <button className="btn primary" onClick={() => void submit()} disabled={!canSubmit}>{busy && <Loader2 size={14} className="spin" />}{t(busy ? 'feedback.sending' : error ? 'feedback.retry' : 'feedback.submit')}</button>
          </div>
        </>}
      </div>
    </div>
  )
}
