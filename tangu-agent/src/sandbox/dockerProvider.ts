/**
 * Docker 沙箱（v1：ephemeral-per-exec —— 每次执行起一个一次性具名容器，跑完即焚）。
 * 安全红线：--network none、--init（reap 僵尸/转发信号）、cap-drop ALL、no-new-privileges、
 * 只读 rootfs + 可写工作区、CPU/内存/pids 配额、超时/中止用 `docker kill <name>` 真停容器
 * （不是杀 CLI —— 杀 CLI 会留孤儿容器占资源）、输出截断、不注入任何密钥/env。
 * 并发上限信号量防止容器风暴打爆宿主。
 *
 * 工作区：可传 mountDir（宿主临时目录）bind 到容器 /workspace（可读写），实现
 * Penzor workspace 的 hydrate（执行前写入）/ snapshot（执行后回写）。bind 时以宿主
 * uid:gid 运行容器，保证产物属主可被服务进程读回。未传 mountDir 时退回 tmpfs。
 *
 * 可观测：维护进程内「活跃执行」表 + 最近执行历史，供 admin 面板显示真实占用/运行情况
 * （ephemeral 容器存活仅数秒，docker stats 快照常抓不到，故以进程内登记为准）。
 *
 * 按需装包：exec 沙箱保持 --network none。需要的第三方包由 installPackages() 在一个
 * 「短命、带网、只挂共享包目录」的安装容器里 `pip install --target /pkgs`，装到宿主共享
 * 缓存目录；exec 时把该目录只读挂到 /pkgs 并设 PYTHONPATH=/pkgs。共享缓存=每个包全局只装一次，
 * 后续 run 直接挂载零成本。安装容器默认 --only-binary（不跑 setup.py，杜绝装包期任意代码执行）。
 */
import { spawn, execFile } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { sandboxConfig } from './sandboxConfig.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted?: boolean;
}

export interface ExecOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  mountDir?: string;
  runId?: string;
  kind?: string; // 'python' | 'node:<toolName>' …（仅用于可观测标注）
}

// 默认用预装文档/数据库的自建镜像（见 sandbox/Dockerfile）；缺失时回落 python:3.12-slim。
// 回落源可经 env 覆盖(桌面「中国大陆镜像」注入 DaoCloud 代理,Docker Hub 直连在国内常拉不动)。
const PYTHON_IMAGE = process.env.AGENT_SANDBOX_PYTHON_IMAGE || 'forsion-agent-sandbox:py312';
const PYTHON_IMAGE_FALLBACK = process.env.AGENT_SANDBOX_PYTHON_IMAGE_FALLBACK || 'python:3.12-slim';
const NODE_IMAGE = process.env.AGENT_SANDBOX_NODE_IMAGE || 'node:20-slim';
let pythonImageResolved: string | null = null;

// 按需装包：共享包缓存目录（持久化=跨 run 复用，重启清空可接受）；开关 + 安全选项。
export const PKG_DIR = process.env.AGENT_SANDBOX_PKG_DIR || path.join(os.tmpdir(), 'forsion-agent-pkgs');
const ALLOW_INSTALL = (process.env.AGENT_SANDBOX_ALLOW_INSTALL ?? 'true') !== 'false';
const INSTALL_ONLY_BINARY = (process.env.AGENT_SANDBOX_INSTALL_ONLY_BINARY ?? 'true') !== 'false';
const INSTALL_TIMEOUT_MS = Number(process.env.AGENT_SANDBOX_INSTALL_TIMEOUT_MS) || 120_000;
// pip 镜像源(中国大陆:桌面「中国大陆镜像」开关经 env 注入清华源);空=直连 PyPI。
const PIP_INDEX_URL = (process.env.AGENT_SANDBOX_PIP_INDEX_URL || process.env.PIP_INDEX_URL || '').trim();
const MAX_INSTALL_PKGS = 20;
// 包名/版本规格允许集：名字[extras](==/>=/... 版本)*；禁止 flags/URL/路径/shell 元字符。
const PKG_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?([=<>!~]=?[0-9A-Za-z.*+!-]+)*$/;
let pkgDirReady = false;
let installChain: Promise<unknown> = Promise.resolve(); // 串行化安装（pip --target 非并发安全）

export const MAX_OUTPUT = 16_000;
// run_python（持久 kernel 路径）的全文捕获上限：远高于 MAX_OUTPUT，让 registry 拿到完整输出后
// 再决定「预览+落盘」还是「直接回」。1MB 兜内存/DB；ephemeral 路径仍按 MAX_OUTPUT 源头截断。
export const MAX_CAPTURE = Number(process.env.AGENT_SANDBOX_MAX_CAPTURE) || 1_000_000;
export const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_SANDBOX_TIMEOUT_MS) || 20_000;
// node 首次执行可能触发镜像拉取，给更宽裕的超时（仅首跑）。
const NODE_FIRST_RUN_TIMEOUT_MS = Number(process.env.AGENT_SANDBOX_NODE_PULL_TIMEOUT_MS) || 120_000;
let nodeImageWarmed = false;

// ── 进程内可观测：活跃执行表 + 最近历史 ─────────────────────────────────
export interface ActiveExec {
  name: string;
  runId: string | null;
  kind: string;
  startedAt: number;
}
export interface ExecHistoryItem {
  name: string;
  runId: string | null;
  kind: string;
  startedAt: number;
  endedAt: number;
  ms: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}
const activeExecs = new Map<string, ActiveExec>();
const recentExecs: ExecHistoryItem[] = [];
const MAX_HISTORY = 50;

/** 当前正在跑的沙箱容器（按名）。 */
export function getActiveExecs(): ActiveExec[] {
  return Array.from(activeExecs.values()).sort((a, b) => a.startedAt - b.startedAt);
}
/** 最近的沙箱执行历史（最新在前）。 */
export function getRecentExecs(limit = 20): ExecHistoryItem[] {
  return recentExecs.slice(0, Math.max(0, limit));
}
/** 进程内沙箱使用累计快照（容器极短命，docker stats 抓不到时以此为准）。 */
export function getSandboxSnapshot() {
  return {
    active: getActiveExecs(),
    activeCount: activeExecs.size,
    maxConcurrent: sandboxConfig().maxConcurrent,
    queued: waiters.length,
    recent: getRecentExecs(20),
    totalRecent: recentExecs.length,
  };
}

// ── 计数信号量：限制并发容器数（上限运行期可调，admin 设置 → sandboxConfig）──
let active = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < sandboxConfig().maxConcurrent) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function pump(): void {
  while (waiters.length && active < sandboxConfig().maxConcurrent) {
    active++;
    waiters.shift()!();
  }
}
function release(): void {
  active = Math.max(0, active - 1);
  pump();
}
/** 并发上限被调高后立即唤醒排队任务（admin 改设置后调用）。 */
export function pumpWaiters(): void {
  pump();
}

/** 供 sessionSandbox 复用同一并发信号量（会话级 kernel exec 也受 maxConcurrent 约束）。 */
export function acquireSlot(): Promise<void> { return acquire(); }
export function releaseSlot(): void { release(); }

/** 供外部（sessionSandbox）登记一次执行到可观测表，admin 面板能看到会话 kernel 的真实占用。返回 startedAt。 */
export function beginExec(name: string, runId: string | null, kind: string): number {
  const startedAt = Date.now();
  activeExecs.set(name, { name, runId, kind, startedAt });
  return startedAt;
}
export function endExec(
  name: string,
  runId: string | null,
  kind: string,
  startedAt: number,
  r: { exitCode: number | null; timedOut?: boolean; aborted?: boolean },
): void {
  activeExecs.delete(name);
  recentExecs.unshift({
    name, runId, kind, startedAt, endedAt: Date.now(),
    ms: Date.now() - startedAt, exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted,
  });
  if (recentExecs.length > MAX_HISTORY) recentExecs.length = MAX_HISTORY;
}

/** 解析 Python 镜像：首选自建镜像，缺失则回落官方 slim（只探一次）。 */
export function resolvePythonImage(): Promise<string> {
  if (pythonImageResolved) return Promise.resolve(pythonImageResolved);
  if (process.env.AGENT_SANDBOX_PYTHON_IMAGE) { // 显式指定就不探测
    pythonImageResolved = PYTHON_IMAGE;
    return Promise.resolve(pythonImageResolved);
  }
  return new Promise((resolve) => {
    execFile('docker', ['image', 'inspect', PYTHON_IMAGE], { timeout: 5000 }, (err) => {
      pythonImageResolved = err ? PYTHON_IMAGE_FALLBACK : PYTHON_IMAGE;
      if (err) console.warn(`[agent-core] 沙箱镜像 ${PYTHON_IMAGE} 不存在，回落 ${PYTHON_IMAGE_FALLBACK}（文档库不可用，请构建：docker build -t ${PYTHON_IMAGE} server/microserver/agent-core/sandbox）`);
      resolve(pythonImageResolved!);
    });
  });
}

export async function ensurePkgDir(): Promise<void> {
  if (pkgDirReady) return;
  await fsp.mkdir(PKG_DIR, { recursive: true }).catch(() => {});
  pkgDirReady = true;
}

// ── 包缓存策略：体积上限 + 保留天数（超限则清空整缓存——缓存语义，安全且简单）──
const LAST_USED_MARKER = '.last_used';

/** 触达缓存「最近使用」标记（exec 挂载/安装时调用），驱动 TTL 判定。 */
async function touchLastUsed(): Promise<void> {
  const f = path.join(PKG_DIR, LAST_USED_MARKER);
  const now = new Date();
  await fsp.utimes(f, now, now).catch(async () => {
    await fsp.writeFile(f, '').catch(() => {});
  });
}

/** 缓存总体积（字节）。优先用 du（快），失败回落 node 递归。 */
function getCacheSizeBytes(): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sb', PKG_DIR], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout) {
        const n = parseInt(String(stdout).split(/\s+/)[0], 10);
        if (Number.isFinite(n)) return resolve(n);
      }
      // 回落：递归累加
      walkSize(PKG_DIR).then(resolve).catch(() => resolve(0));
    });
  });
}
async function walkSize(dir: string): Promise<number> {
  let total = 0;
  let entries: any[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) total += await walkSize(abs);
    else { try { total += (await fsp.stat(abs)).size; } catch { /* skip */ } }
  }
  return total;
}

/** 清空包缓存内容（保留目录本身）。返回清掉前的体积 MB。 */
export async function clearPkgCache(): Promise<number> {
  await ensurePkgDir();
  const before = await getCacheSizeBytes();
  let entries: any[] = [];
  try { entries = await fsp.readdir(PKG_DIR); } catch { /* none */ }
  for (const name of entries) {
    await fsp.rm(path.join(PKG_DIR, name), { recursive: true, force: true }).catch(() => {});
  }
  return Math.round((before / (1024 * 1024)) * 10) / 10;
}

/** 缓存信息（供 admin 面板显示）。 */
export async function getCacheInfo(): Promise<{ sizeMB: number; maxMB: number; ttlDays: number; lastUsed: number | null }> {
  await ensurePkgDir();
  const bytes = await getCacheSizeBytes();
  let lastUsed: number | null = null;
  try { lastUsed = (await fsp.stat(path.join(PKG_DIR, LAST_USED_MARKER))).mtimeMs; } catch { /* none */ }
  const cfg = sandboxConfig();
  return {
    sizeMB: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    maxMB: cfg.pkgCacheMaxMB,
    ttlDays: cfg.pkgCacheTtlDays,
    lastUsed,
  };
}

/** 执行缓存策略：超龄(TTL) 或 超体积(MB) 则清空。返回是否清理 + 原因。 */
export async function enforceCachePolicy(): Promise<{ cleared: boolean; reason?: string; sizeMB?: number }> {
  const { pkgCacheMaxMB, pkgCacheTtlDays } = sandboxConfig();
  await ensurePkgDir();

  // TTL：标记文件超过 N 天未触达 → 清
  if (pkgCacheTtlDays > 0) {
    try {
      const st = await fsp.stat(path.join(PKG_DIR, LAST_USED_MARKER));
      const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
      if (ageDays > pkgCacheTtlDays) {
        const mb = await clearPkgCache();
        console.log(`[agent-core] 包缓存超 ${pkgCacheTtlDays} 天未用，已清空（${mb}MB）`);
        return { cleared: true, reason: 'ttl', sizeMB: mb };
      }
    } catch { /* 无标记=没用过，跳过 */ }
  }
  // 体积：超上限 → 清
  if (pkgCacheMaxMB > 0) {
    const mb = (await getCacheSizeBytes()) / (1024 * 1024);
    if (mb > pkgCacheMaxMB) {
      const cleared = await clearPkgCache();
      console.log(`[agent-core] 包缓存 ${cleared}MB 超上限 ${pkgCacheMaxMB}MB，已清空`);
      return { cleared: true, reason: 'size', sizeMB: cleared };
    }
  }
  return { cleared: false };
}

let janitorTimer: ReturnType<typeof setInterval> | null = null;
/** 启动周期清理任务（默认每小时跑一次缓存策略，主要为 TTL 兜底）。幂等。 */
export function startCacheJanitor(intervalMs = 3_600_000): void {
  if (janitorTimer) return;
  janitorTimer = setInterval(() => { void enforceCachePolicy().catch(() => {}); }, intervalMs);
  if (typeof janitorTimer.unref === 'function') janitorTimer.unref();
}

/** 停止缓存清理器(dispose/热加载用)。 */
export function stopCacheJanitor(): void {
  if (janitorTimer) { clearInterval(janitorTimer); janitorTimer = null; }
}

/** 在沙箱里跑一段 Python（代码经 stdin 传入，避免参数转义问题）。 */
export async function runPython(code: string, opts?: ExecOpts): Promise<ExecResult> {
  const image = await resolvePythonImage();
  await ensurePkgDir();
  void touchLastUsed(); // 标记缓存被使用（TTL 计时），不阻塞
  await acquire();
  try {
    return await runInDocker({
      image,
      cmd: ['python3', '-'],
      stdinData: code,
      kind: opts?.kind || 'python',
      // 按需装的包：只读挂到 /pkgs + PYTHONPATH，让 import 找得到（exec 仍无网络）。
      pkgMount: { dir: PKG_DIR, ro: true },
      ...opts,
    });
  } finally {
    release();
  }
}

function installErr(msg: string): ExecResult {
  return { stdout: '', stderr: msg, exitCode: 1, timedOut: false };
}

/**
 * 按需安装 Python 包到共享缓存（供后续 run_python import）。
 * 在一个「短命、带网、只挂 /pkgs」的安装容器里 `pip install --target /pkgs` 执行；
 * exec 沙箱本身仍 --network none。默认 --only-binary（不跑 setup.py）。串行化避免 --target 竞态。
 */
export async function installPackages(packages: string[], opts?: ExecOpts): Promise<ExecResult> {
  if (!ALLOW_INSTALL) return installErr('package install is disabled (AGENT_SANDBOX_ALLOW_INSTALL=false)');
  const pkgs = (packages || []).map((p) => String(p).trim()).filter(Boolean);
  if (!pkgs.length) return installErr('no packages specified');
  if (pkgs.length > MAX_INSTALL_PKGS) return installErr(`too many packages (max ${MAX_INSTALL_PKGS})`);
  for (const p of pkgs) {
    if (!PKG_SPEC_RE.test(p)) return installErr(`invalid package spec: "${p}" (only name[extras][version] allowed)`);
  }
  await ensurePkgDir();
  const image = await resolvePythonImage();

  // 串行化：把本次安装挂到 installChain 尾部，避免并发 pip --target 互相破坏。
  const run = installChain.then(async () => {
    // 装前先按策略清理（若已超龄/超体积），给本次安装腾空间，避免刚装就被清。
    await enforceCachePolicy().catch(() => {});
    await touchLastUsed();
    await acquire();
    try {
      const cmd = ['pip', 'install', '--target', '/pkgs', '--no-input', '--no-cache-dir', '--disable-pip-version-check'];
      if (PIP_INDEX_URL) cmd.push('--index-url', PIP_INDEX_URL); // 中国大陆镜像:清华 PyPI 等
      if (INSTALL_ONLY_BINARY) cmd.push('--only-binary', ':all:');
      cmd.push(...pkgs);
      return await runInDocker({
        image,
        cmd,
        stdinData: '',
        kind: 'pip-install',
        network: 'bridge',                       // 仅安装容器带网
        pkgMount: { dir: PKG_DIR, ro: false },   // 写入共享缓存
        env: { HOME: '/tmp' },
        timeoutMs: opts?.timeoutMs ?? INSTALL_TIMEOUT_MS,
        signal: opts?.signal,
        runId: opts?.runId,
      });
    } finally {
      release();
    }
  });
  installChain = run.then(() => undefined, () => undefined);
  return run;
}

// ── per-run 暖容器：一个 run 复用一个常驻容器，docker exec 跑代码（省冷启 ~1s/次）──
interface RunContainer { name: string; mountDir: string; createdAt: number; starting?: Promise<boolean>; }
const runContainers = new Map<string, RunContainer>();

function dockerRm(name: string): void {
  execFile('docker', ['rm', '-f', name], () => {});
}

async function ensureRunContainer(runId: string, mountDir: string): Promise<string | null> {
  const existing = runContainers.get(runId);
  if (existing) {
    if (existing.starting) return (await existing.starting) ? existing.name : null;
    return existing.name;
  }
  const image = await resolvePythonImage();
  await ensurePkgDir();
  const name = `agent-run-${runId}`;
  const rc: RunContainer = { name, mountDir, createdAt: Date.now() };
  rc.starting = (async () => {
    await new Promise<void>((r) => execFile('docker', ['rm', '-f', name], () => r())); // 清同名残留
    const args = [
      'run', '-d', '--name', name, '--init',
      '--network', 'none', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m',
    ];
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const gid = typeof process.getgid === 'function' ? process.getgid() : null;
      if (uid != null && gid != null) args.push('--user', `${uid}:${gid}`);
    } catch { /* 非 POSIX */ }
    args.push(
      // 唯一持久可写处：/workspace 与 /mnt/data 同指会话工作区目录。HOME/缓存指到易失 /tmp。
      '-v', `${mountDir}:/workspace:rw`, '-v', `${mountDir}:/mnt/data:rw`, '-v', `${PKG_DIR}:/pkgs:ro`,
      '-e', 'PYTHONPATH=/pkgs', '-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp', '-e', 'MPLCONFIGDIR=/tmp/mpl',
      '-e', 'XDG_CACHE_HOME=/tmp/.cache', '-e', 'XDG_CONFIG_HOME=/tmp/.config', '-e', 'XDG_DATA_HOME=/tmp/.local',
      '--workdir', '/workspace', '--entrypoint', 'sleep', image, 'infinity',
    );
    return await new Promise<boolean>((resolve) => {
      execFile('docker', args, { timeout: 60_000 }, (err) => resolve(!err));
    });
  })();
  runContainers.set(runId, rc);
  const ok = await rc.starting;
  rc.starting = undefined;
  if (!ok) { runContainers.delete(runId); return null; }
  return name;
}

/**
 * 在 run 的暖容器里 docker exec 跑 python。首次调用：本次走 ephemeral（与纯 ephemeral 同速，不回退变慢），
 * 同时后台预热暖容器；后续调用直接 docker exec 复用（省冷启 ~1s/次）。建容器失败则一直 ephemeral。
 */
export async function runPythonInRun(runId: string, mountDir: string, code: string, opts?: ExecOpts): Promise<ExecResult> {
  if (!runContainers.has(runId)) {
    const res = await runPython(code, { mountDir, ...opts }); // 首次走 ephemeral（与纯 ephemeral 同速）
    void ensureRunContainer(runId, mountDir).catch(() => {}); // 完成后再后台预热（与后续 LLM 间隙重叠，不抢首调用资源）
    return res;
  }
  const name = await ensureRunContainer(runId, mountDir);
  if (!name) return runPython(code, { mountDir, ...opts });
  await acquire();
  try {
    return await execInContainer(runId, name, code, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts?.signal);
  } finally {
    release();
  }
}

/** run 结束清掉暖容器。 */
export function releaseRunContainer(runId: string): void {
  const rc = runContainers.get(runId);
  if (!rc) return;
  runContainers.delete(runId);
  dockerRm(rc.name);
}

/** 进程启动时清理上个进程遗留的 agent-run-* 暖容器（孤儿）。 */
export function reapOrphanRunContainers(): void {
  execFile('docker', ['ps', '-aq', '--filter', 'name=agent-run-'], { timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return;
    const ids = String(stdout).split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) execFile('docker', ['rm', '-f', ...ids], () => {});
  });
}

function execInContainer(runId: string, name: string, code: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  const startedAt = Date.now();
  activeExecs.set(name, { name, runId, kind: 'python', startedAt });
  const finish = (r: ExecResult) => {
    activeExecs.delete(name);
    recentExecs.unshift({
      name, runId, kind: 'python', startedAt, endedAt: Date.now(),
      ms: Date.now() - startedAt, exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted,
    });
    if (recentExecs.length > MAX_HISTORY) recentExecs.length = MAX_HISTORY;
  };
  return new Promise<ExecResult>((resolve) => {
    let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false;
    const child = spawn('docker', ['exec', '-i', name, 'python3', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // 超时/中止 → kill 整个暖容器（其内 exec 进程随之死），从 map 删除让下次重建
    const killContainer = () => { runContainers.delete(runId); execFile('docker', ['kill', name], () => dockerRm(name)); };
    const killer = setTimeout(() => { timedOut = true; killContainer(); }, timeoutMs);
    const onAbort = () => { aborted = true; killContainer(); };
    if (signal) {
      if (signal.aborted) { aborted = true; queueMicrotask(killContainer); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { clearTimeout(killer); if (signal) signal.removeEventListener('abort', onAbort); };
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return; settled = true; cleanup();
      runContainers.delete(runId); // exec 失败（容器可能已死）→ 下次重建
      const r: ExecResult = { stdout, stderr: `${stderr}\n[docker exec error] ${err.message}`.slice(0, MAX_OUTPUT), exitCode: null, timedOut, aborted };
      finish(r); resolve(r);
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; cleanup();
      const r: ExecResult = { stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), exitCode: code, timedOut, aborted };
      finish(r); resolve(r);
    });
    try { child.stdin.write(code); child.stdin.end(); } catch { /* close handler resolves */ }
  });
}

/**
 * 在沙箱里跑一段 Node 脚本（脚本经 stdin 传入 `node -`，无网络）。
 * 供 agent 自定义 JS 工具的云端执行——纯计算；要联网请用 http executor。
 */
export async function runNode(script: string, opts?: ExecOpts): Promise<ExecResult> {
  await acquire();
  try {
    const timeoutMs = opts?.timeoutMs ?? (nodeImageWarmed ? DEFAULT_TIMEOUT_MS : NODE_FIRST_RUN_TIMEOUT_MS);
    const r = await runInDocker({
      image: NODE_IMAGE,
      cmd: ['node', '-'],
      stdinData: script,
      kind: opts?.kind || 'node',
      ...opts,
      timeoutMs,
    });
    if (r.exitCode === 0 || (r.stdout && r.stdout.length)) nodeImageWarmed = true;
    return r;
  } finally {
    release();
  }
}

interface DockerRunArgs extends ExecOpts {
  image: string;
  cmd: string[];
  stdinData: string;
  network?: string;                         // 默认 'none'（仅装包容器用 'bridge'）
  pkgMount?: { dir: string; ro: boolean };  // 共享包缓存挂到 /pkgs（exec 只读，安装可写）
  env?: Record<string, string>;             // 仅非敏感配置（如 PYTHONPATH/HOME），绝不注入密钥
}

function runInDocker(args: DockerRunArgs): Promise<ExecResult> {
  const { image, cmd, stdinData } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = `agent-sbx-${randomUUID()}`;
  const kind = args.kind || 'exec';

  const dockerArgs = [
    'run', '--rm', '-i',
    '--name', name,
    '--init',
    '--network', args.network || 'none',
    '--cpus', '1',
    '--memory', '512m',
    '--pids-limit', '128',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=64m',
  ];

  // bind 挂载需以宿主 uid:gid 运行，保证产物属主可被服务进程读回 / 共享缓存可读写。
  if (args.mountDir || args.pkgMount) {
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const gid = typeof process.getgid === 'function' ? process.getgid() : null;
      if (uid != null && gid != null) dockerArgs.push('--user', `${uid}:${gid}`);
    } catch { /* 非 POSIX：跳过 --user */ }
  }

  if (args.mountDir) {
    // 唯一持久可写处：/workspace 与 /mnt/data 同指会话工作区目录（兼容模型默认往 /mnt/data 写）。
    dockerArgs.push('-v', `${args.mountDir}:/workspace:rw`, '-v', `${args.mountDir}:/mnt/data:rw`);
  } else {
    dockerArgs.push('--tmpfs', '/workspace:rw,size=64m,exec');
  }

  const env: Record<string, string> = { ...(args.env || {}) };
  if (args.pkgMount) {
    dockerArgs.push('-v', `${args.pkgMount.dir}:/pkgs:${args.pkgMount.ro ? 'ro' : 'rw'}`);
    if (!env.PYTHONPATH) env.PYTHONPATH = '/pkgs'; // 让 import 找到按需装的包
  }
  // HOME / 库缓存指到易失 /tmp：避免写穿只读 rootfs 报错，也避免缓存污染回流的工作区。
  if (!env.HOME) env.HOME = '/tmp';
  if (!env.TMPDIR) env.TMPDIR = '/tmp';
  if (!env.MPLCONFIGDIR) env.MPLCONFIGDIR = '/tmp/mpl';
  if (!env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = '/tmp/.cache';
  if (!env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = '/tmp/.config';
  if (!env.XDG_DATA_HOME) env.XDG_DATA_HOME = '/tmp/.local';
  for (const [k, v] of Object.entries(env)) dockerArgs.push('-e', `${k}=${v}`);

  dockerArgs.push('--workdir', '/workspace', image, ...cmd);

  const startedAt = Date.now();
  activeExecs.set(name, { name, runId: args.runId ?? null, kind, startedAt });

  const finish = (r: ExecResult) => {
    activeExecs.delete(name);
    recentExecs.unshift({
      name, runId: args.runId ?? null, kind, startedAt, endedAt: Date.now(),
      ms: Date.now() - startedAt, exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted,
    });
    if (recentExecs.length > MAX_HISTORY) recentExecs.length = MAX_HISTORY;
  };

  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    // 真停容器（不是杀 CLI）：docker kill 具名容器；rm -f 作为兜底清孤儿。
    const killContainer = () => {
      execFile('docker', ['kill', name], () => {
        execFile('docker', ['rm', '-f', name], () => {});
      });
    };

    const killer = setTimeout(() => { timedOut = true; killContainer(); }, timeoutMs);

    // 中止信号：abort 时真停容器（与超时同路径）。
    const onAbort = () => { aborted = true; killContainer(); };
    if (args.signal) {
      if (args.signal.aborted) { aborted = true; queueMicrotask(killContainer); }
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(killer);
      if (args.signal) args.signal.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      execFile('docker', ['rm', '-f', name], () => {}); // 兜底
      const r: ExecResult = {
        stdout,
        stderr: `${stderr}\n[docker spawn error] ${err.message}`.slice(0, MAX_OUTPUT),
        exitCode: null,
        timedOut,
        aborted,
      };
      finish(r);
      resolve(r);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const r: ExecResult = {
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code,
        timedOut,
        aborted,
      };
      finish(r);
      resolve(r);
    });

    try {
      child.stdin.write(stdinData);
      child.stdin.end();
    } catch {
      /* ignore — close handler will resolve */
    }
  });
}

/** 给调用方临时目录的根（os.tmpdir 下，调用方负责 mkdtemp/rm）。 */
export function sandboxTmpRoot(): string {
  return os.tmpdir();
}
