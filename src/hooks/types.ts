/**
 * Lifecycle Hooks 类型（镜像 Claude Code / codex-rs/hooks 的线格式，精简为 TS）。
 *
 * hook = 用户在 agent 循环固定生命周期点挂的确定性回调（host-only shell 命令）：
 * 不改模型提示就能拦截 / 改写 / 注入上下文 / 记录。把「靠模型自觉」变成「由代码保证」。
 * host-only：云端/worker 因 hostExec:false + 不读 config.json 而天然 no-op（见 runner.ts 顶部闸）。
 *
 * 线格式刻意对齐 Claude Code（Codex/Hermes 也解析同一 `{"decision":"block"}` 形状），
 * 用户脚本因此可跨 Claude/Codex/Hermes/Tangu 复用。
 */
import type { AppProfile } from '../seams/appProfile.js';

/** 生命周期事件名（PascalCase，与 Claude Code / Codex 对齐）。 */
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'PreCompact'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop';

export const HOOK_EVENT_NAMES: HookEventName[] = [
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit',
  'SessionStart', 'PreCompact', 'Stop', 'SubagentStart', 'SubagentStop',
];

/** 单个 hook handler 配置。只实现 command 类型（prompt/agent 类型 Codex 自己也没实现）。 */
export interface HookHandlerConfig {
  type: 'command';
  command: string;
  /** Windows 覆盖命令（缺省用 command）。 */
  commandWindows?: string;
  /** 超时秒（默认 600，最小 1）。 */
  timeout?: number;
  /** 运行时状态条文案（面板/进度用）。 */
  statusMessage?: string;
}

/** 一组共享 matcher 的 handlers。 */
export interface MatcherGroup {
  matcher?: string;
  hooks: HookHandlerConfig[];
}

/** 每事件 → matcher 组列表。 */
export type HookEventsConfig = Partial<Record<HookEventName, MatcherGroup[]>>;

/** hook 来源（P1 仅 user；project/plugin/managed 见 P4）。决定 trust 默认与是否可禁用。 */
export type HookSource = 'user' | 'project' | 'plugin' | 'managed';

/** trust 状态：managed/plugin 恒 trusted；user hook 需内容 hash 匹配，否则 needs-review。 */
export type HookTrustStatus = 'trusted' | 'needs-review' | 'managed';

/** 发现出的、待判定的单个 hook（配置 + 来源 + 稳定 key + trust/enable）。 */
export interface DiscoveredHook {
  /** 稳定 key = `{source}:{event}:{contentHash前12}`（不抄 Codex 的位置后缀，它挂了 TODO 要改）。 */
  key: string;
  event: HookEventName;
  matcher?: string;
  handler: HookHandlerConfig;
  source: HookSource;
  contentHash: string;
  trust: HookTrustStatus;
  /** 用户开关（默认 on，除非显式禁用）。 */
  enabled: boolean;
  /** 真正会运行 = enabled && trust!=='needs-review'。 */
  active: boolean;
}

// ── wire 输入（喂给 hook 脚本 stdin 的 JSON）──────────────────────────────
export interface HookInput {
  hook_event_name?: HookEventName;
  session_id?: string;
  run_id?: string;
  cwd?: string;
  agent_slug?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;   // PostToolUse
  is_error?: boolean;    // PostToolUse
  prompt?: string;       // UserPromptSubmit
  source?: string;       // SessionStart: startup|resume|clear|compact；PreCompact: manual|auto
  agent_type?: string;   // Subagent*
  stop_reason?: string;  // Stop
}

// ── wire 输出（hook 脚本 stdout 的 JSON，camelCase，与 Claude Code 对齐）────
export interface HookSpecificOutput {
  permissionDecision?: 'allow' | 'deny';  // PreToolUse / PermissionRequest
  additionalContext?: string;             // 注入进对话
  updatedInput?: Record<string, any>;     // PreToolUse 改参
}
export interface HookOutput {
  decision?: 'block';
  reason?: string;
  continue?: boolean;      // false → 停止循环/压缩
  stopReason?: string;
  systemMessage?: string;  // transcript 可见警告
  suppressOutput?: boolean;
  hookSpecificOutput?: HookSpecificOutput;
}

export type HookRunStatus = 'completed' | 'blocked' | 'stopped' | 'failed';

/** 单个 hook 运行结果（含解析后的输出 + 诊断，供面板/遥测）。 */
export interface HookRunResult {
  key: string;
  event: HookEventName;
  status: HookRunStatus;
  durationMs: number;
  /** fail-open：解析失败/不支持字段的人类可读原因。 */
  failReason?: string;
  output?: HookOutput;
}

/** runHooks 折叠后的最终判定（供派发点消费；各点只取自己关心的字段）。 */
export interface HookVerdict {
  /** PreToolUse/PostToolUse/UserPromptSubmit/Stop/PermissionRequest：拦截。 */
  block?: boolean;
  blockReason?: string;
  /** PreToolUse：改写后的工具参数。 */
  updatedInput?: Record<string, any>;
  /** PermissionRequest：显式放行（跳过用户审批）。 */
  allow?: boolean;
  /** 注入进对话的上下文（顺序保留）。 */
  additionalContext: string[];
  /** continue:false → 停止循环/压缩。 */
  stop?: boolean;
  stopReason?: string;
  /** transcript 警告。 */
  systemMessages: string[];
  /** 逐 hook 诊断。 */
  runs: HookRunResult[];
}

/** runHooks 运行上下文（host-only 闸所需 + payload 富集）。 */
export interface HookRunContext {
  profile?: AppProfile;
  execMode?: 'sandbox' | 'host';
  cwd?: string;
  sessionId?: string;
  runId?: string;
  agentSlug?: string;
  signal?: AbortSignal;
}
