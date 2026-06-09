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
import { publish } from './eventBus.js';
import type { ToolCall } from '../core/types.js';

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';
export type ApprovalAction = 'approve' | 'approve_always' | 'reject';
export interface ApprovalDecision {
  action: ApprovalAction;
  /** 用户在审批时修改了参数（如改 bash 命令）：用这份覆盖原 call 的 arguments 执行。 */
  argsOverride?: Record<string, any>;
}

interface Pending {
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
  const writesFiles = name === 'write_file' || name === 'edit_file';
  const runsCommands = name === 'run_bash';
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

/** TUI 按键时调用：兑现某审批。返回 false 表示该 id 已不在等待（重复/过期）。 */
export function resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision);
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
export function clearSessionApprovals(sessionId: string): void {
  alwaysAllow.delete(sessionId);
}

/**
 * loop 工具执行前的审批闸门。返回归一化决定（approve / reject）。
 *   - execMode!=='host' → 立即 approve（**server/worker 零影响**）
 *   - 不需要审批 / 本会话已「总允许」 → 立即 approve
 *   - 否则 await 用户决定；approve_always 落「总允许」缓存后按 approve 返回
 */
export async function gateToolCall(
  runId: string,
  call: ToolCall,
  ctx: { sessionId: string; execMode?: string; approvalMode?: ApprovalMode },
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  if (ctx.execMode !== 'host') return { action: 'approve' };
  if (!toolNeedsApproval(call.function.name, ctx.approvalMode)) return { action: 'approve' };
  if (isAlwaysAllowed(ctx.sessionId, call.function.name)) return { action: 'approve' };
  const d = await requestApproval(runId, call, approvalPreview(call), signal);
  if (d.action === 'approve_always') {
    allowAlways(ctx.sessionId, call.function.name);
    return { action: 'approve', argsOverride: d.argsOverride };
  }
  return d;
}
