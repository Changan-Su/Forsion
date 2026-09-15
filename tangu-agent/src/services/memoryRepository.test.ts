import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fault = vi.hoisted(() => ({ read: '', rename: '', remaining: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (fault.remaining && fault.read && String(args[0]).endsWith(fault.read)) {
        fault.remaining--; throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
      }
      return fs.openSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.remaining && fault.rename && String(args[1]).endsWith(fault.rename)) {
        fault.remaining--; throw Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' });
      }
      return fs.renameSync(...args);
    },
    // Windows semantics: FlushFileBuffers on a directory handle fails, surfaced by libuv as EPERM.
    fsyncSync: (fd: number) => {
      if (process.platform === 'win32' && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });
      return fs.fsyncSync(fd);
    },
  };
});

import { createMemoryRepository, memoryFactFingerprint, withMemoryDirectoryLock, isMemoryTombstoneActive } from './memoryRepository.js';
import { createLocalMemoryBrain, createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { runWithAgentSlug } from '../seams/runContext.js';

let dir: string;
const oldHome = process.env.TANGU_HOME;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tangu-memory-repository-')); fault.read = ''; fault.rename = ''; fault.remaining = 0; });
afterEach(() => { fault.remaining = 0; rmSync(dir, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = oldHome; });

describe('per-agent durable memory repository', () => {
  it('does not invent a local modification time when initializing absent memory', async () => {
    const brain = createLocalMemoryBrain({ baseDir: dir, deviceId: 'fixture' });
    expect(await brain.getMemory('fixture')).toEqual({ content: '', updatedAt: null });
    expect(brain.store.memoryLocalUpdatedAt()).toBe(0);
  });
  it('lazily imports the existing editable Markdown without losing formatting or inventing provenance', () => {
    const original = '# Preferences\n\n- 喜欢茶。\n';
    writeFileSync(join(dir, 'MEMORY.md'), original);
    const repo = createMemoryRepository(dir);
    const first = repo.snapshot();
    expect(first.content).toBe(original);
    expect(first.entries[1].source.kind).toBe('migration');
    expect(repo.snapshot().version).toBe(first.version);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(original);
  });

  it('gives identical facts in two Agents different IDs and rejects an ID from another Agent', async () => {
    process.env.TANGU_HOME = dir;
    const brain = createLocalMemoryBrain({ deviceId: 'fixture' });
    const a = await runWithAgentSlug('agent-a', () => brain.mutateMemory!('u', { action: 'add', fact: '喜欢茶。' }));
    const b = await runWithAgentSlug('agent-b', () => brain.mutateMemory!('u', { action: 'add', fact: '喜欢茶。' }));
    expect(a.entries[0].id).not.toBe(b.entries[0].id);
    await expect(runWithAgentSlug('agent-b', () => brain.mutateMemory!('u', { action: 'forget', id: a.entries[0].id }))).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect((await runWithAgentSlug('agent-a', () => brain.getMemorySnapshot!('u'))).content).toBe('喜欢茶。');
  });

  it('rejects invalid active Agent slugs instead of creating a sibling memory scope', async () => {
    process.env.TANGU_HOME = dir;
    const brain = createLocalMemoryBrain({ deviceId: 'fixture' });
    await expect(runWithAgentSlug('../escape', () => brain.appendMemoryEntry('u', 'x'))).rejects.toMatchObject({ code: 'MEMORY_UNSAFE_PATH' });
  });

  it('fails stale CAS proposals and keeps the newer explicit addition', () => {
    const repo = createMemoryRepository(dir);
    const read = repo.add('old fact');
    repo.add('concurrent explicit fact');
    expect(() => repo.commit({ expectedVersion: read.version, content: 'summary from stale snapshot', source: { kind: 'dream' } })).toThrow(expect.objectContaining({ code: 'MEMORY_VERSION_CONFLICT' }));
    expect(repo.snapshot().content).toContain('concurrent explicit fact');
  });

  it('imports a manual Markdown edit as a new version and rejects stale editor saves', () => {
    const repo = createMemoryRepository(dir);
    const previous = repo.add('old fact');
    writeFileSync(join(dir, 'MEMORY.md'), 'manually corrected fact');
    const edited = repo.snapshot();
    expect(edited.version).not.toBe(previous.version);
    expect(edited.entries[0].source.kind).toBe('external-edit');
    expect(() => repo.commit({ expectedVersion: previous.version, content: 'stale editor', source: { kind: 'manual' } })).toThrow(expect.objectContaining({ code: 'MEMORY_VERSION_CONFLICT' }));
  });

  it('updates a stable entry ID, preserves evidence and prevents the corrected old text returning', () => {
    const repo = createMemoryRepository(dir);
    const first = repo.add('I live in Paris', { source: { kind: 'explicit', sessionId: 's1', messageId: 'm1' } });
    const updated = repo.update(first.entries[0].id, 'I live in London', { source: { kind: 'explicit', messageId: 'm2' } });
    expect(updated.entries[0].id).toBe(first.entries[0].id);
    expect(updated.entries[0].evidenceIds).toEqual(expect.arrayContaining(['m1', 'm2']));
    const merged = repo.commit({ expectedVersion: updated.version, content: 'I live in Paris\nI live in London', source: { kind: 'sync' } });
    expect(merged.content).toBe('I live in London');
  });

  it('records forget tombstones and blocks normalized text and provenance replay', () => {
    const repo = createMemoryRepository(dir);
    const first = repo.add('I prefer Tea', { source: { kind: 'explicit', messageId: 'user-message-1' } });
    const forgotten = repo.forget(first.entries[0].id);
    expect(forgotten.entries).toEqual([]);
    expect(forgotten.tombstones[0].fingerprint).toBe(memoryFactFingerprint('I prefer Tea'));
    const retried = repo.commit({ expectedVersion: forgotten.version, content: '- i prefer   tea\nDrinks tea daily\nnew safe fact', source: { kind: 'dream' }, provenance: [{ fact: 'Drinks tea daily', sourceIds: ['user-message-1'] }] });
    expect(retried.content).toBe('new safe fact');
  });

  it('does not turn a shared source session or message anchor into a ban on unrelated facts', () => {
    const repo = createMemoryRepository(dir);
    const first = repo.add('fact A', { evidenceIds: ['candidate:a', 'source:session:shared', 'source:message:anchor'] });
    const forgotten = repo.forget(first.entries[0].id);
    const next = repo.commit({ expectedVersion: forgotten.version, content: 'fact B', source: { kind: 'dream' }, provenance: [{ fact: 'fact B', sourceIds: ['candidate:b', 'source:session:shared', 'source:message:anchor'] }] });
    expect(next.content).toBe('fact B');
  });

  it('converges identical-time cross-device tombstone events deterministically', () => {
    const a = createMemoryRepository(join(dir, 'a'));
    const b = createMemoryRepository(join(dir, 'b'));
    const first = { id: 'a', content: 'fact', fingerprint: memoryFactFingerprint('fact'), forgottenAt: 42, evidenceIds: ['a'] };
    const second = { ...first, id: 'b', evidenceIds: ['b'] };
    a.mergeTombstones([first]); b.mergeTombstones([second]);
    const at = a.mergeTombstones([second]).tombstones;
    const bt = b.mergeTombstones([first]).tombstones;
    expect(at).toEqual(bt);
    expect(at[0].id).toBe('b');
  });

  it('unions remote tombstones before a legacy blob can recreate forgotten memory', () => {
    const a = createMemoryRepository(join(dir, 'a'));
    const b = createMemoryRepository(join(dir, 'b'));
    const af = a.add('shared by deliberate sync');
    b.add('shared by deliberate sync');
    const forgotten = a.forget(af.entries[0].id);
    const merged = b.mergeTombstones(forgotten.tombstones);
    expect(merged.content).toBe('');
    expect(b.commit({ expectedVersion: merged.version, content: '- shared by deliberate sync', source: { kind: 'sync' } }).entries).toEqual([]);
  });

  it('explicitly remembering again survives an older cloud tombstone, but a subsequent forget wins', () => {
    const a = createMemoryRepository(join(dir, 'a'));
    const b = createMemoryRepository(join(dir, 'b'));
    const remembered = a.add('tea');
    const forgotten = a.forget(remembered.entries[0].id);
    b.mergeTombstones(forgotten.tombstones);
    const restored = a.add('tea');
    expect(isMemoryTombstoneActive(restored.tombstones[0])).toBe(false);
    expect(a.mergeTombstones(forgotten.tombstones).content).toBe('tea');
    const bs = b.mergeTombstones(restored.tombstones);
    expect(b.commit({ expectedVersion: bs.version, content: restored.content, source: { kind: 'sync' } }).content).toBe('tea');
    const forgottenAgain = b.forget(b.snapshot().entries[0].id);
    expect(a.mergeTombstones(forgottenAgain.tombstones).content).toBe('');
  });

  it('commits discarded candidate IDs with content so recovery cannot repeat their model work', () => {
    const repo = createMemoryRepository(dir); const before = repo.add('existing');
    fault.rename = 'MEMORY.md'; fault.remaining = 1;
    expect(() => repo.commit({ expectedVersion: before.version, content: 'existing\nnew fact', source: { kind: 'dream' }, consumedCandidateIds: ['candidate:promoted', 'candidate:discarded'] })).toThrow('synthetic disk write failure');
    const recovered = repo.snapshot();
    expect(recovered.processedCandidateIds).toEqual(['candidate:promoted', 'candidate:discarded']);
    expect(recovered.content).toContain('new fact');
    expect(() => repo.commit({ expectedVersion: before.version, content: 'stale', source: { kind: 'dream' }, consumedCandidateIds: ['candidate:must-not-be-consumed'] })).toThrow(expect.objectContaining({ code: 'MEMORY_VERSION_CONFLICT' }));
    expect(repo.snapshot().processedCandidateIds).not.toContain('candidate:must-not-be-consumed');
  });

  it('restores retained revisions with original provenance but never resurrects a forgotten fact', () => {
    const repo = createMemoryRepository(dir);
    const first = repo.add('retain fact', { source: { kind: 'explicit', sessionId: 'origin' } });
    const second = repo.add('forget fact');
    const third = repo.forget(second.entries.find(e => e.content === 'forget fact')!.id);
    const restore = repo.restore(second.version, third.version);
    expect(restore.content.trim()).toBe(first.content);
    expect(restore.entries[0].source.sessionId).toBe('origin');
    expect(repo.revisions().some(r => r.version === first.version)).toBe(true);
  });

  it('keeps all content on pre-aborted mutations and does not leave a lock', () => {
    const repo = createMemoryRepository(dir);
    const before = repo.add('existing');
    const abort = new AbortController(); abort.abort(new Error('cancelled fixture'));
    expect(() => repo.add('must not land', { signal: abort.signal })).toThrow('cancelled fixture');
    expect(repo.snapshot()).toEqual(before);
    expect(readdirSync(dir)).not.toContain('.memory.lock');
  });

  it('EIO is a failed read, never an empty memory that may be overwritten', async () => {
    // Correct-behavior regression for the former audit probe: only synthetic files.
    const original = 'existing irreplaceable memory';
    writeFileSync(join(dir, 'MEMORY.md'), original);
    const brain = createLocalMemoryBrain({ baseDir: dir, deviceId: 'fixture' });
    fault.read = 'MEMORY.md'; fault.remaining = 2;
    await expect(brain.getMemory('u')).rejects.toMatchObject({ code: 'EIO' });
    await expect(brain.appendMemoryEntry('u', 'new short summary')).rejects.toMatchObject({ code: 'EIO' });
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(original);
    expect(readdirSync(dir)).not.toContain('.memory-state.json');
  });

  it('refuses unknown or corrupted metadata without resetting Markdown', () => {
    const repo = createMemoryRepository(dir); repo.add('existing');
    writeFileSync(join(dir, '.memory-state.json'), '{ broken json');
    expect(() => repo.snapshot()).toThrow(expect.objectContaining({ code: 'MEMORY_CORRUPT' }));
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('existing');
  });

  it('refuses valid JSON whose entry index lost a record', () => {
    const repo = createMemoryRepository(dir); repo.add('existing');
    const file = join(dir, '.memory-state.json');
    const state = JSON.parse(readFileSync(file, 'utf8')); state.entries = [];
    writeFileSync(file, JSON.stringify(state));
    expect(() => repo.snapshot()).toThrow(expect.objectContaining({ code: 'MEMORY_CORRUPT' }));
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('existing');
  });

  it('an interrupted projection export recovers committed content and retains its old revision', () => {
    const repo = createMemoryRepository(dir); const old = repo.add('old fact');
    fault.rename = 'MEMORY.md'; fault.remaining = 1;
    expect(() => repo.add('new fact')).toThrow('synthetic disk write failure');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('old fact');
    const recovered = repo.snapshot();
    expect(recovered.content).toContain('new fact');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(recovered.content);
    expect(repo.revisions().some(r => r.version === old.version)).toBe(true);
    expect(readdirSync(dir).some(f => f.endsWith('.tmp') || f === '.memory.lock')).toBe(false);
  });

  it('a failed authoritative write preserves the original content and version', () => {
    const repo = createMemoryRepository(dir); const old = repo.add('old fact');
    fault.rename = '.memory-state.json'; fault.remaining = 1;
    expect(() => repo.add('lost write')).toThrow('synthetic disk write failure');
    expect(repo.snapshot()).toEqual(old);
  });

  it('upgrades and commits on Windows, where a directory handle cannot be fsynced', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      writeFileSync(join(dir, 'MEMORY.md'), 'legacy fact\n');
      const repo = createMemoryRepository(dir);
      // The on-disk state 2.10.0–2.10.2 left on Windows: metadata committed, projection still pending.
      fault.rename = 'MEMORY.md'; fault.remaining = 1;
      expect(() => repo.snapshot()).toThrow('synthetic disk write failure');
      expect(JSON.parse(readFileSync(join(dir, '.memory-state.json'), 'utf8')).projectionPending).toBe(true);
      const migrated = repo.snapshot();
      expect(migrated.content).toBe('legacy fact\n');
      repo.add('new fact', { expectedVersion: migrated.version });
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('legacy fact\nnew fact');
      expect(JSON.parse(readFileSync(join(dir, '.memory-state.json'), 'utf8')).projectionPending).toBe(false);
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it('rejects symlinked Agent directories and memory files', () => {
    const outside = join(dir, 'outside.md'); writeFileSync(outside, 'outside private fixture');
    const memory = join(dir, 'memory'); symlinkSync(dir, memory);
    expect(() => createMemoryRepository(memory).snapshot()).toThrow(expect.objectContaining({ code: 'MEMORY_UNSAFE_PATH' }));
    symlinkSync(outside, join(dir, 'MEMORY.md'));
    expect(() => createMemoryRepository(dir).snapshot()).toThrow(expect.objectContaining({ code: 'MEMORY_UNSAFE_PATH' }));
    expect(readFileSync(outside, 'utf8')).toBe('outside private fixture');
  });

  it('rejects async transaction callbacks before they run and reports another writer lock', () => {
    let invoked = false;
    expect(() => withMemoryDirectoryLock(dir, async () => { invoked = true; })).toThrow(expect.objectContaining({ code: 'MEMORY_ASYNC_TRANSACTION' }));
    expect(invoked).toBe(false);
    writeFileSync(join(dir, '.memory.lock'), JSON.stringify({ pid: 123 }));
    expect(() => createMemoryRepository(dir).snapshot()).toThrow(expect.objectContaining({ code: 'MEMORY_BUSY' }));
  });
});

describe('shared log transaction safety', () => {
  it('validates real calendar dates and rejects traversal before writing', async () => {
    const brain = createLocalMemoryBrain({ baseDir: dir, deviceId: 'fixture' });
    for (const date of ['../escape', '2026-02-30', '2026-13-01', '2026-9-08']) {
      await expect(brain.appendLogEntry('u', 'fixture', { date })).rejects.toMatchObject({ code: 'MEMORY_INVALID' });
    }
    await expect(brain.appendLogEntry('u', 'fixture', { date: '2024-02-29', time: '25:00' })).rejects.toMatchObject({ code: 'MEMORY_INVALID' });
    await expect(brain.appendLogEntry('u', 'fixture', { date: '2024-02-29', time: '23:59' })).resolves.toEqual({ date: '2024-02-29', time: '23:59' });
  });

  it('rejects stale LOG replacements after another writer appended', async () => {
    const store = createLocalMemoryStore(dir);
    const before = store.readLogSnapshot!('2026-09-08');
    const brain = createLocalMemoryBrain({ baseDir: dir, deviceId: 'fixture' });
    await brain.appendLogEntry('u', 'concurrent new entry', { date: '2026-09-08' });
    expect(() => store.writeLog('2026-09-08', 'old cloud snapshot', before.version)).toThrow(expect.objectContaining({ code: 'MEMORY_VERSION_CONFLICT' }));
    expect(store.readLog('2026-09-08')).toContain('concurrent new entry');
  });

  it('keeps memory unchanged when sync metadata cannot be read', () => {
    const store = createLocalMemoryStore(dir); store.writeMemory('existing');
    writeFileSync(join(dir, '.sync.json'), 'broken');
    expect(() => store.writeMemory('must not land')).toThrow(expect.objectContaining({ code: 'MEMORY_CORRUPT' }));
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('existing');
  });

  it('never follows a symlinked LOG directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tangu-log-outside-'));
    try {
      symlinkSync(outside, join(dir, 'LOG'));
      const store = createLocalMemoryStore(dir);
      expect(() => store.writeLog('2026-09-08', 'must not escape')).toThrow(expect.objectContaining({ code: 'MEMORY_UNSAFE_PATH' }));
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
