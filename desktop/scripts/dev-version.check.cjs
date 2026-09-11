/** npm run check:version; also runs before npm run dev. Read-only, never fetches or changes Git state. */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function inspectVersions(desktop) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
  const engine = path.resolve(desktop, '../tangu-agent')
  const values = {}
  for (const [name, root] of [['desktop', desktop], ['tangu-agent', engine]]) {
    values[`${name}/package.json`] = read(path.join(root, 'package.json')).version
    const lock = read(path.join(root, 'package-lock.json'))
    values[`${name}/package-lock.json`] = lock.version
    values[`${name}/package-lock.json packages[""]`] = lock.packages?.['']?.version
  }
  const changelog = fs.readFileSync(path.join(desktop, 'CHANGELOG.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  values['desktop/CHANGELOG.md'] = /^##\s+(?:Forsion\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/mi.exec(changelog)?.[1]
  const version = values['desktop/package.json']
  const errors = Object.entries(values)
    .filter(([, value]) => !value || value !== version)
    .map(([file, value]) => `${file}: ${value || '(missing)'}; expected ${version}`)
  return { version, errors }
}

function main() {
  const desktop = path.resolve(__dirname, '..')
  const { version, errors } = inspectVersions(desktop)
  console.log(`[dev-version] Forsion ${version} | ${desktop}`)
  for (const error of errors) console.error(`[dev-version] MISMATCH ${error}`)
  if (errors.length) {
    console.error('[dev-version] Reconcile the release baseline and version files before starting dev.')
    process.exitCode = 1
  }
  const git = (...args) => execFileSync('git', args, {
    cwd: desktop, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    const commit = git('rev-parse', '--short', 'HEAD')
    console.log(`[dev-version] ${branch} @ ${commit}`)
    const upstreamVersion = JSON.parse(git('show', 'origin/main:desktop/package.json')).version
    const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/)
    console.log(`[dev-version] cached origin/main ${upstreamVersion} | ahead ${ahead}, behind ${behind}`)
    if (behind !== '0') {
      console.warn('[dev-version] This checkout is behind cached origin/main. Releases from another worktree do not update this directory.')
    }
  } catch { /* Source archives and repositories without origin/main can still run dev. */ }
}

module.exports = { inspectVersions }
if (require.main === module) main()
