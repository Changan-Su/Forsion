/**
 * Forsion 账号凭据文件(Electron 主进程版,契约与 `tangu login` 完全一致):token 存 ~/.forsion/auth.json,
 * 与 CLI/TUI/managed 后端同一份凭证 —— 登录态对全家共享:tangu / tangu-server / 桌面 managed 后端都读这份 auth.json。
 *
 * 2026-09-28 起 Forsion 云端那半(device flow / whoami / 滑动续期 / 多账号记忆 auth-accounts.json / 服务端吊销)住在
 * Forsion Extend 的主进程半身(经 cloudHost.ts 的 account* 接缝调进 accountCore.ts);这里只剩跨进程契约:
 * auth.json 的路径与格式、按账号的云同步设置(config:get/set 契约的一部分)、账号身份推导。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { forsionHomeDir } from './forsionHome'
import { forsionAccountId } from '../shared/forsionAccount'
export { forsionAccountId } from '../shared/forsionAccount'

export interface TanguCreds {
  cloudUrl?: string
  token?: string
  model?: string
}

const credsFile = (): string => join(forsionHomeDir(), 'auth.json')
const accountSettingsFile = (): string => join(forsionHomeDir(), 'cloud-account-settings.json')

interface JsonRead {
  data: Record<string, any>
  readable: boolean
}
const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
/** 每份文件上次读到的内容(进程内)。 */
const lastRead = new Map<string, JsonRead>()
/** 只有 ENOENT 算空。文件在却读不了 / 解析不了 = 不知道:给上次读到的内容、readable=false,调用方不许写回 ——
 *  断电留下的零字节文件当空继续走,写回就盖掉了真内容;watcher 还会当成登出,把这个账号从多账号记忆里忘掉。 */
function readPrivateJson(file: string, valid: (data: Record<string, any>) => boolean): JsonRead {
  let data: Record<string, any> | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isRecord(parsed) && valid(parsed)) data = parsed
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') data = {}
  }
  const last = lastRead.get(file)
  if (!data && last?.readable !== false) console.error(`[auth] ${file} is unreadable; keeping the last read and refusing writes until it is repaired or removed`)
  const read = data ? { data, readable: true } : { data: last?.data ?? {}, readable: false }
  lastRead.set(file, read)
  return read
}

export interface AccountCloudSettings {
  forsionSyncEnabled: boolean
  forsionLastSyncedAt: number
}
function readAccountSettings(): { accounts: Record<string, AccountCloudSettings>; readable: boolean } {
  const { data, readable } = readPrivateJson(accountSettingsFile(), (d) => d.accounts == null || isRecord(d.accounts))
  return { accounts: data.accounts ?? {}, readable }
}
const normalizedSettings = (settings?: AccountCloudSettings): AccountCloudSettings => ({
  forsionSyncEnabled: settings?.forsionSyncEnabled === true,
  forsionLastSyncedAt: typeof settings?.forsionLastSyncedAt === 'number' ? settings.forsionLastSyncedAt : 0,
})
export function loadAccountCloudSettings(creds = loadTanguCreds()): AccountCloudSettings {
  const id = forsionAccountId(creds.cloudUrl || '', creds.token || '')
  return normalizedSettings(id ? readAccountSettings().accounts[id] : undefined)
}
export function saveAccountCloudSettings(patch: Partial<AccountCloudSettings>, creds = loadTanguCreds()): void {
  const id = forsionAccountId(creds.cloudUrl || '', creds.token || '')
  if (!id) return
  const { accounts, readable } = readAccountSettings()
  if (!readable) return // 写回就把别的账号的设置冲掉了
  accounts[id] = { ...normalizedSettings(accounts[id]), ...patch }
  writePrivateJson(accountSettingsFile(), { version: 1, accounts })
}

function writePrivateJson(file: string, data: Record<string, any>): void {
  mkdirSync(forsionHomeDir(), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  lastRead.set(file, { data: { ...data }, readable: true })
}

const readCreds = (): JsonRead => readPrivateJson(credsFile(), (c) => [c.cloudUrl, c.token].every((v) => v == null || typeof v === 'string'))

export function loadTanguCreds(): TanguCreds {
  return { ...readCreds().data }
}

export function assertTanguCredsWritable(): void {
  if (!readCreds().readable) throw new Error(`${credsFile()} is unreadable. Repair or remove it, then sign in again.`)
}

/** 只写 auth.json;读不出来时拒写。多账号记忆(auth-accounts.json)由 Extend 在换号 / 登录 / 续期时自己维护。 */
export function saveTanguCreds(c: TanguCreds): void {
  assertTanguCredsWritable()
  writePrivateJson(credsFile(), c)
}
