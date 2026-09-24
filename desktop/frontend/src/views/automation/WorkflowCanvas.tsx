import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, CircleAlert, Maximize, Minus, Plus, RotateCcw } from 'lucide-react'
import { useI18n } from '../../i18n'

export interface FlowNode { id: string; title: string; subtitle: string; icon: React.ReactNode; ready: boolean }
type Point = { x: number; y: number }
const WIDTH = 244
const HEIGHT = 90
const initialPosition = (index: number): Point => ({ x: 64, y: 40 + index * 142 })

/** A linear workflow canvas: geometry never changes execution order. */
export const WorkflowCanvas: React.FC<{
  nodes: FlowNode[]; selected: string; onSelect: (id: string) => void; children?: React.ReactNode
}> = ({ nodes, selected, onSelect, children }) => {
  const { t } = useI18n()
  const marker = useId().replace(/:/g, '')
  const viewport = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ id?: string; pointer: number; start: Point; origin: Point; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const point = (id: string, i: number): Point => positions[id] || initialPosition(i)
  const fit = useCallback(() => {
    const el = viewport.current
    if (!el || !el.clientWidth || !el.clientHeight) return
    const ps = nodes.map((n, i) => positions[n.id] || initialPosition(i))
    const left = Math.min(...ps.map((p) => p.x)), top = Math.min(...ps.map((p) => p.y))
    const width = Math.max(...ps.map((p) => p.x)) - left + WIDTH
    const height = Math.max(...ps.map((p) => p.y)) - top + HEIGHT
    const zoom = Math.max(0.1, Math.min(1, (el.clientWidth - 64) / width, (el.clientHeight - 100) / height))
    setView({ x: (el.clientWidth - width * zoom) / 2 - left * zoom, y: (el.clientHeight - height * zoom) / 2 - top * zoom - 14, zoom })
  }, [nodes, positions])
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(() => fitRef.current())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const topology = nodes.map((node) => node.id).join(',')
  useEffect(() => {
    // Structural edits reflow the chain so earlier manual drags cannot overlap new steps.
    setPositions({})
    const frame = requestAnimationFrame(() => fitRef.current())
    return () => cancelAnimationFrame(frame)
  }, [topology])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const bounds = el.getBoundingClientRect()
        const x = event.clientX - bounds.left, y = event.clientY - bounds.top
        setView((v) => {
          const zoom = Math.max(0.1, Math.min(1.5, v.zoom * Math.exp(-event.deltaY * 0.005)))
          return { zoom, x: x - (x - v.x) * zoom / v.zoom, y: y - (y - v.y) * zoom / v.zoom }
        })
      } else setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  const zoomBy = (delta: number): void => {
    const el = viewport.current
    if (!el) return
    setView((v) => {
      const zoom = Math.max(0.1, Math.min(1.5, v.zoom + delta))
      const ratio = zoom / v.zoom
      return { zoom, x: el.clientWidth / 2 - (el.clientWidth / 2 - v.x) * ratio, y: el.clientHeight / 2 - (el.clientHeight / 2 - v.y) * ratio }
    })
  }
  const startDrag = (e: React.PointerEvent, id?: string, origin?: Point): void => {
    if (e.button !== 0 || (!id && (e.target as Element).closest('button, select'))) return
    suppressClick.current = false
    drag.current = { id, pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, origin: origin || view, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.stopPropagation()
  }
  const move = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    const dx = e.clientX - d.start.x, dy = e.clientY - d.start.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    if (d.id) setPositions((ps) => ({ ...ps, [d.id!]: { x: d.origin.x + dx / view.zoom, y: d.origin.y + dy / view.zoom } }))
    else setView((v) => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }))
  }
  const stop = (): void => { suppressClick.current = !!drag.current?.moved; drag.current = null }
  return <div className="auto-canvas-shell">
    <div className="auto-canvas-heading"><strong>{t('automation.ux.flow')}</strong><span>{t('automation.ux.canvasHint')}</span></div>
    <div className="auto-canvas" ref={viewport} onPointerDown={(e) => startDrag(e)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}>
      <div className="auto-canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="auto-canvas-edges" aria-hidden="true">
          <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" /></marker></defs>
          {nodes.slice(1).map((node, i) => {
            const a = point(nodes[i].id, i), b = point(node.id, i + 1)
            const x1 = a.x + WIDTH / 2, y1 = a.y + HEIGHT, x2 = b.x + WIDTH / 2, y2 = b.y
            const bend = Math.max(24, Math.abs(y2 - y1) / 2)
            return <path key={node.id} d={`M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`} markerEnd={`url(#${marker})`} />
          })}
        </svg>
        {nodes.map((node, i) => {
          const p = point(node.id, i)
          return <button key={node.id} type="button" className={`auto-flow-node ${selected === node.id ? 'selected' : ''}`} style={{ left: p.x, top: p.y, width: WIDTH, height: HEIGHT }}
            aria-pressed={selected === node.id} aria-label={`${node.title}: ${node.subtitle}`} data-node={node.id}
            onPointerDown={(e) => startDrag(e, node.id, p)} onClick={() => { if (!suppressClick.current) onSelect(node.id); suppressClick.current = false }}>
            <span className="auto-flow-icon">{node.icon}</span><strong>{node.title}</strong>
            <span className="auto-flow-status" title={t(node.ready ? 'automation.ux.ready' : 'automation.ux.incomplete')}>{node.ready ? <Check size={13} /> : <CircleAlert size={13} />}</span>
            <span className="auto-flow-subtitle">{node.subtitle}</span>
          </button>
        })}
      </div>
      <div className="auto-canvas-controls">
        <button type="button" className="icon-btn" aria-label={t('automation.ux.zoomOut')} onClick={() => zoomBy(-0.1)}><Minus size={14} /></button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label={t('automation.ux.zoomIn')} onClick={() => zoomBy(0.1)}><Plus size={14} /></button>
        <button type="button" className="icon-btn" aria-label={t('automation.ux.fit')} onClick={fit}><Maximize size={14} /></button>
        <button type="button" className="icon-btn" aria-label={t('automation.ux.arrange')} onClick={() => { setPositions({}); requestAnimationFrame(() => fitRef.current()) }}><RotateCcw size={14} /></button>
      </div>
    </div>
    {children}
  </div>
}
