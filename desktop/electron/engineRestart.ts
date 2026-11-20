/**
 * 引擎重启的「能不打断就别打断」(中断任务续跑方案 B 6.6,docs/ToBeImproved/中断任务续跑方案_2026-11-20)。
 *
 * 改提供方(保存 / 删除 / 导入)、改托管引擎参数这类重启:引擎正有任务在跑时,设置照存,重启等任务都结束再做 ——
 * 比事后续跑便宜,也不打断用户。登录登出 / auth.json 被改写(换了账号,旧引擎不能再拿旧身份跑)、用户点的「重启引擎」、
 * 订阅登录(调用方要等新引擎装好那个 provider 才往下走)不走这里,照旧立即重启。
 *
 * 规则:
 *  - 请求时先问一次引擎:没有任务 / 引擎没在跑 / 问不到 → 立即重启(和以前一样);有任务 → 记下待办、立即返回(调用方不挂住),
 *    之后每 intervalMs 再问一次,问到空闲 / 引擎没了 / 问不到就重启。
 *  - 等待期间再来的请求合并成一次(重启时 ensureBackend 现读配置,最新的设置一并生效)。
 *  - 等待期间有一次立即重启(或退出 / 清空数据)= 这次待办已被吸收,cancel() 掉。
 */
export type EngineBusy = 'busy' | 'idle' | 'down' | 'unknown'

export interface DeferredRestartDeps {
  /** busy = 有运行中或排队中的任务;idle = 没有;down = 引擎没在跑 / 没就绪;unknown = 问不到。 */
  probe(): Promise<EngineBusy>
  /** 真正的重启(立即重启那条路)。 */
  restart(): Promise<void>
  /** 进入等待时调一次(提示「当前任务结束后生效」)。合并进已有等待的请求不再调。 */
  onDeferred?(): void
  intervalMs?: number
}

export interface DeferredRestart {
  /** 请求一次「空闲时重启」。立即重启时等重启做完;要等待时马上返回。 */
  request(): Promise<void>
  /** 待办被一次立即重启 / 退出吸收:不再重启。 */
  cancel(): void
  isPending(): boolean
}

export const RESTART_POLL_MS = 5000

export function createDeferredRestart(deps: DeferredRestartDeps): DeferredRestart {
  const interval = deps.intervalMs ?? RESTART_POLL_MS
  /** 第一次询问还在路上:同一时刻的请求共用它。 */
  let first: Promise<void> | null = null
  /** 已进入等待:定时再问。 */
  let waiting = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** cancel() 一次加一:询问回来时代号变了 = 已被吸收,不再重启 / 不再排下一次。 */
  let epoch = 0

  const probe = (): Promise<EngineBusy> => deps.probe().catch(() => 'unknown' as const)
  const settle = (): void => {
    waiting = false
    if (timer) { clearTimeout(timer); timer = null }
  }
  const schedule = (mine: number): void => {
    timer = setTimeout(() => {
      timer = null
      void probe().then((state) => {
        if (mine !== epoch || !waiting) return
        if (state === 'busy') { schedule(mine); return }
        settle()
        return deps.restart()
      }).catch(() => { /* restart 自己记日志 */ })
    }, interval)
  }

  return {
    request() {
      if (waiting) return Promise.resolve()
      if (first) return first
      const mine = epoch
      const asked: Promise<void> = probe().then(async (state) => {
        if (first === asked) first = null
        if (mine !== epoch) return
        if (state !== 'busy') { await deps.restart(); return }
        waiting = true
        try { deps.onDeferred?.() } catch { /* 提示失败不影响等待 */ }
        schedule(mine)
      })
      first = asked
      return asked
    },
    cancel() {
      epoch++
      first = null
      settle()
    },
    isPending: () => waiting || !!first,
  }
}
