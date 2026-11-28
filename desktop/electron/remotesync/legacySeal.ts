/**
 * 旧 remotesync 的封口闸(智库同步统一方案第 2 步 H 包,契约 §3.8 D、§3.9、实现期修订 H-1 第 2 条)。纯逻辑,不 import electron。
 *
 * 新同步(Forsion Extend 里的 v2 引擎)接手 remotesync 的配置后,同一个网盘目录只许一个写者:
 * - **持有**(hold.holder = 'v2'):落盘在宿主 sync-targets 文件里,跨重启;
 * - **握手**:每次启动,Extend 在这次启动里调了任一 syncTargets 成员 = ok;Extend 没装载(插件页停用 / 验签失败),
 *   或装载后 handshakeMs 内一次都没调 = released,**这次启动交还**给 remotesync(落盘的持有不改,下次 Extend 回来照样拦)。
 *   v2 引擎只跑在 Extend 里:Extend 不在,就没有第二个写者,交还是安全的。
 * - blocked() 是同步判断,remotesync 在拿运行锁之前、任何 await 之前调它(定时、启动那一轮、手动 run、预演、adoptRemote 全走这里)。
 * - seal() 先把闸关上再落盘,然后等在途那一轮结束才返回;握手(touch)在 v2 持有时也等在途那一轮。
 * - seal / unseal / markArchived / exclusive 排一把锁(一个接一个):seal 等在途那一轮时,后来的 unseal 排队,
 *   seal 返回时闸一定关着;exclusive(fn) 给归档用 —— 持有着才进,进了闸就关着、等在途那一轮跑完才跑 fn,fn 跑完才放开。
 *   锁不可重入:fn 里改归档记录用它递进来的 markArchived,别再调 gate.markArchived(会等自己)。
 * - 持有状态读不了 = 不知道 = 按持有处理(仍然可以因为 Extend 不在而交还)。
 */

export interface LegacyHoldState {
  holder: 'v2' | null
  /** remotesync.json 已复制进接手档案、原文件的自动同步已关、基线已挪走(archiveLegacyRemoteSync)。 */
  archived: boolean
  archivedAt?: number
  archiveDir?: string
}

export interface LegacyGateDeps {
  /** 读落盘的持有状态;没有 = { holder: null, archived: false };读不了就抛。 */
  loadHold(): Promise<LegacyHoldState>
  saveHold(next: LegacyHoldState): Promise<void>
  /** Extend 装载后多久没握手就交还(缺省 60 秒)。 */
  handshakeMs?: number
  log?(m: string): void
}

export type Handshake = 'pending' | 'ok' | 'released'

export interface LegacyGateState {
  hold: 'v2' | 'none' | 'unknown'
  archived: boolean
  archiveDir?: string
  handshake: Handshake
  /** 这次启动里 v2 正持有写权:旧入口被拦着。 */
  blocked: boolean
  running: boolean
}

/** 日志里只放错误码:持有状态存在带凭据的 sync-targets 文件里,读错的原始报错(JSON.parse)会带一截原文。 */
const logCode = (e: unknown): string => {
  const m = String((e as Error)?.message ?? e)
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(m) ? m : 'unreadable'
}

export function createLegacyGate(deps: LegacyGateDeps) {
  let hold: LegacyHoldState | 'loading' | 'unknown' = 'loading'
  let handshake: Handshake = 'pending'
  let sealing = false
  /** 排在锁里、还没跑完的 seal:unseal 跑完时还有 seal 排着,闸就别放开(马上又要关)。 */
  let sealsQueued = 0
  /** exclusive 正在跑(含等在途那一轮):闸关着。 */
  let exclusiveHeld = 0
  let inflight: Promise<void> | null = null
  let lock: Promise<unknown> = Promise.resolve()
  let queued = 0
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    queued++
    const work = lock.then(fn).finally(() => { queued-- })
    lock = work.catch(() => {})
    return work
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const loaded: Promise<void> = deps.loadHold().then(
    (h) => { hold = { holder: h?.holder === 'v2' ? 'v2' : null, archived: h?.archived === true, ...(h?.archivedAt ? { archivedAt: h.archivedAt } : {}), ...(h?.archiveDir ? { archiveDir: h.archiveDir } : {}) } },
    (e) => { hold = 'unknown'; deps.log?.(`[remotesync] hold state unreadable, treating as held: ${logCode(e)}`) },
  )
  const heldByV2 = (): boolean => hold === 'loading' || hold === 'unknown' || hold.holder === 'v2'
  const stopTimer = (): void => { if (timer) { clearTimeout(timer); timer = null } }
  const release = (why: string): void => {
    if (handshake !== 'pending') return
    handshake = 'released'
    stopTimer()
    if (heldByV2()) deps.log?.(`[remotesync] v2 hand-shake ${why}: legacy remote sync handed back for this launch`)
  }
  const current = async (): Promise<LegacyHoldState> => {
    await loaded
    if (hold === 'unknown' || hold === 'loading') {
      // 再读一次:可能刚才是瞬时错误。还是读不了就抛 —— 拿一份「不知道」去写,会把 archived 之类的记录盖掉
      const fresh = await deps.loadHold()
      hold = fresh
    }
    return hold as LegacyHoldState
  }
  const idle = async (): Promise<void> => { while (inflight) await inflight.catch(() => {}) }
  /** 锁里用(不再拿锁):持有 → 无。 */
  const unsealLocked = async (): Promise<void> => {
    const cur = await current()
    if (cur.holder !== null) {
      const next = { ...cur, holder: null }
      await deps.saveHold(next)
      hold = next
    }
    if (!sealsQueued) sealing = false
  }
  /** 锁里用(不再拿锁)。 */
  const markArchivedLocked = async (archiveDir: string, now = Date.now()): Promise<void> => {
    const cur = await current()
    if (cur.holder !== 'v2') throw new Error('legacy-not-sealed')
    if (cur.archived) return
    const next = { ...cur, archived: true, archivedAt: now, archiveDir }
    await deps.saveHold(next)
    hold = next
  }

  return {
    ready: (): Promise<void> => loaded,
    /** 同步判:现在拦不拦旧 remotesync 的一轮。 */
    blocked(): boolean {
      if (sealing || exclusiveHeld > 0) return true
      if (handshake === 'released') return false
      return heldByV2()
    },
    /** 一轮开始(调用方已经过了 blocked() 和自己的运行锁):返回「这一轮结束」。seal / touch 靠它等在途那一轮。 */
    begin(): () => void {
      let done!: () => void
      const p = new Promise<void>((resolve) => { done = resolve })
      inflight = p
      return () => { if (inflight === p) inflight = null; done() }
    },
    /** Extend 调了 syncTargets 的某个成员:握手成功;v2 持有时等在途那一轮跑完再放行(之后的轮次被 blocked() 拦住)。 */
    async touch(): Promise<void> {
      handshake = 'ok'
      stopTimer()
      await loaded
      if (heldByV2()) await idle()
    },
    /** 宿主装载完内置包时调一次:Extend 不在 → 立刻交还;在 → 等 handshakeMs,还没握手就交还。 */
    extendLoaded(present: boolean): void {
      if (!present) { release('impossible (Forsion Extend is not loaded)'); return }
      if (handshake !== 'pending' || timer) return
      timer = setTimeout(() => release('timed out'), deps.handshakeMs ?? 60_000)
      ;(timer as { unref?: () => void }).unref?.()
    },
    /** 关掉定时、启动那一轮、手动 run(幂等):闸先关上(调用当下就关,不等锁),再落盘持有,再等在途那一轮结束。
     *  落盘失败照样抛,闸保持关着(调用方失败后调 unseal 交还)。排在锁里:返回时后来的 unseal 还没跑,闸一定关着。 */
    seal(): Promise<void> {
      sealing = true
      handshake = 'ok'
      stopTimer()
      sealsQueued++
      return serial(async () => {
        try {
          sealing = true
          const cur = await current()
          if (cur.holder !== 'v2') {
            const next = { ...cur, holder: 'v2' as const }
            await deps.saveHold(next)
            hold = next
          }
          await idle()
        } finally { sealsQueued-- }
      })
    },
    /** 只在接手中途失败、退回时用:持有 → 无。已归档的不还原(交还后只能手动、从零基线跑)。排在锁里,等前面的 seal / 归档做完。 */
    unseal(): Promise<void> {
      return serial(unsealLocked)
    },
    /** 先核再交还(契约 H-13):排在同一把锁里,闸关着、在途那一轮跑完才调 check。check 拿到 handBack,核对和交还在 check 的
     *  同一段里做(调用方在里面占着自己的配置写队列,核完到交还之间别人插不进来);check 抛 = 什么都不动。handBack 不再拿锁。 */
    unsealChecked(check: (handBack: () => Promise<void>) => Promise<void>): Promise<void> {
      return serial(async () => {
        exclusiveHeld++
        try {
          await idle()
          await check(unsealLocked)
        } finally { exclusiveHeld-- }
      })
    },
    markArchived: (archiveDir: string, now?: number): Promise<void> => serial(() => markArchivedLocked(archiveDir, now)),
    /** Only for operations that require an unused legacy engine. Refuse queued takeovers and hand-backs. */
    async exclusiveIfUnused<T>(fn: () => Promise<T>): Promise<T | undefined> {
      await loaded
      const unused = () => handshake === 'ok' && typeof hold === 'object' && hold.holder === null && !hold.archived && !sealing && !inflight
      if (queued || !unused()) return undefined
      return serial(async () => {
        if (queued !== 1 || !unused()) return undefined
        exclusiveHeld++
        try { return await fn() } finally { exclusiveHeld-- }
      })
    },
    /** 归档用:持有着(hold.holder = 'v2')才进;进了闸就关着(这次启动交还着也关),等在途那一轮跑完再跑 fn,
     *  fn 跑完才放开、才轮到排着的 unseal。fn 拿到的 markArchived 不再拿锁。没持有 → 抛 legacy-not-sealed,fn 不跑。 */
    exclusive<T>(fn: (g: { markArchived(archiveDir: string, now?: number): Promise<void> }) => Promise<T>): Promise<T> {
      return serial(async () => {
        const cur = await current()
        if (cur.holder !== 'v2') throw new Error('legacy-not-sealed')
        exclusiveHeld++
        try {
          await idle()
          return await fn({ markArchived: markArchivedLocked })
        } finally { exclusiveHeld-- }
      })
    },
    idle,
    state(): LegacyGateState {
      const h = hold === 'loading' || hold === 'unknown' ? null : hold
      return {
        hold: h ? (h.holder === 'v2' ? 'v2' : 'none') : 'unknown',
        archived: h?.archived === true,
        ...(h?.archiveDir ? { archiveDir: h.archiveDir } : {}),
        handshake,
        blocked: sealing || exclusiveHeld > 0 || (handshake !== 'released' && heldByV2()),
        running: !!inflight,
      }
    },
  }
}

export type LegacyGate = ReturnType<typeof createLegacyGate>
