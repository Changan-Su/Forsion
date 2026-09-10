/** Read-only upstream check. Fetch tags explicitly before checking a new release. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSourcePaths } from './releasePolicy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

export async function readReleaseBaseline() {
  const baseline = JSON.parse(await readFile(resolve(root, 'unit/upstream.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(baseline.desktopVersion) || baseline.desktopTag !== `v${baseline.desktopVersion}` || !Number.isInteger(baseline.unitRevision) || baseline.unitRevision < 1) throw new Error('Invalid Unit upstream baseline')
  if (git('rev-parse', `${baseline.desktopTag}^{commit}`) !== baseline.desktopCommit) throw new Error('Desktop tag differs from the recorded baseline')
  git('merge-base', '--is-ancestor', baseline.desktopCommit, 'HEAD')
  for (const pkg of ['desktop', 'tangu-agent']) {
    const { version } = JSON.parse(await readFile(resolve(root, pkg, 'package.json'), 'utf8'))
    if (version !== baseline.desktopVersion) throw new Error(`${pkg} ${version} differs from Desktop baseline ${baseline.desktopVersion}`)
  }
  const tags = git('tag', '--list', 'v*').split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  tags.sort((a, b) => {
    const left = a.slice(1).split('.').map(Number), right = b.slice(1).split('.').map(Number)
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  })
  if (tags.at(-1) !== baseline.desktopTag) throw new Error(`Unit needs synchronization: latest fetched Desktop tag is ${tags.at(-1)}, baseline is ${baseline.desktopTag}`)
  checkSourcePaths(git('ls-files', '-z').split('\0').filter(Boolean))
  return { ...baseline, sourceCommit: git('rev-parse', 'HEAD'), sourceDirty: !!git('status', '--porcelain', '--untracked-files=normal') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await readReleaseBaseline(), null, 2))
}
