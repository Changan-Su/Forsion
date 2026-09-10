/** Cancellable admission. A cancelled waiter never owns a slot or starts execution. */
export class ExecutionQueue {
  private active = 0;
  private readonly waiters: Array<{ grant(): void }> = [];

  constructor(private readonly capacity: () => number) {}

  get queued(): number { return this.waiters.length; }
  get activeCount(): number { return this.active; }

  acquire(signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.capacity() && !this.waiters.length) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const cancel = (error: unknown): void => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        cleanup();
        reject(error);
      };
      const onAbort = (): void => cancel(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      const waiter = { grant: (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.active++;
        resolve();
      } };
      // Cleanup owns an internal waiter with timeoutMs=0: it must eventually observe the current
      // owner finishing, rather than abandon disposal and allow another session to reuse its files.
      const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 60_000;
      const timer = budget > 0 ? setTimeout(() => cancel(new DOMException('Sandbox queue wait timed out', 'TimeoutError')), budget) : undefined;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      if (signal?.aborted) onAbort();
      else this.pump();
    });
  }

  release(): void {
    if (this.active <= 0) throw new Error('Cannot release an unowned execution slot');
    this.active--;
    this.pump();
  }

  pump(): void {
    while (this.waiters.length && this.active < this.capacity()) this.waiters.shift()!.grant();
  }
}
