/**
 * 导入本机配置(借鉴 magpie 方案 3a,docs/ToBeImproved/借鉴magpie方案_2026-10-28/import.html):
 * - CC Switch:~/.cc-switch/cc-switch.db 的 providers 表(claude / codex 两类)
 * - Claude Code:$CLAUDE_CONFIG_DIR(缺省 ~/.claude)/settings.json 的 env
 * - Codex:$CODEX_HOME(缺省 ~/.codex)/config.toml 里带内联 key 的 [model_providers.*]
 * 只读这三处,不改它们;扫描结果里 key 不出主进程,渲染端只拿末 4 位(导入之后它就是一条普通连接,和手填的一样)。只填了环境变量名(env_key)、没有 key 值的跳过;
 * 指回 Forsion 自己的(forsion.net / 当前云端地址)跳过。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import TOML from '@iarna/toml'
import type { DirectProviderConfig } from '../../frontend/src/types'

export type LocalSource = 'cc-switch' | 'claude-code' | 'codex'
type Protocol = NonNullable<DirectProviderConfig['protocol']>
interface Found { source: LocalSource; name: string; baseUrl: string; apiKey: string; protocol: Protocol; models: string[] }

/** 给渲染端的一行:没有 key,只有末 4 位;id = 来源 + 配置指纹(换了 key / 地址就是新的一条,「忽略」过的会再提示)。 */
export interface LocalProviderCandidate {
  id: string
  source: LocalSource
  name: string
  host: string
  keyTail: string
  models: string[]
  /** 地址和 key 都一样的连接已经在 Forsion 里。 */
  exists: boolean
}

const clean = (u: string) => u.trim().replace(/\/+$/, '')
const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }
const str = (o: any, ...keys: string[]): string => {
  for (const k of keys) { const v = o?.[k]; if (typeof v === 'string' && v.trim()) return v.trim() }
  return ''
}
const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return null } }

const CLAUDE_MODEL_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']
function fromClaudeEnv(source: LocalSource, name: string, env: any): Found | null {
  const apiKey = str(env, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')
  if (!apiKey) return null // Claude 自己的订阅登录,或只写了环境变量名
  const baseUrl = clean(str(env, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com')
  return { source, name: name || hostOf(baseUrl), baseUrl, apiKey, protocol: 'anthropic-messages', models: [...new Set(CLAUDE_MODEL_KEYS.map((k) => str(env, k)).filter(Boolean))] }
}

/** Codex 的一个 [model_providers.<id>] 块;key 只认内联的(experimental_bearer_token,CC Switch 另给 auth.OPENAI_API_KEY)。 */
function fromCodexProvider(source: LocalSource, name: string, mp: any, key: string, model?: string): Found | null {
  const apiKey = key || str(mp, 'experimental_bearer_token')
  if (!apiKey) return null // env_key 只是变量名
  const baseUrl = clean(str(mp, 'base_url') || 'https://api.openai.com/v1')
  return { source, name: name || str(mp, 'name') || hostOf(baseUrl), baseUrl, apiKey, protocol: str(mp, 'wire_api') === 'chat' ? 'openai' : 'openai-responses', models: model ? [model] : [] }
}

function scanClaudeSettings(env: NodeJS.ProcessEnv, home: string): Found[] {
  const s = readJson(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'))
  const f = s && fromClaudeEnv('claude-code', '', s.env)
  return f ? [f] : []
}

function scanCodexConfig(env: NodeJS.ProcessEnv, home: string): Found[] {
  const file = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
  if (!existsSync(file)) return []
  let cfg: any
  try { cfg = TOML.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const out: Found[] = []
  for (const [id, mp] of Object.entries<any>(cfg.model_providers || {})) {
    const f = fromCodexProvider('codex', str(mp, 'name') || id, mp, '', cfg.model_provider === id ? str(cfg, 'model') : undefined)
    if (f) out.push(f)
  }
  return out
}

async function scanCcSwitch(home: string): Promise<Found[]> {
  const file = join(home, '.cc-switch', 'cc-switch.db')
  if (!existsSync(file)) return []
  let db: { prepare(sql: string): { all(): any[] }; close(): void } | undefined
  try {
    // node:sqlite 是 Electron 自带 Node 的内置模块;@types/node 还没有它的类型
    const { DatabaseSync } = await import('node:sqlite' as string) as any
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db!.prepare('SELECT app_type, name, settings_config FROM providers ORDER BY app_type, COALESCE(sort_index, 0), created_at').all()
    const out: Found[] = []
    for (const r of rows) {
      // 一行坏了只跳这一行(坏 JSON / null / 坏 TOML),别的照列;坏 TOML 不能当成「没写地址 = 官方 OpenAI」
      try {
        const s = JSON.parse(String(r.settings_config || '{}'))
        if (!s || typeof s !== 'object') continue
        const name = String(r.name || '').trim()
        let f: Found | null = null
        if (r.app_type === 'claude') f = fromClaudeEnv('cc-switch', name, s.env)
        else if (r.app_type === 'codex') {
          const cfg: any = s.config ? TOML.parse(String(s.config)) : {}
          f = fromCodexProvider('cc-switch', name, cfg.model_providers?.[cfg.model_provider] || {}, str(s.auth, 'OPENAI_API_KEY'), str(cfg, 'model') || undefined)
        }
        if (f) out.push(f)
      } catch { /* 跳过这一行 */ }
    }
    return out
  } catch (e: any) {
    console.warn('[import] CC Switch 数据库读不了:', e?.message || e)
    return []
  } finally { try { db?.close() } catch { /* ignore */ } }
}

const fingerprint = (f: Found) => `${f.source}:${createHash('sha256').update([f.source, f.baseUrl, f.apiKey, f.protocol].join('\n')).digest('hex').slice(0, 16)}`
const sameConn = (f: Found, p: DirectProviderConfig) => clean(p.baseUrl || '') === f.baseUrl && (p.apiKey || '') === f.apiKey

async function scanFound(opts: { env?: NodeJS.ProcessEnv; home?: string; skipHosts?: string[] } = {}): Promise<Found[]> {
  const env = opts.env || process.env, home = opts.home || homedir()
  const skip = (h: string) => /(^|\.)forsion\.net$/i.test(h) || (opts.skipHosts || []).includes(h)
  const all = [...await scanCcSwitch(home), ...scanClaudeSettings(env, home), ...scanCodexConfig(env, home)]
  const seen = new Set<string>()
  return all.filter((f) => {
    const hostname = (() => { try { return new URL(f.baseUrl).hostname } catch { return '' } })()
    if (!hostname || skip(hostname)) return false
    const conn = [f.baseUrl, f.apiKey, f.protocol].join('\n')
    if (seen.has(conn)) return false // CC Switch 里那条正是 settings.json 当前在用的:只列一次(先到的来源算)
    seen.add(conn)
    return true
  })
}

export async function scanLocalProviders(existing: DirectProviderConfig[], opts?: Parameters<typeof scanFound>[0]): Promise<LocalProviderCandidate[]> {
  return (await scanFound(opts)).map((f) => ({
    id: fingerprint(f), source: f.source, name: f.name, host: hostOf(f.baseUrl), keyTail: f.apiKey.slice(-4), models: f.models,
    exists: existing.some((p) => sameConn(f, p)),
  }))
}

// 订阅登录派生的 provider 用这些 id;导入的同名连接会盖掉它们(显式配置优先),所以换个名字
const RESERVED = new Set(['forsion', 'codex', 'xai', 'grok', 'claude', 'anthropic', 'openai', 'gemini', 'google'])
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

/** 按 id 重新读一遍再取(key 不经渲染端);返回要追加的连接,已经在 Forsion 里的不重复加。 */
export async function localProvidersFor(ids: string[], existing: DirectProviderConfig[], opts?: Parameters<typeof scanFound>[0]): Promise<DirectProviderConfig[]> {
  const want = new Set(ids)
  const taken = new Set(existing.map((p) => p.providerId))
  const out: DirectProviderConfig[] = []
  for (const f of await scanFound(opts)) {
    if (!want.has(fingerprint(f)) || existing.some((p) => sameConn(f, p))) continue
    const base = slug(f.name) || slug(hostOf(f.baseUrl)) || 'imported'
    let providerId = RESERVED.has(base) ? `${base}-import` : base
    for (let n = 2; taken.has(providerId); n++) providerId = `${base}-${n}`
    taken.add(providerId)
    out.push({ providerId, baseUrl: f.baseUrl, apiKey: f.apiKey, ...(f.models.length ? { modelIds: f.models } : {}), ...(f.protocol !== 'openai' ? { protocol: f.protocol } : {}) })
  }
  return out
}
