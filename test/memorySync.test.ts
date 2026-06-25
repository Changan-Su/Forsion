import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemoryBrain, createLocalMemoryStore } from '../src/adapters/standalone/localMemoryBrain.js';
import { runMemorySync, splitLogBlocks } from '../src/services/memorySync.js';
import type { MemoryBrain } from '../src/seams/cloudBrain.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tangu-sync-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const localBrain = () => createLocalMemoryBrain({ baseDir: dir, deviceId: 'devA' });
const store = () => createLocalMemoryStore(dir);

/** 仿真 Forsion 云端 MemoryBrain(内存;日志格式镜像服务端 `### time\n<text>`)。 */
function fakeCloud(init?: { memory?: string; logs?: Record<string, string> }): MemoryBrain & { _mem: () => string; _log: (d: string) => string } {
  let mem = init?.memory ?? '';
  let memTs = init?.memory ? Date.now() : 0;
  const logs: Record<string, string> = { ...(init?.logs ?? {}) };
  const logTs: Record<string, number> = {};
  return {
    async getMemory() { return { content: mem, updatedAt: memTs || null }; },
    async setMemory(_u, content) { mem = content; memTs = Date.now() + 1; return { content: mem, updatedAt: memTs }; },
    async appendMemoryEntry() { return { appended: false, length: mem.length }; },
    async appendLogEntry(_u, text, o) {
      const date = o?.date ?? '2026-06-23';
      const time = o?.time ?? '00:00';
      const entry = `### ${time}\n${text}\n`;
      logs[date] = logs[date] ? logs[date] + (logs[date].endsWith('\n') ? '\n' : '\n\n') + entry : `# ${date}\n\n${entry}`;
      logTs[date] = Date.now();
      return { date, time };
    },
    async getLog(_u, date) { const d = date ?? '2026-06-23'; return { date: d, content: logs[d] ?? '', updatedAt: logTs[d] ?? null }; },
    _mem: () => mem,
    _log: (d) => logs[d] ?? '',
  };
}

describe('splitLogBlocks', () => {
  it('separates header from `### ` blocks', () => {
    const { header, blocks } = splitLogBlocks('# 2026-06-23\n\n### 10:00\n@devA a\n\n### 11:00\n@devA b\n');
    expect(header.trim()).toBe('# 2026-06-23');
    expect(blocks).toEqual(['### 10:00\n@devA a', '### 11:00\n@devA b']);
  });
});

describe('runMemorySync — memory LWW', () => {
  it('pushes when local is newer', async () => {
    const b = localBrain();
    await b.setMemory!('u', 'local fact');
    const cloud = fakeCloud();
    const r = await runMemorySync(store(), cloud, { userId: 'u' });
    expect(r.ok).toBe(true);
    expect(r.memory).toBe('pushed');
    expect(cloud._mem()).toBe('local fact');
  });

  it('pulls when cloud is newer (local empty)', async () => {
    const cloud = fakeCloud({ memory: 'cloud fact' });
    const r = await runMemorySync(store(), cloud, { userId: 'u' });
    expect(r.memory).toBe('pulled');
    expect(store().readMemory()).toBe('cloud fact');
  });

  it('is a no-op when identical', async () => {
    const b = localBrain();
    await b.setMemory!('u', 'same');
    const cloud = fakeCloud();
    await runMemorySync(store(), cloud, { userId: 'u' }); // push
    const r2 = await runMemorySync(store(), cloud, { userId: 'u' }); // identical now
    expect(r2.memory).toBe('in-sync');
  });
});

describe('runMemorySync — log append-merge', () => {
  it('unions both sides without losing entries, dedups identical blocks', async () => {
    const b = localBrain();
    await b.appendLogEntry('u', 'local-only', { date: '2026-06-23', time: '09:00' });
    // cloud has a different entry the same day (e.g. from another device/web)
    const cloud = fakeCloud({ logs: { '2026-06-23': '# 2026-06-23\n\n### 08:00\n@devB cloud-only\n' } });

    const r = await runMemorySync(store(), cloud, { userId: 'u', dates: ['2026-06-23'] });
    expect(r.ok).toBe(true);
    const logEntry = r.logs.find((l) => l.date === '2026-06-23')!;
    expect(logEntry.pushed).toBe(1);  // local-only pushed up
    expect(logEntry.pulled).toBe(1);  // cloud-only pulled down

    // both sides now contain both entries
    const localBlocks = splitLogBlocks(store().readLog('2026-06-23')).blocks.join('\n');
    expect(localBlocks).toContain('@devA local-only');
    expect(localBlocks).toContain('@devB cloud-only');
    expect(cloud._log('2026-06-23')).toContain('@devA local-only');

    // second sync: nothing new (idempotent — no re-push/re-pull)
    const r2 = await runMemorySync(store(), cloud, { userId: 'u', dates: ['2026-06-23'] });
    const l2 = r2.logs.find((l) => l.date === '2026-06-23')!;
    expect(l2.pushed).toBe(0);
    expect(l2.pulled).toBe(0);
  });
});

describe('runMemorySync — offline', () => {
  it('returns ok:false and leaves local intact when cloud throws', async () => {
    const b = localBrain();
    await b.setMemory!('u', 'precious local');
    const broken: MemoryBrain = {
      async getMemory() { throw new Error('network down'); },
      async appendMemoryEntry() { return { appended: false, length: 0 }; },
      async appendLogEntry() { return { date: '', time: '' }; },
      async getLog() { return { date: '', content: '', updatedAt: null }; },
    };
    const r = await runMemorySync(store(), broken, { userId: 'u' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network down');
    expect(store().readMemory()).toBe('precious local'); // untouched
  });
});
