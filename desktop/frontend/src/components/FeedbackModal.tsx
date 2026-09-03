/** 反馈弹窗:写问题/建议 → 自动附带本次会话日志(设置·高级那份)→ 提交 Forsion 反馈中心。 */
import React, { useState } from 'react'
import { X, MessageSquare, Loader2, MessagesSquare } from 'lucide-react'
import { useWorkspace } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { buildSessionLogPayload, sessionLogFilename } from '../services/sessionLog'
import type { SessionRecord, TanguDesktopConfig } from '../types'

registerMessages({
  'feedback.diagnosePrompt': {
    zh: '我在使用 Tangu 时遇到一个问题，想请你帮我诊断：\n\n{description}\n\n请结合当前会话的上下文分析可能的原因，并给出排查步骤。',
    en: 'I ran into a problem while using Tangu and would like your help diagnosing it:\n\n{description}\n\nUsing the context of this session, analyze the likely causes and suggest troubleshooting steps.',
  },
})

export const FeedbackModal: React.FC<{
  cfg: TanguDesktopConfig
  activeSession: SessionRecord | null
  onClose: () => void
}> = ({ cfg, activeSession, onClose }) => {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [msg, setMsg] = useState('')

  const submit = async (): Promise<void> => {
    const description = text.trim()
    if (!description) { setMsg(t('feedback.errEmpty')); return }
    if (!window.tangu?.submitFeedback) { setMsg(t('feedback.errUnavailable')); return }
    setBusy(true); setMsg('')
    try {
      let sessionLogJson: string | undefined
      let sessionLogName: string | undefined
      if (activeSession) {
        try {
          sessionLogJson = JSON.stringify(await buildSessionLogPayload(cfg, activeSession), null, 2)
          sessionLogName = sessionLogFilename(activeSession)
        } catch { /* 日志取不到也不挡提交 */ }
      }
      const r = await window.tangu.submitFeedback({ description, sessionLogJson, sessionLogName })
      if (!r.ok) {
        const err = r.error === 'not-logged-in' ? t('feedback.errNotLoggedIn') : (r.error || '')
        setMsg(t('feedback.errFail', { err }))
      } else {
        setDone(true)
        setMsg(r.attachmentSkipped ? t('feedback.okNoLog') : t('feedback.ok'))
        setTimeout(onClose, 1400)
      }
    } finally {
      setBusy(false)
    }
  }

  // 「让 Tangu 帮我诊断」:把问题描述预填进当前会话聊天框,交给内嵌 agent 就地排查(很多「bug」其实是配置/用法困惑)。
  const diagnoseViaChat = (): void => {
    const description = text.trim()
    if (!description) return
    const prompt = t('feedback.diagnosePrompt', { description })
    useApp.getState().setPendingDraft(prompt)
    useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    onClose()
  }

  return (
    <div className="memv-modal" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <MessageSquare size={15} style={{ marginRight: 6 }} />
          {t('feedback.title')}
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} title={t('settings.btn.cancel')}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t('feedback.label')}</label>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('feedback.placeholder')}
              disabled={busy || done}
              style={{ width: '100%', resize: 'vertical', minHeight: 150 }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            {activeSession ? t('feedback.logAttached', { name: sessionLogFilename(activeSession) }) : t('feedback.noSession')}
          </div>
          {msg ? (
            <div style={{ fontSize: 12, marginTop: 8, color: done ? 'var(--accent-ink)' : 'var(--danger)' }}>{msg}</div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
            <button className="btn ghost" onClick={diagnoseViaChat} disabled={busy || done || !text.trim()} title={t('feedback.diagnoseViaChatHint')}>
              <MessagesSquare size={14} style={{ marginRight: 6 }} />
              {t('feedback.diagnoseViaChat')}
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onClose} disabled={busy}>{t('settings.btn.cancel')}</button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || done || !text.trim()}>
              {busy ? <Loader2 size={14} className="spin" style={{ marginRight: 6 }} /> : null}
              {t('feedback.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
