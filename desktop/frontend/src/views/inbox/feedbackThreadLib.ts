/**
 * 收件箱里的反馈线程(2026-09-22):纯函数与类型,组件在 FeedbackThread.tsx(与本文件同名只差大小写会撞 macOS 的大小写不敏感文件系统,故本文件带 Lib 后缀)。
 *
 * 线程真身在 Forsion 服务端的反馈 API(`GET/POST /api/feedback/:id…`,票主与管理员共用一条路,服务端按 role 定视角);
 * 收件箱那封信只是通知 + 入口 —— 信件正文永远是文字,字节不进正文。
 * 附件限额与服务端 feedbackService.validateAttachments 同口径(≤5 个、单个 ≤5MB、图片 / 文本 / JSON)。
 */
import type { InboxMessage } from '../../services/backendService'

export const FEEDBACK_MAX_FILES = 5
export const FEEDBACK_MAX_BYTES = 5 * 1024 * 1024

export interface FeedbackAttachmentInput {
  filename: string
  mime_type: string
  size: number
  data_base64: string
}

export interface FeedbackThreadData {
  ticket: { id: string; user_id: string; title: string | null; description: string; status: string; created_at: string; username?: string | null; nickname?: string | null }
  replies: Array<{ id: string; author_role: 'user' | 'admin'; content: string; created_at: string }>
  attachments: Array<{ id: string; reply_id: string | null; filename: string | null; mime_type: string; size: number; data_base64: string }>
  /** 服务端按当前账号裁定的视角:票主 = user,管理员 = admin。老 server 不给 → 按 user。 */
  viewer?: 'user' | 'admin'
}

/** 这封信是不是反馈线程:只认服务端广播落下来的、形状完整的 thread(引擎 routes/inbox.ts 已按同规则过滤,这里再钉一次:
 *  移动端 localInbox 直存服务端行,thread 可能还是 JSON 串)。 */
export function inboxThreadOf(msg: Pick<InboxMessage, 'sender_kind' | 'thread'>): { ticketId: string; event?: string } | null {
  if (msg.sender_kind !== 'server' || !msg.thread) return null
  let t: unknown = msg.thread
  if (typeof t === 'string') { try { t = JSON.parse(t) } catch { return null } }
  const o = t as { kind?: unknown; ticketId?: unknown; event?: unknown }
  if (o?.kind !== 'feedback' || typeof o.ticketId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(o.ticketId)) return null
  return { ticketId: o.ticketId, ...(typeof o.event === 'string' ? { event: o.event } : {}) }
}

/** 类型放行:image/*、text/*、application/json;浏览器给不出 mime 的(.log / .json 有时为空)按扩展名兜底。 */
export function attachmentTypeOk(mime: string, name: string): boolean {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/') || m.startsWith('text/') || m === 'application/json') return true
  if (m) return false
  return /\.(txt|log|md|json|csv)$/i.test(name)
}

/** 选文件时的预检:回第一个不合规的原因(与服务端拒绝同口径,先在本地拦住少一趟往返);null = 放行。 */
export function checkAttachments(
  existing: number,
  files: ReadonlyArray<{ name: string; size: number; type: string }>,
): { code: 'tooMany' | 'tooBig' | 'badType'; name: string } | null {
  if (existing + files.length > FEEDBACK_MAX_FILES) return { code: 'tooMany', name: '' }
  for (const f of files) {
    if (!attachmentTypeOk(f.type, f.name)) return { code: 'badType', name: f.name }
    if (f.size <= 0 || f.size > FEEDBACK_MAX_BYTES) return { code: 'tooBig', name: f.name }
  }
  return null
}

/** File → 服务端附件形状(FileReader dataURL 去头即 base64;mime 空时按扩展名补一个能过服务端白名单的)。 */
export function fileToAttachment(file: File): Promise<FeedbackAttachmentInput> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.onload = () => {
      const s = String(r.result || '')
      const at = s.indexOf(',')
      const mime = file.type || (/\.json$/i.test(file.name) ? 'application/json' : 'text/plain')
      resolve({ filename: file.name, mime_type: mime, size: file.size, data_base64: at >= 0 ? s.slice(at + 1) : '' })
    }
    r.readAsDataURL(file)
  })
}

export const isImageMime = (mime: string): boolean => /^image\/[a-z0-9.+-]+$/i.test(mime || '')

/** 展示用 data: 地址(三端 CSP 的 img-src 都放行 data:)。只给图片用;文本类走 Blob 下载。 */
export function attachmentDataUrl(a: { mime_type: string; data_base64: string }): string {
  return `data:${a.mime_type};base64,${(a.data_base64 || '').replace(/\s+/g, '')}`
}

export function fmtKb(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}
