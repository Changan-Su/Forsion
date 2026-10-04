import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { getRun } from './runStore.js';
import { publish } from './eventBus.js';

/** FIFO per canonical project, including native-chat continuations of plugin task sessions. */
export class TaskProjectQueue {
  private slots = new Map<string, { queue: Array<() => void> }>();
  acquire(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, { queue: [] });
      return Promise.resolve(this.release(key));
    }
    return new Promise((resolve, reject) => {
      const enter = (): void => { signal.removeEventListener('abort', cancel); resolve(this.release(key)); };
      const cancel = (): void => { const i = slot.queue.indexOf(enter); if (i >= 0) slot.queue.splice(i, 1); reject(signal.reason || new Error('aborted')); };
      slot.queue.push(enter);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private release(key: string): () => void {
    let released = false;
    return () => {
      if (released) return; released = true;
      const slot = this.slots.get(key), next = slot?.queue.shift();
      if (next) next(); else this.slots.delete(key);
    };
  }
}
const projects = new TaskProjectQueue();
export async function withTaskProjectQueue(runId: string, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return run();
  const row = await getRun(runId);
  if (!row) return run();
  const sessions = await query<any[]>('SELECT kind, project_path FROM chat_sessions WHERE id = ? AND user_id = ?', [row.session_id, row.user_id]);
  const session = sessions[0];
  if (session?.kind !== 'task' || !session.project_path) return run();
  await publish(runId, 'status', { state: 'queued' });
  const off = await projects.acquire(session.project_path, signal);
  try { signal.throwIfAborted(); await run(); } finally { off(); }
}
