/** A backend is an optional capability of the existing Forsion plugin package. */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { isSafePluginExt } from '../desktop/shared/amadeus/pluginFiles'
import { isNativeFeatureId, nativeFeatureSpaceIds, type NativeFeatureId } from '../desktop/shared/nativeFeatures'

export interface CloudServices {
  amadeus?: { adapter: 'forsion-cloud-v1'; apiBase: string; collaboration?: boolean }
  tangu?: { adapter: 'forsion-cloud-v1'; apiBase: string; execution: 'fleet' }
}

export interface PluginManifest {
  id: string
  version: string
  apiVersion: number
  name?: string
  nameEn?: string
  description?: string
  descriptionEn?: string
  minAppVersion?: string
  main?: string
  onboarding?: unknown
  fileExtensions?: string[]
  runtime?: { apiVersion: 1; main: string; dependencies?: NonNullable<PluginManifest['backend']>['dependencies'] }
  requires?: string[]
  frontend?: { features: NativeFeatureId[]; services?: CloudServices }
  backend?: {
    apiVersion: number
    main: string
    dependencies?: { mode: 'bundled' | 'npm-ci'; platform?: string; arch?: string; nodeAbi?: string; libc?: 'glibc' | 'musl' }
  }
}
export interface InstalledPackage {
  root: string
  manifest: PluginManifest
  backendEntry?: string
  runtimeEntry?: string
  ui?: Record<string, unknown>
  spaces: Array<{ slug: string; json: string; plugin: string }>
  spaceIds: Set<string>
}
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id)
export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (v: string) => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v) ? v.split(/[.+-]/).slice(0, 3).map(Number) : null
  const a = parse(actual), b = parse(minimum)
  if (!a || !b) throw new Error('Invalid semantic version')
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
export async function packagePath(root: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || !relative || isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Plugin file escapes its package')
  const file = await realpath(resolve(root, relative))
  if (!file.startsWith(root + sep)) throw new Error('Plugin file escapes its package')
  if (!(await stat(file)).isFile()) throw new Error('Plugin entry must be a regular file')
  return file
}
export async function readPackage(dir: string, appVersion?: string): Promise<InstalledPackage> {
  const root = await realpath(dir)
  const manifest: PluginManifest = JSON.parse(await readFile(await packagePath(root, 'manifest.json'), 'utf8'))
  if (!validId(manifest.id) || manifest.apiVersion !== 1) throw new Error('Invalid plugin identity or unsupported plugin API')
  versionAtLeast(manifest.version, '0.0.0')
  if (manifest.minAppVersion && appVersion && !versionAtLeast(appVersion, manifest.minAppVersion)) throw new Error(`Plugin ${manifest.id} requires Unit ${manifest.minAppVersion}`)
  if (manifest.requires && (!Array.isArray(manifest.requires) || !manifest.requires.every(validId))) throw new Error('Invalid plugin dependencies')
  const result: InstalledPackage = { root, manifest, spaces: [], spaceIds: new Set() }
  if (manifest.frontend) {
    const { features, services = {} } = manifest.frontend
    if (!Array.isArray(features) || !features.length || !features.every(isNativeFeatureId)
      || new Set(features).size !== features.length) throw new Error('Invalid native frontend features')
    for (const [id, service] of Object.entries(services)) {
      if (!['amadeus', 'tangu'].includes(id) || !features.includes(id as NativeFeatureId)
        || !service || service.adapter !== 'forsion-cloud-v1'
        || typeof service.apiBase !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(service.apiBase)
        || (id === 'tangu' && service.execution !== 'fleet')
        || (id === 'amadeus' && service.collaboration !== undefined && typeof service.collaboration !== 'boolean')) {
        throw new Error('Invalid frontend cloud service')
      }
    }
    for (const id of nativeFeatureSpaceIds(features)) result.spaceIds.add(id)
  }

  if (manifest.main) {
    const code = await readFile(await packagePath(root, manifest.main), 'utf8')
    // Only UI fields enter the public projection. Backend entries/config are private.
    result.ui = { id: manifest.id, name: manifest.name, nameEn: manifest.nameEn, version: manifest.version,
      apiVersion: manifest.apiVersion, minAppVersion: manifest.minAppVersion,
      description: manifest.description, descriptionEn: manifest.descriptionEn, onboarding: manifest.onboarding, fileExtensions: Array.isArray(manifest.fileExtensions) ? manifest.fileExtensions.filter(isSafePluginExt).map((v) => v.trim().toLowerCase()).slice(0, 8) : [], code }
  }
  if (manifest.runtime) {
    if (manifest.runtime.apiVersion !== 1) throw new Error('Unsupported local runtime API')
    if (manifest.runtime.dependencies?.mode === 'npm-ci') throw new Error('Local runtime dependencies must be bundled')
    result.runtimeEntry = await packagePath(root, manifest.runtime.main)
  }
  if (manifest.backend) {
    if (manifest.backend.apiVersion !== 1) throw new Error('Unsupported backend plugin API')
    result.backendEntry = await packagePath(root, manifest.backend.main)

  }
  for (const deps of [manifest.backend?.dependencies, manifest.runtime?.dependencies]) {
    if (deps && !['bundled', 'npm-ci'].includes(deps.mode)) throw new Error('Unsupported dependency mode')
    const libc = process.platform === 'linux' ? ((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime ? 'glibc' : 'musl') : undefined
    if (deps?.mode === 'bundled' && ((deps.platform && deps.platform !== process.platform)
      || (deps.libc && deps.libc !== libc) || (deps.arch && deps.arch !== process.arch) || (deps.nodeAbi && deps.nodeAbi !== process.versions.modules))) {
      throw new Error('Plugin dependencies were built for a different OS, architecture, Node ABI, or libc')
    }
  }
  if (!result.ui && !result.backendEntry && !result.runtimeEntry && !manifest.frontend) throw new Error('Plugin has no UI or backend entry')
  const entries = await readdir(resolve(root, 'spaces'), { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const json = await readFile(await packagePath(root, `spaces/${entry.name}/space.json`), 'utf8')
    const spec = JSON.parse(json)
    if (!validId(spec.id) || result.spaceIds.has(spec.id)) throw new Error('Invalid or duplicate Space id')
    result.spaceIds.add(spec.id)
    result.spaces.push({ slug: entry.name, json, plugin: manifest.id })
  }
  return result
}

export async function loadPackages(dirs: string[]) {
  const packages = await Promise.all(dirs.map((dir) => readPackage(dir)))
  const ids = new Set<string>(), spaceIds = new Set<string>()
  for (const p of packages) {
    if (ids.has(p.manifest.id)) throw new Error('Duplicate plugin id')
    ids.add(p.manifest.id)
    for (const id of p.spaceIds) {
      if (spaceIds.has(id)) throw new Error('Duplicate Space id')
      spaceIds.add(id)
    }
  }
  return { plugins: packages.flatMap((p) => p.ui ? [p.ui] : []), spaces: packages.flatMap((p) => p.spaces), spaceIds }
}
