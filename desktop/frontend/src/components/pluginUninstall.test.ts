/** 捆绑包卸载里内嵌引擎插件那半:只收捆绑包自己管的;主进程没卸成要把设置接回去;留设置时不碰引擎。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { uninstall: [] as string[], restored: [] as string[] }
const main = vi.fn(async () => ({ trashId: 'desktop-1' }))
vi.mock('@amadeus/api', () => ({ amadeus: { uninstallPlugin: (...a: unknown[]) => main(...(a as [])) } }))
vi.mock('@amadeus/plugins/pluginStore', () => ({ dropPluginPrefs: vi.fn(), pluginPrefs: () => ({}), pluginVaultFolder: () => null }))
vi.mock('@amadeus/plugins/pluginDataSync', () => ({ dropPluginCloudData: vi.fn(), pluginDataSyncOn: () => false }))
vi.mock('../amadeusPlugins', () => ({ reloadPluginsAndAnnounce: vi.fn(async () => {}) }))
vi.mock('../userSpaces', () => ({ loadUserSpaces: vi.fn() }))
vi.mock('../services/engine/targets', () => ({ homeTarget: () => ({}) }))
vi.mock('./PanelNotice', () => ({ panelToast: vi.fn() }))
vi.mock('./UninstallDialog', () => ({ notifyUninstalled: vi.fn() }))
vi.mock('../services/backendService', () => ({
  listPlugins: async () => [{ id: 'mine', source: 'folder' }, { id: 'user-copy', source: 'folder' }, { id: 'first-party', source: 'builtin' }, { id: 'unrelated', source: 'folder' }],
  rescanPlugins: async () => ({ ok: true, reloadedIds: [] }),
  restoreTrashEntry: async (_t: unknown, id: string) => { calls.restored.push(id); return { ok: true } },
  uninstallPlugin: async (_t: unknown, id: string) => { calls.uninstall.push(id); return { ok: true, trashId: `t-${id}` } },
}))

const plugin = { id: 'bundle', name: 'Bundle', bundle: { enginePlugins: ['mine', 'user-copy', 'first-party'] } } as never
const hooks = { engine: true }

beforeEach(() => {
  calls.uninstall = []; calls.restored = []
  main.mockClear(); main.mockImplementation(async () => ({ trashId: 'desktop-1' }))
  vi.stubGlobal('window', { tangu: { pluginsUserInstalled: async () => [{ id: 'user-copy', slug: 'user-copy' }], marketForget: async () => ({ ok: true }) } })
})

describe('uninstallForsionPlugin 的内嵌引擎插件', () => {
  it('不留设置:只收捆绑包管的那个,条目 id 记进回收站', async () => {
    const { uninstallForsionPlugin } = await import('./pluginUninstall')
    expect(await uninstallForsionPlugin(plugin, 'Bundle', { keepSettings: false, moveVault: false }, hooks)).toBe(true)
    expect(calls.uninstall).toEqual(['mine'])
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
