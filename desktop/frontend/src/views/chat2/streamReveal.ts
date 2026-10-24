/**
 * 流式尾巴淡入(借鉴 Comma 方案 §5「Chat 手感」,2026-10-24):刚流出来的字从半透明淡到正常,不跳。
 *
 * 做法:CSS 自定义高亮(`CSS.highlights`),只吃 Range、不拆 span、不读布局 —— 正文照旧由 Markdown 整段重渲。
 * 每条在流的回答记一个「已见字数」:每次渲染后量一下 `.t2-content` 里的字数,多出来的那一截记为一批新字;
 * 每帧按「到了多久」把每个字放进 16 档透明度高亮之一(同档相邻的字合成一个 Range)。
 *
 * 数值(方案试玩页「借鉴后」那一栏):每个字 150ms,前后错开 10ms、最多错开 90ms,一次最多 220 个字在动,
 * 起点 12% 透明度,smoothstep 曲线。减少动态效果 / 不支持高亮时整个不做(字照旧直接出现)。
 *
 * ponytail: 按 UTF-16 码元算「字」,emoji 这类代理对会被拆到两档里各画一半 —— 只是 150ms 内的颜色,不值得上 Intl.Segmenter。
 * ponytail: 淡入色统一取 --text,链接 / 行内代码淡入那 150ms 是正文色,落定后回到自己的颜色。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { reducedMotion } from '@lcl/engine'

const DURATION = 150
const STAGGER = 10
const MAX_STAGGER = 90
const LEVELS = 16
const MAX_CHARS = 220
const NAME = 't2-reveal-'

interface Run { start: number; end: number; at: number }
interface Root { el: HTMLElement; seen: number; runs: Run[]; live: boolean }

const roots = new Set<Root>()
let highlights: Highlight[] | null = null
let raf = 0

const supported = (): boolean => typeof Highlight === 'function' && typeof CSS !== 'undefined' && 'highlights' in CSS

/** 回答里属于正文的文本节点(工具行、过程行、卡片不算:它们的字变了不该淡入)。 */
function textNodes(el: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.t2-content') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}
const textLength = (el: HTMLElement): number => textNodes(el).reduce((s, n) => s + n.length, 0)

function ensureHighlights(): Highlight[] {
  if (highlights) return highlights
  const style = document.createElement('style')
  style.dataset.t2Reveal = ''
  style.textContent = Array.from({ length: LEVELS }, (_, k) => {
    const pct = Math.round(12 + (88 * k) / (LEVELS - 1))
    return `.t2-content::highlight(${NAME}${k}), .t2-content ::highlight(${NAME}${k}) { color: color-mix(in srgb, var(--text) ${pct}%, transparent); }`
  }).join('\n')
  document.head.appendChild(style)
  highlights = Array.from({ length: LEVELS }, (_, k) => {
    const h = new Highlight()
    CSS.highlights.set(`${NAME}${k}`, h)
    return h
  })
  return highlights
}

function paint(now: number): void {
  raf = 0
  const hs = ensureHighlights()
  hs.forEach((h) => h.clear())
  for (const root of roots) {
    root.runs = root.runs.filter((r) => now < r.at + MAX_STAGGER + DURATION)
    if (!root.runs.length) { if (!root.live) roots.delete(root); continue }
    const nodes = textNodes(root.el)
    // 新字一律在尾巴上:从后往前数够 220 个就停,更早的那些直接算落定
    let budget = MAX_CHARS
    const marks: Array<{ i: number; level: number }> = []
    for (let r = root.runs.length - 1; r >= 0 && budget > 0; r--) {
      const run = root.runs[r]
      for (let i = run.end - 1; i >= run.start && budget > 0; i--, budget--) {
        const p = (now - run.at - Math.min((i - run.start) * STAGGER, MAX_STAGGER)) / DURATION
        if (p >= 1) continue
        const x = Math.max(0, p)
        marks.push({ i, level: Math.min(LEVELS - 1, Math.floor(x * x * (3 - 2 * x) * LEVELS)) })
      }
    }
    marks.reverse()
    // 字的偏移 → (文本节点, 节点内偏移);marks 升序,节点指针只往前走
    let ni = 0
    let base = 0
    const locate = (i: number): [Text, number] | null => {
      while (ni < nodes.length && base + nodes[ni].length <= i) { base += nodes[ni].length; ni++ }
      return ni < nodes.length ? [nodes[ni], i - base] : null
    }
    for (let k = 0; k < marks.length;) {
      let j = k
      while (j + 1 < marks.length && marks[j + 1].level === marks[k].level && marks[j + 1].i === marks[j].i + 1) j++
      const a = locate(marks[k].i)
      const b = locate(marks[j].i)
      if (a && b) {
        const range = document.createRange()
        range.setStart(a[0], a[1])
        range.setEnd(b[0], b[1] + 1)
        hs[marks[k].level].add(range)
      }
      k = j + 1
    }
  }
  if (roots.size) raf = requestAnimationFrame(paint)
}

const kick = (): void => { if (!raf) raf = requestAnimationFrame(paint) }

/** 挂在一条助手消息上:streaming 期间每次渲染后认一下新到的字。挂上时已有的字不淡入(新建 / 恢复不入场)。 */
export function useStreamReveal(ref: RefObject<HTMLElement | null>, streaming: boolean): void {
  const root = useRef<Root | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!streaming || !el || !supported() || reducedMotion()) return
    const r: Root = { el, seen: textLength(el), runs: [], live: true }
    root.current = r
    roots.add(r)
    return () => { r.live = false; root.current = null; if (!r.runs.length) roots.delete(r) }
  }, [ref, streaming])
  useLayoutEffect(() => {
    const r = root.current
    if (!r) return
    const len = textLength(r.el)
    if (len > r.seen) { r.runs.push({ start: r.seen, end: len, at: performance.now() }); kick() }
    else if (len < r.seen) r.runs = r.runs.filter((run) => run.start < len).map((run) => ({ ...run, end: Math.min(run.end, len) }))
    r.seen = len
  })
}
