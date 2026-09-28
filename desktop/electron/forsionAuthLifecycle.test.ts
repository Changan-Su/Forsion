/** 凭据文件那半(宿主留下的):auth.json 私有权限、按账号的云同步设置。device flow / 多账号记忆的用例随代码搬去了 Forsion Extend(test/auth.test.ts)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTanguCreds, saveTanguCreds, forsionAccountId, loadAccountCloudSettings, saveAccountCloudSettings } from './forsionAuth'

const cloud = 'https://accounts.example.test'
const jwt = (userId: string): string => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.y`

describe('desktop account credential files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forsion-auth-test-'))
    vi.stubEnv('TANGU_HOME', dir)
  })
  afterEach(() => {
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
})
