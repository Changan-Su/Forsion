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
import { registerView, unregisterView, useWorkspace, getActiveSpace, getView, showInMainPanel, type ViewProps } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { recordDevMountError } from '@amadeus/plugins/devRecords'
import { setDevViewBridge } from '@amadeus/plugins/devSandbox'
import type { ViewContribution } from '@amadeus/plugins/types'
import { registerMessages, translate } from './i18n'

registerMessages({
  'pluginview.mountFailed': { zh: '插件视图加载失败(见控制台)', en: 'Plugin view failed to load (see console)' },
})

/** DOM-mount 宿主:div 交给插件的 mount(),卸载时跑其返回的清理函数。
 *  导出给 builtins/muse 的主槽复用:Muse Space 主区渲染 agent-muse 插件的 home 视图时走的就是这份契约。
 *  `pluginId` 只在经插件命名空间注册时有(见下方 factory);带上它,挂载失败才能按插件记账 —— 控制台里
 *  那行 `[plugin-view] mount failed` 谁都看得见,但开发者看不见「是我的插件炸的」。 */
export const PluginViewHost: React.FC<ViewProps & { def: ViewContribution; pluginId?: string }> = ({ def, pluginId, extendView, leaf, params }) => {
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
    const kind = windowKind()
    const isMini = kind === 'mini'
    const isFloating = kind === 'floating' || !!el.closest('.floating-panel-window')
    try {
      cleanup = def.mount(el, {
        extendView, surface: isMini ? 'mini' : isFloating ? 'floating' : 'main',
        getParams: () => { check(); return { ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params) } },
        setParams: (patch) => { check(); current.current.leaf.setParams({ ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params), ...patch }) },
        onParamsChanged: (listener) => { check(); listeners.current.add(listener); return () => { listeners.current.delete(listener) } },
        showInMainPanel: isMini ? () => {
          check()
          const space = getActiveSpace()
          if (space?.mini) showInMainPanel({ spaceId: space.id, type: space.mini.mainView.type,
            params: { ...space.mini.mainView.params, ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params) } })
        } : isFloating ? () => {
          check()
          const params = { ...(useWorkspace.getState().leafById(current.current.leaf.id)?.params ?? current.current.params) }
          if (window.tangu?.showMainPanel) window.tangu.showMainPanel({ type: current.current.leaf.type, params })
          else useWorkspace.getState().openView(current.current.leaf.type, params, 'main')
        } : undefined,
      })
    } catch (e) {
      console.error(`[plugin-view] mount "${def.id}" failed`, e)
      if (pluginId) recordDevMountError(pluginId, def.id, e)
      el.textContent = translate('pluginview.mountFailed')
    }
    return () => {
      alive = false
      listeners.current.clear()
      try { if (typeof cleanup === 'function') cleanup() } catch (e) { console.error(`[plugin-view] cleanup "${def.id}" failed`, e) }
      el.replaceChildren()
    }
  }, [def, pluginId, extendView])
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

  // Forsion Sandbox 的热重载接缝:插件宿主(平台中立)不 import @lcl,工作台的读写由桌面壳在这里注入。
  // 枚举走 remapLeaves —— 它是**唯一**同时覆盖活 leaf 与收起侧栏 stash 的跨 store 接口(全返回 undefined
  // = 一个 leaf 都不动,纯只读);停靠位从两侧的 tab 类型反查(remapLeaves 会把 __loc 摘掉)。
  setDevViewBridge({
    snapshot: (prefix) => {
      const ws = useWorkspace.getState()
      const side = new Map<string, 'left' | 'right'>()
      for (const t of ws.leftTabs) side.set(t.type, 'left')
      for (const t of ws.rightTabs) side.set(t.type, 'right')
      const out: Array<{ type: string; params: Record<string, unknown>; loc: 'main' | 'left' | 'right' }> = []
      ws.remapLeaves((type, params) => {
        if (type.startsWith(prefix)) out.push({ type, params: { ...params }, loc: side.get(type) ?? 'main' })
        return undefined
      })
      return out
    },
    isRegistered: (type) => !!getView(type),
    open: (type, params, loc) => {
      // ⚠️主区必须显式 newTab:openView 的主区默认是**就地导航**(替换当前活动 leaf)。teardown 刚把插件
      // 自己那个 leaf 关掉,活动 leaf 于是变成了开发者的 Studio / 代码标签页 —— 不带 newTab,一次热重载
      // 就把 Studio 原地换成了预览(而且两个主区视图时,第二个还会把第一个顶掉)。侧栏那条按同侧同类型
      // 复用,不受这条默认影响。
      useWorkspace.getState().openView(type, params, loc, loc === 'main' ? { newTab: true } : undefined)
    },
    // 恢复焦点:重开的 leaf 会自动前置,于是每次(尤其是自动)热重载都把开发者从 Studio 抢到预览上。
    // 原本就停在预览上的情况天然正确 —— 那个 leaf 已被关掉,leafById 找不到,不恢复。
    captureFocus: () => {
      const id = useWorkspace.getState().mainTabs.find((t) => t.front)?.id
      if (!id) return null
      return () => {
        const ws = useWorkspace.getState()
        if (ws.leafById(id)) ws.activateLeaf(id)
      }
    },
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
        factory: (props) => <PluginViewHost def={def} pluginId={type.split(':')[1]} {...props} />,
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
