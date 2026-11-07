import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_ID_MAX, setMarketIdsForTest, telemetryCommandId, telemetryPluginRef } from './telemetryPluginId'

// 真实值(11-07):better-pdf 的商店条目 id、一个 market-<UUID> 新目录、内置插件 id。
const STORE_ID = 'c6ff39fc-e42e-4999-9b2c-23776defd853'
const NEW_DIR_UUID = '8f2a49a8-9de7-462d-864b-576c2bf1981d'
afterEach(() => setMarketIdsForTest(null))

describe('telemetryPluginRef', () => {
  it('作者自起名的老目录:更新器状态里认得 → 商店条目 id;认不得 → local', () => {
    setMarketIdsForTest([{ id: STORE_ID, type: 'amadeus-plugin', slug: 'better-pdf' }, { id: NEW_DIR_UUID, type: 'amadeus-plugin', slug: 'pdf-notes-old' }])
    expect(telemetryPluginRef({ id: 'better-pdf' })).toEqual({ pluginId: STORE_ID, pluginOfficial: true })
    // 清单 id 和安装目录名不同:按主进程扫出来的目录名认(不是 bundle 才有)
    expect(telemetryPluginRef({ id: 'pdf-notes', dir: 'pdf-notes-old' })).toEqual({ pluginId: NEW_DIR_UUID, pluginOfficial: true })
    expect(telemetryPluginRef({ id: 'pdf-notes' })).toEqual({ pluginId: 'local', pluginOfficial: false })
    expect(telemetryPluginRef({ id: 'better-pdf' }, 'plugin')).toEqual({ pluginId: 'local', pluginOfficial: false }) // 类型不同不串
    expect(telemetryPluginRef({ id: 'my-private-tool' })).toEqual({ pluginId: 'local', pluginOfficial: false })
  })
  it('market-<UUID> 目录 → 裸 UUID;内置 / 预装 → 插件 id;开发副本一律 local', () => {
    expect(telemetryPluginRef({ id: 'whatever', bundle: { dir: `market-${NEW_DIR_UUID}` } })).toEqual({ pluginId: NEW_DIR_UUID, pluginOfficial: true })
    expect(telemetryPluginRef({ id: `market-${NEW_DIR_UUID}` })).toEqual({ pluginId: NEW_DIR_UUID, pluginOfficial: true })
    expect(telemetryPluginRef({ id: 'forsion-calendar', builtin: true })).toEqual({ pluginId: 'forsion-calendar', pluginOfficial: true })
    expect(telemetryPluginRef({ id: 'tangu-computer-use', preinstalled: true })).toEqual({ pluginId: 'tangu-computer-use', pluginOfficial: true })
    expect(telemetryPluginRef({ id: 'forsion-calendar', builtin: true, dev: true })).toEqual({ pluginId: 'local', pluginOfficial: false })
    expect(telemetryPluginRef(undefined)).toEqual({ pluginId: 'local', pluginOfficial: false })
  })
})

describe('telemetryCommandId(格式:amadeus:<裸 UUID 或内置 id>:<命令>,超 80 或命令名不合规 → amadeus:<id>:other)', () => {
  const plugins: Record<string, { id: string; builtin?: boolean; bundle?: { dir: string } }> = {
    'forsion-calendar': { id: 'forsion-calendar', builtin: true },
    'pdf-reader': { id: 'pdf-reader', bundle: { dir: `market-${NEW_DIR_UUID}` } },
    'side-loaded': { id: 'side-loaded' },
  }
  const of = (id: string) => plugins[id]
  it('宿主自己的命令原样', () => {
    expect(telemetryCommandId('open-settings', of)).toBe('open-settings')
    expect(telemetryCommandId('tangu:new-chat', of)).toBe('tangu:new-chat')
  })
  it('商店插件换成裸 UUID(绝不带 market- 前缀),内置插件用插件 id,侧载 → plugin:local', () => {
    expect(telemetryCommandId('amadeus:pdf-reader:open-reader', of)).toBe(`amadeus:${NEW_DIR_UUID}:open-reader`)
    expect(telemetryCommandId('amadeus:pdf-reader:open-reader', of)).not.toContain('market-')
    expect(telemetryCommandId('amadeus:forsion-calendar:new-event', of)).toBe('amadeus:forsion-calendar:new-event')
    expect(telemetryCommandId('amadeus:side-loaded:anything', of)).toBe('plugin:local')
    expect(telemetryCommandId('amadeus:unknown:x', of)).toBe('plugin:local')
  })
  it('命令名空着 / 缺段:侧载的照样 plugin:local(绝不原样放过去),公开的记 other', () => {
    expect(telemetryCommandId('amadeus:side-loaded:', of)).toBe('plugin:local')
    expect(telemetryCommandId('amadeus:side-loaded', of)).toBe('plugin:local')
    expect(telemetryCommandId('amadeus:', of)).toBe('plugin:local')
    expect(telemetryCommandId('amadeus:forsion-calendar:', of)).toBe('amadeus:forsion-calendar:other')
    expect(telemetryCommandId('amadeus:forsion-calendar', of)).toBe('amadeus:forsion-calendar:other')
  })
  it('切视图模式的命令:值由视图 / 插件起名 → 收成 view-mode:pick', () => {
    expect(telemetryCommandId('view-mode:my-private-mode', of)).toBe('view-mode:pick')
    expect(telemetryCommandId('view-mode-next', of)).toBe('view-mode-next')
  })
  it('拼起来超 80 字符或命令名不合规 → 命令名记 other', () => {
    const long = `amadeus:pdf-reader:${'a'.repeat(50)}`
    expect(telemetryCommandId(long, of)).toBe(`amadeus:${NEW_DIR_UUID}:other`)
    expect(telemetryCommandId('amadeus:forsion-calendar:has space', of)).toBe('amadeus:forsion-calendar:other')
    expect(telemetryCommandId('amadeus:forsion-calendar:sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd', of)).toBe('amadeus:forsion-calendar:other')
    expect(telemetryCommandId(`amadeus:forsion-calendar:${'0123456789abcdef'.repeat(2)}`, of)).toBe('amadeus:forsion-calendar:other')
    for (const id of [long, 'amadeus:pdf-reader:open-reader']) expect(telemetryCommandId(id, of).length).toBeLessThanOrEqual(COMMAND_ID_MAX)
  })
})

describe('countTelemetryOnce(引擎事件派生的计数:带事件 id 交给主进程去重)', () => {
  it('每次都发,带上 once;去重在主进程(见 telemetryHost.test)', async () => {
    const { countTelemetryOnce } = await import('./telemetrySend')
    const sent: unknown[] = []
    const g = globalThis as Record<string, unknown>
    const prev = g.window
    g.window = { tangu: { telemetryReport: (kind: string, props: unknown) => sent.push([kind, props]) } }
    try {
      countTelemetryOnce('achImageGenerate', 'call_1')
      countTelemetryOnce('achImageGenerate', 'call_1')
      expect(sent).toEqual([['count', { key: 'achImageGenerate', once: 'call_1' }], ['count', { key: 'achImageGenerate', once: 'call_1' }]])
    } finally { g.window = prev }
  })
})
