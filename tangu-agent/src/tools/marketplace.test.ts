import { describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock('../seams/runtime.js', () => ({ isConfigured: () => true, deps: () => ({ brain: { marketplace: fixture } }) }));
import { marketplaceProvider } from './builtin/marketplace.js';
import { marketplaceItemsOf } from '../shared/marketplace.js';
describe('Forsion marketplace tools', () => {
  const item = (id: string, name: string, tags = ['notes']) => ({ id, name, tags, installSlug: `market-${id}`, type: 'amadeus-plugin', source: 'zip', author: 'Author', summary: 'PDF notes', minAppVersion: '2.13.0', platforms: ['desktop'] });
  it('searches the entire catalog, preserves duplicate names, applies filters and propagates cancellation', async () => {
    const signal = new AbortController().signal;
    fixture.list.mockResolvedValue([...Array.from({ length: 20 }, (_, n) => item(`unrelated${n}`, 'Other', ['calendar'])), item('one', 'Same'), item('two', 'Same')]);
    const tool = (await marketplaceProvider.tools({} as any))[0];
    const result = await tool.execute({ query: 'same', tags: ['notes'], type: 'amadeus-plugin', limit: 6 }, { signal } as any);
    expect(marketplaceItemsOf(result).map(x => x.id)).toEqual(['one', 'two']);
    expect(fixture.list).toHaveBeenCalledWith(signal);
    expect(marketplaceItemsOf(await tool.execute({ query: 'absent' }, {} as any))).toEqual([]);
  });
  it('looks up immutable IDs and rejects unavailable entries and path injection', async () => {
    const tool = (await marketplaceProvider.tools({} as any))[1];
    await expect(tool.execute({ id: '../bad' }, {} as any)).rejects.toThrow('Invalid');
    fixture.detail.mockResolvedValue(null);
    await expect(tool.execute({ id: 'one' }, {} as any)).rejects.toThrow('unavailable');
    fixture.detail.mockResolvedValue(item('one', 'Same'));
    expect(marketplaceItemsOf(await tool.execute({ id: 'one' }, {} as any))[0].id).toBe('one');
  });
});

it('keeps large records valid under the engine cap and does not exclude OS-specific desktop entries', async () => {
  const tools = await marketplaceProvider.tools({} as any);
  const record = { id: 'large', name: 'Large PDF', type: 'amadeus-plugin', installSlug: 'large', author: 'Author', summary: 'PDF', minAppVersion: '2.13.0', platforms: ['macos'], description: 'x'.repeat(200000), readme: 'x'.repeat(200000), tags: [] };
  fixture.list.mockResolvedValue([record]);
  const result = await tools[0].execute({ query: 'PDF', type: 'plugin' }, { client: 'desktop/2.13.4' } as any);
  expect(String(result).length).toBeLessThan(48000);
  expect(marketplaceItemsOf(result)[0].id).toBe('large');
  fixture.detail.mockResolvedValue(record);
  const detail = await tools[1].execute({ id: 'large' }, {} as any);
  expect(String(detail).length).toBeLessThan(48000);
  expect(marketplaceItemsOf(detail)[0].id).toBe('large');
});

it('matches capabilities beyond the display excerpt and includes their source excerpt', async () => {
  fixture.list.mockResolvedValue([{ id: 'deep', name: 'Notes', type: 'amadeus-plugin', installSlug: 'deep', summary: 'Notes', description: 'x'.repeat(60000) + ' longitudinal-probe capability', tags: [] }]);
  const search = (await marketplaceProvider.tools({} as any))[0];
  const result = await search.execute({ query: 'longitudinal-probe' }, {} as any);
  expect(marketplaceItemsOf(result)[0].id).toBe('deep');
  expect(marketplaceItemsOf(result)[0].description).toContain('longitudinal-probe');
  expect(String(result).length).toBeLessThan(48000);
});
