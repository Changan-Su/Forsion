import { useEffect, useState } from 'react'
import { NotebookPen, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getAgentHarness, rollbackHarnessEntry, type HarnessJournalLine } from '../services/backendService'
import { harnessChangeState, HARNESS_CHANGED_EVENT, type HarnessChange } from '../services/harnessUpdates'
import { targetForSession } from '../services/engine/targets'
import './humanCollaboration.css'

registerMessages({
  'harness.updated': { zh: '工作笔记已更新', en: 'Working notes updated' },
  'harness.act.create': { zh: '新增', en: 'Added' },
  'harness.act.revise': { zh: '修订', en: 'Revised' },
  'harness.act.delete': { zh: '删除', en: 'Removed' },
  'harness.act.rollback': { zh: '恢复上一版', en: 'Restored previous version' },
  'harness.applied': { zh: '已生效', en: 'Applied' },
  'harness.undone': { zh: '本次更新已撤销', en: 'This update was undone' },
  'harness.evidence': { zh: '更新依据', en: 'Reason for this update' },
  'harness.view': { zh: '查看工作笔记', en: 'View working notes' },
  'harness.undo': { zh: '撤销本次更新', en: 'Undo this update' },
  'harness.undoConflict': { zh: '这条笔记后来又改过。请打开工作笔记调整，避免覆盖新的内容。', en: 'This note changed again later. Open the working notes to revise it without overwriting newer changes.' },
})

/** Agent 自己改了工作笔记(manage_harness 立即生效、不逐笔审批)→ 这条回复下出一张卡:改了什么、依据、可撤销。
 *  与协作说明的更新卡同一副样式(humanCollaboration.css 的 .human-update-card)。 */
export function HarnessUpdateCard({ changes, sessionId }: { changes: HarnessChange[]; sessionId: string }) {
  const { t } = useI18n()
  const engine = targetForSession(sessionId)
  const slugs = [...new Set(changes.map((c) => c.agent))].join(',')
  const revs = changes.map((c) => c.rev).join(',')
  const [journals, setJournals] = useState<Record<string, HarnessJournalLine[]>>({})
  const [busy, setBusy] = useState(''), [errors, setErrors] = useState<Record<string, string>>({})
  const names = useApp((s) => s.agentDefs)
  useEffect(() => {
    if (!slugs) return
    let alive = true
    const refresh = () => {
      for (const slug of slugs.split(',')) void getAgentHarness(engine, slug).then((r) => { if (alive) setJournals((j) => ({ ...j, [slug]: r.journal })) }).catch(() => {})
    }
    refresh(); window.addEventListener(HARNESS_CHANGED_EVENT, refresh)
    return () => { alive = false; window.removeEventListener(HARNESS_CHANGED_EVENT, refresh) }
  }, [engine.key, engine.base, slugs, revs]) // eslint-disable-line react-hooks/exhaustive-deps
  // 回复还在流式时新回执到了:详情页开着的「进化」面板跟着重读
  useEffect(() => { if (revs) window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }, [revs])
  if (!changes.length) return null
  const undo = async (change: HarnessChange) => {
    if (busy) return
    setBusy(change.rev); setErrors((e) => ({ ...e, [change.rev]: '' }))
    try { await rollbackHarnessEntry(engine, change.agent, change.entryId, change.rev) }
    catch (e: any) { setErrors((x) => ({ ...x, [change.rev]: e?.status === 409 ? t('harness.undoConflict') : String(e?.message || e) })) }
    finally { setBusy(''); window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }
  }
  return <section className="human-update-card" data-harness-updates>
    <div className="human-update-head"><NotebookPen size={15} /><strong>{t('harness.updated')}</strong></div>
    {changes.map((change) => {
      const journal = journals[change.agent]
      const state = journal ? harnessChangeState(journal, change) : null
      return <article key={change.rev} data-harness-update={change.rev} data-harness-state={state || undefined}>
        <div className="human-scope">{names.find((a) => a.slug === change.agent)?.name || change.agent} · {t(`harness.act.${change.action}`)} · <span className="human-applied">{t(state === 'undone' ? 'harness.undone' : 'harness.applied')}</span></div>
        <p><strong>{change.title}</strong></p>
        <p>{change.body}</p>
        {change.evidence && <details><summary>{t('harness.evidence')}</summary><p>{change.evidence}</p></details>}
        <div className="human-actions">
          <button type="button" className="profile-text-action" onClick={() => showDetails({ kind: 'agent', slug: change.agent, evolution: Date.now() })}>{t('harness.view')}</button>
          {state !== 'undone' && <button type="button" className="profile-text-action" disabled={!!busy || state !== 'current'} title={state === 'superseded' ? t('harness.undoConflict') : undefined} onClick={() => void undo(change)}><Undo2 size={12} />{t('harness.undo')}</button>}
        </div>
        {errors[change.rev] && <p className="agent-profile-error" role="alert">{errors[change.rev]}</p>}
      </article>
    })}
  </section>
}
