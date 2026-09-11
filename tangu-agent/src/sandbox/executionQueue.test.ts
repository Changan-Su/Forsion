import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionQueue } from './executionQueue.js';

afterEach(() => vi.useRealTimers());

describe('execution queue lifecycle', () => {
  it('removes cancelled work and never starts it when capacity is released', async () => {
    const queue = new ExecutionQueue(() => 1);
    await queue.acquire();
    const cancelled = new AbortController();
    const run = vi.fn();
    const waiting = queue.acquire(cancelled.signal).then(run);
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.abort();
    await rejected;
    expect(queue.queued).toBe(0);
    queue.release();
    await queue.acquire();
    expect(run).not.toHaveBeenCalled();
    expect(queue.activeCount).toBe(1);
    queue.release();
  });

  it('expires only queued admission and preserves a running owner', async () => {
    vi.useFakeTimers();
    const queue = new ExecutionQueue(() => 1);
    await queue.acquire();
    const waiting = expect(queue.acquire(undefined, 25)).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(25);
    await waiting;
    expect([queue.activeCount, queue.queued]).toEqual([1, 0]);
    queue.release();
  });

  it('does not acquire for an already cancelled caller', () => {
    const queue = new ExecutionQueue(() => 1);
    const controller = new AbortController();
    controller.abort();
    expect(() => queue.acquire(controller.signal)).toThrow();
    expect([queue.activeCount, queue.queued]).toEqual([0, 0]);
  });

  it('preserves FIFO and wakes callers when the configured capacity increases', async () => {
    let capacity = 1;
    const queue = new ExecutionQueue(() => capacity);
    await queue.acquire();
    const order: number[] = [];
    const first = queue.acquire().then(() => order.push(1));
    const second = queue.acquire().then(() => order.push(2));
    capacity = 2;
    queue.pump();
    await first;
    expect(order).toEqual([1]);
    queue.release();
    await second;
    expect(order).toEqual([1, 2]);
    queue.release();
    queue.release();
    expect(queue.activeCount).toBe(0);
  });
});
