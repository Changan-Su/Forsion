import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ root: '', keys: [] as any[] }));
vi.mock('../sandbox/sessionSandbox.js', () => ({
  getSessionDir: async (key: any) => {
    fixture.keys.push(key);
    // Same project would share this directory if the real caller supplied wsProject.
    const dir = path.join(fixture.root, key.wsProject || key.sessionId);
    await fs.mkdir(dir, { recursive: true }); return dir;
  },
  markSessionDirty: (key: any) => fixture.keys.push(key),
}));
import { formatToolOutput, persistLargeOutput, readToolOutput } from './outputPersist.js';
const ctx: any = { execMode: 'sandbox', userId: 'u', appId: 'tangu', sessionId: 'first', wsProject: 'shared-project' };
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(tmpdir(), 'spill-sandbox-')); fixture.keys = []; });
afterEach(async () => { await fs.rm(fixture.root, { recursive: true, force: true }); });
it('keeps project-session artifacts outside the shared project and returns only a scoped handle', async () => {
  const full = 'sample-data\n'.repeat(2000);
  const artifact = await persistLargeOutput(ctx, 'test', full);
  const formatted = await formatToolOutput(ctx, 'test', full);
  expect(formatted).toContain(artifact.id);
  expect(formatted).not.toContain(artifact.path);
  expect(fixture.keys.every(k => k.wsProject === null)).toBe(true);
  expect(fixture.keys.every(k => k.sessionId === 'first')).toBe(true);
  await expect(fs.stat(path.join(fixture.root, 'shared-project'))).rejects.toThrow();
  await expect(readToolOutput({ ...ctx, sessionId: 'second' }, { id: artifact.id })).rejects.toThrow('missing');
  expect(JSON.parse(await readToolOutput(ctx, { id: artifact.id, limit: 50 })).text).toBe(full.slice(0, 50));
});
