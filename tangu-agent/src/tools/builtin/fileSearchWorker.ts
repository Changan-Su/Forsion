import { Worker } from 'node:worker_threads';

/** Model patterns are data. Only this fixed program is evaluated in the worker.
 * Inline JS keeps the same worker entrypoint in tsc output and Vitest/tsx sources. */
const SEARCH_PROGRAM = String.raw`
(async () => {
const { parentPort, workerData } = await import('node:worker_threads');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const skip = new Set(['.git','node_modules','dist','build','.cache','.venv','venv','__pycache__','.next','target','out']);
const regex = workerData.pattern ? new RegExp(workerData.pattern, workerData.flags) : null;
const include = workerData.include ? new RegExp(workerData.include) : null;
const MAX_FILES = 5000, MAX_BYTES = 1024 * 1024;
async function walk(base) {
  const files = [], queue = [''];
  let directories = 0;
  while (queue.length && files.length < MAX_FILES && directories++ < MAX_FILES) {
    const rel = queue.shift();
    let dir;
    try { dir = await fs.opendir(path.join(base, rel)); } catch { continue; }
    for await (const entry of dir) {
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory() && !skip.has(entry.name) && !entry.name.startsWith('.') && queue.length < MAX_FILES) queue.push(name);
      else if (entry.isFile()) files.push(name);
      if (files.length >= MAX_FILES) break;
    }
  }
  return { files, capped: files.length >= MAX_FILES || queue.length > 0 };
}
function search(file, text, limit) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (regex.test(lines[i])) hits.push({ file, line: i + 1, text: lines[i].trim().slice(0, 241) });
  }
  return hits;
}
async function run(job) {
  if (job.type === 'select') return job.paths.filter(p => !include || include.test(p)).slice(0, job.limit);
  if (job.type === 'content') return search(job.file, job.text, job.limit);
  const { files, capped } = await walk(job.base);
  if (job.type === 'glob') return files.filter(p => !include || include.test(p)).slice(0, 500);
  const hits = [];
  for (const file of files) {
    if (include && !include.test(file)) continue;
    let handle;
    try {
      handle = await fs.open(path.join(job.base, file), 'r');
      if (!(await handle.stat()).isFile()) continue;
      // Bound the actual read as well as stat: a file can grow between the two.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES || buffer.subarray(0, Math.min(bytesRead, 4096)).includes(0)) continue;
      hits.push(...search(file, buffer.subarray(0, bytesRead).toString('utf8'), 200 - hits.length));
    } catch (error) {
      // FS errors skip a single file; regex errors terminate the worker at startup.
    } finally { if (handle) await handle.close(); }
    if (hits.length >= 200) break;
  }
  return { hits, capped };
}
parentPort.on('message', async job => {
  try { parentPort.postMessage({ value: await run(job) }); }
  catch (error) { parentPort.postMessage({ error: String(error && error.message || error) }); }
});
})().catch(error => { throw error; });
`;

export function searchAbortError(signal?: AbortSignal): Error {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : 'Search cancelled');
  error.name = 'AbortError';
  return error;
}

export function checkSearchAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw searchAbortError(signal);
}

/** One worker per search; cloud reads reuse it instead of paying startup per file.
 * Termination is awaited before rejecting, so a timed-out regex cannot keep computing. */
export class FileSearchWorker {
  private worker: Worker;
  private pending?: { resolve: (value: any) => void; reject: (error: Error) => void };
  private stopped?: Error;
  private termination?: Promise<number>;
  private timer: ReturnType<typeof setTimeout>;
  private onAbort: () => void;

  constructor(
    spec: { pattern?: string; flags?: string; include?: string },
    private signal?: AbortSignal,
    timeoutMs = 30_000,
  ) {
    checkSearchAbort(signal);
    this.worker = new Worker(SEARCH_PROGRAM, {
      eval: true,
      workerData: spec,
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    this.onAbort = () => { void this.stop(searchAbortError(signal)); };
    this.timer = setTimeout(() => {
      const error = new Error('Search timed out; narrow the pattern or directory');
      error.name = 'TimeoutError';
      void this.stop(error);
    }, timeoutMs);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
    this.worker.on('message', (message: { value?: any; error?: string }) => {
      if (this.stopped) return;
      const pending = this.pending;
      this.pending = undefined;
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    });
    this.worker.on('error', (error) => { void this.stop(error); });
    this.worker.on('exit', (code) => {
      if (!this.stopped) void this.stop(new Error(`Search worker exited unexpectedly (${code})`));
    });
  }

  run<T>(job: Record<string, unknown>): Promise<T> {
    checkSearchAbort(this.signal);
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.pending) return Promise.reject(new Error('Search worker already has a pending operation'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(job);
    });
  }

  private async stop(error: Error): Promise<void> {
    if (!this.stopped) this.stopped = error;
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.onAbort);
    this.termination ??= this.worker.terminate().catch(error => {
      this.stopped = new Error(`Search worker termination failed: ${String(error)}`);
      return -1;
    });
    await this.termination;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.stopped);
  }

  async dispose(): Promise<void> {
    await this.stop(new Error('Search worker closed'));
  }
}
