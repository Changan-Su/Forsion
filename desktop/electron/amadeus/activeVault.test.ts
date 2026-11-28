/**
 * 智库同步第 3 步 H3 12a:在线库的宿主接缝(契约 step34「H3 接口定稿」第 2 节)。
 * - active-vault:get:账号对 / 不对 / 没登录 / 配置读不了 / 形状不对;读不改盘;
 * - active-vault:set:只收可信发送方、账号不对不写、null 清掉、写完广播、和普通 writeConfig 两个顺序都不互相冲掉;
 * - 切本机库(switchVault)同一次落盘清掉 activeVault 并广播,restoreVault 的回落不清;
 * - CloudHost.openLibrary / canOpenOnline:成功、超时、无主窗、没报过 online-capable、渲染层报失败、账号不对;
 *   online-capable 只认主窗、主框架换文档 / wc 销毁后作废;
 * - 老配置迁移:该迁、缺 vaultId、读不了、没登录、已迁过幂等、别的账号 / 无主镜像、本机库也不在、已有 activeVault、没有配置文件;
 *   按需迁移 active-vault:migrate(U3a):只认主窗当前文档、回迁好的 ref / null、读不了就抛不写、迁移途中换号抛 account_changed;
 * - online-opened(U3a):只认主窗当前文档的报告,换文档 / 渲染进程没了 / 换号作废;插件数据按这份报告判在线,不看盘。
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

async function setup(opts: { timeoutMs?: number; accountId?: () => string | null } = {}) {
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
    accountId: opts.accountId ?? (() => (env.creds.token ? `${CLOUD}::${JSON.parse(Buffer.from(env.creds.token.split('.')[1], 'base64url').toString()).userId}` : null)),
    broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    timeoutMs: opts.timeoutMs,
  })
  host.register({ handle: (ch, fn) => handles.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) })
  // 缺省发送帧 = 那个 wc 现在的顶层文档(真 Electron 里 e.senderFrame === e.sender.mainFrame)
  const ev = (sender: unknown, extra: Record<string, unknown> = {}) => ({ sender, senderFrame: (sender as { mainFrame?: unknown } | null)?.mainFrame ?? {}, ...extra })
  return {
    host, state, broadcasts, K: ACTIVE_VAULT_IPC,
    get: (sender: unknown = state.main, extra: Record<string, unknown> = {}) => handles.get(ACTIVE_VAULT_IPC.get)!(ev(sender, extra)),
    set: (ref: unknown, sender: unknown = state.main, extra: Record<string, unknown> = {}, requestId?: string) => handles.get(ACTIVE_VAULT_IPC.set)!(ev(sender, extra), ref, requestId),
    result: (r: unknown, sender: unknown = state.main, extra: Record<string, unknown> = {}) => listeners.get(ACTIVE_VAULT_IPC.openOnlineResult)!(ev(sender, extra), r),
    reqId: (n = 0): string => state.main!.send.mock.calls[n][1].requestId,
    capable: (sender: unknown = state.main, extra: Record<string, unknown> = {}) => listeners.get(ACTIVE_VAULT_IPC.onlineCapable)!(ev(sender, extra)),
    opened: (ref: unknown, sender: unknown = state.main, extra: Record<string, unknown> = {}) => handles.get(ACTIVE_VAULT_IPC.onlineOpened)!(ev(sender, extra), ref),
    migrate: (sender: unknown = state.main, extra: Record<string, unknown> = {}) => handles.get(ACTIVE_VAULT_IPC.migrate)!(ev(sender, extra)),
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

describe('a failed read never leaves an empty config behind for later writes', () => {
  it('set / clear / migrate / local switch during a read failure all throw; after recovery a lastPage write keeps lastVault, vaults and cloudAccounts', async () => {
    const { cloudVaultDir } = await import('./cloudPaths')
    const mirror = cloudVaultDir(`${CLOUD}::A`)
    await fs.mkdir(mirror, { recursive: true })
    const seeded = {
      lastVault: mirror, localVault: '/x/Vault', vaults: [{ root: '/x/Vault' }, { root: '/x/Notes' }],
      cloudAccounts: { [ns('A')]: { cloudSync: { enabled: true, vaultId: 'vault-1' }, entrySync: [] } },
    }
    await fs.writeFile(cfgFile(), JSON.stringify(seeded))
    let failing = true
    const realRead = fs.readFile.bind(fs)
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (failing && String(p) === cfgFile()) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as never)
    try {
      const t = await setup()
      const { updateLocalVaultConfig, writeConfig } = await import('./settings')
      const { migrateMirrorActiveVault } = await import('./settings')
      const { isManagedCloudVault } = await import('./cloudPaths')
      await expect(t.set(refOf('A'))).rejects.toThrow('amadeus-config-unreadable')
      await expect(t.set(null)).rejects.toThrow('amadeus-config-unreadable')
      await expect(migrateMirrorActiveVault(`${CLOUD}::A`, (id) => cloudVaultDir(id), isManagedCloudVault)).rejects.toThrow('amadeus-config-unreadable')
      t.capable()
      await expect(t.migrate()).rejects.toThrow('amadeus-config-unreadable') // 按需迁移那条 IPC 同样抛、不写
      await expect(updateLocalVaultConfig((cfg) => { cfg.lastVault = '/x/Notes'; cfg.localVault = '/x/Notes' })).rejects.toThrow('amadeus-config-unreadable')
      failing = false // 磁盘恢复
      await writeConfig({ lastPage: 'z.md' })
      const after = JSON.parse(await realRead(cfgFile(), 'utf8') as string)
      expect(after.lastVault).toBe(mirror)
      expect(after.vaults).toEqual(seeded.vaults)
      expect(after.cloudAccounts[ns('A')].cloudSync).toEqual({ enabled: true, vaultId: 'vault-1' })
      expect(after.lastPage).toBe('z.md')
    } finally { spy.mockRestore() }
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

  it('picking the same local vault the online session sat on (lastVault unchanged) still clears it', async () => {
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(local)
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: local, localVault: local, vaults: [{ root: local }], activeVault: refOf('A') }))
    const { registerIpc } = await import('./ipc')
    const { IPC } = await import('@amadeus-shared/ipc')
    const { ACTIVE_VAULT_IPC } = await import('./activeVaultKeys')
    registerIpc(() => null)
    await env.handlers.get(IPC.switchVault)!({ sender: { id: 1 } }, local)
    expect('activeVault' in (await readCfg())).toBe(false)
    expect(env.sent.filter((s) => s.ch === ACTIVE_VAULT_IPC.changed)).toEqual([{ ch: ACTIVE_VAULT_IPC.changed, payload: { ref: null } }])
  })
})

describe('any config write that changes lastVault drops activeVault in the same write', () => {
  it('writeConfig / updateConfig moving lastVault drops it and broadcasts { ref: null }; same lastVault (any spelling) keeps it', async () => {
    const { writeConfig, updateConfig } = await import('./settings')
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: '/x/Vault', localVault: '/x/Vault', activeVault: refOf('A') }))
    const t = await setup()
    await writeConfig({ lastPage: 'a.md' }) // rememberPage
    await writeConfig({ lastVault: '/x/Vault/', lastPage: 'b.md' }) // 同一个库,写法不同
    await updateConfig((cfg) => { cfg.lastPage = 'c.md' }) // 读改写带回原样的 lastVault
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
    expect(t.broadcasts).toEqual([])
    await writeConfig({ lastVault: '/x/Notes', localVault: '/x/Notes' }) // Extend 的胶囊切本机就是这样写的
    const after = await readCfg()
    expect('activeVault' in after).toBe(false)
    expect(after.lastVault).toBe('/x/Notes')
    expect(t.broadcasts).toEqual([{ ch: t.K.changed, payload: { ref: null } }])
    await t.set(refOf('A')) // set 自己不动 lastVault
    expect((await readCfg()).lastVault).toBe('/x/Notes')
    await updateConfig((cfg) => { cfg.lastVault = '/x/Vault' })
    expect('activeVault' in (await readCfg())).toBe(false)
    expect(t.broadcasts.filter((b) => b.ch === t.K.changed).map((b) => b.payload)).toEqual([{ ref: null }, { ref: refOf('A') }, { ref: null }])
  })

  it('the host’s own startup fallbacks rewrite lastVault but keep activeVault (contract: falling back does not clear)', async () => {
    const { registerIpc } = await import('./ipc')
    const { IPC } = await import('@amadeus-shared/ipc')
    registerIpc(() => null)
    const invoke = (ch: string, ...a: unknown[]) => env.handlers.get(ch)!({ sender: { id: 1 } }, ...a)
    // 没有 lastVault(迁移删掉了、或首启)→ 建默认库
    await fs.writeFile(cfgFile(), JSON.stringify({ activeVault: refOf('A') }))
    const restored = await invoke(IPC.restoreVault)
    expect(restored.root).toBe(path.join(env.root, 'workspace', 'Amadeus'))
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
    expect((await readCfg()).lastVault).toBe(path.join(env.root, 'workspace', 'Amadeus'))
  })

  it('restoreVault moving off an unmountable mirror keeps activeVault too', async () => {
    const { unscopedCloudVaultDir } = await import('./cloudPaths')
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(local); await fs.mkdir(unscopedCloudVaultDir(), { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: unscopedCloudVaultDir(), localVault: local, activeVault: refOf('A') }))
    const { registerIpc } = await import('./ipc')
    const { IPC } = await import('@amadeus-shared/ipc')
    registerIpc(() => null)
    const restored = await env.handlers.get(IPC.restoreVault)!({ sender: { id: 1 } })
    expect(restored.root).toBe(local)
    expect((await readCfg()).lastVault).toBe(local)
    expect((await readCfg()).activeVault).toEqual(refOf('A'))
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

  it('success: focuses the main window, asks it, resolves once it sets the same ref with the same requestId', async () => {
    const t = await setup()
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    expect(t.state.focus).toHaveBeenCalledTimes(1)
    const [ch, payload] = t.state.main!.send.mock.calls[0]
    expect(ch).toBe(t.K.openOnline)
    expect(payload.ref).toEqual(refOf('A'))
    expect(typeof payload.requestId).toBe('string')
    const id = payload.requestId as string
    let done = false
    void opening.then(() => { done = true })
    await t.set(refOf('A', { libraryId: 'lib-2' }), t.state.main, {}, id) // 别的库不算
    await t.set(refOf('A'), fakeContents(5), {}, id) // 不是主窗发的不算
    await t.set(refOf('A')) // 不带 requestId 的普通切换不算
    await t.set(refOf('A'), t.state.main, {}, 'some-other-request') // 别的请求不算
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    await t.set(refOf('A'), t.state.main, {}, id)
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
    await expect(t.set(refOf('A'), t.state.main, {}, t.reqId())).rejects.toThrow('account_changed')
    await expect(opening).rejects.toThrow('account_changed')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('an account switch while the file is being written: no broadcast of the old account’s ref, and the open fails with account_changed', async () => {
    const t = await setup({ timeoutMs: 5_000 })
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => { login('B'); return realRename(a, b) })
    try {
      await expect(t.set(refOf('A'), t.state.main, {}, t.reqId())).rejects.toThrow('account_changed')
    } finally { spy.mockRestore() }
    await expect(opening).rejects.toThrow('account_changed')
    expect(t.broadcasts).toEqual([])
    expect(await t.get()).toEqual({ ref: null, fallback: { reason: 'account', name: 'Notes' } }) // 盘上那条留着,按账号回 fallback
  })

  it('a set still in flight from before a reload cannot confirm a new request; the reload itself fails the old one', async () => {
    const t = await setup({ timeoutMs: 5_000 })
    t.capable()
    const first = t.host.openLibrary(refOf('A'))
    const oldFrame = t.state.main!.mainFrame
    const firstId = t.reqId()
    // 主窗重载:新文档(新的顶层帧)
    t.state.main!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    t.state.main!.mainFrame = {}
    await expect(first).rejects.toThrow('switch_failed') // 发请求时那份文档没了
    t.capable()
    const second = t.host.openLibrary(refOf('A'))
    let done = false
    void second.then(() => { done = true }, () => { done = true })
    // 旧文档的迟到 set:旧帧 / 旧 requestId,都不算
    await expect(t.set(refOf('A'), t.state.main, { senderFrame: oldFrame }, firstId)).rejects.toThrow('forbidden')
    await t.set(refOf('A'), t.state.main, {}, firstId)
    t.result({ requestId: t.reqId(1), ok: false }, t.state.main, { senderFrame: oldFrame }) // 旧帧的失败回报也不算
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    await t.set(refOf('A'), t.state.main, {}, t.reqId(1))
    await expect(second).resolves.toBeUndefined()
  })

  it('get / set / result refuse a null sender frame or a frame that is not the current top document', async () => {
    const t = await setup({ timeoutMs: 200 })
    for (const extra of [{ senderFrame: null }, { senderFrame: {} }]) {
      await expect(t.get(t.state.main, extra)).rejects.toThrow('forbidden')
      await expect(t.set(null, t.state.main, extra)).rejects.toThrow('forbidden')
    }
    t.capable()
    const opening = t.host.openLibrary(refOf('A'))
    let settled = false
    opening.then(() => { settled = true }, () => { settled = true })
    t.result({ requestId: t.reqId(), ok: false }, t.state.main, { senderFrame: null })
    t.result({ requestId: t.reqId(), ok: false }, t.state.main, { senderFrame: {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    t.result({ requestId: t.reqId(), ok: false })
    await expect(opening).rejects.toThrow('switch_failed')
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

  it('startup wiring is off until U3a: with the switch off nothing is read or written', async () => {
    const { MIRROR_MIGRATION_ENABLED, migrateOnStartup } = await import('./activeVault')
    expect(MIRROR_MIGRATION_ENABLED).toBe(false)
    await seed()
    const before = await bytes()
    expect(await migrateOnStartup(`${CLOUD}::A`)).toBe(false)
    expect(await bytes()).toBe(before)
    await fs.writeFile(cfgFile(), '{"lastVault":') // 关着时连读都不读:坏配置也不报错
    await expect(migrateOnStartup(`${CLOUD}::A`)).resolves.toBe(false)
    await seed()
    expect(await migrateOnStartup(`${CLOUD}::A`, true)).toBe(true) // 打开以后就是上面那套迁移
    expect((await readCfg()).activeVault?.vaultId).toBe('vault-1')
  })

  it('a deleted local vault, or a plain file at its path, is not written as lastVault', async () => {
    const { local } = await seed()
    await fs.rm(local, { recursive: true })
    expect(await migrate()).toBe(true)
    expect('lastVault' in (await readCfg())).toBe(false)
    await seed()
    await fs.rm(local, { recursive: true }); await fs.writeFile(local, 'not a folder')
    expect(await migrate()).toBe(true)
    expect('lastVault' in (await readCfg())).toBe(false)
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

describe('active-vault:migrate (on demand, from the main window)', () => {
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
  const DEFAULT_LIB = { kind: 'online', account: ns('A'), libraryId: 'vault-1', vaultId: 'vault-1', prefix: 'Amadeus/', name: 'My Vault' }

  it('returns the migrated ref, writes exactly what the startup migration writes, and does not broadcast; a second call → null', async () => {
    await seed()
    await (await import('./activeVault')).migrateLegacyMirrorVault(`${CLOUD}::A`) // 启动接线开着时跑的那一段
    const viaStartup = await bytes()
    vi.resetModules()
    const { local } = await seed()
    const t = await setup()
    t.capable()
    expect(await t.migrate()).toEqual(DEFAULT_LIB)
    expect(await bytes()).toBe(viaStartup) // 同一段迁移逻辑,落盘逐字节一样
    expect((await readCfg()).lastVault).toBe(local)
    expect(t.broadcasts).toEqual([]) // 渲染层换完 impl 再 set,广播在 set
    const once = await bytes()
    expect(await t.migrate()).toBeNull() // 已有 activeVault:不迁
    expect(await bytes()).toBe(once)
  })

  it('only the main window’s current top document may ask; nothing is read or written otherwise', async () => {
    await seed()
    const before = await bytes()
    const t = await setup()
    await expect(t.migrate(fakeContents(2))).rejects.toThrow('forbidden') // View 窗
    await expect(t.migrate(t.state.main, { untrusted: true })).rejects.toThrow('forbidden')
    await expect(t.migrate(t.state.main, { senderFrame: null })).rejects.toThrow('forbidden') // 旧文档的迟到请求
    await expect(t.migrate(t.state.main, { senderFrame: {} })).rejects.toThrow('forbidden')
    t.state.main = null
    await expect(t.migrate(fakeContents(1))).rejects.toThrow('forbidden') // 没有主窗
    expect(await bytes()).toBe(before)
  })

  it('a document that has not reported online-capable (no relay channels) → renderer_unsupported; nothing is read or written', async () => {
    await seed()
    const before = await bytes()
    const t = await setup()
    await expect(t.migrate()).rejects.toThrow('renderer_unsupported')
    t.capable()
    t.state.main!.emit('render-process-gone', {}, { reason: 'crashed' }) // 报过的那份文档没了:新文档还没报
    await expect(t.migrate()).rejects.toThrow('renderer_unsupported')
    t.state.main = fakeContents(3) // 主窗重建:新的那扇没报过
    t.capable(fakeContents(2)) // 别的窗报的不算
    await expect(t.migrate()).rejects.toThrow('renderer_unsupported')
    expect(await bytes()).toBe(before)
    t.capable()
    expect(await t.migrate()).toEqual(DEFAULT_LIB)
  })

  it('nothing to migrate → null (signed out, no vaultId, not on the mirror); an unreadable config throws and stays as is', async () => {
    await seed()
    let before = await bytes()
    env.creds = {}
    const t = await setup()
    t.capable()
    expect(await t.migrate()).toBeNull()
    expect(await bytes()).toBe(before)
    login('A')
    await seed({ cloudAccounts: { [ns('A')]: { cloudSync: { enabled: true } } } })
    before = await bytes()
    expect(await t.migrate()).toBeNull()
    expect(await bytes()).toBe(before)
    await seed({ lastVault: path.join(env.root, 'Vault') })
    before = await bytes()
    expect(await t.migrate()).toBeNull()
    expect(await bytes()).toBe(before)
    await fs.writeFile(cfgFile(), '{"lastVault":')
    await expect(t.migrate()).rejects.toThrow('amadeus-config-unparseable')
    expect(await bytes()).toBe('{"lastVault":')
  })

  it('the account changed while migrating → account_changed; the written ref stays on disk for get to fall back on', async () => {
    await seed()
    let calls = 0
    const t = await setup({ accountId: () => (++calls === 1 ? `${CLOUD}::A` : `${CLOUD}::B`) })
    t.capable()
    await expect(t.migrate()).rejects.toThrow('account_changed')
    expect((await readCfg()).activeVault).toEqual(DEFAULT_LIB)
    expect(t.broadcasts).toEqual([])
  })
})

describe('online-opened: the main window reports which library the forwarding bridge has open', () => {
  it('only the main window’s current top document is believed; bad shapes are refused', async () => {
    const t = await setup()
    await expect(t.opened(refOf('A'), fakeContents(2))).rejects.toThrow('forbidden') // View 窗报了也不认
    await expect(t.opened(refOf('A'), t.state.main, { untrusted: true })).rejects.toThrow('forbidden')
    await expect(t.opened(refOf('A'), t.state.main, { senderFrame: null })).rejects.toThrow('forbidden')
    await expect(t.opened(refOf('A'), t.state.main, { senderFrame: {} })).rejects.toThrow('forbidden')
    for (const bad of [{ ...refOf('A'), kind: 'local' }, { ...refOf('A'), prefix: '../' }, 'x', undefined]) await expect(t.opened(bad)).rejects.toThrow('invalid_ref')
    expect(t.host.onlineOpened()).toBeNull()
    await t.opened(refOf('A'))
    expect(t.host.onlineOpened()).toEqual(refOf('A'))
    await t.opened(null) // 回本机库
    expect(t.host.onlineOpened()).toBeNull()
  })

  it('a new document, a gone renderer, a rebuilt main window or another account all read as local', async () => {
    const t = await setup()
    await t.opened(refOf('A'))
    t.state.main!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }) // 同文档内跳转不算
    expect(t.host.onlineOpened()).toEqual(refOf('A'))
    t.state.main!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }) // 重载:新文档的壳还没换库
    expect(t.host.onlineOpened()).toBeNull()
    t.state.main!.mainFrame = {}
    await t.opened(refOf('A'))
    t.state.main!.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(t.host.onlineOpened()).toBeNull()
    await t.opened(refOf('A'))
    login('B')
    expect(t.host.onlineOpened()).toBeNull() // 换了号:不给上一个账号的在线库开插件数据
    env.creds = {}
    expect(t.host.onlineOpened()).toBeNull()
    login('A')
    expect(t.host.onlineOpened()).toEqual(refOf('A'))
    t.state.main = fakeContents(3) // 主窗重建
    expect(t.host.onlineOpened()).toBeNull()
  })

  it('the module-level readout follows the registered host; the root is cloud://<vaultId>/<libraryId>', async () => {
    const { currentOnlineOpened, currentOnlineRoot, setRegisteredActiveVaultHostForTest } = await import('./activeVault')
    const t = await setup()
    expect(currentOnlineRoot()).toBeNull()
    await t.opened(refOf('A', { libraryId: 'vault-1:Amadeus/Lab/', prefix: 'Amadeus/Lab/' }))
    expect(currentOnlineOpened()?.libraryId).toBe('vault-1:Amadeus/Lab/')
    expect(currentOnlineRoot()).toBe('cloud://vault-1/vault-1:Amadeus/Lab/')
    setRegisteredActiveVaultHostForTest(null)
    expect(currentOnlineRoot()).toBeNull()
  })
})

describe('plugin storage judges "online" by the report, never by the saved activeVault', () => {
  const ID = 'demo'
  const storage = async (vaultRoot: string) => {
    const { createPluginStorageHost } = await import('./pluginStorage')
    const { currentOnlineRoot } = await import('./activeVault')
    // 12b 之后 amadeus/ipc.ts 照这样接:onlineRoot: currentOnlineRoot
    return createPluginStorageHost({ base: () => path.join(env.root, 'plugin-data'), vaultRoot: () => vaultRoot, onlineRoot: currentOnlineRoot })
  }

  it('activeVault on disk but the renderer fell back to the local vault (reported null): the vault layer reads, writes and gives a host path', async () => {
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(local)
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: local, localVault: local, activeVault: refOf('A') }))
    const t = await setup()
    expect((await t.get()).ref).toEqual(refOf('A')) // 盘上确实写着在线库
    await t.opened(null) // 渲染层回落:开的是 lastVault
    const h = await storage(local)
    await h.handle({ id: ID, vault: local, op: 'write', path: 'state.json', data: '{"n":1}' })
    expect(await h.handle({ id: ID, vault: local, op: 'readText', path: 'state.json' })).toBe('{"n":1}')
    const { storageVaultKey } = await import('@amadeus-shared/pluginStorage')
    expect(await h.handle({ id: ID, vault: local, op: 'hostPath', path: 'state.json' })).toBe(path.join(env.root, 'plugin-data', ID, 'vaults', storageVaultKey(local), 'state.json'))
    expect((await readCfg()).activeVault).toEqual(refOf('A')) // 回落不清
  })

  it('a renderer that has not reported at all is local too', async () => {
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(local)
    await fs.writeFile(cfgFile(), JSON.stringify({ lastVault: local, activeVault: refOf('A') }))
    await setup()
    const h = await storage(local)
    expect(typeof await h.handle({ id: ID, vault: local, op: 'hostPath' })).toBe('string')
  })

  it('reported online: the vault layer only takes the cloud root, has no host path, and import refuses with a fixed error', async () => {
    const local = path.join(env.root, 'Vault')
    await fs.mkdir(path.join(local, 'Plugins', ID), { recursive: true })
    await fs.writeFile(path.join(local, 'Plugins', ID, 'old.json'), 'old')
    const t = await setup()
    await t.opened(refOf('A'))
    const h = await storage(local) // 主进程还挂着上一个本机根
    const cloud = 'cloud://vault-1/lib-1'
    await expect(h.handle({ id: ID, vault: local, op: 'write', path: 'a.txt', data: 'x' })).rejects.toThrow('Vault changed')
    await h.handle({ id: ID, vault: cloud, op: 'write', path: 'a.txt', data: 'x' })
    expect(await h.handle({ id: ID, vault: cloud, op: 'readText', path: 'a.txt' })).toBe('x')
    const { STORAGE_IMPORT_NEEDS_LOCAL, storageVaultKey } = await import('@amadeus-shared/pluginStorage')
    expect(await fs.readFile(path.join(env.root, 'plugin-data', ID, 'vaults', storageVaultKey(cloud), 'a.txt'), 'utf8')).toBe('x') // 落在本机插件数据
    expect(await h.handle({ id: ID, vault: cloud, op: 'hostPath', path: 'a.txt' })).toBeNull()
    expect(await h.handle({ id: ID, op: 'hostPath', path: 'a.txt' })).toBe(path.join(env.root, 'plugin-data', ID, 'a.txt')) // 跟应用那一层照旧
    for (const vault of [cloud, local]) {
      await expect(h.handle({ id: ID, op: 'import', vault, from: `Plugins/${ID}`, to: '', migration: 'm1', allowed: [`Plugins/${ID}`], into: 'app' })).rejects.toThrow(STORAGE_IMPORT_NEEDS_LOCAL)
    }
    await t.opened(null) // 回本机库:一切照旧
    expect(await h.handle({ id: ID, op: 'import', vault: local, from: `Plugins/${ID}`, to: '', migration: 'm1', allowed: [`Plugins/${ID}`], into: 'app' })).toMatchObject({ status: 'complete', copied: 1 })
    expect(typeof await h.handle({ id: ID, vault: local, op: 'hostPath' })).toBe('string')
  })
})
