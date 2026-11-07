/** 凭据文件那半(宿主留下的):auth.json 私有权限、按账号的云同步设置。device flow / 多账号记忆的用例随代码搬去了 Forsion Extend(test/auth.test.ts)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountCore, type AccountCoreDeps } from './accountCore'
import { loadTanguCreds, saveTanguCreds, assertTanguCredsWritable, forsionAccountId, loadAccountCloudSettings, saveAccountCloudSettings } from './forsionAuth'

const cloud = 'https://accounts.example.test'
const jwt = (userId: string): string => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.y`

describe('desktop account credential files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forsion-auth-test-'))
    vi.stubEnv('TANGU_HOME', dir)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('auth.json 私有权限;saveTanguCreds 只写 auth.json(不再顺手记多账号)', () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a'), model: 'local-choice' })
    expect(loadTanguCreds()).toEqual({ cloudUrl: cloud, token: jwt('a'), model: 'local-choice' })
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(() => statSync(join(dir, 'auth-accounts.json'))).toThrow()
  })

  it('cloud sync permission and last-sync state belong to each account', () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    saveAccountCloudSettings({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    saveTanguCreds({ cloudUrl: cloud, token: jwt('b') })
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: false, forsionLastSyncedAt: 0 })
    saveAccountCloudSettings({ forsionSyncEnabled: true, forsionLastSyncedAt: 200 })
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    expect(forsionAccountId(cloud, jwt('a'))).not.toBe(forsionAccountId(cloud, jwt('b')))
    saveTanguCreds({ cloudUrl: cloud })
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: false, forsionLastSyncedAt: 0 })
  })

  it('auth.json 读不出来 ≠ 没有:保留上次读到的内容,保存被拒、文件原样;删掉坏文件后恢复', () => {
    const file = join(dir, 'auth.json')
    const good = { cloudUrl: cloud, token: jwt('a'), model: 'local-choice' }
    saveTanguCreds(good)
    expect(loadTanguCreds()).toEqual(good)
    for (const bad of ['', '{"cloudUrl":', '[]', 'null', '{"token":1}']) {
      writeFileSync(file, bad)
      expect(loadTanguCreds()).toEqual(good)
      expect(() => saveTanguCreds({ cloudUrl: cloud, token: jwt('b') })).toThrow(/unreadable/)
      expect(readFileSync(file, 'utf8')).toBe(bad)
    }
    rmSync(file)
    mkdirSync(file) // 读本身就失败(非 ENOENT)
    expect(loadTanguCreds()).toEqual(good)
    expect(() => saveTanguCreds({ cloudUrl: cloud })).toThrow(/unreadable/)
    rmSync(file, { recursive: true })
    expect(loadTanguCreds()).toEqual({})
    saveTanguCreds({ cloudUrl: cloud, token: jwt('b') })
    expect(loadTanguCreds()).toEqual({ cloudUrl: cloud, token: jwt('b') })
  })

  it('一上来就是坏文件:没有上次内容可用,读到空但照样拒写', () => {
    const file = join(dir, 'auth.json')
    writeFileSync(file, '')
    expect(loadTanguCreds()).toEqual({})
    expect(() => saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })).toThrow(/unreadable/)
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  describe('明确登录能救回来', () => {
    const core = (): ReturnType<typeof createAccountCore> => createAccountCore({
      loadCreds: loadTanguCreds, saveCreds: saveTanguCreds, assertCredsWritable: assertTanguCredsWritable,
      saveConfig: async () => {}, loadConfig: async () => ({ mode: 'external' }), refreshUnitHost: () => {},
      renderers: () => [], broadcast: () => {}, stopSync: () => null, restartSync: () => null, log: () => {},
    } as unknown as AccountCoreDeps)
    const kept = (): string[] => readdirSync(join(dir, 'config-backup')).filter((name) => name.startsWith('auth.json.bad-'))

    it('启动时就是坏文件:登录走完整条链,坏文件原样另存(0600),auth.json 换成新凭据', async () => {
      const file = join(dir, 'auth.json')
      for (const [i, bad] of ['', '{"token":"half'].entries()) {
        writeFileSync(file, bad)
        await core().commit({ cloudUrl: cloud, token: jwt('b') })
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ cloudUrl: cloud, token: jwt('b') })
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(kept()).toHaveLength(i + 1)
      }
      const contents = kept().map((name) => readFileSync(join(dir, 'config-backup', name), 'utf8'))
      expect(contents.sort()).toEqual(['', '{"token":"half'])
      for (const name of kept()) expect(statSync(join(dir, 'config-backup', name)).mode & 0o777).toBe(0o600)
      expect(() => saveTanguCreds({ cloudUrl: cloud })).not.toThrow() // 修好了:之后的普通保存不再被拒
    })

    it('运行中坏了:登录保留上次读到的 model', async () => {
      saveTanguCreds({ cloudUrl: cloud, token: jwt('a'), model: 'local-choice' })
      writeFileSync(join(dir, 'auth.json'), '')
      await core().commit({ cloudUrl: cloud, token: jwt('b') })
      expect(loadTanguCreds()).toEqual({ cloudUrl: cloud, token: jwt('b'), model: 'local-choice' })
    })

    it('好文件上登录不留 .bad-*', async () => {
      saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
      await core().commit({ cloudUrl: cloud, token: jwt('b') })
      expect(existsSync(join(dir, 'config-backup'))).toBe(false)
    })

    it('坏文件留不下来就整次失败(读本身就失败的目录),不覆盖', () => {
      const file = join(dir, 'auth.json')
      mkdirSync(file)
      expect(() => saveTanguCreds({ cloudUrl: cloud, token: jwt('b') }, { signIn: true })).toThrow()
      expect(statSync(file).isDirectory()).toBe(true)
    })

    it('登出不放行:clear 仍然拒,坏文件原样,不留 .bad-*', async () => {
      const file = join(dir, 'auth.json')
      saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
      writeFileSync(file, '')
      await expect(core().clear()).rejects.toThrow(/unreadable/)
      expect(readFileSync(file, 'utf8')).toBe('')
      expect(existsSync(join(dir, 'config-backup'))).toBe(false)
    })
  })

  it('改 loadTanguCreds 的返回值不影响下一次读(登出 delete token 的就是它)', () => {
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    loadTanguCreds()
    writeFileSync(join(dir, 'auth.json'), '')
    delete loadTanguCreds().token
    expect(loadTanguCreds().token).toBe(jwt('a'))
  })

  it('cloud-account-settings.json 读不出来:读到上次的设置,保存不写回,别的账号的设置不会被冲掉', () => {
    const file = join(dir, 'cloud-account-settings.json')
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    saveAccountCloudSettings({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    for (const bad of ['', '{"accounts":', '{"accounts":"not-an-object"}']) {
      writeFileSync(file, bad)
      saveAccountCloudSettings({ forsionLastSyncedAt: 200 })
      expect(readFileSync(file, 'utf8')).toBe(bad)
      expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: true, forsionLastSyncedAt: 100 })
    }
    rmSync(file)
    saveAccountCloudSettings({ forsionLastSyncedAt: 200 })
    expect(loadAccountCloudSettings()).toEqual({ forsionSyncEnabled: false, forsionLastSyncedAt: 200 })
  })

  it('运行中 auth.json 坏了不算外部登出:watcher 不走换号链(Extend 的钩子会把这个账号忘掉)', async () => {
    vi.useFakeTimers()
    saveTanguCreds({ cloudUrl: cloud, token: jwt('a') })
    const core = createAccountCore({
      loadCreds: loadTanguCreds, saveCreds: saveTanguCreds, assertCredsWritable: assertTanguCredsWritable,
      renderers: () => [], log: () => {},
    } as unknown as AccountCoreDeps)
    const change = vi.fn()
    core.onExternalChange(change)
    writeFileSync(join(dir, 'auth.json'), '')
    core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(300)
    expect(change).not.toHaveBeenCalled()
  })
})
