/**
 * 工作区文件浮层预览:从输入框上方弹起(framer-motion 弹簧),按文件类型渲染。
 * 渲染对齐 AionUI:代码/文本 CodeMirror、图片缩放/平移、docx 走 docx-preview 真实版式、
 * diff 走 diff2html;Markdown/HTML 带源码/预览切换;xlsx 表格、pptx 文本提纲。
 * 数据由 RightPanel 以 loader thunk 注入,与「云沙箱 / 本机」模式无关。
 * 重库(CodeMirror / docx-preview / diff2html / xlsx / jszip)一律懒加载,主 bundle 不膨胀。
 */
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Download, X, Maximize2, Minimize2, FileWarning, Loader2, RefreshCw,
  ZoomIn, ZoomOut, Maximize, WrapText, Code2, Eye, Columns2, AlignJustify,
} from 'lucide-react'
import { Markdown } from './Markdown'
import {
  previewKindFor, iconForFile, extOf, baseOf, parseDelimited, fmtSize, mimeForExt, type PreviewKind,
} from '../services/fileKinds'
import { useIsDark } from '../services/useIsDark'
import { useI18n } from '../i18n'
import 'diff2html/bundles/css/diff2html.min.css'
// pdf.js worker(?url 走 Vite 资源,单独 asset);PDF 渲染到 canvas,不依赖 Electron PDF 插件。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const CodeView = lazy(() => import('./CodeView'))

export interface PreviewData { mimeType: string; bytes: Uint8Array; size: number; mtimeMs?: number }
/** name=显示名(文件名/相对路径);load=拉取字节(或超限);download=可选下载;
 *  path=本机绝对路径(有则预览可持久化为标签页、可系统打开;云沙箱/内联无)。 */
export interface PreviewTarget {
  name: string
  path?: string
  load: () => Promise<PreviewData | { tooLarge: true; size: number } | null>
  download?: () => void
}

export type ImgView = { s: number; x: number; y: number }

export const TEXT_KINDS = new Set<PreviewKind>(['html', 'code', 'markdown', 'csv', 'json', 'text', 'diff'])
export const BLOB_KINDS = new Set<PreviewKind>(['image', 'video', 'audio']) // pdf 走 pdf.js,不需 blobUrl
export const CSV_ROW_CAP = 500
const SPRING = { type: 'spring' as const, stiffness: 300, damping: 26, mass: 0.9 }
const clampScale = (s: number) => Math.min(8, Math.max(0.1, s))

export const Spinner = () => <div className="wsfile-center"><Loader2 size={20} className="spin" /></div>

/** 解码 XML 实体(pptx 文本提取用);&amp; 最后解,避免二次解码。 */
export function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
}

/** 懒加载的 CodeMirror 视图(代码 / JSON / 文本 / md·html 源码)。 */
export const cm = (props: { value: string; fileName?: string; language?: string; wrap?: boolean }) => (
  <div className="wsfile-cmwrap"><Suspense fallback={<Spinner />}><CodeView {...props} /></Suspense></div>
)

export const OfficeFail: React.FC<{ t: (k: string, v?: Record<string, unknown>) => string; download?: () => void }> = ({ t, download }) => (
  <div className="wsfile-center wsfile-fallback">
    <FileWarning size={26} />
    <div>{t('preview.loadFailed')}</div>
    {download && <button className="btn ghost sm" onClick={download}><Download size={13} /> {t('preview.download')}</button>}
  </div>
)

// ── 图片缩放/平移(滚轮以光标为中心、拖拽平移、双击复位)──────────────────────────
export const ImageView: React.FC<{ src: string; alt: string; view: ImgView; setView: React.Dispatch<React.SetStateAction<ImgView>> }> = ({ src, alt, view, setView }) => {
  const drag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null)
  return (
    <div
      className="wsfile-imgwrap"
      onWheel={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const cx = e.clientX - r.left - r.width / 2
        const cy = e.clientY - r.top - r.height / 2
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
        setView((p) => { const s = clampScale(p.s * f); const k = s / p.s; return { s, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k } })
      }}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, sx: view.x, sy: view.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { const d = drag.current; if (d) setView((p) => ({ ...p, x: d.sx + (e.clientX - d.x), y: d.sy + (e.clientY - d.y) })) }}
      onPointerUp={() => { drag.current = null }}
      onDoubleClick={() => setView({ s: 1, x: 0, y: 0 })}
    >
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }} />
    </div>
  )
}

// ── docx → docx-preview(真实 OOXML 版式;库直接操作 DOM)──────────────────────────
export const DocxView: React.FC<{ bytes: Uint8Array; download?: () => void }> = ({ bytes, download }) => {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState(false)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    let cancelled = false
    setErr(false); setBusy(true)
    void (async () => {
      try {
        const m: any = await import('docx-preview')
        if (cancelled || !ref.current) return
        ref.current.innerHTML = ''
        await m.renderAsync(bytes, ref.current, undefined, { className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true })
        if (!cancelled) setBusy(false)
      } catch { if (!cancelled) { setErr(true); setBusy(false) } }
    })()
    return () => { cancelled = true }
  }, [bytes])
  if (err) return <OfficeFail t={t} download={download} />
  return <div className="wsfile-doc wsfile-docx"><div ref={ref} />{busy && <Spinner />}</div>
}

// ── diff → diff2html(并排/逐行;暗色加 d2h-dark-color-scheme)─────────────────────
export const DiffView: React.FC<{ text: string; side: boolean; download?: () => void }> = ({ text, side, download }) => {
  const { t } = useI18n()
  const dark = useIsDark()
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let cancelled = false
    setHtml(null); setErr(false)
    void (async () => {
      try {
        const d2h: any = await import('diff2html')
        const out: string = (d2h.html || d2h.default?.html)(text, { outputFormat: side ? 'side-by-side' : 'line-by-line', drawFileList: false, matching: 'lines' })
        if (!cancelled) setHtml(out)
      } catch { if (!cancelled) setErr(true) }
    })()
    return () => { cancelled = true }
  }, [text, side])
  if (err) return <OfficeFail t={t} download={download} />
  if (html == null) return <Spinner />
  return <div className={`wsfile-doc wsfile-diff${dark ? ' d2h-dark-color-scheme' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}

// ── PDF → pdf.js 渲染到 canvas(渲染器侧,不依赖 Electron PDF 插件 / file:// / blob)──
const MAX_PDF_PAGES = 100
export const PdfView: React.FC<{ bytes: Uint8Array; download?: () => void }> = ({ bytes, download }) => {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState(false)
  const [busy, setBusy] = useState(true)
  const [more, setMore] = useState<{ shown: number; total: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    let doc: any = null
    setErr(false); setBusy(true); setMore(null)
    void (async () => {
      try {
        const pdfjs: any = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
        if (cancelled || !ref.current) return
        ref.current.innerHTML = ''
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const n = Math.min(doc.numPages, MAX_PDF_PAGES)
        for (let i = 1; i <= n; i++) {
          if (cancelled) break
          const page = await doc.getPage(i)
          const viewport = page.getViewport({ scale: 1.3 * dpr })
          const canvas = document.createElement('canvas')
          canvas.className = 'wsfile-pdf-page'
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = `${viewport.width / dpr}px`
          ref.current?.appendChild(canvas)
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
        }
        if (!cancelled) { setBusy(false); if (doc.numPages > n) setMore({ shown: n, total: doc.numPages }) }
      } catch { if (!cancelled) { setErr(true); setBusy(false) } }
    })()
    return () => { cancelled = true; if (doc) { try { void doc.destroy() } catch { /* ignore */ } } }
  }, [bytes])
  if (err) return <OfficeFail t={t} download={download} />
  return (
    <div className="wsfile-doc wsfile-pdf">
      <div ref={ref} />
      {busy && <Spinner />}
      {more && <div className="panel-note">{t('preview.pdfPages', { n: String(more.shown), total: String(more.total) })}</div>}
    </div>
  )
}

// ── xlsx / pptx 解析(懒加载重库;浮层与标签页预览共用)──────────────────────────
export type OfficeRender = { kind: 'xlsx'; sheets: { name: string; html: string }[] } | { kind: 'pptx'; slides: string[] }
export async function loadOffice(bytes: Uint8Array, kind: 'xlsx' | 'pptx'): Promise<OfficeRender> {
  if (kind === 'xlsx') {
    const x: any = await import('xlsx'); const XLSX = x.read ? x : x.default
    const wb = XLSX.read(bytes, { type: 'array' })
    return { kind: 'xlsx', sheets: wb.SheetNames.map((name: string) => ({ name, html: XLSX.utils.sheet_to_html(wb.Sheets[name]) })) }
  }
  const j: any = await import('jszip'); const JSZip = j.loadAsync ? j : (j.default ?? j)
  const zip = await JSZip.loadAsync(bytes)
  const order = (p: string): number => parseInt(p.match(/(\d+)\.xml$/)?.[1] || '0', 10)
  const files = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => order(a) - order(b))
  const slides: string[] = []
  for (const p of files) {
    const xml: string = await zip.files[p].async('text')
    slides.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((mm) => unescapeXml(mm[1])).join('\n'))
  }
  return { kind: 'pptx', slides }
}

export const WorkspaceFilePreview: React.FC<{ target: PreviewTarget; onClose: () => void }> = ({ target, onClose }) => {
  const { t } = useI18n()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PreviewData | null>(null)
  const [tooLarge, setTooLarge] = useState<number | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [docView, setDocView] = useState<'preview' | 'source'>('preview') // markdown / html
  const [reloadNonce, setReloadNonce] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [diffSide, setDiffSide] = useState(true)
  const [imgView, setImgView] = useState<ImgView>({ s: 1, x: 0, y: 0 })

  const Icon = iconForFile(data?.mimeType || '', target.name)
  const ext = extOf(target.name)
  const kind: PreviewKind = data ? previewKindFor(data.mimeType, target.name) : 'binary'

  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    setLoading(true); setError(null); setData(null); setTooLarge(null); setBlobUrl(null)
    setDocView('preview'); setImgView({ s: 1, x: 0, y: 0 })
    void (async () => {
      try {
        const r = await target.load()
        if (cancelled) return
        if (!r) { setError('not-found'); setLoading(false); return }
        if ('tooLarge' in r) { setTooLarge(r.size); setLoading(false); return }
        if (BLOB_KINDS.has(previewKindFor(r.mimeType, target.name))) {
          const type = mimeForExt(target.name) || r.mimeType || 'application/octet-stream'
          createdUrl = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type }))
          setBlobUrl(createdUrl)
        }
        setData(r); setLoading(false)
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || 'error'); setLoading(false) }
      }
    })()
    return () => { cancelled = true; if (createdUrl) URL.revokeObjectURL(createdUrl) }
  }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (expanded) setExpanded(false); else onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, onClose])

  const text = useMemo(
    () => (data && TEXT_KINDS.has(kind) ? new TextDecoder('utf-8', { fatal: false }).decode(data.bytes) : ''),
    [data, kind],
  )

  // xlsx / pptx 懒加载(docx 走独立 DocxView)。
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

  const officeBody = (): React.ReactNode => {
    if (officeErr) return <OfficeFail t={t} download={target.download} />
    if (!office) return <Spinner />
    if (office.kind === 'xlsx') {
      const cur = office.sheets[sheetIdx] ?? office.sheets[0]
      return (
        <div className="wsfile-sheetwrap">
          {office.sheets.length > 1 && (
            <div className="wsfile-seg wsfile-sheet-tabs">
              {office.sheets.map((s, i) => <button key={i} className={i === sheetIdx ? 'active' : ''} onClick={() => setSheetIdx(i)}>{s.name}</button>)}
            </div>
          )}
          {/* ponytail: SheetJS 输出无脚本受控 HTML,源是用户自己文档,风险可控 */}
          <div className="wsfile-doc wsfile-sheet" dangerouslySetInnerHTML={{ __html: cur?.html ?? '' }} />
        </div>
      )
    }
    return (
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

  let body: React.ReactNode
  if (loading) body = <Spinner />
  else if (tooLarge !== null) body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{t('preview.tooLarge', { size: fmtSize(tooLarge) })}</div>
      {target.download && <button className="btn ghost sm" onClick={target.download}><Download size={13} /> {t('preview.download')}</button>}
    </div>
  )
  else if (error || !data) body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{error === 'not-found' ? t('preview.notFound') : t('preview.loadFailed')}</div>
    </div>
  )
  else if (kind === 'image') body = blobUrl ? <ImageView src={blobUrl} alt={target.name} view={imgView} setView={setImgView} /> : null
  else if (kind === 'pdf') body = <PdfView bytes={data.bytes} download={target.download} />
  else if (kind === 'video') body = <div className="wsfile-media">{blobUrl && <video src={blobUrl} controls />}</div>
  else if (kind === 'audio') body = <div className="wsfile-media wsfile-audio">{blobUrl && <audio src={blobUrl} controls />}</div>
  else if (kind === 'markdown') body = docView === 'preview' ? <div className="wsfile-doc msg-content"><Markdown content={text} /></div> : cm({ value: text, fileName: target.name, wrap })
  else if (kind === 'json') { let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* keep raw */ } body = cm({ value: pretty, fileName: 'x.json', language: 'json', wrap }) }
  else if (kind === 'code') body = cm({ value: text, fileName: target.name, wrap })
  else if (kind === 'text') body = cm({ value: text, fileName: target.name, wrap })
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
    ? <iframe key={reloadNonce} className="wsfile-frame" srcDoc={text} sandbox="allow-scripts allow-popups allow-forms allow-modals" title={target.name} />
    : cm({ value: text, language: 'html', wrap })
  else if (kind === 'docx') body = <DocxView bytes={data.bytes} download={target.download} />
  else if (kind === 'xlsx' || kind === 'pptx') body = officeBody()
  else body = (
    <div className="wsfile-center wsfile-fallback">
      <FileWarning size={26} /><div>{t('preview.notAvailable')}</div>
      {target.download && <button className="btn ghost sm" onClick={target.download}><Download size={13} /> {t('preview.download')}</button>}
    </div>
  )

  // 工具栏上下文控件
  const ready = !loading && !error && tooLarge === null && !!data
  const isDoc = kind === 'markdown' || kind === 'html'
  const isCode = kind === 'code' || kind === 'json' || kind === 'text' || (isDoc && docView === 'source')

  return (
    <motion.div
      className="wsfile-overlay"
      initial={{ opacity: 0, y: 24, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.94 }}
      transition={SPRING}
      style={{ transformOrigin: 'bottom center' }}
    >
      <div className={`wsfile-panel${expanded ? ' expanded' : ''}${kind === 'html' && docView === 'preview' && ready ? ' fill' : ''}`}>
        <div className="wsfile-head">
          <Icon size={14} className="wsfile-head-icon" />
          <div className="wsfile-title" title={target.name}>
            <span className="wsfile-name">{baseOf(target.name)}</span>
            {ext && <span className="wsfile-ext">{ext}</span>}
          </div>

          {ready && isDoc && (
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
          {ready && isCode && (
            <button className={`icon-btn${wrap ? ' active' : ''}`} title={t('preview.wrap')} onClick={() => setWrap((v) => !v)}><WrapText size={14} /></button>
          )}
          {ready && kind === 'image' && (
            <>
              <button className="icon-btn" title={t('preview.zoomOut')} onClick={() => setImgView((p) => ({ ...p, s: clampScale(p.s * 0.8) }))}><ZoomOut size={14} /></button>
              <button className="icon-btn" title={t('preview.zoomIn')} onClick={() => setImgView((p) => ({ ...p, s: clampScale(p.s * 1.25) }))}><ZoomIn size={14} /></button>
              <button className="icon-btn" title={t('preview.fit')} onClick={() => setImgView({ s: 1, x: 0, y: 0 })}><Maximize size={14} /></button>
            </>
          )}

          {target.download && <button className="icon-btn" title={t('preview.download')} onClick={target.download}><Download size={14} /></button>}
          <button className="icon-btn" title={expanded ? t('preview.collapse') : t('preview.expand')} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-btn" title={t('preview.close')} onClick={onClose}><X size={15} /></button>
        </div>
        <div className="wsfile-body">{body}</div>
      </div>
    </motion.div>
  )
}
