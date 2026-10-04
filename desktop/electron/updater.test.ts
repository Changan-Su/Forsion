import { afterEach, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  events: new Map<string, (...args: any[]) => void>(),
  checkForUpdates: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {
  on: (name: string, cb: (...args: any[]) => void) => updater.events.set(name, cb),
  checkForUpdates: updater.checkForUpdates,
} } }))
vi.mock('./distribution', () => ({ BUNDLE_EXTEND: true }))
vi.mock('./noExtendUpdateProvider', () => ({ NoExtendUpdateProvider: class {} }))
vi.mock('./forsionHome', () => ({ forsionHomeDir: () => '/nonexistent-forsion-updater-test' }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

it('keeps the downloaded installer visible when a later check would fail', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const { checkForUpdates, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  updater.events.get('update-downloaded')!({ version: '3.0.0' })
  updater.checkForUpdates.mockRejectedValue(new Error('offline'))
  expect(await checkForUpdates()).toMatchObject({ phase: 'downloaded', version: '3.0.0' })
  expect(getUpdaterStatus().phase).toBe('downloaded')
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
})
