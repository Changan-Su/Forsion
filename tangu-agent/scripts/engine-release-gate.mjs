#!/usr/bin/env node
// 引擎 npm 热更新的发版门禁(.github/workflows/publish-engine.yml 与 build-desktop.yml 调用)。
//
//   node scripts/engine-release-gate.mjs <ref 名> <事件名>      发引擎之前:这一版发出去有没有桌面会收
//   node scripts/engine-release-gate.mjs --desktop-release       发桌面之前:版本号有没有被引擎热更新用掉
//
// 发引擎之前核四件(与桌面端装机时的判定 src/boot/overlay.ts 一一对应,在这里拦住就不会发出一个没人收的版本):
//   · 依赖清单与它所基于的那个桌面正式版相同(新版只带 dist,用的是安装包里的 node_modules);
//   · 建表 / 迁移文件没动(带迁移的版本只能随安装包发,这样退回自带引擎永远安全);
//   · 版本号比那个桌面正式版新;
//   · 推 tag 时:tag 就是 tangu-v<package.json 的版本>,且比 npm 上已有的都新。
// 手动运行(workflow_dispatch)只打包不发布,而且包的版本号恒取「所基于的桌面版本」—— 一个已经发过、没有任何桌面会装的号。
// 这种包只用来给 npm 上的包名占位(首发那一次),不会和将来任何一版撞号。
//
// 发桌面之前核一件:没有 tangu-v<这个版本> 的 tag。引擎热更新只在推这种 tag 时发布,有它 = 这个号已经归一次热更新了。
//
// 输出(GITHUB_OUTPUT):base=<所基于的桌面版本>  pack_version=<打包用的版本号>  publish=true|false
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = '@forsion/tangu-agent'
const SCHEMA_SOURCES = ['src/db/migrate.ts', 'src/db/schemaStandalone.ts', 'src/core/dialectDDL.ts']
const RELEASE = /^\d+\.\d+\.\d+$/
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const fail = (m) => {
  console.error(`::error::${m}`)
  process.exit(1)
}
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

/** npm 上已发布的全部版本;包还不存在(首发之前)或 registry 连不上返回 null。 */
function publishedVersions() {
  try {
    const out = JSON.parse(execFileSync('npm', ['view', PACKAGE, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    return Array.isArray(out) ? out : [out]
  } catch {
    return null
  }
}

if (process.argv[2] === '--desktop-release') {
  const desktop = JSON.parse(readFileSync(path.join(root, '..', 'desktop', 'package.json'), 'utf8')).version
  // 问远端而不是看本地:CI 的检出不带 tag。连不上远端就让它红 —— 这是发版门禁,不能在查不了的时候放行。
  const taken = git('ls-remote', '--tags', 'origin', `refs/tags/tangu-v${desktop}`)
  if (taken) {
    fail(`${desktop} already belongs to an engine hot update (tag tangu-v${desktop} exists). The engine bundled in this installer would differ from ${PACKAGE}@${desktop} on npm. Bump desktop and tangu-agent to the next patch.`)
  }
  console.log(`version ${desktop} is not taken by an engine hot update`)
  process.exit(0)
}

const [ref = '', event = ''] = process.argv.slice(2)
const publish = event === 'push' && ref.startsWith('tangu-v')
const problems = []
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (!RELEASE.test(version)) fail(`tangu-agent/package.json version ${JSON.stringify(version)} is not a release version (x.y.z).`)

let baseTag
try {
  baseTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', '*-*')
} catch {
  fail('No desktop release tag (v*) is reachable from this commit. An engine hot update is cut from the desktop release it targets.')
}
const base = baseTag.slice(1)
if (!RELEASE.test(base)) fail(`The nearest desktop tag ${baseTag} is not a stable release.`)

const baseDeps = JSON.parse(git('show', `${baseTag}:tangu-agent/package.json`)).dependencies
const deps = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies
if (sortedJson(deps) !== sortedJson(baseDeps)) problems.push(`dependencies differ from ${baseTag}: an engine with new or bumped dependencies can only ship inside an installer.`)
// git 在 tangu-agent/ 下跑,pathspec 相对这里写(带上 tangu-agent/ 前缀会指到不存在的路径,diff 恒为空)。
const changedSchema = git('diff', '--name-only', baseTag, '--', ...SCHEMA_SOURCES).split('\n').filter(Boolean)
if (changedSchema.length) problems.push(`schema / migration files changed since ${baseTag} (${changedSchema.join(', ')}): an engine with migrations can only ship inside an installer.`)

if (publish) {
  if (ref !== `tangu-v${version}`) fail(`Tag ${ref} does not match tangu-agent/package.json version ${version} (expected tangu-v${version}).`)
  if (cmp(version, base) <= 0) problems.push(`version ${version} is not newer than the desktop release ${base} it is based on; no desktop would install it.`)
  if (problems.length) fail(problems.join('\n'))
  const published = publishedVersions()
  const newest = published?.filter((v) => RELEASE.test(v)).sort(cmp).at(-1)
  if (newest && cmp(version, newest) <= 0) fail(`${PACKAGE}@${newest} is already on npm; ${version} is not newer.`)
} else {
  for (const p of problems) console.log(`::warning::${p}`)
}

const packVersion = publish ? version : base
console.log(publish
  ? `${PACKAGE}@${version}, based on desktop ${base}; will publish`
  : `manual run: packing ${PACKAGE}@${packVersion} (the desktop release this commit is based on, so no desktop will ever install it); not publishing`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\npack_version=${packVersion}\npublish=${publish}\n`)
