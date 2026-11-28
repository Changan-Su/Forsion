/**
 * 退出门禁(智库同步统一方案第 2 步 H 包;契约 §3.10「退出门禁」5C、Codex 18、实现期修订 H-1 第 6 条)。
 *
 * 新同步(Forsion Extend)经 CloudHost.addQuitCheck 登记一个检查:叫引擎扫一遍,回有类型的结果
 * synced / pending:N / failed:[{path, reason}]。宿主在 before-quit 里**任何不可逆清理之前**、编辑器保存和冲刷之后问它:
 * - 没人登记(老 Extend、Extend 停用)= 今天的行为,一字不变;
 * - synced → 照常退;
 * - pending / failed:有窗口订阅了门禁卡(设置 › 同步那套界面,U 包)就把结果推过去,等用户「直接退出」/「取消退出」,
 *   期间每 pollMs 再扫一遍,同步完了自动退;没有窗口订阅 → 照今天的行为直接退(待办落盘,下次启动接着同步)。
 * - 无人值守的装更新(installIfIdle)不弹卡:还在同步(pending)就这次不装。
 * 纯逻辑:界面那一半由调用方注入(createRendererQuitGateUi 是 Electron 那份),vitest 直测。
 */

export interface QuitCheckResult {
  state: 'synced' | 'pending' | 'failed'
  pending: number
  failed: Array<{ path: string; reason: string }>
}
export type QuitCheckFn = () => Promise<QuitCheckResult>
export type QuitGateAnswer = 'quit' | 'cancel'

export interface QuitGateUi {
  /** 有没有窗口能问(订阅了门禁卡)。没有 = 照今天的行为直接退。 */
  available(): boolean
  /** 把当前结果推给界面(第一次 = 打开卡片)。 */
  show(r: QuitCheckResult): void
  /** 用户点了哪个;每次 run 只取一次。 */
  answer(): Promise<QuitGateAnswer>
  hide(): void
}

const MAX_FAILED = 50

function normalize(r: unknown): QuitCheckResult {
  const x = r as Partial<QuitCheckResult> | null
  const state = x?.state === 'synced' || x?.state === 'pending' || x?.state === 'failed' ? x.state : 'failed'
  const failed = Array.isArray(x?.failed)
    ? x!.failed.filter((f) => f && typeof f === 'object').slice(0, MAX_FAILED).map((f) => ({ path: String((f as { path?: unknown }).path ?? ''), reason: String((f as { reason?: unknown }).reason ?? '') }))
    : []
  const pending = typeof x?.pending === 'number' && Number.isFinite(x.pending) && x.pending >= 0 ? Math.floor(x.pending) : 0
  if (state === 'failed' && !failed.length && x?.state !== 'failed') failed.push({ path: '', reason: 'invalid quit check result' })
  return { state, pending, failed }
}

/** 几个检查合成一个:有失败 = failed;有待同步 = pending;都同步完 = synced。 */
export function mergeQuitChecks(rs: QuitCheckResult[]): QuitCheckResult {
  const failed = rs.flatMap((r) => r.failed).slice(0, MAX_FAILED)
  const pending = rs.reduce((n, r) => n + r.pending, 0)
  const state = rs.some((r) => r.state === 'failed') ? 'failed' : rs.some((r) => r.state === 'pending') ? 'pending' : 'synced'
  return { state, pending, failed }
}

export function createSyncQuitGate(deps: { ui: QuitGateUi; pollMs?: number; checkTimeoutMs?: number; log?: (m: string) => void }) {
  const checks = new Set<QuitCheckFn>()
  let running: Promise<boolean> | null = null
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.() })

  async function one(fn: QuitCheckFn): Promise<QuitCheckResult> {
    const timeout = deps.checkTimeoutMs ?? 60_000
    try {
      return await Promise.race([
        Promise.resolve().then(fn).then(normalize),
        sleep(timeout).then((): QuitCheckResult => ({ state: 'pending', pending: 0, failed: [] })), // 扫得太久 = 还在同步
      ])
    } catch (e) {
      // 插件抛错:说成失败(界面写明哪儿错了),不当成同步完了
      return { state: 'failed', pending: 0, failed: [{ path: '', reason: String((e as Error)?.message || e) }] }
    }
  }

  async function check(): Promise<QuitCheckResult | null> {
    if (!checks.size) return null
    return mergeQuitChecks(await Promise.all([...checks].map(one)))
  }

  return {
    add(fn: QuitCheckFn): () => void {
      if (typeof fn !== 'function') return () => {}
      checks.add(fn)
      return () => { checks.delete(fn) }
    },
    has: (): boolean => checks.size > 0,
    check,
    /** 交互式退出:true = 可以退;false = 用户点了取消退出。同时只跑一份(再按退出拿到同一个 promise)。 */
    run(): Promise<boolean> {
      if (running) return running
      running = (async () => {
        let r = await check()
        if (!r || r.state === 'synced') return true
        if (!deps.ui.available()) {
          deps.log?.(`[quit-gate] ${r.state} (${r.pending} pending, ${r.failed.length} failed) and no window to ask: quitting as before`)
          return true
        }
        deps.ui.show(r)
        const answer = deps.ui.answer().then((a) => ({ a }))
        // 用户的回答和整个轮询赛跑:等下一次扫描、扫描本身都和回答一起 race —— 扫描途中点了「取消退出」,
        // 那次扫描回来就算同步完了也不退
        for (;;) {
          const won = await Promise.race([answer, sleep(deps.pollMs ?? 2000).then(() => null)])
          if (won) { deps.ui.hide(); return won.a === 'quit' }
          const next = await Promise.race([answer, check().then((x) => ({ r: x }))])
          if ('a' in next) { deps.ui.hide(); return next.a === 'quit' }
          r = next.r
          if (!r || r.state === 'synced') { deps.ui.hide(); return true }
          deps.ui.show(r)
        }
      })().finally(() => { running = null })
      return running
    },
    /** 无人值守(装更新):不弹卡;还在同步就这次不装(false)。只有失败的照旧装:失败要人处理,下次启动接着报。
     *  「还在同步」= state pending **或** pending > 0(几个检查合起来时 failed 盖过 pending,state 是 failed 也可能还有在传的)。 */
    async unattended(): Promise<boolean> {
      const r = await check()
      return !r || (r.state !== 'pending' && r.pending === 0)
    },
  }
}

export type SyncQuitGate = ReturnType<typeof createSyncQuitGate>

interface QuitEvents {
  on(ev: 'before-quit', fn: () => void): unknown
  removeListener(ev: 'before-quit', fn: () => void): unknown
}
/** 旧引擎(Extend 里的 Amadeus 云同步,经 amadeus/ipc 的 onBeforeQuit 登记)的退出钩子:held() = 这一次 before-quit
 *  被同步门禁拦下来问用户(main.ts 的 syncGateChain 在跑)—— 这次不调,钩子留着;放行的那次 before-quit 才调,调过即摘(同 app.once)。
 *  门禁「取消退出」时旧引擎就一直没停过。没登记退出检查 = held() 恒假 = 第一次 before-quit 就调,和 app.once 一样。
 *  依赖 main.ts 自己的 before-quit 监听先登记(模块顶层),这里的后登记(whenReady 里),同一次派发里先看到门禁状态。 */
export function onQuitProceeding(events: QuitEvents, held: () => boolean, cb: () => void): () => void {
  const on = (): void => {
    if (held()) return
    events.removeListener('before-quit', on)
    cb()
  }
  events.on('before-quit', on)
  return () => { events.removeListener('before-quit', on) }
}

// ── Electron 那一半:渲染层经 window.remoteSync.quitGate 订阅 / 回答(preload:remotesyncPreload.ts)──────────────

interface Sender { id: number; isDestroyed(): boolean; send(channel: string, payload: unknown): void; once?(ev: 'destroyed', fn: () => void): void }
interface GateEvents {
  handle(channel: string, fn: (e: { sender: Sender }, ...args: any[]) => unknown): void
}

export function createRendererQuitGateUi(deps: { events: GateEvents; isTrusted(e: { sender: Sender }): boolean; reveal?(): void }): QuitGateUi {
  const subs = new Map<number, Sender>()
  let pendingAnswer: ((a: QuitGateAnswer) => void) | null = null
  const live = (): Sender[] => [...subs.values()].filter((s) => !s.isDestroyed())
  deps.events.handle('remotesync:quitGate:subscribe', (e, on: unknown) => {
    if (!deps.isTrusted(e)) throw new Error('forbidden')
    if (on === false) subs.delete(e.sender.id)
    else { subs.set(e.sender.id, e.sender); e.sender.once?.('destroyed', () => subs.delete(e.sender.id)) }
    return { ok: true }
  })
  deps.events.handle('remotesync:quitGate:answer', (e, a: unknown) => {
    if (!deps.isTrusted(e)) throw new Error('forbidden')
    if (a !== 'quit' && a !== 'cancel') throw new Error('invalid answer')
    const resolve = pendingAnswer
    pendingAnswer = null
    resolve?.(a)
    return { ok: true }
  })
  const send = (payload: unknown) => { for (const s of live()) s.send('remotesync:quitGate', payload) }
  return {
    available: () => live().length > 0,
    show(r) { deps.reveal?.(); send({ open: true, result: r }) },
    answer: () => new Promise<QuitGateAnswer>((resolve) => { pendingAnswer = resolve }),
    hide() { pendingAnswer = null; send({ open: false }) },
  }
}
