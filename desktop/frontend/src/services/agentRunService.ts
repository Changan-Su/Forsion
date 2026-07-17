/**
 * renderer 直连 standalone Tangu 服务(localhost)。
 * SSE 用 fetch + ReadableStream(EventSource 不能带 Bearer);seq 去重 + 断线重连 + fromSeq 续传。
 * 复刻 apps/Forsion-AI-Studio/client/services/cloudAgentService.ts 的成熟模式。
 */
import type { AgentConfig, AgentRunEvent, Attachment, StartRunResult, TanguDesktopConfig } from '../types'
import { authFetch } from './http'

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

export async function testConnection(cfg: TanguDesktopConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await authFetch(`${cfg.backendUrl}/health`, { headers: headers(cfg.token) }, { timeoutMs: 15000 })
    if (r.ok) {
      const j = await r.json().catch(() => ({}))
      return { ok: true, message: `已连接 · sandbox=${j.sandbox ?? '?'}` }
    }
    return { ok: false, message: `HTTP ${r.status}` }
  } catch (e: any) {
    return { ok: false, message: e?.message || '连接失败' }
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
      // 全端共用 'tangu':桌面 standalone 基线本就应答它,云端 worker 经 appProfiles.config 文件层
      // 覆盖同样认它(2026-07-17 弃用独立 'tangu-web',web/桌面云会话与 admin 模型配置统一一份)。
      app_id: 'tangu',
      message: params.message,
      attachments: params.attachments || [],
      agent_config: params.agentConfig || {},
    }),
  })
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return r.json()
}

export async function abortRun(cfg: TanguDesktopConfig, runId: string): Promise<void> {
  await authFetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    headers: headers(cfg.token),
  }).catch(() => {})
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

/** 列出某会话的在飞/最近 run(刷新恢复:重新挂 SSE)。 */
export async function listActiveRuns(
  cfg: TanguDesktopConfig,
  sessionId: string,
): Promise<Array<{ id: string; status: string; assistant_message_id: string | null }>> {
  const r = await authFetch(`${cfg.backendUrl}/agent/runs?session_id=${encodeURIComponent(sessionId)}`, {
    headers: headers(cfg.token),
  })
  if (!r.ok) return []
  const j = await r.json().catch(() => ({ runs: [] }))
  return j.runs || []
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
    if (res.status >= 400 && res.status < 500) throw new Error(`订阅失败 (${res.status})`)
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
