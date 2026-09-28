/**
 * 笔记写盘冲突的**共享口径**(主进程 × 渲染层 × web/mobile 同一份,纯函数、零依赖)。
 *
 * - `conflictCopyPath`:冲突副本命名。云同步引擎(electron/amadeus/sync)与编辑器(UnifiedPage 的
 *   「打字中外部改动 / CAS 拒写」)**必须**同名:entryRegistry 的 stripConflictSuffix 靠这个尾缀把副本
 *   归一回原条目,tangu-agent 的 amadeus-note-format §十(AI 合并冲突副本)也靠它认出副本。
 *   原先住在 electron/amadeus/sync/reconcile.ts,那边保留 re-export —— 别再复制一份。
 * - `conflictCopyVariant`:同分钟撞名的递增候选,与引擎 materializeConflictCopy 的 `-2/-3…` 同口径。
 * - `textFingerprint`:writeTextFile CAS 的基线指纹。主进程(node)与渲染层(浏览器)必须逐字相同,
 *   而且要**同步**可算 —— 所以不用 crypto/SubtleCrypto,用 53 位 cyrb53 + 长度。碰撞的代价只是
 *   「漏判一次冲突」(= 退回旧的盲写行为),不是写坏。
 */

/** 冲突副本路径:`a/b/Note.md` → `a/b/Note (conflict 2026-07-10 1532).md`。 */
export function conflictCopyPath(serverPath: string, now: Date): string {
  const slash = serverPath.lastIndexOf('/')
  const dir = slash < 0 ? '' : serverPath.slice(0, slash + 1)
  const base = slash < 0 ? serverPath : serverPath.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`
  return `${dir}${stem} (conflict ${stamp})${ext}`
}

/** 同分钟第 n 份冲突副本(n ≥ 2):`Note (conflict …).md` → `Note (conflict …)-2.md`。n < 2 原样返回。 */
export function conflictCopyVariant(first: string, n: number): string {
  if (n < 2) return first
  const dot = first.lastIndexOf('.')
  const hasExt = dot > first.lastIndexOf('/') && dot > first.lastIndexOf(')')
  const stem = hasExt ? first.slice(0, dot) : first
  const ext = hasExt ? first.slice(dot) : ''
  return `${stem}-${n}${ext}`
}

/** 文本指纹(writeTextFile 的 CAS 基线):`<长度36进制>-<cyrb53 36进制>`。按 UTF-16 码元算,node/浏览器一致。 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${text.length.toString(36)}-${h.toString(36)}`
}
