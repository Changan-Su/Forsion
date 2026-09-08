import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))
import { shell } from 'electron'
import { forsionDeviceLogin, forsionLogout, loadTanguCreds, saveTanguCreds, forsionAccounts,
  savedForsionAccount, forsionAccountId, loadAccountCloudSettings, saveAccountCloudSettings } from './forsionAuth'

const cloud = 'https://accounts.example.test'
const jwt = (userId: string): string => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.y`
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const startResponse = () => Response.json({ device_code: 'device', user_code: '1234', verification_uri_complete: cloud + '/cli-auth?code=1234', interval: 0.001 })

describe('desktop account login lifecycle', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forsion-auth-test-'))
    vi.stubEnv('TANGU_HOME', dir)
    vi.useFakeTimers()
  })
  afterEach(() => {
    forsionLogout()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('explicit desktop login goes through a fresh account login even with an existing browser session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(startResponse()).mockResolvedValueOnce(Response.json({ status: 'approved', token: jwt('b') })))
    const login = forsionDeviceLogin(cloud)
    await vi.advanceTimersByTimeAsync(2)
    await login
    const opened = new URL(vi.mocked(shell.openExternal).mock.calls.at(-1)![0])
    expect(opened.pathname).toBe('/auth')
    expect(opened.searchParams.get('logout')).toBe('1')
    expect(new URL(opened.searchParams.get('redirect')!).pathname).toBe('/cli-auth')
  })

  it('a pending approval cannot restore credentials after logout', async () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    const poll = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(startResponse()).mockReturnValueOnce(poll.promise))
    const login = forsionDeviceLogin(cloud).then(() => 'approved', () => 'cancelled')
    await vi.advanceTimersByTimeAsync(2)
    forsionLogout()
    poll.resolve(Response.json({ status: 'approved', token: jwt('b') }))
    expect(await login).toBe('cancelled')
    expect(loadTanguCreds().token).toBeUndefined()
  })

  it('switches A → B → A and forgets only the signed-out credential', () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a'), model: 'local-choice' })
    saveTanguCreds({ ...loadTanguCreds(), token: jwt('b') })
    expect(forsionAccounts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: forsionAccountId(cloud, jwt('a')), active: false }),
      expect.objectContaining({ id: forsionAccountId(cloud, jwt('b')), active: true }),
    ]))
    expect(forsionAccounts().every((a) => !('token' in a))).toBe(true)
    saveTanguCreds({ ...loadTanguCreds(), ...savedForsionAccount(forsionAccountId(cloud, jwt('a'))!) })
    expect(loadTanguCreds()).toEqual({ cloudUrl: cloud, token: jwt('a'), model: 'local-choice' })
    forsionLogout()
    expect(forsionAccounts()).toHaveLength(1)
    expect(forsionAccounts()[0].id).toBe(forsionAccountId(cloud, jwt('b')))
    expect(() => savedForsionAccount(forsionAccountId(cloud, jwt('a'))!)).toThrow()
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'auth-accounts.json')).mode & 0o777).toBe(0o600)
  })

  it('cloud sync permission and last-sync state belong to each account', () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    saveAccountCloudSettings({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    saveTanguCreds({ cloudUrl: cloud, token: jwt('b') })
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: false, forsionLastSyncedAt: 0 })
    saveAccountCloudSettings({ forsionSyncEnabled: true, forsionLastSyncedAt: 200 })
    saveTanguCreds(savedForsionAccount(forsionAccountId(cloud, jwt('a'))!))
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    forsionLogout()
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: false, forsionLastSyncedAt: 0 })
  })

  it('late completion of a cancelled login cannot displace a new pending login', async () => {
    const firstPoll = deferred<Response>()
    const secondPoll = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(startResponse()).mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValueOnce(startResponse()).mockReturnValueOnce(secondPoll.promise))
    const first = forsionDeviceLogin(cloud).catch(() => null)
    await vi.advanceTimersByTimeAsync(2)
    forsionLogout()
    const second = forsionDeviceLogin(cloud)
    await vi.advanceTimersByTimeAsync(2)
    firstPoll.resolve(Response.json({ status: 'approved', token: jwt('a') }))
    expect(await first).toBeNull()
    secondPoll.resolve(Response.json({ status: 'approved', token: jwt('b') }))
    expect((await second).token).toBe(jwt('b'))
    expect(loadTanguCreds().token).toBe(jwt('b'))
  })
})
