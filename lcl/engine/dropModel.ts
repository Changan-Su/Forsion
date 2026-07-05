/**
 * 受控拖放的「唯一真源」:computeDropTarget 据光标算出落点,**提示层与提交层共用同一结果** →
 * 竖线/半屏高亮显示在哪,松手就落在哪(根治「提示≠落点」)。
 *
 * 固定 3 面板模型(左/主/右,身份显式存 panel.__loc):
 *  - tab 栏 → 并为标签页(竖线指示插入位),不分屏;
 *  - 正文半边 → 面板内分屏:主区四向,侧栏仅上/下(左右半边归并到最近的上/下);
 *  - 违规(拖到最外缘另起第 4 列 / 侧栏想左右分屏)→ 本层不产出该目标 = 松手弹回。
 * 纯计算部分(splitDirection/tabInsertion/locOf)可单测;computeDropTarget 是 DOM 粘合层。
 */
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react'
import type { ViewLocation } from './types'

interface HasLoc { __loc?: ViewLocation }

/** 组的面板身份(组内 panel 共享 __loc;取首个,缺省 main)。 */
export function locOf(group: { panels: Pick<IDockviewPanel, 'params'>[] }): ViewLocation {
  const loc = ((group.panels[0]?.params ?? {}) as HasLoc).__loc
  return loc ?? 'main'
}

export type SplitDir = 'top' | 'bottom' | 'left' | 'right'
export interface RectLike { left: number; top: number; width: number; height: number }

export type DropTarget =
  | { mode: 'tab'; group: DockviewGroupPanel; index: number; lineX: number; top: number; height: number }
  | { mode: 'split'; group: DockviewGroupPanel; dir: SplitDir; rect: RectLike }

/** 正文半屏分屏方向。主区:对角线四分 → 四向;侧栏:仅按水平中线 → 上/下(左右区也归并,不产出 left|right)。 */
export function splitDirection(x: number, y: number, rect: RectLike, loc: ViewLocation): SplitDir {
  const cy = rect.top + rect.height / 2
  if (loc === 'left' || loc === 'right') return y < cy ? 'top' : 'bottom'
  const dx = (x - (rect.left + rect.width / 2)) / (rect.width || 1)
  const dy = (y - cy) / (rect.height || 1)
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/** 半屏高亮矩形(视口坐标),对应 splitDirection 的落点半边。 */
export function halfRect(rect: RectLike, dir: SplitDir): RectLike {
  const { left, top, width, height } = rect
  if (dir === 'left') return { left, top, width: width / 2, height }
  if (dir === 'right') return { left: left + width / 2, top, width: width / 2, height }
  if (dir === 'top') return { left, top, width, height: height / 2 }
  return { left, top: top + height / 2, width, height: height / 2 }
}

/** tab 条插入位:遍历 tab 中点,x 落在哪个之前就插在其前;都不在则末尾。lineX=竖线 x。
 *  tabs 已排除被拖的源 tab(同组重排时)。stripLeft=空条时的起点。 */
export function tabInsertion(tabs: { left: number; right: number }[], x: number, stripLeft: number): { index: number; lineX: number } {
  let index = tabs.length
  let lineX = stripLeft
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]
    lineX = t.right
    if (x < t.left + (t.right - t.left) / 2) { lineX = t.left; index = i; break }
  }
  return { index, lineX }
}

/** 唯一真源:据光标(视口坐标)算落点。null = 违规/无命中 → 不提示不落子。
 *  被拖的源 tab 靠 DOM 上的 .wb-tab-dragging 类排除(见下),故无需 draggingId 参与计算。 */
export function computeDropTarget(api: DockviewApi, x: number, y: number): DropTarget | null {
  const groupEl = (document.elementFromPoint(x, y) as Element | null)?.closest('.dv-groupview') as HTMLElement | null
  if (!groupEl) return null
  const group = api.groups.find((g) => (g as unknown as { element?: HTMLElement }).element === groupEl)
  if (!group) return null
  const loc = locOf(group)

  // tab 栏命中?(整条 actions 行,含末尾 void)
  const row = groupEl.querySelector('.dv-tabs-and-actions-container') as HTMLElement | null
  const rr = row?.getBoundingClientRect()
  if (row && rr && y >= rr.top && y <= rr.bottom) {
    const strip = row.querySelector('.dv-tabs-container') as HTMLElement | null
    if (!strip) return null
    const sr = strip.getBoundingClientRect()
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.dv-tab'))
      .filter((t) => !t.classList.contains('wb-tab-dragging')) // 排除被拖的源 tab(同组重排)
      .map((t) => t.getBoundingClientRect())
    const { index, lineX } = tabInsertion(tabs, x, sr.left)
    return { mode: 'tab', group, index, lineX, top: sr.top + 3, height: Math.max(0, sr.height - 6) }
  }

  // 正文 → 面板内分屏
  const content = (groupEl.querySelector('.dv-content-container') ?? groupEl) as HTMLElement
  const cr = content.getBoundingClientRect()
  const dir = splitDirection(x, y, cr, loc)
  return { mode: 'split', group, dir, rect: halfRect(cr, dir) }
}
