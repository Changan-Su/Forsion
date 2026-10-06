/** Windows' native HTML drag loop swallows Escape and drops over guest contents.
 * Keep the gesture in the source renderer with pointer capture instead. */
export function beginRibbonPointerDrag(event: PointerEvent, source: HTMLElement, handlers: {
  start(): void
  move(event: PointerEvent): void
  drop(event: PointerEvent): void
  cancel(): void
}): () => void {
  const capture = (event.target as Element).closest('button') ?? source
  let active = false, finished = false
  let ghost: HTMLElement | undefined
  let shield: HTMLElement | undefined
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1
  const x = event.clientX, y = event.clientY
  capture.setPointerCapture(event.pointerId)
  const clean = (released = false): void => {
    finished = true
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('blur', cancel)
    capture.removeEventListener('lostpointercapture', cancel)
    if (capture.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId)
    document.documentElement.classList.remove('rb-pointer-dragging')
    ghost?.remove()
    shield?.remove()
    if (active) {
      // Captured release would otherwise click the original Space button.
      const swallow = (e: MouseEvent): void => { e.preventDefault(); e.stopImmediatePropagation(); remove() }
      const afterUp = (): void => { clearTimeout(timer); timer = window.setTimeout(remove, 0) }
      const remove = (): void => { window.removeEventListener('click', swallow, true); window.removeEventListener('pointerup', afterUp, true); clearTimeout(timer) }
      window.addEventListener('click', swallow, true)
      if (!released) window.addEventListener('pointerup', afterUp, { capture: true, once: true })
      let timer = window.setTimeout(remove, released ? 0 : 10000)
    }
  }
  const cancel = (): void => { if (finished) return; clean(); if (active) handlers.cancel() }
  const key = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault(); e.stopImmediatePropagation(); cancel()
  }
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== event.pointerId || finished) return
    if (!(e.buttons & 1)) { cancel(); return }
    if (!active && Math.hypot(e.clientX - x, e.clientY - y) < 6) return
    if (!active) {
      active = true
      document.documentElement.classList.add('rb-pointer-dragging')
      // Guest webContents have their own input routing. Cover them during the gesture;
      // briefly ignore this shield only when hit-testing the actual Ribbon target.
      shield = document.createElement('div')
      shield.className = 'rb-pointer-shield'
      shield.style.width = `${window.innerWidth / zoom}px`
      shield.style.height = `${window.innerHeight / zoom}px`
      shield.setAttribute('aria-hidden', 'true')
      document.body.appendChild(shield)
      ghost = source.cloneNode(true) as HTMLElement
      ghost.removeAttribute('data-id')
      ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
      ghost.className = 'rb-pointer-ghost'
      ghost.setAttribute('aria-hidden', 'true')
      ghost.style.width = `${source.getBoundingClientRect().width / zoom}px`
      document.body.appendChild(ghost)
      handlers.start()
    }
    e.preventDefault()
    ghost!.style.left = `${(e.clientX + 12) / zoom}px`
    ghost!.style.top = `${(e.clientY + 12) / zoom}px`
    shield!.style.pointerEvents = 'none'
    try { handlers.move(e) } finally { shield!.style.pointerEvents = '' }
  }
  const up = (e: PointerEvent): void => {
    if (e.pointerId !== event.pointerId || e.button !== 0 || finished) return
    clean(true)
    if (active) { e.preventDefault(); handlers.drop(e) }
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', key, true)
  window.addEventListener('blur', cancel)
  capture.addEventListener('lostpointercapture', cancel)
  return cancel
}
