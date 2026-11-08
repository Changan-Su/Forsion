/**
 * Store sources (third-party catalogs shown in the store's left column).
 *
 * A source only supplies a catalog (`forsion-store.json`); the host draws it, downloads the packages and installs
 * them with the same pipeline as Forsion store items. This module is pure (no I/O): it parses what a person types or
 * what a plugin manifest declares into a source reference, and validates a catalog file. Main process: storeSources.ts.
 *
 * Identity: a source has an 8-hex id; an item installed from it gets the card id `src_<source>_<item>` (never a
 * Forsion store id: those are UUIDs) and the install folder `src-<source>-<item>` (a safe slug, so it never lands in
 * a Forsion store folder either).
 */

export type LocalText = string | { zh?: string; en?: string }

export type StoreSourceRef =
  | { kind: 'github'; repo: string; ref?: string; dir?: string }
  | { kind: 'npm'; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'forsion-git'; repo: string; ref?: string; dir?: string }

export type StorePackage =
  | { kind: 'github'; repo: string; ref: string; path?: string }
  | { kind: 'npm'; name: string; version: string; integrity?: string }
  | { kind: 'url'; url: string; sha256: string }
  | { kind: 'forsion-git'; repo: string; ref: string; path?: string }

export const STORE_ITEM_TYPES = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin'] as const
export type StoreItemType = typeof STORE_ITEM_TYPES[number]

export interface StoreIndexItem {
  id: string
  type: StoreItemType
  name: LocalText
  summary?: LocalText
  version: string
  tags: string[]
  author?: string
  icon?: string
  readme?: string
  minAppVersion?: string
  maxAppVersion?: string
  platforms?: string[]
  updatedAt?: string
  package: StorePackage
}

export interface StoreIndex {
  title?: LocalText
  author?: string
  description?: LocalText
  items: StoreIndexItem[]
  /** More than MAX_INDEX_ITEMS were listed; only the first ones are kept. */
  truncated: boolean
}

/** A source declared in a plugin manifest (`storeSources`). */
export interface DeclaredStoreSource { pluginId: string; id: string; title: LocalText; index: string; icon?: string }

export const STORE_INDEX_FILE = 'forsion-store.json'
export const MAX_INDEX_BYTES = 1024 * 1024
export const MAX_INDEX_ITEMS = 1000
export const MAX_README_CHARS = 64 * 1024
export const MAX_DECLARED_PER_PLUGIN = 4

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const SOURCE_HASH = /^[0-9a-f]{8}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/
const DECLARED_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const FORSION_GIT_HOST = 'git.forsion.net'

/** Card id of an item from a source (renderer and main route on this). */
export const isSourceCardId = (id: unknown): id is string => typeof id === 'string' && /^src_[0-9a-f]{8}_[a-z0-9][a-z0-9-]{0,47}$/.test(id)
export const sourceCardId = (source: string, item: string): string => `src_${source}_${item}`
export const sourceInstallSlug = (source: string, item: string): string => `src-${source}-${item}`
export function splitSourceCardId(id: string): { source: string; item: string } | null {
  if (!isSourceCardId(id)) return null
  return { source: id.slice(4, 12), item: id.slice(13) }
}
export const isSourceId = (id: unknown): id is string => typeof id === 'string' && SOURCE_HASH.test(id)

export function pickText(text: LocalText | undefined, locale: string): string {
  if (!text) return ''
  if (typeof text === 'string') return text
  const zh = locale === 'zh' || locale.startsWith('zh')
  return (zh ? text.zh ?? text.en : text.en ?? text.zh) ?? ''
}

const isRepo = (owner: string, repo: string) => OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..'
const safeSegments = (s: string, max: number) => s.length <= max && s.split('/').every((x) => /^[A-Za-z0-9._-]+$/.test(x) && x !== '.' && x !== '..')
const isRef = (s: string) => /^[A-Za-z0-9._/-]{1,100}$/.test(s) && !s.startsWith('/') && !s.startsWith('-') && !s.endsWith('/') && safeSegments(s, 100)
const isDir = (s: string) => safeSegments(s, 200)
const localHttp = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)

/** A repository path after the host: `owner/repo[.git][/tree/<ref>[/<dir>]]`. */
function repoPath(kind: 'github' | 'forsion-git', path: string): StoreSourceRef | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const owner = parts[0], repo = parts[1].replace(/\.git$/, '')
  if (!isRepo(owner, repo)) return null
  if (parts.length === 2) return { kind, repo: `${owner}/${repo}` }
  if ((parts[2] !== 'tree' && parts[2] !== 'src') || parts.length < 4) return null
  // Gitea writes /src/branch/<ref>/…; GitHub /tree/<ref>/…. A ref with a slash is taken as ref + dir.
  const rest = parts[2] === 'src' && ['branch', 'tag', 'commit'].includes(parts[3]) ? parts.slice(4) : parts.slice(3)
  if (!rest.length || !isRef(rest[0])) return null
  const dir = rest.slice(1).join('/')
  if (dir && !isDir(dir)) return null
  return { kind, repo: `${owner}/${repo}`, ref: rest[0], ...(dir ? { dir } : {}) }
}

/**
 * Parse what a person pastes (or a manifest `index`) into a source reference. Accepts
 * `github:owner/repo`, `https://github.com/owner/repo[/tree/<ref>/<dir>]`, `npm:<name>`,
 * `https://www.npmjs.com/package/<name>`, `forsion-git:owner/repo`, `https://git.forsion.net/owner/repo…`
 * and any other https URL of a catalog file (plain http only for localhost).
 */
export function parseSourceInput(raw: unknown): StoreSourceRef | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s || s.length > 500 || /\s/.test(s)) return null
  const short = /^(github|npm|forsion-git):(.+)$/i.exec(s)
  if (short) {
    const kind = short[1].toLowerCase(), rest = short[2]
    if (kind === 'npm') return NPM_NAME.test(rest) && rest.length <= 214 ? { kind: 'npm', name: rest } : null
    return repoPath(kind === 'github' ? 'github' : 'forsion-git', rest)
  }
  if (/^(github\.com|www\.github\.com|git\.forsion\.net|www\.npmjs\.com|npmjs\.com)\//i.test(s)) s = `https://${s}`
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase()
  if (u.protocol === 'https:' && (host === 'github.com' || host === 'www.github.com')) return repoPath('github', decodeURIComponent(u.pathname))
  if (u.protocol === 'https:' && host === FORSION_GIT_HOST) return repoPath('forsion-git', decodeURIComponent(u.pathname))
  if (u.protocol === 'https:' && (host === 'www.npmjs.com' || host === 'npmjs.com')) {
    const m = /^\/package\/((?:@[^/]+\/)?[^/]+)\/?$/.exec(decodeURIComponent(u.pathname))
    return m && NPM_NAME.test(m[1]) ? { kind: 'npm', name: m[1] } : null
  }
  if (u.protocol !== 'https:' && !localHttp(u)) return null
  u.hash = ''
  return { kind: 'url', url: u.toString() }
}

/** One spelling per source: used to show the address and to refuse adding the same source twice. */
export function canonicalSource(ref: StoreSourceRef): string {
  if (ref.kind === 'npm') return `https://www.npmjs.com/package/${ref.name}`
  if (ref.kind === 'url') return ref.url
  const host = ref.kind === 'github' ? 'https://github.com' : `https://${FORSION_GIT_HOST}`
  if (!ref.ref && !ref.dir) return `${host}/${ref.repo}`
  return `${host}/${ref.repo}/${ref.kind === 'github' ? 'tree' : 'src/branch'}/${ref.ref || 'HEAD'}${ref.dir ? `/${ref.dir}` : ''}`
}

/** Which origin a package downloads from; an automatic update that changes it stops and asks. */
export function packageOrigin(pkg: StorePackage): string {
  if (pkg.kind === 'github') return `github:${pkg.repo.toLowerCase()}`
  if (pkg.kind === 'forsion-git') return `forsion-git:${pkg.repo.toLowerCase()}`
  if (pkg.kind === 'npm') return `npm:${pkg.name}`
  try { return `url:${new URL(pkg.url).host}` } catch { return 'url:?' }
}

export class StoreIndexError extends Error {
  constructor(readonly code: string) { super(`source: ${code}`) }
}

function text(v: unknown, max: number): LocalText | undefined {
  if (typeof v === 'string') return v.trim() ? v.trim().slice(0, max) : undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const zh = typeof o.zh === 'string' && o.zh.trim() ? o.zh.trim().slice(0, max) : undefined
  const en = typeof o.en === 'string' && o.en.trim() ? o.en.trim().slice(0, max) : undefined
  return zh || en ? { ...(zh ? { zh } : {}), ...(en ? { en } : {}) } : undefined
}
const str = (v: unknown, max: number): string | undefined => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined

function parsePackage(v: unknown): StorePackage | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const repoPkg = (kind: 'github' | 'forsion-git', repo: unknown): StorePackage | null => {
    if (typeof repo !== 'string') return null
    const [owner, name, ...extra] = repo.split('/')
    if (extra.length || !owner || !name || !isRepo(owner, name)) return null
    if (typeof o.ref !== 'string' || !isRef(o.ref)) return null
    if (o.path !== undefined && (typeof o.path !== 'string' || !isDir(o.path.replace(/^\/+|\/+$/g, '')))) return null
    const path = typeof o.path === 'string' ? o.path.replace(/^\/+|\/+$/g, '') : ''
    return { kind, repo: `${owner}/${name}`, ref: o.ref, ...(path ? { path } : {}) }
  }
  if (o.github !== undefined) return repoPkg('github', o.github)
  if (o.forsionGit !== undefined) return repoPkg('forsion-git', o.forsionGit)
  if (o.npm !== undefined) {
    if (typeof o.npm !== 'string' || !NPM_NAME.test(o.npm) || o.npm.length > 214 || typeof o.version !== 'string' || !VERSION.test(o.version)) return null
    if (o.integrity !== undefined && (typeof o.integrity !== 'string' || !SHA512.test(o.integrity))) return null
    return { kind: 'npm', name: o.npm, version: o.version, ...(typeof o.integrity === 'string' ? { integrity: o.integrity } : {}) }
  }
  if (o.url !== undefined) {
    if (typeof o.url !== 'string' || typeof o.sha256 !== 'string' || !SHA256.test(o.sha256.toLowerCase())) return null
    let u: URL
    try { u = new URL(o.url) } catch { return null }
    if ((u.protocol !== 'https:' && !localHttp(u)) || u.username || u.password) return null
    return { kind: 'url', url: u.toString(), sha256: o.sha256.toLowerCase() }
  }
  return null
}

/** Validate a catalog file. Bad items are dropped (one typo must not hide the rest); a bad file throws. */
export function parseStoreIndex(raw: unknown): StoreIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StoreIndexError('index-invalid')
  const o = raw as Record<string, unknown>
  if (o.schema !== 1) throw new StoreIndexError('index-schema')
  if (!Array.isArray(o.items)) throw new StoreIndexError('index-invalid')
  const items: StoreIndexItem[] = []
  const seen = new Set<string>()
  for (const x of o.items) {
    if (items.length >= MAX_INDEX_ITEMS) break
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const it = x as Record<string, unknown>
    const name = text(it.name, 120)
    const pkg = parsePackage(it.package)
    const version = typeof it.version === 'string' ? it.version.trim().replace(/^v/i, '') : ''
    if (typeof it.id !== 'string' || !ITEM_ID.test(it.id) || seen.has(it.id)) continue
    if (!STORE_ITEM_TYPES.includes(it.type as StoreItemType) || !name || !pkg || !VERSION.test(version)) continue
    if (pkg.kind === 'npm' && pkg.version !== version) continue
    seen.add(it.id)
    const tags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string' && !!t.trim() && t.length <= 40).map((t) => t.trim()).slice(0, 12) : []
    const platforms = Array.isArray(it.platforms) ? it.platforms.filter((p): p is string => ['macos', 'windows', 'linux', 'android', 'ios', 'web'].includes(p as string)) : undefined
    items.push({
      id: it.id, type: it.type as StoreItemType, name, version, tags, package: pkg,
      ...(text(it.summary, 400) ? { summary: text(it.summary, 400) } : {}),
      ...(str(it.author, 80) ? { author: str(it.author, 80) } : {}),
      ...(str(it.icon, 500) ? { icon: str(it.icon, 500) } : {}),
      ...(typeof it.readme === 'string' && it.readme.trim() ? { readme: it.readme.slice(0, MAX_README_CHARS) } : {}),
      ...(str(it.minAppVersion, 40) ? { minAppVersion: str(it.minAppVersion, 40) } : {}),
      ...(str(it.maxAppVersion, 40) ? { maxAppVersion: str(it.maxAppVersion, 40) } : {}),
      ...(platforms?.length ? { platforms } : {}),
      ...(str(it.updatedAt, 40) && !Number.isNaN(Date.parse(it.updatedAt as string)) ? { updatedAt: str(it.updatedAt, 40) } : {}),
    })
  }
  const total = o.items.length
  return {
    items, truncated: total > MAX_INDEX_ITEMS,
    ...(text(o.title, 80) ? { title: text(o.title, 80) } : {}),
    ...(str(o.author, 80) ? { author: str(o.author, 80) } : {}),
    ...(text(o.description, 400) ? { description: text(o.description, 400) } : {}),
  }
}

/** `storeSources` of a plugin manifest. Invalid entries are dropped; at most MAX_DECLARED_PER_PLUGIN per plugin. */
export function declaredSourcesOf(pluginId: string, raw: unknown): DeclaredStoreSource[] {
  if (!Array.isArray(raw)) return []
  const out: DeclaredStoreSource[] = []
  for (const x of raw) {
    if (out.length >= MAX_DECLARED_PER_PLUGIN) break
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const o = x as Record<string, unknown>
    const title = text(o.title, 60)
    if (typeof o.id !== 'string' || !DECLARED_ID.test(o.id) || out.some((d) => d.id === o.id) || !title || !parseSourceInput(o.index)) continue
    out.push({ pluginId, id: o.id, title, index: (o.index as string).trim(), ...(typeof o.icon === 'string' && /^[a-z-]{1,24}$/.test(o.icon) ? { icon: o.icon } : {}) })
  }
  return out
}
