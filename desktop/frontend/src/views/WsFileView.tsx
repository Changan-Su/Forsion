/** 工作区文件预览标签页(主区多实例视图;替代 chatbox 上方的浮层预览)。
 *  params: {path,name}(本机,随布局持久化,重启恢复)或 {tkey,name}(瞬态:云沙箱/对话内联)。
 *  渲染复用 WorkspaceFilePreview 的导出渲染器;markdown(本机)默认 Amadeus Milkdown 编辑、
 *  debounce 原子写回 + mtime 冲突保护;不支持的类型询问是否用系统默认应用打开。 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download, FileWarning, RefreshCw, WrapText, Code2, Eye, Columns2, AlignJustify,
  ZoomIn, ZoomOut, Maximize, ExternalLink, FolderSearch, Pencil, Clock, NotebookPen,
} from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { Markdown } from '../components/Markdown'
import {
  ImageView, PdfView, DocxView, DiffView, Spinner, cm, loadOffice, HtmlPreview,
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
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { openNote } from '../amadeusNav'

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

/** 库外音视频 + 时刻锚:`<video>/<audio>` 加一层,收到 seek 就跳过去。
 *  ⚠️ **元数据到齐之前写 `currentTime` 是静默无效的**(浏览器直接丢弃),必须等 `loadedmetadata`;
 *     而它**只触发一次** —— 所以 effect 依赖 seek.nonce,元数据已就绪时直接赋值。
 *  押后的监听必须能撤:seek 连变几次会堆叠出好几个 once 监听,元数据一到按注册序依次赋值,
 *  中间那些都是**过期时刻**(MediaPlayer 里同款,那份是库内媒体的实现)。
 *  刻意不自动 play:引用条是「带我去那一秒」,不是「开始放」;库内那条走 MediaPlayer 的
 *  goto 会 play —— 那是笔记里点链接的语义,两边不必一致。 */
const MediaSeek: React.FC<{ src: string; kind: 'video' | 'audio'; seek: { t: number; to?: number; nonce: number } | null }> = ({ src, kind, seek }) => {
  const ref = useRef<HTMLMediaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !seek) return
    const go = (): void => { try { el.currentTime = seek.t } catch { /* 源未就绪,忽略 */ } }
    if (el.readyState >= 1 /* HAVE_METADATA */) { go(); return }
    el.addEventListener('loadedmetadata', go, { once: true })
    return () => el.removeEventListener('loadedmetadata', go)
  }, [src, seek?.t, seek?.nonce])
  // 区间锚 `#t=95,120`:到点暂停(原生 loop 不认片段,W3C bug 12426 WONTFIX)。
  // 与库内那条(MediaPlayer)同款 —— 只有一边有的话,同一个锚点在库内库外表现不同,是更难查的坑。
  useEffect(() => {
    const el = ref.current
    const to = seek?.to
    if (!el || !to) return
    const onTime = (): void => { if (el.currentTime >= to) el.pause() }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [seek?.to])
  const common = { ref: (el: HTMLMediaElement | null) => { ref.current = el }, src, controls: true, preload: 'metadata' as const }
  return kind === 'video' ? <video {...common} /> : <audio {...common} />
}

/** 本机 .md 编辑器:frontmatter 原样保留(剥离喂 Milkdown、保存拼回);800ms debounce 原子写回;
 *  mtime 冲突(外部修改)→ 横幅问「重新加载 / 覆盖写入」,绝不静默覆盖;
 *  卸载冲刷失败/冲突 → 另存旁路文件 + toast(绝不静默丢弃)。
 *  「源码」模式在本组件内渲染(读活草稿),编辑↔源码切换不卸载、内容永远最新。 */
const MdFileEditor: React.FC<{ path: string; text: string; mtimeMs?: number; view: 'edit' | 'source'; onReload: () => void; focusLine?: { line: number; end?: number; nonce: number } | null }> = ({ path, text, mtimeMs, view, onReload, focusLine }) => {
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
        // 行号锚含 frontmatter 行(read_file 读的是整份磁盘文件),这里 value 恰好也是 fm+body → 对齐
        cm({ value: fm + bodyRef.current, fileName: path, wrap: false, focusLine })
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
  // 行号引用(聊天里的 [[path#L42]] 条):params 里的行号供冷挂载,已挂载的实例听
  // amadeus:wsfile-goto 就地跳(pdf-goto 同款通路);nonce 让「滚走后再点同一条」也重新居中。
  const pLine = typeof leaf.params.line === 'number' && leaf.params.line >= 1 ? Math.trunc(leaf.params.line) : null
  const pEnd = typeof leaf.params.endLine === 'number' && leaf.params.endLine >= 1 ? Math.trunc(leaf.params.endLine) : undefined
  const [focus, setFocus] = useState<{ line: number; end?: number; nonce: number } | null>(pLine ? { line: pLine, end: pEnd, nonce: 0 } : null)
  // 媒体时刻引用(**库外**音视频的 `[[/abs/a.mp4#t=95]]`;库内走 amadeus-media 视图)。
  // 独立于 focus 而不是塞进去:focus 的载荷是 `line: number`(要原样喂给 CodeMirror 的 focusLine),
  // 而时刻锚没有行 —— 一个文件要么是文本要么是媒体,两者永不同时存在,合并只会把类型搅浑。
  // nonce 纪律与 focus 一致:拖走进度条后再点同一条引用,要能再跳一次。
  const pAt = typeof leaf.params.t === 'number' && leaf.params.t >= 0 ? leaf.params.t : null
  const pTo = typeof leaf.params.tTo === 'number' && leaf.params.tTo > (pAt ?? 0) ? leaf.params.tTo : undefined
  const [seek, setSeek] = useState<{ t: number; to?: number; nonce: number } | null>(pAt != null ? { t: pAt, to: pTo, nonce: 0 } : null)

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
  // 带行号锚打开的 .md/.html 直接落源码模式:行号只在源码视图里有落点(Milkdown/预览没有行的概念)。
  const [docView, setDocView] = useState<'preview' | 'source'>(pLine ? 'source' : 'preview') // html / 瞬态 markdown
  const [mdMode, setMdMode] = useState<'edit' | 'source'>(pLine ? 'source' : 'edit') // 本机 markdown
  useEffect(() => {
    if (!path) return
    const onGoto = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; line?: number; endLine?: number; t?: number; tTo?: number; clear?: boolean } | undefined
      if (!d || d.path !== path) return
      // 普通方式(不带锚点)重开同一文件 → 清掉引用高亮,csv/diff 回表格/对比视图(Codex 二审);
      // 不动 mdMode/docView:那两个有工具栏开关,用户自己切。
      // ⚠️ **seek 也必须一起清**(Codex 三审):区间锚 `#t=95,120` 注册的 timeupdate 监听会一直
      //    活着 —— 从文件面板普通打开同一段视频,播到 120 秒还是会自己停,而界面上没有任何东西
      //    说明「还在区间模式」。这与「focus 只设不清 = 永久锁死」是同一个坑的第二种形态。
      if (d.clear) {
        setFocus(null)
        setSeek(null)
        // ⚠️ 活体 state 清了还不够:params 里的 line/t 是**冷挂载的真源**(刷新、布局恢复、
        //    面板重挂都读它)—— 不一起清,普通重开之后只要来一次重挂,上一条引用的行号/区间
        //    就又回来了(Codex 四审)。Desk 那条路不受影响(deskShowFile 整份换 view.params),
        //    主区 openWsFile 的「已开就激活」分支只发事件不动 params —— 在视图里清是唯一
        //    覆盖所有派发方的地方。setParams 自带逐键相等守卫,白清一次不产生重渲。
        leaf.setParams({ line: undefined, endLine: undefined, t: undefined, tTo: undefined })
        return
      }
      // 媒体时刻:就地 seek(同一份视频不重挂 = 不重新读整份字节)。放在行号判定**之前** ——
      // 下面那条 `d.line` 守卫会把只带 t 的事件直接 return 掉。
      if (typeof d.t === 'number' && d.t >= 0) {
        setSeek((p) => ({ t: d.t!, to: typeof d.tTo === 'number' && d.tTo > d.t! ? d.tTo : undefined, nonce: (p?.nonce ?? 0) + 1 }))
        return
      }
      if (typeof d.line !== 'number' || d.line < 1) return
      setFocus((p) => ({ line: Math.trunc(d.line!), end: typeof d.endLine === 'number' && d.endLine >= 1 ? Math.trunc(d.endLine) : undefined, nonce: (p?.nonce ?? 0) + 1 }))
      // 已开在预览/编辑模式的 markdown/html 收到行锚 → 切到源码,行号才有落地处(Codex 评审)
      setMdMode('source')
      setDocView('source')
    }
    window.addEventListener('amadeus:wsfile-goto', onGoto)
    return () => window.removeEventListener('amadeus:wsfile-goto', onGoto)
  }, [path])
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
  // 设备页只读桥没有 openHostPath/revealHostPath:两枚按钮是静默哑弹,整对藏掉(两桥同生同灭,嗅探一枚)。
  const hostActions = path && window.tangu?.openHostPath ? (
    <>
      <button className="btn ghost sm" onClick={openWithDefault}><ExternalLink size={13} /> {t('preview.openWithDefault')}</button>
      <button className="btn ghost sm" onClick={reveal}><FolderSearch size={13} /> {t('panel.action.revealInFileManager')}</button>
    </>
  ) : target?.download ? (
    <button className="btn ghost sm" onClick={target.download}><Download size={13} /> {t('preview.download')}</button>
  ) : null

  // 毁档防线:画板/导图/插件文件类型磁盘同为 .md 但载荷不是笔记,喂 Milkdown 会被 normalize 改写
  // → 一律只读源码,原生编辑请走「在 Amadeus 中打开」。
  // ponytail: 内置特型后缀写死(shared 判定函数在另一会话未提交 WIP 里,不引);插件类型订阅
  // fileTypes 响应晚注册(插件异步装载期不误放行);已禁用插件的文件回归普通 md,与全 app 判定口径一致。
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const specialMd = !!path && (/\.(excalidraw|mindmap)\.md$/i.test(path) || !!findFileType(fileTypes, path))
  const mdEditable = kind === 'markdown' && !!path && !!window.tangu?.writeHostFile && !specialMd

  // 文件在当前打开的 Amadeus vault 里 → 原生 view 优先:「在 Amadeus 中打开」交给 openNote 门面
  // (笔记/画板/导图/插件文件类型各自改道,这里不重复判定)。只对 .md 系开这个门,附件类型不进笔记编辑器。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultRel = useMemo(() => {
    if (!path || !vaultRoot) return null
    const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '')
    const r = norm(vaultRoot)
    const q = norm(path)
    return q.startsWith(r + '/') ? q.slice(r.length + 1) : null
  }, [path, vaultRoot])
  const amadeusOpen = vaultRel && /\.md$/i.test(vaultRel) ? () => void openNote(vaultRel) : undefined

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
  else if (kind === 'video') body = <div className="wsfile-media">{blobUrl && <MediaSeek src={blobUrl} kind="video" seek={seek} />}</div>
  else if (kind === 'audio') body = <div className="wsfile-media wsfile-audio">{blobUrl && <MediaSeek src={blobUrl} kind="audio" seek={seek} />}</div>
  else if (kind === 'markdown') {
    if (mdEditable) body = (
      <MdFileEditor
        key={`${path}:${data.mtimeMs ?? 0}:${reloadNonce}`}
        path={path!}
        text={text}
        mtimeMs={data.mtimeMs}
        view={mdMode}
        onReload={() => setReloadNonce((n) => n + 1)}
        focusLine={focus}
      />
    )
    else if (specialMd || docView === 'source') body = cm({ value: text, fileName: name, wrap, focusLine: focus })
    else body = <div className="wsfile-doc msg-content"><Markdown content={text} /></div>
  }
  // json:带行号锚时**不 pretty**——引用的行号指向磁盘原文,重排缩进后行号全体错位。
  else if (kind === 'json') {
    let pretty = text
    if (!focus) { try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* keep raw */ } }
    body = cm({ value: pretty, fileName: 'x.json', language: 'json', wrap, focusLine: focus })
  }
  else if (kind === 'code') body = cm({ value: text, fileName: name, wrap, focusLine: focus })
  else if (kind === 'text') body = cm({ value: text, fileName: name, wrap, focusLine: focus })
  // diff/csv 带行锚 → 保留磁盘行号的 CodeMirror(diff 视图/表格没有「第 N 行」可落;Codex 评审:
  // read_file 对这些文本一样教 #L,引用点开必须有落点,不能开了却不定位)。
  else if (kind === 'diff') body = focus ? cm({ value: text, fileName: name, wrap, focusLine: focus }) : <DiffView text={text} side={diffSide} />
  else if (kind === 'csv' && focus) body = cm({ value: text, fileName: name, wrap, focusLine: focus })
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
    ? <HtmlPreview path={path ?? target.path} text={text} title={name} nonce={reloadNonce} />
    : cm({ value: text, language: 'html', wrap, focusLine: focus })
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
    || (kind === 'markdown' && !mdEditable && (docView === 'source' || specialMd)))

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
        {ready && !mdEditable && !specialMd && (kind === 'markdown' || kind === 'html') && (
          <div className="wsfile-seg">
            <button className={docView === 'preview' ? 'active' : ''} title={t('preview.htmlPreview')} onClick={() => setDocView('preview')}><Eye size={13} /></button>
            <button className={docView === 'source' ? 'active' : ''} title={t('preview.htmlCode')} onClick={() => setDocView('source')}><Code2 size={13} /></button>
            {kind === 'html' && docView === 'preview' && <button title={t('preview.reload')} onClick={() => setReloadNonce((n) => n + 1)}><RefreshCw size={12} /></button>}
            {/* 在系统浏览器里调试:令牌根按目录 memo,重复 servePath 返回同一 URL,无需从 HtmlPreview 里把它抬出来 */}
            {kind === 'html' && docView === 'preview' && !!(path ?? target?.path) && !!window.tangu?.codePreviewServePath && !!window.tangu?.openExternal && (
              <button title={t('preview.openInBrowser')} onClick={() => void window.tangu!.codePreviewServePath!((path ?? target!.path)!).then((r) => window.tangu!.openExternal!(r.url)).catch(() => {})}><ExternalLink size={12} /></button>
            )}
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

        {amadeusOpen && <button className="icon-btn" title={t('preview.openInAmadeus')} onClick={amadeusOpen}><NotebookPen size={14} /></button>}
        {path && <button className="icon-btn" title={t('preview.openWithDefault')} onClick={openWithDefault}><ExternalLink size={14} /></button>}
        {target?.download && <button className="icon-btn" title={path ? t('panel.action.revealInFileManager') : t('preview.download')} onClick={target.download}><Download size={14} /></button>}
        <button className="icon-btn" title={t('preview.reload')} onClick={() => setReloadNonce((n) => n + 1)}><RefreshCw size={14} /></button>
      </div>
      <div className="wsfile-body">{body}</div>
    </div>
  )
}
