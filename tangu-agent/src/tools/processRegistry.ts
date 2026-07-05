/**
 * 后台进程注册表(host 模式):run_bash background:true 启动的子进程按 session 登记,
 * list_processes / read_process_output / kill_process 据此管理。
 *   - 输出进 ring buffer(每进程 200KB 上限,超出丢头留尾)
 *   - 进程退出后保留记录与输出(可读尾巴),完成态记录 30 分钟后由 reaper 清理
 *   - dispose()(模块卸载/进程退出)SIGKILL 所有在跑子进程,防泄漏
 *   - writeStdin/waitForOutput:交互式驱动(write_process_input 工具用),给 stdin 喂输入 + yield 收集新输出
 */
import { spawn, type ChildProcess } from 'node:child_process';

const OUTPUT_CAP = 200_000;
const FINISHED_TTL_MS = 30 * 60 * 1000;
const MAX_PER_SESSION = 10;

export interface BackgroundProcess {
  id: string;
  sessionId: string;
  command: string;
  pid: number | null;
  status: 'running' | 'exited' | 'killed' | 'error';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  output: string; // stdout+stderr 合流 ring buffer
  truncated: boolean;
  child: ChildProcess | null;
  lastDataAt: number; // 最近一次产出输出的时刻（write_process_input 的 yield 模型据此判「空闲」）
}

const procs = new Map<string, BackgroundProcess>(); // id -> proc
let seq = 0;
let reaper: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;

/**
 * 杀「整个进程组」:detached 子进程自成进程组(pgid=child.pid),负 pid 杀组连带它 fork 的孙进程
 * (dev server / watch 等)。否则只杀 shell、孙进程残留占着端口/管道。非 POSIX 或无 pid 退回杀 child。
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  try {
    if (pid && process.platform !== 'win32') process.kill(-pid, sig);
    else child.kill(sig);
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of procs) {
      if (p.status !== 'running' && p.endedAt && now - p.endedAt > FINISHED_TTL_MS) procs.delete(id);
    }
    if (!procs.size && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 60_000);
  reaper.unref?.();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const p of procs.values()) if (p.child && p.status === 'running') killTree(p.child);
    });
  }
}

function append(p: BackgroundProcess, chunk: string): void {
  p.output += chunk;
  p.lastDataAt = Date.now();
  if (p.output.length > OUTPUT_CAP) {
    p.output = p.output.slice(p.output.length - OUTPUT_CAP);
    p.truncated = true;
  }
}

export function startBackgroundProcess(sessionId: string, command: string, cwd: string): BackgroundProcess | string {
  const running = [...procs.values()].filter((p) => p.sessionId === sessionId && p.status === 'running');
  if (running.length >= MAX_PER_SESSION) {
    return `Error: 本会话已有 ${running.length} 个后台进程在跑(上限 ${MAX_PER_SESSION});先 kill_process 清理。`;
  }
  const id = `bg_${Date.now().toString(36)}_${++seq}`;
  let child: ChildProcess;
  try {
    child = spawn(command, { cwd, shell: true, detached: true });
  } catch (e: any) {
    return `Error: spawn failed: ${e?.message || e}`;
  }
  const p: BackgroundProcess = {
    id, sessionId, command, pid: child.pid ?? null,
    status: 'running', exitCode: null,
    startedAt: Date.now(), endedAt: null,
    output: '', truncated: false, child, lastDataAt: Date.now(),
  };
  child.stdout?.on('data', (d) => append(p, d.toString()));
  child.stderr?.on('data', (d) => append(p, d.toString()));
  child.on('error', (e: any) => {
    append(p, `\n[error] ${e?.message || e}`);
    p.status = 'error';
    p.endedAt = Date.now();
    p.child = null;
  });
  child.on('close', (code) => {
    if (p.status === 'running') p.status = code === null ? 'killed' : 'exited';
    p.exitCode = code;
    p.endedAt = Date.now();
    p.child = null;
  });
  procs.set(id, p);
  ensureReaper();
  return p;
}

export function listProcesses(sessionId: string): BackgroundProcess[] {
  return [...procs.values()].filter((p) => p.sessionId === sessionId);
}

export function getProcess(sessionId: string, id: string): BackgroundProcess | null {
  const p = procs.get(id);
  return p && p.sessionId === sessionId ? p : null;
}

export function killProcess(sessionId: string, id: string): string {
  const p = getProcess(sessionId, id);
  if (!p) return `Error: 进程 ${id} 不存在`;
  if (p.status !== 'running' || !p.child) return `进程 ${id} 已结束(status=${p.status})`;
  p.status = 'killed';
  p.endedAt = Date.now();
  try {
    killTree(p.child, 'SIGTERM');
    const child = p.child;
    setTimeout(() => killTree(child), 3000).unref?.();
  } catch {
    /* 已退出 */
  }
  return `killed ${id} (pid ${p.pid})`;
}

const CTRL_C = '\x03'; // ETX (Ctrl-C):管道无真 TTY,转成 SIGINT 发给进程

/**
 * 向某后台进程的 stdin 写入(交互式驱动 REPL/问答 CLI)。
 *   - 进程已结束 / stdin 不可写 → 返回错误串
 *   - 输入恰为单个 \x03(Ctrl-C)→ 发 SIGINT(管道无 TTY,无法靠字节传中断)
 *   - 否则写入,appendNewline 时补 \n(多数行式程序需要换行才处理一行)
 */
export function writeStdin(sessionId: string, id: string, data: string, appendNewline: boolean): string {
  const p = getProcess(sessionId, id);
  if (!p) return `Error: 进程 ${id} 不存在`;
  if (p.status !== 'running' || !p.child) return `Error: 进程 ${id} 已结束(status=${p.status}),无法写入`;
  if (data === CTRL_C) {
    try { killTree(p.child, 'SIGINT'); } catch { /* 已退出 */ }
    return `sent SIGINT to ${id}`;
  }
  const stdin = p.child.stdin;
  if (!stdin || !stdin.writable) return `Error: 进程 ${id} 的 stdin 不可写(可能未读取输入或已关闭)`;
  try {
    stdin.write(appendNewline ? data + '\n' : data);
  } catch (e: any) {
    return `Error: 写入失败:${e?.message || e}`;
  }
  return `wrote ${data.length} char(s) to ${id}`;
}

/**
 * 写入 stdin 后收集新增输出的 yield 模型(对齐 Codex unified_exec,不做 prompt 检测):
 * 满足任一即返回——① 进程产出了新输出且随后空闲 idleMs；② 总耗时超 capMs；③ 进程结束；④ signal 中止。
 * 不阻塞到天荒地老:链式 setTimeout 轮询(每 ~50ms),全部计时器 unref 不吊住进程退出。
 */
export function waitForOutput(
  p: BackgroundProcess,
  fromLen: number,
  opts: { idleMs?: number; capMs?: number; signal?: AbortSignal },
): Promise<{ output: string; status: BackgroundProcess['status'] }> {
  const idleMs = opts.idleMs ?? 400;
  const capMs = opts.capMs ?? 8000;
  const start = Date.now();
  const STEP = 50;
  return new Promise((resolve) => {
    const done = (): void => resolve({ output: p.output.slice(fromLen), status: p.status });
    const tick = (): void => {
      const grew = p.output.length > fromLen;
      const idleEnough = Date.now() - p.lastDataAt >= idleMs;
      if (opts.signal?.aborted) return done();
      if (p.status !== 'running') return done();
      if (Date.now() - start >= capMs) return done();
      if (grew && idleEnough) return done(); // 有新输出且静默够久 → 这一轮交互产出已稳定
      setTimeout(tick, STEP).unref?.();
    };
    setTimeout(tick, STEP).unref?.();
  });
}

/** 模块卸载/dispose:杀掉所有在跑子进程 + 停 reaper。 */
export function disposeAllProcesses(): void {
  for (const p of procs.values()) {
    if (p.child && p.status === 'running') {
      p.status = 'killed';
      p.endedAt = Date.now();
      try { killTree(p.child); } catch { /* ignore */ }
    }
  }
  procs.clear();
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
