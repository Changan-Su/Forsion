import { Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getView, subscribeViews, ViewErrorBoundary, type Leaf } from '@lcl/engine'
import type { FloatingPanelViewTarget } from '../../../shared/floatingPanel'

export function FloatingViewSurface({ target, onUnavailable }: { target: FloatingPanelViewTarget; onUnavailable?: () => void }) {
  const [, refresh] = useReducer((n) => n + 1, 0)
  const [params, setParams] = useState<Record<string, unknown>>(() => ({ ...(target.params ?? {}) }))
  const paramsRef = useRef(params)
  paramsRef.current = params
  const seen = useRef(false)
  useEffect(() => subscribeViews(refresh), [])
  useEffect(() => setParams({ ...(target.params ?? {}) }), [target])
  const view = getView(target.type)
  if (view) seen.current = true
  useEffect(() => { if (seen.current && !view) onUnavailable?.() }, [view, onUnavailable])
  const leaf = useMemo<Leaf>(() => ({
    id: `floating:${target.type}`,
    type: target.type,
    loc: 'main',
    get params() { return paramsRef.current },
    setTitle: (title) => { document.title = title },
    setParams: (next) => setParams({ ...next }),
    close: () => onUnavailable?.(),
  }), [target.type, onUnavailable])
  if (!view) return <div className="floating-panel-empty">Loading panel…</div>
  return <div className="floating-plugin-view" data-view={target.type}>
    <ViewErrorBoundary><Suspense fallback={null}>{view.factory({ leaf, params })}</Suspense></ViewErrorBoundary>
  </div>
}
