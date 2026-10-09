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
