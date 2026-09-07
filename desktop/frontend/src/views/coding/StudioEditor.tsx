import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Copy, FileWarning, Loader2, Save, WrapText } from 'lucide-react'
import { lazyRetry } from '../../lazyRetry'
import { useI18n } from '../../i18n'
import { getStudioEditorSession, type EditorErrorKind, type EditorStatus } from './editorSession'
import './editorMessages'
import './editor.css'

const CodeView = lazyRetry(() => import('../../components/CodeView'))
const statusKeys: Record<EditorStatus, string> = {
  loading: 'coding.editor.loading', saved: 'coding.editor.saved', dirty: 'coding.editor.dirty', saving: 'coding.editor.saving',
  conflict: 'coding.editor.conflict', error: 'coding.editor.error', readonly: 'coding.editor.readonly', recovered: 'coding.editor.recovered',
}
const errorKeys: Record<EditorErrorKind, string> = {
  read: 'coding.editor.readError', write: 'coding.editor.writeError', tooLarge: 'coding.editor.tooLarge', binary: 'coding.editor.binary',
  unavailable: 'coding.editor.unavailable', revision: 'coding.editor.readonlyHint',
}

export interface StudioEditorProps {
  path: string
  reloadNonce?: number
  onSaved?: (path: string) => void
  onDirtyChange?: (dirty: boolean, path: string) => void
}

export function StudioEditor({ path, reloadNonce = 0, onSaved, onDirtyChange }: StudioEditorProps) {
  const { t } = useI18n()
  const session = useMemo(() => getStudioEditorSession(path), [path])
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const [wrap, setWrap] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [recoveryIndex, setRecoveryIndex] = useState(0)
  const callbacks = useRef({ onSaved, onDirtyChange })
  callbacks.current = { onSaved, onDirtyChange }

  useEffect(() => {
    // Capture this file's callbacks before detach. Its outstanding save can still
    // notify preview invalidation after the editor has switched to another file.
    let seen = session.getSnapshot().savedSequence
    const saved = callbacks.current.onSaved
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot().savedSequence
      if (next !== seen) { seen = next; saved?.(session.path) }
    })
    return () => { void session.flush().finally(unsubscribe) }
  }, [session])
  useEffect(() => { void session.load() }, [session, reloadNonce])
  useEffect(() => { callbacks.current.onDirtyChange?.(state.dirty || state.status === 'saving', path) }, [state.dirty, state.status, path])
  useEffect(() => { setCopyState('idle'); setRecoveryIndex(0) }, [session, state.content])

  const copy = async (content: string): Promise<void> => {
    try { await navigator.clipboard.writeText(content); setCopyState('copied') }
    catch { setCopyState('error') }
  }
  const issue = state.status === 'conflict' || state.status === 'error'
  const hintKey = state.status === 'conflict' ? 'coding.editor.conflictHint'
    : state.errorKind ? errorKeys[state.errorKind] : state.status === 'readonly' ? 'coding.editor.readonlyHint' : null
  const recovery = state.recoveryDrafts[Math.min(recoveryIndex, state.recoveryDrafts.length - 1)]

  return <div className="cs-editor" data-status={state.status} data-path={path} onKeyDownCapture={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation()
      void session.retry()
    }
  }}>
    <div className="cs-editor-toolbar">
      <span className="cs-editor-status" role="status" aria-live="polite">
        {state.status === 'saving' || state.status === 'loading' ? <Loader2 size={13} className="cs-editor-spin" /> : issue ? <FileWarning size={13} /> : state.status === 'saved' ? <Check size={13} /> : <Save size={13} />}
        {t(statusKeys[state.status])}
      </span>
      <div className="cs-editor-actions">
        {(state.dirty || issue || state.status === 'recovered') && <button type="button" onClick={() => void copy(state.content)}><Copy size={12} />{t(copyState === 'copied' ? 'coding.editor.copied' : 'coding.editor.copyDraft')}</button>}
        {(state.status === 'error' || state.status === 'recovered' || state.status === 'dirty') && <button type="button" onClick={() => void session.retry()}>{t(state.status === 'error' ? 'coding.editor.retry' : 'coding.editor.save')}</button>}
        <button type="button" aria-pressed={wrap} title={t('coding.editor.wrap')} aria-label={t('coding.editor.wrap')} onClick={() => setWrap((v) => !v)}><WrapText size={14} /></button>
      </div>
    </div>
    {hintKey && <div className="cs-editor-notice" role={issue ? 'alert' : 'note'}>
      <span>{t(hintKey)}</span>
      {(state.status === 'conflict' || (state.status === 'error' && state.dirty)) && <button type="button" onClick={() => void session.loadDisk()}>{t('coding.editor.loadDisk')}</button>}
    </div>}
    {state.storageFailed && <div className="cs-editor-notice" role="alert">{t('coding.editor.storageFailed')}</div>}
    {copyState === 'error' && <div className="cs-editor-notice" role="alert">{t('coding.editor.copyError')}</div>}
    {(issue || copyState === 'error') && <details className="cs-editor-recovery">
      <summary>{t('coding.editor.draftContent')}</summary>
      <textarea readOnly value={state.content} aria-label={t('coding.editor.draftContent')} />
    </details>}
    {state.recoveryDrafts.length > 0 && <details className="cs-editor-recovery">
      <summary>{t('coding.editor.recovery', { count: state.recoveryDrafts.length })}</summary>
      <p>{t('coding.editor.recoveryHint')}</p>
      <div className="cs-editor-recovery-actions">
        <select value={Math.min(recoveryIndex, state.recoveryDrafts.length - 1)} onChange={(e) => setRecoveryIndex(Number(e.target.value))} aria-label={t('coding.editor.recovery', { count: state.recoveryDrafts.length })}>
          {state.recoveryDrafts.map((_, index) => <option key={index} value={index}>{t('coding.editor.draftVersion', { number: index + 1 })}</option>)}
        </select>
        <button type="button" onClick={() => void copy(recovery)}>{t('coding.editor.copyDraft')}</button>
        {session.canEdit() && <button type="button" onClick={() => session.restoreDraft(recoveryIndex)}>{t('coding.editor.restore')}</button>}
      </div>
      <textarea readOnly value={recovery} aria-label={t('coding.editor.recovery', { count: state.recoveryDrafts.length })} />
    </details>}
    <div className="cs-editor-code">
      {!state.loaded && !state.content
        ? <div className="cs-editor-placeholder">{t(hintKey || statusKeys[state.status])}</div>
        : <Suspense fallback={<div className="cs-editor-placeholder">{t('coding.editor.loading')}</div>}>
          <CodeView key={path} value={state.content} fileName={path} editable={session.canEdit()} onChange={session.edit} wrap={wrap} />
        </Suspense>}
    </div>
    <div className="cs-editor-footer"><span>{path.replace(/\\/g, '/').split('/').pop()}</span><span>{t('coding.editor.lines', { count: state.content.split('\n').length })}</span><span>UTF-8</span></div>
  </div>
}

export default StudioEditor
