/**
 * 会话级沙箱（T2：沙箱 + 本地工作区 + 持久 Python kernel 的生命周期 = 整个会话，而非单次调用）。
 *
 * 对齐 ChatGPT Code Interpreter 模型：
 *   - 每个 (userId, appId, sessionId) 一个**常驻**本地工作区目录 + 暖容器 + 持久 kernel。
 *   - **懒 hydrate**：首次文件/代码操作才从 Penzor 拉一次工作区；纯聊天的 run 零 FS 成本。
 *   - **持久 kernel**：run_python 不再每次起新 python 进程（重导入 pandas/matplotlib 1-3s），
 *     而是把代码喂给容器内一个长驻 python 进程（import 与变量跨调用保留）→ 第二次起近乎瞬时。
 *   - **本地优先 + 选择性上传**：文件工具/代码都在本地目录读写，run 结束按 sha256 diff 只回写变更文件。
 *   - **空闲 TTL + LRU 淘汰**：会话静默超时则 snapshot + 杀容器 + 删目录；并发会话数封顶。
 *
 * 隔离红线：sessionKey 含 userId，容器**绝不跨用户/会话复用**；容器仍 --network none、cap-drop ALL、
 * 只读 rootfs、CPU/内存/pids 配额、不注入密钥。kernel exec 受同一并发信号量约束。
 *
 * kernel 协议：docker exec -i <c> python3 -u -c <DRIVER>，stdin/stdout 走「10 位十进制长度前缀 + UTF-8」
 * 帧。driver 在持久 globals 里 exec，sys.stdout/stderr 重定向到 StringIO 回传。
 * 局限：绕过 sys.stdout 的裸 fd 写（os.write(1,...) 等）会破坏帧 → 视为 kernel 死亡，杀容器重建并回退
 * ephemeral。文档生成类代码（print / 库写文件）不受影响。
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePythonImage, ensurePkgDir, PKG_DIR,
  acquireSlot, releaseSlot, beginExec, endExec,
  runPython, DEFAULT_TIMEOUT_MS, MAX_CAPTURE, type ExecResult,
} from './dockerProvider.js';
import { hydrateWorkspaceToDir, snapshotDirToWorkspace, scopeOf } from '../tools/fileWorkspace.js';

export interface SessionKey {
  userId: string;
  appId: string;
  sessionId: string;
  /** 云端 Project 工作区名:有值时沙箱按 (user, app, project) 归并——同 Project 多会话共享同一
   *  本地目录/容器/kernel(per-project 锁串行,天然避免并发写各自基线互踩),hydrate/snapshot 走
   *  Cloud-Workspaces/Projects/<name>/ 云树。缺省=旧 per-session 工作区。 */
  wsProject?: string | null;
}

const BASE_DIR = process.env.AGENT_SANDBOX_SESSION_DIR || path.join(os.tmpdir(), 'forsion-agent-sessions');
const SESSION_TTL_MS = Number(process.env.AGENT_SANDBOX_SESSION_TTL_MS) || 600_000; // 10min 空闲回收
const MAX_SESSIONS = Math.max(1, Number(process.env.AGENT_SANDBOX_MAX_SESSIONS) || 24);
const KERNEL_START_TIMEOUT_MS = Number(process.env.AGENT_SANDBOX_KERNEL_START_TIMEOUT_MS) || 30_000;

// ── 持久 kernel driver（发给容器内 python3 -c）。帧：b"%010d"(len) + JSON ──────────
const KERNEL_DRIVER = [
  'import sys, io, json, traceback, importlib',
  '_in = sys.stdin.buffer',
  '_out = sys.stdout.buffer',
  '_G = {"__name__": "__main__"}',
  'def _read_exactly(n):',
  '    b = b""',
  '    while len(b) < n:',
  '        c = _in.read(n - len(b))',
  '        if not c: return None',
  '        b += c',
  '    return b',
  'def _send(o):',
  '    d = json.dumps(o).encode("utf-8")',
  '    _out.write(b"%010d" % len(d)); _out.write(d); _out.flush()',
  '_send({"ready": True})',
  'while True:',
  '    h = _read_exactly(10)',
  '    if h is None: break',
  '    try: n = int(h)',
  '    except Exception: break',
  '    code = _read_exactly(n)',
  '    if code is None: break',
  '    code = code.decode("utf-8", "replace")',
  '    importlib.invalidate_caches()',  // 让 pip_install 刚装的包在持久 kernel 里立即可 import
  '    so, se = io.StringIO(), io.StringIO()',
  '    oo, oe = sys.stdout, sys.stderr',
  '    sys.stdout, sys.stderr = so, se',
  '    ok = True',
  '    try:',
  '        exec(compile(code, "<run_python>", "exec"), _G)',
  '    except SystemExit:',
  '        pass',
  '    except BaseException:',
  '        ok = False; traceback.print_exc()',
  '    finally:',
  '        sys.stdout, sys.stderr = oo, oe',
  '    _send({"stdout": so.getvalue(), "stderr": se.getvalue(), "ok": ok})',
].join('\n');

interface KernelResult { stdout: string; stderr: string; ok: boolean; }

/** 容器内持久 python 进程的宿主侧句柄。调用方保证串行 exec（同一时刻至多一个 pending）。 */
class PythonKernel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  dead = false;
  private pending: ((r: KernelResult) => void) | null = null;
  private readyResolve: ((ok: boolean) => void) | null = null;

  constructor(private readonly containerName: string) {}

  start(timeoutMs = KERNEL_START_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => { this.dead = true; done(false); }, timeoutMs);
      try {
        this.child = spawn('docker', ['exec', '-i', this.containerName, 'python3', '-u', '-c', KERNEL_DRIVER],
          { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { this.dead = true; return done(false); }
      this.readyResolve = (ok) => done(ok);
      this.child.stdout.on('data', (d: Buffer) => this.onData(d));
      this.child.stderr.on('data', () => { /* driver 级 stderr：忽略（执行级 stderr 走帧） */ });
      this.child.on('error', () => { this.dead = true; this.failAll(); done(false); });
      this.child.on('exit', () => { this.dead = true; this.failAll(); done(false); });
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 10) {
      const len = parseInt(this.buf.subarray(0, 10).toString('ascii'), 10);
      if (!Number.isFinite(len) || len < 0) { this.dead = true; this.failAll(); return; } // 帧损坏
      if (this.buf.length < 10 + len) break;
      const payload = this.buf.subarray(10, 10 + len).toString('utf-8');
      this.buf = this.buf.subarray(10 + len);
      let obj: any = null;
      try { obj = JSON.parse(payload); } catch { /* 损坏帧 */ }
      if (obj && obj.ready) {
        const r = this.readyResolve; this.readyResolve = null; r?.(true);
        continue;
      }
      const p = this.pending; this.pending = null;
      p?.({ stdout: obj?.stdout || '', stderr: obj?.stderr || '', ok: !!(obj && obj.ok) });
    }
  }

  private failAll(): void {
    const p = this.pending; this.pending = null;
    p?.({ stdout: '', stderr: '[kernel died]', ok: false });
    const r = this.readyResolve; this.readyResolve = null; r?.(false);
  }

  exec(code: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; ok: boolean; timedOut: boolean; aborted: boolean }> {
    return new Promise((resolve) => {
      if (this.dead || !this.child) {
        resolve({ stdout: '', stderr: '[kernel unavailable]', ok: false, timedOut: false, aborted: false });
        return;
      }
      let settled = false;
      const finish = (r: KernelResult, timedOut: boolean, aborted: boolean) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ ...r, timedOut, aborted });
      };
      // 超时/中止：标记 kernel 死亡（容器由调用方真停）；in-container 代码随容器被杀而停。
      const timer = setTimeout(() => { this.dead = true; finish({ stdout: '', stderr: '[timed out]', ok: false }, true, false); }, timeoutMs);
      const onAbort = () => { this.dead = true; finish({ stdout: '', stderr: '[aborted]', ok: false }, false, true); };
      if (signal) {
        if (signal.aborted) { this.dead = true; finish({ stdout: '', stderr: '[aborted]', ok: false }, false, true); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending = (r) => finish(r, false, false);
      try {
        const codeBuf = Buffer.from(code, 'utf-8');
        const hdr = Buffer.from(String(codeBuf.length).padStart(10, '0'), 'ascii');
        this.child.stdin.write(hdr);
        this.child.stdin.write(codeBuf);
      } catch {
        this.dead = true;
        finish({ stdout: '', stderr: '[kernel write failed]', ok: false }, false, false);
      }
    });
  }

  dispose(): void {
    this.dead = true;
    try { this.child?.stdin.end(); } catch { /* ignore */ }
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
  }
}

// ── 会话状态 ──────────────────────────────────────────────────────────────
interface Session {
  ks: string;
  key: SessionKey;
  id: string;            // 容器/目录名用的短 hash
  dir: string;           // 常驻本地工作区目录
  manifest: Map<string, string>; // 相对路径 → sha256（diff snapshot 基线，回写后更新）
  hydrated: boolean;
  hydrating: Promise<void> | null;
  containerName: string | null;
  kernel: PythonKernel | null;
  lastUsed: number;
  dirty: boolean;        // 有未回写的本地改动
  lock: Promise<unknown>; // per-session 串行链（kernel exec / snapshot / 容器生命周期）
}

const sessions = new Map<string, Session>();

function keyStr(k: SessionKey): string {
  return k.wsProject
    ? `${k.userId} ${k.appId} proj:${k.wsProject}`
    : `${k.userId} ${k.appId} ${k.sessionId}`;
}
function shortId(k: SessionKey): string {
  return createHash('sha1').update(keyStr(k)).digest('hex').slice(0, 24);
}

/** per-session 串行锁：保证同一会话的 exec / snapshot / 容器创建不并发交错。 */
function withSessionLock<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const run = s.lock.then(fn, fn);
  s.lock = run.then(() => undefined, () => undefined);
  return run;
}

function getUidGidArgs(): string[] {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;
    if (uid != null && gid != null) return ['--user', `${uid}:${gid}`];
  } catch { /* 非 POSIX */ }
  return [];
}

// 容器内唯一「持久可写」的地方就是会话工作区（绑到 /workspace，并额外绑到 /mnt/data，
// 因为 code-interpreter 训练出来的模型常默认往 /mnt/data 写——两者指向同一宿主目录，
// 都会被 snapshot 回流到本会话云端工作区）。其余 rootfs 只读；HOME / 各类库缓存指到
// 临时 /tmp（易失、不回流），避免缓存写穿只读 rootfs 报错、也避免污染用户工作区。
const SANDBOX_ENV: Record<string, string> = {
  PYTHONPATH: '/pkgs',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  MPLCONFIGDIR: '/tmp/mpl',
  XDG_CACHE_HOME: '/tmp/.cache',
  XDG_CONFIG_HOME: '/tmp/.config',
  XDG_DATA_HOME: '/tmp/.local',
};
function sandboxEnvArgs(): string[] {
  return Object.entries(SANDBOX_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/** 起一个会话暖容器（sleep infinity，绑定会话工作区目录）。 */
async function dockerRunContainer(name: string, dir: string, image: string): Promise<boolean> {
  await new Promise<void>((r) => execFile('docker', ['rm', '-f', name], () => r())); // 清同名残留
  const args = [
    'run', '-d', '--name', name, '--init',
    '--network', 'none', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,size=64m',
    ...getUidGidArgs(),
    // 会话工作区：唯一持久可写处，/workspace 与 /mnt/data 同指它。
    '-v', `${dir}:/workspace:rw`, '-v', `${dir}:/mnt/data:rw`,
    '-v', `${PKG_DIR}:/pkgs:ro`,
    ...sandboxEnvArgs(),
    '--workdir', '/workspace', '--entrypoint', 'sleep', image, 'infinity',
  ];
  return new Promise<boolean>((resolve) => {
    execFile('docker', args, { timeout: 60_000 }, (err) => resolve(!err));
  });
}

/** 真停并清掉会话容器（runaway / abort / 淘汰）；保留 dir + manifest，下次懒重建。 */
function disposeContainer(s: Session): void {
  const name = s.containerName;
  s.kernel?.dispose();
  s.kernel = null;
  s.containerName = null;
  if (name) execFile('docker', ['rm', '-f', name], () => {});
}

/** 确保会话工作区目录已从 Penzor hydrate（整会话只拉一次）。并发首调用去重。
 *  重 hydrate(refreshSessionWorkspace 之后)会**清理云端已删文件**:上轮来自云端(旧 manifest 有)、
 *  本轮云端没有、且本地未被改动(sha 仍等于旧 manifest)的文件删掉——否则跨端删除的文件残留本地,
 *  下次 snapshot 又被当新文件回写云端(删除被悄悄撤销)。本地改过/新建的文件一律保留(冲突保守留数据)。 */
async function ensureHydrated(s: Session): Promise<void> {
  if (s.hydrated) return;
  if (!s.hydrating) {
    s.hydrating = (async () => {
      await fsp.mkdir(s.dir, { recursive: true }).catch(() => {});
      const prev = s.manifest;
      try {
        const r = await hydrateWorkspaceToDir(s.key.userId, s.key.appId, scopeOf(s.key), s.dir);
        s.manifest = r.manifest;
        // 只有权威完整快照(complete)才可据缺席判「云端已删」——部分失败的缺席可能只是网络抖。
        if (r.complete) {
          for (const [rel, hash] of prev) {
            if (s.manifest.has(rel)) continue;
            const abs = path.join(s.dir, rel);
            const buf = await fsp.readFile(abs).catch(() => null);
            if (buf && createHash('sha256').update(buf).digest('hex') === hash) {
              await fsp.rm(abs, { force: true }).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.warn('[agent-core] session workspace hydrate failed:', e);
        s.manifest = new Map();
      }
      s.hydrated = true;
    })();
  }
  await s.hydrating;
}

function evictIfOverCap(): void {
  while (sessions.size >= MAX_SESSIONS) {
    let lruKey: string | null = null;
    let lruAt = Infinity;
    for (const [ks, s] of sessions) {
      if (s.lastUsed < lruAt) { lruAt = s.lastUsed; lruKey = ks; }
    }
    if (!lruKey) break;
    void disposeSession(lruKey); // fire-and-forget（含 best-effort snapshot）
  }
}

async function getOrCreateSession(k: SessionKey): Promise<Session> {
  const ks = keyStr(k);
  let s = sessions.get(ks);
  if (!s) {
    evictIfOverCap();
    s = {
      ks, key: k, id: shortId(k), dir: path.join(BASE_DIR, shortId(k)),
      manifest: new Map(), hydrated: false, hydrating: null,
      containerName: null, kernel: null, lastUsed: Date.now(), dirty: false, lock: Promise.resolve(),
    };
    sessions.set(ks, s);
  }
  s.lastUsed = Date.now();
  await ensureHydrated(s);
  return s;
}

/** 确保暖容器 + 持久 kernel 就绪（仅 run_python 触发；在 session 锁内调用，无并发竞态）。 */
async function ensureContainerKernel(s: Session): Promise<boolean> {
  if (s.containerName && s.kernel && !s.kernel.dead) return true;
  // 残留清理（kernel 死但容器名还在）
  if (s.containerName && (!s.kernel || s.kernel.dead)) disposeContainer(s);
  const image = await resolvePythonImage();
  await ensurePkgDir();
  const name = `agent-sess-${s.id}`;
  const okC = await dockerRunContainer(name, s.dir, image);
  if (!okC) { s.containerName = null; s.kernel = null; return false; }
  s.containerName = name;
  const k = new PythonKernel(name);
  const okK = await k.start();
  if (!okK) { k.dispose(); disposeContainer(s); return false; }
  s.kernel = k;
  return true;
}

// ── 对外 API（registry / agentLoop 调用）────────────────────────────────────

/** 取会话本地工作区目录（首次触发懒 hydrate）。供文件工具本地读写。 */
export async function getSessionDir(k: SessionKey): Promise<string> {
  const s = await getOrCreateSession(k);
  return s.dir;
}

/** 标记会话工作区有未回写改动（write_file 后调用），驱动 run 末 snapshot。 */
export function markSessionDirty(k: SessionKey): void {
  const s = sessions.get(keyStr(k));
  if (s) { s.dirty = true; s.lastUsed = Date.now(); }
}

/** 使沙箱的懒 hydrate 失效(run 开始时调):下次文件操作重新从云端拉取,看见其它端/会话
 *  在此期间写入的 Project 文件与客户端新上传的文件。dirty(上次 snapshot 失败残留)时不失效,
 *  防止重 hydrate 覆盖未回写的本地改动——那些文件留在目录里,下次 snapshot 自动重试回写。 */
export function refreshSessionWorkspace(k: SessionKey): void {
  const s = sessions.get(keyStr(k));
  if (s && s.hydrated && !s.dirty) { s.hydrated = false; s.hydrating = null; }
}

/** 在会话持久 kernel 里执行 Python（跨调用保留 import/变量）。失败回退 ephemeral（挂同一本地目录）。 */
export async function runPythonInSession(
  k: SessionKey,
  code: string,
  opts?: { signal?: AbortSignal; runId?: string; timeoutMs?: number },
): Promise<ExecResult> {
  const s = await getOrCreateSession(k);
  return withSessionLock(s, async () => {
    s.dirty = true;
    s.lastUsed = Date.now();
    const ok = await ensureContainerKernel(s);
    if (!ok || !s.kernel) {
      // 回退：ephemeral 容器挂会话目录（仍受益于已 hydrate 的本地工作区，不必重拉 OSS）。
      return runPython(code, { mountDir: s.dir, signal: opts?.signal, runId: opts?.runId });
    }
    await acquireSlot();
    const cname = s.containerName!;
    const startedAt = beginExec(cname, opts?.runId ?? null, 'python:session');
    try {
      const r = await s.kernel.exec(code, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts?.signal);
      endExec(cname, opts?.runId ?? null, 'python:session', startedAt, {
        exitCode: r.ok ? 0 : 1, timedOut: r.timedOut, aborted: r.aborted,
      });
      // 超时/中止/kernel 死 → 真停容器（停掉容器内 runaway 代码并释放），下次懒重建。
      if (r.timedOut || r.aborted || s.kernel?.dead) disposeContainer(s);
      return {
        // 不在此预截到 MAX_OUTPUT：放行到 MAX_CAPTURE，让 registry 决定预览+落盘还是直接回。
        stdout: r.stdout.slice(0, MAX_CAPTURE),
        stderr: r.stderr.slice(0, MAX_CAPTURE),
        exitCode: r.ok ? 0 : 1,
        timedOut: r.timedOut,
        aborted: r.aborted,
      };
    } finally {
      releaseSlot();
    }
  });
}

/** run 末把会话本地改动按 diff 选择性回写 Penzor（更新基线 manifest）。保持沙箱温（不杀）。 */
export async function snapshotSession(k: SessionKey): Promise<string[]> {
  const s = sessions.get(keyStr(k));
  if (!s || !s.hydrated || !s.dirty) return [];
  return withSessionLock(s, async () => {
    if (!s.dirty) return [];
    let changed: string[] = [];
    try {
      changed = await snapshotDirToWorkspace(s.key.userId, s.key.appId, scopeOf(s.key), s.dir, s.manifest);
    } catch (e) {
      console.warn('[agent-core] session snapshot failed:', e);
    }
    s.dirty = false;
    s.lastUsed = Date.now();
    return changed;
  });
}

/** 彻底回收一个会话：best-effort snapshot + 杀容器 + 删本地目录。 */
export async function disposeSession(ks: string): Promise<void> {
  const s = sessions.get(ks);
  if (!s) return;
  sessions.delete(ks);
  if (s.dirty && s.hydrated) {
    try { await snapshotDirToWorkspace(s.key.userId, s.key.appId, scopeOf(s.key), s.dir, s.manifest); } catch { /* best-effort */ }
  }
  disposeContainer(s);
  await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

// ── 后台维护 ────────────────────────────────────────────────────────────────
let reaperTimer: ReturnType<typeof setInterval> | null = null;
/** 空闲 TTL 回收器（默认每 60s 扫一次）。幂等。 */
export function startSessionReaper(intervalMs = 60_000): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [ks, s] of sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) void disposeSession(ks);
    }
  }, intervalMs);
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();
}

/** 停止会话回收器(dispose/热加载用)。 */
export function stopSessionReaper(): void {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
}

/** 进程启动时清理上个进程遗留的 agent-sess-* 容器 + 会话目录（孤儿）。 */
export function reapOrphanSessions(): void {
  execFile('docker', ['ps', '-aq', '--filter', 'name=agent-sess-'], { timeout: 5000 }, (err, stdout) => {
    if (!err && stdout) {
      const ids = String(stdout).split('\n').map((x) => x.trim()).filter(Boolean);
      if (ids.length) execFile('docker', ['rm', '-f', ...ids], () => {});
    }
  });
  // 清空会话工作区根目录（重启后本地缓存失效，权威数据在 Penzor）。
  fsp.rm(BASE_DIR, { recursive: true, force: true }).catch(() => {});
}

/** 进程内会话沙箱快照（供 admin 面板观测）。 */
export function getSessionSnapshot() {
  return {
    count: sessions.size,
    maxSessions: MAX_SESSIONS,
    ttlMs: SESSION_TTL_MS,
    sessions: Array.from(sessions.values()).map((s) => ({
      id: s.id,
      hasContainer: !!s.containerName,
      kernelAlive: !!(s.kernel && !s.kernel.dead),
      dirty: s.dirty,
      idleMs: Date.now() - s.lastUsed,
    })),
  };
}
