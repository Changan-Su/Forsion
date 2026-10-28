#!/usr/bin/env node
// Desktop and engine have independent version sequences. Check each identity in its own namespace.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE = '@forsion/tangu-agent'
const SCHEMA_SOURCES = ['src/db/migrate.ts', 'src/db/schemaStandalone.ts', 'src/core/dialectDDL.ts']
const ENGINE_SOURCES = ['src', 'skills', 'agent-skills', 'tsconfig.json', 'package-lock.json']
// Engine npm identities keep their existing stable/prerelease contract; metadata is Desktop-only.
import { compareReleaseVersions, isPrerelease, parseReleaseVersion } from '../../desktop/shared/releaseVersion.mjs'
import { engineLineTag } from '../../desktop/shared/engineLine.mjs'
// An installer whose tree has this file checks its own line's dist-tag; older installers read only `latest`.
const LINE_TAG_MODULE = 'desktop/shared/engineLine.mjs'
const engineVersion = v => { const p = parseReleaseVersion(v); return p && p.version === v && !p.metadata.length }
const desktopVersion = v => { const p = parseReleaseVersion(v); return p && p.version === v }
const stableEngine = v => engineVersion(v) && !isPrerelease(v)
export const cmp = compareReleaseVersions
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

export function desktopProblems({ desktop, engine, ref, newestPublished, previousEngine, sameVersionBaseline, engineChanged }) {
  const problems = []
  if (!desktopVersion(desktop) || !engineVersion(engine)) return ['Desktop must be a valid release version; engine must be x.y.z with an optional prerelease suffix and no build metadata.']
  if (ref && ref !== `v${desktop}`) problems.push(`Tag ${ref} does not match desktop ${desktop}.`)
  if (previousEngine && cmp(engine, previousEngine) < 0) problems.push(`Bundled engine ${engine} would downgrade ${previousEngine} from the previous desktop.`)
  if (sameVersionBaseline) {
    if (engineChanged) problems.push(`Engine ${engine} differs from its released source ${sameVersionBaseline}; bump the engine version only.`)
  } else if (newestPublished && cmp(engine, newestPublished) <= 0) {
    problems.push(`Engine ${engine} is not newer than published ${newestPublished} and has no verified same-version source; use a new engine version.`)
  }
  return problems
}

// One publish sets exactly one dist-tag: trusted publishing (OIDC) covers `npm publish`, not `npm dist-tag add`.
// Line-aware installers get their own tag and `latest` stays put; a legacy stable line keeps `latest` (all it reads);
// a legacy prerelease line is unreachable without taking `latest` from the stable line, so it gets null.
export const hotUpdateDistTag = (baseDesktop, lineAware) =>
  lineAware ? engineLineTag(baseDesktop) : isPrerelease(baseDesktop) ? null : 'latest'

export function hotUpdateProblems({ version, baseEngine, baseDesktop, ref, publish, dependenciesMatch, schemaChanges, newestPublished, newestBundled, distTag }) {
  const problems = []
  if (!distTag) problems.push(`desktop ${baseDesktop} only reads the latest dist-tag, which belongs to the stable line; ship this fix in the next desktop build.`)
  if (!dependenciesMatch) problems.push(`dependencies differ from desktop ${baseDesktop}; ship these changes in an installer.`)
  if (schemaChanges.length) problems.push(`schema / migration files changed since desktop ${baseDesktop} (${schemaChanges.join(', ')}); ship these changes in an installer.`)
  if (publish) {
    if (ref !== `tangu-v${version}`) problems.push(`Tag ${ref} does not match engine ${version}.`)
    if (cmp(version, baseEngine) <= 0) problems.push(`Engine ${version} is not newer than bundled engine ${baseEngine} in desktop ${baseDesktop}.`)
    if (newestBundled && cmp(version, newestBundled) <= 0) problems.push(`Engine ${version} is not newer than engine ${newestBundled} already shipped in a desktop installer.`)
    if (newestPublished && cmp(version, newestPublished) <= 0) problems.push(`${PACKAGE}@${newestPublished} is already published; ${version} is not newer.`)
  }
  return problems
}

export function runGate(root, args, env = process.env, { readPublishedVersion } = {}) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  if (!(args[0] === '--desktop-release' ? engineVersion(version) : stableEngine(version))) throw new Error(`Invalid engine version ${JSON.stringify(version)} for this release channel.`)
  const desktop = JSON.parse(readFileSync(path.join(root, '..', 'desktop', 'package.json'), 'utf8')).version
  if (!desktopVersion(desktop)) throw new Error(`Invalid desktop version ${JSON.stringify(desktop)}.`)
  const npmVersions = () => {
    // Do not confuse an unavailable registry with an unused version. This package already exists.
    const cmd = process.platform === 'win32' ? 'cmd' : 'npm'
    const a = ['view', PACKAGE, 'versions', '--json', '--registry=https://registry.npmjs.org']
    const out = JSON.parse(execFileSync(cmd, process.platform === 'win32' ? ['/c', 'npm', ...a] : a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    const versions = (Array.isArray(out) ? out : [out]).filter(v => typeof v === 'string' && stableEngine(v))
    if (!versions.length) throw new Error('Registry returned no stable engine versions; cannot validate release identity.')
    return versions.sort(cmp).at(-1)
  }
  const manifestAt = (ref) => JSON.parse(git('show', `${ref}:tangu-agent/package.json`))
  const changed = (ref, paths) => git('diff', '--name-only', ref, '--', ...paths).split('\n').filter(Boolean)
  const failOn = (problems) => { if (problems.length) throw new Error(problems.join('\n')) }

  // Some historical desktop tags predate the tangu-agent/ layout. Ignore only missing paths, not Git failures.
  const desktopEngines = git('tag', '--list', 'v*').split('\n')
    .filter(t => parseReleaseVersion(t) && (args[0] !== '--desktop-release' || t !== `v${desktop}`))
    .filter(t => git('ls-tree', t, '--', 'package.json'))
    .map(tag => ({ tag, pkg: manifestAt(tag) }))
    .sort((a, b) => cmp(b.tag.slice(1), a.tag.slice(1)))
  if (args[0] === '--desktop-release') {
    const prior = desktopEngines.filter(item => cmp(item.tag.slice(1), desktop) < 0)
    const previous = prior[0]?.pkg
    let baseline = desktopEngines.find(item => item.pkg.version === version)?.tag
    // Only the ENGINE version is looked up in the hot-update namespace; the desktop number is unrelated.
    const engineTag = `tangu-v${version}`
    if (git('ls-remote', '--tags', 'origin', `refs/tags/${engineTag}`)) {
      git('fetch', '--quiet', 'origin', `refs/tags/${engineTag}`)
      baseline = 'FETCH_HEAD'
    }
    const engineChanged = baseline
      ? changed(baseline, ENGINE_SOURCES).length > 0 || sortedJson(manifestAt(baseline)) !== sortedJson(pkg)
      : false
    failOn(desktopProblems({ desktop, engine: version, ref: args[1], newestPublished: (readPublishedVersion ?? npmVersions)(), previousEngine: previous?.version, sameVersionBaseline: baseline, engineChanged }))
    console.log(`Desktop ${desktop}, bundled engine ${version}: independent identities verified${baseline ? ` against ${baseline}` : ''}.`)
    return
  }

  const [ref = '', event = ''] = args
  const publish = event === 'push' && ref.startsWith('tangu-v')
  // The installer line this hotfix was cut from, beta lines included.
  const baseTag = git('tag', '--merged', 'HEAD', '--list', 'v*').split('\n')
    .filter(t => parseReleaseVersion(t)).sort(cmp).at(-1)
  if (!baseTag) throw new Error('No desktop baseline is contained in this checkout')
  const baseDesktop = baseTag.slice(1)
  const basePkg = manifestAt(baseTag)
  // The launcher (overlay.ts checkOverlay) only replaces a stable bundled engine; a beta installer may bundle a prerelease one.
  if (!stableEngine(basePkg.version)) throw new Error(`Desktop ${baseDesktop} bundles engine ${basePkg.version}; hot updates only replace a stable bundled engine.`)
  // The whole line (original build and its +build.N revisions) may take it; checkOverlay still compares schema and dependencies.
  const minDesktop = baseDesktop.split('+')[0]
  const distTag = hotUpdateDistTag(baseDesktop, !!git('ls-tree', '--full-tree', '--name-only', baseTag, '--', LINE_TAG_MODULE))
  const problems = hotUpdateProblems({ version, baseEngine: basePkg.version, baseDesktop, ref, publish,
    dependenciesMatch: sortedJson(pkg.dependencies) === sortedJson(basePkg.dependencies),
    schemaChanges: changed(baseTag, SCHEMA_SOURCES),
    newestBundled: desktopEngines.map(item => item.pkg.version).filter(v => engineVersion(v)).sort(cmp).at(-1),
    newestPublished: publish ? (readPublishedVersion ?? npmVersions)() : undefined, distTag })
  if (publish) failOn(problems)
  else for (const problem of problems) console.log(`::warning::${problem}`)
  // A manual preview uses the baseline ENGINE number, not the independent desktop number.
  const packVersion = publish ? version : basePkg.version
  console.log(`${PACKAGE}@${packVersion}, minimum desktop ${minDesktop}, dist-tag ${distTag ?? '(none)'}; ${publish ? 'will publish' : 'manual preview only, not publishing'}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `base=${minDesktop}\nbase_engine=${basePkg.version}\npack_version=${packVersion}\npublish=${publish}\ndist_tag=${distTag ?? ''}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { runGate(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.slice(2)) }
  catch (e) { console.error(`::error::${e.message}`); process.exitCode = 1 }
}
