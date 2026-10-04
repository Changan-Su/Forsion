/** npm is an archive channel, not `npm install`: no lifecycle scripts or dependency execution. */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { untar } from './minitar'
import { computeStripPrefix, MARKET_MANIFEST } from './marketInstall'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
export interface NpmInstallSnapshot { npmPackage: string; version: string; integrity: string }

export function npmDownloadCandidates(info: NpmInstallSnapshot, mirror: string): string[] {
  if (!PACKAGE_NAME.test(info.npmPackage) || info.npmPackage.length > 214 || !VERSION.test(info.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(info.integrity)) throw new Error('resolve: invalid npm snapshot')
  const file = `${info.npmPackage}/-/${info.npmPackage.split('/').pop()}-${info.version}.tgz`
  const official = `https://registry.npmjs.org/${file}`
  return mirror === 'china' ? [`https://registry.npmmirror.com/${file}`, official] : [official]
}

/** Validate all bytes and paths before handing a normalized zip to the existing market installer. */
export async function npmTarballToZip(buffer: Buffer, info: NpmInstallSnapshot, type: string): Promise<Buffer> {
  npmDownloadCandidates(info, '')
  if (`sha512-${createHash('sha512').update(buffer).digest('base64')}` !== info.integrity) throw new Error('install: npm integrity mismatch')
  const entries = untar(gunzipSync(buffer, { maxOutputLength: 200 * 1024 * 1024 }))
  if (!entries.length || entries.length > 5000) throw new Error('install: invalid npm file count')
  const zip = new JSZip()
  const paths = new Set<string>()
  for (const entry of entries) {
    if (!entry.path.startsWith('package/')) throw new Error('install: invalid npm package root')
    const rel = entry.path.slice('package/'.length)
    if (!rel || rel.includes('\\') || rel.includes('\0') || rel.split('/').some((s) => !s || s === '.' || s === '..') || /^[a-z]:/i.test(rel) || paths.has(rel)) throw new Error('install: unsafe npm path')
    paths.add(rel)
    zip.file(rel, entry.data, { unixPermissions: entry.mode })
  }
  const pkg = entries.find((entry) => entry.path === 'package/package.json')
  const meta = pkg ? JSON.parse(pkg.data.toString('utf8')) : null
  if (meta?.name !== info.npmPackage || meta?.version !== info.version) throw new Error('install: npm package identity mismatch')
  const manifests = type === 'plugin' || type === 'amadeus-plugin' ? ['manifest.json', 'tangu-plugin.json'] : MARKET_MANIFEST[type] || []
  const names = [...paths]
  const prefix = computeStripPrefix(names, manifests)
  const manifest = manifests.map((name) => entries.find((entry) => entry.path === `package/${prefix}${name}`)).find(Boolean)
  if (!manifest) throw new Error('install: npm package has no Forsion manifest')
  const raw = manifest.data.toString('utf8')
  const version = manifest.path.endsWith('.json') ? JSON.parse(raw)?.version
    : type === 'skill' ? /(?:^|\n)version\s*:\s*["']?([^"'\r\n]+)/.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || '')?.[1]?.trim()
    : /(?:^|\n)\s*version\s*=\s*["']([^"'\n]+)["']/.exec(raw)?.[1]
  if (String(version || '').replace(/^v/i, '') !== info.version) throw new Error('install: npm and Forsion manifest versions differ')
  return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}
