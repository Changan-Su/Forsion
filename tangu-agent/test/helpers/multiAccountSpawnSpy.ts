/**
 * Multi-account mode tests: a pass-through spy on node:child_process.
 *
 * Installed from each test file with
 *   vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
 * (and the same for the bare 'child_process' specifier). Every call made by engine code that vitest transforms is
 * recorded in a process-wide log and then forwarded to the real function, so a bypass is observed, not prevented.
 * Calls made by externalized node_modules are not seen; the tests back this up with marker files.
 */
import { promisify } from 'node:util';

export interface SpawnRecord {
  fn: string;
  command: string;
  at: number;
  /** account bound in the engine's account context at call time (if the harness could read it) */
  account?: string;
  /** set while the test itself deliberately calls child_process to prove the spy is live */
  tag?: string;
  /** uid / gid from the options object, when the call asked to run as another user */
  uid?: number;
  gid?: number;
  stack: string;
}

interface SpyState { log: SpawnRecord[]; tag?: string; currentAccount?: () => string | undefined }
const KEY = '__multiAccountSpawnSpy__';
export function spawnSpyState(): SpyState {
  const g = globalThis as any;
  if (!g[KEY]) g[KEY] = { log: [] } satisfies SpyState;
  return g[KEY];
}
export const spawnLog = (): SpawnRecord[] => spawnSpyState().log;

const NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

function describeCall(args: unknown[]): string {
  const [cmd, maybeArgs] = args;
  const parts = [typeof cmd === 'string' ? cmd : String(cmd)];
  if (Array.isArray(maybeArgs)) parts.push(...maybeArgs.map((a) => String(a)));
  return parts.join(' ').slice(0, 400);
}

function record(fn: string, args: unknown[]): void {
  const st = spawnSpyState();
  let account: string | undefined;
  try { account = st.currentAccount?.(); } catch { account = undefined; }
  const opts = args.find((a, i) => i > 0 && !!a && typeof a === 'object' && !Array.isArray(a)) as { uid?: unknown; gid?: unknown } | undefined;
  const ids = {
    ...(typeof opts?.uid === 'number' ? { uid: opts.uid } : {}),
    ...(typeof opts?.gid === 'number' ? { gid: opts.gid } : {}),
  };
  st.log.push({ fn, command: describeCall(args), at: Date.now(), account, tag: st.tag, ...ids, stack: String(new Error().stack || '').split('\n').slice(2, 12).join('\n') });
}

function wrap(name: string, fn: any): any {
  if (typeof fn !== 'function') return fn;
  const wrapped: any = function (this: unknown, ...args: unknown[]) {
    record(name, args);
    return fn.apply(this, args);
  };
  const custom = fn[promisify.custom];
  if (typeof custom === 'function') {
    wrapped[promisify.custom] = function (this: unknown, ...args: unknown[]) {
      record(`${name}[promisified]`, args);
      return custom.apply(this, args);
    };
  }
  return wrapped;
}

export function wrapChildProcess(orig: any): any {
  const out: any = { ...orig };
  const base = orig.default && typeof orig.default === 'object' ? orig.default : orig;
  const def: any = { ...base };
  for (const n of NAMES) {
    if (typeof orig[n] === 'function') out[n] = wrap(n, orig[n]);
    if (typeof base[n] === 'function') def[n] = out[n] ?? wrap(n, base[n]);
  }
  out.default = def;
  return out;
}
