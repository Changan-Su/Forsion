import { mkdir, readFile, open, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startBasicUnit, type UnitConfig } from './host'
import { readConfig, writeConfig, installations } from './config'
import { readPackage, validId } from './packages'
import { localOwnerToken } from './localWorkspace'
import { installPackage } from './install'
import { migrateBackend } from './backendRunner'
import { sendControl, startControl, unitIsOffline, type ControlCommand } from './control'
import desktop from '../desktop/package.json'
import { stageRelease } from './releases'
import type { ManagementCommand } from './management'

const dist = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const commands = ['init', 'install', 'stage', 'update', 'run', 'migrate', 'enable', 'disable', 'restart', 'status', 'access']
const action = commands.includes(args[0]) ? args.shift()! : 'run'
const configArgument = args.shift()
const file = resolve(configArgument || (action === 'init' ? 'forsion-unit' : 'unit.json'))
const print = (result: unknown) => console.log(JSON.stringify(result, null, 2))
async function findInstallation(config: UnitConfig, id?: string) {
  if (!id) throw new Error('A plugin id is required')
  for (const entry of installations(config)) if ((await readPackage(entry.path)).manifest.id === id) return entry
  throw new Error(`Plugin is not installed: ${id}`)
}
async function run() {
  if (action === 'update') {
    if (!configArgument?.trim() || args.length !== 2 || args.some((arg) => !arg.trim())) {
      throw new Error('Usage: node main.mjs update <unit.json> <plugin-id> <package-path>')
    }
    if (!validId(args[0])) throw new Error('Invalid plugin id')
  }
  if (action === 'stage' && (!configArgument?.trim() || args.length !== 1 || !args[0]?.trim())) {
    throw new Error('Usage: node main.mjs stage <unit.json> <bundled-package-path>')
  }
  if (action === 'init') {
    const option = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1] }
    const mode = option('--mode', 'public')
    if (!['public', 'local'].includes(mode)) throw new Error('Mode must be public or local')
    const port = Number(option('--port', '3001')), basePath = option('--base', mode === 'local' ? '/' : '/admin/')
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !basePath?.startsWith('/')) throw new Error('Invalid port or projection base path')
    await mkdir(file, { recursive: true, mode: 0o700 })
    const path = resolve(file, 'unit.json')
    const config: UnitConfig = { instanceId: randomUUID(), name: 'Forsion Unit', version: desktop.version,
      port, bindHost: option('--host', '127.0.0.1'), basePath, webDist: resolve(dist, 'web'), workerFile: resolve(dist, 'backendWorker.mjs'), dataDir: resolve(file, 'data'), plugins: [], ...(mode === 'local' ? { workspace: { mode: 'local' as const } } : {}) }
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(config, null, 2) + '\n') } finally { await handle.close() }
    print({ config: path, instanceId: config.instanceId }); return
  }
  if (action === 'install') { if (!args[0]) throw new Error('A plugin package directory is required'); print(await installPackage(file, resolve(args[0]))); return }
  const config = await readConfig(file)
  config.workerFile ||= resolve(dist, 'backendWorker.mjs')
  if (action === 'stage') { print(await stageRelease(config.dataDir!, resolve(args[0]), config.version)); return }
  if (action === 'update') {
    await findInstallation(config, args[0])
    print(await installPackage(file, resolve(args[1]), { updateId: args[0] })); return
  }
  if (action === 'access') {
    if (config.workspace?.mode !== 'local') throw new Error('Public sites use their Account provider')
    const token = await localOwnerToken(config.dataDir!)
    print({ url: `http://${config.bindHost || '127.0.0.1'}:${config.port}${config.basePath}#unit-owner=${token}` }); return
  }
  if (action !== 'run') {
    try { print(await sendControl(config.dataDir!, { action: action as ControlCommand['action'], id: args[0] })); return }
    catch (error) { if (!unitIsOffline(error)) throw error }
    if (action === 'status') {
      print({ running: false, instanceId: config.instanceId, plugins: await Promise.all(installations(config).map(async (p) => ({ id: (await readPackage(p.path)).manifest.id, enabled: p.enabled !== false }))) }); return
    }
    const entry = await findInstallation(config, args[0])
    if (action === 'enable' || action === 'disable') { entry.enabled = action === 'enable'; await writeConfig(file, config); print({ id: args[0], enabled: entry.enabled }); return }
    if (action === 'restart') throw new Error('Unit is not running')
    const pack = await readPackage(entry.path, config.version)
    if (!pack.backendEntry) throw new Error('Plugin has no backend migration')
    const dataDir = resolve(config.dataDir!, 'plugins', pack.manifest.id)
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const migration = new AbortController()
    const cancelMigration = () => migration.abort(new Error('Migration interrupted'))
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, cancelMigration)
    try { await migrateBackend({ signal: migration.signal, id: pack.manifest.id, entry: pack.backendEntry, packageDir: pack.root, dataDir,
      config: entry.config || {}, env: { ...(entry.config?.env as Record<string, string> || {}), ...entry.env }, workerFile: config.workerFile!, startTimeoutMs: 600_000 }) }
    finally { for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, cancelMigration) }
    print({ id: pack.manifest.id, migrated: true }); return
  }
  if (process.env.UNIT_PORT) config.port = Number(process.env.UNIT_PORT)
  await mkdir(config.dataDir!, { recursive: true, mode: 0o700 })
  const lockPath = resolve(config.dataDir!, 'run.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number(await readFile(lockPath, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Unit startup is locked; inspect data/run.lock')
    try { process.kill(pid, 0); throw new Error('This Unit is already running') }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure }
    await rm(lockPath); lock = await open(lockPath, 'wx', 0o600)
  }
  await lock.writeFile(String(process.pid)); await lock.close()
  let unit: Awaited<ReturnType<typeof startBasicUnit>> | undefined
  let control: Awaited<ReturnType<typeof startControl>> | undefined
  let executeManagement: ((command: ManagementCommand, authorize: () => Promise<void>) => Promise<unknown>) | undefined
  let shutdownRequested = false, requestStop: (() => Promise<void>) | undefined
  const onSignal = () => { shutdownRequested = true; void requestStop?.() }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, onSignal)
  try {
    unit = await startBasicUnit(config, { execute: async (command, authorize) => {
      if (!executeManagement) throw new Error('Unit control is not ready')
      return executeManagement(command, authorize)
    } })
    let queue = Promise.resolve()
    const status = () => ({ running: true, pid: process.pid, instanceId: config.instanceId, port: unit!.port, plugins: unit!.status() })
    const dispatch = async (command: ControlCommand) => {
      if (command.action === 'status') return status()
      if (command.action === 'stage') {
        if (command.remote && config.management?.enabled !== true) throw new Error('Remote Unit management is disabled')
        if (!command.path) throw new Error('A prepared package is required')
        return stageRelease(config.dataDir!, command.path, config.version)
      }
      if (!['enable', 'disable', 'restart', 'update', 'migrate'].includes(command.action)) throw new Error('Unknown Unit command')
      const entry = await findInstallation(config, command.id)
      const previous = { ...entry }
      if (command.action === 'update') {
        if (!command.path) throw new Error('An update package path is required')
        await unit!.update(command.id!, command.path); entry.path = resolve(command.path)
      } else if (command.action === 'enable') { await unit!.enable(command.id!); entry.enabled = true }
      else if (command.action === 'disable') { await unit!.disable(command.id!); entry.enabled = false }
      else if (command.action === 'restart') await unit!.restart(command.id!)
      else await unit!.migrate(command.id!)
      try { await writeConfig(file, config) }
      catch (error) {
        Object.assign(entry, previous); entry.enabled = previous.enabled
        if (command.action === 'update') await unit!.update(command.id!, previous.path)
        if (command.action === 'enable' && previous.enabled === false) await unit!.disable(command.id!)
        if (command.action === 'disable' && previous.enabled !== false) await unit!.enable(command.id!)
        throw error
      }
      return status()
    }
    const enqueue = (run: () => Promise<unknown>) => {
      const next = queue.then(run)
      queue = next.then(() => {}, () => {}); return next
    }
    executeManagement = async (command, authorize) => {
      const apply = (action: ControlCommand) => enqueue(async () => { await authorize(); return dispatch(action) })
      if (command.action === 'update') return installPackage(file, command.path!, { updateId: command.id,
        releaseDigest: command.releaseDigest, applyUpdate: (id, path) => apply({ action: 'update', id, path }) })
      return apply({ action: command.action, id: command.id })
    }
    control = await startControl(config.dataDir!, (command) => enqueue(() => dispatch(command)))
    print(status())
    console.log(`[unit] ${config.name} http://${config.bindHost || '127.0.0.1'}:${unit.port}${config.basePath}`)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      let failure = false
      try { await unit!.closeManagement(); await control!.close(); await queue; await unit!.close() } catch (error) { console.error(error); failure = true }
      finally { await rm(lockPath, { force: true }); process.exit(failure ? 1 : 0) }
    }
    requestStop = stop
    if (shutdownRequested) await stop()
  } catch (error) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, onSignal)
    try { await control?.close() } finally { try { await unit?.close() } finally { await rm(lockPath, { force: true }) } }
    throw error
  }
}
await run().catch((error) => { console.error(`[unit] ${error instanceof Error ? error.message : 'Command failed'}`); process.exitCode = 1 })
