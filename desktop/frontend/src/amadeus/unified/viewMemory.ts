/** Amadeus 文档/画布的本机视图记忆。
 *
 * 内容与视图状态刻意分家：当前模式属于“我在这台设备上看到哪一面”，不该为了记住一个 tab
 * 就物化/改写笔记 frontmatter（也不会被 800ms 的正文保存防抖拖住）。文档滚动与画布 viewport
 * 同为会话态，存在模块 Map；模式要跨重启恢复，才落 localStorage。
 */

export type NoteSurfaceMode = 'doc' | 'canvas'

const MODE_PREFIX = 'amx.noteSurfaceMode:'
const docScroll = new Map<string, number>()

/** vault 必须进键：两个库都很常见 `untitled.md`，只按相对 path 会串记忆。 */
export function noteMemoryId(vaultRoot: string | null | undefined, path: string): string {
  return JSON.stringify([vaultRoot ?? '', path])
}

const modeKey = (vaultRoot: string | null | undefined, path: string): string =>
  `${MODE_PREFIX}${noteMemoryId(vaultRoot, path)}`

export function readNoteSurfaceMode(vaultRoot: string | null | undefined, path: string): NoteSurfaceMode | null {
  try {
    const value = localStorage.getItem(modeKey(vaultRoot, path))
    return value === 'doc' || value === 'canvas' ? value : null
  } catch {
    return null
  }
}

export function writeNoteSurfaceMode(vaultRoot: string | null | undefined, path: string, mode: NoteSurfaceMode): void {
  try { localStorage.setItem(modeKey(vaultRoot, path), mode) } catch { /* 私有模式：本次实例 state 仍然正确 */ }
}

export function readDocumentScroll(vaultRoot: string | null | undefined, path: string): number {
  return docScroll.get(noteMemoryId(vaultRoot, path)) ?? 0
}

export function writeDocumentScroll(vaultRoot: string | null | undefined, path: string, top: number): void {
  docScroll.set(noteMemoryId(vaultRoot, path), Math.max(0, Number.isFinite(top) ? top : 0))
}

/** 行内改名会用新 path 重建 UnifiedPage；先搬记忆，重建首帧才不会退回另一种模式/页首。 */
export function remapNoteViewMemory(vaultRoot: string | null | undefined, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  const mode = readNoteSurfaceMode(vaultRoot, oldPath)
  if (mode) writeNoteSurfaceMode(vaultRoot, newPath, mode)
  const oldId = noteMemoryId(vaultRoot, oldPath)
  if (docScroll.has(oldId)) docScroll.set(noteMemoryId(vaultRoot, newPath), docScroll.get(oldId)!)
}
