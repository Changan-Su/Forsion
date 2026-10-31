/**
 * 插件卸载残留检查:真 standalone 引擎 × 真 Electron × 隔离 home。夹具插件带规则、设置、数据、内嵌引擎插件,用一下,
 * 从设置页卸掉,再按夹具 id 扫一遍家目录、引擎规则、localStorage:扫到的要么在 LEFT_ON_PURPOSE 里写明原因,要么算残留。
 * 其后走:回收站恢复 / 卸载后重装(不留设置、留设置)/ 停用状态下卸载 / 引擎不在时卸载并重启。
 * 云端插件数据要 Extend 的 cloudFetch,这里没有,由 pluginDataSync.test.ts 管。商店重装打开停用的那半由 marketPostInstall.test.ts 管。
 *
 * 先 build 两边:cd ../tangu-agent && npm run build && cd ../desktop && npx electron-vite build
 * node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="插件卸载残留" --eta=4 -- npm run check:uninstall-residue
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.resolve(ROOT, '../tangu-agent/dist/standalone/main.js')
const ID = 'residue-fixture', ENGINE_ID = 'residue-engine', TOKEN = 'residue-token'
const RULE = `plugin:${ID}:watch`
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-residue-'))
// home = Forsion 根(插件、插件数据);engineHome = 引擎 home,与产品一样在根下的 tangu/(回收站、规则、引擎设置都在这)
const home = path.join(temp, 'home'), engineHome = path.join(home, 'tangu'), vault = path.join(temp, 'vault'), userData = path.join(temp, 'userdata')
const pluginDir = path.join(home, 'plugins', ID)
const dataFile = path.join(home, 'plugins-data', `${ID}.json`)
let failed = 0
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return true; await pause(100) }
  return false
}

/** 卸载后还允许出现的东西,写明为什么留。其余一律算残留。 */
const LEFT_ON_PURPOSE = [
  [/^home:.*plugins-ext-tombstones\.json$/, '扩展名墓碑:库里数据文件还在,掉回笔记 = 毁档'],
  [/^home:config-backup\//, '引擎 config.json 的通用写前备份(上一次写盘前那份),下一次写配置就换掉,不是卸载该管的'],
  [/^ls:amadeus\.plugins\.bundleEngineOwed$/, '父插件停用时欠内嵌引擎插件的「开」:恢复后再打开要靠它补开,重装时对齐一轮自己销账'],
  [/^ls:amadeus\.plugins\.disabled$/, '停用状态下卸载:恢复要原样;从商店重装时打开(marketPostInstall)'],
  [/^(rule:|home:tangu\/agents\/muse\/(triggers|db-cursors)\.json$)/, '规则停用但不删:删了会丢用户「单独暂停」的标记,恢复 / 重装后开不回原状'],
]

function writeFixture() {
  const engineDir = path.join(pluginDir, 'tangu-plugins', ENGINE_ID)
  fs.mkdirSync(path.join(engineDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: ID, name: 'Residue Fixture', version: '1.0.0', minAppVersion: '0.0.1', description: 'plugin-uninstall-residue.check 的夹具,不是产品插件', fileExtensions: ['.rfx'] }, null, 2))
  fs.writeFileSync(path.join(pluginDir, 'main.js'), `
    localStorage.setItem('plugin.${ID}.mode', 'on')
    void ctx.saveData({ uses: 1 })
    ctx.registerCommand({ id: '${ID}-hello', title: 'Residue hello', run() {} })
    void ctx.automation?.ensure([{ key: 'watch', desc: 'Residue fixture rule', cond_type: 'db_changed', path: 'rfx.db', event: 'row_added', actions: [{ type: 'notify', title: 'Residue fired' }] }])
  `)
  fs.writeFileSync(path.join(engineDir, 'tangu-plugin.json'), JSON.stringify({ id: ENGINE_ID, name: ENGINE_ID, version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' }))
  fs.writeFileSync(path.join(engineDir, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(engineDir, 'dist', 'index.js'), `export default { activate(ctx) { ctx.registerPlugin(${JSON.stringify({ id: ENGINE_ID, name: 'Residue engine', description: 'Fixture', settings: { fields: [{ key: 'apiKey', type: 'text', secret: true, label: 'Key' }] } })}) } }\n`)
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
let engine = null, url = ''
async function startEngine() {
  const port = url ? Number(new URL(url).port) : await freePort()
  url = `http://127.0.0.1:${port}`
  engine = spawn(process.execPath, [ENGINE, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'), '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN],
    { env: { ...process.env, TANGU_HOME: engineHome, TANGU_DEFAULT_WORKSPACE: path.join(temp, 'workspace'), FORSION_AMADEUS_VAULT: vault, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' }, stdio: ['ignore', 'ignore', fs.openSync(path.join(temp, 'engine.log'), 'a')] })
  if (!await waitFor(() => fetch(`${url}/agent/plugins`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.ok), 30000)) throw new Error(`引擎没起来,见 ${path.join(temp, 'engine.log')}`)
}
async function stopEngine() {
  if (!engine) return
  const exited = new Promise((r) => engine.once('exit', r))
  engine.kill('SIGKILL')
  await exited
  engine = null
}
const api = (p, init) => fetch(`${url}${p}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }).then((r) => r.json())
const rule = async () => (await api('/agent/special/muse/triggers')).triggers.find((t) => t.id === RULE)
const enginePlugin = async () => (await api('/agent/plugins')).plugins.find((p) => p.id === ENGINE_ID)

async function launch() {
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
  const main = await app.firstWindow()
  await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
  await skipOnboarding(main)
  return { app, main }
}

async function openPlugins(app, main) {
  await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins' } }))
  let fl
  await waitFor(async () => { fl = app.windows().find((p) => p.url().includes('window=floating')); return !!fl })
  if (!fl) throw new Error('设置浮窗没开')
  await fl.locator('.settings-nav-subitem', { hasText: '已安装插件' }).click()
  await fl.waitForSelector(`[data-plugin-id="${ID}"]`, { timeout: 30000 })
  return fl
}

/** 走真实的卸载按钮;checks 是确认框里要勾的项(data-un-row)。 */
async function uninstall(fl, checks = []) {
  await fl.locator(`[data-plugin-id="${ID}"]`).click()
  await fl.waitForSelector(`[data-plugin-detail="${ID}"]`, { timeout: 10000 })
  await fl.locator(`[data-plugin-detail="${ID}"] button`, { hasText: '卸载' }).first().click()
  const dlg = fl.locator('[data-uninstall-dialog] .un-dlg')
  await dlg.waitFor({ timeout: 8000 })
  for (const key of checks) await dlg.locator(`[data-un-row="${key}"] input[type="checkbox"]`).check()
  await dlg.locator('.dialog-btn[data-danger]').click()
}

async function restoreFromTrash(fl) {
  await fl.locator('.settings-nav').getByRole('button', { name: '回收站', exact: true }).first().click()
  const row = fl.locator('[data-trash-entry]').filter({ hasText: 'Residue Fixture' }).first()
  if (!await row.waitFor({ timeout: 8000 }).then(() => true, () => false)) return false
  await row.getByRole('button', { name: '恢复', exact: true }).click()
  return true
}

const walk = (dir, out = []) => {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['trash', 'node_modules'].includes(e.name)) walk(p, out) } else if (!e.name.startsWith('state.db')) out.push(p)
  }
  return out
}
const lsDump = (win) => win.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))

/** 按夹具 id 全面扫一遍。tag 形如 `home:<相对路径>` / `rule:<id>` / `ls:<键>`。 */
async function scan(win) {
  const tags = []
  const needle = (s) => s.includes(ID) || s.includes(ENGINE_ID)
  for (const f of walk(home)) {
    const rel = path.relative(home, f)
    let hit = needle(rel)
    if (!hit && fs.statSync(f).size < 2_000_000) hit = needle(fs.readFileSync(f, 'utf8'))
    if (hit) tags.push(`home:${rel}`)
  }
  for (const t of (await api('/agent/special/muse/triggers')).triggers) if (needle(t.id)) tags.push(`rule:${t.id}:${t.enabled ? 'on' : 'off'}`)
  for (const [k, v] of Object.entries(await lsDump(win))) if (needle(k) || needle(v || '')) tags.push(`ls:${k}`)
  return tags
}
const leftovers = (tags) => tags.filter((t) => !LEFT_ON_PURPOSE.some(([re]) => re.test(t)))

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(ENGINE)) throw new Error('先 build tangu-agent 与 desktop')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true })
  fs.mkdirSync(engineHome, { recursive: true })
  fs.writeFileSync(path.join(vault, 'rfx.db'), JSON.stringify({ version: 1, name: 'rfx', columns: [{ id: 'title', name: 'Title', type: 'title' }], rows: [] }))
  writeFixture()
  await startEngine()
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: url, token: TOKEN }))

  let { app, main: win } = await launch()
  try {
    // ── 基线:扫描器得先看得见每一类东西,否则后面「扫不到」说明不了什么
    check('基线:规则开着', await waitFor(async () => (await rule())?.enabled === true, 20000))
    check('基线:数据文件在', await waitFor(async () => fs.existsSync(dataFile)))
    await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`, { method: 'PUT', body: JSON.stringify({ patch: { apiKey: 'sk-residue' } }) })
    await win.evaluate((id) => { localStorage.setItem(`forsion.pluginSync.off.${id}`, '1'); localStorage.setItem(`forsion.pluginSync.${id}`, JSON.stringify({ v: 3, gen: 2, owner: 'u1' })) }, ID)
    const before = await scan(win)
    console.log(`  基线扫到 ${before.length} 项:${before.join(' , ')}`)
    check('基线:引擎插件设置看得见', JSON.stringify(await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`)).includes('sk-residue'))
    check('基线:内嵌引擎插件开着', (await enginePlugin())?.enabled === true, JSON.stringify(await enginePlugin()))
    check('基线:localStorage 看得见', before.includes(`ls:plugin.${ID}.mode`) && before.includes(`ls:forsion.pluginSync.${ID}`))

    // ── ① 卸载(不留设置)
    let fl = await openPlugins(app, win)
    await uninstall(fl)
    check('① 文件进回收站', await waitFor(async () => !fs.existsSync(pluginDir) && fs.readdirSync(path.join(engineHome, 'trash')).length >= 1))
    check('① 规则停了', await waitFor(async () => (await rule())?.enabled === false))
    check('① 内嵌引擎插件撤了', await waitFor(async () => !(await enginePlugin())))
    await pause(800)
    let tags = await scan(win)
    const left = leftovers(tags)
    console.log(`  卸载后扫到:${tags.join(' , ') || '(无)'}`)
    check('① 除写明的之外没有残留', left.length === 0, left.join(' , '))
    check('① 引擎插件设置(含密钥)不留在原处', !walk(home).some((f) => !f.includes('config-backup') && fs.statSync(f).size < 2_000_000 && fs.readFileSync(f, 'utf8').includes('sk-residue')))

    // ── ② 撤销(恢复):和卸载前一样
    check('② 回收站页列出它', await restoreFromTrash(fl))
    check('② 撤销后:规则开着', await waitFor(async () => fs.existsSync(pluginDir) && (await rule())?.enabled === true, 20000))
    check('② 撤销后:内嵌引擎插件开着', await waitFor(async () => (await enginePlugin())?.enabled === true, 20000), JSON.stringify(await enginePlugin()))
    check('② 撤销后:引擎插件设置回来', await waitFor(async () => JSON.stringify(await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`)).includes('sk-residue')))
    check('② 撤销后:数据文件回来', fs.existsSync(dataFile))
    check('② 撤销后:偏好与同步状态回来', await waitFor(async () => { const ls = await lsDump(win); return ls[`plugin.${ID}.mode`] === 'on' && ls[`forsion.pluginSync.off.${ID}`] === '1' && JSON.parse(ls[`forsion.pluginSync.${ID}`] || '{}').owner === 'u1' }))
    check('② 撤销后:回收站没这一条', (await api('/agent/trash')).entries.every((e) => e.ref !== ID))
    await fl.close().catch(() => {})

    // ── ③ 卸载后重装(新装一份,不是恢复;引擎一直跑着,和商店重装一样重扫):内嵌引擎插件不能卡在卸载时写下的「关」
    fl = await openPlugins(app, win)
    await uninstall(fl)
    await waitFor(async () => !fs.existsSync(pluginDir))
    await waitFor(async () => !(await enginePlugin()))
    writeFixture()
    await api('/agent/plugins/rescan', { method: 'POST' })
    await fl.close().catch(() => {})
    await app.close().catch(() => {})
    ;({ app, main: win } = await launch())
    check('③ 重装后:规则开着', await waitFor(async () => (await rule())?.enabled === true, 20000))
    check('③ 重装后:内嵌引擎插件开着', await waitFor(async () => (await enginePlugin())?.enabled === true, 20000), JSON.stringify(await enginePlugin()))
    check('③ 重装后:设置是空的(上一轮没留)', !JSON.stringify(await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`)).includes('sk-residue'))

    // ── ③b 勾「保留设置」卸载再重装:设置还在、内嵌引擎插件开着
    await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`, { method: 'PUT', body: JSON.stringify({ patch: { apiKey: 'sk-kept' } }) })
    fl = await openPlugins(app, win)
    await uninstall(fl, ['keepSettings'])
    await waitFor(async () => !fs.existsSync(pluginDir))
    check('③b 数据文件留着', fs.existsSync(dataFile))
    await waitFor(async () => !(await enginePlugin()))
    writeFixture()
    await api('/agent/plugins/rescan', { method: 'POST' })
    check('③b 重装后:内嵌引擎插件开着、设置还在', await waitFor(async () => (await enginePlugin())?.enabled === true && JSON.stringify(await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`)).includes('sk-kept'), 20000))
    await fl.close().catch(() => {})
    await app.close().catch(() => {})
    ;({ app, main: win } = await launch())
    await waitFor(async () => (await rule())?.enabled === true, 20000)

    // ── ③d 勾「保留设置」卸载再恢复:内嵌引擎插件要被重新发现
    fl = await openPlugins(app, win)
    await uninstall(fl, ['keepSettings'])
    check('③d 卸载后内嵌引擎插件撤了', await waitFor(async () => !fs.existsSync(pluginDir) && !(await enginePlugin()), 20000))
    await restoreFromTrash(fl)
    check('③d 恢复后内嵌引擎插件开着、设置还在', await waitFor(async () => (await enginePlugin())?.enabled === true && JSON.stringify(await api(`/agent/plugins/${ENGINE_ID}/settings?scope=global`)).includes('sk-kept'), 20000))
    await fl.close().catch(() => {})

    // ── ③c 停用状态下卸载:规则本来就停着;停用记录留着,恢复后仍是停用
    fl = await openPlugins(app, win)
    await fl.locator(`[data-plugin-id="${ID}"] [data-plugin-switch]`).click()
    check('③c 停用后规则停了', await waitFor(async () => (await rule())?.enabled === false))
    await uninstall(fl)
    await waitFor(async () => !fs.existsSync(pluginDir))
    const off = await scan(win)
    check('③c 卸载后只留写明的', leftovers(off).length === 0, leftovers(off).join(' , '))
    await restoreFromTrash(fl)
    check('③c 恢复后插件回来但仍是停用,规则不开', await waitFor(async () => fs.existsSync(pluginDir)) && await pause(1500).then(async () => (await rule())?.enabled === false))
    await fl.close().catch(() => {})
    await win.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('amadeus.plugins.disabled') || '[]').filter((x) => x !== 'residue-fixture')
      localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(list))
    })
    await app.close().catch(() => {})
    ;({ app, main: win } = await launch())
    check('③c 重新开着后规则开回来', await waitFor(async () => (await rule())?.enabled === true, 20000))

    // ── ④ 引擎不在时卸载,关掉 App 再一起起来:规则不能永远开着
    fl = await openPlugins(app, win)
    await stopEngine()
    await uninstall(fl)
    check('④ 引擎不在也卸得掉', await waitFor(async () => !fs.existsSync(pluginDir), 30000))
    await pause(1000)
    await fl.close().catch(() => {})
    await app.close().catch(() => {})
    await startEngine()
    check('④ 引擎回来时规则还开着(前提)', (await rule())?.enabled === true)
    ;({ app, main: win } = await launch())
    check('④ 下次启动后规则停了', await waitFor(async () => (await rule())?.enabled === false, 30000))
  } finally {
    await app.close().catch(() => {})
    await stopEngine().catch(() => {})
    if (failed) console.log(`隔离目录留着:${temp}`)
    else fs.rmSync(temp, { recursive: true, force: true })
  }
  console.log(failed ? `\n${failed} 项没过` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); stopEngine().finally(() => process.exit(2)) })
