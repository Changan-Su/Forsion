/** Operators stage trusted packages locally; remote management accepts only release IDs. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, rm, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { copyPackage } from './install'
import { readPackage } from './packages'

export const validReleaseId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
export interface StagedRelease { releaseId: string; pluginId: string; version: string; sha256: string; createdAt: string }
export async function packageDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(dir: string, prefix = ''): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const name = prefix + entry.name, path = join(dir, entry.name)
      if (entry.isDirectory()) { hash.update(JSON.stringify(['directory', name])); await visit(path, name + '/') }
      else if (entry.isSymbolicLink()) hash.update(JSON.stringify(['link', name, await readlink(path)]))
      else if (entry.isFile()) {
        const file = createHash('sha256')
        for await (const chunk of createReadStream(path)) file.update(chunk)
        hash.update(JSON.stringify(['file', name, file.digest('hex')]))
      } else throw new Error('Release contains a non-regular file')
    }
  }
  await visit(root)
  return hash.digest('hex')
}
export async function listReleases(dataDir: string): Promise<StagedRelease[]> {
  const root = join(dataDir, 'releases')
  let names: string[]
  try { names = await readdir(root) } catch (e: any) { if (e.code === 'ENOENT') return []; throw e }
  const result: StagedRelease[] = []
  for (const name of names.filter(validReleaseId).slice(0, 200)) {
    const item = JSON.parse(await readFile(join(root, name, 'release.json'), 'utf8')) as StagedRelease
    if (item.releaseId !== name) throw new Error('Invalid release record')
    result.push({ releaseId: name, pluginId: item.pluginId, version: item.version, sha256: item.sha256, createdAt: item.createdAt })
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function stageRelease(dataDir: string, source: string, version: string): Promise<StagedRelease> {
  const root = join(dataDir, 'releases'), id = randomUUID(), temporary = join(root, '.' + id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await listReleases(dataDir)).length >= 200) throw new Error('Release storage is full; archive unused staged packages locally')
  await mkdir(temporary, { mode: 0o700 })
  try {
    const pack = await copyPackage(source, join(temporary, 'package'), version)
    if (pack.manifest.backend?.dependencies?.mode === 'npm-ci' || pack.manifest.runtime?.dependencies?.mode === 'npm-ci') {
      throw new Error('Stage requires a bundled package; install and seal dependencies on the target platform first')
    }
    const item: StagedRelease = { releaseId: id, pluginId: pack.manifest.id, version: pack.manifest.version,
      sha256: await packageDigest(pack.root), createdAt: new Date().toISOString() }
    await writeFile(join(temporary, 'release.json'), JSON.stringify(item), { mode: 0o600 })
    await rename(temporary, join(root, id))
    return item
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
export async function resolveRelease(dataDir: string, id: string, pluginId: string, version: string, verifyContents = true) {
  if (!validReleaseId(id)) throw new Error('Invalid release ID')
  const root = join(dataDir, 'releases', id), path = join(root, 'package')
  const item: StagedRelease = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
  const pack = await readPackage(path, version)
  if (item.releaseId !== id || item.pluginId !== pluginId || pack.manifest.id !== pluginId || item.version !== pack.manifest.version
    || pack.manifest.backend?.dependencies?.mode === 'npm-ci' || pack.manifest.runtime?.dependencies?.mode === 'npm-ci'
    || (verifyContents && item.sha256 !== await packageDigest(path))) throw new Error('Staged release identity or content changed')
  return { item, path }
}
