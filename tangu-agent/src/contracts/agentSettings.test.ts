import { describe, it, expect, vi } from 'vitest';
import { createAgentSettingsRegistry } from './agentSettings.js';
const owner = { id: 'latex-suite', name: 'LaTeX Suite', version: '1.1' };
describe.each(['ui', 'engine'] as const)('Agent settings in %s', (source) => {
  it('projects only declared fields; secrets only return configured status', async () => {
    const registry = createAgentSettingsRegistry(source);
    registry.register(owner, { fields: [
      { key: 'enabled', type: 'boolean', description: 'Enabled' },
      { key: 'token', type: 'secret', description: 'Token configured' },
    ], read: () => ({ enabled: false, token: 'never-expose-me', undeclared: 'private' }) });
    const r = await registry.read(owner.id);
    expect(r.fields).toEqual([
      { key: 'enabled', type: 'boolean', description: 'Enabled', scope: 'device', value: false },
      { key: 'token', type: 'secret', description: 'Token configured', scope: 'device', unavailable: true },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/never-expose-me|private/);
    expect((await registry.read(owner.id, ['undeclared'])).error).toBe('invalid_keys');
  });
  it('revokes delayed results across disable and replacement', async () => {
    const registry = createAgentSettingsRegistry(source);
    let done!: (v: any) => void;
    const off = registry.register(owner, { fields: [{ key: 'lang', type: 'string', description: '' }], read: () => new Promise((resolve) => { done = resolve; }) });
    const pending = registry.read(owner.id);
    await Promise.resolve();
    registry.register({ ...owner, version: '2' }, { fields: [{ key: 'lang', type: 'string', description: '' }], read: () => ({ lang: 'new' }) });
    off(); // An older disposer cannot revoke the replacement.
    done({ lang: 'old' });
    expect((await pending).error).toBe('unavailable');
    expect((await registry.read(owner.id)).fields?.[0].value).toBe('new');
  });
  it('reads live per-user values, bounds results, and sanitizes provider errors', async () => {
    const registry = createAgentSettingsRegistry(source);
    const fields = [{ key: 'language', type: 'string' as const, description: '' }];
    registry.register(owner, { fields, read: ({ userId }) => ({ language: userId || '' }) });
    expect((await registry.read(owner.id, undefined, { userId: 'alice' })).fields?.[0].value).toBe('alice');
    expect((await registry.read(owner.id, undefined, { userId: 'bob' })).fields?.[0].value).toBe('bob');
    registry.register(owner, { fields, read: () => ({ language: 'a'.repeat(8000) }) });
    expect((await registry.read(owner.id)).error).toBe('too_large');
    registry.register(owner, { fields, read: () => { throw new Error('private-token'); } });
    expect(await registry.read(owner.id)).toEqual({ kind: 'plugin_settings', source, error: 'unavailable' });
    registry.register(owner, { fields, read: () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private-token'); } }) });
    expect(await registry.read(owner.id)).toEqual({ kind: 'plugin_settings', source, error: 'unavailable' });
  });
  it('does not invoke a provider after cancellation', async () => {
    const registry = createAgentSettingsRegistry(source);
    const read = vi.fn(() => ({}));
    registry.register(owner, { fields: [], read });
    const controller = new AbortController(); controller.abort();
    expect((await registry.read(owner.id, undefined, { signal: controller.signal })).error).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
  });
});
