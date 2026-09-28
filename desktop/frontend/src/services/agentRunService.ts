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
import { asTarget, isEngineTarget, type EngineArg } from './engine/targets'
import { currentPlatform } from './platform'

registerMessages({
  'agentrun.authFailed': { zh: '鉴权失败（401）：令牌无效或已过期', en: 'Authentication failed (401): the token is invalid or has expired' },
  'agentrun.connected': { zh: '已连接 · sandbox={sandbox}', en: 'Connected · sandbox={sandbox}' },
  'agentrun.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'agentrun.subscribeFailed': { zh: '订阅失败 ({status})', en: 'Event stream subscription failed ({status})' },
  'agentrun.stopUnconfirmed': { zh: '尚未确认任务停止，请重试停止操作。', en: 'The run has not confirmed it stopped. Please try stopping it again.' },
})

/** 对目标引擎发一条请求(P1-K6):基址与鉴权头都归目标(`asTarget`),本文件不再直读 cfg.backendUrl / cfg.token。
 *  头与改造前的 `headers(cfg.token)` 同形;opts 缺省时不传第三参,与改造前逐字一致。 */
async function engineRequest(cfg: EngineArg, path: string, init: RequestInit = {}, opts?: { timeoutMs?: number }): Promise<Response> {
  const t = asTarget(cfg)
  const req = { ...init, headers: await t.headers(true) }
  return opts ? authFetch(`${t.base}${path}`, req, opts) : authFetch(`${t.base}${path}`, req)
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

/** /health 之后追打的带鉴权探针:任一需要 authMiddleware 的轻量 GET 即可(special/config 无副作用、体积小)。 */
export const AUTH_PROBE_PATH = '/agent/special/config'

/** authRejected:探针 401(令牌被拒)。凭证问题不是瞬态连接故障 —— 调用方(boot 重试环)见它即停,自愈归 handleAuthExpired。 */
export async function testConnection(cfg: EngineArg): Promise<{ ok: boolean; message: string; authRejected?: boolean }> {
  try {
    const r = await engineRequest(cfg, '/health', {}, { timeoutMs: 15000 })
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    // /health 不鉴权(standalone/main.ts 直接 res.json)—— 令牌漂了它照样 200,connState 假绿,随后每个真请求
    // 各自 401(真机一轮 9 次)。再追一次带鉴权的 GET:**只认 401**(凭证被拒);403 / 404 / 5xx / 网络错是别的
    // 问题(云端面没有这条路由、配额、后端半启动),不把连接判死。authFetch 的 401 拦截器照常触发重登录自愈。
    const probe = await engineRequest(cfg, AUTH_PROBE_PATH, {}, { timeoutMs: 15000 }).catch(() => null)
    if (probe && probe.status === 401) return { ok: false, message: translate('agentrun.authFailed'), authRejected: true }
    return { ok: true, message: translate('agentrun.connected', { sandbox: j.sandbox ?? '?' }) }
  } catch (e: any) {
    return { ok: false, message: e?.message || translate('agentrun.connectFailed') }
  }
}

export async function startRun(
  cfg: EngineArg,
  params: {
    sessionId: string
    message: string
    modelId?: string
    attachments?: Attachment[]
    agentConfig?: AgentConfig
  },
): Promise<StartRunResult> {
  // 模型回退:老调用点传整份 cfg 时沿用 cfg.modelId(行为不变);目标本身不带模型(S2 起改走按目标的 modelFor)。
  const fallbackModel = isEngineTarget(cfg) ? undefined : cfg.modelId
  const r = await engineRequest(cfg, '/agent/runs', {
    method: 'POST',
    body: JSON.stringify({
      session_id: params.sessionId,
      model_id: params.modelId || fallbackModel || undefined,
      app_id: AGENT_APP_ID,
      client: currentClientId(),
      // 界面面能力握手 + 目录/设置快照(引擎侧 input.uiCommands/uiSettings → ToolContext)。
      // ⚠️ 字段**在场即代表本端会处理 `ui_cmd` 事件**,引擎据此 default-deny 三个界面工具;
      //    所以哪怕目录为空也要送(送空数组 ≠ 不送)。目录随端而异是正确行为。
      ui_commands: buildCommandCatalog(),
      ui_settings: readUiSettings(),
      // 同类握手:本端有输入框上方的审批托盘(views/chat2/ApprovalTray),待批卡能攒多张、各自兑现。
      approval_tray: true,
      message: params.message,
      attachments: params.attachments || [],
      agent_config: params.agentConfig || {},
    }),
  })
  // 远端拒绝码(设备页的工作目录落在受保护位置 → REMOTE_CWD_FORBIDDEN 等)换成本地化提示;其余照旧取 detail / 原文
  if (!r.ok) throw Object.assign(new Error((await httpErrorMessage(r)).message), { status: r.status })
  return r.json()
}

async function requestAbort(cfg: EngineArg, runId: string): Promise<{ settled?: boolean; status?: string }> {
  // 超时覆盖读取 body 的全过程,不只等 HTTP 响应头。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Stop request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(cfg, `/agent/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    signal: ac.signal,
    })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    return await r.json()
  } finally { clearTimeout(timer) }
}

export async function abortRun(cfg: EngineArg, runId: string): Promise<void> {
  await requestAbort(cfg, runId)
}

export type TerminalRunStatus = 'done' | 'failed' | 'aborted'
function isTerminalStatus(status: unknown): status is TerminalRunStatus {
  return status === 'done' || status === 'failed' || status === 'aborted'
}

/** 保留 SSE 订阅直到真终态。新引擎等 finally;旧引擎回退到显式的终态记录,空列表不是证明。 */
export async function abortRunAndWait(cfg: EngineArg, runId: string, sessionId: string): Promise<TerminalRunStatus> {
  const deadline = Date.now() + 10_000
  do {
    const result = await requestAbort(cfg, runId)
    if (result.settled === true && isTerminalStatus(result.status)) return result.status
    if (result.settled === undefined) {
      const run = (await listActiveRuns(cfg, sessionId)).find((r) => r.id === runId)
      if (run && isTerminalStatus(run.status)) return run.status
    }
    if (Date.now() >= deadline) break
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(translate('agentrun.stopUnconfirmed'))
}

/** 运行时转向:把消息注入仍在跑的 run(下一迭代生效)。run 已结束 → 409 返回 {ok:false,reason:'not_active'},前端回退起新 run。 */
export async function steerRun(
  cfg: EngineArg,
  runId: string,
  params: { message: string; attachments?: Attachment[] },
): Promise<{ ok: boolean; reason?: string; userMessageId?: string }> {
  const r = await engineRequest(cfg, `/agent/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ message: params.message, attachments: params.attachments || [] }),
  })
  if (r.status === 409) return { ok: false, reason: 'not_active' }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  const j = await r.json().catch(() => ({}))
  return { ok: true, userMessageId: j.userMessageId }
}

/** Wake queued input in the SAME run. Old engines may reject flush; never fall back to abort. */
export async function expediteSteer(cfg: EngineArg, runId: string): Promise<{ ok: boolean }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Steering request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(cfg, `/agent/runs/${encodeURIComponent(runId)}/steer`, {
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
  cfg: EngineArg,
  runId: string,
  messageId: string,
): Promise<{ ok: boolean; gone?: boolean }> {
  const r = await engineRequest(cfg, `/agent/runs/${encodeURIComponent(runId)}/steer/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  })
  if (r.status === 404) return { ok: false, gone: true }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return { ok: true }
}

/** 列出某会话的在飞/最近 run(刷新恢复:重新挂 SSE)。 */
export async function listActiveRuns(
  cfg: EngineArg,
  sessionId: string,
): Promise<Array<{ id: string; status: string; assistant_message_id: string | null }>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Run status request timed out', 'TimeoutError')), 5000)
  try {
    const r = await engineRequest(cfg, `/agent/runs?session_id=${encodeURIComponent(sessionId)}`, {
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
  cfg: EngineArg,
  runId: string,
  inquiryId: string,
  answer: string,
): Promise<{ ok: boolean; gone: boolean }> {
  const r = await engineRequest(
    cfg,
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
  cfg: EngineArg,
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
      const r = await engineRequest(cfg, path, { method: 'POST', body: JSON.stringify(body) })
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
  cfg: EngineArg,
  runId: string,
  shotId: string,
  body: { dataUrl?: string; mode?: 'card' | 'open'; companion?: string; error?: string },
): Promise<void> {
  await engineRequest(
    cfg,
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
  cfg: EngineArg,
  runId: string,
  approvalId: string,
  action: 'approve' | 'approve_always' | 'reject',
  argsOverride?: Record<string, any>,
): Promise<{ ok: boolean; gone: boolean; message?: string; code?: string }> {
  const r = await engineRequest(
    cfg,
    `/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', body: JSON.stringify({ action, argsOverride }) },
    { timeoutMs: DECIDE_TIMEOUT_MS },
  )
  if (r.ok || r.status === 410) return { ok: r.ok, gone: r.status === 410 }
  return { ok: false, gone: false, ...(await httpErrorMessage(r)) }
}

/** 订阅 run 的 SSE 事件流;onEvent 收到每条 {seq,type,payload}。done/error 时返回。 */
export async function subscribeRunEvents(
  cfg: EngineArg,
  runId: string,
  onEvent: (ev: AgentRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let lastSeq = 0
  let failures = 0
  const MAX = 6

  while (true) {
    if (signal?.aborted) return
    let res: Response
    try {
      res = await engineRequest(
        cfg,
        `/agent/runs/${encodeURIComponent(runId)}/events?fromSeq=${lastSeq}`,
        { signal },
      )
    } catch (e) {
      if (signal?.aborted) return
      if (++failures > MAX) throw e
      await delay(1000 * failures)
      continue
    }
    if (res.status >= 400 && res.status < 500) throw new Error(translate('agentrun.subscribeFailed', { status: res.status }))
    if (!res.ok || !res.body) {
      if (++failures > MAX) throw new Error(`HTTP ${res.status}`)
      await delay(1000 * failures)
      continue
    }
    failures = 0

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
            if (ev.seq > lastSeq) lastSeq = ev.seq
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
