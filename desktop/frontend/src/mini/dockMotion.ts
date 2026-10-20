import type { MiniDockMotion } from '../../../shared/miniDock'

/** One compositor animation, independent of React commits or main-process timer cadence. */
export function installMiniDockMotion(): () => void {
  let animation: Animation | undefined, latest = 0
  const off = window.tangu?.onMiniDockMotion?.((request: MiniDockMotion) => {
    const shell = document.querySelector<HTMLElement>('.mini-card-shell')
    if (!shell) return
    latest = request.id
    const from = getComputedStyle(shell).transform
    animation?.cancel()
    const target = request.x || request.y
      ? `translate3d(calc(${request.x}px / var(--uiz, 1)), calc(${request.y}px / var(--uiz, 1)), 0)` : 'none'
    shell.style.transform = target
    const done = (): void => {
      if (latest !== request.id) return
      animation?.cancel(); animation = undefined
      if (target === 'none') shell.style.removeProperty('transform') // restore fixed descendants' containing block
      window.tangu?.miniDockMotionDone?.(request.id)
    }
    if (!request.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return }
    animation = shell.animate([{ transform: from }, { transform: target }], { duration: 220, easing: 'cubic-bezier(.22, .8, .25, 1)' })
    void animation.finished.then(done, () => {})
  })
  return () => { latest++; animation?.cancel(); off?.() }
}
