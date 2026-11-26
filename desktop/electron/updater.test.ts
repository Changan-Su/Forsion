import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  events: new Map<string, (...args: any[]) => void>(),
  feeds: [] as any[],
  sent: [] as any[],
  download: [] as Array<(token?: any) => Promise<void>>,
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
  relaunched: 0,
  sourcePref: 'auto',
  /** 每次钉源时 disableDifferentialDownload 设成了什么 */
  noDiff: [] as boolean[],
}))
const emitNative = (name: string, ...args: any[]) => { for (const cb of [...(updater.native.get(name) ?? [])]) cb(...args) }
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => updater.current, getPath: () => '/Applications/Forsion.app/Contents/MacOS/Forsion', relaunch: () => { updater.relaunched++ }, exit: () => {} },
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
  set disableDifferentialDownload(v: boolean) { updater.noDiff.push(v) },
  get disableDifferentialDownload() { return updater.noDiff.at(-1) ?? false },
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
  downloadUpdate: (token: any) => (updater.download.shift() ?? (async () => updater.events.get('update-downloaded')!({ version: '2.13.4' })))(token),
} } }))
vi.mock('./distribution', () => ({ BUNDLE_EXTEND: true }))
vi.mock('./websiteUpdateProvider', () => ({ WebsiteUpdateProvider: class {} }))
vi.mock('./forsionHome', () => ({ forsionHomeDir: () => '/nonexistent-forsion-updater-test' }))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: async () => JSON.stringify({ updater: { beta: updater.beta, source: updater.sourcePref } }),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const answers = new Map<string, unknown>()
const json = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.resetModules()
  updater.events.clear(); updater.feeds.length = 0; updater.sent.length = 0; updater.download.length = 0; updater.reject = false; answers.clear()
  updater.beta = false; updater.current = '2.13.3'
  updater.macSelf = { ok: false, reason: 'not-developer-id' }; updater.quitAndInstall.mockClear(); updater.native.clear()
  updater.squirrel = 'update-downloaded'; updater.opened.length = 0; updater.checkFails = false; updater.relaunched = 0; updater.sourcePref = 'auto'
  updater.noDiff.length = 0
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
  expect(updater.feeds[0]).toMatchObject({ provider: 'custom', downloadUrl: 'https://forsion.net/api/website/download/windows', differential: false })
  expect(updater.noDiff).toEqual([true]) // 这条官网记录没有 blockmap(老 server):整包
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  await downloadUpdate()
  expect(updater.feeds.at(-1)).toMatchObject({ provider: 'generic' })
  expect(updater.noDiff.at(-1)).toBe(false) // GitHub 照旧差量
  expect(updater.sent).toContainEqual(expect.objectContaining({ phase: 'downloading', source: 'github', fallbackFrom: 'website' }))
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'github' })
})

it('in mainland a website record with a blockmap downloads from the versioned address with differential download on', async () => {
  answers.set('/website/config', site({ version: '2.13.4', sha512: 'abc==', blockmap: true }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website' })
  expect(updater.feeds[0]).toMatchObject({
    provider: 'custom', differential: true,
    downloadUrl: 'https://forsion.net/api/website/download/windows/2.13.4/Forsion-2.13.4-x64.exe',
  })
  expect(updater.noDiff).toEqual([false])
  await downloadUpdate()
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'website' })
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

it('Developer ID mac abroad: downloads the zip feed from GitHub, stages Squirrel, then quits and installs', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac({ sha512: 'abc==' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
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

it.each([
  ['mainland', { country: 'CN', mainland_china: true }, 'auto'],
  ['unknown region', undefined, 'auto'],
  ['website chosen abroad', { country: 'GB', mainland_china: false }, 'website'],
])('Developer ID mac, %s: follows the website, which only has the .dmg, and never detours to GitHub', async (_name, region, source) => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  updater.sourcePref = source
  answers.set('/website/config', mac({ sha512: 'abc==' }))
  if (region) answers.set('/auth/region', region)
  const { checkForUpdates, downloadUpdate, openUpdateInstaller } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website', size: 200, manualInstall: true })
  expect(updater.feeds).toEqual([])
  await downloadUpdate()
  expect(updater.feeds).toEqual([])
  expect(await openUpdateInstaller()).toBe(true)
  expect(updater.opened).toEqual(['https://forsion.net/api/website/download/macos'])
})

it('Developer ID mac abroad: a stalled GitHub download falls back to the .dmg instead of a dead error', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', source: 'github', manualInstall: true, selfInstallFailed: true })
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

it('Developer ID mac: install-time recheck refuses a bundle that became read-only, and a beta toggle cannot drop a staged install', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, prepareInstall, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  updater.macSelf = { ok: false, reason: 'read-only' }
  expect(await prepareInstall()).toBe(false)
  expect(updater.native.get('update-downloaded')?.size ?? 0).toBe(0) // Squirrel 根本没被叫起来
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', manualInstall: true, selfInstallFailed: true })
})

it('Developer ID mac: a staged beta survives turning beta off, and a Squirrel error after quitAndInstall relaunches instead of leaving a windowless app', async () => {
  onMac()
  updater.beta = true
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac({ version: '2.13.3' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.14.0-beta.1', prerelease: true }])
  updater.download.push(async () => updater.events.get('update-downloaded')!({ version: '2.14.0-beta.1' }))
  const { checkForUpdates, downloadUpdate, prepareInstall, channelChanged, installUpdate, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate()
  const staging = prepareInstall()
  channelChanged(false) // 准备中关测试版:不作废
  expect(await staging).toBe(true)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', version: '2.14.0-beta.1' })
  installUpdate()
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  emitNative('error', new Error('ShipItState.plist could not be written'))
  expect(updater.relaunched).toBe(1)
})

// 官网收了 mac 自动更新用的 zip(server 的 `macos-update`)之后:大陆的 mac 也和 Windows 一样从官网应用内更新
const macWithZip = (zip: Record<string, unknown> = {}) => ({ platforms: {
  macos: { version: '2.13.4', filename: 'Forsion-2.13.4-arm64.dmg', size: 200 },
  'macos-update': { version: '2.13.4', filename: 'Forsion-2.13.4-arm64.zip', size: 210, sha512: 'zip==', ...zip },
} })

it('Developer ID mac in mainland: downloads the website zip in-app, and can still switch to GitHub', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', macWithZip())
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website', manualInstall: false })
  expect(updater.feeds[0]).toMatchObject({ provider: 'custom', downloadUrl: 'https://forsion.net/api/website/download/macos-update', installer: { filename: 'Forsion-2.13.4-arm64.zip', sha512: 'zip==' } })
  expect(updater.noDiff).toEqual([true])
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  await downloadUpdate()
  expect(updater.feeds.at(-1)).toMatchObject({ provider: 'generic' })
  expect(updater.sent).toContainEqual(expect.objectContaining({ phase: 'downloading', source: 'github', fallbackFrom: 'website' }))
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'github' })
})

it.each([
  ['a differential website download (blockmaps first, no progress yet) gets 90 seconds', true, 'CN', 60_000, 100_000, 'generic'],
  ['a full website download is still called stalled after 30 seconds without progress', false, 'CN', 25_000, 40_000, 'generic'],
  ['a GitHub download (differential too) keeps the 30-second watchdog', true, 'GB', 25_000, 40_000, 'custom'],
])('stall watchdog: %s', async (_name, blockmap, country, alive, dead, switchedTo) => {
  answers.set('/website/config', site({ version: '2.13.4', sha512: 'abc==', ...(blockmap ? { blockmap: true } : {}) }))
  answers.set('/auth/region', { country, mainland_china: country === 'CN' })
  const { checkForUpdates, downloadUpdate } = await import('./updater')
  await checkForUpdates()
  vi.useFakeTimers()
  try {
    let token: any
    updater.download.push((t) => new Promise((_ok, fail) => { token = t; t.onCancel(() => fail(new Error('cancelled'))) }))
    const pending = downloadUpdate()
    await vi.advanceTimersByTimeAsync(alive)
    expect(token.cancelled).toBe(false)
    await vi.advanceTimersByTimeAsync(dead - alive)
    expect(token.cancelled).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(updater.feeds.at(-1)).toMatchObject({ provider: switchedTo }) // 下不动就换另一边,和原来一样
  } finally { vi.useRealTimers() }
})

it('Developer ID mac in mainland: a website zip with a blockmap is fetched from the versioned address with differential download on', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', macWithZip({ blockmap: true }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website', manualInstall: false })
  expect(updater.feeds[0]).toMatchObject({ downloadUrl: 'https://forsion.net/api/website/download/macos-update/2.13.4/Forsion-2.13.4-arm64.zip', differential: true })
  expect(updater.noDiff).toEqual([false])
})

it.each([
  ['a different version (dmg rolled back or zip not imported yet)', { version: '2.13.5' }],
  ['no sha512', { sha512: undefined }],
  ['a NoExtend file', { filename: 'Forsion-NoExtend-2.13.4-arm64.zip' }],
  ['not a zip', { filename: 'Forsion-2.13.4-arm64.dmg' }],
])('Developer ID mac in mainland: a website update record with %s is not used, the website .dmg is offered instead', async (_name, zip) => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', macWithZip(zip))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website', manualInstall: true })
  expect(updater.feeds).toEqual([])
})

it('Windows never picks the mac update record', async () => {
  answers.set('/website/config', { platforms: { ...macWithZip().platforms, windows: { version: '2.13.4', filename: 'Forsion-2.13.4-x64.exe', size: 100, sha512: 'exe==' } } })
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates } = await import('./updater')
  await checkForUpdates()
  expect(updater.feeds[0]).toMatchObject({ provider: 'custom', downloadUrl: 'https://forsion.net/api/website/download/windows', installer: { sha512: 'exe==' } })
})

// ── 后台自动下载:只给 GitHub 源(海外 / 测试版);官网源走 OSS 计费,照旧等用户点 ──────────────────────────
it('GitHub source is marked for background download, and the auto download finishes like a manual one', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'github', autoDownload: true })
  await downloadUpdate({ auto: true, version: '2.13.4' })
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', version: '2.13.4', source: 'github' })
})

it('website source is never downloaded automatically', async () => {
  answers.set('/website/config', site({ version: '2.13.4', sha512: 'abc==' }))
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', source: 'website', autoDownload: false })
  let started = 0
  updater.download.push(async () => { started++ })
  await downloadUpdate({ auto: true, version: '2.13.4' })
  expect(started).toBe(0)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', source: 'website' })
})

it('a failed background download never falls back to the website: it quietly waits for the user, whose click still can', async () => {
  answers.set('/website/config', site({ version: '2.13.4', sha512: 'abc==' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ source: 'github', autoDownload: true })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  await downloadUpdate({ auto: true, version: '2.13.4' })
  expect(updater.feeds).toHaveLength(1) // 没钉去官网
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', source: 'github', autoDownload: false })
  expect(updater.sent.some((s) => s.phase === 'error')).toBe(false)
  await downloadUpdate({ auto: true, version: '2.13.4' }) // 清掉 autoDownload 之后不再自己重试
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available' })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  await downloadUpdate() // 用户点的:照旧换官网
  expect(updater.feeds.at(-1)).toMatchObject({ provider: 'custom' })
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'website' })
  // 下一轮定时检查见到 downloaded 原样返回,不会再标自动下载
  expect(await checkForUpdates()).toMatchObject({ phase: 'downloaded' })
})

it('Developer ID mac abroad: a failed background download does not give up on in-app install', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  answers.set('/website/config', mac())
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  updater.download.push(async () => { throw new Error('ECONNRESET') })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ source: 'github', manualInstall: false, autoDownload: true })
  await downloadUpdate({ auto: true, version: '2.13.4' })
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', manualInstall: false, autoDownload: false })
  expect(getUpdaterStatus().selfInstallFailed).toBeUndefined()
  await downloadUpdate() // 用户点的:默认那份下载成功
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded' })
})

it('the background download only takes the version the main window checked, and never a prerelease once beta is off', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  let started = 0
  updater.download.push(async () => { started++ })
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  await checkForUpdates()
  await downloadUpdate({ auto: true, version: '2.13.5' }) // 主窗查跳过时看的是另一版
  await downloadUpdate({ auto: true })
  expect(started).toBe(0)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available', version: '2.13.4' })
})

it('a beta announced by a check that raced "beta off" is not downloaded in the background', async () => {
  updater.beta = true
  answers.set('/website/config', site({ version: '2.13.3' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.13.4-beta.1' }])
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.4-beta.1', autoDownload: true })
  updater.beta = false // 在设置里关了测试版,channelChanged 没赶上
  let started = 0
  updater.download.push(async () => { started++ })
  await downloadUpdate({ auto: true, version: '2.13.4-beta.1' })
  expect(started).toBe(0)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'available' })
})

it('Developer ID mac in mainland on beta: the website has no such version, so the GitHub zip downloads in the background', async () => {
  onMac()
  updater.macSelf = { ok: true, reason: 'developer-id' }
  updater.beta = true
  answers.set('/website/config', macWithZip())
  answers.set('/auth/region', { country: 'CN', mainland_china: true })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.13.5-beta.1' }])
  const { checkForUpdates, downloadUpdate, getUpdaterStatus } = await import('./updater')
  expect(await checkForUpdates()).toMatchObject({ phase: 'available', version: '2.13.5-beta.1', source: 'github', manualInstall: false, autoDownload: true })
  updater.download.push(async () => updater.events.get('update-downloaded')!({ version: '2.13.5-beta.1' }))
  await downloadUpdate({ auto: true, version: '2.13.5-beta.1' })
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', source: 'github' })
})

// ── Unattended install (installIfIdle): pin the downloaded package so nothing swaps it before quitAndInstall ──
const downloadedBeta = async () => {
  updater.beta = true
  answers.set('/website/config', site({ version: '2.13.3' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  answers.set('/releases?per_page=', [{ tag_name: 'v2.14.0-beta.1', prerelease: true }])
  updater.download.push(async () => updater.events.get('update-downloaded')!({ version: '2.14.0-beta.1' }))
  const mod = await import('./updater')
  await mod.checkForUpdates()
  await mod.downloadUpdate()
  expect(mod.getUpdaterStatus()).toMatchObject({ phase: 'downloaded', version: '2.14.0-beta.1' })
  return mod
}

it('pin: refuses before anything is downloaded, and refuses a version other than the downloaded one', async () => {
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, downloadUpdate, pinDownloaded, installPinned } = await import('./updater')
  await checkForUpdates()
  expect(pinDownloaded('2.13.4')).toBe('not_downloaded')
  await downloadUpdate()
  expect(pinDownloaded('2.13.5')).toBe('version_mismatch')
  expect(installPinned('2.13.5')).toBe(false)
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  expect(pinDownloaded('2.13.4')).toBeNull()
  expect(pinDownloaded('2.13.5')).toBe('version_mismatch') // one pin at a time
  expect(installPinned('2.13.4')).toBe(true)
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
})

it('pin: a channel switch while pinned cannot drop the package, and a re-check cannot replace it', async () => {
  const { pinDownloaded, channelChanged, checkForUpdates, getUpdaterStatus, pinStillValid, installPinned } = await downloadedBeta()
  expect(pinDownloaded('2.14.0-beta.1')).toBeNull()
  updater.beta = false
  channelChanged(false) // would drop the prerelease (see "turning beta off drops a downloaded prerelease")
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded', version: '2.14.0-beta.1' })
  answers.set('/website/config', site({ version: '2.13.9' }))
  expect(await checkForUpdates()).toMatchObject({ phase: 'downloaded', version: '2.14.0-beta.1' })
  expect(pinStillValid('2.14.0-beta.1')).toBe(true)
  expect(installPinned('2.14.0-beta.1')).toBe(true)
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
})

it('pin: a channel switch made while pinned takes effect when the attempt is released without installing', async () => {
  const { pinDownloaded, unpinDownloaded, channelChanged, getUpdaterStatus, installPinned } = await downloadedBeta()
  expect(pinDownloaded('2.14.0-beta.1')).toBeNull()
  updater.beta = false
  channelChanged(false)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'downloaded' })
  unpinDownloaded('2.14.0-beta.1') // e.g. someone came back: refused
  expect(getUpdaterStatus()).toMatchObject({ phase: 'idle' })
  expect(installPinned('2.14.0-beta.1')).toBe(false)
})

it('pin: once unpinned a channel switch drops the package again and the old version can no longer be installed', async () => {
  const { pinDownloaded, unpinDownloaded, channelChanged, getUpdaterStatus, installPinned } = await downloadedBeta()
  expect(pinDownloaded('2.14.0-beta.1')).toBeNull()
  unpinDownloaded('2.14.0-beta.1')
  updater.beta = false
  channelChanged(false)
  expect(getUpdaterStatus()).toMatchObject({ phase: 'idle' })
  expect(installPinned('2.14.0-beta.1')).toBe(false)
  expect(pinDownloaded('2.14.0-beta.1')).toBe('not_downloaded')
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
})

it('pin: an ad-hoc mac (manual .dmg only) cannot be pinned', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  answers.set('/website/config', site({ version: '2.13.4' }))
  answers.set('/auth/region', { country: 'GB', mainland_china: false })
  const { checkForUpdates, pinDownloaded } = await import('./updater')
  await checkForUpdates()
  expect(pinDownloaded('2.13.4')).toBe('unsupported')
})
