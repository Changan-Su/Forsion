import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { IlinkRuntime } from '../src/wechat/ilinkRuntime.js';
import { WechatChannel } from '../src/channels/wechat.js';

// 防回归:文本发送没送达必须回 ok:false。通道审批卡的送达闸(channels/service.ts delivering / onApprovalUndelivered)
// 只认驱动回报 —— 旧版限流重试放弃后丢了消息仍回 ok:true,多条审批卡丢了中间一段,用户看着前几条就能「批准」整个操作。
const stateDirs: string[] = [];
afterAll(async () => {
  await Promise.all(stateDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeRuntime(sendText: (to: string, text: string, ctx?: string) => Promise<any>, contextTokens: Record<string, string> = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ilink-send-test-'));
  stateDirs.push(stateDir);
  const logs: string[] = [];
  const rt = new IlinkRuntime({ stateDir, onMessage: async () => '', logger: (level, msg) => { logs.push(`${level} ${msg}`); } });
  // 直接装配账号(绕开 addAccount 的自动 start 与真实 IlinkClient,不打网络)。
  (rt as any).accounts.set('acc1', { accountId: 'acc1', token: 't1', baseUrl: 'http://x', syncBuf: '', contextTokens });
  const calls: Array<{ text: string; ctx?: string }> = [];
  (rt as any).clients.set('acc1', {
    sendText: async (to: string, text: string, ctx?: string) => { calls.push({ text, ctx }); return sendText(to, text, ctx); },
  });
  return { rt, logs, calls };
}

/** 跑完限速间隔与退避重试(RATE_LIMIT_BACKOFF_MS × 4)的假时钟。 */
async function settled<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

afterEach(() => { vi.useRealTimers(); });

describe('iLink 文本发送:没送达就报失败', () => {
  it('限流重试全部放弃 → ok:false(重试次数照旧)', async () => {
    vi.useFakeTimers();
    const { rt, logs, calls } = await makeRuntime(async () => ({ ret: -2 }));
    const r = await settled(rt.send('acc1', 'peer1', 'part 2/3'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rate limit/i);
    expect(calls).toHaveLength(1 + 4); // 首发 + RATE_LIMIT_RETRIES
    expect(logs.some((l) => l.startsWith('error') && l.includes('限流'))).toBe(true);
  });

  it('限流一次后成功 → ok:true(重试能救回来就不报失败)', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { rt, calls } = await makeRuntime(async () => (++n === 1 ? { ret: -2 } : {}));
    const r = await settled(rt.send('acc1', 'peer1', 'hi'));
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('成功({} / ret:0)→ ok:true', async () => {
    vi.useFakeTimers();
    const { rt } = await makeRuntime(async () => ({ ret: 0 }));
    expect(await settled(rt.send('acc1', 'peer1', 'hi'))).toEqual({ ok: true });
  });

  it('会话过期:带 context_token 过期 → 去掉 token 重发成功 = ok:true', async () => {
    vi.useFakeTimers();
    const { rt, calls } = await makeRuntime(async (_to, _t, ctx) => (ctx ? { ret: -14 } : {}), { peer1: 'ctx-old' });
    const r = await settled(rt.send('acc1', 'peer1', 'hi'));
    expect(r).toEqual({ ok: true });
    expect(calls.map((c) => c.ctx)).toEqual(['ctx-old', undefined]);
  });

  it('会话过期且重发仍过期(或本就没 token)→ ok:false', async () => {
    vi.useFakeTimers();
    const a = await makeRuntime(async () => ({ ret: -14 }), { peer1: 'ctx-old' });
    const r1 = await settled(a.rt.send('acc1', 'peer1', 'hi'));
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/session expired/i);
    const b = await makeRuntime(async () => ({ ret: -14 }));
    expect((await settled(b.rt.send('acc1', 'peer1', 'hi'))).ok).toBe(false);
  });

  it('其它上游业务错误(ret / errcode 非 0)→ ok:false,与 sendMedia 同口径', async () => {
    vi.useFakeTimers();
    const { rt } = await makeRuntime(async () => ({ ret: -1, errmsg: 'bad' }));
    const r = await settled(rt.send('acc1', 'peer1', 'hi'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ret=-1/);
    const e = await makeRuntime(async () => ({ errcode: 40001 }));
    expect((await settled(e.rt.send('acc1', 'peer1', 'hi'))).ok).toBe(false);
  });

  it('网络异常照旧 ok:false', async () => {
    vi.useFakeTimers();
    const { rt } = await makeRuntime(async () => { throw new Error('ECONNRESET'); });
    const r = await settled(rt.send('acc1', 'peer1', 'hi'));
    expect(r).toEqual({ ok: false, error: 'ECONNRESET' });
  });

  it('微信驱动(channels/wechat.ts)把失败原样交给 ChannelService,不吞成成功', async () => {
    vi.useFakeTimers();
    const { rt } = await makeRuntime(async () => ({ ret: -2 }));
    const ch = new WechatChannel();
    (ch as any).runtime = rt;
    const r = await settled(ch.send('acc1', 'peer1', 'approval part 2/3'));
    expect(r.ok).toBe(false);
  });

  it('入站回复没送达:不抛(已记日志),轮询不受影响', async () => {
    vi.useFakeTimers();
    const { rt, logs } = await makeRuntime(async () => ({ ret: -2 }));
    (rt as any).opts.onMessage = async () => 'reply';
    const account = (rt as any).accounts.get('acc1');
    const client = (rt as any).clients.get('acc1');
    const p = (rt as any).handleMessage(account, client, { from_user_id: 'peer1', message_id: 'm1', item_list: [{ type: 1, text_item: { text: 'hi' } }] });
    await expect(settled(p)).resolves.toBeUndefined();
    expect(logs.some((l) => l.startsWith('error'))).toBe(true);
  });
});
