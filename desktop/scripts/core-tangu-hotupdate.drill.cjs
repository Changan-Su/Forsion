#!/usr/bin/env node
/**
 * 界面热更新 4d 演练(施工图 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §7 第 4 步):
 * 打包形态的 N → 落位 N+1 → 重启后两半(引擎 /health、界面 data-core-tangu)都是 N+1;四个负对照(签名坏、forDesktop 对不上、
 * 依赖变了、界面激活就抛)界面都停在 N、对话照常能用;另用老桌面自己的判定代码核对它们不收新包。
 *
 * 「打包形态的 N」= 一份已装好的 Forsion.app 的隔离副本:只借它的 Electron、原生依赖、随包 node / python / 插件,
 * 换上本检出的 desktop/out 与 tangu-agent 的 dist / ui / skills / package.json(依赖清单必须和那份安装包一致,原生依赖用它的)。
 * app.isPackaged、resources 路径、hardenNav、启动器、更新器落位目录、验签用的钉死公钥都是打包版的真路径;
 * 家目录 / userData / appData 全在临时目录,真模型 GPT 6 Luna(软链 ~/.forsion-dev/provider-auth.json 的订阅登录)。
 *
 *   npm run drill:coretangu -- --app /Applications/Forsion.app/Contents/MacOS/Forsion [--only base,good,sig,fordesktop,deps,throws,old] [--out <目录>]
 *
 * 先:本检出 tangu-agent 的 npm run build、desktop 的 npm run build(含 build-tangu-ui)。N+1 用 pack-engine 的签名私钥签
 * (TANGU_ENGINE_SIGNING_KEY 或 ~/.forsion-dev/secrets/tangu-engine-signing/key.pem)—— 只有钉死的那把签的包过得了打包版的验签。
 * 包只落在临时目录,不发 npm。报告 + 截图 + 日志写进 --out(缺省 desktop/outputs/core-tangu-drill/)。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const asar = require('@electron/asar')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const DESKTOP = path.resolve(__dirname, '..')
const GENESIS = path.resolve(DESKTOP, '..')
const ENGINE_SRC = path.join(GENESIS, 'tangu-agent')
const sourceExecutable = option('--app') || '/Applications/Forsion.app/Contents/MacOS/Forsion'
const only = (option('--only') || 'base,good,sig,fordesktop,deps,throws,old').split(',')
const out = path.resolve(option('--out') || path.join(DESKTOP, 'outputs', 'core-tangu-drill'))
const AUTH = path.resolve(process.env.TANGU_LIVE_AUTH || path.join(os.homedir(), '.forsion-dev', 'provider-auth.json'))
const MODEL = option('--model') || 'codex/gpt-6-luna'
if (process.platform !== 'darwin') throw new Error('the drill clones an installed macOS app')
for (const [file, hint] of [[sourceExecutable, '--app <installed executable>'], [path.join(DESKTOP, 'out/main/main.js'), 'desktop: npm run build'], [path.join(ENGINE_SRC, 'dist/boot/launch.js'), 'tangu-agent: npm run build'], [path.join(ENGINE_SRC, 'ui/main.js'), 'desktop: node scripts/build-tangu-ui.mjs'], [AUTH, 'the subscription login at ~/.forsion-dev/provider-auth.json']]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file} (${hint})`)
}
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-core-tangu-drill-')))
const home = path.join(temp, 'forsion'), userData = path.join(temp, 'userdata'), profile = path.join(temp, 'profile'), appData = path.join(temp, 'appdata'), vault = path.join(temp, 'vault')
for (const dir of [home, userData, profile, appData, vault]) fs.mkdirSync(dir, { recursive: true })
const engineRoot = path.join(home, 'engine')
const report = { app: sourceExecutable, model: MODEL, scenarios: [], old: [] }
const logs = []
const results = []
const check = (scenario, name, ok, detail = '') => {
  results.push({ scenario, name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? '  | ' + detail : ''}`)
}

// ── 1. 打包形态的 N:装好的 .app 副本 + 本检出的代码 ──
const sourceApp = path.resolve(sourceExecutable, '../../..')
const copy = path.join(temp, 'ForsionDrill.app')
execFileSync('cp', ['-cR', sourceApp, copy])
const resources = path.join(copy, 'Contents', 'Resources'), appDir = path.join(resources, 'app'), server = path.join(resources, 'tangu-server')
asar.extractAll(path.join(resources, 'app.asar'), appDir)
fs.rmSync(path.join(resources, 'app.asar'))
const appPackage = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const installedDeps = JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8')).dependencies
const enginePkg = JSON.parse(fs.readFileSync(path.join(ENGINE_SRC, 'package.json'), 'utf8'))
if (JSON.stringify(installedDeps) !== JSON.stringify(enginePkg.dependencies)) throw new Error('the installed app bundles different engine dependencies than this checkout; its node_modules cannot run this engine')
fs.rmSync(path.join(appDir, 'out'), { recursive: true })
fs.cpSync(path.join(DESKTOP, 'out'), path.join(appDir, 'out'), { recursive: true })
for (const name of ['dist', 'ui', 'skills', 'agent-skills', 'package.json']) {
  fs.rmSync(path.join(server, name), { recursive: true, force: true })
  fs.cpSync(path.join(ENGINE_SRC, name), path.join(server, name), { recursive: true, filter: (f) => !f.endsWith('.map') && !f.endsWith('.d.ts') })
}
// 主进程最前面改 home / appData(打包版 Electron 不认 -r 预加载;同 engine-update.live.check.cjs)
const mainFile = path.resolve(appDir, appPackage.main)
fs.writeFileSync(mainFile, `import { app as __drillApp } from 'electron';\n__drillApp.setPath('home', ${JSON.stringify(profile)});\n__drillApp.setPath('appData', ${JSON.stringify(appData)});\n` + fs.readFileSync(mainFile, 'utf8'))
const executablePath = path.join(copy, 'Contents', 'MacOS', path.basename(sourceExecutable))
const desktopVersion = appPackage.version
const hostVersion = JSON.parse(fs.readFileSync(path.join(server, 'desktop-host.json'), 'utf8')).version
const N = enginePkg.version
const [ma, mi, pa] = N.split('.').map(Number)
const N1 = `${ma}.${mi}.${pa + 1}`
report.versions = { desktop: desktopVersion, host: hostVersion, bundledEngine: N, update: N1 }
console.log(`desktop ${desktopVersion}(host ${hostVersion}),N = engine ${N},N+1 = ${N1};临时目录 ${temp}`)

fs.symlinkSync(AUTH, path.join(home, 'provider-auth.json'))
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ workspace: path.join(temp, 'workspace'), browser: { enabled: false } }))
fs.writeFileSync(path.join(userData, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', modelId: MODEL, unitHostEnabled: false, computerHistoryEnabled: false, activeWindowEnabled: false, disabledBundles: ['forsion-extend', 'tangu-computer-use'] }))
fs.writeFileSync(path.join(userData, 'amadeus-config.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
// 静默窗口(showInactive + 压到普通窗口之下):Playwright 的预加载在打包版里不生效,自动静默认不出来,必须显式开
const env = { ...process.env, TANGU_HOME: path.join(home, 'tangu'), TANGU_PLUGINS: 'off', TANGU_ENGINE_OVERLAY: 'verbose', TANGU_HARNESS_QUIET: '1' }
for (const k of ['ELECTRON_RUN_AS_NODE', 'TANGU_BACKEND_URL', 'TANGU_UI']) delete env[k]

// ── 2. N+1 的几种包(pack-engine 真签名;只改各自那一处)──
function makePackage(name, { forDesktop = desktopVersion, minDesktop = hostVersion, deps, ui } = {}) {
  const root = path.join(temp, `src-${name}`)
  fs.mkdirSync(root)
  for (const dir of ['dist', 'skills', 'agent-skills', 'ui']) fs.cpSync(path.join(ENGINE_SRC, dir), path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...enginePkg, dependencies: deps ?? enginePkg.dependencies }, null, 2))
  if (ui) fs.writeFileSync(path.join(root, 'ui', 'main.js'), ui(fs.readFileSync(path.join(root, 'ui', 'main.js'), 'utf8')))
  const dest = path.join(temp, `pack-${name}`)
  execFileSync(process.execPath, [path.join(ENGINE_SRC, 'scripts', 'pack-engine.mjs'), '--root', root, '--stage-only', '--version', N1, '--min-desktop', minDesktop, '--for-desktop', forDesktop, '--out', dest], { stdio: ['ignore', 'ignore', 'inherit'] })
  return path.join(dest, 'package')
}
const STRICT = '"use strict";'
const marked = (code) => { if (!code.startsWith(STRICT)) throw new Error('unexpected bundle head'); return `${STRICT}globalThis.__tanguDrill=${JSON.stringify(N1)};${code.slice(STRICT.length)}` }
const throwing = (code) => {
  const footer = 'return { exports: __tanguUi,'
  if (!code.includes(footer)) throw new Error('unexpected bundle footer')
  return marked(code).replace(footer, 'return { exports: Object.assign({}, __tanguUi, { activateTangu() { throw new Error("drill: activateTangu throws") } }),')
}
function stage(pkg, after) {
  fs.rmSync(path.join(engineRoot, N1), { recursive: true, force: true })
  fs.rmSync(path.join(engineRoot, 'bad.json'), { force: true })
  if (!pkg) return
  fs.mkdirSync(engineRoot, { recursive: true })
  fs.cpSync(pkg, path.join(engineRoot, N1), { recursive: true })
  after?.(path.join(engineRoot, N1))
}
const readBad = () => { try { return JSON.parse(fs.readFileSync(path.join(engineRoot, 'bad.json'), 'utf8')) } catch { return {} } }

// 前台看门狗:每 0.3 秒看一眼前台 App 的 pid,是演练这份就记下并中止 —— 别抢用户的前台(lsappinfo 不要辅助功能权限)
function frontPid() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim()
    return Number((execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' }).match(/pid\s*=\s*(\d+)/) || [])[1]) || null
  } catch { return null }
}
let stolen = null

// ── 3. 起一次打包版:等引擎就绪,读两半的版本,在 Tangu 里真发一条 ──
async function run(scenario, expect) {
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, '--lang=zh-CN'], env, timeout: 90_000 })
  let text = ''
  app.process().stdout?.on('data', (d) => { text += d })
  app.process().stderr?.on('data', (d) => { text += d })
  const pageErrors = []
  const seen = { core: [] }
  const pid = app.process().pid
  const watchdog = setInterval(() => {
    if (stolen || frontPid() !== pid) return
    stolen = `${scenario}: the drill app became the frontmost app`
    console.error(`[drill] ${stolen}; aborting`)
    app.close().catch(() => {})
  }, 300)
  try {
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), resources: process.resourcesPath }))
    if (!identity.packaged || fs.realpathSync(identity.resources) !== fs.realpathSync(resources)) throw new Error(`not the packaged drill copy: ${JSON.stringify(identity)}`)
    const win = await app.firstWindow({ timeout: 90_000 })
    win.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
    win.on('console', (m) => { const t = m.text(); if (/core-tangu/.test(t)) seen.core.push(t) })
    await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {})
    await win.waitForSelector('#root', { timeout: 90_000 })
    await skipOnboarding(win, 20_000)
    const until = async (fn, ms, arg) => win.waitForFunction(fn, arg, { timeout: ms, polling: 250 }).then(() => true, () => false)
    // 界面那半:激活抛错的那一档会先求值热更新版、失败后被主进程重载成自带的 —— 等到期望的那份
    await until((want) => document.documentElement.dataset.coreTangu === want, 60_000, expect.ui)
    const ui = await win.evaluate(() => ({ core: document.documentElement.dataset.coreTangu || null, marker: globalThis.__tanguDrill ?? null }))
    const ready = await until(async () => (await window.tangu.backendStatus()).state === 'ready', 120_000)
    const status = await win.evaluate(() => window.tangu.backendStatus())
    const health = ready ? await fetch(`${status.url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch((e) => ({ error: String(e) })) : null
    check(scenario, `引擎跑 ${expect.engine}`, health?.version === expect.engine, `/health ${JSON.stringify(health?.version ?? health)}`)
    check(scenario, `界面是 ${expect.ui}`, ui.core === expect.ui && (expect.marker ? ui.marker === N1 : ui.marker === null), JSON.stringify(ui))
    // 对话:进 Tangu Space,新对话里发一句,等到 GPT 6 Luna 的回复
    await win.waitForSelector('.dv-groupview', { timeout: 60_000 })
    await win.evaluate(() => [...document.querySelectorAll('button.rb-space')].find((b) => /Agent|Tangu/.test(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || ''))?.click())
    let composer = win.locator('.t2c-ta').first()
    if (!(await composer.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
      await win.getByRole('button', { name: /^(新对话|New chat)$/ }).first().click().catch(() => {})
      composer = win.locator('.t2c-ta').first()
    }
    const said = `演练 ${scenario}:请只回复「收到」两个字`
    let reply = ''
    if (await composer.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      await composer.click()
      await composer.fill(said)
      await composer.press('Enter')
      await until((t) => [...document.querySelectorAll('.t2-user')].some((el) => el.textContent.includes(t)), 20_000, said)
      await until(() => [...document.querySelectorAll('.t2-asst')].some((el) => /收到/.test(el.textContent || '')), 120_000)
      reply = await win.evaluate(() => [...document.querySelectorAll('.t2-asst')].map((el) => el.textContent.trim()).filter(Boolean).pop() || '')
    }
    check(scenario, '对话能用:发出的话出现、模型回了「收到」', /收到/.test(reply), `回复 ${JSON.stringify(reply.slice(0, 80))}`)
    const fatal = pageErrors.filter((e) => !/drill: activateTangu throws/.test(e))
    check(scenario, '没有别的 pageerror', fatal.length === 0, fatal[0] || '')
    await win.screenshot({ path: path.join(out, `${scenario}.png`) })
    const r = { scenario, expect, ui, engine: health?.version, reply: reply.slice(0, 200), coreLogs: seen.core, overlayLog: text.split('\n').filter((l) => /engine-overlay|core-tangu|engine-updates/.test(l)).slice(-12), bad: readBad() }
    report.scenarios.push(r)
    return r
  } finally {
    clearInterval(watchdog)
    await app.close().catch(() => {})
    logs.push(`===== ${scenario} =====\n${text}`)
    if (stolen) throw new Error(stolen)
  }
}

// ── 4. 老桌面:用它们自己的判定代码看新包 ──
async function oldDesktops(pkgFor) {
  // a) 已装的这份(4b 之前,不读界面半身):壳版本读 desktop-host.json
  const installed = await import(pathToFileURL(path.join(sourceApp, 'Contents', 'Resources', 'tangu-server', 'dist', 'boot', 'overlay.js')).href)
  const installedRoot = path.join(sourceApp, 'Contents', 'Resources', 'tangu-server')
  // b) v2.13.7:从 tag 取 overlay.ts 现编;它的安装包没有 desktop-host.json,壳版本回退成自带引擎版本(2.13.8)
  const src = path.join(temp, 'v2.13.7')
  fs.mkdirSync(src)
  execFileSync('sh', ['-c', `git -C "${GENESIS}" archive v2.13.7 tangu-agent/src/boot tangu-agent/src/contracts | tar -x -C "${src}"`])
  const { build } = require('esbuild')
  const bundle = path.join(src, 'overlay-2.13.7.mjs')
  await build({ entryPoints: [path.join(src, 'tangu-agent/src/boot/overlay.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
  const v2137 = await import(pathToFileURL(bundle).href)
  const root2137 = path.join(src, 'bundled')
  fs.mkdirSync(root2137)
  fs.writeFileSync(path.join(root2137, 'package.json'), execFileSync('git', ['-C', GENESIS, 'show', 'v2.13.7:tangu-agent/package.json']))
  for (const [label, api, root] of [[`已装的 ${hostVersion}(4b 之前)`, installed, installedRoot], ['v2.13.7', v2137, root2137]]) {
    for (const minDesktop of ['2.13.8', '2.13.9']) {
      const v = api.checkOverlay(pkgFor(minDesktop), root)
      report.old.push({ desktop: label, minDesktop, verdict: v })
      check('old', `${label} 看 minDesktop ${minDesktop} 的新包:不收`, !v.ok, v.ok ? 'ACCEPTED' : `${v.code}: ${v.reason}`)
    }
  }
  const update = execFileSync('git', ['-C', GENESIS, 'show', 'v2.13.7:desktop/electron/engineUpdates.ts'], { encoding: 'utf8' })
  check('old', 'v2.13.7 的更新器只读 latest(新包发在 desktop-<基准> 线上,latest 不动)', !/engineLineTag|dist-tags\[/.test(update) && /resolveLatest/.test(update))
}

;(async () => {
  const pkgs = {}
  const pkg = (name, o) => (pkgs[name] ??= makePackage(name, o))
  try {
    if (only.includes('base')) { stage(null); await run('base', { engine: N, ui: `bundled ${N}` }) }
    if (only.includes('good')) {
      stage(pkg('good', { ui: marked }))
      await run('good', { engine: N1, ui: `overlay ${N1}`, marker: true })
    }
    if (only.includes('sig')) {
      stage(pkg('good', { ui: marked }), (dir) => fs.appendFileSync(path.join(dir, 'ui', 'main.js'), '\n'))
      await run('sig', { engine: N, ui: `bundled ${N}` })
    }
    if (only.includes('fordesktop')) {
      stage(pkg('fordesktop', { ui: marked, forDesktop: '2.13.7' }))
      // 设计如此:引擎照收热更新,界面用自带的(和「只热更了引擎」一样)
      await run('fordesktop', { engine: N1, ui: `bundled ${N}` })
    }
    if (only.includes('deps')) {
      stage(pkg('deps', { ui: marked, deps: { ...enginePkg.dependencies, 'left-pad': '1.3.0' } }))
      await run('deps', { engine: N, ui: `bundled ${N}` })
    }
    if (only.includes('throws')) {
      stage(pkg('throws', { ui: throwing }))
      // 这一次:界面激活就抛 → 主进程整版记坏、重载成自带界面;引擎这次运行里还是它(下次拉起才退)
      const first = await run('throws', { engine: N1, ui: `bundled ${N}` })
      check('throws', `bad.json 记下 ${N1}(原因带 UI:)`, /^UI: /.test(first.bad[N1] || ''), JSON.stringify(first.bad))
      await run('throws-restart', { engine: N, ui: `bundled ${N}` })
    }
    if (only.includes('old')) await oldDesktops((minDesktop) => pkg(`old-${minDesktop}`, { ui: marked, minDesktop }))
  } catch (e) {
    check('drill', 'ran to the end', false, String(e?.stack || e).slice(0, 600))
  } finally {
    check('drill', '演练全程没抢过前台', !stolen, stolen || '')
    const failed = results.filter((r) => !r.ok)
    report.results = results
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    fs.writeFileSync(path.join(out, 'app.log'), logs.join('\n'))
    fs.rmSync(temp, { recursive: true, force: true })
    console.log(`\ncore-tangu drill: ${results.length - failed.length}/${results.length} PASS  报告 ${out}`)
    process.exit(failed.length ? 1 : 0)
  }
})()
