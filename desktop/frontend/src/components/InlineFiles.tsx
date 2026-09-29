/**
 * 对话区内联文件:agent 经 display_file / generate_image / 表情包展示给用户的文件。
 * 图片 = 缩略图,点击放大(复用 WorkspaceFilePreview 灯箱);其它 = 可点击文件卡片(同样开预览,支持各类文件)。
 * 字节来源:dataUrl 直接用;工作区路径 host 会话走「会话所在那台电脑」的 host 文件面(hostFs:本机 = window.tangu.readHostFile,
 * 手机把整端切到我的电脑 = 经 hub 的 /unit/hostfile)、沙箱走 /agent/workspace/read(P1-K6 S2)。
 * 下载(P1-DL):host 文件一律交给同一个 hostFs 的 downloadHostFile —— 本机 = 在文件管理器显示;手机 / 设备页 / 看别的电脑 =
 * /unit/hostfile/download 流式下载原文件(预览 4MB 上限管不到它)。老消息不用改形状,同样有下载位。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { DisplayFile, TanguDesktopConfig } from '../types'
import type { PreviewTarget, PreviewData } from './WorkspaceFilePreview'
import { b64ToBytes, iconForFile } from '../services/fileKinds'
import * as api from '../services/backendService'
import { hostFsForSession } from '../services/engine/hostFs'
import { notifyApp } from '../stores/notificationStore'
import { targetForSession } from '../services/engine/targets'

type ExecMode = 'host' | 'sandbox' | undefined

const isImage = (f: DisplayFile): boolean =>
  (f.mime?.startsWith('image/') ?? false) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)

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
    download: f.path
      ? (execMode === 'host'
          // 这端给不了(云端没有 host 文件面)→ undefined 藏掉下载位,免留静默哑弹
          ? (hostDownload ? () => { void hostDownload(f.path!, f.name).catch(surface) } : undefined)
          : () => { void api.downloadWorkspaceFile(targetForSession(sessionId), sessionId, f.path!).catch(surface) })
      : undefined,
  }
}

/** 非图片(以及读不出缩略图的图片)的文件卡片:点开预览,预览里有下载位。 */
const FileCard: React.FC<{ f: DisplayFile; onClick: () => void }> = ({ f, onClick }) => {
  const Icon = iconForFile(f.mime || '', f.name)
  return (
    <button className="inline-file-card" title={f.name} onClick={onClick}>
      <Icon size={15} /><span className="inline-file-name">{f.name}</span>
    </button>
  )
}

/** 缩略图:dataUrl / 沙箱直链直接用;host 路径异步读字节做 blob URL。
 *  目标不能直链(手机经 hub 打我的电脑:`<img src>` 不带凭据、隧道 cookie 对手机源是跨站)→ 沙箱文件也读字节做 blob。
 *  读不出来(手机上 >4MB 的图 = 隧道预览 tooLarge、对方离线……)→ 退化成文件卡片:图没了下载位也不能跟着没(P1-DL)。 */
const Thumb: React.FC<{ f: DisplayFile; cfg: TanguDesktopConfig; sessionId: string; execMode: ExecMode; onClick: () => void }> = ({ f, cfg, sessionId, execMode, onClick }) => {
  sessionId = f.sourceSessionId || sessionId
  const direct = f.dataUrl || (f.path && execMode !== 'host' ? api.workspaceDownloadUrl(targetForSession(sessionId), sessionId, f.path) : null)
  const [src, setSrc] = useState<string | null>(direct)
  const [failed, setFailed] = useState(false)
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    setFailed(false)
    if (direct) { setSrc(direct); return }
    let cancelled = false
    void (async () => {
      if (!f.path) return
      const fs = execMode === 'host' ? hostFsForSession(sessionId) : null
      try {
        let bytes: Uint8Array | null = null
        let mime = ''
        if (fs) {
          const r = await fs.readHostFile(f.path)
          if (cancelled) return
          if (r.tooLarge) { setFailed(true); return }
          bytes = b64ToBytes(r.content)
          mime = r.mimeType
        } else if (execMode !== 'host') {
          const r = await api.readWorkspaceFile(targetForSession(sessionId), sessionId, f.path)
          if (cancelled) return
          bytes = b64ToBytes(r.content)
          mime = r.mimeType
        }
        if (!bytes || cancelled) return
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || f.mime || 'image/png' }))
        urlRef.current = url
        setSrc(url)
      } catch { if (!cancelled) setFailed(true) }
    })()
    return () => { cancelled = true; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null } }
  }, [f.path, f.dataUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <FileCard f={f} onClick={onClick} />
  if (!src) return null
  return <img className="inline-file-img" src={src} alt={f.name} title={f.name} onClick={onClick} draggable={false} onError={() => setFailed(true)} />
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
  return (
    <div className="inline-file-grid">
      {files.map((f, i) => {
        if (isImage(f)) return <Thumb key={i} f={f} cfg={cfg} sessionId={sessionId} execMode={execMode} onClick={() => open(f)} />
        return <FileCard key={i} f={f} onClick={() => open(f)} />
      })}
    </div>
  )
}
