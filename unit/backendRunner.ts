import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Duplex } from 'node:stream'
import { MessageChannel, Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { PortDuplex } from './portDuplex'
import type { BackendAccount, BackendHandle, BackendIdentity, BackendOptions, BackendState, BackendWorkerCommand, BackendWorkerData, BackendWorkerEvent, SocketMetadata } from './backendTypes'

export type { BackendAccount, BackendHandle, BackendIdentity, BackendOptions, BackendState } from './backendTypes'

function environment(overrides: BackendOptions['env']): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function socketMetadata(socket: IncomingMessage['socket']): SocketMetadata {
  return { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily,
    localAddress: socket.localAddress, localPort: socket.localPort, encrypted: Boolean((socket as typeof socket & { encrypted?: boolean }).encrypted) }
}

function unavailable(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ detail: 'Backend plugin unavailable', code: 'BACKEND_UNAVAILABLE' }))
}

class BackendSession {
  state: BackendState
  mounts: string[] = []
  hasAccount = false
  accountMetadata?: BackendAccount['metadata']
  readonly worker: Worker
  readonly completion: Promise<void>
  private resolveCompletion!: () => void
  private rejectCompletion!: (error: Error) => void
  private completed = false
  private failureReported = false
  private expectedExit = false
  private startTimer?: ReturnType<typeof setTimeout>
  private stopPromise?: Promise<void>
  private resolveStop?: () => void
  private rejectStop?: (error: Error) => void
  private stopTimer?: ReturnType<typeof setTimeout>
  private abortHandler?: () => void
  private cancellationError?: Error
  private cancellationFinish?: Promise<void>
  private readonly active = new Set<PortDuplex>()
  private readonly accountCalls = new Map<string, {
    finish: (identity: BackendIdentity | null, error?: Error) => void
  }>()

  constructor(readonly options: BackendOptions, readonly mode: 'start' | 'migrate') {
    for (const path of [options.entry, options.packageDir, options.dataDir, options.workerFile]) {
      if (!isAbsolute(path)) throw new Error('Backend runtime paths must be absolute')
    }
    if (options.signal?.aborted) throw this.abortReason()
    if (options.accountTimeoutMs !== undefined && (!Number.isFinite(options.accountTimeoutMs) || options.accountTimeoutMs <= 0)) {
      throw new Error('Backend account timeout must be positive and finite')
    }
    this.state = mode === 'start' ? 'starting' : 'migrating'
    this.completion = new Promise((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject })
    const data: BackendWorkerData = { id: options.id, entry: options.entry, packageDir: options.packageDir,
      dataDir: options.dataDir, config: options.config ?? {}, mode }
    this.worker = new Worker(options.workerFile, { workerData: data, env: environment(options.env), execArgv: [] })
    this.worker.on('message', (event: unknown) => this.onMessage(event))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => {
      if (this.cancellationError) this.finishCancellation()
      else if (!this.expectedExit) this.fail(new Error(`Backend worker exited unexpectedly (${code})`))
    })
    this.startTimer = setTimeout(() => this.cancel(new Error(`Backend ${mode} timed out`)), options.startTimeoutMs ?? 30_000)
    this.startTimer.unref()
    if (options.signal) {
      this.abortHandler = () => this.cancel(this.abortReason())
      options.signal.addEventListener('abort', this.abortHandler, { once: true })
      if (options.signal.aborted) this.abortHandler()
    }
  }

  private abortReason(): Error {
    const reason = this.options.signal?.reason
    return reason instanceof Error ? reason : new Error('Backend operation cancelled', { cause: reason })
  }

  private detachAbort(): void {
    if (this.abortHandler) this.options.signal?.removeEventListener('abort', this.abortHandler)
    this.abortHandler = undefined
  }

  /** A startup deadline must abort plugin-owned jobs before their worker disappears. */
  private cancel(error: Error): void {
    if (this.completed || this.cancellationError || this.state === 'stopped' || this.state === 'failed') return
    this.cancellationError = error
    this.state = 'stopping'
    if (this.startTimer) clearTimeout(this.startTimer)
    this.detachAbort()
    this.closeConnections()
    this.stopTimer = setTimeout(() => this.finishCancellation(), this.options.stopTimeoutMs ?? 10_000)
    this.stopTimer.unref()
    try { this.worker.postMessage({ type: 'stop' } satisfies BackendWorkerCommand) }
    catch { this.finishCancellation() }
  }

  private finishCancellation(): void {
    if (!this.cancellationError || this.cancellationFinish) return
    this.expectedExit = true
    if (this.stopTimer) clearTimeout(this.stopTimer)
    // Reject only after cleanup/termination. A failed install may immediately start
    // the previous package; it must not overlap an old detached migration job.
    this.cancellationFinish = this.worker.terminate().then(() => {}, () => {}).then(() => {
      this.settleFailure(this.cancellationError!)
    })
  }

  private callback(callback: (() => void | Promise<void>) | undefined): void {
    try { Promise.resolve(callback?.()).catch((error) => this.fail(error)) }
    catch (error) { this.fail(error) }
  }

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) {
      this.fail(new Error('Invalid backend worker event'))
      return
    }
    const event = raw as BackendWorkerEvent
    if (this.cancellationError) {
      if (event.type === 'stopped' || event.type === 'failure' || event.type === 'migrated') this.finishCancellation()
      return // Late ready/restart events cannot publish a cancelled backend.
    }
    if (event.type === 'failure') {
      const error = new Error(typeof event.message === 'string' ? event.message : 'Backend worker failed')
      if (typeof event.stack === 'string') error.stack = event.stack
      this.fail(error)
    } else if (event.type === 'ready' && this.state === 'starting') {
      if (!Array.isArray(event.mounts) || event.mounts.some((mount) => typeof mount !== 'string')) {
        this.fail(new Error('Invalid backend mount registration'))
        return
      }
      this.mounts = Object.freeze([...event.mounts]) as unknown as string[]
      this.hasAccount = event.hasAccount === true
      this.accountMetadata = event.accountMetadata && Object.freeze({ ...event.accountMetadata })
      this.state = 'running'
      this.finish()
    } else if (event.type === 'migrated' && this.state === 'migrating') {
      this.expectedExit = true
      void this.worker.terminate().then(() => {
        if (this.cancellationError) { this.finishCancellation(); return }
        this.state = 'stopped'; this.finish()
      }, (error) => this.fail(error))
    } else if (event.type === 'stopped' && this.state === 'stopping') {
      this.expectedExit = true
      void this.worker.terminate().then(() => {
        if (this.stopTimer) clearTimeout(this.stopTimer)
        this.closeConnections()
        this.state = 'stopped'
        this.resolveStop?.()
      }, (error) => this.fail(error))
    } else if (event.type === 'account-result') {
      this.accountCalls.get(event.requestId)?.finish(event.identity)
    } else if (event.type === 'account-error') {
      this.accountCalls.get(event.requestId)?.finish(null, new Error('Account provider unavailable'))
    } else if (event.type === 'restart' && this.state === 'running') {
      this.callback(this.options.onRestart)
    } else if (event.type === 'log' && typeof event.message === 'string') {
      // Configuration and backend exceptions are never turned into HTTP responses.
      try { this.options.onLog?.(event.message) } catch { /* observer must not terminate the Unit */ }
    }
  }

  private finish(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.detachAbort()
    if (this.completed) return
    this.completed = true
    this.resolveCompletion()
  }

  private fail(cause: unknown): void {
    if (this.state === 'stopped') return
    if (this.cancellationError) { this.finishCancellation(); return }
    const error = cause instanceof Error ? cause : new Error(String(cause))
    this.expectedExit = true
    this.settleFailure(error)
    void this.worker.terminate().catch(() => {})
  }

  private settleFailure(error: Error): void {
    this.state = 'failed'
    this.detachAbort()
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.closeConnections()
    if (!this.completed) { this.completed = true; this.rejectCompletion(error) }
    this.rejectStop?.(error)
    if (!this.failureReported) {
      this.failureReported = true
      try { this.options.onFailure?.(error) } catch { /* observers cannot take down the Unit */ }
    }
  }

  private closeConnections(): void {
    for (const socket of this.active) socket.destroy(new Error('Backend plugin unavailable'))
    this.active.clear()
    for (const call of this.accountCalls.values()) call.finish(null, new Error('Account provider unavailable'))
  }

  resolveAccount: BackendAccount['resolve'] = async (token, options = {}) => {
    if (this.state !== 'running' || !this.hasAccount) throw new Error('Account provider unavailable')
    if (typeof token !== 'string' || !token || token.length > 16_384) return null
    if (options.signal?.aborted) throw new Error('Account resolution cancelled')
    if (this.accountCalls.size >= 256) throw new Error('Account provider busy')
    const requestId = randomUUID()
    return new Promise<BackendIdentity | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (identity: BackendIdentity | null, error?: Error) => {
        if (!this.accountCalls.delete(requestId)) return
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve(identity)
      }
      const abort = (message: string) => {
        finish(null, new Error(message))
        try { this.worker.postMessage({ type: 'account-cancel', requestId } satisfies BackendWorkerCommand) } catch { /* worker already gone */ }
      }
      const cancel = () => abort('Account resolution cancelled')
      this.accountCalls.set(requestId, { finish })
      timer = setTimeout(() => abort('Account resolution timed out'), Math.min(this.options.accountTimeoutMs ?? 5000, 30_000))
      timer.unref()
      options.signal?.addEventListener('abort', cancel, { once: true })
      if (options.signal?.aborted) { cancel(); return }
      try { this.worker.postMessage({ type: 'account-resolve', requestId, token } satisfies BackendWorkerCommand) }
      catch { finish(null, new Error('Account provider unavailable')) }
    })
  }

  private connection(metadata: SocketMetadata): PortDuplex {
    const { port1, port2 } = new MessageChannel()
    const stream = new PortDuplex(port1)
    this.active.add(stream)
    stream.once('close', () => this.active.delete(stream))
    try {
      this.worker.postMessage({ type: 'connection', port: port2, socket: metadata } satisfies BackendWorkerCommand, [port2])
    } catch (error) {
      port2.close()
      stream.destroy()
      throw error
    }
    return stream
  }

  handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (this.state !== 'running') { unavailable(response); return }
    let connection: PortDuplex
    try { connection = this.connection(socketMetadata(request.socket)) }
    catch { unavailable(response); return }
    // agent:false creates an Agent which ignores createConnection. An explicitly
    // owned one-shot agent always uses our MessagePort, never a DNS/TCP fallback.
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => connection as unknown as import('node:net').Socket
    const upstream = http.request({ hostname: 'unit-backend.invalid', port: 80,
      path: request.url, method: request.method, headers: { ...request.headers, connection: 'close' }, agent })
    const cancel = (): void => { upstream.destroy(); connection.destroy(); agent.destroy() }
    request.once('aborted', cancel)
    request.once('error', cancel)
    request.once('end', () => { if (Object.keys(request.trailers).length) upstream.addTrailers(request.trailers) })
    response.once('close', cancel)
    upstream.once('error', () => { unavailable(response); agent.destroy() })
    upstream.once('response', (incoming) => {
      if (response.destroyed) { incoming.destroy(); return }
      const headers = { ...incoming.headers }
      delete headers.connection
      delete headers['keep-alive']
      response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, headers)
      incoming.once('aborted', () => response.destroy())
      incoming.once('error', () => response.destroy())
      incoming.once('end', () => { if (Object.keys(incoming.trailers).length) response.addTrailers(incoming.trailers) })
      incoming.pipe(response)
    })
    request.pipe(upstream)
  }

  upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (this.state !== 'running') { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    let connection: PortDuplex
    try { connection = this.connection(socketMetadata(request.socket)) }
    catch { socket.destroy(); return }
    const close = (): void => { connection.destroy(); socket.destroy() }
    socket.once('error', close)
    socket.once('close', () => connection.destroy())
    connection.once('error', close)
    connection.once('close', () => socket.destroy())
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`]
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
    connection.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) connection.write(head)
    socket.pipe(connection).pipe(socket)
  }

  stop = (): Promise<void> => {
    if (this.stopPromise) return this.stopPromise
    if (this.state === 'stopped') return Promise.resolve()
    if (this.state === 'failed') return this.worker.terminate().then(() => {})
    this.state = 'stopping'
    this.closeConnections()
    this.stopPromise = new Promise<void>((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject })
    this.stopTimer = setTimeout(() => this.fail(new Error('Backend stop timed out')), this.options.stopTimeoutMs ?? 10_000)
    this.stopTimer.unref()
    this.worker.postMessage({ type: 'stop' } satisfies BackendWorkerCommand)
    return this.stopPromise
  }
}

export async function startBackend(options: BackendOptions): Promise<BackendHandle> {
  const session = new BackendSession(options, 'start')
  await session.completion
  return { get mounts() { return session.mounts }, get state() { return session.state },
    account: session.hasAccount ? { metadata: session.accountMetadata, resolve: session.resolveAccount } : undefined,
    handle: session.handle, upgrade: session.upgrade, stop: session.stop }
}

/** Migrations run in a fresh worker without starting or publishing its business routes. */
export async function migrateBackend(options: BackendOptions): Promise<void> {
  await new BackendSession(options, 'migrate').completion
}
