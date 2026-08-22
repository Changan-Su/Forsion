/**
 * 工具系统共享类型(从 registry.ts 抽出,供 toolRegistry/builtin providers/hostExec 共用,
 * 避免值模块间的循环依赖——本文件零运行时依赖)。
 */
import type { Tool } from '../core/types.js';
import type { LoadedCustomTool } from './customTools.js';
import type { LoadedMcpTool } from '../mcp/toolBridge.js';
import type { AppProfile } from '../seams/appProfile.js';

export interface ToolContext {
  userId: string;
  sessionId: string;
  appId: string;
  runId?: string;
  /** 客户端面标识(input.client,经 routes/runs 白名单:desktop|web|mobile|cli|tui/版本)。
   *  GUI 门禁工具(sketch)据此判定;TUI/通道/自动化/子代理 run 无 tag → 缺省即不可见(default-deny)。 */
  client?: string;
  signal?: AbortSignal;
  /** 本次 run 的自定义工具（HTTP/JS），按工具名索引。 */
  customTools?: Map<string, LoadedCustomTool>;
  /** 本次 run 的 MCP 工具快照(run 开始取一次、run 内冻结——prompt 缓存纪律)。 */
  mcpTools?: Map<string, LoadedMcpTool>;
  /** 本次 run 启用的技能 id（use_skill 的 allowlist）。 */
  enabledSkillIds?: string[];
  /** 执行形态：'host'=本地直连真实 FS/shell（TUI），缺省/'sandbox'=云沙箱 + 云工作区。 */
  execMode?: 'sandbox' | 'host';
  /** host 模式的工作目录（文件/命令相对此解析）。 */
  cwd?: string;
  /** host 模式的**额外工作文件夹**(绝对路径):并入可写根,免逐次「越界写」审批。
   *  相对路径**仍只**相对 cwd 解析 —— 这些目录一律用绝对路径引用,避免多根相对解析的歧义。 */
  extraRoots?: string[];
  /** 云端 Project 工作区名(sandbox 模式):有值时文件工具落 <appId>/Cloud-Workspaces/Projects/<name>/(跨会话共享),缺省落旧 per-session 工作区。 */
  wsProject?: string | null;
  /** host 模式的审批档（loop 据此决定哪些破坏性工具执行前需用户批准）。 */
  approvalMode?: 'readonly' | 'auto-edit' | 'full-auto' | 'custom';
  /** 本次 run 的 AppProfile(接缝①):工具门禁 isEnabledFor 据此过滤。缺省回退 deps().profile。 */
  profile?: AppProfile;
  /** delegate 子代理深度(0/缺省=主 loop,1=子代理内)。深度 ≥1 时 delegate 工具不可见,防递归裂变。 */
  subAgentDepth?: number;
  /** 本 run 激活的 Normal Agent 定义 slug(start_discussion 的「分身」据此取主 agent 人设;缺省=默认 agent)。 */
  agentSlug?: string;
  /** 讨论 run 标记:start_discussion 起的后台群聊 run 内,start_discussion/wait_discussion 不可见(防递归)。 */
  inDiscussion?: boolean;
  /** 计划模式(类 Claude plan mode):只暴露只读工具 + exit_plan_mode;custom/MCP 工具一并隐藏。 */
  planMode?: boolean;
  /** Muse run 标记:仅此时 add_muse_todo(Muse 唯一写权限)可见。 */
  muse?: boolean;
  /** 用户活动日志读取授权(config.toml activity_access;Muse 之外的 agent 用 read_activity 需显式开)。 */
  activityAccess?: boolean;
  /** 无人值守自动化的来源(triggerKey):活动行加 o= 标记,event_seen 评估据此跳过本规则自己产生的事件(防自激)。 */
  automationOrigin?: string;
  /** 内置工具黑白名单(config.toml tools_mode/tools_list):'deny'=名单内禁用,'allow'=仅名单内可用;
   *  缺省=不限制。只约束无门禁的内置工具,见 resolveTools。 */
  toolsMode?: 'allow' | 'deny';
  toolsList?: string[];
  /** 本会话是否连接着聊天通道(微信/TG/QQ 活跃绑定):channel_send_* 仅此时暴露。loop 每 run 预查一次。 */
  channelSession?: boolean;
  /** 工作预设:'coding'=编码任务形态(Coding Space / bench / CLI 项目模式显式传入)。
   *  产品面工具(浏览器/笔记/收件箱等)转 deferred,提示词换 coding 契约——见 registry CODING_PRESET_DEFERRED。 */
  preset?: 'coding';
  /** 已解锁的 deferred 工具名(P0-2):**严格 run-local**,每 run 从空集起步、本 run 内经 load_tools 增量;
   *  不从历史恢复(hydrate 不带 tool_calls)。 */
  unlockedTools?: ReadonlySet<string>;
  /** load_tools 的解锁回调(loop 提供):记入 run 级集合并触发下一迭代 defs 重算。
   *  缺省(子代理/群聊等)= 不支持解锁 → load_tools 不暴露,deferred 保持隐藏。 */
  unlockTools?: (names: string[]) => void;
  /** 本次 run 的模型 id(delegate 子代理沿用父模型)。 */
  modelId?: string;
  /** 默认生图模型 id(generate_image 缺省据此选模型;来自 agentConfig.imageModelId)。 */
  imageModelId?: string;
  /** 辅助模型 · 图像识别 id(主模型无原生视觉时,collectImage 的图先经它转文字;来自 agentConfig.visionModelId)。 */
  visionModelId?: string;
  /**
   * 工具产出图片的回流闸(view_image 用):工具把图片 data URL 交回 loop,
   * loop 在本轮工具执行完后把它物化成一条 user 图像消息追加到对话尾部,让模型"看见"图片。
   * 缺省(未装配此闸的运行环境)时工具应优雅降级,不要假定一定可用。
   */
  collectImage?: (img: { url: string; name?: string }) => void;
  /**
   * 「在对话区展示文件」闸(display_file / generate_image / 表情包用):工具把要展示给**用户**的
   * 文件交给 loop,loop 即时 publish 'display_file' 事件(桌面端内联渲染、图片可点击放大),并在
   * finalize 时持久化到 assistant 消息。与 collectImage 不同:不回灌进模型上下文、不计费。
   * 缺省(未装配此闸,如 TUI/纯云)时工具应优雅降级,不要假定一定可用。
   */
  displayFile?: (item: DisplayFileItem) => void;
  /**
   * 「Agent Desk」演出闸(desk_present 用):把要给用户看的视图清单交给 loop,loop 即时 publish
   * 'desk_present' 事件,桌面端在聊天右侧的实验性 Agent Desk 面板里并排展示(不落库、不回灌上下文)。
   * 缺省(TUI/纯云等未装配此闸的运行环境)时工具应优雅降级,不要假定一定可用。
   */
  presentDesk?: (spec: DeskPresentSpec) => void;
  /** 父 run 的思考档(self_brainstorm 分身须同档:无原生思考的模型档位是注进 system 的文本,档不同=前缀不同)。 */
  thinkingLevel?: string;
  /**
   * 当前 run 的在存工作消息数组冻结快照(self_brainstorm 用):返回主 loop workingMessages 的浅拷贝。
   * 分身补全的共享前缀**必须**取自这里而非 DB 重建——脚手架消息不落库、运行内折叠、pin 锚定都会让
   * 重建序列字节不一致,provider 前缀缓存全 miss(这是该工具「命中缓存」承诺的唯一真源)。
   * 仅主 agentLoop 装配;子代理/群聊等旁路 loop 不装配,消费方须优雅降级。
   */
  getWorkingMessages?: () => any[];
}

/** Agent Desk 演出请求:views=从上到下的展示项(file=本地文件;view=已注册的桌面视图,含插件注册);
 *  size=展示形态(card=收起成预览卡片,half/wide=展开侧板;宽度被用户拖过后不再被 agent 覆盖)。 */
export interface DeskPresentSpec {
  views: Array<
    | { type: 'file'; path: string; name?: string }
    | { type: 'view'; view: string; params?: Record<string, unknown>; name?: string }
  >;
  size?: 'card' | 'half' | 'wide';
  note?: string;
}

/** 展示给用户的文件:path=工作区文件(前端懒加载字节);dataUrl=内联字节(无工作区路径,如表情包 blob)。二选一。 */
export interface DisplayFileItem {
  name: string;
  mime?: string;
  /** 工作区相对路径(host=cwd 相对;sandbox=工作区相对)。前端按会话形态读字节。 */
  path?: string;
  /** 内联数据 URL(data:<mime>;base64,...);用于无工作区路径的小文件。 */
  dataUrl?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
  artifactPath?: string;
  metadata?: Record<string, any>;
}

export interface ToolCapabilities {
  /** 副作用类别；unknown/write/system/browser 均默认串行。 */
  sideEffect?: 'none' | 'read' | 'network' | 'browser' | 'write' | 'system' | 'unknown';
  /** 仅显式声明 true 的工具可被 agentLoop 并发执行。 */
  parallel?: boolean;
  /** 同一 key 的调用应串行；浏览器等有会话态的工具使用固定 key。 */
  concurrencyKey?: string;
  /** 默认超时；executeTool 会把它并入 ctx.signal。 */
  defaultTimeoutMs?: number;
  /** 审批档：'command' = 与 run_bash 同档(readonly/auto-edit 下需批准）。缺省=只读语义、不触发审批。
   *  approvals.toolNeedsApproval 经 declaredApproval(name) 读此，插件工具无需核心硬编码工具名。 */
  approval?: 'command';
  /** 正向声明:允许作为自动化 tool_call 动作(不经 LLM 定参直执行)。缺省 false——
   *  插件工具不声明就不进动作目录(declaredAutomationSafe;内置另有 curated 白名单)。 */
  automationSafe?: boolean;
}

export interface ToolImpl {
  definition: Tool;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
  /** 工具可见性域：'sandbox'=仅云沙箱模式，'host'=仅本地直连模式，缺省='both'=两者皆可。 */
  mode?: 'sandbox' | 'host' | 'both';
  capabilities?: ToolCapabilities;
}
