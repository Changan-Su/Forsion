/** 主区聊天 leaf：followActive 跟随侧栏；分屏 leaf 用 sessionId 固定会话。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ArrowDown, Quote } from 'lucide-react'
import type { AgentConfig, UiMessage } from '../types'
import { Composer2 } from './chat2/Composer2'
import { EnginePicker } from '../components/EnginePicker'
import { AgentPicker } from '../components/AgentPicker'
import { ProjectSelector } from '../components/ProjectSelector'
import { WorkspaceFilePreview } from '../components/WorkspaceFilePreview'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { EditorialMessage } from './chat2/EditorialMessage'
import { EmptyState2 } from './chat2/EmptyState2'
import { FloatingToc } from './chat2/FloatingToc'
import { useApp } from '../stores/appStore'
import { useWorkspace } from '@lcl/engine'
import { useI18n } from '../i18n'
import { speakMessage, stopSpeaking, subscribeTts, ttsState, type TtsState } from '../services/ttsService'
import type { ViewProps } from '@lcl/engine/types'
import { useShallow } from 'zustand/react/shallow'
import './chat2/chat2.css'

const EMPTY_MESSAGES: UiMessage[] = []
const EMPTY_CONFIG: AgentConfig = {}
const EMPTY_USAGE = { ctx: 0, base: 0, live: 0 }

export function ChatView({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const streamingNodeRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const pendingCountRef = useRef(0)
  const globalActiveId = useApp((state) => state.activeId)
  const followActive = params.followActive !== false
  const pinnedSessionId = typeof params.sessionId === 'string' ? params.sessionId : null
  const activeId = followActive ? globalActiveId : pinnedSessionId
  const s = useApp(useShallow((state) => ({
    activeSession: state.sessions.find((x) => x.id === activeId) || state.archivedSessions.find((x) => x.id === activeId) || null,
    activeMessages: (activeId && state.messagesBySession[activeId]) || EMPTY_MESSAGES,
    running: !!(activeId && state.runningBySession[activeId]),
    execConfig: (activeId && state.configBySession[activeId]) || EMPTY_CONFIG,
    activeUsage: (activeId && state.usageBySession[activeId]) || EMPTY_USAGE,
    isGroupVoting: !!(activeId && state.groupVoting[activeId]),
    cfg: state.cfg,
    authInfo: state.authInfo,
    desktopConfig: state.desktopConfig,
    modelsResp: state.modelsResp,
    newChatWs: state.newChatWs,
    newChatCfg: state.newChatCfg,
    newChatModel: state.newChatModel,
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
    setSessionModel: state.setSessionModel,
    setNewChatModel: state.setNewChatModel,
    setSessionEngineModel: state.setSessionEngineModel,
    setSessionThinking: state.setSessionThinking,
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
  const activeSession = s.activeSession
  const activeModel = (s.modelsResp?.models || []).find((m) => m.id === (activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || '')) || null
  const activeUsage = s.activeUsage
  const activeMessages = s.activeMessages
  const running = s.running
  const execConfig = s.execConfig

  const mvCfg: AgentConfig = activeId
    // 已有会话:配置未加载完(execMode 缺失)时按 project_path 兜底判 host/sandbox,避免加载窗口内
    // 拖文件误走 25MB 上传;配置一旦到达(含用户显式选的 sandbox)即以 execConfig 为准。
    ? (execConfig.execMode ? execConfig : {
        execMode: activeSession?.project_path ? 'host' : 'sandbox',
        approvalMode: 'auto-edit',
        cwd: activeSession?.project_path || undefined,
        ...execConfig,
      })
    : {
        execMode: s.newChatWs?.kind === 'cloud' ? 'sandbox' : 'host',
        approvalMode: 'auto-edit',
        cwd: s.newChatWs?.kind === 'cloud' ? undefined : (s.newChatWs?.path || undefined),
        ...s.newChatCfg,
      }
  const mvModelId = activeId
    ? (activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || '')
    : (s.newChatModel || s.cfg.modelId || s.modelsResp?.defaultModelId || '')
  const isCloudSession = mvCfg.execMode === 'sandbox'
  const visibleModels = !s.modelsResp?.models
    ? null
    : s.modelsResp.models.filter((m) => (m.modelType || 'llm') === 'llm' && (!isCloudSession || m.source === 'forsion'))
  const availableEngines = s.engines.filter((e) => e.available)
  const curEngineId = activeId ? execConfig.engineId : s.newChatCfg.engineId
  const streamingId = useMemo(() => activeMessages.find((m) => m.status === 'streaming')?.id ?? null, [activeMessages])

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

  // 原生标签栏的标签名 = 会话标题(否则显示视图名「对话」);随会话/标题变化更新。
  useEffect(() => { leaf.setTitle(activeSession?.title || t('sidebar.newChat')) }, [activeSession?.title, leaf, t])

  useEffect(() => {
    if (activeId) void useApp.getState().loadSessionHistory(activeId)
  }, [activeId])

  // 每个 leaf 维护自己的标题，避免分屏时误改第一块 Chat tab。
  useEffect(() => {
    leaf.setTitle(activeSession?.title || (activeId ? 'Tangu Agent' : t('sidebar.newChat')))
  }, [activeId, activeSession?.title, leaf, t])

  const scrollToBottom = useCallback((smooth = false): void => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stickToBottom.current = true
    setShowJump(false)
  }, [])

  // 用户滚离底部后不抢滚动；重新到底即恢复跟随。
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const update = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      stickToBottom.current = atBottom
      setShowJump(!atBottom)
    }
    const releaseIfUp = (): void => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= 80) {
        stickToBottom.current = false
        setShowJump(true)
      }
    }
    const onWheel = (e: WheelEvent): void => { if (e.deltaY < 0) releaseIfUp() }
    el.addEventListener('scroll', update, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', releaseIfUp, { passive: true })
    return () => {
      el.removeEventListener('scroll', update)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', releaseIfUp)
    }
  }, [activeId])

  // 流式消息实际变高时吸底，避免逐 token effect 与 Markdown 布局互相追逐。
  useEffect(() => {
    if (!streamingId) return
    const node = streamingNodeRef.current
    const el = chatScrollRef.current
    if (!node || !el) return
    const follow = (): void => { if (stickToBottom.current) el.scrollTop = el.scrollHeight }
    follow()
    const ro = new ResizeObserver(() => requestAnimationFrame(follow))
    ro.observe(node)
    return () => ro.disconnect()
  }, [streamingId, activeId])

  // 非流式插入新消息时做一次吸底。
  useEffect(() => {
    if (!streamingId && stickToBottom.current) scrollToBottom()
  }, [activeMessages, streamingId, scrollToBottom])

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
      setQuoteButton({ x: rect.right - bounds.left, y: rect.bottom - bounds.top + 6, text })
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

  return (
    <div className="t2-chat-view" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <ErrorBoundary key={activeId || 'none'}>
        <div className="t2-chat-body" ref={chatAreaRef}>
          {hasMessages && <FloatingToc scrollContainerRef={chatScrollRef} scanTrigger={activeMessages.length} />}
          <div className="t2-stream" ref={registerChatScroll}>
            <div className="t2-stream-inner">
            {!hasMessages ? (
              <EmptyState2 />
            ) : (
              activeMessages.map((m) => {
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
                    rootRef={m.id === streamingId ? streamingNodeRef : undefined}
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
                    speakState={tts?.msgId === m.id ? tts.phase : undefined}
                    voice={ttsEnabled ? { on: voiceOn, cfg: s.cfg, stored: s.desktopConfig } : undefined}
                    handlers={{
                      onCopy: copy,
                      onRegenerate: () => s.regenerate(m.id, activeId),
                      onBranch: () => void s.branchFromMessage(m.id, activeId),
                      onEdit: () => startEdit(m.id, m.content),
                      onApproval: (aid, action, args) => void s.decideApproval(m.id, aid, action, args, activeId),
                      onInquiry: (iid, ans) => void s.answerInquiry(m.id, iid, ans, activeId),
                      ...(ttsEnabled ? { onSpeak: () => speak(m.id, m.content) } : {}),
                    }}
                  />
                )
              })
            )}
            {running && activeId && s.isGroupVoting && <div className="t2-sys"><span className="t2-dot" /> {t('group.voting.inProgress')}</div>}
            </div>
          </div>
          {showJump && <button className="jump-bottom t2-jump" title={t('chat.jumpToBottom')} onClick={() => scrollToBottom(true)}><ArrowDown size={16} /></button>}
          {quoteButton && (
            <button
              className="quote-float t2-quote"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuotedText(quoteButton.text)
                setQuoteButton(null)
                window.getSelection()?.removeAllRanges()
              }}
              style={{ left: quoteButton.x, top: quoteButton.y }}
            >
              <Quote size={13} /> {t('chat.action.quote')}
            </button>
          )}
        </div>
      </ErrorBoundary>

      {!hasMessages && mvCfg.execMode === 'host' && !mvCfg.groupChat && (
        <div className="newchat-pickers">
          {availableEngines.length > 0 && (
            <EnginePicker
              engines={availableEngines}
              selectedId={mvCfg.engineId || ''}
              warmingId={mvCfg.engineId && !s.engineCaps[mvCfg.engineId] ? mvCfg.engineId : null}
              onSelect={(id) => (activeId ? s.setSessionEngine(id, activeId) : s.setNewChatCfg((c) => ({ ...c, engineId: id || undefined, engineModelId: undefined, ...(id ? { groupChat: false } : {}) })))}
            />
          )}
          {!mvCfg.engineId && s.agentDefs.length > 0 && (
            <AgentPicker
              agents={s.agentDefs}
              selectedSlug={mvCfg.agentSlug || ''}
              defaultSlug={s.defaultAgentSlug}
              avatars={s.agentAvatars}
              onSelect={activeId ? (slug) => s.selectSessionAgent(slug, activeId) : s.selectNewChatAgent}
            />
          )}
        </div>
      )}

      {!activeId && (
        <div className="newchat-projectbar">
          <div className="newchat-projectbar-inner">
            <ProjectSelector
              workspaces={s.workspaces()}
              value={s.newChatWs?.key ?? null}
              onChange={(w) => s.setNewChatWs(w)}
              onAddProject={window.tangu?.pickDirectory ? () => void s.addLocalWorkspace() : undefined}
            />
          </div>
        </div>
      )}

      <div className="composer-anchor">
        <AnimatePresence>
          {s.filePreview && (
            <WorkspaceFilePreview key={s.filePreview.name} target={s.filePreview} onClose={() => s.setFilePreview(null)} />
          )}
        </AnimatePresence>
        <Composer2
          disabled={s.connState !== 'ok'}
          running={running}
          execConfig={mvCfg}
          models={visibleModels}
          modelId={mvModelId}
          onModelChange={activeId ? (id) => s.setSessionModel(id, activeId) : (id) => s.setNewChatModel(id)}
          engines={s.engines}
          engineId={mvCfg.engineId}
          engineModels={mvCfg.engineId ? (s.engineCaps[mvCfg.engineId]?.models ?? []) : undefined}
          engineModelId={mvCfg.engineModelId}
          onEngineModelChange={activeId ? (id) => s.setSessionEngineModel(id, activeId) : (id) => s.setNewChatCfg((c) => ({ ...c, engineModelId: id || undefined }))}
          engineCommands={mvCfg.engineId ? (s.engineCaps[mvCfg.engineId]?.commands ?? []) : undefined}
          thinkingLevel={mvCfg.thinkingLevel}
          onThinkingChange={activeId ? (lv) => s.setSessionThinking(lv, activeId) : (lv) => s.setNewChatCfg((c) => ({ ...c, thinkingLevel: lv }))}
          maxIterations={mvCfg.maxIterations}
          onMaxIterationsChange={activeId ? (n) => s.setSessionMaxIterations(n, activeId) : (n) => s.setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
          planMode={mvCfg.planMode}
          onPlanModeChange={activeId ? (v) => s.setSessionPlanMode(v, activeId) : (v) => s.setNewChatCfg((c) => ({ ...c, planMode: v }))}
          voiceMode={voiceOn}
          onVoiceModeChange={chatAgentSlug ? (on) => void s.setVoiceMode(chatAgentSlug, on) : undefined}
          groupChat={mvCfg.groupChat}
          groupAgents={mvCfg.groupAgents}
          groupTempAgents={mvCfg.groupTempAgents}
          groupIntensity={mvCfg.groupIntensity}
          groupMaxRounds={mvCfg.groupMaxRounds}
          onGroupChange={activeId ? (patch) => s.setSessionGroup(patch, activeId) : (patch) => s.setNewChatCfg((c) => ({ ...c, ...patch }))}
          skills={s.skillsList}
          agents={s.agentDefs}
          onNewSession={() => void s.newSession()}
          onBranch={activeId ? () => void s.branchFromMessage(undefined, activeId) : undefined}
          onOpenSettings={() => s.openSettings('skills')}
          onExecConfigChange={activeId ? (patch) => s.setExecConfig(patch, activeId) : (patch) => s.setNewChatCfg((c) => ({ ...c, ...patch }))}
          onSend={(text, attachments, workspaceFiles, skillIds, mentions) => s.send(text, attachments, workspaceFiles, skillIds, mentions, activeId)}
          onStop={() => s.stop(activeId)}
          quotedText={quotedText}
          onClearQuote={() => setQuotedText('')}
          contextWindow={activeModel?.contextWindow || 0}
          ctxTokens={activeUsage.ctx}
          sessionTokens={activeUsage.base + activeUsage.live}
          onCompact={() => void s.compact(activeId)}
        />
      </div>
    </div>
  )
}
