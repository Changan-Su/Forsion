/** Trusted local capabilities supplied by installed Forsion packages, never by the bare Unit. */
import type { VaultFace } from '../desktop/electron/amadeus/ipc'

export interface RuntimeContext {
  packageDir: string
  dataDir: string
  workspaceDir: string
  config: Record<string, unknown>
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
    endpoint(): { url: string | null; token: string }
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
