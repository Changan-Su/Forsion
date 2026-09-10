import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { spawnHostCommand, hostSandboxBackend, normalizeHostSandbox, prepareHostCommand } from './hostSandbox.js';
import { HOST_TOOLS } from '../tools/hostExec.js';
import { startBackgroundProcess, disposeAllProcesses, writeStdin } from '../tools/processRegistry.js';
import { protectedHostPaths } from './hostSandboxProtection.js';
import { hostSandboxFs } from './hostSandboxFs.js';
import type { ToolContext } from '../tools/toolTypes.js';

const tempDirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture(mode: 'workspace-write' | 'read-only' = 'workspace-write') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-sandbox-test-'));
  tempDirs.push(dir);
  const cwd = path.join(dir, 'workspace');
  await fs.mkdir(cwd);
  const ctx = { userId: 'test', sessionId: 'test', appId: 'test', cwd, hostSandbox: { mode, network: 'deny' } } as ToolContext;
  return { dir, cwd, ctx, outside: path.join(dir, 'outside.txt') };
}
async function command(ctx: ToolContext, argv: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawnHostCommand(ctx, argv);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(new Error('test child timed out')); }, 8000);
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

describe('host sandbox configuration', () => {
  it('defaults off while rejecting malformed policies instead of weakening them', () => {
    expect(normalizeHostSandbox(undefined)).toEqual({ mode: 'off', network: 'deny' });
    for (const mode of ['typo', ['off'], null, 1]) expect(() => normalizeHostSandbox({ mode })).toThrow('Invalid hostSandbox');
    for (const network of [['allow'], null, 1]) expect(() => normalizeHostSandbox({ network })).toThrow('Invalid hostSandbox');
    expect(() => normalizeHostSandbox({ mode: 'read-only', network: 'typo' })).toThrow('Invalid hostSandbox');
    expect(hostSandboxBackend('win32')).toMatchObject({ available: false, backend: 'unsupported' });
  });
  it('off uses the original executable with no policy wrapper', async () => {
    const { ctx } = await fixture();
    ctx.hostSandbox!.mode = 'off';
    const prepared = prepareHostCommand(ctx, ['/bin/sh', '-c', 'true']);
    expect({ file: prepared.file, args: prepared.args }).toEqual({ file: '/bin/sh', args: ['-c', 'true'] });
    prepared.cleanup();
  });
});

const native = hostSandboxBackend().available;
describe.skipIf(!native)('real OS host sandbox (temporary paths only)', () => {
  it('lets shell and filesystem helper write the workspace but denies writes outside it', async () => {
    const { ctx, cwd, outside } = await fixture();
    const file = path.join(cwd, 'inside.txt');
    const allowed = await command(ctx, ['/bin/sh', '-c', 'echo inside > "$1"', 'sh', file]);
    expect(allowed, allowed.output).toMatchObject({ code: 0 });
    const blocked = await command(ctx, ['/bin/sh', '-c', 'echo outside > "$1"', 'sh', outside]);
    expect(blocked.code, blocked.output).not.toBe(0);
    await expect(fs.stat(outside)).rejects.toThrow();
    await hostSandboxFs(ctx).writeFile(file, 'helper content', 'utf8');
    expect(await hostSandboxFs(ctx).readFile(file, 'utf8')).toBe('helper content');
    await expect(hostSandboxFs(ctx).writeFile(outside, 'must not exist')).rejects.toThrow();
    await expect(fs.stat(outside)).rejects.toThrow();
  });
  it('read-only denies even workspace writes; child processes inherit restrictions', async () => {
    const { ctx, cwd } = await fixture('read-only');
    const file = path.join(cwd, 'readonly.txt');
    await fs.writeFile(file, 'original');
    const script = 'const p=require("child_process").spawnSync("/bin/sh", ["-c",process.argv[1],"sh",process.argv[2]], {stdio:"inherit"});process.exit(p.status??99)';
    const result = await command(ctx, [process.execPath, '-e', script, 'echo changed > "$1"', file]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(/Operation not permitted|Permission denied|Read-only file system/);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    await expect(hostSandboxFs(ctx).writeFile(file, 'changed')).rejects.toThrow();
  });
  it('rejects symlink escapes and protects existing git metadata', async () => {
    const { ctx, cwd, outside } = await fixture();
    await fs.writeFile(outside, 'outside');
    const link = path.join(cwd, 'link');
    await fs.symlink(outside, link);
    await expect(hostSandboxFs(ctx).writeFile(link, 'changed')).rejects.toThrow();
    await fs.mkdir(path.join(cwd, '.git'));
    const git = path.join(cwd, '.git/config');
    await fs.writeFile(git, 'original');
    const result = await command(ctx, ['/bin/sh', '-c', 'echo changed > "$1"', 'sh', git]);
    expect(result.code, result.output).not.toBe(0);
    expect(await fs.readFile(git, 'utf8')).toBe('original');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
  });
  it('blocks configuration changes and renaming a parent to replace that configuration', async () => {
    const { ctx, cwd } = await fixture();
    const home = path.join(cwd, 'test-home');
    await fs.mkdir(home);
    const config = path.join(home, 'config.json');
    await fs.writeFile(config, 'original');
    vi.stubEnv('TANGU_HOME', home);
    if (process.platform === 'linux') {
      expect(() => prepareHostCommand(ctx, ['/bin/true'])).toThrow('choose a narrower workspace');
      expect(await fs.readFile(config, 'utf8')).toBe('original');
      return;
    }
    const denied = await command(ctx, ['/bin/sh', '-c', 'echo changed > "$1"', 'sh', config]);
    expect(denied.code, denied.output).not.toBe(0);
    const moved = await command(ctx, ['/bin/mv', home, path.join(cwd, 'renamed')]);
    expect(moved.code, moved.output).not.toBe(0);
    expect(await fs.readFile(config, 'utf8')).toBe('original');
    expect(protectedHostPaths()).toContain(process.execPath);
  });
  it('uses the same policy through the actual host tools and background process registry', async () => {
    const { ctx, cwd, outside } = await fixture();
    const inside = path.join(cwd, 'tool.txt');
    expect(await HOST_TOOLS.write_file.execute({ path: inside, content: 'tool' }, ctx)).toContain('wrote');
    expect(await HOST_TOOLS.write_file.execute({ path: outside, content: 'escape' }, ctx)).toContain('Error:');
    expect(await HOST_TOOLS.read_file.execute({ path: inside }, ctx)).toContain('tool');
    expect(await HOST_TOOLS.list_dir.execute({ path: cwd }, ctx)).toContain('tool.txt (4 bytes)');
    const shell = await HOST_TOOLS.run_bash.execute({ command: 'printf child', timeout_ms: 1000 }, ctx);
    expect(shell).toContain('child');
    const process = startBackgroundProcess('sandbox-test', `echo denied > '${outside}'`, cwd, ctx);
    expect(typeof process).not.toBe('string');
    if (typeof process !== 'string') {
      await new Promise<void>((resolve) => process.child!.once('close', () => resolve()));
      expect(process.exitCode).not.toBe(0);
    }
    disposeAllProcesses();
    await expect(fs.stat(outside)).rejects.toThrow();
  });
  it('does not inherit secret or executable-hook environment variables', async () => {
    const { ctx } = await fixture();
    vi.stubEnv('TANGU_SANDBOX_TEST_SECRET', 'not-a-real-secret');
    vi.stubEnv('NODE_OPTIONS', '--throw-deprecation');
    const result = await command(ctx, [process.execPath, '-e', 'console.log(JSON.stringify({secret:process.env.TANGU_SANDBOX_TEST_SECRET,node:process.env.NODE_OPTIONS}))']);
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim()).toBe('{}');
  });
  it('cannot inject input into an old unrestricted background process after policy changes', async () => {
    const { ctx, cwd } = await fixture();
    const unrestricted = { ...ctx, hostSandbox: { mode: 'off', network: 'deny' } } as ToolContext;
    const p = startBackgroundProcess('old-policy', 'cat', cwd, unrestricted);
    expect(typeof p).not.toBe('string');
    try {
      if (typeof p !== 'string') expect(writeStdin('old-policy', p.id, 'input', true, ctx)).toContain('different host sandbox policy');
    } finally { disposeAllProcesses(); }
  });
  it('cancels a blocked filesystem helper without waiting for the file operation', async () => {
    const { ctx, cwd } = await fixture();
    const fifo = path.join(cwd, 'waiting.fifo');
    execFileSync('mkfifo', [fifo]);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const started = Date.now();
    const operation = hostSandboxFs(ctx).readFile(fifo);
    setTimeout(() => controller.abort(), 100);
    await expect(operation).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('runs an ordinary npm script in its workspace without installing packages', async () => {
    const { ctx, cwd } = await fixture();
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'sandbox-fixture', version: '1.0.0', scripts: { verify: 'node verify.cjs' } }));
    await fs.writeFile(path.join(cwd, 'verify.cjs'), 'require("fs").writeFileSync("artifact.txt", "verified"); console.log("npm-script-ok")');
    const result = await command(ctx, ['npm', '--offline', '--no-update-notifier', 'run', 'verify']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('npm-script-ok');
    expect(await fs.readFile(path.join(cwd, 'artifact.txt'), 'utf8')).toBe('verified');
  });
  it('denies loopback networking and allows it only under the explicit network policy', async () => {
    const { ctx } = await fixture();
    const server = net.createServer((socket) => { socket.on('error', () => {}); socket.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const script = 'const s=require("net").connect({host:"127.0.0.1",port:Number(process.argv[1])});s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(7));setTimeout(()=>process.exit(8),1500)';
      expect((await command(ctx, [process.execPath, '-e', script, String(port)])).code).not.toBe(0);
      ctx.hostSandbox!.network = 'allow';
      const allowed = await command(ctx, [process.execPath, '-e', script, String(port)]);
      expect(allowed, allowed.output).toMatchObject({ code: 0 });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
