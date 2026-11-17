import { it, expect } from 'vitest';
import { pluginDependencyIndex, pluginViewAlias, supersededPlainInstalls } from './pluginAliases.js';
it('keeps exact identities authoritative and resolves only unique package aliases', () => {
  const one = { id: 'market-one', packageId: 'base' }, two = { id: 'market-two', packageId: 'base' };
  expect(pluginDependencyIndex([one]).get('base')).toBe(one);
  expect(pluginDependencyIndex([one, two]).has('base')).toBe(false);
  const legacy = { id: 'base' };
  expect(pluginDependencyIndex([one, two, legacy]).get('base')).toBe(legacy);
});

const A = 'market-00000000-0000-4000-8000-00000000000a';
const B = 'market-00000000-0000-4000-8000-00000000000b';

it('lets a store install replace the plain install of the same package', () => {
  // The plain copy sorts first; it used to load next to the store copy and win the shared Space id.
  const dirs = [{ dir: 'demo-suite', manifestId: 'demo-suite' }, { dir: A, manifestId: 'demo-suite' }, { dir: 'other', manifestId: 'other' }];
  expect([...supersededPlainInstalls(dirs)]).toEqual([['demo-suite', A]]);
  // A plain directory whose manifest id is broken still runs under its directory name.
  expect([...supersededPlainInstalls([{ dir: 'demo-suite', manifestId: 'Not Valid' }, { dir: A, manifestId: 'demo-suite' }])]).toEqual([['demo-suite', A]]);
});

it('replaces nothing when the store claim is ambiguous, protected or absent', () => {
  expect(supersededPlainInstalls([{ dir: 'demo-suite', manifestId: 'demo-suite' }, { dir: A, manifestId: 'demo-suite' }, { dir: B, manifestId: 'demo-suite' }]).size).toBe(0);
  expect(supersededPlainInstalls([{ dir: 'demo-suite', manifestId: 'demo-suite' }, { dir: A, manifestId: 'demo-suite' }], new Set(['demo-suite'])).size).toBe(0);
  expect(supersededPlainInstalls([{ dir: 'demo-suite', manifestId: 'demo-suite' }, { dir: A, manifestId: 'other' }]).size).toBe(0);
  // Two store installs never replace each other.
  expect(supersededPlainInstalls([{ dir: A, manifestId: 'demo-suite' }, { dir: B, manifestId: A }]).size).toBe(0);
});

it('moves a saved view to the identity its plugin runs under now', () => {
  const store = { id: A, packageId: 'demo-suite' };
  expect(pluginViewAlias('plugin:demo-suite:chat', [store])).toBe(`plugin:${A}:chat`);
  expect(pluginViewAlias('plugin:demo-suite:nested/view', [store])).toBe(`plugin:${A}:nested/view`);
  // The old identity is still listed (even disabled): it keeps its views.
  expect(pluginViewAlias('plugin:demo-suite:chat', [store, { id: 'demo-suite' }])).toBeNull();
  expect(pluginViewAlias('plugin:demo-suite:chat', [store, { id: B, packageId: 'demo-suite' }])).toBeNull();
  expect(pluginViewAlias(`plugin:${A}:chat`, [store])).toBeNull();
  expect(pluginViewAlias('chat', [store])).toBeNull();
});
