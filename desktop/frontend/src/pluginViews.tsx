import { windowKind } from './windowKind'
/**
 * 插件视图桥:pluginStore.views(平台中立的 DOM-mount 契约)→ LCL 视图注册表。
 * 桌面差异全部收在这里(与 amadeusPlugins.ts 同款纪律,vendored pluginStore 不 import @lcl):
 *  - 注册名统一命名空间 `plugin:<pluginId>:<viewId>`(Space 的 requires.views 用同名声明);
 *  - 插件禁用 → 先关掉该类型的所有开着的 leaf(主区按 mainTabs,侧栏两侧 closeSideView),再反注册
 *    ——Dockview 的 components map 收缩时不能留活面板;
 *  - ctx.openView 经 pluginStore.viewOpener 钩子指到 workspace.openView(主区)。
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { registerView, unregisterView, useWorkspace, getActiveSpace, showInMainPanel, type ViewProps } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ViewContribution } from '@amadeus/plugins/types'
import { registerMessages, translate } from './i18n'

registerMessages({
  'pluginview.mountFailed': { zh: '插件视图加载失败(见控制台)', en: 'Plugin view failed to load (see console)' },
})

/** DOM-mount 宿主:div 交给插件的 mount(),卸载时跑其返回的清理函数。
 *  导出给 builtins/muse 的主槽复用:Muse Space 主区渲染 agent-muse 插件的 home 视图时走的就是这份契约。 */
export const PluginViewHost: React.FC<ViewProps & { def: ViewContribution }> = ({ def, extendView, leaf, params }) => {
  const ref = useRef<HTMLDivElement>(null)
  const current = useRef({ leaf, params })
  current.current = { leaf, params }
  const listeners = useRef(new Set<(params: Readonly<Record<string, unknown>>) => void>())
  useLayoutEffect(() => { for (const notify of listeners.current) notify(params) }, [params])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cleanup: (() => void) | void
    let alive = true
    const check = (): void => { if (!alive) throw new Error('View has been disposed') }
    const isMini = windowKind() === 'mini'
    try {
      cleanup = def.mount(el, {
        extendView, surface: isMini ? 'mini' : 'main',
        getParams: () => { check(); return { ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params) } },
        setParams: (patch) => { check(); current.current.leaf.setParams({ ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params), ...patch }) },
        onParamsChanged: (listener) => { check(); listeners.current.add(listener); return () => { listeners.current.delete(listener) } },
        showInMainPanel: isMini ? () => {
          check()
          const space = getActiveSpace()
          if (space?.mini) showInMainPanel({ spaceId: space.id, type: space.mini.mainView.type,
            params: { ...space.mini.mainView.params, ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params) } })
        } : undefined,
      })
    } catch (e) {
      console.error(`[plugin-view] mount "${def.id}" failed`, e)
      el.textContent = translate('pluginview.mountFailed')
    }
    return () => {
      alive = false
      listeners.current.clear()
      try { if (typeof cleanup === 'function') cleanup() } catch (e) { console.error(`[plugin-view] cleanup "${def.id}" failed`, e) }
      el.replaceChildren()
    }
  }, [def, extendView])
  return <div ref={ref} style={{ height: '100%', overflow: 'auto' }} />
}

/** 关闭工作台里该类型的全部实例,为反注册清场。
 *  ⚠️改用引擎的 closeViewsOfType(以 api.panels 为准):原来手写 `mainTabs + left + right` 三处枚举,
 *  加了底部面板之后会漏掉停在 bottom 的实例 —— 插件被禁用后它的 cleanup 不跑、UI 继续活着,而且这个
 *  已反注册的类型留在持久化布局里,下次启动 layoutViewsAllRegistered 判定失败 → **整份布局丢回默认**。 */
function closeLeafsOfType(type: string): void {
  useWorkspace.getState().closeViewsOfType(type)
}

let installed = false

/** 装一次:接 viewOpener + 把 views 切片持续同步进 LCL 注册表。 */
export function syncPluginViews(): void {
  if (installed) return
  installed = true

  usePluginStore.getState().setViewOpener((type, loc) => {
    // P2:放开停靠位(此前写死 'main',插件 view 进侧栏只能靠 space.json 声明)。
    useWorkspace.getState().openView(type, {}, loc === 'left' || loc === 'right' ? loc : 'main')
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
        kind: 'page', // 插件 view 无宿主可信的身份/文件声明,一律 page;embeddable 恒缺省 false(宿主白名单语义)
        displayName: () => def.title,
        factory: (props) => <PluginViewHost def={def} {...props} />,
        singleton: def.singleton !== false,
        closable: true,
        // P2 联动声明:插件内相对 id → 补全命名空间(type 形如 plugin:<pid>:<vid>,pid 取中段;
        // 只能指本插件自己的源 —— 前缀由宿主拼,插件写不了别家的)。
        workspaceSource: def.workspaceSource ? `plugin:${type.split(':')[1]}:${def.workspaceSource}` : undefined,
      })
    }
  }
  sync()
  usePluginStore.subscribe((s, p) => { if (s.views !== p.views) sync() })
}
