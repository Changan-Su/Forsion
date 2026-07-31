/**
 * 仪器:`.db` 的跨进程写锁(引擎侧)。
 *
 * 它要挡的失败形态是 **stale overwrite** —— 引擎读完到 rename 之间桌面 main 写了一次,
 * 我们的 rename 把它整个抹掉(反向亦然)。这条竞态只在两个进程之间成立,单测起不了两个进程;
 * 但锁本身是**文件**级的,所以「同一路径上两个并发调用者必须排队」在一个进程里量到什么样,
 * 跨进程就是什么样 —— 争的是同一个 `O_EXCL` 创建。
 *
 * ponytail: 这里**证不了**两个实现算出的是同一个锁路径(桌面那半在另一个包里,import 不过来)。
 *   所以 A 组把路径约定逐字钉死;镜像断言在 `desktop/electron/amadeus/fs/dbLock.test.ts`,
 *   改这条约定必须两边一起改,否则就是各锁各的、静默失效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDbLock } from './amadeusDb.js';

let dir = '';
const dbAbs = (): string => path.join(dir, '任务.db');
const lockAbs = (): string => path.join(dir, '.任务.db.lock');

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dblock-')));
  await fs.writeFile(dbAbs(), '{}', 'utf8');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('A. 锁文件路径约定(跨进程契约)', () => {
  it('是同目录下的 `.<文件名>.lock`', async () => {
    let seen: string[] = [];
    await withDbLock(dbAbs(), async () => {
      seen = await fs.readdir(dir);
    });
    expect(seen).toContain('.任务.db.lock');
  });

  it('点开头 —— 这是 watcher 的 ignored 与同步 isIgnoredName 滤掉它的依据', () => {
    expect(path.basename(lockAbs()).startsWith('.')).toBe(true);
  });

  it('跑完就删,不在 vault 里留垃圾', async () => {
    await withDbLock(dbAbs(), async () => {});
    expect(await fs.readdir(dir)).toEqual(['任务.db']);
  });
});

describe('B. 互斥', () => {
  it('同一路径的两个调用者排队,临界区不重叠', async () => {
    const log: string[] = [];
    const body = (tag: string) => async (): Promise<void> => {
      log.push(`in-${tag}`);
      await new Promise((r) => setTimeout(r, 60));
      log.push(`out-${tag}`);
    };
    await Promise.all([withDbLock(dbAbs(), body('a')), withDbLock(dbAbs(), body('b'))]);
    // 谁先进不重要(取决于调度),重叠才是 bug:in-x 之后必须紧跟 out-x。
    expect(log).toHaveLength(4);
    expect(log[1]).toBe(`out-${log[0].slice(3)}`);
    expect(log[3]).toBe(`out-${log[2].slice(3)}`);
  });

  it('不同路径互不阻塞(锁按表分,不是全局一把)', async () => {
    const other = path.join(dir, '别的.db');
    await fs.writeFile(other, '{}', 'utf8');
    let bStarted = false;
    const a = withDbLock(dbAbs(), async () => {
      await new Promise((r) => setTimeout(r, 80));
      expect(bStarted).toBe(true); // b 在 a 还持锁时就跑起来了
    });
    const b = withDbLock(other, async () => { bStarted = true; });
    await Promise.all([a, b]);
  });

  it('临界区抛错也释放锁(否则这张表永久写不进去)', async () => {
    await expect(withDbLock(dbAbs(), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await fs.readdir(dir)).toEqual(['任务.db']);
    await withDbLock(dbAbs(), async () => {}); // 还能再拿到
  });
});

describe('C. 陈旧锁', () => {
  it('持锁进程崩了(mtime 超过 10s)→ 破锁,不永久卡死', async () => {
    await fs.writeFile(lockAbs(), '99999', 'utf8');
    const old = Date.now() / 1000 - 60;
    await fs.utimes(lockAbs(), old, old);
    let ran = false;
    await withDbLock(dbAbs(), async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('锁还新鲜 → 等着,不抢', async () => {
    await fs.writeFile(lockAbs(), '99999', 'utf8'); // 别人刚拿走,没释放
    let done = false;
    const p = withDbLock(dbAbs(), async () => { done = true; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    expect(done).toBe(false); // 仍在等(满 5s 才超时抛错,那条不值得在单测里真等)
    await fs.unlink(lockAbs()); // 对方释放 → 应当拿到
    await p;
    expect(done).toBe(true);
  });
});
