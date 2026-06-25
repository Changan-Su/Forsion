/**
 * 流式空闲看门狗(复用工具)。把 httpBrain 的内联帧级 idle 看门狗抽成一次性 guard:
 * 合并外部 abort 源 + 内部空闲计时,任一触发即 abort 内部 AbortController。
 *
 * 直连流(openaiCompat/anthropicMessages/openaiResponses)与 httpBrain 共用:fetch 用 guard.signal,
 * 每次 reader.read() 返回帧就 arm() 续命,结束 dispose()。
 *
 * 帧级(而非回调级 onToken)是有意为之:SSE keepalive(Anthropic 每 ~15-30s 一次 ping / OpenAI 注释行)会让
 * reader.read() 返回字节但不触发任何 onToken 回调;以「收到任意帧」续命才不会在模型静默思考期误杀健康流。
 */
import { LlmError } from '../core/types.js';

export interface StreamIdleGuard {
  /** 传给 fetch 的 signal(合并了 external abort 与内部空闲超时)。 */
  signal: AbortSignal;
  /** 收到任意帧后调用,重置空闲计时。 */
  arm(): void;
  /** 流正常/异常结束后调用,清计时器并摘除 external 监听(幂等)。 */
  dispose(): void;
}

const DEFAULT_IDLE_MS = Number(process.env.TANGU_STREAM_IDLE_TIMEOUT_MS) || 120_000;

export function streamIdleGuard(externalSignal?: AbortSignal, idleMs = DEFAULT_IDLE_MS): StreamIdleGuard {
  const ac = new AbortController();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const onExt = (): void => ac.abort((externalSignal as any)?.reason ?? new Error('aborted'));

  // 构造时 external 已 aborted → 立即把内部 ac 也 abort,别等帧(竞态保护)。
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort((externalSignal as any).reason);
    else externalSignal.addEventListener('abort', onExt, { once: true });
  }

  const arm = (): void => {
    if (disposed || ac.signal.aborted) return; // 已结束/已中止不再续命,杜绝 dispose 后野生 timer
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new LlmError(504, 'stream idle timeout')), idleMs);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (idle) { clearTimeout(idle); idle = null; }
    if (externalSignal) externalSignal.removeEventListener('abort', onExt);
  };

  return { signal: ac.signal, arm, dispose };
}

/**
 * idle abort 时 reader.read() 抛的 DOMException 的 .name 仍是 'AbortError',若不还原会被 agentLoop 误判成
 * 「用户主动停」(标 aborted 而非 failed)。按中止源还原语义:
 *   - 用户主动 abort(external 已 aborted)→ AbortError(agentLoop 标 'aborted')
 *   - 内部 idle 触发 → guard.signal.reason 上的 LlmError(504)(标 'failed' + 504 可读)
 *   - 真网络错(name 非 AbortError)→ 原样透传
 */
export function mapStreamAbort(err: unknown, guardSignal: AbortSignal, externalSignal?: AbortSignal): unknown {
  if ((err as any)?.name !== 'AbortError') return err;
  if (externalSignal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
  }
  const reason = (guardSignal as any).reason;
  return reason instanceof LlmError ? reason : new LlmError(504, 'stream idle timeout');
}

/**
 * 给一段流式 fn 套上 idle 看门狗 + abort 语义还原 + 清理。fn 收到 guard:用 guard.signal 发 fetch、
 * 每帧 guard.arm()。供无现成 try/finally 的直连流薄包一层,避免整段 body 缩进。
 */
export async function withStreamIdle<T>(
  externalSignal: AbortSignal | undefined,
  fn: (guard: StreamIdleGuard) => Promise<T>,
): Promise<T> {
  const guard = streamIdleGuard(externalSignal);
  try {
    return await fn(guard);
  } catch (err) {
    throw mapStreamAbort(err, guard.signal, externalSignal);
  } finally {
    guard.dispose();
  }
}
