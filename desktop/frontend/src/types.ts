/** standalone /agent 契约的前端类型(与包内 routes/eventBus 一致)。 */

export interface TanguDesktopConfig {
  backendUrl: string
  token: string
  modelId: string
  /** 默认生图模型 id(generate_image 用;缺省=自动取第一个可用生图模型)。 */
  imageModelId?: string
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

/** 子聊天(右栏「子聊天」区)的一段内容:发言文本 / 工具调用 / 投票。 */
export type SubChatSeg =
  | { t: 'text'; speaker?: string; color?: string; text: string }
  | { t: 'tool'; name: string; args?: string; preview?: string; error?: boolean }
  | { t: 'vote'; text: string }

/** 一个子聊天条目。discussion=独立 run(面板订阅它的事件流);subagent=主 run 内流式片段(主流累积)。 */
export interface SubChat {
  id: string                 // subId(subagent)| discussion runId
  kind: 'discussion' | 'subagent'
  title: string
  runId?: string             // discussion:要订阅的 run(= id)
  streaming: boolean
  segs: SubChatSeg[]         // subagent 内容随主流累积;discussion 由面板二开 SSE 现拉,segs 保持空
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
  /** 每 x 轮触发一次维护(标题 + 日志/记忆同一节奏)。 */
  everyRounds: number
  firstRoundTrigger: boolean
  /** independent=自己判断并写日志/记忆(默认);assist=分支出后台讨论,由主 Agent 自己定夺并写入(首轮始终 independent)。 */
  mode: 'independent' | 'assist'
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
  activeHours: { start: number; end: number } | null
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

/** 默认 Agent slug(无 agentSlug 时后端落此;新会话选择器默认高亮)。 */
export const DEFAULT_AGENT_SLUG = 'xyra'

/** 开发者「回复前显示 system prompt」开关(localStorage;仅 dev 模式可见,App.send 据此带 debugSystemPrompt)。 */
export const SHOW_SYSTEM_PROMPT_KEY = 'forsion_tangu_show_system_prompt'

/** Agent 列表的全局 meta:展示顺序 + 用户选定的默认 agent。 */
export interface AgentsMeta { order: string[]; defaultSlug: string }

/** 本地 Normal Agent 定义(~/.tangu/agents/<slug>/;后端 agentRegistry 解析)。 */
export interface NormalAgentDef {
  slug: string
  name: string
  /** 版本号(config.toml version,缺省 1.0.0);市场「可更新」检查用。 */
  version?: string
  description: string
  model: string
  tools: string[]
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | ''
  maxIterations: number | null
  approvalMode: 'readonly' | 'auto-edit' | 'full-auto' | ''
  /** system = 内置系统 agent(如 Muse):名册/选择器显示「后台」徽章,启用期间禁删。 */
  createdBy: 'user' | 'agent' | 'system'
  createdAt: string
  systemPrompt: string
  /** 人格(SOUL.md)。 */
  soul?: string
  /** 头像文件名(该 agent 的 Library 内);有则选择器显示头像,否则显示首字母。 */
  avatar?: string
  /** 共用默认 Agent 的记忆/日志(默认 false=该 agent 有专属记忆/日志)。 */
  shareDefaultMemory?: boolean
  /** 开启云同步:该 agent 全部文件跨设备完全镜像(默认 false=纯本地)。 */
  cloudSync?: boolean
}

export interface AgentConfig {
  systemPrompt?: string
  /** 默认生图模型 id(generate_image 缺省据此;来自全局设置 cfg.imageModelId,随 run 透传)。 */
  imageModelId?: string
  /** 激活的 Normal Agent slug(后端 agentLoop 解析注入人格/模型/工具)。 */
  agentSlug?: string
  /** 外部 agent 引擎 id(如 'claude-code'):设了就把整个 turn 委托给该 ACP 引擎而非 Tangu 自有 loop。host-only。 */
  engineId?: string
  /** 为外部引擎选的模型(经 ACP setSessionModel 应用);空=用引擎默认。 */
  engineModelId?: string
  maxIterations?: number
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
  enabledSkillIds?: string[]
  /** 本条消息经 /skill 显式点选的技能 id(per-message,加性:并入可用集 + 强制使用;不持久化、不收窄目录)。 */
  requestedSkillIds?: string[]
  /** 开发者调试:置 true 则后端把本 run 组装好的 system prompt 作 `system_prompt` 事件回传(per-message,不持久化)。 */
  debugSystemPrompt?: boolean
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
  /** 本条消息 @ 的 agent slug(群聊:该 agent 本场优先发言;per-message,发送后清空,不持久化)。 */
  priorityAgent?: string
  /** 本条消息 @ 的 agent slug 列表(单聊:提示主 agent 用 delegate 把子任务交给这些 Normal Agent 作 subagent;per-message,不持久化)。 */
  mentionedAgentSlugs?: string[]
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
  /** 大语言模型 / 生图模型(后端已分类;模型设置据此分区,生图选 image_gen)。缺省视作 llm。 */
  modelType?: 'llm' | 'image_gen'
  /** 模型上下文窗口(tokens);输入框「上下文占比」进度条用。后端缺省回退全局默认。 */
  contextWindow?: number
}

export interface ModelsResponse {
  models: ModelInfo[]
  directProviders: Array<{ providerId: string; baseUrl?: string; modelIds?: string[]; imageModelIds?: string[]; ttsModelIds?: string[] }>
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
  /** 该 provider 的生图模型 id(OpenAI 兼容 /images/generations;generate_image 用)。 */
  imageModelIds?: string[]
  /** 该 provider 的语音合成模型 id(OpenAI 兼容 /audio/speech;朗读用)。 */
  ttsModelIds?: string[]
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

/** agent 主动展示给用户的文件(display_file / generate_image / 表情包);path 或 dataUrl 二选一。 */
export interface DisplayFile {
  name: string
  mime?: string
  /** 工作区文件路径(host 会话=绝对路径;沙箱=工作区相对路径)。 */
  path?: string
  /** 内联数据 URL(data:<mime>;base64,...);无工作区路径的小文件用(表情包 / 沙箱生图)。 */
  dataUrl?: string
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
  /** 开发者调试:本条消息发给模型的完整 system prompt(经 `system_prompt` 事件填入;仅 dev 开关开启时有)。 */
  systemPrompt?: string
  toolEvents?: ToolEvent[]
  approvals?: ApprovalRequest[]
  inquiries?: InquiryRequest[]
  /** 计划模式下 agent 提交的计划(plan 事件;渲染为计划卡)。 */
  planProposal?: string
  /** 本会话任务清单(todo 事件;渲染为 todolist,整单替换)。 */
  todos?: TodoItem[]
  attachments?: Attachment[]
  /** agent 在对话区展示的文件(display_file 事件 / 历史 display_files);图片渲染为可点击放大的缩略图。 */
  displayFiles?: DisplayFile[]
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

/** 应用内自动更新状态(electron-updater 经 'updater:status' 广播;mac 仅检测)。 */
export interface UpdaterStatusInfo {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  version?: string
  releaseNotes?: string
  percent?: number
  error?: string
}

/** 主进程持久化的完整配置;getConfig 返回时 backendUrl/token 已折算为有效值(managed 就绪=托管子进程的)。 */
export interface StoredDesktopConfig extends TanguDesktopConfig {
  mode: 'managed' | 'external'
  cloudUrl: string
  cloudToken: string
  sandbox: 'auto' | 'docker' | 'none'
  /** Python 来源:bundled=内置解释器(默认,免装/隔离);system=用系统已装 python。 */
  pythonMode?: 'bundled' | 'system'
  /** 网络镜像:china=中国大陆镜像源(pip/npm/git + 市场 github 下载);default=直连。 */
  mirror?: 'default' | 'china'
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
  /** 笔记拖入附件存放方式:attachments=同目录 attachments/;same=与笔记同目录;vault=固定文件夹。 */
  notesAttachmentMode?: 'attachments' | 'same' | 'vault'
  /** notesAttachmentMode==='vault' 时的 vault 相对文件夹(如 "assets")。 */
  notesAttachmentFolder?: string
  /** 导入文件是否默认开启预览(![[file]] 形式);false=插入 [名](路径) 链接。 */
  notesImportPreview?: boolean
  /** 日记(每日笔记)所在 vault 相对文件夹;'' = vault 根。 */
  notesDailyFolder?: string
  /** 收件箱新消息系统通知(undefined 视为 true=默认开;ribbon/dock 角标不受此控)。 */
  inboxNotifyEnabled?: boolean
  /** 朗读(TTS)模型 id(<providerId>/<model> 或某 provider ttsModelIds 命中);空/缺省=未启用,不显示朗读按钮。 */
  ttsModelId?: string
  /** 朗读音色 id(provider 特定);空=provider 默认。 */
  ttsVoice?: string
  /** 朗读语速 0.5–2(缺省 1)。 */
  ttsSpeed?: number
  /** 新回复完成后自动朗读(仅当前活跃会话)。 */
  ttsAutoSpeak?: boolean
  backendState?: BackendStatusInfo
  /** 主进程附带的用户主目录(本机模式 cwd 兜底)。 */
  homeDir?: string
}

export interface AuthStatusInfo {
  loggedIn: boolean
  /** token 是否仍有效:true=有效,false=已失效(401/403),null=未校验/离线(不确定)。用于检测登录过期。 */
  tokenValid?: boolean | null
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
      /** Tangu Web(浏览器云端客户端)标志:由 web 垫片注入;共享组件据此解闸云端可用特性(如技能)。 */
      cloudWeb?: boolean
      /** 移动端(Capacitor/Android)标志:由 mobile 垫片注入;Inbox 等据此走设备本地存储实现。 */
      mobile?: boolean
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
      openAccountCenter?(section?: string): Promise<{ ok: boolean }>
      /** 提交反馈到 Forsion 反馈中心(会话日志 JSON 随附为附件;token 留主进程)。 */
      submitFeedback?(input: { description: string; sessionLogJson?: string; sessionLogName?: string }): Promise<{ ok: boolean; id?: string | null; error?: string; attachmentSkipped?: boolean }>
      appVersion?(): Promise<string>
      /** 应用内自动更新:检查 / 下载 / 重启安装(mac 仅检测,download/install 为 no-op)。 */
      checkForUpdates?(): Promise<UpdaterStatusInfo>
      downloadUpdate?(): Promise<void>
      installUpdate?(): Promise<{ ok: boolean }>
      onUpdaterStatus?(cb: (st: UpdaterStatusInfo) => void): () => void
      onAuthDevice?(cb: (info: { url: string; userCode: string }) => void): () => void
      pickDirectory?(): Promise<string | null>
      /** 另存为文本文件(导出日志等);取消返回 { ok:false }。 */
      saveTextFile?(defaultName: string, content: string): Promise<{ ok: boolean; path: string | null }>
      /** 拖入文件 → 绝对路径(本机模式粘贴路径用)。 */
      getPathForFile?(file: File): string
      /** 本机工作区文件浏览(host cwd)。 */
      listDir?(dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>>
      readHostFile?(filePath: string): Promise<{ mimeType: string; content: string; size: number; mtimeMs?: number; tooLarge?: boolean }>
      /** 用系统默认应用打开(预览不支持的类型)。 */
      openHostPath?(p: string): Promise<{ ok: boolean; error?: string }>
      /** 写回文本文件(工作区 .md 编辑):原子写;expectedMtimeMs 不符返回 conflict。 */
      writeHostFile?(filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean): Promise<{ ok?: boolean; conflict?: boolean; mtimeMs: number }>
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
      /** 拖入式主题:列 ~/.tangu/themes/(每项 {id,manifest,css})/ 打开该文件夹。 */
      listThemes?(): Promise<Array<{ id: string; manifest: Record<string, unknown>; css: string }>>
      openThemesDir?(): Promise<{ ok: boolean }>
      /** 设置界面「打开文件夹」:在系统文件管理器打开 agent(slug 缺省=agents 根)/ skills 目录(仅桌面)。 */
      openAgentDir?(slug?: string): Promise<{ ok: boolean }>
      openSkillsDir?(): Promise<{ ok: boolean }>
      /** Forsion Market:浏览(公开)/ 详情含 README / 安装(下载+按类型解压到 ~/.tangu)/ 已装列表。 */
      marketList?(type?: string): Promise<{ items: MarketCard[] }>
      marketDetail?(id: string): Promise<MarketDetail>
      marketInstall?(id: string): Promise<{ ok: boolean; path: string; files: number; type: string; slug: string }>
      marketInstalled?(): Promise<Record<string, Array<{ slug: string; version: string | null }>>>
      /** 用户自定义 Space:~/.tangu/spaces/<slug>/space.json(数据化布局配方;market type='space' 同目录)。 */
      spacesList?(): Promise<Array<{ slug: string; json: string }>>
      spacesSave?(slug: string, json: string): Promise<{ ok: boolean }>
      spacesDelete?(slug: string): Promise<{ ok: boolean }>
      /** 收件箱:系统通知(点击回跳 Inbox Space)/ dock 角标(仅 mac 生效)/ 通知点击订阅。 */
      notifyInbox?(title: string, body: string): Promise<void>
      setInboxBadge?(count: number): Promise<void>
      onInboxOpen?(cb: () => void): () => void
    }
  }
}

/** 市场卡片(浏览列表)。 */
export interface MarketCard {
  id: string
  type: 'skill' | 'agent' | 'plugin' | 'space'
  source: 'github' | 'zip'
  name: string
  summary: string
  author: string
  installSlug: string
  downloads: number
  latestTag?: string | null
  /** 可比较的最新版本(github=release tag,zip=manifest/手填 version);null=不参与「可更新」判断。 */
  latestVersion?: string | null
}

/** 市场详情(含 README 正文)。 */
export interface MarketDetail extends MarketCard {
  readme: string
  githubRepoUrl?: string | null
}
