/** 主区聊天 leaf：followActive 跟随侧栏；分屏 leaf 用 sessionId 固定会话。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ArrowDown, Folder, MessageSquarePlus, Quote } from 'lucide-react'
import type { AgentConfig, UiMessage } from '../types'
import { Composer2 } from './chat2/Composer2'
import { AgentSelectStrip } from '../components/AgentSelectStrip'
import { ProjectSelector } from '../components/ProjectSelector'
import { WorkspaceFilePreview } from '../components/WorkspaceFilePreview'
import { targetFor } from '../components/InlineFiles'
import { openWsFile } from './wsFileNav'
import { openNewChat, openSession, rotateSolo } from '../sessionNav'
import { TeamEditor } from '../components/TeamEditor'
import { postMuseFeedback, saveAgentScheduleEntry } from '../services/backendService'
import { runTaskCard } from './chat2/taskLanding'
import { resolveDeskPath } from '../stores/deskPlan'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { EditorialMessage } from './chat2/EditorialMessage'
import { RunStatsLine } from './chat2/RunStatsLine'
import { inRunWindow } from '../stores/runStats'
import { EmptyState2 } from './chat2/EmptyState2'
import { FloatingToc } from './chat2/FloatingToc'
import { TaskSummary } from './chat2/TaskSummary'
import { useApp, stickyDefaults, activeChatModelId, withAmadeusWorkspace, applyPreset, newSessionPreset } from '../stores/appStore'
import { currentPlatform } from '../services/agentRunService'
import { hasChatRef, readChatRefs } from './chat2/chatDragRef'
import { useWorkspace, useSpaceStore, UI_MODE, Skeleton } from '@lcl/engine'
import { AgentDesk, DeskCard } from './chat2/AgentDesk'
import { HistorianStatus } from './chat2/HistorianStatus'
import { TeamStatus } from './chat2/TeamDesk'
import { ChildChatPanel, SubChatStatus } from './chat2/ChildChatPanel'
import { useChildChat } from '../stores/childChatStore'
import { TeamSummary } from './chat2/TeamSummary'
import { useI18n } from '../i18n'
import { speakMessage, stopSpeaking, subscribeTts, ttsState, type TtsState } from '../services/ttsService'
import type { ViewProps } from '@lcl/engine/types'
import { useShallow } from 'zustand/react/shallow'
import './chat2/chat2.css'
import { zoomOf } from '@lcl/engine'
import { usePageStore } from '../amadeus/store/pageStore'
import { useCodeStudio } from '../stores/codeStudioStore'
import { projectName } from './coding/studioModel'
import './coding/studioMessages'
import { selectableChatModels } from './chatModelCatalog'
import { useChatWaitDetailsEnabled } from '../chatWaitDetails'

const EMPTY_MESSAGES: UiMessage[] = []
const EMPTY_CONFIG: AgentConfig = {}
const EMPTY_USAGE: { ctx: number; base: number; live: number; runCost?: number; costLimit?: number } = { ctx: 0, base: 0, live: 0 }
const EMPTY_STEER: Array<{ id: string; text: string }> = []
const EMPTY_STRS: string[] = []
/** 列表里不画的消息:团队总结(单独挂尾部)与只有工作占位、没东西可看的成员气泡。 */
const isHiddenInList = (m: UiMessage): boolean =>
  !!m.teamSummary || (!!m.work && !m.content && !m.error && !m.approvals?.length && !m.inquiries?.length)

export function ChatView({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const showWaitDetails = useChatWaitDetailsEnabled()
  const childSelections = useChildChat((state) => state.selected)
  const [raiseTeam, setRaiseTeam] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const streamingNodeRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const pendingCountRef = useRef(0)
  const globalActiveId = useApp((state) => state.activeId)
  const followActive = params.followActive !== false
  // Saved Coding layouts predate the studio param; the active Space supplies the same scope.
  const inCodingSpace = useSpaceStore(state => state.activeSpaceId === 'coding')
  const studioChat = followActive && (!!params.studio || inCodingSpace)
  const studioRoot = useCodeStudio(state => state.activeProject)
  const pinnedSessionId = typeof params.sessionId === 'string' ? params.sessionId : null
  const activeId = followActive ? globalActiveId : pinnedSessionId
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
    addCloudProject: state.addCloudProject,
    setSessionModel: state.setSessionModel,
    setNewChatModel: state.setNewChatModel,
    setSessionEngineModel: state.setSessionEngineModel,
    setSessionThinking: state.setSessionThinking,
    setDefaultModel: state.setDefaultModel,
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
  const [showJump, setShowJump] = useState(false)
  const [quoteButton, setQuoteButton] = useState<{ x: number; y: number; text: string } | null>(null)
  const [quotedText, setQuotedText] = useState('')
  const [refDrop, setRefDrop] = useState(false) // 工作区条目拖到聊天区上方(整块高亮)
  const childSession = useChildChat((state) => activeId ? state.sessions[activeId] : undefined)
  const activeSession = s.activeSession || childSession
  const activeModel = (s.modelsResp?.models || []).find((m) => m.id === (activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || '')) || null
  // 切模型后 SSE 重放会把 setSessionModel 清掉的旧 context_info 复活——事件带的 modelId 与当前
  // 会话模型不一致就视同没有(老引擎事件不带 modelId → 放行,保持兼容)
  const activeCtxInfo = s.activeCtxInfo && (!s.activeCtxInfo.modelId || !activeModel || s.activeCtxInfo.modelId === activeModel.id) ? s.activeCtxInfo : null
  const activeUsage = s.activeUsage
  const activeMessages = s.activeMessages
  const running = s.running
  const execConfig = s.execConfig
  // Vault 切换会即时重算 Project 列表与系统工作根;不能只在 s.workspaces() 里 getState 快照,
  // 否则 appStore 本身没变化时 React 不会重渲染选择器。
  const amadeusRoot = usePageStore((state) => state.vaultRoot)

  // 主区划线后交给侧栏的引用可能先于 chat-panel 挂载；目标承载一出现就消费，其他 ChatView 不碰。
  useEffect(() => {
    const pending = s.pendingChatQuote
    if (!pending || pending.targetType !== leaf.type) return
    setQuotedText(pending.text)
    s.clearPendingChatQuote(pending.seq)
  }, [leaf.type, s.pendingChatQuote, s.clearPendingChatQuote])

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
        return applyPreset({
          execMode: cloud ? 'sandbox' : 'host',
          ...stickyDefaults(s.desktopConfig, !cloud, preset),
          cwd: cloud ? undefined : (s.newChatWs?.path || undefined),
          ...s.newChatCfg,
        }, preset) as AgentConfig
      })(), amadeusRoot)
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
  // composer ↑↓ 历史召回:本会话已发送的用户消息(旧→新)+ steer 入队即记的补充池(被删/撤回的插话
  // 仍可从 ↑ 找回;已注入的会同时出现在消息里,按文本去重)。打断标记是机器行,不进历史。
  const sentHistory = useMemo(() => {
    const users = activeMessages.filter((m) => m.role === 'user' && !m.content.startsWith('<turn_interrupted>')).map((m) => m.content)
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
    leaf.setTitle(activeSession?.title || (activeId ? 'Tangu Agent' : t('sidebar.newChat')))
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
    const root = chatScrollRef.current
    if (root) {
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
      root.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' })
      stickToBottom.current = false
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
    let pointerDown = false
    const update = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom) stickToBottom.current = true
      else if (pointerDown && el.scrollTop < previousTop) stickToBottom.current = false
      previousTop = el.scrollTop
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

  // 审批/询问属于必须看到的操作，首次出现时强制定位到底部。
  useEffect(() => {
    let pending = 0
    for (const m of activeMessages) {
      pending += m.approvals?.filter((a) => a.status === 'pending').length || 0
      pending += m.inquiries?.filter((q) => q.status === 'pending').length || 0
    }
    if (pending > pendingCountRef.current) scrollToBottom(true)
    pendingCountRef.current = pending
  }, [activeMessages, scrollToBottom])

  // 聊天区划线引用。
  useEffect(() => {
    const el = chatScrollRef.current
    const host = chatAreaRef.current
    if (!el || !host) return
    const onMouseUp = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setQuoteButton(null); return }
      const text = selection.toString().trim()
      const range = selection.getRangeAt(0)
      if (!text || !el.contains(range.commonAncestorContainer)) { setQuoteButton(null); return }
      const rect = range.getBoundingClientRect()
      const bounds = host.getBoundingClientRect()
      // rect/bounds 是视口 px,而 absolute 的 left/top 是宿主内未缩放局部 px → 差值先除掉宿主缩放。
      const z = zoomOf(host)
      setQuoteButton({ x: (rect.right - bounds.left) / z, y: (rect.bottom - bounds.top) / z + 6, text })
    }
    const onSelection = (): void => { if (window.getSelection()?.isCollapsed) setQuoteButton(null) }
    const clear = (): void => setQuoteButton(null)
    el.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelection)
    el.addEventListener('scroll', clear, { passive: true })
    return () => {
      el.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelection)
      el.removeEventListener('scroll', clear)
    }
  }, [activeId, activeMessages.length])

  const copy = (text: string): void => { try { void navigator.clipboard.writeText(text) } catch { /* ignore */ } }
  // 朗读:配置了 TTS 模型才显示入口;点击播放/合成中的消息 = 停止。
  const [tts, setTts] = useState<TtsState>(ttsState())
  useEffect(() => subscribeTts(setTts), [])
  const ttsEnabled = !!s.desktopConfig?.ttsModelId?.trim()
  const speak = (id: string, text: string): void => {
    if (tts?.msgId === id) { stopSpeaking(); return }
    speakMessage(s.cfg, s.desktopConfig, id, text).catch((e: any) => {
      s.toast(e?.message === 'EMPTY' ? t('tts.noText') : t('tts.failed', { e: e?.message || e }), true)
    })
  }
  const startEdit = (id: string, content: string): void => { setEditingId(id); setEditText(content) }
  const saveEdit = (): void => { if (editingId && editText.trim()) { s.editUserMessage(editingId, editText.trim(), activeId) } setEditingId(null) }

  const hasMessages = activeMessages.length > 0
  // Agent Desk:桌面端默认开(移动端没有);用户可在设置→高级关掉,窄容器由 CSS 容器查询兜底隐藏。
  const deskEnabled = !params.childSurface && !studioChat && UI_MODE !== 'mobile' && !!s.desktopConfig?.agentDeskEnabled
  // 团队成员列表嵌入 Pin Summary 的运行状态,Agent Desk 保持独立。
  const teamDesk = !params.childSurface && !studioChat && UI_MODE !== 'mobile' && !!mvCfg.groupChat && (mvCfg.groupAgents?.length || 0) >= 2

  // 工作区(会话/笔记/文件)拖进来即引用:**整个聊天区**都是落区,不用瞄准输入框。
  // 只吃 chatDragRef 的两个 MIME —— OS 文件仍归输入框卡片那套(附件/路径插入),两条路不打架。
  const onRefDragOver = (e: React.DragEvent): void => {
    if (!hasChatRef(e.dataTransfer)) return
    e.preventDefault() // 不 preventDefault 就不会有 drop 事件
    e.dataTransfer.dropEffect = 'copy'
    if (!refDrop) setRefDrop(true)
  }
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
    <div
      className={`t2-chat-view${refDrop ? ' refdrop' : ''}`}
      data-chat-surface={leaf.type}
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
      <div className="t2-chat-col">
      <ErrorBoundary key={activeId || 'none'}>
        <div className="t2-chat-body" ref={chatAreaRef}>
          {hasMessages && <FloatingToc scrollContainerRef={chatScrollRef} scanTrigger={activeMessages.length} />}
          <div className="t2-stream" ref={registerChatScroll}>
            <div className="t2-stream-inner">
            {!hasMessages ? (
              // 空状态本身不在流里(见下面 .t2-chat-col 直属的那份):流只占输入框以上,
              // 在里面居中 = 视觉上偏高。骨架屏留在流里 —— 它替代的是消息,本就该从顶部排。
              historyLoading ? <Skeleton variant="chat" /> : null
            ) : (
              activeMessages.map((m) => {
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
                    footer={m.id === runStatsMsgId && runStats ? <RunStatsLine stats={runStats} /> : undefined}
                    avatarUrl={m.role !== 'assistant' ? undefined : (() => {
                      // 群聊发言人:优先 agentId,缺失时按名反查 slug(agentDefs 晚到时自动纠正);仍无则不回退会话默认头像。
                      const aid = m.agentId || (m.agentName ? s.agentDefs.find((a) => a.name === m.agentName)?.slug : undefined)
                      if (aid) return s.agentAvatars[aid]
                      if (m.agentName) return undefined
                      return curEngineId ? undefined : chatAgentAvatar
                    })()}
                    agentNameFallback={chatAgentName}
                    userName={userName}
                    userAvatar={userAvatar}
                    fileCtx={{ cfg: s.cfg, sessionId: activeId || '', execMode: mvCfg.execMode, onOpenPreview: s.setFilePreview }}
                    modelId={mvModelId}
                    speakState={tts?.msgId === m.id ? tts.phase : undefined}
                    voice={ttsEnabled ? { on: voiceOn, cfg: s.cfg, stored: s.desktopConfig } : undefined}
                    handlers={{
                      onCopy: copy,
                      onRegenerate: params.readOnly ? undefined : () => s.regenerate(m.id, activeId),
                      onBranch: params.childSurface ? undefined : () => void s.branchFromMessage(m.id, activeId),
                      onEdit: params.readOnly ? undefined : () => startEdit(m.id, m.content),
                      onRewind: params.readOnly ? undefined : (mode) => void s.rewindTo(m.id, mode, activeId),
                      onApproval: (aid, action, args) => void s.decideApproval(m.id, aid, action, args, activeId),
                      onInquiry: (iid, ans) => s.answerInquiry(m.id, iid, ans, activeId),
                      // 建议芯片 = 用户自己把这句话打进去按了回车(运行中则落进 steer 等待区)。
                      onSuggest: params.readOnly ? undefined : (text) => void s.send(text, [], undefined, undefined, undefined, activeId),
                      onTask: (card, landing) => runTaskCard(card, landing, activeId),

                      ...(ttsEnabled ? { onSpeak: (text) => speak(m.id, text) } : {}),
                    }}
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
          {showJump && <button className="jump-bottom t2-jump" title={t('chat.jumpToBottom')} onClick={() => scrollToBottom(true)}><ArrowDown size={16} /></button>}
          {quoteButton && (
            <div
              className="quote-float t2-quote-menu"
              role="toolbar"
              aria-label={t('chat.selection.actions')}
              onMouseDown={(e) => e.preventDefault()}
              style={{ left: quoteButton.x, top: quoteButton.y }}
            >
              <button
                className="t2-quote-action"
                data-testid="selection-quote"
                onClick={() => {
                  setQuotedText(quoteButton.text)
                  setQuoteButton(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                <Quote size={13} /> {t('chat.action.quote')}
              </button>
              {leaf.type !== 'chat-panel' && (
                <button
                  className="t2-quote-action"
                  data-testid="selection-ask-in-panel"
                  onClick={() => {
                    const text = quoteButton.text
                    useApp.getState().setPendingChatQuote('chat-panel', text)
                    const workspace = useWorkspace.getState()
                    const panelIsFront = workspace.rightVisible
                      && workspace.rightTabs.some((tab) => tab.type === 'chat-panel' && tab.active)
                    // showSideView 对当前活动项是 toggle；这里的语义是 reveal，已在前台时不能反向收起。
                    if (!panelIsFront) workspace.showSideView('right', 'chat-panel')
                    setQuoteButton(null)
                    window.getSelection()?.removeAllRanges()
                  }}
                >
                  <MessageSquarePlus size={13} /> {t('chat.action.askInPanel')}
                </button>
              )}
            </div>
          )}
        </div>
      </ErrorBoundary>

      {/* 空状态优先保持 view 居中;空间不足时按 composer 实高向上避让,小高度逐级精简。 */}
      {!hasMessages && !historyLoading && <EmptyState2 compact={!!params.miniSurface} title={params.miniSurface ? t('mini.chatHint') : studioChat ? t('studio.chatTitle') : undefined} subtitle={studioChat ? t(studioRoot ? 'studio.chatHint' : 'studio.chooseProject') : undefined} />}

      {/* 输入区整簇(新对话的两条选择器 + 输入卡)一起悬浮:它们**都在 .composer-anchor 里**,
          正文才能真正铺满整列。留在外面就会各占一段布局,反倒被悬浮的卡盖住。
          新加与输入卡同簇的东西请一并放进来 —— 高度由 anchor 统一量成 --t2-composer-h。 */}
      <div className="composer-anchor" ref={composerRef}>
        {/* Chat 固定使用创建时的当前默认 Agent，不露选择器；Work 的云会话仍可选 Agent，外部引擎仍 host-only。
            轨道方案 §4:门控去掉 `!groupChat`(06-25 那道「群聊态无单一主 agent」门的理由随选择条消失 ——
            **这条就是群聊/团队模式的配置器**),换成轨道身份钉死的三把锁(私聊 / 私聊引擎 / 独立团队)。 */}
        {!params.miniSurface && !params.childSurface && !hasMessages && mvCfg.preset !== 'chat' && !mvCfg.soloAgentSlug && !mvCfg.soloEngineId && !mvCfg.teamSlug && (
          <div className="newchat-pickers">
            <AgentSelectStrip sessionId={activeId} cfg={mvCfg} />
          </div>
        )}
  
        {/* Chat 无项目:不露项目选择器，否则会悄悄建成 Work 会话。Coding Studio 另要求先选定项目。 */}
        {!activeId && mvCfg.preset !== 'chat' && (!studioChat || studioRoot) && (
          <div className="newchat-projectbar">
            <div className="newchat-projectbar-inner">
              {studioChat && studioRoot ? <div className="project-pill" title={studioRoot} data-studio-project={studioRoot}><Folder size={13} /><span className="project-pill-name">{projectName(studioRoot)}</span></div> : <ProjectSelector
                workspaces={s.workspaces()}
                value={s.newChatWs?.key ?? null}
                onChange={(w) => s.setNewChatWs(w)}
                onAddProject={window.tangu?.pickDirectory ? () => void s.addLocalWorkspace() : undefined}
                onAddCloudProject={(name) => void s.addCloudProject(name)}
              />}
            </div>
          </div>
        )}

        <AnimatePresence>
          {s.filePreview && (
            <WorkspaceFilePreview key={s.filePreview.name} target={s.filePreview} onClose={() => s.setFilePreview(null)} />
          )}
        </AnimatePresence>
        <Composer2
          // 实时语音:只有跟随侧栏的主区聊天接得住(固定会话的分屏/隐藏标签不许抢交接);发往的就是本视图的会话
          liveOwner={followActive && leaf.loc === 'main'}
          liveSessionKey={activeId}
          disabled={!!params.readOnly || s.connState !== 'ok' || (studioChat && !studioRoot)}
          disabledPlaceholder={studioChat && !studioRoot ? t('studio.chooseProject') : undefined}
          running={running}
          execConfig={mvCfg}
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
          onThinkingChange={(lv) => s.setSessionThinking(lv, activeId, !params.childSurface)}
          defaultModelIds={{
            backgroundModelId: s.desktopConfig?.backgroundModelId || '',
            imageModelId: s.cfg.imageModelId || '',
            visionModelId: s.cfg.visionModelId || '',
          }}
          onDefaultModelChange={s.setDefaultModel}
          maxIterations={mvCfg.maxIterations}
          onMaxIterationsChange={activeId ? (n) => s.setSessionMaxIterations(n, activeId) : (n) => s.setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
          verifyCommand={mvCfg.verifyCommand}
          onVerifyCommandChange={activeId
            ? (cmd) => s.setExecConfig({ verifyCommand: cmd || undefined }, activeId)
            : (cmd) => s.setNewChatCfg((c) => ({ ...c, verifyCommand: cmd || undefined }))}
          planMode={mvCfg.planMode}
          onPlanModeChange={activeId ? (v) => s.setSessionPlanMode(v, activeId) : (v) => s.setNewChatCfg((c) => ({ ...c, planMode: v }))}
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
          onNormalWork={() => {
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
          onExecConfigChange={(patch) => s.setExecConfig(patch, activeId)}
          onSend={async (text, attachments, workspaceFiles, skillIds, mentions) => {
            if (studioChat) {
              const target = useCodeStudio.getState().prepareRun()
              if (!target) return false
              return useApp.getState().send(text, attachments, workspaceFiles, skillIds, mentions, target.sessionId)
            }
            return s.send(text, attachments, workspaceFiles, skillIds, mentions, activeId)
          }}
          onStop={() => s.stop(activeId)}
          quotedText={quotedText}
          onClearQuote={() => setQuotedText('')}
          // 引擎 context_info 报的窗口是真实预算口径(覆盖表/族兜底),优先于模型列表值——两边可能不一致
          contextWindow={activeCtxInfo?.ctxWindow || activeModel?.contextWindow || 0}
          ctxInfo={activeCtxInfo}
          ctxTokens={activeUsage.ctx}
          sessionTokens={activeUsage.base + activeUsage.live}
          runCost={activeUsage.runCost}
          costLimit={activeUsage.costLimit}
          onCompact={(focus) => void s.compact(activeId, focus)}
          seedText={s.steerRestore ?? (params.childSurface ? null : s.pendingDraft)}
          appendRefs={params.childSurface ? null : s.draftRefs}
          onAppendRefsConsumed={s.clearDraftRefs}
          // 聊天开在侧栏(Amadeus 右栏等)→ 默认引用主区当前打开的那篇笔记;聊天自己就是主区时无从谈起
          autoRefFromMain={!params.childSurface && leaf.loc !== 'main'}
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
      {!params.childSurface && <div className="t2-rail">
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
          lockedRoots={mvCfg.execMode === 'host' && amadeusRoot ? [amadeusRoot] : []}
          // 只有本机会话谈得上「加本机文件夹」;沙箱会话的工作区不在本机。
          onAddRoot={mvCfg.execMode === 'host' && activeId ? () => {
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
          onShowEditing={deskEnabled && activeId ? (p) => useApp.getState().deskShowFile(activeId, p) : undefined}
          onOpenFile={(f) => {
            // 设成「在 Agent Desk 展开」且 Desk 开着且这文件定位得到 → 上演出格;其余一律新标签页。
            const abs = f.path ? resolveDeskPath(f.path, mvCfg.cwd) : null
            if (deskEnabled && activeId && abs && s.desktopConfig?.summaryOpenIn === 'desk') {
              useApp.getState().deskShowFile(activeId, abs)
              return
            }
            openWsFile(targetFor(f, s.cfg, activeId || '', mvCfg.execMode))
          }}
        />
        {deskEnabled && activeId ? <DeskCard sessionId={activeId} /> : null}
      </div>}
      </div>
      {deskEnabled && activeId && !childSelections[activeId] ? <AgentDesk sessionId={activeId} /> : null}
      {!params.childSurface && activeId ? <ChildChatPanel key={activeId} parentId={activeId} /> : null}
    </div>
  )
}

/** 本地时刻 → 日程锚点串 `YYYY-MM-DDTHH:mm`(与 agentSchedule 的 calendarDate 编码同款;绝不走 toISOString=UTC)。 */
