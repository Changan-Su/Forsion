export interface LocalEngineBuildOptions {
  output: string
  dependencyRoot?: string
  /** Optional exact-version SQLite package compiled for the builder's Node ABI. */
  sqlitePackage?: string
}
export function buildLocalEngine(options: LocalEngineBuildOptions): Promise<{
  entryFile: string
  dependencies: { mode: 'bundled'; platform: string; arch: string; nodeAbi: string; libc?: string }
}>
export function copyLockedProductionDependencies(source: string, target: string, lock: Record<string, any>): Promise<number>
