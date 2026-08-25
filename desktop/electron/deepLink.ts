/**
 * forsion:// deep link 主进程侧(View 基座统一化 P1)——**纯队列逻辑,零 Electron 依赖**(node 可测)。
 * 挂接(setAsDefaultProtocolClient / open-url / second-instance argv)在 main.ts;
 * 冷启动时 URL 先于渲染层就绪到达 → 入队,渲染层起来后经 IPC `deeplink:drain` 一次拉走。
 * 语义与安全边界正典:docs/ToBeImproved/View基座统一化方案_2026-08-25.md §4。
 */

/** 是不是我们的 scheme。只认形态,不做解析(解析与白名单在渲染层 resolver,那里有注册表)。 */
export const isForsionUrl = (s: unknown): s is string => typeof s === 'string' && /^forsion:\/\//i.test(s.trim())

const MAX_QUEUE = 8 // 防外部滥发挤爆:只留最近 8 条(deep link 是导航意图,旧的没意义)

const queue: string[] = []

export function pushDeepLink(url: string): void {
  if (!isForsionUrl(url)) return
  queue.push(url.trim())
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
}

/** 渲染层拉走全部待处理 URL(拿走即清)。 */
export function drainDeepLinks(): string[] {
  return queue.splice(0)
}
