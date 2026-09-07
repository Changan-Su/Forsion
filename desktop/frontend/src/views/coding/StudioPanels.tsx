import { useEffect, useRef, useState } from 'react'
import { Check, History, Loader2, Save, Undo2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { buildStudioDraft, type StudioBrief } from './projectBrief'
import { saveStudioBriefFile } from './briefFile'
import { flushStudioEditors, hasUnsavedStudioEditors } from './editorSession'
import { projectName, normPath } from './studioModel'
import type { CodeStudioSnapshotSummary } from '../../../../shared/codeStudio'
import './studioMessages'
export type StudioPanel = 'brief' | 'history' | 'checks' | 'issues' | 'setup' | null
export const CHECKS = [
  ['main', 'studio.checkMain'], ['phone', 'studio.checkPhone'], ['failure', 'studio.checkFailure'], ['data', 'studio.checkData'], ['access', 'studio.checkAccess'],
] as const

export function BriefPanel({ root, onPrompt }: { root: string; onPrompt(text: string, plan?: boolean): void }) {
  const { t, locale } = useI18n()
  const saved = useCodeStudio(s => s.projects[root]?.brief)
  const [brief, setBrief] = useState<StudioBrief>(() => saved || { idea: '', audience: '', constraints: '', capabilities: [], locale })
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const persist = async (snapshot: StudioBrief): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setSaving(true); setError(''); setNotice('')
    try {
      await saveStudioBriefFile(root, snapshot)
      if (!mounted.current || useCodeStudio.getState().activeProject !== root) return false
      useCodeStudio.getState().updateProject({ brief: snapshot })
      setNotice(t('studio.briefSaved'))
      return true
    } catch (e) { if (mounted.current) setError(String((e as Error).message || e)); return false }
    finally { inFlight.current = false; if (mounted.current) setSaving(false) }
  }
  const submit = async (plan?: boolean): Promise<void> => {
    const snapshot = { ...brief, capabilities: [...brief.capabilities], locale }
    if (await persist(snapshot) && plan !== undefined) onPrompt(buildStudioDraft(snapshot), plan)
  }
  return <div className="csu-panel-body">
    {!saved && <p className="csu-hint">{t('studio.noBrief')}</p>}
    {(['idea', 'audience', 'constraints'] as const).map(field => <label className="csu-field" key={field}><span>{t(`studio.${field}`)}</span><textarea aria-label={t(`studio.${field}`)} disabled={saving} rows={field === 'idea' ? 5 : 3} value={brief[field]} onChange={e => setBrief({ ...brief, [field]: e.target.value })} /></label>)}
    <div className="csu-actions"><button disabled={saving} onClick={() => void submit()}><Save size={14} />{t('studio.saveBrief')}</button><button disabled={saving || !brief.idea.trim()} onClick={() => void submit(true)}>{t('studio.plan')}</button><button className="csu-primary" disabled={saving || !brief.idea.trim()} onClick={() => void submit(false)}>{t('studio.build')}</button></div>
    {!!error && <p role="alert" className="csu-error">{error}</p>}
    {!!notice && <p role="status" className="csu-hint"><Check size={13} />{notice}</p>}
  </div>
}
export function ChecksPanel({ root, onPrompt }: { root: string; onPrompt(text: string): void }) {
  const { t } = useI18n()
  const checked = useCodeStudio(s => s.projects[root]?.checks || {})
  return <div className="csu-panel-body"><p className="csu-hint">{t('studio.manualChecks')}</p>
    <div className="csu-check-list">{CHECKS.map(([id, key]) => <label key={id}><input type="checkbox" checked={!!checked[id]} onChange={e => useCodeStudio.getState().updateProject({ checks: { ...checked, [id]: e.target.checked } })} /><span>{t(key)}</span></label>)}</div>
    <button className="csu-primary" onClick={() => onPrompt(`Review and test the current project against these acceptance criteria. Inspect the source and run the available tools; exercise the preview if browser tools are available. Do not claim checks passed without evidence. Report defects with reproduction steps. Do not change files during this review.\n${CHECKS.map(([, key]) => `- ${t(key)}`).join('\n')}`)}>{t('studio.askVerify')}</button>
  </div>
}
export function HistoryPanel({ root, running, onRestored }: { root: string; running: boolean; onRestored(): void }) {
  const { t, locale } = useI18n()
  const [versions, setVersions] = useState<CodeStudioSnapshotSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.tangu?.codeStudioVersions?.(root).then(list => { if (live) setVersions(list) }).catch(e => { if (live) setError(String(e.message || e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [root])
  const allowed = () => {
    const app = useApp.getState()
    return !app.sessions.some(session => normPath(session.project_path || '') === normPath(root) && !!app.runningBySession[session.id]) && !hasUnsavedStudioEditors(root)
  }
  const save = async () => {
    if (busy || running) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (!await flushStudioEditors(root) || !allowed()) throw new Error(t('studio.saveFirst'))
      const version = await window.tangu!.codeStudioSnapshot!(root, name.trim() || `${projectName(root)} · ${new Date().toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-GB')}`)
      setVersions(old => [version, ...old]); setName(''); setNotice(t('studio.versionSaved'))
    } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
  }
  const restore = async (id: string) => {
    if (busy || !allowed()) { setError(t('studio.saveFirst')); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await window.tangu!.codeStudioRestore!(root, id)
      setConfirm(null)
      setNotice(t('studio.restored', { restored: result.restored.length, deleted: result.deleted.length }))
      if (result.conflicts.length) setError(t('studio.restoreConflicts', { count: result.conflicts.length }) + '\n' + result.conflicts.join('\n'))
      setVersions(await window.tangu!.codeStudioVersions!(root)); onRestored()
    } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
  }
  return <div className="csu-panel-body"><p className="csu-hint">{t('studio.historyHint')}</p>
    <div className="csu-version-create"><input aria-label={t('studio.versionName')} placeholder={t('studio.versionName')} maxLength={100} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) void save() }} /><button className="csu-primary" disabled={busy || running} onClick={() => void save()}>{busy ? <Loader2 size={14} className="csx-spin" /> : <Save size={14} />}{t('studio.saveVersion')}</button></div>
    {error && <p className="csu-error" role="alert">{error}</p>}{notice && <p className="csu-hint" role="status">{notice}</p>}
    {loading ? <Loader2 className="csx-spin" size={18} /> : !versions.length ? <p className="csu-hint">{t('studio.noVersions')}</p> : <div className="csu-versions">{versions.map(version => <div className="csu-version" key={version.id}><History size={15} /><div><strong>{version.name}</strong><small>{new Date(version.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-GB')} · {version.files} {t('studio.files')}</small>
      {confirm === version.id && <div className="csu-restore-confirm"><p>{t('studio.confirmRestore')}</p><button className="csu-primary" disabled={busy || running} onClick={() => void restore(version.id)}>{t('studio.restore')}</button><button disabled={busy} onClick={() => setConfirm(null)}>{t('studio.cancel')}</button></div>}
    </div><button disabled={busy || running} aria-label={`${t('studio.restore')} ${version.name}`} onClick={() => setConfirm(version.id)}><Undo2 size={15} /></button></div>)}</div>}
  </div>
}
export function PanelHeader({ title, close }: { title: string; close(): void }) { const { t } = useI18n(); return <div className="csu-panel-head"><strong>{title}</strong><button className="icon-btn" aria-label={t('studio.close')} onClick={close}><X size={16} /></button></div> }
