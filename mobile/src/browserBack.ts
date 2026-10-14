/** One same-URL history entry while the app has something to go back through. Returning to the app's
 * home removes that entry; the browser's next Back can leave normally. No stored data or URL changes. */
export interface BrowserBackPlan { run(): void; boundary?: boolean }

export function installBrowserBack(plan: () => BrowserBackPlan, watch: (changed: () => void) => () => void): () => void {
  const key = 'forsionMobileBack'
  // A reload keeps history.state. Reclaim our current entry instead of stacking another identical page.
  const saved = history.state?.[key]
  const id = typeof saved === 'string' ? saved : crypto.randomUUID()
  let guarded = saved === id
  let pruning = false
  let handling = false
  let frame = 0
  let alive = true
  const needsBack = (): boolean => !plan().boundary
  const update = (): void => {
    if (!alive || handling || pruning) return
    if (needsBack()) {
      if (guarded) return
      const previous = history.state && typeof history.state === 'object' ? history.state : {}
      history.pushState({ ...previous, [key]: id }, '', location.href)
      guarded = true
    } else if (guarded && history.state?.[key] === id) {
      pruning = true
      history.back()
    }
  }
  const changed = (): void => {
    if (frame) return
    // Wait for the React commit: a just-closed sheet's back listener must be gone before probing again.
    frame = requestAnimationFrame(() => { frame = 0; update() })
  }
  const pop = (event: PopStateEvent): void => {
    if (pruning) { pruning = false; guarded = false; changed(); return }
    if (event.state?.[key] === id) { guarded = true; changed(); return } // Forward into our entry.
    if (!guarded) return
    guarded = false
    const next = plan()
    if (next.boundary) return
    handling = true
    try { next.run() } finally { handling = false; changed() }
  }
  window.addEventListener('popstate', pop)
  const off = watch(changed)
  update()
  return () => { alive = false; cancelAnimationFrame(frame); off(); window.removeEventListener('popstate', pop) }
}
