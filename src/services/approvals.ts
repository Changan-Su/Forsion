/**
 * 进程内工具审批登记表（host-exec 模式 / TUI 专用）。
 *
 * 事件总线是单向的（run publish → 订阅者）。审批需要「订阅者把决定送回正在等待的 run」。
 * 因为 TUI 在**同一进程**里跑 loop（无 HTTP，同 cli），用一张进程内登记表即可：
 *   loop 调 requestApproval → 发 `approval_request` 事件 + 登记 resolver，await Promise；
 *   TUI 收到事件、用户按键 → resolveApproval(approvalId, decision)，Promise 兑现，loop 继续。
 *
 * **安全边界**：gateToolCall 在 execMode!=='host' 时立即放行（无 await、无事件），
 * 故 microserver / standalone-server / worker 行为零变化——审批只在 host-exec（TUI）激活。
 *
 * 远程 host-exec（跨进程）需要的是 HTTP「租赁」端点（见架构 v2.0 §3.3 Lease），不在此文件范围。
 */
import path from 'node:path';
import { publish } from './eventBus.js';
import { isOutsideWorkspace } from '../tools/fsPolicy.js';
import type { ToolCall } from '../core/types.js';
import { runHooks } from '../hooks/index.js';
import { currentAgentSlug } from '../seams/runContext.js';
import type { AppProfile } from '../seams/appProfile.js';

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';
export type ApprovalAction = 'approve' | 'approve_always' | 'reject';
export interface ApprovalDecision {
  action: ApprovalAction;
  /** 用户在审批时修改了参数（如改 bash 命令）：用这份覆盖原 call 的 arguments 执行。 */
  argsOverride?: Record<string, any>;
}

interface Pending {
  runId: string;
  resolve: (d: ApprovalDecision) => void;
}

const pending = new Map<string, Pending>(); // approvalId -> resolver
const alwaysAllow = new Map<string, Set<string>>(); // sessionId -> 本会话「总允许」的工具名

let approvalSeq = 0;
function nextApprovalId(): string {
  return `apv_${Date.now().toString(36)}_${++approvalSeq}`;
}

/**
 * 破坏性工具在某审批档下是否需要批准。
 *   readonly  : 写文件 + 跑命令都要批
 *   auto-edit : 写文件放行，跑命令要批（codex「auto edit」语义）
 *   full-auto : 全放行
 * 只读工具（read_file/list_dir/web_search/...）永不在此返回 true。
 */
export function toolNeedsApproval(name: string, mode: ApprovalMode | undefined): boolean {
  if (!mode || mode === 'full-auto') return false;
  const writesFiles = name === 'write_file' || name === 'edit_file' || name === 'multi_edit' || name === 'apply_patch';
  // 跑命令档(auto-edit 也要批):run_bash / kill_process / MCP 任意能力 / 后台起进程 / 给进程喂 stdin。
  // run_background + write_process_input = 启动任意 shell 进程并向其喂输入,危险性同 run_bash,纳入此档。
  // browser_task = 自主 agent 以用户身份操作已登录网站(点按/提交),危险性同档。
  const runsCommands =
    name === 'run_bash' || name === 'kill_process' || name === 'run_background' ||
    name === 'write_process_input' || name === 'browser_task' || name.startsWith('mcp__');
  if (mode === 'readonly') return writesFiles || runsCommands;
  if (mode === 'auto-edit') return runsCommands;
  return false;
}

/** 给审批弹窗用的人类可读预览（从 tool 参数里抽要害）。 */
export function approvalPreview(call: ToolCall): string {
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    /* ignore */
  }
  const name = call.function.name;
  if (name === 'run_bash') return `$ ${String(args.command ?? '').trim()}`;
  if (name === 'write_file') return `write ${args.path} (${String(args.content ?? '').length} chars)`;
  if (name === 'edit_file') return `edit ${args.path}`;
  if (name === 'multi_edit') return `multi_edit ${args.path} (${Array.isArray(args.edits) ? args.edits.length : '?'} edits)`;
  if (name === 'run_background') return `bg$ ${String(args.command ?? '').trim()}`;
  if (name === 'write_process_input') {
    const inp = String(args.input ?? '');
    return `→ proc ${args.process_id}: ${inp.length > 80 ? inp.slice(0, 80) + '…' : inp || '(poll)'}`;
  }
  if (name === 'apply_patch') {
    const n = (String(args.patch ?? args.input ?? '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm) || []).length;
    return `apply_patch (${n} file change(s))`;
  }
  if (name === 'kill_process') return `kill process ${args.process_id ?? ''}`;
  if (name === 'browser_task') {
    const t = String(args.task ?? '').trim();
    const domains = Array.isArray(args.allowed_domains) && args.allowed_domains.length ? ` [${args.allowed_domains.join(', ')}]` : '';
    return `browser_task${domains}: ${t.length > 160 ? `${t.slice(0, 160)}…` : t}`;
  }
  return `${name} ${JSON.stringify(args).slice(0, 200)}`;
}

/** 登记一次审批请求：发事件 + await 决定。中止信号触发时按拒绝兑现（loop 随后会抛 AbortError）。 */
export function requestApproval(
  runId: string,
  call: ToolCall,
  preview: string,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  if (signal?.aborted) return Promise.resolve({ action: 'reject' });
  const approvalId = nextApprovalId();
  return new Promise<ApprovalDecision>((resolve) => {
    const onAbort = (): void => {
      pending.delete(approvalId);
      resolve({ action: 'reject' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending.set(approvalId, {
      runId,
      resolve: (d) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(d);
      },
    });
    void publish(runId, 'approval_request', {
      approvalId,
      name: call.function.name,
      arguments: call.function.arguments,
      preview,
    });
  });
}

/** TUI 按键 / HTTP 审批端点调用：兑现某审批。返回 false 表示该 id 已不在等待（重复/过期）。 */
export function resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision);
  // 广播审批结果:SSE 回放/多端订阅者据此知道该审批已被消化(TUI 忽略未知事件类型,零影响)。
  void publish(p.runId, 'approval_result', { approvalId, action: decision.action });
  return true;
}

export function isAlwaysAllowed(sessionId: string, toolName: string): boolean {
  return alwaysAllow.get(sessionId)?.has(toolName) ?? false;
}
export function allowAlways(sessionId: string, toolName: string): void {
  let s = alwaysAllow.get(sessionId);
  if (!s) {
    s = new Set();
    alwaysAllow.set(sessionId, s);
  }
  s.add(toolName);
}
// ── known-safe bash 白名单(借 Codex 的 prefix-rule 思路):只读单命令免审批,纯 UX。──
const SAFE_BASH_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'stat', 'file', 'which', 'date', 'whoami',
  'env', 'printenv', 'grep', 'rg', 'find', 'tree', 'du', 'df', 'basename', 'dirname', 'realpath',
  'readlink', 'uname', 'hostname',
]);
const SAFE_GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'describe']);
// shell 元字符:链式/管道/重定向/子命令/转义 → 一律视为不安全(防 `ls; rm -rf /` 之类绕过)。
const SHELL_META = /[;&|<>$`(){}\n\\]/;

/** 命令是否「已知只读、单条简单调用」→ 可免审批。任何元字符即判不安全。 */
export function isKnownSafeBash(command: string): boolean {
  const cmd = String(command || '').trim();
  if (!cmd || SHELL_META.test(cmd)) return false;
  const parts = cmd.split(/\s+/);
  if (parts[0] === 'git') return SAFE_GIT_SUB.has(parts[1] || '');
  return SAFE_BASH_PROGRAMS.has(parts[0]);
}

// 补丁路径抽取(escalation 用,不必整体解析补丁):匹配 File: / Move to: 行。
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** host 写工具的目标路径(write/edit/multi_edit 取 args.path;apply_patch 从补丁文本抽)。 */
function writeTargetsOf(call: ToolCall): string[] {
  const name = call.function.name;
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return [];
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'multi_edit') {
    return args.path ? [String(args.path)] : [];
  }
  if (name === 'apply_patch') {
    const patch = String(args.patch ?? args.input ?? '');
    const out: string[] = [];
    PATCH_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATCH_PATH_RE.exec(patch))) out.push((m[1] || m[2] || '').trim());
    return out;
  }
  return [];
}

/** 写目标是否越界(工作区外,但非硬拒保护路径)→ 需升级审批。借 Codex writable-roots escalation。 */
export function writeEscalationNeeded(call: ToolCall, ctx: { cwd?: string }): boolean {
  const targets = writeTargetsOf(call);
  if (!targets.length) return false;
  const cwd = ctx.cwd || process.cwd();
  const fakeCtx = { cwd } as any;
  return targets.some((t) => isOutsideWorkspace(fakeCtx, path.isAbsolute(t) ? t : path.resolve(cwd, t)));
}

function bashCommandOf(call: ToolCall): string {
  try {
    return String((call.function.arguments ? JSON.parse(call.function.arguments) : {}).command || '');
  } catch {
    return '';
  }
}

/** 安全解析工具参数（供 PermissionRequest hook payload）。坏 JSON → 空对象。 */
function parseCallArgs(call: ToolCall): any {
  try {
    return call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return {};
  }
}

/**
 * loop 工具执行前的审批闸门。返回归一化决定（approve / reject）。
 *   - execMode!=='host' 且非 mcp__ → 立即 approve（**server/worker 零影响**）
 *   - run_bash 且 known-safe(只读单命令) → 立即 approve（纯 UX,即便 readonly）
 *   - 越界写(工作区外,非保护路径)→ 强制升级审批（auto-edit 也要批;full-auto 放行;不吃「总允许」）
 *   - 否则按档:不需审批 / 已「总允许」→ approve;否则 await 用户决定
 */
export async function gateToolCall(
  runId: string,
  call: ToolCall,
  ctx: { sessionId: string; execMode?: string; approvalMode?: ApprovalMode; cwd?: string; profile?: AppProfile },
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const name = call.function.name;
  // host 模式全部过闸;非 host 仅 MCP 工具过闸(本地形态的 sandbox 会话也可能挂 MCP)。
  if (ctx.execMode !== 'host' && !name.startsWith('mcp__')) return { action: 'approve' };

  // known-safe 只读 bash:免审批。
  if (name === 'run_bash' && isKnownSafeBash(bashCommandOf(call))) return { action: 'approve' };

  // 越界写升级:工作区外写一律要批(full-auto 例外:用户已全信任)。
  const escalate =
    ctx.execMode === 'host' && ctx.approvalMode !== 'full-auto' && writeEscalationNeeded(call, ctx);

  if (!escalate) {
    if (!toolNeedsApproval(name, ctx.approvalMode)) return { action: 'approve' };
    if (isAlwaysAllowed(ctx.sessionId, name)) return { action: 'approve' };
  }

  // —— PermissionRequest hook：在弹审批 UI 前问 hook（host-only）。deny → 拒绝；allow → 跳过用户审批直接放行。——
  const permV = await runHooks('PermissionRequest', {
    tool_name: name,
    tool_input: parseCallArgs(call),
    session_id: ctx.sessionId, run_id: runId, cwd: ctx.cwd, agent_slug: currentAgentSlug(),
  }, {
    profile: ctx.profile,
    execMode: ctx.execMode === 'host' ? 'host' : 'sandbox',
    cwd: ctx.cwd, sessionId: ctx.sessionId, runId, signal,
  });
  if (permV.block) return { action: 'reject' };
  if (permV.allow) return { action: 'approve' };

  const preview = escalate ? '⚠ 工作区外写入 · ' + approvalPreview(call) : approvalPreview(call);
  const d = await requestApproval(runId, call, preview, signal);
  if (d.action === 'approve_always') {
    if (!escalate) allowAlways(ctx.sessionId, name); // 越界写不进「总允许」,每次都确认
    return { action: 'approve', argsOverride: d.argsOverride };
  }
  return d;
}
