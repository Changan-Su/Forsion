import { afterEach, describe, expect, it } from 'vitest'
import { inventoryPayload } from './telemetryInventory'
import { setMarketIdsForTest, telemetryPluginEntry, telemetryPluginRef } from './telemetryPluginId'

const UUID = '7d3f0c52-6a41-4c8e-9f0b-2e5d8a1c4b67'
afterEach(() => setMarketIdsForTest(null))

describe('telemetryPluginEntry:插件清单的 source', () => {
  it('商店条目 = store(market-<UUID> 目录或更新器认领的老条目),内置 / 预装 = builtin,其余 local;ref 与原来一致', () => {
    setMarketIdsForTest([{ id: UUID, type: 'amadeus-plugin', slug: 'author-named' }])
    expect(telemetryPluginEntry({ id: 'author-named' })).toEqual({ pluginId: UUID, pluginOfficial: true, source: 'store' })
    expect(telemetryPluginEntry({ id: 'x', dir: `market-${UUID}` })).toEqual({ pluginId: UUID, pluginOfficial: true, source: 'store' })
    expect(telemetryPluginEntry({ id: 'forsion-calendar', builtin: true })).toEqual({ pluginId: 'forsion-calendar', pluginOfficial: true, source: 'builtin' })
    expect(telemetryPluginEntry({ id: 'my-sideload' })).toEqual({ pluginId: 'local', pluginOfficial: false, source: 'local' })
    expect(telemetryPluginEntry({ id: 'forsion-calendar', builtin: true, dev: true }).source).toBe('local')
    expect(telemetryPluginRef({ id: 'author-named' })).toEqual({ pluginId: UUID, pluginOfficial: true })
  })
})

describe('inventoryPayload', () => {
  it('公开的每个一条,本地的只数个数;没有引擎(null)只报 Forsion 插件', () => {
    const forsion = [
      { entry: telemetryPluginEntry({ id: 'forsion-extend', builtin: true }), enabled: true },
      { entry: telemetryPluginEntry({ id: 'x', dir: `market-${UUID}` }), enabled: false },
      { entry: telemetryPluginEntry({ id: 'my-sideload' }), enabled: true },
    ]
    const engine = [{ entry: telemetryPluginEntry({ id: 'local-engine' }, 'plugin'), enabled: true }]
    expect(inventoryPayload(forsion, engine)).toEqual({
      plugins: [
        { pluginId: 'forsion-extend', pluginOfficial: true, source: 'builtin', enabled: true },
        { pluginId: UUID, pluginOfficial: true, source: 'store', enabled: false },
      ],
      localCount: 2,
    })
    expect(inventoryPayload(forsion, null).localCount).toBe(1)
    expect(JSON.stringify(inventoryPayload(forsion, engine))).not.toContain('my-sideload')
  })
})
