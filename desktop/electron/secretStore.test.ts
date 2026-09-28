import { describe, expect, it } from 'vitest'
import { createSecretStore, decideLevel, SecretStoreInsecureError, SecretStoreUnavailableError, SLOT_POLICY, type CryptoProvider, type SecretStoreDeps } from './secretStore'

const FILE = '/ud/device-secrets.json'
const SECRET = 'unit-secret-7f3a9c2e1d'

/** 可逆的假加密:异或 + 前缀,密文里不会出现明文(也不是 base64(明文))。`identity` = 负对照用的「不加密」。 */
function fakeCrypto(o: { available?: boolean; backend?: string; identity?: boolean } = {}) {
  const calls = { available: 0, backend: 0, encrypt: 0, decrypt: 0 }
  const st = { failDecrypt: false, available: o.available ?? true, backend: o.backend ?? 'gnome_libsecret' }
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  const crypto: CryptoProvider = {
    available: () => { calls.available++; return st.available },
    backend: () => { calls.backend++; return st.backend },
    encrypt: (s) => { calls.encrypt++; return o.identity ? Buffer.from(s, 'utf8') : Buffer.concat([Buffer.from('v10'), xor(Buffer.from(s, 'utf8'))]) },
    decrypt: (b) => {
      calls.decrypt++
      if (st.failDecrypt) throw new Error('keychain denied')
      return o.identity ? b.toString('utf8') : xor(b.subarray(3)).toString('utf8')
    },
  }
  return { crypto, calls, st }
}

/** 照 Chromium OSCrypt(os_crypt_mac.mm DeriveKey)的语义:一个进程只试一次钥匙串 —— 第一次调用按用户在系统框里的选择
 *  (allow / deny)定格,之后无论用户怎么改主意都不再试(`try_keychain_ = false`,「Never try it again」)。
 *  新进程 = 新建一个 provider。 */
function chromiumMacKeychain(user: { choice: 'allow' | 'deny' }) {
  const inner = fakeCrypto()
  let key: boolean | null = null // null = 还没试过钥匙串
  const derive = (): boolean => (key ??= user.choice === 'allow')
  const crypto: CryptoProvider = {
    available: () => derive(),
    backend: () => 'keychain',
    encrypt: (s) => { if (!derive()) throw new Error('Error while encrypting the text provided'); return inner.crypto.encrypt(s) },
    decrypt: (b) => { if (!derive()) throw new Error('Error while decrypting the ciphertext provided'); return inner.crypto.decrypt(b) },
  }
  return { crypto, calls: inner.calls, st: inner.st }
}

function memFs(init?: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(init ?? {}))
  const st = { failWrite: false, writes: 0 }
  const deps: Pick<SecretStoreDeps, 'read' | 'write' | 'rm'> = {
    read: async (f) => files.get(f) ?? null,
    write: async (f, data) => {
      if (st.failWrite) throw new Error('EXDEV rename failed') // 原子写:rename 失败时旧文件不动
      st.writes++
      files.set(f, JSON.stringify(data, null, 2))
    },
    rm: async (f) => { files.delete(f) },
  }
  return { files, st, deps }
}

function mk(o: { platform?: NodeJS.Platform; crypto?: ReturnType<typeof fakeCrypto>; files?: Record<string, string> } = {}) {
  const c = o.crypto ?? fakeCrypto()
  const fs = memFs(o.files)
  const store = createSecretStore({ file: FILE, crypto: c.crypto, platform: o.platform ?? 'linux', now: () => 1759000000000, ...fs.deps })
  return { store, c, fs }
}

/** 断言文件字节里没有明文 —— 连 base64 解码后的 data 字段也查(否则 base64(明文) 会骗过子串检查)。 */
function expectNoPlaintext(text: string | undefined, secret: string): void {
  expect(text, '文件不存在').toBeTruthy()
  expect(text!.includes(secret), '文件字节里直接出现了明文').toBe(false)
  const j = JSON.parse(text!) as { entries: Record<string, { data: string }> }
  for (const [slot, e] of Object.entries(j.entries)) {
    expect(Buffer.from(e.data, 'base64').toString('utf8').includes(secret), `${slot} 的 data 解码后就是明文(没加密)`).toBe(false)
  }
}

describe('decideLevel', () => {
  const p = (available: boolean, backend = 'unknown') => fakeCrypto({ available, backend }).crypto
  it('darwin / win32:加密可用即 os;不可用 = unavailable(绝不回落 plaintext —— 那是 Linux 无钥匙串的兼容路径)', () => {
    expect(decideLevel('darwin', p(true))).toEqual({ level: 'os', backend: 'keychain' })
    expect(decideLevel('darwin', p(false))).toEqual({ level: 'unavailable', backend: 'keychain' })
    expect(decideLevel('win32', p(true))).toEqual({ level: 'os', backend: 'dpapi' })
    expect(decideLevel('win32', p(false))).toEqual({ level: 'unavailable', backend: 'dpapi' })
  })
  it('linux:basic_text / unknown 一律 plaintext,libsecret / kwallet* 才是 os', () => {
    expect(decideLevel('linux', p(true, 'basic_text'))).toEqual({ level: 'plaintext', backend: 'basic_text' })
    expect(decideLevel('linux', p(true, 'unknown'))).toEqual({ level: 'plaintext', backend: 'unknown' })
    expect(decideLevel('linux', p(true, 'gnome_libsecret'))).toEqual({ level: 'os', backend: 'gnome_libsecret' })
    expect(decideLevel('linux', p(true, 'kwallet6'))).toEqual({ level: 'os', backend: 'kwallet6' })
    expect(decideLevel('linux', p(false, 'gnome_libsecret'))).toEqual({ level: 'plaintext', backend: 'gnome_libsecret' })
  })
  it('其余平台 → plaintext;darwin 上 available() 抛错 → unavailable', () => {
    expect(decideLevel('freebsd', p(true, 'gnome_libsecret')).level).toBe('plaintext')
    const boom: CryptoProvider = { available: () => { throw new Error('x') }, backend: () => 'kwallet', encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    expect(decideLevel('darwin', boom).level).toBe('unavailable')
    expect(decideLevel('linux', boom).level).toBe('plaintext')
  })
  it('槽策略:只有 unitCallerSecret 不许明文', () => {
    expect(SLOT_POLICY).toEqual({ unitPairing: { allowPlaintext: true }, externalToken: { allowPlaintext: true }, unitCallerSecret: { allowPlaintext: false } })
  })
})

describe('secretStore', () => {
  it('os 往返;文件字节(含 base64 解码后)不含明文', async () => {
    const { store, fs } = mk()
    await store.init()
    await store.set('unitPairing', SECRET)
    expect(await store.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
    expectNoPlaintext(fs.files.get(FILE), SECRET)
    const j = JSON.parse(fs.files.get(FILE)!)
    expect(j).toMatchObject({ v: 1, entries: { unitPairing: { enc: 'os', backend: 'gnome_libsecret', at: 1759000000000 } } })
    // 新进程(新 store 实例)从盘上读回
    const again = createSecretStore({ file: FILE, crypto: fakeCrypto().crypto, platform: 'linux', ...fs.deps })
    await again.init()
    expect(await again.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
  })

  it('plaintext 等级:配对 / token 兼容回落明文往返;unitCallerSecret 抛 secret-store-insecure 且文件字节不变', async () => {
    const { store, fs } = mk({ crypto: fakeCrypto({ backend: 'basic_text' }) })
    await store.init()
    await store.set('unitPairing', SECRET)
    await store.set('externalToken', 'tok-1')
    expect(await store.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
    expect(JSON.parse(fs.files.get(FILE)!).entries.unitPairing.enc).toBe('plain')
    expect(store.status()).toMatchObject({ level: 'plaintext', backend: 'basic_text', locked: [], restartRequired: false })
    const before = fs.files.get(FILE)
    const err = await store.set('unitCallerSecret', 'caller-secret').catch((e) => e)
    expect(err).toBeInstanceOf(SecretStoreInsecureError)
    expect(err.code).toBe('secret-store-insecure')
    expect(fs.files.get(FILE)).toBe(before)
    expect(await store.get('unitCallerSecret')).toEqual({ state: 'ok', value: null })
  })

  it('解密抛错 → locked:文件字节不变、之后不再反复解密(防钥匙串弹框风暴);retry 成功恢复', async () => {
    const c = fakeCrypto()
    const { store, fs } = mk({ crypto: c })
    await store.init()
    await store.set('unitPairing', SECRET)
    const bytes = fs.files.get(FILE)
    const fresh = createSecretStore({ file: FILE, crypto: c.crypto, platform: 'linux', ...fs.deps })
    await fresh.init()
    c.st.failDecrypt = true
    expect(await fresh.get('unitPairing')).toEqual({ state: 'locked' })
    expect(fresh.status()).toMatchObject({ locked: ['unitPairing'], lastError: 'decrypt-failed', restartRequired: false }) // 解密失败:进程内重试有意义
    const n = c.calls.decrypt
    expect(await fresh.get('unitPairing')).toEqual({ state: 'locked' })
    expect(c.calls.decrypt, '锁定后还在反复解密').toBe(n)
    expect(fs.files.get(FILE)).toBe(bytes)
    // 锁定期间写别的槽:锁住的那条原样保留
    await fresh.set('externalToken', 'tok-2')
    expect(JSON.parse(fs.files.get(FILE)!).entries.unitPairing).toEqual(JSON.parse(bytes!).entries.unitPairing)
    c.st.failDecrypt = false
    const st = await fresh.retry()
    expect(st.locked).toEqual([])
    expect(await fresh.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
    expect(await fresh.get('externalToken')).toEqual({ state: 'ok', value: 'tok-2' })
  })

  it('enc=plain 在 level=os 时 init 重新加密写回;enc=os 在 level=plaintext 时 locked 且不删', async () => {
    const plainFile = JSON.stringify({ v: 1, entries: { unitPairing: { enc: 'plain', data: SECRET, at: 1 } } }, null, 2)
    const up = mk({ files: { [FILE]: plainFile } })
    await up.store.init()
    const j = JSON.parse(up.fs.files.get(FILE)!)
    expect(j.entries.unitPairing.enc).toBe('os')
    expect(j.entries.unitPairing.at).toBe(1) // 保留原写入时刻
    expectNoPlaintext(up.fs.files.get(FILE), SECRET)
    expect(await up.store.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })

    const osBytes = up.fs.files.get(FILE)!
    const down = mk({ crypto: fakeCrypto({ backend: 'basic_text' }), files: { [FILE]: osBytes } })
    await down.store.init()
    expect(await down.store.get('unitPairing')).toEqual({ state: 'locked' })
    // Linux 这次没起钥匙串而盘上有加密条目:进程内救不回(后端在启动时就定了),要重启
    expect(down.store.status()).toMatchObject({ level: 'plaintext', locked: ['unitPairing'], lastError: 'os-crypto-unavailable', restartRequired: true })
    expect(down.fs.files.get(FILE)).toBe(osBytes)
  })

  it('wipe 删文件、清状态', async () => {
    const { store, fs } = mk()
    await store.init()
    await store.set('externalToken', 'tok')
    await store.wipe()
    expect(fs.files.has(FILE)).toBe(false)
    expect(await store.get('externalToken')).toEqual({ state: 'ok', value: null })
  })

  it('落盘失败(rename 失败):旧文件完好,内存里仍是旧值,错误抛给调用方', async () => {
    const { store, fs } = mk()
    await store.init()
    await store.set('externalToken', 'old')
    const bytes = fs.files.get(FILE)
    fs.st.failWrite = true
    await expect(store.set('externalToken', 'new')).rejects.toThrow(/rename/)
    await expect(store.set('externalToken', null)).rejects.toThrow(/rename/)
    expect(fs.files.get(FILE)).toBe(bytes)
    expect(await store.get('externalToken')).toEqual({ state: 'ok', value: 'old' })
  })

  it('没有任何槽时零次加密后端调用(懒加载:台架零改动、不弹钥匙串)', async () => {
    const { store, c, fs } = mk({ platform: 'darwin' })
    await store.init()
    for (const s of ['unitPairing', 'externalToken', 'unitCallerSecret'] as const) expect(await store.get(s)).toEqual({ state: 'ok', value: null })
    await store.set('externalToken', null) // 清一个本来就空的槽:不写盘、不碰加密
    expect(c.calls).toEqual({ available: 0, backend: 0, encrypt: 0, decrypt: 0 })
    expect(fs.st.writes).toBe(0)
  })

  it('文件解析不了 → 所有槽 locked;普通写入拒绝(不许顺手丢掉配对),force 才重写', async () => {
    const { store, fs } = mk({ files: { [FILE]: '{"v":1,"entries":' } })
    await store.init()
    expect(await store.get('unitPairing')).toEqual({ state: 'locked' })
    await expect(store.set('externalToken', 'x')).rejects.toMatchObject({ code: 'secret-store-unreadable' })
    expect(fs.files.get(FILE)).toBe('{"v":1,"entries":')
    await store.set('unitPairing', null, { force: true })
    expect(JSON.parse(fs.files.get(FILE)!)).toEqual({ v: 1, entries: {} })
    expect(store.status().locked).toEqual([])
  })

  it('读不懂的条目 / 未知槽在写别的槽时原样保留', async () => {
    const file = JSON.stringify({ v: 1, entries: { unitPairing: { enc: 'weird', blob: 1 }, futureSlot: { enc: 'os', data: 'zz', at: 2 } } }, null, 2)
    const { store, fs } = mk({ files: { [FILE]: file } })
    await store.init()
    expect(await store.get('unitPairing')).toEqual({ state: 'locked' })
    await store.set('externalToken', 'tok')
    const j = JSON.parse(fs.files.get(FILE)!)
    expect(j.entries.unitPairing).toEqual({ enc: 'weird', blob: 1 })
    expect(j.entries.futureSlot).toEqual({ enc: 'os', data: 'zz', at: 2 })
  })

  it('setVerified:从磁盘字节重新解密核对;对不上就把文件恢复成写入前的字节', async () => {
    const c = fakeCrypto()
    const { store, fs } = mk({ crypto: c })
    await store.init()
    expect(await store.setVerified('unitPairing', SECRET)).toBe(true)
    expectNoPlaintext(fs.files.get(FILE), SECRET)

    await store.set('externalToken', 'tok-a')
    const bytes = fs.files.get(FILE)
    // 加密后端「写得进、读不回」:解密出别的东西
    const realDecrypt = c.crypto.decrypt
    c.crypto.decrypt = () => 'garbage'
    expect(await store.setVerified('externalToken', 'tok-b')).toBe(false)
    expect(fs.files.get(FILE), '校验失败没有恢复成原字节').toBe(bytes)
    expect(store.status().lastError).toBe('migrate-verify-failed')
    c.crypto.decrypt = realDecrypt
    expect(await store.get('externalToken')).toEqual({ state: 'ok', value: 'tok-a' })

    // 原本没有文件:校验失败 → 删掉,不留半成品
    const empty = mk({ crypto: fakeCrypto() })
    await empty.store.init()
    empty.c.crypto.decrypt = () => 'garbage'
    expect(await empty.store.setVerified('unitPairing', SECRET)).toBe(false)
    expect(empty.fs.files.has(FILE)).toBe(false)
  })

  it('onChange:锁定 / 恢复时通知订阅方', async () => {
    const c = fakeCrypto()
    const { store, fs } = mk({ crypto: c })
    await store.init()
    await store.set('unitPairing', SECRET)
    const fresh = createSecretStore({ file: FILE, crypto: c.crypto, platform: 'linux', ...fs.deps })
    const seen: string[][] = []
    fresh.onChange((st) => seen.push(st.locked))
    await fresh.init()
    c.st.failDecrypt = true
    await fresh.get('unitPairing')
    c.st.failDecrypt = false
    await fresh.retry()
    // 第一条:init 读到条目、level 首次判定出来(也算状态变化);之后锁定、恢复各一条。
    expect(seen).toEqual([[], ['unitPairing'], []])
  })
})

describe('macOS / Windows 加密不可用(钥匙串被拒绝):不回落明文、进程内重试救不回', () => {
  const pairingFile = (c: CryptoProvider): string => JSON.stringify({ v: 1, entries: { unitPairing: { enc: 'os', backend: 'keychain', data: c.encrypt(SECRET).toString('base64'), at: 1 } } }, null, 2)

  it('拒绝钥匙串 → 配对锁定、restartRequired;retry 不谎报恢复(Chromium 一个进程只试一次);重启后选允许 → 恢复', async () => {
    const user = { choice: 'deny' as 'allow' | 'deny' }
    const bytes = pairingFile(fakeCrypto().crypto)
    const fs = memFs({ [FILE]: bytes })
    const p1 = chromiumMacKeychain(user)
    const store = createSecretStore({ file: FILE, crypto: p1.crypto, platform: 'darwin', ...fs.deps })
    await store.init()
    expect(await store.get('unitPairing')).toEqual({ state: 'locked' })
    expect(store.status()).toMatchObject({ level: 'unavailable', backend: 'keychain', locked: ['unitPairing'], restartRequired: true, lastError: 'os-crypto-unavailable' })
    // 用户按提示「这次选允许」再点重试:同一进程里 Chromium 不再问钥匙串 → 必须仍报 restartRequired,不能说恢复了
    user.choice = 'allow'
    const st = await store.retry()
    expect(st).toMatchObject({ level: 'unavailable', locked: ['unitPairing'], restartRequired: true })
    expect(await store.get('unitPairing')).toEqual({ state: 'locked' })
    expect(fs.files.get(FILE), '锁定时文件被动了').toBe(bytes)
    // 重启 = 新进程 = 新 provider:这次选允许 → 读回原配对(没有重新登记)
    const store2 = createSecretStore({ file: FILE, crypto: chromiumMacKeychain(user).crypto, platform: 'darwin', ...fs.deps })
    await store2.init()
    expect(await store2.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
    expect(store2.status()).toMatchObject({ level: 'os', locked: [], restartRequired: false })
  })

  it('unavailable 时任何槽都不落盘(抛 secret-store-unavailable,不写 enc:plain):配对、token 都一样,文件字节不变', async () => {
    const bytes = pairingFile(fakeCrypto().crypto)
    const { store, fs } = mk({ platform: 'darwin', crypto: fakeCrypto({ available: false }), files: { [FILE]: bytes } })
    await store.init()
    for (const slot of ['unitPairing', 'externalToken', 'unitCallerSecret'] as const) {
      const err = await store.set(slot, 'v-' + slot).catch((e) => e)
      expect(err, slot).toBeInstanceOf(SecretStoreUnavailableError)
      expect(err.code).toBe('secret-store-unavailable')
    }
    expect(fs.files.get(FILE)).toBe(bytes)
    expect(await store.setVerified('externalToken', 'tok'), '迁移也不许明文落盘').toBe(false)
    expect(fs.files.get(FILE)).toBe(bytes)
    expect(store.status().lastError).toBe('os-crypto-unavailable')

    // 空文件的 Mac:同样不建文件(旧实现这里会写出 {enc:'plain', data:'{unitId,secret}'})
    const empty = mk({ platform: 'darwin', crypto: fakeCrypto({ available: false }) })
    await empty.store.init()
    await expect(empty.store.set('unitPairing', SECRET)).rejects.toMatchObject({ code: 'secret-store-unavailable' })
    expect(empty.fs.files.has(FILE)).toBe(false)
    expect(empty.store.status()).toMatchObject({ level: 'unavailable', restartRequired: true })
  })
})

describe('setVerified × 读不懂的文件', () => {
  const V2 = JSON.stringify({ v: 2, entries: { unitPairing: { enc: 'os', data: 'newer-format' } } })

  it('只迁 token:文件读不懂 → 不写(不许为一个 token 丢掉读不懂的配对),字节不变、配对仍锁定、原因码 store-unreadable', async () => {
    const { store, fs } = mk({ files: { [FILE]: V2 } })
    await store.init()
    expect(await store.setVerified('externalToken', 'tok')).toBe(false)
    expect(fs.files.get(FILE)).toBe(V2)
    expect(fs.st.writes).toBe(0)
    expect(await store.get('unitPairing')).toEqual({ state: 'locked' })
    expect(store.status().lastError).toBe('store-unreadable')
  })

  it('迁配对:shell 里的配对按设计为准,force 重写', async () => {
    const { store, fs } = mk({ files: { [FILE]: V2 } })
    await store.init()
    expect(await store.setVerified('unitPairing', SECRET)).toBe(true)
    expect(await store.get('unitPairing')).toEqual({ state: 'ok', value: SECRET })
    expectNoPlaintext(fs.files.get(FILE), SECRET)
  })
})
