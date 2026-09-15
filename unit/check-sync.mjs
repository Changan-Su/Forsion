/** Read-only release baseline, derived from git. Fetch tags before checking a new release. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSourcePaths } from './releasePolicy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const isAncestor = (commit) => { try { git('merge-base', '--is-ancestor', commit, 'HEAD'); return true } catch { return false } }
const byVersion = (a, b) => {
  const left = a.slice(1).split('.').map(Number), right = b.slice(1).split('.').map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/** The Desktop baseline is the newest release tag contained in this checkout and the Unit revision counts
 * the commits since it. Nothing is hand-maintained: the Unit builds from the same commit as Desktop, so the
 * only drift left to catch is a stale checkout (a newer release tag exists outside HEAD's history).
 * A package version beyond the tag is a pre-release build and is recorded, not refused. */
export async function readReleaseBaseline() {
  const versions = {}
  for (const pkg of ['desktop', 'tangu-agent']) versions[pkg] = JSON.parse(await readFile(resolve(root, pkg, 'package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+$/.test(versions.desktop) || versions.desktop !== versions['tangu-agent']) {
    throw new Error(`desktop ${versions.desktop} and tangu-agent ${versions['tangu-agent']} must ship the same version`)
  }
  const tags = git('tag', '--list', 'v*').split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)).sort(byVersion).reverse()
  if (!tags.length) throw new Error('No Desktop release tag found; fetch tags before building a Unit')
  const desktopTag = tags.find((tag) => isAncestor(`${tag}^{commit}`))
  if (!desktopTag) throw new Error('No Desktop release tag is contained in this checkout; pull the released history first')
  if (tags[0] !== desktopTag) throw new Error(`Checkout is behind the latest Desktop release ${tags[0]} (it contains ${desktopTag}); pull before building a Unit`)
  const desktopCommit = git('rev-parse', `${desktopTag}^{commit}`)
  const unitRevision = Number(git('rev-list', '--count', `${desktopCommit}..HEAD`))
  checkSourcePaths(git('ls-files', '-z').split('\0').filter(Boolean))
  return {
    desktopVersion: versions.desktop, desktopTag, desktopCommit, unitRevision, prerelease: `v${versions.desktop}` !== desktopTag,
    sourceCommit: git('rev-parse', 'HEAD'), sourceDirty: !!git('status', '--porcelain', '--untracked-files=normal'),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await readReleaseBaseline(), null, 2))
}
