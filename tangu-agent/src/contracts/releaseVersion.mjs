/** Shared by browser update checks and Node release gates. Only +build.N is an ordered app revision. */
const number = '(?:0|[1-9]\\d*)'
const id = '[0-9A-Za-z-]+'
const pattern = new RegExp(`^(${number})\\.(${number})\\.(${number})(?:-(${id}(?:\\.${id})*))?(?:\\+(${id}(?:\\.${id})*))?$`)

export function parseReleaseVersion(value) {
  if (typeof value !== 'string' || value.length > 256) return null
  const version = value.trim().replace(/^v/i, '')
  const match = pattern.exec(version)
  if (!match) return null
  const main = match.slice(1, 4).map(Number)
  if (main.some(n => !Number.isSafeInteger(n))) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && !new RegExp(`^${number}$`).test(part))) return null
  const metadata = match[5]?.split('.') ?? []
  let revision = 0
  if (metadata[0] === 'build') {
    if (metadata.length !== 2 || !new RegExp(`^${number}$`).test(metadata[1])) return null
    revision = Number(metadata[1])
    if (!Number.isSafeInteger(revision)) return null
  }
  return { version, main, prerelease, metadata, revision }
}

/** SemVer precedence first; the reserved numeric revision only breaks an otherwise equal app version. */
export function compareReleaseVersions(left, right, includeRevision = true) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right)
  if (!a || !b) throw new Error(`Invalid release version: ${!a ? left : right}`)
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i] < b.main[i] ? -1 : 1
  if (!a.prerelease.length && b.prerelease.length) return 1
  if (a.prerelease.length && !b.prerelease.length) return -1
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn !== yn) return xn ? -1 : 1
    // Numeric identifiers may exceed Number.MAX_SAFE_INTEGER in valid SemVer.
    if (xn && x.length !== y.length) return x.length < y.length ? -1 : 1
    return x < y ? -1 : 1
  }
  return includeRevision ? Math.sign(a.revision - b.revision) : 0
}

export function isPrerelease(value) { return !!parseReleaseVersion(value)?.prerelease.length }
export function isNewer(remote, current) {
  return !!parseReleaseVersion(remote) && !!parseReleaseVersion(current) && compareReleaseVersions(remote, current) > 0
}
export function isRevisionUpgrade(remote, current) {
  return isNewer(remote, current) && compareReleaseVersions(remote, current, false) === 0
}
