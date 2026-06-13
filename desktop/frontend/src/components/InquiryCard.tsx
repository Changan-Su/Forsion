/**
 * 询问卡(ask_user / exit_plan_mode):问题 + 选项按钮 + 自由输入;answered/expired 显示灰态。
 * 视觉对齐 ApprovalCard(边框卡片,token CSS)。
 */
import React, { useState } from 'react'
import { CircleHelp, Send, CheckSquare, Square, Loader2 } from 'lucide-react'
import type { InquiryRequest, TodoItem } from '../types'

export const InquiryCard: React.FC<{
  req: InquiryRequest
  onAnswer: (answer: string) => void
}> = ({ req, onAnswer }) => {
  const [draft, setDraft] = useState('')
  const pending = req.status === 'pending'

  return (
    <div
      style={{
        border: 'var(--border-width) solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 12px',
        background: 'var(--bg-card)',
        opacity: pending ? 1 : 0.75,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        <CircleHelp size={14} style={{ color: 'var(--accent)' }} />
        {req.question}
      </div>
      {pending ? (
        <>
          {req.options.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {req.options.map((opt, i) => (
                <button key={i} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => onAnswer(opt)}>
                  {i + 1}. {opt}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              className="inline-input"
              style={{ flex: 1 }}
              value={draft}
              placeholder={req.options.length ? '或自由输入…' : '输入回答…'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim() && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  onAnswer(draft.trim())
                }
              }}
            />
            <button className="btn primary sm" disabled={!draft.trim()} onClick={() => draft.trim() && onAnswer(draft.trim())}>
              <Send size={12} /> 回答
            </button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          {req.status === 'answered' ? `已回答:${req.answer ?? ''}` : '已过期(运行已结束)'}
        </div>
      )}
    </div>
  )
}

/** 计划卡:计划模式下 agent 提交的实施计划(plan 事件)。 */
export const PlanCard: React.FC<{ plan: string }> = ({ plan }) => (
  <div
    style={{
      border: 'var(--border-width) solid var(--border)',
      borderLeft: '3px solid var(--accent)',
      borderRadius: 'var(--radius-md)',
      padding: '10px 12px',
      background: 'var(--bg-card)',
    }}
  >
    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>📋 计划提案</div>
    <pre
      style={{
        margin: 0, fontSize: 12.5, fontFamily: 'inherit', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', maxHeight: 360, overflowY: 'auto',
      }}
    >
      {plan}
    </pre>
  </div>
)

/** 任务清单(todo 事件;对齐 Claude TodoWrite 的实时显示)。 */
export const TodoList: React.FC<{ todos: TodoItem[] }> = ({ todos }) => {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div
      style={{
        border: 'var(--border-width) solid var(--border)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 12px',
        background: 'var(--bg-card)',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', marginBottom: 7 }}>
        ✓ 任务清单 <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({done}/{todos.length})</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {todos.map((t, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 13,
              color: t.status === 'completed' ? 'var(--text-faint)' : 'var(--text)',
            }}
          >
            <span style={{ flexShrink: 0, marginTop: 1 }}>
              {t.status === 'completed' ? (
                <CheckSquare size={14} style={{ color: 'var(--green)' }} />
              ) : t.status === 'in_progress' ? (
                <Loader2 size={14} className="spin" style={{ color: 'var(--accent)' }} />
              ) : (
                <Square size={14} style={{ color: 'var(--text-ghost)' }} />
              )}
            </span>
            <span style={{ textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>{t.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
