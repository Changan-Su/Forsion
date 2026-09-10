import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface BoundedProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  reason?: 'aborted' | 'timeout' | 'output-limit' | 'spawn-error';
  error?: NodeJS.ErrnoException;
  cleanupTimedOut: boolean;
}

/** Prefix capture with a byte cap and complete UTF-8 decoding across pipe chunks. */
class BoundedText {
  private decoder = new StringDecoder('utf8');
  private text = '';
  append(chunk: Buffer): void { this.text += this.decoder.write(chunk); }
  finish(truncated: boolean): string {
    // A prefix truncated inside a scalar is omitted, not replaced with U+FFFD.
    return this.text + (truncated ? '' : this.decoder.end());
  }
}

/** POSIX children must have been spawned detached (new session/process group).
 * Windows uses a numeric PID argument to the OS taskkill, never an interpolated shell. */
async function killProcessTree(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return true;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      try { child.kill('SIGKILL'); } catch { /* root already exited */ }
      return false;
    }
  }
  return new Promise((resolve) => {
    const root = process.env.SystemRoot || process.env.WINDIR;
    const killRoot = (): void => { try { child.kill('SIGKILL'); } catch { /* already exited */ } };
    if (!root || !path.win32.isAbsolute(root)) { killRoot(); resolve(false); return; }
    let killer: ChildProcess;
    try {
      killer = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
    } catch { killRoot(); resolve(false); return; }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) killRoot();
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, timeoutMs);
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

/** Scoped process execution: bounded capture, total deadline, cancellation and
 * bounded exit acknowledgement. This is lifecycle management, not an OS sandbox. */
export function runBoundedProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    maxOutputBytes?: number;
    cleanupMs?: number;
  },
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) return Promise.resolve({
    code: 130, stdout: '', stderr: '', reason: 'aborted', cleanupTimedOut: false,
  });
  const cap = options.maxOutputBytes ?? 256 * 1024;
  const cleanupMs = options.cleanupMs ?? 2_000;
  return new Promise((resolve) => {
    const stdout = new BoundedText(), stderr = new BoundedText();
    let reason: BoundedProcessResult['reason'];
    let error: NodeJS.ErrnoException | undefined;
    let code = 0, stopped = false, closed = false, totalBytes = 0;
    let closeResolve: () => void;
    const close = new Promise<void>(r => { closeResolve = r; });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd, env: options.env, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: 'pipe',
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: '', reason: 'spawn-error', error: error as NodeJS.ErrnoException, cleanupTimedOut: false });
      return;
    }
    const timer = setTimeout(() => { reason = 'timeout'; code = 124; void stop(); }, options.timeoutMs);
    const onAbort = (): void => { reason = 'aborted'; code = 130; void stop(); };
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
      const acknowledged = await Promise.race([
        Promise.all([
          // taskkill cannot target an already exited PID. Natural Windows exits
          // still wait for pipe closure; cancellation kills /T before root exit.
          process.platform === 'win32' && !reason ? Promise.resolve(true) : killProcessTree(child, cleanupMs),
          close,
        ]).then(([killed]) => killed).catch(() => false),
        new Promise<boolean>(r => { acknowledgementTimer = setTimeout(() => r(false), cleanupMs); }),
      ]);
      clearTimeout(acknowledgementTimer);
      // Pipe ownership can escape the original process group. Do not keep the
      // engine alive forever, and report missing acknowledgement explicitly.
      if (!closed) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      resolve({ code, stdout: stdout.finish(reason === 'output-limit'), stderr: stderr.finish(reason === 'output-limit'),
        reason, error, cleanupTimedOut: !acknowledged });
    };
    const capture = (target: BoundedText, chunk: Buffer): void => {
      if (reason) return;
      const available = Math.max(0, cap - totalBytes);
      target.append(chunk.subarray(0, available));
      totalBytes += Math.min(chunk.length, available);
      if (chunk.length > available) { reason = 'output-limit'; code = 125; void stop(); }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on('error', () => { /* early stdin close is a normal hook outcome */ });
    child.once('error', (e: NodeJS.ErrnoException) => { error = e; reason = 'spawn-error'; code = 127; void stop(); });
    child.once('exit', (exitCode, signal) => {
      if (!reason) { code = exitCode ?? (signal ? 128 : 0); void stop(); }
    });
    child.once('close', () => { closed = true; closeResolve!(); });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else child.stdin.end(options.input);
  });
}
