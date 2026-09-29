/**
 * 每个引擎目标一个健康状态机(P1-K6 §3.1 / §3.6)。经 hub 打「我的电脑」时会遇到本机直连遇不到的一整类失败:
 * 电脑离线(503 UNIT_OFFLINE)、隧道断(502 / 504)、引擎没起(503 ENGINE_NOT_READY)、全局限流(429)、设备被移除
 * (404 UNIT_NOT_FOUND)、调用方身份取不到 / 被拒(503 CALLER_* / 403 UNIT_CALLER_* / BAD_CALLER_ASSERTION)、
 * 执行设备拒绝远程会话(403 REMOTE_* / 423 REMOTE_LOCKED)。它们的处置完全不同:可恢复的暂停等恢复、
 * 终局的直接收尾 —— **绝不无限重试**(R-32:中继的「失败关闭」不能在渲染层表现成网络错无限重试)。
 *
 * 一个目标离线只动它自己那一格,别的目标不受影响(S4 多目标并存的前提)。
 */
import { create } from 'zustand'
import { engineFetch, targetForRef, type EngineTarget, type TargetKey } from './targets'
import { isTargetKey, type TargetRef } from './target'

/** /health 之后追打的带鉴权探针(无副作用、体积小;远端 allow)。agentRunService 的 AUTH_PROBE_PATH 即它。 */
export const AUTH_PROBE_PATH = '/agent/special/config'

export type Verdict =
  | 'ok'
  | 'account-auth?' // 401:hub 401 体无 code、与引擎 401 分不开 → 调用方必须复检账号
  | 'offline' // 电脑不在线 / 隧道断 / 认领超时 / 网络错
  | 'engine-unavailable' // 电脑在线,引擎没起
  | 'rate-limited'
  | 'transient' // 其它 5xx
  | 'gone' // 设备不属于本人 / 已移除
  | 'local-only' // 403 LOCAL_ONLY:这条路由远端不许
  | 'caller-unavailable' // 调用方身份取不到 / 验不过(R-32)
  | 'refused' // 执行设备拒绝远程会话 / 已急停锁定(K4 / K2 的码)。按层 / 按方法拒(读照常放行):服务层把它当这一条请求的事,
  //             只有 GET 探针 / 事件流(本该放行的读)也被拒时才写进健康表
  | 'too-large' // 413 UNIT_BODY_TOO_LARGE
  | 'fatal' // 其它 4xx

/** 调用方身份相关的失败(K1 / K8 的码):终局,不重试。 */
const CALLER_CODES = new Set(['CALLER_UNAVAILABLE', 'CALLER_UNSUPPORTED', 'UNIT_CALLER_INVALID', 'UNIT_CALLER_EXPIRED', 'BAD_CALLER_ASSERTION'])

function codeOf(body: unknown): string {
  const c = (body as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' ? c : ''
}

/**
 * HTTP 结果 → 处置类别。status 0 = 请求没发出去 / 网络错(调用方按目标来路再定是离线还是瞬态)。
 * 码优先于状态:同一个 503,UNIT_OFFLINE / ENGINE_NOT_READY / CALLER_* 的处置完全不同。
 */
export function classify(status: number, body: { code?: unknown } | null | undefined): Verdict {
  const code = codeOf(body)
  if (status >= 200 && status < 300) return 'ok'
  if (status === 0) return 'offline'
  if (CALLER_CODES.has(code) || /^UNIT_CALLER_/.test(code)) return 'caller-unavailable'
  if (status === 401) return 'account-auth?'
  if (status === 403 && code === 'LOCAL_ONLY') return 'local-only'
  if ((status === 403 || status === 423) && /^REMOTE_/.test(code)) return 'refused'
  if (status === 404 && code === 'UNIT_NOT_FOUND') return 'gone'
  if (status === 413) return 'too-large'
  if (status === 429) return 'rate-limited'
  if (status === 503 && code === 'ENGINE_NOT_READY') return 'engine-unavailable'
  if (status === 503 && code === 'UNIT_OFFLINE') return 'offline'
  if (status === 502 || status === 504) return 'offline' // UNIT_DISCONNECTED / UNIT_TIMEOUT(hub 自己的网关错也按离线等)
  if (status >= 500) return 'transient'
  return 'fatal'
}

/** 请求抛出来的错误(网络错、headers() 失败关闭的 CALLER_UNAVAILABLE、超时)→ 类别。 */
export function classifyError(e: unknown): Verdict {
  const x = e as { code?: unknown; status?: unknown; name?: unknown } | null
  if (x && typeof x.code === 'string' && CALLER_CODES.has(x.code)) return 'caller-unavailable'
  if (x && typeof x.status === 'number' && x.status > 0) return classify(x.status, { code: x.code })
  return 'offline'
}

export type TargetHealthState = 'unknown' | 'ready' | 'offline' | 'engine-unavailable' | 'engine-auth' | 'rate-limited' | 'caller-unavailable' | 'refused' | 'gone'
/** 拒绝体里的调用方状态(P1-KF):REMOTE_CALLER_UNCONFIRMED 的 `state` / `reason` —— 文案按 reason 先、state 后选(localOnly.remoteCallerMessage)。 */
export type RefusalDetail = { state?: string; reason?: string }
export type TargetHealth =
  | { state: 'unknown' | 'ready' }
  | { state: 'offline' | 'engine-unavailable' | 'engine-auth' | 'rate-limited' | 'caller-unavailable' | 'refused'; since: number; retryAt?: number; code?: string; refusal?: RefusalDetail }
  | { state: 'gone' }

/** 响应体 → 拒绝细节(只取字符串的 state / reason;都没有 = undefined)。 */
export function refusalOf(body: unknown): RefusalDetail | undefined {
  const b = (body && typeof body === 'object' ? body : {}) as { state?: unknown; reason?: unknown }
  const out: RefusalDetail = {}
  if (typeof b.state === 'string') out.state = b.state
  if (typeof b.reason === 'string') out.reason = b.reason
  return out.state || out.reason ? out : undefined
}

/** 终局态:等不回来,waitReady 直接拒;SSE / 轮询见它就收尾。不自动重试(R-32),手动出口是 targets.retryFocusTarget。 */
export const TERMINAL_STATES: ReadonlySet<TargetHealthState> = new Set(['gone', 'caller-unavailable', 'engine-auth', 'refused'])
export const isTerminal = (h: TargetHealth): boolean => TERMINAL_STATES.has(h.state)
/** 可恢复态:探针退避等它自己好(焦点那台掉进来时宿主挂一个后台 waitReady,不靠「恰好有 SSE 在等」)。 */
export const RECOVERABLE_STATES: ReadonlySet<TargetHealthState> = new Set(['offline', 'engine-unavailable', 'rate-limited'])
export const isRecoverable = (h: TargetHealth): boolean => RECOVERABLE_STATES.has(h.state)

export const useTargetHealth = create<{ byKey: Partial<Record<TargetKey, TargetHealth>> }>(() => ({ byKey: {} }))

const UNKNOWN: TargetHealth = Object.freeze({ state: 'unknown' }) as TargetHealth

export function healthOf(key: TargetKey): TargetHealth {
  return useTargetHealth.getState().byKey[key] ?? UNKNOWN
}

const sameDetail = (a: TargetHealth, b: TargetHealth): boolean => {
  const ca = 'code' in a ? a.code : undefined, cb = 'code' in b ? b.code : undefined
  const ra = 'refusal' in a ? a.refusal : undefined, rb = 'refusal' in b ? b.refusal : undefined
  return ca === cb && ra?.state === rb?.state && ra?.reason === rb?.reason
}

/** 写一格健康状态。同态不重写 since(离线持续多久要准);同态但码 / 拒绝细节变了要重写(P1-KF:否则提示条停在旧原因的文案上)。 */
export function noteHealth(key: TargetKey, h: TargetHealth): void {
  const cur = useTargetHealth.getState().byKey[key]
  if (cur && cur.state === h.state && !('retryAt' in h && h.retryAt) && sameDetail(cur, h)) return
  const next = cur && cur.state === h.state && 'since' in cur && 'since' in h ? { ...h, since: cur.since } : h
  useTargetHealth.setState((s) => ({ byKey: { ...s.byKey, [key]: next } }))
}

/** 处置类别 → 健康状态(只有「关于这台引擎能不能用」的类别才写;local-only / too-large / fatal 是单条请求的事)。 */
export function noteVerdict(key: TargetKey, v: Verdict, extra: { retryAt?: number; code?: string; refusal?: RefusalDetail } = {}): void {
  const since = Date.now()
  switch (v) {
    case 'ok': noteHealth(key, { state: 'ready' }); return
    case 'offline': noteHealth(key, { state: 'offline', since, ...extra }); return
    case 'engine-unavailable': noteHealth(key, { state: 'engine-unavailable', since, ...extra }); return
    case 'rate-limited': noteHealth(key, { state: 'rate-limited', since, ...extra }); return
    case 'caller-unavailable': noteHealth(key, { state: 'caller-unavailable', since, ...extra }); return
    case 'refused': noteHealth(key, { state: 'refused', since, ...extra }); return
    case 'gone': noteHealth(key, { state: 'gone' }); return
    default: return
  }
}

/**
 * 一条**带鉴权**的 unit 请求拿到 2xx:hub、隧道、那台的引擎、凭据、调用方身份此刻都通 → 记 ready(一次 502 之后
 * 不必干等探针;轮询 / 看门狗随之解除暂停)。不复活 gone(设备 id 不会回来)。
 * ⚠️ 别拿 `/health` 的 200 调它:那条不鉴权,令牌漂了照样 200(testConnection 的注释)—— 调用方负责排除。
 */
export function noteReachable(key: TargetKey): void {
  if (healthOf(key).state === 'gone') return
  noteVerdict(key, 'ok')
}

/** @internal 焦点切换 / 测试:清一格或全部。 */
export function resetHealth(key?: TargetKey): void {
  if (!key) { useTargetHealth.setState({ byKey: {} }); return }
  useTargetHealth.setState((s) => {
    const byKey = { ...s.byKey }
    delete byKey[key]
    return { byKey }
  })
}

async function bodyOf(r: Response): Promise<{ code?: unknown } | null> {
  try { return await r.clone().json() } catch { return null }
}

/**
 * 健康探针:`GET /health`(不鉴权,判「在不在线 / 引擎起没起」)+ `GET /agent/special/config`(带鉴权,判凭据)。
 * 两条远端都是 allow。结果写进健康表并返回。401 → engine-auth(账号复检归 401 拦截器,这里只记这台引擎拒了)。
 */
export async function probeTarget(t: EngineTarget, signal?: AbortSignal): Promise<TargetHealth> {
  let v: Verdict
  let code: string | undefined
  let refusal: RefusalDetail | undefined
  try {
    const r = await engineFetch(t, '/health', signal ? { signal } : {}, { timeoutMs: 15000 })
    const b = r.ok ? null : await bodyOf(r)
    v = classify(r.status, b)
    code = codeOf(b) || undefined
    refusal = refusalOf(b)
    if (v === 'ok') {
      const p = await engineFetch(t, AUTH_PROBE_PATH, signal ? { signal } : {}, { timeoutMs: 15000 })
      const pb = p.ok ? null : await bodyOf(p)
      const pv = classify(p.status, pb)
      // 401 = 这台引擎(或 hub)拒了凭据;其余非 2xx(403 / 404 / 5xx)不把连接判死(与 testConnection 同口径)
      v = pv === 'account-auth?' ? 'account-auth?' : pv === 'caller-unavailable' || pv === 'refused' || pv === 'gone' ? pv : 'ok'
      code = codeOf(pb) || undefined
      refusal = refusalOf(pb)
    }
  } catch (e) {
    if (signal?.aborted) throw e
    v = classifyError(e)
    code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined
  }
  if (v === 'account-auth?') noteHealth(t.key, { state: 'engine-auth', since: Date.now() })
  else noteVerdict(t.key, v === 'transient' ? 'offline' : v, { ...(code ? { code } : {}), ...(refusal ? { refusal } : {}) })
  return healthOf(t.key)
}

// ── 等恢复 ──
/** 探针退避:2 → 4 → 8 → 16 → 30s 封顶。限流态另有 retryAt 时至少睡到那一刻(别在 429 的 hub 上按 2/4/8s 追打)。 */
export const PROBE_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000] as const
const RETRY_AT_CAP_MS = 120_000

function probeDelay(key: TargetKey, i: number): number {
  const backoff = PROBE_BACKOFF_MS[Math.min(i, PROBE_BACKOFF_MS.length - 1)]
  const h = healthOf(key)
  const until = h.state === 'rate-limited' && 'retryAt' in h && h.retryAt ? h.retryAt - Date.now() : 0
  return Math.max(backoff, Math.min(until, RETRY_AT_CAP_MS))
}

function refOfKey(key: TargetKey): TargetRef {
  return key === 'home' ? { kind: 'home' } : { kind: 'unit', unitId: key.slice('unit:'.length) }
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError')
}

/** 睡到 ms 或被唤醒(回前台 / 网络恢复 / 健康表被别人写成 ready 或终局)。 */
function sleepOrWake(key: TargetKey, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsub()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('online', finish)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => { finish(); resolve() }, ms)
    const onAbort = (): void => { finish(); reject(abortError(signal)) }
    const onVisible = (): void => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') { finish(); resolve() } }
    const unsub = useTargetHealth.subscribe((s) => {
      const h = s.byKey[key]
      if (h && (h.state === 'ready' || isTerminal(h))) { finish(); resolve() }
    })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('online', finish)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 终局态 → 给调用方的错误(带 code,消息由调用方本地化)。 */
export function healthError(h: TargetHealth): Error {
  const code = 'code' in h && h.code ? h.code : h.state === 'gone' ? 'UNIT_NOT_FOUND' : h.state === 'caller-unavailable' ? 'CALLER_UNAVAILABLE' : h.state.toUpperCase()
  return Object.assign(new Error(`Engine target ${h.state}`), { code, health: h.state })
}

/** 每个目标一条探针环;`ac` 在最后一个等待者离开时中止 —— 睡着的环立刻收工,**在飞的探针也一并撤掉**
 *  (否则焦点已经离开那台,慢到的探针结果还会把一格旧健康态写回表里)。 */
const loops = new Map<TargetKey, { p: Promise<void>; ac: AbortController }>()
/** 每个目标还有几个等待者:探针环只在有人等时才转(SSE 被中止、换了焦点、没人等了 → 立即收工,不对离线的电脑空探一整夜)。 */
const waiters = new Map<TargetKey, number>()

/** 同一目标的所有等待者共用一条探针环(不重复打 hub);环在 ready / 终局 / 没人等时结束。 */
function probeLoop(key: TargetKey): Promise<void> {
  const running = loops.get(key)
  if (running) return running.p
  const ac = new AbortController()
  const p = (async () => {
    for (let i = 0; ; i++) {
      const h = healthOf(key)
      if (h.state === 'ready') return
      if (isTerminal(h)) throw healthError(h)
      if (!waiters.get(key) || ac.signal.aborted) return
      try { await sleepOrWake(key, probeDelay(key, i), ac.signal) } catch { return } // 中止 = 没人等了
      const after = healthOf(key)
      if (after.state === 'ready') return
      if (isTerminal(after)) throw healthError(after)
      if (!waiters.get(key) || ac.signal.aborted) return
      const t = isTargetKey(key) ? targetForRef(refOfKey(key)) : null
      if (!t) throw healthError({ state: 'gone' })
      await probeTarget(t, ac.signal).catch(() => undefined) // 中止时 probeTarget 抛、不写表
    }
  })().finally(() => { if (loops.get(key)?.p === p) loops.delete(key) })
  loops.set(key, { p, ac })
  return p
}

/**
 * 等某个目标恢复可用。ready → 立即 resolve;终局(gone / caller-unavailable / engine-auth / refused)→ reject;
 * 其余(离线 / 引擎没起 / 限流)→ 按退避探针,期间回前台 / 网络恢复会提前探一次。signal 中止 → reject。
 */
export function waitReady(key: TargetKey, signal?: AbortSignal): Promise<void> {
  const h = healthOf(key)
  if (h.state === 'ready') return Promise.resolve()
  if (isTerminal(h)) return Promise.reject(healthError(h))
  if (signal?.aborted) return Promise.reject(abortError(signal))
  waiters.set(key, (waiters.get(key) ?? 0) + 1)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    const n = (waiters.get(key) ?? 1) - 1
    if (n > 0) { waiters.set(key, n); return }
    waiters.delete(key)
    // 最后一个等待者走了:当场撤掉这条环(先摘下再中止 —— 之后到的等待者起一条新环,不接上这条正在收工的)
    const loop = loops.get(key)
    if (loop) { loops.delete(key); loop.ac.abort() }
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { release(); reject(abortError(signal)) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => { signal?.removeEventListener('abort', onAbort); release() }
    probeLoop(key).then(
      () => {
        settle()
        // 环因「没人等了」收工而恰好被这位晚到的等待者接上:健康没好就重新等一轮,绝不假装已恢复
        if (healthOf(key).state === 'ready') resolve()
        else waitReady(key, signal).then(resolve, reject)
      },
      (e) => { settle(); reject(e) },
    )
  })
}
