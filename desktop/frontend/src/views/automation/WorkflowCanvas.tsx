import React, { useEffect, useId, useRef, useState } from 'react'
import { Check, CircleAlert, RotateCcw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { CanvasChrome, CanvasMiniMap, useCanvasViewport, useCanvasGestures, hostSize, zoomAt, gridLayerStyle, type Box } from '../../amadeus/unified/canvasKit'
import { canvasGridSnapEnabled, canvasMiniMapEnabled, setCanvasGridSnapEnabled, setCanvasMiniMapEnabled } from '../../amadeus/unified/canvasPrefs'

export interface FlowNode { id: string; title: string; subtitle: string; icon: React.ReactNode; ready: boolean }
const initialBox = (index: number): Box => ({ x: 0, y: index * 132, w: 244, h: 84 })

/** The shared Forsion canvas owns navigation and gestures; only workflow nodes and edges live here. */
export const WorkflowCanvas: React.FC<{
  nodes: FlowNode[]; selected: string; onSelect: (id: string) => void; children?: React.ReactNode
}> = ({ nodes, selected, onSelect, children }) => {
  const { t } = useI18n()
  const marker = useId().replace(/:/g, '')
  const host = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Record<string, Box>>({})
  const [snap, setSnap] = useState(canvasGridSnapEnabled)
  const [mini, setMini] = useState(canvasMiniMapEnabled)
  const view = useCanvasViewport(host)
  const boxes = new Map(nodes.map((node, i) => [node.id, positions[node.id] || initialBox(i)]))
  const topology = nodes.map((node) => node.id).join(',')
  const gesture = useCanvasGestures(host, view, {
    boxes: () => boxes,
    identity: () => topology,
    commit: (next) => setPositions((old) => ({ ...old, ...Object.fromEntries(next) })),
    hitKey: (target) => target.closest<HTMLElement>('[data-flow-node]')?.dataset.flowNode || null,
    onEnterEdit: onSelect,
    onDoubleClick: (key) => { if (key) onSelect(key) },
    minW: 244, minH: 84, repel: true,
  }, snap)
  useEffect(() => gesture.bind(host.current), [gesture.bind])
  useEffect(() => view.bindWheel(host.current), [view.bindWheel])
  const fitRef = useRef(() => view.fitTo([...boxes.values()], 64))
  fitRef.current = () => view.fitTo([...boxes.values()], 64)
  useEffect(() => {
    setPositions({})
    const frame = requestAnimationFrame(() => fitRef.current())
    return () => cancelAnimationFrame(frame)
  }, [topology])
  useEffect(() => {
    const observer = new ResizeObserver(() => fitRef.current())
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  const box = (id: string): Box => gesture.live?.get(id) || boxes.get(id)!
  return <div className="auto-canvas-shell am-app">
    <div className="auto-canvas amx-stage" ref={host} tabIndex={0} aria-label={t('automation.ux.flow')}
      onPointerUpCapture={(event) => {
        if (gesture.busy) return
        const node = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-flow-node]')
        if (node && host.current?.contains(node)) onSelect(node.dataset.flowNode!)
      }}>
      <div className="amx-stage-grid" style={gridLayerStyle(view.vp)} />
      <div className="auto-canvas-world" style={{ transform: `translate(${view.vp.x}px, ${view.vp.y}px) scale(${view.vp.z})` }}>
        <svg className="auto-canvas-edges" aria-hidden="true">
          <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" /></marker></defs>
          {nodes.slice(1).map((node, i) => {
            const a = box(nodes[i].id), b = box(node.id)
            const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y
            return <path key={node.id} d={`M${x1},${y1} C${x1},${y1 + 28} ${x2},${y2 - 28} ${x2},${y2}`} markerEnd={`url(#${marker})`} />
          })}
        </svg>
        {nodes.map((node) => {
          const p = box(node.id)
          return <div key={node.id} data-flow-node={node.id} role="button" tabIndex={0} aria-pressed={selected === node.id}
            className={`auto-flow-node ${selected === node.id ? 'selected' : ''}`} style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            onClick={() => onSelect(node.id)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSelect(node.id) } }}>
            <span className="auto-flow-icon">{node.icon}</span><strong>{node.title}</strong>
            <span className="auto-flow-status" title={t(node.ready ? 'automation.ux.ready' : 'automation.ux.incomplete')}>{node.ready ? <Check size={13} /> : <CircleAlert size={13} />}</span>
            <span className="auto-flow-subtitle">{node.subtitle}</span>
          </div>
        })}
        {gesture.marquee && <div className="amx-stage-marquee" style={{ left: gesture.marquee.x, top: gesture.marquee.y, width: gesture.marquee.w, height: gesture.marquee.h }} />}
      </div>
      {children && <div className="amx-stage-tools auto-canvas-tools">{children}</div>}
      <CanvasChrome zoom={view.vp.z} onZoomBy={(factor) => { const { w, h } = hostSize(host.current); view.setVp(zoomAt(view.vp, view.vp.z * factor, w / 2, h / 2)) }}
        onFit={() => fitRef.current()} snap={snap} onSnap={(on) => { setSnap(on); setCanvasGridSnapEnabled(on) }}
        mini={mini} onMini={(on) => { setMini(on); setCanvasMiniMapEnabled(on) }}
        extra={<button type="button" title={t('automation.ux.arrange')} onClick={() => { setPositions({}); requestAnimationFrame(() => fitRef.current()) }}><RotateCcw size={12} /></button>} />
      {mini && <CanvasMiniMap hostRef={host} vp={view.vp} items={nodes.map((node) => ({ key: node.id, kind: 'card', box: box(node.id) }))} onCenter={view.centerOn} />}
    </div>
  </div>
}
