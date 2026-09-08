/** This entry executes only in an isolated backend worker, never in the Unit main thread. */
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { parentPort, workerData } from 'node:worker_threads'
import { PortDuplex } from './portDuplex'
import type { BackendFactory, BackendPlugin, BackendWorkerCommand, BackendWorkerData, BackendWorkerEvent } from './backendTypes'

if (!parentPort) throw new Error('Backend worker requires a parent Unit')
const parent = parentPort
const data = workerData as BackendWorkerData
const controller = new AbortController()
const connections = new Set<PortDuplex>()
let plugin: BackendPlugin | undefined
let server: http.Server | undefined
let stopping: Promise<void> | undefined
let creating: Promise<void> | undefined
let activeHook: Promise<void> | undefined
let ready = false

// A backend contributes handlers to its Unit. Outbound sockets (PG, Redis, HTTP)
// remain available; a plugin cannot silently create a second inbound listener.
net.Server.prototype.listen = function (): never {
  throw new Error('Backend plugins must use the Unit HTTP listener')
} as typeof net.Server.prototype.listen

function send(event: BackendWorkerEvent): void { parent.postMessage(event) }

async function shutdown(): Promise<void> {
  if (stopping) return stopping
  stopping = (async () => {
    ready = false
    controller.abort()
    // Stop ingress before plugin.stop closes its database/other services. Flush
    // socket close/aborted events so an upload cannot continue against a closed pool.
    for (const connection of connections) connection.destroy()
    connections.clear()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // A factory may still be returning the object which owns its resources. Do not
    // acknowledge stop before we can invoke its stop hook. The parent bounds this wait.
    await creating?.catch(() => {})
    try { await plugin?.stop?.() }
    finally { await activeHook?.catch(() => {}) }
  })()
  return stopping
}

async function fail(error: unknown): Promise<void> {
  const cause = error instanceof Error ? error : new Error(String(error))
  try { await shutdown() } catch { /* keep the original error; the parent enforces its deadline */ }
  send({ type: 'failure', message: cause.message, stack: cause.stack })
}

parent.on('message', (command: BackendWorkerCommand) => {
  if (command.type === 'stop') {
    void shutdown().then(() => send({ type: 'stopped' }), fail)
    return
  }
  if (command.type !== 'connection') return
  if (!ready || !server) { command.port.close(); return }
  const connection = new PortDuplex(command.port, command.socket)
  connections.add(connection)
  connection.once('close', () => connections.delete(connection))
  server.emit('connection', connection)
})

async function boot(): Promise<void> {
  const entry = await import(pathToFileURL(data.entry).href)
  if (controller.signal.aborted) return
  const factory: BackendFactory = entry.default
  if (typeof factory !== 'function') throw new Error('Backend entry must default-export a factory')
  creating = (async () => { plugin = await factory({
    packageDir: data.packageDir,
    dataDir: data.dataDir,
    config: data.config,
    signal: controller.signal,
    log: (...messages) => send({ type: 'log', message: format(...messages) }),
    requestRestart: () => send({ type: 'restart' }),
  }) })()
  await creating
  if (controller.signal.aborted) return
  if (!plugin || typeof plugin.handle !== 'function' || !Array.isArray(plugin.mounts)
    || plugin.mounts.some((mount) => typeof mount !== 'string' || !mount.startsWith('/') || /[?#\r\n]/.test(mount))) {
    throw new Error('Backend factory must provide a handler and absolute mounts')
  }
  if (data.mode === 'migrate') {
    activeHook = Promise.resolve().then(() => plugin!.migrate?.())
    await activeHook
    if (controller.signal.aborted) return
    await shutdown()
    send({ type: 'migrated' })
    return
  }
  activeHook = Promise.resolve().then(() => plugin!.start?.())
  await activeHook
  if (controller.signal.aborted) return
  server = http.createServer(plugin.handle)
  if (plugin.upgrade) server.on('upgrade', plugin.upgrade)
  // The client-facing Unit owns deadlines. SSE and large uploads must not inherit
  // a second, invisible HTTP server timeout in the worker.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0
  ready = true
  send({ type: 'ready', mounts: plugin.mounts })
}

void boot().catch(fail)
