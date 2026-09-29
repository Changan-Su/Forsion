/** Amadeus 文档/画布的本机视图记忆。
 *
 * 内容与视图状态刻意分家：当前模式属于“我在这台设备上看到哪一面”，不该为了记住一个 tab
 * 就物化/改写笔记 frontmatter（也不会被 800ms 的正文保存防抖拖住）。画布 viewport 是会话态，
 * 存在模块 Map；模式、文档滚动与光标(C-23)要跨重启恢复，落 localStorage。
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
  const id = noteMemoryId(vaultRoot, path)
  return docScroll.get(id) ?? views()[id]?.s ?? 0
}

export function writeDocumentScroll(vaultRoot: string | null | undefined, path: string, top: number): void {
  const id = noteMemoryId(vaultRoot, path)
  const v = Math.max(0, Number.isFinite(top) ? top : 0)
  docScroll.set(id, v)
  touchView(id, { s: Math.round(v) })
}

// ── 文档位置的本机持久记忆(评审 C-23)──────────────────────────────────────────────────────────────
// 滚动与光标此前只在进程内(上面的 docScroll):换篇回来光标丢了、重载 / 重启 / 渲染进程崩溃重载后连滚动也没了。
// 按 noteMemoryId(库根 + 路径)存本机 localStorage,一个键一张表、按最近使用淘汰到 VIEW_CAP 条;不写 md。
// 光标带一小段上下文文字(caretContext):回放前按文本复核,文档在别处被改得对不上了就丢弃,绝不把光标放到别的字上。
// 写入防抖 500ms(滚动事件很密),pagehide / beforeunload 立即落;多窗口各写各的,落盘前与盘上那份按条目的新旧合并。

export interface NoteCaret {
  /** anchor / head(PM 文档位置) */
  a: number
  h: number
  /** head 前后各一小段文字(复核用) */
  t: string
}
interface NoteView { s?: number; c?: NoteCaret; u: number }
const VIEW_KEY = 'amx.noteView.v1'
const VIEW_CAP = 300
let viewCache: Record<string, NoteView> | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

function loadViews(): Record<string, NoteView> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, NoteView>) : {}
  } catch {
    return {}
  }
}
function views(): Record<string, NoteView> {
  if (!viewCache) viewCache = loadViews()
  return viewCache
}
function persistViews(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  const mine = views()
  const merged: Record<string, NoteView> = loadViews()
  for (const [id, v] of Object.entries(mine)) if (!merged[id] || (merged[id].u ?? 0) <= v.u) merged[id] = v
  const ids = Object.keys(merged)
  if (ids.length > VIEW_CAP) {
    ids.sort((x, y) => (merged[y].u ?? 0) - (merged[x].u ?? 0))
    for (const id of ids.slice(VIEW_CAP)) delete merged[id]
  }
  viewCache = merged
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(merged)) } catch { /* 私有模式 / 配额:本次会话的进程内记忆仍然有效 */ }
}
function touchView(id: string, patch: Partial<NoteView>): void {
  const all = views()
  all[id] = { ...all[id], ...patch, u: Date.now() }
  if (!persistTimer) persistTimer = setTimeout(persistViews, 500)
}
if (typeof window !== 'undefined') {
  const now = (): void => { if (persistTimer) persistViews() }
  window.addEventListener('pagehide', now)
  window.addEventListener('beforeunload', now)
}

/** 立刻落盘(防抖窗里的也算):窗口要走了(pagehide)时,防抖着没记的光标先记进来再调它。 */
export function flushNoteViews(): void {
  if (persistTimer) persistViews()
}

export function readNoteCaret(vaultRoot: string | null | undefined, path: string): NoteCaret | null {
  const c = views()[noteMemoryId(vaultRoot, path)]?.c
  return c && Number.isInteger(c.a) && Number.isInteger(c.h) && typeof c.t === 'string' ? c : null
}

export function writeNoteCaret(vaultRoot: string | null | undefined, path: string, caret: NoteCaret): void {
  touchView(noteMemoryId(vaultRoot, path), { c: caret })
}

/** 行内改名会用新 path 重建 UnifiedPage；先搬记忆，重建首帧才不会退回另一种模式/页首。 */
export function remapNoteViewMemory(vaultRoot: string | null | undefined, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  const mode = readNoteSurfaceMode(vaultRoot, oldPath)
  if (mode) writeNoteSurfaceMode(vaultRoot, newPath, mode)
  const oldId = noteMemoryId(vaultRoot, oldPath)
  if (docScroll.has(oldId)) docScroll.set(noteMemoryId(vaultRoot, newPath), docScroll.get(oldId)!)
  const kept = views()[oldId]
  if (kept) {
    delete views()[oldId]
    touchView(noteMemoryId(vaultRoot, newPath), { ...kept })
  }
  const vp = recallViewport(oldId) // 画布视口(会话级,键同口径;V-15)
  if (vp) rememberViewport(noteMemoryId(vaultRoot, newPath), vp)
  if (readNoteLocked(vaultRoot, oldPath)) {
    writeNoteLocked(vaultRoot, newPath, true)
    writeNoteLocked(vaultRoot, oldPath, false)
  }
  movePageStyle(vaultRoot, oldPath, newPath)
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

// ── 页面排版选项(评审 C-21,拍板 #14):全宽 / 小字号 / 页面字体 ─────────────────────────────────────────
// 与锁定页面同一口径:「这台设备上怎么看这一篇」是视图偏好,不是内容 —— 只落本机 localStorage(键 = 库根 + 路径),
// 不写 frontmatter。一篇一个键,全是缺省值就删键(同「解锁即删键」),所以不设 LRU:只有改过的笔记才占条目。

export type NotePageFont = 'default' | 'serif' | 'mono'
export interface NotePageStyle { wide: boolean; small: boolean; font: NotePageFont }
export const DEFAULT_PAGE_STYLE: NotePageStyle = { wide: false, small: false, font: 'default' }

const PAGE_PREFIX = 'amx.notePage:'
const PAGE_EVENT = 'amadeus:note-page-style'
const pageKey = (vaultRoot: string | null | undefined, path: string): string => `${PAGE_PREFIX}${noteMemoryId(vaultRoot, path)}`

function parsePageStyle(raw: string | null): NotePageStyle {
  if (!raw) return DEFAULT_PAGE_STYLE
  try {
    const v = JSON.parse(raw) as { w?: unknown; s?: unknown; f?: unknown }
    return { wide: v.w === 1, small: v.s === 1, font: v.f === 'serif' || v.f === 'mono' ? v.f : 'default' }
  } catch {
    return DEFAULT_PAGE_STYLE
  }
}

export function readNotePageStyle(vaultRoot: string | null | undefined, path: string): NotePageStyle {
  try { return parsePageStyle(localStorage.getItem(pageKey(vaultRoot, path))) } catch { return DEFAULT_PAGE_STYLE }
}

/** 改这一篇的排版选项(只改给出的几项)。同窗各标签经事件、别的窗口经 `storage` 事件跟上。 */
export function writeNotePageStyle(vaultRoot: string | null | undefined, path: string, patch: Partial<NotePageStyle>): void {
  const next = { ...readNotePageStyle(vaultRoot, path), ...patch }
  storePageStyle(pageKey(vaultRoot, path), next)
  try { window.dispatchEvent(new Event(PAGE_EVENT)) } catch { /* 非浏览器环境 */ }
}

function storePageStyle(key: string, st: NotePageStyle): void {
  const packed: { w?: 1; s?: 1; f?: NotePageFont } = {}
  if (st.wide) packed.w = 1
  if (st.small) packed.s = 1
  if (st.font !== 'default') packed.f = st.font
  try {
    if (Object.keys(packed).length) localStorage.setItem(key, JSON.stringify(packed))
    else localStorage.removeItem(key)
  } catch { /* 私有模式 / 配额:本次会话照样生效,只是记不住 */ }
}

/** 订阅排版选项变化(任一篇;订阅方自己按路径重读)。返回退订函数。 */
export function onNotePageStyleChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent): void => { if (!e.key || e.key.startsWith(PAGE_PREFIX)) fn() }
  window.addEventListener(PAGE_EVENT, fn)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PAGE_EVENT, fn)
    window.removeEventListener('storage', onStorage)
  }
}

/** 改名 / 移动:排版选项跟着走,旧键删掉(再调一次就是空操作 —— 行内改名与 remapScopePaths 会各调一次)。 */
function movePageStyle(vaultRoot: string | null | undefined, oldPath: string, newPath: string): void {
  let raw: string | null = null
  try { raw = localStorage.getItem(pageKey(vaultRoot, oldPath)) } catch { return }
  if (raw == null) return
  storePageStyle(pageKey(vaultRoot, newPath), parsePageStyle(raw))
  try { localStorage.removeItem(pageKey(vaultRoot, oldPath)) } catch { /* 同上 */ }
  try { window.dispatchEvent(new Event(PAGE_EVENT)) } catch { /* 非浏览器环境 */ }
}

/** 文件夹改名 / 移动(整棵子树换前缀):子树里每篇的排版选项跟着走。库根不同的条目不碰。 */
export function remapNotePageStylePrefix(vaultRoot: string | null | undefined, oldPrefix: string, newPrefix: string): void {
  if (oldPrefix === newPrefix) return
  const hits: Array<[string, string]> = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(PAGE_PREFIX)) continue
      let id: unknown
      try { id = JSON.parse(key.slice(PAGE_PREFIX.length)) } catch { continue }
      if (!Array.isArray(id) || id[0] !== (vaultRoot ?? '') || typeof id[1] !== 'string') continue
      const p = id[1]
      if (p === oldPrefix || p.startsWith(`${oldPrefix}/`)) hits.push([p, newPrefix + p.slice(oldPrefix.length)])
    }
  } catch { return }
  for (const [from, to] of hits) movePageStyle(vaultRoot, from, to)
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
