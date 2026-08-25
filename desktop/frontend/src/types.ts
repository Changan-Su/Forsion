/** standalone /agent 契约的前端类型(与包内 routes/eventBus 一致)。 */

/**
 * 思考强度七档 —— 与引擎的 `modelCapabilities.ThinkingLevel` 同款。
 * UI 一律给全七档,「这个模型真支持哪几档」由引擎侧能力表判定并自动降档
 * (Forsion-Genesis/tangu-agent/src/llm/modelCapabilities.ts)。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Chat View「高级」里可持久化的三类默认模型槽。 */
export type DefaultModelSlot = 'backgroundModelId' | 'imageModelId' | 'visionModelId'

/**
 * 「辅助模型 · 图像识别」何时介入:
 *   auto   —— 只在主模型被判定为无原生视觉时(黑名单制,见引擎 modelCapabilities)
 *   always —— 所有图先转文字再入上下文(黑名单猜不准时的确定性出路)
 *   off    —— 从不转写,图原样发给主模型
 */
export type VisionMode = 'auto' | 'always' | 'off'

export interface TanguDesktopConfig {
  backendUrl: string
  token: string
  modelId: string
  /** 默认生图模型 id(generate_image 用;缺省=自动取第一个可用生图模型)。 */
  imageModelId?: string
  /** 默认语音识别模型 id(语音输入转写用;缺省=跟随 app 级 asr 默认)。 */
  asrModelId?: string
  /** 辅助模型 · 图像识别 id(缺省=跟随 config.json models.vision → app 级槽)。 */
  visionModelId?: string
  /** 图像识别何时介入(落 config.json models.visionMode;缺省 auto)。 */
  visionMode?: VisionMode
}

/** 带时间戳的转写结果(仅在调用方显式要 timestamps 时返回;segments 缺席 = 上游给不了)。 */
export interface AsrTimedResult { text: string; segments?: Array<{ start: number; end: number; text: string }> }

/** Computer Use 正在操控的窗口的一帧。active:false = 现在没人在操控(或本平台/本 helper 不支持)。 */
export interface CuLiveFrame {
  active: boolean
  windowId?: number
  pid?: number
  app?: string
  bundleId?: string
  title?: string
  width?: number
  height?: number
  /** JPEG base64(不含 data: 前缀)。缺失 = 本次没取到画面,看 error。 */
  jpegBase64?: string
  /** 这一帧的序号。带回给下次请求,画面没变时 helper 只回 unchanged、不重编 JPEG。 */
  frameSeq?: string
  /** true = 与你上次见到的那一帧相同,本次不含图。 */
  unchanged?: boolean
  ageMs?: number
  error?: string
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
  /** Historian 会话摘要(人读:列表悬停预览 / [[ 引用候选副标题)。 */
  summary?: string | null
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
  /** independent=自己判断并写日志/记忆(默认);assist=分支出后台讨论,由主 Agent 自己定夺并写入(首轮始终 independent);
   *  fork=尾部分叉判官:用会话模型在全量上下文快照上一次补全出判断(缓存对齐),失败自动回落 independent。 */
  mode: 'independent' | 'assist' | 'fork'
  prompt: string
  /** 自进化自动档:判官额外提名「工作笔记候选」进各 Agent 收件箱,/refine 时供其审阅采纳(默认关)。 */
  harnessCandidates: boolean
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
/** 自动化动作链步骤(引擎 museTriggers.ActionSpec 镜像;tool_call 只能在构建器创建)。 */
export type AutomationActionSpec =
  | { type: 'notify'; title: string; body?: string }
  | { type: 'agent_run'; agentSlug: string; prompt: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  /** Amadeus 多维表写入(cells 键=列 id 或列名;值可含 {{row.X}} 模板)。rowId 缺省=触发命中的那一行。 */
  | { type: 'db_row_add'; path: string; cells: Record<string, string> }
  | { type: 'db_row_edit'; path: string; rowId?: string; cells: Record<string, string> }
/** 自动化规则(manage_automation 工具/构建器写入 agents/muse/triggers.json)。 */
export interface MuseTriggerInfo {
  id: string
  desc: string
  cond:
    | { type: 'file_chars_gte'; path: string; n: number }
    | { type: 'event_seen'; match: string }
    | { type: 'daily_at'; time: string }
    | { type: 'at'; datetime: string }
    | { type: 'every'; interval: string }
    /** 手动:巡检永不命中,只能由 Amadeus 按钮块点击(origin=button)或面板试跑起跑。 */
    | { type: 'manual' }
    /** Amadeus 多维表变化(vault 钉住建规则时那个库;columnId 存列 id——列名不唯一也会改)。 */
    | { type: 'db_changed'; path: string; vault: string; event: 'row_added' | 'cell_changed'; columnId?: string; equals?: string }
  prompt?: string
  cooldownHours: number
  lastFiredAt: string | null
  enabled: boolean
  createdAt: string
  /** 旧式单动作:命中后执行的 agent(缺省=唤醒 Muse)。actions 存在时此字段为空。 */
  agentSlug?: string
  /** 动作链(有则取代 agentSlug/Muse 旧语义)。 */
  actions?: AutomationActionSpec[]
  /** 服务端权威计算的下次应触时刻(ISO;事件/文件类或已禁用 → null)。 */
  nextRunAt?: string | null
}
/** POST /agent/special/muse/triggers 的 upsert 入参(snake_case 对齐引擎校验)。
 *  actions:数组=设置;null=显式清空(回到 Muse/agentSlug 旧语义);缺席=保留旧值。 */
export interface MuseTriggerUpsert {
  id?: string
  desc: string
  cond_type: 'file_chars_gte' | 'event_seen' | 'daily_at' | 'at' | 'every' | 'manual' | 'db_changed'
  path?: string
  n?: number
  match?: string
  time?: string
  datetime?: string
  interval?: string
  event?: 'row_added' | 'cell_changed'
  vault?: string
  column_id?: string
  equals?: string
  prompt?: string
  cooldown_hours?: number
  agent_slug?: string
  enabled?: boolean
  actions?: AutomationActionSpec[] | null
}
/** GET /agent/special/automation/actions 的目录项(tool_call 步骤选择器+参数表单生成)。 */
export interface AutomationActionCatalogItem {
  name: string
  description: string
  parameters: { type?: string; properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] }
  dangerous?: boolean
}
/** 动作链执行账本行(GET /agent/special/automation/executions)。 */
export interface AutomationExecutionInfo {
  id: string
  trigger_id: string
  origin: 'auto' | 'manual' | string
  status: string
  steps: { type: string; tool?: string; ok: boolean; summary: string }[]
  error: string | null
  created_at: string
}
/** agent 自动化的常驻会话(每规则一条;运行历史=该会话的 runs)。 */
export interface AutomationSessionInfo {
  id: string
  title: string
  triggerId: string | null
  agentSlug: string | null
  created_at: string
  updated_at: string
}
export interface AutomationRunInfo {
  id: string
  status: string
  tokens_total: number | null
  error: string | null
  created_at: string
  updated_at: string
}
/** agent 日程条目(agents/<slug>/SCHEDULE.db;引擎 entriesOf 的结构化输出)。 */
export interface AgentScheduleEntry {
  id: string
  name: string
  /** calendarDate 编码 `start[/end]`;''=无日期。 */
  date: string
  /** ''=一次性;`\d+[hd]` 从锚点滚动。 */
  repeat: string
  /** true=到点无人值守执行 prompt(触发记录=triggerKey `sched:<slug>:<id>` 的自动化会话)。 */
  auto: boolean
  prompt: string
  description: string
  todo: boolean
  lastRun: string
}
/** GET /agent/special/schedule 的单个 agent 日程(db=DbFile 原样,Calendar 合成只读源用)。 */
export interface AgentScheduleInfo {
  slug: string
  name: string
  db: {
    version: number
    name: string
    columns: { id: string; name: string; type: string }[]
    rows: { id: string; cells: Record<string, unknown> }[]
  }
  entries: AgentScheduleEntry[]
}
/** POST /agent/special/schedule/:slug/entries 的 upsert 入参。 */
export interface AgentScheduleEntryUpsert {
  id?: string
  name: string
  date?: string
  repeat?: string
  auto?: boolean
  prompt?: string
  description?: string
  todo?: boolean
}

/** 默认 Agent slug(无 agentSlug 时后端落此;新会话选择器默认高亮)。 */
export const DEFAULT_AGENT_SLUG = 'xyra'

/** 开发者「回复前显示 system prompt」开关(localStorage;仅 dev 模式可见,App.send 据此带 debugSystemPrompt)。 */
export const SHOW_SYSTEM_PROMPT_KEY = 'forsion_tangu_show_system_prompt'

/** 丝滑光标开关(localStorage,**缺席=关**;smoothCaret.ts 全局模块 + 设置→外观)。 */
export const SMOOTH_CARET_KEY = 'forsion_tangu_smooth_caret'

/** 界面字体三档(localStorage,**缺席=跟随主题**;uiFont.ts + 设置→外观)。 */
export const FONT_UI_KEY = 'forsion_tangu_font_ui'
export const FONT_BODY_KEY = 'forsion_tangu_font_body'
export const FONT_MONO_KEY = 'forsion_tangu_font_mono'

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
  thinkingLevel: ThinkingLevel | ''
  maxIterations: number | null
  approvalMode: 'readonly' | 'auto-edit' | 'full-auto' | 'custom' | ''
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
  /** 允许读用户活动日志(read_activity 工具);默认 false=仅 Muse 可读。 */
  activityAccess?: boolean
  /** 内置工具名单:'deny'=toolsList 内禁用(其余可用);'allow'=仅 toolsList 可用;缺省=不限制。 */
  toolsMode?: 'allow' | 'deny'
  toolsList?: string[]
}

export interface AgentConfig {
  systemPrompt?: string
  /** 云端 Project 工作区名(sandbox 会话):run 的文件工具/沙箱落 Penzor Cloud-Workspaces/Projects/<名>/(跨会话共享)。 */
  workspaceProject?: string
  /** 默认生图模型 id(generate_image 缺省据此;来自全局设置 cfg.imageModelId,随 run 透传)。 */
  imageModelId?: string
  /** 辅助模型 · 图像识别 id(主模型无原生视觉时用它把图转文字;来自全局设置 cfg.visionModelId)。 */
  visionModelId?: string
  /** 图像识别何时介入(来自 cfg.visionMode;云端会话的引擎读不到本机 config.json,只能随 run 带)。 */
  visionMode?: VisionMode
  /** 激活的 Normal Agent slug(后端 agentLoop 解析注入人格/模型/工具)。 */
  agentSlug?: string
  /** 外部 agent 引擎 id(如 'claude-code'):设了就把整个 turn 委托给该 ACP 引擎而非 Tangu 自有 loop。host-only。 */
  engineId?: string
  /** 为外部引擎选的模型(经 ACP setSessionModel 应用);空=用引擎默认。 */
  engineModelId?: string
  maxIterations?: number
  thinkingLevel?: ThinkingLevel
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
  /** 额外工作文件夹(host-only,绝对路径):并入引擎可写根 + 写进系统提示,免逐次「越界写」审批。
   *  cwd 仍是默认目录 —— 相对路径只相对 cwd 解析,这些一律绝对路径引用。引擎侧封顶 8 个。 */
  extraRoots?: string[]
  approvalMode?: 'readonly' | 'auto-edit' | 'full-auto' | 'custom'
  /** 验证回路(/verify,host-only):收尾前引擎自动跑的命令,失败回灌逼修到绿才许收尾;空/缺省=关闭。 */
  verifyCommand?: string
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

/** 通道类型(微信/Telegram/QQ;与引擎 channels/types.ts 对齐)。 */
export type ChannelKind = 'wechat' | 'telegram' | 'qq'

/** 侧栏工作区:Cloud Project(云沙箱,文件落 Penzor Cloud-Workspaces/Projects/<名>)或本地目录(host 执行,cwd=path)。 */
export interface WorkspaceDescriptor {
  /** 分组键:cloud 用 cloudProjectKey(project);本地用绝对路径(= project_path)。 */
  key: string
  name: string
  /** channel = 通道专属工作区文件夹(webot/tgbot/qqbot;会话按 project_path 归入)。 */
  kind: 'cloud' | 'local' | 'channel'
  /** 本地工作目录绝对路径;cloud 为 null。 */
  path: string | null
  /** 常驻系统工作区(默认云 Project / Tangu 默认本地区):不可重命名 / 移除。 */
  system?: boolean
  /** 云端 Project 名(kind='cloud'):会话 project_name 与 run 的 workspaceProject 都用它。 */
  project?: string
  /** 通道种类(kind='channel')。 */
  channel?: ChannelKind
}

/** 「Cloud 工作区」分组键哨兵(project_path 为空的会话归此组;真实本地路径永不为此值)。 */
export const CLOUD_WORKSPACE_KEY = '__cloud__'

/** 默认云 Project 名(新会话未选时的「Tangu」默认工作区项目;与引擎 DEFAULT_PROJECT_NAME 一致)。 */
export const DEFAULT_CLOUD_PROJECT = 'Tangu'

/** 云 Project 的工作区分组键。 */
export const cloudProjectKey = (project?: string | null): string =>
  `${CLOUD_WORKSPACE_KEY}:${project || DEFAULT_CLOUD_PROJECT}`

/** 会话 → 工作区分组键:本地按 project_path;云会话按 project_name 归组(旧会话
 *  project_name 为空 → 归默认 Tangu 组,文件视图仍走其 per-session 工作区,不迁移)。 */
export const sessionWorkspaceKey = (s: { project_path?: string | null; project_name?: string | null }): string =>
  s.project_path || cloudProjectKey(s.project_name)

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
  /** 大语言模型 / 生图 / 语音识别(后端已分类;模型设置据此分区)。缺省视作 llm。 */
  modelType?: 'llm' | 'image_gen' | 'asr'
  /** 模型上下文窗口(tokens);输入框「上下文占比」进度条用。后端缺省回退全局默认。 */
  contextWindow?: number
  /** 能不能直接「看」图。黑名单制:缺省/true=能;false=遇图自动转交「辅助模型 · 图像识别」。 */
  supportsVision?: boolean
  /** 该模型真正支持的思考档(引擎能力表下发;仅 llm)。思考菜单据此把不支持的档标灰。缺省=不知道,全可选。 */
  thinkingLevels?: string[]
}

export interface ModelsResponse {
  models: ModelInfo[]
  directProviders: Array<{ providerId: string; baseUrl?: string; modelIds?: string[]; imageModelIds?: string[]; ttsModelIds?: string[]; asrModelIds?: string[]; noVisionModelIds?: string[] }>
  defaultModelId: string | null
  /** admin 的 app 级「后台 agent 默认」槽(Muse/Historian 未显式选模型时跟随;缺省回退 defaultModelId)。 */
  backgroundModelId?: string | null
  /** admin 的 app 级「生图默认」槽(generate_image 与设置生图区未显式选择时跟随)。 */
  imageModelId?: string | null
  /** admin 的 app 级「语音识别默认」槽(语音输入未显式选择时跟随)。 */
  asrModelId?: string | null
  /** admin 的 app 级「辅助模型 · 图像识别」槽(本端未显式选择时跟随)。 */
  visionModelId?: string | null
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
  /** 该 provider 的语音识别模型 id(OpenAI 兼容 /audio/transcriptions;语音输入用)。 */
  asrModelIds?: string[]
  /** 该 provider 里**没有**多模态的模型(黑名单;默认都算能看图)。命中的模型遇图转交辅助视觉模型。 */
  noVisionModelIds?: string[]
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

/** 镜像连通性测试结果(每个 registry 目标一行)。 */
export interface MirrorTestResult {
  mirror: 'default' | 'china'
  targets: Array<{ name: string; url: string; ok: boolean; status: number; latencyMs: number; error?: string }>
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

/** 引擎 context_info 事件(每 run 一条):窗口值+来源、注入段分解、指令文件、历史规模(H5/H8/B2)。 */
export interface CtxInfo {
  ctxWindow: number
  /** 'override' | 'model' | 'family' | 'default';后两档是猜的,UI 要标注 */
  ctxWindowSource: string
  sections: Array<{ k: string; tokens: number }>
  files: string[]
  filesTruncated: boolean
  historyCount: number
  historyTokens: number
  /** 思考档:请求档 vs 实际生效档(能力表 clamp;不同=被自动降档,H6 降档可见)。 */
  thinkingRequested?: string
  thinkingEffective?: string
  /** 事件按哪个模型算的:切模型后 SSE 重放会复活旧事件,消费方据此丢弃不匹配的。 */
  modelId?: string
}

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
  /** 历史恢复锚点:工具调用发生前,终稿正文中的 UTF-16 偏移。旧消息没有。 */
  contentOffset?: number
}

/** 助手一条消息的「顺序段」(直播归约期填充;新历史消息也可由工具锚点重建):
 *  text=一段正文;tools=一串**连续**工具调用(按 id 引用 toolEvents,连续者并入同一块)。
 *  旧历史没有锚点 → 渲染回退老序(全部工具一块 + 全文)。 */
export type MsgSeg =
  | { t: 'text'; text: string }
  | { t: 'tools'; ids: string[] }

export interface ApprovalRequest {
  approvalId: string
  runId: string
  name: string
  arguments?: string
  preview: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  /** 「这次为什么问你」(B3)。旧事件没有这个字段 → 卡上不显示解释,不是错误。 */
  reason?: ApprovalReason
}

/** 引擎给出的审批判定理由。kind 由 reducer 白名单清洗,渲染层可以信任。 */
export interface ApprovalReason {
  /** custom-ask=你写的规则要求问 · escalate=工作区外写入升级 · mode=该档位本就需要审批 */
  kind: 'custom-ask' | 'escalate' | 'mode'
  /** 命中的规则串(仅 custom-ask) */
  rule?: string
  /** 引擎侧**生效**的档位(custom 未命中时是降解后的 base) */
  mode?: 'readonly' | 'auto-edit' | 'full-auto'
}

/** ask_user / exit_plan_mode 的询问(机制同审批;answer 为自由文本)。 */
export interface InquiryRequest {
  inquiryId: string
  runId: string
  question: string
  options: string[]
  status: 'pending' | 'answered' | 'expired'
  answer?: string
  /** 'plan'=计划审阅(渲染专属计划卡:批准 / 编辑后批准 / 打回);缺省=通用问答卡。 */
  kind?: 'plan'
}

/** sketch 工具画的对话内 HTML 卡片。载荷在 tool_call **参数**里(原样落 JSONB 不截断),
 *  直播由 tool_result 归约生成、重载由 recordToUi back-fill 重建并按工具锚点归位。 */
export interface SketchItem {
  /** 工具调用 id:去重键(SSE 重放/重载不双画),兼作 React key。 */
  callId: string
  html: string
  title?: string
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
  /** 顺序段(见 MsgSeg):存在则按段穿插渲染文字/工具、连续工具并块;缺省=老序渲染(历史重载)。 */
  segments?: MsgSeg[]
  approvals?: ApprovalRequest[]
  inquiries?: InquiryRequest[]
  /** 计划模式下 agent 提交的计划(plan 事件;渲染为计划卡)。 */
  planProposal?: string
  /** 本会话任务清单(todo 事件;渲染为 todolist,整单替换)。 */
  todos?: TodoItem[]
  attachments?: Attachment[]
  /** agent 在对话区展示的文件(display_file 事件 / 历史 display_files);图片渲染为可点击放大的缩略图。 */
  displayFiles?: DisplayFile[]
  /** sketch 工具画的 HTML 卡片;按 callId 嵌回对应顺序段,旧历史无锚点时才回退到消息末尾。 */
  sketches?: SketchItem[]
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
  /** 「允许其他设备连接本机」开关(起 unitWeb 局域网面 + unitHost 云通道,B 端渲染)。 */
  unitHostEnabled?: boolean
  cloudUrl: string
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
  notesUpgradeV4?: boolean
  /** 日记(每日笔记)所在 vault 相对文件夹;'' = vault 根。 */
  notesDailyFolder?: string
  /** `[[ ]]` 补全是否收录附件与数据库(undefined 视为 true=默认开;关掉则只补全笔记)。 */
  notesWikiIncludeFiles?: boolean
  /** 删除笔记时是否连带删除「只被它引用」的附件:true/false=记住的选择,undefined=每次询问。 */
  notesDeleteAssets?: boolean
  /** 收件箱新消息系统通知(undefined 视为 true=默认开;ribbon/dock 角标不受此控)。 */
  inboxNotifyEnabled?: boolean
  /** 记录应用内活动日志(undefined 视为 true=默认开;喂后台 Muse + 可导出排查 bug)。 */
  activityLogEnabled?: boolean
  /** 对外 MCP 端点开关(默认 false=关;开=主进程起本地 HTTP MCP server,外部 agent 可调桌面能力)。 */
  mcpEnabled?: boolean
  /** Agent Desk 演出面板:聊天右侧 agent 展示区。默认开,设置→高级可关。 */
  agentDeskEnabled?: boolean
  /** 任务概览里点来源/产物文件时开在哪:'tab'=新标签页(默认)、'desk'=Agent Desk 演出格。 */
  summaryOpenIn?: 'tab' | 'desk'
  /** 对外 MCP 端点运行态(主进程 effectiveConfig 注入,非持久化):供「高级」页展示连接信息。 */
  forsionMcp?: { running: boolean; url: string | null; token: string }
  /** 朗读(TTS)模型 id(<providerId>/<model> 或某 provider ttsModelIds 命中);空/缺省=未启用,不显示朗读按钮。 */
  ttsModelId?: string
  /** 朗读音色 id(provider 特定);空=provider 默认。 */
  ttsVoice?: string
  /** 朗读语速 0.5–2(缺省 1)。 */
  ttsSpeed?: number
  /** 新回复完成后自动朗读(仅当前活跃会话)。 */
  ttsAutoSpeak?: boolean
  /** 语音输入偏好后端:local=本地 SenseVoice(需下载);cloud=Forsion 云端/自带 key。缺省 cloud。(就绪与否走 asrLocalStatus IPC,不落 config) */
  asrBackend?: 'local' | 'cloud'
  /** 辅助模型 · LLM:后台/特殊 agent(Muse/Historian)用;空=跟随 app 级槽。 */
  backgroundModelId?: string
  /** 辅助模型 · 图像识别:主模型无原生视觉时的看图兜底 + 非聊天识图;空=跟随 app 级槽。 */
  visionModelId?: string
  /** 上次用的审批档 / 思考档:**新会话据此起步**(模型走 modelId,已是全局键)。
   *  在任意会话里改这三样都会写回这里 —— 用户的口径是「换过一次就一直是它」,不是每建一个会话重设一次。 */
  lastApprovalMode?: 'readonly' | 'auto-edit' | 'full-auto' | 'custom'
  lastThinkingLevel?: ThinkingLevel
  backendState?: BackendStatusInfo
  /** 主进程附带的用户主目录(本机模式 cwd 兜底)。 */
  homeDir?: string
}

/** 账号名下的一台设备(Forsion Unit,unit-hub 名册行)。 */
export interface UnitInfo {
  id: string
  name: string
  platform: string | null
  /** 切换器里的自定义 emoji 图标;null = 按 platform 给默认。 */
  icon: string | null
  online: boolean
  createdAt?: string
  lastSeenAt?: string | null
  /** 设备自报的局域网直连地址(同网段优先直连的候选;不作可达性担保)。 */
  lanUrl?: string | null
}

/** 已配对的来访设备(本机 unitWeb 的 T1 局域网配对;令牌只存 hash)。 */
export interface UnitPairedDevice {
  id: string
  name: string
  createdAt: number
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
  tokenSource: 'tangu-login' | null
  /** managed 模式下的引擎进程态;null=external/无 agent 后端形态(前端不渲染引擎态)。 */
  backendState?: 'stopped' | 'starting' | 'ready' | 'crashed' | null
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
      /** unit 设备页标志(B 端渲染,unitShim 注入):本页是另一台设备曝出来的 Forsion 面 ——
       *  插件清单走对方的 unit/plugins,无 vault 桥(本地 vault 面 = v2.1)。 */
      unitPage?: boolean
      getConfig(): Promise<StoredDesktopConfig>
      setConfig(patch: Partial<StoredDesktopConfig>): Promise<StoredDesktopConfig>
      backendStatus?(): Promise<BackendStatusInfo>
      backendLogs?(): Promise<string[]>
      backendRestart?(): Promise<BackendStatusInfo>
      onBackendStatus?(cb: (st: BackendStatusInfo) => void): () => void
      // ── 设备互联(Forsion Unit):名册 + 本机 host 状态(token 留主进程,渲染层只拿结果)──
      unitsList?(): Promise<{ status: number; json: { units?: UnitInfo[] } | null }>
      unitsUpdate?(id: string, patch: { name?: string; icon?: string }): Promise<{ status: number; json: any }>
      unitsRemove?(id: string): Promise<{ status: number; json: any }>
      unitHostStatus?(): Promise<{ running: boolean; connected: boolean; unitId: string | null; lastError: string | null; webPort: number | null; lanUrl: string | null }>
      /** 本机已配对的来访设备(T1)与回收。 */
      unitsPairedList?(): Promise<UnitPairedDevice[]>
      unitsPairedRemove?(id: string): Promise<{ ok: boolean }>
      /** LAN 直连探针(主进程发,免 CORS):是台 unitWeb 就回 meta,否则 null。 */
      unitsProbeLan?(lanUrl: string): Promise<{ instanceId: string; name: string } | null>
      authStatus?(): Promise<AuthStatusInfo>
      forsionLogin?(cloudUrl?: string): Promise<{ ok: boolean; cloudUrl: string }>
      forsionLogout?(): Promise<{ ok: boolean }>
      authProviders?(): Promise<Array<{ id: string; loggedIn: boolean }>>
      providerLogin?(id: string): Promise<{ ok: boolean; id: string }>
      openAccountCenter?(section?: string): Promise<{ ok: boolean }>
      /** 打开会员购买页({cloudUrl}/pay?tab=membership,token 主进程拼接)。 */
      openPayCenter?(): Promise<{ ok: boolean }>
      /** 头像菜单额度视图(GET /api/token-quota/my 透传,含 resetCards)。 */
      accountQuota?(): Promise<{ status: number; json: any }>
      /** 用掉一张限额重置卡(今日+本周已用清零)。 */
      accountUseResetCard?(type?: 'both' | 'weekly'): Promise<{ status: number; json: any }>
      /** 提交反馈到 Forsion 反馈中心(会话日志 JSON 随附为附件;token 留主进程)。 */
      submitFeedback?(input: { description: string; sessionLogJson?: string; sessionLogName?: string }): Promise<{ ok: boolean; id?: string | null; error?: string; attachmentSkipped?: boolean }>
      appVersion?(): Promise<string>
      /** 应用内自动更新:检查 / 下载 / 重启安装(mac 仅检测,download/install 为 no-op)。 */
      checkForUpdates?(): Promise<UpdaterStatusInfo>
      downloadUpdate?(): Promise<void>
      installUpdate?(): Promise<{ ok: boolean }>
      /** 测试版通道开关(缺省关)。开了才收 x.y.z-beta.N;关着两层都隔离:
       *  Win/Linux 读的是 latest.yml 而非 beta.yml,mac 打的是 /releases/latest(按定义排除 prerelease)。 */
      getUpdateBeta?(): Promise<boolean>
      setUpdateBeta?(on: boolean): Promise<{ ok: boolean }>
      onUpdaterStatus?(cb: (st: UpdaterStatusInfo) => void): () => void
      /** 应用内清空数据(卸载/重置);清完主进程 relaunch。 */
      clearAppData?(opts: { desktop?: boolean; tangu?: boolean }): Promise<{ ok: boolean }>
      /** 主题请求窗口级材质;system-glass 在 macOS 映射为可取样窗口后方的高透原生 vibrancy。 */
      setWindowMaterial?(input: { material: 'opaque' | 'system-glass'; mode: 'light' | 'dark'; backgroundColor?: string }): Promise<{ ok: boolean }>
      onAuthDevice?(cb: (info: { url: string; userCode: string }) => void): () => void
      /** 登录态变化(桌面登录/登出、CLI `tangu login` 等外部来源)→ 刷新账号卡/authInfo。 */
      onAuthChanged?(cb: (info: { loggedIn: boolean }) => void): () => void
      /** 截当前窗口的一块视口矩形(Agent Desk 截屏 → 引擎 desk_screenshot);失败返回 null。 */
      captureRect?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
      pickDirectory?(): Promise<string | null>
      /** Chat Box 添加文件或文件夹；取消返回空数组。 */
      pickPaths?(): Promise<Array<{ path: string; isDirectory: boolean }>>
      /** 另存为文本文件(导出日志等);取消返回 { ok:false }。 */
      saveTextFile?(defaultName: string, content: string): Promise<{ ok: boolean; path: string | null }>
      /** 用户活动日志埋点(fire-and-forget;拼行/消毒在 main 侧 activityLog.ts)。 */
      act?(event: string, detail?: Record<string, unknown>): void
      /** 导出近 days 天活动日志拼接文本。 */
      exportActivity?(days?: number): Promise<string>
      /** 拖入文件 → 绝对路径(本机模式粘贴路径用)。 */
      getPathForFile?(file: File): string
      /** 本机工作区文件浏览(host cwd)。 */
      listDir?(dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>>
      /** 单条目 stat(侧栏悬停提示):文件→修改/创建时间;目录→另带直接子项计数。
       *  birthtimeMs=null → 该文件系统给不出创建时间(Linux 常见)。 */
      statPath?(p: string): Promise<{ isDir: boolean; mtimeMs: number; birthtimeMs: number | null; files?: number; folders?: number } | null>
      readHostFile?(filePath: string): Promise<{ mimeType: string; content: string; size: number; mtimeMs?: number; tooLarge?: boolean }>
      /** 用系统默认应用打开(预览不支持的类型)。 */
      openHostPath?(p: string): Promise<{ ok: boolean; error?: string }>
      /** Coding Space:把工作区目录挂本地静态服务器,返回 origin(iframe 多文件预览)。 */
      codePreviewServe?(rootDir: string): Promise<{ origin: string }>
      /** 单文件 HTML 预览:挂其所在目录到不可猜的令牌根,返回可直接加载的 http URL。 */
      codePreviewServePath?(filePath: string): Promise<{ url: string }>
      /** 无本机路径的 HTML(云沙箱/对话内联):把文本挂到令牌根,同样拿到真实源。 */
      codePreviewServeHtml?(html: string): Promise<{ url: string }>
      codePreviewStop?(): Promise<{ ok: boolean }>
      /** Coding Space 项目根 ~/Forsion/Project(确保存在)。 */
      codeProjectsRoot?(): Promise<string>
      /** Forsion Connect:Coding Space 项目发布到云端托管(主进程持 token 转发)。 */
      connectMeta?(dir: string): Promise<{ slug?: string }>
      connectList?(): Promise<{ ok: boolean; code?: string; detail?: string; base?: string; handle?: string | null; apps?: Array<{ slug: string; name: string; entry: string; status: string; total_bytes: number; updated_at?: string; listing_status?: string | null; listing_summary?: string | null; listing_note?: string | null }>; used?: number; limit?: number; tier?: string }>
      connectPublish?(p: { dir: string; name: string; slug: string; entry: string }): Promise<{ ok: boolean; code?: string; detail?: string; slug?: string; handle?: string; url?: string; used?: number; limit?: number }>
      connectUnpublish?(slug: string): Promise<{ ok: boolean; code?: string; detail?: string }>
      connectListingApply?(p: { slug: string; summary: string }): Promise<{ ok: boolean; code?: string; detail?: string; status?: string }>
      connectListingWithdraw?(slug: string): Promise<{ ok: boolean; code?: string; detail?: string }>
      connectStore?(): Promise<{ ok: boolean; detail?: string; base?: string; items?: Array<{ name: string; summary: string; handle: string; slug: string; url: string; updatedAt?: string }> }>
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
      // ── 内置浏览器 / 内置终端(builtins/)──
      /** 用系统浏览器打开(主进程只放 http(s))。 */
      openExternal?(url: string): Promise<void>
      /** 拉外部日历订阅(.ics);走主进程绕开 CORS(订阅地址一律不发 CORS 头)。 */
      fetchIcs?(url: string): Promise<{ ok: boolean; text?: string; error?: string }>
      /** 主进程回投的外链;渲染层决定进内置浏览器还是系统浏览器。返回取消订阅。 */
      onOpenUrl?(cb: (url: string) => void): () => void
      /** 内置终端 PTY;spawn 失败(原生模块未就绪)返回 { error } 而非抛。 */
      pty?: {
        spawn(opts: { cols?: number; rows?: number; cwd?: string }): Promise<{ id?: string; shell?: string; error?: string }>
        write(id: string, data: string): void
        resize(id: string, cols: number, rows: number): void
        kill(id: string): void
        onData(id: string, cb: (data: string) => void): () => void
        onExit(id: string, cb: (code: number) => void): () => void
      }
      listProviders?(): Promise<DirectProviderConfig[]>
      saveProvider?(provider: DirectProviderConfig): Promise<DirectProviderConfig[]>
      deleteProvider?(providerId: string): Promise<DirectProviderConfig[]>
      /** 桌面级共享语音转写:音频(base64)→ 文本。任意功能复用;主进程本地/自带-key,不经引擎。 */
      /** timestamps 不传 = 回纯文本(语音输入);传 true = 回 { text, segments }(视频转录要分段时间戳)。 */
      transcribeAudio?(req: { audioBase64: string; mime?: string; modelId?: string; language?: string }): Promise<string>
      transcribeAudio?(req: { audioBase64: string; mime?: string; modelId?: string; language?: string; timestamps: true }): Promise<AsrTimedResult>
      /** 按路径转写(几十 MB 音轨不走 base64;主进程直接读盘)。 */
      transcribeAudioFile?(filePath: string, req?: { mime?: string; modelId?: string; language?: string }): Promise<string>
      transcribeAudioFile?(filePath: string, req: { mime?: string; modelId?: string; language?: string; timestamps: true }): Promise<AsrTimedResult>
      /** Computer Use:最近被操控窗口的一帧画面。只读——helper 没跑就 active:false,绝不因此拉起它。
       *  仅 macOS(Windows helper 是 stdio 子进程,桌面够不着);拿不到图会带 error 而不是伪造画面。 */
      computerUseLiveView?(opts?: { maxDimension?: number; quality?: number; activeWithinMs?: number; image?: boolean; sinceFrame?: string }): Promise<CuLiveFrame>
      /** 本地语音模型(SenseVoice)状态 / 下载 / 删除 + 下载进度订阅(返回取消函数)。 */
      asrLocalStatus?(): Promise<{ ready: boolean; sizeBytes: number }>
      asrLocalDownload?(): Promise<{ ok: boolean; ready: boolean }>
      asrLocalRemove?(): Promise<{ ok: boolean }>
      onAsrLocalProgress?(cb: (ev: { received: number; total: number }) => void): () => void
      readMcpConfig?(): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      writeMcpConfig?(cfg: { mcpServers: Record<string, McpServerConfigEntry> }): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      discoveryScan?(): Promise<DiscoveryResult>
      discoveryImportSkills?(ids: string[]): Promise<{ imported: string[] }>
      discoveryImportMcp?(names: string[]): Promise<{ imported: string[] }>
      envCheck?(): Promise<EnvProbeResult[]>
      envRun?(installId: string): Promise<{ exitCode: number }>
      envTestMirror?(mirror?: 'default' | 'china'): Promise<MirrorTestResult>
      onEnvOutput?(cb: (ev: { installId: string; line: string }) => void): () => void
      /** Forsion 插件依赖应用一键安装:宿主白名单查表登记,拿 installId 走 envRun;null=无一键命令。 */
      requestKnownAppInstall?(appId: string): Promise<{ installId: string; command: string } | null>
      /** 拖入式主题:列 ~/.tangu/themes/(每项 {id,manifest,css})/ 打开该文件夹。 */
      listThemes?(): Promise<Array<{ id: string; manifest: Record<string, unknown>; css: string }>>
      openThemesDir?(): Promise<{ ok: boolean }>
      /** 设置界面「打开文件夹」:在系统文件管理器打开 agent(slug 缺省=agents 根)/ skills / plugins 目录(仅桌面)。 */
      openAgentDir?(slug?: string): Promise<{ ok: boolean }>
      openSkillsDir?(): Promise<{ ok: boolean }>
      openPluginsDir?(): Promise<{ ok: boolean }>
      /** Forsion Market:浏览(公开)/ 详情含 README / 安装(下载+按类型解压到 ~/.tangu)/ 已装列表。 */
      marketList?(type?: string): Promise<{ items: MarketCard[] }>
      marketDetail?(id: string): Promise<MarketDetail>
      marketInstall?(id: string): Promise<{ ok: boolean; path: string; files: number; type: string; slug: string }>
      marketInstalled?(): Promise<Record<string, Array<{ slug: string; version: string | null }>>>
      /** 后端插件卸载:列用户目录已装(manifest id→目录名)/ 按 id 删目录(仅 ~/.tangu/plugins,首方插件删不到)。 */
      pluginsUserInstalled?(): Promise<Array<{ id: string; slug: string }>>
      pluginsUninstall?(id: string): Promise<{ ok: boolean }>
      /** 用户自定义 Space:~/.tangu/spaces/<slug>/space.json(数据化布局配方;market type='space' 同目录)。 */
      spacesList?(): Promise<Array<{ slug: string; json: string; plugin?: string }>>
      spacesSave?(slug: string, json: string): Promise<{ ok: boolean }>
      spacesDelete?(slug: string): Promise<{ ok: boolean }>
      /** 收件箱:系统通知(点击回跳 Inbox Space)/ dock 角标(仅 mac 生效)/ 通知点击订阅。 */
      notifyInbox?(title: string, body: string): Promise<void>
      /** 通用系统通知(所有应用内通知同步发);web/mobile 下 undefined。 */
      notify?(title: string, body: string): Promise<void>
      setInboxBadge?(count: number): Promise<void>
      onInboxOpen?(cb: () => void): () => void
      // ── 多窗口:独立窗(拖出的 dockview,无 ribbon)+ mini 悬浮卡片 ──
      /** 独立窗启动握手:pull 本窗待打开的初始视图(拖出时登记的 {type,params}[];重启已恢复布局则返回空)。 */
      detachedReady?(id: string): Promise<Array<{ type: string; params?: Record<string, unknown> }>>
      /** 开一个独立窗承载给定视图(右键「移到新窗口」/拖到空桌面);screen 坐标可选(拖出落点)。 */
      openDetached?(views: Array<{ type: string; params?: Record<string, unknown> }>, at?: { screenX: number; screenY: number }): Promise<{ id: string }>
      /** 开/切换 mini 悬浮卡片(命令 + 全局快捷键共用)。 */
      openMini?(): void
      /** 关闭当前(卫星)窗口。 */
      closeSelf?(): void
      /** 跨窗撕拽:拖拽中实时上报屏幕坐标(主进程命中测试 → 给光标下窗口发落点预览)。节流后调。 */
      dragUpdate?(screenX: number, screenY: number, view: { type: string; params?: Record<string, unknown> }): void
      /** 跨窗撕拽:最终落点路由(命中另一 dockview 窗→并入并返回 routed:true;空桌面→建新独立窗;命中源窗→false 不动)。 */
      dropView?(screenX: number, screenY: number, view: { type: string; params?: Record<string, unknown> }): Promise<{ routed: boolean }>
      /** 本窗收到跨窗拖入的视图(主进程 accept-view)→ 打开在主区。返回取消订阅。 */
      onAcceptView?(cb: (view: { type: string; params?: Record<string, unknown> }) => void): () => void
      /** 本窗收到跨窗拖拽实时预览(主进程 drag-preview;null=离开本窗清除)。返回取消订阅。 */
      onDragPreview?(cb: (at: { localX: number; localY: number } | null) => void): () => void
    }
    /** Amadeus 页面级共享+发布(web=cloudCollab / 桌面=collab IPC;移动 undefined,共享 UI 据此解闸)。 */
    amadeusCollab?: {
      listVaults(): Promise<Array<{ id: string; name: string; role?: string; ownerName?: string | null }>>
      activeVaultId(): Promise<string>
      /** 切活动云库(web=localStorage+reload;桌面=切共享镜像)。 */
      switchVault(id: string): void
      // 同步共享(owner):共享单位 = 页 + 子页面树
      pageShare(path: string): Promise<{ share: AmadeusPageShare | null; quota: AmadeusCollabQuota }>
      createPageShare(path: string, opts: { role?: 'editor' | 'viewer'; expiresDays?: number | null; password?: string | null }): Promise<AmadeusPageShare>
      updatePageShare(id: string, patch: { role?: 'editor' | 'viewer'; password?: string | null; expiresDays?: number | null; rotate?: boolean }): Promise<AmadeusPageShare>
      revokePageShare(id: string): Promise<void>
      setParticipantRole(id: string, userId: string, role: 'editor' | 'viewer'): Promise<void>
      removeParticipant(id: string, userId: string): Promise<void>
      // 参与者
      sharedWithMe(): Promise<Array<{ vaultId: string; path: string; title: string; role: string; ownerName: string | null; localPath?: string }>>
      leaveShare(id: string): Promise<void>
      inviteUrl(token: string): string
      // 发布(公开只读链接)
      publishes(): Promise<{ shares: Array<{ token: string; mode: string; path: string; createdAt: string }>; quota: AmadeusCollabQuota }>
      createPublish(mode: 'page' | 'subtree', path: string): Promise<{ token: string; mode: string; path: string; url: string }>
      revokePublish(token: string): Promise<void>
      /** Public View 跨库撤销：显式带 vaultId（默认变体只作用于 own vault）。 */
      revokePublishIn(vaultId: string, token: string): Promise<void>
      revokePageShareIn(vaultId: string, id: string): Promise<void>
      publishUrl(token: string): string
      /** Public View：跨全部 vault 汇总「我发布的公开链接 + 我创建的页面协作共享」。 */
      listAllShares(): Promise<{
        publishes: Array<{ token: string; mode: string; path: string; createdAt?: string; vaultId: string; vaultName: string }>
        pageShares: Array<Record<string, unknown>>
        linkBase: string
      }>
      // presence
      heartbeat(page: string | null): void
      stopHeartbeat(): void
      onPresence(cb: (list: Array<{ userId: string; username: string; page: string | null; at: number }>) => void): () => void
      myUserId(): string | null
    }
    /** Amadeus 云同步(桌面专属;web/mobile 下为 undefined,设置页/滑块据此隐藏)。 */
    amadeusSync?: {
      get(): Promise<AmadeusSyncStatus>
      setEnabled(on: boolean): Promise<AmadeusSyncStatus>
      syncNow(): Promise<AmadeusSyncStatus>
      /** 放行被删除保护拦下的批量删除(可选:旧 preload 构建下缺位)。 */
      confirmDeletions?(): Promise<AmadeusSyncStatus>
      /** 胶囊滑块:Local↔Cloud 全局切活动 vault;返回与 restoreVault 同形载荷。 */
      switchSide(side: 'local' | 'cloud'): Promise<{ root: string; pages: string[]; folders: string[]; lastPage?: string; side: 'local' | 'cloud' } | null>
      onStatus(cb: (s: AmadeusSyncStatus) => void): () => void
      // ── 按条目云同步(全部可选:旧 preload 构建下优雅缺位) ──
      entrySyncGet?(): Promise<AmadeusEntrySyncState>
      entrySyncEnable?(payload: {
        entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>
        /** 取消勾选的子页面(被条目覆盖但不同步)。 */
        exclude?: string[]
        /** 勾上的子页面:显式解除历史排除。 */
        include?: string[]
        cloudName?: string
        merge?: boolean
      }): Promise<{ ok?: boolean; cloudName?: string; conflict?: string; error?: string }>
      entrySyncDisable?(path: string): Promise<{ ok: boolean }>
      /** 递归关联闭包(开启弹窗数据源):种子范围外的关联笔记+附件,外加种子页的子页面。 */
      entrySyncClosure?(rootRel: string, kind: 'page' | 'folder'): Promise<{ pages: string[]; files: string[]; subPages: string[] }>
      onEntrySyncChange?(cb: () => void): () => void
      /** 非活动侧(Local↔Cloud 另一侧)的 .db 只读快照,供 Calendar 汇总两侧日历。null = 无另一侧。 */
      otherSideCalDbs?(): Promise<AmadeusOtherSideDbs | null>
    }
    /** 本地库远程同步(remotely-save 式,S3/WebDAV/文件夹;桌面专属,web/mobile 下 undefined)。 */
    remoteSync?: {
      get(): Promise<RemoteSyncState>
      set(patch: Partial<RemoteSyncConfig>): Promise<RemoteSyncConfig>
      run(opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<RemoteSyncReport>
      check(): Promise<{ ok: boolean; error?: string }>
      /** mode:auto = 回环回调自动回填(结果走 onDropboxAuth);manual = 端口起不来,要用户手贴授权码。 */
      dropboxAuthStart(appKey: string): Promise<{ ok: boolean; error?: string; mode?: 'auto' | 'manual'; redirectUri?: string }>
      dropboxAuthFinish(appKey: string, code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }>
      onDropboxAuth(cb: (r: { ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }) => void): () => void
      onStatus(cb: (s: { running: boolean; lastReport: RemoteSyncReport | null; progress: RemoteSyncProgress | null }) => void): () => void
    }
  }
}

/** 执行阶段进度(主进程 150ms 节流广播;key = 当前处理的文件)。 */
export interface RemoteSyncProgress {
  done: number
  total: number
  key: string
}

/** 本地库远程同步配置(镜像 electron/remotesyncIpc.ts 的 RemoteSyncConfig)。 */
export interface RemoteSyncConfig {
  backend: 'off' | 'folder' | 's3' | 'webdav' | 'penzor' | 'dropbox'
  /** 定时同步间隔(分钟);0 = 仅手动。 */
  intervalMin: number
  folder?: { path: string }
  s3?: { endpoint: string; region: string; accessKeyID: string; secretAccessKey: string; bucket: string; prefix?: string; forcePathStyle?: boolean }
  webdav?: { address: string; username: string; password: string; authType?: 'basic' | 'digest'; baseDir?: string }
  penzor?: { vault?: string }
  dropbox?: { appKey: string; refreshToken?: string; accountId?: string; email?: string; baseDir?: string }
  /** 同步方式:both=双向(默认);push=仅上传(增量备份);pull=仅下载(增量还原)。 */
  direction?: 'both' | 'push' | 'pull'
  /** 启动后自动同步一次(15s 后)。 */
  syncOnStart?: boolean
  /** 传输并发(1-16,缺省 4)。 */
  concurrency?: number
  ignore?: string[]
  maxFileMB?: number
}

/** 一次同步的结果(镜像 electron/remotesync/types.ts 的 SyncReport)。 */
export interface RemoteSyncReport {
  ok: boolean
  startedAt: number
  finishedAt: number
  pushed: number
  pulled: number
  deletedLocal: number
  deletedRemote: number
  conflicts: number
  skippedLarge: string[]
  pendingDeletions: number
  errors: string[]
  /** dryRun 时返回完整计划(不执行任何写)。 */
  plan?: Array<{ key: string; kind: 'push' | 'pull' | 'pushDelete' | 'deleteLocal' | 'join' | 'conflict' }>
}

export interface RemoteSyncState {
  config: RemoteSyncConfig
  running: boolean
  lastReport: RemoteSyncReport | null
  progress: RemoteSyncProgress | null
  root: string | null
  rootError: string | null
  /** 装机自带 Forsion 官方 Dropbox 应用 → 无需用户填 App Key,点一下即登。 */
  dropboxBuiltin?: boolean
}

/** 非活动侧日历只读快照(Calendar 汇总另一侧用)。root=另一侧磁盘根;vaultName=显示名(云端/文件夹名)。 */
export interface AmadeusOtherSideDbs {
  root: string
  vaultName: string
  dbs: Array<{ rel: string; source: string }>
}

/** 按条目云同步注册表(镜像 electron/amadeus/sync/entryRegistry.ts)。 */
export interface AmadeusEntrySyncVault {
  vaultRoot: string
  cloudName: string
  entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>
  /** 被条目覆盖但用户剔除的路径(子树语义)。 */
  exclude?: string[]
}

export interface AmadeusEntrySyncState {
  vaults: AmadeusEntrySyncVault[]
  activeRoot: string | null
  cloudRoot: string
  /** 云镜像里带 `.forsion-vault.md` 标记的根级文件夹名(换设备时注册表为空,分区名只能靠它)。 */
  mirrorVaults?: string[]
}

/** 页面级同步共享(分享卡片数据源)。 */
export interface AmadeusPageShare {
  id: string
  path: string
  title: string
  inviteToken: string
  inviteRole: 'editor' | 'viewer'
  hasPassword: boolean
  expiresAt: string | null
  participants: Array<{ userId: string; username: string | null; role: 'editor' | 'viewer'; since: string }>
}

export interface AmadeusCollabQuota {
  collab: number
  publish: number
}

/** 云同步状态(镜像 electron/amadeus/sync/engine.ts 的 SyncStatus;side 由 IPC get 附带)。 */
export interface AmadeusSyncStatus {
  enabled: boolean
  state: 'disabled' | 'starting' | 'idle' | 'syncing' | 'offline' | 'auth-required' | 'error'
  lastSyncAt: number | null
  pending: number
  conflicts: number
  skipped: Array<{ path: string; reason: string }>
  error: string | null
  /** 被删除保护拦下、等确认的删除条数(旧 preload 无此字段 → undefined 按 0 处理)。 */
  pendingDeletions?: number
  /** 仅 get() 响应携带:当前活动 vault 在哪一侧。 */
  side?: 'local' | 'cloud'
  /** 按条目同步绑定的状态事件携带:该绑定的本地 vault 根(区分多引擎,防互相覆盖)。 */
  binding?: string
}

/** 市场卡片(浏览列表)。 */
export interface MarketCard {
  id: string
  type: 'skill' | 'agent' | 'plugin' | 'space' | 'theme' | 'amadeus-plugin'
  source: 'github' | 'zip'
  name: string
  summary: string
  author: string
  installSlug: string
  downloads: number
  latestTag?: string | null
  /** 可比较的最新版本(github=release tag,zip=manifest/手填 version);null=不参与「可更新」判断。 */
  latestVersion?: string | null
  /** 投稿标签。旧服务端未返回时按空数组处理。 */
  tags?: string[]
  /** 用于商店「最近上架」和详情元信息；兼容旧服务端，均可缺省。 */
  createdAt?: string | null
  updatedAt?: string | null
}

/** 市场详情(含 README 正文)。 */
export interface MarketDetail extends MarketCard {
  readme: string
  githubRepoUrl?: string | null
}
