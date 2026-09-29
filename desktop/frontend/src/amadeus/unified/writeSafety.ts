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
  'unisave.conflict.agentToast': {
    zh: 'Tangu 在你编辑时改了「{name}」。已保留你的版本，Tangu 的改动另存为「{copy}」。',
    en: 'Tangu changed "{name}" while you were editing. Your version was kept, and Tangu’s changes were saved as "{copy}".',
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
  'unisave.gone.toast': {
    zh: '「{name}」已在别处被删除或移走，最后的改动没来得及保存，另存副本也没写成。可以把这篇的内容复制下来。',
    en: '"{name}" was deleted or moved elsewhere before your last changes were saved, and a backup copy couldn’t be written. You can copy its text.',
  },
  'unisave.renameCopy.toast': {
    zh: '「{name}」改名时已被别处改过，没有覆盖它。你改名期间打的字另存为「{copy}」。',
    en: '"{name}" was changed elsewhere while it was being renamed, so it wasn’t overwritten. What you typed during the rename was saved as "{copy}".',
  },
  'unisave.rescued.toast': {
    zh: '「{name}」已在别处被删除或移走。你还没保存的内容另存为「{copy}」。',
    en: '"{name}" was deleted or moved elsewhere. Your unsaved changes were saved as "{copy}".',
  },
  'unisave.gone.copy': { zh: '复制内容', en: 'Copy text' },
  'unisave.gone.copied': { zh: '已复制到剪贴板', en: 'Copied to clipboard' },
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
// 本窗内的副本写入排成一条队(评审 G1-08 返修):「查空位 → 写」不是原子的,同篇双开的两个实例同时另存
// (别处删了这篇、两边各有没落盘的字)会看中同一个空位,后写的把先写的整份盖掉 —— 正是要保住的那份字。
// 跨窗口的同一竞态仍在(记账:需要主进程的「仅新建」写口)。
let copyQueue: Promise<unknown> = Promise.resolve()
export function writeConflictCopy(path: string, content: string, now = new Date()): Promise<string> {
  const run = copyQueue.then(() => writeConflictCopyNow(path, content, now), () => writeConflictCopyNow(path, content, now))
  copyQueue = run.catch(() => {})
  return run
}

async function writeConflictCopyNow(path: string, content: string, now: Date): Promise<string> {
  const first = conflictCopyPath(path, now)
  for (let n = 1; n <= 50; n++) {
    const candidate = conflictCopyVariant(first, n)
    const existing = await amadeus.readTextFile(candidate)
    if (existing === content) return candidate
    if (existing != null) continue
    // 占名用宿主原子的仅新建(Codex 复核返修 P0):「读到空位 → 写」之间别的窗口 / 设备可能刚占了这个名字 —— 照写就把人家的
    // 副本整份盖掉(本窗的 copyQueue 挡不住跨窗口)。被占了 → 试下一个编号;占的恰好是同一份内容 → 复用;
    // 宿主说没建成又拿不出现文 → 抛(调用方按写失败处理,不许覆盖原文件)。不认 create 的旧宿主回 void,照旧当写成。
    const r = await amadeus.writeTextFile(candidate, content, { create: true })
    if (r && r.ok === false) {
      if (r.current === content) return candidate
      if (r.current != null) continue
      throw new Error('The conflict copy could not be created')
    }
    return candidate
  }
  throw new Error('Too many conflict copies in one minute')
}

/** D-03 / G1-01:error 级提示 + 「打开副本」。同一篇的连续冲突合并成一条(dedupeKey)。 */
/** agent:被盖掉的那一版是 Tangu 写的(评审 G3-05:归属账本认得出)—— 说清是谁的改动进了副本,别让它像「别处」一样模糊。 */
export function toastConflictCopy(path: string, copy: string, agent = false): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-conflict:${path}`,
    text: translate(agent ? 'unisave.conflict.agentToast' : 'unisave.conflict.toast', { name: noteName(path), copy: noteName(copy) }),
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

/** 这篇在盘上没了、手里的字已另存为副本(评审 G1-08 返修):error 级常驻,带「打开副本」。
 *  去重键按**副本**:同篇双开两个实例各存各的副本、各出一条,不互相顶掉(同内容共用一份副本时也只出一条)。 */
export function toastRescued(path: string, copy: string): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-rescued:${copy}`,
    text: translate('unisave.rescued.toast', { name: noteName(path), copy: noteName(copy) }),
    action: {
      label: translate('unisave.conflict.open'),
      run: () => { window.dispatchEvent(new CustomEvent('amadeus:navigate-note', { detail: { path: copy }, cancelable: true })) },
    },
  })
}

/** 改名后补写撞上 CAS(Codex 复核返修 P0-4):新路径已被别处改过 / 没了,本实例改名期间打的字进了副本。 */
export function toastRenameCopy(path: string, copy: string): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-renamecopy:${copy}`,
    text: translate('unisave.renameCopy.toast', { name: noteName(path), copy: noteName(copy) }),
    action: {
      label: translate('unisave.conflict.open'),
      run: () => { window.dispatchEvent(new CustomEvent('amadeus:navigate-note', { detail: { path: copy }, cancelable: true })) },
    },
  })
}

/** 兜底(评审 G1-08):另存副本也写不进去时,最后的入口是剪贴板。复制在点按钮时发生(用户手势,剪贴板写得进)。
 *  去重键带一段内容指纹:同篇双开两个实例的字不同,各出一条。 */
export function toastGoneUnsaved(path: string, text: string): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-gone:${path}:${textFingerprint(text)}`,
    text: translate('unisave.gone.toast', { name: noteName(path) }),
    action: {
      label: translate('unisave.gone.copy'),
      run: () => {
        void navigator.clipboard?.writeText(text).then(() => emitAmadeusToast({ text: translate('unisave.gone.copied') }), () => {})
      },
    },
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
  /** 存在哪个槽位(见 draftKey);null = 不分槽的那一格。读出来时才有,删 / 认领都按它找回原键。 */
  slot?: string | null
}

// 槽位(评审 G1-02 返修):同一篇开在两个标签里、两边都有没落盘的字时被别处改名,两个实例各自把草稿存到新路径 ——
// 只按路径做键的话后一份把前一份整个盖掉。槽位 = 实例所属的 leaf(改名后同一个 leaf 会在新路径重挂,认得回自己那份);
// 不在面板里的实例(台架主实例 / 单列宿主)用不分槽的旧键,与此前落下的草稿兼容。`\u0000` 分隔:路径里不会有它。
const draftBase = (vaultRoot: string | null | undefined, path: string): string => `amadeus.unsavedDraft:${vaultRoot ?? ''}:${path}`
const draftKey = (vaultRoot: string | null | undefined, path: string, slot?: string | null): string =>
  draftBase(vaultRoot, path) + (slot ? `\u0000${slot}` : '')

export function stashDraft(vaultRoot: string | null | undefined, path: string, text: string, baseText: string, slot?: string | null): void {
  try {
    const draft: UnsavedDraft = { text, base: textFingerprint(baseText), at: Date.now() }
    localStorage.setItem(draftKey(vaultRoot, path, slot), JSON.stringify(draft))
  } catch { /* 无痕 / 配额满 / 缩略图宿主:本机草稿只是兜底,拿不到不影响正常保存 */ }
}

function parseDraft(raw: string | null, slot: string | null): UnsavedDraft | null {
  if (!raw) return null
  const d = JSON.parse(raw) as Partial<UnsavedDraft>
  return typeof d.text === 'string' && typeof d.base === 'string' ? { text: d.text, base: d.base, at: Number(d.at) || 0, slot } : null
}

/** 读这篇的草稿:先认自己槽位的;没有就退到**已失去归属**的槽位里最新的一份(那个标签已经关了 / 重启后换了 leaf ——
 *  草稿不能因为认不出主人就再也不提示)。不分槽的那格(slot = null)对不分槽的实例就是自己那格。
 *  `isLive(slot)`:那个槽位的主人还在不在(leaf 还开着 / 有活实例)。**活槽不给别人**(Codex 复核 P1):
 *  否则没有本槽草稿的 A 会读到仍属于 B 的草稿,点「丢弃」删掉 B 的、点「恢复」把 B 的正文放进 A。
 *  不给 isLive = 一律当活着(只认自己那格)。 */
export function readDraft(vaultRoot: string | null | undefined, path: string, slot?: string | null, isLive: (slot: string | null) => boolean = () => true): UnsavedDraft | null {
  try {
    const plainKey = draftKey(vaultRoot, path)
    if (!slot) {
      const own = parseDraft(localStorage.getItem(plainKey), null)
      if (own) return own
    } else {
      const own = parseDraft(localStorage.getItem(draftKey(vaultRoot, path, slot)), slot)
      if (own) return own
      const plain = isLive(null) ? null : parseDraft(localStorage.getItem(plainKey), null)
      if (plain) return plain
    }
    const prefix = draftBase(vaultRoot, path) + '\u0000'
    let best: UnsavedDraft | null = null
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(prefix)) continue
      const owner = k.slice(prefix.length)
      if (owner === slot || isLive(owner)) continue
      const d = parseDraft(localStorage.getItem(k), owner)
      if (d && (!best || d.at > best.at)) best = d
    }
    return best
  } catch {
    return null
  }
}

/** 删草稿(slot 那一格)。给了 `onlyIfText` 时只在存着的正是这份内容时才删 —— 别把上一次会话留下、用户还没决定的那份顺手删了。 */
export function clearDraft(vaultRoot: string | null | undefined, path: string, onlyIfText?: string, slot?: string | null): void {
  try {
    const key = draftKey(vaultRoot, path, slot)
    if (onlyIfText != null) {
      const d = parseDraft(localStorage.getItem(key), slot ?? null)
      if (!d || d.text !== onlyIfText) return
    }
    localStorage.removeItem(key)
  } catch { /* 同 stashDraft */ }
}

/** Electron 宿主:渲染层 beforeunload 的返回值会**无提示**地阻止窗口关闭(用户退不出去),桌面不拦,
 *  走切号 / 退出的冲洗握手;只有 web / 移动宿主才用浏览器的离开确认。
 *  ⚠️ 只能认 UA:web(webShim / unitShim)与移动端(mobileShim)也会装一个 `window.tangu` 垫片,
 *  拿它当判据等于在 web / 移动端也永远不拦(评审跟进实查)。 */
export function isElectronHost(): boolean {
  return typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)
}
