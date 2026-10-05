/** Gate for the npm publish job. npm versions are immutable, so only the exact tagged release build may go out:
 * a build from main carries the same version as the release it follows and would either collide or mislabel. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Returns why this distribution must not be published under `tag`, or null when it may. */
export function publishBlocker(release, pkg, tag) {
  if (pkg.name !== '@forsion/unit') return `unexpected package name ${pkg.name}`
  if (release.prerelease || release.unitRevision !== 0) return `pre-release build (revision ${release.unitRevision}) after ${release.desktopTag}`
  if (release.sourceDirty) return 'built from a checkout with uncommitted changes'
  if (tag !== `v${pkg.version}` || release.desktopTag !== tag) return `tag ${tag} does not match package ${pkg.version} (baseline ${release.desktopTag})`
  return null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, tag] = process.argv.slice(2)
  const read = async (name) => JSON.parse(await readFile(resolve(directory, name), 'utf8'))
  const blocker = publishBlocker(await read('release.json'), await read('package.json'), tag)
  if (blocker) { console.error(`[unit] Not publishable: ${blocker}`); process.exit(1) }
  console.log(`[unit] ${tag} is publishable`)
}
