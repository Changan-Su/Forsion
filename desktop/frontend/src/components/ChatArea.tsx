/**
 * 聊天流:消息列表(markdown/思考块/工具卡片/审批卡片/计划卡/todolist)+ 智能吸底滚动。
 * 吸底语义对齐 AI Studio:用户上滑即释放自动吸底(流式照样可往上看历史),回到底部自动恢复;
 * 释放期间右下角浮出「跳到底部」按钮,点一下平滑回底并重新吸附。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Copy, Check, Pencil, RefreshCw } from 'lucide-react'
import type { UiMessage } from '../types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { InquiryCard, PlanCard, TodoList } from './InquiryCard'
import { BrandLogo } from './BrandLogo'
import { useI18n } from '../i18n'

export const ChatArea: React.FC<{
  messages: UiMessage[]
  containerRef?: React.RefObject<HTMLDivElement | null> // 由 App 提供以与右侧「目录」共享滚动容器
  onApproval: (runOwnerMessageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
  onInquiry: (runOwnerMessageId: string, inquiryId: string, answer: string) => void
  /** 重新编辑用户消息并重发(截断该消息及之后,以编辑后的文本重跑)。running 时禁用。 */
  onEditResend?: (messageId: string, newText: string) => void
  /** 重新生成某条助手消息(截断到其上一条用户消息后,以原输入重跑)。running 时禁用。 */
  onRegenerate?: (messageId: string) => void
  /** 是否有在飞 run:为真时禁用编辑/重生成(避免截断正在跑的会话)。 */
  running?: boolean
}> = ({ messages, containerRef, onApproval, onInquiry, onEditResend, onRegenerate, running }) => {
  const { t } = useI18n()
  const internalRef = useRef<HTMLDivElement>(null)
  // 复制反馈(2s 回弹);内联编辑用户消息(editingId + 草稿)。
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const copyMsg = useCallback((m: UiMessage) => {
    navigator.clipboard?.writeText(m.content || '').then(() => {
      setCopiedId(m.id)
      setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 2000)
    }).catch(() => { /* 忽略剪贴板失败 */ })
  }, [])
  const beginEdit = useCallback((m: UiMessage) => {
    setEditingId(m.id)
    setEditDraft(m.content || '')
  }, [])
  const commitEdit = useCallback(() => {
    const text = editDraft.trim()
    const id = editingId
    setEditingId(null)
    if (id && text && onEditResend) onEditResend(id, text)
  }, [editDraft, editingId, onEditResend])
  const ref = containerRef ?? internalRef
  // 是否吸底:**纯位置**判定。每次 scroll 事件按"离底距离"重算 —— 程序化吸底落到底→dist≈0→stick=true
  // (自洽,不会被误判为上滑);用户用任意方式(滚轮/触摸/拖滚动条/键盘)上滑→dist>阈值→stick=false。
  // 内容增长只改 scrollHeight、不改 scrollTop、不触发 scroll → 增长期间 stick 不被误改。
  // 没有 delta/时间窗 → 不会出现旧版"流式高频 follow 把时间窗焐热、令上滑判定永久失效"的死锁。
  const stick = useRef(true)
  const streamingNodeRef = useRef<HTMLDivElement | null>(null)
  const [showJump, setShowJump] = useState(false)
  const STICK_THRESHOLD = 80

  // 正在流式输出的消息 id(吸底锚点;无则非流式,走一次性 snap)。
  const streamingId = useMemo(() => messages.find((m) => m.status === 'streaming')?.id ?? null, [messages])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stick.current = true
    setShowJump(false)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
      stick.current = atBottom
      setShowJump(!atBottom)
    }
    // 滚轮上滑 / 触摸拖动是**无歧义**的用户意图(程序化滚动绝不触发),立即解除吸底并 latch 住,
    // 确保在下一帧 follow() 之前 stick 已为 false —— 极快流式下也不会被 follow 抢回。
    const releaseIfUp = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= STICK_THRESHOLD) {
        stick.current = false
        setShowJump(true)
      }
    }
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) releaseIfUp() }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', releaseIfUp, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', releaseIfUp)
    }
  }, [ref])

  // 流式中:用 ResizeObserver 盯住「流式消息节点」的实际布局增长来吸底(而非靠 messages 引用
  // 每 token 变化触发的 effect——那会在布局未稳时滚动,产生上下抖动)。instant 滚动避免平滑动画
  // 互相追逐。仅在 stick 时跟随,绝不抢用户已上滑的视图。
  useEffect(() => {
    if (!streamingId) return
    const node = streamingNodeRef.current
    const el = ref.current
    if (!node || !el) return
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
    }
    follow() // 流式气泡首次挂载时先吸一次
    const ro = new ResizeObserver(() => requestAnimationFrame(follow))
    ro.observe(node)
    return () => ro.disconnect()
  }, [streamingId, ref])

  // 非流式的一次性吸底(新用户消息 / 工具结果插入)。流式期间交给上面的 ResizeObserver。
  useEffect(() => {
    if (streamingId) return
    if (!stick.current) return
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, streamingId, ref])

  if (!messages.length) {
    return (
      <div className="empty-state">
        <BrandLogo size={56} />
        <div className="empty-title">{t('chat.emptyTitle')}</div>
        <div style={{ fontSize: 12.5 }}>{t('chat.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className="chat-area">
      <div className="chat-stream" ref={ref}>
        <div className="stream-inner">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div
              className="msg-row user"
              key={m.id}
              id={`tocmsg-${m.id}`}
              data-toc-msg-role="user"
              data-toc-title={m.content}
            >
              {editingId === m.id ? (
                <div className="msg-edit">
                  <textarea
                    className="msg-edit-input"
                    value={editDraft}
                    autoFocus
                    rows={Math.min(12, Math.max(2, editDraft.split('\n').length))}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit() }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                    }}
                  />
                  <div className="msg-edit-actions">
                    <button className="btn sm ghost" onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
                    <button className="btn sm primary" disabled={!editDraft.trim()} onClick={commitEdit}>{t('chat.action.resend')}</button>
                  </div>
                </div>
              ) : (
                <div className="msg-user-wrap">
                  <div className="msg-user-bubble">
                    {m.attachments?.length ? (
                      <div className="msg-attach-grid">
                        {m.attachments.map((a, i) =>
                          a.mimeType?.startsWith('image/') && a.data ? (
                            <img
                              key={i}
                              className="msg-attach-img"
                              src={`data:${a.mimeType};base64,${a.data}`}
                              alt={a.name}
                              title={a.name}
                            />
                          ) : (
                            <span key={i} className="msg-attach-file" title={a.name}>📎 {a.name}</span>
                          ),
                        )}
                      </div>
                    ) : null}
                    {m.content}
                  </div>
                  <div className="msg-actions user">
                    <button
                      className={`msg-action-btn${copiedId === m.id ? ' copied' : ''}`}
                      title={copiedId === m.id ? t('chat.action.copied') : t('chat.action.copy')}
                      onClick={() => copyMsg(m)}
                    >
                      {copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    {onEditResend && (
                      <button
                        className="msg-action-btn"
                        title={t('chat.action.edit')}
                        disabled={running}
                        onClick={() => beginEdit(m)}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              className="msg-row msg-assistant"
              key={m.id}
              id={`tocmsg-${m.id}`}
              data-toc-msg-role="assistant"
              ref={m.id === streamingId ? streamingNodeRef : undefined}
            >
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
                    <Markdown content={m.content} anchorPrefix={`toc-${m.id}`} />
                  </div>
                ) : m.status === 'streaming' && !m.toolEvents?.length && !m.reasoning ? (
                  <div style={{ color: 'var(--text-faint)', fontSize: 13 }} className="streaming-caret">
                    {t('chat.thinking')}
                  </div>
                ) : null}
                {m.error ? <div className="msg-error">{m.error === 'aborted' ? t('chat.aborted') : m.error}</div> : null}
                {m.status !== 'streaming' && (m.content || m.error) ? (
                  <div className="msg-actions assistant">
                    <button
                      className={`msg-action-btn${copiedId === m.id ? ' copied' : ''}`}
                      title={copiedId === m.id ? t('chat.action.copied') : t('chat.action.copy')}
                      onClick={() => copyMsg(m)}
                    >
                      {copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    {onRegenerate && (
                      <button
                        className="msg-action-btn"
                        title={t('chat.action.regenerate')}
                        disabled={running}
                        onClick={() => onRegenerate(m.id)}
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ),
        )}
        </div>
      </div>
      {showJump && (
        <button className="jump-bottom" title={t('chat.jumpToBottom')} onClick={() => scrollToBottom(true)}>
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}
