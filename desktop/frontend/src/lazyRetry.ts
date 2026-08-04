/* eslint-disable @typescript-eslint/no-explicit-any -- React.lazy 同款签名:ComponentType<any> 才能保住各组件自己的 props 类型 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** React.lazy + 失败自动重试一次(800ms 后):web/移动端弱网下动态 chunk 偶发拉不下来,
 *  瞬断多数一次重试即活;仍失败才抛,由引擎的面板级 ViewErrorBoundary 接住(不再整 app 白屏)。
 *  仓内所有 `lazy(() => import(...))` 一律换用本函数。 */
// ponytail: 只重试一次、固定 800ms;需要指数退避时再说。
export function lazyRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(() => load().catch(() => new Promise<void>((r) => setTimeout(r, 800)).then(load)))
}
