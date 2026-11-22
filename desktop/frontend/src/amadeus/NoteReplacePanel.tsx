import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { ChevronLeft, Replace, Search } from 'lucide-react'
import { useWorkspace } from '@lcl/engine'
import { useMobileBackClose } from '@amadeus/lib/mobileBack'
import { usePageStore } from '@amadeus/store/pageStore'
import {
  applyNoteReplace, loadNoteReplaceBatch, previewNoteReplace, resumeNoteReplace, undoNoteReplace,
  type ReplaceBatch, type ReplaceMatch, type ReplacePlan,
} from '@amadeus/lib/noteBatchReplace'
import { registerMessages, useI18n } from '../i18n'
import { matchContext, noteTitle, NoteReplaceBody, REVIEW_VIEW, useReplacePreview } from './NoteReplacePreview'
import './noteReplace.css'

registerMessages({
  'noteReplace.title': { zh: '跨笔记替换', en: 'Replace across notes' },
  'noteReplace.backSearch': { zh: '返回全文搜索', en: 'Back to search' },
  'noteReplace.search': { zh: '查找', en: 'Find' },
  'noteReplace.find': { zh: '查找正文', en: 'Find in note text' },
  'noteReplace.with': { zh: '替换为', en: 'Replace with' },
  'noteReplace.delete': { zh: '留空将删除所选文字', en: 'Leave empty to delete selected text' },
  'noteReplace.searching': { zh: '正在查找可替换的正文…', en: 'Looking for matching note text…' },
  'noteReplace.empty': { zh: '没有可替换的正文', en: 'No matching note text' },
  'noteReplace.chooseMatch': { zh: '从全文搜索选择一处匹配，查看它在笔记中的位置。', en: 'Choose a match in the search results to see it in the note.' },
  'noteReplace.preview': { zh: '替换预览', en: 'Replacement preview' },
  'noteReplace.backResults': { zh: '返回匹配结果', en: 'Back to matches' },
  'noteReplace.quoteKeep': { zh: '引用原文 · 保留', en: 'Quotation · keep original' },
  'noteReplace.quoteReplace': { zh: '引用原文 · 将替换', en: 'Quotation · replace' },
  'noteReplace.selectMatch': { zh: '选择这处匹配：{text}', en: 'Select match: {text}' },
  'noteReplace.more': { zh: '显示更多匹配（余 {n} 处）', en: 'Show more matches ({n} remaining)' },
  'noteReplace.clear': { zh: '清除勾选', en: 'Clear selection' },
  'noteReplace.selectText': { zh: '勾选非引文', en: 'Select non-quotations' },
  'noteReplace.count': { zh: '已选 {n} / {total} 处', en: '{n} of {total} selected' },
  'noteReplace.apply': { zh: '替换 {n} 处', en: 'Replace {n}' },
  'noteReplace.remove': { zh: '删除 {n} 处', en: 'Delete {n}' },
  'noteReplace.working': { zh: '正在处理…', en: 'Working…' },
  'noteReplace.same': { zh: '查找词与替换词相同。', en: 'The search and replacement text are identical.' },
  'noteReplace.retention': { zh: '此智库仅保留最近一次替换的撤销记录。', en: 'Only the latest batch in this vault can be undone.' },
  'noteReplace.result': { zh: '批次结果', en: 'Batch results' },
  'noteReplace.applied': { zh: '已替换 {n} 处', en: 'Replaced {n}' },
  'noteReplace.undone': { zh: '已撤销 {n} 处', en: 'Undid {n}' },
  'noteReplace.changed': { zh: '内容或位置已变，保留当前版本', en: 'Note changed or moved. Current version kept.' },
  'noteReplace.unsafe': { zh: '会改变 Markdown 结构，已保留原文', en: 'Kept to preserve Markdown structure' },
  'noteReplace.skipped': { zh: '未写入', en: 'Not written' },
  'noteReplace.pending': { zh: '待处理', en: 'Pending' },
  'noteReplace.failed': { zh: '处理失败', en: 'Failed' },
  'noteReplace.undo': { zh: '撤销这次替换', en: 'Undo this batch' },
  'noteReplace.resume': { zh: '继续处理', en: 'Resume batch' },
  'noteReplace.last': { zh: '上次替换', en: 'Last batch' },
  'noteReplace.new': { zh: '重新预览', en: 'Review again' },
  'noteReplace.unavailable': { zh: '{n} 篇未能读取', en: 'Could not read {n} notes' },
  'noteReplace.exactContext': { zh: '所选位置的原文', en: 'Text at the selected match' },
  'noteReplace.serverUpdate': { zh: '云端服务需更新后才能跨笔记替换。', en: 'Update the cloud service to replace text across notes.' },
  'noteReplace.error': { zh: '操作未完成，请重试。', en: 'The operation did not complete. Try again.' },
})

export function NoteReplacePanel({ root, initialQuery, inline, onClose, innerBack }: {
  root: string; initialQuery: string; inline: boolean; onClose: (query: string) => void; innerBack?: MutableRefObject<(() => void) | null>
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState(initialQuery)
  const remote = usePageStore(s => s.vaultSide === 'cloud') || root.startsWith('cloud://')
  const [requested, setRequested] = useState('')
  const search = remote ? requested : query
  const [replacement, setReplacement] = useState('')
  const [plan, setPlan] = useState<ReplacePlan | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState('')
  const [phonePreview, setPhonePreview] = useState(false)
  const [composing, setComposing] = useState(false)
  const [composingReplacement, setComposingReplacement] = useState(false)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 650px)').matches)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState(() => loadNoteReplaceBatch(root))
  const [showBatch, setShowBatch] = useState(false)
  const [error, setError] = useState<'' | 'noteReplace.error' | 'noteReplace.serverUpdate'>('')
  const [refresh, setRefresh] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(120)
  const editing = useRef(false)
  const mounted = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const selectionBeforeRefresh = useRef<{ query: string; selected: ReadonlySet<string> } | null>(null)
  const mobile = inline || narrow
  const listShown = useWorkspace(s => s.leftVisible)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)')
    const change = () => { setNarrow(media.matches); setPhonePreview(false) }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  const current = plan?.query === query && !composing && !showBatch ? plan : null
  const allHits = useMemo(() => current?.files.flatMap(file => file.matches) ?? [], [current])
  const visibleGroups = useMemo(() => {
    const groups = []
    let remaining = visibleLimit
    for (const file of current?.files ?? []) {
      if (!remaining) break
      const hits = file.matches.slice(0, remaining)
      groups.push({ file, hits })
      remaining -= hits.length
    }
    return groups
  }, [current, visibleLimit])
  const file = current?.files.find(file => file.matches.some(m => m.id === active)) ?? current?.files[0]
  const view = useMemo(() => file ? { root, file, selected, replacement, activeId: active } : null,
    [root, file, selected, replacement, active])
  const closePreview = () => useWorkspace.getState().closeViewsOfType(REVIEW_VIEW)
  const openPreview = () => useWorkspace.getState().openView(REVIEW_VIEW, {}, 'main', { newTab: true })

  useEffect(() => {
    mounted.current = true
    // The search sidebar remains mounted while the independent, read-only main tab is open.
    if (!mobile) openPreview()
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => {
      mounted.current = false
      cancelAnimationFrame(frame)
      if (!mobile) {
        useReplacePreview.setState({ current: null })
        closePreview()
      }
    }
  }, [mobile])
  useEffect(() => {
    if (!mobile) useReplacePreview.setState({ current: view })
  }, [mobile, view])

  useEffect(() => {
    setPlan(null)
    setError('')
    if (showBatch || !search.trim() || composing) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void previewNoteReplace(root, search, controller.signal).then(result => {
        if (controller.signal.aborted) return
        const old = selectionBeforeRefresh.current
        const hits = result.files.flatMap(file => file.matches)
        setSelected(new Set(hits.filter(hit => old?.query === search ? old.selected.has(hit.id) : !hit.quote).map(hit => hit.id)))
        setActive(hits[0]?.id ?? '')
        setVisibleLimit(120)
        setPlan(result)
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error && 'code' in failure && failure.code === 'NOTE_REPLACE_SERVER_UPDATE'
          ? 'noteReplace.serverUpdate' : 'noteReplace.error')
      })
    }, remote ? 0 : 400)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [root, search, remote, showBatch, composing, refresh])

  function choose(hit: ReplaceMatch) {
    setActive(hit.id)
    if (mobile) setPhonePreview(true)
    else openPreview()
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function reviewAgain() {
    setShowBatch(false)
    if (remote) setRequested(query)
    setError('')
    setRefresh(n => n + 1)
    if (!mobile) openPreview()
    requestAnimationFrame(() => input.current?.focus())
  }

  async function run(action: 'apply' | 'undo' | 'resume') {
    if (editing.current || composing || composingReplacement || usePageStore.getState().vaultRoot !== root) return
    if (action === 'apply' && (!current || !selected.size || query === replacement)) return
    if (action !== 'apply' && !batch) return
    editing.current = true
    setBusy(true)
    setError('')
    if (action === 'apply') selectionBeforeRefresh.current = { query, selected }
    try {
      const result = action === 'apply' ? await applyNoteReplace(current!, replacement, selected)
        : action === 'undo' ? await undoNoteReplace(batch!) : await resumeNoteReplace(batch!)
      if (!mounted.current) return
      setBatch(result)
      setShowBatch(true)
      setPhonePreview(false)
      if (!mobile) closePreview()
    } catch {
      if (!mounted.current) return
      setBatch(loadNoteReplaceBatch(root))
      setError('noteReplace.error')
    } finally {
      editing.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function back() {
    if (phonePreview) {
      setPhonePreview(false)
      requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-open-match="${CSS.escape(active)}"]`)?.focus({ preventScroll: true }))
    } else if (!editing.current) onClose(query)
  }

  // The owning phone list handles Back after all overlays. Give it the deepest local action
  // instead of installing a second listener on the same window event.
  const backRef = useRef(back)
  backRef.current = back
  useMobileBackClose(mobile && !inline && listShown, back)
  useEffect(() => {
    if (!innerBack) return
    innerBack.current = () => backRef.current()
    return () => { innerBack.current = null }
  }, [innerBack])

  const header = <div className="amx-replace-head">
    <button type="button" className="amx-panel-head amx-replace-back" disabled={busy} onClick={back}
      aria-label={t(phonePreview ? 'noteReplace.backResults' : 'noteReplace.backSearch')}>
      <ChevronLeft size={15} />{t(phonePreview ? 'noteReplace.backResults' : 'noteReplace.title')}
    </button>
    {batch && !showBatch && !phonePreview && <button className="amx-search-save" type="button" disabled={busy}
      onClick={() => { setShowBatch(true); if (!mobile) closePreview() }}>{t('noteReplace.last')}</button>}
  </div>

  return <div className={`amx-panel amx-replace-panel${inline ? ' amx-panel--inlist' : ''}`} ref={panel}
    onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing && !composing) { e.stopPropagation(); back() } }}>
    {header}
    {phonePreview && view ? <NoteReplaceBody view={view} /> : showBatch && batch ? <>
      <div className="amx-replace-scroll" role="status">
        <strong className="amx-replace-result-title">{t('noteReplace.result')}</strong>
        <small className="amx-replace-hint">{t('noteReplace.retention')}</small>
        {batch.files.map(file => <div className="amx-replace-result" key={file.path}>
          <span>{file.path}</span>
          <small>{t(`noteReplace.${file.status}`, { n: file.count })}</small>
        </div>)}
      </div>
      {error && <p className="amx-panel-empty" role="alert">{t(error)}</p>}
      <div className="amx-replace-actions">
        <button type="button" className="amx-search-save" onClick={reviewAgain} disabled={busy}>{t('noteReplace.new')}</button>
        {batch.files.some(f => f.status === 'pending' || f.status === 'failed') && <button type="button" className="btn sm"
          disabled={busy} onClick={() => void run('resume')}>{t('noteReplace.resume')}</button>}
        {batch.files.some(f => f.status === 'applied') && <button type="button" className="btn sm"
          disabled={busy} onClick={() => void run('undo')}>{t('noteReplace.undo')}</button>}
      </div>
    </> : <>
      <form className="t2s-search amx-search-box" onSubmit={e => { e.preventDefault(); if (remote && !composing && query.trim()) { setRequested(query); setRefresh(n => n + 1) } }}><Search size={13} />
        <input ref={input} aria-label={t('noteReplace.find')} placeholder={t('noteReplace.find')} value={query} disabled={busy}
          onKeyDown={e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault() }}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onChange={e => { selectionBeforeRefresh.current = null; setRequested(''); setQuery(e.target.value) }} />
        {remote && <button type="submit" className="amx-search-save" disabled={!query.trim() || busy || composing}>{t('noteReplace.search')}</button>}
      </form>
      <label className="t2s-search amx-search-box"><Replace size={13} />
        <input aria-label={t('noteReplace.with')} title={t('noteReplace.delete')} placeholder={t('noteReplace.with')} value={replacement} disabled={busy}
          onCompositionStart={() => setComposingReplacement(true)} onCompositionEnd={() => setComposingReplacement(false)}
          onChange={e => setReplacement(e.target.value)} />
      </label>
      <div className="amx-replace-scroll">
        {error && <div role="alert" className="amx-panel-empty">{t(error)} <button type="button" className="amx-search-save" onClick={reviewAgain}>{t('noteReplace.new')}</button></div>}
        {!error && search.trim() && !current && !composing && <div className="amx-panel-empty" role="status">{t('noteReplace.searching')}</div>}
        {current && !allHits.length && <div className="amx-panel-empty">{t('noteReplace.empty')}</div>}
        {allHits.length > 10 && <button type="button" className="amx-search-save" disabled={busy}
          onClick={() => setSelected(selected.size ? new Set() : new Set(allHits.filter(hit => !hit.quote).map(hit => hit.id)))}>
          {t(selected.size ? 'noteReplace.clear' : 'noteReplace.selectText')}
        </button>}
        {visibleGroups.map(({ file, hits }) => <section className="amx-taghit-group amx-replace-group" key={file.path}>
          <div className="amx-replace-file"><b title={file.path}>{file.path.includes('/') ? file.path : noteTitle(file.path)}</b><small>{file.matches.filter(hit => selected.has(hit.id)).length} / {file.matches.length}</small></div>
          {hits.map(hit => {
            const [before, word, after] = matchContext(file, hit)
            return <div key={hit.id} className="amx-replace-row" data-active={active === hit.id || undefined}>
              <input type="checkbox" checked={selected.has(hit.id)} disabled={busy}
                aria-label={t('noteReplace.selectMatch', { text: before + word + after })} onChange={() => toggle(hit.id)} />
              <button type="button" className="amx-replace-context" data-open-match={hit.id} onClick={() => choose(hit)}>
                <span>{before}<mark>{word}</mark>{after}</span>
                {hit.quote && <small>{t(selected.has(hit.id) ? 'noteReplace.quoteReplace' : 'noteReplace.quoteKeep')}</small>}
              </button>
            </div>
          })}
        </section>)}
        {allHits.length > visibleLimit && <button type="button" className="amx-search-save" onClick={() => setVisibleLimit(n => n + 120)}>
          {t('noteReplace.more', { n: allHits.length - visibleLimit })}
        </button>}
        {!!current?.unavailable.length && <details className="amx-replace-result"><summary>{t('noteReplace.unavailable', { n: current.unavailable.length })}</summary>
          {current.unavailable.map(path => <div key={path}>{path}</div>)}</details>}
      </div>
      {query && query === replacement && <small className="amx-replace-hint">{t('noteReplace.same')}</small>}
      <div className="amx-replace-actions"><small aria-live="polite">{t('noteReplace.count', { n: current ? selected.size : 0, total: allHits.length })}</small>
        <button type="button" className="btn primary sm" disabled={!current || !selected.size || busy || composingReplacement || query === replacement} onClick={() => void run('apply')}>
          {busy ? t('noteReplace.working') : t(replacement ? 'noteReplace.apply' : 'noteReplace.remove', { n: current ? selected.size : 0 })}
        </button>
      </div>
    </>}
  </div>
}
