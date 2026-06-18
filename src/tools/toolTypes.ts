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
  /** 计划模式(类 Claude plan mode):只暴露只读工具 + exit_plan_mode;custom/MCP 工具一并隐藏。 */
  planMode?: boolean;
  /** Muse run 标记:仅此时 add_muse_todo(Muse 唯一写权限)可见。 */
  muse?: boolean;
  /** 本次 run 的模型 id(delegate 子代理沿用父模型)。 */
  modelId?: string;
  /**
   * 工具产出图片的回流闸(view_image 用):工具把图片 data URL 交回 loop,
   * loop 在本轮工具执行完后把它物化成一条 user 图像消息追加到对话尾部,让模型"看见"图片。
   * 缺省(未装配此闸的运行环境)时工具应优雅降级,不要假定一定可用。
   */
  collectImage?: (img: { url: string; name?: string }) => void;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

export interface ToolImpl {
  definition: Tool;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
  /** 工具可见性域：'sandbox'=仅云沙箱模式，'host'=仅本地直连模式，缺省='both'=两者皆可。 */
  mode?: 'sandbox' | 'host' | 'both';
}
