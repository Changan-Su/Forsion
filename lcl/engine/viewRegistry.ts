/**
 * 视图注册表(≈ Obsidian registerView)。模块级单例:视图在启动期注册,WorkspaceHost
 * 据此构建 Dockview 的 components map。带订阅,使 Phase 4 插件运行期注册新视图也能刷新。
 */
import type { ViewDefinition } from './types'

const registry = new Map<string, ViewDefinition>()
const listeners = new Set<() => void>()

export function registerView(def: ViewDefinition): void {
  registry.set(def.type, def)
  listeners.forEach((l) => l())
}

export function unregisterView(type: string): void {
  if (registry.delete(type)) listeners.forEach((l) => l())
}

export function getView(type: string): ViewDefinition | undefined {
  return registry.get(type)
}

export function allViews(): ViewDefinition[] {
  return [...registry.values()]
}

/** 订阅注册表变化(返回退订函数)。 */
export function subscribeViews(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
