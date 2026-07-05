import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemoryBrain, MEMORY_SOFT_CAP } from '../src/adapters/standalone/localMemoryBrain.js';

let dir: string;
const mk = () => createLocalMemoryBrain({ baseDir: dir, deviceId: 'devA' });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tangu-mem-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('localMemoryBrain memory', () => {
  it('append + dedup + cap', async () => {
    const b = mk();
    expect((await b.appendMemoryEntry('u', '喜欢简洁')).appended).toBe(true);
    expect((await b.appendMemoryEntry('u', '  喜欢简洁  ')).reason).toBe('duplicate'); // normalize+dedup
    expect((await b.appendMemoryEntry('u', '')).reason).toBe('empty');
    const big = 'x'.repeat(MEMORY_SOFT_CAP);
    expect((await b.appendMemoryEntry('u', big)).reason).toBe('full');
    expect((await b.getMemory('u')).content).toBe('喜欢简洁');
  });

  it('setMemory round-trip + updatedAt advances', async () => {
    const b = mk();
    const r1 = await b.setMemory!('u', 'line1');
    expect(r1.content).toBe('line1');
    expect(r1.updatedAt).toBeGreaterThan(0);
    const r2 = await b.setMemory!('u', 'line1\nline2');
    expect((await b.getMemory('u')).content).toBe('line1\nline2');
    expect(r2.updatedAt).toBeGreaterThanOrEqual(r1.updatedAt);
  });
});

describe('localMemoryBrain log', () => {
  it('writes device-tagged entries and reads them back', async () => {
    const b = mk();
    await b.appendLogEntry('u', 'did a thing', { date: '2026-06-23', time: '10:00' });
    await b.appendLogEntry('u', 'did another', { date: '2026-06-23', time: '11:30' });
    const { content, date } = await b.getLog('u', '2026-06-23');
    expect(date).toBe('2026-06-23');
    expect(content).toContain('# 2026-06-23');
    expect(content).toContain('### 10:00\n@devA did a thing');
    expect(content).toContain('### 11:30\n@devA did another');
  });

  it('appendLogEntry rejects empty', async () => {
    const b = mk();
    await expect(b.appendLogEntry('u', '   ')).rejects.toThrow();
  });
});
