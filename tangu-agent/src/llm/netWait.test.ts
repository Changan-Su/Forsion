/**
 * 断网判定 / 探网 / 等网络 / 睡眠检测(llm/netWait.ts、llm/sleepDetector.ts)。
 * 报错的形状照 Node 22 undici 实测(11-20):fetch failed → cause{code,hostname} 或 cause AggregateError{code, errors[{address,port}]}。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import {
  offlineCauseOf, isOfflineLlmError, mayBeOfflineLlmError, probeTargetOf, waitForNetwork, probeNetwork, reachableAny, __setNetworkProbeForTests, __setReferenceHostsForTests,
  NETWORK_WAIT_MAX_MS, proxyConfigured,
} from './netWait.js';
import { createDriftDetector, SLEEP_GAP_MS, __recordSleepForTests, __resetSleepForTests, sleptMsBetween } from './sleepDetector.js';
import { LlmError } from '../core/types.js';

const sysErr = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`${code} x`), { code, ...extra });
const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });

afterEach(() => {
  __setNetworkProbeForTests(null);
  __setReferenceHostsForTests(null);
  __resetSleepForTests();
  delete process.env.HTTPS_PROXY;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  it('「可能是断网」只给本地传输中断:裸传输错 / status 0 / 本机静默超时是;拿到 HTTP 响应的(含 504 / 503)不是', () => {
    expect(mayBeOfflineLlmError(fetchFailed(sysErr('ECONNRESET')))).toBe(true);
    expect(mayBeOfflineLlmError(new LlmError(0, 'x'))).toBe(true);
    expect(mayBeOfflineLlmError(Object.assign(new LlmError(504, 'stream idle timeout'), { localTransport: true }))).toBe(true);
    expect(mayBeOfflineLlmError(new LlmError(504, 'Gateway Timeout'))).toBe(false);
    expect(mayBeOfflineLlmError(new LlmError(503, 'Service Unavailable'))).toBe(false);
    expect(mayBeOfflineLlmError(new LlmError(502, 'Bad Gateway'))).toBe(false);
    expect(mayBeOfflineLlmError(new LlmError(429, 'Rate limit'))).toBe(false);
    expect(mayBeOfflineLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('探谁', () => {
  it('优先请求地址(重新解析、全部地址都探):报错里的 IP 只是第一个失败的那个', () => {
    expect(probeTargetOf(fetchFailed(sysErr('ENOTFOUND', { hostname: 'api.example.com' })), 'https://api.example.com:8443/v1')).toEqual({ host: 'api.example.com', port: 8443 });
    const v6first = fetchFailed(Object.assign(new AggregateError([
      sysErr('ENETUNREACH', { address: '2001:db8::1', port: 11434 }),
      sysErr('ECONNREFUSED', { address: '127.0.0.1', port: 11434 }),
    ], ''), { code: 'ENETUNREACH' }));
    expect(probeTargetOf(v6first, 'http://localhost:11434/v1')).toEqual({ host: 'localhost', port: 11434 });
  });
  it('没有请求地址:报错里的主机名;只有 IP 时把双栈两个地址都带上', () => {
    expect(probeTargetOf(fetchFailed(sysErr('ENOTFOUND', { hostname: 'proxy.lan' })))).toEqual({ host: 'proxy.lan', port: 443 });
    const agg = fetchFailed(Object.assign(new AggregateError([
      sysErr('ENETUNREACH', { address: '2001:db8::1', port: 443 }),
      sysErr('ECONNREFUSED', { address: '127.0.0.1', port: 443 }),
    ], ''), { code: 'ENETUNREACH' }));
    expect(probeTargetOf(agg)).toEqual({ host: '2001:db8::1', port: 443, addresses: ['2001:db8::1', '127.0.0.1'] });
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
      expect(await probeNetwork({ host: '127.0.0.1', port })).toBe('up');
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await probeNetwork({ host: '127.0.0.1', port })).toBe('up'); // 关了:ECONNREFUSED = 包到得了
    __setReferenceHostsForTests(['also-no-such-host.forsion-probe.invalid']);
    expect(await probeNetwork({ host: 'no-such-host.forsion-probe.invalid', port: 443 })).toBe('down');
  });
  it('端点探不通但参照域名连得上 → 本机有网(地址填错 / 那一家停机不能干等 30 分钟)', async () => {
    __setReferenceHostsForTests(['localhost']);
    expect(await probeNetwork({ host: 'no-such-host.forsion-probe.invalid', port: 443 })).toBe('up');
    expect(await probeNetwork({ host: '100::1', port: 443 })).toBe('up');
  });
  it('参照也要连得上,只「解析得出」不算(断网后 DNS 可能还答缓存;IP 字面量永远「解析得出」)', async () => {
    __setReferenceHostsForTests(['100::1']);
    expect(await probeNetwork({ host: 'no-such-host.forsion-probe.invalid', port: 443 })).toBe('down');
  });
  it('有结果就关掉其余在途连接:本机端口先通,连 TEST-NET 的那条 socket 当场销毁', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const socks: net.Socket[] = [];
    const real = net.connect.bind(net) as (o: net.NetConnectOpts) => net.Socket;
    vi.spyOn(net, 'connect').mockImplementation(((o: net.NetConnectOpts) => { const s = real(o); socks.push(s); return s; }) as typeof net.connect);
    try {
      __setReferenceHostsForTests(['192.0.2.1']); // TEST-NET-1:连不上,一般挂到超时
      expect(await probeNetwork({ host: '127.0.0.1', port }, undefined, 3_000)).toBe('up');
      expect(socks.length).toBe(2);
      expect(socks.every((s) => s.destroyed)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
  it('点停:立刻 AbortError,在途 socket 全部销毁', async () => {
    const socks: net.Socket[] = [];
    const real = net.connect.bind(net) as (o: net.NetConnectOpts) => net.Socket;
    vi.spyOn(net, 'connect').mockImplementation(((o: net.NetConnectOpts) => { const s = real(o); socks.push(s); return s; }) as typeof net.connect);
    __setReferenceHostsForTests(['192.0.2.2']);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    await expect(probeNetwork({ host: '192.0.2.1', port: 443 }, ac.signal, 3_000)).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(socks.length).toBe(2);
    expect(socks.every((s) => s.destroyed)).toBe(true);
  });
  it('配了代理(HTTPS_PROXY / HTTP_PROXY / ALL_PROXY,大小写都认):直连探不出实际出口 → unknown,不调探网实现', async () => {
    expect(proxyConfigured({ https_proxy: 'http://127.0.0.1:7890' })).toBe(true);
    expect(proxyConfigured({ ALL_PROXY: 'socks5://127.0.0.1:7891' })).toBe(true);
    expect(proxyConfigured({ HTTP_PROXY: '  ' })).toBe(false);
    expect(proxyConfigured({})).toBe(false);
    const probe = vi.fn(async () => false);
    __setNetworkProbeForTests(probe, 5);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    expect(await probeNetwork({ host: 'h', port: 443 })).toBe('unknown');
    const onWaiting = vi.fn();
    await expect(waitForNetwork({ target: { host: 'h', port: 443 }, onWaiting })).resolves.toMatchObject({ state: 'unknown', waitedMs: 0 });
    expect(onWaiting).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it('探网实现自己说 unknown → 不进长等', async () => {
    __setNetworkProbeForTests(async () => 'unknown', 5);
    expect(await probeNetwork({ host: 'h', port: 443 })).toBe('unknown');
    await expect(waitForNetwork({ target: { host: 'h', port: 443 } })).resolves.toMatchObject({ state: 'unknown' });
    // 等的中途变成 unknown:也不再等下去
    const seq: Array<boolean | 'unknown'> = [false, 'unknown'];
    __setNetworkProbeForTests(async () => seq.shift() ?? false, 5);
    await expect(waitForNetwork({ target: { host: 'h', port: 443 } })).resolves.toMatchObject({ state: 'unknown' });
  });
  it('解析出多个地址时任一个通就算通:IPv6 坏、IPv4 好不能判成断网(fetch 也会两个都试)', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      // 100::1 = RFC 6666 丢弃前缀(到不了),192.0.2.1 = TEST-NET-1(到不了)
      const t0 = Date.now();
      expect(await reachableAny(['100::1', '127.0.0.1'], port, 3_000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2_000); // 不等坏地址超时
      expect(await reachableAny(['100::1', '192.0.2.1'], port, 300)).toBe(false);
      expect(await reachableAny([], port, 300)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
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
  it('等的中途合盖 2 小时:睡着的时间不算进 30 分钟,醒来第一探没通照样接着等', async () => {
    vi.useFakeTimers();
    let up = false;
    __setNetworkProbeForTests(async () => up, 5_000);
    let settled = false;
    const p = waitForNetwork({ target: { host: 'h', port: 443 }, maxMs: NETWORK_WAIT_MAX_MS }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10_000); // 醒着等了 10s
    const s0 = Date.now();
    vi.setSystemTime(s0 + 2 * 3600_000); // 合盖 2 小时(定时器不走,墙钟跳)
    __recordSleepForTests(s0, Date.now()); // 睡眠检测的心跳记下这一段
    await vi.advanceTimersByTimeAsync(5_000); // 醒来第一探:Wi-Fi 还没连上
    expect(settled).toBe(false);
    up = true;
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await p;
    expect(r.state).toBe('back');
    expect(r.waitedMs).toBeGreaterThan(2 * 3600_000);
    expect(r.awakeMs).toBeLessThan(60_000);
  });
  it('睡眠只认心跳:墙钟跳了 2 小时但心跳没记睡眠(探网卡住 / 事件循环忙)→ 照算醒着,超 30 分钟放弃', async () => {
    vi.useFakeTimers();
    __setNetworkProbeForTests(async () => false, 5_000);
    const p = waitForNetwork({ target: { host: 'h', port: 443 }, maxMs: NETWORK_WAIT_MAX_MS });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await p;
    expect(r.state).toBe('gave_up');
    expect(r.awakeMs).toBeGreaterThan(NETWORK_WAIT_MAX_MS);
  });
  it('每次探测受剩余时限约束:只剩 1s 时探网卡住也 1s 就收', async () => {
    __setNetworkProbeForTests(() => new Promise<boolean>(() => {}), 5);
    const t0 = Date.now();
    const r = await waitForNetwork({ target: { host: 'h', port: 443 }, maxMs: 300, assumeDown: true });
    expect(r.state).toBe('gave_up');
    expect(Date.now() - t0).toBeLessThan(1_500);
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
    expect(d.intervals()).toEqual([{ start: woke - 20 * 60_000, end: woke }]); // 睡眠区间 = [睡前最后一拍, 醒来第一拍]
  });
  it('sleptMsBetween 只算与窗口重叠的那段', () => {
    __recordSleepForTests(1_000, 5_000);
    __recordSleepForTests(8_000, 9_000);
    expect(sleptMsBetween(0, 10_000)).toBe(5_000);
    expect(sleptMsBetween(3_000, 8_500)).toBe(2_500);
    expect(sleptMsBetween(5_000, 8_000)).toBe(0);
  });
});
