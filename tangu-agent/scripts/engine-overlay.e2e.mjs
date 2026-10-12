#!/usr/bin/env node
/**
 * 引擎热更新整条链的端到端核对:真打包 + 真签名 + 真启动器 + 真引擎。先 `npm run build`。
 *
 *   node scripts/engine-overlay.e2e.mjs [--root <自带引擎的包根>] [--exe <拿来当 node 跑的 Electron>]
 *
 * 缺省核本仓这份 dist + 当前 node。--root / --exe 用来核打包后的真实运行时(desktop/scripts/engine-overlay-packaged.check.cjs):
 * 自带引擎 = 安装包里的 resources/tangu-server,解释器 = 安装包里的 Electron(ELECTRON_RUN_AS_NODE),原生依赖是 Electron ABI 的那份。
 *
 * 做法:把当前 dist 打成「比自带高一个补丁号」的热更新包,解到临时家目录的 engine/<版本>/,再经 dist/boot/launch.js
 * 起 standalone,看 /health 报的是哪个版本。每条负对照都要退回自带版本并说出原因。
 * 要签名私钥(本机 ~/.forsion-dev/secrets/tangu-engine-signing/key.pem 或 TANGU_ENGINE_SIGNING_KEY);没有就跳过。
 * 要 Node ≥ 22.15(module.registerHooks);桌面安装包自带的是 Node 24。
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import * as nodeModule from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // 打包脚本与被打的 dist 都取本仓这份
const root = path.resolve(arg('--root') || source)
const exe = arg('--exe') ? path.resolve(arg('--exe')) : process.execPath
const runAsNode = arg('--exe') ? { ELECTRON_RUN_AS_NODE: '1' } : {}
const launch = path.join(root, 'dist', 'boot', 'launch.js')
const localKey = path.join(os.homedir(), '.forsion-dev', 'secrets', 'tangu-engine-signing', 'key.pem')
if (!existsSync(launch)) { console.error(`${launch} is missing; run \`npm run build\` first.`); process.exit(1) }
if (!arg('--exe') && typeof nodeModule.registerHooks !== 'function') { console.error(`Node ${process.versions.node} has no module.registerHooks (need ≥ 22.15).`); process.exit(1) }
if (!process.env.TANGU_ENGINE_SIGNING_KEY?.trim() && !existsSync(localKey)) {
  console.log('::warning::Engine hot-update end-to-end check SKIPPED: no signing key here (TANGU_ENGINE_SIGNING_KEY). The launcher only accepts packages signed with the release key.')
  process.exit(0)
}

const bundled = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const [major, minor, patch] = bundled.split('.').map(Number)
const next = `${major}.${minor}.${patch + 1}`
const tmp = mkdtempSync(path.join(os.tmpdir(), 'engine-overlay-e2e-'))
const tanguHome = path.join(tmp, 'tangu') // 目录名叫 tangu → 共享域 = tmp,新版放 tmp/engine/
const engineRoot = path.join(tmp, 'engine')
let failed = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed++
}

/** 签好名的包的暂存目录(= 解到用户目录后的样子)。 */
function pack(version, minDesktop) {
  const out = path.join(tmp, `pack-${version}-${minDesktop}`)
  execFileSync(process.execPath, [path.join(source, 'scripts', 'pack-engine.mjs'), '--stage-only', '--version', version, '--min-desktop', minDesktop, '--out', out], { stdio: ['ignore', 'ignore', 'inherit'] })
  return path.join(out, 'package')
}
function install(stage, version) {
  const dir = path.join(engineRoot, version)
  rmSync(dir, { recursive: true, force: true })
  cpSync(stage, dir, { recursive: true })
  return dir
}
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  srv.on('error', reject)
})

/** 起一次 standalone,等 /health;返回它报的版本与全部输出。 */
async function boot(extraEnv = {}) {
  const port = await freePort()
  const env = { ...process.env, TANGU_HOME: tanguHome, TANGU_TOKEN: 'e2e', TANGU_LOCAL_TOKEN: 'e2e-local', TANGU_PLUGINS: 'off', ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, runAsNode)
  const child = spawn(exe, [launch, 'standalone', '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(tanguHome, 'state.db'), '--sandbox', 'none'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  let version = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) { version = (await r.json()).version; break }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  return { version, output }
}

try {
  console.log(`bundled ${bundled} → update ${next}   (home: ${tmp})`)
  const stage = pack(next, bundled)
  // 干扰项:新版目录上层的野 node_modules。引擎的第一批 import 里就有 express,解析被它劫走的话直接起不来。
  mkdirSync(path.join(tmp, 'node_modules', 'express'), { recursive: true })
  writeFileSync(path.join(tmp, 'node_modules', 'express', 'package.json'), '{"name":"express","version":"0.0.0","main":"index.js"}')
  writeFileSync(path.join(tmp, 'node_modules', 'express', 'index.js'), 'throw new Error("stray node_modules/express was loaded")')

  const none = await boot()
  check(none.version === bundled, `没有新版 → 跑自带的 ${bundled}`, `got ${none.version}\n${none.output.slice(-600)}`)

  const dir = install(stage, next)
  const good = await boot()
  check(good.version === next && good.output.includes(`[engine-overlay] running ${next}`), `放进签好名的 ${next} → 跑新版(上层野 node_modules 不干扰)`, `got ${good.version}\n${good.output.slice(-800)}`)

  const tui = spawn(exe, [launch, 'tui', 'plugins'], { env: { ...process.env, TANGU_HOME: tanguHome, TANGU_PLUGINS: 'off', TANGU_ENGINE_OVERLAY: 'verbose', ...runAsNode }, stdio: ['ignore', 'pipe', 'pipe'] })
  let tuiOut = ''
  tui.stdout.on('data', (d) => { tuiOut += d })
  tui.stderr.on('data', (d) => { tuiOut += d })
  const tuiCode = await new Promise((resolve) => tui.on('exit', resolve))
  check(tuiCode === 0 && tuiOut.includes(`[engine-overlay] running ${next}`), `终端入口(tangu plugins)也跑新版`, `exit ${tuiCode}\n${tuiOut.slice(-600)}`)

  const off = await boot({ TANGU_ENGINE_OVERLAY: 'off' })
  check(off.version === bundled, 'TANGU_ENGINE_OVERLAY=off → 跑自带的', `got ${off.version}`)

  // —— 负对照:每条都必须退回自带版本,并说出原因 ——
  const main = path.join(dir, 'dist', 'standalone', 'main.js')
  const original = readFileSync(main)
  appendFileSync(main, '\n// tampered\n')
  const tampered = await boot()
  check(tampered.version === bundled && /skipped \(signature\).*does not match its signed hash/.test(tampered.output), '改了新版里一个文件 → 退回自带的(签名)', `got ${tampered.version}\n${tampered.output.slice(-600)}`)
  writeFileSync(main, original)

  writeFileSync(path.join(dir, 'dist', 'extra.js'), 'export {}\n')
  const extra = await boot()
  check(extra.version === bundled && /skipped \(signature\).*dist\/extra\.js is not covered/.test(extra.output), '新版目录里多了一个没签过的文件 → 退回自带的', `got ${extra.version}\n${extra.output.slice(-600)}`)
  rmSync(path.join(dir, 'dist', 'extra.js'))

  const restored = await boot()
  check(restored.version === next, '恢复原样后又跑新版(上面两条不是别的原因造成的)', `got ${restored.version}\n${restored.output.slice(-600)}`)

  writeFileSync(path.join(engineRoot, 'bad.json'), JSON.stringify({ [next]: 'e2e' }))
  const bad = await boot()
  check(bad.version === bundled, '记成坏版本 → 跑自带的', `got ${bad.version}`)
  rmSync(path.join(engineRoot, 'bad.json'))

  install(pack(next, `${major + 1}.0.0`), next)
  const tooNew = await boot()
  check(tooNew.version === bundled && /skipped \(host\)/.test(tooNew.output), `新版要求更高的壳版本 → 退回自带的`, `got ${tooNew.version}\n${tooNew.output.slice(-600)}`)

  // 依赖清单不同:签名是对的,但这份安装包的 node_modules 不是它要的那套。
  const depsDir = path.join(tmp, 'deps-stage')
  cpSync(stage, depsDir, { recursive: true })
  const pkg = JSON.parse(readFileSync(path.join(depsDir, 'package.json'), 'utf8'))
  pkg.dependencies = { ...pkg.dependencies, 'left-pad': '^1.3.0' }
  writeFileSync(path.join(depsDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  rmSync(path.join(engineRoot, next), { recursive: true, force: true })
  cpSync(depsDir, path.join(engineRoot, next), { recursive: true })
  const deps = await boot()
  check(deps.version === bundled && /skipped \(deps\)/.test(deps.output), '新版的依赖清单与自带的不同 → 退回自带的', `got ${deps.version}\n${deps.output.slice(-600)}`)
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) // Windows 上刚退出的进程还占着文件
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
