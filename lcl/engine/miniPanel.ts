/** Mini is an opt-in Space surface. The host never falls back to a desktop layout. */
import type { SpaceDefinition } from './types'
import { getView } from './viewRegistry'

export interface MiniViewTarget { type: string; params?: Record<string, unknown> }
export interface MiniPanelDefinition {
  /** Dedicated compact view, registered before the Space. */
  view: MiniViewTarget
  /** Full view opened by the host's “Show in main panel” action. Current params win. */
  mainView: MiniViewTarget
  /** Optional compact surface name (e.g. Calendar exposes ToDo List). */
  name?: string | (() => string)
}
export interface MainPanelTarget extends MiniViewTarget { spaceId?: string }

export function supportsMiniPanel(space: SpaceDefinition): boolean {
  return !!space.mini && space.mini.view.type !== space.mini.mainView.type
    && !!getView(space.mini.view.type) && !!getView(space.mini.mainView.type)
}

/** Host seam, also used when a compact view links to content requiring a full workspace. */
let openMain: ((target: MainPanelTarget) => void) | null = null
export function setMiniMainHandler(handler: typeof openMain): void { openMain = handler }
export function showInMainPanel(target: MainPanelTarget): void { openMain?.(target) }

// Injected by MiniRoot; keeps the single-leaf data model free of Space registry cycles.
let route: ((target: MiniViewTarget) => MiniViewTarget | null) | null = null
export function setMiniViewRouter(router: typeof route): void { route = router }
export function routeMiniView(target: MiniViewTarget): MiniViewTarget | null { return route ? route(target) : target }
