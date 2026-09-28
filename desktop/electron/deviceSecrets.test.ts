import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-userdata' }, safeStorage: {} }))

import { createDeviceSecrets, registerSecretsIpc, unitHostStartPlan, type DeviceSecrets, type ShellDeps } from './deviceSecrets'
import { createSecretStore, type CryptoProvider } from './secretStore'
import { createSerialQueue } from './configWrite'

const STORE = '/ud/device-secrets.json'
const SHELL = '/ud/tangu-desktop-config.json'
const LEGACY = '/tangu-agent-desktop2/tangu-desktop-config.json'
const SECRET = 'unit-secret-9b1c'

function fakeCrypto(o: { backend?: string } = {}) {
  const st = { backend: o.backend ?? 'gnome_libsecret', decryptOverride: null as null | (() => string), available: true }
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x33))
  const crypto: CryptoProvider = {
    available: () => st.available,
    backend: () => st.backend,
    encrypt: (s) => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(s))]),
    decrypt: (b) => (st.decryptOverride ? st.decryptOverride() : xor(b.subarray(3)).toString()),
  }
  return { crypto, st }
}

/** 内存文件系统 + main.ts readShellConfig 的播种语义(本端 shell 没有 mode → 从旧目录整份继承并落盘一次)。 */
function world(o: { shell?: Record<string, unknown>; legacy?: Record<string, unknown>; backend?: string; platform?: NodeJS.Platform } = {}) {
  const files = new Map<string, string>()
  if (o.shell) files.set(SHELL, JSON.stringify(o.shell))
  if (o.legacy) files.set(LEGACY, JSON.stringify(o.legacy))
  const c = fakeCrypto({ backend: o.backend })
  const counts = { storeWrites: 0, shellWrites: 0 }
  const fail = { shellWrite: false }
  const queue = createSerialQueue()
  const warns: string[] = []
  const readShell = async (): Promise<Record<string, any>> => {
    const cur = files.has(SHELL) ? JSON.parse(files.get(SHELL)!) : {}
    if (!cur.mode && files.has(LEGACY)) {
      const seeded = { ...JSON.parse(files.get(LEGACY)!), ...cur }
      files.set(SHELL, JSON.stringify(seeded))
      return seeded
    }
    return cur
  }
  const shellDeps: ShellDeps = {
    readShell,
    writeShell: async (s) => {
      if (fail.shellWrite) throw new Error('disk full')
      counts.shellWrites++
      files.set(SHELL, JSON.stringify(s))
    },
    queue,
  }
  const mkStore = () => createSecretStore({
    file: STORE, crypto: c.crypto, platform: o.platform ?? 'linux',
    read: async (f) => files.get(f) ?? null,
    write: async (f, d) => { counts.storeWrites++; files.set(f, JSON.stringify(d, null, 2)) },
    rm: async (f) => { files.delete(f) },
  })
  const boot = () => {
    const ds = createDeviceSecrets({ store: mkStore(), warn: (m) => warns.push(m) })
    return ds
  }
  const shell = (): Record<string, unknown> => JSON.parse(files.get(SHELL) ?? '{}')
  return { files, c, counts, fail, shellDeps, boot, shell, warns }
}

const LEGACY_SHELL = { mode: 'external', backendUrl: 'http://x', token: 'ext-token-1', unitHostEnabled: true, unitHostId: 'u-1', unitHostSecret: SECRET, modelId: 'm' }

describe('deviceSecrets 迁移', () => {
  it('三键移出 shell、其余键原样;值进加密存储且读得回;文件字节里没有明文', async () => {
    const w = world({ shell: LEGACY_SHELL })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.shell()).toEqual({ mode: 'external', backendUrl: 'http://x', unitHostEnabled: true, modelId: 'm' })
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } })
    expect(await ds.externalToken()).toBe('ext-token-1')
    const raw = w.files.get(STORE)!
    expect(raw.includes(SECRET)).toBe(false)
    expect(raw.includes('ext-token-1')).toBe(false)
    expect(w.files.get(SHELL)!.includes(SECRET)).toBe(false)
    expect(ds.status()).toMatchObject({ level: 'os', locked: [], lastError: null })
  })

  it('读回校验失败:shell 原样、store 无条目;期间配对按锁定、token 回落 shell;重试成功后完成迁移', async () => {
    const w = world({ shell: LEGACY_SHELL })
    w.c.st.decryptOverride = () => 'garbage' // 写得进、读不回
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.shell()).toEqual(LEGACY_SHELL)
    expect(w.files.has(STORE)).toBe(false)
    expect(await ds.unitPairing(), '校验没通过时配对当成空 = 自动重新登记(新 unit id)').toEqual({ state: 'locked' })
    expect(await ds.externalToken()).toBe('ext-token-1')
    expect(ds.status()).toMatchObject({ locked: ['unitPairing'], lastError: 'migrate-verify-failed' })
    expect(ds.publicStatus().locked).toEqual(['unitPairing'])
    expect(ds.remoteSessionsPermitted()).toBe(false)
    expect(unitHostStartPlan({ enabled: true, pairing: (await ds.unitPairing()).state })).toBe('web-only-locked')

    w.c.st.decryptOverride = null
    const st = await ds.retry()
    expect(st).toMatchObject({ locked: [], lastError: null })
    expect(w.shell()).toEqual({ mode: 'external', backendUrl: 'http://x', unitHostEnabled: true, modelId: 'm' })
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } })
    expect(ds.remoteSessionsPermitted()).toBe(true)
  })

  it('写 shell 时崩溃:下次启动值相同只删 shell(store 不重写),值不同以 shell 为准', async () => {
    const w = world({ shell: LEGACY_SHELL })
    w.fail.shellWrite = true
    await w.boot().init(w.shellDeps)
    expect(w.shell()).toEqual(LEGACY_SHELL) // 原件还在
    const writes = w.counts.storeWrites
    w.fail.shellWrite = false
    const ds2 = w.boot()
    await ds2.init(w.shellDeps)
    expect(w.counts.storeWrites, '值相同还重写了 store').toBe(writes)
    expect(w.shell().unitHostSecret).toBeUndefined()
    expect(await ds2.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } })

    // 降级旧版本后重新登记出了新配对、写回了 shell → 再升级:shell 为准
    w.files.set(SHELL, JSON.stringify({ ...w.shell(), unitHostId: 'u-2', unitHostSecret: 'secret-2', token: 'ext-token-2' }))
    const ds3 = w.boot()
    await ds3.init(w.shellDeps)
    expect(await ds3.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-2', secret: 'secret-2' } })
    expect(await ds3.externalToken()).toBe('ext-token-2')
    expect(Object.keys(w.shell())).not.toContain('unitHostSecret')
  })

  it('第二次运行没有任何写入', async () => {
    const w = world({ shell: LEGACY_SHELL })
    await w.boot().init(w.shellDeps)
    const snap = { ...w.counts }
    const ds = w.boot()
    await ds.init(w.shellDeps)
    await ds.unitPairing()
    await ds.externalToken()
    expect(w.counts).toEqual(snap)
  })

  it('旧目录播种来的秘密同样被迁移(旧目录原件不清理,C4 已覆盖)', async () => {
    const w = world({ legacy: LEGACY_SHELL })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.shell()).toEqual({ mode: 'external', backendUrl: 'http://x', unitHostEnabled: true, modelId: 'm' })
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } })
    expect(w.files.get(LEGACY)!.includes(SECRET)).toBe(true)
  })

  it('清空过的配对(空串)只从 shell 删键,不碰 store', async () => {
    const w = world({ shell: { mode: 'managed', unitHostId: '', unitHostSecret: '', token: '' } })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.shell()).toEqual({ mode: 'managed' })
    expect(w.counts.storeWrites).toBe(0)
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: null })
  })
})

describe('deviceSecrets 门控与读写', () => {
  it('unitHostStartPlan 全表', () => {
    expect(unitHostStartPlan({ enabled: false, pairing: 'ok' })).toBe('off')
    expect(unitHostStartPlan({ enabled: false, pairing: 'locked' })).toBe('off')
    expect(unitHostStartPlan({ enabled: true, pairing: 'ok' })).toBe('start')
    expect(unitHostStartPlan({ enabled: true, pairing: 'locked' })).toBe('web-only-locked')
  })

  it('remoteSessionsPermitted 真值表:init 前 / plaintext / 配对锁定 / 配对是明文条目 → false;os 且配对可读 → true', async () => {
    const w = world({ shell: LEGACY_SHELL })
    const ds = w.boot()
    expect(ds.remoteSessionsPermitted(), 'init 之前').toBe(false)
    await ds.init(w.shellDeps)
    await ds.unitPairing()
    expect(ds.remoteSessionsPermitted()).toBe(true)

    const empty = world({ shell: { mode: 'managed' } })
    const dsE = empty.boot()
    await dsE.init(empty.shellDeps)
    expect(dsE.remoteSessionsPermitted(), '还没配对、存储是 os:允许(开关本身的前提是存储安全)').toBe(true)

    const plain = world({ shell: LEGACY_SHELL, backend: 'basic_text' })
    const dsP = plain.boot()
    await dsP.init(plain.shellDeps)
    expect(await dsP.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } }) // 兼容回落:设备页照常
    expect(dsP.status().level).toBe('plaintext')
    expect(dsP.remoteSessionsPermitted()).toBe(false)

    // 配对锁定:把 store 里的密文换成解不开的
    const locked = world({ shell: LEGACY_SHELL })
    await locked.boot().init(locked.shellDeps)
    locked.c.st.decryptOverride = () => { throw new Error('keychain denied') }
    const dsL = locked.boot()
    await dsL.init(locked.shellDeps)
    expect(await dsL.unitPairing()).toEqual({ state: 'locked' })
    expect(dsL.remoteSessionsPermitted()).toBe(false)
    expect(locked.files.get(STORE)).toBeTruthy() // locked ≠ absent:不删

    // level=os 但配对还是明文条目(升级失败的残留)
    const plainEntry = world({ shell: { mode: 'managed' } })
    plainEntry.files.set(STORE, JSON.stringify({ v: 1, entries: { unitPairing: { enc: 'plain', data: JSON.stringify({ unitId: 'u', secret: 's' }), at: 1 } } }))
    plainEntry.c.crypto.encrypt = () => { throw new Error('encrypt failed') }
    const dsPE = plainEntry.boot()
    await dsPE.init(plainEntry.shellDeps)
    expect(dsPE.remoteSessionsPermitted()).toBe(false)
  })

  it('调用方凭据(P2)fail-closed:plaintext 时 setCallerSecret 抛 secret-store-insecure 且不落盘;os 时往返', async () => {
    const plain = world({ shell: { mode: 'managed' }, backend: 'basic_text' })
    const dsP = plain.boot()
    await dsP.init(plain.shellDeps)
    await expect(dsP.setCallerSecret('cs')).rejects.toMatchObject({ code: 'secret-store-insecure' })
    expect(plain.files.has(STORE)).toBe(false)
    const os = world({ shell: { mode: 'managed' } })
    const ds = os.boot()
    await ds.init(os.shellDeps)
    await ds.setCallerSecret('cs')
    expect(await ds.callerSecret()).toEqual({ state: 'ok', value: 'cs' })
    expect(ds.publicStatus().locked).toEqual([])
  })

  it('external token:同值不重写;空串 = 清掉', async () => {
    const w = world({ shell: { mode: 'external' } })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    await ds.setExternalToken('t1')
    const n = w.counts.storeWrites
    await ds.setExternalToken('t1')
    expect(w.counts.storeWrites).toBe(n)
    await ds.setExternalToken('')
    expect(await ds.externalToken()).toBe('')
  })

  it('重新登记本机只在配对锁定时可用:没锁定 → not-locked 且什么都不动(可信渲染层代码不许随手换掉本机身份)', async () => {
    const w = world({ shell: LEGACY_SHELL })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    const bytes = w.files.get(STORE)
    const confirm = vi.fn(async () => true)
    await expect(ds.resetUnitPairing({ confirm })).rejects.toThrow('not-locked')
    expect(confirm, '没锁定时连确认框都不该弹').not.toHaveBeenCalled()
    expect(w.files.get(STORE)).toBe(bytes)
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: { unitId: 'u-1', secret: SECRET } })
  })

  it('重新登记本机:用户在确认框里取消 → 什么都不动;确认 → 清空', async () => {
    const w = world({ shell: LEGACY_SHELL })
    await w.boot().init(w.shellDeps)
    w.c.st.decryptOverride = () => { throw new Error('keychain reset') }
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(await ds.unitPairing()).toEqual({ state: 'locked' })
    const bytes = w.files.get(STORE)
    await ds.resetUnitPairing({ confirm: async () => false })
    expect(w.files.get(STORE)).toBe(bytes)
    expect(ds.status().locked).toEqual(['unitPairing'])
    await ds.resetUnitPairing({ confirm: async () => true })
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: null })
  })

  it('重新登记本机:清掉 store 里的配对与 shell 残留(迁移没做完的那份),之后配对为空', async () => {
    const w = world({ shell: LEGACY_SHELL })
    w.c.st.decryptOverride = () => 'garbage'
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(await ds.unitPairing()).toEqual({ state: 'locked' })
    w.c.st.decryptOverride = null
    const st = await ds.resetUnitPairing()
    expect(st.locked).toEqual([])
    expect(w.shell().unitHostSecret).toBeUndefined()
    expect(w.shell().unitHostId).toBeUndefined()
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: null })
  })

  it('init 之前被调用:按锁定 / 空处理并出声,不挂死', async () => {
    const w = world({ shell: LEGACY_SHELL })
    const ds = w.boot()
    expect(await ds.unitPairing()).toEqual({ state: 'locked' })
    expect(await ds.externalToken()).toBe('')
    await expect(ds.setUnitPairing(null)).rejects.toThrow('device-secrets-not-ready')
    expect(w.warns.length).toBe(3)
  })

  it('wipe:删存储文件', async () => {
    const w = world({ shell: LEGACY_SHELL })
    const ds = w.boot()
    await ds.init(w.shellDeps)
    await ds.wipe()
    expect(w.files.has(STORE)).toBe(false)
    expect(await ds.unitPairing()).toEqual({ state: 'ok', value: null })
  })

  it('IPC 四个通道都只给可信发送方', async () => {
    const handlers = new Map<string, (e: unknown) => Promise<unknown>>()
    const ipc = { handle: (ch: string, fn: (e: unknown) => Promise<unknown>) => { handlers.set(ch, fn) } }
    const refresh = vi.fn(async () => {})
    const relaunch = vi.fn()
    const confirmReset = vi.fn(async () => true)
    registerSecretsIpc(ipc as never, { isTrustedSender: () => false, refreshUnitHost: refresh, relaunch, confirmReset })
    expect([...handlers.keys()].sort()).toEqual(['secrets:relaunch', 'secrets:resetUnitPairing', 'secrets:retry', 'secrets:status'])
    for (const fn of handlers.values()) await expect(fn({})).rejects.toThrow('forbidden')
    expect(refresh).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(confirmReset).not.toHaveBeenCalled()
  })

  it('IPC secrets:relaunch 只在 restartRequired 时放行;secrets:resetUnitPairing 走主进程确认框,取消不刷新 unitHost', async () => {
    const mkIpc = (ds: DeviceSecrets, confirm: boolean) => {
      const handlers = new Map<string, (e: unknown) => Promise<unknown>>()
      const ipc = { handle: (ch: string, fn: (e: unknown) => Promise<unknown>) => { handlers.set(ch, fn) } }
      const d = { refresh: vi.fn(async () => {}), relaunch: vi.fn(), confirmReset: vi.fn(async () => confirm) }
      registerSecretsIpc(ipc as never, { isTrustedSender: () => true, refreshUnitHost: d.refresh, relaunch: d.relaunch, confirmReset: d.confirmReset, impl: () => ds })
      return { call: (ch: string) => handlers.get(ch)!({ sender: {} }), ...d }
    }
    // 正常:不许重启、不许重新登记
    const ok = world({ shell: LEGACY_SHELL })
    const dsOk = ok.boot()
    await dsOk.init(ok.shellDeps)
    const a = mkIpc(dsOk, true)
    await expect(a.call('secrets:relaunch')).rejects.toThrow('not-restart-required')
    expect(a.relaunch).not.toHaveBeenCalled()
    await expect(a.call('secrets:resetUnitPairing')).rejects.toThrow('not-locked')
    expect(a.confirmReset).not.toHaveBeenCalled()

    // macOS 钥匙串被拒绝:重启放行;重新登记拒绝(新配对存不下)
    const mac = world({ shell: LEGACY_SHELL, platform: 'darwin' })
    mac.c.st.available = false
    const dsMac = mac.boot()
    await dsMac.init(mac.shellDeps)
    const b = mkIpc(dsMac, true)
    await expect(b.call('secrets:resetUnitPairing')).rejects.toThrow('restart-required')
    expect(b.confirmReset).not.toHaveBeenCalled()
    await b.call('secrets:relaunch')
    expect(b.relaunch).toHaveBeenCalledTimes(1)

    // 解密失败的锁定:确认框取消 → 不动、不刷新;确认 → 清空并刷新
    const lk = world({ shell: LEGACY_SHELL })
    await lk.boot().init(lk.shellDeps)
    lk.c.st.decryptOverride = () => { throw new Error('keychain reset') }
    const dsL = lk.boot()
    await dsL.init(lk.shellDeps)
    await dsL.unitPairing()
    const c = mkIpc(dsL, false)
    await c.call('secrets:resetUnitPairing')
    expect(c.confirmReset).toHaveBeenCalledTimes(1)
    expect(c.refresh).not.toHaveBeenCalled()
    expect(dsL.status().locked).toEqual(['unitPairing'])
    const d2 = mkIpc(dsL, true)
    await d2.call('secrets:resetUnitPairing')
    expect(d2.refresh).toHaveBeenCalledTimes(1)
    expect(await dsL.unitPairing()).toEqual({ state: 'ok', value: null })
  })
})

describe('deviceSecrets × macOS 钥匙串被拒绝(level=unavailable)', () => {
  it('迁移:不落盘明文、shell 原样;配对锁定、token 回落 shell;restartRequired;重试救不回;重新登记被拒', async () => {
    const w = world({ shell: LEGACY_SHELL, platform: 'darwin' })
    w.c.st.available = false
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.files.has(STORE), '拒绝钥匙串后把配对明文写进了 device-secrets.json').toBe(false)
    expect(w.shell()).toEqual(LEGACY_SHELL)
    expect(await ds.unitPairing()).toEqual({ state: 'locked' })
    expect(await ds.externalToken()).toBe('ext-token-1')
    expect(ds.publicStatus()).toMatchObject({ level: 'unavailable', backend: 'keychain', locked: ['unitPairing'], restartRequired: true })
    expect(ds.remoteSessionsPermitted()).toBe(false)
    const st = await ds.retry() // Chromium:同一进程不再试钥匙串 → 仍不可用
    expect(st).toMatchObject({ restartRequired: true, locked: ['unitPairing'] })
    await expect(ds.resetUnitPairing({ confirm: async () => true })).rejects.toThrow('restart-required')
    expect(w.shell()).toEqual(LEGACY_SHELL)
  })

  it('配对为空也按锁定处理:新登记出来的配对存不下 → UnitHost 不许起(否则每次启动铸一个新 unit id)', async () => {
    const w = world({ shell: { mode: 'managed', unitHostEnabled: true }, platform: 'darwin' })
    w.c.st.available = false
    const ds = w.boot()
    await ds.init(w.shellDeps)
    const pr = await ds.unitPairing()
    expect(pr).toEqual({ state: 'locked' })
    expect(unitHostStartPlan({ enabled: true, pairing: pr.state })).toBe('web-only-locked')
    await expect(ds.setUnitPairing({ unitId: 'u-new', secret: 's' })).rejects.toMatchObject({ code: 'secret-store-unavailable' })
    expect(w.files.has(STORE)).toBe(false)
    // 同一台 Mac 钥匙串可用时:空配对照常 = 可以入册
    const okMac = world({ shell: { mode: 'managed', unitHostEnabled: true }, platform: 'darwin' })
    const ds2 = okMac.boot()
    await ds2.init(okMac.shellDeps)
    expect(await ds2.unitPairing()).toEqual({ state: 'ok', value: null })
  })
})

describe('deviceSecrets × 读不懂的存储文件 / shell 残留 token', () => {
  it('store 读不懂 + shell 只有 token:store 字节不变、配对仍锁定(不会变成「空」去重新登记)、token 回落 shell', async () => {
    const V2 = JSON.stringify({ v: 2, entries: { unitPairing: { enc: 'os', data: 'newer-format' } } })
    const w = world({ shell: { mode: 'external', token: 'tok', unitHostEnabled: true } })
    w.files.set(STORE, V2)
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.files.get(STORE)).toBe(V2)
    expect(w.shell()).toEqual({ mode: 'external', token: 'tok', unitHostEnabled: true })
    const pr = await ds.unitPairing()
    expect(pr).toEqual({ state: 'locked' })
    expect(unitHostStartPlan({ enabled: true, pairing: pr.state })).toBe('web-only-locked')
    expect(await ds.externalToken()).toBe('tok')
    expect(ds.status().lastError).toBe('store-unreadable')
  })

  it('迁移没做完时用户填了新 token:shell 里的旧原件被删掉,重启后仍是新 token(不被「shell 为准」盖回)', async () => {
    const w = world({ shell: { mode: 'external', token: 'old-tok' } })
    w.c.st.decryptOverride = () => 'garbage' // 读回校验失败 → token 留在 shell(pending)
    const ds = w.boot()
    await ds.init(w.shellDeps)
    expect(w.shell().token).toBe('old-tok')
    expect(await ds.externalToken()).toBe('old-tok')
    w.c.st.decryptOverride = null
    await w.shellDeps.queue(() => ds.setExternalToken('new-tok')) // 与 main.ts writeConfigPatch 同:在 configQueue 内调用
    expect('token' in w.shell(), 'shell 里还躺着旧 token').toBe(false)
    const again = w.boot()
    await again.init(w.shellDeps)
    expect(await again.externalToken()).toBe('new-tok')
  })
})
