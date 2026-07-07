/** Coding Space 主界面 —— 模仿 Google AI Studio 的 Code | Preview 双切换工作台。
 *  项目:`~/Forsion/Project/<项目>`,每个项目一个子文件夹。activeProject 为空 → 显示项目选择器(列已有 + 新建)。
 *  选/建项目即绑定一个 Coding 会话(cwd=项目);主区把项目目录挂本地静态服务器,iframe 加载 entry(多文件真解析)。
 *  Code:可编辑 CodeMirror,防抖写回(mtime CAS);右栏文件树点文件 → 进 Code 选中。
 *  实时跟随:Coding Agent 每写一个文件 → 刷新预览;首个 .html 自动设为入口。纯渲染端,host 缺失降级为占位。 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Code2, Eye, RotateCw, Folder, FolderPlus, Loader2 } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { useCodeStudio } from '../stores/codeStudioStore'
import { useI18n } from '../i18n'
import { b64ToBytes } from '../services/fileKinds'
import { parseStreamingWrite } from './streamingWrite'
import type { UiMessage, ToolEvent } from '../types'

const CodeView = lazy(() => import('../components/CodeView'))

/** 节流:限制值更新频率(流式代码喂给 CodeMirror ~15fps,避免每 token 全量重渲。 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const wait = ms - (Date.now() - last.current)
    if (wait <= 0) { last.current = Date.now(); setV(value) }
    else { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { last.current = Date.now(); setV(value) }, wait) }
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [value, ms])
  return v
}
const isAbsPath = (p: string): boolean => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
/** 最近一条 assistant 消息里进行中的写文件工具调用(流式源码就在它的 arguments 里)。 */
function findInflightWrite(messages?: UiMessage[]): ToolEvent | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    return messages[i].toolEvents?.find((e) => WRITE_TOOLS.has(e.name) && !e.done) ?? null
  }
  return null
}

// ── 文件写入探测(实时刷新预览)──
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'create_file', 'str_replace_editor', 'str_replace_based_edit_tool'])
function writePathOf(ev: ToolEvent): string | null {
  if (!ev.done || !WRITE_TOOLS.has(ev.name)) return null
  if (ev.artifactPath) return ev.artifactPath
  try {
    const a = JSON.parse(ev.arguments || '{}') as Record<string, unknown>
    const p = a.path ?? a.file_path ?? a.filename ?? a.file
    return typeof p === 'string' ? p : null
  } catch { return null }
}
const normSep = (p: string): string => p.replace(/\\/g, '/')
const baseName = (p: string): string => normSep(p).replace(/\/$/, '').split('/').pop() || p
function toRel(root: string, abs: string): string | null {
  const r = normSep(root).replace(/\/$/, ''); const a = normSep(abs)
  if (a === r) return ''
  return a.startsWith(r + '/') ? a.slice(r.length + 1) : null
}
function collectWrites(messages: UiMessage[], root: string): string[] {
  const out: string[] = []
  for (const m of messages) for (const ev of m.toolEvents || []) {
    const p = writePathOf(ev); if (!p) continue
    const rel = toRel(root, p); if (rel) out.push(rel)
  }
  return out
}
const joinPath = (root: string, rel: string): string => normSep(root).replace(/\/$/, '') + '/' + rel

// depth 限深 + 跳过重目录:扫描项目里的 html 作为预览入口候选。
async function scanHtml(root: string): Promise<string[]> {
  const found: string[] = []
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage'])
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length > 200) return
    const entries = (await window.tangu?.listDir?.(dir).catch(() => [])) || []
    for (const e of entries) {
      if (e.isDir) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(e.path, rel ? `${rel}/${e.name}` : e.name, depth + 1) }
      else if (e.name.toLowerCase().endsWith('.html')) found.push(rel ? `${rel}/${e.name}` : e.name)
    }
  }
  await walk(root, '', 0)
  return found.sort()
}
const pickEntry = (list: string[]): string | null =>
  list.find((f) => f === 'index.html' || f.endsWith('/index.html')) || list[0] || null

// ── 项目选择器(activeProject 为空时的空态)──
function ProjectPicker({ root }: { root: string | null }) {
  const { t } = useI18n()
  const openProject = useCodeStudio((s) => s.openProject)
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!root) { setProjects([]); return }
    const entries = (await window.tangu?.listDir?.(root).catch(() => [])) || []
    setProjects(entries.filter((e) => e.isDir && !e.name.startsWith('.')).map((e) => ({ name: e.name, path: e.path })))
  }, [root])
  useEffect(() => { void refresh() }, [refresh])

  const create = async (): Promise<void> => {
    const n = name.trim()
    if (!n || !root) return
    try {
      const r = await window.tangu?.mkdirHost?.(root, n)
      setCreating(false); setName(''); setErr(null)
      if (r?.path) openProject(r.path, n)
    } catch (e) { setErr((e as Error)?.message || String(e)) }
  }

  return (
    <div className="csx-picker">
      <div className="csx-picker-head">
        <span className="csx-picker-title">{t('coding.projects')}</span>
        <button className="csx-newproj" onClick={() => { setCreating(true); setErr(null) }}><FolderPlus size={14} />{t('coding.newProject')}</button>
      </div>
      {creating && (
        <div className="csx-newrow">
          <input
            autoFocus className="csx-newinput" placeholder={t('coding.projectName')} value={name}
            onChange={(e) => { setName(e.target.value); setErr(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); else if (e.key === 'Escape') { setCreating(false); setName(''); setErr(null) } }}
          />
          <button className="csx-newok" onClick={() => void create()}>{t('coding.create')}</button>
        </div>
      )}
      {err && <div className="csx-newerr">{err}</div>}
      {projects.length === 0 && !creating
        ? <div className="csx-empty">{t('coding.noProjects')}</div>
        : (
          <div className="csx-projlist">
            {projects.map((p) => (
              <button key={p.path} className="csx-projcard" onClick={() => openProject(p.path, p.name)}>
                <Folder size={16} /><span>{p.name}</span>
              </button>
            ))}
          </div>
        )}
    </div>
  )
}

export function CodeStudioView(_: ViewProps) {
  const { t } = useI18n()
  const activeId = useApp((s) => s.activeId)
  const messages = useApp((s) => (activeId ? s.messagesBySession[activeId] : undefined))

  const projectsRoot = useCodeStudio((s) => s.projectsRoot)
  const setProjectsRoot = useCodeStudio((s) => s.setProjectsRoot)
  const root = useCodeStudio((s) => s.activeProject) // 预览/文件根 = 当前项目
  const closeProject = useCodeStudio((s) => s.closeProject)
  const mode = useCodeStudio((s) => s.mode)
  const setMode = useCodeStudio((s) => s.setMode)
  const entry = useCodeStudio((s) => s.entry)
  const setEntry = useCodeStudio((s) => s.setEntry)
  const activeFile = useCodeStudio((s) => s.activeFile)
  const reloadNonce = useCodeStudio((s) => s.reloadNonce)
  const reload = useCodeStudio((s) => s.reload)

  const [origin, setOrigin] = useState<string | null>(null)
  const [htmlFiles, setHtmlFiles] = useState<string[]>([])
  const hasHost = !!window.tangu?.codePreviewServe

  // 首次解析项目根 ~/Forsion/Project。
  useEffect(() => {
    if (projectsRoot || !window.tangu?.codeProjectsRoot) return
    void window.tangu.codeProjectsRoot().then((r) => setProjectsRoot(r)).catch(() => {})
  }, [projectsRoot, setProjectsRoot])

  // 左侧对话跟随当前项目:切回 Coding Space(或活动会话在别处漂移过)时,把对话重绑回本项目。
  useEffect(() => {
    if (root) useCodeStudio.getState().bindChatToProject(root, baseName(root))
  }, [root])

  // 项目变 → 起/切静态服务器,重扫入口。切根后 origin 不变(同端口),同名 index.html 会导致 src 不变 → 主动 reload。
  useEffect(() => {
    if (!root || !hasHost) { setOrigin(null); setHtmlFiles([]); return }
    let cancel = false
    void window.tangu!.codePreviewServe!(root).then((r) => { if (!cancel) { setOrigin(r.origin); reload() } }).catch(() => {})
    void scanHtml(root).then((list) => {
      if (cancel) return
      setHtmlFiles(list)
      const cur = useCodeStudio.getState().entry
      if (!cur || !list.includes(cur)) setEntry(pickEntry(list))
    })
    return () => { cancel = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, hasHost])

  // 实时跟随 agent 写盘:新 html 补入口、刷新预览。
  const writeSig = useMemo(() => (root && messages ? collectWrites(messages, root).join('|') : ''), [messages, root])
  useEffect(() => {
    if (!root || !messages) return
    const rel = collectWrites(messages, root)
    if (!rel.length) return
    const htmls = rel.filter((r) => r.endsWith('.html'))
    if (htmls.length) {
      setHtmlFiles((prev) => Array.from(new Set([...prev, ...htmls])).sort())
      if (!useCodeStudio.getState().entry) setEntry(htmls.find((h) => h.endsWith('index.html')) || htmls[0])
    }
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeSig])

  // ── 流式:agent 正在写的文件,边写边在 Code 面板显示(AI Studio 式)──
  const inflight = useMemo(() => findInflightWrite(messages), [messages])
  const inflightId = inflight?.id ?? null
  const throttledArgs = useThrottledValue(inflight?.arguments ?? '', 66)
  const streaming = useMemo(() => {
    if (!inflightId) return null
    const { path, content } = parseStreamingWrite(throttledArgs)
    if (content == null) return null
    const abs = path ? (isAbsPath(path) ? path : root ? joinPath(root, path) : path) : null
    if (abs && root && toRel(root, abs) == null) return null // 写到本项目之外 → 不显示
    const rel = abs && root ? toRel(root, abs) : path ?? null
    return { abs, rel, content: content.length > 500_000 ? content.slice(-500_000) : content }
  }, [inflightId, throttledArgs, root])
  const isStreaming = !!streaming
  const streamAbs = streaming?.abs ?? null
  // 开始流式 → 切到 Code 看生成;选中该文件(流式结束后无缝接上磁盘可编辑版)。
  useEffect(() => {
    if (isStreaming && useCodeStudio.getState().mode !== 'code') useCodeStudio.getState().setMode('code')
  }, [isStreaming])
  useEffect(() => {
    if (streamAbs) useCodeStudio.getState().setActiveFile(streamAbs)
  }, [streamAbs])

  // ── Code 面板:内容加载 + 防抖写回 ──
  const codeFile = activeFile || (entry && root ? joinPath(root, entry) : null)
  const [text, setText] = useState('')
  const [mtime, setMtime] = useState<number | undefined>(undefined)
  const loadedRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancel = false
    loadedRef.current = null; dirtyRef.current = false
    if (isStreaming || !codeFile || !window.tangu?.readHostFile) { setText(''); return } // 流式期间不读盘(文件尚未落定);结束(isStreaming→false)后本 effect 重跑读最终版
    void window.tangu.readHostFile(codeFile).then((r) => {
      if (cancel || !r) return
      if (r.tooLarge) { setText(''); loadedRef.current = null; return }
      setText(new TextDecoder().decode(b64ToBytes(r.content)))
      setMtime(r.mtimeMs); loadedRef.current = codeFile
    }).catch(() => {})
    return () => { cancel = true }
  }, [codeFile, isStreaming])

  const onCode = (v: string): void => {
    setText(v)
    if (loadedRef.current !== codeFile || !codeFile) return
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const r = await window.tangu?.writeHostFile?.(codeFile, v, mtime).catch(() => null)
      dirtyRef.current = false
      if (r?.conflict) {
        // 外部(agent)已改盘:以磁盘为准重载(丢本地编辑)。ponytail: dev 预览的可接受权衡,同时编辑罕见。
        const fresh = await window.tangu?.readHostFile?.(codeFile).catch(() => null)
        if (fresh && !fresh.tooLarge) { setText(new TextDecoder().decode(b64ToBytes(fresh.content))); setMtime(fresh.mtimeMs) }
        return
      }
      if (r?.mtimeMs) { setMtime(r.mtimeMs); reload() } // 保存成功 → 刷新预览
    }, 800)
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  // 未选项目 → 项目选择器。
  if (!root) return <ProjectPicker root={projectsRoot} />

  const previewUrl = origin && entry ? `${origin}/${entry.split('/').map(encodeURIComponent).join('/')}` : null

  return (
    <div className="csx">
      <div className="csx-head">
        <button className="csx-proj" title={t('coding.switchProject')} onClick={() => closeProject()}><Folder size={13} />{baseName(root)}</button>
        <div className="csx-seg">
          <button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code2 size={13} />{t('coding.code')}</button>
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Eye size={13} />{t('coding.preview')}</button>
        </div>
        <div className="csx-title">
          {isStreaming
            ? <span className="csx-genbadge"><Loader2 size={13} className="csx-spin" />{t('coding.generating')}{streaming?.rel ? ` · ${streaming.rel}` : ''}</span>
            : mode === 'preview'
              ? (htmlFiles.length > 1
                ? <select className="csx-entry" value={entry || ''} onChange={(e) => setEntry(e.target.value || null)}>
                    {htmlFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                : <span className="csx-path">{entry || t('coding.noEntry')}</span>)
              : <span className="csx-path">{codeFile ? (toRel(root, codeFile) ?? codeFile) : t('coding.noFile')}</span>}
        </div>
        {mode === 'preview' && !isStreaming && <button className="icon-btn" title={t('coding.reload')} onClick={() => reload()}><RotateCw size={15} /></button>}
      </div>
      <div className="csx-body">
        {isStreaming
          ? <Suspense fallback={<div className="csx-empty">…</div>}><CodeView value={streaming!.content} fileName={streaming!.abs || streaming!.rel || 'file.txt'} autoScroll /></Suspense>
          : mode === 'preview'
            ? (previewUrl
              ? <iframe key={reloadNonce} className="csx-frame" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" title="preview" />
              : <div className="csx-empty">{t('coding.emptyPreview')}</div>)
            : (codeFile
              ? <Suspense fallback={<div className="csx-empty">…</div>}><CodeView value={text} fileName={codeFile} editable onChange={onCode} /></Suspense>
              : <div className="csx-empty">{t('coding.pickFile')}</div>)}
      </div>
    </div>
  )
}
