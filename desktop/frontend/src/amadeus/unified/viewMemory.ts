/** Amadeus 文档/画布的本机视图记忆。
 *
 * 内容与视图状态刻意分家：当前模式属于“我在这台设备上看到哪一面”，不该为了记住一个 tab
 * 就物化/改写笔记 frontmatter（也不会被 800ms 的正文保存防抖拖住）。文档滚动与画布 viewport
 * 同为会话态，存在模块 Map；模式要跨重启恢复，才落 localStorage。
 */

import { recallViewport, rememberViewport } from './canvasKit/viewport'

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
  const vp = recallViewport(oldId) // 画布视口(会话级,键同口径;V-15)
  if (vp) rememberViewport(noteMemoryId(vaultRoot, newPath), vp)
  if (readNoteLocked(vaultRoot, oldPath)) {
    writeNoteLocked(vaultRoot, newPath, true)
    writeNoteLocked(vaultRoot, oldPath, false)
  }
}

// ── 锁定页面(评审 C-07,拍板 #15)──────────────────────────────────────────────────────────────
// 「这台设备上别手滑改到它」是视图偏好,不是内容:只落本机 localStorage(键含库根),不写 frontmatter ——
// 写进文件就会同步到别的设备、被别的编辑器读到,还会为了一个开关改动文件。锁定的笔记用只读实例渲染
// (与公开分享页同一套 readOnly),外部改动照常回灌。

const LOCK_PREFIX = 'amx.noteLocked:'
const LOCK_EVENT = 'amadeus:note-lock'
const lockKey = (vaultRoot: string | null | undefined, path: string): string => `${LOCK_PREFIX}${noteMemoryId(vaultRoot, path)}`

export function readNoteLocked(vaultRoot: string | null | undefined, path: string): boolean {
  try { return localStorage.getItem(lockKey(vaultRoot, path)) === '1' } catch { return false }
}

/** 锁 / 解锁。同窗的其它标签(同一篇开在几处)经事件一起换实例;别的窗口经 `storage` 事件跟上。 */
export function writeNoteLocked(vaultRoot: string | null | undefined, path: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(lockKey(vaultRoot, path), '1')
    else localStorage.removeItem(lockKey(vaultRoot, path))
  } catch { /* 私有模式:这次会话照样能锁,只是记不住 */ }
  try { window.dispatchEvent(new Event(LOCK_EVENT)) } catch { /* 非浏览器环境 */ }
}

/** 订阅锁定状态变化(任一篇;订阅方自己按路径重读)。返回退订函数。 */
export function onNoteLockChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent): void => { if (!e.key || e.key.startsWith(LOCK_PREFIX)) fn() }
  window.addEventListener(LOCK_EVENT, fn)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(LOCK_EVENT, fn)
    window.removeEventListener('storage', onStorage)
  }
}

const PROPS_OPEN_PREFIX = 'amx.propsOpen:'

/** 属性区展开 / 折叠(评审 C-19):按**库**记(全库一个偏好,同 Obsidian 的全局开关),不写 md。未记过 = null。 */
export function readPropsOpen(vaultRoot: string | null | undefined): boolean | null {
  try {
    const v = localStorage.getItem(`${PROPS_OPEN_PREFIX}${vaultRoot ?? ''}`)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

export function writePropsOpen(vaultRoot: string | null | undefined, open: boolean): void {
  try { localStorage.setItem(`${PROPS_OPEN_PREFIX}${vaultRoot ?? ''}`, open ? '1' : '0') } catch { /* 私有模式:本次实例 state 仍然正确 */ }
}
