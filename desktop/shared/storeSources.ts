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
  | { kind: 'github'; repo: string; ref: string; path?: string; commit?: string }
  | { kind: 'npm'; name: string; version: string; integrity?: string }
  | { kind: 'url'; url: string; sha256: string }
  | { kind: 'forsion-git'; repo: string; ref: string; path?: string; commit?: string }

export const STORE_ITEM_TYPES = ['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin'] as const
export type StoreItemType = typeof STORE_ITEM_TYPES[number]

/**
 * The built-in source: skills Forsion collects from skills.sh. The Forsion server keeps the catalog (same file shape as
 * any source, plus a `collected` block per item); the desktop installs its items through the source pipeline.
 * The id is `sha256("builtin:skills.sh").hex.slice(0, 8)`, hard-coded on both sides (server and desktop tests recompute it).
 */
export const BUILTIN_SKILLS_SH = { key: 'skills-sh', id: '25aae625', title: 'skills.sh' } as const
export const COLLECTED_CATALOG_PATH = `/api/market/collected/${BUILTIN_SKILLS_SH.key}/forsion-store.json`
export const collectedItemPath = (itemId: string): string => `/api/market/collected/${BUILTIN_SKILLS_SH.key}/items/${encodeURIComponent(itemId)}`
export const isBuiltinSourceId = (id: unknown): boolean => id === BUILTIN_SKILLS_SH.id

export const AUDIT_RISKS = ['safe', 'low', 'medium', 'high', 'critical', 'unknown'] as const
export type AuditRisk = typeof AUDIT_RISKS[number]
export const AUDIT_PROVIDERS = ['gen', 'socket', 'snyk'] as const
/** What Forsion's collector found out about a skills.sh entry (catalog `collected` block, contract §3.1). */
export interface CollectedInfo {
  installs: number
  rank: number | null
  trendingRank: number | null
  audit: Record<typeof AUDIT_PROVIDERS[number], AuditRisk>
  /** An admin released an item the audit would have kept out. */
  override: boolean
  license: string | null
  scripts: number
  files: number
  requirements: { cli: boolean; apiKeys: string[]; desktopOnly: boolean }
  writtenFor: Array<'claude-code' | 'codex'>
  adapted: boolean
  adaptCount: number
  unsupportedCount: number
  /** Item ids in the same source this skill needs installed alongside. */
  requires: string[]
  upstreamDeleted: boolean
  pageUrl: string | null
  /** A prerequisite named by the skill couldn't be matched to a collected item (optional; older servers omit it). */
  missingPrereq: boolean
}
/** Any audit at medium or worse (an admin-released high counts too): the item is confirmed one by one before installing. */
export const auditWarns = (c: Pick<CollectedInfo, 'audit'> | null | undefined): boolean =>
  !!c && AUDIT_PROVIDERS.some((p) => c.audit[p] === 'medium' || c.audit[p] === 'high' || c.audit[p] === 'critical')

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
  collected?: CollectedInfo
}

export interface StoreIndex {
  title?: LocalText
  author?: string
  description?: LocalText
  items: StoreIndexItem[]
  /** More than MAX_INDEX_ITEMS were listed; only the first ones are kept. */
  truncated: boolean
}

/** What the store shows (main process → renderer). */
export interface StoreSourceInfo {
  id: string
  title: string
  /** builtin = skills.sh, run by Forsion: always trusted, can be turned off, can't be removed. */
  origin: 'user' | 'plugin' | 'builtin'
  pluginId?: string
  uri: string
  kind: StoreSourceRef['kind']
  icon?: string
  trusted: boolean
  disabled: boolean
}
export interface StoreSourceCard {
  id: string
  type: StoreItemType
  source: 'github' | 'npm' | 'zip'
  name: string
  summary: string
  author: string
  installSlug: string
  downloads: number
  iconUrl: string | null
  latestVersion: string
  tags: string[]
  minAppVersion?: string
  maxAppVersion?: string
  platforms?: string[]
  createdAt: null
  updatedAt: string | null
  githubRepoUrl?: string
  npmPackage?: string
  origin: { sourceId: string; sourceTitle: string }
  /** Built-in source: what the collector found (audit, licence, requirements, prerequisites…). */
  collected?: CollectedInfo
  /** The commit a GitHub / Forsion Git package is pinned to. */
  commit?: string
  /** `collected.requires` resolved against the same catalog (prerequisites installed alongside). */
  prereqs?: StorePrereq[]
}
/** A prerequisite of a collected skill, as the catalog lists it. `missing` = named but not in the catalog. */
export interface StorePrereq { id: string; itemId: string; name: string; installSlug: string; scripts: number; auditWarn: boolean; missing?: boolean }

export const ADAPT_ACTIONS = ['use-skill', 'delegate', 'ask-user', 'todo', 'skill-dir', 'invoke-only-when-named', 'tools-hint', 'ask-user-run-skill', 'context-only'] as const
export type AdaptAction = typeof ADAPT_ACTIONS[number]
/** How a collected skill written for Claude Code / Codex reads in Tangu (contract §3.2). `note` is what Tangu reads. */
export interface AdaptView {
  entries: Array<{ line: number; quote: string; action: AdaptAction; target?: string; by: 'table' | 'ai' }>
  unsupported: Array<{ line: number; quote: string; feature: 'hooks' | 'other' }>
  requires: string[]
  setup?: string
  external: string[]
  note: string
  commit: string
}
/** The adaptation note written next to SKILL.md; the engine reads it before the skill body. */
export const ADAPT_FILE = '.forsion-adapt.md'
export const MAX_ADAPT_NOTE = 1200
export interface StoreSourceCatalog {
  source: StoreSourceInfo
  items: StoreSourceCard[]
  fetchedAt: number | null
  /** Shown from the last copy on this computer because fetching failed. */
  stale: boolean
  error?: string
  truncated: boolean
  description?: string
}
export interface StoreSourceInstall {
  cardId: string; type: string; slug: string; name: string; version: string | null; sourceId: string; sourceTitle: string | null; removed: boolean
  /** Copied from the catalog at install time. */
  summary?: string; author?: string
  /** The last catalog read says the upstream repository or folder is gone (the installed copy stays). */
  upstreamDeleted?: boolean
  /** The last catalog read no longer lists it (hidden by Forsion, or dropped): not updated any more, the copy stays. */
  delisted?: boolean
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
/** Gitea user / organisation names may also carry `.` and `_` (not at the ends). */
const GIT_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
/** A full git commit id (SHA-1, 40 lowercase hex). Short ids are refused: they can become ambiguous. */
const COMMIT = /^[0-9a-f]{40}$/
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
export const isCommitId = (s: unknown): s is string => typeof s === 'string' && COMMIT.test(s)

export function pickText(text: LocalText | undefined, locale: string): string {
  if (!text) return ''
  if (typeof text === 'string') return text
  const zh = locale === 'zh' || locale.startsWith('zh')
  return (zh ? text.zh ?? text.en : text.en ?? text.zh) ?? ''
}

const isRepo = (owner: string, repo: string, kind: 'github' | 'forsion-git' = 'github') =>
  (kind === 'forsion-git' ? GIT_OWNER : OWNER).test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..'
const safeSegments = (s: string, max: number) => s.length <= max && s.split('/').every((x) => /^[A-Za-z0-9._-]+$/.test(x) && x !== '.' && x !== '..')
const isRef = (s: string) => /^[A-Za-z0-9._/-]{1,100}$/.test(s) && !s.startsWith('/') && !s.startsWith('-') && !s.endsWith('/') && safeSegments(s, 100)
const isDir = (s: string) => safeSegments(s, 200)
const localHttp = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)

/**
 * An https address on the public internet: no loopback, private, link-local or carrier-NAT address, no
 * single-label or `.local`-style name. Catalog-supplied addresses (packages, redirects, icons) must pass this,
 * so a catalog can't make the desktop app call services on the user's machine or network.
 * (A name that resolves to a private address is not caught here.)
 */
export function isPublicHttpsUrl(raw: string | URL): boolean {
  let u: URL
  try { u = typeof raw === 'string' ? new URL(raw) : raw } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(h)) return false
  if (h.includes(':')) return !(h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:'))
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!v4) return h.includes('.')
  const a = Number(v4[1]), b = Number(v4[2])
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)))
}

/** A repository path after the host: `owner/repo[.git][/tree/<ref>[/<dir>]]`. */
function repoPath(kind: 'github' | 'forsion-git', path: string): StoreSourceRef | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const owner = parts[0], repo = parts[1].replace(/\.git$/, '')
  if (!isRepo(owner, repo, kind)) return null
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
    if (extra.length || !owner || !name || !isRepo(owner, name, kind)) return null
    if (typeof o.ref !== 'string' || !isRef(o.ref)) return null
    if (o.path !== undefined && (typeof o.path !== 'string' || !isDir(o.path.replace(/^\/+|\/+$/g, '')))) return null
    const path = typeof o.path === 'string' ? o.path.replace(/^\/+|\/+$/g, '') : ''
    // `commit` pins the package to one commit (`ref` stays required: older apps ignore `commit` and follow `ref`).
    // A ref that is itself a full commit id pins too. A malformed commit drops the item rather than falling back
    // to the unpinned ref: the author would believe it is pinned.
    let commit: string | undefined
    if (o.commit !== undefined) {
      if (typeof o.commit !== 'string' || !isCommitId(o.commit.toLowerCase())) return null
      commit = o.commit.toLowerCase()
      if (isCommitId(o.ref.toLowerCase()) && o.ref.toLowerCase() !== commit) return null
    } else if (isCommitId(o.ref.toLowerCase())) commit = o.ref.toLowerCase()
    return { kind, repo: `${owner}/${name}`, ref: o.ref, ...(path ? { path } : {}), ...(commit ? { commit } : {}) }
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

const count = (v: unknown, max = 1e12): number | undefined => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined
const rankOf = (v: unknown): number | null | undefined => v === undefined || v === null ? null : count(v, 1e7)
const flag = (v: unknown): boolean | undefined => v === undefined ? false : typeof v === 'boolean' ? v : undefined
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
/** skills.sh pages only (the collector writes `https://skills.sh/<owner>/<repo>/<skill>`). */
function skillsShPage(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.length > 300) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && (u.hostname === 'skills.sh' || u.hostname === 'www.skills.sh') && !u.username && !u.password ? u.toString() : undefined
  } catch { return undefined }
}

/**
 * The `collected` block of a built-in catalog item. Every field is checked; anything malformed drops the block (the item
 * itself stays, without the extra facts). Absent optional fields take their defaults; present-but-wrong ones don't.
 */
export function parseCollected(raw: unknown): CollectedInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const installs = count(o.installs), scripts = count(o.scripts, 1e6), files = count(o.files, 1e6)
  const rank = rankOf(o.rank), trendingRank = rankOf(o.trendingRank)
  const adaptCount = o.adaptCount === undefined ? 0 : count(o.adaptCount, 1000), unsupportedCount = o.unsupportedCount === undefined ? 0 : count(o.unsupportedCount, 1000)
  const override = flag(o.override), adapted = flag(o.adapted), upstreamDeleted = flag(o.upstreamDeleted), missingPrereq = flag(o.missingPrereq)
  if (installs === undefined || scripts === undefined || files === undefined || rank === undefined || trendingRank === undefined || adaptCount === undefined || unsupportedCount === undefined) return undefined
  if (override === undefined || adapted === undefined || upstreamDeleted === undefined || missingPrereq === undefined) return undefined
  const a = o.audit
  if (!a || typeof a !== 'object' || Array.isArray(a)) return undefined
  const audit = {} as CollectedInfo['audit']
  for (const p of AUDIT_PROVIDERS) {
    const v = (a as Record<string, unknown>)[p]
    if (v === undefined || v === null) audit[p] = 'unknown'
    else if (AUDIT_RISKS.includes(v as AuditRisk)) audit[p] = v as AuditRisk
    else return undefined
  }
  const r = o.requirements
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined
  const req = r as Record<string, unknown>
  const cli = flag(req.cli), desktopOnly = flag(req.desktopOnly)
  const apiKeys = req.apiKeys === undefined ? [] : Array.isArray(req.apiKeys) && req.apiKeys.length <= 12 && req.apiKeys.every((k) => typeof k === 'string' && ENV_NAME.test(k)) ? req.apiKeys as string[] : undefined
  if (cli === undefined || desktopOnly === undefined || !apiKeys) return undefined
  const license = o.license === undefined || o.license === null ? null : typeof o.license === 'string' && o.license.trim() && o.license.length <= 64 && !/[\u0000-\u001f]/.test(o.license) ? o.license.trim() : undefined
  const writtenFor = o.writtenFor === undefined ? [] : Array.isArray(o.writtenFor) && o.writtenFor.every((w) => w === 'claude-code' || w === 'codex') ? [...new Set(o.writtenFor as Array<'claude-code' | 'codex'>)] : undefined
  const requires = o.requires === undefined ? [] : Array.isArray(o.requires) && o.requires.length <= 16 && o.requires.every((x) => typeof x === 'string' && ITEM_ID.test(x)) ? [...new Set(o.requires as string[])] : undefined
  const pageUrl = skillsShPage(o.pageUrl)
  if (license === undefined || !writtenFor || !requires || pageUrl === undefined) return undefined
  return {
    installs, rank, trendingRank, audit, override, license, scripts, files,
    requirements: { cli, apiKeys: [...new Set(apiKeys)], desktopOnly }, writtenFor, adapted, adaptCount, unsupportedCount,
    requires, upstreamDeleted, pageUrl, missingPrereq,
  }
}

/** Printable text without control characters (newlines optional), trimmed and capped; undefined when it doesn't fit. */
function plain(v: unknown, max: number, lines = false): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\r\n?/g, '\n').trim()
  if (!s || s.length > max || (lines ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s)) return undefined
  return s
}

/**
 * The adaptation of a collected skill (item detail `adapt`, contract §3.2). Bad entries are dropped one by one; the
 * view itself needs a note (≤ MAX_ADAPT_NOTE chars, the text Tangu reads) and the commit it was made for. null = unusable.
 */
export function parseAdaptView(raw: unknown): AdaptView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const note = plain(o.note, MAX_ADAPT_NOTE, true)
  const commit = typeof o.commit === 'string' ? o.commit.toLowerCase() : ''
  if (!note || !isCommitId(commit)) return null
  const line = (v: unknown) => count(v, 100000) !== undefined && (v as number) >= 1 ? v as number : undefined
  const requires = Array.isArray(o.requires) ? [...new Set(o.requires.filter((x): x is string => typeof x === 'string' && ITEM_ID.test(x)))].slice(0, 16) : []
  const entries: AdaptView['entries'] = []
  for (const e of Array.isArray(o.entries) ? o.entries : []) {
    if (entries.length >= 24 || !e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    const ln = line(x.line), quote = plain(x.quote, 200), action = ADAPT_ACTIONS.includes(x.action as AdaptAction) ? x.action as AdaptAction : undefined
    const by = x.by === 'table' || x.by === 'ai' ? x.by : undefined
    const targeted = action === 'use-skill' || action === 'ask-user-run-skill'
    const target = typeof x.target === 'string' && ITEM_ID.test(x.target) ? x.target : undefined
    if (!ln || !quote || !action || !by || (targeted && !target)) continue
    if (entries.some((y) => y.line === ln && y.action === action)) continue
    entries.push({ line: ln, quote, action, by, ...(targeted ? { target } : {}) })
  }
  const unsupported: AdaptView['unsupported'] = []
  for (const e of Array.isArray(o.unsupported) ? o.unsupported : []) {
    if (unsupported.length >= 12 || !e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    const ln = line(x.line), quote = plain(x.quote, 200), feature = x.feature === 'hooks' || x.feature === 'other' ? x.feature : undefined
    if (ln && quote && feature) unsupported.push({ line: ln, quote, feature })
  }
  const external = Array.isArray(o.external) ? o.external.map((x) => plain(x, 80)).filter((x): x is string => !!x).slice(0, 3) : []
  const setup = typeof o.setup === 'string' && ITEM_ID.test(o.setup) ? o.setup : undefined
  return { entries, unsupported, requires, ...(setup ? { setup } : {}), external, note, commit }
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
    const collected = it.collected === undefined ? undefined : parseCollected(it.collected)
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
      ...(collected ? { collected } : {}),
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
