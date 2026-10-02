/**
 * 客户端原生动作(手机操控 phone_* 等)的请求登记表 —— 引擎 → 发起端原生层的一次往返。
 * 形状照 uiAck.ts(发事件 + 登记 resolver + 回程借 inquiries 路由),但多一道 **claim**:
 * 契约正典 tangu-agent/docs/phone-control.md §3。
 *
 *   requestClientAction → publish 'client_cmd' {ackId, ns, body}
 *     → 网关 SSE → 渲染层只做转交(JS 不回执)→ 原生
 *     → POST inquiries/cc_… {phase:'claim', digest, claimant} → 200 {nonce, execMs} | 410
 *     →(需确认的 op){phase:'commit', nonce}           → 200 | 410
 *     → {phase:'result', nonce, ok, code?, …}          → 200 | 410
 *
 * ⚠️ **本表是唯一权威**:原生没 claim 到 nonce 就绝不执行。重放、至少一次投递、worker 重启、JS 伪造 body,
 *    都在 claim 这一步 fail closed —— 所以任何不符(runId / digest / nonce / 状态 / 已兑现)一律回 null → 410,
 *    不区分原因,不泄露某个 ackId 是否存在(同 uiAck 的口径)。
 * ⚠️ 两段计时:pending(claimMs)→ claimed(execMs,claim 成功时重置)。pending 超时 = 手机根本没接,
 *    **什么都没发生**(之后迟到的 claim 拿 410);claimed 超时 = 手机接了但没回,**可能做了也可能没做**。
 *    两种文案必须分开写,模型据此决定「告诉用户」还是「请用户先看一眼手机」。
 * ⚠️ 事件名 `client_cmd` 必须 ≤24 字符(agent_run_events.type 是 VARCHAR(24);Postgres 强制、SQLite 不强制,
 *    超长 = 桌面全绿、上云静默不落库)。
 * ⚠️ 中止:调用方的 signal(工具作用域,含 registry 超时)**与** run 级 signal 都监听 —— 插件传一个与 run 无关的
 *    AbortController 时,用户按停也必须立刻兑现并删掉登记(之后的 claim / commit / result 一律 410)。
 *    中止与超时同样按状态分两种码、两种文案:pending 中止 = `aborted`(之后的 claim 拿 410,**协议保证什么都没做**);
 *    claimed 中止 = `aborted_claimed`(手机已经领走,不需确认的 op 可能早已执行完 —— **可能做了也可能没做**)。
 *    后者绝不能说「什么都不会发生」:模型会据此对用户说「没做」然后重试,闹钟 / 打开的 App 就多出一份。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { publish } from './eventBus.js';
import type { ClientActionOptions, ClientActionRequest, ClientActionResult } from '../tools/toolTypes.js';

export const CLIENT_CMD_EVENT = 'client_cmd';

export const CLAIM_MS = { def: 15_000, min: 3_000, max: 30_000 } as const;
export const EXEC_MS = { def: 20_000, min: 5_000, max: 120_000 } as const;
/** body 体积上限:tool 参数本身有上限,这里是给插件调用方的兜底(body 会原样进 agent_run_events 与 SSE)。 */
const MAX_BODY_CHARS = 64_000;

/** pending 超时:手机从没 claim —— 由协议保证什么都没做。 */
export const NOT_PICKED_UP_TEXT =
  'The phone never picked this up, so nothing was done on it. Forsion on the phone may be closed or in the background '
  + 'for too long, phone control may be switched off, or the conversation continued on another device. '
  + 'Tell the user; do not retry blindly.';
/** claimed 超时:手机接了没回 —— 可能做了也可能没做。 */
export const NO_REPORT_TEXT =
  'The phone accepted the action but never reported back, so it may or may not have happened. '
  + 'Ask the user to check the phone before retrying.';
/** claimed 期内被中止(run 停止 / 调用方信号):手机已领走,同 no_report —— 可能做了也可能没做。 */
export const ABORTED_CLAIMED_TEXT =
  'Cancelled after the phone had already accepted the action, so it may or may not have happened. '
  + 'Ask the user to check the phone before retrying.';

const NS_RE = /^[a-z][a-z0-9-]{0,23}$/;
const OP_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** 原生每次 exec 自生成的随机领取者 id(只在它那次 exec 的唯一一次重试里复用)。 */
const CLAIMANT_RE = /^[A-Za-z0-9_-]{16,64}$/;

interface Entry {
  runId: string;
  digest: string;
  label: string;
  state: 'pending' | 'claimed';
  nonce?: string;
  /** 首次 claim 带来的领取者 id;幂等重领只认它。 */
  claimant?: string;
  execMs: number;
  deadline: number;
  t0: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (r: ClientActionResult) => void;
}

/** ackId → 登记。⚠️ 连 runId 一起存:路由只能证明 URL 里的 runId 属于调用者,证明不了 ackId 属于那条 run。 */
const pending = new Map<string, Entry>();
let seq = 0;

const clamp = (v: number | undefined, spec: { def: number; min: number; max: number }): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, Math.round(v))) : spec.def;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 凭据比较:先比字节长度(timingSafeEqual 长度不等会抛),再定时比较。 */
function secretMatches(want: string | undefined, n: unknown): boolean {
  if (typeof n !== 'string' || !want) return false;
  const a = Buffer.from(n, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const fail = (code: string, error: string): ClientActionResult => ({ ok: false, code, error });

/** 本 run 的绑定:闭包里只有这些,调用方(工具 / 插件)指定不了别的 run。 */
export interface ClientActionBinding {
  runId: string;
  sessionId: string;
  /** 本 run 声明的能力(冻结)。ns 必须命中其中某个 `<ns>.*`。 */
  caps: readonly string[];
  /** run 级中止信号:无论调用方传什么 signal,都一并监听。 */
  runSignal?: AbortSignal;
}

/** 登记一次客户端动作:发 `client_cmd` + 等原生 claim / 回执(超时与中止都按失败兑现,绝不挂 loop)。 */
export function requestClientAction(
  bind: ClientActionBinding,
  req: ClientActionRequest,
  opts: ClientActionOptions = {},
): Promise<ClientActionResult> {
  const signals = [opts.signal, bind.runSignal].filter((s): s is AbortSignal => !!s);
  if (signals.some((s) => s.aborted)) return Promise.resolve(fail('aborted', 'aborted'));
  const ns = String(req?.ns ?? '');
  const op = String(req?.op ?? '');
  if (!NS_RE.test(ns) || !bind.caps.some((c) => c.startsWith(`${ns}.`))) {
    return Promise.resolve(fail('undeclared', `This conversation did not come from a client that declared "${ns.slice(0, 24)}" capabilities, so nothing can be sent to it.`));
  }
  if (!OP_RE.test(op)) return Promise.resolve(fail('invalid_args', 'invalid op name'));
  if (req.args != null && (typeof req.args !== 'object' || Array.isArray(req.args))) {
    return Promise.resolve(fail('invalid_args', 'args must be an object'));
  }

  // 随机段:这个 id 进 SSE、进事件表,可以被看到 —— 真正的凭据是 claim 发的 nonce;随机段只让它不可预测。
  const ackId = `cc_${Date.now().toString(36)}_${++seq}_${randomBytes(9).toString('base64url')}`;
  let body: string;
  try {
    // ⚠️ body 是**字符串**进 payload:args 里即使有 NUL,序列化后也只是 `\u0000` 六个 ASCII 字符,
    //    不会让云端 JSONB 拒收整条事件。原生按 UTF-8 字节算 sha256 比对的就是这一串。
    body = JSON.stringify({
      v: 1, runId: bind.runId, sessionId: bind.sessionId, ackId, ns, op,
      args: req.args ?? {}, iat: Date.now(), target: { kind: 'origin' },
    });
  } catch {
    return Promise.resolve(fail('invalid_args', 'args are not serializable'));
  }
  if (body.length > MAX_BODY_CHARS) return Promise.resolve(fail('invalid_args', 'action is too large'));

  const claimMs = clamp(opts.claimMs, CLAIM_MS);
  const execMs = clamp(opts.execMs, EXEC_MS);
  const label = `${ns}.${op}`;
  const t0 = Date.now();
  // 单行、不写载荷(短信正文 / 剪贴板文字都在 args 里;引擎 stdout 进桌面日志环,整进程共用)。
  console.log(`[client-cmd] → ${label} (${ackId})`);

  return new Promise<ClientActionResult>((resolve) => {
    let settled = false;
    // ⚠️ 先读状态再 settle(settle 会删登记):claimed 期的中止不能沿用 pending 那句「什么都没发生」。
    const onAbort = (): void => settle(pending.get(ackId)?.state === 'claimed'
      ? fail('aborted_claimed', ABORTED_CLAIMED_TEXT)
      : fail('aborted', 'aborted'));
    const settle = (r: ClientActionResult): void => {
      if (settled) return;
      settled = true;
      const e = pending.get(ackId);
      if (e) clearTimeout(e.timer);
      pending.delete(ackId);
      for (const s of signals) s.removeEventListener('abort', onAbort);
      console.log(`[client-cmd] ← ${r.ok ? 'ok' : 'fail'} ${label} code=${r.code || (r.ok ? 'ok' : '-')} (${Date.now() - t0}ms)`);
      resolve(r);
    };
    const timer = setTimeout(() => settle(fail('not_picked_up', NOT_PICKED_UP_TEXT)), claimMs);
    timer.unref?.();
    pending.set(ackId, { runId: bind.runId, digest: sha256Hex(body), label, state: 'pending', execMs, deadline: t0 + claimMs, t0, timer, settle });
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
    // 发不出去就别干等 claimMs(SqlStateStore 的 INSERT 失败只打日志;抛错的实现在这里兜住,同步抛也算)。
    const undeliverable = (): void => settle(fail('error', 'Could not deliver the action to the phone. Tell the user; do not retry blindly.'));
    try {
      publish(bind.runId, CLIENT_CMD_EVENT, { ackId, ns, body }).catch(undeliverable);
    } catch {
      undeliverable();
    }
  });
}

/** agentLoop 装进 ToolContext.requestClientAction 的闭包(runId/sessionId/caps/run 信号都在这里绑死)。 */
export function makeClientActionRequester(bind: ClientActionBinding): (req: ClientActionRequest, opts?: ClientActionOptions) => Promise<ClientActionResult> {
  return (req, opts) => requestClientAction(bind, req, opts);
}

export type ClientAckMessage =
  | { phase: 'claim'; digest: unknown; claimant?: unknown }
  | { phase: 'commit'; nonce: unknown }
  | { phase: 'result'; nonce: unknown; result: ClientActionResult };

/**
 * HTTP 端点调用(routes/approvals.ts 的 cc_ 分支)。返回 null = 410(一切不符都走这里,不分原因)。
 *   claim  → { nonce, execMs };同 (ackId, digest, claimant) 在 claimed 期内**幂等**返回同一 nonce(网关丢了响应时
 *            原生可重试),execMs 回**剩余**时长且不重置计时 —— 重试循环不能把期限越拖越长。
 *            ⚠️ 幂等只认首次 claim 的 claimant:同账号两台手机都持有这条 run 的 G2 归属时会各自 claim 同一条指令
 *            (digest 相同、token 相同)。只比 digest 就把同一枚 nonce 发给两台 → 两台都执行;或关着开关的那台抢先
 *            回 `disabled`,引擎告诉模型「没做」而另一台已经做了。首次没带 claimant 的,重领一律 410(fail closed)。
 *   commit → {}:只证明「引擎仍在等、没被中止」,原生据此才执行需确认的 op。
 *   result → {}:兑现并删除。
 */
export function resolveClientAction(runId: string, ackId: string, msg: ClientAckMessage): { nonce: string; execMs: number } | Record<string, never> | null {
  const e = pending.get(ackId);
  if (!e || e.runId !== runId) return null;
  if (msg.phase === 'claim') {
    if (typeof msg.digest !== 'string' || !DIGEST_RE.test(msg.digest) || msg.digest !== e.digest) {
      // 登记确实存在、digest 却不符 = 伪造或篡改过的 body(或原生算错)。只记一行,不兑现:合法原生仍可 claim。
      console.log(`[client-cmd] ✗ claim digest mismatch ${e.label} (${ackId})`);
      return null;
    }
    // 带了就必须合规(畸形 = 不是合法原生);不带 = 老原生,只是失去重领资格。
    if (msg.claimant !== undefined && (typeof msg.claimant !== 'string' || !CLAIMANT_RE.test(msg.claimant))) return null;
    const now = Date.now();
    if (e.state === 'claimed') {
      if (!secretMatches(e.claimant, msg.claimant)) {
        console.log(`[client-cmd] ✗ re-claim by another claimant ${e.label} (${ackId})`);
        return null;
      }
      return { nonce: e.nonce!, execMs: Math.max(0, e.deadline - now) };
    }
    clearTimeout(e.timer);
    e.state = 'claimed';
    e.claimant = msg.claimant as string | undefined;
    e.nonce = randomBytes(18).toString('base64url');
    e.deadline = now + e.execMs;
    e.timer = setTimeout(() => e.settle(fail('no_report', NO_REPORT_TEXT)), e.execMs);
    e.timer.unref?.();
    console.log(`[client-cmd] ⇢ claimed ${e.label} (${ackId}) +${now - e.t0}ms`);
    return { nonce: e.nonce, execMs: e.execMs };
  }
  if (e.state !== 'claimed' || !secretMatches(e.nonce, msg.nonce)) return null;
  if (msg.phase === 'commit') return {};
  if (msg.phase === 'result') {
    e.settle(msg.result);
    return {};
  }
  return null;
}

/** 仅测试用:当前登记数(验证兑现 / 中止后确实删掉了)。 */
export function __pendingClientActionsForTest(): number {
  return pending.size;
}
