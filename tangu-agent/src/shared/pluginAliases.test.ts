import { it, expect } from 'vitest';
import { pluginDependencyIndex } from './pluginAliases.js';
it('keeps exact identities authoritative and resolves only unique package aliases', () => {
  const one = { id: 'market-one', packageId: 'base' }, two = { id: 'market-two', packageId: 'base' };
  expect(pluginDependencyIndex([one]).get('base')).toBe(one);
  expect(pluginDependencyIndex([one, two]).has('base')).toBe(false);
  const legacy = { id: 'base' };
  expect(pluginDependencyIndex([one, two, legacy]).get('base')).toBe(legacy);
});
