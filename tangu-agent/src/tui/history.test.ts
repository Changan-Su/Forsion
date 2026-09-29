/**
 * 输入历史的跨进程并发(Codex 评审 tui #3 / 复核 #6):两个 tangu 同时开,旧版「读 → 追加 → 原子替换整份」
 * 会让后 rename 的进程吞掉先写的那行;改成追加式后,「偶尔整理」仍是「读 → 截 → rename」,读与 rename 之间
 * 别人的追加会被旧快照盖掉 —— 只比文件大小关不死(比完、rename 前追加照丢)。现在整条落盘都在跨进程锁里。这里:
 *   - 确定性:在「我们读完盘」与「我们写盘」之间插一次不守锁的裸追加(包一层 readFileSync 钩子),别人的行必须还在;
 *   - 确定性 + 真进程:我们整理到「比完大小、rename 之前」那一刻,另起一个真 tangu 进程去记一行(包一层 renameSync
 *     钩子),它的行必须还在(旧实现在这里丢行 —— 复核 #6 的原样场景);
 *   - 确定性 + 真进程(复核 R2):同上,但我们在「核完 → rename」之间卡过了 10s 陈旧时限(把锁 mtime 调回 60s 前)——
 *     同机、pid 活着的持有者不许按 10s 被抢,另一个 tangu 得等我们整理完再写,它的行必须还在;
 *   - 锁本身:活着的持有者 → 不整理只追加、不动人家的锁(哪怕锁已 60s 没动);持有者进程已不在 / 异机锁 10s 没动 /
 *     同机活 pid 的锁 10 分钟没动(pid 复用)→ 破锁照常整理;破锁时挪走的若是别人刚拿到的新锁 → 原样放回;
 *   - Windows 删除挂起:open 报 EPERM/EACCES 在 win32 上按「被占」等(不当成没法上锁),且不空转;POSIX 上仍立刻放弃;
 *   - 真并发:4 个子进程同时各记 150 条,一条都不能少;开着整理再各记 150 条,每个进程自己的行在盘上必须是连续后缀。
 * 其余规则(去重 / 密钥不落盘 / 仅本人可读)见 tui.commands.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyLockFile, loadHistory, persistHistoryLine, serializeHistory } from './history.js';

const hook = vi.hoisted(() => ({
  afterRead: null as null | ((file: string) => void),
  /** 真 rename 之前跑一次(只认目标路径 === target)。 */
  beforeRename: null as null | { target: (to: string) => boolean; fn: (to: string) => void },
  /** 整理写完临时文件之后跑一次。 */
  afterTmpWrite: null as null | (() => void),
  /** 独占创建历史锁时前 times 次抛 code(模拟 Windows 删除挂起);calls 记总共试了几次。 */
  lockOpen: null as null | { code: string; times: number; calls: number },
}));

// 包 readFileSync:读到历史文件本体后跑一次钩子(模拟「别的进程恰好在这时追加了一行」);
// 包 renameSync:rename 到指定目标之前跑一次钩子;包 writeFileSync:写完整理的临时文件后跑一次钩子。其余原样。
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const out = real.readFileSync(...args);
    const f = hook.afterRead;
    if (f && typeof args[0] === 'string' && /tui_history[^/\\]*$/.test(args[0]) && !/\.(tmp|lock|stale)$/.test(args[0])) {
      hook.afterRead = null;
      f(args[0]);
    }
    return out;
  }) as typeof real.readFileSync;
  const renameSync = ((from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
    const h = hook.beforeRename;
    if (h && typeof to === 'string' && h.target(to)) {
      hook.beforeRename = null;
      h.fn(to);
    }
    return real.renameSync(from, to);
  }) as typeof real.renameSync;
  const writeFileSync = ((...args: Parameters<typeof real.writeFileSync>) => {
    real.writeFileSync(...args);
    const f = hook.afterTmpWrite;
    if (f && typeof args[0] === 'string' && /tui_history[^/\\]*\.tmp$/.test(args[0])) {
      hook.afterTmpWrite = null;
      f();
    }
  }) as typeof real.writeFileSync;
  const openSync = ((...args: Parameters<typeof real.openSync>) => {
    const h = hook.lockOpen;
    if (h && typeof args[0] === 'string' && /tui_history[^/\\]*\.lock$/.test(args[0]) && args[1] === 'wx') {
      h.calls++;
      if (h.calls <= h.times) throw Object.assign(new Error(`${h.code}: operation not permitted, open '${args[0]}'`), { code: h.code });
    }
    return real.openSync(...args);
  }) as typeof real.openSync;
  const patched = { readFileSync, renameSync, writeFileSync, openSync };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

const require = createRequire(import.meta.url);
const viteNode = join(require.resolve('vite-node/package.json'), '..', 'vite-node.mjs');
const historyTs = fileURLToPath(new URL('./history.ts', import.meta.url));
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const exited = (cp: ChildProcess): Promise<number | null> =>
  cp.exitCode !== null || cp.signalCode !== null ? Promise.resolve(cp.exitCode) : new Promise((resolve) => cp.once('exit', (code) => resolve(code)));
const E6 = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
/** 一个肯定不在的 pid(macOS pid 上限 99998,Linux pid_max 上限 2^22)。 */
const DEAD_PID = 2 ** 22 + 4321;
const backdate = (path: string, ms: number): void => {
  const old = new Date(Date.now() - ms);
  utimesSync(path, old, old);
};
/** 把 process.platform 临时换成 p 跑 fn(锁的「被占」判定按调用时平台走,这样在任何 runner 上含义都一样)。 */
const asPlatform = <T,>(p: NodeJS.Platform, fn: () => T): T => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...orig, value: p });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
};

describe('input history across processes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tangu-tui-hist-conc-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    // 某条用例红了没消费掉的钩子,别漏到下一条
    hook.afterRead = null;
    hook.beforeRename = null;
    hook.afterTmpWrite = null;
    hook.lockOpen = null;
  });

  /** 这份历史文件的锁 / 临时文件 / 破锁挪出来的旧锁:每次落盘结束都不该留下(按文件名隔离,一条红了不连累别条)。 */
  const leftovers = (file: string): string[] =>
    readdirSync(dir).filter((n) => n.startsWith(`${basename(file)}.`) && /\.(tmp|lock|stale)$/.test(n));
  const otherProcessAppends = (line: string) => (file: string): void => {
    appendFileSync(file, serializeHistory([line]));
  };
  const writeLock = (file: string, holder: { pid: number; host: string; token: string }): string => {
    const lock = historyLockFile(file);
    writeFileSync(lock, JSON.stringify(holder));
    return lock;
  };

  it('a line another process appends between our read and our write survives', () => {
    const file = join(dir, 'tui_history_race');
    writeFileSync(file, serializeHistory(['old']));
    hook.afterRead = otherProcessAppends('from-other-tangu');
    persistHistoryLine('mine', file);
    expect(hook.afterRead).toBeNull(); // 钩子确实在我们读盘之后触发过
    expect(loadHistory(file)).toEqual(['old', 'from-other-tangu', 'mine']);
    expect(leftovers(file)).toEqual([]);
  });

  it('compacts to the newest `limit` entries once the file reaches 2×limit; an unlocked writer mid-compaction makes it back off', () => {
    const file = join(dir, 'tui_history_compact');
    writeFileSync(file, serializeHistory(E6));
    persistHistoryLine('x', file, 3);
    expect(readFileSync(file, 'utf8')).toBe(serializeHistory(['e5', 'e6', 'x']));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);

    // 边界(文档口径「盘上最多约 2×limit 条」):还差一条到 2×limit 时只追加、不整理,文件恰好攒到 2×limit 条;下一条才整理。
    const edge = join(dir, 'tui_history_compact_edge');
    writeFileSync(edge, serializeHistory(['e1', 'e2', 'e3', 'e4', 'e5']));
    persistHistoryLine('x', edge, 3);
    expect(loadHistory(edge, 100)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'x']);
    persistHistoryLine('y', edge, 3);
    expect(loadHistory(edge, 100)).toEqual(['e5', 'x', 'y']);

    // 不守锁的写者(手工编辑 / 裸 append)在我们读完后追加:rename 前的大小核对兜住,这次不整理、照常追加。
    const file2 = join(dir, 'tui_history_compact_race');
    writeFileSync(file2, serializeHistory(E6));
    hook.afterRead = otherProcessAppends('from-other-tangu');
    persistHistoryLine('y', file2, 3);
    expect(loadHistory(file2, 100)).toEqual([...E6, 'from-other-tangu', 'y']);
    expect(leftovers(file)).toEqual([]);
    expect(leftovers(edge)).toEqual([]);
    expect(leftovers(file2)).toEqual([]); // 放弃整理不留临时文件,锁也放掉了
  });

  /**
   * 钩在我们整理的 rename 之前(此时「锁还是我的」+ 大小都已核对过):先跑 prep,再另起一个真 tangu 进程去记 line,
   * 等它就位后给它最多 1.5s 写完。它的等锁上限给 10s(远大于这 1.5s):守锁的实现里它此刻卡在等锁、写不完,我们整理完
   * 放锁它才写;不守锁 / 把我们的锁破了的实现里它很快写完(done 标记一出现就不再干等),随即被我们的 rename 盖掉。
   * 子进程写没写完只能看文件标记 —— 钩子里同步睡着,事件循环收不到 exit。
   */
  const recordFromOtherProcessBeforeRename = (file: string, line: string, limit: number, prep?: () => void) => {
    const script = join(dir, 'child_one.ts');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\n` +
        `import { persistHistoryLine } from ${JSON.stringify(historyTs)};\n` +
        `const [file, ready, done, line, limit, waitMs] = process.argv.slice(2);\n` +
        `writeFileSync(ready, 'ready');\n` + // 模块已载入,下一句就去记这一行
        `persistHistoryLine(line, file, Number(limit), { waitMs: Number(waitMs) });\n` +
        `writeFileSync(done, 'done');\n`,
    );
    const rec = { child: null as ChildProcess | null, stderr: '', ready: `${file}-child.ready`, done: `${file}-child.done` };
    hook.beforeRename = {
      target: (to) => to === file,
      fn: () => {
        prep?.();
        const cp = spawn(process.execPath, [viteNode, script, file, rec.ready, rec.done, line, String(limit), '10000'], { stdio: ['ignore', 'ignore', 'pipe'] });
        rec.child = cp;
        cp.stderr?.on('data', (d) => (rec.stderr += String(d)));
        const until = Date.now() + 30_000;
        while (!existsSync(rec.ready) && Date.now() < until) sleepSync(20);
        const settle = Date.now() + 1500;
        while (!existsSync(rec.done) && Date.now() < settle) sleepSync(10);
      },
    };
    return rec;
  };
  const expectOtherProcessLineKept = async (file: string, rec: ReturnType<typeof recordFromOtherProcessBeforeRename>): Promise<void> => {
    expect(hook.beforeRename).toBeNull(); // 钩子确实在整理的 rename 之前触发过
    expect(rec.child).not.toBeNull();
    const code = await exited(rec.child!);
    expect(existsSync(rec.ready), rec.stderr).toBe(true);
    expect(code, rec.stderr).toBe(0);
    expect(existsSync(rec.done), rec.stderr).toBe(true);
    expect(loadHistory(file, 100)).toEqual(['e5', 'e6', 'mine', 'from-other-tangu']);
    expect(leftovers(file)).toEqual([]);
  };

  // Codex 复核 #6 的原样场景:大小已核对过、rename 还没做,另一个 tangu 进程此刻记一行。
  // 旧实现:它的行进了旧 inode,随即被 rename 盖掉。现在:它卡在等锁,我们整理完放锁后它才追加。
  it.skipIf(process.platform === 'win32')('another tangu process recording a line while we are between the size check and the rename is not clobbered', async () => {
    const file = join(dir, 'tui_history_compact_proc');
    writeFileSync(file, serializeHistory(E6));
    const rec = recordFromOtherProcessBeforeRename(file, 'from-other-tangu', 3);
    persistHistoryLine('mine', file, 3);
    await expectOtherProcessLineKept(file, rec);
  }, 90_000);

  // Codex 复核 R2 #1 的原样场景:同上,但我们在「核完 → rename」之间卡过了 10s 陈旧时限(合盖 / SIGSTOP)。
  // 旧实现:对方见锁 10s 没动就破锁、在锁下写完,我们恢复后的 rename 把它盖掉。现在:同机 pid 活着 → 不按 10s 抢,它等我们。
  it.skipIf(process.platform === 'win32')('a live holder stalled past staleMs between its checks and its rename keeps its lock; the other tangu waits and its line survives', async () => {
    const file = join(dir, 'tui_history_compact_stalled');
    writeFileSync(file, serializeHistory(E6));
    const lock = historyLockFile(file);
    let held = false; // 钩子里的异常会被整理的 try/catch 吞掉,记下来出钩子再断言
    const rec = recordFromOtherProcessBeforeRename(file, 'from-other-tangu', 3, () => {
      held = existsSync(lock);
      if (held) backdate(lock, 60_000);
    });
    persistHistoryLine('mine', file, 3);
    expect(held, 'we must hold the lock at rename time').toBe(true);
    await expectOtherProcessLineKept(file, rec);
  }, 90_000);

  it('a fresh lock held by a live process: never compacts, falls back to a plain append after the wait, and leaves that lock alone', () => {
    const file = join(dir, 'tui_history_lock_live');
    writeFileSync(file, serializeHistory(E6));
    const holder = { pid: process.pid, host: hostname(), token: 'someone-else' }; // 本进程 = 肯定活着
    const lock = writeLock(file, holder);
    const t0 = Date.now();
    persistHistoryLine('x', file, 3, { waitMs: 150 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // 真等过锁
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']); // 没整理:没拿到锁时整理会盖掉持锁者正在写的行
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(holder); // 不是自己的锁不删、不改
    unlinkSync(lock);
    expect(leftovers(file)).toEqual([]);
  });

  it('a lock whose holder process is gone is broken at once and compaction proceeds', () => {
    const file = join(dir, 'tui_history_lock_dead');
    writeFileSync(file, serializeHistory(E6));
    writeLock(file, { pid: DEAD_PID, host: hostname(), token: 'crashed' });
    const t0 = Date.now();
    persistHistoryLine('x', file, 3, { waitMs: 5000, staleMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(2000); // 不等时限:同机 pid 已不在就判陈旧
    expect(loadHistory(file, 100)).toEqual(['e5', 'e6', 'x']);
    expect(leftovers(file)).toEqual([]);
  });

  it('a lock that has not been touched for staleMs is broken when its pid cannot be checked (other host)', () => {
    const file = join(dir, 'tui_history_lock_old');
    writeFileSync(file, serializeHistory(E6));
    const lock = writeLock(file, { pid: process.pid, host: 'some-other-host', token: 'ancient' });
    backdate(lock, 60_000);
    persistHistoryLine('x', file, 3, { waitMs: 2000, staleMs: 10_000 });
    expect(loadHistory(file, 100)).toEqual(['e5', 'e6', 'x']);
    expect(leftovers(file)).toEqual([]);
  });

  it('a same-host lock whose pid is alive is not broken at staleMs (the holder may be stalled mid-compaction): wait, then plain append', () => {
    const file = join(dir, 'tui_history_lock_live_old');
    writeFileSync(file, serializeHistory(E6));
    const holder = { pid: process.pid, host: hostname(), token: 'stalled' }; // 本进程 = 肯定活着
    const lock = writeLock(file, holder);
    backdate(lock, 60_000); // 远超 staleMs
    const t0 = Date.now();
    persistHistoryLine('x', file, 3, { waitMs: 150, staleMs: 10_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // 真等过锁,没破
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']); // 没整理
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(holder); // 锁原样
    unlinkSync(lock);
    expect(leftovers(file)).toEqual([]);
  });

  it('a same-host lock whose pid is alive but untouched for 10 minutes is broken (crashed holder, pid reused)', () => {
    const file = join(dir, 'tui_history_lock_live_ancient');
    writeFileSync(file, serializeHistory(E6));
    const lock = writeLock(file, { pid: process.pid, host: hostname(), token: 'pid-reused' });
    backdate(lock, 11 * 60_000);
    persistHistoryLine('x', file, 3, { waitMs: 2000, staleMs: 10_000 });
    expect(loadHistory(file, 100)).toEqual(['e5', 'e6', 'x']);
    expect(leftovers(file)).toEqual([]);
  });

  // Windows:锁文件「删除挂起」(杀软 / 另一个 tangu 还开着)时独占创建报 EPERM/EACCES —— 那是「被占」,不是「没法上锁」。
  it('win32: EPERM/EACCES on creating the lock counts as busy (wait and retry), and waiting on it does not spin', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const file = join(dir, `tui_history_win_busy_${code}`);
      writeFileSync(file, serializeHistory(E6));
      hook.lockOpen = { code, times: 3, calls: 0 };
      asPlatform('win32', () => persistHistoryLine('x', file, 3, { waitMs: 2000 }));
      expect(hook.lockOpen.calls).toBe(4); // 挂起 3 次后拿到锁
      expect(loadHistory(file, 100)).toEqual(['e5', 'e6', 'x']); // 拿到锁才整理(旧实现当成没法上锁 → 只追加)
      expect(leftovers(file)).toEqual([]);
    }
    // 一直挂起:等到时限后退回只追加;期间按轮询间隔睡,不空转(stat 也失败,没有「刚被放掉」可抢)
    const file = join(dir, 'tui_history_win_busy_forever');
    writeFileSync(file, serializeHistory(E6));
    hook.lockOpen = { code: 'EPERM', times: Infinity, calls: 0 };
    const t0 = Date.now();
    asPlatform('win32', () => persistHistoryLine('x', file, 3, { waitMs: 100 }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(hook.lockOpen.calls).toBeGreaterThan(1);
    expect(hook.lockOpen.calls).toBeLessThan(60); // 5ms 一轮 ≈ 20 次;空转会是成千上万次
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']);
    expect(leftovers(file)).toEqual([]);
  });

  it('POSIX: EPERM on creating the lock is a real permission error — give up at once (no waiting), plain append', () => {
    const file = join(dir, 'tui_history_posix_eperm');
    writeFileSync(file, serializeHistory(E6));
    hook.lockOpen = { code: 'EPERM', times: Infinity, calls: 0 };
    const t0 = Date.now();
    asPlatform('linux', () => persistHistoryLine('x', file, 3, { waitMs: 2000 }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hook.lockOpen.calls).toBe(1);
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']);
    expect(leftovers(file)).toEqual([]);
  });

  it('breaking a stale lock never deletes a fresh lock another process grabbed in the meantime', () => {
    const file = join(dir, 'tui_history_lock_steal');
    writeFileSync(file, serializeHistory(E6));
    const lock = writeLock(file, { pid: DEAD_PID, host: hostname(), token: 'crashed' });
    const fresh = { pid: process.pid, host: hostname(), token: 'fresh-holder' };
    // 我们判陈旧、正要把它挪开的那一刻:另一个进程抢先破了旧锁并拿到新锁(我们挪走的会是它的新锁)。
    hook.beforeRename = {
      target: (to) => to.startsWith(`${lock}.`) && to.endsWith('.stale'),
      fn: () => {
        unlinkSync(lock);
        writeFileSync(lock, JSON.stringify(fresh));
      },
    };
    persistHistoryLine('x', file, 3, { waitMs: 150 });
    expect(hook.beforeRename).toBeNull();
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(fresh); // 原样放回
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']); // 锁在别人手里:不整理,只追加
    unlinkSync(lock);
    expect(leftovers(file)).toEqual([]);
  });

  it('if our lock was broken mid-compaction before our checks (other host past staleMs / same host past 10 min), we do not rename over the file and do not delete the new holder\'s lock', () => {
    const file = join(dir, 'tui_history_lock_lost');
    writeFileSync(file, serializeHistory(E6));
    const lock = historyLockFile(file);
    const thief = { pid: process.pid, host: hostname(), token: 'took-over' };
    hook.afterTmpWrite = () => {
      // 模拟:我们卡住超过陈旧时限,别的进程破了我们的锁并拿到新锁
      unlinkSync(lock);
      writeFileSync(lock, JSON.stringify(thief));
    };
    persistHistoryLine('x', file, 3);
    expect(hook.afterTmpWrite).toBeNull(); // 确实走到了整理
    expect(loadHistory(file, 100)).toEqual([...E6, 'x']); // 放弃整理,照常追加
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(thief); // 不删接手者的锁
    unlinkSync(lock);
    expect(leftovers(file)).toEqual([]);
  });

  it('dedupes against the last line on disk; appending to a hand-edited file without a trailing newline stays line-safe', () => {
    const file = join(dir, 'tui_history_tail');
    writeFileSync(file, 'plain line');
    persistHistoryLine('next', file);
    persistHistoryLine('next', file);
    expect(loadHistory(file)).toEqual(['plain line', 'next']);
    // 两个进程撞车各记了一次同一条:读时折叠
    appendFileSync(file, serializeHistory(['next']));
    expect(loadHistory(file)).toEqual(['plain line', 'next']);
    expect(existsSync(file)).toBe(true);
  });

  const runProcs = async (file: string, tags: string[], n: number, limit: number): Promise<void> => {
    const child = join(dir, 'child.ts');
    writeFileSync(
      child,
      `import { persistHistoryLine } from ${JSON.stringify(historyTs)};\n` +
        `const [file, tag, n, limit] = process.argv.slice(2);\n` +
        `for (let i = 0; i < Number(n); i++) persistHistoryLine(tag + '-' + i, file, Number(limit));\n`,
    );
    await Promise.all(
      tags.map(
        (tag) =>
          new Promise<void>((resolve, reject) =>
            execFile(process.execPath, [viteNode, child, file, tag, String(n), String(limit)], { timeout: 60_000 }, (err, _o, stderr) =>
              err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(),
            ),
          ),
      ),
    );
  };

  it.skipIf(process.platform === 'win32')('4 concurrent processes × 150 lines: nothing is lost', async () => {
    const file = join(dir, 'tui_history_procs');
    const tags = ['a', 'b', 'c', 'd'];
    await runProcs(file, tags, 150, 100000);
    const got = new Set(loadHistory(file, 100000));
    const missing = tags.flatMap((t) => Array.from({ length: 150 }, (_, i) => `${t}-${i}`)).filter((l) => !got.has(l));
    expect(missing).toEqual([]);
    expect(leftovers(file)).toEqual([]);
  }, 90_000);

  // 开着整理(limit=10,约 50 次整理)同时写:盘上永远是「全局写入序列的一段后缀」。某进程的 i 号行还在,
  // 它之后写的 i+1…149 就必须都在;被整理盖掉的行会在自己那串里留下窟窿。
  it.skipIf(process.platform === 'win32')('4 concurrent processes × 150 lines with compaction on: every process keeps a gap-free tail', async () => {
    const file = join(dir, 'tui_history_procs_compact');
    const tags = ['a', 'b', 'c', 'd'];
    const limit = 10;
    await runProcs(file, tags, 150, limit);
    const got = loadHistory(file, 100000);
    expect(got.length).toBeGreaterThanOrEqual(limit);
    expect(got.length).toBeLessThanOrEqual(limit * 2);
    const holes: string[] = [];
    for (const t of tags) {
      const idx = new Set(got.filter((l) => l.startsWith(`${t}-`)).map((l) => Number(l.slice(t.length + 1))));
      if (!idx.size) continue;
      for (let j = Math.min(...idx); j < 150; j++) if (!idx.has(j)) holes.push(`${t}-${j}`);
    }
    expect(holes).toEqual([]);
    expect(leftovers(file)).toEqual([]);
  }, 90_000);
});
