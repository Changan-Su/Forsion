/**
 * ctx.secrets 的主进程半边(2026-11-24,翻译插件接 DeepL 等要密钥的服务):插件按 key 存小段机密(第三方 API 密钥)。
 *
 * 文件 `<userData>/plugin-secrets.json`:{ "v": 1, "plugins": { "<pluginId>": { "<key>": { "data": "<base64 密文>", "at": 1764… } } } }
 *
 * 规矩(契约:仓根 docs/ToBeImproved/翻译插件设置与服务方案_2026-11-24/契约.md §1):
 *  · 只存 safeStorage 加密后的密文,判据与 secretStore.decideLevel 同一条:macOS / Windows 加密不可用就拒,Linux 只认真钥匙串;
 *    任何情况下都不明文落盘(`secrets_unavailable`)。
 *  · 读失败 ≠ 空:文件解析不了 → 读写都拒(`secrets_failed`),绝不拿空表覆盖;某条解不开 → `secrets_locked`,不当成没存过。
 *  · 按插件 id 分开,但插件与宿主同一个渲染进程,任何插件都能冒用别的插件 id 调这条 IPC —— 不是安全边界(同 pluginNet)。
 *    挡住的是明文躺盘、userData 备份 / 同步拷贝和诊断快照。
 *  · 失败不抛:回 `{ ok: false, code }`(ipcRenderer.invoke 会把错误包一层、码就丢了),渲染层再还原成带 code 的 Error。
 * 不依赖 electron:加密与文件读写由调用方注入,vitest 直测。
 */
import { decideLevel, type CryptoProvider } from './secretStore'

export type PluginSecretsErrorCode = 'secrets_bad_key' | 'secrets_too_large' | 'secrets_too_many' | 'secrets_unavailable' | 'secrets_locked' | 'secrets_failed'
export type PluginSecretsResult<T> = { ok: true; value: T } | { ok: false; code: PluginSecretsErrorCode; message: string }

export const SECRET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const SECRET_MAX_VALUE = 8192
export const SECRET_MAX_KEYS = 64
/** 插件 id 的形状(外部 manifest id 规则 + 商店的 market-<UUID>);不合形状的一律拒,免得拼进对象键出怪事。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

interface Entry { data: string; at: number }
type Store = Record<string, Record<string, Entry>>

export interface PluginSecretsDeps {
  file: string
  crypto: CryptoProvider
  platform: NodeJS.Platform
  /** 文件内容;不存在回 null;读不了抛错。 */
  read(f: string): Promise<string | null>
  /** 原子落盘(tmp + rename,0600)。失败必须保证旧文件完好。 */
  write(f: string, data: unknown): Promise<void>
  now?: () => number
}

export interface PluginSecrets {
  get(pluginId: unknown, key: unknown): Promise<PluginSecretsResult<string | null>>
  set(pluginId: unknown, key: unknown, value: unknown): Promise<PluginSecretsResult<null>>
  delete(pluginId: unknown, key: unknown): Promise<PluginSecretsResult<null>>
  has(pluginId: unknown, key: unknown): Promise<PluginSecretsResult<boolean>>
  keys(pluginId: unknown): Promise<PluginSecretsResult<string[]>>
  /** 卸载插件时调:删掉它的全部条目。文件读不了就什么都不动(回 false)。 */
  removePlugin(pluginId: string): Promise<boolean>
}

const fail = (code: PluginSecretsErrorCode, message: string = code): { ok: false; code: PluginSecretsErrorCode; message: string } => ({ ok: false, code, message })

export function createPluginSecrets(d: PluginSecretsDeps): PluginSecrets {
  const now = d.now ?? Date.now
  // 串行:读到一半的写不许被看见,两次写不互相覆盖。
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => undefined)
    return p
  }

  /** null = 文件坏了(不知道里面有什么):调用方必须拒绝,不能当空表写回。 */
  async function load(): Promise<Store | null> {
    let raw: string | null
    try { raw = await d.read(d.file) } catch { return null }
    if (raw == null) return {}
    try {
      const j = JSON.parse(raw) as { v?: unknown; plugins?: unknown }
      if (!j || typeof j !== 'object' || j.v !== 1 || !j.plugins || typeof j.plugins !== 'object') return null
      return j.plugins as Store
    } catch { return null }
  }
  const save = (plugins: Store): Promise<void> => d.write(d.file, { v: 1, plugins })
  const osReady = (): boolean => decideLevel(d.platform, d.crypto).level === 'os'

  const checkId = (pluginId: unknown): pluginId is string => typeof pluginId === 'string' && PLUGIN_ID_RE.test(pluginId)
  const checkKey = (key: unknown): key is string => typeof key === 'string' && SECRET_KEY_RE.test(key)
  // 原型链上的名字(__proto__ / constructor)不会过 checkKey 的正则(要小写字母或数字开头、无下划线开头);插件 id 也不以 _ 开头。
  const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

  return {
    get: (pluginId, key) => serial(async () => {
      if (!checkId(pluginId) || !checkKey(key)) return fail('secrets_bad_key')
      const s = await load()
      if (!s) return fail('secrets_failed', 'plugin-secrets.json is unreadable')
      const e = own(own(s, pluginId), key)
      if (!e) return { ok: true, value: null }
      if (!osReady()) return fail('secrets_locked', 'system encryption is not available right now')
      try { return { ok: true, value: d.crypto.decrypt(Buffer.from(e.data, 'base64')) } } catch { return fail('secrets_locked', 'stored secret could not be decrypted') }
    }),
    set: (pluginId, key, value) => serial(async () => {
      if (!checkId(pluginId) || !checkKey(key)) return fail('secrets_bad_key')
      if (typeof value !== 'string') return fail('secrets_bad_key', 'value must be a string')
      if (value.length > SECRET_MAX_VALUE) return fail('secrets_too_large')
      if (!osReady()) return fail('secrets_unavailable', 'this device has no system encryption for secrets')
      const s = await load()
      if (!s) return fail('secrets_failed', 'plugin-secrets.json is unreadable')
      const mine = { ...(own(s, pluginId) || {}) }
      if (!own(mine, key) && Object.keys(mine).length >= SECRET_MAX_KEYS) return fail('secrets_too_many')
      let data: string
      try { data = d.crypto.encrypt(value).toString('base64') } catch { return fail('secrets_unavailable', 'encryption failed') }
      mine[key] = { data, at: now() }
      try { await save({ ...s, [pluginId]: mine }) } catch (e) { return fail('secrets_failed', (e as Error)?.message || 'write failed') }
      return { ok: true, value: null }
    }),
    delete: (pluginId, key) => serial(async () => {
      if (!checkId(pluginId) || !checkKey(key)) return fail('secrets_bad_key')
      const s = await load()
      if (!s) return fail('secrets_failed', 'plugin-secrets.json is unreadable')
      const mine = own(s, pluginId)
      if (!own(mine, key)) return { ok: true, value: null }
      const rest = { ...mine }
      delete rest[key]
      const next = { ...s }
      if (Object.keys(rest).length) next[pluginId] = rest
      else delete next[pluginId]
      try { await save(next) } catch (e) { return fail('secrets_failed', (e as Error)?.message || 'write failed') }
      return { ok: true, value: null }
    }),
    has: (pluginId, key) => serial(async () => {
      if (!checkId(pluginId) || !checkKey(key)) return fail('secrets_bad_key')
      const s = await load()
      if (!s) return fail('secrets_failed', 'plugin-secrets.json is unreadable')
      return { ok: true, value: !!own(own(s, pluginId), key) }
    }),
    keys: (pluginId) => serial(async () => {
      if (!checkId(pluginId)) return fail('secrets_bad_key')
      const s = await load()
      if (!s) return fail('secrets_failed', 'plugin-secrets.json is unreadable')
      return { ok: true, value: Object.keys(own(s, pluginId) || {}).sort() }
    }),
    removePlugin: (pluginId) => serial(async () => {
      if (!checkId(pluginId)) return false
      const s = await load()
      if (!s) return false
      if (!own(s, pluginId)) return true
      const next = { ...s }
      delete next[pluginId]
      try { await save(next); return true } catch { return false }
    }),
  }
}
