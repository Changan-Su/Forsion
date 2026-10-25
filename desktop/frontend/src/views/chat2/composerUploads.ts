/**
 * 输入卡里的附件从加进来那一刻起就有磁贴(10-24 用户:「上传的时候不让发送就行了，上传完再发」)。
 *  - 图片:磁贴先用本地预览(objectURL)出来,后台读成 base64(随消息发给模型);
 *  - 「→工作区」文件:读完,会话已经存在就立刻传进会话工作区,磁贴里是上传进度;发送时不再传第二遍。
 *    新对话还没有会话,只读不传 —— 发送时建出会话再传(Composer 在那段时间里把磁贴画成「上传中」)。
 * 读 / 传期间与失败时发送键灰着(Composer2 的 uploadGate)。进度记在上传台账(services/uploads),磁贴按 id 读。
 * 状态不写进 Attachment(那是引擎契约类型):按对象挂在 WeakMap 上,与 tileKey / isLeaving 同一做法。
 */
import type { Attachment } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { deleteWorkspaceFile, uploadWorkspaceFiles } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { cancelUpload, forgetUpload, readAsBase64, startUpload } from '../../services/uploads'
import { setDraftField, useComposerDrafts } from './composerDrafts'

type Field = 'attachments' | 'wsFiles'

const uploadIds = new WeakMap<Attachment, string>()
const previews = new WeakMap<Attachment, string>()
/** 已经传进了哪个会话的工作区:发送时跳过,移除磁贴时从那里删掉。 */
const inWorkspace = new WeakMap<Attachment, string>()

export const uploadIdOf = (a: Attachment): string | undefined => uploadIds.get(a)
export const previewOf = (a: Attachment): string | undefined => previews.get(a)
export const isInWorkspace = (a: Attachment): boolean => inWorkspace.has(a)

/** 加进草稿 `key` 的 `field`:先出磁贴,再读(+ 传)。src 是 File(还没读)或已读好的附件(本机路径读出来的)。
 *  sessionId:会话已存在 → 文件立刻传进它的工作区;null = 新对话 / 正在跑,只读,发送时再传。
 *  「→工作区」里已有同名的 → 不加,返回 false:两份落在工作区同一路径上,移除其中一个会把另一个的文件删掉。 */
export function addDraftFile(key: string, field: Field, src: File | Attachment, sessionId: string | null): boolean {
  if (field === 'wsFiles' && useComposerDrafts.getState()[key]?.wsFiles.some((x) => x.name === src.name)) return false
  const file = src instanceof File ? src : null
  const a: Attachment = file
    ? { name: file.name, mimeType: file.type || 'application/octet-stream', data: '', size: file.size }
    : src as Attachment
  if (file && a.mimeType.startsWith('image/')) previews.set(a, URL.createObjectURL(file))
  // 读好之后原地写进这个对象再让草稿重渲:磁贴按对象认(tileKey),换个对象它会当成新磁贴重新入场。
  const touch = (): void => setDraftField(key, field, (prev) => (prev.includes(a) ? [...prev] : prev))
  const id = startUpload(a.name, a.size || file?.size || 0, async ({ stage, progress, signal }) => {
    if (!a.data && file) {
      a.data = await readAsBase64(file, progress, signal)
      touch()
    }
    if (field !== 'wsFiles' || !sessionId) return
    stage('uploading')
    const size = a.size || file?.size || 0
    const r = await uploadWorkspaceFiles(targetForSession(sessionId), sessionId,
      [{ path: a.name, content: a.data, encoding: 'base64', mimeType: a.mimeType }],
      { onProgress: (x) => progress(x * size), signal })
    if (!r.success || !r.saved) throw new Error(r.errors?.[0] || 'upload failed')
    inWorkspace.set(a, sessionId)
  })
  uploadIds.set(a, id)
  setDraftField(key, field, (prev) => [...prev, a])
  return true
}

/** 移除磁贴:在途的中止;已经传进工作区的从那里删掉(不留没人用的文件);释放预览。 */
export function removeDraftFile(key: string, field: Field, a: Attachment): void {
  const id = uploadIds.get(a)
  if (id) cancelUpload(id)
  const sid = inWorkspace.get(a)
  if (sid) void deleteWorkspaceFile(targetForSession(sid), sid, a.name).catch(() => {})
  release([a])
  setDraftField(key, field, (prev) => prev.filter((x) => x !== a))
}

/** 发出去了:台账里拿掉、预览释放(气泡里画的是 base64,不再要它)。 */
export function release(list: Attachment[]): void {
  for (const a of list) {
    const id = uploadIds.get(a)
    if (id) forgetUpload(id)
    const url = previews.get(a)
    if (url) URL.revokeObjectURL(url)
    previews.delete(a)
  }
}
