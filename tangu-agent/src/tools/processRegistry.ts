/**
 * 后台进程注册表(host 模式):run_bash background:true 启动的子进程按 session 登记,
 * list_processes / read_process_output / kill_process 据此管理。
 *   - 输出进 ring buffer(每进程 200KB 上限,超出丢头留尾)
 *   - 进程退出后保留记录与输出(可读尾巴),完成态记录 30 分钟后由 reaper 清理
 *   - dispose()(模块卸载/进程退出)SIGKILL 所有在跑子进程,防泄漏
 *   - writeStdin/waitForOutput:交互式驱动(write_process_input 工具用),给 stdin 喂输入 + yield 收集新输出
 *   - adoptForegroundProcess:前台 run_bash 跑着时用户插话 → 把**同一个**子进程(不重起,沙箱包装与进程树原样)移交进来,
 *     带 handoff 标记;结局由 services/steerHandoff.ts 交回会话(借鉴 dsh-superagent 方案第 5 条 A,11-20)
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
  remoteSeatbelt?: boolean;  /** 输出里第一次出现的本机地址(dev server 之类),归一成 localhost;摘要栏「后台」卡据此把这一行当服务。 */
  url?: string;
  /** 引擎自己要停它(kill_process / 界面停止 / 急停 / 移交上限到点 / 引擎退出)。移交进来的进程据此区分「被停」和「自己跑完」。 */
  killRequested?: boolean;
  /** 移交进来的前台命令才有(adoptForegroundProcess)。 */
  handoff?: ForegroundHandoff;
  /** 输出打码(移交进来的 run_bash 带着 run 的 secret_env 跑;run 收尾后秘密表已清,这里留着移交那一刻的快照)。读输出一律经 processOutput()。 */
  redact?: (text: string) => string;
}

/** 前台 run_bash 因用户插话移交进后台(方案 A:只在插话时才移交,平时和原来一样)。 */
export interface ForegroundHandoff {
  /** 移交时那一轮。用户停掉这一轮(仍在跑时)→ 一并停它。 */
  runId: string;
  /** 那次 run_bash 调用。 */
  toolCallId: string;
  movedAt: number;
  /** 到这个时刻还在跑 → 停掉、告诉模型(移交后最多再跑 HANDOFF_MAX_MS)。 */
  deadlineAt: number;
  /** 到点被停。 */
  timedOut?: boolean;
  /** 真正收尾(close,或 exit 后管道迟迟不关的兜底)。结局判定与交回都等它。 */
  closed?: boolean;
  /** 结局已经处理过(交进某一轮 / 起了一轮 / 不用交)。同步翻,防两处各交一次。 */
  delivered?: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/;
/** 文本里第一个本机地址;vite 等会给地址上色,先剥色码。0.0.0.0 / 127.0.0.1 / [::1] 归一成 localhost(浏览器打得开、看着一致)。
 *  complete:地址后面必须已经跟着空白 / 引号 / 括号 —— 流式输出可能停在 `http://localhost:` 或半截色码上,
 *  这时先不认(否则缓存成没端口的地址,之后再也不改);下一块输出到了再判。 */
export function detectLocalUrl(text: string, complete = false): string | null {
  const t = stripAnsi(text);
  const m = t.match(LOCAL_URL);
  if (!m) return null;
  if (complete && !/[\s'"<>)\]]/.test(t.charAt((m.index ?? 0) + m[0].length))) return null;
  return m[0].replace(/\/\/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\])/, '//localhost');
}
/** 最后一个非空行(剥色码;`\r` 刷新的进度行也拆开),截 160。 */
export function lastLine(output: string): string {
  const lines = stripAnsi(output).split(/\r\n|\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.slice(0, 160);
  }
  return '';
}

/** 给人 / 模型看的输出(带打码的进程先打码)。所有读 output 的地方都走这里。 */
export function processOutput(p: BackgroundProcess): string {
  return p.redact ? p.redact(p.output) : p.output;
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
const endListeners = new Set<(p: BackgroundProcess) => void>();
/** 移交进来的进程真正收尾(输出已齐)。返回退订。 */
export function onHandoffClosed(cb: (p: BackgroundProcess) => void): () => void {
  endListeners.add(cb);
  return () => { endListeners.delete(cb); };
}
function emitHandoffClosed(p: BackgroundProcess): void {
  for (const cb of [...endListeners]) {
    try { cb(p); } catch { /* 订阅者的错误不影响注册表 */ }
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
 * (dev server / watch 等)。Windows Bash 用 Job Object，cmd 用 taskkill /T /F，保证释放端口和管道。
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGKILL'): void {
  void killProcessTree(child, 5000, sig);
}

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of procs) {
      // 移交进来、结局还没交出去的不收(会话一直忙着的话,交出去之前模型还要读它的输出)
      if (p.handoff && !p.handoff.delivered) continue;
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
  if (!p.url) {
    // 多看前面 200 字:地址可能被切在两个 chunk 之间
    const url = detectLocalUrl(p.output.slice(-(chunk.length + 200)), true);
    // 地址里带着秘密变量的值(打码会改动它)→ 不登记:url 会原样经进程接口和界面地址条出去(Codex 11-21 P0-3)
    if (url && (!p.redact || p.redact(url) === url)) { p.url = url; emitChange(); }
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
  wire(p, child);
  procs.set(id, p);
  ensureReaper();
  emitChange();
  return p;
}

function wire(p: BackgroundProcess, child: ChildProcess): void {
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
    closeHandoff(p);
  });
  child.on('close', (code) => {
    if (p.status === 'running') p.status = code === null ? 'killed' : 'exited';
    p.exitCode = code;
    p.endedAt = Date.now();
    p.child = null;
    emitChange();
    closeHandoff(p);
  });
}

/** 移交上限:移交之后最多再跑这么久(方案定 30 分钟)。测试经 TANGU_HANDOFF_MAX_MS 缩短。 */
export function handoffMaxMs(): number {
  const v = Number(process.env.TANGU_HANDOFF_MAX_MS);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
}
/** shell 已退出、管道却被它留下的孙进程撑着不关(close 永远不来)→ 等这么久就按收尾算,别让结局永远交不出去。 */
const EXIT_CLOSE_GRACE_MS = 3000;

function closeHandoff(p: BackgroundProcess): void {
  const h = p.handoff;
  if (!h || h.closed) return;
  h.closed = true;
  emitHandoffClosed(p);
}

/**
 * 前台 run_bash 跑着时用户插话 → 把**正在跑的那个子进程**(不重起)登记进后台进程表。
 * 沙箱包装、进程组 / Windows 进程树都是原来那个;来源 / runId / 沙箱范围 / 远程写保护的标签与 run_background 同口径
 * (急停与 stdin 闸靠它们)。不受每会话 MAX_PER_SESSION 限制:它本来就在跑,拒收 = 继续挡着用户。
 * output:移交前已收到的输出(stdout 在前、stderr 在后,交错顺序已丢)。
 */
export function adoptForegroundProcess(o: {
  sessionId: string; command: string; child: ChildProcess; ctx?: ToolContext; cwd: string;
  output: string; startedAt: number; runId: string; toolCallId: string;
  redact?: (text: string) => string; remoteSeatbelt?: boolean;
}): BackgroundProcess {
  const now = Date.now();
  const id = `bg_${now.toString(36)}_${++seq}`;
  const p: BackgroundProcess = {
    id, sessionId: o.sessionId, command: o.command, pid: o.child.pid ?? null,
    status: 'running', exitCode: null,
    startedAt: o.startedAt, endedAt: null,
    output: '', truncated: false, child: o.child, lastDataAt: now,
    sandboxScope: hostSandboxScopeKey(o.ctx || { cwd: o.cwd }),
    runId: o.runId,
    origin: processOriginOf(o.ctx),
    ...(o.remoteSeatbelt ? { remoteSeatbelt: true } : {}),
    ...(o.redact ? { redact: o.redact } : {}),
    handoff: { runId: o.runId, toolCallId: o.toolCallId, movedAt: now, deadlineAt: now + handoffMaxMs() },
  };
  if (o.output) append(p, o.output);
  wire(p, o.child);
  const deadline = setTimeout(() => {
    if (p.status !== 'running' || !p.child) return;
    p.handoff!.timedOut = true;
    terminate(p);
    emitChange();
  }, handoffMaxMs());
  deadline.unref?.();
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const child = o.child;
  const onExit = (code: number | null): void => {
    if (exitTimer) return;
    exitTimer = setTimeout(() => {
      if (p.handoff?.closed) return;
      // 管道还被孙进程撑着:按 shell 的退出码收尾,并停掉撑着管道的孙进程 —— 不停的话记录已成终态,kill_process / 停止那一轮 /
      // 到点都够不着它们(Codex 11-21 P1-3)。没移交时同样的命令也是等到超时整组停掉。不记 killRequested:结局按 shell 的退出码算。
      if (p.status === 'running') p.status = code === null ? 'killed' : 'exited';
      if (p.exitCode === null) p.exitCode = code;
      p.endedAt = p.endedAt ?? Date.now();
      try {
        killTree(child, 'SIGTERM');
        if (process.platform !== 'win32') setTimeout(() => killTree(child), 3000).unref?.();
      } catch { /* 组已空 */ }
      emitChange();
      closeHandoff(p);
    }, EXIT_CLOSE_GRACE_MS);
    exitTimer.unref?.();
  };
  // shell 可能在宽限期里就退了(孙进程撑着管道,runBash 还在等 close):exit 早已发过,补挂不到 → 现在就起兜底(Codex 11-21 P1-2)
  if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode);
  else child.on('exit', (code) => onExit(code));
  const stopTimers = (): void => { clearTimeout(deadline); if (exitTimer) clearTimeout(exitTimer); };
  endListenersOnce(p, stopTimers);
  procs.set(id, p);
  ensureReaper();
  emitChange();
  return p;
}
/** 本进程收尾时跑一次(只给 adoptForegroundProcess 清计时器用)。 */
function endListenersOnce(p: BackgroundProcess, fn: () => void): void {
  const off = onHandoffClosed((x) => { if (x === p) { off(); fn(); } });
}

/** 所有会话的进程(摘要栏按用户归属自己筛)。 */
export function listAllProcesses(): BackgroundProcess[] {
  return [...procs.values()];
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
  p.killRequested = true;
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
    // 先整段打码再按打码后的前缀长度切:按原始偏移切,跨在 fromLen 上的一段秘密两边都配不上打码表(Codex 11-21 P0-4)
    const done = (): void => {
      const out = p.redact ? p.redact(p.output).slice(p.redact(p.output.slice(0, fromLen)).length) : p.output.slice(fromLen);
      resolve({ output: out, status: p.status });
    };
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
      p.killRequested = true;
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
