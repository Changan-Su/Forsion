/** Trusted local capabilities supplied by installed Forsion packages, never by the bare Unit. */
import type { VaultFace } from '../desktop/electron/amadeus/ipc'

export interface RuntimeContext {
  /** May be read-only and shared with other instances: write under dataDir, never here. */
  packageDir: string
  dataDir: string
  workspaceDir: string
  config: Record<string, unknown>
  /** Set on a public Unit's visitor engine: one engine serves every signed-in visitor as their own account.
   *  The runtime must then provide an engine only, never a vault or an owner account. */
  multiAccount?: boolean
  /** Visitor engine only: the account server's origin (the remote account authority). The engine sends model calls there with
   *  each visitor's model ticket. Never a credential. */
  cloudUrl?: string
  /** Visitor engine only: 'required' when this Unit holds a hosted unit device credential. Plugin scripts must then run as an
   *  unprivileged user so they cannot read it; an engine that cannot switch users refuses to run them. */
  scriptIsolation?: 'required'
  /** Visitor engine only: give the engine a second, host-only credential for per-account backup operations (snapshot,
   *  restore, archive). With it the engine also stops creating accounts on its own: the host admits or restores them. */
  hostControl?: boolean
  log(message: string): void
}
/** The vault as the cloud host sees it. The lock must come from here: it is module state of the runtime bundle that owns the vault. */
export interface RuntimeVault extends VaultFace {
  withWriteLock(paths: string | string[], commit: () => void): Promise<void>
  setMutationHooks(
    onMutate: (rel: string, kind: 'write' | 'remove') => void,
    onMove: (from: string, to: string, kind?: 'file' | 'folder') => void | Promise<void>,
    onBeforeMove: (from: string, to: string) => (() => void) | undefined,
  ): void
  /** Resolves once operations already queued on the vault have finished. */
  settled(): Promise<void>
}
export interface LocalRuntime {
  vault?: RuntimeVault
  engine?: {
    /** multiAccount: the engine confirmed multi-account mode (required before a public Unit lets visitors in). */
    endpoint(): { url: string | null; token: string; multiAccount?: boolean }
    /** The host-only side of a visitor engine started with hostControl (never handed to visitors' requests). */
    control?(): { url: string | null; token: string } | null
    status(): unknown
  }
  /** Reconcile installed/enabled bundles using the same loader as desktop. */
  setPackages?(roots: string[], installedRoots?: string[]): Promise<void>
  readProviders?(): Promise<unknown[]>
  /** The owner's account, on a runtime that hosts the cloud account bundle. */
  account?: { login(cloudUrl?: string): Promise<unknown>; logout(): Promise<unknown>; status(): Promise<unknown> }
  close(): Promise<void>
}
export type RuntimeFactory = (context: RuntimeContext) => LocalRuntime | Promise<LocalRuntime>
