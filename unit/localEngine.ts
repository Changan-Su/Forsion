/** Portable owner of the existing standalone Tangu process. Loaded by the Tangu
 * plugin only; the base Unit has no engine or database dependency. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LocalEngineOptions {
  dataDir: string
  entryFile?: string
  nodePath?: string
  /** Native Tangu config schema. Seeded once; existing user configuration wins. */
  initialConfig?: Record<string, unknown>
  log?: (message: string) => void
  startupTimeoutMs?: number
  /** One engine for many accounts (TANGU_MULTI_ACCOUNT=1): each request names its account in X-Forsion-User,
   *  every account keeps its own folder and database under the engine home. There is no owner, so no
   *  single database path, user id, owner config or remote mark. */
  multiAccount?: boolean
  /** Multi-account only: the account server the engine sends model calls to (TANGU_CLOUD_URL). Model calls carry each
   *  account's model ticket from the host; no token is ever passed in the environment. */
  cloudUrl?: string
  /** Multi-account only: TANGU_SCRIPT_ISOLATION=required (the host holds a device credential plugin scripts must not read). */
  scriptIsolation?: 'required'
  /** Multi-account only: a second, host-only credential (TANGU_HOST_CONTROL_TOKEN) for per-account backup operations.
   *  It is never the credential visitors' requests carry. */
  hostControl?: boolean
}

export interface LocalEngine {
  readonly configFile: string
  /** multiAccount is true only once the engine itself reported multi-account mode at readiness. */
  endpoint(): { url: string | null; token: string; remoteMark?: string; multiAccount?: boolean }
  /** hostControl engines only: the host-only credential, while the engine runs. */
  control(): { url: string | null; token: string } | null
  status(): { state: 'stopped' | 'starting' | 'ready' | 'crashed'; pid: number | null; lastError: string | null }
  start(packageRoots: string[]): Promise<void>
  /** Restart discards registered tools/routes from removed packages. Agents already
   * seeded to the user's home are retained, matching desktop bundle semantics. */
  setPackages(packageRoots: string[], force?: boolean): Promise<void>
  stop(): Promise<void>
}

export function createLocalEngine(options: LocalEngineOptions): LocalEngine {
  const dataDir = resolve(options.dataDir)
  const configFile = join(dataDir, 'config.json')
  const entry = options.entryFile || fileURLToPath(new URL('./engine/dist/standalone/main.mjs', import.meta.url))
  let child: ChildProcess | null = null
  let url: string | null = null
  let token = ''
  let controlToken = ''
  // Lets the engine tell relayed requests from the owner's own; the owner's page never carries it.
  const remoteMark = randomBytes(32).toString('base64url')
  let state: ReturnType<LocalEngine['status']>['state'] = 'stopped'
  let lastError: string | null = null
  let fingerprint = ''
  let queue: Promise<void> = Promise.resolve()
  const serialize = (action: () => Promise<void>) => {
    const task = queue.then(action)
    queue = task.catch(() => {})
    return task
  }

  async function stopChild() {
    const current = child
    child = null
    url = null
    token = ''
    controlToken = ''
    state = 'stopped'
    if (!current?.pid || current.exitCode !== null || current.signalCode !== null) return
    await new Promise<void>((done) => {
      const timeout = setTimeout(() => current.kill('SIGKILL'), 3000)
      current.once('exit', () => { clearTimeout(timeout); done() })
      current.kill('SIGTERM')
    })
  }

  async function run(packageRoots: string[], force = false) {
    const roots = [...new Set(await Promise.all(packageRoots.map((root) => realpath(root))))].sort()
    const stamps = await Promise.all(roots.map(async (root) => {
      const manifest = join(root, 'manifest.json')
      return [root, (await stat(manifest)).mtimeMs, await readFile(manifest, 'utf8')]
    }))
    const nextFingerprint = JSON.stringify(stamps)
    if (!force && state === 'ready' && fingerprint === nextFingerprint) return
    await stopChild()
    await mkdir(join(dataDir, 'tangu'), { recursive: true })
    if (!options.multiAccount) {
      await mkdir(join(dataDir, 'workspace'), { recursive: true })
      try {
        await writeFile(configFile, JSON.stringify({ workspace: join(dataDir, 'workspace'), ...options.initialConfig }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      } catch (error: any) { if (error.code !== 'EEXIST') throw error }
    }
    // Never inherit a different desktop/server instance's credentials, database or
    // plugin overrides. Explicit configuration inside this instance remains native.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TANGU_') && key !== 'DATABASE_URL'))
    token = randomBytes(32).toString('base64url')
    controlToken = options.multiAccount && options.hostControl ? randomBytes(32).toString('base64url') : ''
    Object.assign(env, options.multiAccount ? {
      TANGU_HOME: join(dataDir, 'tangu'), TANGU_LOCAL_TOKEN: token, TANGU_MULTI_ACCOUNT: '1',
      TANGU_HOST: '127.0.0.1', TANGU_PORT: '0', TANGU_BUNDLE_DIRS: JSON.stringify(roots),
      ...(options.cloudUrl ? { TANGU_CLOUD_URL: options.cloudUrl } : {}),
      ...(options.scriptIsolation === 'required' ? { TANGU_SCRIPT_ISOLATION: 'required' } : {}),
      ...(controlToken ? { TANGU_HOST_CONTROL_TOKEN: controlToken } : {}),
    } : {
      TANGU_HOME: join(dataDir, 'tangu'), TANGU_LOCAL_TOKEN: token, TANGU_REMOTE_MARK_SECRET: remoteMark,
      TANGU_DATABASE_URL: '', TANGU_DATA_DIR: join(dataDir, 'tangu/state.db'),
      TANGU_HOST: '127.0.0.1', TANGU_PORT: '0', TANGU_USER_ID: 'local',
      TANGU_BUNDLE_DIRS: JSON.stringify(roots),
    })
    state = 'starting'
    lastError = null
    const current = spawn(options.nodePath || process.execPath, [entry], {
      cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child = current
    let logs = ''
    for (const stream of [current.stdout, current.stderr]) stream?.on('data', (chunk) => {
      const text = String(chunk)
      logs = (logs + text).slice(-6000)
      options.log?.(text.trimEnd())
    })
    current.once('exit', (code, signal) => {
      if (child !== current) return
      child = null; url = null; token = ''; controlToken = ''; state = 'crashed'
      lastError = `Local Tangu engine exited (${signal || code})`
      options.log?.(lastError)
    })
    try {
      await new Promise<void>((done, reject) => {
        const cleanup = () => { clearTimeout(timer); current.off('message', onMessage); current.off('error', onError); current.off('exit', onExit) }
        const onError = (error: Error) => { cleanup(); reject(error) }
        const onExit = (code: number | null, signal: string | null) => onError(new Error(`Local Tangu engine exited before readiness (${signal || code}): ${logs}`))
        const onMessage = (message: any) => {
          if (message?.type !== 'tangu:ready') return
          if (message.host !== '127.0.0.1' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
            onError(new Error('Invalid local engine readiness endpoint')); return
          }
          // Never trust the request alone: an engine that does not confirm multi-account mode would put every
          // visitor in one database.
          if (options.multiAccount && message.mode !== 'multi-account') { onError(new Error('Local engine did not start in multi-account mode')); return }
          url = `http://127.0.0.1:${message.port}`
          state = 'ready'
          fingerprint = nextFingerprint
          cleanup(); done()
        }
        const timer = setTimeout(() => onError(new Error(`Local Tangu engine startup timed out: ${logs}`)), options.startupTimeoutMs ?? 30_000)
        current.on('message', onMessage); current.once('error', onError); current.once('exit', onExit)
      })
    } catch (error: any) {
      await stopChild()
      state = 'crashed'; lastError = error?.message || String(error)
      throw error
    }
  }

  return {
    configFile,
    endpoint: () => (url ? (options.multiAccount ? { url, token, multiAccount: true } : { url, token, remoteMark }) : { url, token }),
    control: () => (controlToken ? { url, token: controlToken } : null),
    status: () => ({ state, pid: child?.pid ?? null, lastError }),
    start: (roots) => serialize(() => run(roots)),
    setPackages: (roots, force) => serialize(() => run(roots, force)),
    stop: () => serialize(stopChild),
  }
}
