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

export interface AccountCloudSettings {
  forsionSyncEnabled: boolean
  forsionLastSyncedAt: number
}
function readAccountSettings(): Record<string, AccountCloudSettings> {
  try {
    const data = JSON.parse(readFileSync(accountSettingsFile(), 'utf8'))
    return data.accounts && typeof data.accounts === 'object' ? data.accounts : {}
  } catch { return {} }
}
export function loadAccountCloudSettings(creds = loadTanguCreds()): AccountCloudSettings {
  const id = forsionAccountId(creds.cloudUrl || '', creds.token || '')
  const settings = id ? readAccountSettings()[id] : undefined
  return {
    forsionSyncEnabled: settings?.forsionSyncEnabled === true,
    forsionLastSyncedAt: typeof settings?.forsionLastSyncedAt === 'number' ? settings.forsionLastSyncedAt : 0,
  }
}
export function saveAccountCloudSettings(patch: Partial<AccountCloudSettings>, creds = loadTanguCreds()): void {
  const id = forsionAccountId(creds.cloudUrl || '', creds.token || '')
  if (!id) return
  const accounts = readAccountSettings()
  accounts[id] = { ...loadAccountCloudSettings(creds), ...patch }
  writePrivateJson(accountSettingsFile(), { version: 1, accounts })
}

function writePrivateJson(file: string, data: unknown): void {
  mkdirSync(forsionHomeDir(), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}

export function loadTanguCreds(): TanguCreds {
  try {
    return JSON.parse(readFileSync(credsFile(), 'utf8')) as TanguCreds
  } catch {
    return {}
  }
}

/** 只写 auth.json。多账号记忆(auth-accounts.json)由 Extend 在换号 / 登录 / 续期时自己维护。 */
export function saveTanguCreds(c: TanguCreds): void {
  writePrivateJson(credsFile(), c)
}
