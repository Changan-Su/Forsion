import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { agentSyncScope, setAgentSyncPermission } from './cloudSyncAccount.js';

const { agentFilesSync, memorySync } = vi.hoisted(() => ({ agentFilesSync: vi.fn(), memorySync: vi.fn() }));
vi.mock('./agentFileSync.js', () => ({ runAgentFilesSync: agentFilesSync }));
vi.mock('./memorySync.js', () => ({ runMemorySync: memorySync }));
const { getSyncStatus, setSyncSources, syncNow } = await import('./memorySyncService.js');
const result = { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0 };
const source = (): CloudBrainServices => ({ agentFiles: {}, memory: {} } as CloudBrainServices);
let previousHome: string | undefined;
let home: string;
beforeEach(() => {
  previousHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'sync-account-service-'));
  process.env.TANGU_HOME = home;
  agentFilesSync.mockReset().mockResolvedValue(result);
  memorySync.mockReset().mockResolvedValue({ memory: 'in-sync', logs: [] });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = previousHome;
  rmSync(home, { force: true, recursive: true });
});

describe('memory sync account boundary', () => {
  it('requires account-specific consent for the historical global memory upload', async () => {
    const brain = source();
    setSyncSources({ brain });
    await syncNow('a');
    expect(memorySync).not.toHaveBeenCalled();
    setAgentSyncPermission('xyra', agentSyncScope(brain.agentFiles, 'a')!, true);
    await syncNow('a');
    expect(memorySync).toHaveBeenCalledTimes(1);
    await syncNow('b');
    expect(memorySync).toHaveBeenCalledTimes(1);
    expect(getSyncStatus('a').lastAt).toBeNull();
  });

  it('does not continue an in-flight A sync with B’s cloud source or expose A’s result', async () => {
    const a = source();
    const b = source();
    setSyncSources({ brain: a });
    setAgentSyncPermission('xyra', agentSyncScope(a.agentFiles, 'a')!, true);
    let finish!: (value: typeof result) => void;
    agentFilesSync.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = syncNow('a');
    setSyncSources({ brain: b });
    expect(getSyncStatus('b')).toMatchObject({ running: false, lastAt: null, lastResult: null });
    finish(result);
    await pending;
    expect(memorySync).not.toHaveBeenCalled();
    expect(getSyncStatus('b')).toMatchObject({ lastAt: null, lastResult: null });
  });
});
