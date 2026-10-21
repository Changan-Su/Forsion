/** Build-time only: pinned npm integrity + official SIGNATURE. No runtime code download. */
import { createHash, verify } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Plugin } from 'vite'
import bundles from '../../desktop/electron/builtinBundles.json'
import { canonicalFiles, type BundleSignature } from '../../desktop/electron/bundleSignature'
import { stripTopDir, untar } from '../../desktop/electron/minitar'

const ID = 'virtual:forsion-mobile-extend'
const LOCK = resolve(import.meta.dirname, '../../desktop/package-lock.json')
const CACHE = resolve(import.meta.dirname, '../.extend-cache')
const trusted = bundles.find((b) => b.id === 'forsion-extend')!
const safe = (p: string): boolean => !!p && !p.includes('\\') && !p.includes('\0') && !p.startsWith('/') && p.split('/').every((s) => s !== '.' && s !== '..' && !!s)

export function verifyExtendFiles(files: Map<string, Buffer>, key = trusted.desktop!.signingKey): void {
  const signature = JSON.parse(files.get('SIGNATURE')?.toString() || 'null') as BundleSignature | null
  if (!signature || signature.alg !== 'ed25519' || !signature.files || typeof signature.sig !== 'string') throw new Error('Extend SIGNATURE is missing or malformed')
  const entries = Object.entries(signature.files)
  if (!entries.length || entries.length > 5000) throw new Error('Extend SIGNATURE file count is invalid')
  if (!verify(null, Buffer.from(canonicalFiles(signature.files)), key, Buffer.from(signature.sig, 'base64'))) throw new Error('Extend signature does not match the pinned public key')
  for (const required of ['manifest.json', 'package.json', 'dist/main.js']) if (!(required in signature.files)) throw new Error(`Extend ${required} is unsigned`)
  for (const [p, digest] of entries) {
    if (!safe(p) || p === 'SIGNATURE' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Extend SIGNATURE has an unsafe entry')
    const data = files.get(p)
    if (!data || createHash('sha256').update(data).digest('hex') !== digest) throw new Error(`Extend ${p} does not match its signed hash`)
  }
  // Only signed bytes may reach the virtual module (extra package files are ignored).
  for (const p of files.keys()) if (p !== 'SIGNATURE' && !(p in signature.files)) files.delete(p)
}

export async function loadExtendBundle(opts: { mode: string; testRoot?: string; packagePath?: string; packageIntegrity?: string; fetch?: typeof fetch; cacheDir?: string }) {
  let files: Map<string, Buffer>
  if (opts.testRoot) {
    if (opts.mode !== 'extend-test') throw new Error('FORSION_EXTEND_TEST_ROOT is only allowed with --mode extend-test; it cannot ship in a production build')
    const root = resolve(opts.testRoot)
    files = new Map()
    for (const p of ['manifest.json', 'package.json', 'dist/main.js', 'README.md', 'CHANGELOG.md']) files.set(p, await fs.readFile(resolve(root, p)))
    const walk = async (dir: string, rel = 'spaces'): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = `${rel}/${e.name}`
        if (e.isDirectory()) await walk(resolve(dir, e.name), p)
        else if (e.isFile() && e.name === 'space.json') files.set(p, await fs.readFile(resolve(dir, e.name)))
      }
    }
    await walk(resolve(root, 'spaces'))
  } else {
    const staged = await fs.readFile(resolve(import.meta.dirname, '../extend-bundle.json'), 'utf8').then((s) => JSON.parse(s) as { path: string; integrity: string; version: string }).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
    const lock = JSON.parse(await fs.readFile(LOCK, 'utf8')).packages['node_modules/@forsion/extend']
    const local = opts.packagePath || (staged ? resolve(import.meta.dirname, '..', staged.path) : undefined)
    const expected = opts.packagePath ? opts.packageIntegrity : staged?.integrity
    if (staged && (!safe(staged.path) || !/^vendor\/[^/]+\.tgz$/.test(staged.path) || !/^sha512-[A-Za-z0-9+/=]+$/.test(staged.integrity) || typeof staged.version !== 'string')) throw new Error('Extend staged package pin is invalid')
    if (!lock?.version || !/^sha512-[A-Za-z0-9+/=]+$/.test(lock.integrity)) throw new Error('Extend npm pin is missing')
    const cache = opts.cacheDir || CACHE
    const path = resolve(cache, `extend-${lock.version}.tgz`)
    let tarball = local ? await fs.readFile(resolve(local)) : await fs.readFile(path).catch(() => null)
    const integrity = (b: Buffer): boolean => `sha512-${createHash('sha512').update(b).digest('base64')}` === lock.integrity
    if (local && expected && `sha512-${createHash('sha512').update(tarball!).digest('base64')}` !== expected) throw new Error('Extend staged package integrity mismatch')
    if (!local && (!tarball || !integrity(tarball))) {
      const url = new URL(lock.resolved)
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Extend npm URL must use the official registry')
      const response = await (opts.fetch || fetch)(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`Extend npm download failed: ${response.status}`)
      tarball = Buffer.from(await response.arrayBuffer())
      if (!integrity(tarball)) throw new Error('Extend npm integrity mismatch')
      await fs.mkdir(cache, { recursive: true })
      await fs.writeFile(path, tarball)
    }
    const entries = stripTopDir(untar(gunzipSync(tarball!, { maxOutputLength: 64 * 1024 * 1024 })))
    if (entries.some((e) => !safe(e.path)) || new Set(entries.map((e) => e.path)).size !== entries.length) throw new Error('Extend archive has unsafe or duplicate entries')
    files = new Map(entries.map((e) => [e.path, e.data]))
    verifyExtendFiles(files)
    const pkg = JSON.parse(files.get('package.json')!.toString())
    const manifestVersion = JSON.parse(files.get('manifest.json')!.toString()).version
    const version = local ? (opts.packagePath ? manifestVersion : staged!.version) : lock.version
    if (pkg.name !== trusted.pkg || pkg.version !== version || manifestVersion !== version) throw new Error('Extend package identity does not match its pin')
  }
  const read = (p: string): string => files.get(p)?.toString('utf8') || ''
  const manifest = JSON.parse(read('manifest.json'))
  if (manifest.mobileHostApi !== 1) throw new Error('Extend package is missing mobileHostApi:1; stage the signed mobile-compatible package before building')
  if (manifest.id !== trusted.id || manifest.main !== 'dist/main.js' || !read(manifest.main)) throw new Error('Extend manifest identity or entry is invalid')
  const recipes = [...files.keys()].filter((p) => /^spaces\/[^/]+\/space.json$/.test(p)).map((p) => ({ slug: p.split('/')[1], json: read(p), plugin: manifest.id }))
  return { manifest, code: read(manifest.main), readme: read('README.md'), changelog: read('CHANGELOG.md'), recipes, testOnly: !!opts.testRoot }
}

export function mobileExtendBundle(mode: string, testRoot?: string, packagePath?: string, packageIntegrity?: string): Plugin {
  let data: Awaited<ReturnType<typeof loadExtendBundle>>
  return {
    name: 'mobile-signed-extend',
    async buildStart() { data = await loadExtendBundle({ mode, testRoot, packagePath, packageIntegrity }) },
    resolveId(id) { if (id === ID) return '\0' + ID },
    load(id) { if (id === '\0' + ID) return `export default ${JSON.stringify(data)}` },
    generateBundle() {
      if (data.testOnly) this.emitFile({ type: 'asset', fileName: 'forsion-extend-test-only.json', source: JSON.stringify({ testOnly: true, releaseForbidden: true }) })
    },
  }
}
