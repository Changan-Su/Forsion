import { describe, expect, it, vi } from 'vitest'
import type { LocalVaultRow } from '@amadeus-shared/ipc'
import { resolveCalendarSettingsKey, type KeyEnv } from './calendarSettingsKey'

const row = (o: Partial<LocalVaultRow>): LocalVaultRow => ({ root: '/V', name: 'V', display: '/V', current: false, sync: false, pinned: false, exists: true, ...o })
const env = (o: Partial<KeyEnv> = {}): KeyEnv => ({
  ownVaults: () => ['own1'], refreshOwnVaults: vi.fn(), listVaults: null, account: () => 'acct', unitPage: false, ...o,
})

describe('库键', () => {
  it('cloud:// 自有库 → sync;别人共享的 → 留本机;ownVaults 还没刷完 → 不知道(并去刷)', async () => {
    expect(await resolveCalendarSettingsKey('cloud://own1', env())).toEqual({ kind: 'sync', acct: 'acct' })
    expect(await resolveCalendarSettingsKey('cloud://theirs', env())).toEqual({ kind: 'local' })
    const e = env({ ownVaults: () => [] })
    expect(await resolveCalendarSettingsKey('cloud://own1', e)).toEqual({ kind: 'unknown' })
    expect(e.refreshOwnVaults).toHaveBeenCalled()
  })
  it('账号拿不到(桌面中转口还没到 / 没登录)= 不知道', async () => {
    expect(await resolveCalendarSettingsKey('cloud://own1', env({ account: () => null }))).toEqual({ kind: 'unknown' })
    const list = async () => [row({ root: '/V', current: true, sync: true })]
    expect(await resolveCalendarSettingsKey('/V', env({ listVaults: list, account: () => null }))).toEqual({ kind: 'unknown' })
  })
  it('桌面本地库:当前行 sync 为真才是 sync(pinned 不算);不是当前那个库 = 不知道', async () => {
    const list = (rows: LocalVaultRow[]) => async () => rows
    expect(await resolveCalendarSettingsKey('/V/', env({ listVaults: list([row({ current: true, sync: true })]) }))).toEqual({ kind: 'sync', acct: 'acct' })
    expect(await resolveCalendarSettingsKey('/V', env({ listVaults: list([row({ current: true, pinned: true })]) }))).toEqual({ kind: 'local' })
    expect(await resolveCalendarSettingsKey('/W', env({ listVaults: list([row({ current: true, sync: true })]) }))).toEqual({ kind: 'unknown' })
    expect(await resolveCalendarSettingsKey('/V', env({ listVaults: list([row({ current: false, sync: true })]) }))).toEqual({ kind: 'local' })
    expect(await resolveCalendarSettingsKey('/V', env({ listVaults: async () => { throw new Error('ipc') } }))).toEqual({ kind: 'unknown' })
    expect(await resolveCalendarSettingsKey('D:\\Vault', env({ listVaults: list([row({ root: 'd:\\vault\\', current: true, sync: true })]) }))).toEqual({ kind: 'sync', acct: 'acct' })
  })
  it('手机 /vault、没有 listVaults 的老主进程、设备页 → 留本机', async () => {
    expect(await resolveCalendarSettingsKey('/vault', env())).toEqual({ kind: 'local' })
    expect(await resolveCalendarSettingsKey('cloud://own1', env({ unitPage: true }))).toEqual({ kind: 'local' })
    expect(await resolveCalendarSettingsKey('', env())).toEqual({ kind: 'unknown' })
  })
})
