// 「块表面」seam(2026-07-26 起):把**真 Amadeus 块**开放给外置插件。
//
// 为什么需要它:此前内置插件与外置插件的能力**不对等** —— 内置插件跑在进程内、可以直接给 React
// 组件(于是能挂 <BlockHost>、渲染真块);外置插件是 `new Function('ctx', code)` 的裸 setup 体,
// 只有一个 DOM 元素可用,够不着 BlockHost 与它依赖的一堆宿主 store。结果就是「节点内是真块」这类
// 界面只能做进宿主 —— 这不是设计,是缺口。用户定的原则:**内置与外置的唯一区别是「提前装好了」**。
//
// 提供两样东西,合起来足以在插件里做出思维导图那种界面:
//   1. 页数据 API —— 页的块与结构操作(读/订阅/增删/焦点/撤销/外来 frontmatter 读写)。
//   2. `mountBlocks(el, …)` —— 宿主往插件给的 DOM 里渲染一个真 <BlockHost>:内容、编辑、slash、
//      `![[嵌入]]`、插件块全都原样跟随,插件不必也不该复刻编辑器。
//
// 绑定模型(2026-08-14 scope 化):
// - **不带 bind**(插件 ctx.app 上那份,每插件一个):跟随「活动面板」门面 —— 老模型,老插件不变。
// - **带 bind{store,scope}**(每个插件文件视图一份,由 AmadeusPluginFileView 创建):绑定该视图
//   自己的 pageStore 作用域,与编辑器面板并存互不抢页 —— 「同一时刻只能编辑一处」到此为止。
//   宿主的多面板 scope 机制(pageStoreFor/PageScopeCtx)本来就在,seam 挂在单页门面上才是自设限制。
//
// ⚠️ 这里是**信任边界**:调用方是第三方 JS,参数可能是任何东西,回调可能抛、可能是 async、可能重入,
// 也可能干脆忘了清理。所以本文件的纪律是(codex 评审后加固):
// - **每份 surface 可吊销**(不是全局单例):它自己开的订阅与挂载的 React root 都记在账上,
//   插件被禁用/重载/setup 抛错时宿主统一收干净,之后该 facade 的所有方法变 no-op —— 插件在飞的
//   异步任务不能再回来改用户的文件。
// - **改数据必须带页令牌**:块 id 是**页内**递增的(两页都有 `b1`),插件拿着 A 页的 id、页已换成
//   B 时继续提交,轻则把块插进 B、重则删掉 B 的同名块。令牌不匹配一律拒绝。scope 化后单个视图
//   通常不换页,但外部改名/重装页仍会换令牌 —— 纪律不放松。
// - **快照是冻结的**:派生表按引用缓存(每份 surface 一套),不冻住的话插件一句
//   `page.blocks.b1 = …` 就污染了后续读到的内容,还会把去重判据带偏。
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { DndContext, useSensors } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { usePageStore, PageScopeCtx, type PageStoreApi } from '../store/pageStore'
import { BlockHost, BlockSurfaceContext, type BlockSurface } from '../components/BlockHost'
import { askString } from '../components/askString'
import type { BlockSurfaceApi, PageSnapshot, MountBlockOptions } from './types'

/** surface 的数据源:不绑定 = 活动面板门面(facade),绑定 = 指定 scope 的 store。
 *  两者的 getState/subscribe 形状一致,门面会动态解析到当前活动面板。 */
export interface SurfaceBind {
  store: PageStoreApi
  scope: string
}

// ── 第三方回调的安全调用 ─────────────────────────────────────────────────────────
// 同步抛要接住;**async 回调抛更要接住** —— 它同步返回的是一个 Promise,try/catch 抓不到,
// 会变成全局 unhandledrejection(codex)。读 thenable 本身也可能抛(恶意 getter),一并包住。
function safeCall<A extends unknown[]>(what: string, fn: ((...a: A) => unknown) | undefined, ...args: A): void {
  if (typeof fn !== 'function') return
  try {
    const r = fn(...args)
    if (r && typeof (r as { then?: unknown }).then === 'function') {
      void Promise.resolve(r).catch((e: unknown) => console.error(`[amadeus] 插件 ${what} 异步抛错`, e))
    }
  } catch (e) {
    console.error(`[amadeus] 插件 ${what} 抛错`, e)
  }
}

/** 两份快照对插件而言是否等价(subscribePage 的去重判据;导出以便单测 —— 判错的代价是
 *  「插件整棵树每次按键都重渲」或者更糟的「块删了插件不知道」)。 */
export function samePage(a: PageSnapshot, b: PageSnapshot): boolean {
  return (
    a.token === b.token &&
    a.path === b.path && // token 已含路径,这条是冗余的安全带:令牌生成一旦出 bug,别静默变成「换页不通知」

    // `saving` 只是防抖保存的过程态,页面照常可用。不归一的话每编辑一次就多两轮通知
    // (ready→saving→ready),大插件视图整树白重渲两遍(codex)。
    liveStatus(a.status) === liveStatus(b.status) &&
    a.blocks === b.blocks && // 引用比较成立靠 contentMap 的按引用缓存,见 makeRuntime
    a.fmExtra === b.fmExtra &&
    a.order.length === b.order.length &&
    a.order.every((id, i) => id === b.order[i])
  )
}
const liveStatus = (s: string): string => (s === 'saving' ? 'ready' : s)

/** 每份 surface 一套的快照/令牌运行时(scope 化前是模块级单例 —— 单页模型的遗迹)。 */
function makeRuntime(bind?: SurfaceBind) {
  const src = bind?.store ?? usePageStore

  // 页令牌:`${路径}#${序号}`,序号在页路径每次变化时 +1 —— 只比路径不够:A→B→A 之后,插件手里
  // 那张第一次 A 时拿的旧快照又会「验证通过」,而那期间的块 id 早已易主。
  let pageSeq = 0
  let lastPath: string | null = src.getState().activePage
  const stopWatch = src.subscribe(() => {
    const p = src.getState().activePage
    if (p !== lastPath) {
      lastPath = p
      pageSeq++
    }
  })
  const currentToken = (): string => `${lastPath ?? ''}#${pageSeq}`

  // 派生表按**上游对象的引用**缓存:每次快照都新建 object 的话,subscribePage 的引用比较永远不等
  // → 插件每次 store 变动都整棵重渲。缓存冻结:插件写坏它,后续读到的全是假内容。
  let lastRawBlocks: unknown = null
  let lastContentMap: Readonly<Record<string, string>> = Object.freeze({})
  const contentMap = (raw: Record<string, { content: string }>): Readonly<Record<string, string>> => {
    if (raw === lastRawBlocks) return lastContentMap
    lastRawBlocks = raw
    lastContentMap = Object.freeze(Object.fromEntries(Object.entries(raw).map(([id, b]) => [id, b.content])))
    return lastContentMap
  }

  const snapshot = (): Readonly<PageSnapshot> => {
    const s = src.getState()
    return Object.freeze({
      token: currentToken(),
      path: s.activePage,
      status: s.status,
      blocks: contentMap(s.blocks),
      order: Object.freeze(s.flatOrder()) as readonly string[],
      fmExtra: s.manifest?.fmExtra ?? '',
    })
  }

  return { src, scope: bind?.scope ?? null, currentToken, snapshot, stopWatch }
}

// 一个容器只许有一个 React root。插件常「dispose 完立刻在同一个 el 上重挂」,而 unmount 推迟到
// microtask(React 18+ 不许在渲染周期里同步 unmount)—— 不认容器的话第二次 createRoot 会在仍被
// 标记为 root 的元素上再建一个,随后旧 root 的延迟 unmount 反过来把新挂载清掉(codex)。
const rootsByEl = new WeakMap<HTMLElement, { root: Root; gen: number }>()
let mountGen = 0

const isEl = (v: unknown): v is HTMLElement =>
  typeof HTMLElement !== 'undefined' ? v instanceof HTMLElement : !!v && typeof (v as HTMLElement).appendChild === 'function'

/** 往插件的 DOM 里挂一棵宿主 React 树(容器去重 + 代际校验 + microtask 延迟卸载三件套)。
 *  mountBlocks 与 mountNoteView(viewSurface)共用 —— 这套纪律漏一处就是「新挂载被旧 dispose 清掉」。 */
export function mountHostReact(el: HTMLElement, node: ReactNode): () => void {
  const gen = ++mountGen
  const existing = rootsByEl.get(el)
  const root = existing?.root ?? createRoot(el)
  rootsByEl.set(el, { root, gen })
  root.render(node)
  return () => {
    const cur = rootsByEl.get(el)
    if (!cur || cur.gen !== gen) return // 这个容器已经被新的挂载接管 → 本次 dispose 作废
    // ⚠️ 表项**不能**在这里同步删:React effect 的 cleanup→setup 同步连跑,同一 el 立即重挂时
    // 读不到 existing 就会在旧 root 仍挂载的容器上第二次 createRoot,而微任务里旧 root 的
    // unmount 又被新表项跳过 —— 旧树永久泄漏 + 同容器双 root(评审 P1,2026-08-14)。
    // 删除也推进微任务、按代际校验:同步重挂读到 existing → 复用同一 root 只换 render 内容。
    queueMicrotask(() => {
      if (rootsByEl.get(el)?.gen !== gen) return // 已被新挂载接管
      rootsByEl.delete(el)
      try {
        cur.root.unmount()
      } catch (e) {
        console.error('[amadeus] 卸载插件挂载树失败', e)
      }
    })
  }
}

/** BlockHost 硬依赖 dnd-kit 的 <DndContext>+<SortableContext>(内部 useSortable/useDroppable),
 *  不包就抛。**空 sensors** = dnd-kit 不启动拖拽,插件自己的指针逻辑不被抢走(思维导图卡片的拖动
 *  就是这么和块编辑器共存的)。scope 在场就多包一层 PageScopeCtx —— 块的读写全部落到该视图自己的
 *  作用域,而不是活动面板。 */
function MountedBlock({ blockId, surface, scope }: { blockId: string; surface: BlockSurface | null; scope: string | null }) {
  const sensors = useSensors()
  const inner = (
    <BlockSurfaceContext.Provider value={surface}>
      <DndContext sensors={sensors}>
        <SortableContext items={[blockId]}>
          <BlockHost blockId={blockId} />
        </SortableContext>
      </DndContext>
    </BlockSurfaceContext.Provider>
  )
  return scope ? <PageScopeCtx.Provider value={scope}>{inner}</PageScopeCtx.Provider> : inner
}

/** 建一份**属于某个插件**的块表面。返回 `revoke`:宿主在插件禁用/重载/setup 抛错(或视图卸载,
 *  scope 化的那份)时调用,收掉它开的全部订阅与 React root,并让后续调用整体变哑 —— 插件在飞的
 *  异步任务不能再改用户文件。 */
export function createBlockSurface(pluginId: string, bind?: SurfaceBind): { api: BlockSurfaceApi; revoke: () => void } {
  let alive = true
  const rt = makeRuntime(bind)
  const unsubs = new Set<() => void>()
  const mounts = new Set<() => void>()

  /** 活着吗?顺带把「插件卸载后还在调 API」这件事说出来(静默 no-op 会被当成宿主 bug 查半天)。 */
  const ok = (): boolean => {
    if (!alive) console.warn(`[amadeus] 插件 ${pluginId} 已停用,块表面调用被忽略`)
    return alive
  }
  /** 改数据前的闸:活着 + 页令牌匹配。令牌不对 = 页已经换了,这次提交会打到别的文件上。 */
  const guard = (token: unknown): boolean => {
    if (!ok()) return false
    if (String(token ?? '') !== rt.currentToken()) {
      console.warn(`[amadeus] 插件 ${pluginId} 的页令牌已过期(页已切换),本次改动被拒绝`)
      return false
    }
    return true
  }

  const api: BlockSurfaceApi = {
    getPage: () => rt.snapshot(),

    subscribePage(cb) {
      if (!ok()) return () => {}
      let prev = rt.snapshot()
      const off = rt.src.subscribe(() => {
        const next = rt.snapshot()
        if (samePage(prev, next)) return
        prev = next
        safeCall('subscribePage 回调', cb as (p: PageSnapshot) => unknown, next)
      })
      const dispose = (): void => {
        if (unsubs.delete(off)) off()
      }
      unsubs.add(off)
      return dispose
    },

    setFmExtra(token, text) {
      if (!guard(token)) return
      rt.src.getState().setFmExtra(String(text ?? ''))
    },

    insertBlockAfter(token, afterId, content) {
      if (!guard(token)) return null
      return rt.src.getState().insertBlockAfter(afterId ?? null, undefined, String(content ?? ''))
    },

    async deleteBlock(token, id) {
      if (!guard(token)) return
      await rt.src.getState().deleteBlock(String(id))
    },

    requestFocus(id, place) {
      if (!ok()) return
      rt.src.getState().requestFocus(String(id), place === 'start' ? 'start' : 'end')
    },

    consumeFocus(id) {
      if (!ok()) return
      rt.src.getState().consumeFocus(String(id))
    },

    undo(token) {
      if (!guard(token)) return
      rt.src.getState().undo()
    },

    redo(token) {
      if (!guard(token)) return
      rt.src.getState().redo()
    },

    prompt(title, initial, opts) {
      if (!ok()) return Promise.resolve(null)
      return askString(String(title ?? ''), initial ?? '', opts) // Electron 无 window.prompt
    },

    mountBlocks(el, opts) {
      if (!ok() || !isEl(el)) return () => {}
      const o = (opts ?? {}) as MountBlockOptions
      const blockId = String(o.blockId ?? '')
      if (!blockId || !guard(o.token)) return () => {}
      // 给了 onInsertAfter = 插件宣告接管结构(见文件头)。
      const surface: BlockSurface | null = o.onInsertAfter
        ? { insertAfter: (id, content) => safeCall('onInsertAfter', o.onInsertAfter, id, content) }
        : null
      const disposeRoot = mountHostReact(el, <MountedBlock blockId={blockId} surface={surface} scope={rt.scope} />)
      const dispose = (): void => {
        mounts.delete(dispose)
        disposeRoot()
      }
      mounts.add(dispose)
      return dispose
    },
  }

  return {
    api,
    revoke() {
      alive = false
      try { rt.stopWatch() } catch { /* ignore */ }
      for (const off of [...unsubs]) {
        unsubs.delete(off)
        try { off() } catch { /* ignore */ }
      }
      for (const d of [...mounts]) {
        try { d() } catch { /* ignore */ }
      }
      mounts.clear()
    },
  }
}
