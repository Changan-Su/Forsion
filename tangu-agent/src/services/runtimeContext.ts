/**
 * 每-run 运行时现场注入(Codex/PI 双师承):模型开工前先「看见现场」——会话 todo 清单 + git 状态,
 * 而不是靠翻聊天记录猜进度。拼进尾部 user 消息(与 /skill 指令同通道,不动 system 前缀字节,
 * 前缀缓存只失效最短尾巴),不落库不上屏,纯 harness 脚手架。
 */
import { execFile, spawn } from 'node:child_process';
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

/** 验证回路的执行器(/verify 配的会话命令,收尾闸门用):shell 跑一遍,回 exit code + 输出尾巴。
 *  用户自己配的命令(与 hooks 同级信任),不过审批闸;超时(2min)按失败算。
 *  signal:用户打断 run 时随之杀掉验证命令,否则 abort 后命令还能跑满 2 分钟且 run 假 done(Codex 评审 #6)。
 *  ponytail: signal/timeout 只杀 shell 本体,孙进程可能存活;要杀进程树等真实需求出现再上 pgid。 */
export function runVerifyCommand(command: string, cwd?: string, signal?: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: cwd || process.cwd(), timeout: VERIFY_TIMEOUT_MS, env: process.env, signal });
    let buf = '';
    const keep = (d: Buffer) => { buf = (buf + d.toString()).slice(-VERIFY_TAIL_CHARS * 2); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e: any) => resolve({ ok: false, code: null, tail: String(e?.message || e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, tail: buf.slice(-VERIFY_TAIL_CHARS) }));
  });
}

const GIT_TIMEOUT_MS = 800;
const GIT_STATUS_MAX_LINES = 20; // ponytail: 大仓 status 截断到 20 行 + 计数,模型要全量自己跑 git status

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/** git 现场段(host 会话专用):分支 + 脏文件摘要 + 最近提交。非 git 仓 / 无 git / 超时 → null 静默跳过。 */
export async function collectGitState(cwd?: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const [status, log] = await Promise.all([
      git(cwd, ['status', '--porcelain']).catch(() => ''),
      git(cwd, ['log', '--oneline', '-3']).catch(() => ''),
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
