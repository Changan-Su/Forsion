/**
 * 对话区内联文件:agent 经 display_file / generate_image / 表情包展示给用户的文件。
 * 图片 = 缩略图,点击放大(复用 WorkspaceFilePreview 灯箱);其它 = 可点击文件卡片(同样开预览,支持各类文件)。
 * 字节来源:dataUrl 直接用;工作区路径 host 会话走 window.tangu.readHostFile、沙箱走 /agent/workspace/read。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { DisplayFile, TanguDesktopConfig } from '../types'
import type { PreviewTarget, PreviewData } from './WorkspaceFilePreview'
import { b64ToBytes, iconForFile } from '../services/fileKinds'
import * as api from '../services/backendService'

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
  return {
    name: f.name,
    // path 只在本机绝对路径时给:openWsFile 用它做「同路径聚焦 + 随布局持久化」,而恢复时是走
    // hostTargetFor(readHostFile) 重建的 —— 沙箱的工作区相对路径喂进去必然读不到,只能走瞬态 target。
    path: execMode === 'host' && f.path && /^([/~]|[A-Za-z]:[\\/])/.test(f.path) ? f.path : undefined,
    load: async () => {
      if (f.dataUrl) return decodeDataUrl(f.dataUrl)
      if (!f.path) return null
      if (execMode === 'host' && window.tangu?.readHostFile) {
        const r = await window.tangu.readHostFile(f.path)
        if (r.tooLarge) return { tooLarge: true as const, size: r.size }
        return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
      }
      const r = await api.readWorkspaceFile(cfg, sessionId, f.path)
      return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size }
    },
    download: f.path
      ? (execMode === 'host'
          ? () => { void window.tangu?.revealHostPath?.(f.path!) }
          : () => { void api.downloadWorkspaceFile(cfg, sessionId, f.path!).catch(() => {}) })
      : undefined,
  }
}

/** 缩略图:dataUrl / 沙箱直链直接用;host 路径异步读字节做 blob URL。 */
const Thumb: React.FC<{ f: DisplayFile; cfg: TanguDesktopConfig; sessionId: string; execMode: ExecMode; onClick: () => void }> = ({ f, cfg, sessionId, execMode, onClick }) => {
  const direct = f.dataUrl || (f.path && execMode !== 'host' ? api.workspaceDownloadUrl(cfg, sessionId, f.path) : null)
  const [src, setSrc] = useState<string | null>(direct)
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    if (direct) { setSrc(direct); return }
    let cancelled = false
    void (async () => {
      if (f.path && window.tangu?.readHostFile) {
        try {
          const r = await window.tangu.readHostFile(f.path)
          if (cancelled || r.tooLarge) return
          const url = URL.createObjectURL(new Blob([b64ToBytes(r.content) as BlobPart], { type: r.mimeType || f.mime || 'image/png' }))
          urlRef.current = url
          setSrc(url)
        } catch { /* 显示失败 → 退化为文件卡片由父层兜 */ }
      }
    })()
    return () => { cancelled = true; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null } }
  }, [f.path, f.dataUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!src) return null
  return <img className="inline-file-img" src={src} alt={f.name} title={f.name} onClick={onClick} draggable={false} />
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
        const Icon = iconForFile(f.mime || '', f.name)
        return (
          <button key={i} className="inline-file-card" title={f.name} onClick={() => open(f)}>
            <Icon size={15} /><span className="inline-file-name">{f.name}</span>
          </button>
        )
      })}
    </div>
  )
}
