import { lookup } from 'node:dns';
import net from 'node:net';
import { LlmError } from '../core/types.js';
import { sleptMsBetween } from './sleepDetector.js';

/**
 * 「等待网络」:断网时模型调用不再白白耗掉重试次数、一分钟内就判失败,而是停下来每 ~5 秒探一次网,
 * 网回来就在同一轮接着发(llm/retry.ts 的 LlmRetryChain / awaitNetwork / probeBeforeResume 调用这里)。
 *
 * 判「断网」分两层:
 *  1. 报错本身:错误链(cause / AggregateError.errors)里有 ENOTFOUND / EAI_AGAIN / ECONNREFUSED / ENETUNREACH /
 *     EHOSTUNREACH / ENETDOWN —— 连接根本没建起来。收到过 HTTP 响应的(LlmError 且 status≠0)一律不算:
 *     云端流里转述的「上游 ENOTFOUND」是服务器那边的网,不是这台电脑的。ECONNRESET / 超时也不算(可能是服务端掐的)。
 *  2. 探网确认:按报错归成断网也要先探一次,探得通就照常重试(本机模型没起的 ECONNREFUSED、代理没开等),
 *     免费的等待只在探网确认断了的时候发生 —— 否则分类一错就是不扣次数的死循环。
 *     「通」= 请求的那个端点连得上,**或者**参照域名(缺省 forsion.net,TANGU_NET_REFERENCE_HOSTS 可改)连得上:
 *     模型地址填错 / 那一家停机 / 代理域名解析不了时本机其实有网,不能挂 30 分钟,照常重试、照常失败。
 *
 * 探网 = 解析请求的主机名(dns.lookup all,和 fetch 走同一条系统解析)+ 并行连一下每个地址的端口,任一个连上 /
 * 被拒 / 被重置都算通(包到得了对方;fetch 也会把 IPv6 / IPv4 都试一遍,只探第一个会把「IPv6 坏、IPv4 好」误判成断网)。
 * 端点和参照域名并行探,整次探网受 NETWORK_PROBE_TIMEOUT_MS 与剩余时限约束;有结果 / 超时 / 点停就销毁其余在途 socket,
 * 迟到的 DNS 结果不再发起连接。dns.lookup 不能取消、占 libuv 线程池:同一主机同时只留一个在途解析。
 *
 * 结果三态:up / down / unknown。配了代理(HTTPS_PROXY / HTTP_PROXY / ALL_PROXY)时直连 TCP 探不出实际出口的通断 → unknown;
 * unknown 一律不进长等,按普通错误走重试。
 */

export const NETWORK_WAIT_MAX_MS = 30 * 60_000;
export const NETWORK_PROBE_INTERVAL_MS = 5_000;
export const NETWORK_PROBE_TIMEOUT_MS = 4_000;

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

export interface ProbeTarget {
  host: string;
  port: number;
  /** 报错里连不上的那几个 IP(没有请求地址可解析时用;双栈要全探) */
  addresses?: string[];
}


const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** 沿 cause / AggregateError.errors 往下走(有界、防环)。 */
function errorChain(err: unknown): any[] {
  const out: any[] = [];
  const seen = new Set<unknown>();
  const walk = (e: any, depth: number): void => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 5) return;
    seen.add(e);
    out.push(e);
    if (Array.isArray(e.errors)) for (const x of e.errors) walk(x, depth + 1);
    walk(e.cause, depth + 1);
  };
  walk(err, 0);
  return out;
}

/** 连接没建起来的那个底层错误(带 code / 主机 / 端口);不是断网类返回 null。 */
export function offlineCauseOf(err: unknown): { code: string; host?: string; port?: number } | null {
  if ((err as any)?.name === 'AbortError') return null;
  if (err instanceof LlmError && err.status !== 0) return null; // 收到过 HTTP 响应:网是通的
  for (const e of errorChain(err)) {
    const code = typeof e.code === 'string' ? e.code : '';
    if (!OFFLINE_CODES.has(code)) continue;
    // AggregateError 本身带 code 但没有地址,地址在它的 errors 里:继续往下找带地址的那个
    const host = typeof e.hostname === 'string' ? e.hostname : typeof e.address === 'string' ? e.address : undefined;
    if (!host && Array.isArray(e.errors)) continue;
    return { code, ...(host ? { host } : {}), ...(Number(e.port) > 0 ? { port: Number(e.port) } : {}) };
  }
  // 只有 AggregateError 带 code、子错误都没地址:仍算断网类
  for (const e of errorChain(err)) if (typeof e.code === 'string' && OFFLINE_CODES.has(e.code)) return { code: e.code };
  return null;
}

export const isOfflineLlmError = (err: unknown): boolean => offlineCauseOf(err) !== null;

/**
 * 本地传输中断:连接没建起来 / 建了被掐 / 本地看门狗超时 —— 没拿到 HTTP 响应。裸传输错、status 0、
 * 以及带 localTransport 标记的(streamIdle 的静默超时、httpBrain 的本地超时)。HTTP 503 / 504 响应不算。
 * 决定「要不要探网」(放弃前 / 中流续写前)与「跨睡眠能不能免费重发」。
 */
export function isLocalTransportError(err: unknown): boolean {
  if ((err as any)?.name === 'AbortError') return false;
  if (err instanceof LlmError) return err.status === 0 || (err as { localTransport?: boolean }).localTransport === true;
  return true;
}

/** 兼容旧名:可能是断网 = 本地传输中断(只用来决定要不要探一次网,不直接当断网)。 */
export const mayBeOfflineLlmError = isLocalTransportError;

function targetFromUrl(url: string | undefined): ProbeTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    return { host, port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443) };
  } catch {
    return null;
  }
}

/**
 * 探谁:优先请求地址(重新解析、全部地址都探 —— 报错里的 IP 只是 happy eyeballs 第一个失败的那个,
 * Windows 上常是 IPv6 ENETUNREACH,IPv4 才是通路);没有请求地址时用报错里的主机名,再不然用报错里全部 IP。
 * 都没有 → null(不探、照常重试)。
 */
export function probeTargetOf(err: unknown, fallbackUrl?: string): ProbeTarget | null {
  const fromUrl = targetFromUrl(fallbackUrl);
  if (fromUrl) return fromUrl;
  const cause = offlineCauseOf(err);
  if (!cause?.host) return null;
  const port = cause.port || 443;
  if (!net.isIP(cause.host)) return { host: cause.host, port };
  const addresses = [...new Set(errorChain(err)
    .filter((e) => typeof e.code === 'string' && OFFLINE_CODES.has(e.code) && typeof e.address === 'string')
    .map((e) => e.address as string))];
  return { host: cause.host, port, addresses: addresses.length ? addresses : [cause.host] };
}

// ── 探网 ─────────────────────────────────────────────────────────────────────

export type ProbeResult = 'up' | 'down' | 'unknown';

/** 配了代理:请求走代理出去,直连 TCP 探测说明不了实际出口通不通。 */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((k) => String(env[k] || '').trim() !== '');
}

const pendingLookups = new Map<string, Promise<string[]>>();

/** 同一主机同时只留一个在途 dns.lookup(解析可能挂几十秒,不能每 5 秒叠一个进线程池)。 */
function lookupOnce(host: string): Promise<string[]> {
  let p = pendingLookups.get(host);
  if (!p) {
    p = new Promise<string[]>((resolve, reject) =>
      lookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))));
    pendingLookups.set(host, p);
    p.then(() => pendingLookups.delete(host), () => pendingLookups.delete(host));
  }
  return p;
}

/** 等解析,signal 一停就当没结果(底层 getaddrinfo 取消不了,迟到的结果直接丢)。 */
function lookupUntil(host: string, signal: AbortSignal): Promise<string[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    lookupOnce(host).then(
      (r) => { signal.removeEventListener('abort', onAbort); resolve(signal.aborted ? null : r); },
      () => { signal.removeEventListener('abort', onAbort); resolve(null); },
    );
  });
}

/** 连一下:连上 / 被拒 / 被重置 = 通;signal 停了就销毁 socket、算不通。 */
function tcpReachable(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      sock.destroy();
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    sock.once('connect', () => finish(true));
    // 被拒绝 / 被重置 = 包到得了对方:网是通的(本机模型没起 → 照常重试再失败,不该当断网干等)
    sock.once('error', (e: any) => finish(e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET'));
  });
}

/** 并行跑一组「通不通」,任一个通就返回 true 并停掉其余(销毁在途 socket);全不通 / 停了 → false。 */
function anyTrue(tasks: Array<(signal: AbortSignal) => Promise<boolean>>, signal: AbortSignal): Promise<boolean> {
  if (!tasks.length || signal.aborted) return Promise.resolve(false);
  const inner = new AbortController();
  const stop = (): void => inner.abort();
  signal.addEventListener('abort', stop, { once: true });
  return new Promise<boolean>((resolve) => {
    let pending = tasks.length;
    for (const t of tasks) {
      void t(inner.signal).then((ok) => {
        if (ok) { resolve(true); inner.abort(); }
        else if (--pending === 0) resolve(false);
      }, () => { if (--pending === 0) resolve(false); });
    }
  }).finally(() => { signal.removeEventListener('abort', stop); inner.abort(); });
}

/** 并行连每个地址,任一个通就是通(其余连接随即关掉);全不通(或没地址)才是断。 */
export function reachableAny(addresses: string[], port: number, ms = NETWORK_PROBE_TIMEOUT_MS): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  t.unref?.();
  return anyTrue(addresses.map((a) => (s: AbortSignal) => tcpReachable(a, port, s)), ac.signal).finally(() => clearTimeout(t));
}

function targetReachable(t: ProbeTarget, signal: AbortSignal): Promise<boolean> {
  const connectAll = (addrs: string[]): Promise<boolean> => anyTrue(addrs.map((a) => (s: AbortSignal) => tcpReachable(a, t.port, s)), signal);
  if (t.addresses?.length) return connectAll(t.addresses);
  if (net.isIP(t.host)) return connectAll([t.host]);
  return lookupUntil(t.host, signal).then((addrs) => (addrs?.length && !signal.aborted ? connectAll(addrs) : false));
}

/** 参照域名:请求端点探不通时,它们任一个连得上就算本机有网。TANGU_NET_REFERENCE_HOSTS(逗号分隔)可改。 */
const DEFAULT_REFERENCE_HOSTS = ['forsion.net'];
let referenceHosts: string[] = (process.env.TANGU_NET_REFERENCE_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
if (!referenceHosts.length) referenceHosts = DEFAULT_REFERENCE_HOSTS;

/** 仅测试:换参照域名(传 null 复原)。 */
export function __setReferenceHostsForTests(hosts: string[] | null): void {
  referenceHosts = hosts ?? DEFAULT_REFERENCE_HOSTS;
}

/**
 * 缺省探网:端点与参照域名(解析 + 连 443,被拒也算)**并行**,任一个通 = 通(端点自己挂了 / 地址填错不算本机断网;
 * 参照只解析不连不够 —— 断网后 DNS 可能答缓存,IP 字面量永远「解析得出」)。signal 停 = 超时 / 点停:关掉全部在途连接。
 */
function defaultProbe(t: ProbeTarget, signal: AbortSignal): Promise<boolean> {
  return anyTrue([
    (s) => targetReachable(t, s),
    ...referenceHosts.map((h) => (s: AbortSignal) => targetReachable({ host: h, port: 443 }, s)),
  ], signal);
}

type ProbeImpl = (t: ProbeTarget, signal: AbortSignal) => Promise<boolean | 'unknown'>;
let probeImpl: ProbeImpl = defaultProbe;
let probeIntervalMs = NETWORK_PROBE_INTERVAL_MS;

/** 仅测试:换掉探网实现与间隔(传 null 复原)。实现可返回 'unknown'。 */
export function __setNetworkProbeForTests(probe: ProbeImpl | null, intervalMs?: number): void {
  probeImpl = probe ?? defaultProbe;
  probeIntervalMs = intervalMs ?? NETWORK_PROBE_INTERVAL_MS;
}

/**
 * 探一次。配了代理 → unknown(不探)。timeoutMs(缺省 NETWORK_PROBE_TIMEOUT_MS)到了还没通 → down,并停掉在途连接。
 * 用户点停 → 立刻抛 AbortError(底层 socket 一并销毁,迟到的解析结果不再发起连接)。
 */
export async function probeNetwork(t: ProbeTarget, signal?: AbortSignal, timeoutMs = NETWORK_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (signal?.aborted) throw abortError();
  if (proxyConfigured()) return 'unknown';
  const ac = new AbortController();
  const onOuter = (): void => ac.abort();
  signal?.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const r = await Promise.race([
      probeImpl(t, ac.signal).catch(() => false as const),
      new Promise<false>((resolve) => ac.signal.addEventListener('abort', () => resolve(false), { once: true })),
    ]);
    if (signal?.aborted) throw abortError();
    return r === 'unknown' ? 'unknown' : r ? 'up' : 'down';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
    ac.abort(); // 有结果了:其余在途探测一并停掉
  }
}

/** 可中止的等待:signal 一 abort 就抛 AbortError,不再干等完整窗口(retry.ts 原样转出)。 */
export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export interface NetworkWaitResult {
  /** up = 本来就通(没等);back = 断过、回来了;gave_up = 醒着等满 maxMs 还没通;unknown = 探不出(配了代理等),不等 */
  state: 'up' | 'back' | 'gave_up' | 'unknown';
  /** 墙钟(含睡着的时间) */
  waitedMs: number;
  /** 醒着等的时间(墙钟减去睡眠检测记下的睡眠区间):算 30 分钟上限的 */
  awakeMs: number;
  since: number;
}

/**
 * 先探一次(assumeDown = 调用方刚探过、确认断了,跳过这一探);通 → up,探不出 → unknown,都不等。
 * 断了 → onWaiting(since) 一次(每段等待只报一次,不是每次探网),之后每 probeIntervalMs 探一次,通了返回 back,
 * 醒着等满 maxMs 返回 gave_up;每次探测受剩余时限约束。用户点停抛 AbortError。
 * 合盖的那段由睡眠检测判定、不算醒着等的时间 —— 不按某一轮耗时长短猜(探网慢不等于睡着了)。
 */
export async function waitForNetwork(opts: {
  target: ProbeTarget;
  signal?: AbortSignal;
  maxMs?: number;
  assumeDown?: boolean;
  onWaiting?: (since: number) => void;
}): Promise<NetworkWaitResult> {
  const { target, signal } = opts;
  if (!opts.assumeDown) {
    const first = await probeNetwork(target, signal);
    if (first !== 'down') return { state: first, waitedMs: 0, awakeMs: 0, since: 0 };
  }
  const since = Date.now();
  const maxMs = opts.maxMs ?? NETWORK_WAIT_MAX_MS;
  const awake = (now: number): number => Math.max(0, now - since - sleptMsBetween(since, now));
  const result = (state: NetworkWaitResult['state']): NetworkWaitResult => {
    const now = Date.now();
    return { state, waitedMs: now - since, awakeMs: awake(now), since };
  };
  if (maxMs <= 0) return result('gave_up');
  opts.onWaiting?.(since);
  for (;;) {
    let left = maxMs - awake(Date.now());
    if (left <= 0) return result('gave_up');
    await sleepOrAbort(Math.min(probeIntervalMs, left), signal);
    left = maxMs - awake(Date.now());
    if (left <= 0) return result('gave_up');
    const r = await probeNetwork(target, signal, Math.min(NETWORK_PROBE_TIMEOUT_MS, left));
    if (r === 'up') return result('back');
    if (r === 'unknown') return result('unknown');
  }
}
