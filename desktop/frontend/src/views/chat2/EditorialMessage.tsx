import { MarketPluginCards, isMarketplaceTool } from '../../components/MarketPluginCards'
import { PluginSandboxCard, isSandboxCardTool } from './PluginSandboxCard'
import { GitToolCard, gitStatusSuperseded, isGitTool } from './GitToolCard'
import { HumanUpdateCard } from '../../components/HumanUpdateCard'
import { humanChanges } from '../../services/humanCollaboration'
import { SelfUpdateReceipt } from '../../components/SelfUpdateReceipt'
/**
 * 编辑式消息渲染(新视觉):助手在纸面流动(头像 + 安静署名 + 内容 + 悬浮动作),
 * 用户为暖色带尾气泡。子件(思考/工具/待办/审批/反问)以新 t2 风格内联呈现。
 * 接 UiMessage,故可直接喂真实 store 数据(集成期用);回调可选(预览传空)。
 */
import { Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { useStreamReveal } from './streamReveal'
import { Copy, RotateCcw, GitBranch, MessageCircleQuestion, CornerUpLeft, Pencil, Volume2, Square, Loader2, LogIn, Zap, History as HistoryIcon, FileCode2, MessageSquare, ShieldQuestion, CircleCheck, CircleX, CircleHelp } from 'lucide-react'
import { FileInput } from 'lucide-react'
import { useNoteInsertState } from './insertToNote'
import * as api from '../../services/backendService'
import type { UiMessage, TanguDesktopConfig, AgentConfig, StoredDesktopConfig, ToolEvent, InquiryRequest, SketchItem, LiveWait } from '../../../../../tangu-agent/src/contracts/clientTypes'
import type { PreviewTarget } from '../../components/WorkspaceFilePreview'
import { Markdown } from '../../components/Markdown'
import { ChatWikiLink, WikiText } from '../../components/ChatWikiLink'
import { RefChipView, splitLeadingRefs } from './RefChipView'
import { splitLeadingQuotes } from './quotes'
import { QuotePreview, QuoteTile, findQuoteSource } from './QuoteTile'
import { VoiceBubble } from '../../components/VoiceBubble'
import { InlineFiles } from '../../components/InlineFiles'
import { IntelligentUi } from '../../components/IntelligentUi'
import { SketchCards } from '../../components/SketchCard'
import { PluginToolCard, useToolCardOf, type ToolCardClaim } from '../../components/PluginToolCard'
import { HostWebCard, LocalWebCard, isHtmlFile, planWebCards, useSessionCwd, webCardsHere, type WebCardSpec } from './WebCards'
import { sketchFence } from '../../amadeus/blocks/sketch/format'
import { streamingArgString } from '../streamingWrite'
import { SystemPromptBlock } from '../../components/SystemPromptBlock'
import './chatAvatars' // 「聊天头像」开关落 <html data-chat-avatars>,见该文件

registerMessages({
  'chat.team.working': { zh: '工作中 · {activity}', en: 'Working · {activity}' },
  'chat.team.workingIdle': { zh: '工作中', en: 'Working' },
  'chat.team.waiting': { zh: '等待你的审批', en: 'Waiting for your approval' },
  'chat.team.waitingAnswer': { zh: '等你回答', en: 'Waiting for your answer' },
  'chat.team.done': { zh: '已完成', en: 'Done' },
  'chat.approval.pointer': { zh: '{name} 等你批准 · 在输入框上方', en: '{name} is waiting for your approval · above the input box' },
  'chat.approval.pointerN': { zh: '{n} 项操作等你批准 · 在输入框上方', en: '{n} actions are waiting for your approval · above the input box' },
  'chat.inquiry.updateAnswered': { zh: '你答了「{q}」', en: 'You answered “{q}”' },
  'chat.inquiry.updateNone': { zh: '「{q}」没等到回答', en: 'No answer to “{q}”' },
  'chat.inquiry.pointer': { zh: '有问题等你回答 · 在输入框上方', en: 'A question is waiting for your answer · above the input box' },
  'chat.inquiry.expiredLine': { zh: '提问已过期 · {q}', en: 'Question expired · {q}' },
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
import { playSendFlight } from './sendFlight'
import { InquiryCard, PlanCard, TodoList } from '../../components/InquiryCard'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { isHtmlCardTool } from '../../tangu/store/tanguSlice'
import { runResultText, type RunResult } from '../../builtins/runCommand'
import { SUB_PROVIDER_LABELS } from '../../components/OnboardingWizard'
import { UI_MODE, nativeSheetPresenter, runNativeCtxMenu, runNativeSheetMenu, useEdgeNudge, type SheetMenuItem } from '@lcl/engine'
import { splitSuggestions, type FenceKind, type SuggestState, type TaskCard } from './suggest'
import { CreationCards } from './CreationCards'
import { formatDateTime, formatMessageTime } from '../../format/time'

import { TaskCards, TaskTraces, type TaskLanding } from './TaskCards'
import { MuseApprovalLine, MuseTodoCards, MuseTodoTraces, ProactiveMark, isProactive } from './MuseDm'
import { FallbackLine, FallbackModelName, QuotaChips, QuotaRemindChip, QUOTA_RE, isQuotaText, quotaResetFromError, stripQuotaAsk } from './QuotaRelay'
import { CHILD_UPDATE_OPEN, ChildUpdateLine, ForkBlock, ForkScope, childIdsOf } from './ChildSessions'
import { APPROVAL_UPDATE_OPEN, INQUIRY_UPDATE_OPEN, approvalForCall, parseApprovalUpdate, parseInquiryUpdate, pickPlanInquiry, type ApprovalOutcome } from './approvalQueue'
import { isRemoteApprover, wasDecidedHere } from '../../components/ApprovalCard'
import { answeredByText, approvalPreviewText } from '../../approvalReason'
import { refForSession, targetForSession, useSessionHostName } from '../../services/engine/targets'
import { AttachmentTile } from '../../components/AttachmentTile'
import { ImageStack, stackable } from '../../components/ImageStack'
import { UserFold } from './UserFold'
export type { TaskLanding }
import './chat2.css'
import '../../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)

const isImageAtt = (a: { mimeType?: string; data?: string }): boolean => !!a.mimeType?.startsWith('image/') && !!a.data

export type OrderedToolPart =
  | { t: 'tools'; events: ToolEvent[] }
  | { t: 'sketch'; item: SketchItem }
  | { t: 'intelligent'; event: ToolEvent }
  | { t: 'marketplace'; event: ToolEvent }
  | { t: 'sandbox'; event: ToolEvent }
  | { t: 'pluginCard'; event: ToolEvent; claim: ToolCardClaim }
  | { t: 'web'; event: ToolEvent; spec: WebCardSpec }
  | { t: 'git'; events: ToolEvent[] }

/** 直播中还没收口的 sketch 调用 → 草稿卡(10-09,对标 ChatGPT Intelligent UI 边生成边渲染):tool_stream 已把参数增量
 *  累进 ev.arguments,这里从半截 JSON 里把 html 解出来。只在**直播**里算(live):历史 / 中断的未完成调用照旧不画幻影卡。 */
function draftSketchOf(ev: ToolEvent): SketchItem | undefined {
  if (!isHtmlCardTool(ev.name) || ev.done || !ev.arguments) return undefined
  const html = streamingArgString(ev.arguments, 'html')
  if (!html || !html.trim()) return undefined
  const title = streamingArgString(ev.arguments, 'title')
  return { callId: ev.id, html, ...(title ? { title } : {}), draft: true }
}

/**
 * 把一个连续工具段按 Sketch 完成点切开。Sketch 的工具行仍留在前一组中,卡片紧跟其后(原生文档的工具行不留,见下)；
 * 后续工具另起一组,于是多个草图与正文都不会再被批量挪到消息末尾。
 * live=消息还在直播:没收口的 sketch 调用也出一张草稿卡(同 callId,终稿到达原地换成正式卡)。
 * cardOf=插件结果卡片的认领(toolResultCards.useToolCardOf):认领了的调用画卡片**代替**通用记录(同原生文档),
 * 前后的工具各成一组;没认领的(运行中、出错、插件停用 / 重载)照旧是通用记录。
 * webOf=本地网页卡 / 服务卡(WebCards.planWebCards):工具行留着,卡排在这一段工具的最后 —— 不切开工具组,
 * 卡自己判定不画时(文件在 Vite 项目里、地址还没认出、不是本机会话)不留下两截工具组。
 */
export function partitionToolSegment(events: ToolEvent[], sketches?: SketchItem[], live = false, cardOf?: (ev: ToolEvent) => ToolCardClaim | undefined, webOf?: (ev: ToolEvent) => WebCardSpec | undefined): OrderedToolPart[] {
  const sketchByCall = new Map((sketches || []).map((item) => [item.callId, item]))
  const parts: OrderedToolPart[] = []
  const webs: OrderedToolPart[] = []
  let tools: ToolEvent[] = []
  let gitRun: ToolEvent[] = []
  const flushTools = (): void => {
    if (tools.length) parts.push({ t: 'tools', events: tools })
    tools = []
  }
  for (const [i, ev] of events.entries()) {
    if (ev.name === 'intelligent_ui') {
      // 原生文档就是回答本身(10-13,对标 ChatGPT:整条回答是一棵组件树,没有「工具」这一层):
      // 生成中和成功的调用不在文档上面挂工具行;被拒收的那次留着,错误看得见。
      const failed = (e: ToolEvent): boolean => e.done && (!!e.isError || /^Error[:\s]/i.test(e.result || ''))
      if (failed(ev)) tools.push(ev)
      flushTools()
      // 被拒收之后模型在同一段里重写、并且那一份成功了:残缺的那份不画(否则是一张「内容不完整」的卡下面再跟一张完整的),只留它的工具行。
      // 重写的那份还在生成、又被拒收或中断时,前一份照旧画着 —— 它可能是这条回答里唯一看得见的内容(Codex 10-13)。
      const rewritten = failed(ev) && events.slice(i + 1).some((next) => next.name === 'intelligent_ui' && next.done && !failed(next))
      if (!rewritten) parts.push({ t: 'intelligent', event: ev })
      continue
    }
    const claim = cardOf?.(ev)
    if (claim) { flushTools(); parts.push({ t: 'pluginCard', event: ev, claim }); continue }
    if (isSandboxCardTool(ev)) { flushTools(); parts.push({ t: 'sandbox', event: ev }); continue }
    // git_* 的工具行留着,连续几步 git 跑完后接一张 Git 卡(GitToolCard;下一个不是 git 调用时收口)
    if (isGitTool(ev)) {
      tools.push(ev)
      if (ev.done) gitRun.push(ev)
      if (gitRun.length && !(events[i + 1] && isGitTool(events[i + 1]))) { flushTools(); parts.push({ t: 'git', events: gitRun }); gitRun = [] }
      continue
    }
    tools.push(ev)
    if (isMarketplaceTool(ev) && ev.done && !ev.isError) { flushTools(); parts.push({ t: 'marketplace', event: ev }); continue }
    const web = webOf?.(ev)
    if (web) webs.push({ t: 'web', event: ev, spec: web })
    const sketch = sketchByCall.get(ev.id) ?? (live ? draftSketchOf(ev) : undefined)
    if (!sketch) continue
    flushTools()
    parts.push({ t: 'sketch', item: sketch })
  }
  flushTools()
  return webs.length ? [...parts, ...webs] : parts
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
  [QUOTA_RE, 'chat.err.quotaUsed'], // 订阅额度 / 账单配额用完:几小时才重置,不是限流(必须排在 429 前面)
  [/engine_unavailable_remote/i, 'chat.err.engineRemote'], // 契约 C6:远程污点 run 不进外部引擎
  [/run_cost_exceeded/i, 'chat.err.runCost'],
  [/input_too_large/i, 'chat.err.inputTooLarge'],
  [/group_needs_2_agents/i, 'chat.err.groupAgents'],
  [/^orphaned$|stale: process restarted/i, 'chat.err.orphaned'], // 真实产生方写 'stale: process restarted'(sqlStateStore.failStaleRuns)
  [/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i, 'chat.err.network'],
  [/terminated|ECONNRESET|socket hang up|premature close/i, 'chat.err.dropped'],
  [/ETIMEDOUT|timed? ?out/i, 'chat.err.timeout'],
  [/(^|\D)(401|403)(\D|$)|unauthorized|invalid[ _-]?api[ _-]?key/i, 'chat.err.auth'],
  [/(^|\D)429(\D|$)|rate[ _-]?limit|per ?minute|allocated quota exceeded/i, 'chat.err.rate'],
  [/(^|\D)5\d\d(\D|$)|bad gateway|overloaded/i, 'chat.err.server'],
]
export function humanizeRunError(raw: string | undefined, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (!raw) return t('chat.error')
  raw = stripQuotaAsk(raw)
  const hit = ERR_RULES.find(([re, key]) => re.test(raw) && (key !== 'chat.err.quotaUsed' || isQuotaText(raw)))
  if (hit?.[1] === 'chat.err.quotaUsed') {
    const time = quotaResetFromError(raw)
    return `${t(time ? 'chat.err.quotaUsedAt' : 'chat.err.quotaUsed', { time })}(${raw})`
  }
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

export interface MessageHandlers {
  onCopy?: (text: string) => void
  onRegenerate?: () => void
  /** 接着问:从这条分出一支(主区就地换成新的那支)。 */
  onBranch?: () => void
  /** 顺便问:挂在这条上问,开在右边那块面板,不进对话。 */
  onAside?: () => void
  onEdit?: () => void
  /** 朗读本条(再次点击=停止);未配置 TTS 时不传 → 按钮不渲染。text = 摘掉建议围栏的正文。 */
  onSpeak?: (text: string) => void
  /** 点了自动化建议芯片:把这句话当作用户自己发的消息送出去(建议本身不建规则)。 */
  onSuggest?: (text: string) => void
  /** 任务卡(```forsion-task)的落点点击:卡片本身什么也不做,点了才发消息 / 建 Muse 日程。
   *  返回 false = 没做成(卡片保留按钮);其余(true / void)= 做成,卡片定格。 */
  onTask?: (card: TaskCard, landing: TaskLanding) => boolean | void | { childId: string } | Promise<boolean | void | { childId: string }>
  /** 有就说明这个视图在对话末尾画了卡片堆(10-23 方案 B):任务卡只在这里留一行,点了滚过去;审批 / 提问不再留「在输入框上方」那行。 */
  onJumpDeck?: () => void
  /** 回退到本条消息的时刻(B1):仅代码 / 仅对话 / 两者。 */
  onRewind?: (mode: 'code' | 'conversation' | 'both') => void
  /** 把这条回答插回笔记(评审 G3-08,见 insertToNote.ts);宿主没有 Amadeus 编辑能力时不传 → 按钮不渲染。text = 摘掉围栏的正文。 */
  onInsertNote?: (text: string) => void
  /** 插件结果卡片的 call.quote:挂成这块输入框上方的引用卡(同划线「引用」)。不传 → 退回主对话的输入框。 */
  onQuote?: (text: string) => void
}

type RewindMode = 'code' | 'conversation' | 'both'
type RewindStat = { files: number; skipped: number }
type TFn = ReturnType<typeof useI18n>['t']

/** 该时刻之后可回退的文件数(检查点涉及的路径去重,减去当时没存下快照的)。Web 菜单与原生半屏共用这一份口径。 */
function loadRewindStat(at: number, ctx?: FileCtx): Promise<RewindStat> {
  // at=0(消息没时间戳)时 rewindTo 会直接拒绝 → 这里也必须报 0,别把整会话的检查点算进来点亮按钮。
  if (!ctx?.sessionId || !at) return Promise.resolve({ files: 0, skipped: 0 })
  return api.listCheckpoints(targetForSession(ctx.sessionId), ctx.sessionId)
    .then((cps) => {
      const files = new Set<string>()
      const skipped = new Set<string>()
      for (const c of cps) {
        if (c.at < at) continue
        c.files.forEach((p) => files.add(p))
        c.skipped.forEach((p) => skipped.add(p))
      }
      // 能真回退的 = 全部条目减去「没存下快照」的那些(files 是全集,skipped 是它的子集)。
      skipped.forEach((p) => files.delete(p))
      return { files: files.size, skipped: skipped.size }
    })
    .catch(() => ({ files: 0, skipped: 0 }))
}
/** 回退菜单的唯一一份条目(三档);stat=null = 还在统计。 */
function rewindMenuItems(stat: RewindStat | null, t: TFn, onPick: (mode: RewindMode) => void): SheetMenuItem[] {
  const n = stat?.files ?? 0
  return [
    { id: 'code', label: stat ? t('rewind.codeOnly', { n }) : t('rewind.counting'), icon: <FileCode2 size={14} />, disabled: !n, run: () => onPick('code') },
    { id: 'conversation', label: t('rewind.convOnly'), icon: <MessageSquare size={14} />, run: () => onPick('conversation') },
    { id: 'both', label: t('rewind.both'), icon: <HistoryIcon size={14} />, disabled: !n, run: () => onPick('both') },
  ]
}
const rewindNote = (stat: RewindStat | null, t: TFn): string =>
  [t('rewind.scopeNote'), t('rewind.keepNote'), ...(stat?.skipped ? [t('rewind.skippedNote', { n: stat.skipped })] : [])].join(' ')

/** Android(lcl nativeSheet 可选宿主):先统计再呈现原生半屏。没有宿主 → false,调用方照旧开 Web 菜单;
 *  宿主呈现失败 → onFallback 开 Web 菜单。
 *  `signal` = 发起这次请求的那条消息还在不在场(EditorialMessage 在卸载 / 换会话 / 换消息时 abort):
 *  统计检查点可能很慢,期间用户切走了会话 —— 那就**不再弹**;已经弹出来的半屏随 signal 一起收掉,选了也不执行。
 *  否则「回退对话」会落在用户已经离开的那个会话上(onPick 闭包里绑的是发起时的会话与消息)。
 *  Web 菜单没有这个洞:它是消息自己的子节点,消息一卸载菜单就没了。`load` 仅供单测注入慢统计。 */
export function openNativeRewind(
  at: number, ctx: FileCtx | undefined, t: TFn, onPick: (mode: RewindMode) => void, onFallback: () => void,
  signal: AbortSignal, load: typeof loadRewindStat = loadRewindStat,
): boolean {
  if (!nativeSheetPresenter()) return false
  void load(at, ctx)
    .then((stat) => {
      if (signal.aborted) return true // 统计期间消息已不在场:不弹,也不回落 Web 菜单
      const pick = (mode: RewindMode): void => { if (!signal.aborted) onPick(mode) }
      return runNativeSheetMenu({ title: t('rewind.title'), sections: [{ items: rewindMenuItems(stat, t, pick), footer: rewindNote(stat, t) }] }, { signal })
    })
    .then((handled) => { if (!handled && !signal.aborted) onFallback() })
  return true
}

/**
 * 回退菜单(用户消息 hover):三档 + 覆盖范围说明。文件数=该时刻之后所有检查点涉及的路径去重,
 * 打开时才拉(时间线不常看,没必要跟着每条消息常驻)。
 */
const RewindMenu: React.FC<{ at: number; ctx?: FileCtx; onPick: (mode: RewindMode) => void }> = ({ at, ctx, onPick }) => {
  const { t } = useI18n()
  const [stat, setStat] = useState<RewindStat | null>(null)
  // 靠近底部时向上翻:.t2-stream 有 mask 自成层叠上下文,菜单的 z-index 出不去,会被悬浮输入卡盖住且点不到。
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const edgeFix = useEdgeNudge(true, { boundary: '.t2-chat-view' })
  useEffect(() => {
    let alive = true
    void loadRewindStat(at, ctx).then((next) => { if (alive) setStat(next) })
    return () => { alive = false }
  }, [at, ctx?.sessionId, ctx?.cfg])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const limit = document.querySelector('.composer-anchor')?.getBoundingClientRect().top ?? window.innerHeight
    const r = el.getBoundingClientRect()
    if (r.bottom > limit - 4) setUp(true)
  }, [stat])
  return (
    <div
      ref={(el) => { ref.current = el; edgeFix.ref.current = el }}
      className={`composer-menu rewind-menu left${up ? ' up' : ''}`}
      style={edgeFix.style}
    >
      <div className="menu-section">{t('rewind.title')}</div>
      {rewindMenuItems(stat, t, onPick).map((it) => (
        <button key={it.id} className="menu-item" disabled={it.disabled} onClick={it.run}>
          {it.icon}
          <span className="grow">{it.label}</span>
        </button>
      ))}
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

/** 结局行里的预览:原审批带 previewI18n(账号动作 / 发布网页)→ 与审批卡同一句、按界面语言;否则回灌行里的英文摘要。 */
function ApprovalUpdatePreview({ sessionId, callId, preview }: { sessionId?: string; callId: string; preview: string }) {
  const { t } = useI18n()
  const req = useApp((s) => (sessionId ? approvalForCall(s.messagesBySession[sessionId], callId) : undefined))
  const text = req?.previewI18n ? approvalPreviewText(req, t as (k: string, v?: Record<string, unknown>) => string) : preview
  return <span className="t2-apv-update-preview" title={text}>{text}</span>
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

/** memo:流式时 ChatView 每来一段字就重渲一次,没变的消息在这里挡住 —— 不然长会话里每段字都把整段对话的消息外壳重跑一遍。
 *  只有 props 稳住才挡得住:ChatView 的 handlers 按消息 id 缓存、fileCtx / voice 走 useMemo。 */
export const EditorialMessage = memo(EditorialMessageView)

function EditorialMessageView({ msg, avatarUrl, agentNameFallback, userName, userAvatar, handlers, fileCtx, rootRef, speakState, voice, modelId, showWaitDetails = false, footer, onBringBack, todoInTail = false }: { /** 这条的任务清单画在对话末尾(ChatView 只给最新那份传):这里不再画。 */ todoInTail?: boolean; /** 助手气泡正文末尾的附加行(ChatView 给最后一条助手消息挂 run 统计)。 */ footer?: React.ReactNode; /** 分支里最后一条回答:「带回这里」把它作为引用挂进来源那支的输入框(ChatView 只给这一条传)。 */ onBringBack?: (text: string) => void; msg: UiMessage; avatarUrl?: string; agentNameFallback?: string; userName?: string; userAvatar?: string; handlers?: MessageHandlers; fileCtx?: FileCtx; rootRef?: Ref<HTMLDivElement>; speakState?: 'loading' | 'playing'; voice?: { on: boolean; cfg: TanguDesktopConfig; stored: StoredDesktopConfig | null }; /** 这条消息实际用的模型(仅用于认出订阅直连过期 → 给重登按钮;缺省=不给)。 */ modelId?: string; /** 测试性功能:显示发送上下文 / 等待首帧 / 已等待时间。默认关。 */ showWaitDetails?: boolean }) {
  const forkScope = useContext(ForkScope)
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
  // 会话在别的电脑上(桌面作为调用方):代码块的「运行」是这台电脑的终端、内联嵌入读的是这台电脑的盘 —— 都不是那台的,关掉。
  const elsewhere = !!runSid && refForSession(runSid).kind === 'unit'
  const embeds = useMemo(() => (runSid && !elsewhere && UI_MODE !== 'mobile' && window.tangu?.readHostFile ? { execMode: embedExec } : undefined), [runSid, embedExec, elsewhere])
  const { t } = useI18n()
  // 插件结果卡片的认领(订阅渲染器 / 名单:插件晚加载或被停用时这条消息跟着重渲)
  const cardOf = useToolCardOf()
  // 本地网页卡 / 服务卡(网页卡片第二轮 1):整条消息一起排(多个 HTML 只给入口、挂在最后一次写上)
  const webCwd = useSessionCwd(runSid)
  // 引擎不在这台电脑上 / 沙箱会话不排(卡画不出来就别动工具组和附件);同一路径又 display_file 了 → 那张归附件区画
  const webHere = webCardsHere(runSid, fileCtx?.execMode)
  const webPlan = useMemo(() => {
    if (!webHere) return new Map<string, WebCardSpec>()
    const shown = new Set((msg.displayFiles ?? []).map((f) => f.path).filter(Boolean))
    return new Map([...planWebCards(msg.toolEvents, webCwd)].filter(([, w]) => w.kind !== 'local' || !shown.has(w.path)))
  }, [webHere, msg.toolEvents, msg.displayFiles, webCwd])
  const webOf = useCallback((ev: ToolEvent) => webPlan.get(ev.id), [webPlan])
  // 待办清单的「进行中」只在这一段还在流式、且会话的 run 还活着时转圈:停止 / 出错 / 断流后的孤儿气泡都不转。
  // ponytail: steer 切段后旧段已 done,run 仍在跑时这份清单也停转;要跟上得在 turn_boundary 把 todos 挪到新段。
  const todoLive = useApp((s) => msg.status === 'streaming' && !!msg.todos?.length && (!runSid || !!s.runningBySession[runSid]))
  msg = useSpeechReveal(msg)
  // 建议芯片是一次性的:点了就等于用户按了回车,整排随即失效 —— 不然双击会把同一句排两遍。
  const [suggestSent, setSuggestSent] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [previewQuote, setPreviewQuote] = useState<{ text: string; note?: string } | null>(null)
  // 手机:长按菜单原生那头弹不出来过(宿主拒了这次请求)→ 这条消息把三个小键和文字选择还回来,动作不至于够不着。
  const [inlineActions, setInlineActions] = useState(false)
  // 原生回退半屏的在途请求(Android):消息卸载、或它所属的会话 / 消息换了 → 作废(见 openNativeRewind)。
  const rewindReq = useRef<AbortController | null>(null)
  useEffect(() => () => { rewindReq.current?.abort(); rewindReq.current = null }, [msg.id, runSid])
  // 发送动效:刚发出的那条从输入框升上来(只在挂载时认一次,见 sendFlight.ts)
  const userWrapRef = useRef<HTMLDivElement | null>(null)
  const setUserWrap = (el: HTMLDivElement | null): void => {
    userWrapRef.current = el
    if (typeof rootRef === 'function') rootRef(el)
    else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el
  }
  // 流式尾巴淡入(streamReveal.ts):只认助手那支的根
  const asstRef = useRef<HTMLDivElement | null>(null)
  const setAsst = useCallback((el: HTMLDivElement | null): void => {
    asstRef.current = el
    if (typeof rootRef === 'function') rootRef(el)
    else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el
  }, [rootRef])
  useStreamReveal(asstRef, msg.role === 'assistant' && msg.status === 'streaming')
  useLayoutEffect(() => {
    if (msg.role === 'user' && userWrapRef.current) playSendFlight(userWrapRef.current, msg.content)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
    // 子会话结果送回主会话(引擎落库的 <child_sessions_update> user 行):同理画成一行系统行。
    if (msg.content.startsWith(CHILD_UPDATE_OPEN)) return <div ref={rootRef}><ChildUpdateLine content={msg.content} /></div>
    // 挂起提问的答案回灌(<inquiry_update>,10-23):agent 没停下来等,答案到了这一行标出「它从这里接着用上了」
    if (msg.content.startsWith(INQUIRY_UPDATE_OPEN)) {
      const rows = parseInquiryUpdate(msg.content)
      return (
        <div ref={rootRef} className="t2-sys t2-apv-update" data-inquiry-update={rows.length}>
          {rows.map((r) => (
            <div key={r.callId} className="t2-apv-update-row" data-status={r.answered ? 'approved' : 'rejected'}>
              {r.answered ? <CircleCheck size={12} /> : <CircleX size={12} />}
              <span className="t2-apv-update-what">{t(r.answered ? 'chat.inquiry.updateAnswered' : 'chat.inquiry.updateNone', { q: r.question })}</span>
              {r.answered && <span className="t2-apv-update-preview" title={r.answer}>{r.answer}</span>}
            </div>
          ))}
        </div>
      )
    }
    if (msg.content.startsWith(APPROVAL_UPDATE_OPEN)) {
      const rows = parseApprovalUpdate(msg.content)
      return (
        <div ref={rootRef} className="t2-sys t2-apv-update" data-approval-update={rows.length}>
          {rows.map((r) => (
            <Fragment key={r.callId}>
              <div className="t2-apv-update-row" data-status={r.status}>
                {r.status === 'approved' ? <CircleCheck size={12} /> : <CircleX size={12} />}
                <span className="t2-apv-update-what">{t(UPDATE_KEY[r.status], { name: r.name })}</span>
                <ApprovalUpdatePreview sessionId={runSid} callId={r.callId} preview={r.preview} />
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
    // 引用卡同理:紧跟在芯片行后面的那几段引用块还原成卡片(quotes.ts),正文从它们之后开始。
    const lead = splitLeadingRefs(msg.content)
    const quoted = splitLeadingQuotes(lead ? lead.body : msg.content)
    const body = quoted ? quoted.body : lead ? lead.body : msg.content
    const tocTitle = lead || quoted ? (body.trim() || lead?.refs.map((r) => r.name).join(' ') || quoted?.quotes[0] || '') : msg.content
    const atts = msg.attachments || []
    // 只发了附件、没写字:不摆一个空气泡
    const hasBubble = !!(lead || (quoted ? body.trim() : msg.content.trim()))
    const toggleRewind = (): void => {
      // Android:三档改由原生半屏呈现;没有原生宿主时照旧切换 Web 菜单。
      if (!rewindOpen) {
        rewindReq.current?.abort() // 连点:上一次还在统计 / 还开着的请求作废,只留这一次
        const req = new AbortController()
        rewindReq.current = req
        if (openNativeRewind(msg.timestamp, fileCtx, t, (mode) => handlers?.onRewind?.(mode), () => setRewindOpen(true), req.signal)) return
        rewindReq.current = null
      }
      setRewindOpen((v) => !v)
    }
    // 手机(原生半屏宿主):气泡下面不常驻那三个小键(chat2.css 文件末尾按 [data-native-chrome] 收成看不见、读屏与键盘仍够得着),
    // 长按气泡出同样三项。没有宿主(桌面 / 网页 / 手机浏览器)→ 不拦,系统右键菜单与行内按钮照旧。
    // 与回退共用 rewindReq 这一个槽:消息卸载 / 换会话时上面的 effect 一并作废 —— 菜单开着时会话换了,它跟着关,
    // 不会对着已经离开的会话执行编辑 / 回退。
    // 只列这条消息真有的动作(只读会话没有编辑 / 回退);一个都没有就不拦,长按照系统的来。
    const onBubbleMenu = (e: React.MouseEvent): void => {
      const items = [
        ...(handlers?.onCopy ? [{ label: t('chat.action.copy'), icon: <Copy size={14} />, run: () => handlers.onCopy?.(msg.content) }] : []),
        ...(handlers?.onEdit ? [{ label: t('chat.action.edit'), icon: <Pencil size={14} />, run: () => handlers.onEdit?.() }] : []),
        ...(handlers?.onRewind ? [{ label: t('rewind.title'), icon: <HistoryIcon size={14} />, run: toggleRewind }] : []),
      ]
      if (!items.length || !nativeSheetPresenter()) return
      e.preventDefault()
      rewindReq.current?.abort()
      const req = new AbortController()
      rewindReq.current = req
      const restore = (): void => { if (!req.signal.aborted) setInlineActions(true) }
      void runNativeCtxMenu(items, { title: [...tocTitle.trim()].slice(0, 80).join(''), signal: req.signal }) // 按码点截:半个表情不过桥
        .then((shown) => { if (!shown) restore() }, restore)
    }
    return (
      <div ref={setUserWrap} className={`t2-userwrap${inlineActions ? ' t2-userwrap--inline' : ''}${footer ? ' t2-userwrap--failed' : ''}`} id={`tocmsg-${msg.id}`} data-toc-msg-role="user" data-toc-title={tocTitle}>
        <div className="t2-user-col">
          <div className="t2-username">{name}</div>
          {previewQuote && <QuotePreview text={previewQuote.text} note={previewQuote.note} onClose={() => setPreviewQuote(null)} />}
          {(atts.length > 0 || quoted) && (
            // 附件磁贴(B2)挪到气泡上方、右对齐:图片一行在前,文件一行在后;不参与长提问折叠。
            // 引用磁贴(10-23)排在最上面一行:点了跳回原文闪两下,找不到原文(老分页 / 别处带来的引用)就看全文。
            <div className="t2-user-atts" onContextMenu={onBubbleMenu}>
              {quoted && (
                <div className="t2-user-atts-row">
                  {quoted.quotes.map((quote, i) => (
                    // 带回应的卡显示回应(两段引用之间的文字);最后一段后面的字分不出回应还是正文,照旧进气泡
                    <QuoteTile key={i} text={quote} note={quoted.notes[i]} title={t('quote.tile.jump')} onOpen={(el) => {
                      const source = runSid ? findQuoteSource(el, quote) : undefined
                      if (source && runSid) useApp.getState().setJumpTarget(runSid, source)
                      else setPreviewQuote({ text: quote, note: quoted.notes[i] })
                    }} />
                  ))}
                </div>
              )}
              {[atts.filter(isImageAtt), atts.filter((a) => !isImageAtt(a))].map((row, r) => row.length > 0 && (
                // 图片超过 3 张叠成一摞(ImageStack.tsx);3 张以内照旧平铺
                r === 0 && stackable(row.length) ? <ImageStack key={r} files={row} /> :
                <div key={r} className="t2-user-atts-row">
                  {row.map((a, i) => <AttachmentTile key={`${a.name}-${i}`} file={a} view />)}
                </div>
              ))}
            </div>
          )}
          {hasBubble && (
          <div className="t2-user" onContextMenu={onBubbleMenu}>
            <UserFold lines={body.split('\n').length}>
            {lead && (
              <div className="t2-user-refs">
                {lead.refs.map((r, i) => (
                  <RefChipView key={`${r.token}-${i}`} chip={r}>
                    {r.wiki ? <ChatWikiLink inner={r.wiki} /> : undefined}
                  </RefChipView>
                ))}
              </div>
            )}
            {lead || quoted ? (body && <WikiText text={body} />) : <WikiText text={msg.content} />}
            </UserFold>
          </div>
          )}
          {/* 用户消息只有「没发出去」那条(ChatView 的 failedSends)传 footer:换掉复制 / 编辑那一排,放原因 + 丢弃 / 重试 */}
          {footer ?? (
          <div className="t2-actions">
            <MsgTime at={msg.timestamp} />
            <button className="t2-iconbtn" title={t('chat.action.copy')} onClick={() => handlers?.onCopy?.(msg.content)}><Copy size={14} /></button>
            <button className="t2-iconbtn" title={t('chat.action.edit')} onClick={() => handlers?.onEdit?.()}><Pencil size={14} /></button>
            {handlers?.onRewind && (
              <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
                <button className="t2-iconbtn" data-act="rewind" title={t('rewind.title')} onClick={toggleRewind}><HistoryIcon size={14} /></button>
                {rewindOpen && (
                  <RewindMenu at={msg.timestamp} ctx={fileCtx} onPick={(mode) => { setRewindOpen(false); handlers.onRewind?.(mode) }} />
                )}
              </span>
            )}
          </div>
          )}
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
  // Muse 私聊里它自己开口的那条(origin 只有引擎写得出,10-18 方案 B):待办卡的 `todo:` 头生效、审批围栏收成一行(MuseDm.tsx)。
  const museTodo = msg.origin === 'proactive:todo'
  const museApproval = msg.origin === 'proactive:approval'
  const fenceKinds: FenceKind[] = [...(window.tangu?.productsRegister ? ['suggest', 'task', 'creation'] as FenceKind[] : ['suggest', 'task'] as FenceKind[]), ...(museApproval ? ['approval'] as FenceKind[] : [])]
  const { text: body, items: suggestions, tasks, creations, approvals: museApprovals } = splitSuggestions(msg.content, { streaming, kinds: fenceKinds, todo: museTodo })
  const childIds = childIdsOf(msg.toolEvents) // 不用 hook:上面 system / user 两支提前 return 了
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
  const inlineToolIds = new Set(!voiceMode ? (msg.segments || []).flatMap(seg => seg.t === 'tools' ? seg.ids : []) : [])
  const trailingIntelligent = (msg.toolEvents || []).filter(ev => ev.name === 'intelligent_ui' && !inlineToolIds.has(ev.id))
  const trailingSketches = (msg.sketches || []).filter((item) => !inlineSketchIds.has(item.callId))
  const trailingCards = (msg.toolEvents || []).flatMap((ev) => {
    const claim = inlineToolIds.has(ev.id) ? undefined : cardOf(ev)
    return claim ? [{ ev, claim }] : []
  })

  return (
    <>
    {msg.fallback && <FallbackLine fb={msg.fallback} />}
    <div ref={setAsst} className="t2-asst" id={`tocmsg-${msg.id}`} data-streaming={msg.status === 'streaming' ? '' : undefined}>
      <div className="t2-avatar" style={!avatarUrl && msg.agentColor ? { background: msg.agentColor, color: '#fff' } : undefined}>{avatarUrl ? <img src={avatarUrl} alt="" /> : firstChar(msg.agentName || agentNameFallback || 'Tangu')}</div>
      <div className="t2-asst-col">
        <div className="t2-name" style={msg.agentColor ? { color: msg.agentColor } : undefined}>{msg.agentName || agentNameFallback || 'Tangu'}{msg.fallback && <FallbackModelName fb={msg.fallback} />}{msg.status === 'streaming' && <span className="t2-dot" />}</div>
        {isProactive(msg) && <ProactiveMark at={msg.timestamp} />}
        {msg.systemPrompt && <SystemPromptBlock content={msg.systemPrompt} />}
        {(() => {
          // 思考原文整条消息只有一份:挂在第一条过程行上(前面还没有正文时);否则单独一行过程行放最前(只剩思考那一步)。
          // 这条「打头的过程行」两条渲染分支都放在同一个位置、同一个 key —— 思考中途第一个工具到达、或之后再追加工具,
          // 它都不重挂,用户展开着的思考不会被收起、焦点也不丢。
          // 「思考中」只在它是消息最后一块时亮,后面已经有东西了就不在上头闪。
          const think = (last: boolean) => msg.reasoning ? { reasoning: msg.reasoning, reasoningMs: msg.reasoningMs, thinking: last && msg.reasoningSince != null } : {}
          // 直播与带锚点的历史:按发生顺序渲染文字/工具,并把 Sketch 插在对应工具完成点。
          // 无段(旧历史 / 语音整条朗读)→ 回退老序:所有工具一块 + 全文。
          if (msg.segments?.length && !voiceMode) {
            // 流式正文末尾不画闪烁光标(09-16 用户要求去掉):「在输出」由署名旁的圆点与底部 run 统计行表达。
            // 一道围栏可能被中间的工具块切成两段 —— 状态要续读,否则后半段的建议原文会漏进正文。
            let fenceState: SuggestState | undefined
            // 只有**最后一个文本段**才能把未收口的围栏还回正文:靠前的段后面还有段,围栏可能在那里收口
            // (工具块把一道围栏切成两截),提前还回 = 原文泄漏进正文 + 后半段永远拼不成卡。
            const lastTextIdx = msg.segments.reduce((acc, s2, j) => (s2.t === 'text' ? j : acc), -1)
            const firstIdx = msg.segments.findIndex((s2) => s2.t === 'tools' || !!s2.text.trim())
            const evsOf = (ids: string[]) => ids.map((id) => msg.toolEvents?.find((e) => e.id === id)).filter(Boolean) as ToolEvent[]
            const first = msg.segments[firstIdx]
            const firstParts = first?.t === 'tools' ? partitionToolSegment(evsOf(first.ids), msg.sketches, streaming, cardOf, webOf) : []
            const headEvents = firstParts[0]?.t === 'tools' ? firstParts[0].events : undefined
            const nodes = msg.segments.map((seg, i) => {
              if (seg.t === 'text') {
                const parsed = splitSuggestions(seg.text, { streaming: streaming || i !== lastTextIdx, state: fenceState, kinds: fenceKinds })
                fenceState = parsed.state
                const segBody = parsed.text
                return segBody
                  ? <div key={i} className="t2-content"><Markdown content={segBody} anchorPrefix={`toc-${msg.id}`} run={runCtx} allowRun={!elsewhere} embeds={embeds} linkCards /></div>
                  : null
              }
              const skip = i === firstIdx && headEvents ? 1 : 0
              const parts = (i === firstIdx ? firstParts : partitionToolSegment(evsOf(seg.ids), msg.sketches, streaming, cardOf, webOf)).slice(skip)
              return parts.length ? (
                <Fragment key={i}>
                  {parts.map((part, k) => part.t === 'tools'
                    ? <ToolGroup key={`tools-${part.events.map((ev) => ev.id).join('-')}-${k + skip}`} events={part.events} running={msg.status === 'streaming'} approvals={msg.approvals} awaitingAnswer={awaitingAnswer} />
                    : part.t === 'marketplace'
                      ? <MarketPluginCards key={`market-${part.event.id}`} event={part.event} />
                    : part.t === 'sandbox'
                      ? <PluginSandboxCard key={`sandbox-${part.event.id}`} event={part.event} />
                    : part.t === 'web'
                      ? <HostWebCard key={`web-${part.event.id}`} spec={part.spec} sessionId={runSid} onAsk={handlers?.onSuggest} />
                    : part.t === 'git'
                      ? (gitStatusSuperseded(part.events, msg.toolEvents) ? null : <GitToolCard key={`git-${part.events[0].id}`} events={part.events} sessionId={runSid} />)
                    : part.t === 'pluginCard'
                      ? <PluginToolCard key={`ptc-${part.event.id}`} event={part.event} claim={part.claim} onQuote={handlers?.onQuote} fallback={<ToolGroup events={[part.event]} />} />
                    : part.t === 'intelligent'
                      ? <IntelligentUi key={`intelligent-${part.event.id}`} event={part.event} live={streaming} stateScope={runSid ? `${runSid}:${msg.id}` : undefined} onAsk={handlers?.onSuggest} />
                    : <SketchCards key={`sketch-${part.item.callId}`} items={[part.item]} actions={sketchActions} stateScope={runSid ? `${runSid}:${msg.id}` : undefined} onAsk={handlers?.onSuggest} />)}
                </Fragment>
              ) : null
            })
            const head = (!!msg.reasoning || !!headEvents) && <ToolGroup key="proc-head" events={headEvents || []} running={streaming} approvals={msg.approvals} awaitingAnswer={awaitingAnswer} {...think(nodes.every((n) => n == null))} />
            return <>{head}{nodes}</>
          }
          // 老序:插件卡片挪到尾部(trailingCards),不在这一行里再列一遍
          const head = (!!msg.reasoning || !!msg.toolEvents?.length) && <ToolGroup key="proc-head" events={(msg.toolEvents || []).filter((ev) => !cardOf(ev))} running={streaming} approvals={msg.approvals} awaitingAnswer={awaitingAnswer} {...think(!body)} />
          return (
            <>
              {head}
              {body && (
                voiceMode
                  ? <VoiceBubble text={body} stored={voice!.stored} anchorPrefix={`toc-${msg.id}`} />
                  : <div className="t2-content"><Markdown content={body} anchorPrefix={`toc-${msg.id}`} run={runCtx} allowRun={!elsewhere} embeds={embeds} linkCards /></div>
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
        {/* 从这条分出去的:分支 / 顺便问 / start_session 开出的子会话,一块「从这里分出」(ChildSessions.tsx ForkBlock)。 */}
        {runSid && forkScope.inline && <ForkBlock sessionId={runSid} messageId={msg.id} childIds={childIds} onSuggest={handlers?.onSuggest} />}
        {/* 任务卡:顺手发现的、塞进当前对话会撑爆的活。track=true 的卡主按钮是「交给 Muse 追踪」。同样只在 done 上渲染。
            渲染与落点按钮在 TaskCards(与收件箱共用)。 */}
        {!!tasks.length && msg.status === 'done' && (handlers?.onJumpDeck && runSid
          ? museTodo
            ? <MuseTodoTraces tasks={tasks} ownerId={msg.id} sessionId={runSid} createdAt={msg.timestamp || undefined} onJump={handlers.onJumpDeck} />
            : <TaskTraces tasks={tasks} ownerId={msg.id} sessionId={runSid} createdAt={msg.timestamp || undefined} onJump={handlers.onJumpDeck} />
          : museTodo
            ? <MuseTodoCards tasks={tasks} ownerId={msg.id} onTask={handlers?.onTask} sessionId={runSid || undefined} createdAt={msg.timestamp || undefined} />
            : <TaskCards tasks={tasks} ownerId={msg.id} onTask={handlers?.onTask} sessionId={runSid || undefined} createdAt={msg.timestamp || undefined} />)}
        {museApprovals.map((id) => <MuseApprovalLine key={id} id={id} />)}
        {/* 作品卡:把这条对话里做的东西变成「造物」(点了宿主才建文件夹 / 复制)。同样只在 done 上渲染。 */}
        {!!creations.length && msg.status === 'done' && <CreationCards cards={creations} sessionId={runSid} onJump={handlers?.onJumpDeck} createdAt={msg.timestamp || undefined} />}

        {/* Agent 自己写了东西:记忆 / 进化记录并成一行回执;协作说明是说给用户听的,单独一张请求卡。 */}
        {fileCtx && <SelfUpdateReceipt events={msg.toolEvents} sessionId={fileCtx.sessionId} agentSlug={msg.agentId} />}
        {fileCtx && <HumanUpdateCard changes={humanChanges(msg.toolEvents)} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} agentName={msg.agentName || agentNameFallback} onJump={handlers?.onJumpDeck} createdAt={msg.timestamp || undefined} />}

        {msg.planProposal && (

          // 配对 kind='plan' 的询问 → 计划卡自带三态决策(批准/编辑后批准/打回);
          // 没配上(重载后的历史、或 plan 事件缺失)就只渲染正文,询问仍走下面通用卡兜底。
          <PlanCard key={planInq?.inquiryId || 'plan'} plan={msg.planProposal} req={planInq} />
        )}
        {!!msg.todos?.length && !todoInTail && <TodoList todos={msg.todos} live={todoLive} folded={!!handlers?.onJumpDeck} />}
        {/* 判空看 body 不看 msg.content:刚开始打建议围栏时 content 非空但正文为空,
            看 content 会让整条消息只剩一个署名圆点,连「思考中」都不显示。 */}
        {/* 测试性等待详情:开启时每次调用(含工具轮之后)画「发送 N KB / 等首帧 + 已等秒数」。
            默认关闭时仍保留通用「思考中」反馈，不能因 msg.live 存在而把两行一起吞掉。 */}
        {/* 图在转成文字(describing)不归这个开关管:那是一步几十秒的真实工作,默认设置下不画就是「界面不动」。 */}
        {msg.status === 'streaming' && msg.live && (showWaitDetails || msg.live.phase === 'describing') && <LiveWaitLine live={msg.live} />}
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
        {!body && msg.status === 'streaming' && !msg.work && !msg.toolEvents?.length && !msg.reasoning && (!msg.live || (!showWaitDetails && msg.live.phase !== 'describing')) && (
          <div className="t2-dim chat-thinking-live chat-run-shimmer-text" role="status" aria-live="polite">
            {t('chat.thinking')}
          </div>
        )}
        {/* 并行团队:发言以 DONE 收尾 → 正文里的 DONE 已剥掉,这里一枚小标记(成员表态「我这边完了」)。 */}
        {msg.teamDone && msg.status !== 'streaming' && (
          <div className="t2-dim t2-team-done" data-team-done="1">✓ {t('chat.team.done')}</div>
        )}
        {!!msg.displayFiles?.length && fileCtx && (() => {
          // 网页卡片第二轮 1:本机会话里展示一个 .html = 本地网页卡,代替文件名小卡(在 Vite 这类项目里退回小卡)
          const isWeb = (f: NonNullable<UiMessage['displayFiles']>[number]): boolean => webHere && !f.sourceSessionId && isHtmlFile(f.path)
          const files = (list: NonNullable<UiMessage['displayFiles']>) => <InlineFiles files={list} cfg={fileCtx.cfg} sessionId={fileCtx.sessionId} execMode={fileCtx.execMode} onOpenPreview={fileCtx.onOpenPreview} />
          const rest = msg.displayFiles.filter((f) => !isWeb(f))
          return <>
            {!!rest.length && files(rest)}
            {msg.displayFiles.filter(isWeb).map((f) => <LocalWebCard key={f.path} sessionId={fileCtx.sessionId} path={f.path!} onAsk={handlers?.onSuggest} fallback={files([f])} />)}
          </>
        })()}
        {(msg.toolEvents || []).filter(ev => isMarketplaceTool(ev) && !inlineToolIds.has(ev.id)).map(ev => <MarketPluginCards key={`market-${ev.id}`} event={ev} />)}
        {(msg.toolEvents || []).filter(ev => isSandboxCardTool(ev) && !inlineToolIds.has(ev.id)).map(ev => <PluginSandboxCard key={`sandbox-${ev.id}`} event={ev} />)}
        {(() => { const gitEvs = (msg.toolEvents || []).filter(ev => isGitTool(ev) && ev.done && !inlineToolIds.has(ev.id)); return gitEvs.length ? <GitToolCard key={`git-${gitEvs[0].id}`} events={gitEvs} sessionId={runSid} /> : null })()}
        {trailingIntelligent.map(ev => <IntelligentUi key={ev.id} event={ev} live={streaming} stateScope={runSid ? `${runSid}:${msg.id}` : undefined} onAsk={handlers?.onSuggest} />)}
        {!!trailingSketches.length && <SketchCards items={trailingSketches} actions={sketchActions} stateScope={runSid ? `${runSid}:${msg.id}` : undefined} onAsk={handlers?.onSuggest} />}
        {trailingCards.map(({ ev, claim }) => <PluginToolCard key={`ptc-${ev.id}`} event={ev} claim={claim} onQuote={handlers?.onQuote} fallback={<ToolGroup events={[ev]} />} />)}
        {/* 审批卡在托盘里批(ApprovalTray);托盘在输入框上方的视图(预览 / 画布)流里留一行指路,对话末尾有卡片堆的不留(卡就在下面)。已兑现的不留痕 —— 结局看工具卡。
            团队成员的占位气泡已有「等待你的审批」那行,不重复。 */}
        {!msg.work && !handlers?.onJumpDeck && pendingApv.length > 0 && (
          <div className="t2-dim t2-apv-pointer" data-approval-pointer={pendingApv.length}>
            <ShieldQuestion size={12} />
            {pendingApv.length === 1 ? t('chat.approval.pointer', { name: pendingApv[0].name }) : t('chat.approval.pointerN', { n: pendingApv.length })}
          </div>
        )}
        {/* 待答的问题在托盘里答(流里一行指路);答过 / 过期的留在流里当问答记录。 */}
        {!msg.work && !handlers?.onJumpDeck && pendingAsk.length > 0 && (
          <div className="t2-dim t2-apv-pointer" data-inquiry-pointer={pendingAsk.length}>
            <CircleHelp size={12} />
            {pendingAsk.length === 1 ? t('chat.inquiry.pointer') : t('chat.inquiry.pointerN', { n: pendingAsk.length })}
          </div>
        )}
        {/* 有卡片堆的视图里,过期的提问(run 停了没答)只留一行,不再摆一张灰卡 */}
        {msg.inquiries?.filter((q) => q !== planInq && q.status !== 'pending').map((q) => (q.status === 'expired' && handlers?.onJumpDeck
          ? <div key={q.inquiryId} className="t2-dim t2-apv-pointer" data-inquiry-expired={q.inquiryId}><CircleX size={12} /><span>{t('chat.inquiry.expiredLine', { q: q.question })}</span></div>
          : <InquiryCard key={q.inquiryId} req={q} onAnswer={() => {}} />))}
        {msg.status === 'error' && (
          <div className="t2-tool err">
            <span className="t2-status-err">✕ {humanizeRunError(msg.error, t)}</span>
            <ReloginChip error={msg.error} modelId={msg.fallback?.to ?? modelId} />
            <QuotaRemindChip error={msg.error} sessionId={runSid} modelId={msg.fallback?.to ?? modelId} />
            <QuotaChips error={msg.error} messageId={msg.id} sessionId={runSid} modelId={msg.fallback?.to ?? modelId} />
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
            {handlers?.onBranch && <button className="t2-iconbtn" title={t('chat.action.branch')} aria-label={t('chat.action.branch')} data-testid="msg-branch" onClick={() => handlers.onBranch?.()}><GitBranch size={14} /></button>}
            {handlers?.onAside && <button className="t2-iconbtn" title={t('chat.action.aside')} aria-label={t('chat.action.aside')} data-testid="msg-aside" onClick={() => handlers.onAside?.()}><MessageCircleQuestion size={14} /></button>}
            {onBringBack && !!body && <button className="t2-iconbtn t2-textbtn" data-testid="msg-bring-back" onClick={() => onBringBack(body)}><CornerUpLeft size={13} /> {t('chat.action.bringBack')}</button>}
            <MsgTime at={msg.timestamp} />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

/** 操作行末尾的时刻;悬停给带年份的完整时间。0 / 缺省(旧历史没存)不画,免得冒出 1970。 */
function MsgTime({ at }: { at: number }) {
  if (!(at > 0)) return null
  return <span className="t2-msgtime" title={formatDateTime(at, { year: 'always' })}>{formatMessageTime(at)}</span>
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
 *  2026-09-06 取证:本机 52% 墙钟在这段静默里,原先只有一行不动的 shimmer,用户报「卡住」。
 *  describing(10-07):主模型没有图像输入,截图在转成文字 —— 文案顺带说明原因,用户据此知道该换能看图的模型。 */
function LiveWaitLine({ live }: { live: LiveWait }) {
  const { t } = useI18n()
  const sec = useElapsedSec(live.since)
  const kb = Math.max(1, Math.round((live.bytes || 0) / 1024))
  const label = live.phase === 'describing' ? t('chat.wait.describing', { n: live.images || 1 })
    : live.phase === 'sending' && live.bytes ? t('chat.wait.sending', { kb }) : t('chat.wait.firstToken')
  return (
    <div className="t2-dim chat-thinking-live" role="status" aria-live="polite">
      <span className="chat-run-shimmer-text">{label}</span>
      {sec >= 2 && <span className="chat-wait-elapsed"> · {t('chat.wait.elapsed', { s: sec })}</span>}
    </div>
  )
}
