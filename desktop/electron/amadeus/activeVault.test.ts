/**
 * 智库同步第 3 步 H3 12a:在线库的宿主接缝(契约 step34「H3 接口定稿」第 2 节)。
 * - active-vault:get:账号对 / 不对 / 没登录 / 配置读不了 / 形状不对;读不改盘;
 * - active-vault:set:只收可信发送方、账号不对不写、null 清掉、写完广播、和普通 writeConfig 两个顺序都不互相冲掉;
 * - 切本机库(switchVault)同一次落盘清掉 activeVault 并广播,restoreVault 的回落不清;
 * - CloudHost.openLibrary / canOpenOnline:成功、超时、无主窗、没报过 online-capable、渲染层报失败、账号不对;
 *   online-capable 只认主窗、主框架换文档 / wc 销毁后作废;
 * - 老配置迁移:该迁、缺 vaultId、读不了、没登录、已迁过幂等、别的账号 / 无主镜像、本机库也不在、已有 activeVault、没有配置文件。
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', creds: {} as { cloudUrl?: string; token?: string },
  handlers: new Map<string, (...args: any[]) => any>(),
  sent: [] as Array<{ ch: string; payload: unknown }>,
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (ch: string, payload: unknown) => env.sent.push({ ch, payload }) } }] },
  dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

const CLOUD = 'https://cloud.example'
const token = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.x`
const login = (userId: string) => { env.creds = { cloudUrl: CLOUD, token: token(userId) } }
const ns = (userId: string) => createHash('sha256').update(`${CLOUD}::${userId}`).digest('hex')
const refOf = (userId: string, over: Record<string, unknown> = {}) => ({ kind: 'online' as const, account: ns(userId), libraryId: 'lib-1', vaultId: 'vault-1', prefix: 'Amadeus/', name: 'Notes', ...over })
const cfgFile = () => path.join(env.root, 'amadeus-config.json')
const readCfg = async () => JSON.parse(await fs.readFile(cfgFile(), 'utf8'))
const bytes = () => fs.readFile(cfgFile(), 'utf8')

/** 假 webContents:send 记下来,事件用 EventEmitter 发。 */
function fakeContents(id: number) {
  const ee = new EventEmitter() as EventEmitter & { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean; mainFrame: object }
  ee.id = id
  ee.send = vi.fn()
  ee.isDestroyed = () => false
  ee.mainFrame = {}
  return ee
}
type Wc = ReturnType<typeof fakeContents>

async function setup(opts: { timeoutMs?: number } = {}) {
  const { createActiveVaultHost } = await import('./activeVault')
  const { ACTIVE_VAULT_IPC } = await import('./activeVaultKeys')
  const handles = new Map<string, (...a: any[]) => any>()
  const listeners = new Map<string, (...a: any[]) => void>()
  const broadcasts: Array<{ ch: string; payload: unknown }> = []
  const state = { main: fakeContents(1) as Wc | null, focus: vi.fn() }
  const host = createActiveVaultHost({
    isTrusted: (e) => !(e as { untrusted?: boolean }).untrusted,
    mainContents: () => state.main as never,
    focusMain: state.focus,
    accountId: () => (env.creds.token ? `${CLOUD}::${JSON.parse(Buffer.from(env.creds.token.split('.')[1], 'base64url').toString()).userId}` : null),
    broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    timeoutMs: opts.timeoutMs,
  })
  host.register({ handle: (ch, fn) => handles.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) })
  const ev = (sender: unknown, extra: Record<string, unknown> = {}) => ({ sender, senderFrame: {}, ...extra })
  return {
    host, state, broadcasts, K: ACTIVE_VAULT_IPC,
    get: (sender: unknown = state.main, extra: Record<string, unknown> = {}) => handles.get(ACTIVE_VAULT_IPC.get)!(ev(sender, extra)),
    set: (ref: unknown, sender: unknown = state.main, extra: Record<string, unknown> = {}) => handles.get(ACTIVE_VAULT_IPC.set)!(ev(sender, extra), ref),
    capable: (sender: unknown = state.main, extra: Record<string, unknown> = {}) => listeners.get(ACTIVE_VAULT_IPC.onlineCapable)!(ev(sender, extra)),
    result: (r: unknown, sender: unknown = state.main) => listeners.get(ACTIVE_VAULT_IPC.openOnlineResult)!(ev(sender), r),
  }
}

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-active-vault-'))
  env.handlers.clear()
  env.sent = []
  login('A')
})
afterEach(async () => { await fs.rm(env.root, { recursive: true, force: true }) })

describe('active-vault:get', () => {
  it('returns the ref for the signed-in account; another account or signed-out → null + fallback, and the file is untouched', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault', activeVault: refOf('A') }))
    const t = await setup()
    expect(await t.get()).toEqual({ ref: refOf('A'), fallback: null })
    const before = await bytes()
    login('B')
    expect(await t.get()).toEqual({ ref: null, fallback: { reason: 'account', name: 'Notes' } })
    env.creds = {}
    expect(await t.get()).toEqual({ ref: null, fallback: { reason: 'account', name: 'Notes' } })
    expect(await bytes()).toBe(before) // 回落不清,下次换回 A 照样恢复
    login('A')
    expect((await t.get()).ref).toEqual(refOf('A'))
  })

  it('no activeVault → local; an unreadable config or a malformed ref throws instead of reading as local', async () => {
    const t = await setup()
    expect(await t.get()).toEqual({ ref: null, fallback: null }) // 没有配置文件
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault' }))
    expect(await t.get()).toEqual({ ref: null, fallback: null })
    await fs.writeFile(cfgFile(), '{"lastVault":')
    await expect(t.get()).rejects.toThrow('amadeus-config-unparseable')
    await fs.writeFile(cfgFile(), JSON.stringify({ activeVault: { ...refOf('A'), prefix: '../' } }))
    await expect(t.get()).rejects.toThrow('active-vault-malformed')
    await fs.writeFile(cfgFile(), JSON.stringify({ activeVault: { ...refOf('A'), account: 'signed-out' } }))
    await expect(t.get()).rejects.toThrow('active-vault-malformed')
  })

  it('refuses an untrusted sender', async () => {
    const t = await setup()
    await expect(t.get(t.state.main, { untrusted: true })).rejects.toThrow('forbidden')
  })
})

describe('active-vault:set', () => {
  it('writes only the six fields, broadcasts, and null clears it', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault', localVault: '/x/Vault' }))
    const t = await setup()
    await t.set({ ...refOf('A'), extra: 'dropped' })
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
    expect((await readCfg()).lastVault).toBe('/x/Vault') // lastVault 不动
    expect(t.broadcasts).toEqual([{ ch: t.K.changed, payload: { ref: refOf('A') } }])
    await t.set(null)
    expect('activeVault' in (await readCfg())).toBe(false)
    expect(t.broadcasts[1]).toEqual({ ch: t.K.changed, payload: { ref: null } })
    expect(await t.get()).toEqual({ ref: null, fallback: null })
  })

  it('another account’s ref throws account_changed and writes nothing; so does a signed-out session', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault' }))
    const before = await bytes()
    const t = await setup()
    await expect(t.set(refOf('B'))).rejects.toThrow('account_changed')
    env.creds = {}
    await expect(t.set(refOf('A'))).rejects.toThrow('account_changed')
    await expect(t.set({ ...refOf('A'), account: 'signed-out' })).rejects.toThrow() // 'signed-out' 不是哪个账号
    login('A')
    const racing = t.set(refOf('A')) // 排队等写的那一拍里换了账号:队列里再核一次
    login('B')
    await expect(racing).rejects.toThrow('account_changed')
    expect(await bytes()).toBe(before)
    expect(t.broadcasts).toEqual([])
  })

  it('an untrusted sender or a bad shape is refused before touching the file', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault' }))
    const before = await bytes()
    const t = await setup()
    await expect(t.set(refOf('A'), t.state.main, { untrusted: true })).rejects.toThrow('forbidden')
    for (const bad of [{ ...refOf('A'), kind: 'local' }, { ...refOf('A'), prefix: 'Other/' }, { ...refOf('A'), prefix: 'Amadeus/../' }, { ...refOf('A'), libraryId: '' }, 'x']) {
      await expect(t.set(bad)).rejects.toThrow('invalid_ref')
    }
    expect(await bytes()).toBe(before)
    // 旧位置库:libraryId = `${vaultId}:${prefix}`,文件夹名长也照收
    const prefix = `Amadeus/${'N'.repeat(250)}/`
    await t.set(refOf('A', { prefix, libraryId: `vault-1:${prefix}` }))
    expect((await readCfg()).activeVault.libraryId).toBe(`vault-1:${prefix}`)
  })

  it('the settings writer itself keeps only the six fields', async () => {
    const { writeActiveVault } = await import('./settings')
    await writeActiveVault({ ...refOf('A'), token: 'not-stored' } as never)
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
    expect(JSON.stringify(await readCfg())).not.toContain('not-stored')
    await expect(writeActiveVault({ ...refOf('A'), kind: 'local' } as never)).rejects.toThrow('invalid_ref')
  })

  it('an unreadable config is not overwritten', async () => {
    await fs.writeFile(cfgFile(), '{"lastVault":')
    const t = await setup()
    await expect(t.set(refOf('A'))).rejects.toThrow()
    expect(await bytes()).toBe('{"lastVault":')
  })

  it('ordinary config writes keep activeVault, and activeVault writes keep ordinary fields (either order)', async () => {
    const { writeConfig, readConfig } = await import('./settings')
    await writeConfig({ lastVault: '/x/Vault', localVault: '/x/Vault' })
    const t = await setup()
    await t.set(refOf('A'))
    await writeConfig({ lastPage: 'a.md' }) // rememberPage 那条:每次开页都写
    expect((await t.get()).ref).toEqual(refOf('A'))
    await writeConfig({ lastPage: 'b.md' })
    await t.set(refOf('A', { libraryId: 'lib-2' }))
    expect((await readConfig()).lastPage).toBe('b.md')
    expect((await readCfg()).activeVault.libraryId).toBe('lib-2')
    expect((await readConfig()) as Record<string, unknown>).not.toHaveProperty('activeVault') // readConfig 的快照不带它
  })
})

describe('switching to a local vault clears activeVault; restore does not', () => {
  it('switchVault drops activeVault in the same write and broadcasts { ref: null }; restoreVault leaves it', async () => {
    const local = path.join(env.root, 'Vault'), other = path.join(env.root, 'Notes')
    await fs.mkdir(local); await fs.mkdir(other)
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: local, localVault: local, vaults: [{ root: local }, { root: other }], activeVault: refOf('A') }))
    const { registerIpc } = await import('./ipc')
    const { IPC } = await import('@amadeus-shared/ipc')
    const { ACTIVE_VAULT_IPC } = await import('./activeVaultKeys')
    registerIpc(() => null)
    const invoke = (ch: string, ...a: unknown[]) => env.handlers.get(ch)!({ sender: { id: 1 } }, ...a)
    await invoke(IPC.restoreVault)
    expect((await readCfg()).activeVault).toEqual(refOf('A')) // 启动回落不清
    expect(env.sent.filter((s) => s.ch === ACTIVE_VAULT_IPC.changed)).toEqual([])
    await invoke(IPC.switchVault, other)
    const after = await readCfg()
    expect(after.lastVault).toBe(other)
    expect('activeVault' in after).toBe(false)
    expect(env.sent.filter((s) => s.ch === ACTIVE_VAULT_IPC.changed)).toEqual([{ ch: ACTIVE_VAULT_IPC.changed, payload: { ref: null } }])
    await invoke(IPC.switchVault, local) // 本来就没有在线库:不再广播
    expect(env.sent.filter((s) => s.ch === ACTIVE_VAULT_IPC.changed)).toHaveLength(1)
  })
})

describe('CloudHost.openLibrary / canOpenOnline', () => {
  it('canOpenOnline lights only after the main window reports, and goes dark on a new document or a destroyed window', async () => {
    const t = await setup()
    expect(t.host.canOpenOnline()).toBe(false)
    const view = fakeContents(2)
    t.capable(view) // View 窗不算
    t.capable(t.state.main, { untrusted: true })
    t.capable(t.state.main, { senderFrame: null }) // 旧文档的迟到上报
    expect(t.host.canOpenOnline()).toBe(false)
    t.capable()
    expect(t.host.canOpenOnline()).toBe(true)
    t.state.main!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }) // 同文档内跳转不算
    t.state.main!.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }) // 子框架不算
    expect(t.host.canOpenOnline()).toBe(true)
    t.state.main!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }) // 重载
    expect(t.host.canOpenOnline()).toBe(false)
    t.capable()
    expect(t.host.canOpenOnline()).toBe(true)
    t.state.main!.emit('render-process-gone', {}, { reason: 'crashed' }) // 渲染进程没了
    expect(t.host.canOpenOnline()).toBe(false)
    t.capable()
    t.state.main = fakeContents(3) // 主窗重建:新的那扇没报过
    expect(t.host.canOpenOnline()).toBe(false)
  })

  it('success: focuses the main window, asks it, resolves once it sets the same ref', async () => {
    const t = await setup()
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    expect(t.state.focus).toHaveBeenCalledTimes(1)
    const [ch, payload] = t.state.main!.send.mock.calls[0]
    expect(ch).toBe(t.K.openOnline)
    expect(payload.ref).toEqual(refOf('A'))
    expect(typeof payload.requestId).toBe('string')
    let done = false
    void opening.then(() => { done = true })
    await t.set(refOf('A', { libraryId: 'lib-2' })) // 别的库不算
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    await t.set(refOf('A'), fakeContents(5)) // 不是主窗发的不算
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    await t.set(refOf('A'))
    await expect(opening).resolves.toBeUndefined()
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
  })

  it('times out with switch_timeout when the renderer never sets', async () => {
    const t = await setup({ timeoutMs: 30 })
    t.capable()
    await expect(t.host.openLibrary(refOf('A'))).rejects.toThrow('switch_timeout')
    await expect(t.set(refOf('A'))).resolves.toBeUndefined() // 晚到的 set 照常写,不炸
  })

  it('fixed codes: no_main_window, renderer_unsupported, account_changed, invalid_ref — and nothing is sent', async () => {
    const t = await setup()
    await expect(t.host.openLibrary(refOf('A'))).rejects.toThrow('renderer_unsupported')
    expect(t.state.focus).not.toHaveBeenCalled()
    t.capable()
    await expect(t.host.openLibrary(refOf('B'))).rejects.toThrow('account_changed')
    await expect(t.host.openLibrary({ ...refOf('A'), prefix: '' } as never)).rejects.toThrow('invalid_ref')
    env.creds = {}
    await expect(t.host.openLibrary(refOf('A'))).rejects.toThrow('account_changed')
    login('A')
    t.state.main = null
    await expect(t.host.openLibrary(refOf('A'))).rejects.toThrow('no_main_window')
    expect(t.state.focus).not.toHaveBeenCalled()
  })

  it('a failure reported by the main window rejects with switch_failed; reports from other windows are ignored', async () => {
    const t = await setup({ timeoutMs: 200 })
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    const { requestId } = t.state.main!.send.mock.calls[0][1]
    let settled = false
    opening.then(() => { settled = true }, () => { settled = true })
    t.result({ requestId, ok: false, code: 'whatever' }, fakeContents(7)) // 别的窗口
    t.result({ requestId, ok: true }) // 成功只认 set
    t.result({ requestId: 'other', ok: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    t.result({ requestId, ok: false, code: 'bridge_failed' })
    await expect(opening).rejects.toThrow('switch_failed')
  })

  it('a failed set from the main window fails the waiting open right away', async () => {
    const t = await setup({ timeoutMs: 5_000 })
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    const started = Date.now()
    login('B') // 换库途中换了账号
    await expect(t.set(refOf('A'))).rejects.toThrow('account_changed')
    await expect(opening).rejects.toThrow('account_changed')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('legacy mirror migration', () => {
  const seed = async (over: Record<string, unknown> = {}) => {
    const { cloudVaultDir } = await import('./cloudPaths')
    const mirror = cloudVaultDir(`${CLOUD}::A`)
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(mirror, { recursive: true }); await fs.mkdir(local, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      lastVault: mirror, localVault: local, lastPage: 'a.md', vaults: [{ root: local }],
      cloudAccounts: { [ns('A')]: { cloudSync: { enabled: true, vaultId: 'vault-1' }, entrySync: [] } },
      ...over,
    }))
    return { mirror, local }
  }
  const migrate = async (userId: string | null = 'A') => (await import('./activeVault')).migrateLegacyMirrorVault(userId ? `${CLOUD}::${userId}` : null)

  it('lastVault on this account’s mirror + a vaultId → activeVault = the default library, lastVault = localVault; idempotent', async () => {
    const { local } = await seed()
    expect(await migrate()).toBe(true)
    const after = await readCfg()
    expect(after.activeVault).toEqual({ kind: 'online', account: ns('A'), libraryId: 'vault-1', vaultId: 'vault-1', prefix: 'Amadeus/', name: 'My Vault' })
    expect(after.lastVault).toBe(local)
    expect(after.lastPage).toBe('a.md')
    expect(after.cloudAccounts[ns('A')].cloudSync).toEqual({ enabled: true, vaultId: 'vault-1' })
    const once = await bytes()
    expect(await migrate()).toBe(false)
    expect(await bytes()).toBe(once)
    const t = await setup()
    expect((await t.get()).ref?.libraryId).toBe('vault-1')
  })

  it('changes nothing without a vaultId, when signed out, or when the config cannot be read', async () => {
    await seed({ cloudAccounts: { [ns('A')]: { cloudSync: { enabled: true } } } })
    let before = await bytes()
    expect(await migrate()).toBe(false)
    expect(await bytes()).toBe(before)
    await seed()
    before = await bytes()
    expect(await migrate(null)).toBe(false)
    expect(await bytes()).toBe(before)
    await fs.writeFile(cfgFile(), '{"lastVault":')
    await expect(migrate()).rejects.toThrow()
    expect(await bytes()).toBe('{"lastVault":')
  })

  it('leaves another account’s mirror, the unowned old mirror and an existing activeVault alone', async () => {
    const { mirror } = await seed()
    let before = await bytes()
    expect(await migrate('B')).toBe(false) // A 的镜像不当 B 的在线库
    expect(await bytes()).toBe(before)
    const { unscopedCloudVaultDir } = await import('./cloudPaths')
    await seed({ lastVault: unscopedCloudVaultDir() })
    before = await bytes()
    expect(await migrate()).toBe(false)
    expect(await bytes()).toBe(before)
    await seed({ lastVault: mirror, activeVault: refOf('A', { libraryId: 'lib-7' }) })
    before = await bytes()
    expect(await migrate()).toBe(false) // 用户设过的不覆盖
    expect(await bytes()).toBe(before)
  })

  it('no real local vault → lastVault is dropped (restore then makes the default vault); no config file → nothing is created', async () => {
    await seed({ localVault: undefined })
    expect(await migrate()).toBe(true)
    const after = await readCfg()
    expect(after.activeVault?.vaultId).toBe('vault-1')
    expect('lastVault' in after).toBe(false)
    const { mirror } = await seed()
    await seed({ localVault: mirror }) // 本机库那一格也是镜像:同样不当真目录
    expect(await migrate()).toBe(true)
    expect('lastVault' in (await readCfg())).toBe(false)
    await fs.rm(cfgFile())
    expect(await migrate()).toBe(false)
    await expect(fs.stat(cfgFile())).rejects.toThrow()
  })
})
