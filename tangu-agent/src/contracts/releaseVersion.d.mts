export interface ReleaseVersion {
  version: string
  main: number[]
  prerelease: string[]
  metadata: string[]
  revision: number
}
export function parseReleaseVersion(value: unknown): ReleaseVersion | null
export function compareReleaseVersions(left: string, right: string, includeRevision?: boolean): number
export function isPrerelease(value: string): boolean
export function isNewer(remote: string, current: string): boolean
export function isRevisionUpgrade(remote: string, current: string): boolean
