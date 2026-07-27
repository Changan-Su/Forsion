/**
 * Dropbox 后端(Forsion 自研:直连公开 REST v2 API;未使用、未参考 remotely-save 的
 * Dropbox 实现 —— 合规边界见 NOTICE.md):
 *  - OAuth PKCE + refresh token:授权流程由宿主完成(开浏览器 + 用户回贴授权码),
 *    本层拿长期 refresh token,access token 内存缓存、过期自动续期;
 *  - 条件写(CAS):writeFile 三态 mode(null→add / rev→update / undefined→overwrite),
 *    rm 带 parent_rev —— walk→push 窗口的并发写在 Dropbox 侧变 409,绝不静默覆盖;
 *  - Dropbox-API-Arg 头必须纯 ASCII:中文路径一律 \uXXXX 转义(asciiJson)。
 * 隔离约定:不 import electron/desktop;凭据由宿主(remotesyncIpc)注入。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { RemoteEntity, RemoteFs } from './types'

export interface DropboxConfig {
  /** Dropbox App Key(client_id;PKCE 无 secret)。 */
  appKey: string
  /** 长期授权凭据(oauth2/token token_access_type=offline 换得)。 */
  refreshToken: string
  /** 远端根目录(如 /Forsion-Vault;App Folder 型应用相对其沙箱根;空 = 根)。 */
  baseDir?: string
}

const API = 'https://api.dropboxapi.com'
const CONTENT = 'https://content.dropboxapi.com'

/** Dropbox-API-Arg 头要求纯 ASCII:非 ASCII 一律 \uXXXX 转义(中文文件名必踩)。 */
export function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** baseDir 规范化:'' 或 '/a/b'(前导 /、无尾 /)。 */
export function normBaseDir(d?: string): string {
  const t = (d ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return t ? `/${t}` : ''
}

/** client_modified 只收秒级 ISO(带毫秒会 400)。 */
const isoSec = (ms: number): string => new Date(Math.max(0, Math.floor(ms))).toISOString().replace(/\.\d{3}Z$/, 'Z')

interface WireFile {
  '.tag'?: string
  path_display?: string
  path_lower?: string
  size: number
  rev: string
  client_modified?: string
  server_modified?: string
}

// ── OAuth PKCE(宿主授权流程用;verifier 由宿主暂存)──────────────────────────

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function dropboxAuthUrl(appKey: string, challenge: string): string {
  return `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(appKey)}&response_type=code&token_access_type=offline&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`
}

/** 授权码 → refresh token + 账号身份(fingerprint 绑账号 / UI 显示用)。 */
export async function dropboxExchangeCode(
  appKey: string,
  code: string,
  verifier: string,
): Promise<{ refreshToken: string; accountId: string; email?: string; name?: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: code.trim(), code_verifier: verifier, client_id: appKey })
  const rsp = await fetch(`${API}/oauth2/token`, { method: 'POST', body })
  if (!rsp.ok) throw new Error(`dropbox oauth ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 200)}`)
  const j = (await rsp.json()) as { refresh_token?: string; access_token?: string; account_id?: string }
  if (!j.refresh_token) throw new Error('dropbox oauth: no refresh_token in response')
  let email: string | undefined
  let name: string | undefined
  const acc = await fetch(`${API}/2/users/get_current_account`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${j.access_token}`, 'Content-Type': 'application/json' },
    body: 'null',
  }).catch(() => null)
  if (acc?.ok) {
    const a = (await acc.json()) as { email?: string; name?: { display_name?: string } }
    email = a.email
    name = a.name?.display_name
  }
  return { refreshToken: j.refresh_token, accountId: j.account_id ?? '', email, name }
}

// ── RemoteFs ─────────────────────────────────────────────────────────────────

export function createDropboxRemote(cfg: DropboxConfig): RemoteFs {
  const base = normBaseDir(cfg.baseDir)
  const absOf = (key: string): string => `${base}/${key}`
  let cached: { token: string; exp: number } | null = null

  const accessToken = async (signal?: AbortSignal): Promise<string> => {
    if (cached && Date.now() < cached.exp - 60_000) return cached.token
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.appKey })
    const rsp = await fetch(`${API}/oauth2/token`, { method: 'POST', body, signal })
    if (!rsp.ok) throw new Error(`dropbox token ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 200)}`)
    const j = (await rsp.json()) as { access_token: string; expires_in?: number }
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 14400) * 1000 }
    return cached.token
  }

  const rpc = async (path: string, arg: unknown, signal?: AbortSignal): Promise<Response> => {
    const token = await accessToken(signal)
    return fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arg ?? null),
      signal,
    })
  }

  /** base 前缀剥离按小写比较(Dropbox 大小写不敏感,path_display 保留用户大小写)。 */
  const entityOf = (f: WireFile): RemoteEntity | null => {
    const p = f.path_display ?? f.path_lower ?? ''
    let rel: string | null
    if (base) rel = p.toLowerCase().startsWith(base.toLowerCase() + '/') ? p.slice(base.length + 1) : null
    else rel = p.replace(/^\/+/, '')
    if (!rel) return null
    const mt = Date.parse(f.client_modified ?? f.server_modified ?? '') || 0
    return { key: rel, size: f.size, mtimeMs: mt, id: f.rev }
  }

  return {
    kind: 'dropbox',
    async walk(signal) {
      const out: RemoteEntity[] = []
      let cursor: string | null = null
      for (;;) {
        const rsp: Response = cursor
          ? await rpc('/2/files/list_folder/continue', { cursor }, signal)
          : await rpc('/2/files/list_folder', { path: base, recursive: true, limit: 2000 }, signal)
        if (!rsp.ok) {
          const text = await rsp.text().catch(() => '')
          // baseDir 尚未创建 = 明确的空远端(首推场景),非列举失败
          if (!cursor && rsp.status === 409 && text.includes('not_found')) return []
          throw new Error(`dropbox list ${rsp.status}: ${text.slice(0, 200)}`)
        }
        const j = (await rsp.json()) as { entries: WireFile[]; cursor: string; has_more: boolean }
        for (const e of j.entries) {
          if (e['.tag'] !== 'file') continue
          const ent = entityOf(e)
          if (ent) out.push(ent)
        }
        if (!j.has_more) return out
        cursor = j.cursor
      }
    },
    async readFile(key, signal) {
      const token = await accessToken(signal)
      const rsp = await fetch(`${CONTENT}/2/files/download`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': asciiJson({ path: absOf(key) }) },
        signal,
      })
      if (!rsp.ok) throw new Error(`dropbox GET ${rsp.status} ${key}: ${(await rsp.text().catch(() => '')).slice(0, 160)}`)
      const data = Buffer.from(await rsp.arrayBuffer())
      // 截断防护:响应内容长度对 API 元数据校验
      const meta = rsp.headers.get('dropbox-api-result')
      if (meta) {
        try {
          const size = (JSON.parse(meta) as { size?: number }).size
          if (typeof size === 'number' && size !== data.byteLength) throw new Error(`dropbox size mismatch: ${key}`)
        } catch (e) {
          if (String((e as Error)?.message).includes('size mismatch')) throw e
        }
      }
      return data
    },
    async writeFile(key, data, mtimeMs, signal, expectedId) {
      const token = await accessToken(signal)
      const mode = expectedId === null ? 'add' : typeof expectedId === 'string' ? { '.tag': 'update', update: expectedId } : 'overwrite'
      const rsp = await fetch(`${CONTENT}/2/files/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': asciiJson({ path: absOf(key), mode, autorename: false, mute: true, client_modified: isoSec(mtimeMs) }),
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(data),
        signal,
      })
      if (!rsp.ok) {
        const text = await rsp.text().catch(() => '')
        if (rsp.status === 409 && text.includes('conflict')) throw new Error(`cas-conflict dropbox PUT ${key}: ${text.slice(0, 160)}`)
        throw new Error(`dropbox PUT ${rsp.status} ${key}: ${text.slice(0, 200)}`)
      }
      const j = (await rsp.json()) as WireFile
      return { key, size: j.size, mtimeMs: Date.parse(j.client_modified ?? j.server_modified ?? '') || mtimeMs, id: j.rev }
    },
    async rm(key, signal, expectedId) {
      const arg: { path: string; parent_rev?: string } = { path: absOf(key) }
      if (typeof expectedId === 'string' && expectedId) arg.parent_rev = expectedId
      const rsp = await rpc('/2/files/delete_v2', arg, signal)
      if (!rsp.ok) {
        const text = await rsp.text().catch(() => '')
        if (rsp.status === 409 && text.includes('not_found')) return // 已不在 = 幂等
        if (rsp.status === 409) throw new Error(`cas-conflict dropbox rm ${key}: ${text.slice(0, 160)}`)
        throw new Error(`dropbox rm ${rsp.status} ${key}: ${text.slice(0, 200)}`)
      }
    },
    async check() {
      try {
        const rsp = await rpc('/2/users/get_current_account', null)
        if (!rsp.ok) return { ok: false, error: `dropbox ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 120)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    },
  }
}
