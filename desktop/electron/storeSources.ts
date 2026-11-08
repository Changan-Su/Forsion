/**
 * Store sources, main-process half (pure rules: shared/storeSources.ts).
 *
 * - The source table lives on disk (<home>/.store-sources/state.json), plugin-declared sources included, so the
 *   plugin updater can resolve source items at startup before any window syncs.
 * - A source only gives a catalog; packages download here and go through the same checks and install path as Forsion
 *   store items (main.ts routes `src_…` card ids to this module).
 * - Where each installed item came from is kept for every type (the plugin updater only tracks plugins).
 * - A state file that exists but cannot be read is "unknown": nothing is written back over it.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { computeStripPrefix, downloadCandidates, downloadZip, GZIP_MAGIC, isJunkPath, MARKET_MANIFEST, ZIP_MAGIC, type DownloadProgress } from './marketInstall'
import { npmDownloadCandidates, npmTarballToZip } from './npmMarketInstall'
import { untar } from './minitar'
import { registryOrder, resolveLatest, timeoutSignal } from '../shared/npmRegistry'
import {
  canonicalSource, declaredSourcesOf, isSourceId, MAX_INDEX_BYTES, packageOrigin, parseSourceInput, parseStoreIndex, pickText,
  sourceCardId, sourceInstallSlug, splitSourceCardId, STORE_INDEX_FILE, StoreIndexError,
  type DeclaredStoreSource, type LocalText, type StoreIndex, type StoreIndexItem, type StorePackage, type StoreSourceRef,
  type StoreSourceCard, type StoreSourceCatalog, type StoreSourceInfo, type StoreSourceInstall,
} from '../shared/storeSources'
export type { StoreSourceCard, StoreSourceCatalog, StoreSourceInfo, StoreSourceInstall }

type FetchFn = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

interface UserSource { id: string; uri: string; title?: LocalText; addedAt: number }
interface PluginSource { id: string; pluginId: string; declId: string; uri: string; title: LocalText; icon?: string }
interface InstallRecord { cardId: string; type: string; slug: string; name: string; version: string | null; origin: string; at: number; summary?: string; author?: string }
interface State { user: UserSource[]; declared: PluginSource[]; disabled: string[]; trusted: string[]; installs: InstallRecord[] }

export interface SourceDownload {
  info: { type: string; installSlug: string; downloadUrl: string; source: string; version: string; minAppVersion?: string; maxAppVersion?: string; platforms?: string[]; tags?: string[] }
  buf: Buffer
  origin: string
}

const FRESH_MS = 10 * 60_000
const CONNECT_MS = 15_000
const TOTAL_MS = 30_000
const hash8 = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8)
const hostOf = (url: string) => { try { return new URL(url).host } catch { return url.slice(0, 60) } }
const errorText = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code || (e instanceof Error ? e.message : String(e))

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

/** Cut one folder out of a repository archive (GitHub wraps everything in `<repo>-<ref>/`). */
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

/** Manifest id of the package, read the way the installer re-roots it (shallowest manifest). */
export async function packageManifestId(buf: Buffer, type: string): Promise<string | null> {
  const manifest = MARKET_MANIFEST[type]?.[0]
  if (!manifest?.endsWith('.json')) return null
  const zip = await JSZip.loadAsync(buf)
  const names = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name)
  const prefix = computeStripPrefix(names, MARKET_MANIFEST[type])
  const file = zip.file(`${prefix}${manifest}`)
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
}) {
  const root = join(o.home, '.store-sources'), stateFile = join(root, 'state.json'), cacheDir = join(root, 'cache')
  const disk = createSerialQueue()
  let state: State = { user: [], declared: [], disabled: [], trusted: [], installs: [] }
  let readable = true
  let loaded: Promise<void> | undefined
  const memo = new Map<string, { at: number; index: StoreIndex }>()
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
  const save = (mutate: (s: State) => State | void) => disk(async () => {
    await load()
    if (!readable) throw new StoreIndexError('state-unreadable')
    const draft = structuredClone(state)
    const next = mutate(draft) ?? draft
    await writePrivateJson(stateFile, { v: 1, ...next })
    state = next
  })

  const refOf = (s: { uri: string }) => parseSourceInput(s.uri)!
  const all = (): Array<UserSource | PluginSource> => [...state.declared, ...state.user]
  const find = (id: string) => all().find((s) => s.id === id)
  const fallbackTitle = (ref: StoreSourceRef): string =>
    ref.kind === 'npm' ? ref.name : ref.kind === 'url' ? hostOf(ref.url) : ref.repo.split('/')[1]
  const titleOf = (s: UserSource | PluginSource, locale: string): string =>
    pickText(s.title, locale) || pickText(memo.get(s.id)?.index.title, locale) || fallbackTitle(refOf(s))
  const info = (s: UserSource | PluginSource, locale: string): StoreSourceInfo => ({
    id: s.id, title: titleOf(s, locale), uri: canonicalSource(refOf(s)), kind: refOf(s).kind,
    trusted: state.trusted.includes(s.id), disabled: state.disabled.includes(s.id),
    ...('pluginId' in s ? { origin: 'plugin' as const, pluginId: s.pluginId, ...(s.icon ? { icon: s.icon } : {}) } : { origin: 'user' as const }),
  })

  // ── Catalog fetching ──
  async function rawIndex(ref: StoreSourceRef): Promise<{ json: unknown; base?: string }> {
    const mirror = await o.mirror()
    if (ref.kind === 'forsion-git') throw new StoreIndexError('forsion-git-unsupported')
    if (ref.kind === 'url') return { json: JSON.parse(await fetchTextFirst([ref.url], o.fetchFor)), base: new URL('.', ref.url).toString() }
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
    let got: { json: unknown; base?: string }
    try { got = await rawIndex(ref) } catch (e) {
      if (e instanceof SyntaxError) throw new StoreIndexError('index-invalid')
      throw e
    }
    const index = parseStoreIndex(got.json)
    memo.set(id, { at: Date.now(), index }); bases.set(id, got.base)
    await mkdir(cacheDir, { recursive: true }).catch(() => {})
    // The raw file is cached (not the parsed form): it is parsed again with the same rules when read back.
    await writePrivateJson(join(cacheDir, `${id}.json`), { at: Date.now(), base: got.base ?? null, json: got.json }).catch(() => {})
    return index
  }
  /** Fresh enough copy, or fetch. `allowStale` falls back to the copy on disk when fetching fails. */
  async function indexOf(id: string, opts: { refresh?: boolean } = {}): Promise<{ index: StoreIndex; at: number; stale: boolean; error?: string }> {
    const s = find(id)
    if (!s) throw new StoreIndexError('not-found')
    const hit = memo.get(id)
    if (hit && !opts.refresh && Date.now() - hit.at < FRESH_MS) return { index: hit.index, at: hit.at, stale: false }
    let job = inflight.get(id)
    if (!job) { job = fetchIndex(id, refOf(s)).finally(() => inflight.delete(id)); inflight.set(id, job) }
    try { const index = await job; return { index, at: memo.get(id)!.at, stale: false } } catch (e) {
      const code = e instanceof Error ? e.message : String(e)
      if (hit) return { index: hit.index, at: hit.at, stale: true, error: code }
      const cached = await readFile(join(cacheDir, `${id}.json`), 'utf8').then((t) => JSON.parse(t), () => null)
      if (cached?.json) {
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
      return u.protocol === 'https:' ? u.toString() : null
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
    return all().map((s) => info(s, locale))
  }

  async function probe(input: unknown, locale = o.defaultLocale()): Promise<{ uri: string; kind: StoreSourceRef['kind']; title: string; count: number; duplicate?: string }> {
    await load()
    const ref = parseSourceInput(input)
    if (!ref) throw new StoreIndexError('unrecognized')
    const uri = canonicalSource(ref)
    const dup = all().find((s) => canonicalSource(refOf(s)) === uri)
    if (ref.kind === 'forsion-git') throw new StoreIndexError('forsion-git-unsupported')
    const got = await rawIndex(ref).catch((e) => { throw e instanceof SyntaxError ? new StoreIndexError('index-invalid') : e })
    const index = parseStoreIndex(got.json)
    return { uri, kind: ref.kind, title: pickText(index.title, locale) || fallbackTitle(ref), count: index.items.length, ...(dup ? { duplicate: dup.id } : {}) }
  }

  async function add(input: unknown, locale = o.defaultLocale()): Promise<StoreSourceInfo> {
    const ref = parseSourceInput(input)
    if (!ref) throw new StoreIndexError('unrecognized')
    if (ref.kind === 'forsion-git') throw new StoreIndexError('forsion-git-unsupported')
    const uri = canonicalSource(ref)
    const id = hash8(`uri:${uri}`)
    await load()
    if (all().some((s) => s.id === id || canonicalSource(refOf(s)) === uri)) throw new StoreIndexError('duplicate')
    // Only a readable catalog becomes a source.
    const index = await fetchIndex(id, ref)
    await save((s) => { if (!s.user.some((x) => x.id === id)) s.user.push({ id, uri, ...(index.title ? { title: index.title } : {}), addedAt: Date.now() }) })
    return info(find(id)!, locale)
  }

  async function remove(id: string): Promise<void> {
    await load()
    const s = state.user.find((x) => x.id === id)
    if (!s) throw new StoreIndexError('not-found')
    await save((st) => { st.user = st.user.filter((x) => x.id !== id); st.trusted = st.trusted.filter((x) => x !== id); st.disabled = st.disabled.filter((x) => x !== id) })
    memo.delete(id); bases.delete(id)
    await rm(join(cacheDir, `${id}.json`), { force: true }).catch(() => {})
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
    await load()
    const list: DeclaredStoreSource[] = []
    for (const d of Array.isArray(raw) ? raw : []) {
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
    if (JSON.stringify(next) === JSON.stringify(state.declared)) return false
    for (const s of next) { const was = state.declared.find((x) => x.id === s.id); if (was && was.uri !== s.uri) { memo.delete(s.id); bases.delete(s.id) } }
    await save((s) => { s.declared = next })
    return true
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
    return !find(parts.source) || state.disabled.includes(parts.source)
  }

  async function downloadPackage(pkg: StorePackage, type: string, onProgress: (p: DownloadProgress) => void): Promise<{ buf: Buffer; url: string }> {
    const mirror = await o.mirror()
    const fetchFn = (u: string, init: { signal: AbortSignal }) => o.fetchFor(u)(u, init)
    if (pkg.kind === 'forsion-git') throw new Error('resolve: forsion-git-unsupported')
    if (pkg.kind === 'github') {
      const url = `https://github.com/${pkg.repo}/archive/${pkg.ref}.zip`
      const zip = await downloadZip(downloadCandidates(url, mirror, o.githubProxy?.() || ''), fetchFn, onProgress, ZIP_MAGIC)
      return { buf: pkg.path ? await subtreeZip(zip, pkg.path) : zip, url }
    }
    if (pkg.kind === 'url') {
      const zip = await downloadZip([pkg.url], fetchFn, onProgress, ZIP_MAGIC)
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
    if (opts.auto) {
      const rec = state.installs.find((x) => x.cardId === cardId)
      if (rec && rec.origin !== origin) throw new Error('resolve: source-package-moved')
    }
    const { buf, url } = await downloadPackage(it.package, it.type, opts.onProgress ?? (() => {}))
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
