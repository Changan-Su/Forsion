import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSearchProvider } from '../src/tools/builtin/fileSearch.js';
import { FileSearchWorker } from '../src/tools/builtin/fileSearchWorker.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

vi.mock('../src/sandbox/sessionSandbox.js', () => ({ getSessionDir: vi.fn(async () => { throw new Error('cloud'); }) }));
vi.mock('../src/tools/fileWorkspace.js', () => ({
  listWorkspaceMetas: vi.fn(async () => []), readWorkspaceFileRaw: vi.fn(async () => null), scopeOf: () => ({}),
}));

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'tangu-search-runtime-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const context = (signal?: AbortSignal): ToolContext => ({ cwd: dir, execMode: 'host', userId: 'test', appId: 'test', sessionId: 'test', signal } as ToolContext);
const search = async (args: Record<string, unknown>, signal?: AbortSignal) => {
  const tools = await fileSearchProvider.tools();
  return tools.find(tool => tool.name === 'search_files')!.execute(args, context(signal));
};

describe('file search cancellation and fallback', () => {
  it('pre-cancelled searches never return matches from the Node fallback', async () => {
    await writeFile(path.join(dir, 'needle.txt'), 'needle');
    const controller = new AbortController(); controller.abort();
    await expect(search({ pattern: 'needle' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('falls back for missing rg and preserves case/include/line behavior', async () => {
    vi.stubEnv('PATH', path.join(dir, 'missing-bin'));
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.ts'), 'First\nNEEDLE 中文\n');
    await writeFile(path.join(dir, 'ignore.txt'), 'needle');
    expect(await search({ pattern: 'needle', include: '**/*.ts' })).toContain('2: NEEDLE 中文');
    expect(await search({ pattern: 'needle', case_sensitive: true })).not.toContain('a.ts');
  });

  it.skipIf(process.platform === 'win32')('does not fall back on an executable permission error', async () => {
    await writeFile(path.join(dir, 'rg'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(dir, 'rg'), 0o644);
    await writeFile(path.join(dir, 'needle.txt'), 'needle');
    vi.stubEnv('PATH', dir);
    await expect(search({ pattern: 'needle' })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it.skipIf(process.platform === 'win32')('kills an in-flight rg and never switches to a late fallback scan', async () => {
    await writeFile(path.join(dir, 'rg'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);\n`);
    await chmod(path.join(dir, 'rg'), 0o755);
    await writeFile(path.join(dir, 'needle.txt'), 'needle');
    vi.stubEnv('PATH', dir);
    const controller = new AbortController();
    const result = search({ pattern: 'needle' }, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 200; i++) {
      if (await readFile(path.join(dir, 'ready')).catch(() => null)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(path.join(dir, 'ready'), 'utf8')).toBe('yes');
    controller.abort();
    await rejected;
  });

  it('keeps the main event loop responsive during catastrophic fallback regex and terminates it', async () => {
    vi.stubEnv('PATH', path.join(dir, 'missing-bin'));
    await writeFile(path.join(dir, 'slow.txt'), 'a'.repeat(1000) + '!');
    const controller = new AbortController();
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; controller.abort(); }, 150);
    const start = Date.now();
    try { await expect(search({ pattern: '(a+)+$' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    expect(timerRan).toBe(true);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('terminates a pathological regex on its own deadline without caller cancellation', async () => {
    const worker = new FileSearchWorker({ pattern: '(a+)+$', flags: '' }, undefined, 150);
    try {
      await expect(worker.run({ type: 'content', file: 'slow', text: 'a'.repeat(1000) + '!', limit: 1 }))
        .rejects.toMatchObject({ name: 'TimeoutError' });
    } finally { await worker.dispose(); }
  });
});
