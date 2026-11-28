/**
 * 智库同步第 2 步 H 包:在新设置页里给 Dropbox / Google Drive 去处授权,结果直接存进 sync-targets(契约 实现期修订 H-9)。
 * - 不发任何真实请求:net.fetch 换成夹具里的假令牌端点 / 账号端点;Dropbox 的固定回调口(53682)换成夹具捕获回调,
 *   Google Drive 走真的 127.0.0.1 随机口回环(只在本机);浏览器只记下要打开的地址;
 * - 凭据只落 sync-targets 文件,结果事件、旧设置页广播、控制台里都没有;报错只回固定码,不带提供方原文;
 * - 重新授权沿用那条的位置与自建应用,换了账号 = target-location-changed,原凭据不动;
 * - 同时只认一次授权:新的顶掉旧的,和旧设置页的授权互相顶掉;取消 / 超时 / 晚到的回调都不存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Cb = (r: { code: string } | { error: string }) => void
type Req = { url: string; method: string; body: string; auth: string }
const env = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  opened: [] as string[],
  openFails: false,
  requests: [] as Req[],
  respond: null as null | ((r: Req) => Response),
  dbx: null as null | { state: string; cb: Cb; closed: boolean },
  dbxManual: false,
  broadcast: [] as { ch: string; p: unknown }[],
}))
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { env.handlers.set(ch, fn) } },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (ch: string, p: unknown) => { env.broadcast.push({ ch, p }) } } }] },
  net: {
    fetch: async (input: unknown, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const r: Req = { url: String(input), method: init?.method ?? 'GET', body: init?.body == null ? '' : String(init.body), auth: init?.headers?.Authorization ?? '' }
      env.requests.push(r)
      if (!env.respond) throw new Error('no network in tests')
      return env.respond(r)
    },
  },
  shell: { openExternal: async (u: string) => { if (env.openFails) throw new Error('no browser'); env.opened.push(u) }, trashItem: async () => {} },
}))
// Dropbox 的回调口是固定的 53682:夹具捕获回调,不在测试机上占真端口;别的口(Drive 的 0)照用真的回环
vi.mock('./remotesync/fsDropbox', async (orig) => {
  const m = await orig<typeof import('./remotesync/fsDropbox')>()
  return {
    ...m,
    dropboxCallbackServer: (port: number, state: string, cb: Cb) => {
      if (port !== 53682) return m.dropboxCallbackServer(port, state, cb)
      if (env.dbxManual) return Promise.resolve(null)
      const s = { state, cb, closed: false }
      env.dbx = s
      return Promise.resolve({ port, close: () => { s.closed = true } })
    },
  }
})
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./amadeus/settings', () => ({
  readConfig: async () => ({ lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: [] }),
  currentCloudAccountId: () => null,
}))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'cloud-mirror'),
  isManagedCloudVault: () => false,
  hash8: (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8),
}))
vi.mock('./contentSyncHost', () => ({ contentSyncOwned: () => false }))
vi.mock('./syncRecordsIpc', () => ({ appendSyncRecord: () => {} }))

const SECRETS = ['fixture-refresh', 'fixture-access', 'fixture-client-secret', 'fixture-provider-text', 'fixture-person@']
type Ev = { attempt: string; ok: boolean; error?: string; target?: { id: string; kind: string; label: string; dirDefault: string; source: string }; account?: string }
let events: { ch: string; ev: Ev }[] = []
let senderGone = false
const sender = { isDestroyed: () => senderGone, send: (ch: string, ev: Ev) => { events.push({ ch, ev }) } }
const call = async <T = any>(ch: string, ...args: unknown[]): Promise<T> => env.handlers.get(ch)!({ sender }, ...args) as Promise<T>
const store = (): any => JSON.parse(readFileSync(join(env.root, 'userData', 'sync-targets.json'), 'utf8'))
const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const q = (u: string): URLSearchParams => new URL(u).searchParams
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)) }
  throw new Error(`timed out waiting for ${what}`)
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))
/** 等第 n 个结果事件(从 1 数)。 */
async function nthEvent(n: number): Promise<Ev> { await until(() => events.length >= n, `auth event #${n}`); return events[n - 1].ev }

/** 假 Dropbox:令牌端点按 code 发 refresh token,账号端点回 email。 */
function dropbox(accounts: Record<string, { accountId: string; email: string; refresh: string }>): void {
  let last = ''
  env.respond = (r) => {
    if (r.url === 'https://api.dropboxapi.com/oauth2/token') {
      const a = accounts[new URLSearchParams(r.body).get('code') ?? '']
      if (!a) return new Response('{"error":"invalid_grant","error_description":"fixture-provider-text"}', { status: 400 })
      last = a.email
      return json({ refresh_token: a.refresh, access_token: 'fixture-access-token', account_id: a.accountId })
    }
    if (r.url === 'https://api.dropboxapi.com/2/users/get_current_account') return json({ email: last, name: { display_name: 'Fixture' } })
    return new Response('', { status: 404 })
  }
}

let warn: ReturnType<typeof vi.spyOn>, log: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'forsion-target-auth-'))
  mkdirSync(join(env.root, 'Vault'), { recursive: true })
  mkdirSync(join(env.root, 'userData'), { recursive: true })
  Object.assign(env, { opened: [], openFails: false, requests: [], respond: null, dbx: null, dbxManual: false, broadcast: [] })
  events = []
  senderGone = false
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
  env.handlers.clear()
  const ipc = await import('./remotesyncIpc')
  ipc.registerRemoteSync()
  const { registerSyncTargetsIpc } = await import('./syncTargets')
  registerSyncTargetsIpc()
})
afterEach(async () => {
  // 凭据只该在 sync-targets 文件里:事件、旧设置页广播、控制台一个字都没有
  const out = JSON.stringify([events, env.broadcast, warn.mock.calls, log.mock.calls, error.mock.calls])
  for (const s of SECRETS) expect(out).not.toContain(s)
  await call('remotesync:targets:authCancel', '*') // 不是哪一次 = 什么都不做
  for (const e of events) { if (e.ev.attempt) await call('remotesync:targets:authCancel', e.ev.attempt) }
  warn.mockRestore(); log.mockRestore(); error.mockRestore()
  vi.useRealTimers()
  rmSync(env.root, { recursive: true, force: true })
})

describe('authorizing a new Dropbox target', () => {
  it('loopback callback → the credentials land in sync-targets (0600); the renderer only gets a summary and the account name', async () => {
    dropbox({ C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A' } })
    const start = await call('remotesync:targets:authStart', 'dropbox', { label: 'My Dropbox', baseDir: ' /Vault ' })
    expect(start).toMatchObject({ ok: true, mode: 'auto' })
    expect(Object.keys(start).sort()).toEqual(['attempt', 'mode', 'ok'])
    const u = q(env.opened[0])
    expect(u.get('client_id')).toBe('ft4gcwbsrmu3x4x') // 内置官方应用
    expect(u.get('redirect_uri')).toBe('http://localhost:53682/')
    expect(u.get('state')).toBe(env.dbx!.state)
    env.dbx!.cb({ code: 'C1' })
    const ev = await nthEvent(1)
    expect(events[0].ch).toBe('remotesync:targets:auth')
    expect(ev).toEqual({ attempt: start.attempt, ok: true, account: 'a@example.test', target: { id: expect.any(String), kind: 'dropbox', label: 'My Dropbox', dirDefault: '/Vault', source: 'user' } })
    expect(env.dbx!.closed).toBe(true)
    const tok = new URLSearchParams(env.requests[0].body)
    expect(tok.get('code_verifier')).toMatch(/.{43,}/)
    expect(tok.get('redirect_uri')).toBe('http://localhost:53682/')
    const t = store().targets[ev.target!.id]
    expect(t).toMatchObject({ kind: 'dropbox', label: 'My Dropbox', source: 'user', section: { appKey: '', refreshToken: 'fixture-refresh-A', accountId: 'dbid:A', email: 'a@example.test', baseDir: '/Vault' } })
    expect(statSync(join(env.root, 'userData', 'sync-targets.json')).mode & 0o777).toBe(0o600)
    // 旧设置页的配置一点没动
    expect(() => readFileSync(join(env.root, 'userData', 'remotesync.json'))).toThrow()
    expect(await call('remotesync:targets:list')).toEqual([ev.target])
  })

  it('loopback port taken → manual mode: the pasted code is exchanged without redirect_uri; another attempt id is refused', async () => {
    env.dbxManual = true
    dropbox({ 'CODE-M': { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-M' } })
    const start = await call('remotesync:targets:authStart', 'dropbox', {})
    expect(start).toMatchObject({ ok: true, mode: 'manual' })
    expect(q(env.opened[0]).has('redirect_uri')).toBe(false)
    expect(await call('remotesync:targets:authFinish', 'not-this-one', 'CODE-M')).toEqual({ ok: false, error: 'auth-not-started' })
    expect(await call('remotesync:targets:authFinish', start.attempt, '   ')).toEqual({ ok: false, error: 'auth-not-started' })
    expect(await call('remotesync:targets:authFinish', start.attempt, '  CODE-M  ')).toEqual({ ok: true })
    const ev = await nthEvent(1)
    expect(ev).toMatchObject({ ok: true, account: 'a@example.test' })
    const tok = new URLSearchParams(env.requests[0].body)
    expect(tok.get('code')).toBe('CODE-M')
    expect(tok.has('redirect_uri')).toBe(false)
    expect(store().targets[ev.target!.id].section.refreshToken).toBe('fixture-refresh-M')
  })

  it('a user-made app key is kept on the target and reused when re-authorizing', async () => {
    dropbox({ C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-1' }, C2: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-2' } })
    await call('remotesync:targets:authStart', 'dropbox', { appKey: ' fixture-own-app ' })
    expect(q(env.opened[0]).get('client_id')).toBe('fixture-own-app')
    env.dbx!.cb({ code: 'C1' })
    const id = (await nthEvent(1)).target!.id
    expect(store().targets[id].section.appKey).toBe('fixture-own-app')
    await call('remotesync:targets:authStart', 'dropbox', { id })
    expect(q(env.opened[1]).get('client_id')).toBe('fixture-own-app')
    env.dbx!.cb({ code: 'C2' })
    expect(await nthEvent(2)).toMatchObject({ ok: true, target: { id } })
    expect(new URLSearchParams(env.requests[2].body).get('client_id')).toBe('fixture-own-app')
    expect(store().targets[id].section).toMatchObject({ appKey: 'fixture-own-app', refreshToken: 'fixture-refresh-2' })
  })
})

describe('re-authorizing an existing target', () => {
  it('same account → same id, location kept (a baseDir passed now is ignored); another account → target-location-changed and the stored credentials stay', async () => {
    dropbox({
      C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A1' },
      C2: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A2' },
      C3: { accountId: 'dbid:B', email: 'b@example.test', refresh: 'fixture-refresh-B' },
    })
    await call('remotesync:targets:authStart', 'dropbox', { baseDir: '/Vault' })
    env.dbx!.cb({ code: 'C1' })
    const first = await nthEvent(1)
    const id = first.target!.id
    const createdAt = store().targets[id].createdAt
    await call('remotesync:targets:authStart', 'dropbox', { id, baseDir: '/Other', label: 'Renamed' })
    env.dbx!.cb({ code: 'C2' })
    expect(await nthEvent(2)).toMatchObject({ ok: true, target: { id, dirDefault: '/Vault', label: 'Renamed' } })
    expect(store().targets[id]).toMatchObject({ createdAt, section: { baseDir: '/Vault', refreshToken: 'fixture-refresh-A2', accountId: 'dbid:A' } })
    await call('remotesync:targets:authStart', 'dropbox', { id })
    env.dbx!.cb({ code: 'C3' })
    expect(await nthEvent(3)).toEqual({ attempt: expect.any(String), ok: false, error: 'target-location-changed' })
    expect(store().targets[id].section).toMatchObject({ refreshToken: 'fixture-refresh-A2', accountId: 'dbid:A' })
    expect(Object.keys(store().targets)).toEqual([id])
  })

  it('unknown id, another kind, or an unsupported kind is refused before the browser opens', async () => {
    const { saveSyncTarget } = await import('./syncTargets')
    const s3 = await saveSyncTarget({ kind: 's3', section: { endpoint: 'https://s3.test', bucket: 'b', accessKeyID: 'k', secretAccessKey: 's' } })
    expect(await call('remotesync:targets:authStart', 's3', {})).toEqual({ ok: false, error: 'bad-target-kind' })
    expect(await call('remotesync:targets:authStart', 'dropbox', { id: 'no-such-target' })).toEqual({ ok: false, error: 'target-not-found' })
    expect(await call('remotesync:targets:authStart', 'gdrive', { id: s3.id, clientId: 'fixture-client' })).toEqual({ ok: false, error: 'target-kind-changed' })
    expect(env.opened).toEqual([])
  })
})

describe('only one authorization at a time', () => {
  it('a second target authorization supersedes the first; the late callback of the first is ignored', async () => {
    dropbox({ C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A' }, C2: { accountId: 'dbid:B', email: 'b@example.test', refresh: 'fixture-refresh-B' } })
    const a = await call('remotesync:targets:authStart', 'dropbox', {})
    const oldDbx = env.dbx!
    const b = await call('remotesync:targets:authStart', 'dropbox', {})
    expect(await nthEvent(1)).toEqual({ attempt: a.attempt, ok: false, error: 'auth-superseded' })
    expect(oldDbx.closed).toBe(true)
    oldDbx.cb({ code: 'C1' })
    env.dbx!.cb({ code: 'C2' })
    expect(await nthEvent(2)).toMatchObject({ attempt: b.attempt, ok: true, account: 'b@example.test' })
    await settle()
    expect(events).toHaveLength(2)
    expect(Object.values(store().targets).map((t: any) => t.section.accountId)).toEqual(['dbid:B'])
  })

  it('the old settings page starting Dropbox supersedes the target attempt, and the target attempt supersedes the old page', async () => {
    dropbox({})
    const a = await call('remotesync:targets:authStart', 'dropbox', {})
    const targetDbx = env.dbx!
    expect(await call('remotesync:dropboxAuthStart', '')).toMatchObject({ ok: true, mode: 'auto' })
    expect(await nthEvent(1)).toEqual({ attempt: a.attempt, ok: false, error: 'auth-superseded' })
    expect(targetDbx.closed).toBe(true)
    targetDbx.cb({ code: 'C1' }) // 晚到的
    await settle()
    expect(events).toHaveLength(1)
    expect(env.requests).toEqual([])
    const legacyDbx = env.dbx!
    await call('remotesync:targets:authStart', 'dropbox', {})
    expect(env.broadcast).toEqual([{ ch: 'remotesync:dropboxAuth', p: { ok: false, error: 'auth-superseded' } }])
    expect(legacyDbx.closed).toBe(true)
  })

  it('the old settings page starting Google Drive also supersedes a target attempt', async () => {
    const a = await call('remotesync:targets:authStart', 'dropbox', {})
    await call('remotesync:gdriveAuthStart', 'fixture-client', '')
    expect(await nthEvent(1)).toEqual({ attempt: a.attempt, ok: false, error: 'auth-superseded' })
  })
})

describe('ending without credentials', () => {
  it('cancel → auth-cancelled once, the callback is closed and a late code is not exchanged', async () => {
    dropbox({ C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A' } })
    const a = await call('remotesync:targets:authStart', 'dropbox', {})
    expect(await call('remotesync:targets:authCancel', a.attempt)).toEqual({ ok: true })
    expect(await nthEvent(1)).toEqual({ attempt: a.attempt, ok: false, error: 'auth-cancelled' })
    expect(env.dbx!.closed).toBe(true)
    env.dbx!.cb({ code: 'C1' })
    expect(await call('remotesync:targets:authFinish', a.attempt, 'C1')).toEqual({ ok: false, error: 'auth-not-started' })
    await call('remotesync:targets:authCancel', a.attempt)
    await settle()
    expect(events).toHaveLength(1)
    expect(env.requests).toEqual([])
  })

  it('five minutes without a callback → auth-timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await call('remotesync:targets:authStart', 'dropbox', {})
    vi.advanceTimersByTime(5 * 60_000 - 1)
    await Promise.resolve()
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    expect(await nthEvent(1)).toEqual({ attempt: a.attempt, ok: false, error: 'auth-timeout' })
    expect(env.dbx!.closed).toBe(true)
  })

  it('provider errors surface as fixed codes, never the provider text', async () => {
    dropbox({})
    const codes: string[] = []
    for (const r of [{ error: 'access_denied: fixture-person@example.test said no' }, { error: 'state-mismatch' }, { error: 'server_error: fixture-provider-text' }, { code: 'BAD' }]) {
      await call('remotesync:targets:authStart', 'dropbox', {})
      env.dbx!.cb(r as { code: string } | { error: string })
      codes.push((await nthEvent(codes.length + 1)).error!)
    }
    expect(codes).toEqual(['auth-denied', 'auth-state-mismatch', 'auth-failed', 'auth-exchange-failed'])
    expect(() => store()).toThrow() // 什么都没存
  })

  it('the browser cannot be opened → open-browser-failed, nothing left waiting', async () => {
    env.openFails = true
    expect(await call('remotesync:targets:authStart', 'dropbox', {})).toEqual({ ok: false, error: 'open-browser-failed' })
    expect(env.dbx!.closed).toBe(true)
    await settle()
    expect(events).toEqual([])
  })

  it('the window that started it is gone → the result is still saved, nothing is sent', async () => {
    dropbox({ C1: { accountId: 'dbid:A', email: 'a@example.test', refresh: 'fixture-refresh-A' } })
    await call('remotesync:targets:authStart', 'dropbox', {})
    senderGone = true
    env.dbx!.cb({ code: 'C1' })
    await until(() => { try { return Object.keys(store().targets).length === 1 } catch { return false } }, 'saved target')
    await settle()
    expect(events).toEqual([])
  })
})

describe('authorizing a Google Drive target', () => {
  it('real 127.0.0.1 loopback with the state from the auth URL → saved with the user-made client; a wrong state is refused', async () => {
    env.respond = (r) => {
      if (r.url === 'https://oauth2.googleapis.com/token') {
        const b = new URLSearchParams(r.body)
        if (b.get('code') !== 'G1') return new Response('fixture-provider-text', { status: 400 })
        return json({ refresh_token: 'fixture-refresh-G', access_token: 'fixture-access-G' })
      }
      if (r.url.startsWith('https://www.googleapis.com/drive/v3/about')) return json({ user: { permissionId: 'perm-A', emailAddress: 'g@example.test', displayName: 'G' } })
      return new Response('', { status: 404 })
    }
    // 先来一次 state 不对的
    const bad = await call('remotesync:targets:authStart', 'gdrive', { clientId: 'fixture-client.apps', clientSecret: 'fixture-client-secret-1' })
    expect(bad).toMatchObject({ ok: true, mode: 'auto' })
    const ub = q(env.opened[0])
    await fetch(`${ub.get('redirect_uri')}?code=G1&state=not-the-state`)
    expect(await nthEvent(1)).toEqual({ attempt: bad.attempt, ok: false, error: 'auth-state-mismatch' })

    const start = await call('remotesync:targets:authStart', 'gdrive', { clientId: 'fixture-client.apps', clientSecret: 'fixture-client-secret-1', baseDir: 'Forsion/Vault' })
    const u = q(env.opened[1])
    expect(u.get('client_id')).toBe('fixture-client.apps')
    const redirect = u.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const page = await fetch(`${redirect}?code=G1&state=${u.get('state')}`)
    expect(page.status).toBe(200)
    const ev = await nthEvent(2)
    expect(ev).toEqual({ attempt: start.attempt, ok: true, account: 'g@example.test', target: { id: expect.any(String), kind: 'gdrive', label: expect.any(String), dirDefault: 'Forsion/Vault', source: 'user' } })
    const tok = new URLSearchParams(env.requests.find((r) => r.url === 'https://oauth2.googleapis.com/token' && new URLSearchParams(r.body).get('code') === 'G1')!.body)
    expect(tok.get('redirect_uri')).toBe(redirect)
    expect(tok.get('client_secret')).toBe('fixture-client-secret-1')
    expect(store().targets[ev.target!.id].section).toMatchObject({ clientId: 'fixture-client.apps', clientSecret: 'fixture-client-secret-1', refreshToken: 'fixture-refresh-G', accountId: 'perm-A', baseDir: 'Forsion/Vault' })
    // 回调只认一次:再来一遍(keep-alive 的连接还在时请求照样到得了)不再换码、不再发事件
    const tokens = env.requests.length
    await fetch(`${redirect}?code=G1&state=${u.get('state')}`).catch(() => null)
    await settle()
    expect(events).toHaveLength(2)
    expect(env.requests).toHaveLength(tokens)
    // Drive 只有回环一条路:手贴不收
    const again = await call('remotesync:targets:authStart', 'gdrive', { id: ev.target!.id })
    expect(q(env.opened[2]).get('client_id')).toBe('fixture-client.apps') // 重新授权沿用那条的自建客户端
    expect(await call('remotesync:targets:authFinish', again.attempt, 'G1')).toEqual({ ok: false, error: 'auth-not-started' })
  })
})
