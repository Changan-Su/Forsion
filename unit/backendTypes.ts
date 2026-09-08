import type { IncomingMessage, RequestListener } from 'node:http'
import type { Duplex } from 'node:stream'
import type { MessagePort } from 'node:worker_threads'

/** Backend capabilities extend the existing package identity; they are not a second manifest. */
export interface BackendContext {
  packageDir: string
  dataDir: string
  config: Record<string, unknown>
  signal: AbortSignal
  log: (...messages: unknown[]) => void
  requestRestart: () => void
}

export type BackendUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface BackendPlugin {
  /** Absolute URL prefixes. The Unit checks ownership before publishing them. */
  mounts: string[]
  handle: RequestListener
  upgrade?: BackendUpgrade
  start?: () => void | Promise<void>
  stop?: () => void | Promise<void>
  migrate?: () => void | Promise<void>
}

export type BackendFactory = (context: BackendContext) => BackendPlugin | Promise<BackendPlugin>
export type BackendState = 'starting' | 'running' | 'migrating' | 'stopping' | 'stopped' | 'failed'

export interface BackendOptions {
  id: string
  entry: string
  packageDir: string
  dataDir: string
  config?: Record<string, unknown>
  /** Worker-local overrides; undefined removes an inherited variable. */
  env?: Record<string, string | undefined>
  workerFile: string
  onRestart?: () => void | Promise<void>
  onFailure?: (error: Error) => void
  onLog?: (message: string) => void
  startTimeoutMs?: number
  stopTimeoutMs?: number
  /** Cancel startup or migration, awaiting bounded plugin cleanup before rejecting. */
  signal?: AbortSignal
}

export interface BackendHandle {
  readonly mounts: string[]
  readonly state: BackendState
  handle: RequestListener
  upgrade: BackendUpgrade
  stop: () => Promise<void>
}

export interface SocketMetadata {
  remoteAddress?: string
  remotePort?: number
  remoteFamily?: string
  localAddress?: string
  localPort?: number
  encrypted?: boolean
}

export interface BackendWorkerData {
  id: string
  entry: string
  packageDir: string
  dataDir: string
  config: Record<string, unknown>
  mode: 'start' | 'migrate'
}

export type BackendWorkerCommand =
  | { type: 'connection'; port: MessagePort; socket: SocketMetadata }
  | { type: 'stop' }

export type BackendWorkerEvent =
  | { type: 'ready'; mounts: string[] }
  | { type: 'migrated' }
  | { type: 'stopped' }
  | { type: 'failure'; message: string; stack?: string }
  | { type: 'restart' }
  | { type: 'log'; message: string }
