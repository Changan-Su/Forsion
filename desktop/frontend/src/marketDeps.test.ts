import { describe, expect, it } from 'vitest'
import { depCard, installableDeps, planDeps } from './marketDeps'
import { unmetClosure, unmetDependencies, type DepNode, type UnmetDependency } from './amadeus/plugins/pluginDeps'
import type { MarketCard } from './types'

const card = (over: Partial<MarketCard>): MarketCard => ({
  id: over.installSlug || 'x', type: 'amadeus-plugin', source: 'zip', name: 'Item', summary: '', author: '', installSlug: 'x', downloads: 0, ...over,
})
const unmet = (id: string, over: Partial<UnmetDependency['dep']> = {}, reason: UnmetDependency['reason'] = 'missing'): UnmetDependency => ({ dep: { id, ...over }, reason })
const ctx = { appVersion: '2.13.8', platform: 'macos', isInstalled: () => false }

describe('depCard', () => {
  it('matches dep.market first, then dep.id', () => {
    const byMarket = card({ installSlug: 'market-abc' }), byId = card({ installSlug: 'lib' })
    expect(depCard({ id: 'lib', market: 'market-abc' }, [byId, byMarket])).toBe(byMarket)
    expect(depCard({ id: 'lib', market: 'gone' }, [byId])).toBe(byId)
    expect(depCard({ id: 'lib' }, [byId])).toBe(byId)
  })

  it('never matches by display name', () => {
    expect(depCard({ id: 'lib', name: 'Lib' }, [card({ installSlug: 'other', name: 'Lib' })])).toBeUndefined()
  })

  it('treats a shared install slug as no match', () => {
    const twins = [card({ id: 'a', installSlug: 'item' }), card({ id: 'b', installSlug: 'item' })]
    expect(depCard({ id: 'item' }, twins)).toBeUndefined()
  })

  it('ignores entries that cannot satisfy a Forsion plugin', () => {
    expect(depCard({ id: 'lib' }, [card({ installSlug: 'lib', type: 'plugin' })])).toBeUndefined()
  })
})

describe('planDeps', () => {
  it('offers what the store can install', () => {
    const lib = card({ installSlug: 'lib', latestVersion: '1.4.0' })
    const plan = planDeps([unmet('lib', { minVersion: '1.2.0' })], [lib], ctx)
    expect(plan[0]).toMatchObject({ card: lib })
    expect(installableDeps(plan)).toEqual([lib])
  })

  it('offers an update when the installed copy is too old and the store has a newer one', () => {
    const lib = card({ installSlug: 'lib', latestVersion: '2.1.0' })
    const plan = planDeps([unmet('lib', { minVersion: '2.0.0' }, 'version')], [lib], { ...ctx, isInstalled: () => true })
    expect(installableDeps(plan)).toEqual([lib])
  })

  it('reports what the store cannot do', () => {
    const skipOf = (u: UnmetDependency, cards: MarketCard[], c = ctx) => { const [x] = planDeps([u], cards, c); expect(installableDeps([x])).toEqual([]); return x.skip }
    expect(skipOf(unmet('lib'), [])).toBe('absent')
    expect(skipOf(unmet('lib', { minVersion: '2.0.0' }), [card({ installSlug: 'lib', latestVersion: '1.4.0' })])).toBe('low')
    expect(skipOf(unmet('lib'), [card({ installSlug: 'lib', minAppVersion: '9.0.0' })])).toBe('incompatible')
    expect(skipOf(unmet('lib'), [card({ installSlug: 'lib', tags: ['desktop-only'] })], { ...ctx, platform: 'android' })).toBe('incompatible')
    expect(skipOf(unmet('lib'), [card({ installSlug: 'lib' })], { ...ctx, isInstalled: () => true })).toBe('mismatch')
  })

  it('leaves states the store cannot change alone', () => {
    const plan = planDeps([unmet('lib', {}, 'off'), unmet('b', {}, 'cycle'), unmet('c', {}, 'waiting')], [card({ installSlug: 'lib' })], ctx)
    expect(plan.map((x) => x.skip)).toEqual([undefined, undefined, undefined])
    expect(installableDeps(plan)).toEqual([])
  })
})

describe('unmetClosure', () => {
  const unmetOf = (all: DepNode[], active: string[]) => (x: DepNode) => unmetDependencies(x, all, (id) => active.includes(id), () => true)

  it('walks into a prerequisite that is itself waiting', () => {
    const app = { id: 'app', version: '1.0.0', requiresPlugins: [{ id: 'lib' }] }
    const lib = { id: 'lib', version: '1.0.0', requiresPlugins: [{ id: 'base' }] }
    expect(unmetClosure(app, [app, lib], unmetOf([app, lib], [])).map((u) => [u.dep.id, u.reason])).toEqual([['lib', 'waiting'], ['base', 'missing']])
  })

  it('keeps the strictest minVersion when several plugins require the same one', () => {
    const app = { id: 'app', version: '1.0.0', requiresPlugins: [{ id: 'lib' }, { id: 'core', minVersion: '2.0.0' }] }
    const lib = { id: 'lib', version: '1.0.0', requiresPlugins: [{ id: 'core', minVersion: '1.0.0' }] }
    const out = unmetClosure(app, [app, lib], unmetOf([app, lib], []))
    expect(out.map((u) => [u.dep.id, u.dep.minVersion])).toEqual([['lib', undefined], ['core', '2.0.0']])
    const plan = planDeps(out.slice(1), [card({ installSlug: 'core', latestVersion: '1.5.0' })], ctx)
    expect(plan[0].skip).toBe('low')
  })

  it('terminates on a cycle and lists each id once', () => {
    const a = { id: 'a', version: '1.0.0', requiresPlugins: [{ id: 'b' }, { id: 'c' }] }
    const b = { id: 'b', version: '1.0.0', requiresPlugins: [{ id: 'a' }, { id: 'c' }] }
    expect(unmetClosure(a, [a, b], unmetOf([a, b], [])).map((u) => u.dep.id)).toEqual(['b', 'c'])
  })
})
