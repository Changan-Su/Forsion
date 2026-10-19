/** 主区聊天 leaf：followActive 跟随侧栏；分屏 leaf 用 sessionId 固定会话。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ArrowDown, Folder, MessageCircleQuestion, MessageSquare, Quote, Waypoints } from 'lucide-react'
import type { AgentConfig, UiMessage } from '../../../../tangu-agent/src/contracts/clientTypes'
import { Composer2 } from './chat2/Composer2'
import { AgentSelectStrip } from '../components/AgentSelectStrip'
import { displaySessionTitle } from '../sessionTitle'
import { ProjectSelector } from '../components/ProjectSelector'
import { RunLocationPicker, useRunPickerVisible } from '../components/RunLocationPicker' // P1-K7a
import { useRemoteNewChatWorkspaces } from '../stores/newChatWorkspaces'
import { WorkspaceFilePreview } from '../components/WorkspaceFilePreview'
import { targetFor } from '../components/InlineFiles'
import { openWsFile } from './wsFileNav'
import { openNewChat, openSession, rotateSolo } from '../sessionNav'
import { TeamEditor } from '../components/TeamEditor'
import { postMuseFeedback, saveAgentScheduleEntry } from '../services/backendService'
import { runTaskCard } from './chat2/taskLanding'
import { NO_QUOTE_DRAFT, quoteAdded, quotesFor } from './chat2/quotes'
import { askOriginOf, insertReplyToNote } from './chat2/insertToNote'
import { amadeusAvailable } from '../features/runtime'
import { resolveDeskPath } from '../stores/deskPlan'
import { useDeskAcceptsFiles } from '../amadeus/plugins/deskCompanion'
import { ToolCardDeskContext, toolCardDeskFor } from '../components/PluginToolCard'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { EditorialMessage, type MessageHandlers } from './chat2/EditorialMessage'
import { ApprovalTray } from './chat2/ApprovalTray'
import { MuseApprovalTray } from './chat2/MuseDm'
import { APPROVAL_UPDATE_OPEN, pendingPromptsOf } from './chat2/approvalQueue'
import { CHILD_UPDATE_OPEN, ChildFromLine } from './chat2/ChildSessions'
import { RunStatsLine } from './chat2/RunStatsLine'
import { SessionTraceLines, useSessionTraces } from '../components/SessionTraces'
import { SessionOpening } from '../components/SessionOpening'
import { ExtraFolders } from '../components/ExtraFolders'
import { inRunWindow } from '../stores/runStats'
import { EmptyState2 } from './chat2/EmptyState2'
import { FloatingToc } from './chat2/FloatingToc'
import { TaskSummary } from './chat2/TaskSummary'
import { useApp, stickyDefaults, activeChatModelId, withAmadeusWorkspace, applyPreset, newSessionPreset, amadeusLandingRoot } from '../stores/appStore'
import { settleModes } from '../stores/projectSettings'
import { currentPlatform } from '../services/agentRunService'
import { hasChatRef, readChatRefs } from '../components/chatDragRef'
import { useWorkspace, useSpaceStore, UI_MODE, Skeleton, scrollToElement, cancelScrollToElement, useViewModes, ViewHead, inSingleColumnShell } from '@lcl/engine'
import { useTailFirst } from './chat2/useTailFirst'
import { AgentDesk, DeskCard, useDeskHome } from './chat2/AgentDesk'
import { HistorianStatus } from './chat2/HistorianStatus'
import { TeamStatus } from './chat2/TeamDesk'
import { ChildChatPanel, SubChatStatus } from './chat2/ChildChatPanel'
import { openBtw, quoteInMainChat } from './chat2/btwStore'
import { useChildChat } from '../stores/childChatStore'
import { ChatCanvas, useChatCanvasPref } from './chat2/ChatCanvas'
import { TeamSummary } from './chat2/TeamSummary'
import { useI18n } from '../i18n'
import { speakMessage, stopSpeaking, subscribeTts, ttsState, type TtsState } from '../services/ttsService'
import { homeTarget, useComposerRef } from '../services/engine/targets'
import type { ViewProps } from '@lcl/engine/types'
import { useShallow } from 'zustand/react/shallow'
import './chat2/chat2.css'
import { ViewSelectionBar } from '../components/selectionBar/ViewSelectionBar'
import { usePageStore } from '../amadeus/store/pageStore'
import { useCodeStudio } from '../stores/codeStudioStore'
import { projectName } from './coding/studioModel'
import './coding/studioMessages'
import { selectableChatModels } from './chatModelCatalog'
import { useChatWaitDetailsEnabled } from '../chatWaitDetails'
import { QuotaAdvisoryBanner } from '../components/QuotaAdvisoryBanner'
import { TargetHealthNotice, useComposerReady, useTargetComposerPlaceholder } from '../components/TargetHealthNotice'

const EMPTY_MESSAGES: UiMessage[] = []
const EMPTY_CONFIG: AgentConfig = {}
const EMPTY_USAGE: { ctx: number; base: number; live: number; runCost?: number; costLimit?: number } = { ctx: 0, base: 0, live: 0 }
const EMPTY_STEER: Array<{ id: string; text: string }> = []
const EMPTY_STRS: string[] = []
/** 列表里不画的消息:团队总结(单独挂尾部)与只有工作占位、没东西可看的成员气泡。 */
const isHiddenInList = (m: UiMessage): boolean =>
  !!m.teamSummary || (!!m.work && !m.content && !m.error && !m.approvals?.length && !m.inquiries?.length)

/** 侧边拼接面板递来的那扇 App 窗口(leaf params 是不透明数据,逐字段挑)。 */
function appRefOf(raw: unknown): { app: string; bundleId?: string; pid: number; windowId: number; title: string } | null {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!r || typeof r.pid !== 'number' || typeof r.windowId !== 'number') return null
  return { app: String(r.app ?? ''), bundleId: typeof r.bundleId === 'string' ? r.bundleId : undefined, pid: r.pid, windowId: r.windowId, title: String(r.title ?? '') }
}

/** 「回到底部」键自己管显隐。它在滚动起手的那一下翻转;原来是 ChatView 的 state,翻一次就把整段对话的每条消息
 *  重渲一遍(2026-10-11 实测:中端手机速度下每次滑动起手顿约 150ms)。ChatView 只握一个写入口(`setter`),不随它重渲。 */
function JumpToBottom({ setter, title, onClick }: { setter: MutableRefObject<(show: boolean) => void>; title: string; onClick: () => void }) {
  const [show, setShow] = useState(false)
  setter.current = setShow
  return show ? <button className="jump-bottom t2-jump" title={title} onClick={onClick}><ArrowDown size={16} /></button> : null
}

/** 划线所在的那条回答(EditorialMessage 根节点 id = tocmsg-<消息 id>);不在某条回答里 → undefined(引擎挂到最近一条回答)。 */
function selectedMessageId(): string | undefined {
  const node = window.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  const id = el?.closest('.t2-asst[id^="tocmsg-"]')?.id
  return id ? id.slice('tocmsg-'.length) : undefined
}

export function ChatView({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const showWaitDetails = useChatWaitDetailsEnabled()
  const childSelections = useChildChat((state) => state.selected)
  const [raiseTeam, setRaiseTeam] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const streamingNodeRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const pendingCountRef = useRef(0)
  const globalActiveId = useApp((state) => state.activeId)
  const followActive = params.followActive !== false
  // Saved Coding layouts predate the studio param; the active Space supplies the same scope.
  const inCodingSpace = useSpaceStore(state => state.activeSpaceId === 'coding')
  const inAmadeusSpace = useSpaceStore(state => state.activeSpaceId === 'amadeus')
  const studioChat = followActive && (!!params.studio || inCodingSpace)
  const studioRoot = useCodeStudio(state => state.activeProject)
  const pinnedSessionId = typeof params.sessionId === 'string' ? params.sessionId : null
  const activeId = followActive ? globalActiveId : pinnedSessionId
  // P1-K6:输入框对着的那台是「我的电脑」且没连上 → 「等待那台连上」;S4 起按本会话所在的那台(空白新对话 = 焦点)
  const targetPlaceholder = useTargetComposerPlaceholder(activeId)
  const composerTargetReady = useComposerReady(activeId)
  const runPickerOn = useRunPickerVisible() // P1-K7a:「在哪运行」有得选(Chat 模式据此多出那一栏;桌面 Work 模式的药丸恒在)
  const remoteWs = useRemoteNewChatWorkspaces() // 桌面:运行位置在别的电脑上 → 项目药丸列那台的项目
  // 历史在拉:空消息 ≠ 空会话 —— 拉取期间显示会话骨架屏,别把有消息的会话先亮成空状态(EmptyState2)。
  const historyLoading = useApp((state) => !!(activeId && state.historyLoading[activeId]))
  const s = useApp(useShallow((state) => ({
    activeSession: state.sessions.find((x) => x.id === activeId) || state.archivedSessions.find((x) => x.id === activeId) || null,
    activeMessages: (activeId && state.messagesBySession[activeId]) || EMPTY_MESSAGES,
    running: !!(activeId && state.runningBySession[activeId]),
    runStats: (activeId && state.runStatsBySession[activeId]) || null,
    historianEnabled: state.specialEnabled.historian,
    execConfig: (activeId && state.configBySession[activeId]) || EMPTY_CONFIG,
    activeUsage: (activeId && state.usageBySession[activeId]) || EMPTY_USAGE,
    activeCtxInfo: (activeId && state.ctxInfoBySession[activeId]) || null,
    isGroupVoting: !!(activeId && state.groupVoting[activeId]),
    llmRetry: (activeId && state.llmRetryBySession[activeId]) || null,
    compacting: activeId ? state.compactingBySession[activeId] : undefined,
    cfg: state.cfg,
    authInfo: state.authInfo,
    desktopConfig: state.desktopConfig,
    modelsResp: state.modelsResp,
    newChatWs: state.newChatWs,
    newChatCfg: state.newChatCfg,
    newChatModel: state.newChatModel,
    sessionMode: state.sessionMode,
    setSessionMode: state.setSessionMode,
    pendingDraft: state.pendingDraft,
    setPendingDraft: state.setPendingDraft,
    pendingShare: state.pendingShare,
    takePendingShare: state.takePendingShare,
    pendingChatQuote: state.pendingChatQuote,
    clearPendingChatQuote: state.clearPendingChatQuote,
    draftRefs: state.draftRefs,
    appendRefs: state.appendRefs,
    clearDraftRefs: state.clearDraftRefs,
    steerPending: (activeId && state.steerPendingBySession[activeId]) || EMPTY_STEER,
    steerSent: (activeId && state.steerSentBySession[activeId]) || EMPTY_STRS,
    steerRestore: (activeId && state.steerRestoreBySession[activeId]) || null,
    jumpTarget: state.jumpTarget,
    clearJumpTarget: state.clearJumpTarget,
    withdrawSteer: state.withdrawSteer,
    steerNow: state.steerNow,
    clearSteerRestore: state.clearSteerRestore,
    engines: state.engines,
    engineCaps: state.engineCaps,
    agentDefs: state.agentDefs,
    agentAvatars: state.agentAvatars,
    defaultAgentSlug: state.defaultAgentSlug,
    skillsList: state.skillsList,
    connState: state.connState,
    connMessage: state.connMessage,
    filePreview: state.filePreview,
    openFeedback: state.openFeedback,
    toast: state.toast,
    editUserMessage: state.editUserMessage,
    regenerate: state.regenerate,
    branchFromMessage: state.branchFromMessage,
    rewindTo: state.rewindTo,
    decideApproval: state.decideApproval,
    answerInquiry: state.answerInquiry,
    setFilePreview: state.setFilePreview,
    setSessionEngine: state.setSessionEngine,
    setNewChatCfg: state.setNewChatCfg,
    selectSessionAgent: state.selectSessionAgent,
    selectNewChatAgent: state.selectNewChatAgent,
    workspaces: state.workspaces,
    setNewChatWs: state.setNewChatWs,
    addLocalWorkspace: state.addLocalWorkspace,
    cloneGitProject: state.cloneGitProject,
    addCloudProject: state.addCloudProject,
    setSessionModel: state.setSessionModel,
    setNewChatModel: state.setNewChatModel,
    setSessionEngineModel: state.setSessionEngineModel,
    setSessionThinking: state.setSessionThinking,
    setDefaultModel: state.setDefaultModel,
    setModelContextWindow: state.setModelContextWindow,
    setSessionMaxIterations: state.setSessionMaxIterations,
    setSessionPlanMode: state.setSessionPlanMode,
    voiceOnByAgent: state.voiceOnByAgent,
    setVoiceMode: state.setVoiceMode,
    setSessionGroup: state.setSessionGroup,
    newSession: state.newSession,
    openSettings: state.openSettings,
    setExecConfig: state.setExecConfig,
    send: state.send,
    stop: state.stop,
    compact: state.compact,
  })))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const jumpSetter = useRef<(show: boolean) => void>(() => {})
  const setShowJump = useCallback((show: boolean): void => jumpSetter.current(show), [])
  // 输入框上方的引用卡,可挂多段;只在挂它们的那个会话里显示、发送(归属见 quotes.ts 的 QuoteDraft)
  const [quoteDraft, setQuoteDraft] = useState(NO_QUOTE_DRAFT)
  const quoteSid = activeId ?? null
  const quotes = quotesFor(quoteDraft, quoteSid)
  const [refDrop, setRefDrop] = useState(false) // 工作区条目拖到聊天区上方(整块高亮)
  const childSession = useChildChat((state) => activeId ? state.sessions[activeId] : undefined)
  const activeSession = s.activeSession || childSession
  const activeModel = (s.modelsResp?.models || []).find((m) => m.id === (activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || '')) || null
  // 切模型后 SSE 重放会把 setSessionModel 清掉的旧 context_info 复活——事件带的 modelId 与当前
  // 会话模型不一致就视同没有(老引擎事件不带 modelId → 放行,保持兼容)
  const activeCtxInfo = s.activeCtxInfo && (!s.activeCtxInfo.modelId || !activeModel || s.activeCtxInfo.modelId === activeModel.id) ? s.activeCtxInfo : null
  const activeUsage = s.activeUsage
  const activeMessages = s.activeMessages
  // 画到流里的那一段(长会话先是末尾几条、空闲时往上补,见 useTailFirst;桌面与网页 10-16 起也这样,原来只有手机);
  // 数据层的判断一律仍看 activeMessages。要跳到某条消息(搜索命中)时整段挂。
  const shownMessages = useTailFirst(activeMessages, activeId || null, s.jumpTarget?.sessionId !== activeId)
  // 分支里最后一条做完的回答带「带回这里」:作为引用挂进来源那一支的输入框(由用户发,agent 不往别的支写)
  const bringBackTo = activeSession?.fork_message_id ? (activeSession.fork_session_id || activeSession.parent_session_id || null) : null
  const bringBackMsgId = bringBackTo && !params.childSurface ? [...activeMessages].reverse().find((m) => m.role === 'assistant' && m.status === 'done')?.id : undefined
  const bringBack = (text: string): void => {
    if (!bringBackTo) return
    const st = useApp.getState()
    const target = st.sessions.find((x) => x.id === bringBackTo) || st.archivedSessions.find((x) => x.id === bringBackTo)
    openSession(bringBackTo)
    quoteInMainChat(text)
    s.toast(t('chat.bringBack.done', { title: displaySessionTitle(target?.title, t) }))
  }
  const pendingApprovals = useMemo(() => pendingPromptsOf(activeMessages), [activeMessages])
  const running = s.running
  const execConfig = s.execConfig
  // Vault 切换会即时重算 Project 列表与系统工作根;不能只在 s.workspaces() 里 getState 快照,
  // 否则 appStore 本身没变化时 React 不会重渲染选择器。
  const amadeusRoot = usePageStore((state) => state.vaultRoot)
  // 会话在别的电脑上(桌面作为调用方):这台电脑的笔记库 / 文件夹都不属于它的工作范围,也不许把本机路径写进那台的会话配置
  const sessionElsewhere = useComposerRef(activeId).kind === 'unit'

  // 主区划线后交给侧栏的引用可能先于 chat-panel 挂载；目标承载一出现就消费，其他 ChatView 不碰。
  useEffect(() => {
    const pending = s.pendingChatQuote
    if (!pending || pending.targetType !== leaf.type) return
    setQuoteDraft((prev) => quoteAdded(prev, quoteSid, pending.text))
    s.clearPendingChatQuote(pending.seq)
  }, [leaf.type, quoteSid, s.pendingChatQuote, s.clearPendingChatQuote])

  // 在 Amadeus 里呼出的空白新对话:没显式选项目时落在笔记库 —— 药丸与 cwd 显示的必须是 send() 真会用的那个落点(同读 amadeusLandingRoot)。
  const landingRoot = inAmadeusSpace && amadeusRoot ? amadeusLandingRoot() : null
  const mvCfg: AgentConfig = withAmadeusWorkspace(activeId
    // 已有会话:配置未加载完(execMode 缺失)时按 project_path 兜底判 host/sandbox,避免加载窗口内
    // 拖文件误走 25MB 上传;配置一旦到达(含用户显式选的 sandbox)即以 execConfig 为准。
    ? (execConfig.execMode ? execConfig : {
        execMode: activeSession?.project_path ? 'host' : 'sandbox',
        approvalMode: 'auto-edit',
        cwd: activeSession?.project_path || undefined,
        ...execConfig,
      })
    // 空态:药丸显示的必须是这条消息**实际会用**的档位 —— 即 stickyDefaults(上次用的),
    // 否则会出现「显示自动编辑、发出去却是全自动」的错位。
    : (() => {
        // 模式先于工作区:chat 会话恒 sandbox + 无根(方案 §2.1 接缝 0),与 send() 的建会话规则同源(newSessionPreset)。
        const preset = newSessionPreset(s.sessionMode, s.newChatWs, currentPlatform())
        const cloud = preset === 'chat' || s.newChatWs?.kind === 'cloud' || s.newChatWs?.kind === 'rootless'
        // settleModes:与建会话同一口径结算 Ultra(草稿换了云端 / 引擎 / 团队,或 Agent 自带非 max 档,药丸就不显示 Ultra)与「团队模式下没有计划模式」
        return settleModes(applyPreset({
          execMode: cloud ? 'sandbox' : 'host',
          ...stickyDefaults(s.desktopConfig, !cloud, preset),
          ...s.newChatCfg,
          // 排在草稿之后:改审批档会把当时显示的 cwd 抄进草稿,之后换了项目 / 换了库它就是旧的;send() 建会话时同样以落点为准。
          cwd: cloud ? undefined : (s.newChatWs?.path || landingRoot || undefined),
        }, preset) as AgentConfig)
      })(), sessionElsewhere ? null : amadeusRoot) // 别的电脑上的会话 / 草稿:这台电脑的笔记库不并进它的工作范围
  // 团队成员会话(子聊天里直接追问):审批闸只听团队会话此刻的档(引擎 agentLoop.approvalModeSessionId),
  // 成员会话自己的存值不算数 → 药丸显示团队档、改也改团队会话(与团队主区药丸同一条写路径)。
  // 成员身份同引擎按父链接核实:父会话 id 由 ChildChatPanel 的 Team Desk 成员行给,须等于配置里的 teamMember ——
  // 分支会话会把 teamMember 原样抄走,引擎不认,这里也不认(否则在分支里改档会改到原团队)。
  // 团队配置没在本地(理论上不会:子聊天只挂在团队会话的 ChatView 下)就不接管 —— 整对象 PUT 会冲掉团队配置。
  const teamSid = typeof params.teamSessionId === 'string' && params.teamSessionId === mvCfg.teamMember?.teamSessionId ? params.teamSessionId : undefined
  const teamCfg = useApp((state) => (teamSid ? state.configBySession[teamSid] : undefined))
  const mvModelId = activeChatModelId({ ...s, activeId }) // 与建会话落库、startRun、ctx.tangu.activeModel() 同源,勿就地展开回退链
  const visibleModels = !s.modelsResp?.models
    ? null
    : selectableChatModels(s.modelsResp.models)
  const curEngineId = activeId ? execConfig.engineId : s.newChatCfg.engineId
  const streamingId = useMemo(() => activeMessages.find((m) => m.status === 'streaming')?.id ?? null, [activeMessages])
  // run 统计(耗时 · tokens · 思考)挂在本 run 最后一条画出来的助手气泡末尾;run 结束后冻结,直到下一个 run 覆盖。
  // 本 run 还没有可见气泡(团队成员都在干活、占位被隐藏)→ 运行中在列表末尾单独起一行。
  const runStats = s.runStats
  const runStatsMsgId = useMemo(() => {
    if (!runStats) return null
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i]
      if (m.role === 'assistant' && !isHiddenInList(m)) return inRunWindow(runStats, m.timestamp) ? m.id : null
    }
    return null
  }, [activeMessages, runStats])
  // 留痕:后台复盘在这段对话之后写下的东西,钉在触发它的那条回复后面(子会话面是别人的工作记录,不留)。
  const traces = useSessionTraces(activeId, useMemo(() => activeMessages.filter((m) => m.role === 'assistant' && !isHiddenInList(m)), [activeMessages]), !params.childSurface)
  // composer ↑↓ 历史召回:本会话已发送的用户消息(旧→新)+ steer 入队即记的补充池(被删/撤回的插话
  // 仍可从 ↑ 找回;已注入的会同时出现在消息里,按文本去重)。打断标记是机器行,不进历史。
  const sentHistory = useMemo(() => {
    const users = activeMessages.filter((m) => m.role === 'user' && !m.content.startsWith('<turn_interrupted>') && !m.content.startsWith(APPROVAL_UPDATE_OPEN) && !m.content.startsWith(CHILD_UPDATE_OPEN)).map((m) => m.content)
    const have = new Set(users)
    return [...users, ...s.steerSent.filter((x) => !have.has(x))]
  }, [activeMessages, s.steerSent])

  const chatAgentSlug = mvCfg.agentSlug || s.defaultAgentSlug
  const chatAgentAvatar = chatAgentSlug ? s.agentAvatars[chatAgentSlug] : undefined
  // 历史助手消息(recordToUi 不盖 agentName)的名字回退:引擎会话→引擎名,否则→会话 agent 名;
  // 否则 EditorialMessage 只能退到「Tangu」,改名后旧对话仍显示基础名。响应 agentDefs,故连上后自动纠正。
  const chatAgentName = curEngineId
    ? s.engines.find((e) => e.id === curEngineId)?.name
    : (chatAgentSlug ? s.agentDefs.find((a) => a.slug === chatAgentSlug)?.name : undefined)
  const userName = s.authInfo?.nickname || s.authInfo?.username || undefined
  const userAvatar = s.authInfo?.avatar || undefined
  // 语音消息:该会话 agent 是否开启(voice-message 插件设置驱动);渲染语音条还需配了朗读 TTS 模型。
  const voiceOn = chatAgentSlug ? !!s.voiceOnByAgent[chatAgentSlug] : false

  useEffect(() => { useApp.getState().ensureEngineCaps(curEngineId || undefined) }, [curEngineId])
  useEffect(() => { if (chatAgentSlug) void useApp.getState().refreshVoiceMode(chatAgentSlug) }, [chatAgentSlug])

  // DOM 登记在 workspace 层,右栏(目录)跟随最近聚焦的 Chat leaf。
  // 用 callback ref 而非一次性 effect:.t2-stream 会因 <ErrorBoundary key={activeId}> 在切会话时重挂,
  // 一次性登记会留下旧的(已脱离文档的)div → 右栏 ChatToc 扫到空 DOM。callback ref 每次挂载都重登记。
  const registerChatScroll = useCallback((el: HTMLDivElement | null) => {
    chatScrollRef.current = el
    useWorkspace.getState().registerChatSurface(leaf.id, el)
  }, [leaf.id])

  // 输入卡悬浮在正文之上(不占布局)→ 它的实高得回传给 CSS:正文底部留白、底部渐隐止点、
  // 「回到底」按钮三处都按 --t2-composer-h 让位。高度随芯片行/多行草稿/steer 队列实时变,
  // 只能量不能算;写在 .t2-chat-col 上(= 悬浮的定位祖先),整列共享。
  const composerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const col = el.parentElement
    const apply = (): void => col?.style.setProperty('--t2-composer-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (activeId) void useApp.getState().loadSessionHistory(activeId)
  }, [activeId])

  // 每个 leaf 维护自己的标题，避免分屏时误改第一块 Chat tab。会话清单尚未加载但 sessionId 已从
  // Mini handoff 到达时用稳定占位；不能再另挂一段「新对话」标题 effect 与本段来回改名(React #185)。
  useEffect(() => {
    leaf.setTitle(activeSession?.title ? displaySessionTitle(activeSession.title, t) : (activeId ? 'Tangu Agent' : t('sidebar.newChat')))
  }, [activeId, activeSession?.title, leaf, t])

  // 内容级搜索命中 → 打开会话后滚到那条消息并闪一下(P3)。消息还没到齐时不动手:
  // 历史是异步拉的,早滚一次会落在错的位置;拉完仍找不到 = 命中落在更早的分页里,如实提示而不是假装跳了。
  useEffect(() => {
    const jt = s.jumpTarget
    if (!jt || jt.sessionId !== activeId || historyLoading) return
    const el = document.getElementById(`tocmsg-${jt.messageId}`)
    if (!el) {
      if (activeMessages.length) { s.toast(t('search.jumpOutOfWindow'), true); s.clearJumpTarget() }
      return // 消息还没渲染出来:等下一次 activeMessages 变更再试
    }
    // 命中可能在长提问折叠起来的那截里(不知道落在哪一段):跳到用户消息先展开
    el.querySelector<HTMLButtonElement>('.t2-user-more[aria-expanded="false"]')?.click()
    const root = chatScrollRef.current
    if (root) {
      stickToBottom.current = false
      scrollToElement(root, el, 24) // 落地后再量再补:上面的消息带 content-visibility,进视口才量出真实高度
    }
    el.classList.add('t2-jump-flash')
    const timer = window.setTimeout(() => el.classList.remove('t2-jump-flash'), 1600)
    s.clearJumpTarget()
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.jumpTarget?.seq, activeId, historyLoading, activeMessages.length])

  const scrollToBottom = useCallback((smooth = false): void => {
    const el = chatScrollRef.current
    if (!el) return
    cancelScrollToElement(el) // 刚点过目录 / 搜索跳转:那边落地后的补正不许再把人拉回去
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stickToBottom.current = true
    setShowJump(false)
  }, [])

  // Follow actual content height, including complete team remarks and their presentation animation.
  // Only an upward user gesture releases the anchor; a layout-induced scroll event cannot release it.
  useLayoutEffect(() => {
    stickToBottom.current = !s.jumpTarget
    pendingCountRef.current = 0
  }, [activeId])
  useEffect(() => {
    const el = chatScrollRef.current
    const content = el?.querySelector('.t2-stream-inner')
    if (!el || !content) return
    let raf = 0
    let previousTop = el.scrollTop
    let previousMax = el.scrollHeight - el.clientHeight
    let pointerDown = false
    const update = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      const max = el.scrollHeight - el.clientHeight
      if (atBottom) stickToBottom.current = true
      // 往上挪了、可滚的最大距离却没变小(变小 = 布局把位置夹下来,不算):目录跳转这类程序滚动也松开。
      // 消息带 content-visibility,往上一滚,刚进视口的才量出真实高度 → 内容变高 → 不松开就被 follow 拽回底部(10-16 实测)
      else if (el.scrollTop < previousTop && (pointerDown || max >= previousMax)) stickToBottom.current = false
      previousTop = el.scrollTop
      previousMax = max
      setShowJump(!atBottom && !stickToBottom.current)
    }
    const release = (): void => { stickToBottom.current = false; setShowJump(true) }
    const onWheel = (e: WheelEvent): void => { if (e.deltaY < 0) release() }
    let touchY = 0
    const onTouchStart = (e: TouchEvent): void => { touchY = e.touches[0]?.clientY || 0 }
    const onTouchMove = (e: TouchEvent): void => { if ((e.touches[0]?.clientY || 0) > touchY) release() }
    const down = (): void => { pointerDown = true }
    const up = (): void => { pointerDown = false }
    const onKey = (e: KeyboardEvent): void => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) release() }
    const follow = (): void => {
      if (stickToBottom.current) { el.scrollTop = el.scrollHeight; previousTop = el.scrollTop; setShowJump(false) }
    }
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(follow) })
    ro.observe(content)
    ro.observe(el)
    follow()
    el.addEventListener('scroll', update, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('pointerdown', down)
    el.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', up)
    return () => {
      ro.disconnect(); cancelAnimationFrame(raf)
      el.removeEventListener('scroll', update); el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart); el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('pointerdown', down); el.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', up)
    }
  }, [activeId])

  const compactingOn = s.compacting !== undefined
  useLayoutEffect(() => {
    if (stickToBottom.current && !s.jumpTarget) scrollToBottom()
  }, [activeMessages, historyLoading, scrollToBottom, compactingOn])

  // 新计划待拍板时强制定位到底部:拍板区在输入框上方的托盘里,但计划正文在流里,得让人看得到。
  // 审批与普通提问不算:它们整张在托盘里恒可见,再把人拽到底部正是「打断阅读」的一半。
  useEffect(() => {
    let pending = 0
    for (const m of activeMessages) {
      pending += m.planProposal ? m.inquiries?.filter((q) => q.status === 'pending' && q.kind === 'plan').length || 0 : 0
    }
    if (pending > pendingCountRef.current) scrollToBottom(true)
    pendingCountRef.current = pending
  }, [activeMessages, scrollToBottom])

  const copy = (text: string): void => { try { void navigator.clipboard.writeText(text) } catch { /* ignore */ } }
  // 朗读:配置了 TTS 模型才显示入口;点击播放/合成中的消息 = 停止。
  const [tts, setTts] = useState<TtsState>(ttsState())
  useEffect(() => subscribeTts(setTts), [])
  const ttsEnabled = !!s.desktopConfig?.ttsModelId?.trim()
  const speak = (id: string, text: string): void => {
    if (tts?.msgId === id) { stopSpeaking(); return }
    speakMessage(homeTarget(), s.desktopConfig, id, text).catch((e: any) => {
      s.toast(e?.message === 'EMPTY' ? t('tts.noText') : t('tts.failed', { e: e?.message || e }), true)
    })
  }
  const startEdit = (id: string, content: string): void => { setEditingId(id); setEditText(content) }
  const saveEdit = (): void => { if (editingId && editText.trim()) { s.editUserMessage(editingId, editText.trim(), activeId) } setEditingId(null) }

  // 传给每条消息的对象要稳住,EditorialMessage 的 memo 才挡得住「流式每来一段字,整段对话的消息都重渲一遍」。
  // handlers 按「会话 + 哪几个按钮在」整组缓存、组里按消息 id 各一份;函数体经 handlerEnv 取当下的值(提交后才会被点到),不会拿到旧闭包。
  const handlerEnv = useRef({ s, activeId, activeMessages, copy, speak, startEdit, activeSession, mvModelId })
  useLayoutEffect(() => { handlerEnv.current = { s, activeId, activeMessages, copy, speak, startEdit, activeSession, mvModelId } })
  const readOnly = !!params.readOnly
  const childSurface = !!params.childSurface
  const canInsertNote = amadeusAvailable()
  const handlerCache = useMemo(() => new Map<string, MessageHandlers>(), [activeId, readOnly, childSurface, canInsertNote, ttsEnabled])
  const handlersFor = (id: string): MessageHandlers => {
    const hit = handlerCache.get(id)
    if (hit) return hit
    const env = (): typeof handlerEnv.current => handlerEnv.current
    const h: MessageHandlers = {
      onCopy: (text) => env().copy(text),
      onRegenerate: readOnly ? undefined : () => env().s.regenerate(id, env().activeId),
      onBranch: childSurface ? undefined : () => void env().s.branchFromMessage(id, env().activeId),
      // 顺便问(挂在这条回答上):开在右边那块面板,不进对话
      onAside: childSurface ? undefined : () => { const e = env(); if (e.activeId) openBtw({ sessionId: e.activeId, title: e.activeSession?.title, modelId: e.mvModelId || undefined, messageId: id }) },
      onEdit: readOnly ? undefined : () => env().startEdit(id, env().activeMessages.find((m) => m.id === id)?.content ?? ''),
      onRewind: readOnly ? undefined : (mode) => void env().s.rewindTo(id, mode, env().activeId),
      // 建议芯片 = 用户自己把这句话打进去按了回车(运行中则落进 steer 等待区)。
      onSuggest: readOnly ? undefined : (text) => void env().s.send(text, [], undefined, undefined, undefined, env().activeId),
      onTask: (card, landing) => runTaskCard(card, landing, env().activeId),
      // 回答插回笔记(G3-08):由「问 Tangu」发起的对话优先插回出处那篇;宿主没有 Amadeus 编辑能力就不出按钮。
      onInsertNote: canInsertNote ? (text) => void insertReplyToNote(text, askOriginOf(env().activeMessages, id)) : undefined,
      // 插件结果卡片的 call.quote:同划线「引用」,挂进这块输入框
      onQuote: (text) => { const sid = env().activeId ?? null; setQuoteDraft((prev) => quoteAdded(prev, sid, text)) },
      ...(ttsEnabled ? { onSpeak: (text: string) => env().speak(id, text) } : {}),
    }
    handlerCache.set(id, h)
    return h
  }
  const fileCtx = useMemo(() => ({ cfg: s.cfg, sessionId: activeId || '', execMode: mvCfg.execMode, onOpenPreview: s.setFilePreview }), [s.cfg, activeId, mvCfg.execMode, s.setFilePreview])
  const voice = useMemo(() => (ttsEnabled ? { on: voiceOn, cfg: s.cfg, stored: s.desktopConfig } : undefined), [ttsEnabled, voiceOn, s.cfg, s.desktopConfig])

  const hasMessages = activeMessages.length > 0
  // 输入卡上方那一栏的两半(JSX 在 .composer-anchor 里):项目那半只在空白新对话上;开场那半还包括已建好但没发过消息的会话。
  const projectBarOn = !activeId && (!studioChat || !!studioRoot) && (mvCfg.preset !== 'chat' || (runPickerOn && !studioChat))
  const openingOn = !hasMessages && !historyLoading && !params.miniSurface && !params.childSurface && !mvCfg.teamSlug && !mvCfg.groupChat && !mvCfg.teamMember && !mvCfg.soloEngineId && !mvCfg.engineId && s.connState === 'ok'
  /** 流里有画出来的消息(系统消息、列表里隐藏的不算):决定底对齐的排法,也决定手机上整列跟不跟键盘走。 */
  const anyShown = hasMessages && shownMessages.some((m) => m.role !== 'system' && !isHiddenInList(m))
  // Agent Desk 只在会话开始后显示:草稿与已建 ID 但未发消息的新会话都不挂载,也不占右侧车道。
  // 例外(10-13):Muse 私聊一进来就挂 —— 它的 Desk 空闲时演 Muse Space(见 useDeskHome),不必等第一条消息。
  // 桌面端默认开(移动端没有);用户可在设置→高级关掉,窄容器由 CSS 容器查询兜底隐藏。
  const deskHome = useDeskHome(activeId)
  const deskEnabled = !!activeId && (hasMessages || !!deskHome) && !params.childSurface && !studioChat && UI_MODE !== 'mobile' && !!s.desktopConfig?.agentDeskEnabled
  // Desk 收不收文件(与 store 写入口、引用条同一判据):always 伴随面生效时 Desk 只演伴随面,点开文件一律走新标签页。
  const deskTakesFiles = useDeskAcceptsFiles(deskEnabled)
  const deskQuote = useCallback((text: string) => setQuoteDraft((prev) => quoteAdded(prev, quoteSid, text)), [quoteSid])
  // 插件结果卡片的 Desk 落点只在 Desk 真看得见时成立(判定在 toolCardDeskFor;这里量聊天视图宽度,对齐 CSS 容器查询)
  const chatViewRef = useRef<HTMLDivElement>(null)
  const [chatViewW, setChatViewW] = useState(Infinity)
  useEffect(() => {
    const el = chatViewRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setChatViewW(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const deskOpenNow = useApp((state) => (activeId ? state.deskBySession[activeId]?.mode === 'open' : false))
  // 团队成员列表嵌入 Pin Summary 的运行状态,Agent Desk 保持独立。
  const teamDesk = !params.childSurface && !studioChat && UI_MODE !== 'mobile' && !!mvCfg.groupChat && (mvCfg.groupAgents?.length || 0) >= 2
  // 画布(方案「Chat 画布分支」第二步):同一棵会话树的另一种看法。偏好按树根记 —— 在画布里点到别的支,不会翻回对话。
  // 不给画布的地方:团队 / 群聊、私聊 Agent / 引擎、子会话面板、小窗、钉住会话的分屏、Coding 工作台、手机(没有这条标签栏)。
  const treeRoot = activeSession?.fork_message_id ? (activeSession.parent_session_id || activeId) : activeId
  const canvasAllowed = !!activeId && followActive && leaf.loc === 'main' && !inSingleColumnShell() && !params.childSurface && !params.miniSurface && !params.readOnly && !studioChat
    && !mvCfg.groupChat && !mvCfg.teamSlug && !mvCfg.teamMember && !mvCfg.soloAgentSlug && !mvCfg.soloEngineId && !mvCfg.engineId
  const [canvasPref, setCanvasPref] = useChatCanvasPref(treeRoot)
  const canvasOn = canvasAllowed && canvasPref.on
  const toolCardDesk = toolCardDeskFor({ sessionId: activeId, takesFiles: deskTakesFiles, canvas: canvasOn, width: chatViewW, childOpen: !!(activeId && childSelections[activeId]), deskOpen: deskOpenNow })
  // 「对话 / 画布」= 视图模式(lcl viewModes):胶囊在这一列的头行左端,⌥⌘V 切换;记忆照旧按树根
  useViewModes(leaf.id, canvasAllowed ? {
    modes: [
      { value: 'chat', label: t('chatcanvas.seg.chat'), icon: MessageSquare },
      { value: 'canvas', label: t('chatcanvas.seg.canvas'), icon: Waypoints },
    ],
    value: canvasOn ? 'canvas' : 'chat',
    onChange: (v) => setCanvasPref({ on: v === 'canvas' }),
    ariaLabel: t('chatcanvas.seg.aria'),
  } : null)
  // 画布里双击一张卡:切回对话、滚到那个会话里的那一轮(搜索跳转那条路,历史没到齐会等)
  const openTurn = useCallback((sid: string, mid: string): void => {
    setCanvasPref({ on: false })
    if (sid !== useApp.getState().activeId) useApp.getState().setActiveId(sid)
    useApp.getState().setJumpTarget(sid, mid)
  }, [setCanvasPref])

  // 工作区(会话/笔记/文件)拖进来即引用:**整个聊天区**都是落区,不用瞄准输入框。
  // 只吃 chatDragRef 的两个 MIME —— OS 文件仍归输入框卡片那套(附件/路径插入),两条路不打架。
  const onRefDragOver = (e: React.DragEvent): void => {
    if (!hasChatRef(e.dataTransfer)) return
    e.preventDefault() // 不 preventDefault 就不会有 drop 事件
    e.dataTransfer.dropEffect = 'copy'
    if (!refDrop) setRefDrop(true)
  }
  // 拖拽在别处结束(松在窗口外、内层吞了 drop、切走窗口)时 dragleave 不一定来,窗口级收尾。
  useEffect(() => {
    if (!refDrop) return
    const clear = (): void => setRefDrop(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [refDrop])
  const onRefDrop = (e: React.DragEvent): void => {
    setRefDrop(false)
    if (!hasChatRef(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    // 结构化交给 Composer(它转成「已选择」芯片)——不再拼成文本再解析回来。
    const refs = readChatRefs(e.dataTransfer)
    if (refs.length) s.appendRefs(refs)
  }

  return (
    <ToolCardDeskContext.Provider value={toolCardDesk}>
    <div
      ref={chatViewRef}
      className={`t2-chat-view${refDrop ? ' refdrop' : ''}`}
      data-chat-surface={leaf.type}
      data-canvas={canvasOn ? '' : undefined}
      data-session-id={activeId || undefined}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', minWidth: 0 }}
      onDragOver={onRefDragOver}
      // 只有真的离开整块才撤高亮(子元素间移动会连发 leave/enter)
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setRefDrop(false) }}
      onDrop={onRefDrop}
    >
      {raiseTeam && mvCfg.soloAgentSlug && activeId && <TeamEditor
        agents={s.agentDefs.filter((a) => a.createdBy !== 'system' && !!a.libraryDir)} team={null} initialMembers={[mvCfg.soloAgentSlug]}
        onClose={() => setRaiseTeam(false)} onSaved={(saved) => {
          setRaiseTeam(false)
          const parentId = activeId
          void useApp.getState().ensureTeamSession(saved.slug).then((session) => {
            if (!session) return
            useApp.getState().setSeedOnce(session.id, parentId)
            openSession(session.id, { newTab: true })
          })
        }} />}
      {/* data-kb-*: on a phone the column travels with the keyboard (mobile/src/keyboardRise.ts) — the whole of it while
          a conversation is on screen and at its end (it is laid out from the bottom up there, so it lands where layout
          puts it afterwards), the input alone otherwise: an empty chat's mark is centred, not bottom-anchored.
          Markers only; nothing reads them elsewhere. */}
      <div className="t2-chat-col" data-kb-rise={anyShown ? 'end' : undefined}>
      {/* 头行只盖这一列(右栏卡片不动、不放会话标题);画布模式下它浮在舞台上面 */}
      <ViewHead leafId={leaf.id} testId="chat-canvas-seg" />
      <ErrorBoundary key={activeId || 'none'}>
        <div className="t2-chat-body">
          {hasMessages && <FloatingToc scrollContainerRef={chatScrollRef} scanTrigger={shownMessages.length} />}
          <div className="t2-stream" data-kb-end ref={registerChatScroll}>
            {/* data-has-messages:样式靠它认「流里画着消息气泡」(短会话贴着输入区排,见 chat2.css)。只有总结卡 / 系统行、其余都不进列表的
                会话不算 —— 对齐原来的 `:has(> .t2-asst, > .t2-userwrap)`。
                别改回 `:has(…)` 再接 `> :first-child`:那种写法让页面上**任何地方**插入 / 移除一个元素都把整段对话的样式重算一遍。 */}
            <div className="t2-stream-inner" data-has-messages={anyShown ? '' : undefined}>
            {hasMessages && <ChildFromLine session={activeSession} />}
            {!hasMessages ? (
              // 空状态本身不在流里(见下面 .t2-chat-col 直属的那份):流只占输入框以上,
              // 在里面居中 = 视觉上偏高。骨架屏留在流里 —— 它替代的是消息,本就该从顶部排。
              historyLoading ? <Skeleton variant="chat" /> : null
            ) : (
              shownMessages.map((m) => {
                if (isHiddenInList(m)) return null
                if (m.role === 'user' && m.id === editingId) {
                  return (
                    <div key={m.id} className="t2-userwrap">
                      <div className="t2-edit">
                        <textarea className="t2-edit-ta" value={editText} autoFocus
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(); if (e.key === 'Escape') setEditingId(null) }} />
                        <div className="t2-btnrow">
                          <button className="t2-btn primary" onClick={saveEdit}>{t('chat.edit.saveResend')}</button>
                          <button className="t2-btn ghost" onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <EditorialMessage
                    key={m.id}
                    msg={m}
                    showWaitDetails={showWaitDetails}
                    rootRef={m.id === streamingId ? streamingNodeRef : undefined}
                    footer={(m.id === runStatsMsgId && runStats) || traces.has(m.id) ? <>
                      {m.id === runStatsMsgId && runStats && <RunStatsLine stats={runStats} />}
                      {traces.has(m.id) && <SessionTraceLines traces={traces.get(m.id)!} sessionId={activeId || ''} />}
                    </> : undefined}
                    avatarUrl={m.role !== 'assistant' ? undefined : (() => {
                      // 群聊发言人:优先 agentId,缺失时按名反查 slug(agentDefs 晚到时自动纠正);仍无则不回退会话默认头像。
                      const aid = m.agentId || (m.agentName ? s.agentDefs.find((a) => a.name === m.agentName)?.slug : undefined)
                      if (aid) return s.agentAvatars[aid]
                      if (m.agentName) return undefined
                      return curEngineId ? undefined : chatAgentAvatar
                    })()}
                    agentNameFallback={chatAgentName}
                    onBringBack={m.id === bringBackMsgId ? bringBack : undefined}
                    userName={userName}
                    userAvatar={userAvatar}
                    fileCtx={fileCtx}
                    modelId={mvModelId}
                    speakState={tts?.msgId === m.id ? tts.phase : undefined}
                    voice={voice}
                    handlers={handlersFor(m.id)}
                  />
                )
              })
            )}
            {running && runStats && !runStatsMsgId && runStats.finishedAt == null && <div className="t2-runstats-solo"><RunStatsLine stats={runStats} /></div>}
            {activeMessages.filter((m) => m.teamSummary).slice(-1).map((m) => <TeamSummary key={m.id} message={m} />)}
            {running && activeId && s.isGroupVoting && <div className="t2-sys"><span className="t2-dot" /> {t('group.voting.inProgress')}</div>}
            {running && activeId && s.llmRetry && (
              <div className="t2-sys t2-retry" title={s.llmRetry.error}>
                ⟳ {t('chat.llmRetrying', { s: (s.llmRetry.waitMs / 1000).toFixed(1), n: s.llmRetry.attempt, max: s.llmRetry.max || '?' })}
                {s.llmRetry.error ? <span className="t2-retry-err">{s.llmRetry.error}</span> : null}
              </div>
            )}
            {s.compacting !== undefined && (
              <div className="t2-compact" role="status" aria-live="polite">
                <div className="t2-compact-head">
                  <span>{t('input.compacting')}</span>
                  <span className="t2-compact-pct">{s.compacting}%</span>
                </div>
                <div className="t2-compact-track"><div className="t2-compact-fill" style={{ width: `${s.compacting}%` }} /></div>
              </div>
            )}
            </div>
          </div>
          <JumpToBottom setter={jumpSetter} title={t('chat.jumpToBottom')} onClick={() => scrollToBottom(true)} />
          {/* 划线条(全应用同一条,components/selectionBar):这里接管「带去对话」那一格 —— 引用 / 顺便问(10-18 起「在侧栏提问」并进顺便问,开在右边那块面板),
              行为与原来的胶囊菜单一字不差;翻译和插件动作(⋯)由共用的那一层给。条自己 portal 到 body。 */}
          <ViewSelectionBar
            view="chat"
            watch={chatScrollRef}
            watchKey={`${activeId}:${activeMessages.length}`}
            dense={leaf.type === 'chat-panel'}
            source={() => ({ title: activeSession?.title || undefined, sessionId: activeId || undefined })}
            lead={(sel, done) => [
              { id: 'quote', label: t('chat.action.quote'), icon: <Quote size={14} />, lead: true, testId: 'selection-quote', onRun: () => { setQuoteDraft((prev) => quoteAdded(prev, quoteSid, sel.text)); done() } },
              // 划线顺便问:选中的那段作为引用,挂在它所在的那条回答上,主对话里什么都不发
              ...(activeId ? [{ id: 'btw', label: t('btw.selectionAction'), icon: <MessageCircleQuestion size={14} />, testId: 'selection-btw', onRun: () => { openBtw({ sessionId: activeId, title: activeSession?.title, quote: sel.text, modelId: mvModelId || undefined, messageId: selectedMessageId() }); done() } }] : []),
            ]}
          />
        </div>
      </ErrorBoundary>
      {/* 画布盖在对话流上(流照旧挂着、只是藏起来:切回来滚动位置还在);按树根挂,点到别的支时舞台不重挂 */}
      {canvasOn && activeId && treeRoot && (
        <ChatCanvas key={treeRoot} rootId={treeRoot} activeId={activeId} dir={canvasPref.dir} onDir={(dir) => setCanvasPref({ dir })} onOpenTurn={openTurn} />
      )}

      {/* 空状态优先保持 view 居中;空间不足时按 composer 实高向上避让,小高度逐级精简。 */}
      {!hasMessages && !historyLoading && !canvasOn && <EmptyState2 compact={!!params.miniSurface} title={params.miniSurface ? t('mini.chatHint') : studioChat ? t('studio.chatTitle') : undefined} subtitle={studioChat ? t(studioRoot ? 'studio.chatHint' : 'studio.chooseProject') : undefined} />}

      {/* 输入区整簇(新对话的两条选择器 + 输入卡)一起悬浮:它们**都在 .composer-anchor 里**,
          正文才能真正铺满整列。留在外面就会各占一段布局,反倒被悬浮的卡盖住。
          新加与输入卡同簇的东西请一并放进来 —— 高度由 anchor 统一量成 --t2-composer-h。 */}
      <div className="composer-anchor" data-kb-rise ref={composerRef}>
        {/* Chat 固定使用创建时的当前默认 Agent，不露选择器；Work 的云会话仍可选 Agent，外部引擎仍 host-only。
            轨道方案 §4:门控去掉 `!groupChat`(06-25 那道「群聊态无单一主 agent」门的理由随选择条消失 ——
            **这条就是群聊/团队模式的配置器**),换成轨道身份钉死的三把锁(私聊 / 私聊引擎 / 独立团队)。 */}
        {!params.miniSurface && !params.childSurface && !hasMessages && mvCfg.preset !== 'chat' && !mvCfg.soloAgentSlug && !mvCfg.soloEngineId && !mvCfg.teamSlug && (
          <div className="newchat-pickers">
            <AgentSelectStrip sessionId={activeId} cfg={mvCfg} />
          </div>
        )}
  
        {/* 输入卡上方那一栏:左边是「在哪运行 / 项目 / 额外文件夹」几枚胶囊,右边是开场那一行;两半各有各的出现条件,栏本身只要有一半在就在。
            开场不再单占一行排在这一栏下面 —— 那样它夹在项目胶囊和输入卡之间(用户 10-13 报丑);一行放不下时整栏朝上折,胶囊始终贴着输入卡。
            ⚠️ 两半在同一个父节点下的固定位置:项目那半随建会话消失时,开场那一行不重挂(重挂 = 当成「看过了」)。 */}
        {(projectBarOn || openingOn) && (
          <div className="newchat-projectbar">
            <div className="newchat-projectbar-inner">
              {/* Chat 无项目:不露项目选择器，否则会悄悄建成 Work 会话。Coding Studio 另要求先选定项目。
                  P1-K7a:手机上另有「在哪运行」药丸(Chat 模式也要有 —— 聊天会话同样可以建在电脑上),排在项目药丸之前。 */}
              {projectBarOn && <>
                {/* 药丸自己判要不要画:手机 = 有得选才画;桌面主窗口恒画(至少标出「这台电脑」) */}
                {!studioChat && <RunLocationPicker />}
                {mvCfg.preset !== 'chat' && (studioChat && studioRoot ? <div className="project-pill" title={studioRoot} data-studio-project={studioRoot}><Folder size={13} /><span className="project-pill-name">{projectName(studioRoot)}</span></div> : <ProjectSelector
                  workspaces={remoteWs ?? s.workspaces()}
                  value={s.newChatWs?.key ?? landingRoot ?? null}
                  onChange={(w) => s.setNewChatWs(w)}
                  // 「添加本地项目 / 云端项目」加的都是这一端的:运行位置在别的电脑上时不给
                  onAddProject={!remoteWs && window.tangu?.pickDirectory ? () => void s.addLocalWorkspace() : undefined}
                  onCloneProject={!remoteWs && window.tangu?.pickDirectory ? () => void s.cloneGitProject() : undefined}
                  onAddCloudProject={remoteWs ? undefined : (name) => void s.addCloudProject(name)}
                />)}
                {/* Coding Studio 的新对话也要露:草稿里的额外文件夹照样会随它建的会话带走,看不见胶囊 = 没人看见的授权(Codex 评审) */}
                <ExtraFolders />
              </>}
              {/* 开场:新对话(还没有消息)时说一句上次之后后台替这个 Agent 写下了什么。团队 / 群聊 / 成员会话 / 外部引擎 / 小窗不出(那里没有「这一个 Agent」)。 */}
              {openingOn && <SessionOpening slug={chatAgentSlug} />}
            </div>
          </div>
        )}

        <AnimatePresence>
          {s.filePreview && (
            <WorkspaceFilePreview key={s.filePreview.name} target={s.filePreview} onClose={() => s.setFilePreview(null)} />
          )}
        </AnimatePresence>
        <Composer2
          sessionId={activeId}
          approvalTray={pendingApprovals.length ? (
            <ApprovalTray
              // 每个会话一份托盘状态(收起 / 展开项 / 已送出锁),别从上一个会话带过来
              key={activeId ?? ''}
              sessionId={activeId ?? undefined}
              items={pendingApprovals}
              onDecide={(mid, aid, action, args) => s.decideApproval(mid, aid, action, args, activeId)}
              onAnswer={(mid, iid, ans) => s.answerInquiry(mid, iid, ans, activeId)}
            />
          // Muse 私聊:它后台排队的审批也在这里批(10-18 方案 B;没有待批时托盘不画)
          ) : mvCfg.soloAgentSlug === 'muse' && !params.childSurface ? <MuseApprovalTray key={activeId ?? ''} /> : undefined}
          advisory={!params.childSurface ? (
            // P1-K6:焦点在「我的电脑」且连不上时,顶上这一段换成连接态提示(同一段语汇,两条不叠放)。
            // ⚠️ 本文件的状态条 / disabled 归 K7(INTEGRATION §2.2,合入顺序 K6-S4 → K7):K7 的 RemoteSessionStrip(§3.8)落地时
            //    接管这一格 —— 要么收编 TargetHealthNotice(读同一张 useTargetHealth、同一个 retryFocusTarget),要么换成自己的条并把
            //    这里还原成裸 QuotaAdvisoryBanner;下面 disabledPlaceholder 的 targetPlaceholder 随 K7 的 remoteBlocked 一起并过去。
            <TargetHealthNotice sessionId={activeId} fallback={
              <QuotaAdvisoryBanner
                loggedIn={!!s.authInfo?.loggedIn && s.authInfo.tokenValid !== false}
                onToast={s.toast}
              />
            } />
          ) : undefined}
          // 实时语音:只有跟随侧栏的主区聊天接得住(固定会话的分屏/隐藏标签不许抢交接);发往的就是本视图的会话
          liveOwner={followActive && leaf.loc === 'main'}
          liveSessionKey={activeId}
          disabled={!!params.readOnly || !composerTargetReady || (studioChat && !studioRoot)}
          disabledPlaceholder={studioChat && !studioRoot ? t('studio.chooseProject') : targetPlaceholder}
          running={running}
          execConfig={teamCfg ? { ...mvCfg, approvalMode: teamCfg.approvalMode || mvCfg.approvalMode } : mvCfg}
          teamApproval={!!teamCfg}
          models={visibleModels}
          modelsResponse={s.modelsResp}
          modelId={mvModelId}
          onModelChange={(id) => s.setSessionModel(id, activeId, !params.childSurface)}
          engines={s.engines}
          engineId={mvCfg.engineId}
          engineModels={mvCfg.engineId ? (s.engineCaps[mvCfg.engineId]?.models ?? []) : undefined}
          engineModelId={mvCfg.engineModelId}
          onEngineModelChange={activeId ? (id) => s.setSessionEngineModel(id, activeId) : (id) => s.setNewChatCfg((c) => ({ ...c, engineModelId: id || undefined }))}
          engineCommands={mvCfg.engineId ? (s.engineCaps[mvCfg.engineId]?.commands ?? []) : undefined}
          thinkingLevel={mvCfg.thinkingLevel}
          ultra={mvCfg.ultra}
          onThinkingChange={(lv, ultra) => s.setSessionThinking(lv, activeId, !params.childSurface, ultra)}
          defaultModelIds={{
            backgroundModelId: s.desktopConfig?.backgroundModelId || '',
            imageModelId: s.cfg.imageModelId || '',
            visionModelId: s.cfg.visionModelId || '',
          }}
          onDefaultModelChange={s.setDefaultModel}
          // 写的是引擎 config.json 的 modelOverrides;露不露由引擎的 modelOverridesWritable 决定(ModelPill 里判)
          onContextWindowChange={(id, n) => void s.setModelContextWindow(id, n)}
          maxIterations={mvCfg.maxIterations}
          onMaxIterationsChange={activeId ? (n) => s.setSessionMaxIterations(n, activeId) : (n) => s.setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
          verifyCommand={mvCfg.verifyCommand}
          onVerifyCommandChange={activeId
            ? (cmd) => s.setExecConfig({ verifyCommand: cmd || undefined }, activeId)
            : (cmd) => s.setNewChatCfg((c) => ({ ...c, verifyCommand: cmd || undefined }))}
          planMode={mvCfg.planMode}
          // 成员会话不给计划模式:团队模式下没有它(成员的配置每次激活按团队重写,这里开了也不作数)。
          onPlanModeChange={teamCfg ? undefined : activeId ? (v) => s.setSessionPlanMode(v, activeId) : (v) => s.setNewChatCfg((c) => ({ ...c, planMode: v }))}
          preset={mvCfg.preset}
          onPresetChange={activeId ? undefined : (p) => s.setSessionMode(p)}
          voiceMode={voiceOn}
          onVoiceModeChange={chatAgentSlug ? (on) => void s.setVoiceMode(chatAgentSlug, on) : undefined}
          groupChat={mvCfg.groupChat}
          groupAgents={mvCfg.groupAgents}
          groupTempAgents={mvCfg.groupTempAgents}
          // Solo agents create a separate team from the add menu; project and team sessions edit their roster in place.
          onGroupChange={params.childSurface || mvCfg.soloAgentSlug || mvCfg.soloEngineId ? undefined : activeId ? (patch) => s.setSessionGroup(patch, activeId) : (patch) => s.setNewChatCfg((c) => ({ ...c, ...patch }))}
          onAddAgent={mvCfg.soloAgentSlug ? () => setRaiseTeam(true) : undefined}
          // 成员会话不给「普通模式」:它连带写的 auto-edit 落在成员会话上,对审批无效。
          onNormalWork={teamCfg ? undefined : () => {
            const patch: Partial<AgentConfig> = { planMode: false, groupChat: false, approvalMode: 'auto-edit' }
            if (mvCfg.teamSlug && !mvCfg.agentSlug) patch.agentSlug = mvCfg.groupAgents?.[0] || s.defaultAgentSlug
            if (activeId) s.setExecConfig(patch, activeId)
            else { s.setSessionMode('work'); s.setNewChatCfg((cfg) => ({ ...cfg, ...patch })) }
          }}
          skills={s.skillsList}
          agents={s.agentDefs}
          // 拍板 ⑪:对话中可切 Agent,入口先放模式切换菜单;群聊态 / 私聊(钉死)/ 引擎会话不给。
          onAgentSwitch={!params.childSurface && activeId && hasMessages && !mvCfg.groupChat && !mvCfg.soloAgentSlug && !mvCfg.soloEngineId && !mvCfg.teamSlug && !mvCfg.engineId ? (slug) => s.selectSessionAgent(slug, activeId) : undefined}
          currentAgentSlug={mvCfg.agentSlug || s.defaultAgentSlug}
          // 私聊(Agent 轨道):@ 候选换成本机项目 → 派遣(方案 §5.4);只有带路径的本地工作区(派遣工具 host-only)。
          mentionProjects={mvCfg.soloAgentSlug ? s.workspaces().filter((w) => w.kind === 'local' && !!w.path).map((w) => ({ name: w.name, path: w.path! })) : undefined}
          onNewSession={params.childSurface ? undefined : () => {
            if (mvCfg.soloAgentSlug) { if (!running) void rotateSolo('agent', mvCfg.soloAgentSlug) }
            else if (mvCfg.soloEngineId) { if (!running) void rotateSolo('engine', mvCfg.soloEngineId) }
            else void s.newSession()
          }}
          onBranch={!params.childSurface && activeId ? () => void s.branchFromMessage(undefined, activeId) : undefined}
          onOpenSettings={() => s.openSettings('skills')}
          // 成员会话只转 approvalMode:Composer2 顺手带的 cwd / execMode 是成员的,整对象 PUT 进团队会话会盖掉团队的。
          onExecConfigChange={teamSid && teamCfg
            ? (patch) => { if (patch.approvalMode) s.setExecConfig({ approvalMode: patch.approvalMode }, teamSid) }
            : (patch) => s.setExecConfig(patch, activeId)}
          onSend={async (text, attachments, workspaceFiles, skillIds, mentions) => {
            if (studioChat) {
              const target = useCodeStudio.getState().prepareRun()
              if (!target) return false
              return useApp.getState().send(text, attachments, workspaceFiles, skillIds, mentions, target.sessionId)
            }
            return s.send(text, attachments, workspaceFiles, skillIds, mentions, activeId)
          }}
          onStop={() => s.stop(activeId)}
          quotes={quotes}
          onRemoveQuote={(index) => setQuoteDraft((prev) => ({ sid: quoteSid, list: quotesFor(prev, quoteSid).filter((_, i) => i !== index) }))}
          onClearQuote={() => setQuoteDraft({ sid: quoteSid, list: [] })}
          // /btw [问题]:带本会话上下文旁聊(会话级浮窗);输入框挂着的引用一并带过去
          onBtw={activeId ? (question, quote) => openBtw({ sessionId: activeId, title: activeSession?.title, question, quote, modelId: mvModelId || undefined }) : undefined}
          // 引擎 context_info 报的窗口是真实预算口径(覆盖表/族兜底),优先于模型列表值——两边可能不一致
          contextWindow={activeCtxInfo?.ctxWindow || activeModel?.contextWindow || 0}
          ctxInfo={activeCtxInfo}
          ctxTokens={activeUsage.ctx}
          sessionTokens={activeUsage.base + activeUsage.live}
          runCost={activeUsage.runCost}
          costLimit={activeUsage.costLimit}
          onCompact={(focus) => void s.compact(activeId, focus)}
          seedText={s.steerRestore ?? (params.childSurface ? null : s.pendingDraft)}
          seedShare={params.childSurface || leaf.type === 'chat-panel' ? null : s.pendingShare}
          takeSeedShare={s.takePendingShare}
          appendRefs={params.childSurface ? null : s.draftRefs}
          onAppendRefsConsumed={s.clearDraftRefs}
          // 侧栏聊天默认引用主区当前笔记；Space 的主区分栏可显式 opt-in，
          // 让同屏 ChatView 也跟随旁边的 Amadeus 文档。
          autoRefFromMain={!params.childSurface && (leaf.loc !== 'main' || params.autoRefFromMain === true)}
          appRef={!params.childSurface ? appRefOf(params.appRef) : null}
          onSeedConsumed={() => { if (s.steerRestore && activeId) s.clearSteerRestore(activeId); else if (!params.childSurface) s.setPendingDraft(null) }}
          sentHistory={sentHistory}
          pendingSteer={s.steerPending}
          onCancelSteer={activeId ? (id) => { void s.withdrawSteer(activeId, id) } : undefined}
          onWithdrawSteer={activeId ? (id) => s.withdrawSteer(activeId, id) : undefined}
          onSteerNow={activeId ? () => { void s.steerNow(activeId) } : undefined}
        />
      </div>
      {/* 右侧车道:任务概览卡 + Agent Desk 卡片态。锚在整列(.t2-chat-col,含输入框区)——
        * Desk 卡底缘与输入框底缘同一条线(都是列底 -16px);滚动条仍在最右缘
        * (卡片右侧留 --tsum-gut 让 thumb 落位)。够宽才显示(容器查询),见 chat2.css .t2-rail */}
      {/* 画布模式下右侧车道收起,舞台铺满;切回对话原样回来 */}
      {!params.childSurface && !canvasOn && <div className="t2-rail">
        <TaskSummary
          teamStatus={activeId ? <>
            {teamDesk && <TeamStatus sessionId={activeId} />}
            <SubChatStatus sessionId={activeId} />
            {s.historianEnabled && <HistorianStatus key={activeId} sessionId={activeId} />}
          </> : undefined}
          messages={activeMessages}
          running={running}
          cwd={mvCfg.cwd}
          modelId={mvModelId}
          hostCwd={mvCfg.execMode === 'host' ? mvCfg.cwd : undefined}
          extraRoots={mvCfg.extraRoots}
          lockedRoots={mvCfg.execMode === 'host' && amadeusRoot && !sessionElsewhere ? [amadeusRoot] : []}
          // 只有本机会话谈得上「加本机文件夹」;沙箱会话的工作区不在本机。
          onAddRoot={mvCfg.execMode === 'host' && activeId && !sessionElsewhere ? () => {
            void window.tangu?.pickDirectory?.().then((dir) => {
              if (!dir) return
              const cur = useApp.getState().configBySession[activeId]?.extraRoots || []
              if (dir === mvCfg.cwd || cur.includes(dir)) return // 已是默认目录/已加过
              useApp.getState().setExecConfig({ extraRoots: [...cur, dir] }, activeId)
            })
          } : undefined}
          onRemoveRoot={mvCfg.execMode === 'host' && activeId ? (p) => {
            if (p === amadeusRoot) return
            const cur = useApp.getState().configBySession[activeId]?.extraRoots || []
            useApp.getState().setExecConfig({ extraRoots: cur.filter((x) => x !== p) }, activeId)
          } : undefined}
          onJumpToAttention={() => scrollToBottom(true)}
          // 「正在编辑」只在 Desk 收文件时出现(always 伴随面 = 走 Desk 关闭的老路:隐藏)。别退回开标签页:
          // WsFileView 只读一次盘、没有 watcher,写到一半的新文件会「加载失败」、edit_file 显示改前内容。
          onShowEditing={deskTakesFiles && activeId ? (p) => useApp.getState().deskShowFile(activeId, p) : undefined}
          onOpenFile={(f) => {
            // 设成「在 Agent Desk 展开」且 Desk 开着且这文件定位得到 → 上演出格;其余一律新标签页。
            const abs = f.path ? resolveDeskPath(f.path, mvCfg.cwd) : null
            if (deskTakesFiles && activeId && abs && s.desktopConfig?.summaryOpenIn === 'desk') {
              useApp.getState().deskShowFile(activeId, abs)
              return
            }
            openWsFile(targetFor(f, s.cfg, activeId || '', mvCfg.execMode))
          }}
        />
        {deskEnabled && activeId ? <DeskCard sessionId={activeId} /> : null}
      </div>}
      </div>
      {deskEnabled && activeId && !childSelections[activeId] && !canvasOn ? <AgentDesk sessionId={activeId} onQuote={deskQuote} /> : null}
      {!params.childSurface && activeId ? <ChildChatPanel key={activeId} parentId={activeId} /> : null}
    </div>
    </ToolCardDeskContext.Provider>
  )
}

/** 本地时刻 → 日程锚点串 `YYYY-MM-DDTHH:mm`(与 agentSchedule 的 calendarDate 编码同款;绝不走 toISOString=UTC)。 */
