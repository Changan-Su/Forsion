/**
 * 流式空闲看门狗单测:idle 触发 / arm 续命 / external abort 传播 / 构造时已 abort / dispose 不泄漏,
 * 以及 mapStreamAbort 的中止源还原。纯逻辑,用 fake timers + 真 AbortController,不碰网络。
 */
import { describe, it, expect, vi } from 'vitest';
import { streamIdleGuard, mapStreamAbort } from '../src/llm/streamIdle.js';
import { LlmError } from '../src/core/types.js';

describe('streamIdleGuard', () => {
  it('idle 窗口内无 arm → abort,reason 为 LlmError(504)', () => {
    vi.useFakeTimers();
    const g = streamIdleGuard(undefined, 100);
    g.arm();
    expect(g.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(g.signal.aborted).toBe(true);
    expect((g.signal.reason as LlmError).status).toBe(504);
    g.dispose();
    vi.useRealTimers();
  });

  it('每帧 arm() 续命 → 不 abort', () => {
    vi.useFakeTimers();
    const g = streamIdleGuard(undefined, 100);
    g.arm();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(80); g.arm(); } // 80ms < 100ms,每帧续命
    expect(g.signal.aborted).toBe(false);
    g.dispose();
    vi.useRealTimers();
  });

  it('external abort 立即传播,且透传 reason', () => {
    const ext = new AbortController();
    const g = streamIdleGuard(ext.signal, 10_000);
    g.arm();
    const reason = new Error('user stop');
    ext.abort(reason);
    expect(g.signal.aborted).toBe(true);
    expect(g.signal.reason).toBe(reason);
    g.dispose();
  });

  it('构造时 external 已 abort → 内部 signal 立即 aborted(竞态保护)', () => {
    const ext = new AbortController();
    ext.abort(new Error('pre'));
    const g = streamIdleGuard(ext.signal, 10_000);
    expect(g.signal.aborted).toBe(true);
    g.dispose();
  });

  it('dispose 后计时器已清,不再 abort', () => {
    vi.useFakeTimers();
    const g = streamIdleGuard(undefined, 100);
    g.arm();
    g.dispose();
    vi.advanceTimersByTime(500);
    expect(g.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe('mapStreamAbort', () => {
  it('idle 触发(external 未 abort)→ 还原成 reason 上的 LlmError(504)', () => {
    const ac = new AbortController();
    ac.abort(new LlmError(504, 'stream idle timeout')); // 模拟 guard 内部 idle abort:reason 挂 LlmError
    const domAbort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = mapStreamAbort(domAbort, ac.signal, undefined);
    expect(out).toBeInstanceOf(LlmError);
    expect((out as LlmError).status).toBe(504);
  });

  it('用户主动 abort(external 已 abort)→ AbortError', () => {
    const ext = new AbortController();
    ext.abort(new Error('user'));
    const domAbort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = mapStreamAbort(domAbort, ext.signal, ext.signal);
    expect((out as Error).name).toBe('AbortError');
  });

  it('真网络错(非 AbortError)→ 原样透传', () => {
    const ac = new AbortController();
    const real = new Error('ECONNRESET');
    expect(mapStreamAbort(real, ac.signal, undefined)).toBe(real);
  });
});
