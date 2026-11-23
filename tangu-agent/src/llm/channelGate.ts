/**
 * 通道闸(插件开发优化方案 2026-11-23 第三节 A + 第四节 B,用户 11-23「你来决定」= 按建议)。
 *
 * 通道 = 提供方 + 密钥(直连 / 订阅按 provider + 地址 + 账号或 key 的指纹;托管面按模型,托管的模型共用一个令牌,按令牌会让一个模型的限流卡住全部)。
 * 同一通道上所有会话(主会话、子会话、delegate 子代理)的模型请求共用这一份小状态:
 *  - **暂停**:任何一个请求撞上秒级限流(retry.ts isRateLimitedLlmError),整个通道暂停到报错给出的时刻(响应头 Retry-After 或正文「try again in Xs」;
 *    没给按 2 秒)。暂停期间别的请求排队,不再各自去撞 —— 第一轮 dogfood 四路并发各自退避 1/2/4 秒后一起撞上去,3 次用完照样失败。
 *    超过 60 秒的点名等待不暂停:撞上它的那一轮照旧按失败处理(retry.ts RETRY_AFTER_MAX_MS),别的会话不跟着干等。
 *  - **试探**:暂停结束只先放一个请求出去,它拿到响应头(或第一帧、或 5 秒没动静、或结束)再放其余的 —— 一起放会重演「退避完一起撞」。
 *  - **并发上限**:同一通道同时在飞的请求缺省 3 路(config.json models.channelConcurrency,设置里能改),超出的排队(先来先得)。
 *
 * 槽位只在一次请求的流里持有:退避、等网、工具执行期间都不占(调用方在拿到结果 / 失败后立刻 release,再去重试链里等)。
 * 快档 429 当场降档(adapters/standalone/multiBrain.ts)发生在这道闸里面的那次调用之内,不经过这里,#794 / #796 的不变式不动。
 * 重试次数照 #796,不由这里决定;这里只决定「什么时候能发」。状态只在进程内存。
 */
import { createHash } from 'node:crypto';
import { getRawSection } from '../core/config.js';
import { DIRECT_MARK, ACCOUNT_MARK } from './openaiCompat.js';
import { isRateLimitedLlmError, retryAfterMsOf, RETRY_AFTER_MAX_MS } from './retry.js';

export const CHANNEL_CONCURRENCY_DEFAULT = 3;
export const CHANNEL_CONCURRENCY_MAX = 16;
/** 撞了限流、报错没说等多久:按这么久暂停通道。 */
export const CHANNEL_PAUSE_DEFAULT_MS = 2000;
/** 试探请求多久没拿到响应头就当它放行了(托管面的长上传、某些代理不报响应头)。 */
const PROBE_TIMEOUT_MS = 5000;

/** 同一通道同时在飞的请求上限:config.json models.channelConcurrency,1–16 的整数;没设 / 不合法按 3。 */
export function channelConcurrency(): number {
  const v = Number((getRawSection('models') as any)?.channelConcurrency);
  return Number.isInteger(v) && v >= 1 ? Math.min(CHANNEL_CONCURRENCY_MAX, v) : CHANNEL_CONCURRENCY_DEFAULT;
}

/** 这次请求走的通道。key 只进进程内存和日志,不出这台机器;账号 / key 只留指纹。 */
export function channelKeyOf(model: any, baseUrl: string | undefined, apiKey: string | undefined, modelId: string): string {
  if (!model?.[DIRECT_MARK]) return `hosted:${modelId}`;
  const ident = String(model?.[ACCOUNT_MARK] || apiKey || '');
  const fp = ident ? createHash('sha256').update(ident).digest('hex').slice(0, 16) : 'nokey';
  return `direct:${model?.provider || ''}|${baseUrl || ''}|${fp}`;
}

export interface ChannelQueueInfo {
  /** rate_limit = 通道因限流暂停;busy = 同时在飞的请求到了上限 */
  reason: 'rate_limit' | 'busy';
  /** rate_limit:离暂停结束还有多久(毫秒) */
  waitMs?: number;
  /** 排在第几个(从 1 起) */
  position: number;
  limit: number;
}

interface Waiter {
  grant: (probe: boolean) => void;
  fail: (e: Error) => void;
  sessionId?: string;
  onQueued?: (q: ChannelQueueInfo) => void;
  lastReason?: ChannelQueueInfo['reason'];
}

interface Channel {
  pausedUntil: number;
  /** 暂停结束后先放一个出去试探 */
  needsProbe: boolean;
  probeOut: boolean;
  inflight: number;
  waiters: Waiter[];
  timer?: ReturnType<typeof setTimeout>;
}

const channels = new Map<string, Channel>();

const channelOf = (key: string): Channel => {
  let c = channels.get(key);
  if (!c) { c = { pausedUntil: 0, needsProbe: false, probeOut: false, inflight: 0, waiters: [] }; channels.set(key, c); }
  return c;
};

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

function notify(c: Channel, limit: number): void {
  const now = Date.now();
  const paused = c.pausedUntil > now || c.probeOut;
  c.waiters.forEach((w, i) => {
    const reason: ChannelQueueInfo['reason'] = paused ? 'rate_limit' : 'busy';
    // 同一个原因只报一次;暂停被延长(又撞了一次)时 rate_limit 再报一次新的等待
    if (w.lastReason === reason && reason === 'busy') return;
    w.lastReason = reason;
    try { w.onQueued?.({ reason, position: i + 1, limit, ...(reason === 'rate_limit' ? { waitMs: Math.max(0, c.pausedUntil - now) } : {}) }); } catch { /* 上报失败不影响排队 */ }
  });
}

function pump(key: string): void {
  const c = channels.get(key);
  if (!c) return;
  const now = Date.now();
  if (c.pausedUntil > now) {
    if (!c.timer) c.timer = setTimeout(() => { c.timer = undefined; pump(key); }, c.pausedUntil - now);
    return;
  }
  if (c.probeOut) return;
  const limit = channelConcurrency();
  while (c.waiters.length && c.inflight < limit) {
    const w = c.waiters.shift()!;
    c.inflight++;
    if (c.needsProbe) { c.needsProbe = false; c.probeOut = true; w.grant(true); break; }
    w.grant(false);
  }
  if (c.waiters.length) notify(c, limit);
  if (!c.waiters.length && !c.inflight && c.pausedUntil <= now && !c.probeOut) channels.delete(key);
}

export interface ChannelSlot {
  /** 响应开始(响应头到了 / 第一帧):是试探请求的话,放其余排队的 */
  opened(): void;
  /** 这次请求失败:是秒级限流就暂停整个通道 */
  failed(err: unknown): void;
  /** 请求结束(成功或失败都要调,只算一次) */
  release(): void;
  /** 这个槽位是暂停之后的试探请求 */
  readonly probe: boolean;
}

/** 通道暂停到 now + ms(只延长,不缩短);暂停结束后先放一个试探。 */
export function pauseChannel(key: string, ms: number): void {
  const c = channelOf(key);
  const until = Date.now() + Math.max(0, ms);
  if (until > c.pausedUntil) {
    c.pausedUntil = until;
    if (c.timer) { clearTimeout(c.timer); c.timer = undefined; }
  }
  c.needsProbe = true;
  notify(c, channelConcurrency());
  pump(key);
}

/** 秒级限流的暂停时长:报错点名的(≤60 秒)照它;没点名按 2 秒;点名超过 60 秒(那一轮自己会放弃)→ 不暂停。 */
export function pauseMsFor(err: unknown): number | null {
  if (!isRateLimitedLlmError(err)) return null;
  const ra = retryAfterMsOf(err);
  if (ra === undefined) return CHANNEL_PAUSE_DEFAULT_MS;
  return ra <= RETRY_AFTER_MAX_MS ? ra : null;
}

/**
 * 拿一个槽位(排队时 onQueued 报原因)。signal 中止 → 出队并抛 AbortError。
 * 拿到之后调用方必须 release();请求失败先 failed(err)。
 */
export function acquireChannel(key: string, opts: { signal?: AbortSignal; sessionId?: string; onQueued?: (q: ChannelQueueInfo) => void } = {}): Promise<ChannelSlot> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(abortError());
  const c = channelOf(key);
  return new Promise<ChannelSlot>((resolve, reject) => {
    let isProbe = false;
    const make = (): ChannelSlot => {
      let released = false;
      let opened = false;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      const open = (): void => {
        if (opened) return;
        opened = true;
        if (probeTimer) clearTimeout(probeTimer);
        if (isProbe && c.probeOut) { c.probeOut = false; pump(key); }
      };
      if (isProbe) probeTimer = setTimeout(open, PROBE_TIMEOUT_MS);
      return {
        get probe() { return isProbe; },
        opened: open,
        failed: (err) => {
          const ms = pauseMsFor(err);
          if (ms !== null) {
            // 试探又撞了:不放其余的,重新暂停(再来一个试探)
            if (isProbe && !opened) { opened = true; if (probeTimer) clearTimeout(probeTimer); c.probeOut = false; }
            pauseChannel(key, ms);
          }
        },
        release: () => {
          if (released) return;
          released = true;
          c.inflight = Math.max(0, c.inflight - 1);
          open();
          pump(key);
        },
      };
    };
    const w: Waiter = {
      sessionId: opts.sessionId,
      onQueued: opts.onQueued,
      grant: (probe) => {
        signal?.removeEventListener('abort', onAbort);
        isProbe = probe;
        resolve(make());
      },
      fail: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
    };
    const onAbort = (): void => {
      const i = c.waiters.indexOf(w);
      if (i >= 0) c.waiters.splice(i, 1);
      w.fail(abortError());
      pump(key);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    c.waiters.push(w);
    pump(key);
    if (c.waiters.includes(w)) notify(c, channelConcurrency());
  });
}

/** 正在通道闸前排队的会话(会话列表的「排队中」)。 */
export function queuedSessionIds(): Set<string> {
  const out = new Set<string>();
  for (const c of channels.values()) for (const w of c.waiters) if (w.sessionId) out.add(w.sessionId);
  return out;
}

/** 测试用。 */
export function __channelState(key: string): { pausedUntil: number; inflight: number; waiting: number; probeOut: boolean } | null {
  const c = channels.get(key);
  return c ? { pausedUntil: c.pausedUntil, inflight: c.inflight, waiting: c.waiters.length, probeOut: c.probeOut } : null;
}
export function __resetChannels(): void {
  for (const c of channels.values()) if (c.timer) clearTimeout(c.timer);
  channels.clear();
}

/**
 * 包一次流式请求:排队拿槽位 → 调用 → 失败先记限流再放槽位。给 agentLoop 以外的调用方(delegate 子代理)用;
 * fn 拿到槽位,在响应开始 / 第一帧时调 slot.opened()(暂停后的试探请求据此放其余的)。onWaited = 排队了多久(调用方从重试预算里扣掉)。
 */
export async function withChannelSlot<T>(
  key: string,
  opts: { signal?: AbortSignal; sessionId?: string; onQueued?: (q: ChannelQueueInfo) => void; onWaited?: (start: number, end: number) => void },
  fn: (slot: ChannelSlot) => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let queued = false;
  const slot = await acquireChannel(key, { ...opts, onQueued: (q) => { queued = true; opts.onQueued?.(q); } });
  if (queued) opts.onWaited?.(start, Date.now());
  try {
    return await fn(slot);
  } catch (err) {
    slot.failed(err);
    throw err;
  } finally {
    slot.release();
  }
}
