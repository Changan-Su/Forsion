import type { FloatingPanelOpenOptions } from '../../shared/floatingPanel'

let webFloating: FloatingPanelOpenOptions | null = null
const listeners = new Set<() => void>()

export function openWebFloatingPanel(target: FloatingPanelOpenOptions): void {
  webFloating = target
  listeners.forEach((listener) => listener())
}

export function closeWebFloatingPanel(): void {
  webFloating = null
  listeners.forEach((listener) => listener())
}

export function getWebFloatingPanel(): FloatingPanelOpenOptions | null { return webFloating }
export function subscribeWebFloatingPanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
