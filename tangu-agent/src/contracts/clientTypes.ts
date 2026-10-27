/**
 * Tangu 的客户端契约:引擎、Tangu 界面、宿主三方共用的数据形状与无依赖的纯函数(会话 / Agent / 模型 / 工具事件 / 桌面配置……)。
 * 核心插件化第 2b 步从 desktop/frontend/src/types.ts 原样搬来(方案 docs/ToBeImproved/Tangu核心插件化方案_2026-10-17.md 第 9 节),
 * 将来随 @forsion/tangu 包的 contracts/ 子路径发布。
 *
 * 纪律(check:tanguboundary 钉着):本目录只许 import 本目录;不碰 DOM / Node / React,不放状态。
 * 宿主照旧从 types.ts 取(那边转出),Tangu 界面直接从这里取。
 */

/** 运行位置(可持久化、可比较的纯数据)。K7 的 RunLocation ≡ 它(INTEGRATION R-14)。 */
export type TargetRef = { kind: 'home' } | { kind: 'unit'; unitId: string }

export interface HostSandboxConfig {
  mode: 'off' | 'workspace-write' | 'read-only'
  network: 'deny' | 'allow'
}

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
  // P1-K6
  /** Forsion 云端 API 基址(含 `/api`,无尾斜杠)。web / 手机 / 设备页垫片直接给;桌面主进程不给,由
   *  services/engine/cloudBase.ts 从纯源 `cloudUrl` 现算。读它一律经 `cloudApiBase()` / `cloudApiBaseOf()`。 */
  cloudApiBase?: string
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
  sessionId?: string
  runId?: string             // discussion:要订阅的 run(= id)
  /** 由 /background 并进来的行:引擎给的后台会话 kind(historian / discussion …);实时 subagent 行没有。
   *  右栏按它(而不是标题)认出 Historian 的旧 run —— 普通子会话也可能叫「Historian」。 */
  bgKind?: string
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
  /** Codex 式无根会话:不属于本地目录或 Cloud Project,运行在会话自己的隔离沙箱。 */
  projectless?: boolean
  /** 父子会话:主会话用 start_session 开出的子会话指回主会话(左栏挂在它下面一层)。也可能是私聊 @项目派遣的会话(那时主会话在别的组,照平铺)。 */
  parent_session_id?: string | null
  /** 分支(「接着问」分出来的):来源会话里分叉的那条消息 id。有值 = 分支(parent_session_id 指树根),没值 = 子会话 / 派遣。 */
  fork_message_id?: string | null
  /** 分叉那条消息所在的会话(分支的分支挂树根下,来源支从这里认;引擎列表接口现算)。 */
  fork_session_id?: string | null
  /** 这一轮以问句收尾、在等用户回答(引擎置,下一轮开始清掉)。 */
  awaiting_user?: boolean
  /** 引擎这会儿有在飞 / 排队的 run(列表接口现算):客户端没订阅的会话(子会话、自动接着做的一轮)也画「在跑」。 */
  busy?: boolean
  created_at: string
  updated_at: string
  // P1-K6
  /** 会话跑在哪台引擎上(**渲染层专用**:引擎不返回、绝不回写引擎)。缺省 = home。
   *  只由 services/engine/targets.ts 的 withLocation 从绑定表派生,别处不许自己拼(INTEGRATION R-15)。 */
  location?: TargetRef
}

// P1-K6
/** 会话在本端引擎上(未打标 = home)。 */
export function isHomeSession(s: Pick<SessionRecord, 'location'>): boolean {
  return !s.location || s.location.kind === 'home'
}

/** GET /agent/special/approvals 的一行(引擎 pendingApprovals.PendingApprovalRow 镜像)。 */
export interface PendingApprovalInfo {
  id: string
  session_id: string
  run_id: string | null
  agent_slug: string | null
  tool: string
  args: string
  preview: string
  reason: string | null
  cwd: string | null
  status: 'pending' | 'executing' | 'approved' | 'rejected' | 'failed'
  decided_by: 'user' | 'agent' | 'system' | null

  note: string | null
  result: string | null
  created_at: string
  decided_at: string | null
}

export interface HistorianActivityItem {
  id: string
  action: string
  detail: string
  session_ref: string | null
  created_at: string
}

/** 自动化动作链步骤(引擎 museTriggers.ActionSpec 镜像;tool_call 只能在构建器创建)。 */
export type AutomationActionSpec =
  | { type: 'notify'; title: string; body?: string }
  | { type: 'agent_run'; agentSlug: string; prompt: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  /** Amadeus 多维表写入(cells 键=列 id 或列名;值可含 {{row.X}} / {{= 算术 }} 模板)。
   *  db_row_add.skipIfEmpty = cells 里的一个键:该值展开后为空 → 本步跳过(记 skipped,不算失败)。
   *  db_row_edit 目标行:rowId > rowFrom(沿触发行的关联列,列 id 或列名;多值关联逐行)>
   *  match(目标表里 column == value 的全部行,value 可模板)> 触发命中的那一行。
   *  ⚠️与引擎 museTriggers.ActionSpec 是手抄镜像,字段名逐字对齐(抄错 TS 不报,运行时被引擎丢掉)。 */
  | { type: 'db_row_add'; path: string; cells: Record<string, string>; skipIfEmpty?: string }
  | { type: 'db_row_edit'; path: string; rowId?: string; rowFrom?: string; match?: { column: string; value: string }; cells: Record<string, string> }

/** db_changed 的附加条件一条(引擎 DbWhere 镜像):column = 列 id 或列名;eq/ne 要 value,empty/notempty 不要。
 *  比的是触发行**物化后**的模板字符串值(公式/引用列也能比;数组列是 'a, b' 形)。 */
export interface AutomationWhere {
  column: string
  op: 'eq' | 'ne' | 'empty' | 'notempty'
  value?: string
}

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
    /** Amadeus 多维表变化(vault 钉住建规则时那个库;columnId 存列 id——列名不唯一也会改)。
     *  columnIds:多列监听(引擎归一:≥2 列才有此键,columnId=首列;任一列变化即命中)。读端一律经 lib.watchedColumnIds 取并集。 */
    | { type: 'db_changed'; path: string; vault: string; event: 'row_added' | 'cell_changed'; columnId?: string; columnIds?: string[]; equals?: string; where?: AutomationWhere[] }
  prompt?: string
  cooldownHours: number
  lastFiredAt: string | null
  enabled: boolean
  createdAt: string
  /** 引擎自动停用的原因(排空封顶断环 / tool_call 不可用);用户手动启用时引擎清掉。缺席 = 用户自己停的或在跑。 */
  disabledReason?: string
  /** 旧式单动作:命中后执行的 agent(缺省=唤醒 Muse)。actions 存在时此字段为空。 */
  agentSlug?: string
  /** 动作链(有则取代 agentSlug/Muse 旧语义)。 */
  actions?: AutomationActionSpec[]
  /** 服务端权威计算的下次应触时刻(ISO;事件/文件类或已禁用 → null)。 */
  nextRunAt?: string | null
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

/** 开发者「回复前显示 system prompt」开关(localStorage;仅 dev 模式可见,App.send 据此带 debugSystemPrompt)。 */
export const SHOW_SYSTEM_PROMPT_KEY = 'forsion_tangu_show_system_prompt'

/** 本地 Normal Agent 定义(~/.tangu/agents/<slug>/;后端 agentRegistry 解析)。 */
/** 独立团队(Agent 轨道的持久团队实体;引擎 agents/teamRegistry.ts 同形)。项目轨道的「团队模式」是会话级运行模式,不用这个。 */
export interface TeamDef {
  slug: string
  name: string
  description: string
  /** 可选起头人(元数据;调度不走它)。09-16 起没有运行模式与轮数上限。 */
  lead: string
  /** 可选 emoji 或 TEAM Library 里的 avatar.* 文件名;空 = 成员头像组合。 */
  avatar: string
  /** 阵容显示顺序;成员独立并行工作,不限制发言顺序。 */
  members: Array<{ slug: string; role: string }>
  createdAt: string
  /** TEAM.md 正文。 */
  doc: string
  /** 团队会话的 cwd(团队自己的 Library)。 */
  libraryDir: string
}

/** avatar 是上传的图片文件名(引擎 teamRegistry 的 TEAM_AVATAR_FILE 同一口径)而非 emoji。 */
export const isTeamImageAvatar = (avatar?: string): boolean => /^avatar\.(png|jpe?g|gif|webp)$/i.test(avatar || '')

export interface NormalAgentDef {
  slug: string
  name: string
  /** 版本号(config.toml version,缺省 1.0.0);市场「可更新」检查用。 */
  version?: string
  description: string
  model: string
  tools: string[]
  enabledSkillIds?: string[]
  enabledMcpServers?: string[]
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
  /** 本地 agent 的 Library 绝对路径(私聊会话的 cwd);云端 agent 缺省 ⇒ 不能开私聊。 */
  libraryDir?: string
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
  /** 会话循环上限;null = 清掉(PATCH 删键),回到 Agent 定义 / 默认不限。 */
  maxIterations?: number | null
  thinkingLevel?: ThinkingLevel
  /** Ultra 档(对标 Codex Ultra):思考恒 max + 主动把可并行的活拆给 delegate 子代理。会话键,与 thinkingLevel 分开存 ——
   *  塞进 thinkingLevel 的话,读回时会被引擎的 normalizeThinkingLevel 归成 max,开关静默消失。只有本机非 chat 会话给入口。 */
  ultra?: boolean
  /** Fast 档(对标 Codex /fast):请求带 service_tier=priority,换更快的出字速度、多数模型额度消耗更快。会话键,与思考档无关。
   *  引擎只在模型目录声明了这一档(ModelInfo.fastTier)时上 wire,其余模型开着也不发;只作用于主循环,后台调用不跟。 */
  fast?: boolean
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
  /** 团队成员会话的团队段(引擎 teamRuns 写,桌面只读):有 teamSessionId 的 host 会话,审批闸只听那个团队会话此刻的档
   *  (tangu-agent agentLoop.approvalModeSessionId),本会话自己的 approvalMode 不算数。 */
  teamMember?: { teamSessionId?: string }
  /** 验证回路(/verify,host-only):收尾前引擎自动跑的命令,失败回灌逼修到绿才许收尾;空/缺省=关闭。 */
  verifyCommand?: string
  /** 计划模式(类 Claude plan mode):只读工具集,agent 经 exit_plan_mode 提交计划求批准。 */
  planMode?: boolean
  /** 工作预设(**会话事实**,与引擎 core/presetTable.ts 同源):'chat'=轻聊天(正向工具面、临时工作区、答完即停、不写笔记)/
   *  'coding'=编码 / 缺省=work。建会话时定,跑过一轮后引擎锁定(run 带别的值只警告不切)—— 换模式 = 新建会话。 */
  preset?: 'coding' | 'chat'
  /** 团队模式(群聊):≥2 个 Normal Agent 独立并行工作,被 @ 者可继续响应,各自以 DONE 表态收场(没有投票、没有轮数上限)。host-only。 */
  groupChat?: boolean
  /** run 事实(不落库):私聊里 @ 了的项目(引擎据此注入派遣指令,start_project_session)。 */
  mentionedProjects?: Array<{ name: string; path: string }>
  /** run 事实(不落库):团队首个 run 的播种源会话(私聊里拉起群聊 → 私聊摘要进团队首会话,拍板 ⑬);只由 send() 按 seedOnceBySession 带一次。 */
  groupSeedSessionId?: string
  /** 轨道身份(会话事实,建会话写一次、跑过一轮即锁,引擎侧存值为准):私聊 Agent。 */
  soloAgentSlug?: string
  /** 轨道身份:私聊外部引擎(Codex / PI 等 CLI 视作特殊的独立 Agent)。 */
  soloEngineId?: string
  /** 轨道身份:独立团队(Agent 轨道的持久团队实体)。 */
  teamSlug?: string
  /** 群聊参与者 slug(≥2;含已存 Normal Agent 与临时 Agent,按顺序)。 */
  groupAgents?: string[]
  /** 临时 Agent 定义(仅本会话群聊用,不持久化到 ~/.tangu/agents)。slug 在 groupAgents 中列出。 */
  groupTempAgents?: NormalAgentDef[]
  /** 会话团队的共同指令与成员职责;独立 TEAM 在运行时以持久定义为准。 */
  teamDoc?: string
  teamRoles?: Record<string, string>
  /** 会话级成员调档(配队面板「本会话」那行):slug → 本会话用的模型 / Effort;空值 = 沿用该 Agent 自己的设置。
   *  只写会话配置,绝不回写 Agent 定义;引擎侧 groupChat.tuneMembers 落地。临时成员直接改 groupTempAgents,不进这张表。 */
  teamMemberConfigs?: Record<string, { model?: string; thinkingLevel?: ThinkingLevel }>
  /** 本条消息 @ 的 agent slug(群聊:该 agent 本场优先发言;per-message,发送后清空,不持久化)。 */
  priorityAgent?: string
  /** 本条消息 @ 的 agent slug 列表(单聊:提示主 agent 用 delegate 把子任务交给这些 Normal Agent 作 subagent;per-message,不持久化)。 */
  mentionedAgentSlugs?: string[]
}

/** 独立 Agent / 外部引擎 / TEAM 会话虽以 `projectless` 运行,但它们各自就是一级工作轨道,
 *  不能再被项目分组逻辑当成「不在项目中工作」。身份键是会话事实,三者互斥。 */
export const isIndependentOrbitConfig = (config: AgentConfig | null | undefined): boolean =>
  !!(config?.soloAgentSlug || config?.soloEngineId || config?.teamSlug)

/** 通道类型:内置微信/Telegram/QQ + 插件注册的(与引擎 channels/types.ts 对齐)。 */
export type ChannelKind = 'wechat' | 'telegram' | 'qq' | (string & {})

/** 侧栏工作区:Cloud Project、本地目录、通道目录或不绑定项目的无根会话组。 */
export interface WorkspaceDescriptor {
  /** 分组键:cloud 用 cloudProjectKey(project);本地用绝对路径;rootless 用固定哨兵。 */
  key: string
  name: string
  /** channel = 通道专属文件夹;rootless = 不在项目中工作。 */
  kind: 'cloud' | 'local' | 'channel' | 'rootless'
  /** 本地工作目录绝对路径;cloud/rootless 为 null。 */
  path: string | null
  /** 常驻系统工作区(默认云 Project / Tangu 默认本地区):不可重命名 / 移除。 */
  system?: boolean
  /** Tangu 默认本地工作区。system 里只有它算 Project(右栏显示 PROJECT 详情);Vault 与默认云 Project 不算。 */
  isDefault?: boolean
  /** 云端 Project 名(kind='cloud'):会话 project_name 与 run 的 workspaceProject 都用它。 */
  project?: string
  /** 通道种类(kind='channel')。 */
  channel?: ChannelKind
  /** 会话分组键别名。默认本地目录在启动期变更时，旧 project_path 仍归入当前默认组。 */
  sessionKeys?: string[]
  /** 这个工作区在哪台电脑上(桌面作为调用方:新对话项目药丸的远端列表给的那几项)。缺省 = 本端。 */
  unitId?: string
}

/** 「Cloud 工作区」分组键哨兵(project_path 为空的会话归此组;真实本地路径永不为此值)。 */
export const CLOUD_WORKSPACE_KEY = '__cloud__'

/** 「不在项目中工作」会话组。单独列哨兵,不与旧的默认 Cloud Project 会话混淆。 */
export const ROOTLESS_WORKSPACE_KEY = '__rootless__'

/** 默认本地工作区还未解析出绝对路径时的占位键。 */
export const DEFAULT_LOCAL_WORKSPACE_KEY = '__default_ws__'

/** 默认云 Project 名(新会话未选时的「Tangu」默认工作区项目;与引擎 DEFAULT_PROJECT_NAME 一致)。 */
export const DEFAULT_CLOUD_PROJECT = 'Tangu'

/** 云 Project 的工作区分组键。 */
export const cloudProjectKey = (project?: string | null): string =>
  `${CLOUD_WORKSPACE_KEY}:${project || DEFAULT_CLOUD_PROJECT}`

/** 会话 → 工作区分组键:本地按 project_path;云会话按 project_name 归组(旧会话
 *  project_name 为空 → 归默认 Tangu 组,文件视图仍走其 per-session 工作区,不迁移)。 */
export const sessionWorkspaceKey = (
  s: { project_path?: string | null; project_name?: string | null; projectless?: boolean },
  workspaces?: ReadonlyArray<Pick<WorkspaceDescriptor, 'key' | 'sessionKeys'>>,
): string => {
  const raw = s.projectless ? ROOTLESS_WORKSPACE_KEY : s.project_path || cloudProjectKey(s.project_name)
  return workspaces?.find((ws) => ws.key === raw || ws.sessionKeys?.includes(raw))?.key ?? raw
}

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
  /** Muse 主动发进私聊的消息:proactive / proactive:todo / proactive:approval;其余为空。 */
  origin?: string | null
}

export interface ModelInfo {
  groupId?: string | null
  groupName?: string | null
  groupSortOrder?: number
  sortOrder?: number
  tags?: Array<{ text: string; color: 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'gray' }>
  multiplier?: number | null
  id: string
  name: string
  provider: string
  source: 'forsion' | 'direct'
  /** 大语言模型 / 生图 / 语音识别(后端已分类;模型设置据此分区)。缺省视作 llm。 */
  modelType?: 'llm' | 'image_gen' | 'asr'
  /** 模型上下文窗口(tokens);输入框「上下文占比」进度条用。后端缺省回退全局默认。 */
  contextWindow?: number
  /** contextWindow 的来源:override=env 或本机 modelOverrides / model=模型自报 / learned=上游报错回学 / family=族表推断 / default=兜底。设置页据此区分「已覆盖」与「自动」。 */
  contextWindowSource?: 'override' | 'model' | 'learned' | 'family' | 'default'
  /** 自动识别出的模型窗口(封顶前,不看本机覆盖)。contextWindow 是 run 实际用的:自动识别的一律封顶 contextWindowCap,
   *  本机覆盖(modelOverrides)不封顶 —— 模型菜单的「上下文上限」据此露出、写的就是覆盖。老引擎不下发 = 不露。 */
  maxContextWindow?: number
  /** 能不能直接「看」图。黑名单制:缺省/true=能;false=遇图自动转交「辅助模型 · 图像识别」。 */
  supportsVision?: boolean
  /** 该模型真正支持的思考档(引擎能力表下发;仅 llm)。思考菜单据此把不支持的档标灰。缺省=不知道,全可选。 */
  thinkingLevels?: string[]
  /** 模型目录给的 Fast 档说明原文(Codex `/models` 的 service_tiers,如「1.5x speed」「2x speed, increased usage」)。
   *  缺席 = 这个模型没有 Fast 档,界面不露开关。 */
  fastTier?: string
}

/** GET /agent/models/quota 的 quota:直连来源的额度 / 余额(口径见 llm/providerQuota.ts)。 */
export interface QuotaWindow {
  /** 窗口长度(秒):18000 = 5 小时,604800 = 每周。客户端据此起名。 */
  seconds: number;
  usedPercent: number;
  /** 重置时刻(毫秒时间戳)。 */
  resetAt?: number;
}

export interface ProviderQuota {
  providerId: string;
  /** 订阅套餐名(Codex 的 plan_type),原样透传。 */
  plan?: string;
  windows?: QuotaWindow[];
  balance?: { currency: string; amount: number };
  fetchedAt: number;
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
  /** Forsion 云端的实时语音通话模型(不在 models 里;apiModelId = 上游模型名,音色家族按它分)。没有 = 云端没开通话 / 没登录 / 老引擎。 */
  realtimeModel?: { id: string; name: string; apiModelId?: string | null } | null
  /** Forsion 云端的机器翻译模型(不在 models 里:它们不能聊天;只有「翻译」模型槽列它们)。没有 = 云端没配 / 没登录 / 老引擎。 */
  translateModels?: Array<{ id: string; name: string; provider?: string; apiModelId?: string | null }>
  /** Forsion 云端的朗读模型(设置页「语音朗读」模型框的候选;老引擎不给 = 没有) */
  ttsModels?: Array<{ id: string; name: string; apiModelId?: string | null }>
  /** Forsion 云端的补全(FIM)模型(设置页「补全」模型槽与插件 ctx.tangu.fim 的候选;只做补全的不在 models 里)。没有 = 云端没配 / 没登录 / 老引擎。 */
  fimModels?: Array<{ id: string; name: string; provider?: string; apiModelId?: string | null }>
  /** 引擎的缺省上下文上限(272k):自动识别出的窗口超过它就封顶,本机覆盖才开更大。 */
  contextWindowCap?: number
  /** 该引擎能不能写本机模型覆盖(PUT /agent/models/overrides 同一道 hostExec 门)。false / 缺省 = 不露「上下文上限」。 */
  modelOverridesWritable?: boolean
  /** 引擎的 Ultra run 不受缺省上限约束(09-27)。缺省 = 老引擎,Ultra 也封顶:界面别按拉满显示窗口。 */
  ultraUncapped?: boolean
  /** 云端托管面诊断:empty=可达但 admin 没配模型;error=不可达/未授权/未部署 brain-api。 */
  forsion?: { status: 'ok' | 'empty' | 'error'; detail: string | null }
}

// ── 项目上下文(本地项目会话的项目级内容;与引擎 services/projectContext.ts 同形)──
/** 用户侧的项目默认项(引擎家目录 project-settings.json,按 realpath 索引;不进仓库)。Agent 与 Team 二选一。 */
export interface ProjectSettings {
  defaultAgent?: string
  defaultTeam?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  approvalMode?: NonNullable<AgentConfig['approvalMode']>
  /** 项目图标:emoji,或 `icon.<ext>` = 导入的图片(存在项目的 `.tangu/` 里,经引擎读出)。 */
  icon?: string
}

export const isProjectIconFile = (icon?: string): boolean => /^icon\.(png|jpe?g|gif|webp)$/i.test(icon || '')

export interface ProjectDocInfo {
  /** 「这个项目的指令文件」:cwd 层首个命中的候选名;一个都没有时 = 待创建的 `<cwd>/.tangu/AGENTS.md`。 */
  path: string
  exists: boolean
  content: string | null
  mtimeMs: number | null
  bytes: number
  tooLarge: boolean
  /** 引擎本轮实际会拼进系统提示的全部文件(根→cwd)。 */
  sources: string[]
  truncated: boolean
  candidates: string[]
}

export interface ProjectSkillInfo { id: string; name: string; description: string; path: string; legacy: boolean }

export interface ProjectPlanInfo { name: string; path: string; mtimeMs: number; size: number; title: string }

export interface GitRemoteInfo {
  name: string
  /** 遮过凭据的地址。 */
  url: string
  host: 'forsion' | 'github' | 'other'
  hostname: string | null
  /** `owner/repo`。 */
  path: string | null
  /** 仓库网页。 */
  web: string | null
  auth: 'forsion' | 'github' | 'local'
}
export interface GitCommitInfo { sha: string; short: string; at: number; subject: string }

export interface GitChangeInfo { code: string; path: string }

export interface GitSummary {
  available: boolean
  repo: boolean
  nested?: boolean
  branch?: string
  detached?: boolean
  upstream?: string | null
  ahead?: number
  behind?: number
  staged?: number
  unstaged?: number
  untracked?: number
  changes?: GitChangeInfo[]
  changesTotal?: number
  commits?: GitCommitInfo[]
  remote?: string | null
  /** 远端个数(没有 origin、只有一个远端时也能推)。 */
  remotes?: number
  /** 全部远端:哪个站、哪个仓库、推拉带谁的凭据(forsion / github = 引擎替他带那个账号;local = 这台电脑自己的 git 配置)。老引擎没有。 */
  remoteList?: GitRemoteInfo[]
  /** 不点名远端时「推送」推去哪个(当前分支的上游 → origin → 唯一那个);定不下来 → null。老引擎没有(undefined)。 */
  pushRemote?: string | null
  /** 仓库自带会执行程序的配置项与钩子;空 = 没有。 */
  configRisks?: string[]
  /** 用户在面板上信任过这个仓的配置。 */
  trusted?: boolean
  /** 读工作区会跑仓库自带的过滤器且未信任 → 这次没读改动(changes 为空不代表干净)。 */
  changesUnread?: boolean
}

/** 提交会署的名字和邮箱。source:git = git 配置里本来就有;custom = 「设置 → Git」里填的;forsion = 由 Forsion 账号推出来的;
 *  auto = 哪儿都没有,git 自己按这台电脑的用户名和主机名取的。 */
export interface GitIdentity { name: string; email: string; source: 'git' | 'custom' | 'forsion' | 'auto' }

export interface ProjectContext {
  cwd: string
  workspaceDir: string
  workspaceDirName: string
  doc: ProjectDocInfo
  skills: ProjectSkillInfo[]
  plans: ProjectPlanInfo[]
  settings: ProjectSettings | null
  git: GitSummary
  /** 项目记忆(只在这个项目里成立的事实,本项目的 agent 共用;存本机用户目录,不在项目文件夹里)。老引擎 / 远端来源不带。 */
  memory?: ProjectMemoryView
}

export interface ProjectMemoryView {
  version: string | null
  entries: Array<{ id: string; content: string; updatedAt: number }>
  chars: number
  limit: number
  /** 等用户点头的后台候选(带网址、命令或权限字眼,没有直接记):不是记忆,Agent 读不到。老引擎不带。 */
  candidates?: Array<{ id: string; content: string; at: number }>
  /** 写满时的自动压缩:最近一次的前后规模;removed = 被合并或去掉、还能逐句恢复的原句(新的在前)。没压过 / 老引擎不带。 */
  compacted?: { at: number; before: { count: number; chars: number }; after: { count: number; chars: number }; removed: Array<{ id: string; content: string }> }
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  icon: string | null
  category: string | null
  /** local=Tangu 本地;claude/codex=实时识别的外部生态;user=本人已上云;cloud/缺省=全局云端。 */
  source?: 'local' | 'claude' | 'codex' | 'user' | 'cloud'
  /** agent=Agent 用 manage_skill 自建(SKILL.md frontmatter origin);「自建」徽标只认它,不认 category(agent 桶里混着包内置专属技能)。 */
  origin?: 'agent' | null
  /** 随包内置(含家目录里没被改过的镜像;用户改过的副本不算)。Agent 详情据此把内置技能收进折叠组;分类各写各的,不能当判据。 */
  builtin?: boolean
  /** Agent 级技能开了共享(SKILL.md frontmatter `shared: true`):别的 Agent 能在技能目录里看到并借用。 */
  shared?: boolean
}

/** One physical skill copy in the host library. `key` identifies this copy even when slugs collide. */
export interface SkillCatalogEntry {
  key: string
  id: string
  slug: string
  name: string
  description: string
  icon?: string | null
  version?: string | null
  scope: 'user' | 'agent'
  owner: string | null
  path: string
  provenance: 'builtin' | 'bundle' | 'user' | 'builtin-mirror' | 'agent-builtin' | 'agent' | 'agent-mirror'
  origin?: string | null
  /** Existing on-disk folders outside the slug rules remain visible, but require a new valid name to manage. */
  compatibility?: 'legacy-slug' | null
  readOnly: boolean
  disabled: boolean
  disabledForAgent?: boolean
  availability: 'available' | 'disabled' | 'shadowed'
  shadowedBy: string | null
  /** Only returned by the detail endpoint. Body excludes YAML frontmatter. */
  content?: string
  files?: Array<{ path: string; size: number }>
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
    /** 插件自带的 server(引擎插件 manifest 的 mcpServers):不在 mcp.json 里,设置页只读展示。 */
    origin?: { pluginId: string; pluginName: string }
    tools: Array<{ name: string; description: string }>
  }>
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
  /** Origin of a deliverable forwarded from a team member; used for remote file reads. */
  sourceSessionId?: string
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
  /** 'override' | 'model' | 'learned' | 'family' | 'default';family/default 是猜的,UI 要标注。
   *  ⚠️ 新增来源要同时加进 Composer2 的白名单与 i18n 的 ctx.windowSource.* —— 白名单外的值
   *  会被静默当成 'default' 显示成「128k 兜底」,标注反而变成假的。 */
  ctxWindowSource: string
  /** 模型本身的窗口(封顶前)。> ctxWindow 且来源不是 override = 被缺省上限封了顶。 */
  ctxWindowMax?: number
  /** 这一轮的窗口按 Ultra 算(自动识别的不封顶,09-27)。与会话当前的 Ultra 开关不一致 = 切了开关还没跑下一轮,窗口已过时。 */
  ultra?: boolean
  sections: Array<{ k: string; tokens: number }>
  files: string[]
  filesTruncated: boolean
  historyCount: number
  historyTokens: number
  /** 自动压缩触发线(token):引擎按「窗口 − 预留」与用户的 thresholdPercent 算好的,客户端只展示、不另算一份。 */
  compactAt?: number
  /** 思考档:请求档 vs 实际生效档(能力表 clamp;不同=被自动降档,H6 降档可见)。 */
  thinkingRequested?: string
  thinkingEffective?: string
  /** 本 run 生效的最大循环轮数与来源('session' /loop | 'agent' 定义 | 'default'):/status、/loop 提示据此,
   *  别再只看会话配置 —— Agent 定义里的 3 轮曾显示成 90。缺省 = 不限轮数(默认即不限,source 为 'default')。 */
  maxIterations?: number
  maxIterationsSource?: 'session' | 'agent' | 'default' | 'automation' | 'muse'
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
  /** 审批挂起(托盘 run):调用没跑,agent 先干别的;用户拍板后同一 id 的真结果到达即清掉。落库的占位结果重载后仍带着它。 */
  parked?: boolean
}

/** 助手一条消息的「顺序段」(直播归约期填充;新历史消息也可由工具锚点重建):
 *  text=一段正文;tools=一串**连续**工具调用(按 id 引用 toolEvents,连续者并入同一块)。
 *  旧历史没有锚点 → 渲染回退老序(全部工具一块 + 全文)。 */
export type MsgSeg =
  | { t: 'text'; text: string }
  | { t: 'tools'; ids: string[] }

export interface ApprovalRequest {
  approvalId: string
  /** 要兑现到哪条 run:普通 run = 本 run;团队成员的审批由团队 run 转发,这里是**子 run** 的 id(引擎事件带 runId 时以它为准)。 */
  runId: string
  name: string
  arguments?: string
  preview: string
  /** 散文类预览的结构化版(引擎 approvals.ApprovalPreviewI18n 镜像):卡上按界面语言渲染 t(key, vars),没有就显示 preview。 */
  previewI18n?: ApprovalPreviewI18n
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  /** 「这次为什么问你」(B3)。旧事件没有这个字段 → 卡上不显示解释,不是错误。 */
  reason?: ApprovalReason
  /** 对应的工具调用 id(挂起的工具卡据此判断「还在等你」还是早已了结)。旧事件没有。 */
  toolCallId?: string
  // P1-K1
  /** 远程会话发起的审批:来路 + 调用方设备(引擎只给远程污点 run 带;reducer 白名单清洗)。本机 run 没有。 */
  remote?: ApprovalRemote
  // P1-K3
  /** 受保护路径(凭据 / Forsion 本机配置):只能在执行设备本机批准,远端卡片只给「拒绝」(引擎对远端批准回 403 APPROVAL_LOCAL_ONLY)。 */
  localOnly?: boolean
  /** 谁答的(approval_result.by,reducer 白名单清洗):卡片收起时写「在 X 上」。旧引擎没有。 */
  answeredBy?: AnswerBy
}

// P1-K3
/** approval_result.by / inquiry_result.by:谁兑现了这张卡。remote = 带远程标记但来路不在契约内;callerUnit 只在隧道且验过调用方时有。
 *  callerName 是登记者自选的不可信串,只作纯文本展示;可能清洗后为空(看 callerUnit 判「是不是已登记设备」)。 */
export interface AnswerBy {
  via: 'local' | 'tunnel' | 'p2p' | 'lan' | 'remote' | 'channel'
  callerUnit?: string
  callerName?: string
}

// P1-K1
/** approval_request.remote(设备能力 MCP 方案 P1 · K1)。callerUnit/Kind/Name 只在 via==='tunnel' 且 hub → 本机 unitWeb 验过调用方断言时才有;
 *  缺席 = 账号下未识别的客户端(隧道)/ 局域网配对设备 / 点对点直连。callerName 是登记者自选的不可信串,只作纯文本展示。 */
export interface ApprovalPreviewI18n {
  key: string
  vars?: Record<string, string | number>
}

export interface ApprovalRemote {
  via?: 'tunnel' | 'p2p' | 'lan'
  callerUnit?: string
  callerKind?: 'phone' | 'desktop'
  callerName?: string
}

/** 引擎给出的审批判定理由。kind 由 reducer 白名单清洗,渲染层可以信任。 */
export interface ApprovalReason {
  /** custom-ask=你写的规则要求问 · escalate=工作区外写入升级 · mode=该档位本就需要审批 ·
   *  protected=写凭据 / Forsion 本机配置(契约 C4 / C6:每次都问,完全通行与「总允许」都不跳过) ·
   *  always=工具自己声明每次都问(花掉账号里的东西这类动作;完全通行与「总允许」都不跳过,云端会话里也问) */
  kind: 'custom-ask' | 'escalate' | 'mode' | 'protected' | 'control' | 'always'
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
  // P1-K3
  /** 谁答的(inquiry_result.by)。 */
  answeredBy?: AnswerBy
}

/** sketch 工具画的对话内 HTML 卡片。载荷在 tool_call **参数**里(原样落 JSONB 不截断),
 *  直播由 tool_result 归约生成、重载由 recordToUi back-fill 重建并按工具锚点归位。 */
export interface SketchItem {
  /** 工具调用 id:去重键(SSE 重放/重载不双画),兼作 React key。 */
  callId: string
  html: string
  title?: string
  /** 草稿:参数还在流式生成,html 是已到达的半截(只在直播中由渲染层现算,不落库);终稿到达即换成同 callId 的正式卡。 */
  draft?: boolean
}

/** 任务清单一项(todo_write/todo_read 工具 + `todo` 事件;对齐 Claude TodoWrite)。 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 等模型期间的实况(status:llm_call 事件;仅内存不持久化)。since=本次调用起点(重试续用),bytes=上传字节。 */
/** 团队成员本次激活的过程状态(主聊天气泡上的一行;详情在 Team Desk)。 */
export interface TeamWork {
  /** 展示文案:start 时 = 成员这次的任务,team_activity 后 = `tool + ' ' + argsPreview`。别从它反推工具名。 */
  activity?: string
  /** 成员最近一次工具调用的工具名(只由 team_activity 写;agentStatus 的 tool 阶段只认它)。 */
  tool?: string
  waiting?: boolean
}

export interface LiveWait {
  /** describing = 主模型没有图像输入,工具截图 / 附件图正在转成文字(引擎 status:describing_images 的 start → done)。 */
  phase: 'sending' | 'accepted' | 'describing'
  bytes?: number
  uploadMs?: number
  /** describing 时这批图的张数。 */
  images?: number
  since: number
}

export interface UiMessage {
  id: string
  /** system=客户端本地通知行(斜杠命令反馈等;不持久化,reload 会消失)。 */
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Muse 主动发进私聊的(引擎 chat_messages.origin):proactive / proactive:todo / proactive:approval。 */
  origin?: string
  reasoning?: string
  /** 思考累计用时(ms)与本段思考的起点:只在本次运行里由 appStore 记(引擎不落库),渲染成「思考 N 秒」。 */
  reasoningMs?: number
  reasoningSince?: number
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
  /** 模型调用等待期:sending=正在上传上下文,accepted=已送达等首帧;首帧/工具/结束即清(见 appStore reduceEvent)。 */
  live?: LiveWait
  /** 并行团队(09-16 第四轮):成员在自己的工作会话里干活,这条气泡是它本次激活的占位,发言到达(group_speaker end 带 text)才填正文;
   *  activity = 当前工具一行动态(team_activity),waiting = 等审批 / 询问。end 即清。 */
  work?: TeamWork
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
  /** 并行团队:这条发言以 DONE 收尾(成员表态「我这边完了」)。正文里的 DONE 已剥掉,气泡上以「已完成」小标记呈现。 */
  teamDone?: boolean
  teamSummary?: boolean
  /** Live public team remark; historical messages never replay the reveal animation. */
  revealAt?: number
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
  /** 落盘的外部连接地址 / 令牌(backendUrl/token 在托管就绪时被折算成托管子进程的,这里不会)。
   *  设置页从托管切到外部时用它填表(Codex 第一轮 A-1)。老主进程不给 → undefined。 */
  externalConnection?: { backendUrl: string; token: string }
  /** 「允许其他设备连接本机」开关(起 unitWeb 局域网面 + unitHost 云通道,B 端渲染)。 */
  unitHostEnabled?: boolean
  cloudUrl: string
  sandbox: 'auto' | 'docker' | 'none'
  hostSandbox?: HostSandboxConfig
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
  /** Account owning sync settings; include with asynchronous sync updates. */
  forsionSyncAccountId?: string | null
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
  /** 前台窗口采样接缝:开=插件可读「现在焦点在哪个 app」。默认关,入口只在开发者选项。 */
  activeWindowEnabled?: boolean
  /** Agent Desk 演出面板:聊天右侧 agent 展示区。默认开,设置→高级可关。 */
  agentDeskEnabled?: boolean
  /** 有会话运行时阻止电脑闲置休眠(桌面专属,默认关)。 */
  keepAwakeWhileRunning?: boolean
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
  /** 实时语音通话模型:<providerId>/<model>(自带百炼 key)或 Forsion 云端的实时模型 id;空 = 未启用。实际用哪个见 services/realtimeModel.ts。 */
  realtimeModelId?: string
  /** 只读:用户从没动过「语音通话」(这时已登录 Forsion 的用户默认开、用云端模型)。主进程按 config.json 算出来,写它无效。 */
  realtimeModelUnset?: boolean
  /** 实时通话音色(预置名或复刻音色 id;复刻音色须以同一实时模型为 target_model 复刻)。空 = Tina。 */
  realtimeVoice?: string
  /** 语音输入偏好后端:local=本地 SenseVoice(需下载);cloud=Forsion 云端/自带 key。缺省 cloud。(就绪与否走 asrLocalStatus IPC,不落 config) */
  asrBackend?: 'local' | 'cloud'
  /** 辅助模型 · LLM:后台/特殊 agent(Muse/Historian)用;空=跟随 app 级槽。 */
  backgroundModelId?: string
  /** 辅助模型 · 图像识别:主模型无原生视觉时的看图兜底 + 非聊天识图;空=跟随 app 级槽。 */
  visionModelId?: string
  /** 辅助模型 · 翻译:笔记里的「翻译」与插件 ctx.tangu.translate 用;空=跟聊天当前模型。 */
  translateModelId?: string
  /** 辅助模型 · 补全:插件 ctx.tangu.fim(行内补全)用;只能选补全(FIM)模型;空 = 目录里第一个补全模型。 */
  fimModelId?: string
  /** 上次用的审批档 / 思考档:**新会话据此起步**(模型走 modelId,已是全局键)。
   *  在任意会话里改这三样都会写回这里 —— 用户的口径是「换过一次就一直是它」,不是每建一个会话重设一次。 */
  lastApprovalMode?: 'readonly' | 'auto-edit' | 'full-auto' | 'custom'
  lastThinkingLevel?: ThinkingLevel
  /** chat 会话上次用的思考档 —— 与 work 的 lastThinkingLevel **分槽**(D36):chat 缺省「中」(09-19 前是 off);在 chat 里改档不污染下一个 work 会话。 */
  lastChatThinkingLevel?: ThinkingLevel
  /** 上次在 work 会话里停在 Ultra 档(与 lastThinkingLevel='max' 同写;chat 槽没有 Ultra)。 */
  lastUltra?: boolean
  /** 上次的 Fast 开关(新会话照它起步;模型没有 Fast 档时引擎不发,药丸也不显示)。 */
  lastFast?: boolean
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
  // P1-K1(INTEGRATION R-27:六个字段一次加全,K7 / K8 不再碰 UnitInfo;两端数据桥原样转 hub JSON,无需改 main)
  /** 设备类型(server 2.3.23 起;老 server 不回 → 按 desktop)。手机 P1 不开通道,切换器滤掉它。 */
  kind?: 'desktop' | 'phone'
  /** 用户起的短别名(拼进 MCP server 名 dev_<alias>);null = 没起。 */
  alias?: string | null
  /** 登记时的名字(server 2.3.24 起;之后改名不影响它)。确认框 / 信任条目快照用它,不用谁都能改的 name。 */
  registeredName?: string | null
  /** 设备自报的能力快照(不作授权依据);capsLive=false 时 engine 当「未知」,不沿用重连前的 ready。 */
  caps?: { engine?: 'ready' | 'starting' | 'external' | 'stopped' | null; tools?: { id: string; version: string }[] } | null
  /** caps 上报时刻(只作展示 / 年龄)。 */
  capsAt?: string | null
  /** 这份 caps 是不是设备**当前这次连接**里报的。 */
  capsLive?: boolean
}
