/** Durable, run-scoped terminal delivery. No model call is ever replayed. Files contain write-only receipts. */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FinalizeMessageInput } from '../../seams/stateStore.js';

export interface Completion {
  runId: string;
  key: string;
  message?: FinalizeMessageInput;
  messages?: Array<{ value: FinalizeMessageInput; previous?: FinalizeMessageInput; attempted?: FinalizeMessageInput[]; sequence: number }>;
  nextSequence?: number;
  acknowledged?: Record<string, FinalizeMessageInput>;
  status?: string;
  extra?: Record<string, unknown>;
}

export class CompletionOutbox {
  private jobs = new Map<string, Completion>();
  private sending = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private dir: string, private send: (job: Completion) => Promise<void>, private delivered: (runId: string) => void,
    retryMs = 10_000) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir).filter(n => /^[a-f0-9-]+\.json$/.test(n))) {
      try {
        const job = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Completion;
        if (!/^[a-f0-9-]+$/.test(job.runId) || name !== `${job.runId}.json` || !/^[a-f0-9]{64}$/.test(job.key)) throw new Error('Invalid receipt');
        if (!job.status) {
          job.status = 'failed';
          job.extra = { error: 'worker restarted before completion; execution was not resumed' };
        }
        this.save(job);
      } catch (e: any) { console.error(`[tangu-worker] cannot restore completion receipt ${name}: ${e?.message}`); }
    }
    this.timer = setInterval(() => { for (const job of this.jobs.values()) if (job.status) void this.flush(job.runId); }, retryMs);
    this.timer.unref();
  }
  private save(job: Completion): void {
    if (!/^[a-f0-9-]+$/.test(job.runId)) throw new Error('Invalid run id for completion receipt');
    const file = path.join(this.dir, `${job.runId}.json`);
    const temp = `${file}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(job)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const directory = openSync(this.dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    this.jobs.set(job.runId, job);
  }
  create(runId: string): string {
    const key = randomBytes(32).toString('hex');
    this.save({ runId, key });
    return key;
  }
  has(runId: string): boolean { return this.jobs.has(runId); }
  key(runId: string): string | undefined { return this.jobs.get(runId)?.key; }
  sequence(runId: string, messageId: string): number | undefined { return this.jobs.get(runId)?.messages?.find(m => m.value.messageId === messageId)?.sequence; }
  discard(runId: string): void {
    if (!this.jobs.has(runId)) return;
    unlinkSync(path.join(this.dir, `${runId}.json`));
    this.jobs.delete(runId);
  }
  stageMessage(runId: string, message: FinalizeMessageInput): void {
    const job = this.jobs.get(runId);
    if (job && !job.status) {
      const previous = job.acknowledged?.[message.messageId];
      const pending = job.messages?.find(m => m.value.messageId === message.messageId);
      const value = { ...message, timestamp: previous?.timestamp ?? message.timestamp ?? Date.now() };
      const sequence = (job.nextSequence || 0) + 1;
      this.save({ ...job, nextSequence: sequence, message: value, messages: [...(job.messages || []).filter(m => m.value.messageId !== message.messageId),
        { value, previous, attempted: pending ? [...(pending.attempted || []), pending.value] : [], sequence }] });
    }
  }
  acknowledgeMessage(runId: string, messageId: string): void {
    const job = this.jobs.get(runId);
    const pending = job?.messages?.find(m => m.value.messageId === messageId);
    if (job && pending && !job.status) this.save({ ...job,
      acknowledged: { ...job.acknowledged, [messageId]: pending.value },
      messages: job.messages!.filter(m => m !== pending),
    });
  }
  finish(runId: string, status: string, extra?: Record<string, unknown>): void {
    const job = this.jobs.get(runId);
    // The first terminal outcome wins, including while its HTTP request is in flight.
    if (job && !job.status) this.save({ ...job, status, extra });
  }
  flush(runId: string): Promise<void> {
    const existing = this.sending.get(runId);
    if (existing) return existing;
    const job = this.jobs.get(runId);
    if (!job?.status) return Promise.resolve();
    const promise = this.send(job).then(() => {
      unlinkSync(path.join(this.dir, `${runId}.json`));
      this.jobs.delete(runId);
      this.delivered(runId);
    }).catch((e: any) => {
      console.warn(`[tangu-worker] completion pending run=${runId}; will retry: ${e?.message || e}`);
    }).finally(() => { this.sending.delete(runId); });
    this.sending.set(runId, promise);
    return promise;
  }
  close(): void { clearInterval(this.timer); }
}
