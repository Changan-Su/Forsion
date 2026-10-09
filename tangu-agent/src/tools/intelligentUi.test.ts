import { describe, it, expect } from 'vitest'
import { intelligentUiEnabledFor, intelligentUiProvider } from './builtin/intelligentUi.js'
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
