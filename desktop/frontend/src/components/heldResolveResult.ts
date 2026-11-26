/** 「N 篇和云端不一样,等你定」那块点完按钮后,怎么判 resolveHeld 的回复算不算失败。
 *
 *  成功时 Forsion Extend 回的是同步状态(SyncStatus),它恒带 error 字段(引擎级错误,平时是 null),
 *  所以不能拿 `'error' in r` 判失败 —— 那样每次处理成功都会弹「没处理成」。
 *  真失败的回复是 { error: 'binding-not-found' } 这类,不是同步状态,不带 state。
 *  另外 resolveHeld 只是把处理排进队列就返回当时的状态,状态里 error 非空也不代表这次处理失败。
 *  null / undefined(宿主没回东西)照旧不算失败。 */
import type { AmadeusSyncStatus } from '../types'

export type ResolveHeldReply = AmadeusSyncStatus | { error: string } | null | undefined

export function isResolveHeldFailure(r: ResolveHeldReply): boolean {
  return !!r && typeof r === 'object' && !('state' in r) && 'error' in r
}
