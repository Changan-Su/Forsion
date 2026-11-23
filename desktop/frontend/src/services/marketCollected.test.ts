import { describe, expect, it } from 'vitest'
import type { MarketCard } from '../types'
import { ackOf, chatItemExtras, compactCount, confirmNeededOf, confirmOf, fetchPlanCards, installPlan, publisherOf } from './marketCollected'

const SH = '25aae625'
const card = (id: string, over: Partial<MarketCard> = {}): MarketCard => ({
  id: `src_${SH}_${id}`, type: 'skill', source: 'github', name: id, summary: '', author: 'a', installSlug: `src-${SH}-${id}`, downloads: 1, latestVersion: '1', ...over,
} as MarketCard)
const pre = (id: string, over: Record<string, unknown> = {}) => ({ id: `src_${SH}_${id}`, itemId: id, name: id, installSlug: `src-${SH}-${id}`, scripts: 0, auditWarn: false, ...over })

describe('publisherOf', () => {
  const sources = [{ id: '0a1b2c3d', title: '图片 Skills 大全' }] as never
  it('labels Forsion items official / developer, collected skills skills.sh, other sources unreviewed or removed', () => {
    expect(publisherOf({ id: 'latex-suite', publisher: 'official' })).toEqual({ kind: 'official' })
    expect(publisherOf({ id: 'latex-suite', origin: { kind: 'forsion', publisher: 'official' } })).toEqual({ kind: 'official' })
    expect(publisherOf({ id: 'x' })).toEqual({ kind: 'developer' })
    expect(publisherOf({ id: `src_${SH}_wayfinder` }, sources)).toEqual({ kind: 'builtin' })
    expect(publisherOf({ id: 'src_0a1b2c3d_poster' }, sources)).toEqual({ kind: 'source', title: '图片 Skills 大全' })
    expect(publisherOf({ id: 'src_9c9c9c9c_meme' }, sources)).toEqual({ kind: 'removed' })
    // Without the desktop's source table (web), the item's own title stands in.
    expect(publisherOf({ id: 'src_9c9c9c9c_meme', origin: { sourceTitle: 'Meme' } })).toEqual({ kind: 'source', title: 'Meme' })
    // A chat row claiming to be Forsion's doesn't hide that its id is a source's.
    expect(publisherOf({ id: 'src_0a1b2c3d_poster', origin: { kind: 'forsion', publisher: 'official' } }, sources)).toEqual({ kind: 'source', title: '图片 Skills 大全' })
  })
})

describe('installPlan', () => {
  const a = card('a', { prereqs: [pre('b'), pre('gone', { missing: true })] as never })
  const b = card('b', { prereqs: [pre('c'), pre('a')] as never, collected: { scripts: 3, audit: { gen: 'safe', socket: 'safe', snyk: 'safe' } } as never })
  const c = card('c', { collected: { scripts: 0, audit: { gen: 'high', socket: 'safe', snyk: 'safe' } } as never })
  const lookup = (id: string) => [a, b, c].find((x) => x.id === id)
  it('installs prerequisites first, transitively and once each, and reports the ones not collected', () => {
    const plan = installPlan(a, { installed: () => false, lookup })
    expect(plan.steps.map((s) => s.name)).toEqual(['c', 'b', 'a'])
    expect(plan.missing).toEqual(['gone'])
    expect(plan.steps.map((s) => [s.scripts, s.audit])).toEqual([[0, true], [3, false], [0, false]])
  })
  it('skips prerequisites already installed, and Forsion items have no plan beyond themselves', () => {
    expect(installPlan(a, { installed: (slug) => slug.endsWith('-b'), lookup }).steps.map((s) => s.name)).toEqual(['c', 'a'])
    expect(installPlan(card('x', { id: 'plain' }), { installed: () => false, lookup }).steps.map((s) => s.id)).toEqual(['plain'])
  })
  it('fetches the prerequisite cards it needs, level by level', async () => {
    const asked: string[] = []
    const got = await fetchPlanCards(a, async (id) => { asked.push(id); return lookup(id) ?? null })
    expect([...got.keys()].sort()).toEqual([b.id, c.id])
    expect(asked).not.toContain(a.id)
  })
})

describe('confirmations', () => {
  it('asks for items with scripts or an audit warning, taking the higher of the catalog and what main counted', () => {
    const steps = [{ id: `src_${SH}_b`, type: 'skill', name: 'b', installSlug: 'x', scripts: 0, audit: false }, { id: `src_${SH}_a`, type: 'skill', name: 'a', installSlug: 'y', scripts: 2, audit: false }] as never
    expect(confirmOf(steps)).toMatchObject({ scripts: 2, audit: false })
    const found = { [`src_${SH}_b`]: { scripts: 1, audit: true } }
    expect(confirmOf(steps, found)).toMatchObject({ scripts: 3, audit: true })
    expect(confirmOf([{ id: 'forsion-item', type: 'skill', name: 'f', installSlug: 'f', scripts: 4, audit: false }] as never)).toBeNull()
    expect(ackOf((steps as never[])[1], { scripts: 1, audit: true })).toEqual({ scripts: 2, audit: true })
  })
  it('reads the counts main refused with, through the IPC wrapper', () => {
    expect(confirmNeededOf(new Error("Error invoking remote method 'market:install': Error: install: confirm-needed scripts=9 audit=1"))).toEqual({ scripts: 9, audit: true })
    expect(confirmNeededOf({ raw: 'install: confirm-needed scripts=0 audit=1', message: 'x' })).toEqual({ scripts: 0, audit: true })
    expect(confirmNeededOf(new Error('install: skill-invalid'))).toBeNull()
  })
})

describe('chatItemExtras', () => {
  it('keeps well-formed optional fields and drops the rest', () => {
    expect(chatItemExtras({
      publisher: 'official', downloads: 12.7, origin: { kind: 'collected', sourceId: SH, sourceTitle: ' skills.sh ' },
      requirements: { cli: true, apiKeys: ['OPENAI_API_KEY', 'bad key'], desktopOnly: false, scripts: 9, auditWarn: true },
    })).toEqual({
      publisher: 'official', downloads: 12, origin: { kind: 'collected', sourceId: SH, sourceTitle: 'skills.sh' },
      requirements: { cli: true, apiKeys: ['OPENAI_API_KEY'], desktopOnly: false, scripts: 9, auditWarn: true },
    })
    expect(chatItemExtras({ publisher: 'admin', downloads: -1, origin: { kind: 'evil' }, requirements: null })).toEqual({})
    expect(chatItemExtras({ origin: { kind: 'source', sourceId: 'NOT-HEX!' } })).toEqual({ origin: { kind: 'source' } })
    expect(chatItemExtras(null)).toEqual({})
  })
})

describe('compactCount', () => {
  it('writes counts the way the store does', () => {
    expect(compactCount(1650274, 'zh')).toBe('165 万')
    expect(compactCount(841892, 'zh')).toBe('84.2 万')
    expect(compactCount(408, 'zh')).toBe('408')
    expect(compactCount(1650274, 'en')).toBe('1.7M')
  })
})
