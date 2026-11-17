/** 捆绑包卸载里内嵌引擎插件那半:带上捆绑包目录名让引擎核对;主进程没卸成要把设置接回去;留设置时不碰引擎。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { uninstall: [] as string[], restored: [] as string[] }
const main = vi.fn(async () => ({ trashId: 'desktop-1' }))
const api: { uninstallPlugin: (...a: unknown[]) => unknown; trashRestore?: () => unknown } = { uninstallPlugin: (...a: unknown[]) => main(...(a as [])) }
vi.mock('@amadeus/api', () => ({ amadeus: api }))
vi.mock('@amadeus/plugins/pluginStore', () => ({
  dropPluginPrefs: vi.fn(),
  pluginPrefs: (id: string) => (id === 'demo-suite' ? { 'plugin.demo-suite.k': 'old' } : id === 'market-x' ? { 'plugin.market-x.k': 'store' } : {}),
  pluginVaultFolder: (id: string) => (id === 'demo-suite' ? 'Plugins/demo-suite' : null),
}))
vi.mock('@amadeus/plugins/pluginDataSync', () => ({ dropPluginCloudData: vi.fn(), pluginDataSyncOn: () => false }))
vi.mock('../amadeusPlugins', () => ({ reloadPluginsAndAnnounce: vi.fn(async () => {}) }))
vi.mock('../userSpaces', () => ({ loadUserSpaces: vi.fn() }))
vi.mock('../services/engine/targets', () => ({ homeTarget: () => ({}) }))
const notes = vi.hoisted(() => ({ toast: [] as string[], receipts: [] as unknown[] }))
vi.mock('./PanelNotice', () => ({ panelToast: (text: string) => { notes.toast.push(text) } }))
vi.mock('./UninstallDialog', () => ({ notifyUninstalled: (...a: unknown[]) => { notes.receipts.push(a) } }))
vi.mock('../services/backendService', () => ({
  rescanPlugins: async () => ({ ok: true, reloadedIds: [] }),
  restoreTrashEntry: async (_t: unknown, id: string) => { calls.restored.push(id); return { ok: true } },
  uninstallPlugin: async (_t: unknown, id: string, opts: { bundle?: string }) => { calls.uninstall.push(`${id}@${opts.bundle}`); return id === 'no-settings' ? { ok: true } : { ok: true, trashId: `t-${id}` } },
}))

const plugin = { id: 'bundle', name: 'Bundle', bundle: { dir: 'bundle-dir', enginePlugins: ['mine', 'no-settings'] } } as never
const hooks = { engine: true }

beforeEach(() => {
  calls.uninstall = []; calls.restored = []
  main.mockClear(); main.mockImplementation(async () => ({ trashId: 'desktop-1' }))
  notes.toast = []; notes.receipts = []
  delete api.trashRestore
  vi.stubGlobal('window', { tangu: { marketForget: async () => ({ ok: true }) } })
})

describe('uninstallForsionPlugin 的内嵌引擎插件', () => {
  it('不留设置:逐个交给引擎并带上捆绑包目录名,有条目的 id 记进回收站', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    expect(await uninstallForsionPlugin(plugin, 'Bundle', { keepSettings: false, moveVault: false }, hooks)).toBe(true)
    expect(calls.uninstall).toEqual(['mine@bundle-dir', 'no-settings@bundle-dir'])
    expect(main).toHaveBeenCalledWith('bundle', expect.objectContaining({ engineTrash: ['t-mine'] }))
  })

  it('主进程没卸成(开发副本遮蔽等):设置接回去', async () => {
    main.mockRejectedValue(new Error('dev-shadowed: x'))
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    expect(await uninstallForsionPlugin(plugin, 'Bundle', { keepSettings: false, moveVault: false }, hooks)).toBe(false)
    expect(calls.restored).toEqual(['t-mine'])
  })

  it('留设置:不碰引擎那份', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    await uninstallForsionPlugin(plugin, 'Bundle', { keepSettings: true, moveVault: false }, hooks)
    expect(calls.uninstall).toEqual([])
    expect(main.mock.calls[0]).toEqual(['bundle', { keepSettings: true }])
  })
})

const store = { id: 'market-x', name: 'Demo', version: '0.5.0', supersedes: { id: 'demo-suite', dir: 'demo-suite', version: '0.1.0', name: 'Demo' } } as never

describe('商店版取代了旧副本(方案 B)', () => {
  it('⚠️卸载商店版缺省带走旧副本(withSuperseded),旧副本的偏好跟着「不留设置」一起摘', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    await uninstallForsionPlugin(store, 'Demo', { keepSettings: false, moveVault: false }, { engine: false })
    expect(main.mock.calls[0]).toEqual(['market-x', { keepSettings: false, prefs: { 'plugin.market-x.k': 'store', 'plugin.demo-suite.k': 'old' }, withSuperseded: true }])
  })

  it('勾了「保留旧副本」:不带 withSuperseded,旧副本的偏好不动', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    await uninstallForsionPlugin(store, 'Demo', { keepSettings: false, moveVault: false, keepOld: true }, { engine: false })
    expect(main.mock.calls[0]).toEqual(['market-x', { keepSettings: false, prefs: { 'plugin.market-x.k': 'store' } }])
  })

  it('没有旧副本的插件:卸载调用和以前一模一样', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    await uninstallForsionPlugin({ id: 'plain', name: 'Plain' } as never, 'Plain', { keepSettings: true, moveVault: false }, { engine: false })
    expect(main.mock.calls[0]).toEqual(['plain', { keepSettings: true }])
  })

  it('桌面清理旧副本:按旧副本的 id 进回收站(设置 / 工作文件夹按勾选),回执带撤销', async () => {
    api.trashRestore = () => ({})
    main.mockImplementation(async () => ({ trashId: 'old-1' }))
    const { cleanupSupersededCopy } = await import('./pluginUninstall')
    expect(await cleanupSupersededCopy(store, 'Demo', { keepSettings: false, moveVault: true })).toBe(true)
    expect(main.mock.calls[0]).toEqual(['demo-suite', { keepSettings: false, vaultFolder: 'Plugins/demo-suite', prefs: { 'plugin.demo-suite.k': 'old' } }])
    expect(notes.receipts).toEqual([['settings.amadeusPlugins.superseded.done', 'Demo', { id: 'old-1', kind: 'plugin', restorer: 'desktop' }]])
  })

  it('手机(没有回收站)清理旧副本:直接删,设置和工作文件夹都不碰', async () => {
    main.mockImplementation(async () => undefined as never)
    const { cleanupSupersededCopy } = await import('./pluginUninstall')
    expect(await cleanupSupersededCopy(store, 'Demo', { keepSettings: false, moveVault: true })).toBe(true)
    expect(main.mock.calls[0]).toEqual(['demo-suite', { keepSettings: true }])
    expect(notes.toast).toEqual(['settings.amadeusPlugins.superseded.doneMobile'])
  })

  it('清理失败:提示原因,不报成功', async () => {
    api.trashRestore = () => ({})
    main.mockRejectedValue(new Error('plugin-not-found'))
    const { cleanupSupersededCopy } = await import('./pluginUninstall')
    expect(await cleanupSupersededCopy(store, 'Demo', { keepSettings: true, moveVault: false })).toBe(false)
    expect(notes.receipts).toEqual([])
    expect(notes.toast).toHaveLength(1)
  })
})
