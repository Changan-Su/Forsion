/**
 * Store sources, main-process half (pure rules: shared/storeSources.ts).
 *
 * - The source table lives on disk (<home>/.store-sources/state.json), plugin-declared sources included, so the
 *   plugin updater can resolve source items at startup before any window syncs.
 * - A source only gives a catalog; packages download here and go through the same checks and install path as Forsion
 *   store items (main.ts routes `src_…` card ids to this module).
 * - Where each installed item came from is kept for every type (the plugin updater only tracks plugins).
 * - A state file that exists but cannot be read is "unknown": nothing is written back over it.
 * - Forsion Git (private repositories on git.forsion.net): the Forsion server reads the catalog and the archive as the
 *   signed-in user (`/api/git/store/index|archive`, server/microserver/git/routes/store.ts); no Git token reaches this
 *   machine. Those catalogs are private: kept in memory per account only, never in the disk cache.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { downloadCandidates, downloadZip, GZIP_MAGIC, isJunkPath, MARKET_MANIFEST, ZIP_MAGIC, type DownloadProgress } from './marketInstall'
import { npmDownloadCandidates, npmTarballToZip } from './npmMarketInstall'
import { untar } from './minitar'
import { forsionAccountId } from '../shared/forsionAccount'
import { registryOrder, resolveLatest, timeoutSignal } from '../shared/npmRegistry'
import { planZipFiles } from '../shared/marketPackage'
import {
  canonicalSource, isPublicHttpsUrl, declaredSourcesOf, isSourceId, MAX_INDEX_BYTES, packageOrigin, parseSourceInput, parseStoreIndex, pickText,
  sourceCardId, sourceInstallSlug, splitSourceCardId, STORE_INDEX_FILE, StoreIndexError,
  type DeclaredStoreSource, type LocalText, type StoreIndex, type StoreIndexItem, type StorePackage, type StoreSourceRef,
  type StoreSourceCard, type StoreSourceCatalog, type StoreSourceInfo, type StoreSourceInstall,
} from '../shared/storeSources'
export type { StoreSourceCard, StoreSourceCatalog, StoreSourceInfo, StoreSourceInstall }

type FetchFn = (url: string, init: { signal: AbortSignal; headers?: Record<string, string>; redirect?: 'manual' }) => Promise<Response>

interface UserSource { id: string; uri: string; title?: LocalText; addedAt: number }
interface PluginSource { id: string; pluginId: string; declId: string; uri: string; title: LocalText; icon?: string }
interface InstallRecord { cardId: string; type: string; slug: string; name: string; version: string | null; origin: string; at: number; summary?: string; author?: string }
interface State { user: UserSource[]; declared: PluginSource[]; disabled: string[]; trusted: string[]; installs: InstallRecord[] }

/** Where Forsion Git reads go: the Forsion server and the signed-in account's token. null = not signed in. */
export interface ForsionGitAccess { base: string; token: string }

export interface SourceDownload {
  info: { type: string; installSlug: string; downloadUrl: string; source: string; version: string; minAppVersion?: string; maxAppVersion?: string; platforms?: string[]; tags?: string[] }
  buf: Buffer
  origin: string
}

const FRESH_MS = 10 * 60_000
const OWN_CDN_REDIRECTS = /^https:\/\/([^/]*\.)?(github\.com|githubusercontent\.com)\//
const CONNECT_MS = 15_000
const TOTAL_MS = 30_000
const hash8 = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8)
const hostOf = (url: string) => { try { return new URL(url).host } catch { return url.slice(0, 60) } }
const errorText = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code || (e instanceof Error ? e.message : String(e))

/** Server reason codes (routes/store.ts) → ours. Anything else: a 401/403 is a sign-in that ran out, a 404/503 without
 *  our code is a server that doesn't have the endpoint (or has no Forsion Git). */
const GIT_CODES: Record<string, string> = {
  GIT_NOT_FOUND: 'forsion-git-no-access', GIT_FILE_NOT_FOUND: 'index-missing', GIT_REF_NOT_FOUND: 'forsion-git-ref-missing',
  GIT_NEEDS_SETUP: 'forsion-git-needs-setup', GIT_NOT_CONFIGURED: 'forsion-git-unsupported', GIT_STORE_READS_OFF: 'forsion-git-unsupported', GIT_TOO_LARGE: 'too-large',
}
async function gitFailure(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { code?: unknown } | null
  const code = typeof body?.code === 'string' ? GIT_CODES[body.code] : undefined
  if (code) return code
  if (res.status === 401 || res.status === 403) return 'forsion-git-signin'
  if (res.status === 404 || res.status === 503) return 'forsion-git-unsupported'
  return 'fetch-failed'
}
/** Whose copy a Forsion Git catalog is: server + account id from the sign-in token (read, not verified: it only keys
 *  a cache). Two servers can hand out the same user id, so the server is part of it. */
export function forsionAccountKey(base: string, token: string): string {
  return forsionAccountId(base, token) ?? `${base.replace(/\/+$/, '')}::t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}
/** Answers that say this account may not read it (or nobody is signed in): never covered with an older copy. */
const GIT_REFUSALS = new Set(['forsion-git-signin', 'forsion-git-no-access', 'forsion-git-needs-setup'])

/** Fetch the first address that answers with a body under `max` bytes (connect and total timeouts per address). */
export async function fetchTextFirst(urls: string[], fetchFor: (url: string) => FetchFn, max = MAX_INDEX_BYTES): Promise<string> {
  const failed: string[] = []
  for (const url of urls) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TOTAL_MS)
    try {
      const res = await Promise.race([
        fetchFor(url)(url, { signal: ac.signal, headers: { accept: 'application/json' } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CONNECT_MS)),
      ])
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > max) { void reader.cancel().catch(() => {}); throw new StoreIndexError('too-large') }
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } catch (e) {
      if (e instanceof StoreIndexError) throw e
      failed.push(`${hostOf(url)}: ${ac.signal.aborted ? 'timeout' : errorText(e)}`)
      ac.abort()
    } finally { clearTimeout(timer) }
  }
  throw Object.assign(new StoreIndexError('fetch-failed'), { detail: failed.join(' · ') })
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { void reader.cancel().catch(() => {}); throw new StoreIndexError('too-large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Cut one folder out of a repository archive (GitHub wraps everything in `<repo>-<ref>/`, Gitea in `<repo>/`). */
export async function subtreeZip(buf: Buffer, path: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf)
  const files = Object.values(zip.files).filter((f) => !f.dir && !isJunkPath(f.name))
  for (const f of files) {
    const original = (f as { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name
    if (/^([\\/]|[a-z]:)/i.test(original) || original.split(/[\\/]/).includes('..')) throw new Error('install: unsafe path in archive')
  }
  const tops = new Set(files.map((f) => f.name.split('/')[0]))
  const root = tops.size === 1 && files.every((f) => f.name.includes('/')) ? `${[...tops][0]}/` : ''
  const prefix = `${root}${path.replace(/^\/+|\/+$/g, '')}/`
  const out = new JSZip()
  let n = 0
  for (const f of files) {
    if (!f.name.startsWith(prefix)) continue
    const rel = f.name.slice(prefix.length)
    if (!rel) continue
    out.file(rel, await f.async('nodebuffer'), { unixPermissions: f.unixPermissions ?? undefined })
    n++
  }
  if (!n) throw new Error('install: package folder not found')
  return out.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}

/**
 * Manifest id of the package, read through the installer's own plan (same path normalisation, same root), so
 * the id checked is the id that gets installed. Two entries landing on one path are refused: the installer
 * would keep the last, the check might read the first.
 */
export async function packageManifestId(buf: Buffer, type: string): Promise<string | null> {
  const names = MARKET_MANIFEST[type]
  const manifest = names?.[0]
  if (!manifest?.endsWith('.json')) return null
  const zip = await JSZip.loadAsync(buf)
  const plan = planZipFiles(Object.values(zip.files), names)
  const seen = new Set<string>()
  for (const p of plan) {
    const key = p.rel.toLowerCase()
    if (seen.has(key)) throw new Error('install: duplicate path in archive')
    seen.add(key)
  }
  const entry = plan.find((p) => p.rel === manifest)
  const file = entry && zip.file(entry.name)
  if (!file) return null
  try { const id = JSON.parse(await file.async('string'))?.id; return typeof id === 'string' ? id : null } catch { return null }
}

export function createStoreSources(o: {
  home: string
  /** Mirror choice ('china' adds proxies for GitHub and npmmirror). */
  mirror: () => Promise<string>
  githubProxy?: () => string
  /** net.fetch for addresses that should follow the system proxy, plain fetch otherwise. */
  fetchFor: (url: string) => FetchFn
  defaultLocale: () => string
  /** Forsion Git reads: the server and the signed-in token (null = signed out). Missing = Forsion Git isn't offered here. */
  forsionGit?: () => Promise<ForsionGitAccess | null>
  /** Cheap check for the updater: is anyone signed in? Signed out, items from Forsion Git sources wait quietly. */
  forsionSignedIn?: () => boolean
}) {
  const root = join(o.home, '.store-sources'), stateFile = join(root, 'state.json'), cacheDir = join(root, 'cache')
  const disk = createSerialQueue()
  let state: State = { user: [], declared: [], disabled: [], trusted: [], installs: [] }
  let readable = true
  let loaded: Promise<void> | undefined
  // `who` = the account a Forsion Git catalog was read as (other sources: undefined). A copy read as someone else is never used.
  const memo = new Map<string, { at: number; index: StoreIndex; who?: string }>()
  const inflight = new Map<string, Promise<StoreIndex>>()

  const load = () => loaded ??= (async () => {
    try {
      const d = JSON.parse(await readFile(stateFile, 'utf8'))
      if (!d || typeof d !== 'object') throw new Error('Invalid store source state')
      const arr = <T>(v: unknown, ok: (x: any) => boolean): T[] => Array.isArray(v) ? v.filter(ok) : []
      state = {
        user: arr<UserSource>(d.user, (x) => x && isSourceId(x.id) && !!parseSourceInput(x.uri) && typeof x.addedAt === 'number'),
        declared: arr<PluginSource>(d.declared, (x) => x && isSourceId(x.id) && typeof x.pluginId === 'string' && typeof x.declId === 'string' && !!parseSourceInput(x.uri) && !!x.title),
        disabled: arr<string>(d.disabled, isSourceId),
        trusted: arr<string>(d.trusted, isSourceId),
        installs: arr<InstallRecord>(d.installs, (x) => x && typeof x.cardId === 'string' && !!splitSourceCardId(x.cardId) && typeof x.type === 'string' && typeof x.slug === 'string' && typeof x.name === 'string'),
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { readable = false; console.warn('[store-sources] state unreadable:', errorText(e)) }
    }
  })()
  /** Mutations run in the disk queue against the latest state; returning `false` leaves the file alone. */
  const save = (mutate: (s: State) => State | void | false): Promise<boolean> => disk(async () => {
    await load()
    if (!readable) throw new StoreIndexError('state-unreadable')
    const draft = structuredClone(state)
    const r = mutate(draft)
    if (r === false) return false
    const next = r ?? draft
    await writePrivateJson(stateFile, { v: 1, ...next })
    state = next
    return true
  })
  /** Fetch that checks every hop: catalog-supplied addresses (and where they redirect) must be public https,
   *  unless the source itself lives on this machine / network (the user typed that address). */
  const guardedFetch = (allowLocal: boolean): FetchFn => async (url, init) => {
    let at = url
    for (let hop = 0; hop <= 5; hop++) {
      if (!allowLocal && !isPublicHttpsUrl(at)) throw new Error('resolve: address-not-allowed')
      // GitHub only redirects to its own download hosts and goes through Electron's net.fetch (system proxy),
      // which can't stop at a redirect ("Redirect was cancelled"): let it follow. Everything else stops at each hop.
      if (OWN_CDN_REDIRECTS.test(at)) return o.fetchFor(at)(at, init)
      const res = await o.fetchFor(at)(at, { ...init, redirect: 'manual' })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) return res
      void res.body?.cancel().catch(() => {})
      at = new URL(location, at).toString()
    }
    throw new Error('resolve: too many redirects')
  }
  const localSource = (ref: StoreSourceRef) => ref.kind === 'url' && !isPublicHttpsUrl(ref.url)
  const cacheFile = (id: string) => join(cacheDir, `${id}.json`)

  const refOf = (s: { uri: string }) => parseSourceInput(s.uri)!
  const all = (): Array<UserSource | PluginSource> => [...state.declared, ...state.user]
  const find = (id: string) => all().find((s) => s.id === id)
  const fallbackTitle = (ref: StoreSourceRef): string =>
    ref.kind === 'npm' ? ref.name : ref.kind === 'url' ? hostOf(ref.url) : ref.repo.split('/')[1]
  /** A private (Forsion Git) catalog's own title shows only to the account that read it; otherwise the repository name. */
  const memoTitle = (s: UserSource | PluginSource, locale: string): string => {
    const m = memo.get(s.id)
    if (!m || (refOf(s).kind === 'forsion-git' && (!lastWho || m.who !== lastWho))) return ''
    return pickText(m.index.title, locale)
  }
  const titleOf = (s: UserSource | PluginSource, locale: string): string =>
    pickText(s.title, locale) || memoTitle(s, locale) || fallbackTitle(refOf(s))
  const info = (s: UserSource | PluginSource, locale: string): StoreSourceInfo => ({
    id: s.id, title: titleOf(s, locale), uri: canonicalSource(refOf(s)), kind: refOf(s).kind,
    trusted: state.trusted.includes(s.id), disabled: state.disabled.includes(s.id),
    ...('pluginId' in s ? { origin: 'plugin' as const, pluginId: s.pluginId, ...(s.icon ? { icon: s.icon } : {}) } : { origin: 'user' as const }),
  })

  // ── Catalog fetching ──
  /** Signed-in access for Forsion Git, or the reason code why not. */
  async function gitAccess(): Promise<ForsionGitAccess> {
    if (!o.forsionGit) throw new StoreIndexError('forsion-git-unsupported')
    const a = await o.forsionGit().catch(() => null)
    if (!a?.token || !a.base) throw new StoreIndexError('forsion-git-signin')
    return a
  }
  /** Who was signed in at the last look ('' = nobody): lets the (sync) title of a private source follow the account. */
  let lastWho = ''
  /** Who is signed in now, as a cache key ('' = nobody). */
  const currentWho = async (): Promise<string> => {
    const a = await o.forsionGit?.().catch(() => null)
    return (lastWho = a?.token && a.base ? forsionAccountKey(a.base, a.token) : '')
  }
  const gitUrl = (a: ForsionGitAccess, path: string, q: Record<string, string | undefined>) =>
    `${a.base.replace(/\/+$/, '')}/api/git/store/${path}?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`
  /** The server reads the catalog file as this account; the answer carries the code saying why not. */
  async function gitIndex(ref: Extract<StoreSourceRef, { kind: 'forsion-git' }>): Promise<{ json: unknown; who: string }> {
    const a = await gitAccess()
    // No ref (or HEAD) = the repository's default branch, which is what the server reads when none is given.
    const url = gitUrl(a, 'index', { repo: ref.repo, ref: ref.ref === 'HEAD' ? undefined : ref.ref, dir: ref.dir })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TOTAL_MS)
    try {
      // The sign-in goes only to the server that issued it: these endpoints never redirect (the server follows Gitea's
      // own redirects itself), so a redirect is a failure here, not a hop to follow with the token.
      const res = await o.fetchFor(url)(url, { signal: ac.signal, redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${a.token}` } })
      if (!res.ok) throw Object.assign(new StoreIndexError(await gitFailure(res)), { detail: `HTTP ${res.status}` })
      const text = await readCapped(res, MAX_INDEX_BYTES)
      return { json: JSON.parse(text), who: (lastWho = forsionAccountKey(a.base, a.token)) }
    } catch (e) {
      if (e instanceof StoreIndexError || e instanceof SyntaxError) throw e
      throw Object.assign(new StoreIndexError('fetch-failed'), { detail: `${hostOf(url)}: ${ac.signal.aborted ? 'timeout' : errorText(e)}` })
    } finally { clearTimeout(timer) }
  }

  async function rawIndex(ref: StoreSourceRef): Promise<{ json: unknown; base?: string; who?: string }> {
    // Private catalog: no base (its relative icons can't be fetched without the sign-in), keyed by account.
    if (ref.kind === 'forsion-git') return gitIndex(ref)
    const mirror = await o.mirror()
    if (ref.kind === 'url') return { json: JSON.parse(await fetchTextFirst([ref.url], () => guardedFetch(localSource(ref)))), base: new URL('.', ref.url).toString() }
    if (ref.kind === 'github') {
      const base = `https://raw.githubusercontent.com/${ref.repo}/${ref.ref || 'HEAD'}/${ref.dir ? `${ref.dir}/` : ''}`
      return { json: JSON.parse(await fetchTextFirst(downloadCandidates(`${base}${STORE_INDEX_FILE}`, mirror, o.githubProxy?.() || ''), o.fetchFor)), base }
    }
    // npm: the catalog ships inside the package; read it from the verified tarball of `latest`.
    const latest = await resolveLatest(ref.name, registryOrder(mirror), (u, init) => o.fetchFor(u)(u, init)).catch((e) => { throw Object.assign(new StoreIndexError('fetch-failed'), { detail: errorText(e) }) })
    if (!latest) throw new StoreIndexError('fetch-failed')
    const tgz = await downloadZip(latest.tarballs, (u, init) => o.fetchFor(u)(u, init), () => {}, GZIP_MAGIC).catch((e) => { throw Object.assign(new StoreIndexError('fetch-failed'), { detail: errorText(e) }) })
    if (`sha512-${createHash('sha512').update(tgz).digest('base64')}` !== latest.integrity) throw new StoreIndexError('fetch-failed')
    const entry = untar(gunzipSync(tgz, { maxOutputLength: 50 * 1024 * 1024 })).find((x) => x.path === `package/${STORE_INDEX_FILE}`)
    if (!entry) throw new StoreIndexError('index-missing')
    if (entry.data.length > MAX_INDEX_BYTES) throw new StoreIndexError('too-large')
    return { json: JSON.parse(entry.data.toString('utf8')) }
  }
  const bases = new Map<string, string | undefined>()
  async function fetchIndex(id: string, ref: StoreSourceRef): Promise<StoreIndex> {
    let got: { json: unknown; base?: string; who?: string }
    try { got = await rawIndex(ref) } catch (e) {
      if (e instanceof SyntaxError) throw new StoreIndexError('index-invalid')
      throw e
    }
    const index = parseStoreIndex(got.json)
    // The source's address changed while this was in flight: don't publish the old address's catalog under it.
    const uri = canonicalSource(ref), cur = find(id)
    if (cur && canonicalSource(refOf(cur)) !== uri) return index
    memo.set(id, { at: Date.now(), index, ...(got.who !== undefined ? { who: got.who } : {}) }); bases.set(id, got.base)
    // A private (Forsion Git) catalog stays in memory for the account that read it; it never goes to disk.
    if (got.who !== undefined) return index
    await mkdir(cacheDir, { recursive: true }).catch(() => {})
    // The raw file is cached (not the parsed form): it is parsed again with the same rules when read back.
    // It carries the address it came from; a copy for another address is never shown.
    await writePrivateJson(cacheFile(id), { at: Date.now(), uri, base: got.base ?? null, json: got.json }).catch(() => {})
    return index
  }
  /** Fresh enough copy, or fetch. `allowStale` falls back to the copy on disk when fetching fails. */
  async function indexOf(id: string, opts: { refresh?: boolean; again?: boolean } = {}): Promise<{ index: StoreIndex; at: number; stale: boolean; error?: string }> {
    const s = find(id)
    if (!s) throw new StoreIndexError('not-found')
    const git = refOf(s).kind === 'forsion-git'
    const who = git ? await currentWho() : undefined
    const mine = memo.get(id)
    const hit = mine && mine.who === who ? mine : undefined
    if (hit && !opts.refresh && Date.now() - hit.at < FRESH_MS) return { index: hit.index, at: hit.at, stale: false }
    const uri = canonicalSource(refOf(s)), key = `${id} ${uri} ${who ?? ''}`
    let job = inflight.get(key)
    if (!job) { job = fetchIndex(id, refOf(s)).finally(() => inflight.delete(key)); inflight.set(key, job) }
    try {
      const index = await job
      // Signed in as someone else while this was in flight: that read belongs to the other account. Read again as this one.
      if (git && await currentWho() !== who) {
        if (opts.again) throw new StoreIndexError('fetch-failed')
        return indexOf(id, { ...opts, again: true })
      }
      return { index, at: memo.get(id)!.at, stale: false }
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e)
      // "Not you" / "not signed in" isn't an outage: no older copy stands in, and the one in memory goes.
      if (git && e instanceof StoreIndexError && GIT_REFUSALS.has(e.code)) { memo.delete(id); throw e }
      if (hit) return { index: hit.index, at: hit.at, stale: true, error: code }
      if (git) throw e
      const cached = await readFile(cacheFile(id), 'utf8').then((t) => JSON.parse(t), () => null)
      if (cached?.json && cached.uri === uri) {
        try {
          const index = parseStoreIndex(cached.json)
          memo.set(id, { at: cached.at ?? 0, index }); bases.set(id, cached.base ?? undefined)
          return { index, at: cached.at ?? 0, stale: true, error: code }
        } catch { /* broken cache */ }
      }
      throw e
    }
  }

  const iconUrl = (id: string, icon?: string): string | null => {
    if (!icon) return null
    try {
      const u = new URL(icon, bases.get(id))
      return isPublicHttpsUrl(u) ? u.toString() : null
    } catch { return null }
  }
  const card = (s: UserSource | PluginSource, index: StoreIndex, it: StoreIndexItem, locale: string): StoreSourceCard => ({
    id: sourceCardId(s.id, it.id), type: it.type,
    source: it.package.kind === 'github' ? 'github' : it.package.kind === 'npm' ? 'npm' : 'zip',
    name: pickText(it.name, locale), summary: pickText(it.summary, locale), author: it.author ?? index.author ?? '',
    installSlug: sourceInstallSlug(s.id, it.id), downloads: 0, iconUrl: iconUrl(s.id, it.icon), latestVersion: it.version, tags: it.tags,
    ...(it.minAppVersion ? { minAppVersion: it.minAppVersion } : {}), ...(it.maxAppVersion ? { maxAppVersion: it.maxAppVersion } : {}),
    ...(it.platforms ? { platforms: it.platforms } : {}),
    createdAt: null, updatedAt: it.updatedAt ?? null,
    ...(it.package.kind === 'github' ? { githubRepoUrl: `https://github.com/${it.package.repo}` } : {}),
    ...(it.package.kind === 'npm' ? { npmPackage: it.package.name } : {}),
    origin: { sourceId: s.id, sourceTitle: titleOf(s, locale) },
  })

  // ── Public API ──
  async function list(locale = o.defaultLocale()): Promise<StoreSourceInfo[]> {
    await load()
    if (all().some((s) => refOf(s).kind === 'forsion-git')) await currentWho()
    return all().map((s) => info(s, locale))
  }

  async function probe(input: unknown, locale = o.defaultLocale()): Promise<{ uri: string; kind: StoreSourceRef['kind']; title: string; count: number; duplicate?: string }> {
    await load()
    const ref = parseSourceInput(input)
    if (!ref) throw new StoreIndexError('unrecognized')
    const uri = canonicalSource(ref)
    const dup = all().find((s) => canonicalSource(refOf(s)) === uri)
    const got = await rawIndex(ref).catch((e) => { throw e instanceof SyntaxError ? new StoreIndexError('index-invalid') : e })
    const index = parseStoreIndex(got.json)
    return { uri, kind: ref.kind, title: pickText(index.title, locale) || fallbackTitle(ref), count: index.items.length, ...(dup ? { duplicate: dup.id } : {}) }
  }

  async function add(input: unknown, locale = o.defaultLocale()): Promise<StoreSourceInfo> {
    const ref = parseSourceInput(input)
    if (!ref) throw new StoreIndexError('unrecognized')
    const uri = canonicalSource(ref)
    const id = hash8(`uri:${uri}`)
    await load()
    if (all().some((s) => s.id === id || canonicalSource(refOf(s)) === uri)) throw new StoreIndexError('duplicate')
    // Only a readable catalog becomes a source.
    const index = await fetchIndex(id, ref)
    // A private catalog's title isn't written to the shared state file (another account on this machine would see it).
    const keepTitle = index.title && ref.kind !== 'forsion-git'
    await save((s) => { if (!s.user.some((x) => x.id === id)) s.user.push({ id, uri, ...(keepTitle ? { title: index.title } : {}), addedAt: Date.now() }) })
    return info(find(id)!, locale)
  }

  async function remove(id: string): Promise<void> {
    await load()
    const s = state.user.find((x) => x.id === id)
    if (!s) throw new StoreIndexError('not-found')
    await save((st) => { st.user = st.user.filter((x) => x.id !== id); st.trusted = st.trusted.filter((x) => x !== id); st.disabled = st.disabled.filter((x) => x !== id) })
    memo.delete(id); bases.delete(id)
    await rm(cacheFile(id), { force: true }).catch(() => {})
  }

  async function setDisabled(id: string, on: boolean): Promise<void> {
    await load()
    if (!find(id)) throw new StoreIndexError('not-found')
    await save((s) => { s.disabled = on ? [...new Set([...s.disabled, id])] : s.disabled.filter((x) => x !== id) })
  }

  async function trust(id: string): Promise<void> {
    await load()
    if (!find(id)) throw new StoreIndexError('not-found')
    if (!state.trusted.includes(id)) await save((s) => { s.trusted = [...s.trusted, id] })
  }

  /** Sources declared by the plugins that are on now (the renderer knows which ones are on). */
  /** Returns whether the table changed. */
  async function setDeclared(raw: unknown): Promise<boolean> {
    // The list replaces the whole table: anything but an array is a broken call, not "no sources".
    if (!Array.isArray(raw)) throw new StoreIndexError('invalid')
    await load()
    const list: DeclaredStoreSource[] = []
    for (const d of raw) {
      if (!d || typeof d !== 'object' || typeof (d as DeclaredStoreSource).pluginId !== 'string') continue
      const one = declaredSourcesOf((d as DeclaredStoreSource).pluginId, [d])[0]
      if (one && !list.some((x) => x.pluginId === one.pluginId && x.id === one.id)) list.push(one)
    }
    const next: PluginSource[] = []
    for (const d of list) {
      const uri = canonicalSource(parseSourceInput(d.index)!)
      if (next.some((x) => x.uri === uri)) continue
      next.push({ id: hash8(`plugin:${d.pluginId}/${d.id}`), pluginId: d.pluginId, declId: d.id, uri, title: d.title, ...(d.icon ? { icon: d.icon } : {}) })
    }
    // Compare and replace inside the disk queue, so a later call never loses to an earlier one still writing.
    let stale: string[] = []
    const changed = await save((s) => {
      if (JSON.stringify(next) === JSON.stringify(s.declared)) return false
      // A declaration that is gone or now points elsewhere: trust and the cached catalog belonged to the old address.
      stale = s.declared.filter((was) => !next.some((n) => n.id === was.id && n.uri === was.uri)).map((was) => was.id)
      s.trusted = s.trusted.filter((x) => !stale.includes(x))
      s.declared = next
    })
    for (const id of stale) { memo.delete(id); bases.delete(id); await rm(cacheFile(id), { force: true }).catch(() => {}) }
    return changed
  }

  async function catalog(id: string, opts: { refresh?: boolean; locale?: string } = {}): Promise<StoreSourceCatalog> {
    await load()
    const s = find(id)
    if (!s) throw new StoreIndexError('not-found')
    const locale = opts.locale || o.defaultLocale()
    try {
      const got = await indexOf(id, opts)
      return {
        source: info(s, locale), items: got.index.items.map((it) => card(s, got.index, it, locale)), fetchedAt: got.at || null,
        stale: got.stale, ...(got.error ? { error: got.error } : {}), truncated: got.index.truncated,
        ...(got.index.description ? { description: pickText(got.index.description, locale) } : {}),
      }
    } catch (e) {
      return { source: info(s, locale), items: [], fetchedAt: null, stale: false, error: e instanceof Error ? e.message : String(e), truncated: false }
    }
  }

  async function itemOf(cardId: string, opts: { refresh?: boolean } = {}): Promise<{ s: UserSource | PluginSource; index: StoreIndex; it: StoreIndexItem }> {
    await load()
    const parts = splitSourceCardId(cardId)
    const s = parts && find(parts.source)
    if (!parts || !s || state.disabled.includes(s.id)) throw new Error('resolve: source-removed')
    const { index } = await indexOf(s.id, opts)
    const it = index.items.find((x) => x.id === parts.item)
    if (!it) throw new Error('resolve: source-item-removed')
    return { s, index, it }
  }

  async function detail(cardId: string, locale = o.defaultLocale()): Promise<StoreSourceCard & { readme: string; description?: string }> {
    const { s, index, it } = await itemOf(cardId)
    return { ...card(s, index, it, locale), readme: it.readme ?? '' }
  }

  /** For the plugin updater: the latest version a source lists for an installed item. */
  async function lookup(cardId: string): Promise<{ id: string; name: string; type: string; installSlug: string; latestVersion: string; summary: string; author: string }> {
    const { s, index, it } = await itemOf(cardId)
    const c = card(s, index, it, o.defaultLocale())
    return { id: c.id, name: c.name, type: c.type, installSlug: c.installSlug, latestVersion: c.latestVersion, summary: c.summary, author: c.author }
  }

  /** The updater leaves items alone whose source is gone or switched off ("no longer updated"). */
  function updatesPaused(cardId: string): boolean {
    const parts = splitSourceCardId(cardId)
    if (!parts) return false
    const s = find(parts.source)
    if (!s || state.disabled.includes(parts.source)) return true
    // Signed out: a private source (or a Forsion Git package listed by a public one) can't be read. Wait for the
    // sign-in instead of marking the item as failed.
    const viaGit = refOf(s).kind === 'forsion-git' || !!state.installs.find((x) => x.cardId === cardId)?.origin.startsWith('forsion-git:')
    return viaGit && !!o.forsionSignedIn && !o.forsionSignedIn()
  }

  async function downloadPackage(pkg: StorePackage, type: string, onProgress: (p: DownloadProgress) => void, allowLocal: boolean): Promise<{ buf: Buffer; url: string }> {
    const mirror = await o.mirror()
    const fetchFn = (u: string, init: { signal: AbortSignal }) => o.fetchFor(u)(u, init)
    if (pkg.kind === 'forsion-git') {
      const a = await gitAccess().catch((e: StoreIndexError) => { throw new Error(`resolve: ${e.code}`) })
      const url = gitUrl(a, 'archive', { repo: pkg.repo, ref: pkg.ref })
      // The server's refusal carries a reason code; downloadZip only knows "HTTP 4xx", so keep the code and rethrow it.
      let refused = ''
      const authed: FetchFn = async (u, init) => {
        const res = await o.fetchFor(u)(u, { ...init, redirect: 'manual', headers: { authorization: `Bearer ${a.token}` } })
        if (!res.ok) refused = await gitFailure(res)
        return res
      }
      const zip = await downloadZip([url], authed, onProgress, ZIP_MAGIC).catch((e) => { throw refused ? new Error(`resolve: ${refused}`) : e })
      // Gitea's archive wraps everything in `<repo>/` (one top folder): subtreeZip strips it like GitHub's.
      return { buf: pkg.path ? await subtreeZip(zip, pkg.path) : zip, url: `forsion-git:${pkg.repo}@${pkg.ref}` }
    }
    if (pkg.kind === 'github') {
      const url = `https://github.com/${pkg.repo}/archive/${pkg.ref}.zip`
      const zip = await downloadZip(downloadCandidates(url, mirror, o.githubProxy?.() || ''), fetchFn, onProgress, ZIP_MAGIC)
      return { buf: pkg.path ? await subtreeZip(zip, pkg.path) : zip, url }
    }
    if (pkg.kind === 'url') {
      const zip = await downloadZip([pkg.url], guardedFetch(allowLocal), onProgress, ZIP_MAGIC)
      if (createHash('sha256').update(zip).digest('hex') !== pkg.sha256) throw new Error('install: package checksum mismatch')
      return { buf: zip, url: pkg.url }
    }
    let integrity = pkg.integrity
    if (!integrity) {
      // The registry's own record of this exact version; the tarball is checked against it below.
      for (const registry of registryOrder(mirror)) {
        const doc = await fetchFn(`${registry}/${pkg.name.replace('/', '%2f')}/${pkg.version}`, { signal: timeoutSignal(15_000) })
          .then((r) => r.ok ? r.json() as Promise<{ dist?: { integrity?: string } }> : null).catch(() => null)
        const found = doc?.dist?.integrity?.split(/\s+/)[0]
        if (found?.startsWith('sha512-')) { integrity = found; break }
      }
      if (!integrity) throw new Error('resolve: npm version not found')
    }
    const snapshot = { npmPackage: pkg.name, version: pkg.version, integrity }
    const tgz = await downloadZip(npmDownloadCandidates(snapshot, mirror), fetchFn, onProgress, GZIP_MAGIC)
    return { buf: await npmTarballToZip(tgz, snapshot, type), url: `npm:${pkg.name}@${pkg.version}` }
  }

  /** Resolve and download an item. `auto` = the updater: it stops when the package now comes from somewhere else. */
  async function download(cardId: string, opts: { version?: string; auto?: boolean; onProgress?: (p: DownloadProgress) => void } = {}): Promise<SourceDownload> {
    const { s, it } = await itemOf(cardId, { refresh: !opts.auto })
    if (opts.version && opts.version !== it.version) throw new Error('resolve: version-unavailable')
    const origin = packageOrigin(it.package)
    // Automatic updates only follow a package whose origin and type match what the user installed. No record of
    // that (a crash between install and the write, a failed write) counts as "moved": the user updates by hand.
    if (opts.auto) {
      const rec = state.installs.find((x) => x.cardId === cardId)
      if (!rec || rec.origin !== origin || rec.type !== it.type) throw new Error('resolve: source-package-moved')
    }
    const { buf, url } = await downloadPackage(it.package, it.type, opts.onProgress ?? (() => {}), localSource(refOf(s)))
    return {
      buf, origin,
      info: {
        type: it.type, installSlug: sourceInstallSlug(s.id, it.id), downloadUrl: url, source: it.package.kind === 'npm' ? 'npm' : it.package.kind === 'github' ? 'github' : 'zip',
        version: it.version, ...(it.minAppVersion ? { minAppVersion: it.minAppVersion } : {}), ...(it.maxAppVersion ? { maxAppVersion: it.maxAppVersion } : {}),
        ...(it.platforms ? { platforms: it.platforms } : {}), tags: it.tags,
      },
    }
  }

  /** summary / author are copied in so "Installed" can still describe the item after its source is gone. */
  async function recordInstall(r: { cardId: string; type: string; slug: string; name: string; version: string | null; origin: string; summary?: string; author?: string }): Promise<void> {
    await save((s) => { s.installs = [...s.installs.filter((x) => !(x.type === r.type && x.slug === r.slug) && x.cardId !== r.cardId), { ...r, at: Date.now() }] })
  }
  async function forget(type: string, slug: string): Promise<void> {
    await load()
    if (!state.installs.some((x) => x.type === type && x.slug === slug)) return
    await save((s) => { s.installs = s.installs.filter((x) => !(x.type === type && x.slug === slug)) })
  }
  async function installs(locale = o.defaultLocale()): Promise<StoreSourceInstall[]> {
    await load()
    return state.installs.map((x) => {
      const sourceId = splitSourceCardId(x.cardId)!.source
      const s = find(sourceId)
      const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
      return { cardId: x.cardId, type: x.type, slug: x.slug, name: x.name, version: x.version, sourceId, sourceTitle: s ? titleOf(s, locale) : null, removed: !s || state.disabled.includes(sourceId), summary: text(x.summary, 400), author: text(x.author, 80) }
    })
  }

  return { load, list, probe, add, remove, setDisabled, trust, setDeclared, catalog, detail, lookup, updatesPaused, download, recordInstall, forget, installs }
}
export type StoreSources = ReturnType<typeof createStoreSources>
