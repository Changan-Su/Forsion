/**
 * 每-run 运行时现场注入(Codex/PI 双师承):模型开工前先「看见现场」——会话 todo 清单 + git 状态,
 * 而不是靠翻聊天记录猜进度。拼进尾部 user 消息(与 /skill 指令同通道,不动 system 前缀字节,
 * 前缀缓存只失效最短尾巴),不落库不上屏,纯 harness 脚手架。
 */
import { existsSync } from 'node:fs';
import { prepareHostCommand } from '../sandbox/hostSandbox.js';
import { runBoundedProcess } from '../utils/boundedProcess.js';
import type { ToolContext } from '../tools/toolTypes.js';
export type RuntimeExecContext = Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox' | 'execMode' | 'signal'>;
import { renderTodos, type TodoItem } from '../tools/builtin/todo.js';

/** todo 现场段:有未完项才注入(全完成/空单=null,别拿旧清单占 token)。 */
export function renderTodoState(todos: TodoItem[]): string | null {
  if (!todos.length || !todos.some((t) => t.status !== 'completed')) return null;
  return (
    '[Session todo list — current state]\n' +
    renderTodos(todos) +
    '\nUnfinished items are outstanding work in this session (todo_read/todo_write to inspect/update).'
  );
}

/** 汇总各段成 <runtime_context> 块;全空=null(不注入)。 */
export function formatRuntimeContext(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => !!p);
  if (!kept.length) return null;
  return (
    '<runtime_context>\n' +
    'Ambient state injected by the harness at the start of this run (NOT written by the user). Use it for grounding; verify with tools before acting on it.\n\n' +
    kept.join('\n\n') +
    '\n</runtime_context>'
  );
}

const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_TAIL_CHARS = 2000;
export interface VerifyResult { ok: boolean; code: number | null; tail: string }

/** A configured verification command remains subject to the run's frozen OS policy.
 * Cancellation covers its process tree; failed sandbox setup/cleanup is never reported as verified. */
export async function runVerifyCommand(command: string, cwd?: string, signal?: AbortSignal, ctx?: RuntimeExecContext): Promise<VerifyResult> {
  if (signal?.aborted) return { ok: false, code: null, tail: 'Verification aborted' };
  let prepared: ReturnType<typeof prepareHostCommand> | undefined;
  try {
    const argv = process.platform === 'win32'
      ? [process.env.COMSPEC || 'cmd.exe', '/d', '/s', '/c', command]
      : ['/bin/sh', '-c', command];
    prepared = prepareHostCommand({ ...ctx, cwd: cwd || ctx?.cwd }, argv);
    const result = await runBoundedProcess(prepared.file, prepared.args, {
      cwd: String(prepared.options.cwd), env: prepared.options.env,
      signal: signal || ctx?.signal, timeoutMs: VERIFY_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
    });
    const reason = [result.reason, result.cleanupTimedOut ? 'process cleanup was not acknowledged' : '', result.error?.message].filter(Boolean).join('; ');
    return {
      ok: result.code === 0 && !result.reason && !result.cleanupTimedOut,
      code: result.code,
      tail: `${(result.stdout + result.stderr).slice(-VERIFY_TAIL_CHARS)}${reason ? `\nVerification failed: ${reason}` : ''}`.trim(),
    };
  } catch (error) {
    return { ok: false, code: null, tail: `Verification blocked: ${String((error as Error)?.message || error)}` };
  } finally { prepared?.cleanup(); }
}

const GIT_TIMEOUT_MS = 800;
const GIT_STATUS_MAX_LINES = 20; // ponytail: 大仓 status 截断到 20 行 + 计数,模型要全量自己跑 git status

async function git(cwd: string, args: string[], ctx?: RuntimeExecContext): Promise<string> {
  // Apple's /usr/bin/git shim can start xcodebuild for each private sandbox cache.
  // These fixed native developer-tool locations avoid an unsandboxed xcrun probe.
  const executable = process.platform === 'darwin'
    ? ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'].find(existsSync) || 'git'
    : 'git';
  const prepared = prepareHostCommand({ ...ctx, cwd }, [
    executable, '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=', '-C', cwd, ...args,
  ]);
  try {
    const result = await runBoundedProcess(prepared.file, prepared.args, {
      cwd: String(prepared.options.cwd), env: prepared.options.env,
      signal: ctx?.signal, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 256 * 1024,
    });
    if (result.code !== 0 || result.reason || result.cleanupTimedOut) throw new Error('Git state collection did not complete');
    return result.stdout.trim();
  } finally { prepared.cleanup(); }
}

/** git 现场段(host 会话专用):分支 + 脏文件摘要 + 最近提交。非 git 仓 / 无 git / 超时 → null 静默跳过。 */
export async function collectGitState(cwd?: string, ctx?: RuntimeExecContext): Promise<string | null> {
  if (!cwd) return null;
  try {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx);
    const [status, log] = await Promise.all([
      git(cwd, ['status', '--porcelain'], ctx),
      git(cwd, ['log', '--oneline', '-3'], ctx).catch(() => ''),
    ]);
    const statusLines = status ? status.split('\n').filter(Boolean) : [];
    const shown = statusLines.slice(0, GIT_STATUS_MAX_LINES).join('\n');
    const more = statusLines.length > GIT_STATUS_MAX_LINES ? `\n… and ${statusLines.length - GIT_STATUS_MAX_LINES} more` : '';
    return (
      '[Git state]\n' +
      `branch: ${branch}\n` +
      (statusLines.length ? `dirty files (${statusLines.length}):\n${shown}${more}` : 'working tree clean') +
      (log ? `\nrecent commits:\n${log}` : '')
    );
  } catch {
    return null;
  }
}
