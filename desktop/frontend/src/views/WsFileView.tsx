/** 工作区文件预览标签页(主区多实例视图;替代 chatbox 上方的浮层预览)。
 *  params: {path,name}(本机,随布局持久化,重启恢复)或 {tkey,name}(瞬态:云沙箱/对话内联)。
 *  渲染复用 WorkspaceFilePreview 的导出渲染器;markdown(本机)默认 Amadeus Milkdown 编辑、
 *  debounce 原子写回 + mtime 冲突保护;不支持的类型询问是否用系统默认应用打开。 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download, FileWarning, RefreshCw, WrapText, Code2, Eye, Columns2, AlignJustify,
  ZoomIn, ZoomOut, Maximize, ExternalLink, FolderSearch, Pencil, Clock,
} from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { Markdown } from '../components/Markdown'
import {
  ImageView, PdfView, DocxView, DiffView, Spinner, cm, loadOffice,
  TEXT_KINDS, BLOB_KINDS, CSV_ROW_CAP, OfficeFail,
  type PreviewTarget, type PreviewData, type ImgView, type OfficeRender,
} from '../components/WorkspaceFilePreview'
import { previewKindFor, iconForFile, extOf, parseDelimited, fmtSize, mimeForExt, splitFrontmatter, type PreviewKind } from '../services/fileKinds'
import { useI18n } from '../i18n'
import { useTheme } from '../stores/themeStore'
import { PlainMarkdownEditor } from '../amadeus/blocks/markdown/MarkdownBlock'
import { getTransientTarget, hostTargetFor, pendingWrites } from './wsFileNav'
import { useApp } from '../stores/appStore'
import { bumpDir } from './chat2/FilesPanel'

/** 卸载冲刷失败/冲突时的兜底:把未保存内容另存为旁路文件(绝不静默丢),全局 toast 告知。 */
async function salvageDraft(path: string, content: string): Promise<void> {
  const toast = useApp.getState().toast
  const salvagePath = path.replace(/(\.[^./\\]+)?$/, `.本地未保存-${Date.now()}$1`)
  try {
    await window.tangu?.writeHostFile?.(salvagePath, content, undefined, true)
    bumpDir(salvagePath.slice(0, Math.max(salvagePath.lastIndexOf('/'), salvagePath.lastIndexOf('\\'))))
    toast(useApp.getState().tr('preview.mdSalvaged', { file: salvagePath.split(/[/\\]/).pop() || salvagePath }), true)
  } catch {
    toast(useApp.getState().tr('preview.mdSaveFail', { err: path }), true)
  }
}

/** 本机 .md 编辑器:frontmatter 原样保留(剥离喂 Milkdown、保存拼回);800ms debounce 原子写回;
 *  mtime 冲突(外部修改)→ 横幅问「重新加载 / 覆盖写入」,绝不静默覆盖;
 *  卸载冲刷失败/冲突 → 另存旁路文件 + toast(绝不静默丢弃)。
 *  「源码」模式在本组件内渲染(读活草稿),编辑↔源码切换不卸载、内容永远最新。 */
const MdFileEditor: React.FC<{ path: string; text: string; mtimeMs?: number; view: 'edit' | 'source'; onReload: () => void }> = ({ path, text, mtimeMs, view, onReload }) => {
  const { t } = useI18n()
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const fm = useMemo(() => splitFrontmatter(text).fm, [text])
  const bodyRef = useRef(text.slice(fm.length))
  const mtimeRef = useRef(mtimeMs)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const save = async (force?: boolean): Promise<{ conflict?: boolean; failed?: boolean }> => {
    if (!dirtyRef.current || !window.tangu?.writeHostFile) return {}
    const snapshot = bodyRef.current // 写盘期间的新键入不能被 dirty=false 吞掉
    const p = window.tangu.writeHostFile(path, fm + snapshot, force ? undefined : mtimeRef.current)
    pendingWrites.set(path, p.catch(() => {}))
    try {
      const r = await p
      if (r.conflict) { setConflict(true); return { conflict: true } }
      mtimeRef.current = r.mtimeMs
      dirtyRef.current = bodyRef.current !== snapshot
      setConflict(false); setSaveErr(null)
      return {}
    } catch (e: any) {
      setSaveErr(e?.message || String(e))
      return { failed: true }
    } finally {
      pendingWrites.delete(path)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const onChange = (md: string): void => {
    bodyRef.current = md
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void saveRef.current() }, 800)
  }
  // 卸载(关 tab/重挂)冲刷:CAS 保存;冲突或失败 → 另存旁路文件 + toast(组件已卸载,横幅没了,但绝不静默丢)。
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const content = fm + bodyRef.current
    const wasDirty = dirtyRef.current
    void saveRef.current().then((r) => {
      if (wasDirty && (r.conflict || r.failed)) void salvageDraft(path, content)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wsmd-edit">
      {conflict && (
        <div className="wsmd-banner">
          <Clock size={13} />
          <span>{t('preview.mdConflict')}</span>
          <button className="btn ghost sm" onClick={onReload}>{t('preview.mdReload')}</button>
          <button className="btn ghost sm" onClick={() => void save(true)}>{t('preview.mdOverwrite')}</button>
        </div>
      )}
      {saveErr && <div className="wsmd-banner danger"><FileWarning size={13} /><span>{t('preview.mdSaveFail', { err: saveErr })}</span></div>}
      {view === 'source' ? (
        cm({ value: fm + bodyRef.current, fileName: path, wrap: false })
      ) : (
        /* Amadeus 契约 token 域(bridge 取色)+ 整篇 Milkdown 宿主 */
        <div className="am-app tangu-lovable wsmd-scope" data-mode={mode} data-flat={flat ? '1' : '0'}>
          <PlainMarkdownEditor initial={bodyRef.current} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

export function WsFileView({ leaf }: ViewProps) {
  const { t } = useI18n()
  const path = typeof leaf.params.path === 'string' ? leaf.params.path : null
  const tkey = typeof leaf.params.tkey === 'string' ? leaf.params.tkey : null
  const name = typeof leaf.params.name === 'string' && leaf.params.name
    ? leaf.params.name
    : (path ? path.split(/[/\\]/).pop() || path : '')

  const target = useMemo<PreviewTarget | null>(() => {
    if (path) return hostTargetFor(path, name)
    if (tkey) return getTransientTarget(tkey) ?? null
    return null
  }, [path, tkey, name])

  // navigateLeaf 会把标题重置为 displayName,视图挂载/参数变化后自己设回文件名。
  useEffect(() => { if (name) leaf.setTitle(name) }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PreviewData | null>(null)
  const [tooLarge, setTooLarge] = useState<number | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [docView, setDocView] = useState<'preview' | 'source'>('preview') // html / 瞬态 markdown
  const [mdMode, setMdMode] = useState<'edit' | 'source'>('edit')          // 本机 markdown
  const [reloadNonce, setReloadNonce] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [diffSide, setDiffSide] = useState(true)
  const [imgView, setImgView] = useState<ImgView>({ s: 1, x: 0, y: 0 })

  const ext = extOf(name)
  const kind: PreviewKind = data ? previewKindFor(data.mimeType, name) : 'binary'
  const Icon = iconForFile(data?.mimeType || '', name)

  useEffect(() => {
    if (!target) { setLoading(false); return }
    let cancelled = false
    let createdUrl: string | null = null
    setLoading(true); setError(null); setData(null); setTooLarge(null); setBlobUrl(null)
    setImgView({ s: 1, x: 0, y: 0 })
    void (async () => {
      try {
        const r = await target.load()
        if (cancelled) return
        if (!r) { setError('not-found'); setLoading(false); return }
        if ('tooLarge' in r) { setTooLarge(r.size); setLoading(false); return }
        if (BLOB_KINDS.has(previewKindFor(r.mimeType, name))) {
          const type = mimeForExt(name) || r.mimeType || 'application/octet-stream'
          createdUrl = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type }))
          setBlobUrl(createdUrl)
        }
        setData(r); setLoading(false)
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || 'error'); setLoading(false) }
      }
    })()
    return () => { cancelled = true; if (createdUrl) URL.revokeObjectURL(createdUrl) }
  }, [target, reloadNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const text = useMemo(
    () => (data && TEXT_KINDS.has(kind) ? new TextDecoder('utf-8', { fatal: false }).decode(data.bytes) : ''),
    [data, kind],
  )

  // xlsx / pptx 懒解析(共用 loadOffice)。
  const [office, setOffice] = useState<OfficeRender | null>(null)
  const [officeErr, setOfficeErr] = useState(false)
  const [sheetIdx, setSheetIdx] = useState(0)
  useEffect(() => {
    if (!data || (kind !== 'xlsx' && kind !== 'pptx')) { setOffice(null); setOfficeErr(false); return }
    let cancelled = false
    setOffice(null); setOfficeErr(false); setSheetIdx(0)
    loadOffice(data.bytes, kind)
      .then((r) => { if (!cancelled) setOffice(r) })
      .catch(() => { if (!cancelled) setOfficeErr(true) })
    return () => { cancelled = true }
  }, [data, kind])

  const openWithDefault = (): void => {
    if (!path) return
    void window.tangu?.openHostPath?.(path).then((r) => {
      if (r && !r.ok) useApp.getState().toast(r.error || 'open failed', true)
    })
  }
  const reveal = (): void => { if (path) void window.tangu?.revealHostPath?.(path) }
  const hostActions = path ? (
    <>
      <button className="btn ghost sm" onClick={openWithDefault}><ExternalLink size={13} /> {t('preview.openWithDefault')}</button>
      <button className="btn ghost sm" onClick={reveal}><FolderSearch size={13} /> {t('panel.action.revealInFileManager')}</button>
    </>
  ) : target?.download ? (
    <button className="btn ghost sm" onClick={target.download}><Download size={13} /> {t('preview.download')}</button>
  ) : null

  const mdEditable = kind === 'markdown' && !!path && !!window.tangu?.writeHostFile

  let body: React.ReactNode
  if (!target) body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{t('preview.expired')}</div>
    </div>
  )
  else if (loading) body = <Spinner />
  else if (tooLarge !== null) body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{t('preview.tooLarge', { size: fmtSize(tooLarge) })}</div>
      <div className="wsfile-ask-actions">{hostActions}</div>
    </div>
  )
  else if (error || !data) body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{error === 'not-found' ? t('preview.notFound') : t('preview.loadFailed')}</div>
      {path && <div className="wsfile-ask-actions">{hostActions}</div>}
    </div>
  )
  else if (kind === 'image') body = blobUrl ? <ImageView src={blobUrl} alt={name} view={imgView} setView={setImgView} /> : null
  else if (kind === 'pdf') body = <PdfView bytes={data.bytes} download={target.download} />
  else if (kind === 'video') body = <div className="wsfile-media">{blobUrl && <video src={blobUrl} controls />}</div>
  else if (kind === 'audio') body = <div className="wsfile-media wsfile-audio">{blobUrl && <audio src={blobUrl} controls />}</div>
  else if (kind === 'markdown') {
    if (mdEditable) body = (
      <MdFileEditor
        key={`${path}:${data.mtimeMs ?? 0}:${reloadNonce}`}
        path={path!}
        text={text}
        mtimeMs={data.mtimeMs}
        view={mdMode}
        onReload={() => setReloadNonce((n) => n + 1)}
      />
    )
    else if (docView === 'preview') body = <div className="wsfile-doc msg-content"><Markdown content={text} /></div>
    else body = cm({ value: text, fileName: name, wrap })
  }
  else if (kind === 'json') { let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* keep raw */ } body = cm({ value: pretty, fileName: 'x.json', language: 'json', wrap }) }
  else if (kind === 'code') body = cm({ value: text, fileName: name, wrap })
  else if (kind === 'text') body = cm({ value: text, fileName: name, wrap })
  else if (kind === 'diff') body = <DiffView text={text} side={diffSide} download={target.download} />
  else if (kind === 'csv') {
    const rows = parseDelimited(text, ext === 'tsv' ? '\t' : ',')
    const capped = rows.slice(0, CSV_ROW_CAP); const header = capped[0] ?? []
    body = (
      <div className="wsfile-doc">
        <table className="wsfile-table">
          <thead><tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{capped.slice(1).map((r, ri) => <tr key={ri}>{header.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>)}</tbody>
        </table>
        {rows.length > CSV_ROW_CAP && <div className="panel-note">{t('preview.csvTruncated', { shown: String(CSV_ROW_CAP), total: String(rows.length) })}</div>}
      </div>
    )
  }
  else if (kind === 'html') body = docView === 'preview'
    ? <iframe key={reloadNonce} className="wsfile-frame" srcDoc={text} sandbox="allow-scripts allow-popups allow-forms allow-modals" title={name} />
    : cm({ value: text, language: 'html', wrap })
  else if (kind === 'docx') body = <DocxView bytes={data.bytes} download={target.download} />
  else if (kind === 'xlsx' || kind === 'pptx') {
    body = officeErr ? <OfficeFail t={t} download={target.download} />
      : !office ? <Spinner />
      : office.kind === 'xlsx' ? (
        <div className="wsfile-sheetwrap">
          {office.sheets.length > 1 && (
            <div className="wsfile-seg wsfile-sheet-tabs">
              {office.sheets.map((s, i) => <button key={i} className={i === sheetIdx ? 'active' : ''} onClick={() => setSheetIdx(i)}>{s.name}</button>)}
            </div>
          )}
          <div className="wsfile-doc wsfile-sheet" dangerouslySetInnerHTML={{ __html: office.sheets[sheetIdx]?.html ?? office.sheets[0]?.html ?? '' }} />
        </div>
      ) : (
        <div className="wsfile-doc wsfile-pptx">
          {office.slides.map((s, i) => {
            const lines = s.split('\n')
            return (
              <div className="wsfile-slide" key={i}>
                <div className="wsfile-slide-no">{t('preview.slide', { n: String(i + 1) })}</div>
                {lines[0] && <div className="wsfile-slide-title">{lines[0]}</div>}
                <pre>{lines.slice(1).join('\n') || (lines[0] ? '' : '—')}</pre>
              </div>
            )
          })}
        </div>
      )
  }
  else body = (
    // 不支持的类型:询问是否用系统默认应用打开(云沙箱无本机路径 → 只给下载)。
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} />
      <div>{path ? t('preview.unsupportedAsk') : t('preview.notAvailable')}</div>
      <div className="wsfile-ask-actions">{hostActions}</div>
    </div>
  )

  const ready = !loading && !error && tooLarge === null && !!data
  const isCode = ready && (kind === 'code' || kind === 'json' || kind === 'text'
    || (kind === 'html' && docView === 'source')
    || (kind === 'markdown' && !mdEditable && docView === 'source'))

  return (
    <div className="wsfile-tab">
      <div className="wsfile-head">
        <Icon size={14} className="wsfile-head-icon" />
        <div className="wsfile-title" title={path ?? name}>
          <span className="wsfile-name">{path ?? name}</span>
          {ext && <span className="wsfile-ext">{ext}</span>}
        </div>

        {ready && mdEditable && (
          <div className="wsfile-seg">
            <button className={mdMode === 'edit' ? 'active' : ''} title={t('preview.mdEdit')} onClick={() => setMdMode('edit')}><Pencil size={13} /></button>
            <button className={mdMode === 'source' ? 'active' : ''} title={t('preview.htmlCode')} onClick={() => setMdMode('source')}><Code2 size={13} /></button>
          </div>
        )}
        {ready && !mdEditable && (kind === 'markdown' || kind === 'html') && (
          <div className="wsfile-seg">
            <button className={docView === 'preview' ? 'active' : ''} title={t('preview.htmlPreview')} onClick={() => setDocView('preview')}><Eye size={13} /></button>
            <button className={docView === 'source' ? 'active' : ''} title={t('preview.htmlCode')} onClick={() => setDocView('source')}><Code2 size={13} /></button>
            {kind === 'html' && docView === 'preview' && <button title={t('preview.reload')} onClick={() => setReloadNonce((n) => n + 1)}><RefreshCw size={12} /></button>}
          </div>
        )}
        {ready && kind === 'diff' && (
          <div className="wsfile-seg">
            <button className={diffSide ? 'active' : ''} title={t('preview.diffSideBySide')} onClick={() => setDiffSide(true)}><Columns2 size={13} /></button>
            <button className={!diffSide ? 'active' : ''} title={t('preview.diffLineByLine')} onClick={() => setDiffSide(false)}><AlignJustify size={13} /></button>
          </div>
        )}
        {isCode && (
          <button className={`icon-btn${wrap ? ' active' : ''}`} title={t('preview.wrap')} onClick={() => setWrap((v) => !v)}><WrapText size={14} /></button>
        )}
        {ready && kind === 'image' && (
          <>
            <button className="icon-btn" title={t('preview.zoomOut')} onClick={() => setImgView((p) => ({ ...p, s: Math.min(8, Math.max(0.1, p.s * 0.8)) }))}><ZoomOut size={14} /></button>
            <button className="icon-btn" title={t('preview.zoomIn')} onClick={() => setImgView((p) => ({ ...p, s: Math.min(8, Math.max(0.1, p.s * 1.25)) }))}><ZoomIn size={14} /></button>
            <button className="icon-btn" title={t('preview.fit')} onClick={() => setImgView({ s: 1, x: 0, y: 0 })}><Maximize size={14} /></button>
          </>
        )}

        {path && <button className="icon-btn" title={t('preview.openWithDefault')} onClick={openWithDefault}><ExternalLink size={14} /></button>}
        {target?.download && <button className="icon-btn" title={path ? t('panel.action.revealInFileManager') : t('preview.download')} onClick={target.download}><Download size={14} /></button>}
        <button className="icon-btn" title={t('preview.reload')} onClick={() => setReloadNonce((n) => n + 1)}><RefreshCw size={14} /></button>
      </div>
      <div className="wsfile-body">{body}</div>
    </div>
  )
}
