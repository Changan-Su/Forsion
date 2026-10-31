/** Trusted local capabilities supplied by installed Forsion packages, never by the bare Unit. */
import type { VaultFace } from '../desktop/electron/amadeus/ipc'

export interface RuntimeContext {
  /** May be read-only and shared with other instances: write under dataDir, never here. */
  packageDir: string
  dataDir: string
  workspaceDir: string
  config: Record<string, unknown>
  log(message: string): void
}
export interface LocalRuntime {
  vault?: VaultFace
  engine?: {
    endpoint(): { url: string | null; token: string }
    status(): unknown
  }
  /** Reconcile installed/enabled bundles using the same loader as desktop. */
  setPackages?(roots: string[], installedRoots?: string[]): Promise<void>
  readProviders?(): Promise<unknown[]>
  close(): Promise<void>
}
export type RuntimeFactory = (context: RuntimeContext) => LocalRuntime | Promise<LocalRuntime>
