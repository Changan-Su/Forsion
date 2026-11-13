import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { persistLargeOutput, formatToolOutput, readToolOutput, toolOutputTokenBudget } from './outputPersist.js';
import { estimateTokensRough } from '../services/contextBudget.js';
import type { ToolContext } from './toolTypes.js';
let home: string;
const ctx = { execMode: 'host', runId: 'r-test', userId: 'u', appId: 'tangu', sessionId: 's', contextWindow: 128000 } as ToolContext;
beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'spill-test-')); process.env.TANGU_HOME = home; });
afterEach(async () => { delete process.env.TANGU_HOME; await fs.rm(home, { recursive: true, force: true }); });
describe('session-scoped tool output spill', () => {
  it('keeps small output inline and preserves complete large output behind a bounded preview', async () => {
    expect(await persistLargeOutput(ctx, 'unit', 'short')).toEqual({ preview: 'short', path: null });
    const big = 'H'.repeat(3000) + 'M'.repeat(8000) + 'T'.repeat(500);
    const r = await persistLargeOutput(ctx, 'unit', big);
    expect(r.path).toBeTruthy(); expect(path.isAbsolute(r.path!)).toBe(true);
    expect(await fs.readFile(r.path!, 'utf8')).toBe(big);
    expect(r.preview).toContain('H'.repeat(100)); expect(r.preview).toContain('T'.repeat(100));
    expect(estimateTokensRough(await formatToolOutput(ctx, 'unit', big))).toBeLessThanOrEqual(toolOutputTokenBudget(ctx));
    expect(await persistLargeOutput(ctx, 'different-label', big)).toEqual(r);
  });
  it('uses CJK-aware/window-aware budgets, and can retrieve every omitted character across runs', async () => {
    const full = '中文日志内容\n'.repeat(1000);
    const small = { ...ctx, contextWindow: 8000 };
    const r = await persistLargeOutput(small, 'unit', full);
    expect(estimateTokensRough(await formatToolOutput(small, 'unit', full))).toBeLessThanOrEqual(512);
    let offset: number | null = 0, reconstructed = '';
    while (offset !== null) { const page = JSON.parse(await readToolOutput({ ...small, runId: 'next-run' }, { id: r.id, offset, limit: 1000 })); reconstructed += page.text; offset = page.nextOffset; }
    expect(reconstructed).toBe(full);
  });
  it('selects omitted matching lines and denies cross-session access, traversal and tampering', async () => {
    const full = 'ordinary\n'.repeat(800) + 'FINDING exact-evidence\n' + 'ordinary\n'.repeat(800);
    const r = await persistLargeOutput(ctx, 'unit', full);
    const selected = JSON.parse(await readToolOutput(ctx, { id: r.id, contains: 'FINDING' }));
    expect(selected.matches.map((m: any) => m.text)).toEqual(['FINDING exact-evidence']);
    expect(selected.nextOffset).toBeNull();
    await expect(readToolOutput({ ...ctx, sessionId: 'other' }, { id: r.id })).rejects.toThrow('missing');
    await expect(readToolOutput(ctx, { id: '../config.json' })).rejects.toThrow('Invalid');
    await fs.writeFile(r.path!, 'changed');
    await expect(readToolOutput(ctx, { id: r.id })).rejects.toThrow('integrity');
  });
  it('rejects symlinks and reports incomplete previews when persistence fails', async () => {
    const big = 'data\n'.repeat(2000), r = await persistLargeOutput(ctx, 'unit', big);
    await fs.unlink(r.path!); await fs.symlink(path.join(home, 'private.txt'), r.path!);
    await fs.writeFile(path.join(home, 'private.txt'), 'private');
    expect((await persistLargeOutput(ctx, 'unit', big)).path).toBeNull();
    await expect(readToolOutput(ctx, { id: r.id })).rejects.toThrow('Invalid');
    expect(await fs.readFile(path.join(home, 'private.txt'), 'utf8')).toBe('private');
    const failed = await persistLargeOutput(ctx, 'unit', 'x'.repeat(17*1024*1024));
    expect(failed.preview).toContain('could not be saved'); expect(failed.path).toBeNull();
  });
});

it('reconstructs a long matching line across filtered pages without losing its suffix', async () => {
  const full = 'FINDING ' + 'A'.repeat(9000) + '\nnot selected\n';
  const artifact = await persistLargeOutput(ctx, 'long-line', full);
  let offset: number | null = 0, reconstructed = '';
  while (offset !== null) {
    const page = JSON.parse(await readToolOutput(ctx, { id: artifact.id, offset, limit: 700, contains: 'FINDING' }));
    reconstructed += page.matches.map((m: any) => m.text).join(''); offset = page.nextOffset;
  }
  expect(reconstructed).toBe(full.split('\n')[0]);
});

it('retains the legacy cap when the current tool loadout cannot retrieve spill handles', async () => {
  const text = 'ordinary-data '.repeat(1000);
  expect(await formatToolOutput({ ...ctx, canReadToolOutput: false }, 'unit', text)).toBe(text);
});

it('preserves instruction text with or without a reader while the same ordinary data still spills', async () => {
  const text = 'Instruction paragraph.\n'.repeat(2500) + 'MIDDLE_REQUIREMENT\n' + 'More instructions.\n'.repeat(2500);
  for (const canReadToolOutput of [true, false]) {
    expect(await formatToolOutput({ ...ctx, canReadToolOutput }, 'use_skill', text, 'instructions')).toBe(text);
  }
  expect(await fs.readdir(home)).toEqual([]);
  // The label alone is not authority to bypass output limits.
  const data = await formatToolOutput(ctx, 'use_skill', text);
  expect(data).not.toContain('MIDDLE_REQUIREMENT');
  expect(data).toContain('read_tool_output');
  expect(estimateTokensRough(data)).toBeLessThanOrEqual(toolOutputTokenBudget(ctx));
});

it('bounds serialized pages so escape-heavy text and many tiny matches never spill again', async () => {
  const small = { ...ctx, contextWindow: 8000 };
  for (const full of ['FINDING ' + '\u0000'.repeat(4000), 'x\n'.repeat(2500)]) {
    const artifact = await persistLargeOutput(small, 'escaped', full);
    for (const contains of [undefined, full.startsWith('FINDING') ? 'FINDING' : 'x']) {
      let offset: number | null = 0, reconstructed = '';
      while (offset !== null) {
        const serialized = await readToolOutput(small, { id: artifact.id, offset, contains });
        expect(estimateTokensRough(serialized)).toBeLessThanOrEqual(toolOutputTokenBudget(small));
        expect(await formatToolOutput(small, 'read_tool_output', serialized)).toBe(serialized);
        const page = JSON.parse(serialized);
        reconstructed += contains ? page.matches.map((m: any) => m.text).join('') : page.text;
        if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(reconstructed).toBe(contains ? full.replaceAll('\n', '') : full);
    }
  }
});
