import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStoreSources, packageManifestId, subtreeZip } from './storeSources'

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip()
  for (const [k, v] of Object.entries(files)) z.file(k, v)
  return z.generateAsync({ type: 'nodebuffer' })
}
const skill = (name: string, version: string) => `---\nname: ${name}\nversion: ${version}\n---\nbody`

let home: string
let routes: Record<string, () => Response | Promise<Response>>
let hits: string[]
const make = () => createStoreSources({
  home, mirror: async () => '', defaultLocale: () => 'zh',
  fetchFor: () => async (url) => { hits.push(url); const r = routes[url]; if (!r) return new Response('nope', { status: 404 }); return r() },
})
const CATALOG = 'https://raw.githubusercontent.com/pixel-lab/image-skills/HEAD/forsion-store.json'
const index = (items: unknown[]) => ({ schema: 1, title: { zh: '图片 Skills 大全', en: 'Image skills' }, author: 'Pixel Lab', items })
const poster = (version = '1.2.0', pkg: unknown = { github: 'pixel-lab/image-skills', ref: `v${version}`, path: 'skills/poster' }) =>
  ({ id: 'poster', type: 'skill', name: { zh: '海报排版', en: 'Poster layout' }, version, icon: 'icons/poster.png', package: pkg })

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'store-sources-')); routes = {}; hits = [] })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('store sources', () => {
  it('adds a GitHub source and lists its catalog as store cards', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const src = await s.add('https://github.com/pixel-lab/image-skills')
    expect(src).toMatchObject({ title: '图片 Skills 大全', origin: 'user', kind: 'github', uri: 'https://github.com/pixel-lab/image-skills', trusted: false })
    await expect(s.add('github:pixel-lab/image-skills')).rejects.toThrow('source: duplicate')
    const cat = await s.catalog(src.id, { locale: 'en' })
    expect(cat.items).toHaveLength(1)
    expect(cat.items[0]).toMatchObject({
      id: `src_${src.id}_poster`, installSlug: `src-${src.id}-poster`, name: 'Poster layout', type: 'skill', source: 'github', latestVersion: '1.2.0',
      iconUrl: 'https://raw.githubusercontent.com/pixel-lab/image-skills/HEAD/icons/poster.png', origin: { sourceId: src.id, sourceTitle: 'Image skills' },
    })
    // A second instance (next launch) reads the table back.
    expect((await make().list()).map((x) => x.id)).toEqual([src.id])
  })

  it('refuses a catalog it cannot read and does not keep the source', async () => {
    routes[CATALOG] = () => new Response('<html>', { status: 200 })
    const s = make()
    await expect(s.add('github:pixel-lab/image-skills')).rejects.toThrow('source: index-invalid')
    await expect(s.add('git.forsion.net/acme/x')).rejects.toThrow('source: forsion-git-unsupported')
    expect(await s.list()).toEqual([])
  })

  it('shows the last copy when the source is unreachable', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const src = await s.add('github:pixel-lab/image-skills')
    delete routes[CATALOG]
    const again = await make().catalog(src.id, { refresh: true })
    expect(again.stale).toBe(true)
    expect(again.items.map((x) => x.name)).toEqual(['海报排版'])
  })

  it('downloads one folder of a repository archive and keeps where it came from', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const archive = await zipOf({ 'image-skills-1.2.0/skills/poster/SKILL.md': skill('poster', '1.2.0'), 'image-skills-1.2.0/skills/other/SKILL.md': skill('other', '9.9.9'), 'image-skills-1.2.0/README.md': 'x' })
    routes['https://github.com/pixel-lab/image-skills/archive/v1.2.0.zip'] = () => new Response(new Uint8Array(archive))
    const s = make()
    const src = await s.add('github:pixel-lab/image-skills')
    const got = await s.download(`src_${src.id}_poster`)
    const names = Object.keys((await JSZip.loadAsync(got.buf)).files)
    expect(names).toEqual(['SKILL.md'])
    expect(got.info).toMatchObject({ type: 'skill', installSlug: `src-${src.id}-poster`, version: '1.2.0', source: 'github' })
    expect(got.origin).toBe('github:pixel-lab/image-skills')
    await s.recordInstall({ cardId: `src_${src.id}_poster`, type: 'skill', slug: `src-${src.id}-poster`, name: '海报排版', version: '1.2.0', origin: got.origin })
    expect(await s.installs()).toEqual([expect.objectContaining({ slug: `src-${src.id}-poster`, sourceTitle: '图片 Skills 大全', removed: false })])
    await expect(s.download(`src_${src.id}_poster`, { version: '1.0.0' })).rejects.toThrow('resolve: version-unavailable')
  })

  it('stops an automatic update whose package moved elsewhere, and pauses updates once the source is gone', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const src = await s.add('github:pixel-lab/image-skills')
    const cardId = `src_${src.id}_poster`
    await s.recordInstall({ cardId, type: 'skill', slug: `src-${src.id}-poster`, name: 'x', version: '1.2.0', origin: 'github:pixel-lab/image-skills' })
    routes[CATALOG] = () => json(index([poster('1.3.0', { url: 'https://evil.example/x.zip', sha256: 'a'.repeat(64) })]))
    await s.catalog(src.id, { refresh: true })
    await expect(s.download(cardId, { auto: true })).rejects.toThrow('resolve: source-package-moved')
    expect(s.updatesPaused(cardId)).toBe(false)
    await s.remove(src.id)
    expect(s.updatesPaused(cardId)).toBe(true)
    expect((await s.installs())[0]).toMatchObject({ removed: true, sourceTitle: null })
    await expect(s.lookup(cardId)).rejects.toThrow('resolve: source-removed')
  })

  it('checks the hash of a package given by address', async () => {
    const pkgZip = await zipOf({ 'SKILL.md': skill('p', '1.0.0') })
    const sha = createHash('sha256').update(pkgZip).digest('hex')
    routes['https://cdn.example.com/forsion-store.json'] = () => json(index([
      { id: 'good', type: 'skill', name: 'Good', version: '1.0.0', package: { url: 'https://cdn.example.com/p.zip', sha256: sha } },
      { id: 'bad', type: 'skill', name: 'Bad', version: '1.0.0', package: { url: 'https://cdn.example.com/p.zip', sha256: 'b'.repeat(64) } },
    ]))
    routes['https://cdn.example.com/p.zip'] = () => new Response(new Uint8Array(pkgZip))
    const s = make()
    const src = await s.add('https://cdn.example.com/forsion-store.json')
    await expect(s.download(`src_${src.id}_good`)).resolves.toMatchObject({ origin: 'url:cdn.example.com' })
    await expect(s.download(`src_${src.id}_bad`)).rejects.toThrow('install: package checksum mismatch')
  })

  it('keeps plugin-declared sources on disk for the next launch, and can switch them off', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    await s.setDeclared([{ pluginId: 'image-skills', id: 'main', title: { zh: '图片 Skills 大全' }, index: 'github:pixel-lab/image-skills', icon: 'image' }, { pluginId: 'x', id: 'bad', title: 'x', index: 'ftp://x' }])
    const [src] = await make().list()
    expect(src).toMatchObject({ origin: 'plugin', pluginId: 'image-skills', icon: 'image' })
    await expect(s.remove(src.id)).rejects.toThrow('source: not-found')
    await s.setDisabled(src.id, true)
    expect(s.updatesPaused(`src_${src.id}_poster`)).toBe(true)
    await s.setDeclared([])
    expect(await s.list()).toEqual([])
  })

  it('does not update automatically without a record of where the package came from', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const src = await s.add('github:pixel-lab/image-skills')
    await expect(s.download(`src_${src.id}_poster`, { auto: true })).rejects.toThrow('resolve: source-package-moved')
    await s.recordInstall({ cardId: `src_${src.id}_poster`, type: 'plugin', slug: `src-${src.id}-poster`, name: 'x', version: '1.2.0', origin: 'github:pixel-lab/image-skills' })
    // Same origin, but the catalog now says it is another kind of thing.
    await expect(s.download(`src_${src.id}_poster`, { auto: true })).rejects.toThrow('resolve: source-package-moved')
  })

  it('never lets a public catalog send downloads to this machine or the local network', async () => {
    const pkgZip = await zipOf({ 'SKILL.md': skill('p', '1.0.0') })
    const sha = createHash('sha256').update(pkgZip).digest('hex')
    routes['https://cdn.example.com/forsion-store.json'] = () => json(index([
      { id: 'local', type: 'skill', name: 'L', version: '1.0.0', package: { url: 'http://localhost:8787/admin/reset', sha256: sha } },
      { id: 'lan', type: 'skill', name: 'N', version: '1.0.0', package: { url: 'https://192.168.1.1/p.zip', sha256: sha } },
      { id: 'hop', type: 'skill', name: 'H', version: '1.0.0', package: { url: 'https://cdn.example.com/hop.zip', sha256: sha } },
      { id: 'ok', type: 'skill', name: 'O', version: '1.0.0', package: { url: 'https://cdn.example.com/moved.zip', sha256: sha } },
    ]))
    routes['https://cdn.example.com/hop.zip'] = () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9000/x' } })
    routes['https://cdn.example.com/moved.zip'] = () => new Response(null, { status: 302, headers: { location: 'https://files.example.net/p.zip' } })
    routes['https://files.example.net/p.zip'] = () => new Response(new Uint8Array(pkgZip))
    const s = make()
    const src = await s.add('https://cdn.example.com/forsion-store.json')
    for (const id of ['local', 'lan', 'hop']) await expect(s.download(`src_${src.id}_${id}`)).rejects.toThrow('resolve: address-not-allowed')
    expect(hits.some((u) => /localhost|127\.0\.0\.1|192\.168/.test(u))).toBe(false)
    await expect(s.download(`src_${src.id}_ok`)).resolves.toMatchObject({ origin: 'url:cdn.example.com' })
  })

  it('forgets trust and the cached catalog when a plugin points its source somewhere else', async () => {
    const OTHER = 'https://raw.githubusercontent.com/pixel-lab/other/HEAD/forsion-store.json'
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const decl = (index: string) => [{ pluginId: 'image-skills', id: 'main', title: 'Images', index }]
    await s.setDeclared(decl('github:pixel-lab/image-skills'))
    const [src] = await s.list()
    await s.catalog(src.id, { refresh: true }); await s.trust(src.id)
    await s.setDeclared(decl('github:pixel-lab/other'))
    const [moved] = await s.list()
    expect(moved).toMatchObject({ id: src.id, trusted: false, uri: 'https://github.com/pixel-lab/other' })
    // The new address can't be read: the old address's catalog must not stand in for it.
    expect(routes[OTHER]).toBeUndefined()
    const cat = await make().catalog(src.id, { refresh: true })
    expect(cat.items).toEqual([]); expect(cat.error).toBe('source: fetch-failed')
    await expect(s.setDeclared('nope')).rejects.toThrow('source: invalid')
  })

  it('applies plugin-declared lists in the order they were sent', async () => {
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    const a = [{ pluginId: 'image-skills', id: 'main', title: 'A', index: 'github:pixel-lab/image-skills' }]
    await s.setDeclared(a)
    await Promise.all([s.setDeclared([]), s.setDeclared(a)])
    expect((await make().list()).map((x) => x.title)).toEqual(['A'])
  })

  it('never writes over a state file it could not read', async () => {
    await mkdir(join(home, '.store-sources'), { recursive: true })
    await writeFile(join(home, '.store-sources', 'state.json'), '{broken')
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    await expect(s.add('github:pixel-lab/image-skills')).rejects.toThrow('source: state-unreadable')
    expect(await readFile(join(home, '.store-sources', 'state.json'), 'utf8')).toBe('{broken')
  })
})

// Forsion Git: the Forsion server reads private repositories as the signed-in user (server/microserver/git/routes/store.ts).
// The server's answers here follow its tests (storeReads.test.ts) and the real Gitea 28 run (verify-git-store-reads.mts).
describe('Forsion Git sources', () => {
  const BASE = 'https://api.forsion.test'
  const jwt = (userId: string) => ['h', Buffer.from(JSON.stringify({ userId, exp: 9e9 })).toString('base64url'), 'sig'].join('.')
  let access: { base: string; token: string } | null
  let auths: Array<string | undefined>
  const makeGit = () => createStoreSources({
    home, mirror: async () => '', defaultLocale: () => 'zh',
    fetchFor: () => async (url, init) => {
      hits.push(url); auths.push(init.headers?.authorization)
      const r = routes[url]
      return r ? r() : new Response('<!doctype html>Cannot GET', { status: 404 })
    },
    forsionGit: async () => access,
    forsionSignedIn: () => !!access,
  })
  const INDEX = `${BASE}/api/git/store/index?repo=acme%2Fteam-kit`
  const ARCHIVE = `${BASE}/api/git/store/archive?repo=acme%2Fteam-kit&ref=v1.0.0`
  const refused = (status: number, code?: string) => () => new Response(JSON.stringify({ detail: 'x', ...(code ? { code } : {}) }), { status })
  const kit = (pkg: unknown = { forsionGit: 'acme/team-kit', ref: 'v1.0.0', path: 'skills/brief' }) =>
    ({ id: 'brief', type: 'skill', name: { zh: '周报', en: 'Weekly brief' }, version: '1.0.0', icon: 'icons/brief.png', package: pkg })
  beforeEach(() => { access = { base: BASE, token: jwt('u-alice') }; auths = [] })

  it('reads the catalog through the Forsion server as the signed-in account, and keeps it off the disk', async () => {
    routes[INDEX] = () => json(index([kit()]))
    const s = makeGit()
    const src = await s.add('forsion-git:acme/team-kit')
    expect(src).toMatchObject({ kind: 'forsion-git', uri: 'https://git.forsion.net/acme/team-kit', title: '图片 Skills 大全' })
    expect(auths).toEqual([`Bearer ${access!.token}`])
    const cat = await s.catalog(src.id, { locale: 'en' })
    expect(cat.items).toEqual([expect.objectContaining({ id: `src_${src.id}_brief`, name: 'Weekly brief', source: 'zip', iconUrl: null })])
    // Private catalog: never written to the disk cache, so a later launch (or another account) can't show it offline.
    await expect(readFile(join(home, '.store-sources', 'cache', `${src.id}.json`), 'utf8')).rejects.toThrow()
    // Gitea names (organisation with a dot) and the web address with a ref and a folder.
    routes[`${BASE}/api/git/store/index?repo=acme.team%2Fkit&ref=main&dir=catalog`] = () => json(index([]))
    expect(await s.probe('https://git.forsion.net/acme.team/kit/src/branch/main/catalog')).toMatchObject({ kind: 'forsion-git', count: 0 })
  })

  it('signed out: asks to sign in without calling anyone; a copy read as another account is never shown', async () => {
    routes[INDEX] = () => json(index([kit()]))
    const s = makeGit()
    const src = await s.add('forsion-git:acme/team-kit')
    access = null
    const before = hits.length
    await expect(s.probe('forsion-git:acme/other')).rejects.toThrow('source: forsion-git-signin')
    const out = await s.catalog(src.id)
    expect(out).toMatchObject({ items: [], error: 'source: forsion-git-signin', stale: false })
    expect(hits.length).toBe(before)
    expect(s.updatesPaused(`src_${src.id}_brief`)).toBe(true)
    // Bob signs in: Alice's copy (still fresh in memory) must not stand in for his own read.
    access = { base: BASE, token: jwt('u-bob') }
    routes[INDEX] = refused(404, 'GIT_NOT_FOUND')
    expect(await s.catalog(src.id)).toMatchObject({ items: [], error: 'source: forsion-git-no-access' })
    expect(s.updatesPaused(`src_${src.id}_brief`)).toBe(false)
    await expect(s.download(`src_${src.id}_brief`)).rejects.toThrow('source: forsion-git-no-access')
  })

  it('maps the server answers: expired sign-in, no read access, no Forsion Git account, not offered, missing catalog', async () => {
    const s = makeGit()
    for (const [answer, code] of [
      [refused(401), 'forsion-git-signin'], [refused(404, 'GIT_NOT_FOUND'), 'forsion-git-no-access'], [refused(409, 'GIT_NEEDS_SETUP'), 'forsion-git-needs-setup'],
      [refused(503, 'GIT_STORE_READS_OFF'), 'forsion-git-unsupported'], [refused(503, 'GIT_NOT_CONFIGURED'), 'forsion-git-unsupported'],
      [refused(404, 'GIT_FILE_NOT_FOUND'), 'index-missing'], [refused(413, 'GIT_TOO_LARGE'), 'too-large'], [refused(429, 'GIT_STORE_RATE_LIMITED'), 'fetch-failed'],
    ] as const) {
      routes[INDEX] = answer
      await expect(s.probe('forsion-git:acme/team-kit')).rejects.toThrow(`source: ${code}`)
    }
    delete routes[INDEX] // a server from before the endpoint: plain 404 page
    await expect(s.probe('forsion-git:acme/team-kit')).rejects.toThrow('source: forsion-git-unsupported')
    await expect(createStoreSources({ home, mirror: async () => '', defaultLocale: () => 'zh', fetchFor: () => fetch }).probe('forsion-git:acme/team-kit'))
      .rejects.toThrow('source: forsion-git-unsupported')
  })

  it('downloads the package folder from the archive the server streams, signed in as the user', async () => {
    routes[INDEX] = () => json(index([kit()]))
    // Gitea wraps the archive in `<repo>/` (not GitHub's `<repo>-<ref>/`).
    const archive = await zipOf({ 'team-kit/skills/brief/SKILL.md': skill('brief', '1.0.0'), 'team-kit/skills/other/SKILL.md': skill('other', '2.0.0'), 'team-kit/forsion-store.json': '{}' })
    routes[ARCHIVE] = () => new Response(new Uint8Array(archive))
    const s = makeGit()
    const src = await s.add('forsion-git:acme/team-kit')
    const got = await s.download(`src_${src.id}_brief`)
    expect(Object.keys((await JSZip.loadAsync(got.buf)).files)).toEqual(['SKILL.md'])
    expect(got.origin).toBe('forsion-git:acme/team-kit')
    expect(got.info).toMatchObject({ downloadUrl: 'forsion-git:acme/team-kit@v1.0.0', source: 'zip', version: '1.0.0' })
    expect(auths.at(-1)).toBe(`Bearer ${access!.token}`)

    for (const [answer, code] of [[refused(401), 'forsion-git-signin'], [refused(404, 'GIT_NOT_FOUND'), 'forsion-git-no-access'], [refused(404, 'GIT_REF_NOT_FOUND'), 'forsion-git-ref-missing']] as const) {
      routes[ARCHIVE] = answer
      await expect(s.download(`src_${src.id}_brief`)).rejects.toThrow(`resolve: ${code}`)
    }
    // Signed out between reading the catalog and downloading.
    routes[ARCHIVE] = () => new Response(new Uint8Array(archive))
    const cached = makeGit()
    await cached.catalog(src.id)
    access = null
    await expect(cached.download(`src_${src.id}_brief`, { auto: true })).rejects.toThrow('forsion-git-signin')
  })
})

describe('package helpers', () => {
  it('refuses a folder that is not in the archive and reads the manifest id', async () => {
    const z = await zipOf({ 'r-main/a/manifest.json': JSON.stringify({ id: 'my-plugin', version: '1.0.0' }) })
    await expect(subtreeZip(z, 'b')).rejects.toThrow('install: package folder not found')
    expect(await packageManifestId(await subtreeZip(z, 'a'), 'amadeus-plugin')).toBe('my-plugin')
  })

  it('reads the manifest the installer will write, and refuses two files landing on one path', async () => {
    // A Windows-style separator is laid out by the installer as `manifest.json` at the root.
    expect(await packageManifestId(await zipOf({ 'pkg\\manifest.json': JSON.stringify({ id: 'victim', version: '1.0.0' }), 'pkg\\main.js': 'x' }), 'amadeus-plugin')).toBe('victim')
    await expect(packageManifestId(await zipOf({ 'manifest.json': JSON.stringify({ id: 'a' }), 'Manifest.json': JSON.stringify({ id: 'b' }) }), 'amadeus-plugin')).rejects.toThrow('install: duplicate path in archive')
  })
})
