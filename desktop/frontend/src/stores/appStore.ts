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
  MsgSeg, SessionRecord, SkillInfo, SubChat, TanguDesktopConfig, UiMessage, WorkspaceDescriptor, StoredDesktopConfig,
} from '../types'
import { DEFAULT_CLOUD_PROJECT, cloudProjectKey, sessionWorkspaceKey, SHOW_SYSTEM_PROMPT_KEY } from '../types'
import * as api from '../services/backendService'
import { abortRun, cancelSteer, listActiveRuns, resolveApproval, resolveInquiry, startRun, steerRun, subscribeRunEvents, testConnection } from '../services/agentRunService'
import { speakMessage, stopSpeaking, ttsState } from '../services/ttsService'
import { splitSuggestions } from '../views/chat2/suggest'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { openWsFile } from '../views/wsFileNav'
import type { Tab as SettingsTab } from '../components/SettingsModal'
import { ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } from '../components/OnboardingWizard'
import { track } from '../achievements/store'
import { act } from '../activity/log'
import { notifyApp } from './notificationStore'
import { DESK_EDIT_TOOLS, DESK_PERSIST_KEY, deskItemFor, extractStreamingString, isDuplicateShow, packDeskMap, replaceTop, resolveDeskPath, unpackDeskMap, type DeskItem } from './deskPlan'

export type { SettingsTab }

/** 主区特殊视图(从侧栏特殊卡片打开;作主区 leaf,与对话同组 tab)。 */
export type SpecialKind = 'agents' | 'workspace'

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

// 助手消息顺序段(直播归约):文字并入尾部 text 段;连续工具并入尾部 tools 段——保留文字↔工具发生顺序。
export function pushTextSeg(segs: MsgSeg[] | undefined, delta: string): MsgSeg[] {
  if (!delta) return segs || []
  const next = (segs || []).slice()
  const last = next[next.length - 1]
  if (last && last.t === 'text') next[next.length - 1] = { t: 'text', text: last.text + delta }
  else next.push({ t: 'text', text: delta })
  return next
}
export function pushToolSeg(segs: MsgSeg[] | undefined, id: string): MsgSeg[] {
  const next = (segs || []).slice()
  const last = next[next.length - 1]
  if (last && last.t === 'tools') next[next.length - 1] = { t: 'tools', ids: [...last.ids, id] }
  else next.push({ t: 'tools', ids: [id] })
  return next
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
// 计划批准时选了「自动开始执行」的 **run**:该 run done 时消费、自动发起执行消息(engine plan_approved 带 auto)。
// ⚠️ 按 runId 记而非 sessionId(Codex 评审 #4):按会话记的话,用户 stop 掉计划 run 后标记泄漏,
// 该会话下一个无关 run 的 done 会莫名自动「开始执行」。所有终结路径统一在 endRun 清理。
const planAutoStart = new Set<string>()
// 卡死兜底:SSE 偶尔丢「终止帧」(后端 run 挂死/被 orphan janitor 标失败但事件没进流)→ 助手消息永远停在
// streaming。看门狗周期性查:该 run 已不在后端活跃集 → 重载消息收尾(有内容标 done,无则 error),解除卡死。
const runWatchdogs = new Map<string, ReturnType<typeof setInterval>>()
const loadedHistory = new Set<string>()
/** 审批档缺省(全端统一「替我批准」);新会话没有记忆时的起步值。 */
export const DEFAULT_APPROVAL = 'auto-edit' as const
/** 新会话的起步档位 = 上次用的那套(没记忆过就用全端默认「替我批准」+ 不指定思考档)。
 *  只吐 AgentConfig 的键,好让调用方直接展开进 init;模型不在此(走 cfg.modelId 老路)。
 *  **云沙箱会话不带审批档**:引擎那边 approvalMode 缺席才等于 full-auto,写死 auto-edit 会让
 *  云会话的 MCP 调用开始逐个弹审批(gateToolCall 对 mcp__ 工具非 host 也过闸)。 */
export function stickyDefaults(dc: StoredDesktopConfig | null, host: boolean): Pick<AgentConfig, 'approvalMode' | 'thinkingLevel'> {
  const out: Pick<AgentConfig, 'approvalMode' | 'thinkingLevel'> = {}
  if (host) out.approvalMode = dc?.lastApprovalMode || DEFAULT_APPROVAL
  if (dc?.lastThinkingLevel) out.thinkingLevel = dc.lastThinkingLevel
  return out
}
/** 记住「上次用的」审批档/思考档:**新会话据此起步**。先落内存(web/mobile 无 window.tangu,
 *  至少本次会期内粘住),再异步写盘(桌面跨重启)。 */
function rememberDefaults(patch: Partial<StoredDesktopConfig>): void {
  useApp.setState((s) => ({ desktopConfig: { ...((s.desktopConfig || {}) as StoredDesktopConfig), ...patch } }))
  void window.tangu?.setConfig?.(patch).catch(() => {})
}
let lastAuthExpiredAt = 0 // handleAuthExpired 去抖:轮询/SSE/models 可能同时多次 401
const MAX_MSG_CHARS = 1_500_000 // 单条助手正文软上限(防超长正文+markdown 重渲染撑爆渲染进程)
const MAX_LIVE_SESSIONS = 8 // 内存中保留消息的会话数上限(LRU,切走的旧会话淘汰,下次进入重新拉)
const recentSessions: string[] = [] // 最近查看的会话 id(MRU 在前),用于 LRU 淘汰
/** 单条正文超上限则截断 + 标注(后端仍完整落库;仅界面侧防 OOM)。 */
function capContent(s: string): string {
  return s.length >= MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) + '\n\n[输出过长,界面已截断显示]' : s
}

type ConnState = 'idle' | 'ok' | 'err'

export type { DeskItem } from './deskPlan'
/** Agent Desk per-session 状态。纯 UI 态:不落库、不持久化、刷新即散场。 */
export interface DeskState {
  /** 从上到下的演出项(至多 2 格,2 格=上下分屏)。 */
  items: DeskItem[]
  /** agent 建议的宽度档位;用户拖过(userResized)后不再被 agent 覆盖。仅 open 态生效。 */
  size: 'half' | 'wide'
  /** 展示形态:缺省=卡片态(Pin Summary 下方的预览小卡);'open'=展开成侧板。
   *  用户可随时点卡片放大/缩回;agent 也可在 desk_present 里用 size(card/half/wide)显式切换
   *  (2026-07-26 用户裁决,废「形态 100% 用户主权」);自动上台(deskAutoShow)仍永不改形态。 */
  mode?: 'open'
  /** 用户拖出的自定义占比(0-1,优先于 size 档位;比例制对 body zoom 免疫)。 */
  fraction?: number
  userResized?: boolean
  note?: string
}
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
  engines: Array<{ id: string; name: string; available?: boolean; status?: 'available' | 'needs-signin' | 'not-installed'; defaultModel?: string }>
  engineCaps: Record<string, { models: Array<{ id: string; name: string; description?: string }>; commands: Array<{ name: string; description: string; hint?: string }> }>
  specialEnabled: { historian: boolean; muse: boolean }
  newChatWs: WorkspaceDescriptor | null
  /** 云端 Project 名列表(Penzor Cloud-Workspaces/Projects/;connect 后拉取,失败=只有默认 Tangu)。 */
  cloudProjects: string[]
  /** 已启用通道的工作区文件夹快照(channelsStore 轮询后写入;workspaces() 合并展示)。 */
  channelWorkspaces: WorkspaceDescriptor[]
  newChatCfg: AgentConfig
  newChatModel: string | null
  /** 瞬态:外部入口(反馈诊断/对话建 agent/插件)预填聊天框的草稿;Composer2 mount 消费一次即清,不落盘。 */
  pendingDraft: string | null
  /** 拖引用进聊天:追加到草稿末尾(区别于 pendingDraft 的整体覆盖)。seq 让连拖同一条也能触发。 */
  draftAppend: { text: string; seq: number } | null
  /** steer 等待区:run 跑动中发出的消息先等在这里,引擎 turn_boundary 注入后才进对话(id=引擎 userMessageId)。 */
  steerPendingBySession: Record<string, Array<{ id: string; text: string; attachments?: Attachment[] }>>
  /** ↑ 历史召回的补充池:steer 消息**入队即记**(类 pi addToHistory-on-enqueue),被删/被撤回后仍能从 ↑ 找回。 */
  steerSentBySession: Record<string, string[]>
  /** run 终结时未送达的插话回填输入框(per-session,防串会话;ChatView 并进 seedText 通道)。 */
  steerRestoreBySession: Record<string, string | undefined>
  filePreview: PreviewTarget | null
  messagesBySession: Record<string, UiMessage[]>
  configBySession: Record<string, AgentConfig>
  runningBySession: Record<string, string>
  groupVoting: Record<string, boolean>
  /** LLM 瞬时失败重试中(引擎 status/llm_retry 事件):渲染「第 N/M 次重试,Xs 后」。任何后续非 status 事件即清除。 */
  llmRetryBySession: Record<string, { attempt: number; max: number; waitMs: number; error?: string } | undefined>
  /** 手动 Compact 进度 0-100(undefined = 未在压缩)。ponytail: 客户端估算,compact 接口一次性返回没有进度信号。 */
  compactingBySession: Record<string, number | undefined>
  subChatsBySession: Record<string, SubChat[]>
  usageBySession: Record<string, { ctx: number; base: number; live: number }>
  /** Agent Desk:聊天右侧演出面板的 per-session 状态。 */
  deskBySession: Record<string, DeskState>
  /** 语音消息:按 agent 的生效开关(voice-message 插件启用 + 该 agent apply)。缓存,首次进会话惰性拉取。 */
  voiceOnByAgent: Record<string, boolean>
  unread: Set<string>
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
  refreshCloudProjects(c: TanguDesktopConfig): Promise<void>
  /** 新建云端 Project 并选为 new chat 目标。 */
  addCloudProject(name: string): Promise<void>
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
  /** 撤回一条等待中的插话(删除/↑取回)。返回消息文本;已注入或来不及则 null(等待区交给事件流收拾)。 */
  withdrawSteer(sessionId: string, msgId: string): Promise<string | null>
  /** 「立即插话」:打断当前 run,把等待区消息按序强发。 */
  steerNow(sessionId?: string | null): Promise<void>
  stop(sessionId?: string | null): void
  truncateAndResend(fromIndex: number, text: string, attachments: Attachment[], sessionId?: string | null): Promise<void>
  editUserMessage(messageId: string, newText: string, sessionId?: string | null): void
  regenerate(messageId: string, sessionId?: string | null): void
  branchFromMessage(messageId?: string, sessionId?: string | null): Promise<void>
  compact(sessionId?: string | null): Promise<void>
  decideApproval(messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>, sessionId?: string | null): Promise<void>
  answerInquiry(messageId: string, inquiryId: string, answer: string, sessionId?: string | null): Promise<void>
  /** Agent Desk:接收 desk_present 事件(白名单校验/静音/档位策略都在这)。 */
  deskPresent(sessionId: string, spec: Record<string, any>): void
  /** Agent Desk:编辑类工具成功后把目标文件自动搬上顶格(host 会话限定)。 */
  deskAutoShow(sessionId: string, toolId: string): void
  /** Agent Desk:编辑参数还在流式生成时把「直播格」搬上顶格(Cursor 式;内容由 LivePane 直接订阅)。 */
  deskLiveSync(sessionId: string, msgId: string, toolId: string, tool: string): void
  /** Agent Desk:清掉顶格残留的直播格(工具失败/未能落盘切换时)。 */
  deskLiveClear(sessionId: string, toolId: string): void
  /** Agent Desk:用户主动点开某文件(TaskSummary「正在编辑」入口):解除静音并上台。 */
  deskShowFile(sessionId: string, path: string): void
  patchDesk(sessionId: string, patch: Partial<DeskState>): void
  setExecConfig(patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd' | 'extraRoots' | 'verifyCommand'>, sessionId?: string | null): void
  /** remember=false:本次切换是「跟随 agent 预设」而非用户主动挑,不动新会话的起步默认。 */
  setSessionModel(modelId: string, sessionId?: string | null, remember?: boolean): void
  setSessionThinking(level: NonNullable<AgentConfig['thinkingLevel']>, sessionId?: string | null, remember?: boolean): void
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
  /** 预填聊天框草稿(外部 via-chat 入口的统一接缝);Composer2 消费后自行清空。 */
  setPendingDraft(text: string | null): void
  /** Composer 消费掉「未送达插话」的回填后清位(per-session)。 */
  clearSteerRestore(sessionId: string): void
  appendDraft(text: string): void
  clearDraftAppend(): void
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

/** Desk 会话快照:变更后 500ms 合并落盘(直播格在 pack 时剔除,超容量按最近展示截断)。
 *  localStorage 是会话键共享,多窗口各自启动时水化、写入合并为后写胜——与 desk 本身的
 *  per-session 语义一致;写失败(配额/隐私模式)静默容忍,退化回"刷新散场"。 */
let deskPersistTimer: ReturnType<typeof setTimeout> | null = null
function persistDeskSoon(): void {
  if (typeof localStorage === 'undefined') return
  if (deskPersistTimer) clearTimeout(deskPersistTimer)
  deskPersistTimer = setTimeout(() => {
    deskPersistTimer = null
    try { localStorage.setItem(DESK_PERSIST_KEY, packDeskMap(useApp.getState().deskBySession)) } catch { /* ignore */ }
  }, 500)
}

export const useApp = create<AppState>((set, get) => ({
  tr: (k) => k,
  // 云 web/mobile:boot() 异步回填前的早期请求(布局恢复后的轮询等)会拿默认 cfg 打
  // localhost:8787(控制台 ERR_CONNECTION_REFUSED 红噪音)。壳在挂载前已装好
  // window.tangu.cloudWeb + localStorage token(统一键 forsion_token),同步读即得正确初值。
  cfg: typeof window !== 'undefined' && (window as any).tangu?.cloudWeb
    ? { backendUrl: location.origin + '/api', token: (() => { try { return localStorage.getItem('forsion_token') || '' } catch { return '' } })(), modelId: '' }
    : { backendUrl: 'http://localhost:8787', token: '', modelId: '' },
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
  cloudProjects: [],
  channelWorkspaces: [],
  newChatCfg: {},
  newChatModel: null,
  pendingDraft: null,
  draftAppend: null,
  steerPendingBySession: {},
  steerSentBySession: {},
  steerRestoreBySession: {},
  filePreview: null,
  messagesBySession: {},
  configBySession: {},
  // 上次各会话展示的内容随快照复活("上次展示的东西还展示着");直播格是瞬态,不在快照里
  deskBySession: typeof localStorage !== 'undefined' ? unpackDeskMap(localStorage.getItem(DESK_PERSIST_KEY)) : {},
  voiceOnByAgent: {},
  runningBySession: {},
  groupVoting: {},
  llmRetryBySession: {},
  compactingBySession: {},
  subChatsBySession: {},
  usageBySession: {},
  unread: loadUnread(),
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

  // 垫片:旧 toast(text, error) → 通知系统(error 走 error 级=常驻手动关,其余 info 自动消失)。
  toast: (text, error = false) => {
    notifyApp({ text, level: error ? 'error' : 'info' })
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
    // 重试提示自清:重试后流恢复(token/…)或终结(done/error)的第一个非 status 事件就撤掉横幅。
    if (ev.type !== 'status' && get().llmRetryBySession[sessionId]) {
      set((s) => ({ llmRetryBySession: { ...s.llmRetryBySession, [sessionId]: undefined } }))
    }
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
          // ponytail: 顺序段用原始 delta;极长消息 capContent 后 segments 文字或略长于 content——罕见且已降级,不特殊处理。
          return { ...m, content: capContent(m.content + (pl.delta || '')), segments: pushTextSeg(m.segments, pl.delta || '') }
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
          if (i >= 0) { evs[i] = { ...evs[i], arguments: (evs[i].arguments || '') + (pl.delta || '') }; return { ...m, toolEvents: evs } }
          evs.push({ id: pl.id, name: pl.name || 'tool', arguments: pl.delta || '', done: false })
          return { ...m, toolEvents: evs, segments: pushToolSeg(m.segments, pl.id) }
        })
        // Agent Desk 直播:编辑参数还在流式生成就上台(state 只动上台/路径就位两次,内容 LivePane 自己订)。
        if (pl.name && DESK_EDIT_TOOLS.has(String(pl.name))) get().deskLiveSync(sessionId, assistantId, String(pl.id), String(pl.name))
        break
      case 'tool_call':
        if (pl.name === 'generate_image') { track('image.generate'); act('image.generate') }
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((tt) => tt.id === pl.id)
          const item = { id: pl.id, name: pl.name, arguments: pl.arguments, done: false, startedAt: pl.startedAt, parallelGroup: pl.parallelGroup }
          if (i >= 0) { evs[i] = { ...evs[i], ...item }; return { ...m, toolEvents: evs } }
          evs.push(item)
          return { ...m, toolEvents: evs, segments: pushToolSeg(m.segments, pl.id) }
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
        if (!pl.isError) get().deskAutoShow(sessionId, String(pl.id)) // 成功:磁盘真身顶格(覆盖直播格)
        get().deskLiveClear(sessionId, String(pl.id)) // 失败/未切换成功的直播格残留在此清场(成功路径上是 no-op)
        break
      case 'display_file':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m, displayFiles: [...(m.displayFiles || []), { name: pl.name, mime: pl.mime, path: pl.path, dataUrl: pl.dataUrl }],
        }))
        break
      case 'desk_present':
        get().deskPresent(sessionId, pl)
        break
      // desk_screenshot:引擎在等一张图 —— 截 Desk 面板回传(懒加载防 store↔views 循环依赖)。
      case 'desk_capture_request':
        if (pl.shotId) {
          const cfg = get().cfg
          void import('../views/chat2/deskCapture').then((m) => m.answerDeskCapture(cfg, runId, sessionId, String(pl.shotId)))
        }
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
        // 「批准,自动开始执行」:本 run 收尾(done)后自动发起执行(本轮工具集已冻结只读,执行必须是新 run)。
        if (pl.auto) planAutoStart.add(runId)
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
        // 附件随注入迁移(Codex 评审 #2):turn_boundary 刻意只带 id/content(附件可达数 MB,不过 SSE),
        // 附件从等待区条目上就地合并进新用户消息;引擎落库时存了 attachments,刷新后两边一致。
        const pendAtt = new Map((get().steerPendingBySession[sessionId] || [])
          .filter((p) => p.attachments?.length).map((p) => [p.id, p.attachments!] as const))
        // 注入达成:这些消息离开 steer 等待区(下方 additions 负责把它们插进对话)。
        if (users.length) {
          const injected = new Set(users.map((u) => u.id))
          set((s) => ({ steerPendingBySession: { ...s.steerPendingBySession, [sessionId]: (s.steerPendingBySession[sessionId] || []).filter((p) => !injected.has(p.id)) } }))
        }
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
          for (const u of users) if (!have.has(u.id)) additions.push({ id: u.id, role: 'user', content: u.content, attachments: pendAtt.get(u.id), status: 'done', timestamp: Date.now() })
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
            // 摘掉自动化建议围栏再念:手动朗读走的是 EditorialMessage 传来的 body,这里不摘就会
            // 把「forsion-suggest」和反引号念出来 —— 同一条消息两个入口读出两样东西。
            const spoken = msg?.content ? splitSuggestions(msg.content).text : ''
            if (spoken.trim()) {
              speakMessage(st.cfg, dc, assistantId, spoken).catch((e: any) => {
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
        {
          // 计划「批准并自动开始」:**先**消费本 run 的标记(endRun 会兜底清掉一切终结 run 的标记),
          // 再 endRun 清 running,最后发 kickoff(此刻无活跃 run → 正常起新 run 而非误走 steer)。
          const autoKick = planAutoStart.delete(runId)
          endRun(set, get, sessionId, runId)
          if (autoKick) void get().send(t('plan.autoKickoff'), [], undefined, undefined, undefined, sessionId)
        }
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
        endRun(set, get, sessionId, runId) // planAutoStart 的作废清理在 endRun 里统一做(含 stop/看门狗路径)
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
      case 'status':
        // 引擎的其余 status(generating 进度等)对桌面 UI 无用,只取网络重试提示。
        if (pl.phase === 'llm_retry') {
          set((s) => ({
            llmRetryBySession: {
              ...s.llmRetryBySession,
              [sessionId]: {
                attempt: Number(pl.attempt) || 1, max: Number(pl.max) || 0,
                waitMs: Number(pl.waitMs) || 0, error: pl.error ? String(pl.error) : undefined,
              },
            },
          }))
        }
        break
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
    void get().refreshCloudProjects(c)
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
    // 见 backendManager.getToken),会把新用户误判为已配置。真实凭证只看 authStatus.loggedIn(读 auth.json,
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
    // 登录态变化(含 CLI tangu login 等外部来源,主进程 auth.json watcher 广播)→ 刷新 authInfo。
    // managed 后端的重连由上面 onBackendStatus 的 ready 分支承接(登录变化会触发后端带新 token 重启)。
    window.tangu?.onAuthChanged?.(() => {
      void window.tangu?.authStatus?.().then((a) => set({ authInfo: a })).catch(() => set({ authInfo: null }))
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
        ? { execMode: 'host', approvalMode: DEFAULT_APPROVAL, cwd: sess.project_path }
        : {}
      // 本地已有的键优先(local-wins):本地每次改配置都会同步 PUT,永远不旧于服务端;而这里的
      // fetch 可能与「新会话初始配置 PUT」竞速,整体替换会把刚选好的 agentSlug/thinkingLevel 冲掉。
      set((s) => ({ configBySession: { ...s.configBySession, [sessionId]: { ...base, ...config, ...(s.configBySession[sessionId] || {}) } } }))
      // ctx 只有流式 usage 事件会喂,重开会话后本地是空的 → 用服务端回放的「最近一次上下文占用」兜底
      // (本地已有值更新,不覆盖:历史加载可能与正在跑的 run 竞速)。
      void api.getSessionUsage(c, sessionId)
        .then(({ base, ctx }) => set((s) => ({ usageBySession: { ...s.usageBySession, [sessionId]: { ctx: s.usageBySession[sessionId]?.ctx || ctx, base, live: 0 } } })))
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
      if (s) set({ activeWorkspaceKey: sessionWorkspaceKey(s) })
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
    const { defaultWsDir, homeDir, sessions, archivedSessions, cloudProjects, channelWorkspaces, tr: t } = get()
    const defPath = defaultWsDir || homeDir || null
    // 云端 Project 列表(默认 Tangu 恒在首位);每个项目一个工作区分组。
    // 并上会话行派生的项目名:/agent/projects 拉取失败/滞后时,含该 project_name 的会话
    // 仍有组头可挂(否则 SidebarPane 只渲染 workspaces() 里的组,这些会话会整组隐身)。
    const projSet = new Set<string>([DEFAULT_CLOUD_PROJECT, ...cloudProjects])
    for (const s of [...sessions, ...archivedSessions]) {
      if (!s.project_path && s.project_name) projSet.add(s.project_name)
    }
    const projNames = [...projSet]
    const list: WorkspaceDescriptor[] = [
      ...projNames.map((p): WorkspaceDescriptor => ({
        key: cloudProjectKey(p), name: p, kind: 'cloud', path: null, system: p === DEFAULT_CLOUD_PROJECT, project: p,
      })),
      { key: defaultWsDir || '__default_ws__', name: t('app.defaultWorkspace'), kind: 'local', path: defPath, system: true },
    ]
    const seen = new Set<string>([...projNames.map(cloudProjectKey), defaultWsDir || '__default_ws__'])
    // 已启用通道的专属工作区文件夹(webot/tgbot/qqbot;channelsStore 轮询维护,通道停用则回落普通本地组)。
    for (const cw of channelWorkspaces) {
      if (!seen.has(cw.key)) { list.push(cw); seen.add(cw.key) }
    }
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
      // 通道文件夹:走引擎通道会话接口(盖默认 Agent/模型 + 切为正在连接),不是普通 createSession。
      if (ws.kind === 'channel' && ws.channel) {
        const sid = await api.newChannelSession(get().cfg, ws.channel)
        act('chat.new', { s: sid.slice(0, 6) })
        await get().refreshSessions(get().cfg)
        loadedHistory.add(sid)
        get().setActiveId(sid)
        return
      }
      const path = ws.kind === 'local' ? (ws.path || get().defaultWsDir || get().homeDir || null) : null
      const cloudProject = ws.kind === 'cloud' ? (ws.project || DEFAULT_CLOUD_PROJECT) : null
      const s = await api.createSession(get().cfg, path
        ? { project_path: path, project_name: ws.name }
        : cloudProject ? { project_name: cloudProject } : undefined)
      act('chat.new', { s: s.id.slice(0, 6) })
      set((st) => ({ sessions: [s, ...st.sessions] }))
      loadedHistory.add(s.id) // 先标记再 setActiveId(其内部 loadSessionHistory 会拉空配置冲掉 init,同 send)
      get().setActiveId(s.id)
      // 新会话延续「上次用的」档位(审批 + 思考;模型走 cfg.modelId 的老路)。
      const sticky = stickyDefaults(get().desktopConfig, !!path)
      const init: AgentConfig = path
        ? { ...sticky, execMode: 'host', cwd: path }
        : { ...sticky, execMode: 'sandbox', ...(cloudProject ? { workspaceProject: cloudProject } : {}) }
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

  refreshCloudProjects: async (c) => {
    try {
      const names = await api.listProjects(c)
      set({ cloudProjects: names })
    } catch { /* 云端不可用/standalone → 保持现值(workspaces() 恒补默认 Tangu) */ }
  },

  addCloudProject: async (name) => {
    const t = get().tr
    const clean = name.trim().slice(0, 100)
    if (!clean) return
    try {
      await api.createProject(get().cfg, clean)
      set((st) => ({ cloudProjects: st.cloudProjects.includes(clean) ? st.cloudProjects : [...st.cloudProjects, clean] }))
      const ws = get().workspaces().find((w) => w.kind === 'cloud' && w.project === clean)
      if (ws) set({ newChatWs: ws })
    } catch (e: any) {
      get().toast(t('app.createProjectFail', { e: e?.message || e }), true)
    }
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

  // ── Agent Desk:聊天右侧演出面板。会话级快照落 localStorage(persistDeskSoon),
  //    重开会话/重启应用时上次展示的内容复活;直播格是流式瞬态,不落快照。 ──
  deskPresent: (sessionId, spec) => {
    if (!get().desktopConfig?.agentDeskEnabled) return
    const cur = get().deskBySession[sessionId]
    const views = (Array.isArray(spec?.views) ? spec.views : [])
      .filter((v: any) => v && ((v.type === 'file' && typeof v.path === 'string' && v.path)
        || (v.type === 'view' && typeof v.view === 'string' && v.view)))
      .slice(0, 2)
    if (!views.length) return
    const ts = Date.now()
    const items: DeskItem[] = views.map((v: any, i: number) => v.type === 'view'
      ? {
          key: `view:${v.view}@${ts}:${i}`, path: '', name: v.name || v.view, at: ts,
          view: { type: v.view, ...(v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? { params: v.params } : {}) },
        }
      : { key: `${v.path}@${ts}:${i}`, path: v.path, name: v.name || v.path.split(/[\\/]/).pop() || v.path, at: ts })
    const size: DeskState['size'] = cur?.userResized
      ? cur.size
      : (spec.size === 'wide' ? 'wide' : spec.size === 'half' ? 'half' : cur?.size || 'half')
    // size 也是形态指令(用户裁决):card=收回卡片,half/wide=展开侧板;不带 size=保持现状。
    const mode: DeskState['mode'] = spec.size === 'card' ? undefined
      : spec.size === 'half' || spec.size === 'wide' ? 'open' : cur?.mode
    set((s) => ({ deskBySession: { ...s.deskBySession, [sessionId]: { ...cur, items, size, mode, note: typeof spec.note === 'string' ? spec.note : cur?.note } } }))
    persistDeskSoon()
  },
  deskAutoShow: (sessionId, toolId) => {
    if (!get().desktopConfig?.agentDeskEnabled) return
    const cur = get().deskBySession[sessionId]
    const cfg = get().configBySession[sessionId] || {}
    const session = get().sessions.find((x) => x.id === sessionId)
    // 面板读文件走 readHostFile,只对本机会话有意义(execMode 未加载时按 project_path 兜底,同 ChatView)。
    if (cfg.execMode ? cfg.execMode !== 'host' : !session?.project_path) return
    let ev: { name?: string; arguments?: string } | undefined
    const msgs = get().messagesBySession[sessionId] || []
    outer: for (let i = msgs.length - 1; i >= 0; i--) {
      for (const e of msgs[i].toolEvents || []) if (e.id === toolId) { ev = e; break outer }
    }
    if (!ev?.name || !DESK_EDIT_TOOLS.has(ev.name)) return
    let raw = ''
    try { raw = String(JSON.parse(ev.arguments || '{}')?.path || '') } catch { return }
    const p = resolveDeskPath(raw, cfg.cwd || session?.project_path || undefined)
    if (!p) return
    const now = Date.now()
    // 顶格是直播格时必须被磁盘真身替换,节流只防「磁盘格连续重挂」。
    if (!cur?.items[0]?.live && isDuplicateShow(cur?.items[0], p, now)) return
    const item = deskItemFor(p, now)
    set((s) => {
      const c = s.deskBySession[sessionId] ?? { items: [], size: 'half' as const }
      return { deskBySession: { ...s.deskBySession, [sessionId]: { ...c, items: replaceTop(c.items, item) } } }
    })
    persistDeskSoon()
  },
  deskLiveSync: (sessionId, msgId, toolId, tool) => {
    if (!get().desktopConfig?.agentDeskEnabled) return
    const cur = get().deskBySession[sessionId]
    const cfg = get().configBySession[sessionId] || {}
    const session = get().sessions.find((x) => x.id === sessionId)
    if (cfg.execMode ? cfg.execMode !== 'host' : !session?.project_path) return
    const top = cur?.items[0]
    const already = top?.live?.toolId === toolId
    if (already && top!.path) return // 已上台且路径就位:内容直播由 LivePane 订阅,state 不再动
    // 从累积参数里试提目标路径(可能还没流到)
    let p: string | null = null
    const msgs = get().messagesBySession[sessionId] || []
    outer: for (let i = msgs.length - 1; i >= 0; i--) {
      for (const e of msgs[i].toolEvents || []) if (e.id === toolId) {
        const raw = extractStreamingString(e.arguments || '', 'path')
        p = raw ? resolveDeskPath(raw.value, cfg.cwd || session?.project_path || undefined) : null
        break outer
      }
    }
    if (already && !p) return
    const item: DeskItem = {
      key: `live:${toolId}`, // key 稳定:路径就位不 remount,tool_result 换磁盘格才 remount
      path: p || '',
      name: p ? (p.split(/[\\/]/).pop() || p) : '…',
      at: Date.now(),
      live: { msgId, toolId, tool },
    }
    set((s) => {
      const c = s.deskBySession[sessionId] ?? { items: [], size: 'half' as const }
      const items = c.items[0]?.live?.toolId === toolId ? [item, ...c.items.slice(1)] : replaceTop(c.items, item)
      return { deskBySession: { ...s.deskBySession, [sessionId]: { ...c, items } } }
    })
    persistDeskSoon() // 直播格本身不落盘,但 replaceTop 可能挤掉了要落盘的磁盘格
  },
  deskLiveClear: (sessionId, toolId) => {
    set((s) => {
      const c = s.deskBySession[sessionId]
      if (!c || c.items[0]?.live?.toolId !== toolId) return {}
      return { deskBySession: { ...s.deskBySession, [sessionId]: { ...c, items: c.items.slice(1) } } }
    })
    persistDeskSoon()
  },
  deskShowFile: (sessionId, path) => {
    if (!get().desktopConfig?.agentDeskEnabled) return
    set((s) => {
      const c = s.deskBySession[sessionId] ?? { items: [], size: 'half' as const }
      // 顶格正是这个文件的直播格 → 别打断直播,解除静音即可
      const items = c.items[0]?.live && c.items[0].path === path ? c.items : replaceTop(c.items, deskItemFor(path, Date.now()))
      // 用户点了「正在编辑」入口 = 用户动作,直接展开(卡片态 → 侧板)
      return { deskBySession: { ...s.deskBySession, [sessionId]: { ...c, mode: 'open' as const, items } } }
    })
    persistDeskSoon()
  },
  patchDesk: (sessionId, patch) => {
    set((s) => {
      // upsert:卡片态是默认态,展开/拖宽可能发生在 desk 态还没建过的时候
      const c = s.deskBySession[sessionId] ?? { items: [], size: 'half' as const }
      return { deskBySession: { ...s.deskBySession, [sessionId]: { ...c, ...patch } } }
    })
    persistDeskSoon()
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
      // 云沙箱新会话一律落云端 Project(选择器未选 = 默认 Tangu 项目):文件跨会话共享且 Penzor 可见。
      const cloudProject = path ? null : (ws?.kind === 'cloud' ? (ws.project || DEFAULT_CLOUD_PROJECT) : DEFAULT_CLOUD_PROJECT)
      const s = await api.createSession(get().cfg, path
        ? { project_path: path, project_name: ws?.name || t('app.defaultWorkspace') }
        : { project_name: cloudProject! }).catch(() => null)
      if (!s) { get().toast(t('app.cannotCreateSession'), true); return false }
      set((st) => ({ sessions: [s, ...st.sessions] }))
      // 必须先标记再 setActiveId:setActiveId 内部会 void loadSessionHistory,新会话此刻服务端
      // 配置还是空的,拉回来会把下面刚写入的 implicitInit(含选中的 agentSlug/thinkingLevel)整体
      // 冲掉 → 第二轮就「换人」。先标记使其 no-op。
      loadedHistory.add(s.id)
      get().setActiveId(s.id)
      sid = s.id
      const draft = { ...stickyDefaults(get().desktopConfig, !!path), ...get().newChatCfg }
      implicitInit = path
        ? { ...draft, execMode: 'host', cwd: path }
        : { ...draft, execMode: 'sandbox', cwd: undefined, ...(cloudProject ? { workspaceProject: cloudProject } : {}) }
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
    act(wasNewChat ? 'chat.new' : 'chat.send', { s: sessionId.slice(0, 6), text })
    // Agent Desk:新一条用户消息解除「用户关过面板」的静音。
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
    // 辅助视觉模型:本端刚改完就生效(不必等引擎那边 config.json 的 60s 槽缓存过期)。
    if (!agentConfig.visionModelId && get().cfg.visionModelId) agentConfig.visionModelId = get().cfg.visionModelId
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
          // 不直接上屏:消息进「steer 等待区」,引擎在迭代边界注入并发 turn_boundary 后才进对话
          // (此前的立即上屏是谎报——引擎此刻还没读到它)。入队即记 ↑ 历史(类 pi):删/撤回后仍可找回。
          set((s) => steerAcceptPatch(s, sessionId, activeRunId, { id: sr.userMessageId || `u-${Date.now()}`, text, attachments }))
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

  withdrawSteer: async (sessionId, msgId) => {
    const item = (get().steerPendingBySession[sessionId] || []).find((p) => p.id === msgId)
    if (!item) return null
    const runId = get().runningBySession[sessionId]
    if (runId) {
      const r = await cancelSteer(get().cfg, runId, msgId).catch(() => ({ ok: false, gone: false }))
      // 来不及(已注入/引擎已收尾):等待区的这条交给 turn_boundary 或 endRun 收拾,别在这里硬拔。
      if (!r.ok) return null
    }
    set((s) => ({ steerPendingBySession: { ...s.steerPendingBySession, [sessionId]: (s.steerPendingBySession[sessionId] || []).filter((p) => p.id !== msgId) } }))
    return item.text
  },

  steerNow: async (targetSessionId) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) return
    const pending = (get().steerPendingBySession[sid] || []).slice()
    if (!pending.length) return
    // 先逐条撤销**引擎侧**队列再打断(Codex 评审 #3):否则 abort 落地前引擎可能恰好到迭代边界把
    // 队列注入落库,重发就成了双份指令。撤不掉(gone=已注入/正在注入)或网络错的条目一律不重发
    // ——宁可少发一条(文本仍在 ↑ 历史),不可让模型收到两遍。
    const runId = get().runningBySession[sid]
    const resend: typeof pending = []
    for (const p of pending) {
      if (!runId) { resend.push(p); continue }
      const r = await cancelSteer(get().cfg, runId, p.id).catch(() => ({ ok: false }))
      if (r.ok) resend.push(p)
    }
    // 清等待区再 stop:endRun 的「余量回填输入框」只兜真正没送出去的,这批要么马上强发要么已注入。
    set((s) => ({ steerPendingBySession: { ...s.steerPendingBySession, [sid]: [] } }))
    get().stop(sid)
    // ponytail: 点「插话」=撤回成功的按原序冲出去(实际队列深度≈1)。第一条起新 run,后续几条在新
    // run 上要么重新排进等待区、要么(新 run 尚未活跃)各自成排队 run——两种都保序,语义等价。
    for (const p of resend) {
      await get().send(p.text, p.attachments || [], undefined, undefined, undefined, sid)
    }
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
    if (get().compactingBySession[sid] !== undefined) return // 压缩中,别叠第二次
    const modelId = get().sessions.find((s) => s.id === sid)?.model_id || get().cfg.modelId || get().modelsResp?.defaultModelId || ''
    const setPct = (pct: number | undefined) =>
      set((st) => ({ compactingBySession: { ...st.compactingBySession, [sid]: pct } }))
    // ponytail: 百分比是客户端估算 —— compact 是一次性 POST,服务端不吐进度。缓动 1-e^(-t/8s) 逼近
    // 90%,响应到达才冲 100%。要真实百分比得把该接口改成 SSE(阶段 + 已生成 token/上限),暂不值得。
    setPct(0)
    const t0 = Date.now()
    const timer = setInterval(() => setPct(Math.round(90 * (1 - Math.exp(-(Date.now() - t0) / 8000)))), 120)
    try {
      const r = await api.compactSession(get().cfg, sid, modelId)
      get().pushNotice(r.ok ? t('input.compactDone', { n: r.summarizedCount || 0 }) : t('input.compactSkip', { reason: r.reason || '' }))
    } catch (e: any) { get().toast(t('input.compactFail', { e: e?.message || e }), true) }
    finally {
      clearInterval(timer)
      setPct(100) // 满格停一拍再撤,别让进度条在半途消失
      setTimeout(() => set((st) => (st.compactingBySession[sid] === 100
        ? { compactingBySession: { ...st.compactingBySession, [sid]: undefined } }
        : {})), 700)
    }
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
    if (patch.approvalMode) rememberDefaults({ lastApprovalMode: patch.approvalMode })
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) { set((s) => ({ newChatCfg: { ...s.newChatCfg, ...patch } })); return } // 空态:落新会话草稿
    set((s) => {
      const next = { ...(s.configBySession[sid] || {}), ...patch }
      void api.putSessionConfig(get().cfg, sid, next).catch(() => {})
      return { configBySession: { ...s.configBySession, [sid]: next } }
    })
  },

  setSessionModel: (modelId, targetSessionId, remember = true) => {
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    // 在会话里换模型 = 也换掉全局默认(新会话延续);cfg.modelId 本来就是「新会话用哪个模型」的真源。
    if (remember) set((s) => { void window.tangu?.setConfig?.({ modelId }); return { cfg: { ...s.cfg, modelId } } })
    if (!sid) { set({ newChatModel: modelId }); return }
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sid ? { ...x, model_id: modelId } : x)),
      archivedSessions: s.archivedSessions.map((x) => (x.id === sid ? { ...x, model_id: modelId } : x)),
    }))
    void api.updateSession(get().cfg, sid, { model_id: modelId }).catch((e) => get().toast(get().tr('app.modelSwitchSaveFail', { e: e?.message || e }), true))
  },

  setSessionThinking: (level, targetSessionId, remember = true) => {
    if (remember) rememberDefaults({ lastThinkingLevel: level })
    const sid = targetSessionId === undefined ? get().activeId : targetSessionId
    if (!sid) { set((s) => ({ newChatCfg: { ...s.newChatCfg, thinkingLevel: level } })); return }
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
    // 语音消息插件是本地引擎能力:云 web 无本地后端,早期还会拿初始默认 cfg(localhost:8787)打一发
    // 连接拒绝的请求(控制台红噪音)且把失败缓存成关 —— 云端直接视为关,不发请求。
    if ((window as any).tangu?.cloudWeb) return
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
    // remember=false:这是 agent 预设强加的,不该把用户的「新会话默认模型/思考档」也一并改掉。
    if (def?.model) get().setSessionModel(def.model, sid, false)
    if (def?.thinkingLevel) get().setSessionThinking(def.thinkingLevel, sid, false)
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
  setPendingDraft: (text) => set({ pendingDraft: text }),
  clearSteerRestore: (sessionId) => set((s) => ({ steerRestoreBySession: { ...s.steerRestoreBySession, [sessionId]: undefined } })),
  appendDraft: (text) => set((s) => ({ draftAppend: { text, seq: (s.draftAppend?.seq || 0) + 1 } })),
  clearDraftAppend: () => set({ draftAppend: null }),
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
      // 重扫让后端立刻发现新插件(免重启);装即启用;提示可能需重启。
      // 不再自动关市场 / 跳设置:装完只 toast「已安装」,用户在插件详情里自行「打开设置」。
      const r = await api.rescanPlugins(get().cfg)
      for (const id of r.addedIds) await api.setPluginEnabled(get().cfg, id, true).catch(() => {})
      get().toast(r.needsRestart ? t('market.pluginInstalledRestartHint') : t('market.pluginInstalledOk'))
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

/** steer 被引擎受理后的等待区落位(Codex 评审 #1):turn_boundary 走 SSE,可能抢在 POST 响应之前
 *  到达——消息已上屏、或 run 已易主/终结时**不进等待区**(否则 chip 永久残留,run 终结还会把已
 *  送达的消息错误回填输入框)。↑ 历史(steerSent)无条件记:「入队即记」是它的公约。 */
export function steerAcceptPatch(
  s: Pick<AppState, 'messagesBySession' | 'runningBySession' | 'steerPendingBySession' | 'steerSentBySession'>,
  sessionId: string,
  runId: string,
  item: { id: string; text: string; attachments?: Attachment[] },
): Partial<AppState> {
  const sent = { steerSentBySession: { ...s.steerSentBySession, [sessionId]: [...(s.steerSentBySession[sessionId] || []), item.text] } }
  const already = (s.messagesBySession[sessionId] || []).some((m) => m.id === item.id)
  const stillRunning = s.runningBySession[sessionId] === runId
  if (already || !stillRunning) return sent
  return { ...sent, steerPendingBySession: { ...s.steerPendingBySession, [sessionId]: [...(s.steerPendingBySession[sessionId] || []), item] } }
}

/** run 结束清理(对齐 App.tsx endRun):删句柄/订阅 + 清 running + 非活跃则标未读。 */
function endRun(set: (fn: (s: AppState) => Partial<AppState>) => void, get: () => AppState, sessionId: string, runId: string): void {
  runAborts.delete(runId)
  subscribedRuns.delete(runId)
  stoppedRuns.delete(runId)
  // 计划自动开始的兜底清理:done 路径在调 endRun **之前**已消费;其余一切终结路径(stop/错误/看门狗)
  // 在此作废,防止标记泄漏到该会话后续无关 run(Codex 评审 #4)。
  planAutoStart.delete(runId)
  const wd = runWatchdogs.get(runId)
  if (wd) { clearInterval(wd); runWatchdogs.delete(runId) }
  set((s) => {
    // 迟到的旧 run 终结事件不碰任何状态(尤其不许动等待区——新 run 的插话还排着队)。
    if (s.runningBySession[sessionId] !== runId) return {}
    const next = { ...s.runningBySession }
    delete next[sessionId]
    // run 终结时还没被注入的插话:引擎侧队列已丢,回填该会话的输入框(类 pi「Esc=先取回队列再中止」)。
    // 自然收尾(done)前引擎会把队列全量注入,这里有货基本只出现在中止/失败路径。
    const leftover = s.steerPendingBySession[sessionId]
    return {
      runningBySession: next,
      ...(leftover?.length ? {
        steerPendingBySession: { ...s.steerPendingBySession, [sessionId]: [] },
        steerRestoreBySession: { ...s.steerRestoreBySession, [sessionId]: leftover.map((p) => p.text).join('\n\n') },
      } : {}),
    }
  })
  if (get().activeId !== sessionId) {
    const next = new Set(get().unread)
    next.add(sessionId)
    saveUnread(next)
    set(() => ({ unread: next }))
  }
}
