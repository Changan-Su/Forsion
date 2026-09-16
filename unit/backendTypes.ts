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

/** A verified visitor identity. It never represents the Unit host's own account. */
export interface BackendIdentity {
  userId: string
  username: string
  role: string
  /** Account providers choose these scopes from trusted server state, never request headers. */
  tenantId?: string
  workspaceId?: string
  nickname?: string
  avatar?: string
}

export interface BackendAccount {
  /** Public, same-origin endpoints used by the shared browser Account adapter. */
  metadata?: { apiBase: string; loginPath: string }
  resolve: (token: string, options?: { signal?: AbortSignal }) => Promise<BackendIdentity | null>
}

export interface BackendPlugin {
  /** Absolute URL prefixes. The Unit checks ownership before publishing them. */
  mounts: string[]
  handle: RequestListener
  upgrade?: BackendUpgrade
  start?: () => void | Promise<void>
  stop?: () => void | Promise<void>
  migrate?: () => void | Promise<void>
  account?: BackendAccount
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
  /** Account calls are individually bounded, including providers which ignore abort. */
  accountTimeoutMs?: number
  /** Cancel startup or migration, awaiting bounded plugin cleanup before rejecting. */
  signal?: AbortSignal
}

export interface BackendHandle {
  readonly mounts: string[]
  readonly state: BackendState
  handle: RequestListener
  upgrade: BackendUpgrade
  stop: () => Promise<void>
  readonly account?: BackendAccount
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
  | { type: 'account-resolve'; requestId: string; token: string }
  | { type: 'account-cancel'; requestId: string }

export type BackendWorkerEvent =
  | { type: 'ready'; mounts: string[]; hasAccount?: boolean; accountMetadata?: BackendAccount['metadata'] }
  | { type: 'account-result'; requestId: string; identity: BackendIdentity | null }
  | { type: 'account-error'; requestId: string }
  | { type: 'migrated' }
  | { type: 'stopped' }
  | { type: 'failure'; message: string; stack?: string }
  | { type: 'restart' }
  | { type: 'log'; message: string }
