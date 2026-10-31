import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginSkill, listPluginSkills, PLUGIN_SKILL_TIMEOUT_MS, registerPluginSkillProvider } from './pluginSkills.js';

const disposers: Array<() => void> = [];
const entry = (id = 'release') => ({ id, name: 'Release', description: 'Prepare a release', content: 'Read references/release.md.' });
const register = (owner: string, provider: Parameters<typeof registerPluginSkillProvider>[1]) => {
  const off = registerPluginSkillProvider(owner, provider); disposers.push(off); return off;
};
afterEach(() => { for (const off of disposers.splice(0)) off(); vi.useRealTimers(); });

describe('plugin skill providers', () => {
  it('assigns ownership, isolates identical names and snapshots source data', async () => {
    const item = entry();
    const provider = { id: 'skills', list: async () => [item] };
    register('alpha', provider);
    register('beta', { id: 'skills', list: async () => [entry()] });
    provider.id = 'changed';
    const skills = await listPluginSkills();
    expect(skills.map(skill => skill.id)).toEqual(['local:plugin/alpha/skills/release', 'local:plugin/beta/skills/release']);
    expect(skills[0]).toMatchObject({ source: 'plugin', readOnly: true, is_builtin: false, origin: null });
    item.content = 'new content';
    expect(skills[0].content).toBe('Read references/release.md.');
    expect((await getPluginSkill(skills[0].id))?.content).toBe('new content');
  });

  it('validates slugs, duplicate identities, rows and absolute resource directories', async () => {
    expect(() => register('owner', { id: '../escape', list: async () => [] })).toThrow();
    expect(() => register('owner', { id: 42, list: async () => [] } as any)).toThrow();
    register('owner', { id: 'skills', list: async () => [entry(), entry(), entry('../escape'), { ...entry('relative'), dir: 'references' }, { ...entry('absolute'), dir: path.join(tmpdir(), 'resources') }, { ...entry('empty'), content: '' }] });
    expect(() => register('owner', { id: 'skills', list: async () => [] })).toThrow(/already registered/);
    expect((await listPluginSkills()).map(skill => skill.id)).toEqual(['local:plugin/owner/skills/release', 'local:plugin/owner/skills/absolute']);
    expect(await getPluginSkill('local:plugin/owner/skills/../escape')).toBeNull();
  });

  it('revokes in-flight reads and never resurrects an old activation', async () => {
    let finish!: (value: ReturnType<typeof entry>[]) => void;
    let signal!: AbortSignal;
    const off = register('owner', { id: 'skills', list: async context => {
      signal = context.signal!;
      return new Promise(resolve => { finish = resolve; });
    } });
    const reading = listPluginSkills();
    await Promise.resolve();
    off();
    register('owner', { id: 'skills', list: async () => [{ ...entry(), content: 'replacement' }] });
    expect(signal.aborted).toBe(true);
    expect(await reading).toEqual([]);
    finish([entry()]);
    expect((await getPluginSkill('local:plugin/owner/skills/release'))?.content).toBe('replacement');
    off(); // stale disposer cannot revoke the replacement
    expect((await listPluginSkills())[0].content).toBe('replacement');
  });

  it('contains rejection and timeout, aborts the source and allows later recovery', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    let hung = true;
    register('healthy', { id: 'skills', list: async () => [entry()] });
    register('broken', { id: 'skills', list: async () => { throw new Error('source offline'); } });
    register('slow', { id: 'skills', list: async context => {
      signal = context.signal!;
      return hung ? new Promise(() => {}) : [entry()];
    } });
    const reading = listPluginSkills();
    await vi.advanceTimersByTimeAsync(PLUGIN_SKILL_TIMEOUT_MS);
    expect((await reading).map(skill => skill.id)).toEqual(['local:plugin/healthy/skills/release']);
    expect(signal.aborted).toBe(true);
    hung = false;
    expect((await getPluginSkill('local:plugin/slow/skills/release'))?.name).toBe('Release');
  });

  it('drops an already resolved source revoked while another source is still pending', async () => {
    const off = register('fast', { id: 'skills', list: async () => [entry()] });
    let finish!: (value: ReturnType<typeof entry>[]) => void;
    register('slow', { id: 'skills', list: async () => new Promise(resolve => { finish = resolve; }) });
    const reading = listPluginSkills();
    // Let the fast read finish while the aggregate is still awaiting the slow source.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    off();
    register('fast', { id: 'skills', list: async () => [{ ...entry(), content: 'replacement' }] });
    finish([entry()]);
    expect((await reading).map(skill => skill.id)).toEqual(['local:plugin/slow/skills/release']);
  });

  it('passes cwd and refreshes deletion/disable without reading unrelated providers', async () => {
    let enabled = true;
    const list = vi.fn(async () => enabled ? [entry()] : []);
    register('owner', { id: 'skills', list });
    const unrelated = vi.fn(async () => { throw new Error('must not read'); });
    register('other', { id: 'skills', list: unrelated });
    const cwd = path.join(tmpdir(), 'project');
    expect(await getPluginSkill('local:plugin/owner/skills/release', cwd)).not.toBeNull();
    expect(list.mock.calls[0][0]).toMatchObject({ cwd, signal: expect.any(AbortSignal) });
    enabled = false;
    expect(await getPluginSkill('local:plugin/owner/skills/release')).toBeNull();
    expect(unrelated).not.toHaveBeenCalled();
  });
});
