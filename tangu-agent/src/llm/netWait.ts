import { lookup } from 'node:dns';
import net from 'node:net';
import { LlmError } from '../core/types.js';
import { SLEEP_GAP_MS } from './sleepDetector.js';

/**
 * 「等待网络」:断网时模型调用不再白白耗掉重试次数、一分钟内就判失败,而是停下来每 ~5 秒探一次网,
 * 网回来就在同一轮接着发(llm/retry.ts 的 LlmRetryChain / awaitNetworkBeforeResume 调用这里)。
 *
 * 判「断网」分两层:
 *  1. 报错本身:错误链(cause / AggregateError.errors)里有 ENOTFOUND / EAI_AGAIN / ECONNREFUSED / ENETUNREACH /
 *     EHOSTUNREACH / ENETDOWN —— 连接根本没建起来。收到过 HTTP 响应的(LlmError 且 status≠0)一律不算:
 *     云端流里转述的「上游 ENOTFOUND」是服务器那边的网,不是这台电脑的。ECONNRESET / 超时也不算(可能是服务端掐的)。
 *  2. 探网确认:按报错归成断网也要先探一次,探得通就照常重试(本机模型没起的 ECONNREFUSED、代理没开等),
 *     免费的等待只在探网确认断了的时候发生 —— 否则分类一错就是不扣次数的死循环。
 *
 * 探网 = 解析请求的主机名(dns.lookup all,和 fetch 走同一条系统解析)+ 并行连一下每个地址的端口,任一个连上 /
 * 被拒 / 被重置都算通(包到得了对方;fetch 也会把 IPv6 / IPv4 都试一遍,只探第一个会把「IPv6 坏、IPv4 好」误判成断网)。
 * dns.lookup 不能取消、占 libuv 线程池:同一主机同时只留一个在途解析,超时只是不再等它。
 */

export const NETWORK_WAIT_MAX_MS = 30 * 60_000;
export const NETWORK_PROBE_INTERVAL_MS = 5_000;
export const NETWORK_PROBE_TIMEOUT_MS = 4_000;

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

export interface ProbeTarget {
  host: string;
  port: number;
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
 * 可能是断网、但单看报错分不出(连接被重置、流读到一半断了、静默超时):裸传输错、status 0、504。
 * 只用来决定「要不要探一次网」,不直接当断网。
 */
export function mayBeOfflineLlmError(err: unknown): boolean {
  if ((err as any)?.name === 'AbortError') return false;
  if (err instanceof LlmError) return err.status === 0 || err.status === 504;
  return true;
}

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

/** 探谁:优先报错里那个连不上的主机(它就是失败的那一跳),否则用请求地址。都没有 → null(不探、照常重试)。 */
export function probeTargetOf(err: unknown, fallbackUrl?: string): ProbeTarget | null {
  const fromUrl = targetFromUrl(fallbackUrl);
  const cause = offlineCauseOf(err);
  if (cause?.host) {
    const port = cause.port || (fromUrl && fromUrl.host === cause.host ? fromUrl.port : 443);
    return { host: cause.host, port };
  }
  return fromUrl;
}

// ── 探网 ─────────────────────────────────────────────────────────────────────

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

function tcpReachable(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    timer.unref?.();
    sock.once('connect', () => finish(true));
    // 被拒绝 / 被重置 = 包到得了对方:网是通的(本机模型没起、代理没开 → 照常重试再失败,不该当断网干等)
    sock.once('error', (e: any) => finish(e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET'));
  });
}

/** 并行连每个地址,任一个通就是通;全不通(或没地址)才是断。 */
export function reachableAny(addresses: string[], port: number, ms = NETWORK_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!addresses.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    let pending = addresses.length;
    for (const a of addresses) {
      void tcpReachable(a, port, ms).then((ok) => {
        if (ok) resolve(true);
        else if (--pending === 0) resolve(false);
      });
    }
  });
}

async function defaultProbe(t: ProbeTarget): Promise<boolean> {
  if (net.isIP(t.host)) return reachableAny([t.host], t.port);
  const resolved = await withTimeout(lookupOnce(t.host), NETWORK_PROBE_TIMEOUT_MS);
  return resolved ? reachableAny(resolved, t.port) : false;
}

let probeImpl: (t: ProbeTarget) => Promise<boolean> = defaultProbe;
let probeIntervalMs = NETWORK_PROBE_INTERVAL_MS;

/** 仅测试:换掉探网实现与间隔(传 null 复原)。 */
export function __setNetworkProbeForTests(probe: ((t: ProbeTarget) => Promise<boolean>) | null, intervalMs?: number): void {
  probeImpl = probe ?? defaultProbe;
  probeIntervalMs = intervalMs ?? NETWORK_PROBE_INTERVAL_MS;
}

/** 探一次:true = 网通。用户点停立刻抛 AbortError(底层解析 / 连接不等它)。 */
export function probeNetwork(t: ProbeTarget, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(abortError());
  const p = probeImpl(t).catch(() => false);
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); });
  });
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
  /** up = 本来就通(没等);back = 断过、回来了;gave_up = 醒着等满 maxMs 还没通 */
  state: 'up' | 'back' | 'gave_up';
  /** 墙钟(含睡着的时间):上报 / 从重试预算里扣掉 */
  waitedMs: number;
  /** 醒着等的时间:算 30 分钟上限的 */
  awakeMs: number;
  since: number;
}

/**
 * 先探一次;通 → 立即返回 up。不通 → onWaiting(since) 一次(每段等待只报一次,不是每次探网),
 * 之后每 probeIntervalMs 探一次,通了返回 back,醒着等满 maxMs 返回 gave_up。用户点停抛 AbortError。
 * 等的中途合盖:两次探网之间远超一个周期的那段按一个周期算 —— 否则通勤路上合盖 2 小时,醒来 Wi-Fi 还没连上那一探
 * 就因「早过了 30 分钟」放弃,正是这一步要接住的场景。
 */
export async function waitForNetwork(opts: {
  target: ProbeTarget;
  signal?: AbortSignal;
  maxMs?: number;
  onWaiting?: (since: number) => void;
}): Promise<NetworkWaitResult> {
  const { target, signal } = opts;
  if (await probeNetwork(target, signal)) return { state: 'up', waitedMs: 0, awakeMs: 0, since: 0 };
  const since = Date.now();
  const maxMs = opts.maxMs ?? NETWORK_WAIT_MAX_MS;
  opts.onWaiting?.(since);
  let awakeMs = 0;
  let prev = since;
  for (;;) {
    const left = maxMs - awakeMs;
    if (left <= 0) return { state: 'gave_up', waitedMs: Date.now() - since, awakeMs, since };
    await sleepOrAbort(Math.min(probeIntervalMs, left), signal);
    const ok = await probeNetwork(target, signal);
    const now = Date.now();
    const dt = now - prev;
    prev = now;
    awakeMs += dt > probeIntervalMs + SLEEP_GAP_MS ? probeIntervalMs : dt; // 睡着的那段不算
    if (ok) return { state: 'back', waitedMs: now - since, awakeMs, since };
  }
}
