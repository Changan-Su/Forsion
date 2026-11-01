/** Installation copies a trusted local package into an immutable version directory, or references one in place. */
import { cp, mkdir, readdir, realpath, rm, lstat, open, readlink, symlink } from 'node:fs/promises'
import { dirname, resolve, sep, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readPackage, packagePath } from './packages'
import { readConfig, writeConfig, installations } from './config'
import { sendControl, unitIsOffline } from './control'
import { OperationError, RollbackIncomplete } from './errors'

async function inspectTree(dir: string, root: string, seen = new Set<string>()): Promise<void> {
  const actual = await realpath(dir)
  if (seen.has(actual)) return
  seen.add(actual)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.name === '.env' || (entry.name.startsWith('.env.') && !entry.name.endsWith('.example'))) throw new Error('Package contains private environment files')
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (!target.startsWith(root + sep)) throw new Error('Package symlink escapes its directory')
      if ((await lstat(target)).isDirectory()) await inspectTree(target, root, seen)
    } else if (entry.isDirectory()) await inspectTree(path, root, seen)
  }
}
async function relocateLinks(dir: string, source: string, destination: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const link = await readlink(path)
      if (isAbsolute(link)) {
        const relocated = resolve(destination, relative(source, await realpath(link)))
        await rm(path); await symlink(relative(dirname(path), relocated), path)
      }
    } else if (entry.isDirectory()) await relocateLinks(path, source, destination)
  }
}
/** Shared local-package validation for installation and operator-staged releases. */
export async function copyPackage(source: string, destination: string, version?: string) {
  const sourceRoot = await realpath(source)
  if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('Expected an unpacked plugin directory')
  await readPackage(sourceRoot, version)
  await inspectTree(sourceRoot, sourceRoot)
  await cp(sourceRoot, destination, { recursive: true, verbatimSymlinks: true })
  await relocateLinks(destination, sourceRoot, destination)
  return readPackage(destination, version)
}
async function installDependencies(root: string, backendMain: string): Promise<void> {
  // The backend package.json is adjacent to the conventional backend/ directory.
  const backend = resolve(root, backendMain.split('/')[0])
  await packagePath(root, backendMain.split('/')[0] + '/package-lock.json')
  await new Promise<void>((done, reject) => {
    const win = process.platform === 'win32'
    const child = spawn(win ? 'cmd.exe' : 'npm', win ? ['/c', 'npm', 'ci', '--omit=dev'] : ['ci', '--omit=dev'], { cwd: backend, stdio: 'inherit', env: { ...process.env, PATH: dirname(process.execPath) + (win ? ';' : ':') + (process.env.PATH || '') } })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Plugin dependency installation failed (${code})`)))
  })
}
/**
 * updateId requires an existing plugin and a live owner; ordinary installs also work offline.
 * applyInstall hands a new plugin to the live owner (remote management), which activates it and writes unit.json.
 * verify runs on the bytes that will be activated: a check on the staged release alone proves nothing about
 * what a concurrent writer left there when it was copied.
 * reference records the package's own path instead of copying it: nothing is written there, so several
 * instances can share one read-only directory. Packages that install dependencies still get a private copy.
 */
export async function installPackage(configPath: string, source: string, options: { updateId?: string; installId?: string; releaseDigest?: string; reference?: boolean;
  verify?: (root: string) => Promise<void>
  applyUpdate?: (id: string, path: string) => Promise<unknown>; applyInstall?: (id: string, path: string) => Promise<unknown> } = {}) {
  const file = resolve(configPath), root = dirname(file)
  const lockPath = resolve(root, '.install.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another install is in progress') })
  let stage: string | undefined, committed = false
  try {
    const config = await readConfig(file), sourceRoot = await realpath(source)
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('Install expects an unpacked plugin directory')
    const pack = await readPackage(sourceRoot, config.version)
    const entries = installations(config)
    const existing = (await Promise.all(entries.map(async (entry) => ({ entry, pack: await readPackage(entry.path) })))).find((p) => p.pack.manifest.id === pack.manifest.id)
    if (options.updateId !== undefined) {
      if (pack.manifest.id !== options.updateId) throw new Error('Update changes plugin identity')
      if (!existing) throw new Error(`Plugin is not installed: ${options.updateId}`)
      try { await sendControl(config.dataDir!, { action: 'status' }) }
      catch (error) { if (unitIsOffline(error)) throw new Error('Unit is not running; start it before updating'); throw error }
    }
    if (options.applyInstall) {
      if (options.installId !== undefined && pack.manifest.id !== options.installId) throw new Error('Release changes plugin identity')
      if (existing) throw new OperationError('Plugin is already installed; use update')
    }
    await inspectTree(sourceRoot, sourceRoot)
    // stage stays unset for a reference: the cleanup below may only ever remove a private copy.
    if (!options.reference || pack.manifest.backend?.dependencies?.mode === 'npm-ci') {
      stage = resolve(root, 'plugins', pack.manifest.id, `${pack.manifest.version}-${randomUUID()}`)
      await mkdir(dirname(stage), { recursive: true, mode: 0o700 })
      await cp(sourceRoot, stage, { recursive: true, verbatimSymlinks: true })
      await relocateLinks(stage, sourceRoot, stage)
    }
    const target = stage ?? sourceRoot
    if (options.releaseDigest) {
      const { packageDigest } = await import('./releases')
      if (pack.manifest.backend?.dependencies?.mode === 'npm-ci' || pack.manifest.runtime?.dependencies?.mode === 'npm-ci'
        || await packageDigest(target) !== options.releaseDigest) throw new Error('Staged release changed during installation')
    }
    await options.verify?.(target)
    if (pack.manifest.backend?.dependencies?.mode === 'npm-ci') await installDependencies(target, pack.manifest.backend.main)
    const ready = await readPackage(target, config.version)
    const installed = { id: ready.manifest.id, version: ready.manifest.version, path: target, ...(options.reference ? { reference: !stage } : {}) }
    if (existing) {
      try {
        if (options.applyUpdate) await options.applyUpdate(pack.manifest.id, target)
        else await sendControl(config.dataDir!, { action: 'update', id: pack.manifest.id, path: target })
        committed = true // The running owner persists the update before acknowledging.
        return installed
      }
      catch (error) {
        if (!unitIsOffline(error)) {
          // A lost response cannot prove that a live worker has finished or rolled back.
          committed = true
          throw error
        }
        // The owner may have stopped while the package was copied or dependencies installed.
        if (options.updateId !== undefined) throw new Error('Unit is not running; start it before updating')
      }
      existing.entry.path = target
    } else if (options.applyInstall) {
      // The in-process owner either activated it and persisted unit.json, or rolled back before throwing.
      try { await options.applyInstall(pack.manifest.id, target) }
      catch (error) { if (error instanceof RollbackIncomplete) committed = true; throw error }
      committed = true
      return installed
    } else {
      try {
        await sendControl(config.dataDir!, { action: 'status' })
        throw new Error('Stop the Unit before installing a new plugin; updates can run live')
      } catch (error) { if (!unitIsOffline(error)) throw error }
      entries.push({ path: target, enabled: true })
    }
    if (!config.defaultSpace && ready.spaceIds.size) config.defaultSpace = [...ready.spaceIds][0]
    await writeConfig(file, config)
    committed = true
    return installed
  } finally {
    await lock.close(); await rm(lockPath, { force: true })
    if (!committed && stage) await rm(stage, { recursive: true, force: true })
  }
}
