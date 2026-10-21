#!/usr/bin/env node
// Desktop and engine have independent version sequences. Check each identity in its own namespace.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE = '@forsion/tangu-agent'
const SCHEMA_SOURCES = ['src/db/migrate.ts', 'src/db/schemaStandalone.ts', 'src/core/dialectDDL.ts']
const ENGINE_SOURCES = ['src', 'skills', 'agent-skills', 'tsconfig.json', 'package-lock.json']
const RELEASE = /^\d+\.\d+\.\d+$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const cmp = (a, b) => {
  const [ac, ap] = a.split(/-(.*)/s), [bc, bp] = b.split(/-(.*)/s)
  const x = ac.split('.').map(Number), y = bc.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  if (ap === bp) return 0
  if (ap === undefined || bp === undefined) return ap === undefined ? 1 : -1
  const ax = ap.split('.'), bx = bp.split('.')
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === bx[i]) continue
    if (ax[i] === undefined || bx[i] === undefined) return ax[i] === undefined ? -1 : 1
    const an = /^\d+$/.test(ax[i]), bn = /^\d+$/.test(bx[i])
    if (an !== bn) return an ? -1 : 1
    return (an ? Number(ax[i]) < Number(bx[i]) : ax[i] < bx[i]) ? -1 : 1
  }
  return 0
}
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

export function desktopProblems({ desktop, engine, ref, newestPublished, previousEngine, sameVersionBaseline, engineChanged }) {
  const problems = []
  if (!VERSION.test(desktop) || !VERSION.test(engine)) problems.push('Desktop and engine must each have an x.y.z version, optionally with a prerelease suffix.')
  if (ref && ref !== `v${desktop}`) problems.push(`Tag ${ref} does not match desktop ${desktop}.`)
  if (previousEngine && cmp(engine, previousEngine) < 0) problems.push(`Bundled engine ${engine} would downgrade ${previousEngine} from the previous desktop.`)
  if (sameVersionBaseline) {
    if (engineChanged) problems.push(`Engine ${engine} differs from its released source ${sameVersionBaseline}; bump the engine version only.`)
  } else if (newestPublished && cmp(engine, newestPublished) <= 0) {
    problems.push(`Engine ${engine} is not newer than published ${newestPublished} and has no verified same-version source; use a new engine version.`)
  }
  return problems
}

export function hotUpdateProblems({ version, baseEngine, baseDesktop, ref, publish, dependenciesMatch, schemaChanges, newestPublished }) {
  const problems = []
  if (!dependenciesMatch) problems.push(`dependencies differ from desktop ${baseDesktop}; ship these changes in an installer.`)
  if (schemaChanges.length) problems.push(`schema / migration files changed since desktop ${baseDesktop} (${schemaChanges.join(', ')}); ship these changes in an installer.`)
  if (publish) {
    if (ref !== `tangu-v${version}`) problems.push(`Tag ${ref} does not match engine ${version}.`)
    if (cmp(version, baseEngine) <= 0) problems.push(`Engine ${version} is not newer than bundled engine ${baseEngine} in desktop ${baseDesktop}.`)
    if (newestPublished && cmp(version, newestPublished) <= 0) problems.push(`${PACKAGE}@${newestPublished} is already published; ${version} is not newer.`)
  }
  return problems
}

export function runGate(root, args, env = process.env, { readPublishedVersion } = {}) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  if (!(args[0] === '--desktop-release' ? VERSION : RELEASE).test(version)) throw new Error(`Invalid engine version ${JSON.stringify(version)} for this release channel.`)
  const desktop = JSON.parse(readFileSync(path.join(root, '..', 'desktop', 'package.json'), 'utf8')).version
  if (!VERSION.test(desktop)) throw new Error(`Invalid desktop version ${JSON.stringify(desktop)}.`)
  const npmVersions = () => {
    // Do not confuse an unavailable registry with an unused version. This package already exists.
    const cmd = process.platform === 'win32' ? 'cmd' : 'npm'
    const a = ['view', PACKAGE, 'versions', '--json', '--registry=https://registry.npmjs.org']
    const out = JSON.parse(execFileSync(cmd, process.platform === 'win32' ? ['/c', 'npm', ...a] : a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    const versions = (Array.isArray(out) ? out : [out]).filter(v => typeof v === 'string' && RELEASE.test(v))
    if (!versions.length) throw new Error('Registry returned no stable engine versions; cannot validate release identity.')
    return versions.sort(cmp).at(-1)
  }
  const manifestAt = (ref) => JSON.parse(git('show', `${ref}:tangu-agent/package.json`))
  const changed = (ref, paths) => git('diff', '--name-only', ref, '--', ...paths).split('\n').filter(Boolean)
  const failOn = (problems) => { if (problems.length) throw new Error(problems.join('\n')) }

  if (args[0] === '--desktop-release') {
    // Checkout must include tags. Exclude the candidate desktop tag itself: it is not a previous release.
    const tags = git('tag', '--list', 'v*', '--merged', 'HEAD').split('\n')
      .filter(t => VERSION.test(t.slice(1)) && t !== `v${desktop}` && cmp(t.slice(1), desktop) < 0)
      .sort((a, b) => cmp(b.slice(1), a.slice(1)))
    const previous = tags[0] ? manifestAt(tags[0]) : null
    let baseline = tags.find(tag => manifestAt(tag).version === version)
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
  const baseTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', '*-*')
  const baseDesktop = baseTag.slice(1)
  if (!RELEASE.test(baseDesktop)) throw new Error(`No stable desktop baseline: ${baseTag}`)
  const basePkg = manifestAt(baseTag)
  if (!RELEASE.test(basePkg.version)) throw new Error(`Invalid bundled engine version at ${baseTag}`)
  const problems = hotUpdateProblems({ version, baseEngine: basePkg.version, baseDesktop, ref, publish,
    dependenciesMatch: sortedJson(pkg.dependencies) === sortedJson(basePkg.dependencies),
    schemaChanges: changed(baseTag, SCHEMA_SOURCES), newestPublished: publish ? (readPublishedVersion ?? npmVersions)() : undefined })
  if (publish) failOn(problems)
  else for (const problem of problems) console.log(`::warning::${problem}`)
  // A manual preview uses the baseline ENGINE number, not the independent desktop number.
  const packVersion = publish ? version : basePkg.version
  console.log(`${PACKAGE}@${packVersion}, minimum desktop ${baseDesktop}; ${publish ? 'will publish' : 'manual preview only, not publishing'}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `base=${baseDesktop}\nbase_engine=${basePkg.version}\npack_version=${packVersion}\npublish=${publish}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { runGate(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.slice(2)) }
  catch (e) { console.error(`::error::${e.message}`); process.exitCode = 1 }
}
