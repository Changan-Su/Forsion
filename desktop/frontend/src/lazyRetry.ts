/* eslint-disable @typescript-eslint/no-explicit-any -- React.lazy 同款签名:ComponentType<any> 才能保住各组件自己的 props 类型 */
import { createElement, forwardRef, lazy, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { windowKind } from './windowKind'

export type PreloadableLazy<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** 提前拉分块并求值;之后**新挂载**的实例直接渲染真组件,不再经过 Suspense。 */
  preload(): Promise<unknown>
}

/** React.lazy + 失败自动重试一次(800ms 后):web/移动端弱网下动态 chunk 偶发拉不下来,
 *  瞬断多数一次重试即活;仍失败才抛,由引擎的面板级 ViewErrorBoundary 接住(不再整 app 白屏)。
 *  仓内所有 `lazy(() => import(...))` 一律换用本函数。
 *
 *  带 preload()(U-40):React.lazy 首次渲染**总会**挂起一次 —— 哪怕分块早已下载、Promise 早已兑现 ——
 *  再叠上 React 19 的 Suspense 揭示节流(约 300ms),首进就是一闪骨架;光 import() 预取分块实测省不下来。
 *  所以模块到手后记下真组件,新挂载的实例直接渲染它,根本不挂起。 */
// ponytail: 只重试一次、固定 800ms;需要指数退避时再说。
export function lazyRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): PreloadableLazy<T> {
  let loaded: T | null = null
  let pending: Promise<{ default: T }> | null = null
  const get = (): Promise<{ default: T }> => (pending ||= load()
    .catch(() => new Promise<void>((r) => setTimeout(r, 800)).then(load))
    .then((m) => { loaded = m.default; return m }, (e) => { pending = null; throw e }))
  const Lazy = lazy(get)
  const Comp = forwardRef<unknown, any>(function PreloadableLazy(props, ref) {
    // 挂载那一刻定形,此后不换类型:半路从 Lazy 换成真组件 = 整棵子树重挂、丢状态。
    const [Direct] = useState<T | null>(() => loaded)
    return createElement((Direct ?? Lazy) as ComponentType<any>, { ...props, ref })
  }) as unknown as PreloadableLazy<T>
  Comp.preload = get
  return Comp
}

/** 桌面端空闲时预热这几个 View(U-40:消掉每次启动后首进 Space 的那一闪骨架)。
 *  只在 Electron 主窗里做:web / 移动端按需加载省流量,浮窗 / 独立窗用不到这些 Space;预热失败无妨,真进入时照常 lazy 加载。 */
export function preloadWhenIdle(...views: Array<{ preload(): Promise<unknown> }>): void {
  if (typeof navigator === 'undefined' || !navigator.userAgent.includes('Electron/') || windowKind() !== 'main') return
  try { if (localStorage.getItem('forsion_no_idle_preload') === '1') return } catch { /* 读不到就照常预热 */ } // 仅 check:firstenter 负对照用
  const run = (): void => { for (const v of views) void v.preload().catch(() => {}) }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 2000)
}
