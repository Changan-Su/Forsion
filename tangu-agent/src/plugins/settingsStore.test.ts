import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerPlugin } from './registry.js';
import {
  isPluginEnabledSync, setPluginEnabled, getScopeSettings, setScopeSettings,
  getPluginSettingsSync, resolveImageListScope, parseScope,
  writePluginFile, readPluginFile, listPluginFiles, deletePluginFile,
} from './settingsStore.js';

const PID = 'test-plugin';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tangu-plugins-'));
  process.env.TANGU_HOME = dir;
  registerPlugin({
    id: PID, name: 'Test', description: 'x', scopes: ['global', 'agent'],
    settings: {
      fields: [
        { key: 'flag', type: 'toggle', label: 'Flag', default: true },
        { key: 'delay', type: 'number', label: 'Delay', default: 100 },
        { key: 'memes', type: 'image-list', label: 'Memes', itemFields: [{ key: 'meaning', type: 'text', label: 'M' }] },
      ],
    },
  });
});
afterAll(() => { delete process.env.TANGU_HOME; try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('plugin settingsStore', () => {
  it('schema defaults fill unset values', () => {
    expect(getScopeSettings(PID, 'global')).toEqual({ flag: true, delay: 100, memes: [] });
  });

  it('enable defaults false, then toggles', async () => {
    expect(isPluginEnabledSync(PID)).toBe(false);
    await setPluginEnabled(PID, true);
    expect(isPluginEnabledSync(PID)).toBe(true);
  });

  it('global set/get merges over defaults', async () => {
    await setScopeSettings(PID, 'global', { delay: 500 });
    const v = getScopeSettings(PID, 'global');
    expect(v.delay).toBe(500);
    expect(v.flag).toBe(true); // untouched default
  });

  it('per-agent scalar overrides global, image-list whole-group resolution', async () => {
    await setScopeSettings(PID, 'global', { flag: false });
    await setScopeSettings(PID, { agentSlug: 'xyra' }, { delay: 999, memes: [{ file: 'a.png', meaning: 'hi' }] });
    const merged = getPluginSettingsSync(PID, { agentSlug: 'xyra' });
    expect(merged.flag).toBe(false); // from global
    expect(merged.delay).toBe(999); // agent override
    expect(merged.memes).toEqual([{ file: 'a.png', meaning: 'hi' }]); // agent has non-empty → use agent's
    expect(resolveImageListScope(PID, 'memes', 'xyra')).toEqual({ agentSlug: 'xyra' });
    // an agent with no memes falls back to global (empty here)
    expect(resolveImageListScope(PID, 'memes', 'other')).toBe('global');
  });

  it('blob write/list/read/delete round-trips', async () => {
    await writePluginFile(PID, 'global', 'pic.png', Buffer.from('hello'));
    expect((await listPluginFiles(PID, 'global')).map((f) => f.name)).toContain('pic.png');
    const f = await readPluginFile(PID, 'global', 'pic.png');
    expect(f?.buffer.toString()).toBe('hello');
    await deletePluginFile(PID, 'global', 'pic.png');
    expect(await readPluginFile(PID, 'global', 'pic.png')).toBeNull();
  });

  it('parseScope', () => {
    expect(parseScope('global')).toBe('global');
    expect(parseScope(undefined)).toBe('global');
    expect(parseScope('agent:xyra')).toEqual({ agentSlug: 'xyra' });
    expect(() => parseScope('bogus')).toThrow();
  });
});
