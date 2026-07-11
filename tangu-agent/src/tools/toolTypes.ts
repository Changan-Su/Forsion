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
  /** host 模式的审批档（loop 据此决定哪些破坏性工具执行前需用户批准）。 */
  approvalMode?: 'readonly' | 'auto-edit' | 'full-auto';
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
  /** 内置工具黑白名单(config.toml tools_mode/tools_list):'deny'=名单内禁用,'allow'=仅名单内可用;
   *  缺省=不限制。只约束无门禁的内置工具,见 resolveTools。 */
  toolsMode?: 'allow' | 'deny';
  toolsList?: string[];
  /** 本次 run 的模型 id(delegate 子代理沿用父模型)。 */
  modelId?: string;
  /** 默认生图模型 id(generate_image 缺省据此选模型;来自 agentConfig.imageModelId)。 */
  imageModelId?: string;
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
}

export interface ToolImpl {
  definition: Tool;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
  /** 工具可见性域：'sandbox'=仅云沙箱模式，'host'=仅本地直连模式，缺省='both'=两者皆可。 */
  mode?: 'sandbox' | 'host' | 'both';
  capabilities?: ToolCapabilities;
}
