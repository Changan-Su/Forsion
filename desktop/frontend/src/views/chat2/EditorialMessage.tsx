/**
 * 编辑式消息渲染(新视觉):助手在纸面流动(头像 + 安静署名 + 内容 + 悬浮动作),
 * 用户为暖色带尾气泡。子件(思考/工具/待办/审批/反问)以新 t2 风格内联呈现。
 * 接 UiMessage,故可直接喂真实 store 数据(集成期用);回调可选(预览传空)。
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { Copy, RotateCcw, GitBranch, Pencil, ChevronRight, ChevronDown, Volume2, Square, Loader2, LogIn, Zap, History as HistoryIcon, FileCode2, MessageSquare } from 'lucide-react'
import * as api from '../../services/backendService'
import type { UiMessage, TanguDesktopConfig, AgentConfig, StoredDesktopConfig, ToolEvent, MsgSeg, InquiryRequest, SketchItem } from '../../types'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { Markdown } from '../../components/Markdown'
import { WikiText } from '../../components/ChatWikiLink'
import { VoiceBubble } from '../../components/VoiceBubble'
import { InlineFiles } from '../../components/InlineFiles'
import { SketchCards } from '../../components/SketchCard'
import { SystemPromptBlock } from '../../components/SystemPromptBlock'
import { ToolGroup } from '../../components/ToolGroup'
import { ApprovalCard } from '../../components/ApprovalCard'
import { InquiryCard, PlanCard, TodoList } from '../../components/InquiryCard'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { SUB_PROVIDER_LABELS } from '../../components/OnboardingWizard'
import { useEdgeNudge } from '@lcl/engine'
import { splitSuggestions, type SuggestState } from './suggest'
import './chat2.css'

/** 流式光标该落在哪一段:整条消息**最后一个真正渲染出来的**段的下标。
 *  它若落在工具段上,正文分支就永远不匹配 → 一个光标都不显示 —— 工具组自己的转圈已经在表达「在忙」。
 *  (旧行为是每个文字段都挂 streaming-caret,多次调工具时中间会留下一串闪烁块。)
 *  空文字段 / ids 解析不到事件的工具段都渲染成 null,不能算末尾。 */
export function caretSegIndex(segs: MsgSeg[], toolEvents?: ToolEvent[]): number {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]
    if (s.t === 'text' ? !!s.text : s.ids.some((id) => toolEvents?.some((e) => e.id === id))) return i
  }
  return -1
}

export type OrderedToolPart =
  | { t: 'tools'; events: ToolEvent[] }
  | { t: 'sketch'; item: SketchItem }

/**
 * 把一个连续工具段按 Sketch 完成点切开。Sketch 的工具行仍留在前一组中,卡片紧跟其后；
 * 后续工具另起一组,于是多个草图与正文都不会再被批量挪到消息末尾。
 */
export function partitionToolSegment(events: ToolEvent[], sketches?: SketchItem[]): OrderedToolPart[] {
  const sketchByCall = new Map((sketches || []).map((item) => [item.callId, item]))
  const parts: OrderedToolPart[] = []
  let tools: ToolEvent[] = []
  const flushTools = (): void => {
    if (tools.length) parts.push({ t: 'tools', events: tools })
    tools = []
  }
  for (const ev of events) {
    tools.push(ev)
    const sketch = sketchByCall.get(ev.id)
    if (!sketch) continue
    flushTools()
    parts.push({ t: 'sketch', item: sketch })
  }
  flushTools()
  return parts
}

/** 头像回退:无图时取昵称首字(支持 CJK/emoji),对齐 desktop1.0。 */
function firstChar(s?: string): string {
  const t = (s || '').trim()
  return t ? Array.from(t)[0].toUpperCase() : '?'
}

/** 运行错误人话化:undici 的 "fetch failed"/"terminated" 这类短语对用户零信息量,
 *  按特征映射成可行动的说明,原文保留在括号里供排查。未命中的原样透出。 */
/** 订阅直连(codex / xai)的 OAuth 凭证失效:上游把这句英文原样甩回来,用户唯一能做的动作是重新登录。
 *  ⚠️ 句式钉死在上游那句,**别放宽成泛 /expired/** —— Forsion 自家云 token 过期也会说 expired,那种
 *  要走 /login 重登 Forsion,不是去设置里重登直连账号;把人导到错的登录入口比不给按钮更坏。 */
const SUB_EXPIRED_RE = /provided authentication token is expired|try signing in again/i

const ERR_RULES: Array<[RegExp, string]> = [
  // 引擎自家错误码(agentLoop publish 的 error 字段是裸码):精确规则放前面
  [SUB_EXPIRED_RE, 'chat.err.subExpired'], // 比下面通用的 401 更具体,必须排在它前面
  [/token_quota_exceeded/i, 'chat.err.quota'],
  [/run_cost_exceeded/i, 'chat.err.runCost'],
  [/input_too_large/i, 'chat.err.inputTooLarge'],
  [/group_needs_2_agents/i, 'chat.err.groupAgents'],
  [/^orphaned$|stale: process restarted/i, 'chat.err.orphaned'], // 真实产生方写 'stale: process restarted'(sqlStateStore.failStaleRuns)
  [/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i, 'chat.err.network'],
  [/terminated|ECONNRESET|socket hang up|premature close/i, 'chat.err.dropped'],
  [/ETIMEDOUT|timed? ?out/i, 'chat.err.timeout'],
  [/(^|\D)(401|403)(\D|$)|unauthorized|invalid[ _-]?api[ _-]?key/i, 'chat.err.auth'],
  [/(^|\D)429(\D|$)|rate[ _-]?limit|insufficient[ _-]?quota/i, 'chat.err.rate'],
  [/(^|\D)5\d\d(\D|$)|bad gateway|overloaded/i, 'chat.err.server'],
]
export function humanizeRunError(raw: string | undefined, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (!raw) return t('chat.error')
  const hit = ERR_RULES.find(([re]) => re.test(raw))
  return hit ? `${t(hit[1])}(${raw})` : raw
}

registerMessages({
  'chat.err.subExpired': {
    zh: '直连账号的登录已过期,需要重新登录',
    en: 'Your direct-connection sign-in has expired — please sign in again',
  },
  'chat.err.relogin': { zh: '重新登录 {provider}', en: 'Sign in to {provider} again' },
  'rewind.title': { zh: '回退到这条消息', en: 'Rewind to this message' },
  'rewind.counting': { zh: '正在统计改动…', en: 'Counting changes…' },
  'rewind.codeOnly': { zh: '仅回退代码({n} 个文件)', en: 'Code only ({n} file(s))' },
  'rewind.convOnly': { zh: '仅回退对话(原文回输入框)', en: 'Conversation only (prompt back in the box)' },
  'rewind.both': { zh: '代码 + 对话都回退', en: 'Both code and conversation' },
  // 如实写覆盖范围:快照只挂在内置写文件工具上,终端命令与插件/MCP 工具的写入拿不到 pre-image。
  'rewind.scopeNote': {
    zh: '只覆盖 agent 经内置写文件工具(write/edit/multi_edit/apply_patch)改过的文件;终端命令与插件/MCP 工具改的不在内。',
    en: 'Covers only files changed through the built-in file-writing tools (write/edit/multi_edit/apply_patch); changes made by shell commands or plugin/MCP tools are not included.',
  },
  'rewind.skippedNote': { zh: '另有 {n} 个文件当时太大未存快照,恢复不了。', en: '{n} file(s) were too large to snapshot and cannot be restored.' },
  'rewind.keepNote': { zh: 'agent 新建、之后又被改动过的文件会原样保留,不会被删。', en: 'Files the agent created that changed afterwards are kept as-is, never deleted.' },
})

/** 该不该给「重新登录」按钮:句式命中 **且** 当前模型确实来自订阅直连(模型 id 前缀就是 provider id,
 *  见 tangu-agent 的 OAUTH_PROVIDERS)。认不出 provider 就只翻译文案、不给按钮 —— 免得把 BYO-key 或
 *  Forsion 云端的鉴权错误也导到直连登录入口去。 */
export function subLoginProvider(raw: string | undefined, modelId: string | undefined): string | null {
  if (!raw || !SUB_EXPIRED_RE.test(raw)) return null
  const id = (modelId || '').split('/')[0]
  return id && id in SUB_PROVIDER_LABELS ? id : null
}

/** 错误条尾巴上的「重新登录 X」:跳设置 → 模型页,订阅登录按钮就在那一节。
 *  订阅登录是 standalone 专属(providerLogin 这条 IPC 只有桌面壳有),别处那个设置页里根本没有登录
 *  入口 —— 按钮到了那儿就是条死路,故一并挡掉。 */
export function ReloginChip({ error, modelId }: { error?: string; modelId?: string }) {
  const { t } = useI18n()
  const id = subLoginProvider(error, modelId)
  if (!id || !window.tangu?.providerLogin) return null
  return (
    <button className="t2-relogin" onClick={() => useApp.getState().openSettings('model')}>
      <LogIn size={12} /> {t('chat.err.relogin', { provider: SUB_PROVIDER_LABELS[id] })}
    </button>
  )
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
      <AnimatedCollapse open={open}><div className="t2-think-body">{reasoning}</div></AnimatedCollapse>
    </div>
  )
}

/**
 * 计划卡该配对哪个询问:**待答的优先**,否则取最后一条。
 * 打回→重交会让同一条助手消息累积多个 kind='plan' 询问(第一条已答),而 planProposal 已被换成新一版
 * —— 取第一条 = 新计划配旧回执(卡上写着「已打回」却摆着新计划),取待答的才对得上。
 */
export function pickPlanInquiry(msg: Pick<UiMessage, 'planProposal' | 'inquiries'>): InquiryRequest | undefined {
  if (!msg.planProposal) return undefined
  const plans = (msg.inquiries || []).filter((q) => q.kind === 'plan')
  return plans.find((q) => q.status === 'pending') || plans[plans.length - 1]
}

export interface MessageHandlers {
  onCopy?: (text: string) => void
  onRegenerate?: () => void
  onBranch?: () => void
  onEdit?: () => void
  /** 朗读本条(再次点击=停止);未配置 TTS 时不传 → 按钮不渲染。text = 摘掉建议围栏的正文。 */
  onSpeak?: (text: string) => void
  /** 点了自动化建议芯片:把这句话当作用户自己发的消息送出去(建议本身不建规则)。 */
  onSuggest?: (text: string) => void
  onApproval?: (approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, unknown>) => void
  onInquiry?: (inquiryId: string, answer: string) => void | Promise<boolean | void>
  /** 回退到本条消息的时刻(B1):仅代码 / 仅对话 / 两者。 */
  onRewind?: (mode: 'code' | 'conversation' | 'both') => void
}

/**
 * 回退菜单(用户消息 hover):三档 + 覆盖范围说明。文件数=该时刻之后所有检查点涉及的路径去重,
 * 打开时才拉(时间线不常看,没必要跟着每条消息常驻)。
 */
const RewindMenu: React.FC<{ at: number; ctx?: FileCtx; onPick: (mode: 'code' | 'conversation' | 'both') => void }> = ({ at, ctx, onPick }) => {
  const { t } = useI18n()
  const [stat, setStat] = useState<{ files: number; skipped: number } | null>(null)
  // 靠近底部时向上翻:.t2-stream 有 mask 自成层叠上下文,菜单的 z-index 出不去,会被悬浮输入卡盖住且点不到。
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const edgeFix = useEdgeNudge(true, { boundary: '.t2-chat-view' })
  useEffect(() => {
    // at=0(消息没时间戳)时 rewindTo 会直接拒绝 → 这里也必须报 0,别把整会话的检查点算进来点亮按钮。
    if (!ctx?.sessionId || !at) { setStat({ files: 0, skipped: 0 }); return }
    let alive = true
    void api.listCheckpoints(ctx.cfg, ctx.sessionId)
      .then((cps) => {
        if (!alive) return
        const files = new Set<string>()
        const skipped = new Set<string>()
        for (const c of cps) {
          if (c.at < at) continue
          c.files.forEach((p) => files.add(p))
          c.skipped.forEach((p) => skipped.add(p))
        }
        // 能真回退的 = 全部条目减去「没存下快照」的那些(files 是全集,skipped 是它的子集)。
        skipped.forEach((p) => files.delete(p))
        setStat({ files: files.size, skipped: skipped.size })
      })
      .catch(() => { if (alive) setStat({ files: 0, skipped: 0 }) })
    return () => { alive = false }
  }, [at, ctx?.sessionId, ctx?.cfg])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const limit = document.querySelector('.composer-anchor')?.getBoundingClientRect().top ?? window.innerHeight
    const r = el.getBoundingClientRect()
    if (r.bottom > limit - 4) setUp(true)
  }, [stat])
  const n = stat?.files ?? 0
  return (
    <div
      ref={(el) => { ref.current = el; edgeFix.ref.current = el }}
      className={`composer-menu rewind-menu left${up ? ' up' : ''}`}
      style={edgeFix.style}
    >
      <div className="menu-section">{t('rewind.title')}</div>
      <button className="menu-item" disabled={!n} onClick={() => onPick('code')}>
        <FileCode2 size={14} />
        <span className="grow">{stat ? t('rewind.codeOnly', { n }) : t('rewind.counting')}</span>
      </button>
      <button className="menu-item" onClick={() => onPick('conversation')}>
        <MessageSquare size={14} />
        <span className="grow">{t('rewind.convOnly')}</span>
      </button>
      <button className="menu-item" disabled={!n} onClick={() => onPick('both')}>
        <HistoryIcon size={14} />
        <span className="grow">{t('rewind.both')}</span>
      </button>
      <div className="menu-section rewind-note">
        {t('rewind.scopeNote')} {t('rewind.keepNote')}
        {!!stat?.skipped && <> {t('rewind.skippedNote', { n: stat.skipped })}</>}
      </div>
    </div>
  )
}

export function EditorialMessage({ msg, avatarUrl, agentNameFallback, userName, userAvatar, handlers, fileCtx, rootRef, speakState, voice, modelId }: { msg: UiMessage; avatarUrl?: string; agentNameFallback?: string; userName?: string; userAvatar?: string; handlers?: MessageHandlers; fileCtx?: FileCtx; rootRef?: Ref<HTMLDivElement>; speakState?: 'loading' | 'playing'; voice?: { on: boolean; cfg: TanguDesktopConfig; stored: StoredDesktopConfig | null }; /** 这条消息实际用的模型(仅用于认出订阅直连过期 → 给重登按钮;缺省=不给)。 */ modelId?: string }) {
  const { t } = useI18n()
  // 建议芯片是一次性的:点了就等于用户按了回车,整排随即失效 —— 不然双击会把同一句排两遍。
  const [suggestSent, setSuggestSent] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  // 点外面/Esc 关回退菜单(同 Composer2 的 [data-cmenu] 约定)。
  useEffect(() => {
    if (!rewindOpen) return
    const onDown = (e: MouseEvent): void => {
      if ((e.target as HTMLElement)?.closest?.('[data-cmenu]')) return
      setRewindOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setRewindOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [rewindOpen])
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
    // 打断标记(引擎中止时落库的 <turn_interrupted> user 行):给模型看的机器行,对人渲染成一条
    // 轻分隔线,不摆成用户气泡(它不是用户「说」的话)。↑ 历史召回处已同规则滤除。
    if (msg.content.startsWith('<turn_interrupted>')) {
      return <div ref={rootRef} className="t2-sys t2-interrupted">⏹ {t('msg.interrupted')}</div>
    }
    const name = userName || t('chat.you')
    return (
      <div ref={rootRef} className="t2-userwrap" id={`tocmsg-${msg.id}`} data-toc-msg-role="user" data-toc-title={msg.content}>
        <div className="t2-actions">
          <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(msg.content)}><Copy size={14} /></button>
          <button className="t2-iconbtn" title={t('chat.action.edit')} onClick={() => handlers?.onEdit?.()}><Pencil size={14} /></button>
          {handlers?.onRewind && (
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button className="t2-iconbtn" title={t('rewind.title')} onClick={() => setRewindOpen((v) => !v)}><HistoryIcon size={14} /></button>
              {rewindOpen && (
                <RewindMenu at={msg.timestamp} ctx={fileCtx} onPick={(mode) => { setRewindOpen(false); handlers.onRewind?.(mode) }} />
              )}
            </span>
          )}
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
            <WikiText text={msg.content} />
          </div>
        </div>
        <div className="t2-avatar t2-user-avatar" style={!userAvatar ? { background: 'color-mix(in srgb, var(--text-muted) 22%, transparent)' } : undefined}>
          {userAvatar ? <img src={userAvatar} alt="" /> : firstChar(name)}
        </div>
      </div>
    )
  }

  // 自动化建议围栏不属于正文:渲染/复制/朗读都用摘干净的 body,芯片单独摆一排。
  const streaming = msg.status === 'streaming'
  const { text: body, items: suggestions } = splitSuggestions(msg.content, { streaming })
  // 计划审阅的询问归计划卡(专属三态按钮),不再另起一张通用问答卡。
  const planInq = pickPlanInquiry(msg)
  const voiceMode = !!voice?.on && (msg.status === 'done' || msg.status === 'stopped')
  // 顺序段里已消费的 Sketch 不许再在底部画一次。旧历史/语音消息走尾部兼容路径。
  const availableSketchIds = new Set((msg.sketches || []).map((item) => item.callId))
  const inlineSketchIds = new Set<string>()
  if (!voiceMode) {
    for (const seg of msg.segments || []) {
      if (seg.t === 'tools') for (const id of seg.ids) if (availableSketchIds.has(id)) inlineSketchIds.add(id)
    }
  }
  const trailingSketches = (msg.sketches || []).filter((item) => !inlineSketchIds.has(item.callId))

  return (
    <div ref={rootRef} className="t2-asst" id={`tocmsg-${msg.id}`}>
      <div className="t2-avatar" style={!avatarUrl && msg.agentColor ? { background: msg.agentColor, color: '#fff' } : undefined}>{avatarUrl ? <img src={avatarUrl} alt="" /> : firstChar(msg.agentName || agentNameFallback || 'Tangu')}</div>
      <div className="t2-asst-col">
        <div className="t2-name" style={msg.agentColor ? { color: msg.agentColor } : undefined}>{(msg.agentName || agentNameFallback || 'Tangu').toUpperCase()}{msg.status === 'streaming' && <span className="t2-dot" />}</div>
        {msg.systemPrompt && <SystemPromptBlock content={msg.systemPrompt} />}
        {msg.reasoning && <Thinking2 reasoning={msg.reasoning} />}
        {(() => {
          // 直播与带锚点的历史:按发生顺序渲染文字/工具,并把 Sketch 插在对应工具完成点。
          // 无段(旧历史 / 语音整条朗读)→ 回退老序:所有工具一块 + 全文。
          if (msg.segments?.length && !voiceMode) {
            const caretAt = msg.status === 'streaming' ? caretSegIndex(msg.segments, msg.toolEvents) : -1
            // 一道围栏可能被中间的工具块切成两段 —— 状态要续读,否则后半段的建议原文会漏进正文。
            let fenceState: SuggestState | undefined
            return msg.segments.map((seg, i) => {
              if (seg.t === 'text') {
                const parsed = splitSuggestions(seg.text, { streaming, state: fenceState })
                fenceState = parsed.state
                const segBody = parsed.text
                return segBody
                  ? <div key={i} className={`t2-content${i === caretAt ? ' streaming-caret' : ''}`}><Markdown content={segBody} anchorPrefix={`toc-${msg.id}`} /></div>
                  : null
              }
              const evs = seg.ids.map((id) => msg.toolEvents?.find((e) => e.id === id)).filter(Boolean) as ToolEvent[]
              const parts = partitionToolSegment(evs, msg.sketches)
              return parts.length ? (
                <Fragment key={i}>
                  {parts.map((part, j) => part.t === 'tools'
                    ? <ToolGroup key={`tools-${part.events.map((ev) => ev.id).join('-')}-${j}`} events={part.events} running={msg.status === 'streaming'} />
                    : <SketchCards key={`sketch-${part.item.callId}`} items={[part.item]} />)}
                </Fragment>
              ) : null
            })
          }
          return (
            <>
              {!!msg.toolEvents?.length && <ToolGroup events={msg.toolEvents} running={msg.status === 'streaming'} />}
              {body && (
                voiceMode
                  ? <VoiceBubble text={body} cfg={voice!.cfg} stored={voice!.stored} anchorPrefix={`toc-${msg.id}`} />
                  : <div className={`t2-content${msg.status === 'streaming' ? ' streaming-caret' : ''}`}><Markdown content={body} anchorPrefix={`toc-${msg.id}`} /></div>
              )}
            </>
          )
        })()}
        {/* 建议只是「可以做成什么」,点了才把这句话当用户消息发出去。
            只在 done 上渲染:中止/出错的回复里那半句建议还没写完,不该给出可发送的按钮。 */}
        {!!suggestions.length && msg.status === 'done' && (
          <div className="t2-suggest">
            {suggestions.map((s, i) => (
              <button
                key={i}
                className="t2-suggest-chip"
                disabled={suggestSent}
                onClick={() => { setSuggestSent(true); handlers?.onSuggest?.(s) }}
              >
                <Zap size={13} /> {s}
              </button>
            ))}
          </div>
        )}
        {msg.planProposal && (
          // 配对 kind='plan' 的询问 → 计划卡自带三态决策(批准/编辑后批准/打回);
          // 没配上(重载后的历史、或 plan 事件缺失)就只渲染正文,询问仍走下面通用卡兜底。
          <PlanCard
            key={planInq?.inquiryId || 'plan'}
            plan={msg.planProposal}
            req={planInq}
            onAnswer={planInq ? (ans) => handlers?.onInquiry?.(planInq.inquiryId, ans) : undefined}
          />
        )}
        {!!msg.todos?.length && <TodoList todos={msg.todos} />}
        {/* 判空看 body 不看 msg.content:刚开始打建议围栏时 content 非空但正文为空,
            看 content 会让整条消息只剩一个署名圆点,连「思考中」都不显示。 */}
        {!body && msg.status === 'streaming' && !msg.toolEvents?.length && !msg.reasoning && (
          <div className="t2-dim chat-thinking-live chat-run-shimmer-text" role="status" aria-live="polite">
            {t('chat.thinking')}
          </div>
        )}
        {!!msg.displayFiles?.length && fileCtx && (
          <InlineFiles files={msg.displayFiles} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} execMode={fileCtx.execMode} onOpenPreview={fileCtx.onOpenPreview} />
        )}
        {!!trailingSketches.length && <SketchCards items={trailingSketches} />}
        {msg.approvals?.map((a) => <ApprovalCard key={a.approvalId} req={a} onDecide={(act, args) => handlers?.onApproval?.(a.approvalId, act, args)} />)}
        {msg.inquiries?.filter((q) => q !== planInq).map((q) => <InquiryCard key={q.inquiryId} req={q} onAnswer={(ans) => handlers?.onInquiry?.(q.inquiryId, ans)} />)}
        {msg.status === 'error' && (
          <div className="t2-tool err">
            <span className="t2-status-err">✕ {humanizeRunError(msg.error, t)}</span>
            <ReloginChip error={msg.error} modelId={modelId} />
          </div>
        )}
        {msg.status === 'stopped' && <div className="t2-dim">⏹ {t('chat.aborted')}</div>}
        {(msg.status === 'done' || msg.status === 'stopped') && (
          <div className="t2-actions">
            <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(body)}><Copy size={14} /></button>
            {handlers?.onSpeak && !!body && (
              <button className="t2-iconbtn" title={t(speakState ? 'chat.action.stopSpeak' : 'chat.action.speak')} onClick={() => handlers.onSpeak?.(body)}>
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
