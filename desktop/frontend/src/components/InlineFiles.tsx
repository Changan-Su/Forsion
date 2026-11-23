/**
 * 对话区内联文件:agent 经 display_file / generate_image / 表情包展示给用户的文件。
 * 图片 = 缩略图;音视频 = 内联播放器;其它 = 可点击文件卡片(打开 WorkspaceFilePreview)。
 * 字节来源:dataUrl 直接用;工作区路径 host 会话走「会话所在那台电脑」的 host 文件面(hostFs:本机 = window.tangu.readHostFile,
 * 手机把整端切到我的电脑 = 经 hub 的 /unit/hostfile)、沙箱走 /agent/workspace/read(P1-K6 S2)。
 * 下载(P1-DL):host 文件一律交给同一个 hostFs 的 downloadHostFile —— 本机 = 在文件管理器显示;手机 / 设备页 / 看别的电脑 =
 * /unit/hostfile/download 流式下载原文件(预览 4MB 上限管不到它)。老消息不用改形状,同样有下载位。
 * 11-23(生图多张与标注改图 1B):一条消息里生图 / 改图产出的图(source 标记)≥2 张 = 主图 + 缩略条(选中描 --signal),
 *   下面「n / N · 用这张继续 · 再来 N 张」;主图悬停出「标注修改」。1 张、截图、表情包照旧;读失败的那张退回文件卡。
 *   看图器的列表按缩略图收(主图不标 data-viewable,免得同一张收两次)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { CornerDownRight, PenLine, RefreshCw } from 'lucide-react'
import type { DisplayFile, TanguDesktopConfig } from '../types'
import type { PreviewTarget, PreviewData } from './WorkspaceFilePreview'
import { b64ToBytes, iconForFile, mimeForExt, previewKindFor } from '../services/fileKinds'
import * as api from '../services/backendService'
import { hostFsForSession } from '../services/engine/hostFs'
import { notifyApp } from '../stores/notificationStore'
import { targetForSession } from '../services/engine/targets'
import { registerMessages, translate } from '../i18n'
import { continueWithImage, openImageViewer, viewableProps } from './ImageViewer'
import { useApp } from '../stores/appStore'
import { saveResponseAs } from '../services/nativeDownload'

type ExecMode = 'host' | 'sandbox' | undefined

registerMessages({
  'inlineSet.markup': { zh: '标注修改', en: 'Mark up' },
  'inlineSet.useThis': { zh: '用这张继续', en: 'Continue with this' },
  'inlineSet.more': { zh: '再来 {count} 张', en: '{count} more' },
  'inlineSet.moreMsg': { zh: '照这组再来 {count} 张。', en: 'Make {count} more like these.' },
  'inlineSet.pick': { zh: '看第 {n} 张', en: 'Show image {n}' },
})

function decodeDataUrl(u: string): PreviewData {
  const m = u.match(/^data:([^;]+);base64,(.*)$/)
  const bytes = b64ToBytes(m?.[2] || '')
  return { mimeType: m?.[1] || 'application/octet-stream', bytes, size: bytes.length }
}

/** 把一个 DisplayFile 变成 WorkspaceFilePreview 能消费的 target(load 懒拉字节)。
 *  任务概览的产物/来源行也复用它(host 读主进程、沙箱读工作区、dataUrl 直接解),一处逻辑。 */
export function targetFor(f: DisplayFile, cfg: TanguDesktopConfig, sessionId: string, execMode: ExecMode): PreviewTarget {
  sessionId = f.sourceSessionId || sessionId
  const fs = execMode === 'host' ? hostFsForSession(sessionId) : null
  // 失败要看得见(P1-DL):手机上原生存「下载」会因超限 / 系统版本被拒、对方电脑可能不在线,吞掉 = 点了没反应
  const surface = (err: unknown): void => { notifyApp({ text: (err as Error)?.message || String(err), level: 'error' }) }
  const hostDownload = fs?.downloadHostFile
  return {
    name: f.name,
    // path 只在**字节就在本机盘上**(Electron 本机)时给:openWsFile 见到 path 就丢掉这里的 load / download、按
    // hostTargetFor(window.tangu.readHostFile + revealHostPath)重建并随布局持久化 —— 手机 / 设备页 / 看别的电脑时那条路
    // 读不到对方的盘、也没有下载位,只能走瞬态 target。沙箱的工作区相对路径同理。
    path: fs?.local && f.path && /^([/~]|[A-Za-z]:[\\/])/.test(f.path) ? f.path : undefined,
    load: async () => {
      if (f.dataUrl) return decodeDataUrl(f.dataUrl)
      if (!f.path) return null
      if (fs) {
        const r = await fs.readHostFile(f.path)
        if (r.tooLarge) return { tooLarge: true as const, size: r.size }
        return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
      }
      const r = await api.readWorkspaceFile(targetForSession(sessionId), sessionId, f.path)
      return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
    },
    download: f.dataUrl ? () => {
      void (async () => {
        const data = decodeDataUrl(f.dataUrl!)
        await saveResponseAs(f.name, new Response(new Blob([data.bytes as BlobPart], { type: data.mimeType })))
      })().catch(surface)
    } : f.path
      ? (execMode === 'host'
          // 这端给不了(云端没有 host 文件面)→ undefined 藏掉下载位,免留静默哑弹
          ? (hostDownload ? () => { void hostDownload(f.path!, f.name).catch(surface) } : undefined)
          : () => { void api.downloadWorkspaceFile(targetForSession(sessionId), sessionId, f.path!).catch(surface) })
      : undefined,
  }
}

/** 非图片(以及读不出缩略图的图片)的文件卡片:点开预览,预览里有下载位。 */
const FileCard: React.FC<{ f: DisplayFile; onClick: () => void }> = ({ f, onClick }) => {
  const Icon = iconForFile(mimeForExt(f.name) || f.mime || '', f.name)
  return (
    <button className="inline-file-card" title={f.name} onClick={onClick}>
      <Icon size={15} /><span className="inline-file-name">{f.name}</span>
    </button>
  )
}

/** 音视频等进入视口再取字节，避免打开历史对话时并发下载一批大文件。加载或解码失败时保留文件卡片。 */
const InlineMedia: React.FC<{
  f: DisplayFile; cfg: TanguDesktopConfig; sessionId: string; execMode: ExecMode
  kind: 'image' | 'video' | 'audio'; onClick: () => void
}> = ({ f, cfg, sessionId, execMode, kind, onClick }) => {
  const [visible, setVisible] = useState(false)
  const mediaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (kind === 'image' || !mediaRef.current) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    })
    observer.observe(mediaRef.current)
    return () => observer.disconnect()
  }, [kind])
  const { src: imageSrc, failed, setFailed } = useMediaSrc(f, cfg, sessionId, execMode, kind, kind === 'image' || visible)
  if (failed) return <FileCard f={f} onClick={onClick} />
  if (kind !== 'image') return (
    <div className="inline-file-media" ref={mediaRef}>
      {imageSrc && (kind === 'video'
        ? <video className="inline-file-video" src={imageSrc} controls playsInline preload="metadata" aria-label={f.name} onError={() => setFailed(true)} />
        : <audio className="inline-file-audio" src={imageSrc} controls preload="metadata" aria-label={f.name} onError={() => setFailed(true)} />)}
      <FileCard f={f} onClick={onClick} />
    </div>
  )
  if (!imageSrc) return null
  // 点开 = 就地看图(A2);原来的去处(主区文件标签页)挪到看图顶栏的「在标签页打开」
  return <img className="inline-file-img" src={imageSrc} alt={f.name} title={f.name} draggable={false} onError={() => setFailed(true)} {...viewableProps({ name: f.name, alt: { label: translate('viewer.openTab'), run: onClick }, edit: { sessionId } })} />
}

/** 媒体字节 → 可用的 src:dataUrl / 沙箱下载地址直接用,host 文件读出来转 blob URL(卸载时回收)。want = 现在就要(音视频进视口才取)。 */
function useMediaSrc(f: DisplayFile, cfg: TanguDesktopConfig, sessionId: string, execMode: ExecMode, kind: 'image' | 'video' | 'audio', want: boolean) {
  const sourceId = f.sourceSessionId || sessionId
  const direct = kind === 'image'
    ? f.dataUrl || (f.path && execMode !== 'host' ? api.workspaceDownloadUrl(targetForSession(sourceId), sourceId, f.path) : null)
    : null
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const visible = want
  useEffect(() => {
    setSrc(null)
    setFailed(false)
    if (direct || (kind !== 'image' && !visible)) return
    let cancelled = false
    let url: string | undefined
    void (async () => {
      try {
        const data = await targetFor(f, cfg, sessionId, execMode).load()
        if (cancelled) return
        if (!data || 'tooLarge' in data) { setFailed(true); return }
        const type = mimeForExt(f.name) || f.mime || data.mimeType
        url = URL.createObjectURL(new Blob([data.bytes as BlobPart], { type }))
        setSrc(url)
      } catch { if (!cancelled) setFailed(true) }
    })()
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [direct, f.path, f.dataUrl, f.name, f.mime, sourceId, execMode, kind, visible]) // eslint-disable-line react-hooks/exhaustive-deps
  return { src: direct || src, failed, setFailed }
}

/** 缩略条里的一格:真正标 data-viewable 的是它(看图器按它收列表);字节读到后报给上面,主图用同一个 src。 */
const SetThumb: React.FC<{
  f: DisplayFile; cfg: TanguDesktopConfig; sessionId: string; execMode: ExecMode; on: boolean; n: number
  onSrc: (src: string | null, failed: boolean) => void; onPick: () => void; onOpenTab: () => void; imgRef: (el: HTMLImageElement | null) => void
}> = ({ f, cfg, sessionId, execMode, on, n, onSrc, onPick, onOpenTab, imgRef }) => {
  const { src, failed, setFailed } = useMediaSrc(f, cfg, sessionId, execMode, 'image', true)
  useEffect(() => { onSrc(failed ? null : src, failed) }, [src, failed]) // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return null // 上面那层改画成文件卡
  const view = viewableProps({ name: f.name, alt: { label: translate('viewer.openTab'), run: onOpenTab }, edit: { sessionId } })
  return (
    <button type="button" className={`inline-set-thumb${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={translate('inlineSet.pick', { n })} title={f.name} onClick={onPick}>
      {src && !failed
        // 缩略图本身不响应点 / 键(交给外面的按钮切主图);data-viewable + meta 留给看图器收列表
        ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} data-viewable="" ref={(el) => { view.ref(el); imgRef(el) }} />
        : <span className="inline-set-thumb-empty" />}
    </button>
  )
}

/** 1B:主图 + 缩略条。窄了缩略条换到下面横排(容器查询,见 base.css)。 */
const ImageSet: React.FC<{ files: DisplayFile[]; cfg: TanguDesktopConfig; sessionId: string; execMode: ExecMode; open: (f: DisplayFile) => void }> = ({ files, cfg, sessionId, execMode, open }) => {
  const [sel, setSel] = useState(0)
  const [srcs, setSrcs] = useState<Array<string | null>>(() => files.map(() => null))
  const [bad, setBad] = useState<boolean[]>(() => files.map(() => false))
  const thumbs = useRef<Array<HTMLImageElement | null>>([])
  const mainRef = useRef<HTMLImageElement>(null)
  const good = files.map((_, i) => i).filter((i) => !bad[i])
  const cur = bad[sel] ? (good[0] ?? 0) : Math.min(sel, files.length - 1)
  const f = files[cur]
  const mainSrc = srcs[cur]
  const view = (markup = false): void => {
    const el = thumbs.current[cur]
    if (el) openImageViewer(el, { markup, flyEl: mainRef.current ?? undefined })
  }
  const more = (): void => { void useApp.getState().send(translate('inlineSet.moreMsg', { count: files.length }), [], undefined, undefined, undefined, sessionId) }
  return (
    <div className="inline-set">
      <div className="inline-set-row">
        <div className="inline-set-main">
          {mainSrc
            ? <img ref={mainRef} src={mainSrc} alt={f.name} title={f.name} draggable={false} role="button" tabIndex={0}
                onClick={() => view()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view() } }} />
            : <span className="inline-set-main-empty" />}
          {mainSrc && !/\.gif$/i.test(f.name) && (
            <button type="button" className="inline-set-act" onClick={() => view(true)}><PenLine size={13} /><span>{translate('inlineSet.markup')}</span></button>
          )}
        </div>
        <div className="inline-set-strip" role="group">
          {files.map((x, i) => (
            <SetThumb key={i} f={x} cfg={cfg} sessionId={sessionId} execMode={execMode} on={i === cur} n={i + 1}
              onSrc={(u, failed) => {
                setSrcs((all) => (all[i] === u ? all : all.map((v, j) => (j === i ? u : v))))
                setBad((all) => (all[i] === failed ? all : all.map((v, j) => (j === i ? failed : v))))
              }}
              onPick={() => setSel(i)} onOpenTab={() => open(x)} imgRef={(el) => { thumbs.current[i] = el }} />
          ))}
        </div>
      </div>
      <div className="inline-set-meta">
        <span className="inline-set-count">{good.indexOf(cur) + 1} / {good.length}</span>
        <span className="inline-set-name" title={f.name}>{f.name}</span>
        {mainSrc && !/\.gif$/i.test(f.name) && (
          <button type="button" className="inline-set-link" onClick={() => void continueWithImage(mainSrc, f.name, sessionId)}><CornerDownRight size={12} />{translate('inlineSet.useThis')}</button>
        )}
        <button type="button" className="inline-set-link" onClick={more}><RefreshCw size={12} />{translate('inlineSet.more', { count: files.length })}</button>
      </div>
      {files.map((x, i) => (bad[i] ? <FileCard key={i} f={x} onClick={() => open(x)} /> : null))}
    </div>
  )
}

export const InlineFiles: React.FC<{
  files: DisplayFile[]
  cfg: TanguDesktopConfig
  sessionId: string
  execMode: ExecMode
  onOpenPreview?: (t: PreviewTarget) => void
}> = ({ files, cfg, sessionId, execMode, onOpenPreview }) => {
  if (!files.length) return null
  const open = (f: DisplayFile) => onOpenPreview?.(targetFor(f, cfg, sessionId, execMode))
  // 只给生图工具的产出成组:display_file 展示的截图、表情包照旧逐张排(它们没有「再来 N 张」可言)
  const images = files.filter((f) => (f.source === 'generate_image' || f.source === 'edit_image') && previewKindFor(f.mime || '', f.name) === 'image')
  const rest = images.length >= 2 ? files.filter((f) => !images.includes(f)) : files
  return (
    <div className="inline-file-grid">
      {images.length >= 2 && <ImageSet key={images.length} files={images} cfg={cfg} sessionId={sessionId} execMode={execMode} open={open} />}
      {rest.map((f, i) => {
        const kind = previewKindFor(f.mime || '', f.name)
        if (kind === 'image' || kind === 'video' || kind === 'audio') {
          return <InlineMedia key={i} f={f} cfg={cfg} sessionId={sessionId} execMode={execMode} kind={kind} onClick={() => open(f)} />
        }
        return <FileCard key={i} f={f} onClick={() => open(f)} />
      })}
    </div>
  )
}
