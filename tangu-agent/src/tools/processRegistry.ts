/**
 * 后台进程注册表(host 模式):run_bash background:true 启动的子进程按 session 登记,
 * list_processes / read_process_output / kill_process 据此管理。
 *   - 输出进 ring buffer(每进程 200KB 上限,超出丢头留尾)
 *   - 进程退出后保留记录与输出(可读尾巴),完成态记录 30 分钟后由 reaper 清理
 *   - dispose()(模块卸载/进程退出)SIGKILL 所有在跑子进程,防泄漏
 *   - writeStdin/waitForOutput:交互式驱动(write_process_input 工具用),给 stdin 喂输入 + yield 收集新输出
 */
import type { ChildProcess } from 'node:child_process';
import type { ToolContext } from './toolTypes.js';
import { spawnHostShell, hostSandboxEnabled, hostSandboxScopeKey, remoteShellSeatbeltApplies } from '../sandbox/hostSandbox.js';
import { RemoteShellProtectionError } from '../sandbox/remoteShellSeatbelt.js';
import { effectiveRemote } from '../services/remoteOrigin.js';
import { killProcessTree } from '../utils/boundedProcess.js';

/** P1 · K2:后台进程的来源(= 起它的 run 的分类,见 services/remoteActivity.ts runCategory)。急停按它杀:
 *  run 结束后仍在跑的进程(dev server 之类)靠这个标签命中;本机起、后被远端染色的 run 起的进程靠 runId 命中。 */
export type ProcessOrigin = 'remote' | 'channel' | 'unattended' | 'local';

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
  sandboxScope: string;
  lastDataAt: number; // 最近一次产出输出的时刻（write_process_input 的 yield 模型据此判「空闲」）
  /** P1 · K2:起它的 run(ToolContext.runId);没有 run 上下文 = undefined。 */
  runId?: string;
  /** P1 · K2:起它那一刻的来源标签(之后不变)。 */
  origin: ProcessOrigin;
  /** P1 · G5:起它时套了远程 shell 写保护(macOS,宿主沙箱关 + 远程污点)。没套的进程不收远程 run 的 stdin。 */
  remoteSeatbelt?: boolean;
}

/**
 * 起进程那一刻的来源:远程污点(起跑时的 input.remote 或中途染色)> 这条 run 自己的来源(ctx.runOrigin,与 runCategory 同口径)。
 * ⚠️ 不看 ctx.channelSession:那是会话级旗标,连着微信的会话里用户在桌面敲的 run 也为真 —— 按它标会让急停杀掉本机用户自己的
 * dev server(独立评审 P2)。没带 runOrigin 的 ctx(loop 之外的调用方)退回 muse / automationOrigin 判无人值守,其余本机。
 */
export function processOriginOf(ctx: ToolContext | undefined): ProcessOrigin {
  if (!ctx) return 'local';
  if (effectiveRemote(ctx)) return 'remote';
  if (ctx.runOrigin) return ctx.runOrigin;
  if (ctx.muse || ctx.automationOrigin) return 'unattended';
  return 'local';
}

const changeListeners = new Set<() => void>();
/** P1 · K2:进程起落(活动登记表据此刷新快照)。返回退订。 */
export function onProcessChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}
function emitChange(): void {
  for (const cb of [...changeListeners]) {
    try { cb(); } catch { /* 订阅者的错误不影响注册表 */ }
  }
}

const procs = new Map<string, BackgroundProcess>(); // id -> proc
/** Include local processes too: all origins are interrupted when this engine shuts down. */
export const runningProcessCount = (): number => [...procs.values()].filter((p) => p.status === 'running').length;
let seq = 0;
let reaper: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;

/**
 * 杀「整个进程组」:detached 子进程自成进程组(pgid=child.pid),负 pid 杀组连带它 fork 的孙进程
 * (dev server / watch 等)。Windows 通过 taskkill /T /F 杀整棵树,否则孙进程残留占着端口/管道。
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGKILL'): void {
  void killProcessTree(child, 5000, sig);
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

export function startBackgroundProcess(sessionId: string, command: string, cwd: string, ctx?: ToolContext): BackgroundProcess | string {
  if (ctx?.signal?.aborted) return 'Error: background process start aborted';
  const running = [...procs.values()].filter((p) => p.sessionId === sessionId && p.status === 'running');
  if (running.length >= MAX_PER_SESSION) {
    return `Error: 本会话已有 ${running.length} 个后台进程在跑(上限 ${MAX_PER_SESSION});先 kill_process 清理。`;
  }
  const id = `bg_${Date.now().toString(36)}_${++seq}`;
  let child: ChildProcess;
  let remoteSeatbelt = false;
  try {
    remoteSeatbelt = remoteShellSeatbeltApplies(ctx);
    child = spawnHostShell(ctx || { cwd }, command);
  } catch (e: any) {
    if (e instanceof RemoteShellProtectionError) return `Error: ${e.message}`;
    return `Error: spawn failed: ${e?.message || e}`;
  }
  const p: BackgroundProcess = {
    id, sessionId, command, pid: child.pid ?? null,
    status: 'running', exitCode: null,
    startedAt: Date.now(), endedAt: null,
    output: '', truncated: false, child, lastDataAt: Date.now(),
    sandboxScope: hostSandboxScopeKey(ctx || { cwd }),
    ...(ctx?.runId ? { runId: ctx.runId } : {}),
    origin: processOriginOf(ctx),
    ...(remoteSeatbelt ? { remoteSeatbelt } : {}),
  };
  child.stdout?.on('data', (d) => append(p, d.toString()));
  child.stderr?.on('data', (d) => append(p, d.toString()));
  // 进程关了 stdin / 写入时恰好退出 → 异步 EPIPE(writeStdin 的 try/catch 接不住,无监听即未捕获异常)。
  // 流报错后 writable=false,下次 writeStdin 照常返回「不可写」,这里无需另报。
  child.stdin?.on('error', () => { /* ignore */ });
  child.on('error', (e: any) => {
    append(p, `\n[error] ${e?.message || e}`);
    p.status = 'error';
    p.endedAt = Date.now();
    p.child = null;
    emitChange();
  });
  child.on('close', (code) => {
    if (p.status === 'running') p.status = code === null ? 'killed' : 'exited';
    p.exitCode = code;
    p.endedAt = Date.now();
    p.child = null;
    emitChange();
  });
  procs.set(id, p);
  ensureReaper();
  emitChange();
  return p;
}

export function listProcesses(sessionId: string): BackgroundProcess[] {
  return [...procs.values()].filter((p) => p.sessionId === sessionId);
}

export function getProcess(sessionId: string, id: string): BackgroundProcess | null {
  const p = procs.get(id);
  return p && p.sessionId === sessionId ? p : null;
}

/** SIGTERM 整组 → 3s 后 SIGKILL(不等它退出;close 事件照常收尾)。 */
function terminate(p: BackgroundProcess): void {
  if (!p.child) return;
  p.status = 'killed';
  p.endedAt = Date.now();
  try {
    killTree(p.child, 'SIGTERM');
    const child = p.child;
    if (process.platform !== 'win32') setTimeout(() => killTree(child), 3000).unref?.();
  } catch {
    /* 已退出 */
  }
}

export function killProcess(sessionId: string, id: string): string {
  const p = getProcess(sessionId, id);
  if (!p) return `Error: 进程 ${id} 不存在`;
  if (p.status !== 'running' || !p.child) return `进程 ${id} 已结束(status=${p.status})`;
  terminate(p);
  emitChange();
  return `killed ${id} (pid ${p.pid})`;
}

/** P1 · K2 急停:杀掉所有**在跑**且命中谓词的后台进程(整组 SIGTERM → 3s → SIGKILL)。返回杀了几个。 */
export function killProcessesWhere(pred: (p: BackgroundProcess) => boolean): number {
  let n = 0;
  for (const p of procs.values()) {
    if (p.status !== 'running' || !p.child) continue;
    let hit = false;
    try { hit = pred(p); } catch { hit = false; }
    if (!hit) continue;
    terminate(p);
    n++;
  }
  if (n) emitChange();
  return n;
}

/** P1 · K2 活动快照:只列**在跑**且不是本机来源的进程(命令截 80)。 */
export function listTaggedProcesses(): Array<{ id: string; sessionId: string; runId?: string; origin: Exclude<ProcessOrigin, 'local'>; pid: number | null; command: string; startedAt: number }> {
  const out: Array<{ id: string; sessionId: string; runId?: string; origin: Exclude<ProcessOrigin, 'local'>; pid: number | null; command: string; startedAt: number }> = [];
  for (const p of procs.values()) {
    if (p.status !== 'running' || p.origin === 'local') continue;
    out.push({ id: p.id, sessionId: p.sessionId, ...(p.runId ? { runId: p.runId } : {}), origin: p.origin, pid: p.pid, command: p.command.slice(0, 80), startedAt: p.startedAt });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const CTRL_C = '\x03'; // ETX (Ctrl-C):管道无真 TTY,转成 SIGINT 发给进程

/**
 * 向某后台进程的 stdin 写入(交互式驱动 REPL/问答 CLI)。
 *   - 进程已结束 / stdin 不可写 → 返回错误串
 *   - 输入恰为单个 \x03(Ctrl-C)→ 发 SIGINT(管道无 TTY,无法靠字节传中断)
 *   - 否则写入,appendNewline 时补 \n(多数行式程序需要换行才处理一行)
 */
export function writeStdin(sessionId: string, id: string, data: string, appendNewline: boolean, ctx?: ToolContext): string {
  const p = getProcess(sessionId, id);
  if (!p) return `Error: 进程 ${id} 不存在`;
  if (p.status !== 'running' || !p.child) return `Error: 进程 ${id} 已结束(status=${p.status}),无法写入`;
  if (ctx && hostSandboxEnabled(ctx) && p.sandboxScope !== hostSandboxScopeKey(ctx)) {
    return 'Error: this process was started with a different host sandbox policy or workspace; start a new process before sending input';
  }
  // P1 · G5:本机 run 起的 shell / REPL 没套远程写保护 —— 远程污点 run(含中途被 steer 染上的)往它的 stdin 写命令 = 绕过写保护。
  // Ctrl-C 只是中断,照旧放行。
  if (data !== CTRL_C && remoteShellSeatbeltApplies(ctx) && !p.remoteSeatbelt) {
    return `Error: process ${id} was started outside the remote-session write protection on this computer, so a remote session cannot send it input. Start a new process from this session with run_background instead.`;
  }
  if (data === CTRL_C) {
    const child = p.child;
    try { killTree(child, 'SIGINT'); } catch { /* 已退出 */ }
    // ⚠️ 信号会打空:此刻 shell 多半还没 exec 成目标命令,SIGINT 丢在 fork/exec 之间,进程一直活着
    // (Linux 实测零延迟发信号:空载 8 轮丢 2;4 路 CPU 负载下 20 轮丢 4 —— 活下来的是 `sh` 本身,
    //  信号掩码全空,不是被忽略。CI 上表现为 Ctrl-C 用例卡满 capMs 报 status=running)。
    // 补发一次即可,那时 exec 必已完成(同负载下 20/20 全终止)。计时器 unref,不吊住进程退出。
    const again = setTimeout(() => {
      if (p.status === 'running' && p.child) { try { killTree(p.child, 'SIGINT'); } catch { /* 已退出 */ } }
    }, 150);
    again.unref?.();
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
