/**
 * 聊天流:消息列表(markdown/思考块/工具卡片/审批卡片/计划卡/todolist)+ 智能吸底滚动。
 * 吸底语义对齐 AI Studio:用户上滑即释放自动吸底(流式照样可往上看历史),回到底部自动恢复;
 * 释放期间右下角浮出「跳到底部」按钮,点一下平滑回底并重新吸附。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { UiMessage } from '../types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { InquiryCard, PlanCard, TodoList } from './InquiryCard'
import { BrandLogo } from './BrandLogo'

export const ChatArea: React.FC<{
  messages: UiMessage[]
  onApproval: (runOwnerMessageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
  onInquiry: (runOwnerMessageId: string, inquiryId: string, answer: string) => void
}> = ({ messages, onApproval, onInquiry }) => {
  const ref = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true) // 是否自动吸底(用户上滑释放,回底恢复)
  const lastTop = useRef(0)
  const progScrollAt = useRef(0) // 程序化滚动时刻(抑制把自身滚动误判为用户上滑)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current
    if (!el) return
    progScrollAt.current = performance.now()
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    lastTop.current = el.scrollHeight
    followBottom.current = true
    setShowJump(false)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop
      const scrolledUp = top < lastTop.current - 2
      lastTop.current = top
      const dist = el.scrollHeight - top - el.clientHeight
      const atBottom = dist < 80
      // 自身程序化滚动刚发生(<120ms)不当作用户操作
      if (scrolledUp && !atBottom && performance.now() - progScrollAt.current > 120) {
        followBottom.current = false
      } else if (atBottom) {
        followBottom.current = true
      }
      setShowJump(!atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 内容增长(流式 token / 新消息)时,仅在仍吸底时跟随到底,绝不抢用户已上滑的视图。
  useEffect(() => {
    const el = ref.current
    if (el && followBottom.current) {
      progScrollAt.current = performance.now()
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  }, [messages])

  if (!messages.length) {
    return (
      <div className="empty-state">
        <BrandLogo size={56} />
        <div className="empty-title">纸上得来终觉浅,绝知此事要躬行。</div>
        <div style={{ fontSize: 12.5 }}>输入一句话,让 Tangu 开始干活。</div>
      </div>
    )
  }

  return (
    <div className="chat-area">
      <div className="chat-stream" ref={ref}>
        <div className="stream-inner">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="msg-row user" key={m.id}>
              <div className="msg-user-bubble">
                {m.attachments?.length ? (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                    📎 {m.attachments.map((a) => a.name).join(', ')}
                  </div>
                ) : null}
                {m.content}
              </div>
            </div>
          ) : (
            <div className="msg-row msg-assistant" key={m.id}>
              <div className="msg-role">TANGU</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {m.reasoning ? <ThinkingBlock reasoning={m.reasoning} streaming={m.status === 'streaming' && !m.content} /> : null}
                {m.toolEvents?.map((t) => <ToolCallCard key={t.id} ev={t} />)}
                {m.approvals?.map((a) => (
                  <ApprovalCard
                    key={a.approvalId}
                    req={a}
                    onDecide={(action, argsOverride) => onApproval(m.id, a.approvalId, action, argsOverride)}
                  />
                ))}
                {m.planProposal ? <PlanCard plan={m.planProposal} /> : null}
                {m.todos?.length ? <TodoList todos={m.todos} /> : null}
                {m.inquiries?.map((q) => (
                  <InquiryCard key={q.inquiryId} req={q} onAnswer={(answer) => onInquiry(m.id, q.inquiryId, answer)} />
                ))}
                {m.content ? (
                  <div className={`msg-content${m.status === 'streaming' ? ' streaming-caret' : ''}`}>
                    <Markdown content={m.content} />
                  </div>
                ) : m.status === 'streaming' && !m.toolEvents?.length && !m.reasoning ? (
                  <div style={{ color: 'var(--text-faint)', fontSize: 13 }} className="streaming-caret">
                    思考中
                  </div>
                ) : null}
                {m.error ? <div className="msg-error">{m.error === 'aborted' ? '已停止。' : m.error}</div> : null}
              </div>
            </div>
          ),
        )}
        </div>
      </div>
      {showJump && (
        <button className="jump-bottom" title="跳到底部" onClick={() => scrollToBottom(true)}>
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}
