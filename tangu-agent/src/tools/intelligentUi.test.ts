import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computedUiEnabledFor, intelligentUiEnabledFor, intelligentUiProvider, looksLikeLeakedUiDocument } from './builtin/intelligentUi.js'
import { sketchProvider, sketchTurnSignalFor } from './builtin/sketch.js'
describe('native renderer handshake', () => {
  const context = { client: 'desktop/2.13.1', clientCapabilities: ['intelligent-ui.v1'] }
  it('is absent on old clients and nonvisual runs', () => {
    expect(intelligentUiEnabledFor({ client: context.client })).toBe(false)
    expect(intelligentUiEnabledFor(context)).toBe(true)
    for (const extra of [{ client: 'mobile/2.13.1' }, { client: undefined }, { subAgentDepth: 1 }, { planMode: true }, { channelSession: true }, { visuals: 'off' as const }]) expect(intelligentUiEnabledFor({ ...context, ...extra })).toBe(false)
  })
  it('gives actionable errors before a malformed document can succeed', async () => {
    const tool = (await intelligentUiProvider.tools({} as any))[0]
    expect(await tool.execute({ document: '{' }, {} as any)).toMatch(/^Error:/)
    expect(await tool.execute({ document: '{}' }, {} as any)).toMatch(/version/)
  })
})

describe('live app cards', () => {
  const cards = [{ id: 'native:calendar', description: 'Agenda', acceptsQuery: false }, { id: 'plugin:bluebird:library-list', description: 'Bookmarks', acceptsQuery: true }]
  const ctx = { client: 'desktop/2.13.1', clientCapabilities: ['intelligent-ui.v1'], uiCards: cards } as any
  const doc = (cardId: string, query?: string) => ({ document: JSON.stringify({ version: 1, id: 'existing', title: 'Existing data', inputs: [], resources: [], blocks: [{ id: 'card', kind: 'app-card', cardId, ...(query ? { query } : {}) }] }) })
  it('discovers only advertised cards, not records, and validates card/query availability', async () => {
    const [render, list] = intelligentUiProvider.tools()
    expect(JSON.parse(await list.execute({}, ctx) as string).cards).toEqual(cards)
    expect(await render.execute(doc('native:calendar'), ctx)).toMatch(/^Intelligent UI rendered/)
    expect(await render.execute(doc('plugin:bluebird:library-list', 'physics'), ctx)).toMatch(/^Intelligent UI rendered/)
    expect(await render.execute(doc('native:calendar', 'physics'), ctx)).toMatch(/^Error:/)
    expect(await render.execute(doc('native:unknown'), ctx)).toMatch(/^Error:/)
    expect(await render.execute(doc('native:calendar'), { ...ctx, uiCards: [] })).toMatch(/^Error:/)
    expect(list.isEnabledFor?.({} as any, { ...ctx, uiCards: [] })).toBe(false)
  })
})

describe('文档 JSON 写成了正文', () => {
  const doc = '{"version":1,"id":"a","title":"A","inputs":[],"resources":[],"blocks":[{"id":"b","kind":"prose","markdown":"x"}]}'
  it('裸写在正文里(紧凑或带缩进)认得出', () => {
    expect(looksLikeLeakedUiDocument(`先说结论。\n\n${doc}**简短结论**`)).toBe(true)
    expect(looksLikeLeakedUiDocument(JSON.stringify(JSON.parse(doc), null, 2))).toBe(true)
  })
  it('前面有一份放在代码块里的,后面裸写的那份照样认得出', () => {
    expect(looksLikeLeakedUiDocument('```json\n' + doc + '\n```\n然后:\n' + doc)).toBe(true)
  })
  it('放在代码块里的、别的 JSON、普通文字都不算', () => {
    expect(looksLikeLeakedUiDocument('文档长这样:\n```json\n' + doc + '\n```\n就这些。')).toBe(false)
    expect(looksLikeLeakedUiDocument('~~~json\n' + doc + '\n~~~')).toBe(false)
    expect(looksLikeLeakedUiDocument('{"version":1,"name":"pkg"}')).toBe(false)
    expect(looksLikeLeakedUiDocument('{"version":3,"blocks":[]}')).toBe(false)
    expect(looksLikeLeakedUiDocument('好的。{"version":2,"id":"loan","title":"x","blocks":[')).toBe(true) // v2(计算层)写成正文同样要回灌
    expect(looksLikeLeakedUiDocument('version 1 的 blocks 是个数组')).toBe(false)
    expect(looksLikeLeakedUiDocument('')).toBe(false)
  })
})

describe('computed documents (intelligent-ui.v2)', () => {
  const gallery = JSON.parse(readFileSync(new URL('../../../desktop/scripts/fixtures/intelligent-ui-gallery.json', import.meta.url), 'utf8'))
  const v1 = { client: 'desktop/2.13.5', clientCapabilities: ['intelligent-ui.v1'] } as any
  const v2 = { ...v1, clientCapabilities: ['intelligent-ui.v1', 'intelligent-ui.v2'] }
  const [render] = intelligentUiProvider.tools()
  const [sketch] = sketchProvider.tools()
  it('accepts version 2 only from clients that render it', async () => {
    expect(computedUiEnabledFor(v1)).toBe(false)
    expect(computedUiEnabledFor(v2)).toBe(true)
    expect(computedUiEnabledFor({ ...v2, clientCapabilities: ['intelligent-ui.v2'] })).toBe(false)
    expect(await render.execute({ document: JSON.stringify(gallery.loan) }, v1)).toMatch(/^Error: .*version 1 only/)
    expect(await render.execute({ document: JSON.stringify(gallery.loan) }, v2)).toBe('Intelligent UI rendered: 房贷月供估算 (6 blocks).')
  })
  it('lists values that fail at the initial values next to a successful render', async () => {
    const doc = structuredClone(gallery.loan); doc.derived[3].expr = 'payment(r, 0, p)'
    const out = await render.execute({ document: JSON.stringify(doc) }, v2) as string
    expect(out).toMatch(/^Intelligent UI rendered/)
    expect(out).toContain('- derived pay: payment needs a positive number of periods')
  })
  it('routes calculators from sketch to intelligent_ui only for v2 clients', () => {
    const describe = (tool: typeof render, ctx: any) => (tool.definitionFor?.(ctx) ?? tool.definition).function.description
    expect(describe(render, v1)).toBe(render.definition.function.description)
    expect(describe(render, v2)).toContain('computed cards (calculators')
    expect(describe(sketch, v1)).toContain('small interactive widgets')
    expect(describe(sketch, v2)).toContain('calculators, step guides and other cards that only compute from inputs are intelligent_ui documents')
    expect(describe(sketch, v2)).not.toContain('small interactive widgets')
    expect(sketchTurnSignalFor('做一个房贷计算器，可以调利率', 'auto', true, true)?.section).toContain('computed `intelligent_ui` document')
    expect(sketchTurnSignalFor('做一个房贷计算器，可以调利率', 'auto', true, false)?.section).not.toContain('computed')
  })
})
