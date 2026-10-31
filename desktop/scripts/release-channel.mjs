import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNewer, parseReleaseVersion } from '../shared/releaseVersion.mjs'

/** A backfilled stable release must not displace a newer installer from /releases/latest. */
export function releaseFlags(tag, latestTag) {
  const version = parseReleaseVersion(tag), latest = parseReleaseVersion(latestTag)
  if (!version || !latest || latest.prerelease.length) throw new Error('Invalid candidate or current stable release identity')
  if (version.prerelease.length) return '--prerelease --latest=false'
  return isNewer(version.version, latest.version) || version.version === latest.version ? '--latest' : '--latest=false'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(releaseFlags(process.argv[2], process.argv[3]))
}
