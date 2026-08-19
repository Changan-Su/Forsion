// 写锁的两条不变式。这里红了 = 全部写类工具当场不可用,所以值得钉住。
//
// 背景:检查点快照原来在锁外拍(codex 2026-08-17 P1),并发写同一文件时后写者会拍到前写者
// 改动**之前**的字节,回退它就抹掉前者的改动。修法是让 registry 在外层加锁,把
// 「快照 → 执行 → 写后指纹」收进同一个临界区 —— 而工具自己内部本来就各自加锁,
// **所以锁必须可重入,不然内层等外层放锁、外层等内层跑完,第一次写盘就死锁**。
import { describe, expect, it } from 'vitest';
import { withWriteLock, holdingWriteLock } from './writeLock.js';

describe('withWriteLock', () => {
  it('串行:后进的等前一个跑完', async () => {
    const order: string[] = [];
    const a = withWriteLock(async () => {
      order.push('a-in');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-out');
    });
    const b = withWriteLock(async () => {
      order.push('b-in');
      order.push('b-out');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('可重入:嵌套调用直接执行,不死锁', async () => {
    // 5 秒超时兜底:真死锁的话这条会超时而不是挂住整个测试进程。
    const out = await Promise.race([
      withWriteLock(async () => {
        expect(holdingWriteLock()).toBe(true);
        return withWriteLock(async () => 'inner-ran');
      }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: 嵌套 withWriteLock 没能重入')), 5_000)),
    ]);
    expect(out).toBe('inner-ran');
  });

  it('三层嵌套也行(registry → 工具 → 工具内部助手)', async () => {
    const out = await withWriteLock(() => withWriteLock(() => withWriteLock(async () => 3)));
    expect(out).toBe(3);
  });

  it('前一个抛错不卡死后面的', async () => {
    await expect(withWriteLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withWriteLock(async () => 'ok')).resolves.toBe('ok');
  });

  it('锁外不持锁(重入判定不会泄到别的异步链)', async () => {
    await withWriteLock(async () => { expect(holdingWriteLock()).toBe(true); });
    expect(holdingWriteLock()).toBe(false);
  });

  it('并发两条链各自独立:一条在锁内不会让另一条误判成已持锁', async () => {
    let leaked: boolean | null = null;
    await Promise.all([
      withWriteLock(async () => { await new Promise((r) => setTimeout(r, 10)); }),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        leaked = holdingWriteLock(); // 这条链从没进过锁
      })(),
    ]);
    expect(leaked).toBe(false);
  });
});
