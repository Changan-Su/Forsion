/**
 * 断网判定 / 探网 / 等网络 / 睡眠检测(llm/netWait.ts、llm/sleepDetector.ts)。
 * 报错的形状照 Node 22 undici 实测(11-20):fetch failed → cause{code,hostname} 或 cause AggregateError{code, errors[{address,port}]}。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import {
  offlineCauseOf, isOfflineLlmError, mayBeOfflineLlmError, probeTargetOf, waitForNetwork, probeNetwork, __setNetworkProbeForTests,
} from './netWait.js';
import { createDriftDetector, SLEEP_GAP_MS } from './sleepDetector.js';
import { LlmError } from '../core/types.js';

const sysErr = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`${code} x`), { code, ...extra });
const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });

afterEach(() => __setNetworkProbeForTests(null));

describe('断网类报错', () => {
  it('认得出:ENOTFOUND / EAI_AGAIN / ENETUNREACH / EHOSTUNREACH / ENETDOWN / ECONNREFUSED(连接没建起来)', () => {
    expect(offlineCauseOf(fetchFailed(sysErr('ENOTFOUND', { hostname: 'api.openai.com' })))).toEqual({ code: 'ENOTFOUND', host: 'api.openai.com' });
    for (const code of ['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNREFUSED']) {
      expect(isOfflineLlmError(fetchFailed(sysErr(code, { address: '1.2.3.4', port: 443 })))).toBe(true);
    }
  });
  it('happy eyeballs 的 AggregateError:取带地址的那个子错误', () => {
    const agg = Object.assign(new AggregateError([
      sysErr('ECONNREFUSED', { address: '::1', port: 59999 }),
      sysErr('ECONNREFUSED', { address: '127.0.0.1', port: 59999 }),
    ], ''), { code: 'ECONNREFUSED' });
    expect(offlineCauseOf(fetchFailed(agg))).toEqual({ code: 'ECONNREFUSED', host: '::1', port: 59999 });
  });
  it('托管面 httpBrain 包成 LlmError(0) 后仍认得出(原错挂在 cause 上)', () => {
    const wrapped = Object.assign(new LlmError(0, '云端 /agent/stream 连接失败(fetch failed)'), { cause: fetchFailed(sysErr('ENOTFOUND', { hostname: 'api.forsion.net' })) });
    expect(offlineCauseOf(wrapped)).toEqual({ code: 'ENOTFOUND', host: 'api.forsion.net' });
  });
  it('不算断网:ECONNRESET / 超时 / 流读一半断(服务端可能掐的)、收到过 HTTP 响应的、用户点停', () => {
    expect(isOfflineLlmError(fetchFailed(sysErr('ECONNRESET')))).toBe(false);
    expect(isOfflineLlmError(fetchFailed(sysErr('ETIMEDOUT')))).toBe(false);
    expect(isOfflineLlmError(fetchFailed(sysErr('UND_ERR_CONNECT_TIMEOUT')))).toBe(false);
    expect(isOfflineLlmError(new TypeError('terminated', { cause: sysErr('UND_ERR_SOCKET') }))).toBe(false);
    expect(isOfflineLlmError(new TypeError('fetch failed'))).toBe(false); // 没 code:不猜
    // 云端流里转述的「上游 ENOTFOUND」是服务器那边的网
    expect(isOfflineLlmError(Object.assign(new LlmError(502, 'getaddrinfo ENOTFOUND upstream'), { cause: sysErr('ENOTFOUND') }))).toBe(false);
    expect(isOfflineLlmError(Object.assign(new Error('aborted'), { name: 'AbortError', cause: sysErr('ENOTFOUND') }))).toBe(false);
  });
  it('「可能是断网」只决定要不要探网:裸传输错 / status 0 / 504 是,HTTP 状态错不是', () => {
    expect(mayBeOfflineLlmError(fetchFailed(sysErr('ECONNRESET')))).toBe(true);
    expect(mayBeOfflineLlmError(new LlmError(0, 'x'))).toBe(true);
    expect(mayBeOfflineLlmError(new LlmError(504, 'stream idle timeout'))).toBe(true);
    expect(mayBeOfflineLlmError(new LlmError(502, 'Bad Gateway'))).toBe(false);
    expect(mayBeOfflineLlmError(new LlmError(429, 'Rate limit'))).toBe(false);
    expect(mayBeOfflineLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('探谁', () => {
  it('优先报错里连不上的主机;端口同主机时取请求地址的', () => {
    expect(probeTargetOf(fetchFailed(sysErr('ENOTFOUND', { hostname: 'api.example.com' })), 'https://api.example.com:8443/v1')).toEqual({ host: 'api.example.com', port: 8443 });
    expect(probeTargetOf(fetchFailed(sysErr('ENOTFOUND', { hostname: 'proxy.lan' })), 'https://api.example.com/v1')).toEqual({ host: 'proxy.lan', port: 443 });
    expect(probeTargetOf(fetchFailed(sysErr('ECONNREFUSED', { address: '127.0.0.1', port: 11434 })))).toEqual({ host: '127.0.0.1', port: 11434 });
  });
  it('报错没带主机 → 请求地址;http 缺省 80;IPv6 去括号;都没有 → null', () => {
    expect(probeTargetOf(fetchFailed(sysErr('ECONNRESET')), 'http://gw.local/v1')).toEqual({ host: 'gw.local', port: 80 });
    expect(probeTargetOf(new LlmError(504, 'idle'), 'https://[::1]:9000/x')).toEqual({ host: '::1', port: 9000 });
    expect(probeTargetOf(fetchFailed(sysErr('ECONNRESET')), 'b')).toBeNull();
    expect(probeTargetOf(fetchFailed(sysErr('ECONNRESET')))).toBeNull();
  });
});

describe('真探网(缺省实现)', () => {
  it('本机开着的端口 → 通;本机关着的端口(被拒)也算通;.invalid 解析不了 → 断', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await probeNetwork({ host: '127.0.0.1', port })).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await probeNetwork({ host: '127.0.0.1', port })).toBe(true); // 关了:ECONNREFUSED = 包到得了
    expect(await probeNetwork({ host: 'no-such-host.forsion-probe.invalid', port: 443 })).toBe(false);
  });
});

describe('waitForNetwork', () => {
  it('本来就通 → up,不报等待', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const onWaiting = vi.fn();
    await expect(waitForNetwork({ target: { host: 'h', port: 443 }, onWaiting })).resolves.toMatchObject({ state: 'up', waitedMs: 0 });
    expect(onWaiting).not.toHaveBeenCalled();
  });
  it('断两次再通 → back,onWaiting 只报一次(带开始时刻)', async () => {
    const seq = [false, false, true];
    __setNetworkProbeForTests(async () => seq.shift()!, 5);
    const onWaiting = vi.fn();
    const t0 = Date.now();
    const r = await waitForNetwork({ target: { host: 'h', port: 443 }, onWaiting });
    expect(r.state).toBe('back');
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(onWaiting.mock.calls[0][0]).toBeGreaterThanOrEqual(t0);
    expect(r.since).toBe(onWaiting.mock.calls[0][0]);
  });
  it('等满 maxMs → gave_up', async () => {
    __setNetworkProbeForTests(async () => false, 5);
    await expect(waitForNetwork({ target: { host: 'h', port: 443 }, maxMs: 30 })).resolves.toMatchObject({ state: 'gave_up' });
  });
  it('探网卡住时点停也立刻返回 AbortError', async () => {
    __setNetworkProbeForTests(() => new Promise<boolean>(() => {}), 5);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(waitForNetwork({ target: { host: 'h', port: 443 }, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('睡眠检测(drift timer)', () => {
  it('心跳间隙 >15s 记一次醒来;正常心跳 / 恰好 15s 不算', () => {
    let now = 1_000_000;
    const d = createDriftDetector({ now: () => now });
    for (let i = 0; i < 5; i++) { now += 1_000; d.tick(); }
    expect(d.lastWakeAt()).toBe(0);
    now += SLEEP_GAP_MS; d.tick(); // 恰好 15s:不算
    expect(d.lastWakeAt()).toBe(0);
    now += 20 * 60_000; d.tick(); // 合盖 20 分钟
    expect(d.lastWakeAt()).toBe(now);
    const woke = now;
    now += 1_000; d.tick();
    expect(d.lastWakeAt()).toBe(woke); // 醒来之后的正常心跳不改它
  });
});
