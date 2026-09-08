// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'

describe('published Unit browser state', () => {
  it('keeps plugin credentials separate per Unit and never sends them to the host', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    sessionStorage.clear()
    const create = (id: string) => createUnitAmadeusBridge({ base: 'http://localhost/admin/', browserStorage: id,
      getToken: () => '', onAuthError: () => {} })
    try {
      const a = await create('unit-a')
      const b = await create('unit-b')
      await a.writePluginData!('server-admin', JSON.stringify({ token: 'visitor-token' }))
      expect(await (await create('unit-a')).readPluginData!('server-admin')).toContain('visitor-token')
      expect(await b.readPluginData!('server-admin')).toBeNull()
      expect(await a.restoreVault()).toBeNull()
      expect(await a.listPages()).toEqual([])
      await expect(a.readPage('private.md')).rejects.toThrow('does not publish a vault')
      expect(network).not.toHaveBeenCalled()
      sessionStorage.clear()
      expect(await a.readPluginData!('server-admin')).toBeNull()
    } finally { network.mockRestore() }
  })
})
