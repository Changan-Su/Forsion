// Dashboard 结构化布局(`dashboard3:`,2026-08-27 拍板:「结构化优先 + 响应式重排」)。
//
// 与 `dashboard:`(24 列固定格)、`dashboard2:`(自由 px)同一份 `.dashboard.md`、同一套块与
// widget 围栏,**只换几何语义**:
//
//     dashboard3:
//       "1": [0, 6, 3]     # [order, w, h] —— 顺序 / 列跨度(12 列参考系) / 行跨度
//       "2": [1, 3, 2]
//
// 三条与前两版的根本差别,正是「简单拼出统一美观」的全部来源:
//  ① **缺省没有坐标**。卡片按 order 顺序流进 CSS Grid,位置由排版算出来,用户只决定「放什么、多大」。
//     → 永远不会歪、不会叠;新卡自动接在末尾,不需要「找空位」。
//     2026-09-01 起开了一道口子:**手摆过的行**在 `dashboard3x:` 里另记 [row, col](见 Dash3Pin),
//     那一行改由 packPinnedRows 确定性装填、横向留白照留 —— 「你摆过的行归你,没摆过的行归编排器」。
//  ② **跨度是相对的**。w 记的是「占 12 分之几」,实际列数由容器宽度在 {12,6,4,3,2,1} 里挑
//     (全是 12 的因数 → 半宽恒是半宽、三分之一恒是三分之一,比例在任何窗宽下都不变形)。
//     → 成品页是**会重排的页面**,不是按 x/y 各自百分比拉伸的海报(旧版第一张截图那个洞)。
//  ③ **行高固定 px**。窗口变宽只增列数、不放大文字 —— 与 Apple widget 同一条纪律。
//
// order 存在布局键里而不是靠文档块序:重排就只改这一个外来键,**一个字节都不碰块树**
// (moveBlock 要认 row/column 结构,那是毁档面;这里没有理由去碰它)。
// 落盘防线与前两版同源:根必须是映射、元组恰好三项且必须是真数字、读不懂即冻结。

import { Document, parseDocument } from 'yaml'
import type { DashRead } from './dashboard'

export const DASH3_FM_KEY = 'dashboard3'
/** 布局模式的外来键。缺省 = 结构化网格;`canvas` = 退回自由摆位(高级)。 */
export const DASH3_MODE_KEY = 'dashLayout'
export type DashMode = 'grid' | 'canvas'

/** 参考列数。实际列数总是它的因数,故任何跨度的**比例**在所有窗宽下恒定。 */
export const DASH3_COLS = 12
/** 实际列数的候选。必须全是 DASH3_COLS 的因数,且**全为偶数**(1 除外):
 *  半宽是最常见的跨度,只有偶数列才能让 6/12 折算成整数格。3 列会把半宽算成 1.5 → 2,
 *  半宽在那一档变成三分之二,比例就变形了 —— 这正是本版要消灭的东西,故刻意不给 3。 */
export const DASH3_COL_STEPS = [12, 6, 4, 2, 1] as const
/** 一列的最小可用宽度;低于它就降到下一档列数。
 *  2026-08-31 76→56(用户报「调节等级太少」):列是**对齐单位**不是内容单位(最小卡=3~4 列
 *  ≈ 200px+),76 让常见面板宽(主区 ~900-1040px,旁边有 ribbon/侧栏)掉到 6 列 —— 宽度档位
 *  瞬间减半,这才是「等级少」的真身。56 把 12 列的覆盖下限从 1044px 降到 804px。 */
export const DASH3_MIN_COL_PX = 56
/** 行高与间距(px)。CSS 变量 --dash3-row / --dash3-gap 必须与这两个数一致。 */
export const DASH3_ROW_PX = 72
export const DASH3_GAP_PX = 12
/** 单卡行跨度上界:手写 md 里一个 1e308 会把 grid-row 写成非法值。 */
export const DASH3_MAX_ROWS = 24
export const DASH3_MAX_ORDER = 100_000

/** 一张卡在结构化网格里的全部几何:排在第几、占几列、占几行。 */
export interface Cell {
  order: number
  w: number
  h: number
}
export type Dash3Layout = Record<string, Cell>

/** 具名尺寸档。2026-08-31 起不再是 resize 的硬白名单(把手可停任意整数格,下界见
 *  dash3MinCell),只留两个职责:①卡片菜单的快捷入口;②摘要面的 density bucket
 *  (ctx.size 传给 dashboard.factory 的仍是最近具名档,见 dash3BucketOf)。 */
export const DASH3_SIZES = [
  { key: 'sm', label: '小', w: 3, h: 2 },
  { key: 'md', label: '中', w: 4, h: 3 },
  { key: 'wide', label: '宽', w: 6, h: 3 },
  { key: 'tall', label: '高', w: 3, h: 5 },
  { key: 'lg', label: '大', w: 6, h: 5 },
  { key: 'full', label: '整行', w: 12, h: 4 },
  { key: 'workspace', label: '工作区', w: 12, h: 8 },
] as const
export type Dash3SizeKey = (typeof DASH3_SIZES)[number]['key']

export const dash3Size = (key: Dash3SizeKey) => DASH3_SIZES.find((size) => size.key === key) ?? DASH3_SIZES[1]

/** 任意几何 → 最近的具名档(摘要面的 density bucket)。距离相同时优先面积更小的档,
 *  避免把小卡按进更大的信息密度。 */
export function dash3BucketOf(cell: Pick<Cell, 'w' | 'h'>, allowed: readonly Dash3SizeKey[]): Dash3SizeKey | null {
  const choices = DASH3_SIZES.filter((size) => allowed.includes(size.key))
  if (!choices.length) return null
  const exact = choices.find((size) => size.w === cell.w && size.h === cell.h)
  const best = exact ?? [...choices].sort((a, b) => {
    const da = Math.abs(a.w - cell.w) + Math.abs(a.h - cell.h) * 1.25
    const db = Math.abs(b.w - cell.w) + Math.abs(b.h - cell.h) * 1.25
    return da - db || a.w * a.h - b.w * b.h
  })[0]
  return best.key
}

/** 把任意/旧布局吸到最近具名档的**几何**。resize 已不走这条(自由格,2026-08-31 拍板
 *  「只放开档位,保留 DP 编排」);留给需要具名几何的场合(默认值/测试)。 */
export function fitDash3Cell(cell: Cell, allowed: readonly Dash3SizeKey[]): Cell {
  const key = dash3BucketOf(cell, allowed)
  if (!key) return cell
  const size = dash3Size(key)
  return { ...cell, w: size.w, h: size.h }
}

/** resize 的每轴下界 = 声明档位里各轴的最小值:比最小档更窄/更矮的形状,这张卡的内容面
 *  没有承诺能装下。上界恒为 12×DASH3_MAX_ROWS(自由格)。 */
export function dash3MinCell(allowed: readonly Dash3SizeKey[]): { w: number; h: number } {
  const choices = DASH3_SIZES.filter((size) => allowed.includes(size.key))
  if (!choices.length) return { w: 1, h: 1 }
  return { w: Math.min(...choices.map((s) => s.w)), h: Math.min(...choices.map((s) => s.h)) }
}

/** 手工行位(2026-08-31 用户拍板「横向允许留白 + 行内自由摆放 + 空白可插入 + 排斥」)。
 *  `row` 只需在**连续 pinned 段内**可比(同值 = 同一行,落笔时取全局 max+1 保证不与邻行撞);
 *  `col` = 12 列参考系的起始列(0-based),与 w 共用比例守恒的映射。
 *  ⚠️ 另开一个键而不是给 [order,w,h] 加第 4 项:三元组恰好三项是旧读端的冻结判据
 *  (readDash3Layout 的 `v.length !== 3`),加一项 = 存量应用整份布局冻结;未知键旧端一律忽略。 */
export const DASH3_PIN_KEY = 'dashboard3x'
export interface Dash3Pin { row: number; col: number }
export type Dash3Pins = Record<string, Dash3Pin>

/** 12 列参考列 → 当前列数下的起始列。**必须与 span 一起夹右边界**:x 与 w 各自取整会溢出
 *  (x=7,w=5,cols=6 → 3+3 > 6),那就是一条横向滚动条(G2 押着「永不横向滚动」)。 */
export function colFor(x: number, span: number, cols: number): number {
  const ref = clampInt(x, 0, DASH3_COLS - 1, 0)
  const n = Math.max(1, Math.min(DASH3_COLS, Math.round(cols)))
  return Math.max(0, Math.min(n - span, Math.round((ref * n) / DASH3_COLS)))
}

export interface Dash3PackItem { id: string; span: number; h: number; chrome?: boolean; start?: number }
export interface Dash3PackedRow { h: number; items: Dash3PackItem[] }

/** 受控分行：同一行只接纳同高度族的卡片；高度变化、容量不足或 section 都会收口。
 *  因此卡片不再被同行最高项强行拉高，也不会在高卡下方留下 CSS Grid 的内部洞。 */
export function packDash3Rows(items: Dash3PackItem[], cols: number): Dash3PackedRow[] {
  const rows: Dash3PackedRow[] = []
  let row: Dash3PackedRow | null = null
  let used = 0
  const flush = (): void => {
    if (row?.items.length) rows.push(row)
    row = null
    used = 0
  }
  for (const item of items) {
    const span = Math.max(1, Math.min(cols, Math.round(item.span)))
    const next = { ...item, span }
    if (item.chrome) {
      flush()
      rows.push({ h: 1, items: [{ ...next, span: cols, h: 1 }] })
      continue
    }
    if (row && (row.h !== item.h || used + span > cols)) flush()
    if (!row) row = { h: item.h, items: [] }
    row.items.push(next)
    used += span
    if (used >= cols) flush()
  }
  flush()
  return rows
}

export interface Dash3ComposeChoice { key: Dash3SizeKey; w: number; h: number }
export interface Dash3ComposeItem {
  id: string
  preferred: Cell
  choices: readonly Dash3ComposeChoice[]
  chrome?: boolean
}
export interface Dash3ComposedItem extends Dash3PackItem { cell: Cell; size: Dash3SizeKey }
export interface Dash3ComposedRow { h: number; items: Dash3ComposedItem[] }

/**
 * 自动编排器：对相邻 1..4 张卡做小规模动态规划，同时选行边界和离散尺寸。
 *
 * 目标按顺序是：少留横向空洞、少开新行、尽量靠近用户存下的偏好尺寸。只有各卡声明过的
 * choice 才会进入枚举，所以“自动拼满”不会把完整页面压进不支持的小卡，也不会产生无级尺寸。
 * section 是硬边界，视觉顺序始终等于 order。
 */
export function composeDash3Rows(items: Dash3ComposeItem[], cols: number): Dash3ComposedRow[] {
  const out: Dash3ComposedRow[] = []
  let segment: Dash3ComposeItem[] = []
  const flushSegment = (): void => {
    if (!segment.length) return
    const memo = new Map<number, { cost: number; rows: Dash3ComposedRow[] }>()
    const solve = (at: number): { cost: number; rows: Dash3ComposedRow[] } => {
      if (at >= segment.length) return { cost: 0, rows: [] }
      const cached = memo.get(at)
      if (cached) return cached
      let best: { cost: number; rows: Dash3ComposedRow[] } | null = null
      const maxEnd = Math.min(segment.length, at + 4)
      for (let end = at + 1; end <= maxEnd; end++) {
        const group = segment.slice(at, end)
        const heights = [...new Set(group.flatMap((item) => item.choices.map((choice) => choice.h)))]
          .filter((h) => group.every((item) => item.choices.some((choice) => choice.h === h)))
        for (const h of heights) {
          const optionSets = group.map((item) => item.choices.filter((choice) => choice.h === h))
          const walk = (index: number, picked: Dash3ComposeChoice[]): void => {
            if (index < optionSets.length) {
              for (const choice of optionSets[index]) walk(index + 1, [...picked, choice])
              return
            }
            const spans = picked.map((choice) => spanFor(choice.w, cols))
            const used = spans.reduce((sum, span) => sum + span, 0)
            if (used > cols) return
            const tail = solve(end)
            const distance = picked.reduce((sum, choice, index2) => {
              const pref = group[index2].preferred
              return sum + Math.abs(choice.w - pref.w) + Math.abs(choice.h - pref.h) * 1.25
            }, 0)
            // 空列比轻微改档更伤观感；每开一行再加固定成本，促使可兼容的相邻卡片成组。
            const cost = (cols - used) * 2.25 + distance * 2 + 10 + tail.cost
            if (best && cost >= best.cost) return
            const rowItems: Dash3ComposedItem[] = group.map((item, index2) => ({
              id: item.id,
              span: spans[index2],
              h,
              cell: { ...item.preferred, w: picked[index2].w, h },
              size: picked[index2].key,
            }))
            // 不足一行时居中整组，比永远贴左更像一张有意的摘要带；DOM/order 不变。
            if (used < cols) rowItems[0].start = Math.floor((cols - used) / 2) + 1
            best = { cost, rows: [{ h, items: rowItems }, ...tail.rows] }
          }
          walk(0, [])
        }
      }
      // 声明错误也不能让整页消失：退回首个可用档，单张成行。
      if (!best) {
        const item = segment[at]
        const choice = item.choices[0] ?? { key: 'lg' as const, w: item.preferred.w, h: item.preferred.h }
        const tail = solve(at + 1)
        best = {
          cost: 1000 + tail.cost,
          rows: [{ h: choice.h, items: [{ id: item.id, span: spanFor(choice.w, cols), h: choice.h, cell: { ...item.preferred, w: choice.w, h: choice.h }, size: choice.key }] }, ...tail.rows],
        }
      }
      memo.set(at, best)
      return best
    }
    out.push(...solve(0).rows)
    segment = []
  }
  for (const item of items) {
    if (!item.chrome) { segment.push(item); continue }
    flushSegment()
    out.push({ h: 1, items: [{ id: item.id, span: cols, h: 1, chrome: true, cell: { ...item.preferred, w: DASH3_COLS, h: 1 }, size: 'full' }] })
  }
  flushSegment()
  return out
}

/**
 * 手工行的确定性装填。与 DP 段的分工:**你摆过的行归你,没摆过的行归编排器**(用户拍板)。
 *
 *  · 同 `row` 值 = 同一行(band)。band 高 = 行内最高卡,矮卡按自己的 h 渲染、下方留白 ——
 *    同高族约束**只对 DP 段成立**:手工行必须能把 3×2 的挂件放进 6×5 大卡右边的空白,
 *    那正是这轮的头号场景。
 *  · 行内不重叠:想要的列被前一张占了就右移;右移到放不下,整张挪到下一行(拍板:
 *    「把最右的邻居挤到下一行」)。坏值/降列/改尺寸后的冲突全走这一条,不 throw。
 */
function packPinnedRows(entries: Array<{ item: Dash3ComposeItem; pin: Dash3Pin }>, cols: number): Dash3ComposedRow[] {
  const rows: Dash3ComposedRow[] = []
  let row: Dash3ComposedRow | null = null
  let rowKey: number | null = null
  let cursor = 0
  for (const { item, pin } of entries) {
    // ⚠️ 几何取**选中档**不是 preferred:pin 蕴含尺寸铁 → choices 只有一项,而那一项已经夹过
    //    每轴下界(存量里 3×2 的旧文本卡该按 4×3 渲染)。直接用 preferred 就绕过了下界。
    const pick = item.choices[0]
    const cell: Cell = pick ? { ...item.preferred, w: pick.w, h: pick.h } : item.preferred
    const span = spanFor(cell.w, cols)
    const want = colFor(pin.col, span, cols)
    const keep = row !== null && pin.row === rowKey && Math.max(want, cursor) + span <= cols
    const start = keep ? Math.max(want, cursor) : want
    if (!keep) {
      if (row) rows.push(row)
      row = { h: 0, items: [] }
      rowKey = pin.row
    }
    const cur = row as Dash3ComposedRow
    cur.items.push({ id: item.id, span, h: cell.h, cell, size: item.choices[0]?.key ?? 'md', start: start + 1 })
    cur.h = Math.max(cur.h, cell.h)
    cursor = start + span
  }
  if (row) rows.push(row)
  return rows
}

/** 排版总入口:有 pin 的连续段走手工装填,其余段照旧交给 DP(自动拼行/换档/居中一并保留)。
 *  两种段互为硬边界 —— 你摆的那一行不会被别的卡自动挤进来,这就是「松手即定」。 */
export function layoutDash3Rows(items: Dash3ComposeItem[], pins: Dash3Pins, cols: number): Dash3ComposedRow[] {
  const out: Dash3ComposedRow[] = []
  let auto: Dash3ComposeItem[] = []
  let manual: Array<{ item: Dash3ComposeItem; pin: Dash3Pin }> = []
  const flushAuto = (): void => { if (auto.length) { out.push(...composeDash3Rows(auto, cols)); auto = [] } }
  const flushManual = (): void => { if (manual.length) { out.push(...packPinnedRows(manual, cols)); manual = [] } }
  for (const item of items) {
    const pin = item.chrome ? undefined : pins[item.id]
    if (pin) { flushAuto(); manual.push({ item, pin }) } // 分区标题恒整行,不接受 pin
    else { flushManual(); auto.push(item) }
  }
  flushManual()
  flushAuto()
  return out
}

export interface Dash3Slot { id: string; col: number; w: number }

/** 一行之内的让位(「排斥」的全部数学)。按**想要的列**从左往右装:后来的被前面的推开,
 *  行尾放不下的**退出这一行**(调用方把它退回自动流 = 视觉上落到下一行)。
 *  ⚠️ 平手(想要同一列)时靠输入次序定胜负 —— 调用方把正在拖的那张放数组首位,
 *  「我挤进来、你让开」才成立。12 列参考系,纯几何。 */
export function fitRow(slots: Dash3Slot[], cols = DASH3_COLS): { row: Dash3Slot[]; spilled: string[] } {
  const row: Dash3Slot[] = []
  const spilled: string[] = []
  let cursor = 0
  for (const s of [...slots].sort((a, b) => a.col - b.col)) {
    const w = Math.max(1, Math.min(cols, Math.round(s.w)))
    const col = Math.max(cursor, Math.max(0, Math.min(cols - w, Math.round(s.col))))
    if (col + w > cols) { spilled.push(s.id); continue }
    row.push({ id: s.id, col, w })
    cursor = col + w
  }
  return { row, spilled }
}

/** 把一张卡摆进某一行:让位 → 新的顺序 + 新的 pin。视觉序恒等于 order,所以行内让位会连带
 *  改 order;被挤出行尾的卡**丢掉 pin** = 回自动流(不 pin 就不冻结,拍板「未动仍自动」)。 */
export function dropIntoRow(
  ids: string[], pins: Dash3Pins, slots: Dash3Slot[], rowKey: number,
): { ids: string[]; pins: Dash3Pins } {
  const { row, spilled } = fitRow(slots)
  const members = [...row.map((s) => s.id), ...spilled]
  const inRow = new Set(members)
  const out: string[] = []
  let dropped = false
  for (const id of ids) {
    if (!inRow.has(id)) { out.push(id); continue }
    if (!dropped) { out.push(...members); dropped = true } // 整块落在最靠前那位成员的原位
  }
  if (!dropped) out.push(...members)
  const nextPins: Dash3Pins = { ...pins }
  for (const id of spilled) delete nextPins[id]
  for (const s of row) nextPins[s.id] = { row: rowKey, col: s.col }
  return { ids: out, pins: nextPins }
}

/** 下一个可用的行号:与任何现存行都不相等即可(同值才算同行,单调性不是契约)。 */
export function nextPinRow(pins: Dash3Pins): number {
  return Object.values(pins).reduce((m, p) => Math.max(m, p.row + 1), 0) % (DASH3_MAX_ORDER + 1)
}

/** 新卡默认尺寸(按内容类型分档:小挂件方一点,视图卡要能看见内容)。 */
export const DASH3_DEFAULT: Cell = { order: 0, w: 4, h: 3 }
export const DASH3_DEFAULT_MINI: Cell = { order: 0, w: 3, h: 2 }
export const DASH3_DEFAULT_VIEW: Cell = { order: 0, w: 6, h: 5 }
export const DASH3_DEFAULT_TEXT: Cell = { order: 0, w: 6, h: 3 }

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback

export function clampCell(c: Cell): Cell {
  return {
    order: clampInt(c.order, 0, DASH3_MAX_ORDER, 0),
    w: clampInt(c.w, 1, DASH3_COLS, DASH3_DEFAULT.w),
    h: clampInt(c.h, 1, DASH3_MAX_ROWS, DASH3_DEFAULT.h),
  }
}

/** 容器宽度 → 实际列数。取 12 的因数里**放得下**的最大那档。 */
export function colsForWidth(px: number, gap = DASH3_GAP_PX, minCol = DASH3_MIN_COL_PX): number {
  if (!Number.isFinite(px) || px <= 0) return 1
  for (const n of DASH3_COL_STEPS) {
    if (px >= n * minCol + (n - 1) * gap) return n
  }
  return 1
}

/** 12 列参考跨度 → 当前列数下的实际跨度。比例守恒(因数关系),至少 1 格、至多铺满。 */
export function spanFor(w: number, cols: number): number {
  const ref = clampInt(w, 1, DASH3_COLS, DASH3_DEFAULT.w)
  const n = Math.max(1, Math.min(DASH3_COLS, Math.round(cols)))
  return Math.max(1, Math.min(n, Math.round((ref * n) / DASH3_COLS)))
}

/** 按 order 排好的块 id(order 相同时按 id 数值序兜底,保证渲染顺序**确定**)。 */
export function orderedIds(layout: Dash3Layout, ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const oa = layout[a]?.order ?? Number.MAX_SAFE_INTEGER
    const ob = layout[b]?.order ?? Number.MAX_SAFE_INTEGER
    if (oa !== ob) return oa - ob
    return (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)
  })
}

/** 把 ids 按给定顺序重新编号成 0..n-1(order 永远稠密,md 里读起来也是人话)。 */
export function renumber(layout: Dash3Layout, ids: string[]): Dash3Layout {
  const out: Dash3Layout = {}
  ids.forEach((id, i) => {
    const cur = layout[id]
    out[id] = clampCell({ order: i, w: cur?.w ?? DASH3_DEFAULT.w, h: cur?.h ?? DASH3_DEFAULT.h })
  })
  return out
}

/** 把 `id` 移到 `beforeId` 之前(beforeId=null → 移到末尾),返回重编号后的整份布局。 */
export function moveCard(layout: Dash3Layout, ids: string[], id: string, beforeId: string | null): Dash3Layout {
  const cur = orderedIds(layout, ids).filter((x) => x !== id)
  const at = beforeId === null ? cur.length : cur.indexOf(beforeId)
  cur.splice(at < 0 ? cur.length : at, 0, id)
  return renumber(layout, cur)
}

/** 自愈:清孤儿、补新块(接末尾)、稠密重编号。返回 null = 无需改动(别触发无谓落盘)。 */
export function reconcileGrid(layout: Dash3Layout, ids: string[], fallback: Cell = DASH3_DEFAULT): Dash3Layout | null {
  const present = new Set(ids)
  let changed = Object.keys(layout).some((id) => !present.has(id))
  const ordered = orderedIds(layout, ids)
  const next: Dash3Layout = {}
  ordered.forEach((id, i) => {
    const cur = layout[id]
    if (!cur) changed = true
    const want = clampCell({ order: i, w: cur?.w ?? fallback.w, h: cur?.h ?? fallback.h })
    if (cur && (cur.order !== want.order || cur.w !== want.w || cur.h !== want.h)) changed = true
    next[id] = want
  })
  return changed ? next : null
}

/** 布局键与实际块 id 完全不相交 → 这份布局不是给这些块写的,自愈会把它整份当孤儿清掉。
 *  与 dashboard/dashboard2 同一条纪律:认出来就停手,原样留在文件里交给用户决定。 */
export function grid3IsStale(layout: Dash3Layout, ids: string[]): boolean {
  if (!ids.length || !Object.keys(layout).length) return false
  return !ids.some((id) => layout[id])
}

export type Dash3Read = { ok: true; layout: Dash3Layout } | { ok: false; error: string }

/** 读结构化布局。三态与 readDash2Layout 逐条同构:
 *  键不存在 / 显式 null = 「还没排过版」(没有布局可丢,放行自愈);
 *  有内容但读不懂 = 冻结(合法 YAML 的坏值一旦被当成空,打开一次就永久覆盖用户布局)。 */
export function readDash3Layout(fmExtra: string): Dash3Read {
  if (!fmExtra.trim()) return { ok: true, layout: {} }
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message.split('\n')[0] }
  const obj = doc.toJS() as unknown
  if (obj === null || obj === undefined) return { ok: true, layout: {} }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'frontmatter 根节点不是映射' }
  const raw = (obj as Record<string, unknown>)[DASH3_FM_KEY]
  if (raw === undefined || raw === null) return { ok: true, layout: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${DASH3_FM_KEY} 不是映射` }
  const out: Dash3Layout = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 3) return { ok: false, error: `${DASH3_FM_KEY}.${id} 不是 [order, w, h]` }
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return { ok: false, error: `${DASH3_FM_KEY}.${id} 含非数值` }
    }
    const n = v as number[]
    out[String(id)] = clampCell({ order: n[0], w: n[1], h: n[2] })
  }
  return { ok: true, layout: out }
}

/** 写结构化布局(只动 dashboard3: 一个键;走 yaml Document 保注释与键序,同 setDashInFm 的教训)。 */
export function setDash3InFm(fmExtra: string, layout: Dash3Layout): string | null {
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  const ids = Object.keys(layout).sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b))
  if (!ids.length) {
    doc.delete(DASH3_FM_KEY)
  } else {
    const obj: Record<string, number[]> = {}
    for (const id of ids) {
      const c = layout[id]
      obj[id] = [c.order, c.w, c.h]
    }
    const node = doc.createNode(obj)
    if ('items' in node) for (const it of (node as { items: Array<{ value?: unknown }> }).items) {
      const v = it.value as { flow?: boolean } | undefined
      if (v && typeof v === 'object') v.flow = true
    }
    doc.set(DASH3_FM_KEY, node)
  }
  return String(doc).replace(/\n+$/, '')
}

export type Dash3PinRead = { ok: true; pins: Dash3Pins } | { ok: false; error: string }

/** 读手工行位。三态与 readDash3Layout 逐条同构,但**失守的代价小一档**:pin 读不懂 =
 *  这一页按自动排版渲染(布局键还在,卡一张不少),视图只要停掉 pin 的写入即可。 */
export function readDash3Pins(fmExtra: string): Dash3PinRead {
  if (!fmExtra.trim()) return { ok: true, pins: {} }
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message.split('\n')[0] }
  const obj = doc.toJS() as unknown
  if (obj === null || obj === undefined) return { ok: true, pins: {} }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'frontmatter 根节点不是映射' }
  const raw = (obj as Record<string, unknown>)[DASH3_PIN_KEY]
  if (raw === undefined || raw === null) return { ok: true, pins: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${DASH3_PIN_KEY} 不是映射` }
  const out: Dash3Pins = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 2) return { ok: false, error: `${DASH3_PIN_KEY}.${id} 不是 [row, col]` }
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return { ok: false, error: `${DASH3_PIN_KEY}.${id} 含非数值` }
    }
    const n = v as number[]
    out[String(id)] = { row: clampInt(n[0], 0, DASH3_MAX_ORDER, 0), col: clampInt(n[1], 0, DASH3_COLS - 1, 0) }
  }
  return { ok: true, pins: out }
}

/** 写手工行位(与 setDash3InFm 同构,可串在同一份 fmExtra 上 —— 一次落笔、一个 undo 步)。 */
export function setDash3PinsInFm(fmExtra: string, pins: Dash3Pins): string | null {
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  const ids = Object.keys(pins).sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b))
  if (!ids.length) {
    doc.delete(DASH3_PIN_KEY)
  } else {
    const obj: Record<string, number[]> = {}
    for (const id of ids) obj[id] = [pins[id].row, pins[id].col]
    const node = doc.createNode(obj)
    if ('items' in node) for (const it of (node as { items: Array<{ value?: unknown }> }).items) {
      const v = it.value as { flow?: boolean } | undefined
      if (v && typeof v === 'object') v.flow = true
    }
    doc.set(DASH3_PIN_KEY, node)
  }
  return String(doc).replace(/\n+$/, '')
}

/** pin 的自愈:只清孤儿(块没了)。行号不压缩 —— 同值才算同行,稀疏毫无代价。
 *  返回 null = 无需改动。 */
export function reconcilePins(pins: Dash3Pins, ids: string[]): Dash3Pins | null {
  const present = new Set(ids)
  const keys = Object.keys(pins)
  if (!keys.some((id) => !present.has(id))) return null
  const out: Dash3Pins = {}
  for (const id of keys) if (present.has(id)) out[id] = pins[id]
  return out
}

/** 读布局模式。`null` = 文件没表态(新文件 → 网格;有 dashboard2: 的老文件 → 由视图给迁移横幅)。 */
export function readDashMode(fmExtra: string): DashMode | null {
  if (!fmExtra.trim()) return null
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return null
  const obj = doc.toJS() as unknown
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const raw = (obj as Record<string, unknown>)[DASH3_MODE_KEY]
  return raw === 'canvas' ? 'canvas' : raw === 'grid' ? 'grid' : null
}

export function setDashModeInFm(fmExtra: string, mode: DashMode): string | null {
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  doc.set(DASH3_MODE_KEY, mode)
  return String(doc).replace(/\n+$/, '')
}

/** 自由 px 画布 → 结构化网格。
 *  顺序 = 阅读序(先上后左,行容差半个行高);跨度 = 按固定画板 1152×648 的比例折算。
 *  纯数学、不读盘 —— 迁移由视图在用户点「转换」时调用,**绝不自动跑**(老文件的布局是用户手摆的)。 */
export const DASH3_MIGRATE_BOARD_W = 1152
export function migrateCanvasToGrid(px: Record<string, { x: number; y: number; w: number; h: number }>): Dash3Layout {
  const colPx = DASH3_MIGRATE_BOARD_W / DASH3_COLS
  const rowTol = DASH3_ROW_PX / 2
  const ids = Object.keys(px).sort((a, b) => {
    const ra = px[a]
    const rb = px[b]
    if (Math.abs(ra.y - rb.y) > rowTol) return ra.y - rb.y
    return ra.x - rb.x
  })
  const out: Dash3Layout = {}
  ids.forEach((id, i) => {
    const r = px[id]
    out[id] = clampCell({
      order: i,
      w: Math.max(1, Math.round(r.w / colPx)),
      h: Math.max(1, Math.round((r.h + DASH3_GAP_PX) / (DASH3_ROW_PX + DASH3_GAP_PX))),
    })
  })
  return out
}

/** 供 readDash3Layout 的调用方与 dashboard.ts 的 DashRead 保持同一种叙事(类型别名,便于共用分支)。 */
export type { DashRead }
