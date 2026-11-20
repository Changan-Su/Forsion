import { LlmError } from '../core/types.js';
import { isOfflineLlmError, isLocalTransportError, probeTargetOf, probeNetwork, waitForNetwork, sleepOrAbort, NETWORK_WAIT_MAX_MS } from './netWait.js';
import { lastWakeAt, sleepIntervals, sleptMsBetween } from './sleepDetector.js';

/** 有界重试判别:LLM 流式调用抛的错是否值得重试。
 *  - 用户主动 abort(name==='AbortError')→ 否(标 aborted,不是失败)
 *  - LlmError:4xx 客户端错(除 408/425/429)不重试;5xx / 408 / 425 / 429 / status 0(含 idle 504)→ 是
 *  - 其余(纯传输错,如 undici "fetch failed" 的 TypeError)→ 是
 *  注意:调用方还须自守「本次尝试已吐过帧就不重试」,否则会向客户端重复流。 */
export function isRetryableLlmError(err: unknown): boolean {
  if ((err as any)?.name === 'AbortError') return false;
  if (err instanceof LlmError) {
    // 额度 / 配额耗尽常以 429 返回,但要几小时才重置:必须先于状态码判,否则白重试 3 次(PI-DSH 评审 R5,借 pi retry.ts)。
    if (quotaExhaustedErr(err)) return false;
    const s = err.status;
    return s === 0 || s === 408 || s === 425 || s === 429 || s >= 500;
  }
  return true;
}

/** 上游在说「凭证失效」:401,或 xAI CLI proxy 那种用 502 包装的认证失败(只能看报错正文)。
 *  同一个 token 再试必败 —— 调用方应先续期(brain.llm.refreshModelKey),续不了就别重试。 */
export function isAuthExpiredLlmError(err: unknown): boolean {
  return err instanceof LlmError && (err.status === 401 || AUTH_EXPIRED.test(err.message));
}
const AUTH_EXPIRED = /expired credentials|invalid or expired|token (has |is )?expired|PermissionDenied/i;

/** 回灌的加密推理 / 思考签名被上游拒收(换了账号、组织或厂商签的):拿掉推理条目重发一次就能过,原样重试必败。
 *  不看状态码 —— Codex 在 HTTP 400 和流里的 response.failed 两条路都会送来(借 magpie affinity.go foreignReasoning)。 */
export function isForeignReasoningLlmError(err: unknown): boolean {
  return err instanceof LlmError && FOREIGN_REASONING.test(`${(err as { code?: string }).code || ''} ${err.message}`);
}
const FOREIGN_REASONING = /invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content|invalid `?signature`? in `?thinking`? block/i;

/** 订阅额度 / 账单配额用尽(几小时才重置,不是秒级限流)。额度用完接力(llm/quotaRelay.ts)只认这一组。 */
export function isQuotaExhaustedLlmError(err: unknown): boolean {
  return err instanceof LlmError && quotaExhaustedErr(err);
}
/** 订阅额度 / 账单配额用尽的措辞(不可重试)。「rate limit」是秒级限流,不在此列。 */
const QUOTA_EXHAUSTED = /usage limit|usage_limit_reached|usage_not_included|insufficient_quota|quota exceeded|exceeded your current quota|out of budget|billing_hard_limit/i;
/** 写着一分钟以内的窗口、又没提按天 / 余额的「quota exceeded」是限流(Gemini …PerMinute、Vertex requests_per_minute、
 *  百炼 Allocated quota exceeded 其实是 TPM):照常退避重试,也不触发额度接力(借 magpie d83f887a7)。按天的仍算额度用完。 */
const SHORT_WINDOW = /per ?minute|perminute|_per_minute|\b[RT]PM\b|per ?second|allocated quota exceeded/i;
const LONG_WINDOW = /per ?day|perday|_per_day|daily|per ?month|monthly|balance|credit|insufficient_quota|usage_limit_reached|billing_hard_limit/i;
/** 流里的失败只有 error.code 写着 usage_limit_reached 时，正文可能是一句别的话:code 一起看。 */
const quotaExhaustedErr = (err: LlmError): boolean => quotaExhaustedText(`${err.message} ${(err as { code?: string }).code || ''}`);
export const quotaExhaustedText = (msg: string): boolean => QUOTA_EXHAUSTED.test(msg) && !(SHORT_WINDOW.test(msg) && !LONG_WINDOW.test(msg));

export const MODEL_MAX_RETRIES = 3; // 首次 + 至多 3 次重试 = 4 次尝试
/** 服务过载(529 / 503 / 「overloaded」「服务繁忙」)多给几次:过载通常几十秒内缓解,3 次指数退避只覆盖 ~7 秒。 */
export const MODEL_OVERLOAD_MAX_RETRIES = 6;
/** 指数退避:1s 起翻倍(1/2/4/8/16/30s),上限 30s,±20% 抖动(同一时刻断线的一批客户端别同时砸回去)。 */
export const MODEL_RETRY_BASE_MS = 1000;
export const MODEL_RETRY_MAX_MS = 30_000;
export const MODEL_RETRY_JITTER = 0.2;
/** 服务端 Retry-After 在这以内就照它等;要等更久就不等了,按失败处理(一分钟以上的等待不该让用户对着转圈)。 */
export const RETRY_AFTER_MAX_MS = 60_000;
/**
 * 单次尝试耗时超过此值就不再重试(慢失败一票否决,优先级高于 isRetryableLlmError)。
 *
 * 重试的前提是「失败很便宜」:fetch failed / 502 / 429 都是秒级崩,重试三次几乎不花用户时间。
 * 而上游静默到 idle 看门狗超时是分钟级——服务端 180s idle 504 若照旧重试三次,最终失败要
 * 4×180+9 = 729s(~12min),用户体感和「一直没反应」没差别。按耗时判而非按 status 判,
 * 是为了让未来任何新增的慢失败路径自动落进这条保护里。
 */
export const SLOW_FAIL_NO_RETRY_MS = Number(process.env.TANGU_SLOW_FAIL_NO_RETRY_MS) || 60_000;

/** 第 attempt 次重试(从 1 起)前的退避;rng 可注入(测试用固定序列)。上限在抖动之后再卡,30s 是硬顶。 */
export function llmBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const base = MODEL_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jittered = base * (1 + MODEL_RETRY_JITTER * (2 * rng() - 1));
  return Math.round(Math.min(MODEL_RETRY_MAX_MS, jittered));
}

/** 服务过载(不是限流、不是额度用完):HTTP 529 / 503,或正文 / code 写着 overloaded、server busy、服务繁忙。
 *  流里来的过载(Anthropic overloaded_error)是 LlmError(502) + code,所以 code 和正文一起看。 */
export function isOverloadedLlmError(err: unknown): boolean {
  if (!(err instanceof LlmError) || quotaExhaustedErr(err)) return false;
  return err.status === 529 || err.status === 503 || OVERLOADED.test(`${err.message} ${(err as { code?: string }).code || ''}`);
}
const OVERLOADED = /overloaded|server (is )?busy|server_busy|服务(器)?繁忙|系统繁忙/i;

/**
 * 解析响应头里的 Retry-After(毫秒):`retry-after-ms`(OpenAI / Anthropic 自家)优先,其次 `retry-after`
 * (秒数或 HTTP-date)。没有这个头 → undefined。过去的日期 → 0(现在就可以)。
 * 写了但不合法(负数、乱写、算出来溢出)→ Infinity:按「超过 60 秒」处理,不重试 —— 服务端说了要等,读不懂不能当没说。
 */
export function parseRetryAfterMs(headers: { get(name: string): string | null } | null | undefined, now = Date.now()): number | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms != null && ms.trim() !== '') {
    const n = Number(ms);
    return /^\s*\d+(\.\d+)?\s*$/.test(ms) && Number.isFinite(n) ? Math.round(n) : Infinity;
  }
  const ra = headers.get('retry-after');
  if (ra == null || ra.trim() === '') return undefined;
  if (/^\s*\d+(\.\d+)?\s*$/.test(ra)) {
    const n = Number(ra) * 1000;
    return Number.isFinite(n) ? Math.round(n) : Infinity;
  }
  // HTTP-date 一定带月份 / 星期的字母;「-5」「+3」这种 Date.parse 也认(当成年份),不能当日期
  if (!/[a-z]/i.test(ra)) return Infinity;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : Infinity;
}

/** 把响应头里的 Retry-After 挂到报错上(err.retryAfterMs);LLM 客户端抛 HTTP 错之前过一遍。 */
export function withRetryAfter<E>(err: E, headers: { get(name: string): string | null } | null | undefined): E {
  const ms = parseRetryAfterMs(headers);
  if (ms !== undefined && err && typeof err === 'object') (err as { retryAfterMs?: number }).retryAfterMs = ms;
  return err;
}

/** 报错上的 Retry-After:没有 → undefined;不是合法的非负有限数 → Infinity(按超限处理)。 */
export const retryAfterMsOf = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object' || !('retryAfterMs' in err)) return undefined;
  const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Infinity;
};

/** 服务端说要等多久就照它等,但总长不越过 60 秒边界(抖动只往上加、不越界)。 */
const retryAfterWaitMs = (ra: number, rng: () => number): number =>
  Math.min(RETRY_AFTER_MAX_MS, ra + Math.round(rng() * Math.min(1000, Math.max(200, ra * 0.1))));

/**
 * Retry-After 的统一约束(探网放行、中流续写、multiBrain 降档重发前都先过它):
 * none = 没给;wait = 照它等(≤60s);refuse = 超过 60s / 不合法,不重试(任何免费重发分支都不能放行)。
 */
export function retryAfterVerdict(err: unknown, rng: () => number = Math.random): { kind: 'none' } | { kind: 'wait'; ms: number; retryAfterMs: number } | { kind: 'refuse' } {
  const ra = retryAfterMsOf(err);
  if (ra === undefined) return { kind: 'none' };
  if (!(ra <= RETRY_AFTER_MAX_MS)) return { kind: 'refuse' };
  return { kind: 'wait', ms: retryAfterWaitMs(ra, rng), retryAfterMs: ra };
}

/** [from, to] 内若干区间的并集长度(重叠只算一次)。 */
function unionLength(intervals: Array<{ start: number; end: number }>, from: number, to: number): number {
  const clipped = intervals
    .map((x) => ({ start: Math.max(from, x.start), end: Math.min(to, x.end) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const x of clipped) {
    if (x.start > curE) { if (curE > curS) total += curE - curS; curS = x.start; curE = x.end; }
    else curE = Math.max(curE, x.end);
  }
  if (curE > curS) total += curE - curS;
  return total;
}

/** 重试链共用墙钟预算,包含退避;只决定是否再发请求,不假装中止仍在执行的请求。睡着的那段不算(睡前已花的照算)。 */
export function llmRetryBudgetExceeded(chainStartedAt: number, nextWaitMs = 0): boolean {
  const now = Date.now();
  return now - chainStartedAt - sleptMsBetween(chainStartedAt, now) + nextWaitMs >= SLOW_FAIL_NO_RETRY_MS;
}

/** 一次重试的计划(status/llm_retry 的载荷来源)。 */
export interface LlmRetryPlan {
  /** 第几次重试(从 1 起) */
  attempt: number;
  max: number;
  waitMs: number;
  /** 服务过载 → 界面说「服务繁忙」 */
  overload: boolean;
  /** 服务端点名的等待(Retry-After) */
  retryAfterMs?: number;
}

/** 一个 run 的账本:醒着等网累计(首帧前 / build-payload / 中流共用,≤30 分钟)、免费重发与免费续写次数。 */
export interface RunNetLedger {
  awakeMs: number;
  /** 首帧前 / build-payload 在「网络恢复 / 跨睡眠」后的免费重发(不扣次数)。 */
  freeRetries: number;
  /** 中流在「网络恢复 / 跨睡眠」后的免费续写(不扣 MIDSTREAM_MAX_RESUMES)。 */
  freeResumes: number;
}
/** 整 run 的免费重发上限:用完之后网回来照样重发,但扣普通次数。 */
export const RUN_MAX_FREE_RETRIES = 2;
/** 整 run 的免费中流续写上限(和普通 MIDSTREAM_MAX_RESUMES 同量级)。 */
export const MIDSTREAM_MAX_FREE_RESUMES = 3;
export const createRunNetLedger = (): RunNetLedger => ({ awakeMs: 0, freeRetries: 0, freeResumes: 0 });

/** 等网络的回调(给了它才开等网络:后台调用没人看状态,干等 30 分钟不如照旧失败)。 */
export interface LlmNetworkHooks {
  /** 请求地址:报错里没带主机时按它探网 */
  target?: string;
  /** 进入等待(每段一次) */
  onWaiting?: (since: number, err: unknown) => void;
  /** 网回来了,马上重发 */
  onBack?: (waitedMs: number, since: number) => void;
  /** 本 run 的账本(没给就每条链自己一份) */
  ledger?: RunNetLedger;
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * 探网并等网回来,醒着的等待记进账本。up = 本来就通;back = 断过、回来了;gave_up = 账本里的 30 分钟用完了;
 * unknown = 探不出(配了代理 / 不知道探谁),不进长等。assumeDown = 调用方刚探过、确认断了。
 */
export async function awaitNetwork(
  err: unknown,
  hooks: LlmNetworkHooks,
  ledger: RunNetLedger,
  signal: AbortSignal | undefined,
  opts: { assumeDown?: boolean } = {},
): Promise<{ state: 'up' | 'back' | 'gave_up' | 'unknown'; since: number; waitedMs: number }> {
  const target = probeTargetOf(err, hooks.target);
  if (!target) return { state: 'unknown', since: 0, waitedMs: 0 };
  const r = await waitForNetwork({
    target, signal, maxMs: NETWORK_WAIT_MAX_MS - ledger.awakeMs, assumeDown: opts.assumeDown,
    onWaiting: (since) => hooks.onWaiting?.(since, err),
  });
  ledger.awakeMs += r.awakeMs;
  if (r.state === 'back') hooks.onBack?.(r.waitedMs, r.since);
  return r;
}

/** 探一次网(不等):down = 确认断了(调用方先落库再 awaitNetwork({assumeDown}));其余同 awaitNetwork。 */
export async function probeOnce(err: unknown, hooks: LlmNetworkHooks, signal?: AbortSignal): Promise<'up' | 'down' | 'unknown'> {
  const target = probeTargetOf(err, hooks.target);
  if (!target) return 'unknown';
  return probeNetwork(target, signal);
}

/**
 * 一条重试链(一次模型调用的若干次尝试)的状态与决策:agentLoop 的首帧前重试与 withLlmRetry 共用。
 *
 * 预算(SLOW_FAIL_NO_RETRY_MS,60s)= 链开始到现在的墙钟,减去「不计预算的区间」与「睡眠区间」的并集(重叠只扣一次,
 * 不会算出负数;睡前已花的照算)。不计预算的:服务端点名的等待(Retry-After)、服务繁忙的退避、等网。
 * 否则 6 次过载重试(退避合计 ~61s)和 60s 的 Retry-After 永远轮不到。慢失败一票否决照旧:请求本身耗满 60s 就不再重发。
 */
export class LlmRetryChain {
  private retries = 0;
  private readonly startedAt = Date.now();
  private readonly excluded: Array<{ start: number; end: number }> = [];
  private readonly ownLedger = createRunNetLedger();
  constructor(private readonly rng: () => number = Math.random) {}

  /** 这条链已经花掉的预算(醒着、且不在不计预算的等待里的时间)。 */
  budgetUsed(now = Date.now()): number {
    return Math.max(0, now - this.startedAt - unionLength([...this.excluded, ...sleepIntervals()], this.startedAt, now));
  }

  budgetExceeded(nextWaitMs = 0): boolean {
    return this.budgetUsed() + nextWaitMs >= SLOW_FAIL_NO_RETRY_MS;
  }

  private excludeSpan(start: number, end: number): void {
    if (end > start) this.excluded.push({ start, end });
  }

  /** 不探网、不等:这次失败值不值得再试、等多久。null = 放弃。决定重试即记一次。 */
  plan(err: unknown): (LlmRetryPlan & { excludedFromBudget: boolean }) | null {
    if (!isRetryableLlmError(err)) return null;
    const ra = retryAfterVerdict(err, this.rng);
    if (ra.kind === 'refuse') return null;
    const overload = isOverloadedLlmError(err);
    const max = overload ? MODEL_OVERLOAD_MAX_RETRIES : MODEL_MAX_RETRIES;
    if (this.retries >= max) return null;
    const attempt = this.retries + 1;
    const waitMs = ra.kind === 'wait' ? ra.ms : llmBackoffMs(attempt, this.rng);
    const excludedFromBudget = ra.kind === 'wait' || overload;
    if (this.budgetExceeded(excludedFromBudget ? 0 : waitMs)) return null;
    this.retries = attempt;
    return { attempt, max, waitMs, overload, ...(ra.kind === 'wait' ? { retryAfterMs: ra.retryAfterMs } : {}), excludedFromBudget };
  }

  /**
   * 处理一次失败:要么等好了返回(true = 这次重发不扣次数:等过网 / 本地传输中断跨过了一次睡眠),要么抛出(原错 / AbortError)。
   *  - Retry-After 超过 60s / 不合法 → 直接放弃,任何探网分支都不放行。
   *  - 开了等网络、报错是断网类,或本地传输中断跨过了睡眠 → 探网:断了就等(不算预算,醒着累计 ≤30 分钟,账本整 run 共用);
   *    回来后免费重发(整 run ≤ RUN_MAX_FREE_RETRIES 次,用完就照常扣次数);探不出(代理)→ 不等,照常走计划。
   *  - 计划说放弃时,本地传输中断再探一次:真断了照样等网。
   */
  async recover(err: unknown, attemptStartedAt: number, hooks: { signal?: AbortSignal; network?: LlmNetworkHooks; onRetry?: (plan: LlmRetryPlan, err: unknown) => void } = {}): Promise<boolean> {
    const { signal, network } = hooks;
    if (signal?.aborted) throw abortError();
    if (!isRetryableLlmError(err)) throw err;
    if (retryAfterVerdict(err).kind === 'refuse') throw err;
    const ledger = network?.ledger ?? this.ownLedger;
    const local = isLocalTransportError(err);
    // 跨睡眠的免费重发只给本地传输中断(拿到 HTTP 响应的 503 等不算),且不越过 Retry-After
    const woke = local && retryAfterMsOf(err) === undefined && attemptStartedAt < lastWakeAt();
    const tryFree = (): boolean => {
      if (ledger.freeRetries >= RUN_MAX_FREE_RETRIES) return false;
      ledger.freeRetries++;
      return true;
    };
    let probed = false;
    if (network && (woke || isOfflineLlmError(err))) {
      probed = true;
      const r = await this.waitNetwork(err, network, ledger, signal);
      if (r === 'gave_up') throw err;
      if ((r === 'back' || (r === 'up' && woke)) && tryFree()) return true;
    }
    const plan = this.plan(err);
    if (!plan) {
      if (network && !probed && local && (await this.waitNetwork(err, network, ledger, signal)) === 'back' && tryFree()) return true;
      throw err;
    }
    hooks.onRetry?.(plan, err);
    const t0 = Date.now();
    await sleepOrAbort(plan.waitMs, signal);
    if (plan.excludedFromBudget) this.excludeSpan(t0, Date.now());
    // timer/事件循环可能晚唤醒:睡前有余量不代表醒后仍可再发一次请求。
    if (this.budgetExceeded()) throw err;
    return false;
  }

  private async waitNetwork(err: unknown, network: LlmNetworkHooks, ledger: RunNetLedger, signal: AbortSignal | undefined): Promise<'up' | 'back' | 'gave_up' | 'unknown'> {
    const r = await awaitNetwork(err, network, ledger, signal);
    if (r.state === 'back') this.excludeSpan(r.since, r.since + r.waitedMs);
    return r.state;
  }
}

/**
 * 中流断线续写之前,第一步:探一次网(不等)。只给本地传输中断(重置 / 本地静默超时)和跨睡眠的。
 * down = 确认断了:调用方先把屏上那截落库,再 awaitNetwork({assumeDown}) 等网;woke = 跨过睡眠、网通:免费续写一次;
 * no = 网是通的 / 探不出 / 没开等网:照常按次数续写。
 */
export async function probeBeforeResume(err: unknown, attemptStartedAt: number, hooks: { signal?: AbortSignal; network?: LlmNetworkHooks }): Promise<'down' | 'woke' | 'no'> {
  if (!hooks.network || !isLocalTransportError(err)) return 'no';
  const woke = attemptStartedAt < lastWakeAt();
  const r = await probeOnce(err, hooks.network, hooks.signal);
  if (r === 'down') return 'down';
  return r === 'up' && woke ? 'woke' : 'no';
}

/**
 * 给一次性的 LLM 前置调用(resolve / build-payload)与子代理 / 压缩的调用套同一套有界重试(LlmRetryChain)。
 *
 * 这两步此前在 agentLoop 的重试圈**外面**(build-payload 在圈前构建 payload),结构上零重试:
 * 托管面一次秒级 `fetch failed` 就能报废一个已经跑了几分钟的 run(2026-08-27 桌面端 2.8.1 实证)。
 * 慢失败一票否决照旧 —— 撞满超时的大 body 上传重试 4 次只是把干等 ×4。
 * 等网络只在传了 network 时开(主循环的 build-payload);resolve / 子代理 / 压缩照旧失败。
 * canRetry 在决定重试前、等完真要重发前各问一次(子代理据此在退避期间被兄弟推过成本上限时不再发)。
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, waitMs: number, err: unknown, plan: LlmRetryPlan) => void,
  signal?: AbortSignal,
  /** 流式调用方用:本次尝试已向客户端吐过帧就返回 false,不重发(否则重复流)。 */
  canRetry?: () => boolean,
  network?: LlmNetworkHooks,
): Promise<T> {
  const chain = new LlmRetryChain();
  for (;;) {
    if (signal?.aborted) throw abortError();
    const attemptStartedAt = Date.now();
    try {
      return await fn();
    } catch (err) {
      // 慢失败按**累计**耗时判,不只看本次尝试:网关在完整收下大 body 后于 59s 回 502,逐次判定
      // 每次都「不算慢」,4 次重传一个数 MB 的 build-payload ≈ 249s + 4 倍上行(Codex 评审逮到)。
      // 退避期间用户点了停 → 立刻放弃并抛 AbortError,否则最终抛的是传输错、run 被误记成 failed。
      if (signal?.aborted) throw abortError();
      if (canRetry?.() === false) throw err;
      await chain.recover(err, attemptStartedAt, { signal, network, onRetry: (plan, e) => onRetry?.(plan.attempt, plan.waitMs, e, plan) });
      if (canRetry?.() === false) throw err;
    }
  }
}

export { sleepOrAbort };
