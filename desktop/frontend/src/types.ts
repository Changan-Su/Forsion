/** standalone /agent 契约的前端类型(与包内 routes/eventBus 一致)。 */

export interface TanguDesktopConfig {
  backendUrl: string
  token: string
  modelId: string
}

export interface StartRunResult {
  runId: string
  assistantMessageId: string
  userMessageId: string
}

/** SSE 事件:{ seq, type, payload }。type ∈ token/reasoning/tool_call/tool_result/tool_stream/status/usage/approval_request/approval_result/turn_boundary/done/error。turn_boundary=运行时转向回合切分(关闭旧助手段、插入用户消息、开新助手段)。 */
export interface AgentRunEvent {
  seq: number
  type: string
  payload?: any
}

// ── M3 数据 API 形状 ──────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string
  title: string | null
  model_id: string | null
  archived: boolean
  emoji: string | null
  agent_config: AgentConfig | null
  /** 项目工作区(本机模式;云端会话为 null → 侧栏归「未分组」)。 */
  project_path?: string | null
  project_name?: string | null
  created_at: string
  updated_at: string
}

// ── Special Agents（Historian / Muse;本地）──────────────────────────────────
export interface HistorianConfig {
  enabled: boolean
  modelId: string
  everyTitleRounds: number
  everyMemoryRounds: number
  firstRoundTrigger: boolean
  prompt: string
}
export interface MuseConfig {
  enabled: boolean
  modelId: string
  restartWindowHours: number
  maxRestartsPerWindow: number
  maxIterationsPerCycle: number
  maxTodosPerWindow: number
  supervisorPollMinutes: number
  compactAtRatio: number
  activeHours: { start: number; end: number } | null
  prompt: string
  allowedFolders: string[]
}
export interface SpecialAgentsConfig { historian: HistorianConfig; muse: MuseConfig }

export interface HistorianActivityItem {
  id: string
  action: string
  detail: string
  session_ref: string | null
  created_at: string
}
export interface MuseTodo {
  id: string
  title: string
  detail: string | null
  status: 'pending' | 'injected' | 'done' | 'dismissed'
  source_session_id: string | null
  created_at: string
}
export interface MuseStatusInfo {
  enabled: boolean
  hasModel: boolean
  running: boolean
  restartsThisWindow: number
  maxRestartsPerWindow: number
  lastCycleAt: number | null
  lastError: string | null
  sessionId: string | null
}

/** 本地 Normal Agent 定义(~/.tangu/agents/<slug>.md;后端 agentRegistry 解析)。 */
export interface NormalAgentDef {
  slug: string
  name: string
  description: string
  model: string
  tools: string[]
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | ''
  maxIterations: number | null
  approvalMode: 'readonly' | 'auto-edit' | 'full-auto' | ''
  createdBy: 'user' | 'agent'
  createdAt: string
  systemPrompt: string
}

export interface AgentConfig {
  systemPrompt?: string
  /** 激活的 Normal Agent slug(后端 agentLoop 解析注入人格/模型/工具)。 */
  agentSlug?: string
  /** 外部 agent 引擎 id(如 'claude-code'):设了就把整个 turn 委托给该 ACP 引擎而非 Tangu 自有 loop。host-only。 */
  engineId?: string
  /** 为外部引擎选的模型(经 ACP setSessionModel 应用);空=用引擎默认。 */
  engineModelId?: string
  maxIterations?: number
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
  enabledSkillIds?: string[]
  enabledToolIds?: string[]
  /** 本会话启用的 MCP server 名单(缺省=全部已连接 server)。 */
  enabledMcpServers?: string[]
  execMode?: 'sandbox' | 'host'
  cwd?: string
  approvalMode?: 'readonly' | 'auto-edit' | 'full-auto'
  /** 计划模式(类 Claude plan mode):只读工具集,agent 经 exit_plan_mode 提交计划求批准。 */
  planMode?: boolean
  /** 群聊模式:≥2 个 Normal Agent 轮流发言、投票、可总结。host-only。 */
  groupChat?: boolean
  /** 群聊参与者 slug(≥2;含已存 Normal Agent 与临时 Agent,按顺序)。 */
  groupAgents?: string[]
  /** 临时 Agent 定义(仅本会话群聊用,不持久化到 ~/.tangu/agents)。slug 在 groupAgents 中列出。 */
  groupTempAgents?: NormalAgentDef[]
  /** 讨论强度(仅 UI 展示;轮数以 groupMaxRounds 为准)。 */
  groupIntensity?: 'relaxed' | 'medium' | 'intense' | 'custom'
  /** 最大讨论轮数(轻松3/中等7/激烈15/自定义N;后端 clamp 1..30)。 */
  groupMaxRounds?: number
}

/** 侧栏工作区:Cloud(云沙箱,project_path 为空)或本地目录(host 执行,cwd=path)。 */
export interface WorkspaceDescriptor {
  /** 分组键:cloud 用 CLOUD_WORKSPACE_KEY 哨兵;本地用绝对路径(= project_path)。 */
  key: string
  name: string
  kind: 'cloud' | 'local' | 'wechat'
  /** 本地工作目录绝对路径;cloud 为 null。 */
  path: string | null
  /** 常驻系统工作区(Cloud / Tangu 默认):不可重命名 / 移除。其余本地工作区(由会话 project_path 派生)可管理。 */
  system?: boolean
}

/** 「Cloud 工作区」分组键哨兵(project_path 为空的会话归此组;真实本地路径永不为此值)。 */
export const CLOUD_WORKSPACE_KEY = '__cloud__'

export interface MessageRecord {
  id: string
  role: 'user' | 'model' | 'assistant' | string
  content: string | null
  reasoning: string | null
  tool_calls: any[] | null
  tool_results: any[] | null
  attachments: any[] | null
  timestamp: number
  model_id: string | null
  is_error: boolean
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  source: 'forsion' | 'direct'
  /** 模型上下文窗口(tokens);输入框「上下文占比」进度条用。后端缺省回退全局默认。 */
  contextWindow?: number
}

export interface ModelsResponse {
  models: ModelInfo[]
  directProviders: Array<{ providerId: string; baseUrl?: string; modelIds?: string[] }>
  defaultModelId: string | null
  /** 云端托管面诊断:empty=可达但 admin 没配模型;error=不可达/未授权/未部署 brain-api。 */
  forsion?: { status: 'ok' | 'empty' | 'error'; detail: string | null }
}

/** ~/.tangu/providers.json 一项(desktop Providers 页编辑;apiKey 只在本机文件,不进 renderer 之外)。 */
export interface DirectProviderConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelIds?: string[]
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  icon: string | null
  category: string | null
  /** local=Tangu 本地;claude/codex=实时识别的外部生态;user=本人已上云;cloud/缺省=全局云端。 */
  source?: 'local' | 'claude' | 'codex' | 'user' | 'cloud'
}

export interface ToolsResponse {
  builtins: Array<{ name: string; description: string; mode: 'sandbox' | 'host' | 'both' }>
  custom: Array<{ id: string; name: string; description: string; executor: string }>
  /** MCP 分区(仅本地后端;云端恒 [] / 旧后端缺省)。 */
  mcp?: Array<{
    server: string
    transport: 'stdio' | 'http' | 'sse'
    status: 'connected' | 'connecting' | 'error' | 'disabled'
    error: string | null
    tools: Array<{ name: string; description: string }>
  }>
}

// ── 跨生态 agent 资产发现(desktop discovery:scan;~/.claude、~/.codex、~/.hermes)──

export type DiscoveryEcosystem = 'claude-code' | 'codex' | 'hermes'

export interface DiscoveredSkill {
  ecosystem: DiscoveryEcosystem
  id: string
  name: string
  description: string
  sourceDir: string
}

export interface DiscoveredMcp {
  ecosystem: DiscoveryEcosystem
  name: string
  config: McpServerConfigEntry
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[]
  mcpServers: DiscoveredMcp[]
}

/** 环境检测一项(首启向导;installId 为 env:run 的 opaque 凭据)。 */
export interface EnvProbeResult {
  tool: string
  found: boolean
  version: string | null
  installId: string | null
  installCommand: string | null
}

/** ~/.tangu/mcp.json 一项。 */
export interface McpServerConfigEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'stdio' | 'http' | 'sse'
  headers?: Record<string, string>
  timeoutMs?: number
  enabled?: boolean
}

export interface WorkspaceFileMeta {
  path: string
  size: number
  mimeType: string
  updatedAt: number
}

export interface Attachment {
  name: string
  mimeType: string
  /** base64(无 dataURL 前缀) */
  data: string
  size: number
}

// ── 聊天流 UI 模型(由历史 + SSE 事件归约) ─────────────────────────────────────

export interface ToolEvent {
  id: string
  name: string
  arguments?: string
  result?: string
  isError?: boolean
  done: boolean
  startedAt?: number
  elapsedMs?: number
  outputChars?: number
  parallelGroup?: string
  artifactPath?: string
}

export interface ApprovalRequest {
  approvalId: string
  runId: string
  name: string
  arguments?: string
  preview: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

/** ask_user / exit_plan_mode 的询问(机制同审批;answer 为自由文本)。 */
export interface InquiryRequest {
  inquiryId: string
  runId: string
  question: string
  options: string[]
  status: 'pending' | 'answered' | 'expired'
  answer?: string
}

/** 任务清单一项(todo_write/todo_read 工具 + `todo` 事件;对齐 Claude TodoWrite)。 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface UiMessage {
  id: string
  /** system=客户端本地通知行(斜杠命令反馈等;不持久化,reload 会消失)。 */
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  toolEvents?: ToolEvent[]
  approvals?: ApprovalRequest[]
  inquiries?: InquiryRequest[]
  /** 计划模式下 agent 提交的计划(plan 事件;渲染为计划卡)。 */
  planProposal?: string
  /** 本会话任务清单(todo 事件;渲染为 todolist,整单替换)。 */
  todos?: TodoItem[]
  attachments?: Attachment[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  timestamp: number
  /** 群聊模式:本条发言的发言人(Normal Agent slug;__host__=主持人)。缺省=普通单 agent 消息。 */
  agentId?: string
  agentName?: string
  /** 发言人徽章配色(前端按 slug 派生)。 */
  agentColor?: string
  /** 群聊轮次(用于分组/调试)。 */
  groupRound?: number
  /** 群聊投票汇总(role=system 的投票行渲染成投票 chip)。 */
  groupVote?: { round: number; endCount: number; total: number; votes: Array<{ name: string; end: boolean; reason: string }> }
}

// ── Electron 托管后端(managed 模式) ──────────────────────────────────────────

export interface BackendStatusInfo {
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  url: string | null
  pid: number | null
  lastError: string | null
  /** dev:dist 重建于子进程启动之后 → 跑的是旧代码,需重启后端。 */
  staleDist?: boolean
}

/** 主进程持久化的完整配置;getConfig 返回时 backendUrl/token 已折算为有效值(managed 就绪=托管子进程的)。 */
export interface StoredDesktopConfig extends TanguDesktopConfig {
  mode: 'managed' | 'external'
  cloudUrl: string
  cloudToken: string
  sandbox: 'auto' | 'docker' | 'none'
  browserEnabled?: boolean
  browserEngine?: 'auto' | 'chrome' | 'lightpanda'
  browserSearchEngine?: 'duckduckgo' | 'bing' | 'google' | 'baidu'
  browserAllowPrivateUrls?: boolean
  browserCommandTimeoutMs?: number
  wechatEnabled?: boolean
  wechatDefaultSessionId?: string
  wechatRemoteApprovalMode?: 'readonly' | 'auto-edit' | 'full-auto'
  wechatAllowedPeers?: string[]
  /** 「Tangu 默认工作区」本地目录(空=主进程按 ~/Tangu 兜底并首启创建)。设置里可改。 */
  defaultWorkspaceDir?: string
  /** 本地记忆/日志是否自动同步到 Forsion Brain(默认 false=仅手动「立即同步」,隐私优先)。 */
  forsionSyncEnabled?: boolean
  /** 上次成功同步时刻(epoch ms;UI 展示)。 */
  forsionLastSyncedAt?: number
  backendState?: BackendStatusInfo
  /** 主进程附带的用户主目录(本机模式 cwd 兜底)。 */
  homeDir?: string
}

export interface AuthStatusInfo {
  loggedIn: boolean
  cloudUrl: string
  username: string | null
  nickname?: string | null
  avatar?: string | null
  membershipTier?: string | null
  tokenSource: 'config' | 'tangu-login' | null
}

/** preload 注入的 window.tangu(浏览器内调试时缺省,backend/auth 能力按需探测)。 */
declare global {
  interface Window {
    tangu?: {
      /** 宿主平台('darwin' | 'win32' | 'linux');静态值,渲染层据此调标题栏留白。 */
      platform?: string
      getConfig(): Promise<StoredDesktopConfig>
      setConfig(patch: Partial<StoredDesktopConfig>): Promise<StoredDesktopConfig>
      backendStatus?(): Promise<BackendStatusInfo>
      backendLogs?(): Promise<string[]>
      backendRestart?(): Promise<BackendStatusInfo>
      onBackendStatus?(cb: (st: BackendStatusInfo) => void): () => void
      authStatus?(): Promise<AuthStatusInfo>
      forsionLogin?(cloudUrl?: string): Promise<{ ok: boolean; cloudUrl: string }>
      forsionLogout?(): Promise<{ ok: boolean }>
      authProviders?(): Promise<Array<{ id: string; loggedIn: boolean }>>
      providerLogin?(id: string): Promise<{ ok: boolean; id: string }>
      openAccountCenter?(): Promise<{ ok: boolean }>
      appVersion?(): Promise<string>
      onAuthDevice?(cb: (info: { url: string; userCode: string }) => void): () => void
      pickDirectory?(): Promise<string | null>
      /** 另存为文本文件(导出日志等);取消返回 { ok:false }。 */
      saveTextFile?(defaultName: string, content: string): Promise<{ ok: boolean; path: string | null }>
      /** 拖入文件 → 绝对路径(本机模式粘贴路径用)。 */
      getPathForFile?(file: File): string
      /** 本机工作区文件浏览(host cwd)。 */
      listDir?(dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>>
      readHostFile?(filePath: string): Promise<{ mimeType: string; content: string; size: number; tooLarge?: boolean }>
      /** 本机工作区文件操作(host 模式)。 */
      renameHostPath?(oldPath: string, newName: string): Promise<{ path: string }>
      mkdirHost?(parentDir: string, name: string): Promise<{ path: string }>
      trashHostPath?(p: string): Promise<{ ok: boolean }>
      revealHostPath?(p: string): Promise<{ ok: boolean }>
      startHostDrag?(filePath: string): void
      /** 拖 OS 文件/文件夹进 host 工作区目录 → 复制。 */
      copyHostFiles?(srcPaths: string[], destDir: string): Promise<{ copied: number }>
      /** 拖一行到文件夹 → 移动。 */
      moveHostPath?(srcPath: string, destDir: string): Promise<{ path: string }>
      listProviders?(): Promise<DirectProviderConfig[]>
      saveProvider?(provider: DirectProviderConfig): Promise<DirectProviderConfig[]>
      deleteProvider?(providerId: string): Promise<DirectProviderConfig[]>
      readMcpConfig?(): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      writeMcpConfig?(cfg: { mcpServers: Record<string, McpServerConfigEntry> }): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      discoveryScan?(): Promise<DiscoveryResult>
      discoveryImportSkills?(ids: string[]): Promise<{ imported: string[] }>
      discoveryImportMcp?(names: string[]): Promise<{ imported: string[] }>
      envCheck?(): Promise<EnvProbeResult[]>
      envRun?(installId: string): Promise<{ exitCode: number }>
      onEnvOutput?(cb: (ev: { installId: string; line: string }) => void): () => void
    }
  }
}
