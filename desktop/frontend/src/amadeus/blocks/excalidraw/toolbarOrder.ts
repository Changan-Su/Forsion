/** 工具胶囊的分段与顺序(用户可拖拽)。三段:左段 | 中段 | 右段,两条分隔竖线就是段界。
 *
 *  **中段才有数字快捷键**,按位置从左到右 1..9、第 10 个是 0 —— 也就是说拖动会改快捷键,
 *  这是用户明确要的语义(左段/右段的工具没有数字键)。
 *
 *  和 boardUiMode 同一个存法:全局一份 localStorage + 内存态优先 + storage 事件跨窗口作废。
 *  单独成文件同样是为了断开环 —— 它不能 import 引擎。
 */
/** ⚠️ 这里**没有 image**,是实测后故意拿掉的:zsviczian fork 把图片插入整个改道给了 Obsidian 宿主
 *  (它自己的工具栏里也没有 `toolbar-image`,换成了 `COMP_IMG_FROM_SYSTEM` / `COMP_IMG_ANY_FILE` /
 *  `COMP_IMG_LaTeX` 那几项),而我们的假宿主没实现这些。实测点下去:不弹文件选择器、页面里没有
 *  `input[type=file]`、activeTool 当场退回 selection —— 就是一颗死按钮,不如不给。
 *  要补回来得自己做(file input → `api.addFiles` → `convertToExcalidrawElements` 造 image 元素),
 *  是独立一件事;在那之前贴图走粘贴/拖拽(引擎原生管这条路)。 */
export type ToolId =
  | 'lock'
  | 'hand'
  | 'selection'
  | 'shape'
  | 'line'
  | 'freedraw'
  | 'highlighter'
  | 'text'
  | 'eraser'
  | 'frame'
  | 'laser'

export type Segment = 'left' | 'mid' | 'right'
export type ToolbarLayout = Record<Segment, ToolId[]>

export const SEGMENTS: Segment[] = ['left', 'mid', 'right']

/** 出厂布局:锁 + 抓手在第一条分隔线左边(用户要求),画图工具在中段拿数字键,框选/激光笔归右段。 */
export const DEFAULT_LAYOUT: ToolbarLayout = {
  left: ['lock', 'hand'],
  mid: ['selection', 'shape', 'line', 'freedraw', 'highlighter', 'text', 'eraser'],
  right: ['frame', 'laser'],
}

const ALL: ToolId[] = [...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.mid, ...DEFAULT_LAYOUT.right]

const KEY = 'amx.boardToolbar'
const subs = new Set<() => void>()
let mem: ToolbarLayout | null = null

/** 中段第 i 个的数字键。第 10 个用 0(和引擎原来的排法一致),再多就没有键了。 */
export const digitFor = (index: number): string | null => (index < 9 ? String(index + 1) : index === 9 ? '0' : null)

/** 存下来的东西不可信(手改、跨版本增删工具)。规整成:每个已知工具**恰好出现一次**,
 *  未知的丢掉,漏掉的按出厂位置补回去 —— 以后加工具时老用户不会平白少一颗按钮。 */
export function normalize(raw: unknown): ToolbarLayout {
  const seen = new Set<ToolId>()
  const out: ToolbarLayout = { left: [], mid: [], right: [] }
  const src = (raw ?? {}) as Partial<Record<Segment, unknown>>
  for (const seg of SEGMENTS) {
    for (const id of Array.isArray(src[seg]) ? (src[seg] as unknown[]) : []) {
      if (typeof id !== 'string' || !ALL.includes(id as ToolId) || seen.has(id as ToolId)) continue
      seen.add(id as ToolId)
      out[seg].push(id as ToolId)
    }
  }
  for (const seg of SEGMENTS) {
    for (const id of DEFAULT_LAYOUT[seg]) if (!seen.has(id)) out[seg].push(id)
  }
  return out
}

export const getToolbarLayout = (): ToolbarLayout => {
  if (mem) return mem
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return (mem = normalize(JSON.parse(raw)))
  } catch {
    /* 读不到/坏 JSON 就用出厂 */
  }
  return (mem = DEFAULT_LAYOUT)
}

export const setToolbarLayout = (v: ToolbarLayout): void => {
  mem = normalize(v)
  try {
    localStorage.setItem(KEY, JSON.stringify(mem))
  } catch {
    /* 存不下就只活在本次会话 */
  }
  for (const f of subs) f()
}

export const resetToolbarLayout = (): void => {
  mem = DEFAULT_LAYOUT
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  for (const f of subs) f()
}

export const isDefaultLayout = (l: ToolbarLayout): boolean =>
  SEGMENTS.every((s) => l[s].length === DEFAULT_LAYOUT[s].length && l[s].every((id, i) => id === DEFAULT_LAYOUT[s][i]))

export const subscribeToolbarLayout = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** 把 id 从原位摘掉、插到目标段的 index 处。index 允许等于长度(插到末尾)。 */
export function moveTool(layout: ToolbarLayout, id: ToolId, to: Segment, index: number): ToolbarLayout {
  const next: ToolbarLayout = { left: [...layout.left], mid: [...layout.mid], right: [...layout.right] }
  for (const seg of SEGMENTS) {
    const i = next[seg].indexOf(id)
    if (i >= 0) next[seg].splice(i, 1)
  }
  next[to].splice(Math.max(0, Math.min(index, next[to].length)), 0, id)
  return next
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    mem = null
    for (const f of subs) f()
  })
}
