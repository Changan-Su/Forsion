import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mock = vi.hoisted(() => ({
  dir: '', handlers: new Map<string, (...args: any[]) => any>(), listeners: new Map<string, (...args: any[]) => any>(),
  dock: vi.fn(), windowIcon: vi.fn(), send: vi.fn(),
  animation: vi.fn(() => ({ prefersReducedMotion: false })),
}))
vi.mock('electron', () => ({
  app: { getPath: () => mock.dir, isPackaged: false, dock: { setIcon: mock.dock }, on: (key: string, cb: any) => mock.listeners.set(key, cb) },
  ipcMain: { on: (key: string, cb: any) => mock.listeners.set(key, cb), handle: (key: string, cb: any) => mock.handlers.set(key, cb) },
  systemPreferences: { getAnimationSettings: mock.animation },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setIcon: mock.windowIcon, webContents: { send: mock.send } }] },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false, tag: 'default' }),
    createFromDataURL: (url: string) => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), tag: url, toBitmap: () => Object.assign(Buffer.from([255, 255, 255, 255]), { tag: url }) }),
    createFromBitmap: (bitmap: Buffer & { tag: string }) => ({ isEmpty: () => false, tag: bitmap.tag }),
  },
}))
import { registerStartupAppearance } from './startupAppearance'
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const asset = { id: 'plugin:probe:one', label: 'Probe', pluginId: 'probe', image: png }
const platform = process.platform
beforeEach(async () => {
  mock.dir = await mkdtemp(join(tmpdir(), 'appearance-test-'))
  mock.handlers.clear(); mock.listeners.clear(); vi.clearAllMocks()
})
afterEach(async () => { Object.defineProperty(process, 'platform', { value: platform }); await rm(mock.dir, { recursive: true, force: true }) })
const update = (patch: unknown, owner?: string) => mock.handlers.get('appearance:update')!({ trusted: true }, patch, owner)
const initial = () => { const event = { returnValue: undefined }; mock.listeners.get('appearance:initial')!(event); return event.returnValue as any }
describe('desktop appearance persistence and OS icon', () => {
  it('reads current native reduced motion independently of saved artwork preferences', async () => {
    await registerStartupAppearance(() => true)
    const event = { returnValue: undefined as unknown }
    mock.animation.mockReturnValueOnce({ prefersReducedMotion: true })
    mock.listeners.get('appearance:reducedMotion')!(event)
    expect(event.returnValue).toBe(true)
    mock.listeners.get('appearance:reducedMotion')!(event)
    expect(event.returnValue).toBe(false)
    expect(initial()).not.toHaveProperty('prefersReducedMotion')
  })
  it('serializes concurrent patches, persists across launches and resets the macOS Dock', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await registerStartupAppearance((event: any) => event.trusted)
    await Promise.all([update({ icon: asset }), update({ animation: 'spin' })])
    expect(initial()).toMatchObject({ icon: asset, animation: 'spin' })
    expect(mock.dock).toHaveBeenLastCalledWith(expect.objectContaining({ tag: png }))
    expect(JSON.parse(await readFile(join(mock.dir, 'startup-appearance.json'), 'utf8'))).toMatchObject({ icon: asset, animation: 'spin' })
    await registerStartupAppearance(() => true)
    expect(initial().icon).toEqual(asset)
    await update({}, 'different-plugin')
    expect(initial().icon).toEqual(asset)
    await update({}, 'probe')
    expect(initial().icon).toBeNull()
    expect(mock.dock).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 'default' }))
  })
  it('sets existing and future Windows window icons and rejects untrusted or malformed writes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await registerStartupAppearance((event: any) => event.trusted)
    expect(() => mock.handlers.get('appearance:update')!({}, { showSplash: false })).toThrow('Untrusted')
    await expect(update({ icon: { ...asset, image: 'data:image/png;base64,aGVsbG8=' } })).rejects.toThrow('Invalid native icon')
    expect(initial().icon).toBeNull()
    await update({ icon: asset })
    expect(mock.windowIcon).toHaveBeenLastCalledWith(expect.objectContaining({ tag: png }))
    const setIcon = vi.fn()
    mock.listeners.get('browser-window-created')!({}, { setIcon })
    expect(setIcon).toHaveBeenCalledWith(expect.objectContaining({ tag: png }))
    await update({ nativeIcon: false })
    expect(mock.windowIcon).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 'default' }))
    expect(mock.dock).not.toHaveBeenCalled()
  })
  it('recovers a damaged startup file without blocking application startup', async () => {
    await writeFile(join(mock.dir, 'startup-appearance.json'), '{bad')
    await registerStartupAppearance(() => true)
    expect(initial().icon).toBeNull()
  })
})
