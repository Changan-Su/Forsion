/** 同一份附件同时写 markdown 与 native file 时,Chromium/macOS 的 paste 事件有时只暴露 Files。
 * 用短时、同源共享的记忆把这种粘贴还原成库内引用;localStorage 让不同 Forsion 窗口也能读到。 */
export const ATTACHMENT_CLIP_MIME = 'application/x-forsion-attachment-reference'
export const ATTACHMENT_CLIP_RECENT_KEY = 'forsion_attachment_clipboard_v1'
const RECENT_MS = 30_000

interface RecentAttachmentCopy { reference: string; fileName: string; at: number }
let memory: RecentAttachmentCopy | null = null

export function rememberAttachmentCopy(reference: string, ref: string): void {
  const rawName = ref.split(/[\\/]/).pop() ?? ref
  let fileName = rawName
  try { fileName = decodeURIComponent(rawName) } catch { /* literal % filename */ }
  const value = { reference, fileName, at: Date.now() }
  memory = value
  try { localStorage.setItem(ATTACHMENT_CLIP_RECENT_KEY, JSON.stringify(value)) } catch { /* privacy mode */ }
}

export function recentAttachmentCopy(): RecentAttachmentCopy | null {
  let value = memory
  try {
    const stored = JSON.parse(localStorage.getItem(ATTACHMENT_CLIP_RECENT_KEY) ?? 'null') as typeof memory
    if (stored && (!value || stored.at > value.at)) value = stored
  } catch { /* missing/corrupt storage */ }
  if (!value || Date.now() - value.at >= RECENT_MS || !value.reference || !value.fileName) return null
  return value
}
