import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  events: new Map<string, (...args: any[]) => void>(),
  feeds: [] as any[],
  sent: [] as any[],
  download: [] as Array<() => Promise<void>>,
  reject: false,
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '2.13.3' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_c: string, s: any) => updater.sent.push(s) } }] },
  shell: { openExternal: vi.fn() },
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {
  on: (name: string, cb: (...args: any[]) => void) => updater.events.set(name, cb),
  setFeedURL: (feed: any) => updater.feeds.push(feed),
  // 钉在哪个 tag / 官网记录上,就答哪个版本(和真的 generic / WebsiteUpdateProvider 一样)
  checkForUpdates: async () => {
    const feed = updater.feeds.at(-1)
    const version = feed.provider === 'custom' ? feed.installer.version : /\/v([^/]+)$/.exec(feed.url)![1]
    if (updater.reject) return { isUpdateAvailable: false, updateInfo: { version } } // 例:minimumSystemVersion 高过本机
    updater.events.get('update-available')?.({ version, files: [{ size: 100 }] })
    return { isUpdateAvailable: true, updateInfo: { version } }
  },
  downloadUpdate: () => (updater.download.shift() ?? (async () => updater.events.get('update-downloaded')!({ version: '2.13.4' })))(),
} } }))
vi.mock('./distribution', () => ({ BUNDLE_EXTEND: true }))
vi.mock('./websiteUpdateProvider', () => ({ WebsiteUpdateProvider: class {} }))
vi.mock('./forsionHome', () => ({ forsionHomeDir: () => '/nonexistent-forsion-updater-test' }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const answers = new Map<string, unknown>()
const json = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.resetModules()
  updater.events.clear(); updater.feeds.length = 0; updater.sent.length = 0; updater.download.length = 0; updater.reject = false; answers.clear()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [k, v] of answers) if (url.includes(k)) return json(v)
    if (url.includes('raw.githubusercontent.com')) return { ok: false }
    throw new Error(`offline: ${url}`)
  }))
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllGlobals() })

const site = (windows: Record<string, unknown>) => ({ platforms: { windows: { filename: 'Forsion-2.13.4-x64.exe', size: 100, ...windows } } })

it('takes the version from the website even when GitHub has a newer one, and pins GitHub to that tag abroad', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases/latest', { tag_name: 'v2.14.0' })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.4', source: 'github' })
  expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://github.com/Changan-Su/Forsion/releases/download/v2.13.4' }])
})

it('reports nothing new when the website still has the installed version', async () => {
  answers.set('/website/config', site({ version: '2.13.3' }))
  answers.set('/releases/latest', { tag_name: 'v2.14.0' })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'not-available' })
  expect(updater.feeds).toEqual([])
})

it('falls back to GitHub only when the website does not answer', async () => {
  answers.set('/releases/latest', { tag_name: 'v2.13.5' })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.5', source: 'github' })
  answers.clear()
  expect(await checkForUpdates()).toMatchObject({ phase: 'error', error: 'unreachable' })
})

it('in mainland downloads from the website first and switches to GitHub once when it fails', async () => {
  answers.set('/website/config', site({ version: '2.13.4', sha512: 'abc==' }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website' })
  expect(updater.feeds[0]).toMatchObject({ provider: 'custom', downloadUrl: 'https://forsion.net/api/website/download/windows' })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  await downloadUpdate()
  expect(updater.feeds.at(-1)).toMatchObject({ provider: 'generic' })
  expect(updater.sent).toContainEqual(expect.objectContaining({ phase: 'downloading', source: 'github', fallbackFrom: 'website' }))
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'github' })
})

it('does not use the website for Windows when its record has no sha512', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'github' })
})

it('keeps the downloaded installer visible when a later check would fail', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  const { checkForUpdates, downloadUpdate } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  answers.clear()
  expect(await checkForUpdates()).toMatchObject({ phase: 'downloaded', version: '2.13.4' })
})

it('ends with nothing-new instead of hanging in checking when electron-updater rejects the pinned version', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  updater.reject = true
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'not-available' })
})

it('shares one in-flight check between overlapping callers', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  const { checkForUpdates } = await import('./updater')
  const [a, b] = [checkForUpdates(), checkForUpdates()]
  expect(a).toBe(b)
  await a
  expect(updater.feeds).toHaveLength(1)
})
