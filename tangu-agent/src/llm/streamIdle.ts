/**
 * 流式看门狗:分别追踪传输字节与模型语义进展,并合并外部取消。
 *
 * 直连流(openaiCompat/anthropicMessages/openaiResponses)与 httpBrain 共用:fetch 用 guard.signal,
 * 用 read(reader) 消费流,解析出非空正文/思考/工具增量后调用 progress(),结束 dispose()。
 * keepalive 只能证明传输仍活跃,不能无限延长模型无进展的等待。两种计时沿用同一配置窗口,
 * 从 fetch 前覆盖到最后一次 read;思考增量也算进展,不要求模型先输出正文。
 */
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';
import { LlmError } from '../core/types.js';

export interface StreamIdleGuard {
  /** 传给 fetch 的 signal(合并了 external abort 与内部空闲超时)。 */
  signal: AbortSignal;
  /** 收到传输字节后调用,只重置传输空闲计时。read() 已自动调用。 */
  arm(): void;
  /** 解析出有效、非空的正文/思考/工具增量后调用。 */
  progress(): void;
  /** 可取消的 body 读取;取消不依赖 fetch 实现主动终止 reader。 */
  read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** 清计时器、监听与 reader 锁(幂等),不等待可能挂住的底层 cancel 回执。 */
  dispose(): void;
}

const DEFAULT_IDLE_MS = Number(process.env.TANGU_STREAM_IDLE_TIMEOUT_MS) || 120_000;

export function streamIdleGuard(externalSignal?: AbortSignal, idleMs = DEFAULT_IDLE_MS): StreamIdleGuard {
  const ac = new AbortController();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let progressIdle: ReturnType<typeof setTimeout> | null = null;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
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

  const progress = (): void => {
    if (disposed || ac.signal.aborted) return;
    if (progressIdle) clearTimeout(progressIdle);
    progressIdle = setTimeout(() => ac.abort(new LlmError(504, 'stream progress idle timeout')), idleMs);
  };

  const releaseReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    if (!readers.delete(reader)) return;
    // cancel 关闭队列,releaseLock 释放 pending read;不让有问题的 cancel hook 阻塞用户停止。
    try { void reader.cancel(ac.signal.reason).catch(() => undefined); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  };

  const read = (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> => {
    readers.add(reader);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        releaseReader(reader);
      };
      if (ac.signal.aborted) { onAbort(); return; }
      ac.signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then((chunk) => {
        ac.signal.removeEventListener('abort', onAbort);
        if (ac.signal.aborted) { onAbort(); return; }
        if (!chunk.done && chunk.value.byteLength) arm();
        resolve(chunk);
      }, (err) => {
        ac.signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (idle) { clearTimeout(idle); idle = null; }
    if (progressIdle) { clearTimeout(progressIdle); progressIdle = null; }
    for (const reader of readers) releaseReader(reader);
    if (externalSignal) externalSignal.removeEventListener('abort', onExt);
  };

  // 建流即开表:调用点都是「构造 guard → 立刻 fetch」,而 `await fetch()`(DNS/TCP/TLS/等响应头)
  // 本身就会无限挂——半开连接、上游收了连接不回头都卡在这里。等首帧才计时等于这段完全裸奔。
  arm();
  progress();
  return { signal: ac.signal, arm, progress, read, dispose };
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
 * 用 guard.read(reader) 消费并在有效增量处 guard.progress()。供直连流共用清理路径。
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
