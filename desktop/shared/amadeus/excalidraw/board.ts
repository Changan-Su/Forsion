/** 白板的「纸张 + 网格」设置,存 frontmatter。
 *
 *  为什么不放进场景的 appState:serializeAsJSON 按白名单裁剪 appState,自定义键一个都留不下。
 *  而 frontmatter 是 format.ts 逐字节保留的区域(只换 `## Drawing` 段),往里加几个 YAML 键
 *  在 Obsidian 那边完全无害 —— 场景 JSON 一个字节不动,两边互开的契约不破。
 *
 *  纯字符串进出,不引 @excalidraw/excalidraw,与 format.ts 同级(主进程/单测都能用)。 */

export type PaperId = 'A4' | 'A5' | 'B4' | 'B5'

/** ISO 216 尺寸(mm)。B 系列取 ISO(176×250)而非 JIS(182×257):国标 GB/T 148 等同采用 ISO 216。 */
const PAPER_MM: Record<PaperId, readonly [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  B4: [250, 353],
  B5: [176, 250],
}
export const PAPER_IDS = Object.keys(PAPER_MM) as PaperId[]

/** 多页的排布方向:'v' = 上下(缺省),'h' = 左右。 */
export type PaperFlow = 'v' | 'h'

/** 网格方向:方格(缺省)/ 只画横线 / 只画竖线。 */
export type GridDir = 'both' | 'h' | 'v'

export interface BoardSettings {
  /** 横线间距(场景 px);**0 = 不画横线** —— 开关与间距合一,UI 侧自己记住关掉前的值。 */
  gridH: number
  /** 竖线间距;0 = 不画竖线。 */
  gridV: number
  /** null = 无限画布(既有白板的缺省,不写任何键)。 */
  paper: PaperId | null
  landscape: boolean
  flow: PaperFlow
  /** 网格线不透明度,10–100(百分比)。缺省 100 = 线色本身的浓度。 */
  gridOpacity: number
  /** 引擎网格的方向(无限画布用;纸张覆盖层的方向由 gridH / gridV 谁为 0 表达)。缺省方格,不写键。 */
  gridDir: GridDir
  /** 第 0 页**之前**手动加了几页(≤0,记的是最小页号)。缺省 0 = 前面没有额外的页。 */
  pageFirst: number
  /** 第 0 页**之后**手动加了几页(≥0,记的是最大页号)。 */
  pageLast: number
}

export const DEFAULT_BOARD: BoardSettings = {
  gridH: 0,
  gridV: 0,
  paper: null,
  landscape: false,
  flow: 'v',
  gridOpacity: 100,
  gridDir: 'both',
  pageFirst: 0,
  pageLast: 0,
}
/** 页与页之间的空隙(场景 px)。 */
export const PAGE_GAP = 48
/** 打开网格时的缺省间距(≈5mm,方格纸手感)。 */
export const DEFAULT_STEP = 20
const MIN_STEP = 4
const MAX_STEP = 400

/** 纸张的场景像素尺寸(96dpi:mm / 25.4 * 96);无限画布 → null。 */
export function paperSize(s: BoardSettings): { w: number; h: number } | null {
  const mm = s.paper ? PAPER_MM[s.paper] : null
  if (!mm) return null
  const w = Math.round((mm[0] / 25.4) * 96)
  const h = Math.round((mm[1] / 25.4) * 96)
  return s.landscape ? { w: h, h: w } : { w, h }
}

// ── 多页 ────────────────────────────────────────────────────────────────────
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 元素包围盒;没有元素 → null。旋转不计(多算一页无害,少算才有害)。 */
export function elementBounds(els: readonly { x: number; y: number; width?: number; height?: number; isDeleted?: boolean }[]): Bounds | null {
  let b: Bounds | null = null
  for (const e of els) {
    if (e.isDeleted) continue
    const x2 = e.x + (e.width ?? 0)
    const y2 = e.y + (e.height ?? 0)
    b = b
      ? { minX: Math.min(b.minX, e.x, x2), minY: Math.min(b.minY, e.y, y2), maxX: Math.max(b.maxX, e.x, x2), maxY: Math.max(b.maxY, e.y, y2) }
      : { minX: Math.min(e.x, x2), minY: Math.min(e.y, y2), maxX: Math.max(e.x, x2), maxY: Math.max(e.y, y2) }
  }
  return b
}

/** 排布轴上的页间距(纸长 + 空隙)。 */
function stride(s: BoardSettings, p: { w: number; h: number }): number {
  return s.flow === 'h' ? p.w + PAGE_GAP : p.h + PAGE_GAP
}

/** 第 index 页的场景矩形。**index 可为负** —— 页往两头长,第 0 页锚在场景原点。 */
export function pageRect(s: BoardSettings, index: number): { x: number; y: number; w: number; h: number } | null {
  const p = paperSize(s)
  if (!p) return null
  const off = index * stride(s, p)
  return s.flow === 'h' ? { x: off, y: 0, w: p.w, h: p.h } : { x: 0, y: off, w: p.w, h: p.h }
}

/** 场景坐标落在第几页(按排布轴取整;缝隙里的点算给前一页)。 */
export function pageIndexAt(s: BoardSettings, x: number, y: number): number {
  const p = paperSize(s)
  if (!p) return 0
  return Math.floor((s.flow === 'h' ? x : y) / stride(s, p))
}

/** 要渲染 / 要纳入边界的页区间:**页数由用户手动加**(面板上的前/后加一页),不自动长。
 *  但**内容永远兜底** —— 已经画在某页上的东西不能因为页数被调小就掉到页外够不着(也就丢不了)。
 *  没有显式页数键的老白板 = 恰好裹住现有内容,一页不多不少。永远含第 0 页(场景原点那张)。 */
export function pageRange(s: BoardSettings, bounds: Bounds | null): { min: number; max: number } {
  if (!paperSize(s)) return { min: 0, max: 0 }
  const a = bounds ? pageIndexAt(s, bounds.minX, bounds.minY) : 0
  const b = bounds ? pageIndexAt(s, bounds.maxX, bounds.maxY) : 0
  return { min: Math.min(s.pageFirst, a, b, 0), max: Math.max(s.pageLast, a, b, 0) }
}

/** 整条页带的外接矩形(含首尾那两张空白页)。 */
export function stripRect(s: BoardSettings, bounds: Bounds | null): { x: number; y: number; w: number; h: number } | null {
  const r = pageRange(s, bounds)
  const first = pageRect(s, r.min)
  const last = pageRect(s, r.max)
  if (!first || !last) return null
  return { x: first.x, y: first.y, w: last.x + last.w - first.x, h: last.y + last.h - first.y }
}

/** 换排布方向时,把一个点跟着它所在的那一页一起搬:**页内偏移不变**,只换页原点。 */
export function reflowPoint(s: BoardSettings, from: PaperFlow, to: PaperFlow, x: number, y: number): { x: number; y: number } {
  if (from === to || !paperSize(s)) return { x, y }
  const src = pageRect({ ...s, flow: from }, pageIndexAt({ ...s, flow: from }, x, y))
  const dst = pageRect({ ...s, flow: to }, pageIndexAt({ ...s, flow: from }, x, y))
  if (!src || !dst) return { x, y }
  return { x: dst.x + (x - src.x), y: dst.y + (y - src.y) }
}

/** 纸张之外留出的余量(占**单页**边长的比例;整条页带外面留的就是这么一圈)。 */
export const MARGIN = 0.06

export interface Viewport {
  /** excalidraw appState 同名字段:viewportX = (sceneX + scrollX) * zoom。 */
  scrollX: number
  scrollY: number
  zoom: number
  /** 画布的 CSS 像素尺寸。 */
  width: number
  height: number
}

/** 纸张硬边界:把视口钳回「整条页带 + MARGIN」之内(0.18.1 没有 scrollConstraints,只能事后纠偏)。
 *  无限画布 / 已在范围内 → null,调用方据此跳过 updateScene,不然就是自激循环。
 *  ponytail: 只钳滚动不钳缩放 —— 缩放下限会把「一眼看完整篇」这个正当需求也堵死,而「越界不可画」
 *  本来就由遮罩的命中测试保证,不靠缩放。 */
export function clampViewport(s: BoardSettings, v: Viewport, bounds: Bounds | null = null): { scrollX: number; scrollY: number; zoom: number } | null {
  const paper = paperSize(s)
  const strip = stripRect(s, bounds)
  if (!paper || !strip || !v.width || !v.height) return null
  const mx = paper.w * MARGIN
  const my = paper.h * MARGIN
  const zoom = v.zoom
  const sw = v.width / zoom // 视口在场景坐标下的宽高
  const sh = v.height / zoom
  // 视口比页带+余量还宽 → 居中(文档视图的常态);否则钳住,让可视区不越出边界
  const scrollX = sw >= strip.w + 2 * mx ? (sw - strip.w) / 2 - strip.x : clampNum(v.scrollX, sw - strip.x - strip.w - mx, mx - strip.x)
  const scrollY = sh >= strip.h + 2 * my ? (sh - strip.h) / 2 - strip.y : clampNum(v.scrollY, sh - strip.y - strip.h - my, my - strip.y)
  const settled = Math.abs(scrollX - v.scrollX) < 0.5 && Math.abs(scrollY - v.scrollY) < 0.5
  return settled ? null : { scrollX, scrollY, zoom }
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

// ── 网格:两条路 ─────────────────────────────────────────────────────────────
// 无限画布 → **引擎网格**(appState.gridModeEnabled / gridSize / gridStep,写进场景 JSON,Obsidian 那边同样认;
//   有粗线、画的时候吸附)。方向 / 淡浓引擎不落盘 → 存 frontmatter 的 gridDir / gridOpacity,挂载时下发。
// 纸张模式 → **覆盖层**(gridH / gridV,画在每页里、对齐纸边;引擎网格从场景原点铺满全屏,对不齐每页的上边)。
//   纸张模式下引擎网格必须一直是关的 —— 两层同时开就是叠成两层的那个 bug。
// 老白板:无限画布上存着 gridH / gridV 的,在用户第一次碰网格时才转成引擎网格(打开文件时不写盘)。

/** 引擎把 gridSize / gridStep 归一到 1–100;再密就是一片糊(覆盖层同一下限)。 */
export const GRID_MIN = MIN_STEP
export const GRID_MAX = 100
/** 每几格一条粗线(引擎缺省)。 */
export const DEFAULT_MAJOR = 5

export const clampGrid = (n: number): number => Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(n) || DEFAULT_STEP))

/** 网格面板看到的统一模型(两条路都折算成这一份)。 */
export interface GridModel {
  on: boolean
  size: number
  dir: GridDir
}

/** 覆盖层(gridH / gridV)→ 模型。横竖都开但间距不同时,间距取横线的。 */
export function overlayModel(s: Pick<BoardSettings, 'gridH' | 'gridV'>): GridModel {
  const { gridH: h, gridV: v } = s
  if (h <= 0 && v <= 0) return { on: false, size: DEFAULT_STEP, dir: 'both' }
  return { on: true, size: h > 0 ? h : v, dir: h > 0 && v > 0 ? 'both' : h > 0 ? 'h' : 'v' }
}

/** 模型 → 覆盖层的两个键。关 = 两个都写 0(开关与间距合一,见 BoardSettings)。 */
export function overlayFields(m: GridModel): { gridH: number; gridV: number } {
  if (!m.on) return { gridH: 0, gridV: 0 }
  return { gridH: m.dir === 'v' ? 0 : m.size, gridV: m.dir === 'h' ? 0 : m.size }
}

/** 无限画布上的老网格能不能转成引擎网格:没有 → undefined;横竖都开且间距不同 → null(引擎只有正方格,
 *  留在覆盖层,等用户自己改);其余 → 引擎网格的参数。 */
export function legacyToEngine(s: Pick<BoardSettings, 'gridH' | 'gridV'>): { size: number; dir: GridDir } | null | undefined {
  const { gridH: h, gridV: v } = s
  if (h <= 0 && v <= 0) return undefined
  if (h > 0 && v > 0 && h !== v) return null
  const m = overlayModel(s)
  return { size: clampGrid(m.size), dir: m.dir }
}

/** gridDir → 引擎的 gridDirection(horizontal = 画横线)。 */
export const engineDirection = (dir: GridDir): { horizontal: boolean; vertical: boolean } => ({ horizontal: dir !== 'v', vertical: dir !== 'h' })

/** 淡浓 → 引擎的 gridColor。100% = 引擎原样的两档灰;深色下引擎自己会反相,这里只给浅色值。 */
export function engineGridColor(opacity: number): { Bold: string; Regular: string } {
  const a = Math.round(Math.min(100, Math.max(10, opacity))) / 100
  return { Bold: `rgba(204, 204, 204, ${a})`, Regular: `rgba(229, 229, 229, ${a})` }
}

// ── frontmatter ──────────────────────────────────────────────────────────────
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/
const KEY_H = 'forsion-grid-h'
const KEY_V = 'forsion-grid-v'
const KEY_PAPER = 'forsion-paper'
const KEY_LAND = 'forsion-paper-landscape'
const KEY_FLOW = 'forsion-paper-flow'
const KEY_OPACITY = 'forsion-grid-opacity'
const KEY_FIRST = 'forsion-page-first'
const KEY_LAST = 'forsion-page-last'
const KEY_DIR = 'forsion-grid-dir'
/** 手动加页的上限,防手滑按住不放把页带撑到天边。 */
const MAX_PAGES = 200

const lineRe = (k: string): RegExp => new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')

const step = (fm: string, k: string): number => {
  const n = Number(lineRe(k).exec(fm)?.[1]?.trim())
  return Number.isFinite(n) && n >= MIN_STEP ? Math.min(Math.round(n), MAX_STEP) : 0
}

/** 读不出 / 没有 frontmatter → 全缺省(无限画布、无网格),即既有白板的现状。 */
export function readBoard(source: string): BoardSettings {
  const fm = FM_RE.exec(source)?.[1]
  if (!fm) return DEFAULT_BOARD
  const p = lineRe(KEY_PAPER).exec(fm)?.[1]?.trim().toUpperCase()
  return {
    gridH: step(fm, KEY_H),
    gridV: step(fm, KEY_V),
    paper: p && Object.hasOwn(PAPER_MM, p) ? (p as PaperId) : null,
    landscape: /^(true|yes|1)$/i.test(lineRe(KEY_LAND).exec(fm)?.[1]?.trim() ?? ''),
    flow: /^h(orizontal)?$/i.test(lineRe(KEY_FLOW).exec(fm)?.[1]?.trim() ?? '') ? 'h' : 'v',
    gridOpacity: opacityOf(fm),
    gridDir: dirOf(fm),
    pageFirst: pageKey(fm, KEY_FIRST, -MAX_PAGES, 0),
    pageLast: pageKey(fm, KEY_LAST, 0, MAX_PAGES),
  }
}

function pageKey(fm: string, key: string, lo: number, hi: number): number {
  const n = Number(lineRe(key).exec(fm)?.[1]?.trim())
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : 0
}

function dirOf(fm: string): GridDir {
  const v = lineRe(KEY_DIR).exec(fm)?.[1]?.trim().toLowerCase()
  return v === 'h' || v === 'v' ? v : 'both'
}

function opacityOf(fm: string): number {
  const n = Number(lineRe(KEY_OPACITY).exec(fm)?.[1]?.trim())
  return Number.isFinite(n) ? Math.min(100, Math.max(10, Math.round(n))) : 100
}

/** 写回 frontmatter:缺省值删键(别在文件里留一堆 `: 0`),其余字节原样。
 *  没有 frontmatter 的源原样返回 —— 那不是画板,不该被我们加料。 */
export function writeBoard(source: string, s: BoardSettings): string {
  const m = FM_RE.exec(source)
  if (!m) return source
  let fm = m[1]
  fm = upsert(fm, KEY_H, s.gridH >= MIN_STEP ? String(Math.round(s.gridH)) : null)
  fm = upsert(fm, KEY_V, s.gridV >= MIN_STEP ? String(Math.round(s.gridV)) : null)
  fm = upsert(fm, KEY_PAPER, s.paper)
  fm = upsert(fm, KEY_LAND, s.paper && s.landscape ? 'true' : null)
  fm = upsert(fm, KEY_FLOW, s.paper && s.flow === 'h' ? 'h' : null)
  fm = upsert(fm, KEY_OPACITY, s.gridOpacity >= 100 ? null : String(Math.min(100, Math.max(10, Math.round(s.gridOpacity)))))
  fm = upsert(fm, KEY_DIR, s.gridDir === 'h' || s.gridDir === 'v' ? s.gridDir : null)
  fm = upsert(fm, KEY_FIRST, s.paper && s.pageFirst < 0 ? String(Math.max(-MAX_PAGES, Math.round(s.pageFirst))) : null)
  fm = upsert(fm, KEY_LAST, s.paper && s.pageLast > 0 ? String(Math.min(MAX_PAGES, Math.round(s.pageLast))) : null)
  const nl = m[0].includes('\r\n') ? '\r\n' : '\n'
  return `${source.slice(0, m.index)}---${nl}${fm}${nl}---${source.slice(m.index + m[0].length)}`
}

/** ⚠️ 匹配范围必须含**缩进续行**:YAML 的多行值(`key:\n  A4`)只删标题行会留下一条孤儿缩进行,
 *  整个 frontmatter 在 Obsidian 侧当场解析不了。宁可整块换掉,也不能留半截。 */
const keyBlockRe = (key: string): RegExp => new RegExp(`^${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*\\n?`, 'm')

function upsert(fm: string, key: string, val: string | null): string {
  const re = keyBlockRe(key)
  if (val === null) return fm.replace(re, '')
  if (re.test(fm)) return fm.replace(re, (hit) => `${key}: ${val}${hit.endsWith('\n') ? '\n' : ''}`)
  // 追加到正文末尾,但保留原有的尾部空行 —— 插件模板里 `---` 前那个空行是它的字节形态,别动。
  const trail = /\s*$/.exec(fm)?.[0] ?? ''
  return `${fm.slice(0, fm.length - trail.length)}\n${key}: ${val}${trail}`
}
