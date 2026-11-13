// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { usePluginStore } from './pluginStore'
import { uiAgentSettings } from './agentSettings'
import { buildCommandCatalog, runAgentCommand } from '../../agentCommands'
import { AGENT_SETTINGS_COMMAND } from '../../../../../tangu-agent/src/contracts/agentSettings'
import type { PluginContext } from './types'
const id = 'agent-settings-probe'
afterEach(() => { if (usePluginStore.getState().activeIds.includes(id)) usePluginStore.getState().toggle(id) })
it('exposes the live opt-in contract through the client command and revokes stale contexts', async () => {
  let ctx!: PluginContext
  let value = 'zh'
  const contribution = { fields: [{ key: 'language', type: 'string' as const, description: 'Preferred language' }], read: () => ({ language: value, private: 'hidden' }) }
  usePluginStore.getState().init([{ id, name: 'Probe', version: '1', setup: (c) => { ctx = c; c.registerAgentSettings!(contribution) } }])
  expect(buildCommandCatalog().some((c) => c.id === AGENT_SETTINGS_COMMAND)).toBe(true)
  const read = () => runAgentCommand(AGENT_SETTINGS_COMMAND, { pluginId: id })
  expect((await read()).result).toContain('"value":"zh"')
  value = 'en'
  expect((await read()).result).toContain('"value":"en"')
  expect((await read()).result).not.toContain('hidden')
  usePluginStore.getState().toggle(id)
  ctx.registerAgentSettings!(contribution)
  expect((await uiAgentSettings.read(id)).error).toBe('not_exposed')
})
