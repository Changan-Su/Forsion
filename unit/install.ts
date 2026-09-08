/** Installation copies a trusted local package into an immutable version directory. */
import { cp, mkdir, readdir, realpath, rm, lstat, open, readlink, symlink } from 'node:fs/promises'
import { dirname, resolve, sep, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readPackage, packagePath } from './packages'
import { readConfig, writeConfig, installations } from './config'
import { sendControl, unitIsOffline } from './control'

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
export async function installPackage(configPath: string, source: string) {
  const file = resolve(configPath), root = dirname(file)
  const lockPath = resolve(root, '.install.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another install is in progress') })
  let stage: string | undefined, committed = false
  try {
    const config = await readConfig(file), sourceRoot = await realpath(source)
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('Install expects an unpacked plugin directory')
    const pack = await readPackage(sourceRoot, config.version)
    await inspectTree(sourceRoot, sourceRoot)
    stage = resolve(root, 'plugins', pack.manifest.id, `${pack.manifest.version}-${randomUUID()}`)
    await mkdir(dirname(stage), { recursive: true, mode: 0o700 })
    await cp(sourceRoot, stage, { recursive: true, verbatimSymlinks: true })
    await relocateLinks(stage, sourceRoot, stage)
    if (pack.manifest.backend?.dependencies?.mode === 'npm-ci') await installDependencies(stage, pack.manifest.backend.main)
    const ready = await readPackage(stage, config.version)
    const entries = installations(config)
    const existing = (await Promise.all(entries.map(async (entry) => ({ entry, pack: await readPackage(entry.path) })))).find((p) => p.pack.manifest.id === pack.manifest.id)
    if (existing) {
      try {
        await sendControl(config.dataDir!, { action: 'update', id: pack.manifest.id, path: stage })
        committed = true // The running owner persists the update before acknowledging.
        return { id: ready.manifest.id, version: ready.manifest.version, path: stage }
      }
      catch (error) {
        if (!unitIsOffline(error)) {
          // A lost response cannot prove that a live worker has finished or rolled back.
          committed = true
          throw error
        }
      }
      existing.entry.path = stage
    } else {
      try {
        await sendControl(config.dataDir!, { action: 'status' })
        throw new Error('Stop the Unit before installing a new plugin; updates can run live')
      } catch (error) { if (!unitIsOffline(error)) throw error }
      entries.push({ path: stage, enabled: true })
    }
    if (!config.defaultSpace && ready.spaces.length) config.defaultSpace = [...ready.spaceIds][0]
    await writeConfig(file, config)
    committed = true
    return { id: ready.manifest.id, version: ready.manifest.version, path: stage }
  } finally {
    await lock.close(); await rm(lockPath, { force: true })
    if (!committed && stage) await rm(stage, { recursive: true, force: true })
  }
}
