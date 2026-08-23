// Dev-only 编辑器 harness(npm run web → http://localhost:5173/harness.html):
// 真浏览器裸挂 MarkdownBlock,给 Playwright 自动化实测 slash / markdown 触发层用。
// window.__harness 暴露块状态供断言;不进产物(electron-vite build 只打 index.html)。
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './harnessBridge' // ⚠️须早于任何拉到 amadeus/api 的 import(见该文件)
import './styles/base.css'
import './amadeus-host.css'
import './amadeus/styles.css'
import { MarkdownBlock } from './amadeus/blocks/markdown/MarkdownBlock'
import { AskStringHost } from './amadeus/components/askString'
import { DeleteAssetsHost } from './amadeus/components/askDeleteAssets'
import type { FocusPlace } from './amadeus/blocks/registry'
import { PageView } from './amadeus/components/PageView'
import { AmadeusPluginFileView } from './views/AmadeusPluginFileView'
import { AmadeusDashboardView } from './views/AmadeusDashboardView'
import { usePluginStore } from './amadeus/plugins/pluginStore'
import { applyTheme as applyRealTheme } from './theme/loader'
import { resolveInitialLang, resolveInitialSkin } from './theme/registry'
import { setLocaleGlobal } from './i18n'
import { Square } from 'lucide-react'
import './i18n.generated'
import { ModelPill } from './components/ModelPill'
import './views/chat2/composer2.css'
import { Ribbon } from '@lcl/engine/Ribbon'
import { WorkspaceHost } from '@lcl/engine/WorkspaceHost'
import { addRibbonIcon, installHotkeys, recordNav, registerView, useNav, useRibbonStore, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import '@lcl/engine/engine.css'
import { usePageStore, pageStoreFor } from './amadeus/store/pageStore'
import { QuickFind, useQuickFind } from './quickFind'
import { PAGE_SCHEMA } from '@amadeus-shared/compiler/types'
import ExcalidrawCanvas from './amadeus/blocks/excalidraw/ExcalidrawCanvas'
import { DEFAULT_BOARD, type BoardSettings } from '@amadeus-shared/excalidraw/board'
import { UnifiedSpikeHarness } from './amadeus/unified/UnifiedSpike'
import { SEG_SLOT } from './amadeus/unified/CanvasModeSeg'
import { useUiOverlay } from './amadeusOverlayStore'

// ExcalidrawEmbed 平时干这件事;harness 直挂画布,得自己设(否则字体去 CDN 拉,CSP 拦)。
;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', document.baseURI).href

type B = { id: string; content: string }
let nextId = 1

// harness 调试/断言用:暴露 store,供 Playwright 注入任意 manifest(如两栏布局)验证块间方向键落点。
;(window as unknown as { __pageStore: typeof usePageStore }).__pageStore = usePageStore

/** 插件注入口 `window.__ep`:默认壳(v3 编辑器)与 `?upage`(v4 统一编辑器)两处都要 ——
 *  块表面仪器要在**真 v4 笔记**上验插件看到的东西,而那只有 ?upage 里有。走的是真 setup 路径
 *  `new Function('ctx', code)`,与生产的外置插件同一条。见 scripts/plugin-blocksurface.check.cjs。 */
function installPluginInjector(): void {
  ;(window as unknown as { __ep: Record<string, unknown> }).__ep = {
    loadPlugin(code: string, meta?: { id?: string; name?: string }) {
      usePluginStore.getState().init([
        {
          id: meta?.id || 'harness-plugin',
          name: meta?.name || meta?.id || 'harness-plugin',
          version: 'harness',
          setup: (ctx) => {
            const fn = new Function('ctx', code) as (c: unknown) => unknown
            const d = fn(ctx)
            return typeof d === 'function' ? (d as () => void) : undefined
          },
        },
      ])
    },
    active: () => usePluginStore.getState().activeIds.slice(),
    /** 插件自绘的设置面板(ctx.registerSettingsView)。台架没有插件详情页,e2e 自己挂一次 ——
     *  面板里嵌的是真 CodeMirror,那半只有真 DOM 验得了(check.mjs 里是拿不到的)。 */
    settingsViews: () => usePluginStore.getState().settingsViews.map((o) => o.item),
  }
}

function Harness() {
  // ?seed=<md> 种入首块内容,供 Playwright 验证「加载既有 markdown 的解析/往返」(如自定义 HTML 标记)。
  const seed = new URLSearchParams(location.search).get('seed') ?? ''
  // ?anchor=<文本>:模拟「从源码模式切回来」带过来的光标锚点,验证落点(见 amadeus/lib/modeCursor)。
  const anchor = new URLSearchParams(location.search).get('anchor') ?? undefined
  const [blocks, setBlocks] = useState<B[]>([{ id: 'b0', content: seed }])
  const [focus, setFocus] = useState<{ id: string; place: FocusPlace; anchor?: string } | null>({ id: 'b0', place: 'end' })
  ;(window as unknown as { __harness: { blocks: B[] } }).__harness = { blocks }

  const patch = (id: string, content: string): void =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, content } : b)))
  const insertAfter = (id: string, content = ''): void => {
    const nb = { id: `b${nextId++}`, content }
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id)
      const c = bs.slice()
      c.splice(i + 1, 0, nb)
      return c
    })
    setFocus({ id: nb.id, place: 'end' })
  }
  const remove = (id: string): void => setBlocks((bs) => (bs.length > 1 ? bs.filter((b) => b.id !== id) : bs))
  // 与 pageStore.mergeWithPrev 同形:内容并进前一块(相邻两行)、删掉自己、焦点落前一块末尾。
  // 丝滑光标的「合并后光标留在原地」实报只能在这条路径上量到(scripts/caret-merge.check.cjs)。
  const mergePrev = (id: string): void =>
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id)
      if (i <= 0) return bs
      const prev = bs[i - 1]
      const merged = prev.content && bs[i].content ? `${prev.content}\n${bs[i].content}` : prev.content + bs[i].content
      // 与 store 同形:落在接缝处(前块原内容之后),不是合并后整块末尾。
      if (prev.content && bs[i].content) setFocus({ id: prev.id, place: 'start', anchor: prev.content.slice(-40) })
      else setFocus({ id: prev.id, place: 'end' })
      return bs.map((b) => (b.id === prev.id ? { ...b, content: merged } : b)).filter((b) => b.id !== id)
    })

  return (
    /* am-app 是 Amadeus 视图根:少了它 `.am-app .slash-menu` 那套作用域样式(含 position:fixed)
       全都不生效,浮层定位类断言会假绿。见 scripts/overlay-zoom.check.cjs。 */
    <div className="amadeus-root am-app" style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
      {blocks.map((b) => (
        <MarkdownBlock
          key={b.id}
          blockId={b.id}
          content={b.content}
          pagePath="Harness.md"
          onChange={(md) => patch(b.id, md)}
          onInsertAfter={(md) => insertAfter(b.id, md ?? '')}
          onDeleteEmpty={() => remove(b.id)}
          onMergePrev={() => mergePrev(b.id)}
          onArrowOut={() => {}}
          onMoveDir={() => {}}
          // 带 anchor 时 place 固定 'start' —— 与生产的 requestFocusAt 一致(锚点找不到就停在块首)
          focusPlace={focus?.id === b.id ? (anchor || focus.anchor ? 'start' : focus.place) : null}
          focusAnchor={focus?.id === b.id ? (focus.anchor ?? anchor) : undefined}
          onFocused={() => setFocus(null)}
          requestSelfFocus={(place) => setFocus({ id: b.id, place })}
          onOpenWiki={() => {}}
          getPageNames={() => []}
        />
      ))}
      <pre data-harness-dump style={{ fontSize: 11, opacity: 0.6, whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(blocks, null, 1)}
      </pre>
      {/* 行内工具栏的「链接」按钮要弹 askString 输入框,宿主没挂这个 Host 就永远看不到弹窗。 */}
      <AskStringHost />
    </div>
  )
}

// ── ?dnd 模式:真 PageView + 真 pageStore,种 3 个全宽 text 块(单行单列 = 真实页面形态),
//    供 Playwright 驱动真拖拽验证「块级左右分栏」落点判定(scripts/block-dnd.e2e.cjs)。
//    web 无 window.amadeus:save() 内部 throw 被 catch,只置 error,不影响布局断言。
function DndHarness() {
  const manifest = usePageStore((s) => s.manifest)
  ;(window as unknown as { __dndRoot: unknown }).__dndRoot = manifest?.root
  return (
    <div className="amadeus-root am-app" style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <PageView bare />
    </div>
  )
}

// ── ?mindmap 模式:真 pageStore + 真插件宿主 + **外置思维导图插件的真产物**,种 3 个真块 + 关系图。
//    2026-07-26 起思维导图是外置捆绑包,不再是宿主代码 —— 所以这里验的是**整条接缝**:插件经
//    new Function 装载 → registerFileType → 通用插件文件视图挂载 → 插件用 ctx.app.mountBlocks 让
//    宿主把真 <BlockHost> 渲进它的卡片。插件产物由 e2e 脚本注入(见 __mm.loadPlugin),harness 本身
//    不与插件仓库有任何构建期耦合。无需 electron/IPC。见 scripts/mindmap.e2e.cjs。
const MM_FILE = 'Harness.mindmap.md'

function MindmapHarness() {
  const loaded = usePluginStore((s) => s.activeIds.length > 0)
  const leaf = { id: 'mm-harness', params: { filePath: MM_FILE }, setTitle: () => {} }
  return (
    <div className="amadeus-root am-app tangu-lovable" data-mode="light" style={{ position: 'fixed', inset: 0 }}>
      {loaded ? <AmadeusPluginFileView {...({ leaf, params: leaf.params } as unknown as ViewProps)} /> : <div>等待注入插件产物…</div>}
    </div>
  )
}

// ── ?canvasplug 模式:与 ?mindmap 同构,验外置**画布**插件(forsion-plugin-canvas)的整条接缝:
//    new Function 装载 → registerFileType('.canvas.md') → 插件文件视图 → ctx.app.mountBlocks 真块卡片。
//    种 3 个真块(b1/b2 已放置、b3 未放置)+ 1 条连线 + 1 个矩形。见 scripts/canvas.e2e.cjs。
const CV_FILE = 'Harness.canvas.md'

function CanvasPlugHarness() {
  const loaded = usePluginStore((s) => s.activeIds.length > 0)
  const leaf = { id: 'cv-harness', params: { filePath: CV_FILE }, setTitle: () => {}, setParams: () => {} }
  return (
    <div className="amadeus-root am-app tangu-lovable" data-mode="light" style={{ position: 'fixed', inset: 0 }}>
      {loaded ? <AmadeusPluginFileView {...({ leaf, params: leaf.params } as unknown as ViewProps)} /> : <div>等待注入插件产物…</div>}
    </div>
  )
}

// ── ?plugview 模式:通用外置插件视图台架。真插件宿主(new Function('ctx', code))+ 真 ctx +
//    真 UI 壳(.amadeus-root.am-app + 真 theme/loader.applyTheme,深浅可切),把插件 registerView 注册的视图挂进来。
//    ⚠️容器**不带 .tangu-lovable**:那是旧 LCL 词表层(选择子 [data-skin='lovable'|'echo'…] 在现行
//    registry 里永不命中),挂上它等于把一整套**浅色** token 钉死在容器上 —— 深色档量到的低对比是假的。
//    与 ?mindmap 的区别:那个专验块表面 seam,这个不认识任何具体插件 —— 任意插件的 main.js 注进来
//    就能截图/点按/切语言,是「插件也要过真机 UIUX」这条纪律的仪器。见 scripts/plugin-view.e2e.cjs。
function PlugViewHarness() {
  const views = usePluginStore((s) => s.views)
  const [mode, setMode] = useState<'light' | 'dark'>('light')
  const [viewId, setViewId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    applyRealTheme(resolveInitialLang(), resolveInitialSkin(), 'light')
    const w = window as unknown as { __pv: Record<string, unknown> }
    w.__pv = {
      ...(w.__pv ?? {}),
      // 明暗/配色必须走真 applyTheme:token 的选择子是 <html> 上的 [data-theme]×[data-skin]×.dark,
      // 只给容器加 data-mode 只能拿到半套变量(= 假的低对比告警)。
      setMode: (m: 'light' | 'dark') => { applyRealTheme(resolveInitialLang(), resolveInitialSkin(), m); setMode(m) },
      setSkin: (skin: string, m?: 'light' | 'dark') => { applyRealTheme(resolveInitialLang(), skin, m ?? mode); setNonce((n) => n + 1) },
      /** 切语言:走真广播(ctx.subscribeLocale)。**刻意不重挂视图** —— 界面要跟着变,
       *  靠的必须是插件自己订了语言变更,而不是台架替它重建 DOM。 */
      setLocale: (l: 'zh' | 'en') => setLocaleGlobal(l),
      open: (id: string) => { setViewId(id); setNonce((n) => n + 1) },
      remount: () => setNonce((n) => n + 1),
      /** 插件到底贡献了什么(断言「SPEC 点名的贡献点齐全」用)。 */
      contributions: () => {
        const s = usePluginStore.getState()
        return {
          views: s.views.map((o) => ({ pluginId: o.pluginId, id: o.item.id, title: o.item.title })),
          commands: s.commands.map((o) => ({ id: o.item.id, title: o.item.title })),
          slashItems: s.slashItems.map((o) => ({ id: o.item.id, label: o.item.label })),
          settings: s.settings.map((o) => ({ key: o.item.key, label: o.item.label, type: o.item.type })),
          statusItems: s.statusItems.map((o) => ({ id: o.item.id, text: o.item.text })),
          fileTypes: s.fileTypes.map((o) => ({ id: o.item.id, extensions: o.item.extensions })),
          fileCreators: s.fileCreators.map((o) => ({ id: o.item.id, label: o.item.label })),
        }
      },
      run: (commandId: string) => {
        const c = usePluginStore.getState().commands.find((o) => o.item.id === commandId)
        if (!c) throw new Error(`no such command: ${commandId}`)
        c.item.run()
      },
    }
  }, [])

  // 插件注进来后自动开第一个视图(单视图插件的常见情况,e2e 不必先问 id)
  useEffect(() => {
    if (!viewId && views.length) setViewId(views[0].item.id)
  }, [views, viewId])

  useEffect(() => {
    const el = hostRef.current
    const v = views.find((o) => o.item.id === viewId)
    if (!el || !v) return
    el.textContent = ''
    let cleanup: (() => void) | void
    try {
      cleanup = v.item.mount(el)
    } catch (e) {
      ;(window as unknown as { __pvError?: string }).__pvError = String(e)
      throw e
    }
    return () => {
      try { cleanup?.() } catch (e) { console.error('[plugview] cleanup failed', e) }
    }
  }, [views, viewId, nonce])

  return (
    <div
      className="amadeus-root am-app"
      data-mode={mode}
      style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      <div ref={hostRef} data-tag="pv-host" style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />
      <AskStringHost />
    </div>
  )
}

// ── ?dashboard 模式:真 AmadeusDashboardView + 真 pageStore + 真 BlockHost,种一张 3 卡片的仪表盘。
//    纯逻辑(格子几何 / frontmatter 编解码 / 冲突判定)已由 shared/amadeus/dashboard.test.ts 钉死;
//    这里钉的是**单测看不见的那一层**:CSS Grid 把 [x,y,w,h] 摆到哪里、指针位移换算成几格、
//    「压到别人就回弹」在真 DOM 上成不成立、锁定态到底锁没锁住编辑。见 scripts/dashboard.check.cjs。
const DASH_FILE = 'Harness.dashboard.md'

/** ?dashboard 里那张 view 卡片装的东西:一个真·注册视图。露出拿到的 leaf.params,并提供一个
 *  会调 leaf.setParams 的按钮 —— 仪器据此验「视图改了 params 会不会写回卡片源码」。 */
function DashViewProbe({ leaf }: ViewProps) {
  const n = Number(leaf.params.n ?? 0)
  return (
    <div data-tag="dashv" data-params={JSON.stringify(leaf.params)} data-leaf={leaf.id} style={{ padding: 12 }}>
      <button data-act="bump" onClick={() => leaf.setParams({ ...leaf.params, n: n + 1 })}>bump {n}</button>
    </div>
  )
}

function DashHarness() {
  // leaf.id 必须是 MAIN_SCOPE('main'):视图子树经 PageScopeCtx 取自己那份 store,给别的 id
  // 会拿到一个**空的新 store**,harness 种下去的 manifest 根本不在里面。
  const [params, setParams] = useState<Record<string, unknown>>({ dashPath: DASH_FILE, locked: true })
  const leaf = { id: 'main', params, setTitle: () => {}, setParams: (p: Record<string, unknown>) => setParams(p) }
  return (
    <div className="amadeus-root am-app tangu-lovable" data-mode="light" style={{ position: 'fixed', inset: 0 }}>
      <AmadeusDashboardView {...({ leaf, params } as unknown as ViewProps)} />
    </div>
  )
}

// ── ?board 模式:真 <Excalidraw> + 真的纸张/网格层。合成页复刻不出的三件事只有这里量得到:
//    ① 两层到底有没有挂进 .excalidraw(它首帧渲染的是 LoadingMessage,挂载时机是个真坑);
//    ② 指针落点与场景坐标对不对得上(光标偏移);③ 纸张钳制在真视口上的行为。
//    纯逻辑归 shared/amadeus/excalidraw/board.test.ts,CSS 契约归 scripts/board-paper.check.cjs。
function BoardHarness() {
  const [settings, setSettings] = useState<BoardSettings>({ ...DEFAULT_BOARD })
  // 深色档要能切:网格层在深色下换的是 mix-blend-mode(multiply → screen),而混合的结果只有截图看得见。
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    // 合并式:仪器只传改动的字段,别因为漏写新字段把设置打成 undefined
    ;(window as unknown as { __board: unknown }).__board = {
      setSettings: (patch: Partial<BoardSettings>) => setSettings((s) => ({ ...s, ...patch })),
      setTheme,
    }
  }, [])
  return (
    <div className="am-app tangu-lovable amx-pane amx-drawview" data-mode={theme} data-flat="0" style={{ position: 'fixed', inset: 0 }}>
      <div className="amx-draw">
        <ExcalidrawCanvas
          initialData={{ elements: [], appState: { viewBackgroundColor: '#ffffff' } }}
          theme={theme}
          langCode="en"
          settings={settings}
          onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          onSceneChange={(json: string) => {
            ;(window as unknown as { __scene: unknown }).__scene = JSON.parse(json)
          }}
        />
      </div>
    </div>
  )
}

// ── ?ribbon 模式:真 Ribbon + 真 ribbonRegistry,上下两区各种几个图标,供 Playwright 驱动真 HTML5
//    拖拽验证落点(scripts/ribbon-dnd.e2e.cjs)。落点数学是纯函数(lcl slotIndexAt,单测已钉),
//    这里钉的是**DOM 接线**:组级 dragover 算出的下标 → 让位预览 → drop 提交,三者是不是同一个。
function RibbonHarness() {
  return (
    <div className="am-app tangu-lovable" data-mode="light" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <Ribbon />
    </div>
  )
}

// ── ?dock 模式:真 WorkspaceHost + 真 Dockview + 真 dockviewStore.toggleSidebar。
//    验的是「展侧栏时主区到底发生了什么」——纯函数单测看不见的 DOM 接线层:主区面板有没有被
//    Dockview 摘下来重挂(= 用户报的「像重新加载闪一遍」)、主区宽度有没有在一帧里暴缩再弹回。
//    window.__dock.mounts 计主区视图的挂载次数;__dock.mainW() 读主区组当前宽。见 scripts/main-remount.check.cjs。
function DockHarness() {
  return (
    <div className="am-app tangu-lovable" data-mode="light" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <WorkspaceHost dark={false} soft={false} buildDefault={() => useWorkspace.getState().openView('mainv', {}, 'main')} />
    </div>
  )
}

// ?caret:装真的丝滑光标覆盖层(默认不装 —— 别的断言不需要它,装了徒增噪音)。
// 产品默认已翻成「关」,故仪器必须**显式开**,否则 check:caretmerge 量不到覆盖层。
if (new URLSearchParams(location.search).has('caret')) {
  void import('./smoothCaret').then((m) => { m.installSmoothCaret(); m.setSmoothCaretEnabled(true) })
}

if (new URLSearchParams(location.search).has('dock')) {
  // ⚠️必须按 tag 分开计:两个视图共用一个 Body 时,展侧栏本身就会 +1,主区「重挂」就成了假阳性。
  const probe = {
    mounts: {} as Record<string, number>,
    mainW: () => 0,
    toggle: (side: 'left' | 'right') => useWorkspace.getState().toggleSidebar(side),
    // 多标签契约(scripts/chat-multitab.check.cjs):singleton 视图碰上显式 newTab 必须让路。
    // 用 singlev 这个只在仪器里注册的单例视图验引擎本身,不必拖上真 chat 的后端依赖。
    open: (type: string, params: Record<string, unknown> = {}, newTab = false): string | null =>
      useWorkspace.getState().openView(type, params, 'main', newTab ? { newTab: true } : undefined)?.id ?? null,
    panels: (): Array<{ id: string; type?: string; params: Record<string, unknown> }> =>
      (useWorkspace.getState().api?.panels ?? []).map((p) => {
        const params = (p.params ?? {}) as Record<string, unknown>
        return { id: p.id, type: params.__type as string | undefined, params }
      }),
    // per-tab 导航史(scripts/nav-history.check.cjs)。navv 视图的 label 参数当「页面」,restore 只碰
    // 自己那个 leaf —— 真 chat/笔记要后端和库,进不了这个仪器,但引擎那层(每 tab 一份栈、箭头打谁、
    // 异步 restore 期间的重记闸)与产品完全同一份代码。restore 故意异步:真 restore 是 loadPage。
    nav: {
      visit: (leafId: string, label: string): void => {
        const put = (): Promise<void> => {
          useWorkspace.getState().leafById(leafId)?.setParams({ label })
          return new Promise((r) => setTimeout(r, 40))
        }
        void put()
        recordNav(leafId, `p:${label}`, put)
      },
      split: (): string | null => useWorkspace.getState().splitActive('right')?.id ?? null,
      activate: (leafId: string): void => useWorkspace.getState().activateLeaf(leafId),
      stack: (leafId: string): { keys: string[]; idx: number } => {
        const st = useNav.getState().stacks[leafId]
        return { keys: st?.entries.map((e) => e.key) ?? [], idx: st?.idx ?? -1 }
      },
      labels: (): Record<string, string> => Object.fromEntries(
        (useWorkspace.getState().api?.panels ?? []).map((p) => [p.id, String((p.params as { label?: unknown } | undefined)?.label ?? '')]),
      ),
      /** 「同一个 View 里就地换文件」= 只改身份参数。导航历史/最近使用两条订阅都挂在 mainTabs 的
       *  引用变化上,所以这一步必须惊动 mainTabs(2026-08-20 用户实报:此前整片看不见)。 */
      setParams: (leafId: string, p: Record<string, unknown>): void => {
        useWorkspace.getState().leafById(leafId)?.setParams(p)
      },
      onTabs: (cb: () => void): (() => void) =>
        useWorkspace.subscribe((s, prev) => { if (s.mainTabs !== prev.mainTabs) cb() }),
    },
  }
  ;(window as unknown as { __dock: typeof probe }).__dock = probe
  // 内容量必须真实:空 div 重排不要钱,量不出「展侧栏时主区卡一下」。主区喂长文(每段长度不同,
  // 才会真的逐帧重新折行),侧栏喂一坨行(模拟文件树/会话列表那种不便宜的挂载)。
  const lines = (n: number, seed: number): string[] =>
    Array.from({ length: n }, (_, i) => '词'.repeat(20 + ((i * seed) % 60)) + ` #${i}`)
  const Body: React.FC<{ tag: string; rows: string[] }> = ({ tag, rows }) => {
    // 计数放 effect 而非渲染期:StrictMode 双渲染不会虚计,真挂载才 +1。
    useEffect(() => { probe.mounts[tag] = (probe.mounts[tag] ?? 0) + 1 }, [tag])
    return (
      <div className="dockh-body" data-tag={tag} style={{ padding: 12, overflow: 'auto', height: '100%' }}>
        {rows.map((s, i) => <p key={i} style={{ margin: '0 0 10px' }}>{s}</p>)}
      </div>
    )
  }
  for (const [type, name, n, seed] of [['mainv', 'main', 400, 7], ['sidev', 'side', 200, 3]] as const) {
    const rows = lines(n, seed)
    registerView({ type, displayName: name, icon: Square, factory: () => <Body tag={name} rows={rows} /> })
  }
  // 单例视图替身(真 chat 要后端才有会话,进不了这个仪器)——验的是 openView 里 singleton × newTab 那条闸。
  registerView({ type: 'singlev', displayName: 'single', icon: Square, singleton: true, factory: () => <Body tag="single" rows={lines(10, 5)} /> })
  // 导航史用的「页面」替身:参数 label 即当前页,后退/前进改的就是它(断言直接读 DOM,不信 store 自证)。
  registerView({ type: 'navv', displayName: 'nav', icon: Square, factory: ({ params }) => (
    <div className="navv" data-label={String(params.label ?? '')} style={{ padding: 12 }}>{String(params.label ?? '')}</div>
  ) })
  useWorkspace.setState({ sidebarDefaults: { left: [{ type: 'sidev', params: {} }], right: [{ type: 'sidev', params: {} }] } })
  probe.mainW = () => {
    const p = useWorkspace.getState().api?.panels.find((x) => ((x.params ?? {}) as { __loc?: string }).__loc === 'main')
    return (p as unknown as { group?: { api?: { width?: number } } } | undefined)?.group?.api?.width ?? 0
  }
  createRoot(document.getElementById('root')!).render(<DockHarness />)
} else if (new URLSearchParams(location.search).has('qf')) {
  // ⌘P 快切面板裸挂:分类条(全部/笔记/文件/会话)与 ←/→ 切换的真键盘路径 + 一张真截图。
  // 库内容用内存表顶替(pageStore 是同一个 store,setState 即生效);会话表走 appStore。
  const qfDark = new URLSearchParams(location.search).has('dark')
  applyRealTheme(resolveInitialLang(), resolveInitialSkin(), qfDark ? 'dark' : 'light')
  usePageStore.setState({
    pages: ['月度计划.md', '子夹/会议纪要.md', 'MOC-Forsion.md'],
    files: ['报告.pdf', '图/照片.png', '库.db', '画板.excalidraw.md'],
  })
  useQuickFind.getState().openPalette()
  createRoot(document.getElementById('root')!).render(<QuickFind />)
} else if (new URLSearchParams(location.search).has('ribbon')) {
  // 点击记账:mod+1..9 的 slot 分发靠它断言(见 ribbon-dnd.e2e.cjs 的 L 组)。
  const hits: string[] = []
  ;(window as unknown as { __rbHits: string[] }).__rbHits = hits
  const mk = (id: string, side: 'top' | 'bottom', name: string): void =>
    addRibbonIcon({ id, side, icon: Square, tooltip: () => name, onClick: () => hits.push(id) })
  for (const n of ['A', 'B', 'C', 'D']) mk(`t${n}`, 'top', `Top ${n}`)
  for (const n of ['A', 'B', 'C']) mk(`b${n}`, 'bottom', `Bot ${n}`)
  useRibbonStore.setState({ order: ['tA', 'tB', 'tC', 'tD'], bottomOrder: ['bA', 'bB', 'bC'] })
  installHotkeys() // 裸挂 Ribbon 没有 Shell,热键分发得自己装
  // 快捷键提示的符号按 data-platform 走(宿主启动时写);仪器钉死 mac 一路,断言才不看 CI 跑在什么系统上。
  document.documentElement.dataset.platform = 'mac'
  ;(window as unknown as { __rb: typeof useRibbonStore }).__rb = useRibbonStore
  createRoot(document.getElementById('root')!).render(<RibbonHarness />)
} else if (new URLSearchParams(location.search).has('modelpill')) {
  // 模型 / Effort 菜单:真组件裸挂,肉眼/截图核对三行结构与 Max 特效(几何契约由 scripts/model-menu.check.cjs 钉)。
  const modelPillParams = new URLSearchParams(location.search)
  const modelPillMode = modelPillParams.has('dark') ? 'dark' : 'light'
  if (modelPillParams.has('glass')) applyRealTheme('genesis-glass', resolveInitialSkin(), modelPillMode)
  else if (modelPillMode === 'dark') {
    document.documentElement.dataset.mode = 'dark'
    document.documentElement.classList.add('dark')
  }
  const GROUPS = [
    { label: 'zhipu', options: [{ id: 'glm-4.7', name: 'GLM-4.7' }, { id: 'glm-4.6', name: 'GLM-4.6' }, { id: 'glm-air', name: 'GLM-4.5-Air' }] },
    { label: 'deepseek', options: [{ id: 'ds-v32', name: 'DeepSeek-V3.2-Exp' }, { id: 'ds-r1', name: 'DeepSeek-R1' }] },
  ]
  const PillHarness = (): React.ReactElement => {
    const [id, setId] = useState('glm-4.7')
    const [lv, setLv] = useState<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>(new URLSearchParams(location.search).has('max') ? 'max' : 'high')
    const [defaults, setDefaults] = useState({ backgroundModelId: '', imageModelId: '', visionModelId: '' })
    const modelsResponse = {
      models: [
        { id: 'glm-4.7', name: 'GLM-4.7', provider: 'zhipu', source: 'direct' as const, modelType: 'llm' as const, supportsVision: true },
        { id: 'glm-4.6', name: 'GLM-4.6', provider: 'zhipu', source: 'direct' as const, modelType: 'llm' as const, supportsVision: false },
        { id: 'ds-v32', name: 'DeepSeek-V3.2-Exp', provider: 'deepseek', source: 'forsion' as const, modelType: 'llm' as const },
        { id: 'gpt-image-1', name: 'GPT Image 1', provider: 'openai', source: 'forsion' as const, modelType: 'image_gen' as const },
      ],
      directProviders: [], defaultModelId: 'glm-4.7', backgroundModelId: 'ds-v32', imageModelId: 'gpt-image-1', visionModelId: 'glm-4.7',
    }
    return (
      <div className="am-app tangu-lovable" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 24 }}>
        <div className="t2c-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="t2c-pill">模式</button>
          <ModelPill
            modelId={id}
            groups={GROUPS}
            onSelect={setId}
            thinkingLevel={lv}
            onThinkingChange={setLv}
            modelsResponse={modelsResponse}
            defaultModelIds={defaults}
            onDefaultModelChange={(slot, modelId) => setDefaults((d) => ({ ...d, [slot]: modelId }))}
          />
        </div>
      </div>
    )
  }
  createRoot(document.getElementById('root')!).render(<PillHarness />)
} else if (new URLSearchParams(location.search).has('dashboard')) {
  const iso = new Date().toISOString()
  registerView({ type: 'dashv', displayName: 'Dash Probe', icon: Square, factory: (p) => <DashViewProbe {...p} /> })
  usePageStore.setState({
    activePage: DASH_FILE,
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-dash',
      title: 'Dash Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: '1' }, { ref: '2' }, { ref: '3' }, { ref: '4' }] }] }],
      },
      blocks: { 1: { type: 'markdown' }, 2: { type: 'markdown' }, 3: { type: 'markdown' }, 4: { type: 'markdown' } },
      // 天气卡片要联网,harness 里不放(网络断言不是这支仪器的活儿)。
      // 卡片4(view)刻意摆在最右下角:D4/D6 会把卡片2/3 挪来挪去,压上就成了「回弹」而不是被测行为。
      fmExtra: ['tags: [harness]', 'dashboard:', '  "1": [0, 0, 8, 6]', '  "2": [8, 0, 5, 4]', '  "3": [0, 6, 6, 4]', '  "4": [16, 6, 6, 4]'].join('\n'),
    },
    blocks: {
      1: { id: '1', type: 'markdown', content: '第一张卡片' },
      2: { id: '2', type: 'markdown', content: '```clock\ntz: Asia/Shanghai\n```' },
      3: { id: '3', type: 'markdown', content: '第三张卡片' },
      4: { id: '4', type: 'markdown', content: '```view\ntype: dashv\nn: 1\n```' },
    },
  })
  createRoot(document.getElementById('root')!).render(<DashHarness />)
} else if (new URLSearchParams(location.search).has('board')) {
  createRoot(document.getElementById('root')!).render(<BoardHarness />)
} else if (new URLSearchParams(location.search).has('mindmap')) {
  const iso = new Date().toISOString()
  const mm = JSON.stringify({ b2: { p: 'b1' }, b3: { p: 'b1' } }) // b2/b3 是 b1 的子节点
  // 2026-08-14 seam scope 化:真宿主(AmadeusPluginFileView)会给插件发绑定 `plug:<leaf.id>` 作用域的
  // per-view surface —— 台架必须把状态种进**那个 scope 的 store**,种门面等于种给别人(插件读不到)。
  const mmStore = pageStoreFor('plug:mm-harness')
  mmStore.setState({
    activePage: 'Harness.mindmap.md',
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-mm',
      title: 'MM Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: [
          { type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }, { ref: 'b2' }, { ref: 'b3' }] }] },
        ],
      },
      blocks: { b1: { type: 'markdown' }, b2: { type: 'markdown' }, b3: { type: 'markdown' } },
      fmExtra: `mindmap: '${mm}'`,
    },
    blocks: {
      b1: { id: 'b1', type: 'markdown', content: '中心节点' },
      b2: { id: 'b2', type: 'markdown', content: '子节点甲' },
      b3: { id: 'b3', type: 'markdown', content: '子节点乙' },
    },
  })
  ;(window as unknown as { __mm: unknown }).__mm = {
    store: mmStore,
    /** e2e 注入外置插件的构建产物(main.js 原文)。走的是真 setup 路径:new Function('ctx', code)。 */
    loadPlugin(code: string) {
      usePluginStore.getState().init([
        {
          id: 'mindmap',
          name: '思维导图',
          version: 'harness',
          setup: (ctx) => {
            const fn = new Function('ctx', code) as (c: unknown) => unknown
            const d = fn(ctx)
            return typeof d === 'function' ? (d as () => void) : undefined
          },
        },
      ])
    },
  }
  createRoot(document.getElementById('root')!).render(<MindmapHarness />)
} else if (new URLSearchParams(location.search).has('canvasplug')) {
  const iso = new Date().toISOString()
  // 同 ?mindmap:状态种进 per-view scope(plug:cv-harness),走真宿主发的 surface。
  const cvStore = pageStoreFor('plug:cv-harness')
  const cvfm = JSON.stringify({
    v: 1,
    n: { b1: { x: 40, y: 40 }, b2: { x: 420, y: 60, w: 340 } }, // b3 刻意不放置(验「未放置列」)
    e: [{ a: 'b1', b: 'b2', label: '关联' }],
    s: [{ id: 's1', t: 'rect', x: 40, y: 300, w: 200, h: 100 }],
  })
  cvStore.setState({
    activePage: CV_FILE,
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-cv',
      // 复现真实管线形态:导入的插件文件 title 就是带复合段的 'Harness.canvas' ——
      // NoteTitle 若被 manifest.title 短路,e2e 的「标题无后缀残段」断言才抓得到(评审 P1 假绿教训)。
      title: 'Harness.canvas',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: [
          { type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }, { ref: 'b2' }, { ref: 'b3' }] }] },
        ],
      },
      blocks: { b1: { type: 'markdown' }, b2: { type: 'markdown' }, b3: { type: 'markdown' } },
      // 哨兵键:fmExtra 是公共空间,画布的每次外科写都不许动别人的键(用户手写的 + 其它插件的)。
      // e2e 尾部逐字断言这两行幸存 —— 没有哨兵,整对象重写类回归会假绿(Codex P2)。
      fmExtra: `custom_note: 用户手写的键要幸存\nother_plugin: '{"keep":1}'\ncanvas: '${cvfm}'`,
    },
    blocks: {
      b1: { id: 'b1', type: 'markdown', content: '中心卡片' },
      b2: { id: 'b2', type: 'markdown', content: '第二卡片' },
      b3: { id: 'b3', type: 'markdown', content: '游离卡片' },
    },
  })
  ;(window as unknown as { __cv: unknown }).__cv = {
    store: cvStore,
    /** e2e 注入外置插件的构建产物(main.js 原文)。走的是真 setup 路径:new Function('ctx', code)。 */
    loadPlugin(code: string) {
      usePluginStore.getState().init([
        {
          id: 'canvas',
          name: '画布',
          version: 'harness',
          setup: (ctx) => {
            const fn = new Function('ctx', code) as (c: unknown) => unknown
            const d = fn(ctx)
            return typeof d === 'function' ? (d as () => void) : undefined
          },
        },
      ])
    },
  }
  createRoot(document.getElementById('root')!).render(<CanvasPlugHarness />)
} else if (new URLSearchParams(location.search).has('plugview')) {
  // 种一页真块:插件若用块表面(getPage/mountBlocks/insertBlockAfter)在台架里也成立。
  const iso = new Date().toISOString()
  usePageStore.setState({
    activePage: 'Harness.md',
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-pv',
      title: 'PlugView Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: { type: 'stack', children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }] }] }] },
      blocks: { b1: { type: 'markdown' } },
      fmExtra: '',
    },
    blocks: { b1: { id: 'b1', type: 'markdown', content: '台架页首块' } },
  })
  ;(window as unknown as { __pv: Record<string, unknown> }).__pv = {
    /** e2e 注入外置插件的构建产物(main.js 原文)。走的是真 setup 路径:new Function('ctx', code)。
     *  一次页面加载只装一个插件(pluginStore.init 有 initialized 闸)—— e2e 每个插件开一页。 */
    loadPlugin(code: string, meta?: { id?: string; name?: string }) {
      usePluginStore.getState().init([
        {
          id: meta?.id || 'harness-plugin',
          name: meta?.name || meta?.id || 'harness-plugin',
          version: 'harness',
          setup: (ctx) => {
            const fn = new Function('ctx', code) as (c: unknown) => unknown
            const d = fn(ctx)
            return typeof d === 'function' ? (d as () => void) : undefined
          },
        },
      ])
    },
  }
  createRoot(document.getElementById('root')!).render(<PlugViewHarness />)
} else if (new URLSearchParams(location.search).has('embed')) {
  // ── ?embed 模式:真 PageView + 真 BlockHost,种几个嵌入块(图片 / PDF / 未知文件)。
  //    验的是块级「查看源码」`</>`:悬停浮现 → 点击进 EmbedSourceLine → 失焦复渲染。
  //    行内那半(公式 / 行内图片)在默认 harness 里验。见 scripts/source-toggle.check.cjs。
  const iso = new Date().toISOString()
  usePageStore.setState({
    activePage: 'Harness.md',
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-embed',
      title: 'Embed Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: [
          { type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'e1' }, { ref: 'e2' }, { ref: 'e3' }] }] },
        ],
      },
      blocks: { e1: { type: 'markdown' }, e2: { type: 'markdown' }, e3: { type: 'markdown' } },
    },
    blocks: {
      e1: { id: 'e1', type: 'markdown', content: '![[pic.png]]' },
      e2: { id: 'e2', type: 'markdown', content: '![[report.pdf]]' },
      e3: { id: 'e3', type: 'markdown', content: '普通文字块(不该有 </> 按钮)' },
    },
  })
  createRoot(document.getElementById('root')!).render(<DndHarness />)
} else if (new URLSearchParams(location.search).has('fold')) {
  // ── ?fold 模式:真 PageView,种「H1 / 正文 / H2 / 正文 / H1」五块。
  //    ⚠️ 每块**各自一行** —— 标题折叠是**行级**的(PageView 按 root.children 逐行判定,
  //    取每行首块的标题级别),全塞进一行只会得到一行、零个折叠箭头。
  //    验的是:标题行才有箭头;折 H1 吃到下一个 H1 前;折 H2 只吃它自己那段;状态落 localStorage。
  //    见 scripts/editor-triggers.e2e.cjs 的 T37。
  const iso = new Date().toISOString()
  const refs = ['f1', 'f2', 'f3', 'f4', 'f5']
  usePageStore.setState({
    activePage: 'Harness.md',
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness-fold',
      title: 'Fold Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: refs.map((ref, i) => ({
          type: 'row' as const,
          id: `r${i + 1}`,
          columns: [{ id: `c${i + 1}`, width: 1, children: [{ ref }] }],
        })),
      },
      blocks: Object.fromEntries(refs.map((r) => [r, { type: 'markdown' as const }])),
    },
    blocks: {
      f1: { id: 'f1', type: 'markdown', content: '# 一级标题' },
      f2: { id: 'f2', type: 'markdown', content: '一级下的正文' },
      f3: { id: 'f3', type: 'markdown', content: '## 二级标题' },
      f4: { id: 'f4', type: 'markdown', content: '二级下的正文' },
      f5: { id: 'f5', type: 'markdown', content: '# 另一个一级标题' },
    },
  })
  createRoot(document.getElementById('root')!).render(<DndHarness />)
} else if (new URLSearchParams(location.search).has('upage')) {
  // ── ?upage 模式:UnifiedPage 生产组件全链(读 → 编辑 → 防抖落盘 → 外部回灌事务)。
  //    window.amadeus 的四个面用内存 vault 顶替 —— harnessBridge 的对象是可变的,api.ts
  //    抓的是同一引用。见 scripts/unified-page.check.cjs。
  const g = window as unknown as { amadeus?: Record<string, unknown> }
  /** 被嵌入那篇的正文。两段 —— 只有一段的话「嵌入体被当成主卡」那条几何断言分不出来。 */
  const EMBED_MD = '被嵌入的第一段。\n\n被嵌入的第二段。\n'
  const vault = new Map<string, string>()
  const seedMd = new URLSearchParams(location.search).get('useed') ?? '# 外来标题\n\n第一段。\n\n第二段。\n'
  vault.set('Unified.md', seedMd)
  vault.set('Embedded.md', EMBED_MD)
  const writes: Array<{ path: string; text: string }> = []
  const listeners = new Set<(p: string) => void>()
  Object.assign(g.amadeus ?? (g.amadeus = {}), {
    readTextFile: (p: string) => Promise.resolve(vault.get(p) ?? null),
    writeTextFile: (p: string, text: string) => {
      vault.set(p, text)
      writes.push({ path: p, text })
      return Promise.resolve()
    },
    onExternalChange: (cb: (p: string) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    saveAttachment: () => Promise.reject(new Error('harness: no attachments')),
    // 跨笔记嵌入:只认 `Embedded` 这一篇(嵌入体里会长出**第二个** Milkdown 实例 —— 画布模式
    // 的主卡样式泄漏就是被它接住的,见 unified-canvas C71)。其余目标一律「未解析」,
    // unified-page 的「嵌入丢失」壳靠的正是这条,别改成无条件返回内容。
    resolveEmbed: (target: string) =>
      Promise.resolve(
        target.trim() === 'Embedded'
          ? { owner: 'Embedded.md', content: EMBED_MD, type: 'markdown' }
          : null,
      ),
    renamePageFile: (p: string, next: string) => {
      const dir = p.split('/').slice(0, -1).join('/')
      const np = (dir ? dir + '/' : '') + next + '.md'
      if (np !== p) {
        vault.set(np, vault.get(p) ?? '')
        vault.delete(p)
      }
      return Promise.resolve(np)
    },
  })
  // 生产里 activeNotePath 由编辑器 leaf 写(v4 不设 activePage,只读面板与插件块表面全靠它取路径)。
  // 台架站它的位 —— 不写的话块表面在 ?upage 下恒报「没打开笔记」,仪器验的就成了另一回事。
  usePageStore.getState().setActiveNotePath('Unified.md')
  installPluginInjector()
  const upageProbe: Record<string, unknown> = {}
  ;(window as unknown as { __upage: unknown }).__upage = {
    vault,
    writes,
    probe: upageProbe,
    fire(path: string, text: string) {
      vault.set(path, text)
      for (const cb of listeners) cb(path)
    },
    // 源码/可视模式开关(P16 源码 textarea 撑高仪器):生产里在 uiOverlayStore,这里透传。
    setEditorMode(m: 'wysiwyg' | 'source') {
      void import('./amadeusOverlayStore').then(({ useUiOverlay }) => useUiOverlay.setState({ editorMode: m }))
    },
  }
  void import('./amadeus/unified/UnifiedPage').then(({ UnifiedPage }) => {
    // 改名重挂载宿主壳:镜像 amadeusViews 的 leaf 行为(onRenamed → 换参数,实例随 key 重建)。
    // ⚠️ 顶栏胶囊必须拿**宿主自己的笔记路径**喂 CanvasModeSeg —— 生产传的是 `barPath`,组件内
    //    要拿它跟 store 自报的 path 比对。第一版图省事把 store 的 path 又喂回去,那道闸就恒真:
    //    「切到另一篇却显示上一篇的模式」「路径对不上导致胶囊不显示」两类真 bug 一个都测不到。
    function UPageHost({ file }: { file?: string }): React.ReactElement {
      const [st, setSt] = useState({ path: file ?? 'Unified.md', initial: vault.get(file ?? 'Unified.md') ?? seedMd })
      // ⚠️ `&udelay` = **顶栏晚于编辑器到场**的时序(用户 2026-08-18 实报:开机还原到一篇 md 笔记时
      //    胶囊必不显示,点过别的笔记才出来)。生产里顶栏整块挂在 `barPath` 这道门后面,而 barPath
      //    要等一次异步分类才落定 —— 也就是说**插槽可能比 UnifiedPage 晚出现**。默认壳是两者同时到,
      //    这一档专门把插槽推后,钉 CanvasSegPortal 的 MutationObserver 那条路(不然它就是死代码)。
      const [barReady, setBarReady] = useState(!new URLSearchParams(location.search).has('udelay'))
      useEffect(() => {
        if (barReady) return
        const t = setTimeout(() => setBarReady(true), 120)
        return () => clearTimeout(t)
      }, [barReady])
      return (
        <>
          {barReady && (
            <div className="amx-toolbar">
              <span className={SEG_SLOT} />
              <button className="amx-mode-btn" type="button">⋯</button>
            </div>
          )}
          <UnifiedPage
            key={st.path}
            path={st.path}
            initial={st.initial}
            probe={upageProbe}
            onRenamed={(np) => setSt({ path: np, initial: vault.get(np) ?? '' })}
          />
          <AskStringHost />{/* 画布元素文字编辑走 askString(双击形状/连线标签);不挂它,仪器测不到弹窗 */}
          <DeleteAssetsHost />{/* 删文件引用块时的「磁盘文件也删吗」;生产由 AmadeusOverlays 挂 */}
        </>
      )
    }
    // ── ?uscale=<k>[&ucards=2]:PM-under-transform Spike(Canvas 双模式方案 §7 go/no-go)。
    //    把生产 UnifiedPage 放进「画布卡片」的**稳态**形态:绝对定位 + 每卡自身 transform: scale(k)
    //    (§5 两段式在手势结束后就是这个样子)。验的是 scale 底下 posAtCoords / 把手定位 / 拖拽落点
    //    /IME 落字还成不成立 —— 现行补偿走 zoomOf(=currentCSSZoom),transform 不进那个量。
    //    见 scripts/unified-scale.check.cjs。
    const scale = Number(new URLSearchParams(location.search).get('uscale') ?? '')
    const cards = Number(new URLSearchParams(location.search).get('ucards') ?? '1') || 1
    if (scale > 0) {
      vault.set('Unified2.md', '# 二号卡\n\n卡二段一。\n\n卡二段二。\n')
      createRoot(document.getElementById('root')!).render(
        <div data-tag="stage" style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
          {Array.from({ length: cards }, (_, i) => (
            // 后一张 DOM 序在后 = 压在前一张上(重叠命中用);位移刻意让两卡有交叠区。
            <div
              key={i}
              data-tag="card"
              data-card={i}
              className="amadeus-root am-app"
              style={{
                position: 'absolute',
                // 位移刻意小:两卡要在**正文区**真交叠(仪器 S5 先证采样点同时落在两张卡里,
                // 位移大了就变成「相邻不重叠」,命中断言当场变假绿)。
                left: 40 + i * 60,
                top: 40 + i * 40,
                width: 640,
                padding: 16,
                background: 'var(--bg-0, #fff)',
                border: '1px solid #8884',
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
              }}
            >
              <UPageHost file={i ? 'Unified2.md' : 'Unified.md'} />
            </div>
          ))}
        </div>,
      )
      return
    }
    // ── &upane:**生产壳镜像**(2026-08-17)。默认那个 720px 居中盒子测不了画布满铺 ——
    //    满铺要脱出纸面铺满滚动容器 `.amx-pane`,而顶栏 `.amx-toolbar` 是 sticky 且必须**继续可点**
    //    (满铺层不许盖住它)。类名与 amadeusViews 的 EditorScope 一致。
    //    做成 opt-in 而不是改默认壳:`unified-page` / `unified-columns` 两套仪器也吃 ?upage,
    //    换掉默认纸面宽度会连带动它们的几何。
    const upane = new URLSearchParams(location.search).has('upane')
    createRoot(document.getElementById('root')!).render(
      upane ? (
        <div className="am-app tangu-lovable amx-pane amx-editor" data-mode="light" data-flat="0" style={{ position: 'fixed', inset: 0 }}>
          <UPageHost />
        </div>
      ) : (
        <div className="amadeus-root am-app" style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
          <UPageHost />
        </div>
      ),
    )
  })
} else if (new URLSearchParams(location.search).has('unified')) {
  // ── ?unified 模式:v4 统一实例 spike(整篇一个 Milkdown 实例,spec §9 step 1)。
  //    验三关:回灌=事务不重挂 / callout 整只带入+光标离开收回 / PM 原生 Enter=Notion 语义。
  //    种子经 ?useed=<md> 注入(别占 ?seed —— 默认 harness 用它)。见 scripts/unified-spike.check.cjs。
  createRoot(document.getElementById('root')!).render(<UnifiedSpikeHarness />)
} else if (new URLSearchParams(location.search).has('dnd')) {
  const iso = new Date().toISOString()
  usePageStore.setState({
    activePage: 'Harness.md',
    vaultRoot: '/harness',
    status: 'ready',
    manifest: {
      schema: PAGE_SCHEMA,
      id: 'harness',
      title: 'DnD Harness',
      createdAt: iso,
      updatedAt: iso,
      compiler: { version: 'harness' },
      root: {
        type: 'stack',
        children: [
          {
            type: 'row',
            id: 'r1',
            columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }, { ref: 'b2' }, { ref: 'b3' }] }],
          },
        ],
      },
      blocks: { b1: { type: 'markdown' }, b2: { type: 'markdown' }, b3: { type: 'markdown' } },
    },
    blocks: {
      b1: { id: 'b1', type: 'markdown', content: 'Alpha 第一段文本块' },
      b2: { id: 'b2', type: 'markdown', content: 'Beta 第二段文本块' },
      b3: { id: 'b3', type: 'markdown', content: 'Gamma 第三段文本块' },
    },
  })
  createRoot(document.getElementById('root')!).render(<DndHarness />)
} else {
  // 默认 harness = 真编辑器。顺带开一个插件注入口:**编辑器扩展类**插件(ctx.registerEditorExtension)
  // 没有 registerView,`?plugview` 那套挂不了它 —— 它要验的东西全在编辑器里(打字展开、按键接管、
  // 装饰渲染)。同 `?plugview`,走的是真 setup 路径 new Function('ctx', code)。
  // e2e 是页面加载完才注入的,那时编辑器已经建好 —— 靠的正是「扩展注册表代次变了就重建编辑器」
  // 这条机制(useEditor 的 deps 挂着代次)。所以注入后要等一拍再断言,别读到重建中途态。
  // 见 scripts/latex-suite.e2e.cjs。
  installPluginInjector()
  createRoot(document.getElementById('root')!).render(<Harness />)
}
