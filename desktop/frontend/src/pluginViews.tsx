import { syncIntelligentSources } from './services/intelligentCardCatalog'
import { windowKind } from './windowKind'
import { amadeusAvailable } from './features/runtime'
/**
 * 插件视图桥:pluginStore.views(平台中立的 DOM-mount 契约)→ LCL 视图注册表。
 * 桌面差异全部收在这里(与 amadeusPlugins.ts 同款纪律,vendored pluginStore 不 import @lcl):
 *  - 注册名统一命名空间 `plugin:<pluginId>:<viewId>`(Space 的 requires.views 用同名声明);
 *  - 插件禁用 → 先关掉该类型的所有开着的 leaf(主区按 mainTabs,侧栏两侧 closeSideView),再反注册
 *    ——Dockview 的 components map 收缩时不能留活面板;
 *  - ctx.openView 经 pluginStore.viewOpener 钩子指到 workspace.openView(主区 / 侧栏 / 底部面板;移动端无底部)。
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { Puzzle, type LucideIcon } from 'lucide-react'
import { registerView, unregisterView, useWorkspace, getActiveSpace, getView, showInMainPanel, type ViewProps } from '@lcl/engine'
import { notePluginGesture, usePluginStore } from '@amadeus/plugins/pluginStore'
import { recordDevMountError } from '@amadeus/plugins/devRecords'
import { setDevViewBridge } from '@amadeus/plugins/devSandbox'
import type { ViewContribution } from '@amadeus/plugins/types'
import { PLUGIN_ICONS } from '@amadeus/components/icons'
import { registerMessages, translate } from './i18n'

registerMessages({
  'pluginview.mountFailed': { zh: '插件视图加载失败（见控制台）', en: 'Plugin view failed to load (see console)' },
})

/** DOM-mount 宿主:div 交给插件的 mount(),卸载时跑其返回的清理函数。
 *  导出给 builtins/muse 的主槽复用:Muse Space 主区渲染 agent-muse 插件的 home 视图时走的就是这份契约。
 *  `pluginId` 只在经插件命名空间注册时有(见下方 factory);带上它,挂载失败才能按插件记账 —— 控制台里
 *  那行 `[plugin-view] mount failed` 谁都看得见,但开发者看不见「是我的插件炸的」。
 *  `onMountError`:挂载抛错时额外通知调用方(Muse Space 主槽拿它回写给 Muse);走 ref,换了回调身份不重挂。 */
export const PluginViewHost: React.FC<ViewProps & { def: ViewContribution; pluginId?: string; onMountError?: (e: unknown) => void }> = ({ def, pluginId, onMountError, extendView, leaf, params }) => {
  const ref = useRef<HTMLDivElement>(null)
  const onError = useRef(onMountError)
  onError.current = onMountError
  const disposeBeforePaint = useRef<(() => void) | null>(null)
  const current = useRef({ leaf, params })
  current.current = { leaf, params }
  const listeners = useRef(new Set<(params: Readonly<Record<string, unknown>>) => void>())
  useLayoutEffect(() => { for (const notify of listeners.current) notify(params) }, [params])
  // 插件视图读写库内路径(ctx.app.readFile / listFiles…),而库是惰性恢复的:只有左栏工作区、聊天、Agent Desk 这些
  // 宿主会唤醒它。用户直接停在插件 Space(启动即在、刷新、从主页点进来)时谁都不唤醒 → 插件读到空、写被拒
  // 「No vault is open」(2026-10-02 视频工作室 0.8 × 主页启动缺省,真 Electron 抓到)。与 WorkspaceView 同一处方;
  // 动态 import:amadeusPlugins 静态引了本文件(syncPluginViews)。
  useEffect(() => { if (amadeusAvailable()) void import('./amadeusPlugins').then((m) => m.ensureAmadeusReady()) }, [])
  // Plugin views may own Electron webviews/canvases. Passive effect cleanup can run
  // after the first paint of the next Space, leaving the old surface visible briefly.
  // Keep mounting passive, but dispose the live surface during React's unmount commit.
  useLayoutEffect(() => () => { disposeBeforePaint.current?.() }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cleanup: (() => void) | void
    let alive = true
    const check = (): void => { if (!alive) throw new Error('View has been disposed') }
    const kind = windowKind()
    const isMini = kind === 'mini'
    const isFloating = kind === 'floating' || !!el.closest('.floating-panel-window')
    // 记下「用户刚在这个插件的视图里点过 / 按过键」(捕获阶段、只认 isTrusted):ctx.agent.updateTodo 的手势闸只认它
    const gestureEvents = ['pointerdown', 'click', 'keydown'] as const
    const onGesture = (e: Event): void => { if (e.isTrusted && pluginId) notePluginGesture(pluginId) }
    for (const t of gestureEvents) el.addEventListener(t, onGesture, true)
    const fail = (e: unknown): void => {
      console.error(`[plugin-view] mount "${def.id}" failed`, e)
      if (pluginId) recordDevMountError(pluginId, def.id, e)
      onError.current?.(e)
      el.textContent = translate('pluginview.mountFailed')
    }
    const runCleanup = (fn: () => void): void => {
      // 也派给窗口 error:agent 自建 Space 的清理抛错由 builtins/agentSpaceSync 按栈帧认领、回写给 agent(别的插件只多一行日志)
      try { fn() } catch (e) { console.error(`[plugin-view] cleanup "${def.id}" failed`, e); globalThis.reportError?.(e) }
    }
    try {
      const mounted = def.mount(el, {
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
      // async mount(`async mount(el) { await load(); …; return () => … }`,agent 自建 Space 常这么写):Promise 不是函数,
      // 从前被当成「没有清理」—— 每次切回视图订阅 / 监听多挂一份,异步里抛的错也只剩控制台一行、不回写。
      // 现在:resolve 出的函数就是清理(视图已卸载就当场调用);reject 与同步抛错同一条失败路径(已卸载的不报)。
      if (mounted && typeof (mounted as PromiseLike<unknown>).then === 'function') {
        (mounted as PromiseLike<unknown>).then(
          (d) => { if (typeof d !== 'function') return; if (alive) cleanup = d as () => void; else runCleanup(d as () => void) },
          (e) => { if (alive) fail(e) },
        )
      } else cleanup = mounted as (() => void) | void
    } catch (e) {
      fail(e)
    }
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      alive = false
      listeners.current.clear()
      for (const t of gestureEvents) el.removeEventListener(t, onGesture, true)
      if (typeof cleanup === 'function') runCleanup(cleanup)
      el.replaceChildren()
    }
    disposeBeforePaint.current = dispose
    return () => { dispose(); if (disposeBeforePaint.current === dispose) disposeBeforePaint.current = null }
  }, [def, pluginId, extendView])
  return <div ref={ref} style={{ height: '100%', overflow: 'auto' }} />
}

/** 关闭工作台里该类型的全部实例,为反注册清场。
 *  ⚠️改用引擎的 closeViewsOfType(以 api.panels 为准):原来手写 `mainTabs + left + right` 三处枚举,
 *  加了底部面板之后会漏掉停在 bottom 的实例 —— 插件被禁用后它的 cleanup 不跑、UI 继续活着,而且这个
 *  已反注册的类型留在持久化布局里,下次启动 layoutViewsAllRegistered 判定失败 → **整份布局丢回默认**。 */
/** 当前 workspace store 有底部面板(Dockview 壳)。单列 store 没有 bottomVisible 这一位 —— 移动构建把整个选择器
 *  换成单列 store,所以只能运行时实判,不能 import 一个常量(换掉的模块里没有它)。 */
export const hasBottomPanel = (): boolean => 'bottomVisible' in useWorkspace.getState()

/** 插件视图的标签图标:图标词表里的名字(ViewContribution.icon)按 Lucide 的调用形(size / className)包一层;
 *  没写、或词表里没有 → 通用拼图。⚠️侧栏的标签只有图标没有名字,不给图标就是一个看不见、点不到的空标签 ——
 *  固定 View 让插件视图在侧栏分标签(导航 + 素材区)之后才暴露出来,2026-10-03 Video Studio 真机截图抓到。 */
function viewIcon(name: string | undefined): LucideIcon {
  const Glyph = name ? PLUGIN_ICONS[name] : undefined
  if (!Glyph) return Puzzle
  return (({ size, className }: { size?: number; className?: string }) => <Glyph width={size} height={size} className={className} />) as unknown as LucideIcon
}

function closeLeafsOfType(type: string): void {
  useWorkspace.getState().closeViewsOfType(type, true) // 反注册清场:固定 View 也得关(类型都没了)
}

let installed = false

/** 装一次:接 viewOpener + 把 views 切片持续同步进 LCL 注册表。 */
export function syncPluginViews(): void {
  if (installed) return
  installed = true

  // 底部面板只有主窗的 Dockview 壳有:按 store 实判,别看 UI_MODE —— 安卓原生构建经 vite engineSwap 换上单列 store,
  // UI_MODE 却可能仍是 desktop;Mini / 浮窗 / 拖出的独立窗也没有。没有时 bottom 回落右抽屉(同 Extend View 的约定),
  // 也不对插件宣称有 bottom;卫星窗只宣称主区。
  const main = windowKind() === 'main'
  const hasBottom = main && hasBottomPanel()
  usePluginStore.getState().setViewOpener((type, loc) => {
    // P2:放开停靠位(此前写死 'main',插件 view 进侧栏只能靠 space.json 声明)。2026-10-02 起含底部面板。
    const at = loc === 'left' || loc === 'right' ? loc : loc === 'bottom' ? (hasBottom ? 'bottom' : 'right') : 'main'
    useWorkspace.getState().openView(type, {}, at)
  }, !main ? ['main'] : hasBottom ? ['main', 'left', 'right', 'bottom'] : ['main', 'left', 'right'])
  // 关 / 换自己的视图(ctx.closeView / ctx.replaceView):两种 store 都有这两个方法,卫星窗只有一个主区,同样照办。
  usePluginStore.getState().setViewControls({
    close: (type) => useWorkspace.getState().closeViewsOfType(type),
    replace: (from, to, params) => useWorkspace.getState().replaceViewsOfType(from, to, params),
  })

  // Forsion Sandbox 的热重载接缝:插件宿主(平台中立)不 import @lcl,工作台的读写由桌面壳在这里注入。
  // 枚举走 remapLeaves —— 它是**唯一**同时覆盖活 leaf 与收起侧栏 stash 的跨 store 接口(全返回 undefined
  // = 一个 leaf 都不动,纯只读);停靠位从两侧的 tab 类型反查(remapLeaves 会把 __loc 摘掉)。
  setDevViewBridge({
    snapshot: (prefix) => {
      const ws = useWorkspace.getState()
      const side = new Map<string, 'left' | 'right' | 'bottom'>()
      for (const t of ws.leftTabs) side.set(t.type, 'left')
      for (const t of ws.rightTabs) side.set(t.type, 'right')
      // 底部面板没有 tab 投影:展开着的按 __loc 认,收起的在 stash 里(漏掉 = 热重载把底部视图开进主区)
      for (const p of ws.api?.panels ?? []) {
        const q = (p.params ?? {}) as Record<string, unknown>
        if (q.__loc === 'bottom' && typeof q.__type === 'string') side.set(q.__type, 'bottom')
      }
      for (const t of ws.stash.bottom) side.set(t.type, 'bottom')
      const out: Array<{ type: string; params: Record<string, unknown>; loc: 'main' | 'left' | 'right' | 'bottom' }> = []
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
        icon: viewIcon(def.icon),
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
  syncIntelligentSources(usePluginStore.getState().listSources)
  usePluginStore.subscribe((s, p) => {
    if (s.views !== p.views) sync()
    if (s.listSources !== p.listSources) syncIntelligentSources(s.listSources)
  })
}
