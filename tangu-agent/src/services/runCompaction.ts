/** A detached summary candidate cannot mutate context or checkpoints until it wins commit.
 * running -> committing/skipped is synchronous; late provider results have no write authority. */
import { randomUUID } from 'node:crypto';
export type RunCompactionReason = 'idle' | 'threshold' | 'overflow';
export type RunCompactionState = 'running' | 'committing' | 'completed' | 'skipped' | 'failed' | 'aborted';
interface Operation { id: string; reason: RunCompactionReason; state: RunCompactionState; controller: AbortController }
const operations = new Map<string, Operation>();
export interface SkipCompactionResult { ok: boolean; operationId: string; status?: RunCompactionState; reason?: 'not_active' | 'stale_operation' | 'required' | 'already_settled' }
/** Idempotent for the same operation. Never cancels the parent run. */
export function skipRunCompaction(runId: string, operationId: string): SkipCompactionResult {
  const op = operations.get(runId);
  if (!op) return { ok: false, operationId, reason: 'not_active' };
  if (op.id !== operationId) return { ok: false, operationId, reason: 'stale_operation' };
  if (op.reason !== 'idle') return { ok: false, operationId, status: op.state, reason: 'required' };
  if (op.state === 'skipped') return { ok: true, operationId, status: 'skipped' };
  if (op.state !== 'running') return { ok: false, operationId, status: op.state, reason: 'already_settled' };
  op.state = 'skipped';
  op.controller.abort(new DOMException('Summary skipped by user', 'AbortError'));
  return { ok: true, operationId, status: 'skipped' };
}
export function releaseRunCompaction(runId: string): void {
  const op = operations.get(runId);
  if (op?.state === 'running') { op.state = 'aborted'; op.controller.abort(); }
  operations.delete(runId);
}
export interface CompactionCommitResult { phase: 'compacted' | 'compaction_failed'; changed: boolean; [key: string]: unknown }
export async function runCompactionOperation<T>(opts: {
  runId: string; reason: RunCompactionReason; signal: AbortSignal; idleMinutes: number; iteration: number;
  /** Resolves after publishing/persisting start, before the provider is called. */
  publish(payload: Record<string, unknown>): Promise<unknown>;
  prepare(signal: AbortSignal): Promise<T>;
  /** Only commit may mutate live context or persist a checkpoint. */
  commit(prepared: T): Promise<CompactionCommitResult>;
}): Promise<boolean> {
  const existing = operations.get(opts.runId);
  if (existing && (existing.state === 'running' || existing.state === 'committing')) throw new Error('Compaction already active');
  opts.signal.throwIfAborted();
  const op: Operation = { id: randomUUID(), reason: opts.reason, state: 'running', controller: new AbortController() };
  operations.set(opts.runId, op);
  const metadata = { operationId: op.id, reason: opts.reason, iteration: opts.iteration, forced: true, ...(opts.reason === 'idle' ? { idleMinutes: opts.idleMinutes } : {}) };
  const parentAbort = () => { if (op.state === 'running') op.state = 'aborted'; op.controller.abort(opts.signal.reason); };
  opts.signal.addEventListener('abort', parentAbort, { once: true });
  let offAbort: (() => void) | undefined;
  let terminalStarted = false;
  const terminal = async (payload: Record<string, unknown>) => {
    terminalStarted = true;
    await opts.publish({ ...metadata, ...payload, skippable: false });
  };
  try {
    await opts.publish({ ...metadata, phase: 'compacting', skippable: opts.reason === 'idle' });
    opts.signal.throwIfAborted();
    if (op.state !== 'skipped') {
      // Losing prepare work only owns its private candidate array. An abort-ignoring provider
      // may complete/bill later, but has no checkpoint or live-context mutation callback.
      const cancelled = new Promise<{ cancelled: true }>((resolve) => {
        const onAbort = () => resolve({ cancelled: true });
        offAbort = () => op.controller.signal.removeEventListener('abort', onAbort);
        op.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (op.controller.signal.aborted) onAbort();
      });
      const prepared = await Promise.race([
        Promise.resolve().then(() => { op.controller.signal.throwIfAborted(); return opts.prepare(op.controller.signal); }).then((value) => ({ cancelled: false as const, value })),
        cancelled,
      ]);
      opts.signal.throwIfAborted();
      // Epoch and terminal guard immediately before claiming exclusive commit authority.
      if (!prepared.cancelled && operations.get(opts.runId) === op && op.state === 'running') {
        op.state = 'committing';
        const result = await opts.commit(prepared.value);
        op.state = result.phase === 'compacted' ? 'completed' : 'failed';
        await terminal(result);
        return result.changed;
      }
    }
    opts.signal.throwIfAborted();
    if (op.state !== 'skipped') throw new DOMException('Compaction operation no longer active', 'AbortError');
    await terminal({ phase: 'compaction_skipped', byUser: true });
    return false;
  } catch (error) {
    // A transport failure cannot rewrite the outcome or attempt a second terminal event.
    if (terminalStarted) throw error;
    if (op.state === 'skipped' && !opts.signal.aborted) {
      await terminal({ phase: 'compaction_skipped', byUser: true });
      return false;
    }
    op.state = opts.signal.aborted ? 'aborted' : 'failed';
    await terminal({ phase: 'compaction_failed', aborted: opts.signal.aborted }).catch(() => {});
    throw error;
  } finally { offAbort?.(); opts.signal.removeEventListener('abort', parentAbort); }
}
