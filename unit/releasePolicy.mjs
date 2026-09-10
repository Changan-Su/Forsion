/** Independent Unit releases contain the framework and optional local plugins.
 * Commercial deployments compose their own packages in their own repository. */
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const PUBLIC_PLUGIN_IDS = ['amadeus', 'tangu', 'calendar', 'automation', 'public']
const topLevelFiles = new Set(['main.mjs', 'backendWorker.mjs', 'package.json', 'release.json', 'README.md', 'web', 'plugins'])
const commercialPath = /(?:^|\/)(?:server-admin|server-plugin|forsion-plugin-server-admin|forsion-backend-service|forsion-server|microserver|genesis-web)(?:\/|$)/i

export function checkSourcePaths(paths) {
  for (const path of paths) {
    const normalized = path.replaceAll('\\', '/')
    if (commercialPath.test(normalized) || /^(?:server|admin)\//i.test(normalized)) {
      throw new Error(`Commercial Server content is excluded from Unit: ${path}`)
    }
  }
}

/** Called on actual esbuild/Rollup input graphs, not just entry-point names. */
export function checkBundleInputs(inputs, repositoryRoot) {
  for (const input of inputs) {
    if (input.startsWith('\0') || input.startsWith('<')) continue
    const file = input.split('?')[0]
    const absolute = resolve(repositoryRoot, file)
    const rel = relative(repositoryRoot, absolute)
    checkSourcePaths([absolute])
    // Shared worktrees may resolve installed registry dependencies outside this
    // checkout. Application source still must stay within the Genesis repository.
    if (absolute.replaceAll('\\', '/').includes('/node_modules/')) continue
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Unit build imported application source outside Genesis: ${input}`)
    }
    checkSourcePaths([rel])
  }
}

export async function validateDistribution(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!topLevelFiles.has(entry.name)) throw new Error(`Unexpected Unit release entry: ${entry.name}`)
  }
  for (const required of ['main.mjs', 'backendWorker.mjs', 'package.json', 'release.json']) {
    if (!entries.some((entry) => entry.name === required && entry.isFile())) throw new Error(`Missing Unit release file: ${required}`)
  }
  async function walk(relativeDir = '') {
    for (const entry of await readdir(resolve(directory, relativeDir), { withFileTypes: true })) {
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      checkSourcePaths([path])
      if (entry.isSymbolicLink()) throw new Error(`Unit release must be self-contained: ${path}`)
      if (entry.name === '.git' || entry.name === '.npmrc' || /^\.env(?:\.|$)/.test(entry.name)) throw new Error(`Private configuration in Unit release: ${path}`)
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk()
  if (entries.some((entry) => entry.name === 'plugins')) {
    for (const entry of await readdir(resolve(directory, 'plugins'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !PUBLIC_PLUGIN_IDS.includes(entry.name)) throw new Error(`Plugin is not part of the independent Unit release: ${entry.name}`)
      const manifest = JSON.parse(await readFile(resolve(directory, 'plugins', entry.name, 'manifest.json'), 'utf8'))
      if (manifest.id !== entry.name || manifest.backend) throw new Error(`Unexpected bundled plugin identity or backend: ${entry.name}`)
    }
  }
}
