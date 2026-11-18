import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  events: new Map<string, (...args: any[]) => void>(),
  feeds: [] as any[],
  sent: [] as any[],
  download: [] as Array<() => Promise<void>>,
  reject: false,
  beta: false,
  current: '2.13.3',
  macSelf: { ok: false, reason: 'not-developer-id' },
  quitAndInstall: vi.fn(),
  native: new Map<string, Set<(...args: any[]) => void>>(),
  /** Squirrel.Mac 取包验签的结果:'update-downloaded' 成,'error' 验签没过 */
  squirrel: 'update-downloaded' as 'update-downloaded' | 'error',
  opened: [] as string[],
  /** 钉过去拉 yml 失败(例:这一版 GitHub 上没有 latest-mac.yml) */
  checkFails: false,
}))
const emitNative = (name: string, ...args: any[]) => { for (const cb of [...(updater.native.get(name) ?? [])]) cb(...args) }
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => updater.current, getPath: () => '/Applications/Forsion.app/Contents/MacOS/Forsion' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_c: string, s: any) => updater.sent.push(s) } }] },
  shell: { openExternal: async (url: string) => { updater.opened.push(url) } },
  // Squirrel.Mac(Electron 原生 autoUpdater)
  autoUpdater: {
    on: (name: string, cb: any) => { if (!updater.native.has(name)) updater.native.set(name, new Set()); updater.native.get(name)!.add(cb) },
    removeListener: (name: string, cb: any) => { updater.native.get(name)?.delete(cb) },
    checkForUpdates: () => { setTimeout(() => emitNative(updater.squirrel, ...(updater.squirrel === 'error' ? [new Error('Code signature did not pass validation')] : [])), 0) },
  },
}))
vi.mock('./macSelfUpdate', () => ({ probeMacSelfInstall: async () => updater.macSelf }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {
  isUpdateAvailable: async () => true,
  isUpdateSupported: async () => !updater.reject,
  isUserWithinRollout: async () => true,
  on: (name: string, cb: (...args: any[]) => void) => updater.events.set(name, cb),
  setFeedURL: (feed: any) => updater.feeds.push(feed),
  // 钉在哪个 tag / 官网记录上,就答哪个版本(和真的 generic / WebsiteUpdateProvider 一样)
  checkForUpdates: async () => {
    if (updater.checkFails) throw new Error('HttpError: 404 latest-mac.yml')
    const feed = updater.feeds.at(-1)
    const version = feed.provider === 'custom' ? feed.installer.version : /\/v([^/]+)$/.exec(feed.url)![1]
    if (updater.reject) return { isUpdateAvailable: false, updateInfo: { version } } // 例:minimumSystemVersion 高过本机
    updater.events.get('update-available')?.({ version, files: [{ size: 100 }] })
    return { isUpdateAvailable: true, updateInfo: { version } }
  },
  quitAndInstall: updater.quitAndInstall,
  downloadUpdate: () => (updater.download.shift() ?? (async () => updater.events.get('update-downloaded')!({ version: '2.13.4' })))(),
} } }))
vi.mock('./distribution', () => ({ BUNDLE_EXTEND: true }))
vi.mock('./websiteUpdateProvider', () => ({ WebsiteUpdateProvider: class {} }))
vi.mock('./forsionHome', () => ({ forsionHomeDir: () => '/nonexistent-forsion-updater-test' }))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: async () => JSON.stringify({ updater: { beta: updater.beta } }),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const answers = new Map<string, unknown>()
const json = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.resetModules()
  updater.events.clear(); updater.feeds.length = 0; updater.sent.length = 0; updater.download.length = 0; updater.reject = false; answers.clear()
  updater.beta = false; updater.current = '2.13.3'
  updater.macSelf = { ok: false, reason: 'not-developer-id' }; updater.quitAndInstall.mockClear(); updater.native.clear()
  updater.squirrel = 'update-downloaded'; updater.opened.length = 0; updater.checkFails = false
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

it('pins revision feed and UI identity without stripping its metadata', async () => {
  updater.current = '2.13.7+build.2'
  answers.set('/website/config', site({ version: '2.13.7+build.10' }))
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.7+build.10' })
  expect(updater.feeds[0].url).toMatch(/v2\.13\.7\+build\.10$/)
})

it.each(['website', 'github'])('stable channel rejects prereleases from %s, including incorrectly unflagged GitHub tags', async source => {
  if (source === 'website') answers.set('/website/config', site({ version: '2.14.0-beta.1' }))
  else answers.set('/releases/latest', { tag_name: 'v2.14.0-beta.1', prerelease: false })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'not-available' })
  expect(updater.feeds).toHaveLength(0)
})

it('beta opt-in selects highest eligible prerelease and can promote back to stable', async () => {
  updater.beta = true; updater.current = '2.13.8-beta.1'
  answers.set('/website/config', site({ version: '2.13.7+build.10' }))
  answers.set('/releases?per_page=', [
    { tag_name: 'v2.13.8-beta.2' }, { tag_name: 'v2.13.8-beta.10+build.2' },
    { tag_name: 'v2.13.9-rc.1', draft: true },
  ])
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.8-beta.10+build.2' })
  answers.set('/website/config', site({ version: '2.13.8' }))
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.8' })
})

it('turning beta off drops a downloaded prerelease so the next check offers stable instead of "restart to install"', async () => {
  updater.beta = true
  answers.set('/website/config', site({ version: '2.13.3' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.14.0-beta.1', prerelease: true }])
  updater.download.push(async () => updater.events.get('update-downloaded')!({ version: '2.14.0-beta.1' }))
  const { checkForUpdates, downloadUpdate, channelChanged } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.14.0-beta.1' })
  await downloadUpdate()
  updater.beta = false
  channelChanged(false)
  expect(await checkForUpdates()).toMatchObject({ phase: 'not-available' })
})

it('turning beta off keeps a downloaded stable release', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, channelChanged } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  channelChanged(false)
  expect(await checkForUpdates()).toMatchObject({ phase: 'downloaded', version: '2.13.4' })
})

it('names common local download failures with stable codes', async () => {
  const { downloadErrorCode } = await import('./updater')
  expect(downloadErrorCode(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('disk-full')
  expect(downloadErrorCode(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('no-permission')
  expect(downloadErrorCode(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe('file-busy')
  expect(downloadErrorCode(new Error('socket hang up'))).toBe('socket hang up')
})

it('a late "downloaded" event for a dropped prerelease is ignored (Codex review)', async () => {
  updater.beta = true
  answers.set('/website/config', site({ version: '2.13.3' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.14.0-beta.1', prerelease: true }])
  let finish!: () => void
  updater.download.push(() => new Promise<void>((resolve) => { finish = resolve }))
  const { checkForUpdates, downloadUpdate, channelChanged, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  const downloading = downloadUpdate()
  await new Promise((r) => setTimeout(r, 0))
  channelChanged(false)
  updater.events.get('update-downloaded')!({ version: '2.14.0-beta.1' }) // 取消没赶上收尾
  finish()
  await downloading
  expect(getUpdaterStatus()).toMatchObject({ phase: 'idle' })
})

// ── macOS:Developer ID 签名的包应用内自装,ad-hoc 旧包退回浏览器开 .dmg ────────────────────────────────
const mac = (macos: Record<string, unknown> = {}) => ({ platforms: { macos: { version: '2.13.4', filename: 'Forsion-2.13.4-arm64.dmg', size: 200, ...macos } } })
const onMac = () => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

it('ad-hoc mac: offers the .dmg in the browser and never pins electron-updater', async () => {
  onMac()
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, canInstallUpdate, openUpdateInstaller, installUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.4', source: 'website', size: 200, manualInstall: true })
  await downloadUpdate()
  expect(updater.feeds).toEqual([])
  expect(getUpdaterStatus().phase).toBe('available')
  expect(canInstallUpdate()).toBe(false)
  installUpdate()
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  expect(await openUpdateInstaller()).toBe(true)
  expect(updater.opened).toEqual(['https://forsion.net/api/website/download/macos'])
})

it('Developer ID mac: downloads the zip feed from GitHub (never the website dmg), stages Squirrel, then quits and installs', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac({ sha512: 'abc==' }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, canInstallUpdate, prepareInstall, installUpdate, openUpdateInstaller, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'github', manualInstall: false })
  expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://github.com/Changan-Su/Forsion/releases/download/v2.13.4' }])
  expect(await openUpdateInstaller()).toBe(false)
  await downloadUpdate()
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', version: '2.13.4' })
  expect(canInstallUpdate()).toBe(true)
  expect(await prepareInstall()).toBe(true)
  expect(updater.sent).toContainEqual(expect.objectContaining({ phase: 'downloaded', preparing: true }))
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', preparing: false })
  installUpdate()
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
})

it('Developer ID mac: a Squirrel signature rejection falls back to the .dmg before anything is shut down', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  updater.squirrel = 'error'
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, canInstallUpdate, prepareInstall, installUpdate, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  expect(await prepareInstall()).toBe(false)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', version: '2.13.4', source: 'github', manualInstall: true, selfInstallFailed: true })
  expect(updater.sent.some((s) => s.phase === 'error')).toBe(false)
  expect(canInstallUpdate()).toBe(false)
  installUpdate()
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  // 本次运行不再试自装:再检查也只给 .dmg
  updater.sent.length = 0
  const { channelChanged } = await import('./updater')
  channelChanged(false)
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', manualInstall: true })
})

it('Developer ID mac: a stalled GitHub download falls back to the website .dmg in mainland instead of a dead error', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', source: 'website', manualInstall: true, selfInstallFailed: true })
})

it('Developer ID mac: a release without latest-mac.yml on GitHub still offers the .dmg', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  updater.checkFails = true // GitHub 这一版只有 .dmg:generic 拉 latest-mac.yml 404
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'github', manualInstall: true })
})
