/** v4 统一编辑器的写盘安全件(评审 2026-09-27 波次 0a:D-03 / D-04 / G1-01)。
 *
 * UnifiedPage 的保存管线是「单写者、整文件覆写」—— 三条毁数据的缝都出在「写之前不看盘上是谁的版本、
 * 写失败之后不吭声」:
 *  - D-03 打字中到达的外部改动:按拍板 #6 **本地胜**,但被盖掉的盘上版本必须先另存冲突副本 + error 级提示;
 *  - G1-01 同篇多开:writeTextFile 带基线指纹做比对交换写(主进程拒写就回盘上现文),陈旧实例不再盲写;
 *  - D-04 写失败:首次即提示 + 页面「未保存」条 + 退避重试 + 恢复信号补写;卸载冲洗前先把草稿存进本机。
 * 这里只放**与组件状态无关**的件(命名 / 提示 / 草稿存取);状态机本身在 UnifiedPage(pipe)里。
 */
import { amadeus } from '../api'
import { conflictCopyPath, conflictCopyVariant, textFingerprint } from '@amadeus-shared/writeConflict'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'unisave.conflict.toast': {
    zh: '「{name}」在你编辑时被别处改过。已保留你的版本，被覆盖的那一版另存为「{copy}」。',
    en: '"{name}" was changed elsewhere while you were editing. Your version was kept, and the overwritten version was saved as "{copy}".',
  },
  'unisave.conflict.open': { zh: '打开副本', en: 'Open copy' },
  'unisave.failed.toast': {
    zh: '「{name}」没能保存（{reason}），正在自动重试。保存成功之前请不要关闭它。',
    en: 'Couldn’t save "{name}" ({reason}). Retrying automatically — keep it open until it’s saved.',
  },
  'unisave.failed.unknown': { zh: '未知原因', en: 'unknown reason' },
  'unisave.failed.bar': { zh: '未保存：写入失败，正在自动重试', en: 'Unsaved: the write failed and is being retried' },
  'unisave.failed.retry': { zh: '立即重试', en: 'Retry now' },
  'unisave.draft.bar': { zh: '这篇笔记有一份上次没保存成功的草稿（{time}）。', en: 'This note has a draft that wasn’t saved last time ({time}).' },
  'unisave.draft.hint': { zh: '恢复后会覆盖盘上当前内容；盘上那一版若是别处改过的，会先另存为冲突副本。', en: 'Restoring replaces what’s on disk now. If that version was changed elsewhere, it is saved as a conflict copy first.' },
  'unisave.draft.restore': { zh: '恢复草稿', en: 'Restore draft' },
  'unisave.draft.discard': { zh: '丢弃', en: 'Discard' },
})

/** `amadeus:toast` 的事件载荷(编辑器层 → amadeusOverlays)。只有 text 时走底部吐司;带 level / action 的
 *  在主窗走右上角通知栈(error 常驻手动关,能挂动作钮),见 amadeusOverlays 的 onToast。 */
export interface AmadeusToastDetail {
  text: string
  level?: 'info' | 'success' | 'warning' | 'error'
  action?: { label: string; run(): void }
  dedupeKey?: string
}

export function emitAmadeusToast(detail: AmadeusToastDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail }))
}

const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

/** 把即将被本地版本盖掉的盘上内容另存为冲突副本,返回副本路径。
 *  命名与云同步引擎同一口径(shared/writeConflict):同分钟撞名按 `-2/-3…` 递增;已有**同内容**副本就直接复用
 *  (同一版本不出第二份)。写不进去就抛 —— 调用方据此**不许**覆盖原文件(宁可这次保存卡住重试,不吃掉别人的改动)。 */
export async function writeConflictCopy(path: string, content: string, now = new Date()): Promise<string> {
  const first = conflictCopyPath(path, now)
  for (let n = 1; n <= 50; n++) {
    const candidate = conflictCopyVariant(first, n)
    const existing = await amadeus.readTextFile(candidate)
    if (existing === content) return candidate
    if (existing != null) continue
    await amadeus.writeTextFile(candidate, content, { create: true })
    return candidate
  }
  throw new Error('Too many conflict copies in one minute')
}

/** D-03 / G1-01:error 级提示 + 「打开副本」。同一篇的连续冲突合并成一条(dedupeKey)。 */
export function toastConflictCopy(path: string, copy: string): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-conflict:${path}`,
    text: translate('unisave.conflict.toast', { name: noteName(path), copy: noteName(copy) }),
    action: {
      label: translate('unisave.conflict.open'),
      // 走导航门面事件(amadeusOverlays → openNote):副本是刚写出来的新文件,按名字解析可能还没进页面清单。
      run: () => { window.dispatchEvent(new CustomEvent('amadeus:navigate-note', { detail: { path: copy }, cancelable: true })) },
    },
  })
}

/** 写失败原因的短文案:剥掉 Electron 的「Error invoking remote method …」前缀,只留系统给的那句。 */
export function shortWriteError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const msg = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error:\s*)+/, '').trim()
  if (!msg) return translate('unisave.failed.unknown')
  return msg.length > 80 ? `${msg.slice(0, 79)}…` : msg
}

/** D-04:首次写失败的提示(页面上另有常驻的「未保存」条,这条只负责「第一时间让人知道」)。 */
export function toastSaveFailed(path: string, error: unknown): void {
  emitAmadeusToast({
    level: 'warning',
    dedupeKey: `amx-savefail:${path}`,
    text: translate('unisave.failed.toast', { name: noteName(path), reason: shortWriteError(error) }),
  })
}

/** 退避重试间隔(ms):写失败后自动补写的节拍,最后一档封顶循环。 */
export const SAVE_RETRY_MS = [2000, 5000, 10_000, 30_000, 60_000]

// ── 卸载冲洗草稿(D-04):写是异步的,切走 / 关窗时未必来得及完成,也可能失败 —— 写之前先同步存一份进本机,
//    写成功再删;下次打开同一篇时若草稿 ≠ 盘上内容,提示用户恢复(绝不自动覆盖盘上内容)。键含库根 + 路径。

export interface UnsavedDraft {
  text: string
  /** 草稿基于的盘上版本指纹:恢复时盘上已不是它 = 草稿之后别处又写过,覆盖前要先保全盘上那版。 */
  base: string
  at: number
}

const draftKey = (vaultRoot: string | null | undefined, path: string): string => `amadeus.unsavedDraft:${vaultRoot ?? ''}:${path}`

export function stashDraft(vaultRoot: string | null | undefined, path: string, text: string, baseText: string): void {
  try {
    const draft: UnsavedDraft = { text, base: textFingerprint(baseText), at: Date.now() }
    localStorage.setItem(draftKey(vaultRoot, path), JSON.stringify(draft))
  } catch { /* 无痕 / 配额满 / 缩略图宿主:本机草稿只是兜底,拿不到不影响正常保存 */ }
}

export function readDraft(vaultRoot: string | null | undefined, path: string): UnsavedDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(vaultRoot, path))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<UnsavedDraft>
    return typeof d.text === 'string' && typeof d.base === 'string' ? { text: d.text, base: d.base, at: Number(d.at) || 0 } : null
  } catch {
    return null
  }
}

/** 删草稿。给了 `onlyIfText` 时只在存着的正是这份内容时才删 —— 别把上一次会话留下、用户还没决定的那份顺手删了。 */
export function clearDraft(vaultRoot: string | null | undefined, path: string, onlyIfText?: string): void {
  try {
    if (onlyIfText != null) {
      const d = readDraft(vaultRoot, path)
      if (!d || d.text !== onlyIfText) return
    }
    localStorage.removeItem(draftKey(vaultRoot, path))
  } catch { /* 同 stashDraft */ }
}

/** Electron 宿主:渲染层 beforeunload 的返回值会**无提示**地阻止窗口关闭(用户退不出去),桌面不拦,
 *  走切号 / 退出的冲洗握手;只有 web / 移动宿主才用浏览器的离开确认。
 *  ⚠️ 只能认 UA:web(webShim / unitShim)与移动端(mobileShim)也会装一个 `window.tangu` 垫片,
 *  拿它当判据等于在 web / 移动端也永远不拦(评审跟进实查)。 */
export function isElectronHost(): boolean {
  return typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)
}
