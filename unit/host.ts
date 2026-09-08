/** Headless Basic Unit. Reuses the desktop Unit projection service without Electron. */
import { readFile, readdir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { startUnitWeb } from '../desktop/electron/unitWeb'
import { resolveProduct, type ProductProfile } from '../desktop/shared/product'
import basic from '../desktop/products/basic.json'

export interface UnitConfig {
  instanceId: string
  name: string
  version: string
  port: number
  bindHost?: string
  basePath: string
  webDist: string
  plugins: string[]
  defaultSpace: string
}

async function packageFile(root: string, relative: string): Promise<string> {
  const file = await realpath(resolve(root, relative))
  if (!file.startsWith(root + sep)) throw new Error('Plugin file escapes its package')
  return readFile(file, 'utf8')
}

export async function loadPackages(dirs: string[]) {
  const plugins: Array<Record<string, unknown>> = []
  const spaces: Array<{ slug: string; json: string; plugin: string }> = []
  const ids = new Set<string>()
  const spaceIds = new Set<string>()
  for (const dir of dirs) {
    const root = await realpath(dir)
    const manifest = JSON.parse(await packageFile(root, 'manifest.json'))
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.id) || ids.has(manifest.id)) throw new Error('Invalid or duplicate plugin id')
    ids.add(manifest.id)
    if (typeof manifest.main !== 'string') throw new Error(`Plugin ${manifest.id} has no main entry`)
    const code = await packageFile(root, manifest.main)
    // Publish only the UI manifest fields and executable entry. Never enumerate
    // package directories as static files: they can contain local data or secrets.
    plugins.push({ id: manifest.id, name: manifest.name, nameEn: manifest.nameEn,
      version: manifest.version, apiVersion: manifest.apiVersion, minAppVersion: manifest.minAppVersion,
      description: manifest.description, descriptionEn: manifest.descriptionEn, code })
    const entries = await readdir(resolve(root, 'spaces'), { withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const json = await packageFile(root, `spaces/${entry.name}/space.json`)
      const spec = JSON.parse(json)
      if (typeof spec.id !== 'string' || spaceIds.has(spec.id)) throw new Error('Invalid or duplicate Space id')
      spaceIds.add(spec.id)
      spaces.push({ slug: entry.name, json, plugin: manifest.id })
    }
  }
  return { plugins, spaces, spaceIds }
}

export async function startBasicUnit(config: UnitConfig) {
  if (!config.instanceId || !config.name || !config.version) throw new Error('Unit identity is required')
  const packages = await loadPackages(config.plugins)
  if (!packages.spaceIds.has(config.defaultSpace)) throw new Error('The default Space must be supplied by an installed plugin')
  await readFile(resolve(config.webDist, 'index.html')) // Fail startup instead of publishing an empty placeholder.
  const product: ProductProfile = resolveProduct(undefined, { ...basic, spaces: [],
    defaultSpace: config.defaultSpace, market: false, onboarding: false })
  return startUnitWeb({
    meta: { instanceId: config.instanceId, name: config.name, version: config.version },
    projection: { mode: 'public', basePath: config.basePath, product },
    getEngine: () => ({ url: null, token: '' }),
    pairedDevices: { list: () => [], add: async () => { throw new Error('Pairing is disabled') } },
    confirmPair: async () => false,
    readPlugins: async () => packages.plugins,
    readSpaces: async () => packages.spaces,
    readConfig: async () => ({}),
    writeConfig: async () => { throw new Error('Host configuration is not published') },
    readProviders: async () => [],
    readHostFile: async () => null,
    readHostDir: async () => null,
    readHostStat: async () => null,
    webDistDir: () => config.webDist,
    vault: () => null,
    log: (message) => console.log(message),
  }, { port: config.port, bindHost: config.bindHost ?? '127.0.0.1' })
}
