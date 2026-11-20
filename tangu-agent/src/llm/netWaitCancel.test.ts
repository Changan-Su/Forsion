/**
 * 探网的取消(评审 #11):dns.lookup 取消不了 —— 点停 / 超时之后才回来的解析结果直接丢,不再发起连接。
 * 单独一个文件:要 mock node:dns 拿住解析回调,不影响 netWait.test.ts 的真探网用例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';

type LookupCb = (err: Error | null, addrs: Array<{ address: string; family: number }>) => void;
const held: Array<{ host: string; cb: LookupCb }> = [];
vi.mock('node:dns', () => ({
  lookup: (host: string, _opts: unknown, cb: LookupCb) => { held.push({ host, cb }); },
}));

const { probeNetwork, __setReferenceHostsForTests } = await import('./netWait.js');

afterEach(() => {
  held.length = 0;
  __setReferenceHostsForTests(null);
  vi.restoreAllMocks();
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('探网取消', () => {
  it('点停后才回来的解析结果被丢掉:不再连', async () => {
    const connect = vi.spyOn(net, 'connect');
    __setReferenceHostsForTests([]);
    const ac = new AbortController();
    const p = probeNetwork({ host: 'slow-dns.example', port: 443 }, ac.signal, 3_000);
    await settle();
    expect(held.map((h) => h.host)).toEqual(['slow-dns.example']);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    held[0].cb(null, [{ address: '127.0.0.1', family: 4 }]); // 迟到的结果
    await settle();
    expect(connect).not.toHaveBeenCalled();
  });

  it('超时后才回来的解析结果也丢掉:判 down,不再连', async () => {
    const connect = vi.spyOn(net, 'connect');
    __setReferenceHostsForTests(['slow-ref.example']);
    const r = await probeNetwork({ host: 'slow-dns2.example', port: 443 }, undefined, 30);
    expect(r).toBe('down');
    expect(held.map((h) => h.host).sort()).toEqual(['slow-dns2.example', 'slow-ref.example']);
    for (const h of held) h.cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await settle();
    expect(connect).not.toHaveBeenCalled();
  });

  it('对照:解析按时回来就照常连(上面两条不是因为根本没走到连接)', async () => {
    const connect = vi.spyOn(net, 'connect');
    __setReferenceHostsForTests([]);
    const ac = new AbortController();
    const p = probeNetwork({ host: 'fast-dns.example', port: 9 }, ac.signal, 3_000);
    await settle();
    held[0].cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await settle();
    expect(connect).toHaveBeenCalledOnce();
    await p; // 127.0.0.1:9 一般被拒 = 通;结果不重要
  });
});
