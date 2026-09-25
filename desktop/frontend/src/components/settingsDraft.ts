/**
 * 设置页的草稿层(U-05):没保存的输入住在独立的 `edits` 里,渲染时叠在已落盘快照上。
 *
 * 病根:以前草稿直接写进共享的 `stored`,而即时控件是 `setConfig(...).then(setStored)` —— 主进程回来的
 * effectiveConfig 会整体覆盖 `stored`,旁边随手拨一个开关,前面没保存的沙箱 / 镜像 / 工作目录就静默没了。
 * 拆开之后,即时控件只刷新快照,草稿原样浮在上面;提交成功再把**已提交的那几个值**摘掉。
 */
import type { StoredDesktopConfig } from '../types'

export type SettingsEdits = Partial<StoredDesktopConfig>

/** 渲染视图 = 快照 ⊕ 草稿。快照没到时返回 null(与旧 `stored` 语义一致)。 */
export function mergeEdits(saved: StoredDesktopConfig | null, edits: SettingsEdits): StoredDesktopConfig | null {
  if (!saved) return null
  return Object.keys(edits).length ? { ...saved, ...edits } : saved
}

/**
 * 提交完成后摘掉草稿:只摘「值仍等于提交时那一份」的键 —— 提交在路上时用户又改了,新输入必须留着。
 * `committed` 传提交**时**的草稿快照(未经 trim 等规整的原值),比较用引用 / 值相等。
 */
export function dropCommittedEdits(edits: SettingsEdits, committed: SettingsEdits): SettingsEdits {
  let changed = false
  const next: SettingsEdits = { ...edits }
  for (const key of Object.keys(committed) as Array<keyof StoredDesktopConfig>) {
    if (key in next && Object.is(next[key], committed[key])) {
      delete next[key]
      changed = true
    }
  }
  return changed ? next : edits
}

/** 从草稿里挑出指定键(提交用)。 */
export function pickEdits(edits: SettingsEdits, keys: ReadonlyArray<keyof StoredDesktopConfig>): SettingsEdits {
  const out: SettingsEdits = {}
  for (const key of keys) if (key in edits) (out as Record<string, unknown>)[key] = edits[key]
  return out
}

/** 这些键里有没有与快照不同的草稿(草稿值等于快照 = 没改)。defaults 给缺省值归一(如 mirror 缺省 'default')。 */
export function hasDirtyEdits(
  saved: StoredDesktopConfig | null,
  edits: SettingsEdits,
  keys: ReadonlyArray<keyof StoredDesktopConfig>,
  defaults: SettingsEdits = {},
): boolean {
  if (!saved) return false
  return keys.some((key) => key in edits && (edits[key] ?? defaults[key]) !== (saved[key] ?? defaults[key]))
}
