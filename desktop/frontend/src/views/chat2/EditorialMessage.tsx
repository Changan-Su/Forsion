import { HumanUpdateCard } from '../../components/HumanUpdateCard'
import { humanChanges } from '../../services/humanCollaboration'
/**
 * 编辑式消息渲染(新视觉):助手在纸面流动(头像 + 安静署名 + 内容 + 悬浮动作),
 * 用户为暖色带尾气泡。子件(思考/工具/待办/审批/反问)以新 t2 风格内联呈现。
 * 接 UiMessage,故可直接喂真实 store 数据(集成期用);回调可选(预览传空)。
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Copy, RotateCcw, GitBranch, Pencil, ChevronRight, ChevronDown, Volume2, Square, Loader2, LogIn, Zap, History as HistoryIcon, FileCode2, MessageSquare, ShieldQuestion, CircleCheck, CircleX, CircleHelp } from 'lucide-react'
import { FileInput } from 'lucide-react'
import { useNoteInsertState } from './insertToNote'
import * as api from '../../services/backendService'
import type { UiMessage, TanguDesktopConfig, AgentConfig, StoredDesktopConfig, ToolEvent, InquiryRequest, SketchItem, LiveWait } from '../../types'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { Markdown } from '../../components/Markdown'
import { ChatWikiLink, WikiText } from '../../components/ChatWikiLink'
import { RefChipView, splitLeadingRefs } from './RefChipView'
import { VoiceBubble } from '../../components/VoiceBubble'
import { InlineFiles } from '../../components/InlineFiles'
import { SketchCards } from '../../components/SketchCard'
import { sketchFence } from '../../amadeus/blocks/sketch/format'
import { SystemPromptBlock } from '../../components/SystemPromptBlock'

registerMessages({
  'chat.team.working': { zh: '工作中 · {activity}', en: 'Working · {activity}' },
  'chat.team.workingIdle': { zh: '工作中', en: 'Working' },
  'chat.team.waiting': { zh: '等待你的审批', en: 'Waiting for your approval' },
  'chat.team.waitingAnswer': { zh: '等你回答 · 在输入框上方', en: 'Waiting for your answer · above the input box' },
  'chat.team.done': { zh: '已完成', en: 'Done' },
  'chat.approval.pointer': { zh: '{name} 等你批准 · 在输入框上方', en: '{name} is waiting for your approval · above the input box' },
  'chat.approval.pointerN': { zh: '{n} 项操作等你批准 · 在输入框上方', en: '{n} actions are waiting for your approval · above the input box' },
  'chat.inquiry.pointer': { zh: '有问题等你回答 · 在输入框上方', en: 'A question is waiting for your answer · above the input box' },
  'chat.inquiry.pointerN': { zh: '{n} 个问题等你回答 · 在输入框上方', en: '{n} questions are waiting for your answer · above the input box' },
  'chat.approval.update.approved': { zh: '已批准并执行 {name}', en: 'Approved and ran {name}' },
  'chat.approval.update.failed': { zh: '已批准，{name} 执行出错', en: 'Approved; {name} ran with an error' },
  'chat.approval.update.rejected': { zh: '已拒绝 {name}（没有执行）', en: 'Rejected {name} (not run)' },
  // M1B:别处答的(执行的电脑本机 / 另一台设备 / 消息通道)—— {where} = approval.byHost* / byDevice … 的「在哪」短语
  'chat.approval.update.byApproved': { zh: '{where}批准', en: 'Approved {where}' },
  'chat.approval.update.byRejected': { zh: '{where}拒绝', en: 'Rejected {where}' },
})
const UPDATE_KEY = {
  approved: 'chat.approval.update.approved',
  failed: 'chat.approval.update.failed',
  rejected: 'chat.approval.update.rejected',
} as const
import { ToolGroup } from '../../components/ToolGroup'
import { useSpeechReveal } from './useSpeechReveal'
import { InquiryCard, PlanCard, TodoList } from '../../components/InquiryCard'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { runResultText, type RunResult } from '../../builtins/runCommand'
import { SUB_PROVIDER_LABELS } from '../../components/OnboardingWizard'
import { UI_MODE, useEdgeNudge } from '@lcl/engine'
import { splitSuggestions, type FenceKind, type SuggestState, type TaskCard } from './suggest'
import { CreationCards } from './CreationCards'

import { TaskCards, type TaskLanding } from './TaskCards'
import { APPROVAL_UPDATE_OPEN, approvalForCall, parseApprovalUpdate, pickPlanInquiry, type ApprovalOutcome } from './approvalQueue'
import { isRemoteApprover, wasDecidedHere } from '../../components/ApprovalCard'
import { answeredByText } from '../../approvalReason'
import { targetForSession, useSessionHostName } from '../../services/engine/targets'
export type { TaskLanding }
import './chat2.css'

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
  [/engine_unavailable_remote/i, 'chat.err.engineRemote'], // 契约 C6:远程污点 run 不进外部引擎
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
    zh: '直连账号的登录已过期，需要重新登录',
    en: 'Your direct-connection sign-in has expired — please sign in again',
  },
  'chat.err.relogin': { zh: '重新登录 {provider}', en: 'Sign in to {provider} again' },
  'rewind.title': { zh: '回退到这条消息', en: 'Rewind to this message' },
  'rewind.counting': { zh: '正在统计改动…', en: 'Counting changes…' },
  'rewind.codeOnly': { zh: '仅回退代码（{n} 个文件）', en: 'Code only ({n} file(s))' },
  'rewind.convOnly': { zh: '仅回退对话（原文回输入框）', en: 'Conversation only (prompt back in the box)' },
  'rewind.both': { zh: '代码 + 对话都回退', en: 'Both code and conversation' },
  // 如实写覆盖范围:快照只挂在内置写文件工具上,终端命令与插件/MCP 工具的写入拿不到 pre-image。
  'rewind.scopeNote': {
    zh: '只覆盖 Agent 经内置写文件工具（write/edit/multi_edit/apply_patch）改过的文件；终端命令与插件/MCP 工具改的不在内。',
    en: 'Covers only files changed through the built-in file-writing tools (write/edit/multi_edit/apply_patch); changes made by shell commands or plugin/MCP tools are not included.',
  },
  'rewind.skippedNote': { zh: '另有 {n} 个文件当时太大未存快照，恢复不了。', en: '{n} file(s) were too large to snapshot and cannot be restored.' },
  'rewind.keepNote': { zh: 'Agent 新建、之后又被改动过的文件会原样保留，不会被删。', en: 'Files the agent created that changed afterwards are kept as-is, never deleted.' },
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
    <button className="t2-relogin" onClick={() => useApp.getState().openSettings('model/m-providers')}>
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


export interface MessageHandlers {
  onCopy?: (text: string) => void
  onRegenerate?: () => void
  onBranch?: () => void
  onEdit?: () => void
  /** 朗读本条(再次点击=停止);未配置 TTS 时不传 → 按钮不渲染。text = 摘掉建议围栏的正文。 */
  onSpeak?: (text: string) => void
  /** 点了自动化建议芯片:把这句话当作用户自己发的消息送出去(建议本身不建规则)。 */
  onSuggest?: (text: string) => void
  /** 任务卡(```forsion-task)的落点点击:卡片本身什么也不做,点了才发消息 / 建 Muse 日程。
   *  返回 false = 没做成(卡片保留按钮);其余(true / void)= 做成,卡片定格。 */
  onTask?: (card: TaskCard, landing: TaskLanding) => boolean | void | Promise<boolean | void>
  /** 回退到本条消息的时刻(B1):仅代码 / 仅对话 / 两者。 */
  onRewind?: (mode: 'code' | 'conversation' | 'both') => void
  /** 把这条回答插回笔记(评审 G3-08,见 insertToNote.ts);宿主没有 Amadeus 编辑能力时不传 → 按钮不渲染。text = 摘掉围栏的正文。 */
  onInsertNote?: (text: string) => void
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
    void api.listCheckpoints(targetForSession(ctx.sessionId), ctx.sessionId)
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

/** <approval_update> 结局行下的「在哪批的」(M1B,K3 反方向):托盘模式下卡答完即撤,手机上只剩这一行 —— 按 approval_result.by
 *  (reducer 清洗过、挂在原审批上)补一行说明;本页自己答的不写。只在渲染层,不进给模型看的回灌正文。 */
function ApprovalUpdateBy({ sessionId, callId, status }: { sessionId?: string; callId: string; status: ApprovalOutcome['status'] }) {
  const { t } = useI18n()
  const req = useApp((s) => (sessionId ? approvalForCall(s.messagesBySession[sessionId], callId) : undefined))
  const hostName = useSessionHostName(sessionId) // S4:本会话所在的那台(焦点可能已换走)
  if (!req?.answeredBy) return null
  const where = answeredByText(req.answeredBy, { remotePage: isRemoteApprover(sessionId), answeredHere: wasDecidedHere(req.approvalId), hostName }, t as (k: string, v?: Record<string, unknown>) => string)
  if (!where) return null
  return <div className="t2-apv-update-by" data-answered-by>{t(status === 'rejected' ? 'chat.approval.update.byRejected' : 'chat.approval.update.byApproved', { where })}</div>
}

/** 「插入笔记」(G3-08):一篇 v4 笔记都没开 → 不出现;开着的全是只读 / 锁定 → aria-disabled + 说明 —— 不用 disabled:
 *  手机上没有悬停,点一下得有人告诉他为什么不行(点了走 onInsert,insertReplyToNote 自己说明)。 */
function InsertNoteButton({ onInsert }: { onInsert: () => void }) {
  const { t } = useI18n()
  const state = useNoteInsertState()
  if (state === 'hidden') return null
  const ready = state === 'ready'
  return (
    <button
      className="t2-iconbtn"
      data-act="insert-note"
      aria-disabled={ready ? undefined : true}
      title={t(ready ? 'chat.action.insertNote' : 'chat.insertNote.none')}
      aria-label={t('chat.action.insertNote')}
      onClick={onInsert}
    >
      <FileInput size={14} />
    </button>
  )
}

export function EditorialMessage({ msg, avatarUrl, agentNameFallback, userName, userAvatar, handlers, fileCtx, rootRef, speakState, voice, modelId, showWaitDetails = false, footer }: { /** 助手气泡正文末尾的附加行(ChatView 给最后一条助手消息挂 run 统计)。 */ footer?: React.ReactNode; msg: UiMessage; avatarUrl?: string; agentNameFallback?: string; userName?: string; userAvatar?: string; handlers?: MessageHandlers; fileCtx?: FileCtx; rootRef?: Ref<HTMLDivElement>; speakState?: 'loading' | 'playing'; voice?: { on: boolean; cfg: TanguDesktopConfig; stored: StoredDesktopConfig | null }; /** 这条消息实际用的模型(仅用于认出订阅直连过期 → 给重登按钮;缺省=不给)。 */ modelId?: string; /** 测试性功能:显示发送上下文 / 等待首帧 / 已等待时间。默认关。 */ showWaitDetails?: boolean }) {
  // shell 代码块「运行」的回传:结果作为用户消息发回**这条消息所在**的会话(run 活着自动变 steer)。
  // cwd 跟会话走(agent 的工作目录),没有就家目录。对象按会话 memo,别每次渲染新造一个(Markdown 是 React.memo)。
  const runSid = fileCtx?.sessionId
  const runCtx = useMemo(() => runSid ? {
    cwd: useApp.getState().configBySession[runSid]?.cwd || useApp.getState().sessions.find((s) => s.id === runSid)?.project_path || undefined,
    onRun: (r: RunResult) => { void useApp.getState().send(runResultText(r), [], undefined, undefined, undefined, runSid) },
  } : undefined, [runSid])
  // 独占一段的 `![[…]]` → 内联图片/音视频(Markdown 缺省关,只给助手消息开;理由见其 EmbedContext)。
  // 移动端不开:Android 没有 amadeus-asset 拦截器(同 ChatWikiLink 的 media 分支);无 readHostFile = 不在桌面壳里。
  const embedExec = fileCtx?.execMode
  const embeds = useMemo(() => (runSid && UI_MODE !== 'mobile' && window.tangu?.readHostFile ? { execMode: embedExec } : undefined), [runSid, embedExec])
  const { t } = useI18n()
  msg = useSpeechReveal(msg)
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
    // 挂起审批的结局回灌(引擎落库的 <approval_update> user 行):同理不是用户说的话 —— 每张一行结局。
    // 输出不在这里(引擎把真结果放回了原工具卡),这一行只说谁批了什么。
    if (msg.content.startsWith(APPROVAL_UPDATE_OPEN)) {
      const rows = parseApprovalUpdate(msg.content)
      return (
        <div ref={rootRef} className="t2-sys t2-apv-update" data-approval-update={rows.length}>
          {rows.map((r) => (
            <Fragment key={r.callId}>
              <div className="t2-apv-update-row" data-status={r.status}>
                {r.status === 'approved' ? <CircleCheck size={12} /> : <CircleX size={12} />}
                <span className="t2-apv-update-what">{t(UPDATE_KEY[r.status], { name: r.name })}</span>
                <span className="t2-apv-update-preview" title={r.preview}>{r.preview}</span>
              </div>
              <ApprovalUpdateBy sessionId={runSid} callId={r.callId} status={r.status} />
            </Fragment>
          ))}
        </div>
      )
    }
    const name = userName || t('chat.you')
    // 输入框「已选择」芯片发送时拼成正文第一行;气泡里还原成同一套芯片(U-11)。
    // 目录标题用剥掉引用后的正文;复制 / 编辑仍拿原始 msg.content(发的是什么就是什么)。
    const lead = splitLeadingRefs(msg.content)
    const tocTitle = lead ? (lead.body.trim() || lead.refs.map((r) => r.name).join(' ')) : msg.content
    return (
      <div ref={rootRef} className="t2-userwrap" id={`tocmsg-${msg.id}`} data-toc-msg-role="user" data-toc-title={tocTitle}>
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
            {lead && (
              <div className="t2-user-refs">
                {lead.refs.map((r, i) => (
                  <RefChipView key={`${r.token}-${i}`} chip={r}>
                    {r.wiki ? <ChatWikiLink inner={r.wiki} /> : undefined}
                  </RefChipView>
                ))}
              </div>
            )}
            {lead ? (lead.body && <WikiText text={lead.body} />) : <WikiText text={msg.content} />}
          </div>
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
        </div>
        <div className="t2-avatar t2-user-avatar" style={!userAvatar ? { background: 'color-mix(in srgb, var(--text-muted) 22%, transparent)' } : undefined}>
          {userAvatar ? <img src={userAvatar} alt="" /> : firstChar(name)}
        </div>
      </div>
    )
  }

  // 自动化建议围栏不属于正文:渲染/复制/朗读都用摘干净的 body,芯片单独摆一排。
  const streaming = msg.status === 'streaming'
  // 作品卡的按钮要宿主 IPC:只有桌面端认这种围栏,网页 / 手机端原样留在正文(不吞字)
  const fenceKinds: FenceKind[] = window.tangu?.productsRegister ? ['suggest', 'task', 'creation'] : ['suggest', 'task']
  const { text: body, items: suggestions, tasks, creations } = splitSuggestions(msg.content, { streaming, kinds: fenceKinds })
  // sketch 卡 → 笔记里的交互块(```forsion-sketch 围栏,嵌入层按同一沙箱渲染);与回答的「插入笔记」同一条写口。
  const sketchActions = handlers?.onInsertNote
    ? (it: SketchItem) => <InsertNoteButton onInsert={() => handlers.onInsertNote?.(sketchFence(it.html))} />
    : undefined
  // 计划审阅的询问归计划卡(专属三态按钮),不再另起一张通用问答卡。
  const planInq = pickPlanInquiry(msg)
  const pendingApv = (msg.approvals || []).filter((a) => a.status === 'pending')
  const pendingAsk = (msg.inquiries || []).filter((q) => q !== planInq && q.status === 'pending')
  const awaitingAnswer = pendingAsk.length > 0 || planInq?.status === 'pending'
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
        <div className="t2-name" style={msg.agentColor ? { color: msg.agentColor } : undefined}>{msg.agentName || agentNameFallback || 'Tangu'}{msg.status === 'streaming' && <span className="t2-dot" />}</div>
        {msg.systemPrompt && <SystemPromptBlock content={msg.systemPrompt} />}
        {msg.reasoning && <Thinking2 reasoning={msg.reasoning} />}
        {(() => {
          // 直播与带锚点的历史:按发生顺序渲染文字/工具,并把 Sketch 插在对应工具完成点。
          // 无段(旧历史 / 语音整条朗读)→ 回退老序:所有工具一块 + 全文。
          if (msg.segments?.length && !voiceMode) {
            // 流式正文末尾不画闪烁光标(09-16 用户要求去掉):「在输出」由署名旁的圆点与底部 run 统计行表达。
            // 一道围栏可能被中间的工具块切成两段 —— 状态要续读,否则后半段的建议原文会漏进正文。
            let fenceState: SuggestState | undefined
            // 只有**最后一个文本段**才能把未收口的围栏还回正文:靠前的段后面还有段,围栏可能在那里收口
            // (工具块把一道围栏切成两截),提前还回 = 原文泄漏进正文 + 后半段永远拼不成卡。
            const lastTextIdx = msg.segments.reduce((acc, s2, j) => (s2.t === 'text' ? j : acc), -1)
            return msg.segments.map((seg, i) => {
              if (seg.t === 'text') {
                const parsed = splitSuggestions(seg.text, { streaming: streaming || i !== lastTextIdx, state: fenceState, kinds: fenceKinds })
                fenceState = parsed.state
                const segBody = parsed.text
                return segBody
                  ? <div key={i} className="t2-content"><Markdown content={segBody} anchorPrefix={`toc-${msg.id}`} run={runCtx} embeds={embeds} /></div>
                  : null
              }
              const evs = seg.ids.map((id) => msg.toolEvents?.find((e) => e.id === id)).filter(Boolean) as ToolEvent[]
              const parts = partitionToolSegment(evs, msg.sketches)
              return parts.length ? (
                <Fragment key={i}>
                  {parts.map((part, j) => part.t === 'tools'
                    ? <ToolGroup key={`tools-${part.events.map((ev) => ev.id).join('-')}-${j}`} events={part.events} running={msg.status === 'streaming'} approvals={msg.approvals} awaitingAnswer={awaitingAnswer} />
                    : <SketchCards key={`sketch-${part.item.callId}`} items={[part.item]} actions={sketchActions} />)}
                </Fragment>
              ) : null
            })
          }
          return (
            <>
              {!!msg.toolEvents?.length && <ToolGroup events={msg.toolEvents} running={msg.status === 'streaming'} approvals={msg.approvals} awaitingAnswer={awaitingAnswer} />}
              {body && (
                voiceMode
                  ? <VoiceBubble text={body} stored={voice!.stored} anchorPrefix={`toc-${msg.id}`} />
                  : <div className="t2-content"><Markdown content={body} anchorPrefix={`toc-${msg.id}`} run={runCtx} embeds={embeds} /></div>
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
        {/* 任务卡:顺手发现的、塞进当前对话会撑爆的活。track=true 的卡主按钮是「交给 Muse 追踪」。同样只在 done 上渲染。
            渲染与落点按钮在 TaskCards(与收件箱共用)。 */}
        {!!tasks.length && msg.status === 'done' && <TaskCards tasks={tasks} ownerId={msg.id} onTask={handlers?.onTask} />}
        {/* 作品卡:把这条对话里做的东西变成「造物」(点了宿主才建文件夹 / 复制)。同样只在 done 上渲染。 */}
        {!!creations.length && msg.status === 'done' && <CreationCards cards={creations} sessionId={runSid} />}

        {fileCtx && <HumanUpdateCard changes={humanChanges(msg.toolEvents)} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} />}

        {msg.planProposal && (

          // 配对 kind='plan' 的询问 → 计划卡自带三态决策(批准/编辑后批准/打回);
          // 没配上(重载后的历史、或 plan 事件缺失)就只渲染正文,询问仍走下面通用卡兜底。
          <PlanCard key={planInq?.inquiryId || 'plan'} plan={msg.planProposal} req={planInq} />
        )}
        {!!msg.todos?.length && <TodoList todos={msg.todos} />}
        {/* 判空看 body 不看 msg.content:刚开始打建议围栏时 content 非空但正文为空,
            看 content 会让整条消息只剩一个署名圆点,连「思考中」都不显示。 */}
        {/* 测试性等待详情:开启时每次调用(含工具轮之后)画「发送 N KB / 等首帧 + 已等秒数」。
            默认关闭时仍保留通用「思考中」反馈，不能因 msg.live 存在而把两行一起吞掉。 */}
        {showWaitDetails && msg.status === 'streaming' && msg.live && <LiveWaitLine live={msg.live} />}
        {/* 并行团队:成员在自己的工作会话里干活,这条是它本次激活的占位 —— 一行动态(当前工具 / 等审批),发言到达才有正文;详情在 Team Desk。 */}
        {msg.status === 'streaming' && msg.work && (
          <div className="t2-dim chat-thinking-live" role="status" aria-live="polite" data-team-work={msg.work.waiting ? 'waiting' : 'working'}>
            <span className={msg.work.waiting ? undefined : 'chat-run-shimmer-text'}>
              {msg.work.waiting
                // 成员在等的是提问 / 计划拍板而不是审批时,别写「等待你的审批」(托盘里展开的是个问题,人会找不到审批)
                ? t(!pendingApv.length && awaitingAnswer ? 'chat.team.waitingAnswer' : 'chat.team.waiting')
                : msg.work.activity ? t('chat.team.working', { activity: msg.work.activity }) : t('chat.team.workingIdle')}
            </span>
          </div>
        )}
        {!body && msg.status === 'streaming' && !msg.work && !msg.toolEvents?.length && !msg.reasoning && (!msg.live || !showWaitDetails) && (
          <div className="t2-dim chat-thinking-live chat-run-shimmer-text" role="status" aria-live="polite">
            {t('chat.thinking')}
          </div>
        )}
        {/* 并行团队:发言以 DONE 收尾 → 正文里的 DONE 已剥掉,这里一枚小标记(成员表态「我这边完了」)。 */}
        {msg.teamDone && msg.status !== 'streaming' && (
          <div className="t2-dim t2-team-done" data-team-done="1">✓ {t('chat.team.done')}</div>
        )}
        {!!msg.displayFiles?.length && fileCtx && (
          <InlineFiles files={msg.displayFiles} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} execMode={fileCtx.execMode} onOpenPreview={fileCtx.onOpenPreview} />
        )}
        {!!trailingSketches.length && <SketchCards items={trailingSketches} actions={sketchActions} />}
        {/* 审批卡在输入框上方的托盘里批(ApprovalTray);流里只留一行指路,已兑现的不留痕 —— 结局看工具卡。
            团队成员的占位气泡已有「等待你的审批」那行,不重复。 */}
        {!msg.work && pendingApv.length > 0 && (
          <div className="t2-dim t2-apv-pointer" data-approval-pointer={pendingApv.length}>
            <ShieldQuestion size={12} />
            {pendingApv.length === 1 ? t('chat.approval.pointer', { name: pendingApv[0].name }) : t('chat.approval.pointerN', { n: pendingApv.length })}
          </div>
        )}
        {/* 待答的问题在托盘里答(流里一行指路);答过 / 过期的留在流里当问答记录。 */}
        {!msg.work && pendingAsk.length > 0 && (
          <div className="t2-dim t2-apv-pointer" data-inquiry-pointer={pendingAsk.length}>
            <CircleHelp size={12} />
            {pendingAsk.length === 1 ? t('chat.inquiry.pointer') : t('chat.inquiry.pointerN', { n: pendingAsk.length })}
          </div>
        )}
        {msg.inquiries?.filter((q) => q !== planInq && q.status !== 'pending').map((q) => <InquiryCard key={q.inquiryId} req={q} onAnswer={() => {}} />)}
        {msg.status === 'error' && (
          <div className="t2-tool err">
            <span className="t2-status-err">✕ {humanizeRunError(msg.error, t)}</span>
            <ReloginChip error={msg.error} modelId={modelId} />
          </div>
        )}
        {msg.status === 'stopped' && <div className="t2-dim">⏹ {t('chat.aborted')}</div>}
        {/* run 统计行放操作条之前:流式 → 完成时它原地不动,悬停出现的操作条长在下面,不会把它顶走。 */}
        {footer}
        {(msg.status === 'done' || msg.status === 'stopped') && (
          <div className="t2-actions">
            <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(body)}><Copy size={14} /></button>
            {handlers?.onSpeak && !!body && (
              <button className="t2-iconbtn" title={t(speakState ? 'chat.action.stopSpeak' : 'chat.action.speak')} onClick={() => handlers.onSpeak?.(body)}>
                {speakState === 'loading' ? <Loader2 size={14} className="spin" /> : speakState === 'playing' ? <Square size={14} /> : <Volume2 size={14} />}
              </button>
            )}
            {handlers?.onInsertNote && !!body && <InsertNoteButton onInsert={() => handlers.onInsertNote?.(body)} />}
            <button className="t2-iconbtn" title={t('chat.action.regenerate')} onClick={() => handlers?.onRegenerate?.()}><RotateCcw size={14} /></button>
            <button className="t2-iconbtn" title={t('chat.action.branch')} onClick={() => handlers?.onBranch?.()}><GitBranch size={14} /></button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 每秒刷新的已等待秒数(since=本次模型调用起点)。 */
function useElapsedSec(since: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  return Math.max(0, Math.floor((now - since) / 1000))
}

/** 等模型期间的实况行:正在发送上下文 N KB → 等待模型首帧,2 秒起带已等待秒数。
 *  2026-09-06 取证:本机 52% 墙钟在这段静默里,原先只有一行不动的 shimmer,用户报「卡住」。 */
function LiveWaitLine({ live }: { live: LiveWait }) {
  const { t } = useI18n()
  const sec = useElapsedSec(live.since)
  const kb = Math.max(1, Math.round((live.bytes || 0) / 1024))
  const label = live.phase === 'sending' && live.bytes ? t('chat.wait.sending', { kb }) : t('chat.wait.firstToken')
  return (
    <div className="t2-dim chat-thinking-live" role="status" aria-live="polite">
      <span className="chat-run-shimmer-text">{label}</span>
      {sec >= 2 && <span className="chat-wait-elapsed"> · {t('chat.wait.elapsed', { s: sec })}</span>}
    </div>
  )
}
