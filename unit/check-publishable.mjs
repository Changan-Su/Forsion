/** Gate for the npm publish job. npm versions are immutable, so only the exact tagged release build may go out:
 * a build from main carries the same version as the release it follows and would either collide or mislabel. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReleaseVersion } from '../desktop/shared/releaseVersion.mjs'

/** Returns why this distribution must not be published under `tag`, or null when it may. */
export function publishBlocker(release, pkg, tag) {
  if (pkg.name !== '@forsion/unit') return `unexpected package name ${pkg.name}`
  const parsed = parseReleaseVersion(pkg.version)
  if (!parsed || parsed.version !== pkg.version) return `invalid package version ${pkg.version}`
  // npm discards build metadata in package identities. A Desktop revision stays an artifact, never overwrites the base npm package.
  if (parsed.metadata.length) return 'build metadata revisions are artifact-only; npm would reuse the base version'
  if (release.prerelease || release.unitRevision !== 0) return `pre-release build (revision ${release.unitRevision}) after ${release.desktopTag}`
  if (release.sourceDirty) return 'built from a checkout with uncommitted changes'
  if (tag !== `v${pkg.version}` || release.desktopTag !== tag) return `tag ${tag} does not match package ${pkg.version} (baseline ${release.desktopTag})`
  return null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, tag] = process.argv.slice(2)
  const read = async (name) => JSON.parse(await readFile(resolve(directory, name), 'utf8'))
  const release = await read('release.json'), pkg = await read('package.json')
  const parsed = parseReleaseVersion(pkg.version)
  // Keep the existing npm stable-only policy; tagged prereleases/revisions still produce downloadable Unit artifacts.
  if (process.argv.includes('--github-output') && parsed && (parsed.prerelease.length || parsed.metadata.length)) {
    if (pkg.name !== '@forsion/unit' || release.sourceDirty || release.unitRevision !== 0 || release.taggedRelease !== true || release.desktopTag !== tag || tag !== `v${pkg.version}`) throw new Error('Artifact does not match the exact clean release tag')
    console.log(`[unit] ${tag} is artifact-only; npm publish skipped`)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_OUTPUT, 'publish=false\n')
    process.exit(0)
  }
  const blocker = publishBlocker(release, pkg, tag)
  if (blocker) { console.error(`[unit] Not publishable: ${blocker}`); process.exit(1) }
  console.log(`[unit] ${tag} is publishable`)
  if (process.argv.includes('--github-output')) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_OUTPUT, 'publish=true\n')
  }
}
