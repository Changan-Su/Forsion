import { parseReleaseVersion } from '../../../desktop/shared/releaseVersion.mjs'

/** Same-precedence next revision, valid even when the installed package is itself a preview or revision. */
export function revisionFixture(installed) {
  const parsed = parseReleaseVersion(installed)
  if (!parsed || parsed.revision === Number.MAX_SAFE_INTEGER) throw new Error(`Cannot generate revision fixture for ${installed}`)
  const base = parsed.main.join('.') + (parsed.prerelease.length ? `-${parsed.prerelease.join('.')}` : '')
  return { version: `${base}+build.${parsed.revision + 1}`, beta: parsed.prerelease.length > 0 }
}
