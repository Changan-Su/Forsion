// 源码 ↔ 可视 切换时把光标带过去(此前一律跳到文件顶部,长笔记切一次就找不着自己在哪了)。
//
// 两侧对「位置」的表示法完全不同:可视端是某个块内 ProseMirror 的选区,源码端是整份 .md 的
// 字符下标 —— 中间隔着 markdown 序列化,没有现成的双向映射,硬做要给序列化器加位置追踪。
// 这里改用**内容锚点**:取光标前最多 ANCHOR_MAX 个字符,到对面 lastIndexOf 找回去。
//  · 纯文本(绝大多数情况)两侧一模一样,落点精确到字符;
//  · 锚点里含 markdown 语法(`**粗**` 在可视端只有「粗」)时找不回来 → 退到**那个块的开头**。
// 退化路径永远不会把光标丢到别的块里,这是这套方案的下限保证。
import { BLOCK_MARKER_RE, blockMarker } from '@amadeus-shared/compiler/markers'

export interface ModeCursor {
  blockId: string
  /** 光标前的文本(可视端=纯文本,源码端=markdown 原文)。空串 = 只知道块,不知道块内位置。 */
  anchor: string
}

const ANCHOR_MAX = 40

// 一次性传递:切换那一刻写入,对面挂载时取走。刻意不进 store —— 它不是状态,是一次交接。
// ⚠️ **按面板分格**:分屏时每个面板都会挂 SourceEditor/PageView 并调 takeModeCursor(),
// 用一个全局槽的话第一个挂载的把光标取走、另一个拿到 null,而 A 的光标可能被应用到 B 上去
// (Codex 复审坐实)。scope 缺省走 'main',非分屏路径行为不变。
const pending = new Map<string, ModeCursor>()
export const setModeCursor = (c: ModeCursor | null, scope = 'main'): void => {
  if (c) pending.set(scope, c)
  else pending.delete(scope)
}
export const takeModeCursor = (scope = 'main'): ModeCursor | null => {
  const p = pending.get(scope) ?? null
  pending.delete(scope)
  return p
}

/** 从当前 DOM 选区抓「在哪个块 + 光标前是什么文本」。焦点不在任何块里 → null。 */
export function captureFromDom(): ModeCursor | null {
  const sel = window.getSelection()
  if (!sel || !sel.anchorNode) return null
  const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement
  const host = el?.closest<HTMLElement>('[data-block-id]')
  const pm = el?.closest<HTMLElement>('.ProseMirror')
  if (!host || !pm) return null
  const blockId = host.dataset.blockId
  if (!blockId) return null
  // 光标前的纯文本:用一个从块首到光标的 Range 取,天然跨越行内元素(加粗/链接/双链)。
  const r = document.createRange()
  r.selectNodeContents(pm)
  try {
    r.setEnd(sel.anchorNode, sel.anchorOffset)
  } catch {
    return { blockId, anchor: '' }
  }
  return { blockId, anchor: r.toString().slice(-ANCHOR_MAX) }
}

/** 源码里某块**内容**的起始下标(marker 那行之后);没有该块返回 -1。 */
export function blockContentStart(src: string, blockId: string): number {
  const i = src.indexOf(blockMarker(blockId))
  if (i < 0) return -1
  const nl = src.indexOf('\n', i)
  if (nl < 0) return src.length
  // compile() 写的是 `marker\n\n内容`(空块则只有 marker),跳过紧随的空行。
  return src[nl + 1] === '\n' ? nl + 2 : nl + 1
}

/** 可视 → 源码:锚点在该块内容里的落点;找不到就停在块首。src 里没这个块 → -1(调用方不动光标)。 */
export function sourceOffsetFor(src: string, cur: ModeCursor): number {
  const start = blockContentStart(src, cur.blockId)
  if (start < 0 || !cur.anchor) return start
  const next = nextMarkerIndex(src, start)
  const hit = src.slice(start, next).lastIndexOf(cur.anchor)
  return hit < 0 ? start : start + hit + cur.anchor.length
}

/** 全局版块标记正则。由 BLOCK_MARKER_RE 派生,别在本文件里另抄一份字面量(改了会两边不同步)。 */
const markerRe = (): RegExp => new RegExp(BLOCK_MARKER_RE.source, 'gm')

/** 从 from 起下一个块标记的下标(没有则到文末)。 */
function nextMarkerIndex(src: string, from: number): number {
  const re = markerRe()
  re.lastIndex = from
  const m = re.exec(src)
  return m ? m.index : src.length
}

/** 源码 → 可视:光标落在哪个块 + 块内光标前的原文。不在任何块里(如 frontmatter)→ null。 */
export function cursorFromSource(src: string, offset: number): ModeCursor | null {
  const re = markerRe()
  let hit: { id: string; end: number } | null = null
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index >= offset) break
    hit = { id: m[1], end: m.index + m[0].length }
  }
  if (!hit) return null
  const start = src[hit.end + 1] === '\n' ? hit.end + 2 : hit.end + 1
  return { blockId: hit.id, anchor: src.slice(Math.max(start, offset - ANCHOR_MAX), offset) }
}
