import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  exists: vi.fn(), ask: vi.fn(), media: vi.fn(), requestMedia: vi.fn(), sources: vi.fn(),
  open: vi.fn(), launch: vi.fn(), show: vi.fn(), close: vi.fn(), confirm: vi.fn(), handlers: new Map<string, (...args: any[]) => any>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getName: () => 'Forsion', getAppPath: () => '/app', on: vi.fn() },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => m.handlers.set(name, fn) },
  shell: { openExternal: m.open }, desktopCapturer: { getSources: m.sources },
  dialog: { showMessageBox: m.confirm },
  systemPreferences: { getMediaAccessStatus: m.media, askForMediaAccess: m.requestMedia },
}))
vi.mock('node:fs', () => ({ existsSync: m.exists, accessSync: vi.fn(), constants: { W_OK: 2 } }))
vi.mock('node:child_process', () => ({ execFile: m.launch, spawn: vi.fn() }))
vi.mock('./computerUse', () => ({ helperSocketPath: () => '/tmp/test-cu.sock', askHelper: m.ask }))
vi.mock('./permissionGuide', () => ({ PermissionGuide: class { show = m.show; close = m.close } }))

import { DesktopPermissions, helperPermissionStates, normalizeMediaPermission, permissionHelperAppPath, registerDesktopPermissions } from './desktopPermissions'

const native = { accessibility: true, screenRecordingPreflight: true, source: { attribution: 'helper-app', pid: 81 } }
const service = () => new DesktopPermissions(true, vi.fn())
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' }))
afterAll(() => Object.defineProperty(process, 'platform', originalPlatform))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  m.handlers.clear()
  m.exists.mockReturnValue(true)
  m.ask.mockResolvedValue(native)
  m.media.mockReturnValue('not-determined')
  m.open.mockResolvedValue(undefined)
  m.show.mockResolvedValue(undefined)
  m.confirm.mockResolvedValue({ response: 0 })
  m.launch.mockImplementation((_command, _args, _options, callback) => { m.exists.mockReturnValue(true); callback(null, '', '') })
  vi.spyOn(DesktopPermissions.prototype as any, 'runInstaller').mockResolvedValue(true)
})

describe('permission attribution and passive checks', () => {
  it('a live helper grant never implies a Forsion microphone grant', async () => {
    const { snapshot } = await service().read()
    expect(snapshot.permissions.computerAccessibility).toBe('granted')
    expect(snapshot.permissions.microphone).toBe('not-determined')
    expect(snapshot.permissions.computerScreen).toBe('unverified')
    expect(m.ask.mock.calls.map((call) => call[1].cmd)).toEqual(['permissionStatus'])
    expect(m.sources).not.toHaveBeenCalled()
    expect(m.requestMedia).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
    expect((DesktopPermissions.prototype as any).runInstaller).not.toHaveBeenCalled()
  })

  it('missing helper/socket is unknown, not denied; reads do not install or start anything', async () => {
    m.exists.mockReturnValue(false)
    const { snapshot } = await service().read()
    expect(snapshot.helperError).toBe('not-installed')
    expect(snapshot.permissions.computerScreen).toBe('unknown')
    expect(m.ask).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
  })

  it('concurrent UI and panel polls share one read', async () => {
    const s = service()
    await Promise.all([s.read(), s.read(), s.read()])
    expect(m.ask).toHaveBeenCalledTimes(1)
  })

  it('a terminal-owned helper cannot report canonical helper grants', () => {
    expect(helperPermissionStates({ ...native, source: { attribution: 'caller', pid: 81 } }, { pid: 81, granted: true }))
      .toEqual({ computerAccessibility: 'unknown', computerScreen: 'unknown' })
  })

  it('live verification overrides a stale positive or negative preflight and never crosses process IDs', () => {
    expect(helperPermissionStates(native, { pid: 81, granted: false }).computerScreen).toBe('denied')
    expect(helperPermissionStates({ ...native, screenRecordingPreflight: false }, { pid: 81, granted: true }).computerScreen).toBe('granted')
    expect(helperPermissionStates(native, { pid: 82, granted: true }).computerScreen).toBe('unverified')
  })

  it('old/unreachable helpers retain unknown status, not false denial', async () => {
    m.ask.mockRejectedValue(Object.assign(new Error('old helper'), { code: 'unknown_command' }))
    const { snapshot } = await service().read()
    expect(snapshot.helperError).toBe('outdated')
    expect(snapshot.permissions.computerAccessibility).toBe('unknown')
  })

  it('unknown platform values are not silently marked granted', () => {
    expect(normalizeMediaPermission('unknown')).toBe('unknown')
    expect(normalizeMediaPermission(undefined)).toBe('unknown')
    expect(normalizeMediaPermission('restricted')).toBe('restricted')
  })

  it('helper path follows the override without changing the socket attribution', () => {
    expect(permissionHelperAppPath({ PI_COMPUTER_USE_HELPER_APP_PATH: '/tmp/cu.app' }, '/user')).toBe('/tmp/cu.app')
    m.exists.mockReturnValue(false)
    expect(permissionHelperAppPath({}, '/user')).toBe('/user/Applications/tangu-computer-use.app')
  })
})

describe('explicit permission actions', () => {
  it.each(['missing', 'partial'])('repairs a %s app before launching it and requesting access', async (scenario) => {
    m.exists.mockImplementation(file => scenario === 'partial' && file !== '/tmp/test-cu.sock')
    const installer = vi.mocked((DesktopPermissions.prototype as any).runInstaller)
      .mockImplementation(async (checkOnly?: boolean) => !checkOnly)
    await service().request('computerAccessibility')
    expect(installer.mock.calls).toEqual(scenario === 'missing' ? [[]] : [[true], []])
    expect(m.launch).toHaveBeenCalledOnce()
    expect(m.launch.mock.calls[0].slice(0, 2)).toEqual(['/usr/bin/open', expect.arrayContaining(['-n', '-g', 'serve'])])
    expect(installer.mock.invocationCallOrder.at(-1)!).toBeLessThan(m.launch.mock.invocationCallOrder[0])
    expect(m.ask.mock.calls.map(call => call[1])).toContainEqual({ cmd: 'registerPermissions', kind: 'accessibility' })
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it('leaving during signature verification cannot reopen a restart prompt', async () => {
    let release!: (value: boolean) => void
    vi.mocked((DesktopPermissions.prototype as any).runInstaller).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const s = service(), action = s.request('computerAccessibility')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    s.closeGuide(); release(false); await action
    expect(m.confirm).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
  })

  it('a same-protocol old installation requests consent before replacing a running helper', async () => {
    const installer = vi.mocked((DesktopPermissions.prototype as any).runInstaller).mockResolvedValue(false)
    await service().request('computerAccessibility', { locale: 'zh' })
    expect(installer).toHaveBeenCalledExactlyOnceWith(true)
    expect(m.confirm).toHaveBeenCalledOnce()
    expect(m.ask.mock.calls.every((call) => call[1].cmd === 'permissionStatus')).toBe(true)
    expect(m.open).not.toHaveBeenCalled()
  })

  it('current helpers are verified without replacement before requesting access', async () => {
    await service().request('computerAccessibility')
    expect((DesktopPermissions.prototype as any).runInstaller).toHaveBeenCalledExactlyOnceWith(true)
    expect(m.confirm).not.toHaveBeenCalled()
    expect(m.ask.mock.calls.map((call) => call[1])).toContainEqual({ cmd: 'registerPermissions', kind: 'accessibility' })
  })

  it('an outdated helper cannot be stopped based on liveView reporting idle; cancellation leaves it alone', async () => {
    m.ask.mockRejectedValue(Object.assign(new Error('old helper'), { code: 'unknown_command' }))
    const result = await service().request('computerAccessibility', { locale: 'zh' })
    expect(result.helperError).toBe('outdated')
    expect(m.confirm).toHaveBeenCalledOnce()
    expect(m.ask.mock.calls.every((call) => call[1].cmd === 'permissionStatus')).toBe(true)
    expect(m.show).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
  })

  it.each(['restarted', 'wrong-identity'])('does not carry verification into a %s helper', async (scenario) => {
    let probed = false
    m.ask.mockImplementation((_socket, request) => {
      if (request.cmd === 'checkPermissions') { probed = true; return Promise.resolve({ ...native, screenRecordingCapturable: true }) }
      return Promise.resolve(probed ? { ...native, accessibility: false,
        source: { attribution: scenario === 'restarted' ? 'helper-app' : 'caller', pid: 82 } } : native)
    })
    const result = await service().verify()
    expect(result.permissions.computerScreen).toBe(scenario === 'restarted' ? 'unverified' : 'unknown')
    expect(result.permissions.computerAccessibility).toBe(scenario === 'restarted' ? 'denied' : 'unknown')
  })

  it('accessibility requests only accessibility and opens one pane', async () => {
    await service().request('computerAccessibility', { locale: 'zh' })
    const requests = m.ask.mock.calls.map((call) => call[1])
    expect(requests).toContainEqual({ cmd: 'registerPermissions', kind: 'accessibility' })
    expect(requests.some((r) => r.cmd === 'checkPermissions')).toBe(false)
    expect(m.open).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(m.show).toHaveBeenCalledWith('computerAccessibility', { locale: 'zh' })
  })

  it('leaving the page during registration cannot reopen settings or the guide', async () => {
    let release!: (value: unknown) => void
    m.ask.mockImplementation((_socket, request) => request.cmd === 'registerPermissions'
      ? new Promise((resolve) => { release = resolve }) : Promise.resolve(native))
    const s = service()
    const action = s.request('computerAccessibility')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    s.closeGuide()
    release({})
    await action
    expect(m.open).not.toHaveBeenCalled()
    expect(m.show).not.toHaveBeenCalled()
  })

  it('verification is fresh, shared across double-clicks, and remembered only briefly', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    m.ask.mockImplementation((_socket, request) => Promise.resolve(request.cmd === 'checkPermissions'
      ? { ...native, screenRecordingCapturable: true } : native))
    const s = service()
    await Promise.all([s.verify(), s.verify()])
    expect(m.ask.mock.calls.filter((call) => call[1].cmd === 'checkPermissions')).toHaveLength(1)
    expect(m.ask.mock.calls.find((call) => call[1].cmd === 'checkPermissions')?.[1]).toEqual({ cmd: 'checkPermissions', fresh: true })
    expect((await s.read()).snapshot.permissions.computerScreen).toBe('granted')
    now.mockReturnValue(131_000)
    expect((await s.read()).snapshot.permissions.computerScreen).toBe('unverified')
    now.mockRestore()
  })

  it('a microphone granted by the system dialog does not open an extra settings pane', async () => {
    m.requestMedia.mockImplementation(() => { m.media.mockReturnValue('granted'); return Promise.resolve(true) })
    expect((await service().request('microphone')).permissions.microphone).toBe('granted')
    expect(m.requestMedia).toHaveBeenCalledExactlyOnceWith('microphone')
    expect(m.open).not.toHaveBeenCalled()
    expect(m.show).not.toHaveBeenCalled()
  })

  it('IPC rejects subframes/untrusted senders and arbitrary permission names before side effects', () => {
    registerDesktopPermissions({ isTrustedSender: (e) => !!(e as any).trusted, computerUseAvailable: true, returnToApp: vi.fn() })
    expect(() => m.handlers.get('permissions:request')!({}, 'microphone')).toThrow('Untrusted')
    expect(() => m.handlers.get('permissions:request')!({ trusted: true }, 'https://example.com')).toThrow('Unknown permission')
    expect(m.open).not.toHaveBeenCalled()
    expect(m.ask).not.toHaveBeenCalled()
  })
})
