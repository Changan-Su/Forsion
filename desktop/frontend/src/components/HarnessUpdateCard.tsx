import { useEffect, useState } from 'react'
import { NotebookPen, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getAgentHarness, rollbackHarnessEntry, type HarnessJournalLine } from '../services/backendService'
import { harnessChangeState, HARNESS_CHANGED_EVENT, type HarnessChange } from '../services/harnessUpdates'
import { targetForSession } from '../services/engine/targets'
import './selfUpdates.css'

registerMessages({
  'harness.act.create': { zh: '新增', en: 'Added' },
  'harness.act.revise': { zh: '修订', en: 'Revised' },
  'harness.act.delete': { zh: '删除', en: 'Removed' },
  'harness.act.rollback': { zh: '恢复上一版', en: 'Restored previous version' },
  'harness.applied': { zh: '已生效', en: 'Applied' },
  'harness.undone': { zh: '本次更新已撤销', en: 'This update was undone' },
  'harness.evidence': { zh: '更新依据', en: 'Reason for this update' },
  'harness.view': { zh: '查看进化记录', en: 'View evolution record' },
  'harness.undo': { zh: '撤销本次更新', en: 'Undo this update' },
  'harness.viewShort': { zh: '查看', en: 'View' },
  'harness.undoShort': { zh: '撤销', en: 'Undo' },
  'harness.undoConflict': { zh: '这条记录后来又改过。请打开进化记录调整，避免覆盖新的内容。', en: 'This entry changed again later. Open the evolution record to revise it without overwriting newer changes.' },
})

/** Agent 自己改了进化记录(manage_harness 立即生效、不逐笔审批)→ 这条回复的回执行里各占一行:改了什么、依据、可撤销。
 *  只在回执行点开时才挂(SelfUpdateReceipt),所以编辑史也是点开才读。按钮上的字是短的,可访问名仍是完整的那一句(台架按它找)。 */
export function HarnessUpdateRows({ changes, sessionId }: { changes: HarnessChange[]; sessionId: string }) {
  const { t, locale } = useI18n()
  const listSep = locale === 'zh' ? '、' : ', '
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
  if (!changes.length) return null
  const undo = async (change: HarnessChange) => {
    if (busy) return
    setBusy(change.rev); setErrors((e) => ({ ...e, [change.rev]: '' }))
    try { await rollbackHarnessEntry(engine, change.agent, change.entryId, change.rev) }
    catch (e: any) { setErrors((x) => ({ ...x, [change.rev]: e?.status === 409 ? t('harness.undoConflict') : String(e?.message || e) })) }
    finally { setBusy(''); window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }
  }
  return <div data-harness-updates>
    {changes.map((change) => {
      const journal = journals[change.agent]
      const state = journal ? harnessChangeState(journal, change) : null
      return <article className="self-row" key={change.rev} data-harness-update={change.rev} data-harness-state={state || undefined}>
        <NotebookPen size={15} className="self-row-ic" />
        <div className="self-row-kind human-scope">{names.find((a) => a.slug === change.agent)?.name || change.agent} · {t(`harness.act.${change.action}`)} · {t(state === 'undone' ? 'harness.undone' : 'harness.applied')}</div>
        <div className="self-row-main">
          <p><strong>{change.title}</strong></p>
          <p>{change.body}</p>
          {!!change.tools?.length && <p>{t('settings.agents.harnessShelvedTools', { names: change.tools.join(listSep) })}</p>}
          {!!change.skills?.length && <p>{t('settings.agents.harnessShelvedSkills', { names: change.skills.join(listSep) })}</p>}
          {change.evidence && <details><summary>{t('harness.evidence')}</summary><p>{change.evidence}</p></details>}
        </div>
        <div className="self-row-ops">
          <button type="button" className="self-act" aria-label={t('harness.view')} onClick={() => showDetails({ kind: 'agent', slug: change.agent, evolution: Date.now() })}>{t('harness.viewShort')}</button>
          {state !== 'undone' && <button type="button" className="self-act" aria-label={t('harness.undo')} disabled={!!busy || state !== 'current'} title={state === 'superseded' ? t('harness.undoConflict') : undefined} onClick={() => void undo(change)}><Undo2 size={12} />{t('harness.undoShort')}</button>}
        </div>
        {errors[change.rev] && <p className="self-row-note agent-profile-error" role="alert">{errors[change.rev]}</p>}
      </article>
    })}
  </div>
}
