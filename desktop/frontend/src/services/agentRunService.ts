/**
 * renderer 直连 standalone Tangu 服务(localhost)。
 * SSE 用 fetch + ReadableStream(EventSource 不能带 Bearer);seq 去重 + 断线重连 + fromSeq 续传。
 * 复刻 apps/Forsion-AI-Studio/client/services/cloudAgentService.ts 的成熟模式。
 */
import type { AgentRunEvent, StartRunResult, TanguDesktopConfig } from '../types'

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

export async function testConnection(cfg: TanguDesktopConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(`${cfg.backendUrl}/health`, { headers: headers(cfg.token) })
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
  params: { sessionId: string; message: string; modelId?: string },
): Promise<StartRunResult> {
  const r = await fetch(`${cfg.backendUrl}/agent/runs`, {
    method: 'POST',
    headers: headers(cfg.token),
    body: JSON.stringify({
      session_id: params.sessionId,
      model_id: params.modelId || cfg.modelId,
      message: params.message,
      agent_config: {},
    }),
  })
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return r.json()
}

export async function abortRun(cfg: TanguDesktopConfig, runId: string): Promise<void> {
  await fetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'POST',
    headers: headers(cfg.token),
  }).catch(() => {})
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
      res = await fetch(
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
