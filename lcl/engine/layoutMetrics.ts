/**
 * 「恢复默认布局」撤销快照的**尺寸 / 排列**指纹(Codex 第三轮 H1-3)。结构指纹(各组有哪些面板)管不到拖分隔线:
 * 用户重置后把分屏比例拖过,撤销仍会把重置前的整份布局灌回,丢掉刚调的比例。这里补上尺寸,但**侧栏宽度不算**
 * (拖宽侧栏 / pinSides 按黄金分割钉宽都不该让撤销失效)。
 *
 * 布局形状:左右侧栏是按绝对方向加的(direction 'left' / 'right'),落在根 branch 上;主区分屏按 referencePanel
 * 加,和侧栏是**同一个 branch 的兄弟**。于是分两种 branch 记:
 *   - 有侧栏直接子节点的 branch:记相邻两个**非侧栏**子节点之间分隔线的绝对位置(从 branch 起点量)。
 *     拖左侧栏 = 左栏与 m1 此消彼长,m1|m2 那条线的位置不变;拖右侧栏同理 —— 侧栏怎么拖都不动这些数。
 *   - 没有侧栏子节点的 branch(主区里的嵌套分屏、主区 × 底栏):记各子节点占比。外层宽度变化时 Dockview
 *     按比例分配,占比不变。
 * 比较带容差(像素 / 占比的取整抖动)。窗口缩放会改第一种的绝对位置 → 撤销作废,可接受(保守方向)。
 */
import type { DockviewApi } from 'dockview-react'

export interface LayoutMetrics {
  /** 侧栏所在 branch 里、两个非侧栏兄弟之间分隔线的绝对位置(px)。 */
  sashes: number[]
  /** 无侧栏 branch 里各子节点的占比(0..1)。 */
  fractions: number[]
}

type GridNode = { type?: string; data?: unknown; size?: number; visible?: boolean }
type PanelsJson = Record<string, { params?: { __loc?: string } }>

const SASH_TOLERANCE_PX = 3
const FRACTION_TOLERANCE = 0.01

export function layoutMetrics(api: Pick<DockviewApi, 'toJSON'>): LayoutMetrics {
  const out: LayoutMetrics = { sashes: [], fractions: [] }
  let json: { grid?: { root?: GridNode }; panels?: PanelsJson }
  try { json = api.toJSON() as unknown as typeof json } catch { return out }
  const panels = json.panels ?? {}
  const isSide = (node: GridNode): boolean => {
    if (node.type !== 'leaf') return false
    const views = ((node.data ?? {}) as { views?: string[] }).views ?? []
    return views.length > 0 && views.every((id) => {
      const loc = panels[id]?.params?.__loc
      return loc === 'left' || loc === 'right'
    })
  }
  const walk = (node: GridNode | undefined): void => {
    if (!node || node.type !== 'branch' || !Array.isArray(node.data)) return
    const kids = (node.data as GridNode[]).filter((k) => k && k.visible !== false)
    if (kids.some(isSide)) {
      let pos = 0
      kids.forEach((kid, i) => {
        pos += kid.size ?? 0
        const next = kids[i + 1]
        if (next && !isSide(kid) && !isSide(next)) out.sashes.push(pos)
      })
    } else if (kids.length > 1) {
      const total = kids.reduce((sum, kid) => sum + (kid.size ?? 0), 0)
      if (total > 0) for (const kid of kids) out.fractions.push((kid.size ?? 0) / total)
    }
    kids.forEach(walk)
  }
  walk(json.grid?.root)
  return out
}

/** 两份指纹在容差内相同(条数不同 = 排列变了)。 */
export function sameLayoutMetrics(a: LayoutMetrics, b: LayoutMetrics): boolean {
  if (a.sashes.length !== b.sashes.length || a.fractions.length !== b.fractions.length) return false
  return a.sashes.every((v, i) => Math.abs(v - b.sashes[i]) <= SASH_TOLERANCE_PX)
    && a.fractions.every((v, i) => Math.abs(v - b.fractions[i]) <= FRACTION_TOLERANCE)
}
