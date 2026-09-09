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
}

export interface LocalEngine {
  readonly configFile: string
  endpoint(): { url: string | null; token: string }
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
    await mkdir(join(dataDir, 'workspace'), { recursive: true })
    try {
      await writeFile(configFile, JSON.stringify({ workspace: join(dataDir, 'workspace'), ...options.initialConfig }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error: any) { if (error.code !== 'EEXIST') throw error }
    // Never inherit a different desktop/server instance's credentials, database or
    // plugin overrides. Explicit configuration inside this instance remains native.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TANGU_') && key !== 'DATABASE_URL'))
    token = randomBytes(32).toString('base64url')
    Object.assign(env, {
      TANGU_HOME: join(dataDir, 'tangu'), TANGU_LOCAL_TOKEN: token,
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
      child = null; url = null; token = ''; state = 'crashed'
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
    endpoint: () => ({ url, token }),
    status: () => ({ state, pid: child?.pid ?? null, lastError }),
    start: (roots) => serialize(() => run(roots)),
    setPackages: (roots, force) => serialize(() => run(roots, force)),
    stop: () => serialize(stopChild),
  }
}
