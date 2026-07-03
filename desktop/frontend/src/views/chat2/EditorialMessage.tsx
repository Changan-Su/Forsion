/**
 * 编辑式消息渲染(新视觉):助手在纸面流动(头像 + 安静署名 + 内容 + 悬浮动作),
 * 用户为暖色带尾气泡。子件(思考/工具/待办/审批/反问)以新 t2 风格内联呈现。
 * 接 UiMessage,故可直接喂真实 store 数据(集成期用);回调可选(预览传空)。
 */
import { useState, type Ref } from 'react'
import { Copy, RotateCcw, GitBranch, Pencil, ChevronRight, ChevronDown, Volume2, Square, Loader2 } from 'lucide-react'
import type { UiMessage, TanguDesktopConfig, AgentConfig, StoredDesktopConfig } from '../../types'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { Markdown } from '../../components/Markdown'
import { VoiceBubble } from '../../components/VoiceBubble'
import { InlineFiles } from '../../components/InlineFiles'
import { SystemPromptBlock } from '../../components/SystemPromptBlock'
import { ToolGroup } from '../../components/ToolGroup'
import { ApprovalCard } from '../../components/ApprovalCard'
import { InquiryCard, PlanCard, TodoList } from '../../components/InquiryCard'
import { useI18n } from '../../i18n'
import './chat2.css'

/** 头像回退:无图时取昵称首字(支持 CJK/emoji),对齐 desktop1.0。 */
function firstChar(s?: string): string {
  const t = (s || '').trim()
  return t ? Array.from(t)[0].toUpperCase() : '?'
}

/** 内联文件渲染所需上下文(displayFiles 用)。 */
export interface FileCtx {
  cfg: TanguDesktopConfig
  sessionId: string
  execMode: AgentConfig['execMode']
  onOpenPreview?: (t: PreviewTarget) => void
}

export function Thinking2({ reasoning }: { reasoning: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="t2-think">
      <button className="t2-think-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} ✦ {t('thinking.process')}{' '}
        <span className="t2-dim">· {t('thinking.charCount', { count: reasoning.length })}</span>
      </button>
      {open && <div className="t2-think-body">{reasoning}</div>}
    </div>
  )
}

export interface MessageHandlers {
  onCopy?: (text: string) => void
  onRegenerate?: () => void
  onBranch?: () => void
  onEdit?: () => void
  /** 朗读本条(再次点击=停止);未配置 TTS 时不传 → 按钮不渲染。 */
  onSpeak?: () => void
  onApproval?: (approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, unknown>) => void
  onInquiry?: (inquiryId: string, answer: string) => void
}

export function EditorialMessage({ msg, avatarUrl, agentNameFallback, userName, userAvatar, handlers, fileCtx, rootRef, speakState, voice }: { msg: UiMessage; avatarUrl?: string; agentNameFallback?: string; userName?: string; userAvatar?: string; handlers?: MessageHandlers; fileCtx?: FileCtx; rootRef?: Ref<HTMLDivElement>; speakState?: 'loading' | 'playing'; voice?: { on: boolean; cfg: TanguDesktopConfig; stored: StoredDesktopConfig | null } }) {
  const { t } = useI18n()
  if (msg.role === 'system') {
    if (msg.groupVote) {
      const v = msg.groupVote
      return (
        <div ref={rootRef} className="t2-sys"><span className="t2-dim">{t('group.vote.round', { round: v.round })}</span> <b>{t('group.vote.tally', { end: v.endCount, total: v.total })}</b></div>
      )
    }
    if (!msg.content) return null
    return <div ref={rootRef} className="t2-sys">{msg.content}</div>
  }

  if (msg.role === 'user') {
    const name = userName || t('chat.you')
    return (
      <div ref={rootRef} className="t2-userwrap" id={`tocmsg-${msg.id}`} data-toc-msg-role="user" data-toc-title={msg.content}>
        <div className="t2-actions">
          <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(msg.content)}><Copy size={14} /></button>
          <button className="t2-iconbtn" title={t('chat.action.edit')} onClick={() => handlers?.onEdit?.()}><Pencil size={14} /></button>
        </div>
        <div className="t2-user-col">
          <div className="t2-username">{name}</div>
          <div className="t2-user">
            {!!msg.attachments?.length && (
              <div className="msg-attach-grid">
                {msg.attachments.map((a, i) => a.mimeType?.startsWith('image/') && a.data
                  ? <img key={`${a.name}-${i}`} className="msg-attach-img" src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} title={a.name} />
                  : <span key={`${a.name}-${i}`} className="msg-attach-file" title={a.name}>📎 {a.name}</span>)}
              </div>
            )}
            {msg.content}
          </div>
        </div>
        <div className="t2-avatar t2-user-avatar" style={!userAvatar ? { background: 'color-mix(in srgb, var(--text-muted) 22%, transparent)' } : undefined}>
          {userAvatar ? <img src={userAvatar} alt="" /> : firstChar(name)}
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="t2-asst" id={`tocmsg-${msg.id}`}>
      <div className="t2-avatar" style={!avatarUrl && msg.agentColor ? { background: msg.agentColor, color: '#fff' } : undefined}>{avatarUrl ? <img src={avatarUrl} alt="" /> : firstChar(msg.agentName || agentNameFallback || 'Tangu')}</div>
      <div className="t2-asst-col">
        <div className="t2-name" style={msg.agentColor ? { color: msg.agentColor } : undefined}>{(msg.agentName || agentNameFallback || 'Tangu').toUpperCase()}{msg.status === 'streaming' && <span className="t2-dot" />}</div>
        {msg.systemPrompt && <SystemPromptBlock content={msg.systemPrompt} />}
        {msg.reasoning && <Thinking2 reasoning={msg.reasoning} />}
        {!!msg.toolEvents?.length && <ToolGroup events={msg.toolEvents} running={msg.status === 'streaming'} />}
        {msg.planProposal && <PlanCard plan={msg.planProposal} />}
        {!!msg.todos?.length && <TodoList todos={msg.todos} />}
        {msg.content && (
          voice?.on && (msg.status === 'done' || msg.status === 'stopped')
            ? <VoiceBubble text={msg.content} cfg={voice.cfg} stored={voice.stored} anchorPrefix={`toc-${msg.id}`} />
            : <div className={`t2-content${msg.status === 'streaming' ? ' streaming-caret' : ''}`}><Markdown content={msg.content} anchorPrefix={`toc-${msg.id}`} /></div>
        )}
        {!msg.content && msg.status === 'streaming' && !msg.toolEvents?.length && !msg.reasoning && <div className="t2-dim streaming-caret">{t('chat.thinking')}</div>}
        {!!msg.displayFiles?.length && fileCtx && (
          <InlineFiles files={msg.displayFiles} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} execMode={fileCtx.execMode} onOpenPreview={fileCtx.onOpenPreview} />
        )}
        {msg.approvals?.map((a) => <ApprovalCard key={a.approvalId} req={a} onDecide={(act, args) => handlers?.onApproval?.(a.approvalId, act, args)} />)}
        {msg.inquiries?.map((q) => <InquiryCard key={q.inquiryId} req={q} onAnswer={(ans) => handlers?.onInquiry?.(q.inquiryId, ans)} />)}
        {msg.status === 'error' && <div className="t2-tool err"><span className="t2-status-err">✕ {msg.error || t('chat.error')}</span></div>}
        {msg.status === 'stopped' && <div className="t2-dim">⏹ {t('chat.aborted')}</div>}
        {(msg.status === 'done' || msg.status === 'stopped') && (
          <div className="t2-actions">
            <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(msg.content)}><Copy size={14} /></button>
            {handlers?.onSpeak && !!msg.content && (
              <button className="t2-iconbtn" title={t(speakState ? 'chat.action.stopSpeak' : 'chat.action.speak')} onClick={() => handlers.onSpeak?.()}>
                {speakState === 'loading' ? <Loader2 size={14} className="spin" /> : speakState === 'playing' ? <Square size={14} /> : <Volume2 size={14} />}
              </button>
            )}
            <button className="t2-iconbtn" title={t('chat.action.regenerate')} onClick={() => handlers?.onRegenerate?.()}><RotateCcw size={14} /></button>
            <button className="t2-iconbtn" title={t('chat.action.branch')} onClick={() => handlers?.onBranch?.()}><GitBranch size={14} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
