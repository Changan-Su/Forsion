/** Docker CLI exit is not container exit. Mutating mounts stay quarantined until rm acknowledges removal. */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { runBoundedProcess, type BoundedProcessResult } from '../utils/boundedProcess.js';

const CLEANUP_MS = 5_000;
const quarantined = new Map<string, { paths: string[]; reason: string; unconfirmedCreation?: boolean }>();
let startupCleanup: Promise<void> = Promise.resolve();

export class DockerCleanupError extends Error {
  constructor(readonly containerName: string, detail: string) {
    super(`Docker cleanup for ${containerName} was not confirmed; its workspace is quarantined and may still be changing. ${detail}`);
    this.name = 'DockerCleanupError';
  }
}

function canonicalWorkspacePath(dir: string): string {
  let current = path.resolve(dir);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}

export function assertDockerWorkspaceAvailable(dir: string): void {
  const absolute = canonicalWorkspacePath(dir);
  for (const [name, info] of quarantined) for (const root of info.paths) {
    const resolvedRoot = canonicalWorkspacePath(root);
    const rel = path.relative(resolvedRoot, absolute);
    const reverse = path.relative(absolute, resolvedRoot);
    const inside = (value: string) => value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
    if (inside(rel) || inside(reverse)) {
      throw new DockerCleanupError(name, info.reason);
    }
  }
}

export function dockerQuarantines(): Array<{ path: string; name: string; reason: string }> {
  return [...quarantined].flatMap(([name, info]) => (info.paths.length ? info.paths : ['(mounts unknown)']).map((path) => ({ path, name, reason: info.reason })));
}

/** Other Tangu instances may own these containers. Inspect mounts and isolate conflicts; never kill by prefix. */
export function scheduleDockerStartupInspection(prefixes: string[]): Promise<void> {
  startupCleanup = startupCleanup.then(async () => {
    const result = await runDocker(['ps', '-aq', ...prefixes.flatMap((prefix) => ['--filter', `name=${prefix}`])]);
    if (result.code !== 0 || result.reason || result.cleanupTimedOut) throw new Error('Cannot confirm orphan sandbox state during startup');
    for (const name of result.stdout.split(/\s+/).filter(Boolean)) {
      const inspected = await runDocker(['inspect', '--type', 'container', '--format', '{{json .Mounts}}', name]);
      if (inspected.code !== 0 || inspected.reason || inspected.cleanupTimedOut) {
        // A concurrently removed container is harmless; every other unknown state blocks admission.
        if (!inspected.reason && !inspected.cleanupTimedOut && /No such (?:container|object)/i.test(inspected.stderr)) continue;
        throw new Error(`Cannot inspect existing sandbox container ${name}; workspace ownership is unknown`);
      }
      let mounts: any;
      try { mounts = JSON.parse(inspected.stdout); } catch { throw new Error(`Invalid mount information for sandbox container ${name}`); }
      if (!Array.isArray(mounts)) throw new Error(`Invalid mount information for sandbox container ${name}`);
      const paths = mounts.filter((mount) => mount.Type === 'bind' && mount.RW === true)
        .map((mount) => {
          if (typeof mount.Source !== 'string' || !path.isAbsolute(mount.Source)) throw new Error(`Invalid writable mount for sandbox container ${name}`);
          return path.resolve(mount.Source);
        });
      if (paths.length) quarantined.set(name, { paths, reason: 'An existing container may belong to another live Tangu instance. Confirm its owner and stop it before reusing this workspace; startup does not remove unknown containers.' });
    }
  });
  return startupCleanup;
}

export async function waitDockerStartupCleanup(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) { await startupCleanup; return; }
  // Cancels only this admission waiter. The shared cleanup and its barrier remain owned and awaited
  // by future callers; no active container lease is released and no underlying work is claimed stopped.
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    startupCleanup.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
  signal?.throwIfAborted();
}

export function runDocker(args: string[], opts: { signal?: AbortSignal; input?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<BoundedProcessResult> {
  return runBoundedProcess('docker', args, { timeoutMs: opts.timeoutMs ?? CLEANUP_MS,
    maxOutputBytes: opts.maxOutputBytes ?? 16_000, cleanupMs: 1500, signal: opts.signal, input: opts.input });
}

/** Never uses the cancelled operation's signal: cleanup still needs to reach the daemon. */
export async function removeDockerContainer(name: string, writableDirs: string[] = [], allowAlreadyAbsent = true): Promise<void> {
  // A later generic dispose must not forget that the daemon may still finish an interrupted create.
  const unconfirmedCreation = !allowAlreadyAbsent || !!quarantined.get(name)?.unconfirmedCreation;
  const result = await runDocker(['rm', '-f', name]);
  const absent = !unconfirmedCreation && !result.reason && !result.cleanupTimedOut && /No such (?:container|object)/i.test(result.stderr);
  if ((!result.reason && result.code === 0 && !result.cleanupTimedOut) || absent) { quarantined.delete(name); return; }
  const detail = (unconfirmedCreation && /No such (?:container|object)/i.test(result.stderr)
    ? 'Container creation was interrupted; an absent container does not prove the daemon cannot finish creating it later.'
    : result.stderr || result.reason || `docker exited ${result.code}`).slice(0, 500);
  quarantined.set(name, { paths: writableDirs.length ? writableDirs.map((dir) => path.resolve(dir)) : quarantined.get(name)?.paths ?? [], reason: detail, unconfirmedCreation });
  throw new DockerCleanupError(name, detail);
}

/** Register a unique name before calling. Even a failed/timed-out run may have created its container. */
export async function startDockerContainer(name: string, args: string[], writableDirs: string[], signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  for (const dir of writableDirs) assertDockerWorkspaceAvailable(dir);
  const result = await runDocker(args, { signal, timeoutMs: 60_000 });
  if (result.code === 0 && !result.reason && !result.cleanupTimedOut && !signal?.aborted) return true;
  await removeDockerContainer(name, writableDirs, !result.reason && !result.cleanupTimedOut);
  signal?.throwIfAborted();
  return false;
}
