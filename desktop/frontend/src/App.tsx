import { useEffect, useRef, useState } from 'react'
import type { AgentRunEvent, TanguDesktopConfig } from './types'
import { startRun, subscribeRunEvents, abortRun, testConnection } from './services/agentRunService'

const DEFAULT_CONFIG: TanguDesktopConfig = { backendUrl: 'http://localhost:8787', token: '', modelId: '' }

interface ToolEntry { id: string; name: string; result?: string; isError?: boolean }
interface Msg { role: 'user' | 'assistant'; content: string; tools?: ToolEntry[] }

export function App() {
  const [cfg, setCfg] = useState<TanguDesktopConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'err'; text: string }>({ kind: 'idle', text: '未连接' })
  const [messages, setMessages] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const sessionId = useRef<string>(cryptoRandomId())
  const streamRef = useRef<HTMLDivElement | null>(null)

  // 启动:从主进程读本地配置
  useEffect(() => {
    window.tangu?.getConfig().then((c) => c && setCfg((p) => ({ ...p, ...c }))).catch(() => {})
  }, [])

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight })
  }, [messages])

  const persist = (patch: Partial<TanguDesktopConfig>) => {
    const next = { ...cfg, ...patch }
    setCfg(next)
    window.tangu?.setConfig(patch).catch(() => {})
  }

  const onConnect = async () => {
    setStatus({ kind: 'idle', text: '连接中…' })
    const r = await testConnection(cfg)
    setStatus({ kind: r.ok ? 'ok' : 'err', text: r.message })
  }

  const setAssistant = (mutate: (m: Msg) => void) => {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') mutate(last)
      return next
    })
  }

  const onEvent = (ev: AgentRunEvent) => {
    const p = ev.payload || {}
    switch (ev.type) {
      case 'token':
        if (p.delta) setAssistant((m) => { m.content += p.delta })
        break
      case 'tool_call':
        setAssistant((m) => { (m.tools ||= []).push({ id: p.id, name: p.name }) })
        break
      case 'tool_result':
        setAssistant((m) => {
          const t = (m.tools ||= []).find((x) => x.id === p.id)
          if (t) { t.result = String(p.result ?? '').slice(0, 600); t.isError = !!p.isError }
        })
        break
      case 'done':
        if (p.content) setAssistant((m) => { if (!m.content) m.content = p.content })
        setRunning(false)
        break
      case 'error':
        setAssistant((m) => { m.content += `\n\n[错误] ${p.error || ''}` })
        setRunning(false)
        break
    }
  }

  const onSend = async () => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', tools: [] }])
    setRunning(true)
    try {
      const { runId } = await startRun(cfg, { sessionId: sessionId.current, message: text })
      abortRef.current = new AbortController()
      await subscribeRunEvents(cfg, runId, onEvent, abortRef.current.signal)
    } catch (e: any) {
      setAssistant((m) => { m.content += `\n\n[发起失败] ${e?.message || e}` })
      setStatus({ kind: 'err', text: e?.message || '发起失败' })
    } finally {
      setRunning(false)
    }
  }

  const onStop = () => { abortRef.current?.abort(); setRunning(false) }

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">扶桑 · Tangu</span>
        <input className="field field-url" placeholder="后端地址" value={cfg.backendUrl}
          onChange={(e) => persist({ backendUrl: e.target.value })} />
        <input className="field field-token" placeholder="token" type="password" value={cfg.token}
          onChange={(e) => persist({ token: e.target.value })} />
        <input className="field field-model" placeholder="模型 id" value={cfg.modelId}
          onChange={(e) => persist({ modelId: e.target.value })} />
        <button className="btn ghost" onClick={onConnect}>连接</button>
        <span className={`status ${status.kind}`}>{status.text}</span>
      </div>

      <div className="stream" ref={streamRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role === 'user' ? '我' : 'Tangu'}</div>
            {m.tools?.map((t) => (
              <div key={t.id} className={`tool ${t.isError ? 'err' : ''}`}>
                ⚙ {t.name}{t.result != null ? `\n${t.result}` : ' …'}
              </div>
            ))}
            <div className="bubble">{m.content || (m.role === 'assistant' && running ? '…' : '')}</div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea className="input" placeholder="给 Tangu 发消息…(Ctrl/⌘+Enter 发送)" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSend() }} />
        {running
          ? <button className="btn danger" onClick={onStop}>停止</button>
          : <button className="btn" onClick={onSend} disabled={!draft.trim()}>发送</button>}
      </div>
    </div>
  )
}

function cryptoRandomId(): string {
  try { return crypto.randomUUID() } catch { return 'sess-' + Math.floor(Date.now()).toString(36) }
}
