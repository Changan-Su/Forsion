/** Coding Studio: project brief → build → real preview → evidence-based iteration → source versions. */
import { createPortal } from 'react-dom'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Code2, Eye, Columns2, Folder, Globe, Loader2, ExternalLink, RotateCw, Monitor, Tablet, Smartphone, MousePointer2, TerminalSquare, FileText, History, CheckSquare, AlertCircle, Settings2, Square, X, ArrowLeft, PanelLeft, PanelRight, PanelBottom, FolderTree } from 'lucide-react'
import { getView, useWorkspace, type ViewProps, type ExtendViewController } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { ConnectPublishDialog } from '../components/ConnectPublishDialog'
import { useApp } from '../stores/appStore'
import { useCodeStudio, type StudioMode } from '../stores/codeStudioStore'
import { useI18n } from '../i18n'
import { parseStreamingWrite } from './streamingWrite'
import { ProjectLaunchpad } from './coding/ProjectLaunchpad'
import { buildStudioDraft, type StudioBrief } from './coding/projectBrief'
import { saveStudioBriefFile } from './coding/briefFile'
import { StudioEditor } from './coding/StudioEditor'
import { flushStudioEditors, getUnsavedStudioEditorPaths } from './coding/editorSession'
import { StudioPreview } from './coding/StudioPreview'
import { BriefPanel, ChecksPanel, HistoryPanel } from './coding/StudioPanels'
import { collectStudioWrites, inflightStudioWrite, issuePrompt, elementPrompt, joinProjectPath, projectName, projectRelative, normPath, normalizeDevUrl, type StudioIssue, type SelectedElement, type PreviewDevice } from './coding/studioModel'
import { useStudioTools } from './coding/useStudioTools'
import { StudioReveal } from './coding/StudioReveal'
import { registerStudioCommands } from './coding/studioCommands'
import type { UiMessage } from '../types'
import './coding/studioMessages'
import './coding/studio.css'
const CodeView = lazyRetry(() => import('../components/CodeView'))
const EMPTY_MESSAGES: UiMessage[] = []
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'vendor'])
async function scanFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 6 || files.length >= 600) return
    const list = await window.tangu!.listDir!(dir)
    for (const item of list) {
      if (files.length >= 600) break
      if (item.name.startsWith('.') || SKIP.has(item.name)) continue
      const relative = prefix + item.name
      if (!projectRelative(root, item.path)) continue
      if (item.isDir) await walk(item.path, relative + '/', depth + 1)
      else files.push(relative)
    }
  }
  await walk(root, '', 0)
  return files.sort((a, b) => a.localeCompare(b))
}
function useThrottled<T>(value: T): T {
  const [display, setDisplay] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, 80 - (Date.now() - last.current))
    const timer = setTimeout(() => { last.current = Date.now(); setDisplay(value) }, wait)
    return () => clearTimeout(timer)
  }, [value])
  return display
}
export function CodeStudioView({ extendView, leaf }: ViewProps) {
  const { t } = useI18n()
  const activate = useCallback(() => useWorkspace.getState().activateLeaf(leaf.id), [leaf.id])
  const root = useCodeStudio(s => s.activeProject)
  const projectsRoot = useCodeStudio(s => s.projectsRoot)
  const projects = useCodeStudio(s => s.projects)
  const recentProjects = useMemo(() => Object.entries(projects).sort((a, b) => b[1].openedAt - a[1].openedAt).map(([path]) => ({ path, name: projectName(path) })), [projects])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [briefSaveError, setBriefSaveError] = useState<{ root: string; message: string } | null>(null)
  const briefWrites = useRef(new Set<string>())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let live = true
    if (projectsRoot || !window.tangu?.codeProjectsRoot) return
    void window.tangu.codeProjectsRoot().then(path => { if (live) { useCodeStudio.getState().setProjectsRoot(path); setError('') } }).catch(e => { if (live) setError(String(e.message || e)) })
    return () => { live = false }
  }, [projectsRoot, retry])
  useEffect(() => { if (!root) useCodeStudio.getState().idleChat() }, [root])
  const saveCreatedBrief = async (path: string, brief: StudioBrief): Promise<void> => {
    path = normPath(path)
    if (briefWrites.current.has(path)) return
    briefWrites.current.add(path)
    setBriefSaveError(old => old?.root === path ? null : old)
    try {
      // Queue only after the portable brief is durable. Project switches must never hand this prompt to another project.
      await saveStudioBriefFile(path, brief)
      if (alive.current && useCodeStudio.getState().activeProject === path) useCodeStudio.getState().queuePrompt(buildStudioDraft(brief))
    } catch (e) {
      if (alive.current) setBriefSaveError({ root: path, message: String((e as Error).message || e) })
    } finally { briefWrites.current.delete(path) }
  }
  const create = (path: string, name: string, brief: StudioBrief) => {
    useCodeStudio.getState().openProject(path, name)
    useCodeStudio.getState().updateProject({ brief })
    void saveCreatedBrief(path, brief)
  }
  if (root) return <ProjectStudio key={root} root={root} extendView={extendView} onActivate={activate} briefSaveError={briefSaveError?.root === root ? briefSaveError.message : ''} retryBrief={() => {
    const brief = useCodeStudio.getState().projects[root]?.brief
    if (brief) void saveCreatedBrief(root, brief)
  }} />
  return <div className="csu-launch-root">{error && <div className="csu-error" role="alert">{t('studio.loadError', { error })}<button onClick={() => setRetry(n => n + 1)}>{t('studio.retry')}</button></div>}<ProjectLaunchpad root={projectsRoot} recentProjects={recentProjects} onOpen={(path, name) => useCodeStudio.getState().openProject(path, name)} onCreate={create} /></div>
}
function ProjectStudio({ root, extendView, onActivate, briefSaveError, retryBrief }: { root: string; extendView?: ExtendViewController; onActivate(): void; briefSaveError: string; retryBrief(): void }) {
  const { t } = useI18n()
  const activeId = useApp(s => s.activeId)
  const session = useApp(s => s.sessions.find(item => item.id === s.activeId))
  const messages = useApp(s => activeId && normPath(session?.project_path || '') === normPath(root) ? s.messagesBySession[activeId] || EMPTY_MESSAGES : EMPTY_MESSAGES)
  const running = useApp(s => s.sessions.some(item => normPath(item.project_path || '') === normPath(root) && !!s.runningBySession[item.id]))
  const mode = useCodeStudio(s => s.mode)
  const entry = useCodeStudio(s => s.entry)
  const activeFile = useCodeStudio(s => s.activeFile)
  const prefs = useCodeStudio(s => s.projects[root])
  const reloadNonce = useCodeStudio(s => s.reloadNonce)
  const [origin, setOrigin] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [serveError, setServeError] = useState('')
  const [scanError, setScanError] = useState('')
  const [watchError, setWatchError] = useState('')
  const tools = useStudioTools(extendView, root, { embeddedFallback: true })
  const panel = tools.active?.kind ?? null
  const openTool = tools.open
  const [issues, setIssues] = useState<StudioIssue[]>([])
  const [description, setDescription] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [selected, setSelected] = useState<SelectedElement | null>(null)
  const [change, setChange] = useState('')
  const [previewStatus, setPreviewStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pendingChanges, setPendingChanges] = useState(false)
  const [fileRevision, setFileRevision] = useState(0)
  const [showPublish, setShowPublish] = useState(false)
  const [urlDraft, setUrlDraft] = useState(prefs.devUrl)
  const [urlError, setUrlError] = useState('')
  const [scanNonce, setScanNonce] = useState(0)
  const [serveNonce, setServeNonce] = useState(0)
  const [watchNonce, setWatchNonce] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => registerStudioCommands(root, openTool, () => mounted.current && useCodeStudio.getState().activeProject === root), [root, openTool])
  useEffect(() => { useCodeStudio.getState().bindChatToProject(root, projectName(root)) }, [root, activeId])
  useEffect(() => {
    let live = true
    setServeError('')
    void window.tangu?.codePreviewServe?.(root).then(result => { if (live) setOrigin(result.origin) }).catch(e => { if (live) setServeError(String(e.message || e)) })
    return () => { live = false }
  }, [root, serveNonce])
  useEffect(() => {
    let live = true
    void scanFiles(root).then(list => {
      if (!live) return
      setFiles(list); setScanError('')
      const html = list.filter(path => /\.html?$/i.test(path))
      const current = useCodeStudio.getState().entry
      if (!current || !html.includes(current)) useCodeStudio.getState().setEntry(html.find(path => path === 'index.html') || html.find(path => path.endsWith('/index.html')) || html[0] || null)
    }).catch(e => { if (live) setScanError(String(e.message || e)) })
    return () => { live = false }
  }, [root, scanNonce])
  const refreshForChange = useCallback(() => {
    if (!mounted.current) return
    setFileRevision(n => n + 1); setScanNonce(n => n + 1)
    const studio = useCodeStudio.getState()
    if (studio.activeProject !== root) return
    studio.updateProject({ checks: {} })
    if (studio.projects[root]?.autoRefresh) { studio.reload(); setPendingChanges(false) }
    else setPendingChanges(true)
  }, [root])
  useEffect(() => {
    if (!window.tangu?.codeStudioWatch || !window.tangu.onCodeStudioChanged) return
    let live = true
    setWatchError('')
    let canonicalRoot: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.tangu.onCodeStudioChanged(event => {
      if (!live || normPath(event.root) !== normPath(canonicalRoot || root)) return
      if (event.error) { setWatchError(event.error); return }
      setWatchError('')
      clearTimeout(timer); timer = setTimeout(refreshForChange, 400)
    })
    void window.tangu.codeStudioWatch(root).then(r => { if (live) canonicalRoot = r.root }).catch(e => { if (live) setWatchError(String(e.message || e)) })
    return () => { live = false; clearTimeout(timer); off(); void window.tangu?.codeStudioWatch?.(null).catch(() => {}) }
  }, [root, refreshForChange, watchNonce])
  const changedFiles = useMemo(() => collectStudioWrites(messages, root), [messages, root])
  const writeSig = changedFiles.join('|') + messages.flatMap(m => m.toolEvents || []).filter(e => e.done).map(e => e.id).join('|')
  const previousWrite = useRef(writeSig)
  useEffect(() => {
    if (previousWrite.current === writeSig) return
    previousWrite.current = writeSig
    // The filesystem watcher also covers shell tools / external editors. Tool events are a fallback for old hosts.
    if (!window.tangu?.codeStudioWatch) refreshForChange()
  }, [writeSig, refreshForChange])
  const inflight = useMemo(() => inflightStudioWrite(messages), [messages])
  const streamArgs = useThrottled(inflight?.arguments || '')
  const streaming = useMemo(() => {
    if (!inflight) return null
    const parsed = parseStreamingWrite(streamArgs)
    if (!parsed.path || parsed.content == null) return null
    const relative = projectRelative(root, parsed.path)
    return relative ? { file: relative, content: parsed.content.slice(-500_000) } : null
  }, [inflight, streamArgs, root])
  const htmlFiles = files.filter(path => /\.html?$/i.test(path))
  const previewUrl = prefs.devUrl || (origin && entry ? `${origin}/${entry.split('/').map(encodeURIComponent).join('/')}` : null)
  const codeFile = activeFile || (entry ? joinProjectPath(root, entry) : files[0] ? joinProjectPath(root, files[0]) : null)
  const waiting = messages.some(m => m.approvals?.some(a => a.status === 'pending') || m.inquiries?.some(q => q.status === 'pending'))
  const addIssue = useCallback((issue: StudioIssue) => setIssues(old => {
    if (old.some(item => item.message === issue.message && item.source === issue.source)) return old
    return [...old.slice(-49), issue]
  }), [])
  const onPrompt = (text: string, plan?: boolean) => {
    if (useCodeStudio.getState().activeProject !== root) return
    const app = useApp.getState()
    useCodeStudio.getState().bindChatToProject(root, projectName(root))
    const id = useApp.getState().activeId
    if (plan !== undefined) {
      if (id) app.setSessionPlanMode(plan, id)
      else app.setNewChatCfg(config => ({ ...config, planMode: plan }))
    }
    useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary', studio: true }, 'left')
    useCodeStudio.getState().queuePrompt(text)
    app.toast(t('studio.promptReady'))
  }
  const reload = () => { setPendingChanges(false); setIssues([]); setScanNonce(n => n + 1); setFileRevision(n => n + 1); useCodeStudio.getState().reload() }
  const openTerminal = () => {
    if (getView('terminal')) useWorkspace.getState().openView('terminal', { cwd: root, reuseKey: `studio:${root}` }, 'bottom')
  }
  const publish = async () => {
    const saved = await flushStudioEditors(root)
    if (!mounted.current || useCodeStudio.getState().activeProject !== root) return
    if (!saved) {
      const pending = getUnsavedStudioEditorPaths(root)[0]
      if (pending) useCodeStudio.getState().openFile(pending)
      useApp.getState().toast(t('studio.saveFirst'), true); return
    }
    if (prefs.devUrl) { openTool('setup'); useApp.getState().toast(t('studio.publishStaticOnly'), true); return }
    const projectsRoot = useCodeStudio.getState().projectsRoot
    if (projectsRoot && !projectRelative(projectsRoot, root)) { useApp.getState().toast(t('studio.publishImported'), true); return }
    setShowPublish(true)
  }
  const openFiles = () => useWorkspace.getState().openView('workspace', {}, 'right')
  return <div className="csx csu" data-mode={mode}>
    <header className="csx-head csu-head">
      <button className="csu-project" title={t('coding.switchProject')} onClick={() => useCodeStudio.getState().closeProject()}><ArrowLeft size={15} /><span>{projectName(root)}</span></button>
      <div className="csu-modes" role="group" aria-label={t('coding.preview')}>
        {([['preview', Eye, 'coding.preview'], ['code', Code2, 'coding.code'], ['split', Columns2, 'studio.split']] as const).map(([value, Icon, key]) => <button key={value} aria-pressed={mode === value} onClick={() => { useCodeStudio.getState().setMode(value as StudioMode); if (value === 'code') setInspecting(false) }}><Icon size={14} /><span>{t(key)}</span></button>)}
      </div>
      <div className="csu-head-actions">
        {!!window.tangu?.connectPublish && <button className="csu-primary" disabled={running || !entry || !!prefs.devUrl} onClick={() => void publish()}><Globe size={14} /><span>{t('coding.publish')}</span></button>}
      </div>
    </header>
    <div className="csu-tools">
      <div className="csu-device" role="group" aria-label={t('coding.preview')}>{([['desktop', Monitor], ['tablet', Tablet], ['phone', Smartphone]] as const).map(([device, Icon]) => <button key={device} aria-label={t(`studio.${device}`)} title={t(`studio.${device}`)} aria-pressed={prefs.device === device} onClick={() => useCodeStudio.getState().updateProject({ device: device as PreviewDevice })}><Icon size={15} /></button>)}</div>
      <button className="csu-address" title={previewUrl || t('studio.setup')} onClick={() => openTool('setup')}><span>{prefs.devUrl || entry || t('studio.staticPreview')}</span><Settings2 size={13} /></button>
      <button title={t('coding.reload')} aria-label={t('coding.reload')} onClick={reload}><RotateCw size={15} /></button>
      <button className="csu-inspect" title={t('studio.inspect')} aria-label={t('studio.inspect')} disabled={!previewUrl || mode === 'code' || previewStatus !== 'ready'} aria-pressed={inspecting} onClick={() => setInspecting(value => !value)}><MousePointer2 size={15} /><span>{t('studio.inspectShort')}</span></button>
      {!!window.tangu?.openExternal && <button title={t('preview.openInBrowser')} aria-label={t('preview.openInBrowser')} disabled={!previewUrl} onClick={() => { if (previewUrl) void window.tangu!.openExternal!(previewUrl) }}><ExternalLink size={15} /></button>}
    </div>
    {(serveError || scanError || watchError) && <div role="alert" className="csu-error">{serveError || scanError ? t('studio.loadError', { error: [serveError, scanError].filter(Boolean).join('\n') }) : t('studio.watchError', { error: watchError })}<button onClick={() => { setScanNonce(n => n + 1); setServeNonce(n => n + 1); setWatchNonce(n => n + 1) }}>{t('studio.retry')}</button></div>}
    {briefSaveError && <div role="alert" className="csu-error">{t('studio.loadError', { error: briefSaveError })}<button onClick={retryBrief}>{t('studio.retry')}</button></div>}
    <div className="csu-workspace">
      <div className="csu-edit-preview">
        <section className="csu-code-pane" aria-hidden={mode === 'preview'} inert={mode === 'preview'} aria-label={t('coding.code')}>
          <div className="csu-filebar"><Code2 size={13} /><select aria-label={t('studio.files')} value={codeFile ? projectRelative(root, codeFile) || '' : ''} onChange={e => useCodeStudio.getState().setActiveFile(joinProjectPath(root, e.target.value))}><option value="" disabled>{t('coding.noFile')}</option>{files.map(file => <option key={file} value={file}>{file}</option>)}</select></div>
          {streaming && (!activeFile || projectRelative(root, activeFile) === streaming.file) ? <><div className="csu-writing"><Loader2 size={13} className="csx-spin" />{t('studio.streaming', { file: streaming.file })}</div><Suspense fallback={<div className="csx-empty">…</div>}><CodeView value={streaming.content} fileName={streaming.file} autoScroll /></Suspense></> : codeFile ? <StudioEditor path={codeFile} reloadNonce={fileRevision} onSaved={refreshForChange} /> : <div className="csx-empty">{t('coding.pickFile')}</div>}
        </section>
        <section className="csu-preview-pane" aria-hidden={mode === 'code'} inert={mode === 'code'} aria-label={t('coding.preview')}>
          {previewUrl ? <StudioPreview key={previewUrl} url={previewUrl} nonce={reloadNonce} device={prefs.device} visible={!showPublish && (!!extendView || !tools.active)} onActivate={onActivate} inspecting={inspecting} onInspectEnd={() => setInspecting(false)} onSelect={setSelected} onIssue={addIssue} onStatus={setPreviewStatus} /> : <div className="csu-first-page"><div className="csu-first-icon"><Code2 size={28} /></div><h2>{t('studio.firstPage')}</h2><p>{t('studio.firstPageHint')}</p><div className="csu-actions"><button className="csu-primary" onClick={() => openTool('brief')}><FileText size={14} />{t('studio.project')}</button></div></div>}
        </section>
      </div>

    </div>
    <StudioReveal open={!!selected}>{selected && <div className="csu-selection"><div className="csu-selection-head"><MousePointer2 size={15} /><strong>{t('studio.selection')}</strong><code>{selected.selector}</code><button title={t('studio.close')} aria-label={t('studio.close')} onClick={() => { setSelected(null); setChange('') }}><X size={15} /></button></div>{selected.text && <p>{selected.text.slice(0, 180)}</p>}<div className="csu-actions"><input aria-label={t('studio.changePlaceholder')} placeholder={t('studio.changePlaceholder')} value={change} onChange={e => setChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && change.trim()) { onPrompt(elementPrompt(selected, change), false); setSelected(null); setChange('') } }} /><button className="csu-primary" disabled={!change.trim()} onClick={() => { onPrompt(elementPrompt(selected, change), false); setSelected(null); setChange('') }}>{t('studio.addToChat')}</button></div></div>}</StudioReveal>
    <footer className="csu-footer">
      <nav className="csu-tool-nav" aria-label={t('studio.projectTools')}>
        {([['brief', FileText, 'studio.project'], ['history', History, 'studio.history'], ['checks', CheckSquare, 'studio.checks']] as const).filter(([kind]) => kind !== 'history' || !!window.tangu?.codeStudioVersions).map(([kind, Icon, key]) => <button key={kind} aria-label={t(key)} title={t(key)} aria-pressed={panel === kind} onClick={() => openTool(kind)}><Icon size={14} /><span>{t(key)}</span></button>)}
        <span className="csu-tool-divider" />
        <button title={t('studio.files')} aria-label={t('studio.files')} onClick={openFiles}><FolderTree size={14} /><span>{t('studio.filesShort')}</span></button>
        {!!getView('terminal') && <button title={t('studio.terminal')} aria-label={t('studio.terminal')} onClick={openTerminal}><TerminalSquare size={14} /></button>}
        {!!window.tangu?.revealHostPath && <button title={t('studio.reveal')} aria-label={t('studio.reveal')} onClick={() => void window.tangu!.revealHostPath!(root)}><Folder size={14} /></button>}
      </nav>
    <div className="csu-status" role="status"><span className={running ? 'csu-status-running' : ''}>{running ? <Loader2 size={13} className="csx-spin" /> : <Eye size={13} />}{waiting ? t('studio.waiting') : running ? t('studio.building') : previewUrl ? t(previewStatus === 'ready' ? 'studio.previewReady' : previewStatus === 'error' ? 'studio.previewFailed' : 'studio.loading') : t('studio.previewIdle')}</span>
      {changedFiles.length > 0 && <span className="csu-changed">{t('studio.filesChanged', { count: changedFiles.length })}</span>}
      <span className="csu-grow" />{pendingChanges && <button onClick={reload}>{t('studio.pendingChanges')}</button>}
      <label className="csu-live"><input type="checkbox" checked={prefs.autoRefresh} onChange={e => { useCodeStudio.getState().updateProject({ autoRefresh: e.target.checked }); if (e.target.checked && pendingChanges) reload() }} />{t('studio.autoRefresh')}</label>
      {running && <button title={t('studio.stopped')} aria-label={t('studio.stopped')} onClick={() => { const app = useApp.getState(); for (const item of app.sessions) if (normPath(item.project_path || '') === normPath(root) && app.runningBySession[item.id]) app.stop(item.id) }}><Square size={12} /></button>}
      <button className={issues.length ? 'csu-issue-count' : ''} onClick={() => openTool('issues')} aria-label={t('studio.issues')}><AlertCircle size={13} />{issues.length || t('studio.issues')}</button>
    </div>
    </footer>
    {tools.render((tool, side) => <div className="csu csu-tool-view" data-tool={tool} data-side={side}>
      <div className="csu-tool-placement"><span>{projectName(root)}</span><div role="group" aria-label={t('studio.panelPosition')}>
        {([['left', PanelLeft], ['bottom', PanelBottom], ['right', PanelRight]] as const).map(([next, Icon]) => <button key={next} aria-label={t(`studio.move.${next}`)} title={t(`studio.move.${next}`)} aria-pressed={side === next} onClick={() => openTool(tool, next)}><Icon size={13} /></button>)}
      </div></div>
        {tool === 'brief' && <BriefPanel root={root} onPrompt={onPrompt} />}
        {tool === 'checks' && <ChecksPanel root={root} onPrompt={text => onPrompt(text, true)} />}
        {tool === 'history' && <HistoryPanel root={root} running={running} onRestored={refreshForChange} />}
        {tool === 'issues' && <div className="csu-panel-body csu-issues-layout"><section className="csu-issue-evidence"><p className="csu-hint">{issues.length ? t('studio.errorCount', { count: issues.length }) : t('studio.noIssues')}</p>{issues.map(issue => <div className="csu-issue" key={issue.id}><AlertCircle size={14} /><div><pre>{issue.message}</pre>{issue.source && <small>{issue.source}</small>}</div></div>)}</section><section className="csu-issue-request"><label className="csu-field"><span>{t('studio.issueDescription')}</span><textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></label><div className="csu-actions"><button className="csu-primary" onClick={() => onPrompt(issuePrompt(issues, description, previewUrl), false)}>{t('studio.diagnose')}</button><button onClick={() => setIssues([])}>{t('studio.clearIssues')}</button></div></section></div>}
        {tool === 'setup' && <div className="csu-panel-body"><label className="csu-field"><span>{t('studio.entry')}</span><select value={entry || ''} onChange={e => { useCodeStudio.getState().setEntry(e.target.value); useCodeStudio.getState().updateProject({ devUrl: '' }); setUrlDraft('') }}><option value="" disabled>{t('coding.noEntry')}</option>{htmlFiles.map(file => <option key={file}>{file}</option>)}</select></label><h3>{t('studio.devServer')}</h3><p className="csu-hint">{t('studio.devHint')}</p><label className="csu-field"><span>{t('studio.devUrl')}</span><input placeholder="http://localhost:5173" value={urlDraft} onChange={e => { setUrlDraft(e.target.value); setUrlError('') }} /></label>{urlError && <p className="csu-error">{urlError}</p>}<div className="csu-actions"><button className="csu-primary" onClick={() => { const url = normalizeDevUrl(urlDraft); if (url === null) { setUrlError(t('studio.invalidUrl')); return } useCodeStudio.getState().updateProject({ devUrl: url }); setIssues([]); tools.close() }}>{t('studio.apply')}</button><button onClick={() => { setUrlDraft(''); useCodeStudio.getState().updateProject({ devUrl: '' }); setIssues([]) }}>{t('studio.useStatic')}</button></div>{!!getView('terminal') && <button onClick={openTerminal}><TerminalSquare size={14} />{t('studio.terminal')}</button>}</div>}
    </div>)}
    {showPublish && createPortal(<ConnectPublishDialog root={root} projectName={projectName(root)} entry={entry} htmlFiles={htmlFiles} onClose={() => setShowPublish(false)} />, document.body)}
  </div>
}
