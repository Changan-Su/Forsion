/** 从商店重装一个停用状态下卸载的插件:要用它,打开;已经在表里的(升级)不动。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = { disabledIds: ['was-off', 'still-off'], enable: vi.fn() }
const fresh = vi.fn()
vi.mock('@amadeus/plugins/pluginStore', () => ({ usePluginStore: { getState: () => store } }))
vi.mock('./amadeusPlugins', () => ({ announceExtensionsChanged: vi.fn(), installAmadeusPlugins: vi.fn(), reloadPluginsAndAnnounce: () => fresh() }))
vi.mock('./stores/appStore', () => ({ useApp: { getState: () => ({}) } }))
vi.mock('./stores/themeStore', () => ({ useTheme: { getState: () => ({}) } }))
vi.mock('./userSpaces', () => ({ loadUserSpaces: vi.fn(async () => {}) }))

beforeEach(() => { store.enable.mockClear(); vi.stubGlobal('window', { amadeus: {} }) })

describe('afterMarketInstall', () => {
  it('新装上的若在停用名单里就打开,别的不碰', async () => {
    fresh.mockResolvedValue({ before: [], after: [{ id: 'was-off' }, { id: 'new-one' }], fresh: [{ id: 'was-off' }, { id: 'new-one' }] })
    const { afterMarketInstall } = await import('./marketPostInstall')
    await afterMarketInstall('amadeus-plugin', { id: 'was-off' }, false, () => {})
    expect(store.enable.mock.calls).toEqual([['was-off']])
  })

  it('升级(不是新装上的):用户关着就还关着', async () => {
    fresh.mockResolvedValue({ before: [{ id: 'still-off' }], after: [{ id: 'still-off' }], fresh: [] })
    const { afterMarketInstall } = await import('./marketPostInstall')
    await afterMarketInstall('amadeus-plugin', { id: 'still-off' }, true, () => {})
    expect(store.enable).not.toHaveBeenCalled()
  })
})
