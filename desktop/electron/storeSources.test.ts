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

  it('never writes over a state file it could not read', async () => {
    await mkdir(join(home, '.store-sources'), { recursive: true })
    await writeFile(join(home, '.store-sources', 'state.json'), '{broken')
    routes[CATALOG] = () => json(index([poster()]))
    const s = make()
    await expect(s.add('github:pixel-lab/image-skills')).rejects.toThrow('source: state-unreadable')
    expect(await readFile(join(home, '.store-sources', 'state.json'), 'utf8')).toBe('{broken')
  })
})

describe('package helpers', () => {
  it('refuses a folder that is not in the archive and reads the manifest id', async () => {
    const z = await zipOf({ 'r-main/a/manifest.json': JSON.stringify({ id: 'my-plugin', version: '1.0.0' }) })
    await expect(subtreeZip(z, 'b')).rejects.toThrow('install: package folder not found')
    expect(await packageManifestId(await subtreeZip(z, 'a'), 'amadeus-plugin')).toBe('my-plugin')
  })
})
