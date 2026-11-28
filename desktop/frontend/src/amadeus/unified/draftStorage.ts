import { textFingerprint } from '@amadeus-shared/writeConflict'
import { legacyWinRel } from '../lib/vaultFiles'
import { localStorageKeys, moveLocalStorageEntry } from '../lib/localStorageMigration'

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

/** stashDraft 写的那一格此刻存着的正文:空格 = null;读不出 / 解析不了 = undefined(「不知道」,调用方别当空处理)。
 *  只看这一格:stashDraft 从不写老版本 Windows 的 legacy 键,会被它盖掉的只有这一个。 */
export function peekDraftText(vaultRoot: string | null | undefined, path: string, slot?: string | null): string | null | undefined {
  try {
    const raw = localStorage.getItem(draftKey(vaultRoot, path, slot))
    if (raw == null) return null
    return parseDraft(raw, slot ?? null)?.text
  } catch {
    return undefined
  }
}

/** 读这篇的草稿:先认自己槽位的;没有就退到**已失去归属**的槽位里最新的一份(那个标签已经关了 / 重启后换了 leaf ——
 *  草稿不能因为认不出主人就再也不提示)。不分槽的那格(slot = null)对不分槽的实例就是自己那格。
 *  `isLive(slot)`:那个槽位的主人还在不在(leaf 还开着 / 有活实例)。**活槽不给别人**(Codex 复核 P1):
 *  否则没有本槽草稿的 A 会读到仍属于 B 的草稿,点「丢弃」删掉 B 的、点「恢复」把 B 的正文放进 A。
 *  不给 isLive = 一律当活着(只认自己那格)。 */
export function readDraft(vaultRoot: string | null | undefined, path: string, slot?: string | null, isLive: (slot: string | null) => boolean = () => true): UnsavedDraft | null {
  const own = readDraftAt(vaultRoot, path, slot, isLive)
  const legacy = own ? null : legacyWinRel(path, vaultRoot)
  const old = legacy ? readDraftAt(vaultRoot, legacy, slot, isLive) : null
  if (!old || !legacy) return own
  // 老版本 Windows 按 `a\b.md` 存下的草稿:挪到 `/` 的键上(那格已有东西就不动),不然 clearDraft 删不掉,每次打开都再提示一遍。
  try {
    const from = draftKey(vaultRoot, legacy, old.slot)
    const to = draftKey(vaultRoot, path, old.slot)
    const raw = localStorage.getItem(from)
    if (raw != null && localStorage.getItem(to) == null) { localStorage.setItem(to, raw); localStorage.removeItem(from) }
  } catch { /* 同 stashDraft */ }
  return old
}

function readDraftAt(vaultRoot: string | null | undefined, path: string, slot: string | null | undefined, isLive: (slot: string | null) => boolean): UnsavedDraft | null {
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
    // 老版本 Windows 那种写法的键也删:readDraft 读到时挪不动(配额满)就还在那里。
    for (const p of [path, legacyWinRel(path, vaultRoot)]) {
      if (!p) continue
      const key = draftKey(vaultRoot, p, slot)
      if (onlyIfText != null) {
        const d = parseDraft(localStorage.getItem(key), slot ?? null)
        if (!d || d.text !== onlyIfText) continue
      }
      localStorage.removeItem(key)
    }
  } catch { /* 同 stashDraft */ }
}

/** Preserve the relative path and slot exactly when the whole cloud library moves. */
export function migrateDraftRoot(from: string, to: string): void {
  if (from === to) return
  const prefix = draftBase(from, '')
  for (const key of localStorageKeys()) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    moveLocalStorageEntry(key, draftBase(to, suffix), (raw) => parseDraft(raw, null) !== null)
  }
}
