/**
 * Tangu Desktop 应用壳:侧栏(多会话)+ 聊天流 + 输入区 + 设置 + 右侧面板。
 * run 流式:startRun → SSE 归约进对应 assistant 消息(后台会话照常跑,完成标未读)。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentConfig, AgentRunEvent, Attachment, ModelsResponse, NormalAgentDef, SessionRecord, SkillInfo, TanguDesktopConfig, UiMessage, WorkspaceDescriptor,
  StoredDesktopConfig,
} from './types'
import { CLOUD_WORKSPACE_KEY } from './types'
import * as api from './services/backendService'
import { abortRun, listActiveRuns, resolveApproval, resolveInquiry, startRun, steerRun, subscribeRunEvents, testConnection } from './services/agentRunService'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { EnginePicker } from './components/EnginePicker'
import { ChatArea } from './components/ChatArea'
import { MessageInput } from './components/MessageInput'
import { SettingsModal, type Tab as SettingsTab } from './components/SettingsModal'
import { RightPanel } from './components/RightPanel'
import { WorkspaceFilePreview, type PreviewTarget } from './components/WorkspaceFilePreview'
import { AnimatePresence } from 'framer-motion'
import { WeChatView } from './components/WeChatView'
import { AgentsDetailView } from './components/AgentsDetailView'
import { MemoryView } from './components/MemoryView'
import { WorkspaceDetailView } from './components/WorkspaceDetailView'
import { ProjectSelector } from './components/ProjectSelector'
import { OnboardingWizard, ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { resolveInitialMode, resolveInitialPreset } from './theme/registry'
import { applyTheme } from './theme/loader'
import { useI18n } from './i18n'

const UNREAD_KEY = 'forsion_tangu_unread_sessions'

function loadUnread(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]')) } catch { return new Set() }
}
function saveUnread(s: Set<string>): void {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

/** 历史行 → UI 消息(tool_calls/tool_results 配对成 toolEvents)。 */
function recordToUi(r: any): UiMessage {
  const role = r.role === 'model' || r.role === 'assistant' ? 'assistant' : 'user'
  const msg: UiMessage = {
    id: r.id,
    role,
    content: r.content || '',
    reasoning: r.reasoning || undefined,
    attachments: r.attachments || undefined,
    status: 'done',
    timestamp: Number(r.timestamp) || 0,
  }
  if (role === 'assistant' && Array.isArray(r.tool_calls) && r.tool_calls.length) {
    const results = new Map<string, any>(
      (Array.isArray(r.tool_results) ? r.tool_results : []).map((t: any) => [t.tool_call_id, t]),
    )
    msg.toolEvents = r.tool_calls.map((c: any) => {
      const res = results.get(c.id)
      return {
        id: c.id,
        name: c.function?.name || c.name || 'tool',
        arguments: c.function?.arguments,
        result: res ? String(res.content ?? '') : undefined,
        isError: res?.isError || false,
        startedAt: res?.startedAt,
        elapsedMs: res?.elapsedMs,
        outputChars: res?.outputChars,
        parallelGroup: res?.parallelGroup,
        artifactPath: res?.artifactPath,
        done: true,
      }
    })
  }
  if (r.is_error) msg.status = 'error'
  return msg
}

/** 群聊事件在单条 run 的 assistantRef 上挂的额外状态(跨事件持久;StrictMode 安全:仅在事件体内改)。 */
type GroupRef = { current: string; groupSeen?: boolean; group?: boolean; groupEnded?: boolean; reuseNext?: boolean }

/** 群聊发言人徽章配色:按 slug 派生稳定色相(主持人=金色)。前端派生,不改后端 agent 定义。 */
function groupColor(slug: string): string {
  if (slug === '__host__') return '#b8860b'
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 45%)`
}

export function App(): React.JSX.Element {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<TanguDesktopConfig>({ backendUrl: 'http://localhost:8787', token: '', modelId: '' })
  const [desktopConfig, setDesktopConfig] = useState<StoredDesktopConfig | null>(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)
  const [connState, setConnState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [connMessage, setConnMessage] = useState('')
  // managed(本机托管)后端 → 新会话默认本机执行(与 TUI 对齐);homeDir 作 cwd 兜底。
  const desktopMode = useRef<'managed' | 'external' | null>(null)
  const homeDirRef = useRef<string | undefined>(undefined)
  // 「Tangu 默认工作区」本地目录(effectiveConfig 折算的 ~/Tangu;设置里可改)。
  const defaultWsDirRef = useRef<string>('')
  const [defaultWsDir, setDefaultWsDir] = useState('')

  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [archivedSessions, setArchivedSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modelsResp, setModelsResp] = useState<ModelsResponse | null>(null)
  const [skillsList, setSkillsList] = useState<SkillInfo[] | null>(null)
  const [agentDefs, setAgentDefs] = useState<NormalAgentDef[]>([])
  const [engines, setEngines] = useState<Array<{ id: string; name: string; available?: boolean; defaultModel?: string }>>([]) // host 端外部 agent 引擎(含 available 检测;云端=空)
  const [engineCaps, setEngineCaps] = useState<Record<string, { models: Array<{ id: string; name: string; description?: string }>; commands: Array<{ name: string; description: string; hint?: string }> }>>({}) // engineId → 探测到的模型/命令(懒拉缓存)
  // 主区面板:微信远程 / 后台智能体详情 / 记忆 / 工作区详情(null=会话或空白新对话)。
  const [specialView, setSpecialView] = useState<'wechat' | 'agents' | 'memory' | 'workspace' | null>(null)
  const [detailWsKey, setDetailWsKey] = useState<string | null>(null) // 工作区详情面板的目标工作区 key
  const [newChatWs, setNewChatWs] = useState<WorkspaceDescriptor | null>(null) // 空白新对话选定的 Project(null=Tangu 默认)
  const [newChatCfg, setNewChatCfg] = useState<AgentConfig>({}) // 空白新对话草稿配置(审批/计划/思考/技能/agent;发送时并入新会话)
  const [newChatModel, setNewChatModel] = useState<string | null>(null) // 空白新对话草稿模型(modelId 不在 AgentConfig 内,单列)
  // Special Agents 各自开关(侧栏入口按此显隐;云端 404 / 失败 → 全 false)。
  const [specialEnabled, setSpecialEnabled] = useState<{ historian: boolean; muse: boolean }>({ historian: false, muse: false })
  // 划线引用:聊天区选中的待引用文本(发送时以 markdown 引用拼到消息前)。
  const [quote, setQuote] = useState('')
  // 工作区文件浮层预览目标(点右侧工作区文件打开;null=关闭)。
  const [filePreview, setFilePreview] = useState<PreviewTarget | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Record<string, UiMessage[]>>({})
  const [configBySession, setConfigBySession] = useState<Record<string, AgentConfig>>({})
  const [runningBySession, setRunningBySession] = useState<Record<string, string>>({})
  // 会话上下文/消耗:ctx=最近一轮真实 prompt tokens(占比用);base=已完成 run 累计;live=当前 run 累计。
  const [usageBySession, setUsageBySession] = useState<Record<string, { ctx: number; base: number; live: number }>>({})
  const [unread, setUnread] = useState<Set<string>>(loadUnread)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  // 聊天滚动容器引用:ChatArea 用它吸底,右侧「目录」用它扫描/跳转(共享同一容器)。
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 设置页打开时定位到的 tab(null=默认 connection);微信/技能等入口跳到对应分区。
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [onboarding, setOnboarding] = useState(false)
  const [themePreset, setThemePreset] = useState(resolveInitialPreset)
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(resolveInitialMode)
  const [glassOn, setGlassOn] = useState(() => {
    try { return localStorage.getItem('forsion_glass') !== 'off' } catch { return true }
  })
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; error?: boolean }>>([])

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const newChatWsRef = useRef(newChatWs)
  newChatWsRef.current = newChatWs
  const newChatCfgRef = useRef(newChatCfg)
  newChatCfgRef.current = newChatCfg
  const newChatModelRef = useRef(newChatModel)
  newChatModelRef.current = newChatModel
  // 给轮询读「当前会话是否在本地 streaming」用,避免把 runningBySession 列进 effect 依赖导致定时器频繁重建。
  const runningRef = useRef(runningBySession)
  runningRef.current = runningBySession
  const runAborts = useRef(new Map<string, AbortController>())
  const subscribedRuns = useRef(new Set<string>())
  // 用户主动停止的 run:SSE 本地中止后,subscribeRun 的 .catch 据此把消息标「已停止」而非「错误」。
  const stoppedRuns = useRef(new Set<string>())
  const loadedHistory = useRef(new Set<string>())

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  // 斜杠命令的对话内反馈行:像 Claude Code/Codex 那样在消息流里留一条 system 提示(本地、不持久化)。
  // 无活跃会话时退化为 toast。
  const pushNotice = useCallback((text: string) => {
    const sid = activeIdRef.current
    if (!sid) { toast(text); return }
    setMessagesBySession((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] || []), {
        id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'system' as const, content: text, status: 'done' as const, timestamp: Date.now(),
      }],
    }))
  }, [toast])

  // ── 消息更新助手 ──
  const patchMessage = useCallback((sessionId: string, messageId: string, fn: (m: UiMessage) => UiMessage) => {
    setMessagesBySession((prev) => {
      const list = prev[sessionId]
      if (!list) return prev
      const i = list.findIndex((m) => m.id === messageId)
      if (i < 0) return prev
      const next = list.slice()
      next[i] = fn(next[i])
      return { ...prev, [sessionId]: next }
    })
  }, [])

  const endRun = useCallback((sessionId: string, runId: string) => {
    runAborts.current.delete(runId)
    subscribedRuns.current.delete(runId)
    stoppedRuns.current.delete(runId)
    setRunningBySession((prev) => {
      if (prev[sessionId] !== runId) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (activeIdRef.current !== sessionId) {
      setUnread((prev) => {
        const next = new Set(prev)
        next.add(sessionId)
        saveUnread(next)
        return next
      })
    }
  }, [])

  // run 完成后 Historian 异步可能改了标题——经 ref 延迟刷新会话列表(避免 reduceEvent 依赖后定义的 refreshSessions)。
  const refreshSessionsRef = useRef<((c: TanguDesktopConfig) => Promise<unknown>) | null>(null)

  // ── SSE 事件归约 ──
  const reduceEvent = useCallback((sessionId: string, runId: string, assistantRef: { current: string }, ev: AgentRunEvent) => {
    const pl = ev.payload || {}
    // 当前正在累积的助手消息 id;turn_boundary(运行时转向)会把它推进到新段,后续 token/工具事件自动落到新段。
    const assistantId = assistantRef.current
    switch (ev.type) {
      case 'token':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, content: m.content + (pl.delta || '') }))
        break
      case 'reasoning':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, reasoning: (m.reasoning || '') + (pl.delta || '') }))
        break
      case 'tool_stream':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          if (i >= 0) evs[i] = { ...evs[i], arguments: (evs[i].arguments || '') + (pl.delta || '') }
          else evs.push({ id: pl.id, name: pl.name || 'tool', arguments: pl.delta || '', done: false })
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_call':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          const item = { id: pl.id, name: pl.name, arguments: pl.arguments, done: false, startedAt: pl.startedAt, parallelGroup: pl.parallelGroup }
          if (i >= 0) evs[i] = { ...evs[i], ...item }
          else evs.push(item)
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_result':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          if (i >= 0) {
            evs[i] = {
              ...evs[i],
              result: String(pl.result ?? ''),
              isError: !!pl.isError,
              done: true,
              startedAt: pl.startedAt ?? evs[i].startedAt,
              elapsedMs: pl.elapsedMs,
              outputChars: pl.outputChars,
              parallelGroup: pl.parallelGroup ?? evs[i].parallelGroup,
              artifactPath: pl.artifactPath,
            }
          }
          return { ...m, toolEvents: evs }
        })
        break
      case 'approval_request':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          approvals: [
            ...(m.approvals || []),
            {
              approvalId: pl.approvalId, runId, name: pl.name,
              arguments: pl.arguments, preview: pl.preview || '', status: 'pending' as const,
            },
          ],
        }))
        break
      case 'approval_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          approvals: (m.approvals || []).map((a) =>
            a.approvalId === pl.approvalId
              ? { ...a, status: pl.action === 'reject' ? ('rejected' as const) : ('approved' as const) }
              : a,
          ),
        }))
        break
      case 'inquiry_request': {
        const inq = {
          inquiryId: pl.inquiryId, runId, question: pl.question || '',
          options: Array.isArray(pl.options) ? pl.options : [], status: 'pending' as const,
        }
        const gref = assistantRef as GroupRef
        if (gref.group && gref.groupEnded) {
          // 群聊「是否总结」:讨论已结束 → 独立底部气泡(主持人身份),用户答「是」则总结复用本气泡。
          const id = `grp-inq-${pl.inquiryId}`
          gref.current = id
          gref.reuseNext = true
          setMessagesBySession((prev) => ({
            ...prev,
            [sessionId]: [...(prev[sessionId] || []), {
              id, role: 'assistant' as const, content: '', status: 'done' as const, timestamp: Date.now(),
              agentId: '__host__', agentName: '主持人', agentColor: groupColor('__host__'), inquiries: [inq],
            }],
          }))
        } else {
          // 普通 ask_user(含群聊发言人轮内提问):挂到当前发言气泡。
          patchMessage(sessionId, assistantId, (m) => ({ ...m, inquiries: [...(m.inquiries || []), inq] }))
        }
        break
      }
      case 'inquiry_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          inquiries: (m.inquiries || []).map((q) =>
            q.inquiryId === pl.inquiryId ? { ...q, status: 'answered' as const, answer: String(pl.answer ?? '') } : q,
          ),
        }))
        break
      case 'plan':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, planProposal: String(pl.plan || '') }))
        break
      case 'todo':
        // 任务清单整单替换(todo_write 工具 → todo 事件);渲染为 todolist。
        patchMessage(sessionId, assistantId, (m) => ({ ...m, todos: Array.isArray(pl.todos) ? pl.todos : [] }))
        break
      case 'plan_approved':
        // 服务端已把会话 agent_config.planMode 落库为 false;同步本地状态(输入栏开关复位)
        setConfigBySession((prev) => ({
          ...prev,
          [sessionId]: { ...(prev[sessionId] || {}), planMode: false },
        }))
        if (pl.file) toast(t('app.planArchived', { file: pl.file }))
        break
      case 'group_speaker': {
        // 群聊发言人切换:首位发言人复用 send 建的空占位气泡;reuseNext(总结提问后)复用问句气泡;
        // 其余新建一条发言气泡并推进 assistantRef。(ref.current 在事件处理体内推进,与 turn_boundary 同款,StrictMode 安全。)
        const ref = assistantRef as GroupRef
        ref.group = true
        const slug = String(pl.slug || '')
        const name = String(pl.name || slug)
        const round = Number(pl.round) || 0
        const color = groupColor(slug)
        if (pl.phase === 'start') {
          if (!ref.groupSeen || ref.reuseNext) {
            ref.groupSeen = true
            ref.reuseNext = false
            patchMessage(sessionId, ref.current, (m) => ({ ...m, agentId: slug, agentName: name, agentColor: color, groupRound: round, status: 'streaming' }))
          } else {
            const newId = `grp-${slug}-${round}-${Date.now()}`
            ref.current = newId
            setMessagesBySession((prev) => ({
              ...prev,
              [sessionId]: [...(prev[sessionId] || []), { id: newId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), agentId: slug, agentName: name, agentColor: color, groupRound: round }],
            }))
          }
        } else if (pl.phase === 'end') {
          patchMessage(sessionId, ref.current, (m) => ({ ...m, status: 'done' }))
        }
        break
      }
      case 'group_vote': {
        const votes = Array.isArray(pl.votes) ? pl.votes : []
        setMessagesBySession((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] || []), {
            id: `vote-${pl.round}-${Date.now()}`, role: 'system', content: '', status: 'done', timestamp: Date.now(),
            groupVote: { round: Number(pl.round) || 0, endCount: Number(pl.endCount) || 0, total: Number(pl.total) || votes.length, votes },
          }],
        }))
        break
      }
      case 'group_ended': {
        (assistantRef as GroupRef).groupEnded = true // 之后的「是否总结」询问走底部独立气泡
        const reasonMap: Record<string, string> = {
          vote: t('group.ended.vote'), max_rounds: t('group.ended.maxRounds'),
          cost_limit: t('group.ended.costLimit'), quota: t('group.ended.quota'),
        }
        const reason = reasonMap[String(pl.reason)] || t('group.ended.default')
        setMessagesBySession((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] || []), {
            id: `ended-${Date.now()}`, role: 'system', content: t('group.ended.line', { rounds: Number(pl.rounds) || 0, reason }), status: 'done', timestamp: Date.now(),
          }],
        }))
        break
      }
      case 'usage':
        // ctx=本轮真实 prompt(占比);live=本 run 累计 tokens。会话消耗 = base + live。
        setUsageBySession((prev) => {
          const u = prev[sessionId] || { ctx: 0, base: 0, live: 0 }
          return { ...prev, [sessionId]: { ctx: pl.prompt || u.ctx, base: u.base, live: pl.total || u.live } }
        })
        break
      case 'turn_boundary': {
        // 运行时转向回合切分:关闭(空段则丢弃)当前助手段 A → 插入用户消息 U → 开新流式助手段 B,
        // 并把后续 token/工具事件路由到 B(推进 assistantRef.current)。U/B 按 id 去重(send 已乐观插了 U)。
        const finalizedId = pl.finalizedAssistantId
        const newId = pl.newAssistantId
        const users: Array<{ id: string; content: string }> = Array.isArray(pl.userMessages) ? pl.userMessages : []
        setMessagesBySession((prev) => {
          const list = prev[sessionId] || []
          const have = new Set(list.map((m) => m.id))
          const next = list
            .map((m) => (m.id === finalizedId
              ? { ...m, content: pl.finalizedContent || m.content, status: 'done' as const }
              : m))
            // A 完全空(刚开跑就转向)→ 丢弃,不留空气泡;有正文或工具事件则保留。
            .filter((m) => !(m.id === finalizedId && !m.content.trim() && !(m.toolEvents?.length)))
          const additions: UiMessage[] = []
          for (const u of users) {
            if (!have.has(u.id)) additions.push({ id: u.id, role: 'user', content: u.content, status: 'done', timestamp: Date.now() })
          }
          if (newId && !have.has(newId)) additions.push({ id: newId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() + 1 })
          return { ...prev, [sessionId]: [...next, ...additions] }
        })
        if (newId) assistantRef.current = newId
        break
      }
      case 'done':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          content: pl.content || m.content,
          status: 'done' as const,
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        // run 结束:把本 run 的 live 累计并入 base(与持久化的 agent_runs.tokens_total 一致),live 归零。
        setUsageBySession((prev) => {
          const u = prev[sessionId]
          if (!u) return prev
          return { ...prev, [sessionId]: { ctx: u.ctx, base: u.base + u.live, live: 0 } }
        })
        endRun(sessionId, runId)
        // Historian(若开启)在 run 完成后异步总结标题/写记忆——延迟刷新会话列表反映新标题。
        setTimeout(() => { void refreshSessionsRef.current?.(cfgRef.current).catch(() => {}) }, 6000)
        break
      case 'error':
        // 中止(aborted)与真错误分开:中止保留后端落库的部分正文 + 标「已停止」,不显示成失败。
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          content: pl.content || m.content,
          status: pl.aborted ? ('stopped' as const) : ('error' as const),
          error: pl.aborted ? undefined : (pl.error || 'error'),
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        endRun(sessionId, runId)
        break
      default:
        break
    }
  }, [patchMessage, endRun, toast, t])

  const subscribeRun = useCallback(
    (sessionId: string, runId: string, assistantId: string) => {
      if (subscribedRuns.current.has(runId)) return
      subscribedRuns.current.add(runId)
      const ac = new AbortController()
      runAborts.current.set(runId, ac)
      // 可变盒:turn_boundary(运行时转向)会推进当前助手段 id,后续 token/工具事件自动落到新段。
      const assistantRef = { current: assistantId }
      setRunningBySession((prev) => ({ ...prev, [sessionId]: runId }))
      void subscribeRunEvents(cfgRef.current, runId, (ev) => reduceEvent(sessionId, runId, assistantRef, ev), ac.signal)
        .catch((e) => {
          // 用户主动停止 → 本地中止 SSE 会走到这里;stop() 已把消息收尾为「已停止」,不要再标错误。
          if (!stoppedRuns.current.has(runId)) {
            patchMessage(sessionId, assistantRef.current, (m) => ({ ...m, status: 'error', error: e?.message || t('app.eventStreamInterrupted') }))
          }
          endRun(sessionId, runId)
        })
    },
    [reduceEvent, endRun, patchMessage, t],
  )

  // ── 启动:配置 → 连接 → 会话列表 ──
  const refreshSessions = useCallback(async (c: TanguDesktopConfig) => {
    const [act, arch] = await Promise.all([api.listSessions(c, false), api.listSessions(c, true)])
    setSessions(act)
    setArchivedSessions(arch)
    return act
  }, [])
  refreshSessionsRef.current = refreshSessions // 供 reduceEvent('done') 延迟刷新用

  const connect = useCallback(async (c: TanguDesktopConfig) => {
    const r = await testConnection(c)
    setConnState(r.ok ? 'ok' : 'err')
    setConnMessage(r.message)
    if (!r.ok) return
    try {
      const act = await refreshSessions(c)
      setActiveId((cur) => (cur && act.some((s) => s.id === cur) ? cur : (act[0]?.id ?? null)))
    } catch (e: any) {
      toast(t('app.sessionListLoadFail', { e: e?.message || e }), true)
    }
    // 模型目录(输入栏会话内切换器用);失败静默,选择器自动隐藏。
    void api.listModels(c).then(setModelsResp).catch(() => setModelsResp(null))
    // 技能目录(斜杠命令 /skill:* 用);失败静默。
    void api.listSkills(c).then(setSkillsList).catch(() => setSkillsList(null))
    // 本地 Normal Agent 目录(斜杠 /agent:* 用;云端 404 → 空)。
    void api.listAgents(c).then(setAgentDefs).catch(() => setAgentDefs([]))
    // 外部 agent 引擎(host-only;云端 → 空 → 输入栏不显示引擎选择器)。
    void api.listEngines(c).then(setEngines).catch(() => setEngines([]))
    // Special Agents 开关(侧栏入口显隐;云端 hostExec=false → 404 → 全 false)。
    void refreshSpecialEnabled(c)
  }, [refreshSessions, toast, t])

  // Special Agents 开关刷新(connect 后 + 设置关闭后调用,使侧栏入口即时反映开关)。
  const refreshSpecialEnabled = useCallback(async (c: TanguDesktopConfig) => {
    try {
      const r = await api.getSpecialConfig(c)
      setSpecialEnabled({ historian: !!r.config?.historian?.enabled, muse: !!r.config?.muse?.enabled })
    } catch {
      setSpecialEnabled({ historian: false, muse: false })
    }
  }, [])

  // 正在查看的 Special Agent / 微信远程 被关掉 → 退出其视图,避免停留在死视图。
  useEffect(() => {
    if (specialView === 'agents' && !specialEnabled.historian && !specialEnabled.muse) setSpecialView(null)
    const wechatOn = !!window.tangu?.backendStatus && desktopConfig?.wechatEnabled !== false
    if (specialView === 'wechat' && !wechatOn) setSpecialView(null)
  }, [specialEnabled, specialView, desktopConfig?.wechatEnabled])

  useEffect(() => {
    void (async () => {
      const stored = await window.tangu?.getConfig()
      setDesktopConfig(stored || null)
      desktopMode.current = stored?.mode ?? null
      homeDirRef.current = stored?.homeDir
      defaultWsDirRef.current = stored?.defaultWorkspaceDir || ''
      setDefaultWsDir(stored?.defaultWorkspaceDir || '')
      const merged = {
        backendUrl: stored?.backendUrl || cfgRef.current.backendUrl,
        token: stored?.token ?? cfgRef.current.token,
        modelId: stored?.modelId ?? cfgRef.current.modelId,
      }
      setCfg(merged)
      setCfgLoaded(true)
      if (stored?.mode === 'managed') {
        // 托管后端:**就绪才连**(此时 merged 已是 effectiveConfig 折算后的子进程 url/token)。
        // 未就绪别用 stale 默认配置硬连(会误报「未连接」,且后端随后就绪的 ready 事件若错过就一直卡着——
        // 正是「启动后显示未连接、去设置重启才好」的根因);改为显示「启动中」,等下方 onBackendStatus 的 ready。
        if (stored.backendState?.state === 'ready') void connect(merged)
        else { setConnState('idle'); setConnMessage(t('app.managedBackendStarting')) }
      } else if (merged.token) {
        void connect(merged)
      }
      // 首启引导:桌面端「从未配置凭证」(未登录、无 token、无直连 provider,且未跳过过)→ 进向导。
      // cloudUrl 不参与判定:它可由 ~/.tangu/.env(TANGU_CLOUD_URL)预配,有地址没登录仍要引导。
      if (stored && window.tangu?.envCheck) {
        try {
          if (!localStorage.getItem(ONBOARDING_DISMISS_KEY)
            && !stored.cloudToken && !stored.token) {
            const [auth, provs] = await Promise.all([
              window.tangu.authStatus?.().catch(() => null) ?? null,
              window.tangu.listProviders?.().catch(() => []) ?? [],
            ])
            if (!auth?.loggedIn && !(provs && provs.length)) setOnboarding(true)
          }
        } catch { /* 引导判定失败不阻断 */ }
      }
    })()
    // managed 后端状态推送:就绪 → 取折算配置重连;崩溃 → 标离线。
    const off = window.tangu?.onBackendStatus?.((st) => {
      if (st.state === 'ready') {
        void window.tangu!.getConfig().then((c) => {
          setDesktopConfig(c)
          const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
          setCfg(eff)
          void connect(eff)
        })
      } else if (st.state === 'starting') {
        setConnState('idle')
        setConnMessage(t('app.managedBackendStarting'))
      } else if (st.state === 'crashed') {
        setConnState('err')
        setConnMessage(st.lastError || t('app.managedBackendExited'))
      }
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 选中会话:懒加载历史 + 恢复在飞 run + 清未读 ──
  useEffect(() => {
    if (!activeId || connState !== 'ok') return
    setUnread((prev) => {
      if (!prev.has(activeId)) return prev
      const next = new Set(prev)
      next.delete(activeId)
      saveUnread(next)
      return next
    })
    if (loadedHistory.current.has(activeId)) return
    loadedHistory.current.add(activeId)
    void (async () => {
      try {
        const [records, config, active] = await Promise.all([
          api.listMessages(cfgRef.current, activeId),
          api.getSessionConfig(cfgRef.current, activeId).catch(() => ({} as AgentConfig)),
          listActiveRuns(cfgRef.current, activeId),
        ])
        setConfigBySession((prev) => ({ ...prev, [activeId]: config }))
        // 会话累计 token 作 base 种子(跨 run 求和);失败不阻断。
        void api.getSessionUsage(cfgRef.current, activeId)
          .then((base) => setUsageBySession((prev) => ({ ...prev, [activeId]: { ctx: prev[activeId]?.ctx || 0, base, live: 0 } })))
          .catch(() => {})
        setMessagesBySession((prev) => {
          // SSE 已在写的消息(本地比远端新)保留
          const existing = prev[activeId] || []
          const ui = records.map(recordToUi)
          const byId = new Map(ui.map((m) => [m.id, m] as const))
          for (const m of existing) byId.set(m.id, m)
          return { ...prev, [activeId]: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp) }
        })
        // 恢复订阅在飞 run(刷新/重启后)
        for (const run of active) {
          if ((run.status === 'running' || run.status === 'queued') && run.assistant_message_id) {
            const amid = run.assistant_message_id
            setMessagesBySession((prev) => {
              const list = prev[activeId] || []
              if (list.some((m) => m.id === amid)) return prev
              return {
                ...prev,
                [activeId]: [...list, { id: amid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }],
              }
            })
            subscribeRun(activeId, run.id, amid)
          }
        }
      } catch (e: any) {
        loadedHistory.current.delete(activeId)
        toast(t('app.historyLoadFail', { e: e?.message || e }), true)
      }
    })()
  }, [activeId, connState, subscribeRun, toast, t])

  // ── 活跃会话消息轮询(每 4s)──
  // 拉入「带外」写入的新消息(典型:微信 bot 收到消息后由后端跑的会话,本端没订阅其 run),
  // 并订阅外部启动、本端尚未订阅的在飞 run,使回复实时流式呈现——无需手动刷新页面。
  // 本地正在 streaming(runningRef 有值)时跳过本会话拉取,交给 SSE,避免抢写。
  useEffect(() => {
    if (!activeId || connState !== 'ok') return
    let alive = true
    const poll = async (): Promise<void> => {
      const sid = activeIdRef.current
      if (!sid || sid !== activeId || runningRef.current[sid]) return
      try {
        const [records, active] = await Promise.all([
          api.listMessages(cfgRef.current, sid),
          listActiveRuns(cfgRef.current, sid).catch(() => []),
        ])
        if (!alive || activeIdRef.current !== sid || runningRef.current[sid]) return
        setMessagesBySession((prev) => {
          const existing = prev[sid] || []
          const ui = records.map(recordToUi)
          const byId = new Map(ui.map((m) => [m.id, m] as const))
          // 本地版本优先(与初次加载一致):保留 SSE 累积、而 recordToUi 不重建的富状态
          // ——toolEvents/approvals/inquiries/todos/planProposal/system 提示/乐观消息。
          // 仅服务端「新增」的消息(新 id,典型:微信 bot 触发的往来)会被纳入。
          for (const m of existing) byId.set(m.id, m)
          const merged = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
          // 引用级比对:无新增/删除时元素引用全等 → 不触发重渲染(避免轮询把聊天区吸底/抖动)。
          if (merged.length === existing.length && merged.every((m, i) => m === existing[i])) return prev
          return { ...prev, [sid]: merged }
        })
        for (const run of active) {
          if ((run.status === 'running' || run.status === 'queued') && run.assistant_message_id && !subscribedRuns.current.has(run.id)) {
            const amid = run.assistant_message_id
            setMessagesBySession((prev) => {
              const list = prev[sid] || []
              if (list.some((m) => m.id === amid)) return prev
              return { ...prev, [sid]: [...list, { id: amid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }] }
            })
            subscribeRun(sid, run.id, amid)
          }
        }
      } catch { /* 轮询失败静默,下次再试 */ }
    }
    const timer = window.setInterval(() => void poll(), 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [activeId, connState, subscribeRun])

  // ── 设置打开期间轮询 Special Agents 开关(每 2.5s)──
  // 在设置里开/关 Historian/Muse 后,侧栏入口即时显隐(侧栏始终可见),无需刷新页面。
  useEffect(() => {
    if (!settingsOpen || connState !== 'ok') return
    const timer = window.setInterval(() => { void refreshSpecialEnabled(cfgRef.current) }, 2500)
    return () => window.clearInterval(timer)
  }, [settingsOpen, connState, refreshSpecialEnabled])

  // ── 工作区 / 会话操作 ──
  /** 默认本地工作区(Tangu 默认工作区;cwd=defaultWsDir,空时回退主目录)。 */
  const defaultWorkspace = useCallback((): WorkspaceDescriptor => ({
    key: defaultWsDirRef.current || '__default_ws__',
    name: t('app.defaultWorkspace'),
    kind: 'local',
    path: defaultWsDirRef.current || homeDirRef.current || null,
  }), [t])

  /** 工作区列表:Cloud + Tangu 默认 常驻(空也在),再并入会话出现过的其它本地目录。 */
  const workspaces = useMemo<WorkspaceDescriptor[]>(() => {
    const defPath = defaultWsDir || homeDirRef.current || null
    const wechatOn = !!window.tangu?.backendStatus && desktopConfig?.wechatEnabled !== false
    const webotPath = defPath ? `${defPath}/webot` : null
    const list: WorkspaceDescriptor[] = [
      { key: CLOUD_WORKSPACE_KEY, name: t('app.cloudWorkspace'), kind: 'cloud', path: null, system: true },
      { key: defaultWsDir || '__default_ws__', name: t('app.defaultWorkspace'), kind: 'local', path: defPath, system: true },
    ]
    const seen = new Set<string>([CLOUD_WORKSPACE_KEY, defaultWsDir || '__default_ws__'])
    // 「微信远程」专属 Project(~/Tangu/webot):常驻工作区组,点组名进 WeChatView 设置/连接。
    if (wechatOn && webotPath) {
      list.push({ key: webotPath, name: t('app.wechatWorkspace'), kind: 'wechat', path: webotPath, system: true })
      seen.add(webotPath)
    }
    for (const s of [...sessions, ...archivedSessions]) {
      if (s.project_path && s.project_path !== defPath && !seen.has(s.project_path)) {
        seen.add(s.project_path)
        list.push({
          key: s.project_path,
          name: s.project_name || s.project_path.split('/').filter(Boolean).pop() || t('app.workspace'),
          kind: 'local',
          path: s.project_path,
        })
      }
    }
    return list
  }, [sessions, archivedSessions, defaultWsDir, t, desktopConfig?.wechatEnabled])

  /** 在工作区下新建会话:cloud→云沙箱;本地→host + cwd=工作区目录 + 自动编辑审批档。 */
  const createInWorkspace = useCallback(async (ws: WorkspaceDescriptor) => {
    try {
      const path = ws.kind === 'local' ? (ws.path || defaultWsDirRef.current || homeDirRef.current || null) : null
      const s = await api.createSession(cfgRef.current, path
        ? { project_path: path, project_name: ws.name }
        : undefined)
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      loadedHistory.current.add(s.id)
      setMessagesBySession((prev) => ({ ...prev, [s.id]: [] }))
      const init: AgentConfig = path
        ? { execMode: 'host', approvalMode: 'auto-edit', cwd: path }
        : { execMode: 'sandbox' }
      setConfigBySession((prev) => ({ ...prev, [s.id]: init }))
      void api.putSessionConfig(cfgRef.current, s.id, init).catch(() => {})
    } catch (e: any) {
      toast(t('app.createSessionFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  /** 新建会话(默认进 Tangu 默认工作区;Ctrl/Cmd+N 与输入栏 /new 用)。 */
  const newSession = useCallback(() => {
    void createInWorkspace(defaultWorkspace())
  }, [createInWorkspace, defaultWorkspace])

  /** 浏览文件夹新增本地工作区(选目录 → 直接在其中建会话)。 */
  const addLocalWorkspace = useCallback(async () => {
    const dir = await window.tangu?.pickDirectory?.()
    if (!dir) return
    await createInWorkspace({
      key: dir,
      name: dir.split('/').filter(Boolean).pop() || dir,
      kind: 'local',
      path: dir,
    })
  }, [createInWorkspace])

  const renameSession = useCallback(async (id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    setArchivedSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await api.updateSession(cfgRef.current, id, { title })
    } catch (e: any) {
      toast(t('app.renameFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await api.updateSession(cfgRef.current, id, { archived })
      await refreshSessions(cfgRef.current)
      if (archived && activeIdRef.current === id) setActiveId(null)
    } catch (e: any) {
      toast(t('app.operationFail', { e: e?.message || e }), true)
    }
  }, [refreshSessions, toast, t])

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(cfgRef.current, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setArchivedSessions((prev) => prev.filter((s) => s.id !== id))
      loadedHistory.current.delete(id)
      if (activeIdRef.current === id) setActiveId(null)
    } catch (e: any) {
      toast(t('app.deleteFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  // 重命名工作区:工作区名派生自其会话的 project_name → 给该 project_path 下所有会话改名(系统区不可改)。
  const renameWorkspace = useCallback(async (ws: WorkspaceDescriptor, name: string) => {
    const newName = name.trim().slice(0, 255)
    if (!newName || ws.system || ws.kind !== 'local') return
    const targets = [...sessions, ...archivedSessions].filter((s) => s.project_path === ws.key)
    if (!targets.length || newName === ws.name) return
    setSessions((prev) => prev.map((s) => (s.project_path === ws.key ? { ...s, project_name: newName } : s)))
    setArchivedSessions((prev) => prev.map((s) => (s.project_path === ws.key ? { ...s, project_name: newName } : s)))
    try {
      await Promise.all(targets.map((s) => api.updateSession(cfgRef.current, s.id, { project_name: newName })))
    } catch (e: any) {
      toast(t('app.wsRenameFail', { e: e?.message || e }), true)
    }
  }, [sessions, archivedSessions, toast, t])

  // 移除工作区:删除该 project_path 下所有会话(磁盘文件夹不动)。工作区由会话派生,清空即从侧栏消失。
  const removeWorkspace = useCallback(async (ws: WorkspaceDescriptor) => {
    if (ws.system || ws.kind !== 'local') return
    const targets = [...sessions, ...archivedSessions].filter((s) => s.project_path === ws.key)
    if (!targets.length) return
    try {
      // 不吞错:任一删除失败 → 整体进 catch,不乐观删本地、不报成功。
      await Promise.all(targets.map((s) => api.deleteSession(cfgRef.current, s.id)))
      const ids = new Set(targets.map((s) => s.id))
      setSessions((prev) => prev.filter((s) => !ids.has(s.id)))
      setArchivedSessions((prev) => prev.filter((s) => !ids.has(s.id)))
      ids.forEach((id) => loadedHistory.current.delete(id))
      if (activeIdRef.current && ids.has(activeIdRef.current)) setActiveId(null)
      toast(t('app.wsRemoved', { name: ws.name }))
    } catch (e: any) {
      // 可能部分成功 → 拉服务端对账(成功的消失、失败的留下),避免「报成功但刷新后复活」。
      toast(t('app.wsRemoveFail', { e: e?.message || e }), true)
      void refreshSessions(cfgRef.current).catch(() => {})
    }
  }, [sessions, archivedSessions, refreshSessions, toast, t])

  // ── 发送 / 停止 / 审批 ──
  const send = useCallback(async (text: string, attachments: Attachment[], workspaceFiles?: Attachment[]): Promise<boolean> => {
    let sid = activeIdRef.current
    const wasNewChat = !sid
    let implicitInit: AgentConfig | null = null
    if (!sid) {
      // 空白新对话:落进 New Chat 选定的 Project(newChatWs);未选则 Tangu 默认工作区(managed)或云沙箱(其余)。
      const ws = newChatWsRef.current
      const path = ws
        ? (ws.kind === 'local' ? (ws.path || defaultWsDirRef.current || homeDirRef.current || null) : null)
        : (desktopMode.current === 'managed' ? (defaultWsDirRef.current || homeDirRef.current || null) : null)
      const s = await api.createSession(cfgRef.current, path
        ? { project_path: path, project_name: ws?.name || t('app.defaultWorkspace') }
        : undefined).catch(() => null)
      if (!s) {
        toast(t('app.cannotCreateSession'), true)
        return false
      }
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      loadedHistory.current.add(s.id)
      sid = s.id
      // 并入空白新对话草稿(审批/计划/思考/技能/agent);execMode/cwd 由 Project 决定,权威覆盖。
      const draft = newChatCfgRef.current
      implicitInit = path
        ? { ...draft, execMode: 'host', approvalMode: draft.approvalMode || 'auto-edit', cwd: path }
        : { ...draft, execMode: 'sandbox', cwd: undefined }
      setConfigBySession((prev) => ({ ...prev, [s.id]: implicitInit! }))
      void api.putSessionConfig(cfgRef.current, s.id, implicitInit).catch(() => {})
      // 草稿模型落到新会话(否则首条用全局默认)。
      if (newChatModelRef.current) {
        const m = newChatModelRef.current
        setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, model_id: m } : x)))
        void api.updateSession(cfgRef.current, s.id, { model_id: m }).catch(() => {})
      }
    }
    const sessionId = sid
    const agentConfig = { ...(implicitInit || configBySession[sessionId] || {}) }
    // 云沙箱拖入的文件:发送前先上传到会话工作区(agent run 时即可 list/read)。
    if (workspaceFiles?.length) {
      try {
        await api.uploadWorkspaceFiles(cfgRef.current, sessionId, workspaceFiles.map((f) => ({
          path: f.name, content: f.data, encoding: 'base64' as const, mimeType: f.mimeType,
        })))
        toast(t('app.filesUploaded', { count: workspaceFiles.length }))
      } catch (e: any) {
        toast(t('app.workspaceUploadFail', { e: e?.message || e }), true)
      }
    }
    // 运行中再发 → 运行时转向:注入当前 run(下一迭代边界生效),而非另起新 run。runningRef 取实时状态。
    const activeRunId = runningRef.current[sessionId]
    if (activeRunId) {
      try {
        const sr = await steerRun(cfgRef.current, activeRunId, { message: text, attachments })
        if (sr.ok) {
          // 乐观插入用户气泡;后端 turn_boundary 事件会按同一 id 去重,并在其后开新助手段。
          setMessagesBySession((prev) => ({
            ...prev,
            [sessionId]: [
              ...(prev[sessionId] || []),
              { id: sr.userMessageId || `u-${Date.now()}`, role: 'user', content: text, attachments, status: 'done', timestamp: Date.now() },
            ],
          }))
          return true
        }
        // not_active:run 在我们发出前刚结束 → 落到下方起新 run。
      } catch (e: any) {
        toast(t('app.sendFail', { e: e?.message || e }), true)
        return false
      }
    }
    // 会话级模型(输入栏切换器持久化在 session.model_id)优先于全局默认。
    const sessionModelId = wasNewChat
      ? (newChatModelRef.current || undefined)
      : (sessions.find((s) => s.id === sessionId)?.model_id || undefined)
    try {
      const r = await startRun(cfgRef.current, { sessionId, message: text, modelId: sessionModelId, attachments, agentConfig })
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] || []),
          { id: r.userMessageId, role: 'user', content: text, attachments, status: 'done', timestamp: Date.now() },
          { id: r.assistantMessageId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() + 1 },
        ],
      }))
      subscribeRun(sessionId, r.runId, r.assistantMessageId)
      // 新 run 起步:live 归零(base 保留),usage 事件会重新累计本 run。
      setUsageBySession((prev) => ({ ...prev, [sessionId]: { ctx: prev[sessionId]?.ctx || 0, base: prev[sessionId]?.base || 0, live: 0 } }))
      // 自动命名:首条消息给 New Chat 改名
      const sess = sessions.find((s) => s.id === sessionId)
      if (sess && (!sess.title || sess.title === 'New Chat')) {
        void renameSession(sessionId, text.slice(0, 30))
      }
      return true
    } catch (e: any) {
      toast(t('app.sendFail', { e: e?.message || e }), true)
      return false
    }
  }, [configBySession, sessions, subscribeRun, renameSession, toast, t])

  const stop = useCallback(() => {
    const sid = activeIdRef.current
    if (!sid) return
    const runId = runningBySession[sid]
    if (!runId) return
    stoppedRuns.current.add(runId)                        // 标记主动停止 → SSE catch 不报错
    void abortRun(cfgRef.current, runId).catch(() => {})  // 让后端真正取消并落库部分输出(供后续轮次读取)
    runAborts.current.get(runId)?.abort()                 // 立即停本地 SSE,按钮即时生效(不再「按了不停」)
    // 乐观:把当前流式消息原地收尾为「已停止」,保留已流出的部分内容(不再凭空消失)。
    setMessagesBySession((prev) => {
      const list = prev[sid]
      if (!list) return prev
      return { ...prev, [sid]: list.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' as const } : m)) }
    })
    endRun(sid, runId)
  }, [runningBySession, endRun])

  // 截断会话消息(从 fromIndex 起,含)后以给定文本重发:编辑重发 / 重新生成的公共底座。
  // 服务端每轮从 DB 全量重建上下文,故必须先删旧消息再发新 run,否则被截断的旧轮次仍会污染生成。
  // 先删服务端(失败则本地不动、不重发),成功后本地同步截断 + send(send 用函数式 append,接在截断后列表之后)。
  const truncateAndResend = useCallback(async (fromIndex: number, text: string, attachments: Attachment[]) => {
    const sid = activeIdRef.current
    if (!sid) return
    const list = messagesBySession[sid] || []
    if (fromIndex < 0 || fromIndex >= list.length) return
    const removed = list.slice(fromIndex) // 留快照:send 起不来时恢复本地显示,避免静默丢失对话尾巴
    try {
      await api.deleteMessages(cfgRef.current, sid, removed.map((m) => m.id))
    } catch (e: any) {
      toast(t('app.truncateFail', { e: e?.message || e }), true)
      return
    }
    setMessagesBySession((prev) => ({ ...prev, [sid]: (prev[sid] || []).slice(0, fromIndex) }))
    const ok = await send(text, attachments)
    if (!ok) {
      // 服务端已删但新 run 没起来:恢复本地尾巴(暂与服务端不一致,reload 以服务端为准),让用户看到内容并重试。
      setMessagesBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] || []).slice(0, fromIndex), ...removed] }))
      toast(t('app.resendFailed'), true)
    }
  }, [messagesBySession, send, toast, t])

  // 编辑用户消息并重发:从该消息处截断(含),以编辑后的文本(沿用原附件)重跑。
  const editUserMessage = useCallback((messageId: string, newText: string) => {
    const sid = activeIdRef.current
    if (!sid || runningBySession[sid]) return
    const list = messagesBySession[sid] || []
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx < 0 || list[idx].role !== 'user') return
    void truncateAndResend(idx, newText, list[idx].attachments || [])
  }, [messagesBySession, runningBySession, truncateAndResend])

  // 重新生成助手消息:回退到其上一条用户消息处截断(含该用户消息),以原输入重跑(丢弃其后的轮次)。
  const regenerate = useCallback((messageId: string) => {
    const sid = activeIdRef.current
    if (!sid || runningBySession[sid]) return
    const list = messagesBySession[sid] || []
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    let u = idx - 1
    while (u >= 0 && list[u].role !== 'user') u--
    if (u < 0) { toast(t('app.regenNoUser'), true); return }
    void truncateAndResend(u, list[u].content, list[u].attachments || [])
  }, [messagesBySession, runningBySession, truncateAndResend, toast, t])

  // 手动压缩上下文(/compact 或输入栏按钮):生成持久化总结检查点,后续 run 起步即精简。
  const compact = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) return
    const modelId = sessions.find((s) => s.id === sid)?.model_id || cfgRef.current.modelId || modelsResp?.defaultModelId || ''
    toast(t('input.compacting'))
    try {
      const r = await api.compactSession(cfgRef.current, sid, modelId)
      pushNotice(r.ok ? t('input.compactDone', { n: r.summarizedCount || 0 }) : t('input.compactSkip', { reason: r.reason || '' }))
    } catch (e: any) {
      toast(t('input.compactFail', { e: e?.message || e }), true)
    }
  }, [sessions, modelsResp, toast, pushNotice, t])

  const decideApproval = useCallback(
    async (messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => {
      const sid = activeIdRef.current
      if (!sid) return
      // runId 取自审批对象本身(approval_request 事件已带),不依赖易失的 runningBySession
      // (run 结束/切会话后仍可兑现,服务端对过期审批回 410)。
      const approval = (messagesBySession[sid] || [])
        .find((m) => m.id === messageId)
        ?.approvals?.find((a) => a.approvalId === approvalId)
      if (!approval?.runId) return
      const r = await resolveApproval(cfgRef.current, approval.runId, approvalId, action, argsOverride)
      if (r.gone) {
        patchMessage(sid, messageId, (m) => ({
          ...m,
          approvals: (m.approvals || []).map((a) => (a.approvalId === approvalId ? { ...a, status: 'expired' as const } : a)),
        }))
      }
    },
    [messagesBySession, patchMessage],
  )

  const setExecConfig = useCallback((patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), ...patch }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内模型切换:持久化到 session.model_id;无会话时改全局默认。 */
  const setSessionModel = useCallback((modelId: string) => {
    const sid = activeIdRef.current
    if (!sid) {
      setCfg((prev) => {
        void window.tangu?.setConfig({ modelId })
        return { ...prev, modelId }
      })
      return
    }
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model_id: modelId } : s)))
    setArchivedSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model_id: modelId } : s)))
    void api.updateSession(cfgRef.current, sid, { model_id: modelId }).catch((e) => {
      toast(t('app.modelSwitchSaveFail', { e: e?.message || e }), true)
    })
  }, [toast, t])

  /** 会话内思考深度切换:合并进 agent_config.thinkingLevel(agentLoop 每轮 run 读取)。 */
  const setSessionThinking = useCallback((level: NonNullable<AgentConfig['thinkingLevel']>) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), thinkingLevel: level }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内最大循环轮数(/loop <n> 命令):合并进 agent_config.maxIterations(agentLoop 每轮 run 读取,后端 clamp 1-200)。 */
  const setSessionMaxIterations = useCallback((n: number) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), maxIterations: n }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 计划模式开关(输入栏「计划」按钮 / /plan 命令):持久化进 agent_config.planMode。 */
  const setSessionPlanMode = useCallback((on: boolean) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), planMode: on }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 运行引擎选择(输入栏「运行引擎」chip):''=Tangu 自有 loop;否则委托外部 ACP 引擎。持久化进 agent_config.engineId。 */
  const setSessionEngine = useCallback((engineId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      // 切引擎清掉旧的引擎模型选择(对新引擎无意义);选外部引擎则关群聊(二者互斥:外部引擎独占整个 turn)。
      const next = { ...(prev[sid] || {}), engineId: engineId || undefined, engineModelId: undefined, ...(engineId ? { groupChat: false } : {}) }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 外部引擎模型选择(ModelPill):写入 agent_config.engineModelId(run 内经 ACP setSessionModel 应用)。 */
  const setSessionEngineModel = useCallback((engineModelId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), engineModelId: engineModelId || undefined }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  // 选了外部引擎 → 懒拉能力(模型/命令)填选择器;按 engineId 缓存,只拉一次(首次 spawn 慢)。
  const curEngineId = activeId ? configBySession[activeId]?.engineId : newChatCfg.engineId
  // 当前会话所用 agent 名(仅外部引擎显示在头部;Tangu 内置不显示)。
  const curEngineName = curEngineId ? (engines.find((e) => e.id === curEngineId)?.name || '') : ''
  // 仅「已检测到」的第三方引擎进新会话选择器(未装/未登录的不显示)。
  const availableEngines = engines.filter((e) => e.available)
  useEffect(() => {
    if (!curEngineId || engineCaps[curEngineId]) return
    let cancelled = false
    void api.getEngineCapabilities(cfgRef.current, curEngineId).then((caps) => {
      if (!cancelled) setEngineCaps((p) => ({ ...p, [curEngineId]: caps }))
    })
    return () => { cancelled = true }
  }, [curEngineId, engineCaps])

  /** 群聊模式配置(输入栏「群聊」浮层):合并进 agent_config 的 group* 字段(agentLoop 起 run 时读取)。 */
  const setSessionGroup = useCallback((patch: Pick<AgentConfig, 'groupChat' | 'groupAgents' | 'groupTempAgents' | 'groupIntensity' | 'groupMaxRounds'>) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), ...patch }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内技能启停(/skill:<id> 斜杠命令):合并进 agent_config.enabledSkillIds。 */
  const toggleSessionSkill = useCallback((skillId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const cur = new Set(prev[sid]?.enabledSkillIds || [])
      cur.has(skillId) ? cur.delete(skillId) : cur.add(skillId)
      const next = { ...(prev[sid] || {}), enabledSkillIds: [...cur] }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
    const willEnable = !(configBySession[sid]?.enabledSkillIds || []).includes(skillId)
    pushNotice(willEnable ? t('app.skillEnabled', { id: skillId }) : t('app.skillDisabled', { id: skillId }))
  }, [configBySession, pushNotice, t])

  /** 会话内选用 Normal Agent(/agent:<slug> 斜杠命令;''=取消):写 agent_config.agentSlug,有模型则应用会话模型。 */
  const selectSessionAgent = useCallback((slug: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    const def = slug ? agentDefs.find((a) => a.slug === slug) : null
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), agentSlug: slug || undefined }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
    if (def?.model) setSessionModel(def.model)
    pushNotice(def ? t('input.agentActive', { name: def.name }) : t('input.agentCleared'))
  }, [agentDefs, setSessionModel, pushNotice, t])

  /** 兑现询问(ask_user/exit_plan_mode 的询问卡)。 */
  const answerInquiry = useCallback(
    async (messageId: string, inquiryId: string, answer: string) => {
      const sid = activeIdRef.current
      if (!sid) return
      const inquiry = (messagesBySession[sid] || [])
        .find((m) => m.id === messageId)
        ?.inquiries?.find((q) => q.inquiryId === inquiryId)
      if (!inquiry?.runId) return
      const r = await resolveInquiry(cfgRef.current, inquiry.runId, inquiryId, answer)
      if (r.gone) {
        patchMessage(sid, messageId, (m) => ({
          ...m,
          inquiries: (m.inquiries || []).map((q) => (q.inquiryId === inquiryId ? { ...q, status: 'expired' as const } : q)),
        }))
      }
    },
    [messagesBySession, patchMessage],
  )

  // ── 设置 ──
  const patchConfig = useCallback((patch: Partial<TanguDesktopConfig>) => {
    setCfg((prev) => {
      const merged = { ...prev, ...patch }
      void window.tangu?.setConfig(patch)
      return merged
    })
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // 设置里可能改了默认工作区目录 → 重读折算值,刷新侧栏工作区。
    void window.tangu?.getConfig().then((c) => {
      setDesktopConfig(c)
      homeDirRef.current = c.homeDir
      defaultWsDirRef.current = c.defaultWorkspaceDir || ''
      setDefaultWsDir(c.defaultWorkspaceDir || '')
    })
    // 设置里可能开/关了 Special Agents → 刷新侧栏入口显隐。
    void refreshSpecialEnabled(cfgRef.current)
  }, [refreshSpecialEnabled])

  // 打开设置,可选定位到具体 tab(无参=默认 connection)。
  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(tab ?? null)
    setSettingsOpen(true)
  }, [])

  const onGlassChange = useCallback((on: boolean) => {
    setGlassOn(on)
    document.documentElement.dataset.glass = on ? 'on' : 'off'
    try { localStorage.setItem('forsion_glass', on ? 'on' : 'off') } catch { /* ignore */ }
  }, [])

  // 快捷键:Cmd/Ctrl+N 新会话,Cmd/Ctrl+, 设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'n') {
        e.preventDefault()
        void newSession()
      }
      if (e.key === ',') {
        e.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession, openSettings])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) || archivedSessions.find((s) => s.id === activeId) || null,
    [sessions, archivedSessions, activeId],
  )
  const activeModel = useMemo(
    () => (modelsResp?.models || []).find((m) => m.id === (activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || '')) || null,
    [modelsResp, activeSession, cfg.modelId],
  )
  const activeUsage = (activeId && usageBySession[activeId]) || { ctx: 0, base: 0, live: 0 }
  const activeMessages = (activeId && messagesBySession[activeId]) || []
  const running = !!(activeId && runningBySession[activeId])
  const runningIds = useMemo(() => new Set(Object.keys(runningBySession)), [runningBySession])
  const execConfig = (activeId && configBySession[activeId]) || {}
  // 空白新对话:无会话配置可依,按选定 Project 推导执行模式(本地→host,显示审批档;云→sandbox)+ 叠加草稿配置。
  const mvCfg: AgentConfig = activeId ? execConfig : {
    execMode: newChatWs?.kind === 'cloud' ? 'sandbox' : 'host',
    approvalMode: 'auto-edit',
    cwd: newChatWs?.kind === 'cloud' ? undefined : (newChatWs?.path || undefined),
    ...newChatCfg,
  }
  const mvModelId = activeId
    ? (activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || '')
    : (newChatModel || cfg.modelId || modelsResp?.defaultModelId || '')
  // 云端会话(沙箱:在云端 Tangu worker 跑)只能用云端(forsion)模型;本地会话(host)用全部
  // (本地后端可直连 provider + 调云端 brain-api)。隔离模型列表:云端会话不再列出选了也无效的本地模型。
  const isCloudSession = mvCfg.execMode === 'sandbox'
  const visibleModels = !modelsResp?.models
    ? null
    : (isCloudSession ? modelsResp.models.filter((m) => m.source === 'forsion') : modelsResp.models)
  const wechatFeatureEnabled = !!window.tangu?.backendStatus && desktopConfig?.wechatEnabled !== false

  if (!cfgLoaded) return <div className="app" />

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        archivedSessions={archivedSessions}
        activeId={activeId}
        runningIds={runningIds}
        unreadIds={unread}
        cfg={cfg}
        modelId={activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || ''}
        activeSession={activeSession}
        onSelect={(id) => { if (settingsOpen) closeSettings(); setSpecialView(null); setActiveId(id); setQuote('') }}
        showSpecial={!!window.tangu?.backendStatus}
        historianEnabled={specialEnabled.historian}
        museEnabled={specialEnabled.muse}
        wechatEnabled={wechatFeatureEnabled}
        specialView={specialView}
        onOpenSpecial={(v) => { if (settingsOpen) closeSettings(); setSpecialView(v) }}
        onNewChat={() => { if (settingsOpen) closeSettings(); setSpecialView(null); setActiveId(null); setNewChatWs(null); setNewChatCfg({}); setNewChatModel(null) }}
        onOpenMemory={() => { if (settingsOpen) closeSettings(); setSpecialView('memory') }}
        onOpenAgentsSettings={() => openSettings('agents')}
        onOpenWorkspace={(wsKey) => { if (settingsOpen) closeSettings(); setDetailWsKey(wsKey); setSpecialView('workspace') }}
        workspaces={workspaces}
        onNewInWorkspace={(ws) => { if (settingsOpen) closeSettings(); setSpecialView(null); void createInWorkspace(ws) }}
        onAddWorkspace={() => void addLocalWorkspace()}
        onRenameWorkspace={(ws, name) => void renameWorkspace(ws, name)}
        onRemoveWorkspace={(ws) => void removeWorkspace(ws)}
        onRename={(id, t) => void renameSession(id, t)}
        onArchive={(id, a) => void archiveSession(id, a)}
        onDelete={(id) => void deleteSession(id)}
        onOpenSettings={() => openSettings()}
        onToast={toast}
        onAuthChange={() => {
          // 登录/登出后托管后端会重启(主进程触发);稍候重连 + 刷新会话/模型。
          setTimeout(() => void connect(cfgRef.current), 1500)
        }}
      />
      <main className="main">
        <ChatHeader
          title={settingsOpen ? t('settings.title') : (activeSession?.title || 'Tangu Agent')}
          engineName={curEngineName}
          connState={connState}
          connMessage={connMessage}
          sidebarCollapsed={sidebarCollapsed}
          rightOpen={!settingsOpen && rightOpen}
          themeMode={themeMode}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onToggleRight={() => { if (!settingsOpen) setRightOpen(!rightOpen) }}
          onToggleMode={() => {
            const m = themeMode === 'dark' ? 'light' : 'dark'
            applyTheme(themePreset, m) // 切换 + 持久化(forsion_theme)
            setThemeMode(m)
          }}
        />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {settingsOpen ? (
            <SettingsModal
              open={settingsOpen}
              initialTab={settingsTab ?? undefined}
              cfg={cfg}
              activeSession={(activeId && sessions.find((s) => s.id === activeId)) || null}
              themePreset={themePreset}
              themeMode={themeMode}
              glassOn={glassOn}
              onClose={closeSettings}
              onConfigChange={patchConfig}
              onThemeChange={(preset, mode) => {
                setThemePreset(preset)
                setThemeMode(mode)
              }}
              onGlassChange={onGlassChange}
              onReconnect={(patch) => void connect({ ...cfgRef.current, ...(patch || {}) })}
              onRelaunchOnboarding={() => {
                closeSettings()
                try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
                setOnboarding(true)
              }}
            />
          ) : onboarding ? (
            <OnboardingWizard
              themePreset={themePreset}
              themeMode={themeMode}
              onThemeChange={(preset, mode) => { setThemePreset(preset); setThemeMode(mode) }}
              onReconnect={() => {
                desktopMode.current = 'managed'
                void window.tangu?.getConfig().then((c) => {
                  const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                  setCfg(eff)
                  void connect(eff)
                })
              }}
              onFinish={() => {
                setOnboarding(false)
                // 引导里可能改了默认工作区目录 → 重读折算值刷新侧栏工作区,再重连。
                void window.tangu?.getConfig().then((c) => {
                  homeDirRef.current = c.homeDir
                  defaultWsDirRef.current = c.defaultWorkspaceDir || ''
                  setDefaultWsDir(c.defaultWorkspaceDir || '')
                  const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                  setCfg(eff)
                  void connect(eff)
                })
              }}
            />
          ) : (
            <>
              {specialView === 'agents' ? (
                <AgentsDetailView cfg={cfg} onOpenSettings={() => openSettings('agents')} />
              ) : specialView === 'memory' ? (
                <MemoryView cfg={cfg} />
              ) : specialView === 'workspace' ? (
                <WorkspaceDetailView
                  workspace={workspaces.find((w) => w.key === detailWsKey) || defaultWorkspace()}
                  sessions={[...sessions, ...archivedSessions].filter((s) => (s.project_path || CLOUD_WORKSPACE_KEY) === detailWsKey)}
                  onOpenSession={(id) => { setSpecialView(null); setActiveId(id) }}
                  onNewChat={() => { const w = workspaces.find((x) => x.key === detailWsKey) || null; setSpecialView(null); setActiveId(null); setNewChatWs(w); setNewChatCfg({}); setNewChatModel(null) }}
                />
              ) : specialView === 'wechat' ? (
                <WeChatView
                  cfg={cfg}
                  activeSession={activeSession}
                  modelId={activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || ''}
                  onOpenSettings={() => openSettings('wechat')}
                  onOpenSession={(sid) => { loadedHistory.current.delete(sid); setSpecialView(null); setActiveId(sid); void refreshSessions(cfgRef.current).catch(() => {}) }}
                  onSessionsChanged={() => { void refreshSessions(cfgRef.current).catch(() => {}) }}
                />
              ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <ChatArea
                  messages={activeMessages}
                  containerRef={chatScrollRef}
                  onApproval={(mid, aid, action, args) => void decideApproval(mid, aid, action, args)}
                  onInquiry={(mid, iid, answer) => void answerInquiry(mid, iid, answer)}
                  onEditResend={editUserMessage}
                  onRegenerate={regenerate}
                  running={running}
                  onQuote={setQuote}
                />
                {/* 引擎选择器仅在 host(本地)会话且未开群聊时出现:外部引擎是本地 CLI(云端沙箱会话无法用),且与群聊互斥。 */}
                {activeMessages.length === 0 && availableEngines.length > 0 && mvCfg.execMode === 'host' && !mvCfg.groupChat && (
                  <EnginePicker
                    engines={availableEngines}
                    selectedId={mvCfg.engineId || ''}
                    warmingId={mvCfg.engineId && !engineCaps[mvCfg.engineId] ? mvCfg.engineId : null}
                    onSelect={(id) => (activeId ? setSessionEngine(id) : setNewChatCfg((c) => ({ ...c, engineId: id || undefined, engineModelId: undefined, ...(id ? { groupChat: false } : {}) })))}
                  />
                )}
                {!activeId && (
                  <div className="newchat-projectbar">
                    <div className="newchat-projectbar-inner">
                      <ProjectSelector
                        workspaces={workspaces}
                        value={newChatWs?.key ?? null}
                        onChange={(w) => setNewChatWs(w)}
                        onAddProject={() => void addLocalWorkspace()}
                      />
                    </div>
                  </div>
                )}
                <div className="composer-anchor">
                <AnimatePresence>
                  {filePreview && (
                    <WorkspaceFilePreview key={filePreview.name} target={filePreview} onClose={() => setFilePreview(null)} />
                  )}
                </AnimatePresence>
                <MessageInput
                  disabled={connState !== 'ok'}
                  running={running}
                  execConfig={mvCfg}
                  models={visibleModels}
                  modelId={mvModelId}
                  onModelChange={activeId ? setSessionModel : (id) => setNewChatModel(id)}
                  engines={engines}
                  engineId={mvCfg.engineId}
                  engineModels={mvCfg.engineId ? (engineCaps[mvCfg.engineId]?.models ?? []) : undefined}
                  engineModelId={mvCfg.engineModelId}
                  onEngineModelChange={activeId ? setSessionEngineModel : (id) => setNewChatCfg((c) => ({ ...c, engineModelId: id || undefined }))}
                  engineCommands={mvCfg.engineId ? (engineCaps[mvCfg.engineId]?.commands ?? []) : undefined}
                  thinkingLevel={mvCfg.thinkingLevel}
                  onThinkingChange={activeId ? setSessionThinking : (lv) => setNewChatCfg((c) => ({ ...c, thinkingLevel: lv }))}
                  maxIterations={mvCfg.maxIterations}
                  onMaxIterationsChange={activeId ? setSessionMaxIterations : (n) => setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
                  planMode={mvCfg.planMode}
                  onPlanModeChange={activeId ? setSessionPlanMode : (v) => setNewChatCfg((c) => ({ ...c, planMode: v }))}
                  groupChat={mvCfg.groupChat}
                  groupAgents={mvCfg.groupAgents}
                  groupTempAgents={mvCfg.groupTempAgents}
                  groupIntensity={mvCfg.groupIntensity}
                  groupMaxRounds={mvCfg.groupMaxRounds}
                  onGroupChange={activeId ? setSessionGroup : (patch) => setNewChatCfg((c) => ({ ...c, ...patch }))}
                  skills={skillsList}
                  enabledSkillIds={mvCfg.enabledSkillIds || []}
                  onToggleSkill={activeId ? toggleSessionSkill : (id) => setNewChatCfg((c) => { const s = new Set(c.enabledSkillIds || []); s.has(id) ? s.delete(id) : s.add(id); return { ...c, enabledSkillIds: [...s] } })}
                  agents={agentDefs}
                  activeAgentSlug={mvCfg.agentSlug}
                  onSelectAgent={activeId ? selectSessionAgent : (slug) => setNewChatCfg((c) => ({ ...c, agentSlug: slug }))}
                  onNewSession={() => void newSession()}
                  onOpenSettings={() => openSettings('skills')}
                  onExecConfigChange={activeId ? setExecConfig : (patch) => setNewChatCfg((c) => ({ ...c, ...patch }))}
                  onSend={send}
                  onStop={stop}
                  quotedText={quote}
                  onClearQuote={() => setQuote('')}
                  contextWindow={activeModel?.contextWindow || 0}
                  ctxTokens={activeUsage.ctx}
                  sessionTokens={activeUsage.base + activeUsage.live}
                  onCompact={compact}
                />
                </div>
              </div>
              )}
              {rightOpen && activeId && !specialView && (
                <RightPanel
                  cfg={cfg}
                  sessionId={activeId}
                  sessionConfig={execConfig}
                  running={running}
                  messages={activeMessages}
                  chatScrollRef={chatScrollRef}
                  onToast={toast}
                  onOpenPreview={setFilePreview}
                />
              )}
            </>
          )}
        </div>
      </main>

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
