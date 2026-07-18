/**
 * 插件视图桥:pluginStore.views(平台中立的 DOM-mount 契约)→ LCL 视图注册表。
 * 桌面差异全部收在这里(与 amadeusPlugins.ts 同款纪律,vendored pluginStore 不 import @lcl):
 *  - 注册名统一命名空间 `plugin:<pluginId>:<viewId>`(Space 的 requires.views 用同名声明);
 *  - 插件禁用 → 先关掉该类型的所有开着的 leaf(主区按 mainTabs,侧栏两侧 closeSideView),再反注册
 *    ——Dockview 的 components map 收缩时不能留活面板;
 *  - ctx.openView 经 pluginStore.viewOpener 钩子指到 workspace.openView(主区)。
 */
import React, { useEffect, useRef } from 'react'
import { registerView, unregisterView, useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ViewContribution } from '@amadeus/plugins/types'

/** DOM-mount 宿主:div 交给插件的 mount(),卸载时跑其返回的清理函数。 */
const PluginViewHost: React.FC<{ def: ViewContribution }> = ({ def }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cleanup: (() => void) | void
    try {
      cleanup = def.mount(el)
    } catch (e) {
      console.error(`[plugin-view] mount "${def.id}" failed`, e)
      el.textContent = '插件视图加载失败(见控制台)'
    }
    return () => {
      try { if (typeof cleanup === 'function') cleanup() } catch (e) { console.error(`[plugin-view] cleanup "${def.id}" failed`, e) }
      el.replaceChildren()
    }
  }, [def])
  return <div ref={ref} style={{ height: '100%', overflow: 'auto' }} />
}

/** 关闭工作台里该类型的全部实例(主区 + 两侧),为反注册清场。 */
function closeLeafsOfType(type: string): void {
  const ws = useWorkspace.getState()
  for (const tab of ws.mainTabs) if (tab.type === type) ws.closeLeaf(tab.id)
  ws.closeSideView('left', type)
  ws.closeSideView('right', type)
}

let installed = false

/** 装一次:接 viewOpener + 把 views 切片持续同步进 LCL 注册表。 */
export function syncPluginViews(): void {
  if (installed) return
  installed = true

  usePluginStore.getState().setViewOpener((type) => {
    useWorkspace.getState().openView(type, {}, 'main')
  })

  const registered = new Map<string, ViewContribution>()
  const sync = (): void => {
    const next = new Map<string, ViewContribution>()
    for (const o of usePluginStore.getState().views) {
      next.set(`plugin:${o.pluginId}:${o.item.id}`, o.item)
    }
    for (const [type] of registered) {
      if (!next.has(type)) {
        closeLeafsOfType(type)
        unregisterView(type)
        registered.delete(type)
      }
    }
    for (const [type, def] of next) {
      if (registered.has(type)) continue
      registered.set(type, def)
      registerView({
        type,
        displayName: () => def.title,
        factory: () => <PluginViewHost def={def} />,
        singleton: def.singleton !== false,
        closable: true,
      })
    }
  }
  sync()
  usePluginStore.subscribe((s, p) => { if (s.views !== p.views) sync() })
}
