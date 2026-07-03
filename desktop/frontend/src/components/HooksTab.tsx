/**
 * 设置 → Lifecycle Hooks：用户声明的 host-only shell 回调，在 agent 循环生命周期点触发
 * （工具前/后、审批、提交、会话开始、压缩前、停止）。可拦截 / 改参 / 注入上下文 / 记录。
 * 照 MCP 面板：按事件分组列出，每条 启用开关 + 审阅(needs-review) + 编辑 + 删除；经后端 HTTP 持久化到 config.json。
 * 仅本地后端可用（host-only；tab 在 SettingsModal 已由 isDesktop 门控）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { getHooks, saveHooks, trustHookReq, enableHookReq, type HooksData, type HookDiscovered } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

type Row = HookDiscovered & { event: string }
type Draft = { event: string; matcher: string; command: string; timeout: string }

const EVENT_DESC: Record<string, { zh: string; en: string }> = {
  PreToolUse: { zh: '工具执行前 · 可拦截 / 改写参数 / 注入上下文', en: 'Before a tool runs · block / rewrite args / inject context' },
  PostToolUse: { zh: '工具执行后 · 跑格式化 / lint / 审计，或把反馈喂回模型', en: 'After a tool runs · format / lint / audit, or feed feedback back' },
  PermissionRequest: { zh: '弹审批前 · 放行 / 拒绝', en: 'Before the approval prompt · allow / deny' },
  UserPromptSubmit: { zh: '用户提交时 · 注入上下文 / 否决', en: 'On user submit · inject context / veto' },
  SessionStart: { zh: '会话首轮 · 注入上下文', en: 'First turn of a session · inject context' },
  PreCompact: { zh: '上下文压缩前 · 可跳过', en: 'Before context compaction · can skip' },
  Stop: { zh: 'run 结束 / 失败 · 通知 / webhook / 强制续跑', en: 'Run ends / fails · notify / webhook / force-continue' },
  SubagentStart: { zh: '子代理开始（委派 / 讨论）', en: 'Subagent starts (delegate / discussion)' },
  SubagentStop: { zh: '子代理结束', en: 'Subagent stops' },
}
const MATCHERLESS = new Set(['UserPromptSubmit', 'Stop'])

export const HooksTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { locale } = useI18n()
  const en = locale === 'en'
  const [data, setData] = useState<HooksData | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const reload = useCallback(() => { getHooks(cfg).then(setData).catch((e) => setErr(String(e?.message || e))) }, [cfg])
  useEffect(() => { reload() }, [reload])

  const allRows = (): Row[] =>
    data ? Object.entries(data.discovered).flatMap(([event, list]) => list.map((h) => ({ event, ...h }))) : []

  const rowsToEvents = (rows: Array<{ event: string; matcher: string; command: string; timeout: number | string; commandWindows?: string; statusMessage?: string }>) => {
    const ev: Record<string, any[]> = {}
    for (const r of rows) {
      if (!String(r.command).trim()) continue
      const h: any = { type: 'command', command: r.command }
      const to = Number(r.timeout); if (Number.isFinite(to) && to > 0) h.timeout = Math.floor(to)
      if (r.commandWindows) h.commandWindows = r.commandWindows
      if (r.statusMessage) h.statusMessage = r.statusMessage
      ;(ev[r.event] ||= []).push({ matcher: String(r.matcher || '').trim() || undefined, hooks: [h] })
    }
    return ev
  }

  const persist = async (rows: Array<any>): Promise<void> => {
    setErr('')
    try { const res = await saveHooks(cfg, rowsToEvents(rows)); setData((d) => (d ? { ...d, ...res } : d)) }
    catch (e: any) { setErr(e?.message || 'save failed') }
  }
  const submitDraft = async (): Promise<void> => {
    if (!draft || !draft.command.trim()) return
    const kept = allRows().filter((r) => r.key !== editKey)
    await persist([...kept, { event: draft.event, matcher: draft.matcher, command: draft.command, timeout: draft.timeout }])
    setDraft(null); setEditKey(null)
  }
  const del = async (key: string): Promise<void> => {
    if (!window.confirm(en ? 'Delete this hook?' : '删除此 hook?')) return
    await persist(allRows().filter((r) => r.key !== key))
  }
  const toggle = async (row: Row): Promise<void> => {
    try { const r = await enableHookReq(cfg, row.key, !row.enabled); setData((d) => (d ? { ...d, discovered: r.discovered } : d)) } catch { /* ignore */ }
  }
  const trust = async (row: Row): Promise<void> => {
    try { const r = await trustHookReq(cfg, row.key); setData((d) => (d ? { ...d, discovered: r.discovered } : d)) } catch { /* ignore */ }
  }
  const startEdit = (row: Row): void => {
    setEditKey(row.key)
    setDraft({ event: row.event, matcher: row.matcher, command: row.command, timeout: row.timeout ? String(row.timeout) : '' })
  }

  if (!data) return <div className="hint">{err || (en ? 'Loading…' : '加载中…')}</div>
  const eventNames = data.eventNames?.length ? data.eventNames : Object.keys(EVENT_DESC)

  const badge = (text: string, color: string): React.ReactNode => (
    <span style={{ fontSize: 10.5, color, border: `var(--border-width) solid ${color}`, borderRadius: 4, padding: '0 4px' }}>{text}</span>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="hint" style={{ fontSize: 12 }}>
        {en
          ? 'Hooks run your own shell commands at fixed points in the agent loop — deterministic guardrails the model cannot skip (like a git pre-commit hook). Host-only; never runs in the cloud. Scripts get JSON on stdin; exit 2 or {"decision":"block"} blocks.'
          : 'Hook 在 agent 循环的固定生命周期点跑你自己的 shell 命令 —— 模型绕不过去的确定性护栏（就像 git pre-commit）。仅本地生效，云端从不运行。脚本从 stdin 收 JSON；exit 2 或 {"decision":"block"} 即拦截。'}
      </div>

      {!draft && (
        <button className="btn sm" onClick={() => { setEditKey(null); setDraft({ event: 'PreToolUse', matcher: '', command: '', timeout: '' }) }}>
          {en ? '＋ New hook' : '＋ 新建 hook'}
        </button>
      )}

      {draft && (
        <div style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12 }}>
            {en ? 'Event' : '事件'}
            <select value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value })} style={{ marginLeft: 8 }}>
              {eventNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{en ? EVENT_DESC[draft.event]?.en : EVENT_DESC[draft.event]?.zh}</div>
          {!MATCHERLESS.has(draft.event) && (
            <label style={{ fontSize: 12 }}>
              {en ? 'Matcher' : '匹配器'}
              <input value={draft.matcher} placeholder={en ? '* / run_bash / edit_file|write_file / mcp__.*' : '* / run_bash / edit_file|write_file / mcp__.*'}
                onChange={(e) => setDraft({ ...draft, matcher: e.target.value })} style={{ marginLeft: 8, width: 'calc(100% - 60px)' }} />
            </label>
          )}
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {en ? 'Command (shell)' : '命令（shell）'}
            <textarea value={draft.command} rows={2} placeholder={en ? 'e.g. grep -q "rm -rf" && exit 2' : '例如 grep -q "rm -rf" && exit 2'}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} />
          </label>
          <label style={{ fontSize: 12 }}>
            {en ? 'Timeout (s)' : '超时（秒）'}
            <input value={draft.timeout} type="number" placeholder="600" onChange={(e) => setDraft({ ...draft, timeout: e.target.value })} style={{ marginLeft: 8, width: 80 }} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => void submitDraft()} disabled={!draft.command.trim()}>{en ? 'Save' : '保存'}</button>
            <button className="btn ghost sm" onClick={() => { setDraft(null); setEditKey(null) }}>{en ? 'Cancel' : '取消'}</button>
          </div>
        </div>
      )}

      {err && <div className="hint" style={{ color: 'var(--danger, #c0392b)' }}>{err}</div>}

      {eventNames.map((event) => {
        const rows = (data.discovered[event] || [])
        if (!rows.length) return null
        return (
          <div key={event}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{event}
              <span style={{ fontWeight: 400, color: 'var(--text-faint)', marginLeft: 8, fontSize: 11 }}>{en ? EVENT_DESC[event]?.en : EVENT_DESC[event]?.zh}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((h) => (
                <div key={h.key} style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 10, display: 'flex', alignItems: 'center', gap: 10, opacity: h.active ? 1 : 0.6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {h.matcher && badge(h.matcher, 'var(--text-faint)')}
                      {h.source !== 'user' && badge(h.source, 'var(--text-faint)')}
                      {h.trust === 'needs-review' && badge(en ? 'needs review' : '待审阅', 'var(--warn, #b8860b)')}
                      {!h.enabled && badge(en ? 'disabled' : '已禁用', 'var(--text-faint)')}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, marginTop: 3, wordBreak: 'break-all' }}>{h.command}</div>
                  </div>
                  {h.trust === 'needs-review' && <button className="btn ghost sm" onClick={() => void trust({ ...h, event })}>{en ? 'Trust' : '信任'}</button>}
                  <button className="btn ghost sm" onClick={() => startEdit({ ...h, event })}>{en ? 'Edit' : '编辑'}</button>
                  <button className="btn ghost sm" onClick={() => void del(h.key)}>{en ? 'Delete' : '删除'}</button>
                  <input type="checkbox" checked={h.enabled} onChange={() => void toggle({ ...h, event })} style={{ cursor: 'pointer' }} />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
