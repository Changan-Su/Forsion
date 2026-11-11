import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { UiMessage } from '../../types'
import { useI18n } from '../../i18n'
import { skipRunCompaction } from '../../services/agentRunService'
import { targetForSession } from '../../services/engine/targets'
import './compactionNotice.css'

/** The server event is authoritative; an HTTP response never sends/resumes a user message. */
export function CompactionNotice({ message, sessionId }: { message: UiMessage; sessionId?: string }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [settling, setSettling] = useState(false)
  const request = useRef(0)
  const notice = message.compaction!
  useEffect(() => { setBusy(false); setError(false); setSettling(false); return () => { request.current++ } }, [notice.operationId, notice.status, sessionId])
  const pending = notice.status === 'running'
  const skip = async () => {
    if (!sessionId || busy || !notice.skippable) return
    const current = ++request.current
    setBusy(true); setError(false)
    try {
      const result = await skipRunCompaction(targetForSession(sessionId), notice.runId, notice.operationId)
      if (request.current !== current) return
      if (!result.ok && ['committing', 'completed'].includes(result.status || '')) setSettling(true)
      else if (!result.ok) setError(true)
    } catch { if (request.current === current) setError(true) }
    finally { if (request.current === current) setBusy(false) }
  }
  return <div className="t2-compaction" role="status" data-compaction-status={notice.status}>
    <div className="t2-compaction-line">
      {pending ? <Loader2 size={13} className="spin" /> : ['completed', 'skipped'].includes(notice.status) ? <Check size={13} /> : null}
      <span>{pending ? t(notice.reason === 'idle' ? 'ctx.compacting.idle' : 'ctx.compacting.required', { n: notice.idleMinutes || 60 }) : message.content}</span>
      {pending && notice.skippable && sessionId && <button type="button" disabled={busy || settling} onClick={() => void skip()}>{t('ctx.compaction.skip')}</button>}
    </div>
    {pending && <div className="t2-compaction-hint">{t(settling ? 'ctx.compaction.settling' : notice.skippable ? 'ctx.compaction.skipHint' : 'ctx.compaction.requiredHint')}</div>}
    {error && <div className="t2-compaction-error">{t('ctx.compaction.skipFailed')}</div>}
  </div>
}
