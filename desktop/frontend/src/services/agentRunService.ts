/**
 * renderer 直连 standalone Tangu 服务(localhost)。
 * SSE 用 fetch + ReadableStream(EventSource 不能带 Bearer);seq 去重 + 断线重连 + fromSeq 续传。
 * 复刻 apps/Forsion-AI-Studio/client/services/cloudAgentService.ts 的成熟模式。
 */
import type { AgentConfig, AgentRunEvent, Attachment, StartRunResult, TanguDesktopConfig } from '../types'
import { CHANGELOG } from '../changelog'
import { registerMessages, translate } from '../i18n'
import { authFetch } from './http'
import { buildCommandCatalog, readUiSettings } from '../agentCommands'

registerMessages({
  'agentrun.authFailed': { zh: '鉴权失败(401):令牌无效或已过期', en: 'Authentication failed (401): the token is invalid or has expired' },
  'agentrun.connected': { zh: '已连接 · sandbox={sandbox}', en: 'Connected · sandbox={sandbox}' },
  'agentrun.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'agentrun.subscribeFailed': { zh: '订阅失败 ({status})', en: 'Event stream subscription failed ({status})' },
  'agentrun.stopUnconfirmed': { zh: '尚未确认任务停止，请重试停止操作。', en: 'The run has not confirmed it stopped. Please try stopping it again.' },
})

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
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
export type ClientPlatform = 'desktop' | 'web' | 'mobile'
/** 端判定**单源**(方案 D6):新会话现已全端默认 Work，但工作区落点等逻辑仍需识别端。每次调用现算——同上,
 *  提到模块级常量会把之后所有判定永久冻成 desktop;别处不许再写第二份 `window.tangu?.X` 判定,也不许
 *  拿 currentClientId().split('/')[0] 绕。本文件在 platform-parity 的 GATE_FILES 台账里。 */
export function currentPlatform(): ClientPlatform {
  return typeof window === 'undefined' ? 'desktop' // node 环境(vitest)兜底,浏览器里恒有 window
    : window.tangu?.mobile ? 'mobile'
    : window.tangu?.cloudWeb ? 'web'
    : 'desktop'
}
export function currentClientId(): string {
  return `${currentPlatform()}/${CHANGELOG[0]?.version || '0'}`
}

/** /health 之后追打的带鉴权探针:任一需要 authMiddleware 的轻量 GET 即可(special/config 无副作用、体积小)。 */
export const AUTH_PROBE_PATH = '/agent/special/config'

/** authRejected:探针 401(令牌被拒)。凭证问题不是瞬态连接故障 —— 调用方(boot 重试环)见它即停,自愈归 handleAuthExpired。 */
export async function testConnection(cfg: TanguDesktopConfig): Promise<{ ok: boolean; message: string; authRejected?: boolean }> {
  try {
    const r = await authFetch(`${cfg.backendUrl}/health`, { headers: headers(cfg.token) }, { timeoutMs: 15000 })
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    // /health 不鉴权(standalone/main.ts 直接 res.json)—— 令牌漂了它照样 200,connState 假绿,随后每个真请求
    // 各自 401(真机一轮 9 次)。再追一次带鉴权的 GET:**只认 401**(凭证被拒);403 / 404 / 5xx / 网络错是别的
    // 问题(云端面没有这条路由、配额、后端半启动),不把连接判死。authFetch 的 401 拦截器照常触发重登录自愈。
    const probe = await authFetch(`${cfg.backendUrl}${AUTH_PROBE_PATH}`, { headers: headers(cfg.token) }, { timeoutMs: 15000 }).catch(() => null)
    if (probe && probe.status === 401) return { ok: false, message: translate('agentrun.authFailed'), authRejected: true }
    return { ok: true, message: translate('agentrun.connected', { sandbox: j.sandbox ?? '?' }) }
  } catch (e: any) {
    return { ok: false, message: e?.message || translate('agentrun.connectFailed') }
  }
}

export async function startRun(
  cfg: TanguDesktopConfig,
  params: {
    sessionId: string
    message: string
    modelId?: string
    attachments?: Attachment[]
    agentConfig?: AgentConfig
  },
): Promise<StartRunResult> {
  const r = await authFetch(`${cfg.backendUrl}/agent/runs`, {
    method: 'POST',
    headers: headers(cfg.token),
    body: JSON.stringify({
      session_id: params.sessionId,
      model_id: params.modelId || cfg.modelId || undefined,
      app_id: AGENT_APP_ID,
      client: currentClientId(),
      // 界面面能力握手 + 目录/设置快照(引擎侧 input.uiCommands/uiSettings → ToolContext)。
      // ⚠️ 字段**在场即代表本端会处理 `ui_cmd` 事件**,引擎据此 default-deny 三个界面工具;
      //    所以哪怕目录为空也要送(送空数组 ≠ 不送)。目录随端而异是正确行为。
      ui_commands: buildCommandCatalog(),
      ui_settings: readUiSettings(),
      message: params.message,
      attachments: params.attachments || [],
      agent_config: params.agentConfig || {},
    }),
  })
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return r.json()
}

async function requestAbort(cfg: TanguDesktopConfig, runId: string): Promise<{ settled?: boolean; status?: string }> {
  // 超时覆盖读取 body 的全过程,不只等 HTTP 响应头。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Stop request timed out', 'TimeoutError')), 5000)
  try {
    const r = await authFetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    headers: headers(cfg.token),
    signal: ac.signal,
    })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    return await r.json()
  } finally { clearTimeout(timer) }
}

export async function abortRun(cfg: TanguDesktopConfig, runId: string): Promise<void> {
  await requestAbort(cfg, runId)
}

export type TerminalRunStatus = 'done' | 'failed' | 'aborted'
function isTerminalStatus(status: unknown): status is TerminalRunStatus {
  return status === 'done' || status === 'failed' || status === 'aborted'
}

/** 保留 SSE 订阅直到真终态。新引擎等 finally;旧引擎回退到显式的终态记录,空列表不是证明。 */
export async function abortRunAndWait(cfg: TanguDesktopConfig, runId: string, sessionId: string): Promise<TerminalRunStatus> {
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
  cfg: TanguDesktopConfig,
  runId: string,
  params: { message: string; attachments?: Attachment[] },
): Promise<{ ok: boolean; reason?: string; userMessageId?: string }> {
  const r = await authFetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    headers: headers(cfg.token),
    body: JSON.stringify({ message: params.message, attachments: params.attachments || [] }),
  })
  if (r.status === 409) return { ok: false, reason: 'not_active' }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  const j = await r.json().catch(() => ({}))
  return { ok: true, userMessageId: j.userMessageId }
}

/** Wake queued input in the SAME run. Old engines may reject flush; never fall back to abort. */
export async function expediteSteer(cfg: TanguDesktopConfig, runId: string): Promise<{ ok: boolean }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Steering request timed out', 'TimeoutError')), 5000)
  try {
    const r = await authFetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST', headers: headers(cfg.token), signal: ac.signal, body: JSON.stringify({ flush: true }),
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
  cfg: TanguDesktopConfig,
  runId: string,
  messageId: string,
): Promise<{ ok: boolean; gone?: boolean }> {
  const r = await authFetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/steer/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: headers(cfg.token),
  })
  if (r.status === 404) return { ok: false, gone: true }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return { ok: true }
}

/** 列出某会话的在飞/最近 run(刷新恢复:重新挂 SSE)。 */
export async function listActiveRuns(
  cfg: TanguDesktopConfig,
  sessionId: string,
): Promise<Array<{ id: string; status: string; assistant_message_id: string | null }>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new DOMException('Run status request timed out', 'TimeoutError')), 5000)
  try {
    const r = await authFetch(`${cfg.backendUrl}/agent/runs?session_id=${encodeURIComponent(sessionId)}`, {
      headers: headers(cfg.token), signal: ac.signal,
    })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
    const j = await r.json()
    if (!Array.isArray(j.runs)) throw new Error('Invalid run status response')
    return j.runs
  } finally { clearTimeout(timer) }
}

/** 兑现一次询问(ask_user/exit_plan_mode)。410 = 已不在等待(过期/他端已处理)。 */
export async function resolveInquiry(
  cfg: TanguDesktopConfig,
  runId: string,
  inquiryId: string,
  answer: string,
): Promise<{ ok: boolean; gone: boolean }> {
  const r = await authFetch(
    `${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/inquiries/${encodeURIComponent(inquiryId)}`,
    { method: 'POST', headers: headers(cfg.token), body: JSON.stringify({ answer }) },
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
  cfg: TanguDesktopConfig,
  runId: string,
  ackId: string,
  body: { ok: boolean; error?: string; state?: string; settings?: Record<string, string> },
): Promise<string> {
  const url = `${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/inquiries/${encodeURIComponent(ackId)}`
  // ⚠️ 界面已经改完了才发这条回执,所以「发丢了」= 用户看见变化、模型被告知失败(Codex 评审 P1-5)。
  //    重试一次是安全的:引擎侧先到先得,重复的那次拿 410,而 410 恰恰说明前一次已被消费。
  //    只重试网络异常与 5xx;4xx(含 410)是终局,再打没有意义。
  // 返回值 = HTTP 状态或 'network',只进诊断缓冲(diag.ts);永不抛。
  let outcome = 'network'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await authFetch(url, { method: 'POST', headers: headers(cfg.token), body: JSON.stringify(body) })
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
  cfg: TanguDesktopConfig,
  runId: string,
  shotId: string,
  body: { dataUrl?: string; mode?: 'card' | 'open'; error?: string },
): Promise<void> {
  await authFetch(
    `${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/captures/${encodeURIComponent(shotId)}`,
    { method: 'POST', headers: headers(cfg.token), body: JSON.stringify(body) },
  ).catch(() => {})
}

/** 兑现一次 host-exec 审批。410 = 已不在等待(过期/他端已处理)。 */
export async function resolveApproval(
  cfg: TanguDesktopConfig,
  runId: string,
  approvalId: string,
  action: 'approve' | 'approve_always' | 'reject',
  argsOverride?: Record<string, any>,
): Promise<{ ok: boolean; gone: boolean }> {
  const r = await authFetch(
    `${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', headers: headers(cfg.token), body: JSON.stringify({ action, argsOverride }) },
  )
  return { ok: r.ok, gone: r.status === 410 }
}

/** 订阅 run 的 SSE 事件流;onEvent 收到每条 {seq,type,payload}。done/error 时返回。 */
export async function subscribeRunEvents(
  cfg: TanguDesktopConfig,
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
      res = await authFetch(
        `${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/events?fromSeq=${lastSeq}`,
        { headers: headers(cfg.token), signal },
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
