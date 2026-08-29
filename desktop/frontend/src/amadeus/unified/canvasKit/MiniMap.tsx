/**
 * 画布缩略图(View 基座方案 §6.4 S2)——**盒子由调用方给**,本组件只管投影与导航。
 *
 * 画布侧的盒子来自真 DOM 量测(PM 的卡高会随图片加载/换行独立变),仪表盘侧直接就是布局矩形;
 * 那半边差异留在各自的 wrapper 里,投影/视口框/点击导航这半边两处共用。
 */
import { useRef } from 'react'
import { zoomOf } from '@lcl/engine'
import type { Box } from './geometry'
import type { Viewport } from './viewport'

export const MINI_W = 184
export const MINI_H = 112
export const MINI_PAD = 7

export interface MiniItem { key: string; kind: 'card' | 'main' | 'shape' | 'frame'; box: Box }

export function CanvasMiniMap({ hostRef, vp, items, onCenter }: {
  hostRef: React.RefObject<HTMLElement | null>
  vp: Viewport
  items: readonly MiniItem[]
  onCenter: (worldX: number, worldY: number) => void
}): React.ReactElement | null {
  const dragging = useRef(false)
  const host = hostRef.current
  if (!host || !items.length) return null

  const u = zoomOf(host) || 1
  const hr = host.getBoundingClientRect()
  const visible: Box = {
    x: -vp.x / vp.z,
    y: -vp.y / vp.z,
    w: Math.max(1, hr.width / u / vp.z),
    h: Math.max(1, hr.height / u / vp.z),
  }
  // 把视口也并进世界范围:即使平移到内容之外,缩略图仍能显示「你现在在哪里」。
  const boxes = [...items.map((i) => i.box), visible]
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const worldW = Math.max(1, maxX - minX)
  const worldH = Math.max(1, maxY - minY)
  const scale = Math.min((MINI_W - MINI_PAD * 2) / worldW, (MINI_H - MINI_PAD * 2) / worldH)
  const ox = (MINI_W - worldW * scale) / 2 - minX * scale
  const oy = (MINI_H - worldH * scale) / 2 - minY * scale
  const miniBox = (b: Box): Box => ({ x: ox + b.x * scale, y: oy + b.y * scale, w: Math.max(1.5, b.w * scale), h: Math.max(1.5, b.h * scale) })

  const jump = (e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const mx = ((e.clientX - r.left) / Math.max(1, r.width)) * MINI_W
    const my = ((e.clientY - r.top) / Math.max(1, r.height)) * MINI_H
    onCenter((mx - ox) / scale, (my - oy) / scale)
  }

  const vb = miniBox(visible)
  return (
    <div
      className="amx-stage-minimap"
      role="navigation"
      aria-label="画布缩略图"
      title="画布缩略图:点击或拖动以导航"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成事件可没有有效 id */ }
        jump(e)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        e.preventDefault()
        e.stopPropagation()
        jump(e)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
      }}
      onPointerCancel={() => { dragging.current = false }}
    >
      <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
        {items.map((item) => {
          const b = miniBox(item.box)
          return <rect key={item.key} className={`amx-mini-item is-${item.kind}`} data-mini-key={item.key} x={b.x} y={b.y} width={b.w} height={b.h} rx={item.kind === 'frame' ? 2 : 1.5} />
        })}
        <rect className="amx-mini-viewport" x={vb.x} y={vb.y} width={vb.w} height={vb.h} rx="2" />
      </svg>
    </div>
  )
}
