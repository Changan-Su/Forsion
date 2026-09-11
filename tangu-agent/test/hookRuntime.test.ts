import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeHook, runHooks } from '../src/hooks/runner.js';
import { runBoundedProcess } from '../src/utils/boundedProcess.js';
import type { DiscoveredHook, HookRunContext } from '../src/hooks/types.js';

let dir: string;
const children = new Set<number>();
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'tangu-hook-runtime-')); });
afterEach(async () => {
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* test child exited */ } }
  children.clear();
  await rm(dir, { recursive: true, force: true });
});
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const hook = (command: string, timeout?: number): DiscoveredHook => ({
  key: 'test', event: 'SessionStart', handler: { type: 'command', command, timeout },
  source: 'user', contentHash: 'test', trust: 'trusted', enabled: true, active: true,
});
const ctx = (signal?: AbortSignal): HookRunContext => ({ cwd: dir, signal, hostSandbox: { mode: 'off' } });
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    // Container PID 1 may reap orphaned zombies late; zombies cannot run/write.
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!stat || /\) Z /.test(stat)) return false;
    }
    return true;
  } catch { return false; }
}
async function waitFile(name: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const value = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not become ready: ${name}`);
}

describe('bounded command IO', () => {
  it('preserves UTF-8 split across real pipe writes', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', `const b=Buffer.from('你好🙂'); let i=0; const timer=setInterval(()=>{process.stdout.write(b.subarray(i,++i)); if(i===b.length)clearInterval(timer)},2)`], { timeoutMs: 2000 });
    expect(result.stdout).toBe('你好🙂');
    expect(result.cleanupTimedOut).toBe(false);
  });
  it('caps output bytes before allocation and terminates an output flood', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', `process.stdout.write('🙂'.repeat(100000)); setInterval(()=>{},1000)`], { timeoutMs: 2000, maxOutputBytes: 1001 });
    expect(result.reason).toBe('output-limit');
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(1001);
    expect(result.stdout).not.toContain('�');
    expect(result.cleanupTimedOut).toBe(false);
  });
  it('shares the output budget across stdout and stderr', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', `process.stdout.write('a'.repeat(600)); process.stderr.write('b'.repeat(600)); setInterval(()=>{},1000)`], { timeoutMs: 2000, maxOutputBytes: 1000 });
    expect(result.reason).toBe('output-limit');
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(1000);
  });
  it('reports synchronous spawn errors as failed outcomes', async () => {
    const result = await runBoundedProcess(process.execPath, ['invalid\0argument'], { timeoutMs: 1000 });
    expect(result.reason).toBe('spawn-error');
    expect(result.cleanupTimedOut).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('bounds pipe acknowledgement when a child deliberately escapes the process group', async () => {
    const script = path.join(dir, 'escape.cjs');
    await writeFile(script, `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]}); require('node:fs').writeFileSync('escaped',String(c.pid)); c.unref();`);
    const started = Date.now();
    const result = await runBoundedProcess(process.execPath, [script], { cwd: dir, timeoutMs: 1000, cleanupMs: 80 });
    children.add(Number(await readFile(path.join(dir, 'escaped'), 'utf8')));
    expect(result.cleanupTimedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
  });
});

describe.skipIf(process.platform === 'win32')('Hook process ownership (real process group)', () => {
  it('does not start a hook when the signal was already cancelled', async () => {
    const script = path.join(dir, 'write.cjs');
    await writeFile(script, `require('node:fs').writeFileSync('late', 'bad');`);
    const controller = new AbortController(); controller.abort();
    const result = await executeHook(hook(`${quote(process.execPath)} ${quote(script)}`), {}, ctx(controller.signal));
    expect(result.failReason).toBe('hook cancelled');
    expect(await readFile(path.join(dir, 'late')).catch(() => null)).toBeNull();
  });

  it.each(['abort', 'timeout'] as const)('reaps descendants on %s before reporting completion', async (mode) => {
    const childScript = path.join(dir, 'child.cjs'), parentScript = path.join(dir, 'parent.cjs');
    await writeFile(childScript, `const fs=require('node:fs'); fs.writeFileSync('ready',String(process.pid)); setTimeout(()=>fs.writeFileSync('late','bad'),${mode === 'abort' ? 400 : 1300}); setInterval(()=>{},1000);`);
    await writeFile(parentScript, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'}); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const pending = executeHook(hook(`${quote(process.execPath)} ${quote(parentScript)}`, mode === 'timeout' ? 1 : 30), {}, ctx(controller.signal));
    const pid = Number(await waitFile('ready')); children.add(pid);
    if (mode === 'abort') controller.abort();
    const result = await pending;
    expect(result.failReason).toBe(mode === 'abort' ? 'hook cancelled' : 'hook timed out');
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(await readFile(path.join(dir, 'late')).catch(() => null)).toBeNull();
    expect(await alive(pid)).toBe(false);
  });

  it('rejects truncated Hook output instead of parsing it as an approval', async () => {
    const script = path.join(dir, 'flood.cjs');
    await writeFile(script, `process.stdout.write('x'.repeat(300000)); setInterval(()=>{},1000);`);
    const result = await executeHook(hook(`${quote(process.execPath)} ${quote(script)}`), {}, ctx());
    expect(result.status).toBe('failed');
    expect(result.failReason).toContain('output limit');
    expect(result.output).toBeUndefined();
  });

  it('does not let direct or dispatched hooks bypass a restricted sandbox', async () => {
    const script = path.join(dir, 'write.cjs');
    await writeFile(script, `require('node:fs').writeFileSync('late','bad')`);
    const restricted = { ...ctx(), execMode: 'host', hostSandbox: { mode: 'read-only' }, profile: { capabilities: { hostExec: true } } } as HookRunContext;
    const direct = await executeHook(hook(`${quote(process.execPath)} ${quote(script)}`), {}, restricted);
    expect(direct.status).toBe('failed');
    const verdict = await runHooks('SessionStart', {}, restricted);
    expect(verdict.runs).toEqual([]);
    expect(verdict.systemMessages.join(' ')).toContain('disabled');
    expect(await readFile(path.join(dir, 'late')).catch(() => null)).toBeNull();
  });
});
