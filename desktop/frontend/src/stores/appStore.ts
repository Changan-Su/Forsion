/**
 * 应用状态 store —— App.tsx 的忠实搬迁(单 store)。
 * ponytail: single store now; split into config/sessions/runs/catalog if it grows.
 * App.tsx 的 React refs 在此化为:① 用 get() 读当前 state(无 stale-closure 问题);
 * ② 非响应式的 Map/Set(runAborts/subscribedRuns/stoppedRuns/loadedHistory)做模块级常量。
 * i18n 是 hook,store 在 React 外 → 持 tr 函数,由 bootstrap 从 useI18n 注入。
 */
import { create } from 'zustand'
import type {
  AgentConfig, AgentRunEvent, Attachment, AuthStatusInfo, ModelsResponse, NormalAgentDef,
  SessionRecord, SkillInfo, SubChat, TanguDesktopConfig, UiMessage, WorkspaceDescriptor, StoredDesktopConfig,
} from '../types'
import { CLOUD_WORKSPACE_KEY, SHOW_SYSTEM_PROMPT_KEY } from '../types'
import * as api from '../services/backendService'
import { abortRun, listActiveRuns, resolveApproval, resolveInquiry, startRun, steerRun, subscribeRunEvents, testConnection } from '../services/agentRunService'
import { speakMessage, stopSpeaking, ttsState } from '../services/ttsService'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { openWsFile } from '../views/wsFileNav'
import type { Tab as SettingsTab } from '../components/SettingsModal'
import { ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } from '../components/OnboardingWizard'
import { track } from '../achievements/store'

export type { SettingsTab }

/** 主区特殊视图(从侧栏特殊卡片打开;作主区 leaf,与对话同组 tab)。 */
export type SpecialKind = 'wechat' | 'agents' | 'workspace'

const VOICE_MESSAGE_PLUGIN_ID = 'voice-message' // 语音消息插件 id(与 plugins/voice-message 一致)
const UNREAD_KEY = 'forsion_tangu_unread_sessions'
function loadUnread(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]')) } catch { return new Set() }
}
function saveUnread(s: Set<string>): void {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

/** 群聊发言落库为 `**🗣 名字**\n\n正文`(DB 无结构化发言人列)。重载时据此还原发言人身份并剥前缀。 */
const GROUP_SPEAKER_RE = /^\*\*🗣\s*([^*\n]+?)\s*\*\*\n+([\s\S]*)$/

/** 历史行 → UI 消息(tool_calls/tool_results 配对成 toolEvents)。 */
export function recordToUi(r: any, resolveGroup?: (name: string) => { slug?: string; color: string }, resolveSlug?: (slug: string) => string | undefined): UiMessage {
  const role = r.role === 'model' || r.role === 'assistant' ? 'assistant' : 'user'
  let content = r.content || ''
  let agentId: string | undefined
  let agentName: string | undefined
  let agentColor: string | undefined
  if (role === 'assistant' && resolveGroup) {
    const m = GROUP_SPEAKER_RE.exec(content)
    if (m) {
      agentName = m[1].trim()
      content = m[2]
      const g = resolveGroup(agentName)
      agentId = g.slug
      agentColor = g.color
    }
  }
  // 非群聊:用消息自身存的 agent_slug 还原展示身份(头像/昵称),否则重载只能回退到「会话默认 agent」。
  // 旧消息无此列(NULL)→ 不盖,仍走会话回退。不设 agentColor:单聊保持默认配色,不染群聊那种彩色名。
  if (role === 'assistant' && !agentId && r.agent_slug) {
    agentId = r.agent_slug
    agentName = resolveSlug?.(r.agent_slug) || agentName
  }
  const msg: UiMessage = {
    id: r.id, role, content, reasoning: r.reasoning || undefined,
    attachments: r.attachments || undefined,
    displayFiles: Array.isArray(r.display_files) && r.display_files.length ? r.display_files : undefined,
    status: 'done', timestamp: Number(r.timestamp) || 0,
    agentId, agentName, agentColor,
  }
  if (role === 'assistant' && Array.isArray(r.tool_calls) && r.tool_calls.length) {
    const results = new Map<string, any>((Array.isArray(r.tool_results) ? r.tool_results : []).map((t: any) => [t.tool_call_id, t]))
    msg.toolEvents = r.tool_calls.map((c: any) => {
      const res = results.get(c.id)
      return {
        id: c.id, name: c.function?.name || c.name || 'tool', arguments: c.function?.arguments,
        result: res ? String(res.content ?? '') : undefined, isError: res?.isError || false,
        startedAt: res?.startedAt, elapsedMs: res?.elapsedMs, outputChars: res?.outputChars,
        parallelGroup: res?.parallelGroup, artifactPath: res?.artifactPath, done: true,
      }
    })
  }
  if (r.is_error) msg.status = 'error'
  return msg
}

type GroupRef = { current: string; groupSeen?: boolean; group?: boolean; groupEnded?: boolean; reuseNext?: boolean }
function groupColor(slug: string): string {
  if (slug === '__host__') return '#b8860b'
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 45%)`
}
/** 发言人名 → {slug, color}:用于重载历史时按名还原 agent 身份(DB 只存了名字)。 */
function groupSpeakerResolver(agentDefs: NormalAgentDef[], hostName: string) {
  return (name: string): { slug?: string; color: string } => {
    if (name === '主持人' || name === hostName) return { slug: '__host__', color: groupColor('__host__') }
    const a = agentDefs.find((x) => x.name === name)
    if (a) return { slug: a.slug, color: groupColor(a.slug) }
    return { color: groupColor(name) } // 临时 agent / 名字未在册:仍给稳定派生色,slug 缺省(头像靠 ChatView 按名兜底)
  }
}
function appendSubText(s: SubChat, delta: string): SubChat {
  const segs = s.segs.slice()
  const last = segs[segs.length - 1]
  if (last && last.t === 'text') segs[segs.length - 1] = { ...last, text: last.text + delta }
  else segs.push({ t: 'text', text: delta })
  return { ...s, segs }
}

// 非响应式跨事件状态(App.tsx 的 useRef Map/Set)。
/** 助手身份盖章:外部引擎→引擎名(无 agentId,不冒用 Tangu agent 头像);否则非群聊用会话 agent(或默认 agent)slug+名;空=基础 Tangu。送出/恢复/续聊共用,保证恢复的 run 不退回「TANGU」。 */
function agentStamp(s: Pick<AppState, 'engines' | 'agentDefs' | 'defaultAgentSlug'>, config?: AgentConfig): { agentId?: string; agentName?: string } {
  if (config?.engineId) {
    const eng = s.engines.find((e) => e.id === config.engineId)
    return { agentName: eng?.name || config.engineId }
  }
  const slug = config?.agentSlug || s.defaultAgentSlug
  if (!config?.groupChat && slug) {
    const a = s.agentDefs.find((x) => x.slug === slug)
    if (a) return { agentId: a.slug, agentName: a.name }
  }
  return {}
}

const runAborts = new Map<string, AbortController>()
const subscribedRuns = new Set<string>()
const stoppedRuns = new Set<string>()
// 卡死兜底:SSE 偶尔丢「终止帧」(后端 run 挂死/被 orphan janitor 标失败但事件没进流)→ 助手消息永远停在
// streaming。看门狗周期性查:该 run 已不在后端活跃集 → 重载消息收尾(有内容标 done,无则 error),解除卡死。
const runWatchdogs = new Map<string, ReturnType<typeof setInterval>>()
const loadedHistory = new Set<string>()
let lastAuthExpiredAt = 0 // handleAuthExpired 去抖:轮询/SSE/models 可能同时多次 401
const MAX_MSG_CHARS = 1_500_000 // 单条助手正文软上限(防超长正文+markdown 重渲染撑爆渲染进程)
const MAX_LIVE_SESSIONS = 8 // 内存中保留消息的会话数上限(LRU,切走的旧会话淘汰,下次进入重新拉)
const recentSessions: string[] = [] // 最近查看的会话 id(MRU 在前),用于 LRU 淘汰
/** 单条正文超上限则截断 + 标注(后端仍完整落库;仅界面侧防 OOM)。 */
function capContent(s: string): string {
  return s.length >= MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) + '\n\n[输出过长,界面已截断显示]' : s
}

type ConnState = 'idle' | 'ok' | 'err'

export interface AppState {
  tr: (k: string, vars?: Record<string, unknown>) => string
  cfg: TanguDesktopConfig
  desktopConfig: StoredDesktopConfig | null
  cfgLoaded: boolean
  connState: ConnState
  connMessage: string
  desktopMode: 'managed' | 'external' | null
  homeDir: string | undefined
  defaultWsDir: string
  sessions: SessionRecord[]
  archivedSessions: SessionRecord[]
  activeId: string | null
  /** 当前「进入」的工作区 key:会话面板 + 文件面板共享(手风琴同步,展开它收起其余)。 */
  activeWorkspaceKey: string | null
  modelsResp: ModelsResponse | null
  skillsList: SkillInfo[] | null
  agentDefs: NormalAgentDef[]
  agentAvatars: Record<string, string>
  defaultAgentSlug: string
  authInfo: AuthStatusInfo | null
  engines: Array<{ id: string; name: string; available?: boolean; defaultModel?: string }>
  engineCaps: Record<string, { models: Array<{ id: string; name: string; description?: string }>; commands: Array<{ name: string; description: string; hint?: string }> }>
  specialEnabled: { historian: boolean; muse: boolean }
  newChatWs: WorkspaceDescriptor | null
  newChatCfg: AgentConfig
  newChatModel: string | null
  filePreview: PreviewTarget | null
  messagesBySession: Record<string, UiMessage[]>
  configBySession: Record<string, AgentConfig>
  runningBySession: Record<string, string>
  groupVoting: Record<string, boolean>
  subChatsBySession: Record<string, SubChat[]>
  usageBySession: Record<string, { ctx: number; base: number; live: number }>
  /** 语音消息:按 agent 的生效开关(voice-message 插件启用 + 该 agent apply)。缓存,首次进会话惰性拉取。 */
  voiceOnByAgent: Record<string, boolean>
  unread: Set<string>
  toasts: Array<{ id: number; text: string; error?: boolean }>
  // Phase 2: 设置 / 引导 / 更新
  settingsOpen: boolean
  settingsTab: SettingsTab | null
  feedbackOpen: boolean
  marketOpen: boolean
  achievementsOpen: boolean
  onboarding: boolean
  updateAvailable: { version?: string } | null
  updateDismissed: boolean
  // Phase 3: 特殊视图(主区 leaf)目标
  detailWsKey: string | null
  activeSpecial: SpecialKind | null

  setTr(tr: AppState['tr']): void
  toast(text: string, error?: boolean): void
  pushNotice(text: string): void
  patchMessage(sessionId: string, messageId: string, fn: (m: UiMessage) => UiMessage): void
  reduceEvent(sessionId: string, runId: string, assistantRef: { current: string }, ev: AgentRunEvent): void
  subscribeRun(sessionId: string, runId: string, assistantId: string): void
  refreshSessions(c: TanguDesktopConfig): Promise<SessionRecord[]>
  connect(c: TanguDesktopConfig): Promise<void>
  refreshSpecialEnabled(c: TanguDesktopConfig): Promise<void>
  /** 把 Background Session(@讨论/Historian 辅助讨论等,经 /background 端点轮询)合并进该会话的子聊天列表。 */
  mergeBackgroundSubChats(sessionId: string, items: Array<{ runId: string; title: string; status: string }>): void
  boot(): Promise<void>
  refreshAgents(): void
  loadSessionHistory(sessionId: string): Promise<void>
  pollSession(sessionId: string): Promise<void>
  setActiveId(id: string | null): void
  setActiveWorkspaceKey(key: string | null): void
  workspaces(): WorkspaceDescriptor[]
  defaultWorkspace(): WorkspaceDescriptor
  createInWorkspace(ws: WorkspaceDescriptor): Promise<void>
  newSession(): void
  addLocalWorkspace(): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  archiveSession(id: string, archived: boolean): Promise<void>
  deleteSession(id: string): Promise<void>
  renameWorkspace(ws: WorkspaceDescriptor, name: string): Promise<void>
  removeWorkspace(ws: WorkspaceDescriptor): Promise<void>
  send(text: string, attachments: Attachment[], workspaceFiles?: Attachment[], skillIds?: string[], mentions?: { priorityAgent?: string; mentionAgents?: string[] }, sessionId?: string | null): Promise<boolean>
  stop(sessionId?: string | null): void
  truncateAndResend(fromIndex: number, text: string, attachments: Attachment[], sessionId?: string | null): Promise<void>
  editUserMessage(messageId: string, newText: string, sessionId?: string | null): void
  regenerate(messageId: string, sessionId?: string | null): void
  branchFromMessage(messageId?: string, sessionId?: string | null): Promise<void>
  compact(sessionId?: string | null): Promise<void>
  decideApproval(messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>, sessionId?: string | null): Promise<void>
  answerInquiry(messageId: string, inquiryId: string, answer: string, sessionId?: string | null): Promise<void>
  setExecConfig(patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>, sessionId?: string | null): void
  setSessionModel(modelId: string, sessionId?: string | null): void
  setSessionThinking(level: NonNullable<AgentConfig['thinkingLevel']>, sessionId?: string | null): void
  setSessionMaxIterations(n: number, sessionId?: string | null): void
  setSessionPlanMode(on: boolean, sessionId?: string | null): void
  /** 语音消息(按 agent,单一真源=voice-message 插件设置)。 */
  refreshVoiceMode(slug?: string | null): Promise<void>
  setVoiceMode(slug: string, on: boolean): Promise<void>
  setSessionEngine(engineId: string, sessionId?: string | null): void
  setSessionEngineModel(engineModelId: string, sessionId?: string | null): void
  setSessionGroup(patch: Pick<AgentConfig, 'groupChat' | 'groupAgents' | 'groupTempAgents' | 'groupIntensity' | 'groupMaxRounds'>, sessionId?: string | null): void
  selectSessionAgent(slug: string, sessionId?: string | null): void
  selectNewChatAgent(slug: string): void
  setNewChatWs(ws: WorkspaceDescriptor | null): void
  setNewChatCfg(fn: (c: AgentConfig) => AgentConfig): void
  setNewChatModel(id: string | null): void
  setFilePreview(p: PreviewTarget | null): void
  patchConfig(patch: Partial<TanguDesktopConfig>): void
  ensureEngineCaps(engineId: string | undefined): void
  openSettings(tab?: SettingsTab): void
  closeSettings(): void
  /** 检测到 Forsion 登录过期(401/凭证失效):清登录态 + 提示 + 引导重登录。幂等;standalone/未登录不触发。 */
  handleAuthExpired(): void
  openMarket(): void
  closeMarket(): void
  openAchievements(): void
  closeAchievements(): void
  /** 插件装好后:重扫(免重启出现)+ 启用 + 重启提示 + 跳转对应设置。 */
  onPluginInstalled(): Promise<void>
  openFeedback(): void
  closeFeedback(): void
  setOnboarding(on: boolean): void
  setUpdateAvailable(v: { version?: string } | null): void
  dismissUpdate(): void
  setDetailWsKey(k: string | null): void
  setActiveSpecial(k: SpecialKind | null): void
}

export const useApp = create<AppState>((set, get) => ({
  tr: (k) => k,
  cfg: { backendUrl: 'http://localhost:8787', token: '', modelId: '' },
  desktopConfig: null,
  cfgLoaded: false,
  connState: 'idle',
  connMessage: '',
  desktopMode: null,
  homeDir: undefined,
  defaultWsDir: '',
  sessions: [],
  archivedSessions: [],
  activeId: null,
  activeWorkspaceKey: null,
  modelsResp: null,
  skillsList: null,
  agentDefs: [],
  agentAvatars: {},
  defaultAgentSlug: 'xyra',
  authInfo: null,
  engines: [],
  engineCaps: {},
  specialEnabled: { historian: false, muse: false },
  newChatWs: null,
  newChatCfg: {},
  newChatModel: null,
  filePreview: null,
  messagesBySession: {},
  configBySession: {},
  voiceOnByAgent: {},
  runningBySession: {},
  groupVoting: {},
  subChatsBySession: {},
  usageBySession: {},
  unread: loadUnread(),
  toasts: [],
  settingsOpen: false,
  settingsTab: null,
  feedbackOpen: false,
  marketOpen: false,
  achievementsOpen: false,
  onboarding: false,
  updateAvailable: null,
  updateDismissed: false,
  detailWsKey: null,
  activeSpecial: null,

  setTr: (tr) => set({ tr }),

  toast: (text, error = false) => {
    const id = Date.now() + Math.random()
    set((s) => ({ toasts: [...s.toasts, { id, text, error }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4200)
  },

  pushNotice: (text) => {
    const sid = get().activeId
    if (!sid) { get().toast(text); return }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sid]: [...(s.messagesBySession[sid] || []), {
          id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'system' as const, content: text, status: 'done' as const, timestamp: Date.now(),
        }],
      },
    }))
  },

  patchMessage: (sessionId, messageId, fn) => {
    set((s) => {
      const list = s.messagesBySession[sessionId]
      if (!list) return s
      const i = list.findIndex((m) => m.id === messageId)
      if (i < 0) return s
      const next = list.slice()
      next[i] = fn(next[i])
      return { messagesBySession: { ...s.messagesBySession, [sessionId]: next } }
    })
  },

  reduceEvent: (sessionId, runId, assistantRef, ev) => {
    const t = get().tr
    const { patchMessage } = get()
    const pl = ev.payload || {}
    const assistantId = assistantRef.current
    const upsertSubChat = (id: string, fn: (s: SubChat) => SubChat, init?: Partial<SubChat>) => {
      set((s) => {
        const list = s.subChatsBySession[sessionId] || []
        const idx = list.findIndex((x) => x.id === id)
        if (idx < 0) {
          const base: SubChat = { id, kind: 'subagent', title: id.slice(0, 8), streaming: true, segs: [], ...init }
          return { subChatsBySession: { ...s.subChatsBySession, [sessionId]: [...list, fn(base)] } }
        }
        const next = list.slice()
        next[idx] = fn(next[idx])
        return { subChatsBySession: { ...s.subChatsBySession, [sessionId]: next } }
      })
    }
    switch (ev.type) {
      case 'token':
        patchMessage(sessionId, assistantId, (m) => {
          // 单条正文软上限:超长正文 + markdown 重渲染会持续吃渲染进程内存(白屏 OOM 诱因之一)。
          if (m.content.length >= MAX_MSG_CHARS) return m // 已达上限,停止累积(后端仍完整落库)
          return { ...m, content: capContent(m.content + (pl.delta || '')) }
        })
        break
      case 'reasoning':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, reasoning: (m.reasoning || '') + (pl.delta || '') }))
        break
      case 'system_prompt':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, systemPrompt: pl.content || '' }))
        break
      case 'tool_stream':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((tt) => tt.id === pl.id)
          if (i >= 0) evs[i] = { ...evs[i], arguments: (evs[i].arguments || '') + (pl.delta || '') }
          else evs.push({ id: pl.id, name: pl.name || 'tool', arguments: pl.delta || '', done: false })
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_call':
        if (pl.name === 'generate_image') track('image.generate')
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((tt) => tt.id === pl.id)
          const item = { id: pl.id, name: pl.name, arguments: pl.arguments, done: false, startedAt: pl.startedAt, parallelGroup: pl.parallelGroup }
          if (i >= 0) evs[i] = { ...evs[i], ...item }
          else evs.push(item)
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_result':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((tt) => tt.id === pl.id)
          if (i >= 0) {
            evs[i] = {
              ...evs[i], result: String(pl.result ?? ''), isError: !!pl.isError, done: true,
              startedAt: pl.startedAt ?? evs[i].startedAt, elapsedMs: pl.elapsedMs, outputChars: pl.outputChars,
              parallelGroup: pl.parallelGroup ?? evs[i].parallelGroup, artifactPath: pl.artifactPath,
            }
          }
          return { ...m, toolEvents: evs }
        })
        break
      case 'display_file':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, displayFiles: [...(m.displayFiles || []), { name: pl.name, mime: pl.mime, path: pl.path, dataUrl: pl.dataUrl }],
        }))
        break
      case 'approval_request':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, approvals: [...(m.approvals || []), { approvalId: pl.approvalId, runId, name: pl.name, arguments: pl.arguments, preview: pl.preview || '', status: 'pending' as const }],
        }))
        break
      case 'approval_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, approvals: (m.approvals || []).map((a) => a.approvalId === pl.approvalId ? { ...a, status: pl.action === 'reject' ? ('rejected' as const) : ('approved' as const) } : a),
        }))
        break
      case 'inquiry_request': {
        const inq = { inquiryId: pl.inquiryId, runId, question: pl.question || '', options: Array.isArray(pl.options) ? pl.options : [], status: 'pending' as const }
        const gref = assistantRef as GroupRef
        if (gref.group && gref.groupEnded) {
          const id = `grp-inq-${pl.inquiryId}`
          gref.current = id
          gref.reuseNext = true
          set((s) => ({
            messagesBySession: {
              ...s.messagesBySession,
              [sessionId]: [...(s.messagesBySession[sessionId] || []), {
                id, role: 'assistant' as const, content: '', status: 'done' as const, timestamp: Date.now(),
                agentId: '__host__', agentName: t('group.host'), agentColor: groupColor('__host__'), inquiries: [inq],
              }],
            },
          }))
        } else {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, inquiries: [...(m.inquiries || []), inq] }))
        }
        break
      }
      case 'inquiry_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, inquiries: (m.inquiries || []).map((q) => q.inquiryId === pl.inquiryId ? { ...q, status: 'answered' as const, answer: String(pl.answer ?? '') } : q),
        }))
        break
      case 'plan':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, planProposal: String(pl.plan || '') }))
        break
      case 'todo':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, todos: Array.isArray(pl.todos) ? pl.todos : [] }))
        break
      case 'plan_approved':
        set((s) => ({ configBySession: { ...s.configBySession, [sessionId]: { ...(s.configBySession[sessionId] || {}), planMode: false } } }))
        if (pl.file) get().toast(t('app.planArchived', { file: pl.file }))
        break
      case 'group_speaker': {
        const ref = assistantRef as GroupRef
        ref.group = true
        const slug = String(pl.slug || '')
        const name = String(pl.name || slug)
        const round = Number(pl.round) || 0
        const color = groupColor(slug)
        // 用后端下发的持久 uuid 作气泡 id → 与落库行对齐,轮询/重载按 id 合并不再产生重复。旧后端无 messageId 时回退合成 id。
        const mid = String(pl.messageId || '') || `grp-${slug}-${round}-${Date.now()}`
        if (pl.phase === 'start') {
          const wasFirst = !ref.groupSeen
          ref.reuseNext = false
          ref.groupSeen = true
          ref.current = mid
          set((s) => {
            const list = s.messagesBySession[sessionId] || []
            // 首位发言人:把 run 占位气泡(assistantId)就地改成持久 uuid 并盖发言人身份(保留已有内容);
            // 其余发言人:各自追加一条以持久 uuid 为 id 的气泡。id 对齐落库行 → 轮询/重载不产生重复。
            if (wasFirst) {
              const idx = list.findIndex((m) => m.id === assistantId)
              if (idx >= 0) {
                const next = list.slice()
                next[idx] = { ...next[idx], id: mid, status: 'streaming', agentId: slug, agentName: name, agentColor: color, groupRound: round }
                return { messagesBySession: { ...s.messagesBySession, [sessionId]: next } }
              }
            }
            return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...list, { id: mid, role: 'assistant' as const, content: '', status: 'streaming' as const, timestamp: Date.now(), agentId: slug, agentName: name, agentColor: color, groupRound: round }] } }
          })
        } else if (pl.phase === 'end') {
          patchMessage(sessionId, ref.current, (m) => ({ ...m, status: 'done' }))
        }
        break
      }
      case 'group_voting':
        set((s) => ({ groupVoting: { ...s.groupVoting, [sessionId]: true } }))
        break
      case 'group_vote': {
        set((s) => ({ groupVoting: { ...s.groupVoting, [sessionId]: false } }))
        const votes = Array.isArray(pl.votes) ? pl.votes : []
        set((s) => ({
          messagesBySession: { ...s.messagesBySession, [sessionId]: [...(s.messagesBySession[sessionId] || []), {
            id: `vote-${pl.round}-${Date.now()}`, role: 'system', content: '', status: 'done', timestamp: Date.now(),
            groupVote: { round: Number(pl.round) || 0, endCount: Number(pl.endCount) || 0, total: Number(pl.total) || votes.length, votes },
          }] },
        }))
        break
      }
      case 'group_ended': {
        (assistantRef as GroupRef).groupEnded = true
        const reasonMap: Record<string, string> = {
          vote: t('group.ended.vote'), max_rounds: t('group.ended.maxRounds'), cost_limit: t('group.ended.costLimit'), quota: t('group.ended.quota'),
        }
        const reason = reasonMap[String(pl.reason)] || t('group.ended.default')
        set((s) => ({
          messagesBySession: { ...s.messagesBySession, [sessionId]: [...(s.messagesBySession[sessionId] || []), {
            id: `ended-${Date.now()}`, role: 'system', content: t('group.ended.line', { rounds: Number(pl.rounds) || 0, reason }), status: 'done', timestamp: Date.now(),
          }] },
        }))
        break
      }
      case 'usage':
        set((s) => {
          const u = s.usageBySession[sessionId] || { ctx: 0, base: 0, live: 0 }
          return { usageBySession: { ...s.usageBySession, [sessionId]: { ctx: pl.prompt || u.ctx, base: u.base, live: pl.total || u.live } } }
        })
        break
      case 'turn_boundary': {
        const newId = pl.newAssistantId
        const users: Array<{ id: string; content: string }> = Array.isArray(pl.userMessages) ? pl.userMessages : []
        set((s) => {
          const list = s.messagesBySession[sessionId] || []
          const have = new Set(list.map((m) => m.id))
          // 后端 finalizedAssistantId 与乐观/恢复气泡 id 不一致时,回退到当前正在累积的 assistantRef,
          // 否则那条气泡会被孤立(永远「思考中」)且新段无身份退回「TANGU」。
          const finalizedId = have.has(pl.finalizedAssistantId) ? pl.finalizedAssistantId : assistantRef.current
          const prevSeg = list.find((m) => m.id === finalizedId)
          const next = list
            .map((m) => (m.id === finalizedId ? { ...m, content: capContent(pl.finalizedContent || m.content), status: 'done' as const } : m))
            .filter((m) => !(m.id === finalizedId && !m.content.trim() && !(m.toolEvents?.length)))
          const additions: UiMessage[] = []
          for (const u of users) if (!have.has(u.id)) additions.push({ id: u.id, role: 'user', content: u.content, status: 'done', timestamp: Date.now() })
          if (newId && !have.has(newId)) additions.push({ id: newId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() + 1, agentId: prevSeg?.agentId, agentName: prevSeg?.agentName })
          return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...next, ...additions] } }
        })
        if (newId) assistantRef.current = newId
        break
      }
      case 'done':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, content: capContent(pl.content || m.content), status: 'done' as const,
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        // 自动朗读:仅当前活跃会话的新完成回复(历史加载走 loadSessionHistory 不经本 reducer,无误触发)。
        // 每次 done 实时拉 config 而非用 store 缓存:设置模态开着改的开关/音色立即生效(store 副本只在关模态时刷新)。
        if (sessionId === get().activeId && window.tangu?.getConfig) {
          void window.tangu.getConfig().then((dc) => {
            if (!dc?.ttsAutoSpeak || !dc?.ttsModelId) return
            const st = get()
            const msg = (st.messagesBySession[sessionId] || []).find((m) => m.id === assistantId)
            if (msg?.content?.trim()) {
              speakMessage(st.cfg, dc, assistantId, msg.content).catch((e: any) => {
                if (e?.message !== 'EMPTY') get().toast(get().tr('tts.failed', { e: e?.message || e }), true)
              })
            }
          }).catch(() => {})
        }
        set((s) => {
          const u = s.usageBySession[sessionId]
          if (!u) return s
          return { usageBySession: { ...s.usageBySession, [sessionId]: { ctx: u.ctx, base: u.base + u.live, live: 0 } } }
        })
        endRun(set, get, sessionId, runId)
        setTimeout(() => { void get().refreshSessions(get().cfg).catch(() => {}) }, 6000)
        break
      case 'error':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, content: pl.content || m.content,
          status: pl.aborted ? ('stopped' as const) : ('error' as const),
          error: pl.aborted ? undefined : (pl.error || 'error'),
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        endRun(set, get, sessionId, runId)
        // 托管模式下 token 过期不会让本地端点 401,而是表现为 run 出错(后端→云端 401)。做一次真实 whoami 复检,
        // 仅确认凭证已失效才提示重登录(避免把模型/网络错误误判为过期)。
        if (!pl.aborted && get().authInfo?.loggedIn) {
          void window.tangu?.authStatus?.()
            .then((a) => { if (a?.loggedIn && a.tokenValid === false) get().handleAuthExpired() })
            .catch(() => {})
        }
        break
      case 'subchat': {
        const id = String(pl.id || '')
        const kind = pl.kind === 'discussion' ? 'discussion' : 'subagent'
        if (id) upsertSubChat(id, (s) => ({ ...s, kind, title: pl.title || s.title, runId: pl.runId || s.runId }), { kind, title: pl.title, runId: pl.runId })
        break
      }
      case 'subagent': {
        const id = String(pl.subId || '')
        if (!id) break
        if (pl.phase === 'token' && pl.delta) upsertSubChat(id, (s) => appendSubText(s, String(pl.delta)))
        else if (pl.phase === 'tool') upsertSubChat(id, (s) => ({ ...s, segs: [...s.segs, { t: 'tool', name: String(pl.name || ''), args: pl.args, preview: pl.preview, error: !!pl.isError }] }))
        else if (pl.phase === 'start') upsertSubChat(id, (s) => ({ ...s, title: pl.label || s.title, streaming: true }), { kind: 'subagent', title: pl.label })
        else if (pl.phase === 'done') upsertSubChat(id, (s) => ({ ...s, streaming: false }))
        break
      }
      default: break
    }
  },

  subscribeRun: (sessionId, runId, assistantId) => {
    if (subscribedRuns.has(runId)) return
    subscribedRuns.add(runId)
    const ac = new AbortController()
    runAborts.set(runId, ac)
    const assistantRef = { current: assistantId }
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: runId } }))
    // 看门狗:每 30s 查一次。仅当助手消息仍在 streaming、且后端活跃集已无此 run(终止帧丢失 / 被判失败)
    // 才兜底收尾——后端还在跑(慢模型/长任务)时 run 仍在活跃集,绝不误杀。
    runWatchdogs.set(runId, setInterval(() => { void (async () => {
      if (get().runningBySession[sessionId] !== runId) return
      const cur = (get().messagesBySession[sessionId] || []).find((m) => m.id === assistantRef.current)
      if (!cur || cur.status !== 'streaming') return
      let active: Array<{ id: string; status?: string }> = []
      try { active = await listActiveRuns(get().cfg, sessionId) } catch { return }
      if (active.some((r) => r.id === runId && (r.status === 'running' || r.status === 'queued' || !r.status))) return
      // 后端已不跑此 run,但 UI 还卡 streaming → 重载消息收尾。
      let rec: any
      try { rec = (await api.listMessages(get().cfg, sessionId)).find((r: any) => r.id === assistantRef.current) } catch { return }
      get().patchMessage(sessionId, assistantRef.current, (m) => {
        const content = rec?.content || m.content
        return content
          ? { ...m, content, status: 'done' as const }
          : { ...m, status: 'error' as const, error: get().tr('app.eventStreamInterrupted') }
      })
      stoppedRuns.add(runId)
      ac.abort() // 停掉还在空转的 SSE 重连循环
      endRun(set, get, sessionId, runId)
    })() }, 30000))
    void subscribeRunEvents(get().cfg, runId, (ev) => get().reduceEvent(sessionId, runId, assistantRef, ev), ac.signal)
      .catch((e) => {
        if (!stoppedRuns.has(runId)) {
          get().patchMessage(sessionId, assistantRef.current, (m) => ({ ...m, status: 'error', error: e?.message || get().tr('app.eventStreamInterrupted') }))
        }
        endRun(set, get, sessionId, runId)
      })
  },

  refreshSessions: async (c) => {
    const [act, arch] = await Promise.all([api.listSessions(c, false), api.listSessions(c, true)])
    set({ sessions: act, archivedSessions: arch })
    return act
  },

  connect: async (c) => {
    const t = get().tr
    const r = await testConnection(c)
    set({ connState: r.ok ? 'ok' : 'err', connMessage: r.message })
    if (!r.ok) return
    try {
      const act = await get().refreshSessions(c)
      const cur = get().activeId
      get().setActiveId(cur && act.some((s) => s.id === cur) ? cur : (act[0]?.id ?? null))
    } catch (e: any) {
      get().toast(t('app.sessionListLoadFail', { e: e?.message || e }), true)
    }
    void api.listModels(c).then((m) => set({ modelsResp: m })).catch(() => set({ modelsResp: null }))
    void api.listSkills(c).then((s) => set({ skillsList: s })).catch(() => set({ skillsList: null }))
    void api.listEngines(c).then((e) => set({ engines: e })).catch(() => set({ engines: [] }))
    void get().refreshSpecialEnabled(c)
    get().refreshAgents()
    void window.tangu?.authStatus?.().then((a) => set({ authInfo: a })).catch(() => set({ authInfo: null }))
  },

  refreshSpecialEnabled: async (c) => {
    try {
      const r = await api.getSpecialConfig(c)
      set({ specialEnabled: { historian: !!r.config?.historian?.enabled, muse: !!r.config?.muse?.enabled } })
    } catch {
      set({ specialEnabled: { historian: false, muse: false } })
    }
  },

  mergeBackgroundSubChats: (sessionId, items) => {
    if (!items.length) return
    set((s) => {
      const list = s.subChatsBySession[sessionId] || []
      let changed = false
      const next = [...list]
      for (const it of items) {
        const streaming = it.status === 'running' || it.status === 'queued'
        const idx = next.findIndex((x) => x.id === it.runId)
        if (idx < 0) {
          next.push({ id: it.runId, kind: 'discussion', title: it.title, runId: it.runId, streaming, segs: [] })
          changed = true
        } else if (next[idx].streaming !== streaming) {
          next[idx] = { ...next[idx], streaming }
          changed = true
        }
      }
      return changed ? { subChatsBySession: { ...s.subChatsBySession, [sessionId]: next } } : {}
    })
  },

  refreshAgents: () => {
    const c = get().cfg
    void api.listAgents(c).then((defs) => {
      set({ agentDefs: defs })
      void Promise.all(defs.filter((a) => a.avatar).map(async (a) => [a.slug, await api.fetchAgentAvatar(c, a.slug)] as const))
        .then((pairs) => set((s) => {
          Object.values(s.agentAvatars).forEach((u) => { try { URL.revokeObjectURL(u) } catch { /* ignore */ } })
          return { agentAvatars: Object.fromEntries(pairs.filter(([, u]) => u) as Array<[string, string]>) }
        }))
    }).catch(() => set({ agentDefs: [] }))
    void api.getAgentsMeta(c).then((m) => set({ defaultAgentSlug: m.defaultSlug || 'xyra' })).catch(() => { /* ignore */ })
  },

  boot: async () => {
    const t = get().tr
    const stored = await window.tangu?.getConfig()
    set({
      desktopConfig: stored || null,
      desktopMode: stored?.mode ?? null,
      homeDir: stored?.homeDir,
      defaultWsDir: stored?.defaultWorkspaceDir || '',
    })
    const prev = get().cfg
    const merged = {
      backendUrl: stored?.backendUrl || prev.backendUrl,
      token: stored?.token ?? prev.token,
      modelId: stored?.modelId ?? prev.modelId,
    }
    set({ cfg: merged, cfgLoaded: true })
    if (stored?.mode === 'managed') {
      if (stored.backendState?.state === 'ready') void get().connect(merged)
      else set({ connState: 'idle', connMessage: t('app.managedBackendStarting') })
    } else if (merged.token) {
      void get().connect(merged)
    }
    // 首启引导:从未配置凭证(未登录、无直连 provider,且未跳过过)→ 进向导。
    // 注意:不能再用 stored.token 当「有无凭证」信号——managed 后端现在恒有 token(无 Forsion 时回退本地令牌,
    // 见 backendManager.getToken),会把新用户误判为已配置。真实凭证只看 authStatus.loggedIn(读 cloudToken||auth.json,
    // 不含本地回退)+ 直连 provider。
    if (stored && window.tangu?.envCheck) {
      try {
        if (!localStorage.getItem(ONBOARDING_DISMISS_KEY)) {
          const [auth, provs] = await Promise.all([
            window.tangu.authStatus?.().catch(() => null) ?? null,
            window.tangu.listProviders?.().catch(() => []) ?? [],
          ])
          if (!auth?.loggedIn && !(provs && provs.length)) set({ onboarding: true })
        }
      } catch { /* 引导判定失败不阻断 */ }
    }
    // 版本更新后再进一次引导(展示 What's New);完成时记录版本(见 OnboardingWizard.finish)。
    // seen 与当前版本不同(含老用户首次启用本功能,seen 为空)→ 弹一次,弹完即标记不再重复。
    void window.tangu?.appVersion?.().then((ver) => {
      if (!ver) return
      let seen: string | null = null
      try { seen = localStorage.getItem(ONBOARDING_VERSION_KEY) } catch { seen = null }
      if (seen !== ver) set({ onboarding: true })
    }).catch(() => {})
    window.tangu?.onBackendStatus?.((st) => {
      if (st.state === 'ready') {
        void window.tangu!.getConfig().then((c) => {
          set({ desktopConfig: c })
          const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
          set({ cfg: eff })
          void get().connect(eff)
        })
      } else if (st.state === 'starting') {
        set({ connState: 'idle', connMessage: t('app.managedBackendStarting') })
      } else if (st.state === 'crashed') {
        set({ connState: 'err', connMessage: st.lastError || t('app.managedBackendExited') })
      }
    })
  },

  loadSessionHistory: async (sessionId) => {
    const t = get().tr
    if (!sessionId || get().connState !== 'ok') return
    if (get().unread.has(sessionId)) {
      const next = new Set(get().unread)
      next.delete(sessionId)
      saveUnread(next)
      set({ unread: next })
    }
    if (loadedHistory.has(sessionId)) return
    loadedHistory.add(sessionId)
    try {
      const c = get().cfg
      const [records, config, active] = await Promise.all([
        api.listMessages(c, sessionId),
        api.getSessionConfig(c, sessionId).catch(() => ({} as AgentConfig)),
        listActiveRuns(c, sessionId),
      ])
      // 配置拉取失败/为空时,别把本机(project_path)会话降级成非 host——否则 execMode 缺失,拖文件走
      // 「上传工作区(25MB 限制)」而非本机路径插入,且因 loadedHistory 已标记不再重拉 → 刷新前一直卡住。
      // 从会话记录的 project_path 派生 host 兜底,真实 config 覆盖其上(用户显式设过 sandbox 时仍以 config 为准)。
      const sess = get().sessions.find((x) => x.id === sessionId) || get().archivedSessions.find((x) => x.id === sessionId)
      const base: AgentConfig = sess?.project_path
        ? { execMode: 'host', approvalMode: 'auto-edit', cwd: sess.project_path }
        : {}
      // 本地已有的键优先(local-wins):本地每次改配置都会同步 PUT,永远不旧于服务端;而这里的
      // fetch 可能与「新会话初始配置 PUT」竞速,整体替换会把刚选好的 agentSlug/thinkingLevel 冲掉。
      set((s) => ({ configBySession: { ...s.configBySession, [sessionId]: { ...base, ...config, ...(s.configBySession[sessionId] || {}) } } }))
      void api.getSessionUsage(c, sessionId)
        .then((base) => set((s) => ({ usageBySession: { ...s.usageBySession, [sessionId]: { ctx: s.usageBySession[sessionId]?.ctx || 0, base, live: 0 } } })))
        .catch(() => {})
      set((s) => {
        const existing = s.messagesBySession[sessionId] || []
        const resolveGroup = groupSpeakerResolver(s.agentDefs, t('group.host'))
        const resolveSlug = (slug: string) => s.agentDefs.find((a) => a.slug === slug)?.name
        const ui = records.map((r) => recordToUi(r, resolveGroup, resolveSlug))
        const byId = new Map(ui.map((m) => [m.id, m] as const))
        for (const m of existing) byId.set(m.id, m)
        return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp) } }
      })
      const stamp = agentStamp(get(), config)
      for (const run of active) {
        if ((run.status === 'running' || run.status === 'queued') && run.assistant_message_id) {
          const amid = run.assistant_message_id
          set((s) => {
            const list = s.messagesBySession[sessionId] || []
            if (list.some((m) => m.id === amid)) return s
            return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...list, { id: amid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), ...stamp }] } }
          })
          get().subscribeRun(sessionId, run.id, amid)
        }
      }
    } catch (e: any) {
      loadedHistory.delete(sessionId)
      get().toast(t('app.historyLoadFail', { e: e?.message || e }), true)
    }
  },

  pollSession: async (sessionId) => {
    if (!sessionId || get().activeId !== sessionId || get().runningBySession[sessionId]) return
    try {
      const c = get().cfg
      const [records, active] = await Promise.all([
        api.listMessages(c, sessionId),
        listActiveRuns(c, sessionId).catch(() => []),
      ])
      if (get().activeId !== sessionId || get().runningBySession[sessionId]) return
      set((s) => {
        const existing = s.messagesBySession[sessionId] || []
        const resolveGroup = groupSpeakerResolver(s.agentDefs, get().tr('group.host'))
        const resolveSlug = (slug: string) => s.agentDefs.find((a) => a.slug === slug)?.name
        const ui = records.map((r) => recordToUi(r, resolveGroup, resolveSlug))
        const byId = new Map(ui.map((m) => [m.id, m] as const))
        for (const m of existing) byId.set(m.id, m)
        const merged = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
        if (merged.length === existing.length && merged.every((m, i) => m === existing[i])) return s
        return { messagesBySession: { ...s.messagesBySession, [sessionId]: merged } }
      })
      const stamp = agentStamp(get(), get().configBySession[sessionId])
      for (const run of active) {
        if ((run.status === 'running' || run.status === 'queued') && run.assistant_message_id && !subscribedRuns.has(run.id)) {
          const amid = run.assistant_message_id
          set((s) => {
            const list = s.messagesBySession[sessionId] || []
            if (list.some((m) => m.id === amid)) return s
            return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...list, { id: amid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), ...stamp }] } }
          })
          get().subscribeRun(sessionId, run.id, amid)
        }
      }
    } catch { /* 轮询失败静默 */ }
  },

  setActiveId: (id) => {
    // 选/建会话 → 焦点回对话,清掉特殊视图高亮。
    set({ activeId: id, activeSpecial: null })
    if (id) {
      // LRU:把当前会话提到最前;超出上限的旧会话淘汰其内存消息(非运行中),下次进入重新拉。
      const i = recentSessions.indexOf(id)
      if (i >= 0) recentSessions.splice(i, 1)
      recentSessions.unshift(id)
      if (recentSessions.length > MAX_LIVE_SESSIONS) {
        const evict = recentSessions.splice(MAX_LIVE_SESSIONS).filter((sid) => sid !== id && !get().runningBySession[sid])
        if (evict.length) {
          set((s) => {
            const next = { ...s.messagesBySession }
            for (const sid of evict) { delete next[sid]; loadedHistory.delete(sid) }
            return { messagesBySession: next }
          })
        }
      }
      void get().loadSessionHistory(id)
      // 焦点回到会话 → 展开它所在工作区(文件面板 + 会话列表共享 activeWorkspaceKey;
      // 否则启动/恢复/从特殊视图跳回时无人设置,右栏文件面板全收起显得「空」)。
      const s = get().sessions.find((x) => x.id === id) || get().archivedSessions.find((x) => x.id === id)
      if (s) set({ activeWorkspaceKey: s.project_path || CLOUD_WORKSPACE_KEY })
    }
  },
  setActiveWorkspaceKey: (key) => set({ activeWorkspaceKey: key }),

  defaultWorkspace: () => ({
    key: get().defaultWsDir || '__default_ws__',
    name: get().tr('app.defaultWorkspace'),
    kind: 'local',
    path: get().defaultWsDir || get().homeDir || null,
  }),

  workspaces: () => {
    const { defaultWsDir, homeDir, sessions, archivedSessions, desktopConfig, tr: t } = get()
    const defPath = defaultWsDir || homeDir || null
    const wechatOn = !!window.tangu?.backendStatus && desktopConfig?.wechatEnabled !== false
    const webotPath = defPath ? `${defPath}/webot` : null
    const list: WorkspaceDescriptor[] = [
      { key: CLOUD_WORKSPACE_KEY, name: t('app.cloudWorkspace'), kind: 'cloud', path: null, system: true },
      { key: defaultWsDir || '__default_ws__', name: t('app.defaultWorkspace'), kind: 'local', path: defPath, system: true },
    ]
    const seen = new Set<string>([CLOUD_WORKSPACE_KEY, defaultWsDir || '__default_ws__'])
    if (wechatOn && webotPath) { list.push({ key: webotPath, name: t('app.wechatWorkspace'), kind: 'wechat', path: webotPath, system: true }); seen.add(webotPath) }
    for (const s of [...sessions, ...archivedSessions]) {
      if (s.project_path && s.project_path !== defPath && !seen.has(s.project_path)) {
        seen.add(s.project_path)
        list.push({ key: s.project_path, name: s.project_name || s.project_path.split('/').filter(Boolean).pop() || t('app.workspace'), kind: 'local', path: s.project_path })
      }
    }
    return list
  },

  createInWorkspace: async (ws) => {
    const t = get().tr
    try {
      const path = ws.kind === 'local' ? (ws.path || get().defaultWsDir || get().homeDir || null) : null
      const s = await api.createSession(get().cfg, path ? { project_path: path, project_name: ws.name } : undefined)
      set((st) => ({ sessions: [s, ...st.sessions] }))
      loadedHistory.add(s.id) // 先标记再 setActiveId(其内部 loadSessionHistory 会拉空配置冲掉 init,同 send)
      get().setActiveId(s.id)
      const init: AgentConfig = path ? { execMode: 'host', approvalMode: 'auto-edit', cwd: path } : { execMode: 'sandbox' }
      set((st) => ({ messagesBySession: { ...st.messagesBySession, [s.id]: [] }, configBySession: { ...st.configBySession, [s.id]: init } }))
      void api.putSessionConfig(get().cfg, s.id, init).catch(() => {})
    } catch (e: any) {
      get().toast(t('app.createSessionFail', { e: e?.message || e }), true)
    }
  },

  newSession: () => { void get().createInWorkspace(get().defaultWorkspace()) },

  addLocalWorkspace: async () => {
    const dir = await window.tangu?.pickDirectory?.()
    if (!dir) return
    await get().createInWorkspace({ key: dir, name: dir.split('/').filter(Boolean).pop() || dir, kind: 'local', path: dir })
  },

  renameSession: async (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
      archivedSessions: s.archivedSessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }))
    try { await api.updateSession(get().cfg, id, { title }) } catch (e: any) { get().toast(get().tr('app.renameFail', { e: e?.message || e }), true) }
  },

  archiveSession: async (id, archived) => {
    try {
      await api.updateSession(get().cfg, id, { archived })
      await get().refreshSessions(get().cfg)
      if (archived && get().activeId === id) get().setActiveId(null)
    } catch (e: any) { get().toast(get().tr('app.operationFail', { e: e?.message || e }), true) }
  },

  deleteSession: async (id) => {
    try {
      await api.deleteSession(get().cfg, id)
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id), archivedSessions: s.archivedSessions.filter((x) => x.id !== id) }))
      loadedHistory.delete(id)
      if (get().activeId === id) get().setActiveId(null)
    } catch (e: any) { get().toast(get().tr('app.deleteFail', { e: e?.message || e }), true) }
  },

  renameWorkspace: async (ws, name) => {
    const t = get().tr
    const newName = name.trim().slice(0, 255)
    if (!newName || ws.system || ws.kind !== 'local') return
    const targets = [...get().sessions, ...get().archivedSessions].filter((s) => s.project_path === ws.key)
    if (!targets.length || newName === ws.name) return
    set((s) => ({
      sessions: s.sessions.map((x) => (x.project_path === ws.key ? { ...x, project_name: newName } : x)),
      archivedSessions: s.archivedSessions.map((x) => (x.project_path === ws.key ? { ...x, project_name: newName } : x)),
    }))
    try { await Promise.all(targets.map((s) => api.updateSession(get().cfg, s.id, { project_name: newName }))) }
    catch (e: any) { get().toast(t('app.wsRenameFail', { e: e?.message || e }), true) }
  },

  removeWorkspace: async (ws) => {
    const t = get().tr
    if (ws.system || ws.kind !== 'local') return
    const targets = [...get().sessions, ...get().archivedSessions].filter((s) => s.project_path === ws.key)
    if (!targets.length) return
    try {
      await Promise.all(targets.map((s) => api.deleteSession(get().cfg, s.id)))
      const ids = new Set(targets.map((s) => s.id))
      set((s) => ({ sessions: s.sessions.filter((x) => !ids.has(x.id)), archivedSessions: s.archivedSessions.filter((x) => !ids.has(x.id)) }))
      ids.forEach((id) => loadedHistory.delete(id))
      if (get().activeId && ids.has(get().activeId!)) get().setActiveId(null)
      get().toast(t('app.wsRemoved', { name: ws.name }))
    } catch (e: any) {
      get().toast(t('app.wsRemoveFail', { e: e?.message || e }), true)
      void get().refreshSessions(get().cfg).catch(() => {})
    }
  },

  send: async (text, attachments, workspaceFiles, skillIds, mentions, targetSessionId) => {
    track('chat.send')
    const t = get().tr
    let sid = targetSessionId === undefined ? get().activeId : targetSessionId
    const wasNewChat = !sid
    let implicitInit: AgentConfig | null = null
    if (!sid) {
      const ws = get().newChatWs
      const path = ws
        ? (ws.kind === 'local' ? (ws.path || get().defaultWsDir || get().homeDir || null) : null)
        : (get().desktopMode === 'managed' ? (get().defaultWsDir || get().homeDir || null) : null)
      const s = await api.createSession(get().cfg, path ? { project_path: path, project_name: ws?.name || t('app.defaultWorkspace') } : undefined).catch(() => null)
      if (!s) { get().toast(t('app.cannotCreateSession'), true); return false }
      set((st) => ({ sessions: [s, ...st.sessions] }))
      // 必须先标记再 setActiveId:setActiveId 内部会 void loadSessionHistory,新会话此刻服务端
      // 配置还是空的,拉回来会把下面刚写入的 implicitInit(含选中的 agentSlug/thinkingLevel)整体
      // 冲掉 → 第二轮就「换人」。先标记使其 no-op。
      loadedHistory.add(s.id)
      get().setActiveId(s.id)
      sid = s.id
      const draft = get().newChatCfg
      implicitInit = path
        ? { ...draft, execMode: 'host', approvalMode: draft.approvalMode || 'auto-edit', cwd: path }
        : { ...draft, execMode: 'sandbox', cwd: undefined }
      // 新会话生效的 agent 当场固化(默认兜底也算):不落库的话后续轮次会随易变的
      // defaultAgentSlug 重新解析,同一会话可能「换人」。
      if (!implicitInit.agentSlug && get().defaultAgentSlug) implicitInit.agentSlug = get().defaultAgentSlug
      set((st) => ({ configBySession: { ...st.configBySession, [s.id]: implicitInit! } }))
      void api.putSessionConfig(get().cfg, s.id, implicitInit).catch(() => {})
      if (get().newChatModel) {
        const m = get().newChatModel!
        set((st) => ({ sessions: st.sessions.map((x) => (x.id === s.id ? { ...x, model_id: m } : x)) }))
        void api.updateSession(get().cfg, s.id, { model_id: m }).catch(() => {})
      }
    }
    const sessionId = sid
    const agentConfig = { ...(implicitInit || get().configBySession[sessionId] || {}) }
    if (!agentConfig.agentSlug && get().defaultAgentSlug) {
      // 会话没有显式选 agent → 用全局默认兜底,并**固化进会话配置**(本地 + 后端)。
      // defaultAgentSlug 是易变全局(启动异步刷新/用户改默认),不固化的话同一会话前后两轮
      // 可能解析出不同 agent(实例:turn1 qinche → turn2 xyra「换人」)。
      agentConfig.agentSlug = get().defaultAgentSlug
      const pinned = { ...(get().configBySession[sessionId] || {}), agentSlug: agentConfig.agentSlug }
      set((st) => ({ configBySession: { ...st.configBySession, [sessionId]: pinned } }))
      void api.putSessionConfig(get().cfg, sessionId, pinned).catch(() => {})
    }
    if (skillIds?.length) agentConfig.requestedSkillIds = skillIds
    if (mentions?.priorityAgent) agentConfig.priorityAgent = mentions.priorityAgent
    if (mentions?.mentionAgents?.length) agentConfig.mentionedAgentSlugs = mentions.mentionAgents
    if (!agentConfig.imageModelId && get().cfg.imageModelId) agentConfig.imageModelId = get().cfg.imageModelId
    try { if (localStorage.getItem(SHOW_SYSTEM_PROMPT_KEY) === '1') agentConfig.debugSystemPrompt = true } catch { /* ignore */ }
    if (workspaceFiles?.length) {
      try {
        await api.uploadWorkspaceFiles(get().cfg, sessionId, workspaceFiles.map((f) => ({ path: f.name, content: f.data, encoding: 'base64' as const, mimeType: f.mimeType })))
        get().toast(t('app.filesUploaded', { count: workspaceFiles.length }))
      } catch (e: any) { get().toast(t('app.workspaceUploadFail', { e: e?.message || e }), true) }
    }
    const activeRunId = get().runningBySession[sessionId]
    if (activeRunId) {
      try {
        const sr = await steerRun(get().cfg, activeRunId, { message: text, attachments })
        if (sr.ok) {
          set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: [...(s.messagesBySession[sessionId] || []), { id: sr.userMessageId || `u-${Date.now()}`, role: 'user', content: text, attachments, status: 'done', timestamp: Date.now() }] } }))
          return true
        }
      } catch (e: any) { get().toast(t('app.sendFail', { e: e?.message || e }), true); return false }
    }
    // 与输入栏「显示的模型」(mvModelId)同一回退链:newChat/会话模型 → 全局 cfg.modelId → 后端默认模型。
    // 否则新会话(未显式选模型、cloud.defaultModel 又空)会发出空 model_id → 后端 400「model_id required」。
    const fallbackModel = get().cfg.modelId || get().modelsResp?.defaultModelId || undefined
    const sessionModelId = wasNewChat
      ? (get().newChatModel || fallbackModel)
      : (get().sessions.find((s) => s.id === sessionId)?.model_id || fallbackModel)
    try {
      const r = await startRun(get().cfg, { sessionId, message: text, modelId: sessionModelId, attachments, agentConfig })
      // 助手身份盖章:外部引擎名 / Normal Agent / 群聊由 group_speaker 逐发言人盖(见 agentStamp)。
      const stamp = agentStamp(get(), agentConfig)
      set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: [
        ...(s.messagesBySession[sessionId] || []),
        { id: r.userMessageId, role: 'user', content: text, attachments, status: 'done', timestamp: Date.now() },
        { id: r.assistantMessageId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() + 1, ...stamp },
      ] } }))
      get().subscribeRun(sessionId, r.runId, r.assistantMessageId)
      set((s) => ({ usageBySession: { ...s.usageBySession, [sessionId]: { ctx: s.usageBySession[sessionId]?.ctx || 0, base: s.usageBySession[sessionId]?.base || 0, live: 0 } } }))
      const sess = get().sessions.find((s) => s.id === sessionId)
      if (sess && (!sess.title || sess.title === 'New Chat')) void get().renameSession(sessionId, text.slice(0, 30))
      return true
    } catch (e: any) { get().toast(t('app.sendFail', { e: e?.message || e }), true); return false }
  },

  stop: (targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const runId = get().runningBySession[sid]
    if (!runId) return
    stoppedRuns.add(runId)
    void abortRun(get().cfg, runId).catch(() => {})
    runAborts.get(runId)?.abort()
    set((s) => {
      const list = s.messagesBySession[sid]
      if (!list) return s
      return { messagesBySession: { ...s.messagesBySession, [sid]: list.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' as const } : m)) } }
    })
    endRun(set, get, sid, runId)
  },

  truncateAndResend: async (fromIndex, text, attachments, targetSessionId) => {
    const t = get().tr
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const list = get().messagesBySession[sid] || []
    if (fromIndex < 0 || fromIndex >= list.length) return
    const removed = list.slice(fromIndex)
    try { await api.deleteMessages(get().cfg, sid, removed.map((m) => m.id)) }
    catch (e: any) { get().toast(t('app.truncateFail', { e: e?.message || e }), true); return }
    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: (s.messagesBySession[sid] || []).slice(0, fromIndex) } }))
    // 正在朗读的消息被删(重新生成/编辑重发)→ 停播,否则音频没了停止按钮还在响。
    const speaking = ttsState()
    if (speaking && removed.some((m) => m.id === speaking.msgId)) stopSpeaking()
    const ok = await get().send(text, attachments, undefined, undefined, undefined, sid)
    if (!ok) {
      set((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: [...(s.messagesBySession[sid] || []).slice(0, fromIndex), ...removed] } }))
      get().toast(t('app.resendFailed'), true)
    }
  },

  editUserMessage: (messageId, newText, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid || get().runningBySession[sid]) return
    const list = get().messagesBySession[sid] || []
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx < 0 || list[idx].role !== 'user') return
    void get().truncateAndResend(idx, newText, list[idx].attachments || [], sid)
  },

  regenerate: (messageId, targetSessionId) => {
    const t = get().tr
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid || get().runningBySession[sid]) return
    const list = get().messagesBySession[sid] || []
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    let u = idx - 1
    while (u >= 0 && list[u].role !== 'user') u--
    if (u < 0) { get().toast(t('app.regenNoUser'), true); return }
    void get().truncateAndResend(u, list[u].content, list[u].attachments || [], sid)
  },

  branchFromMessage: async (messageId, targetSessionId) => {
    const t = get().tr
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const list = get().messagesBySession[sid] || []
    let id = messageId
    if (!id) { for (let i = list.length - 1; i >= 0; i--) { if (list[i].role === 'assistant') { id = list[i].id; break } } }
    if (!id) { get().toast(t('chat.branchEmpty'), true); return }
    const srcTitle = get().sessions.find((s) => s.id === sid)?.title || ''
    try {
      const s = await api.branchSession(get().cfg, sid, id, srcTitle ? t('chat.branchTitle', { title: srcTitle }) : undefined)
      set((st) => ({ sessions: [s, ...st.sessions] }))
      get().setActiveId(s.id)
      get().toast(t('chat.branched'))
    } catch (e: any) { get().toast(t('app.branchFail', { e: e?.message || e }), true) }
  },

  compact: async (targetSessionId) => {
    const t = get().tr
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const modelId = get().sessions.find((s) => s.id === sid)?.model_id || get().cfg.modelId || get().modelsResp?.defaultModelId || ''
    get().toast(t('input.compacting'))
    try {
      const r = await api.compactSession(get().cfg, sid, modelId)
      get().pushNotice(r.ok ? t('input.compactDone', { n: r.summarizedCount || 0 }) : t('input.compactSkip', { reason: r.reason || '' }))
    } catch (e: any) { get().toast(t('input.compactFail', { e: e?.message || e }), true) }
  },

  decideApproval: async (messageId, approvalId, action, argsOverride, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const approval = (get().messagesBySession[sid] || []).find((m) => m.id === messageId)?.approvals?.find((a) => a.approvalId === approvalId)
    if (!approval?.runId) return
    const r = await resolveApproval(get().cfg, approval.runId, approvalId, action, argsOverride)
    if (r.gone) get().patchMessage(sid, messageId, (m) => ({ ...m, approvals: (m.approvals || []).map((a) => (a.approvalId === approvalId ? { ...a, status: 'expired' as const } : a)) }))
  },

  answerInquiry: async (messageId, inquiryId, answer, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const inquiry = (get().messagesBySession[sid] || []).find((m) => m.id === messageId)?.inquiries?.find((q) => q.inquiryId === inquiryId)
    if (!inquiry?.runId) return
    const r = await resolveInquiry(get().cfg, inquiry.runId, inquiryId, answer)
    if (r.gone) get().patchMessage(sid, messageId, (m) => ({ ...m, inquiries: (m.inquiries || []).map((q) => (q.inquiryId === inquiryId ? { ...q, status: 'expired' as const } : q)) }))
  },

  setExecConfig: (patch, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => {
      const next = { ...(s.configBySession[sid] || {}), ...patch }
      void api.putSessionConfig(get().cfg, sid, next).catch(() => {})
      return { configBySession: { ...s.configBySession, [sid]: next } }
    })
  },

  setSessionModel: (modelId, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) {
      set((s) => { void window.tangu?.setConfig({ modelId }); return { cfg: { ...s.cfg, modelId } } })
      return
    }
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sid ? { ...x, model_id: modelId } : x)),
      archivedSessions: s.archivedSessions.map((x) => (x.id === sid ? { ...x, model_id: modelId } : x)),
    }))
    void api.updateSession(get().cfg, sid, { model_id: modelId }).catch((e) => get().toast(get().tr('app.modelSwitchSaveFail', { e: e?.message || e }), true))
  },

  setSessionThinking: (level, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => { const next = { ...(s.configBySession[sid] || {}), thinkingLevel: level }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
  },

  setSessionMaxIterations: (n, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => { const next = { ...(s.configBySession[sid] || {}), maxIterations: n }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
  },

  setSessionPlanMode: (on, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => { const next = { ...(s.configBySession[sid] || {}), planMode: on }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
  },

  refreshVoiceMode: async (slug) => {
    if (!slug || get().voiceOnByAgent[slug] !== undefined) return // 已缓存不重复拉
    const cfg = get().cfg
    try {
      const plugins = await api.listPlugins(cfg)
      const enabled = !!plugins.find((p) => p.id === VOICE_MESSAGE_PLUGIN_ID)?.enabled
      let on = false
      if (enabled) {
        const v = await api.getPluginSettings(cfg, VOICE_MESSAGE_PLUGIN_ID, `agent:${slug}`).catch(() => ({} as Record<string, any>))
        on = v?.apply !== false // apply 默认开
      }
      set((s) => ({ voiceOnByAgent: { ...s.voiceOnByAgent, [slug]: on } }))
    } catch { /* 插件不可用/云端 → 视为关 */ }
  },

  setVoiceMode: async (slug, on) => {
    set((s) => ({ voiceOnByAgent: { ...s.voiceOnByAgent, [slug]: on } })) // 乐观更新
    const cfg = get().cfg
    try {
      if (on) await api.setPluginEnabled(cfg, VOICE_MESSAGE_PLUGIN_ID, true).catch(() => {}) // 确保插件启用
      await api.putPluginSettings(cfg, VOICE_MESSAGE_PLUGIN_ID, `agent:${slug}`, { apply: on })
    } catch (e: any) {
      set((s) => ({ voiceOnByAgent: { ...s.voiceOnByAgent, [slug]: !on } })) // 失败回滚
      get().toast(get().tr('voice.toggleFailed', { e: e?.message || String(e) }), true)
    }
  },

  setSessionEngine: (engineId, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => {
      const next = { ...(s.configBySession[sid] || {}), engineId: engineId || undefined, engineModelId: undefined, ...(engineId ? { groupChat: false } : {}) }
      void api.putSessionConfig(get().cfg, sid, next).catch(() => {})
      return { configBySession: { ...s.configBySession, [sid]: next } }
    })
  },

  setSessionEngineModel: (engineModelId, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => { const next = { ...(s.configBySession[sid] || {}), engineModelId: engineModelId || undefined }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
  },

  setSessionGroup: (patch, targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    set((s) => { const next = { ...(s.configBySession[sid] || {}), ...patch }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
  },

  selectSessionAgent: (slug, targetSessionId) => {
    const t = get().tr
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const def = slug ? get().agentDefs.find((a) => a.slug === slug) : null
    set((s) => { const next = { ...(s.configBySession[sid] || {}), agentSlug: slug || undefined }; void api.putSessionConfig(get().cfg, sid, next).catch(() => {}); return { configBySession: { ...s.configBySession, [sid]: next } } })
    if (def?.model) get().setSessionModel(def.model, sid)
    if (def?.thinkingLevel) get().setSessionThinking(def.thinkingLevel, sid)
    get().pushNotice(def ? t('input.agentActive', { name: def.name }) : t('input.agentCleared'))
  },

  selectNewChatAgent: (slug) => {
    const def = slug ? get().agentDefs.find((a) => a.slug === slug) : null
    set((s) => ({ newChatCfg: { ...s.newChatCfg, agentSlug: slug || undefined, ...(def?.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}) } }))
    if (def?.model) set({ newChatModel: def.model })
  },

  setNewChatWs: (ws) => set({ newChatWs: ws }),
  setNewChatCfg: (fn) => set((s) => ({ newChatCfg: fn(s.newChatCfg) })),
  setNewChatModel: (id) => set({ newChatModel: id }),
  // 预览改道:所有入口(文件面板/右栏工作区/对话内联)汇聚于此 —— 一律开主区标签页(wsfile 视图)。
  // 原 chatbox 上方浮层暂时停用(filePreview 永不置非空,ChatView 渲染块保留但不触发)。
  setFilePreview: (p) => { if (p) openWsFile(p); else set({ filePreview: null }) },

  patchConfig: (patch) => {
    set((s) => { void window.tangu?.setConfig(patch); return { cfg: { ...s.cfg, ...patch } } })
  },

  ensureEngineCaps: (engineId) => {
    if (!engineId || get().engineCaps[engineId]) return
    void api.getEngineCapabilities(get().cfg, engineId).then((caps) => set((s) => ({ engineCaps: { ...s.engineCaps, [engineId]: caps } })))
  },

  openSettings: (tab) => set({ settingsTab: tab ?? null, settingsOpen: true }),

  openMarket: () => set({ marketOpen: true }),

  openAchievements: () => set({ achievementsOpen: true }),
  closeAchievements: () => set({ achievementsOpen: false }),

  closeMarket: () => {
    set({ marketOpen: false })
    // 装了新技能/智能体/插件 → 刷新本地 Agent 目录 + 技能列表(让 /skill 选择器即时反映新技能,
    // 无需手动刷新桌面;system prompt 的技能段由托管后端每轮按需重扫,已即时生效)。
    get().refreshAgents()
    void api.listSkills(get().cfg).then((s) => set({ skillsList: s })).catch(() => { /* ignore */ })
  },

  onPluginInstalled: async () => {
    const t = get().tr
    try {
      // 重扫让后端立刻发现新插件(免重启);装即启用;提示可能需重启;跳转到对应设置。
      const r = await api.rescanPlugins(get().cfg)
      for (const id of r.addedIds) await api.setPluginEnabled(get().cfg, id, true).catch(() => {})
      get().toast(r.needsRestart ? t('market.pluginInstalledRestartHint') : t('market.pluginInstalledOk'))
      set({ marketOpen: false })
      get().openSettings(r.addedIds[0] ? (`plugin:${r.addedIds[0]}` as SettingsTab) : 'plugins')
    } catch (e: any) {
      get().toast(t('market.installFail', { e: e?.message || String(e) }), true)
    }
  },

  closeSettings: () => {
    set({ settingsOpen: false })
    // 设置里可能改了默认工作区目录 / Special Agents 开关 → 重读折算值刷新。
    void window.tangu?.getConfig().then((c) => set({ desktopConfig: c, homeDir: c.homeDir, defaultWsDir: c.defaultWorkspaceDir || '' }))
    void get().refreshSpecialEnabled(get().cfg)
    // 关设置后刷新本地 Agent 目录(设置页可能新建/改头像)。
    get().refreshAgents()
  },

  handleAuthExpired: () => {
    const s = get()
    if (!s.authInfo?.loggedIn) return // standalone/未登录:绝不踢去 Forsion 登录
    const now = Date.now()
    if (now - lastAuthExpiredAt < 10_000) return // 幂等去抖
    lastAuthExpiredAt = now
    const t = s.tr
    set({
      authInfo: { ...s.authInfo, loggedIn: false, tokenValid: false },
      connState: 'err',
      connMessage: t('app.sessionExpired'),
    })
    s.toast(t('app.sessionExpired'), true)
    // 通知常驻的账号卡(自管 authStatus,不订阅本 store)刷新 → 显示过期态 + 点击改走重新登录。
    try { window.dispatchEvent(new Event('tangu:auth-expired')) } catch { /* ignore */ }
    get().openSettings('forsion') // 复用现成 forsion tab 的登录入口
  },

  openFeedback: () => {
    if (get().authInfo?.loggedIn) set({ feedbackOpen: true })
    else {
      get().toast(get().tr('feedback.errNotLoggedIn'), true)
      set({ settingsOpen: true, settingsTab: 'forsion' })
    }
  },
  closeFeedback: () => set({ feedbackOpen: false }),

  setOnboarding: (on) => set({ onboarding: on }),
  setUpdateAvailable: (v) => set({ updateAvailable: v }),
  dismissUpdate: () => set({ updateDismissed: true }),
  setDetailWsKey: (k) => set({ detailWsKey: k }),
  setActiveSpecial: (k) => set({ activeSpecial: k }),
}))

/** run 结束清理(对齐 App.tsx endRun):删句柄/订阅 + 清 running + 非活跃则标未读。 */
function endRun(set: (fn: (s: AppState) => Partial<AppState>) => void, get: () => AppState, sessionId: string, runId: string): void {
  runAborts.delete(runId)
  subscribedRuns.delete(runId)
  stoppedRuns.delete(runId)
  const wd = runWatchdogs.get(runId)
  if (wd) { clearInterval(wd); runWatchdogs.delete(runId) }
  set((s) => {
    if (s.runningBySession[sessionId] !== runId) return {}
    const next = { ...s.runningBySession }
    delete next[sessionId]
    return { runningBySession: next }
  })
  if (get().activeId !== sessionId) {
    const next = new Set(get().unread)
    next.add(sessionId)
    saveUnread(next)
    set(() => ({ unread: next }))
  }
}
