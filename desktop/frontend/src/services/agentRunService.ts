/**
 * renderer 直连 standalone Tangu 服务(localhost)。
 * SSE 用 fetch + ReadableStream(EventSource 不能带 Bearer);seq 去重 + 断线重连 + fromSeq 续传。
 * 复刻 apps/Forsion-AI-Studio/client/services/cloudAgentService.ts 的成熟模式。
 */
import type { AgentConfig, AgentRunEvent, Attachment, StartRunResult } from '../types'
import { APP_VERSION } from '../changelog'
import { registerMessages, translate } from '../i18n'
import { authFetch } from './http'
import { httpErrorMessage } from './localOnly'
import { buildCommandCatalog, readUiSettings } from '../agentCommands'
import { fetchOpts, targetLabel, type EngineTarget } from './engine/targets'
import { AUTH_PROBE_PATH as PROBE_PATH, classify, classifyError, noteReachable, noteVerdict, refusalOf, waitReady, type Verdict } from './engine/health'
import { remoteRefusalMessage } from './localOnly'
import './engine/messages'
import { currentPlatform } from './platform'
import { collectClientCapabilities } from './clientSurfaces'

registerMessages({
  'agentrun.authFailed': { zh: '鉴权失败（401）：令牌无效或已过期', en: 'Authentication failed (401): the token is invalid or has expired' },
  'agentrun.connected': { zh: '已连接 · sandbox={sandbox}', en: 'Connected · sandbox={sandbox}' },
  'agentrun.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'agentrun.subscribeFailed': { zh: '订阅失败 ({status})', en: 'Event stream subscription failed ({status})' },
  'agentrun.stopUnconfirmed': { zh: '尚未确认任务停止，请重试停止操作。', en: 'The run has not confirmed it stopped. Please try stopping it again.' },
})

/** 对目标引擎发一条请求(P1-K6):基址与鉴权头都归目标,本文件不读 cfg。
 *  头与改造前的 `headers(cfg.token)` 同形;home 目标 opts 缺省时不传第三参,与改造前逐字一致;
 *  非 home 目标恒带 `target`(401 分流,§3.5)。
 *  S3 起本文件的函数只收解析层给的目标:会话类由调用方传 targetForSession(sid)(run 类同理,sid 在调用方手里),
 *  testConnection 探调用方指定的那台(焦点 / 设置页外部连接表单的 connectionTarget)。 */
async function engineRequest(t: EngineTarget, path: string, init: RequestInit = {}, opts?: { timeoutMs?: number }): Promise<Response> {
  const req = { ...init, headers: await t.headers(true) }
  const o = fetchOpts(t, opts?.timeoutMs)
  const r = await (o ? authFetch(`${t.base}${path}`, req, o) : authFetch(`${t.base}${path}`, req))
  // unit 的带鉴权请求 2xx → 这台此刻是通的(与 backendService.request 同口径)。/health 不鉴权(令牌漂了照样 200),不算数。
  if (t.via === 'unit' && r.ok && path !== '/health') noteReachable(t.key)
  return r
}

/**
 * 本客户端(桌面 / web / mobile)全端共用的 app id。桌面 standalone 基线本就应答它,云端 worker 经
 * appProfiles.config 文件层覆盖同样认它(2026-07-17 弃用独立 'tangu-web')。
 * 任何要按 app 解析配置的端点(run / models / …)都得带上,否则云端会落到 worker 基线 'ai-studio'。
 */
export const AGENT_APP_ID = 'tangu'

/**
 * 客户端面标识(统计维度,与 app_id **正交** —— 归属恒为 'tangu',在哪个端调的用这个分):
 * `desktop|web|mobile / 渲染层版本`。随 run 体上报,落 agent_runs.input.client,
 * admin 的 /client-stats 按它分组。必须在**请求时**读取宿主垫片:共享模块可能比 web/mobile
 * shim 更早求值,若在模块加载时冻结,该进程之后所有请求都会被永久误记成 desktop。
 */
/** 端判定**单源**(方案 D6):新会话现已全端默认 Work，但工作区落点等逻辑仍需识别端。实现住叶子模块
 *  services/platform.ts(P1-K6 搬过去,解开与引擎目标解析层的循环依赖),这里 re-export,既有 import 不变。 */
export { currentPlatform, type ClientPlatform } from './platform'
export function currentClientId(): string {
  return `${currentPlatform()}/${APP_VERSION || '0'}`
}

/** /health 之后追打的带鉴权探针:任一需要 authMiddleware 的轻量 GET 即可(special/config 无副作用、体积小)。
 *  单源在 services/engine/health.ts(健康探针同一条),这里 re-export,既有 import 不变。 */
export const AUTH_PROBE_PATH = PROBE_PATH

/** authRejected:探针 401(令牌被拒)。凭证问题不是瞬态连接故障 —— 调用方(boot 重试环)见它即停,自愈归 handleAuthExpired。 */
export async function testConnection(t: EngineTarget): Promise<{ ok: boolean; message: string; authRejected?: boolean; verdict?: Verdict }> {
  // 目录类(§3.3 target 类):探的是**调用方指定的那台**(设置页外部连接表单现拼的 connectionTarget / appStore 的焦点),不按会话路由。
  try {
    const r = await engineRequest(t, '/health', {}, { timeoutMs: 15000 })
    if (!r.ok) {
      // unit 目标(经 hub):离线 / 引擎没起 / 设备被移除 / 调用方身份取不到各给一句人话,并把类别带回去(appStore 据此定健康态)
      if (t.via === 'unit') {
        const body = await r.clone().json().catch(() => null) as { code?: string } | null
        const verdict = classify(r.status, body)
        noteVerdict(t.key, verdict, noteExtra(body))
        return { ok: false, message: unitFailureMessage(t, verdict, body?.code, body) || `HTTP ${r.status}`, verdict }
      }
      return { ok: false, message: `HTTP ${r.status}` }
    }
    const j = await r.json().catch(() => ({}))
    // /health 不鉴权(standalone/main.ts 直接 res.json)—— 令牌漂了它照样 200,connState 假绿,随后每个真请求
    // 各自 401(真机一轮 9 次)。再追一次带鉴权的 GET:**只认 401**(凭证被拒);403 / 404 / 5xx / 网络错是别的
    // 问题(云端面没有这条路由、配额、后端半启动),不把连接判死。authFetch 的 401 拦截器照常触发重登录自愈。
    const probe = await engineRequest(t, AUTH_PROBE_PATH, {}, { timeoutMs: 15000 }).catch(() => null)
    if (probe && probe.status === 401) return { ok: false, message: translate('agentrun.authFailed'), authRejected: true }
    if (t.via === 'unit') {
      // 带鉴权的那条被执行设备 / hub 按调用方拒了(身份、远程会话开关、急停)= 这台连不上,不是「已连接」
      const pb = probe && !probe.ok ? await probe.clone().json().catch(() => null) as { code?: string } | null : null
      const pv = probe && !probe.ok ? classify(probe.status, pb) : 'ok'
      if (pv === 'caller-unavailable' || pv === 'refused' || pv === 'gone') {
        noteVerdict(t.key, pv, noteExtra(pb))
        return { ok: false, message: unitFailureMessage(t, pv, pb?.code, pb) || `HTTP ${probe!.status}`, verdict: pv }
      }
      noteVerdict(t.key, 'ok')
    }
    return { ok: true, message: translate('agentrun.connected', { sandbox: j.sandbox ?? '?' }) }
  } catch (e: any) {
    if (t.via === 'unit') {
      const verdict = classifyError(e)
      noteVerdict(t.key, verdict, typeof e?.code === 'string' ? { code: e.code } : {})
      return { ok: false, message: unitFailureMessage(t, verdict, e?.code) || e?.message || translate('agentrun.connectFailed'), verdict }
    }
    return { ok: false, message: e?.message || translate('agentrun.connectFailed') }
  }
}

/** 失败响应体 → 记健康表的附带信息:码 + 拒绝细节(REMOTE_CALLER_UNCONFIRMED 的 state / reason,P1-KF)。 */
export function noteExtra(body: unknown): { code?: string; refusal?: { state?: string; reason?: string } } {
  const code = (body as { code?: unknown } | null)?.code
  const refusal = refusalOf(body)
  return { ...(typeof code === 'string' && code ? { code } : {}), ...(refusal ? { refusal } : {}) }
}

/**
 * unit 目标的失败 → 一句人话(拒绝码优先走 localOnly 的本地化表;其余按类别给 engine.target.*)。认不出 → null。
 * body = 同一个失败响应体(P1-KF):REMOTE_CALLER_UNCONFIRMED 按它的 reason / state 分句,只凭码会一律说「正在等待确认」。
 */
export function unitFailureMessage(t: EngineTarget, v: Verdict, code?: unknown, body?: unknown): string | null {
  const refusal = remoteRefusalMessage(code, body)
  if (refusal) return refusal
  const name = targetLabel(t)
  switch (v) {
    case 'offline': return translate('engine.target.offline', { name })
    case 'engine-unavailable': return translate('engine.target.engineUnavailable', { name })
    case 'account-auth?': return translate('engine.target.engineAuth', { name })
    case 'gone': return translate('engine.target.gone')
    case 'rate-limited': return translate('engine.target.rateLimited')
    case 'too-large': return translate('engine.target.tooLarge')
    case 'caller-unavailable': return translate('engine.target.callerUnavailable', { name })
    case 'refused': return translate('engine.target.refused', { name })
    default: return null
  }
}

export async function startRun(
  t: EngineTarget,
  params: {
    sessionId: string
    message: string
    modelId?: string
    attachments?: Attachment[]
    agentConfig?: AgentConfig
  },
): Promise<StartRunResult> {
  // 模型:目标不带模型,回退链只在调用方(appStore.send 的 sessionModelId:会话的 → 按目标的缺省 → 目录 defaultModelId,
  // home 缺省即 cfg.modelId —— 改造前这里对 legacy cfg 的兜底与它同值,S3 删掉)。空 = 交给引擎按 profile 缺省。
  const r = await engineRequest(t, '/agent/runs', {
    method: 'POST',
    body: JSON.stringify({
      session_id: params.sessionId,
      model_id: params.modelId || undefined,
      app_id: AGENT_APP_ID,
      client: currentClientId(),
      // 界面面能力握手 + 目录/设置快照(引擎侧 input.uiCommands/uiSettings → ToolContext)。
      // ⚠️ 字段**在场即代表本端会处理 `ui_cmd` 事件**,引擎据此 default-deny 三个界面工具;
      //    所以哪怕目录为空也要送(送空数组 ≠ 不送)。目录随端而异是正确行为。
      ui_commands: buildCommandCatalog(),
      ui_settings: readUiSettings(),
      // 同类握手:本端有输入框上方的审批托盘(views/chat2/ApprovalTray),待批卡能攒多张、各自兑现。
      approval_tray: true,
      // Native UI is declarative; this capability advertises a renderer, not a client command surface.
      // 引擎据此 default-deny `clientCapability` 工具;请求时现算(移动端开关随时会变)。
      client_capabilities: [...collectClientCapabilities(), ...(currentPlatform() !== 'mobile' ? ['intelligent-ui.v1'] : [])],
      message: params.message,
      attachments: params.attachments || [],
      agent_config: params.agentConfig || {},
    }),
  })
  // 远端拒绝码(设备页的工作目录落在受保护位置 → REMOTE_CWD_FORBIDDEN 等)换成本地化提示;其余照旧取 detail / 原文
  if (!r.ok) throw Object.assign(new Error((await httpErrorMessage(r)).message), { status: r.status })
  return r.json()
}

async function requestAbort(t: EngineTarget, runId: string): Promise<{ settled?: boolean; status?: string }> {
  // 超时覆盖读取 body 的全过程,不只等 HTTP 响应头。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Stop request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(t, `/agent/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    signal: ac.signal,
    })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    return await r.json()
  } finally { clearTimeout(timer) }
}

export async function abortRun(t: EngineTarget, runId: string): Promise<void> {
  await requestAbort(t, runId)
}

export type TerminalRunStatus = 'done' | 'failed' | 'aborted'
function isTerminalStatus(status: unknown): status is TerminalRunStatus {
  return status === 'done' || status === 'failed' || status === 'aborted'
}

/** 保留 SSE 订阅直到真终态。新引擎等 finally;旧引擎回退到显式的终态记录,空列表不是证明。 */
export async function abortRunAndWait(t: EngineTarget, runId: string, sessionId: string): Promise<TerminalRunStatus> {
  const deadline = Date.now() + 10_000
  do {
    const result = await requestAbort(t, runId)
    if (result.settled === true && isTerminalStatus(result.status)) return result.status
    if (result.settled === undefined) {
      const run = (await listActiveRuns(t, sessionId)).find((r) => r.id === runId)
      if (run && isTerminalStatus(run.status)) return run.status
    }
    if (Date.now() >= deadline) break
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(translate('agentrun.stopUnconfirmed'))
}

/** 运行时转向:把消息注入仍在跑的 run(下一迭代生效)。run 已结束 → 409 返回 {ok:false,reason:'not_active'},前端回退起新 run。 */
export async function steerRun(
  t: EngineTarget,
  runId: string,
  params: { message: string; attachments?: Attachment[] },
): Promise<{ ok: boolean; reason?: string; userMessageId?: string }> {
  const r = await engineRequest(t, `/agent/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ message: params.message, attachments: params.attachments || [] }),
  })
  if (r.status === 409) return { ok: false, reason: 'not_active' }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  const j = await r.json().catch(() => ({}))
  return { ok: true, userMessageId: j.userMessageId }
}

/** Wake queued input in the SAME run. Old engines may reject flush; never fall back to abort. */
export async function expediteSteer(t: EngineTarget, runId: string): Promise<{ ok: boolean }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Steering request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(t, `/agent/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST', signal: ac.signal, body: JSON.stringify({ flush: true }),
    })
    if (r.status === 409) return { ok: false }
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    const result = await r.json()
    if (result.ok !== true) throw new Error('Steering was not acknowledged')
    return { ok: true }
  } finally { clearTimeout(timer) }
}

/** 撤回一条尚未注入的转向消息。gone=true:已注入或 run 已终结(来不及了,交给事件流收拾)。 */
export async function cancelSteer(
  t: EngineTarget,
  runId: string,
  messageId: string,
): Promise<{ ok: boolean; gone?: boolean }> {
  const r = await engineRequest(t, `/agent/runs/${encodeURIComponent(runId)}/steer/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  })
  if (r.status === 404) return { ok: false, gone: true }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return { ok: true }
}

/** 列出某会话的在飞/最近 run(刷新恢复:重新挂 SSE)。 */
export async function listActiveRuns(
  t: EngineTarget,
  sessionId: string,
): Promise<Array<{ id: string; status: string; assistant_message_id: string | null }>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Run status request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(t, `/agent/runs?session_id=${encodeURIComponent(sessionId)}`, {
      signal: ac.signal,
    })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    const j = await r.json()
    if (!Array.isArray(j.runs)) throw new Error('Invalid run status response')
    return j.runs
  } finally { clearTimeout(timer) }
}

/** 兑现一次询问(ask_user/exit_plan_mode)。410 = 已不在等待(过期/他端已处理)。 */
export async function resolveInquiry(
  t: EngineTarget,
  runId: string,
  inquiryId: string,
  answer: string,
): Promise<{ ok: boolean; gone: boolean }> {
  const r = await engineRequest(
    t,
    `/agent/runs/${encodeURIComponent(runId)}/inquiries/${encodeURIComponent(inquiryId)}`,
    { method: 'POST', body: JSON.stringify({ answer }) },
    { timeoutMs: DECIDE_TIMEOUT_MS },
  )
  return { ok: r.ok, gone: r.status === 410 }
}

/**
 * 兑现一次界面动作请求(`ui_cmd`)。**成败都要发** —— 引擎那头在等,不发就是让用户干等 8 秒超时。
 *
 * ⚠️ 走的是 `/inquiries/:ackId` 而不是自开一条路由:云端网关只代理 runs/abort/approvals/inquiries
 *    四条,新路由在 web 与移动端根本到不了 worker。引擎按 `ui_` 前缀分流(routes/approvals.ts)。
 * 网络异常吞掉:重试没意义(引擎 8s 就超时了),这是纯附加能力,不该冒泡打断会话。
 */
export async function sendUiAck(
  t: EngineTarget,
  runId: string,
  ackId: string,
  body: { ok: boolean; error?: string; state?: string; settings?: Record<string, string> },
): Promise<string> {
  const path = `/agent/runs/${encodeURIComponent(runId)}/inquiries/${encodeURIComponent(ackId)}`
  // ⚠️ 界面已经改完了才发这条回执,所以「发丢了」= 用户看见变化、模型被告知失败(Codex 评审 P1-5)。
  //    重试一次是安全的:引擎侧先到先得,重复的那次拿 410,而 410 恰恰说明前一次已被消费。
  //    只重试网络异常与 5xx;4xx(含 410)是终局,再打没有意义。
  // 返回值 = HTTP 状态或 'network',只进诊断缓冲(diag.ts);永不抛。
  let outcome = 'network'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await engineRequest(t, path, { method: 'POST', body: JSON.stringify(body) })
      outcome = String(r.status)
      if (r.ok || (r.status >= 400 && r.status < 500)) return outcome
    } catch { outcome = 'network' /* 网络异常 → 落到下面重试一次 */ }
    if (attempt === 0) await delay(400)
  }
  return outcome
}

/** 兑现一次 Agent Desk 截屏请求(desk_screenshot)。失败也要发——引擎那头在等,不发就是干等超时。
 *  网络异常吞掉:重试没意义(引擎 8s 就超时了),这是纯附加能力,不该冒泡打断会话。 */
export async function sendDeskCapture(
  t: EngineTarget,
  runId: string,
  shotId: string,
  body: { dataUrl?: string; mode?: 'card' | 'open'; companion?: string; error?: string },
): Promise<void> {
  await engineRequest(
    t,
    `/agent/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(shotId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  ).catch(() => {})
}

/** 审批 / 询问的兑现请求超时:托盘在回执前锁着这一项,请求挂住不返回就永远解不了锁(按「没送达」解锁、提示重试)。 */
const DECIDE_TIMEOUT_MS = 15_000

/** 兑现一次 host-exec 审批。410 = 已不在等待(过期/他端已处理)。
 *  其余非 2xx 带回 message(远端改参数 → REMOTE_ARGS_OVERRIDE_FORBIDDEN 等已本地化):调用方必须上屏,
 *  否则点了「批准」什么都不发生、卡片一直挂着(Codex 终审 F#2)。 */
export async function resolveApproval(
  t: EngineTarget,
  runId: string,
  approvalId: string,
  action: 'approve' | 'approve_always' | 'reject',
  argsOverride?: Record<string, any>,
): Promise<{ ok: boolean; gone: boolean; message?: string; code?: string }> {
  const r = await engineRequest(
    t,
    `/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', body: JSON.stringify({ action, argsOverride }) },
    { timeoutMs: DECIDE_TIMEOUT_MS },
  )
  if (r.ok || r.status === 410) return { ok: r.ok, gone: r.status === 410 }
  return { ok: false, gone: false, ...(await httpErrorMessage(r)) }
}

/** 429 的等待:Retry-After(秒或 HTTP 日期)缺省 10s,钳在 1s–120s。 */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get('Retry-After')
  let ms = 10_000
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs)) ms = secs * 1000
    else {
      const at = Date.parse(raw)
      if (Number.isFinite(at)) ms = at - Date.now()
    }
  }
  return Math.min(120_000, Math.max(1000, ms))
}

/** 可被中止的睡眠(中止 = 立即返回,由调用方看 signal.aborted 收尾)。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 订阅 run 的 SSE 事件流;onEvent 收到每条 {seq,type,payload}。done/error 时返回。
 *
 * P1-K6 S2 · 重试策略按目标(§3.6),目标在订阅时解析一次,重连一直打同一台(换焦点会中止整条订阅):
 *   干净断流且非终态 → 800ms 后以 fromSeq 续订(两类目标同;覆盖 hub 1h 总时长 / 15min 空闲断流)
 *   429               → 按 Retry-After(缺省 10s)续订,不计失败次数(改造前 4xx 一律抛 = 限流直接杀流)
 *   unit 离线类       → 503 UNIT_OFFLINE / 502 / 504 / 网络错 / 503 ENGINE_NOT_READY:**暂停**等 waitReady(探针退避),
 *                       恢复后以原 lastSeq 续订,不把消息标错
 *   unit 终局         → 404 UNIT_NOT_FOUND / 调用方身份(503 CALLER_* / 403 UNIT_CALLER_* / BAD_CALLER_ASSERTION)/
 *                       执行设备拒绝(403 REMOTE_* / 423)/ 其它 4xx:抛,健康表记下(不无限重试,R-32)
 *   home 5xx / 网络错 → 重试 6 次(约 21s)后抛(不变);home 其它 4xx → 抛(不变)
 */
export async function subscribeRunEvents(
  t: EngineTarget,
  runId: string,
  onEvent: (ev: AgentRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const unit = t.via === 'unit'
  let lastSeq = 0
  let failures = 0
  const MAX = 6
  /** unit 离线类:记健康、等恢复。中止 → 返回 false(调用方退出);终局 → 抛。 */
  const pause = async (v: Verdict, code?: string): Promise<boolean> => {
    noteVerdict(t.key, v, code ? { code } : {})
    try {
      await waitReady(t.key, signal)
      return true
    } catch (e) {
      if (signal?.aborted) return false
      throw e
    }
  }
  const unitFail = (v: Verdict, status: number, code?: string, body?: unknown): Error => {
    noteVerdict(t.key, v, { ...(code ? { code } : {}), ...noteExtra(body) })
    return Object.assign(new Error(unitFailureMessage(t, v, code, body) || translate('agentrun.subscribeFailed', { status })), { status, ...(code ? { code } : {}) })
  }

  while (true) {
    if (signal?.aborted) return
    let res: Response
    try {
      res = await engineRequest(
        t,
        `/agent/runs/${encodeURIComponent(runId)}/events?fromSeq=${lastSeq}`,
        { signal },
      )
    } catch (e) {
      if (signal?.aborted) return
      if (unit) {
        const v = classifyError(e)
        if (v === 'caller-unavailable') { noteVerdict(t.key, v, { code: (e as { code?: string }).code || 'CALLER_UNAVAILABLE' }); throw e }
        if (!(await pause('offline'))) return
        continue
      }
      if (++failures > MAX) throw e
      await delay(1000 * failures)
      continue
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res)
      if (unit) noteVerdict(t.key, 'rate-limited', { retryAt: Date.now() + wait })
      await sleep(wait, signal)
      continue
    }
    if (unit && !res.ok) {
      const body = await res.clone().json().catch(() => null) as { code?: string } | null
      const code = typeof body?.code === 'string' ? body.code : undefined
      const v = classify(res.status, body)
      if (v === 'offline' || v === 'engine-unavailable') {
        if (!(await pause(v, code))) return
        continue
      }
      if (v === 'transient') {
        if (++failures > MAX) throw unitFail(v, res.status, code, body)
        await delay(1000 * failures)
        continue
      }
      throw unitFail(v, res.status, code, body)
    }
    if (res.status >= 400 && res.status < 500) throw new Error(translate('agentrun.subscribeFailed', { status: res.status }))
    if (!res.ok || !res.body) {
      if (++failures > MAX) throw new Error(`HTTP ${res.status}`)
      await delay(1000 * failures)
      continue
    }
    failures = 0
    if (unit) noteVerdict(t.key, 'ok')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let terminal = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t || t.startsWith(':')) continue // 跳过心跳/注释
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).replace(/^ /, '')
          if (!data) continue
          try {
            const ev = JSON.parse(data) as AgentRunEvent
            // M1B:按 seq 去重。引擎只在单条流内去重;续订若从更早处回放(hub / 设备重连后 fromSeq 被改回 0、引擎重放),
            // 已送达的事件会再来一遍 —— token 会被 reducer 再拼一次(check:streamrenew 的回放场景)。seq ≤ 已见最大值 = 见过,丢掉。
            if (Number.isFinite(ev.seq)) {
              if (ev.seq <= lastSeq) continue
              lastSeq = ev.seq
            }
            onEvent(ev)
            if (ev.type === 'done' || ev.type === 'error') terminal = true
          } catch {
            /* 跳过坏行 */
          }
        }
        if (terminal) return
      }
    } catch (e) {
      if (signal?.aborted) return
    }
    if (terminal || signal?.aborted) return
    await delay(800)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
