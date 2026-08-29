import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { IlinkRuntime } from '../src/wechat/ilinkRuntime.js';

// 防回归:会话过期(ret=-14)时轮询必须真停,否则每 10 分钟复读同一条 error,
// 把 [inbox]/agent-core 的真故障日志淹掉(2026-08-27 桌面 backendLogs:154 条里约 100 条是它)。
async function makeRuntime() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ilink-test-'));
  const logs: string[] = [];
  let expiredCalls = 0;
  const rt = new IlinkRuntime({
    stateDir,
    onMessage: async () => '',
    onSessionExpired: () => { expiredCalls += 1; },
    logger: (level, msg) => { logs.push(`${level} ${msg}`); },
  });
  // 直接装配账号(绕开 addAccount 的自动 start 与真实 IlinkClient,不打网络)。
  (rt as any).accounts.set('acc1', { accountId: 'acc1', token: 't1', baseUrl: 'http://x', syncBuf: '', contextTokens: {} });
  const setClient = (getUpdates: () => Promise<any>) => (rt as any).clients.set('acc1', { getUpdates });
  return { rt, logs, setClient, expired: () => expiredCalls };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 300));

describe('iLink poll loop: session expired', () => {
  it('过期后停止轮询,只打一条 error、只回调一次', async () => {
    let polls = 0;
    const { rt, logs, setClient, expired } = await makeRuntime();
    setClient(async () => { polls += 1; return { ret: -14 }; });
    rt.start('acc1');
    await settle();

    expect(logs.filter((l) => l.includes('session expired'))).toHaveLength(1);
    expect(expired()).toBe(1);
    expect(polls).toBe(1);
    expect(rt.status().find((s) => s.accountId === 'acc1')?.running).toBe(false);

    // 停稳之后不再有新轮询/新日志
    const before = logs.length;
    await settle();
    expect(polls).toBe(1);
    expect(logs.length).toBe(before);
  }, 5000);

  it('重新登录(换 client + start)后能重启轮询', async () => {
    const { rt, setClient } = await makeRuntime();
    setClient(async () => ({ ret: -14 }));
    rt.start('acc1');
    await settle();
    expect(rt.status()[0]?.running).toBe(false);

    let polls2 = 0;
    setClient(async () => { polls2 += 1; await new Promise((r) => setTimeout(r, 50)); return { ret: 0, msgs: [] }; });
    rt.start('acc1'); // addAccount() 重新登记后会走这一步
    await settle();
    expect(rt.status()[0]?.running).toBe(true);
    expect(polls2).toBeGreaterThan(0);
    rt.shutdown();
  }, 5000);

  it('轮询期间换了凭据 → 这条过期属于旧 client,不误停', async () => {
    const { rt, logs, setClient, expired } = await makeRuntime();
    let pollsNew = 0;
    setClient(async () => {
      // 模拟 addAccount 在长轮询进行中换掉了 client(新 token),旧 client 随后才回过期。
      setClient(async () => { pollsNew += 1; await new Promise((r) => setTimeout(r, 50)); return { ret: 0, msgs: [] }; });
      return { ret: -14 };
    });
    rt.start('acc1');
    await settle();

    expect(logs.filter((l) => l.includes('session expired'))).toHaveLength(0);
    expect(expired()).toBe(0);
    expect(rt.status()[0]?.running).toBe(true);
    expect(pollsNew).toBeGreaterThan(0);
    rt.shutdown();
  }, 5000);
});
