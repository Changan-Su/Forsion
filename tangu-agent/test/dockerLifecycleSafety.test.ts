/** Fake Docker transport + real admission/session state. No daemon, containers or user files. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn(), hydrate: vi.fn(), snapshot: vi.fn() }));
vi.mock('../src/utils/boundedProcess.js', () => ({ runBoundedProcess: fake.run }));
vi.mock('child_process', async (original) => ({ ...(await original<any>()), spawn: fake.spawn }));
vi.mock('../src/tools/fileWorkspace.js', () => ({
  hydrateWorkspaceToDir: fake.hydrate, snapshotDirToWorkspace: fake.snapshot,
  scopeOf: (key: any) => ({ type: 'session', sessionId: key.sessionId }),
}));

let dir: string;
let envBefore: NodeJS.ProcessEnv;
let docker: typeof import('../src/sandbox/dockerProvider.js');
let sessions: typeof import('../src/sandbox/sessionSandbox.js');
let lifecycle: typeof import('../src/sandbox/dockerLifecycle.js');
let kernelReady: boolean;
let kernelResponds: boolean;
let kernelInputs: string[];
const ok = (extra: any = {}) => ({ code: 0, stdout: '', stderr: '', cleanupTimedOut: false, ...extra });
const frame = (value: any) => { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(String(body.length).padStart(10, '0')), body]); };
const key = (sessionId = 'one') => ({ userId: 'u', appId: 'tangu', sessionId });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  envBefore = { ...process.env };
  dir = await mkdtemp(path.join(tmpdir(), 'tangu-docker-lifecycle-'));
  process.env.AGENT_SANDBOX_PKG_DIR = path.join(dir, 'pkgs');
  process.env.AGENT_SANDBOX_SESSION_DIR = path.join(dir, 'sessions');
  process.env.AGENT_SANDBOX_MAX_CONCURRENT = '1';
  process.env.AGENT_SANDBOX_MAX_SESSIONS = '1';
  process.env.AGENT_SANDBOX_PKG_CACHE_MAX_MB = '0';
  process.env.AGENT_SANDBOX_PKG_CACHE_TTL_DAYS = '0';
  kernelReady = true; kernelResponds = false; kernelInputs = [];
  fake.run.mockResolvedValue(ok());
  fake.hydrate.mockResolvedValue({ manifest: new Map(), complete: true });
  fake.snapshot.mockResolvedValue([]);
  fake.spawn.mockImplementation(() => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', (data: Buffer) => {
      kernelInputs.push(data.toString());
      if (kernelResponds && !/^\d{10}$/.test(data.toString())) queueMicrotask(() => child.stdout.write(frame({ stdout: '', stderr: '', ok: true })));
    });
    child.kill = vi.fn(() => { child.emit('exit', 0); child.emit('close', 0); return true; });
    if (kernelReady) queueMicrotask(() => child.stdout.write(frame({ ready: true })));
    return child;
  });
  docker = await import('../src/sandbox/dockerProvider.js');
  sessions = await import('../src/sandbox/sessionSandbox.js');
  lifecycle = await import('../src/sandbox/dockerLifecycle.js');
});

afterEach(async () => {
  sessions.stopSessionReaper(); docker.stopCacheJanitor();
  for (const name of Object.keys(process.env)) if (!(name in envBefore)) delete process.env[name];
  Object.assign(process.env, envBefore);
  await rm(dir, { recursive: true, force: true });
});

describe('Docker lifecycle acknowledgements', () => {
  it('keeps new sessions behind startup inspection while independently cancelling an admission waiter', async () => {
    let inspectionAck!: () => void;
    fake.run.mockImplementation(async (_bin, args) => {
      if (args[0] === 'ps') return ok({ stdout: args.includes('name=agent-sbx-') ? 'old-ephemeral\n' : '' });
      if (args[0] === 'inspect') return new Promise((resolve) => { inspectionAck = () => resolve(ok({ stdout: '[]' })); });
      return ok();
    });
    docker.reapOrphanRunContainers(); sessions.reapOrphanSessions();
    const ac = new AbortController();
    const pending = sessions.runPythonInSession(key(), 'never start', { signal: ac.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(inspectionAck).toBeTypeOf('function'));
    expect(fake.hydrate).not.toHaveBeenCalled();
    ac.abort(); await rejected;
    expect(fake.hydrate).not.toHaveBeenCalled();
    inspectionAck();
    await expect(sessions.getSessionDir(key())).resolves.toContain('sessions');
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(fake.run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });

  it('blocks new mounts when existing container ownership cannot be inspected on restart', async () => {
    fake.run.mockImplementation(async (_bin, args) => args[0] === 'ps'
      ? ok({ stdout: 'old-ephemeral\n' }) : ok({ code: 124, reason: 'timeout' }));
    docker.reapOrphanRunContainers(); sessions.reapOrphanSessions();
    await expect(sessions.getSessionDir(key())).rejects.toThrow('Cannot inspect');
    await expect(docker.runNode('never execute')).rejects.toThrow('Cannot inspect');
    expect(fake.hydrate).not.toHaveBeenCalled();
    expect(fake.run.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false);
    expect(fake.run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });

  it('preserves containers owned by another instance and isolates only their writable mount conflicts', async () => {
    const occupied = path.join(dir, 'other-instance');
    fake.run.mockImplementation(async (_bin, args) => {
      if (args[0] === 'ps') return ok({ stdout: 'other-instance-container\n' });
      if (args[0] === 'inspect') return ok({ stdout: JSON.stringify([
        { Type: 'bind', RW: true, Source: occupied }, { Type: 'bind', RW: false, Source: docker.PKG_DIR },
      ]) });
      return ok();
    });
    docker.reapOrphanRunContainers();
    await lifecycle.waitDockerStartupCleanup();
    await expect(docker.runNode('conflict()', { mountDir: occupied })).rejects.toThrow('another live Tangu instance');
    await expect(sessions.getSessionDir(key())).resolves.toContain('sessions');
    await expect(docker.ensurePkgDir()).resolves.toBeUndefined(); // Another instance's read-only package mount is harmless.
    expect(fake.run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });

  it('awaits active per-run execution and then rm acknowledgement before releasing its mount', async () => {
    let execAck!: () => void;
    let removeAck!: () => void;
    fake.run.mockImplementation(async (_bin, args) => {
      if (args[0] === 'exec') return new Promise((resolve) => { execAck = () => resolve(ok()); });
      if (args[0] === 'rm') return new Promise((resolve) => { removeAck = () => resolve(ok()); });
      return ok();
    });
    const active = docker.runPythonInRun('run-one', dir, 'busy()');
    await vi.waitFor(() => expect(execAck).toBeTypeOf('function'));
    let disposed = false;
    const disposing = docker.releaseRunContainer('run-one').then(() => { disposed = true; });
    await expect(docker.runPythonInRun('run-one', dir, 'late()')).rejects.toThrow('being disposed');
    expect(removeAck).toBeUndefined();
    execAck(); await active;
    await vi.waitFor(() => expect(removeAck).toBeTypeOf('function'));
    expect(disposed).toBe(false);
    removeAck(); await disposing;
    expect(disposed).toBe(true);
  });

  it('waits for rm confirmation before completing cancellation or granting the next global slot', async () => {
    let removeAck!: () => void;
    let executions = 0;
    fake.run.mockImplementation(async (_bin, args, opts) => {
      if (args[0] === 'run') {
        executions++;
        if (executions === 1) return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(ok({ code: 130, reason: 'aborted' })), { once: true }));
      }
      if (args[0] === 'rm' && !removeAck) return new Promise((resolve) => { removeAck = () => resolve(ok()); });
      return ok();
    });
    const ac = new AbortController();
    let finished = false;
    const first = docker.runNode('first', { signal: ac.signal, mountDir: dir }).then((r) => { finished = true; return r; });
    await vi.waitFor(() => expect(executions).toBe(1));
    ac.abort();
    await vi.waitFor(() => expect(removeAck).toBeTypeOf('function'));
    const second = docker.runNode('second', { mountDir: dir });
    expect(finished).toBe(false);
    expect(executions).toBe(1);
    expect(docker.getSandboxSnapshot().allocatedSlots).toBe(1);
    removeAck();
    expect((await first).aborted).toBe(true);
    expect((await second).exitCode).toBe(0);
    expect(executions).toBe(2);
  });

  it('quarantines uncertain cleanup and retains its global slot instead of claiming a stopped container', async () => {
    fake.run.mockImplementation(async (_bin, args) => args[0] === 'rm'
      ? ok({ code: 124, reason: 'timeout' }) : ok({ code: 130, reason: 'aborted' }));
    await expect(docker.runNode('mutate()', { mountDir: dir })).rejects.toBeInstanceOf(lifecycle.DockerCleanupError);
    expect(docker.getSandboxSnapshot()).toMatchObject({ activeCount: 1, allocatedSlots: 1 });
    expect(lifecycle.dockerQuarantines()[0].path).toBe(dir);
    expect(() => lifecycle.assertDockerWorkspaceAvailable(path.join(dir, '..still-a-child'))).toThrow('quarantined');
    const alias = `${dir}-alias`;
    await symlink(dir, alias, 'junction');
    try { expect(() => lifecycle.assertDockerWorkspaceAvailable(path.join(alias, 'future-child'))).toThrow('quarantined'); }
    finally { await rm(alias, { force: true }); }
    await expect(docker.runNode('second()', { mountDir: dir })).rejects.toThrow('quarantined');
    expect(fake.run.mock.calls.filter(([, args]) => args[0] === 'run')).toHaveLength(1);
  });

  it('cancels warm startup, removes even a partially created named container, and never starts a kernel', async () => {
    let starting = false;
    fake.run.mockImplementation(async (_bin, args, opts) => {
      if (args[0] === 'run' && args.includes('-d')) {
        starting = true;
        return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(ok({ code: 130, reason: 'aborted' })), { once: true }));
      }
      return ok();
    });
    const ac = new AbortController();
    const pending = sessions.runPythonInSession(key(), 'never execute', { signal: ac.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(starting).toBe(true));
    ac.abort(); await rejected;
    expect(fake.run.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(true);
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(docker.getSandboxSnapshot().allocatedSlots).toBe(0);
  });

  it('does not treat an absent name as proven cleanup after interrupted container creation', async () => {
    fake.run.mockImplementation(async (_bin, args) => {
      if (args[0] === 'run') return ok({ code: 130, reason: 'aborted' });
      if (args[0] === 'rm') return ok({ code: 1, stderr: 'Error: No such container: still-starting' });
      return ok();
    });
    await expect(sessions.runPythonInSession(key(), 'never execute')).rejects.toThrow('daemon cannot finish creating it later');
    expect(docker.getSandboxSnapshot().allocatedSlots).toBe(1);
    expect(sessions.getSessionSnapshot().sessions[0].quarantined).toContain('not confirmed');
    expect(fake.spawn).not.toHaveBeenCalled();
    // The normal disposal API defaults to accepting absence. It must retain this name's stronger uncertainty.
    await expect(sessions.disposeSession('u\0tangu\0one')).rejects.toThrow('daemon cannot finish creating it later');
    expect(lifecycle.dockerQuarantines()).toHaveLength(1);
    expect(sessions.getSessionSnapshot().sessions[0].quarantined).toContain('not confirmed');
    expect(fake.snapshot).not.toHaveBeenCalled();
  });

  it('allows disposal retry after container removal succeeds but a transient snapshot upload fails', async () => {
    kernelResponds = true;
    const workspace = await sessions.getSessionDir(key());
    await writeFile(path.join(workspace, 'keep.txt'), 'unsynced work');
    expect((await sessions.runPythonInSession(key(), 'success()')).exitCode).toBe(0);
    fake.snapshot.mockRejectedValueOnce(new Error('temporary upload failure')).mockResolvedValueOnce(['keep.txt']);
    await expect(sessions.disposeSession('u\0tangu\0one')).rejects.toThrow('temporary upload failure');
    expect(sessions.getSessionSnapshot().sessions[0]).toMatchObject({ hasContainer: false, dirty: true, disposing: false });
    await expect(access(path.join(workspace, 'keep.txt'))).resolves.toBeUndefined();
    await expect(sessions.getSessionDir(key())).resolves.toBe(workspace);
    await expect(sessions.disposeSession('u\0tangu\0one')).resolves.toBeUndefined();
    expect(sessions.getSessionSnapshot().count).toBe(0);
    expect(fake.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.run.mock.calls.filter(([, args]) => args[0] === 'rm')).toHaveLength(1);
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a silent kernel handshake and waits for container removal before returning', async () => {
    kernelReady = false;
    let removeAck!: () => void;
    fake.run.mockImplementation(async (_bin, args) => args[0] === 'rm'
      ? new Promise((resolve) => { removeAck = () => resolve(ok()); }) : ok());
    const ac = new AbortController();
    let finished = false;
    const running = sessions.runPythonInSession(key(), 'never execute', { signal: ac.signal }).finally(() => { finished = true; });
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledOnce());
    ac.abort();
    await vi.waitFor(() => expect(removeAck).toBeTypeOf('function'));
    expect(finished).toBe(false);
    expect(kernelInputs).toEqual([]);
    removeAck(); await rejected;
    expect(sessions.getSessionSnapshot().sessions[0].hasContainer).toBe(false);
  });

  it('preserves a quarantined session directory and blocks reads/reuse/disposal after failed timeout cleanup', async () => {
    const workspace = await sessions.getSessionDir(key());
    await writeFile(path.join(workspace, 'keep.txt'), 'unsynced work');
    fake.run.mockImplementation(async (_bin, args) => args[0] === 'rm' ? ok({ code: 124, reason: 'timeout' }) : ok());
    await expect(sessions.runPythonInSession(key(), 'runaway()', { timeoutMs: 10 })).rejects.toThrow('quarantined');
    expect(sessions.getSessionSnapshot().sessions[0].quarantined).toContain('not confirmed');
    await expect(sessions.getSessionDir(key())).rejects.toThrow('quarantined');
    await expect(sessions.disposeSession('u\0tangu\0one')).rejects.toThrow('quarantined');
    await expect(access(path.join(workspace, 'keep.txt'))).resolves.toBeUndefined();
    expect(fake.snapshot).not.toHaveBeenCalled();
  });

  it('never evicts a currently executing session to make room for another session', async () => {
    const ac = new AbortController();
    const first = sessions.runPythonInSession(key(), 'busy()', { signal: ac.signal });
    await vi.waitFor(() => expect(kernelInputs).toContain('busy()'));
    await expect(sessions.getSessionDir(key('two'))).rejects.toThrow('capacity reached');
    ac.abort();
    expect((await first).aborted).toBe(true);
    expect(sessions.getSessionSnapshot().count).toBe(1);
  });

  it('removes an aborted package-install waiter without waiting for the running installation', async () => {
    let finishInstall!: () => void;
    fake.run.mockImplementation(async (_bin, args) => args.includes('pip')
      ? new Promise((resolve) => { finishInstall = () => resolve(ok()); }) : ok());
    const first = docker.installPackages(['first-package']);
    await vi.waitFor(() => expect(finishInstall).toBeTypeOf('function'));
    const ac = new AbortController();
    const second = docker.installPackages(['second-package'], { signal: ac.signal });
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    ac.abort(); await rejected;
    expect(fake.run.mock.calls.filter(([, args]) => args.includes('pip'))).toHaveLength(1);
    finishInstall(); await first;
  });

  it('never clears the package cache while an uncertain install container can still mutate it', async () => {
    await docker.ensurePkgDir();
    const saved = path.join(docker.PKG_DIR, 'keep.txt');
    await writeFile(saved, 'in-flight installed bytes');
    fake.run.mockImplementation(async (_bin, args) => args[0] === 'rm' ? ok({ code: 124, reason: 'timeout' }) : ok());
    await expect(docker.installPackages(['package'])).rejects.toThrow('not confirmed');
    await expect(docker.clearPkgCache()).rejects.toThrow('quarantined');
    await expect(access(saved)).resolves.toBeUndefined();
    expect(docker.getSandboxSnapshot().allocatedSlots).toBe(1);
  });
});
