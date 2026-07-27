// 「块表面」seam(2026-07-26 起):把**真 Amadeus 块**开放给外置插件。
//
// 为什么需要它:此前内置插件与外置插件的能力**不对等** —— 内置插件跑在进程内、可以直接给 React
// 组件(于是能挂 <BlockHost>、渲染真块);外置插件是 `new Function('ctx', code)` 的裸 setup 体,
// 只有一个 DOM 元素可用,够不着 BlockHost 与它依赖的一堆宿主 store。结果就是「节点内是真块」这类
// 界面只能做进宿主 —— 这不是设计,是缺口。用户定的原则:**内置与外置的唯一区别是「提前装好了」**。
//
// 提供两样东西,合起来足以在插件里做出思维导图那种界面:
//   1. 页数据 API —— 活动页的块与结构操作(读/订阅/增删/焦点/撤销/外来 frontmatter 读写)。
//   2. `mountBlocks(el, …)` —— 宿主往插件给的 DOM 里渲染一个真 <BlockHost>:内容、编辑、slash、
//      `![[嵌入]]`、插件块全都原样跟随,插件不必也不该复刻编辑器。
//
// ⚠️ 这里是**信任边界**:调用方是第三方 JS,参数可能是任何东西,回调可能抛、可能是 async、可能重入,
// 也可能干脆忘了清理。所以本文件的纪律是(codex 评审后加固):
// - **每个插件一份可吊销的 facade**(不是全局单例):它自己开的订阅与挂载的 React root 都记在账上,
//   插件被禁用/重载/setup 抛错时宿主统一收干净,之后该 facade 的所有方法变 no-op —— 插件在飞的
//   异步任务不能再回来改用户的文件。
// - **改数据必须带页令牌**:块 id 是**页内**递增的(两页都有 `b1`),插件拿着 A 页的 id、用户已切到
//   B 页时继续提交,轻则把块插进 B、重则删掉 B 的同名块。令牌不匹配一律拒绝。
// - **快照是冻结的**:派生表按引用缓存且全插件共用,不冻住的话插件 A 一句 `page.blocks.b1 = …`
//   就污染了插件 B 读到的内容,还会把去重判据带偏。
// - 只服务**活动页**:Amadeus 是单活页模型(同一时刻只加载一处),插件跟着这个模型走,不给它开
//   第二份页面状态 —— 否则两份 store 会各自保存、互相覆盖。
import { createRoot, type Root } from 'react-dom/client'
import { DndContext, useSensors } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { usePageStore } from '../store/pageStore'
import { BlockHost, BlockSurfaceContext, type BlockSurface } from '../components/BlockHost'
import { askString } from '../components/askString'
import type { BlockSurfaceApi, PageSnapshot, MountBlockOptions } from './types'

// ── 页令牌 ───────────────────────────────────────────────────────────────────────
// `${路径}#${序号}`,序号在活动页每次变化时 +1 —— 只比路径不够:A→B→A 之后,插件手里那张
// 在第一次 A 时拿的旧快照又会「验证通过」,而那期间的块 id 早已易主。
let pageSeq = 0
let lastPath: string | null = null
let tokenWatchInstalled = false
function installTokenWatch(): void {
  if (tokenWatchInstalled) return
  tokenWatchInstalled = true
  lastPath = usePageStore.getState().activePage
  usePageStore.subscribe(() => {
    const p = usePageStore.getState().activePage
    if (p !== lastPath) {
      lastPath = p
      pageSeq++
    }
  })
}
const currentToken = (): string => `${lastPath ?? ''}#${pageSeq}`

// ── 快照 ─────────────────────────────────────────────────────────────────────────
// 插件看到的是 id→markdown 的扁平表(不暴露 BlockState 的内部形状)。派生表按**上游对象的引用**缓存:
// 每次快照都新建一个 object 的话,subscribePage 的引用比较永远不等 → 插件每次 store 变动都整棵重渲。
// 缓存是全插件共用的,所以必须冻结:一个插件写坏它,所有插件都读到假内容。
let lastRawBlocks: unknown = null
let lastContentMap: Readonly<Record<string, string>> = Object.freeze({})
function contentMap(raw: Record<string, { content: string }>): Readonly<Record<string, string>> {
  if (raw === lastRawBlocks) return lastContentMap
  lastRawBlocks = raw
  lastContentMap = Object.freeze(Object.fromEntries(Object.entries(raw).map(([id, b]) => [id, b.content])))
  return lastContentMap
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
    a.blocks === b.blocks && // 引用比较成立靠 contentMap 的缓存,见上
    a.fmExtra === b.fmExtra &&
    a.order.length === b.order.length &&
    a.order.every((id, i) => id === b.order[i])
  )
}
const liveStatus = (s: string): string => (s === 'saving' ? 'ready' : s)

function snapshot(): Readonly<PageSnapshot> {
  installTokenWatch()
  const s = usePageStore.getState()
  return Object.freeze({
    token: currentToken(),
    path: s.activePage,
    status: s.status,
    blocks: contentMap(s.blocks),
    order: Object.freeze(s.flatOrder()) as readonly string[],
    fmExtra: s.manifest?.fmExtra ?? '',
  })
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

/** BlockHost 硬依赖 dnd-kit 的 <DndContext>+<SortableContext>(内部 useSortable/useDroppable),
 *  不包就抛。**空 sensors** = dnd-kit 不启动拖拽,插件自己的指针逻辑不被抢走(思维导图卡片的拖动
 *  就是这么和块编辑器共存的)。 */
function MountedBlock({ blockId, surface }: { blockId: string; surface: BlockSurface | null }) {
  const sensors = useSensors()
  return (
    <BlockSurfaceContext.Provider value={surface}>
      <DndContext sensors={sensors}>
        <SortableContext items={[blockId]}>
          <BlockHost blockId={blockId} />
        </SortableContext>
      </DndContext>
    </BlockSurfaceContext.Provider>
  )
}

// 一个容器只许有一个 React root。插件常「dispose 完立刻在同一个 el 上重挂」,而 unmount 推迟到
// microtask(React 18+ 不许在渲染周期里同步 unmount)—— 不认容器的话第二次 createRoot 会在仍被
// 标记为 root 的元素上再建一个,随后旧 root 的延迟 unmount 反过来把新挂载清掉(codex)。
const rootsByEl = new WeakMap<HTMLElement, { root: Root; gen: number }>()
let mountGen = 0

const isEl = (v: unknown): v is HTMLElement =>
  typeof HTMLElement !== 'undefined' ? v instanceof HTMLElement : !!v && typeof (v as HTMLElement).appendChild === 'function'

/** 建一份**属于某个插件**的块表面。返回 `revoke`:宿主在插件禁用/重载/setup 抛错时调用,
 *  收掉它开的全部订阅与 React root,并让后续调用整体变哑 —— 插件在飞的异步任务不能再改用户文件。 */
export function createBlockSurface(pluginId: string): { api: BlockSurfaceApi; revoke: () => void } {
  let alive = true
  const unsubs = new Set<() => void>()
  const mounts = new Set<() => void>()

  /** 活着吗?顺带把「插件卸载后还在调 API」这件事说出来(静默 no-op 会被当成宿主 bug 查半天)。 */
  const ok = (): boolean => {
    if (!alive) console.warn(`[amadeus] 插件 ${pluginId} 已停用,块表面调用被忽略`)
    return alive
  }
  /** 改数据前的闸:活着 + 页令牌匹配。令牌不对 = 用户已经切页了,这次提交会打到别的文件上。 */
  const guard = (token: unknown): boolean => {
    if (!ok()) return false
    installTokenWatch()
    if (String(token ?? '') !== currentToken()) {
      console.warn(`[amadeus] 插件 ${pluginId} 的页令牌已过期(用户已切页),本次改动被拒绝`)
      return false
    }
    return true
  }

  const api: BlockSurfaceApi = {
    getPage: () => snapshot(),

    subscribePage(cb) {
      if (!ok()) return () => {}
      let prev = snapshot()
      const off = usePageStore.subscribe(() => {
        const next = snapshot()
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
      usePageStore.getState().setFmExtra(String(text ?? ''))
    },

    insertBlockAfter(token, afterId, content) {
      if (!guard(token)) return null
      return usePageStore.getState().insertBlockAfter(afterId ?? null, undefined, String(content ?? ''))
    },

    async deleteBlock(token, id) {
      if (!guard(token)) return
      await usePageStore.getState().deleteBlock(String(id))
    },

    requestFocus(id, place) {
      if (!ok()) return
      usePageStore.getState().requestFocus(String(id), place === 'start' ? 'start' : 'end')
    },

    consumeFocus(id) {
      if (!ok()) return
      usePageStore.getState().consumeFocus(String(id))
    },

    undo(token) {
      if (!guard(token)) return
      usePageStore.getState().undo()
    },

    redo(token) {
      if (!guard(token)) return
      usePageStore.getState().redo()
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
      const gen = ++mountGen
      const existing = rootsByEl.get(el)
      const root = existing?.root ?? createRoot(el)
      rootsByEl.set(el, { root, gen })
      root.render(<MountedBlock blockId={blockId} surface={surface} />)

      const dispose = (): void => {
        mounts.delete(dispose)
        const cur = rootsByEl.get(el)
        if (!cur || cur.gen !== gen) return // 这个容器已经被新的挂载接管 → 本次 dispose 作废
        rootsByEl.delete(el)
        // React 18+ 禁止在渲染周期里同步 unmount(插件常在自己的 effect 清理里调)→ 推迟一拍;
        // 期间若有人重新 mount 同一个 el,上面的 gen 检查会拦下这次 unmount。
        queueMicrotask(() => {
          if (rootsByEl.get(el)) return
          try {
            cur.root.unmount()
          } catch (e) {
            console.error('[amadeus] 卸载插件块失败', e)
          }
        })
      }
      mounts.add(dispose)
      return dispose
    },
  }

  return {
    api,
    revoke() {
      alive = false
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
