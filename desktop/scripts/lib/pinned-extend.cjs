/**
 * A Forsion Extend build pinned to one commit, for rigs that must run against an Extend from before a protocol change
 * (sync-release.e2e.cjs compat mode needs one without the vault-sync v2 runtime: with v2 the host is in full mode and the
 * legacy entry sync is taken over at launch, so the claim / release story under test never happens).
 *
 * Source comes from `git archive <commit>` of a local Extend clone (no worktree is registered in it), node_modules is
 * linked from that clone, then `node scripts/build.mjs`. The result is cached under <cacheRoot>/forsion-extend-pin-<sha>
 * and reused while its `.pin` file names the same commit. Nothing here touches the clone's working tree.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function ensurePinnedExtend({ repo, commit, cacheRoot, log = () => {} }) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
  let full
  try { full = git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim() } catch {
    throw Error(`pinned Extend ${commit} not found in ${repo}: fetch it there (git -C ${repo} fetch origin), or set EXTEND_COMPAT_PKG to a built pre-v2 Extend`)
  }
  const dir = path.join(cacheRoot, `forsion-extend-pin-${full.slice(0, 12)}`)
  const pinFile = path.join(dir, '.pin')
  if (fs.existsSync(path.join(dir, 'dist/desktop.mjs')) && fs.existsSync(pinFile) && fs.readFileSync(pinFile, 'utf8').trim() === full) return { dir, commit: full, cached: true }
  const modules = path.join(repo, 'node_modules')
  if (!fs.existsSync(modules)) throw Error(`pinned Extend build needs ${modules} (npm ci in the Extend clone first)`)
  const tmp = `${dir}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  log(`building pinned Extend ${full.slice(0, 12)} into ${dir}`)
  execFileSync('tar', ['-xf', '-', '-C', tmp], { input: git('archive', full), maxBuffer: 512 * 1024 * 1024 })
  fs.symlinkSync(modules, path.join(tmp, 'node_modules'))
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
  if (!fs.existsSync(path.join(tmp, 'dist/desktop.mjs'))) throw Error(`pinned Extend ${full.slice(0, 12)} built no dist/desktop.mjs`)
  fs.writeFileSync(path.join(tmp, '.pin'), full + '\n')
  // Someone else finished the same pin meanwhile (rigs normally run one at a time under the GUI lock): keep theirs
  if (fs.existsSync(path.join(dir, 'dist/desktop.mjs')) && fs.existsSync(pinFile) && fs.readFileSync(pinFile, 'utf8').trim() === full) { fs.rmSync(tmp, { recursive: true, force: true }); return { dir, commit: full, cached: true } }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(tmp, dir)
  return { dir, commit: full, cached: false }
}

module.exports = { ensurePinnedExtend }
