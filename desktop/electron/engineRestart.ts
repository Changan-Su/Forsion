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
 *  - 修订号(评审 #4):每次 request 记一笔改动;重启读配置之前 markCovered() 记下「到这一笔为止都会被这次带上」。
 *    重启进行中(track 登记,谁发起的都算)来的请求先等它做完:已被带上的不再排第二次;没带上的(读完配置之后才存的)
 *    再走一遍上面的流程,多个合成一次。cancel() 只作废等待 / 询问,不动修订号与进行中的那次 ——
 *    这里自己发起的重启也经 ensureBackend,它开头就会 cancel()。
 */
export type EngineBusy = 'busy' | 'idle' | 'down' | 'unknown'

export interface DeferredRestartDeps {
  /** busy = 有运行中或排队中的任务;idle = 没有;down = 引擎没在跑 / 没就绪;unknown = 问不到。 */
  probe(): Promise<EngineBusy>
  /** 真正的重启(立即重启那条路)。应当在读配置之前调 markCovered()、并用 track() 登记自己。 */
  restart(): Promise<void>
  /** 进入等待时调一次(提示「当前任务结束后生效」)。合并进已有等待的请求不再调。 */
  onDeferred?(): void
  intervalMs?: number
}

export interface DeferredRestart {
  /** 一笔改动已落盘,请求一次「空闲时重启」。立即重启时等重启做完;要等待时马上返回。 */
  request(): Promise<void>
  /** 一次重启就要读配置了:到此为止登记的改动都由它带上(在读配置**之前**调;晚了会漏掉设置,早了只多重启一次)。 */
  markCovered(): void
  /** 登记一次进行中的重启(不论谁发起):期间来的请求等它做完,再看自己那笔改动是否已被带上。 */
  track(p: Promise<unknown>): void
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
  /** 已登记的改动笔数(request 一次加一)。 */
  let rev = 0
  /** 最近一次重启读配置时的笔数:≤ 它的改动都已被带上。 */
  let covered = 0
  /** 进行中的重启(已吞掉拒绝)。 */
  let inflight: Promise<void> | null = null

  const outstanding = (): boolean => rev > covered
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
        if (!outstanding()) { settle(); return } // 等着的这段时间里别的重启已经把改动带上了
        if (state === 'busy') { schedule(mine); return }
        settle()
        return deps.restart()
      }).catch(() => { /* restart 自己记日志 */ })
    }, interval)
  }

  const pump = (): Promise<void> => {
    if (!outstanding()) return Promise.resolve()
    // 重启进行中:等它做完再看(读配置之前存的已被带上;之后存的再排一次,多笔合成一次)
    if (inflight) return inflight.then(pump)
    if (waiting) return Promise.resolve()
    if (first) return first
    const mine = epoch
    const asked: Promise<void> = probe().then(async (state) => {
      if (first === asked) first = null
      if (mine !== epoch || !outstanding()) return
      if (state !== 'busy') { await deps.restart(); return }
      waiting = true
      try { deps.onDeferred?.() } catch { /* 提示失败不影响等待 */ }
      schedule(mine)
    })
    first = asked
    return asked
  }

  return {
    request() {
      rev++
      return pump()
    },
    markCovered() { covered = rev },
    track(p) {
      const settled: Promise<void> = p.then(() => {}, () => {})
      inflight = settled
      void settled.then(() => { if (inflight === settled) inflight = null })
    },
    cancel() {
      epoch++
      first = null
      settle()
    },
    isPending: () => waiting || !!first,
  }
}
