/**
 * Hook 执行引擎。
 *
 *   runHooks(event, input, ctx) —— 派发点唯一入口：
 *     1. host-only 闸：hostExec:false 或非 host execMode → 直接空判定（云端/worker no-op）
 *     2. loadHooksConfig + discover active hooks + matcher 选择
 *     3. 并发执行（JSON 喂 stdin，超时 kill），解析 stdout/退出码 → HookRunResult（fail-open）
 *     4. foldVerdict → HookVerdict
 *
 * 线格式对齐 Claude Code：stdout JSON `{decision,reason,hookSpecificOutput,continue,...}`，
 * 或退出码（0 ok / 2 block + stderr reason / 其它 fail）。不认识的输出 fail-open（标 failed，绝不静默改行为）。
 */
import { spawn } from 'node:child_process';
import { loadHooksConfig, discoverHooks } from './config.js';
import { matcherMatches } from './matcher.js';
import { foldVerdict } from './events.js';
import {
  type DiscoveredHook,
  type HookEventName,
  type HookInput,
  type HookOutput,
  type HookRunContext,
  type HookRunResult,
  type HookRunStatus,
  type HookVerdict,
} from './types.js';

const emptyVerdict = (): HookVerdict => ({ additionalContext: [], systemMessages: [], runs: [] });

/** Stop / UserPromptSubmit 恒运行（Codex：这两个事件忽略 matcher）。 */
function ignoresMatcher(event: HookEventName): boolean {
  return event === 'UserPromptSubmit' || event === 'Stop';
}

/** matcher 比对的目标：工具名 / source / agent_type。 */
function matchTarget(event: HookEventName, input: HookInput): string {
  if (event === 'SessionStart' || event === 'PreCompact') return input.source || '';
  if (event === 'SubagentStart' || event === 'SubagentStop') return input.agent_type || '';
  return input.tool_name || '';
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(
  handler: DiscoveredHook['handler'],
  input: string,
  timeoutMs: number,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const command = isWin && handler.commandWindows ? handler.commandWindows : handler.command;
    const args = isWin ? ['/C', command] : ['-lc', command];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const onAbort = (): void => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish(130);
    };
    const child = spawn(shell, args, { cwd, env: process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish(124);
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e?.message || e); finish(127); });
    child.on('close', (code) => finish(code == null ? 0 : code));
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch { /* stdin closed early */ }
  });
}

function looksJson(s: string): boolean {
  return s.trim().startsWith('{');
}

function statusFromOutput(o: HookOutput): HookRunStatus {
  if (o.decision === 'block' || o.hookSpecificOutput?.permissionDecision === 'deny') return 'blocked';
  if (o.continue === false) return 'stopped';
  return 'completed';
}

/** 解析退出码 + stdout → {status, output?, failReason?}。fail-open：不认识 → failed，不改行为。 */
export function parseHookOutput(
  event: HookEventName,
  code: number,
  stdout: string,
  stderr: string,
): { status: HookRunStatus; output?: HookOutput; failReason?: string } {
  if (code === 2) {
    return { status: 'blocked', output: { decision: 'block', reason: stderr.trim() || 'blocked (exit 2)' } };
  }
  if (code !== 0) {
    return { status: 'failed', failReason: stderr.trim() || `hook exited ${code}` };
  }
  const out = stdout.trim();
  if (!out) return { status: 'completed' };
  if (looksJson(out)) {
    try {
      const parsed = JSON.parse(out) as HookOutput;
      return { status: statusFromOutput(parsed), output: parsed };
    } catch (e: any) {
      return { status: 'failed', failReason: `invalid JSON stdout: ${e?.message || e}` };
    }
  }
  // 纯文本 stdout：仅上下文注入类事件当作 additionalContext（对齐 Codex）；其它事件忽略。
  if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'SubagentStart') {
    return { status: 'completed', output: { hookSpecificOutput: { additionalContext: out } } };
  }
  return { status: 'completed' };
}

/** 执行单个已发现的 hook → HookRunResult（不做 host-only 闸，那在 runHooks；便于单测）。 */
export async function executeHook(
  hook: DiscoveredHook,
  input: HookInput,
  ctx: HookRunContext,
): Promise<HookRunResult> {
  const started = Date.now();
  const timeoutMs = Math.max(1000, (hook.handler.timeout ?? 600) * 1000);
  const payload = JSON.stringify({ ...input, hook_event_name: hook.event });
  const sr = await runCommand(hook.handler, payload, timeoutMs, ctx.cwd, ctx.signal);
  const parsed = sr.timedOut
    ? { status: 'failed' as HookRunStatus, failReason: 'hook timed out' }
    : parseHookOutput(hook.event, sr.code, sr.stdout, sr.stderr);
  return {
    key: hook.key,
    event: hook.event,
    status: parsed.status,
    durationMs: Date.now() - started,
    failReason: parsed.failReason,
    output: parsed.output,
  };
}

/** 派发点唯一入口。host-only 闸在最顶（云端/worker 直接空判定，绝不读 config、绝不 spawn）。 */
export async function runHooks(event: HookEventName, input: HookInput, ctx: HookRunContext): Promise<HookVerdict> {
  if (!ctx.profile?.capabilities?.hostExec || ctx.execMode !== 'host') return emptyVerdict();

  let selected: DiscoveredHook[];
  try {
    const cfg = loadHooksConfig();
    const active = discoverHooks(cfg, event).filter((h) => h.active);
    if (!active.length) return emptyVerdict();
    const target = matchTarget(event, input);
    selected = ignoresMatcher(event) ? active : active.filter((h) => matcherMatches(h.matcher, target));
  } catch {
    return emptyVerdict();
  }
  if (!selected.length) return emptyVerdict();

  // 事件上报仅在真实 run（有 runId）时；懒加载 eventBus，避免 hooks 单测拉进 db/deps。
  let publish: ((runId: string, type: string, payload: any) => unknown) | null = null;
  if (ctx.runId) {
    try { ({ publish } = await import('../services/eventBus.js')); } catch { publish = null; }
  }

  const results: HookRunResult[] = [];
  await Promise.all(
    selected.map(async (h) => {
      if (publish && ctx.runId) {
        void publish(ctx.runId, 'hook_started', {
          key: h.key, event, matcher: h.matcher, statusMessage: h.handler.statusMessage,
        });
      }
      const res = await executeHook(h, input, ctx);
      results.push(res); // 完成序 push → foldVerdict 的 updatedInput「最后完成者赢」成立
      if (publish && ctx.runId) {
        void publish(ctx.runId, 'hook_completed', {
          key: h.key, event, status: res.status, failReason: res.failReason, durationMs: res.durationMs,
        });
      }
    }),
  );
  return foldVerdict(event, results);
}
