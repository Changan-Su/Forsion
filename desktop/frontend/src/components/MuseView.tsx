/**
 * Muse 工作区：上=Muse 当前思考 + 运行态；下=Muse TODO 清单（多选 → 选会话 → 注入并运行）。
 */
import React, { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Play, Check, XCircle } from 'lucide-react'
import { getMuseStatus, getMuseTodos, patchMuseTodo, injectMuseTodos, listMessages } from '../services/backendService'
import type { MuseStatusInfo, MuseTodo, SessionRecord, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

export const MuseView: React.FC<{
  cfg: TanguDesktopConfig
  sessions: SessionRecord[]
  onInjected: (sessionId: string) => void
}> = ({ cfg, sessions, onInjected }) => {
  const { t } = useI18n()
  const [status, setStatus] = useState<MuseStatusInfo | null>(null)
  const [todos, setTodos] = useState<MuseTodo[]>([])
  const [thinking, setThinking] = useState<string>('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<string>('')
  const [msg, setMsg] = useState('')

  const load = async (): Promise<void> => {
    const st = await getMuseStatus(cfg).catch(() => null)
    setStatus(st)
    setTodos(await getMuseTodos(cfg, 'pending').catch(() => []))
    if (st?.sessionId) {
      const ms = await listMessages(cfg, st.sessionId, 6).catch(() => [])
      const lastAssistant = [...ms].reverse().find((m) => m.role === 'assistant' || m.role === 'model')
      setThinking(String(lastAssistant?.content || '').slice(0, 4000))
    }
  }
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (id: string): void => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const inject = async (): Promise<void> => {
    if (!target || !sel.size) return
    try {
      await injectMuseTodos(cfg, [...sel], target)
      setMsg(t('special.muse.injected', { n: sel.size }))
      setSel(new Set())
      onInjected(target)
    } catch (e: any) {
      setMsg(t('special.muse.injectFail', { e: e?.message || e }))
    }
  }
  const setTodoStatus = async (id: string, status: MuseTodo['status']): Promise<void> => {
    await patchMuseTodo(cfg, id, status).catch(() => {})
    setTodos((p) => p.filter((x) => x.id !== id))
  }

  const running = !!status?.running
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, padding: '16px 20px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontWeight: 600 }}>
        <Sparkles size={16} /> {t('special.muse.title')}
        <span style={{ flex: 1 }} />
        <span className="conn-pill" style={{ fontSize: 12 }}>
          <span className="dot" style={{ background: running ? 'var(--accent)' : 'var(--text-muted)' }} />
          {!status?.enabled ? t('special.muse.disabled') : running ? t('special.muse.running') : t('special.muse.idle')}
        </span>
        <button className="icon-btn" onClick={() => void load()}><RefreshCw size={13} /></button>
      </div>

      {/* 当前思考 */}
      <div className="field">
        <label>{t('special.muse.thinking')}</label>
        <div style={{
          fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto',
          background: 'var(--bg-card)', border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10,
        }}>
          {thinking || <span className="hint">{status?.enabled ? '…' : t('special.muse.disabled')}</span>}
        </div>
      </div>

      {/* TODO 清单 */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {t('special.muse.todos')}
          <span style={{ flex: 1 }} />
          {todos.length > 0 && (
            <button className="btn ghost sm" onClick={() => setSel(sel.size === todos.length ? new Set() : new Set(todos.map((x) => x.id)))}>
              {t('special.muse.selectAll')}
            </button>
          )}
        </label>
        {todos.length === 0 && <div className="hint">{t('special.muse.todosEmpty')}</div>}
        {todos.map((td) => (
          <div key={td.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={sel.has(td.id)} onChange={() => toggle(td.id)} style={{ marginTop: 3 }} />
            <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
              <b>{td.title}</b>
              {td.detail && <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{td.detail}</div>}
            </span>
            <button className="icon-btn" title={t('special.muse.markDone')} onClick={() => void setTodoStatus(td.id, 'done')}><Check size={13} /></button>
            <button className="icon-btn" title={t('special.muse.dismiss')} onClick={() => void setTodoStatus(td.id, 'dismissed')}><XCircle size={13} /></button>
          </div>
        ))}
      </div>

      {/* 注入区 */}
      {todos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="">{t('special.muse.pickSession')}</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>)}
          </select>
          <button className="btn primary sm" disabled={!target || !sel.size} onClick={() => void inject()}>
            <Play size={12} /> {t('special.muse.inject')}
          </button>
          {msg && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{msg}</span>}
        </div>
      )}
    </div>
  )
}
