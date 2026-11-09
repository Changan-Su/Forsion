/** 从商店重装一个停用状态下卸载的插件:要用它,打开;已经在表里的(升级)不动。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = { disabledIds: ['was-off', 'still-off'], enable: vi.fn() }
const fresh = vi.fn()
vi.mock('@amadeus/plugins/pluginStore', () => ({ usePluginStore: { getState: () => store } }))
vi.mock('./amadeusPlugins', () => ({ announceExtensionsChanged: vi.fn(), installAmadeusPlugins: vi.fn(), reloadPluginsAndAnnounce: () => fresh() }))
vi.mock('./stores/appStore', () => ({ useApp: { getState: () => ({ onPluginInstalled: installed }) } }))
vi.mock('./stores/themeStore', () => ({ useTheme: { getState: () => ({}) } }))
vi.mock('./userSpaces', () => ({ loadUserSpaces: vi.fn(async () => {}) }))
const rescan = vi.fn(async () => ({}))
const installed = vi.fn(async () => false)
vi.mock('./services/backendService', () => ({ rescanPlugins: () => rescan() }))
vi.mock('./services/engine/targets', () => ({ homeTarget: () => 'home' }))

beforeEach(() => { store.enable.mockClear(); rescan.mockClear(); installed.mockClear(); vi.stubGlobal('window', { amadeus: {} }) })

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

  it('只带 Agent 的捆绑包升级后静默重扫引擎,让 Agent 技能跟上新包', async () => {
    const bb = { id: 'bluebird', bundle: { dir: 'item', enginePlugins: [], agents: ['bluebird'], skills: [], spaces: [] } }
    fresh.mockResolvedValue({ before: [bb], after: [bb], fresh: [] })
    const { afterMarketInstall } = await import('./marketPostInstall')
    const say = vi.fn()
    expect((await afterMarketInstall('amadeus-plugin', { id: 'bluebird' }, true, say)).restart).toBe(false)
    expect(rescan).toHaveBeenCalledTimes(1)
    expect(installed).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })

  it('带引擎插件的照旧走 onPluginInstalled(它自己重扫),不重复扫;重扫失败不拦安装', async () => {
    const eng = { id: 'cu', bundle: { dir: 'cu', enginePlugins: ['cu-engine'], agents: ['cu'], skills: [], spaces: [] } }
    fresh.mockResolvedValue({ before: [eng], after: [eng], fresh: [] })
    const { afterMarketInstall } = await import('./marketPostInstall')
    await afterMarketInstall('amadeus-plugin', { id: 'cu' }, true, () => {})
    expect(installed).toHaveBeenCalledTimes(1)
    expect(rescan).not.toHaveBeenCalled()
    const plain = { id: 'plain', bundle: undefined }
    fresh.mockResolvedValue({ before: [], after: [plain], fresh: [plain] })
    await afterMarketInstall('amadeus-plugin', { id: 'plain' }, false, () => {})
    expect(rescan).not.toHaveBeenCalled()
    const bb = { id: 'bluebird', bundle: { dir: 'item', enginePlugins: [], agents: ['bluebird'], skills: [], spaces: [] } }
    fresh.mockResolvedValue({ before: [], after: [bb], fresh: [bb] })
    rescan.mockRejectedValueOnce(new Error('engine down'))
    await expect(afterMarketInstall('amadeus-plugin', { id: 'bluebird' }, false, () => {})).resolves.toMatchObject({ restart: false })
  })
})
