import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NsisUpdater } from 'electron-updater'
import { Provider } from 'electron-updater/out/providers/Provider'
import type { UpdateInfo } from 'builder-util-runtime'
import { checkRevisionUpdate } from './revisionUpdateCheck'

// Real electron-updater, with only its app adapter / provider replaced. No Electron, network, downloads or real user data.
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(current = '2.13.7', target = '2.13.7+build.1') {
  const dir = await mkdtemp(join(tmpdir(), 'revision-update-')); roots.push(dir)
  const info: { -readonly [K in keyof UpdateInfo]: UpdateInfo[K] } = { version: target, files: [], path: 'unused.exe', sha512: '', releaseDate: '2026-10-22' }
  class MemoryProvider extends Provider<UpdateInfo> {
    constructor(_options: unknown, _updater: unknown, runtime: any) { super(runtime) }
    async getLatestVersion() { return info }
    resolveFiles() { return [] }
  }
  const updater = new NsisUpdater(null, {
    version: current, name: 'Revision test', isPackaged: true,
    userDataPath: dir, baseCachePath: dir, appUpdateConfigPath: join(dir, 'unused.yml'),
    whenReady: async () => {}, relaunch() {}, quit() {}, onQuit() {},
  })
  updater.logger = null
  updater.autoDownload = false
  updater.setFeedURL({ provider: 'custom', updateProvider: MemoryProvider })
  const support = vi.fn(async () => true), rollout = vi.fn(async () => true)
  updater.isUpdateSupported = support
  updater.isUserWithinRollout = rollout
  return { updater, support, rollout, info }
}

it('makes a real updater recognize a revision that stock SemVer treats as equal, then restores it', async () => {
  const { updater, support, rollout } = await fixture()
  expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(false)
  const internal = updater as any, original = internal.isUpdateAvailable
  const result = await checkRevisionUpdate(updater, '2.13.7', '2.13.7+build.1')
  expect(result).toMatchObject({ isUpdateAvailable: true, updateInfo: { version: '2.13.7+build.1' } })
  expect(support).toHaveBeenCalledOnce(); expect(rollout).toHaveBeenCalledOnce()
  expect(internal.isUpdateAvailable).toBe(original)
})

it.each(['support', 'rollout'] as const)('retains the real updater %s veto', async guard => {
  const f = await fixture('2.13.7+build.1', '2.13.7+build.2')
  f[guard].mockResolvedValue(false)
  expect((await checkRevisionUpdate(f.updater, '2.13.7+build.1', '2.13.7+build.2'))?.isUpdateAvailable).toBe(false)
})

it('keeps the built-in OS minimum check on revision upgrades', async () => {
  const f = await fixture()
  const { AppUpdater } = await import('electron-updater')
  // Use a fresh updater's default public support function, rather than the fixture stub.
  const defaultUpdater = new NsisUpdater(null, (f.updater as any).app)
  defaultUpdater.logger = null
  expect(defaultUpdater).toBeInstanceOf(AppUpdater)
  f.updater.isUpdateSupported = defaultUpdater.isUpdateSupported
  f.info.minimumSystemVersion = '9999.0.0'
  expect((await checkRevisionUpdate(f.updater, '2.13.7', f.info.version))?.isUpdateAvailable).toBe(false)
})

it('does not grant the revision exception to a different manifest and restores on errors', async () => {
  const f = await fixture('2.13.7', '2.13.7+build.0')
  const original = (f.updater as any).isUpdateAvailable
  expect((await checkRevisionUpdate(f.updater, '2.13.7', '2.13.7+build.1'))?.isUpdateAvailable).toBe(false)
  f.info.version = '2.13.7+build.1'
  f.support.mockRejectedValue(new Error('support failed'))
  await expect(checkRevisionUpdate(f.updater, '2.13.7', f.info.version)).rejects.toThrow('support failed')
  expect((f.updater as any).isUpdateAvailable).toBe(original)
})

it('uses normal checks for promotion to stable and never downgrades a revision', async () => {
  const pre = await fixture('2.13.8-rc.1', '2.13.8')
  expect((await checkRevisionUpdate(pre.updater, '2.13.8-rc.1', '2.13.8'))?.isUpdateAvailable).toBe(true)
  const older = await fixture('2.13.7+build.10', '2.13.7+build.2')
  expect((await checkRevisionUpdate(older.updater, '2.13.7+build.10', '2.13.7+build.2'))?.isUpdateAvailable).toBe(false)
})
