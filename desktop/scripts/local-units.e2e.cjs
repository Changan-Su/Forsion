/**
 * 本机多 Unit 的端到端台架(真 Electron:默认那台 + 它拉起的 / 台架直接起的文件夹 Unit 进程)。
 *
 * 证的是:
 *   1 新建:文件夹里有标记 + home/ app-data/ Forsion/,名册登记在默认那台的 userData 下
 *   2 打开:默认那台拉起的子进程 pid 不同、命令行只带 id;它的 userData / home 落在文件夹里(MCP 发现文件写进 <文件夹>/home)
 *   3 整机资源:**按子进程 pid(含它的整棵子进程树,引擎是孙进程)查它在听的端口**,不去探端口 ——
 *     不含 Clip / 门铃 8791–8794、MCP 固定段 3591–3611、浏览器扩展桥 47654 / 47655 以及本台架钉的扩展口;
 *     先正面确认 lsof 看得到它的 MCP 随机口、引擎确实起来了,免得「什么都没听」也算过
 *   4 再开一次:没有新 pid(新进程把参数交给在跑的那份就退出)
 *   5 默认那台的面板收到 localUnits:changed(另一个进程起来 / 退出时)
 *   6 --forsion-unit-quit 让它正常退出,运行记录随之删掉
 *   7 伪造的 id / 文件夹不在了 / 标记 id 对不上:退出码 3(台架模式下不弹框)、不建任何目录、名册一字不改
 *   8 拷贝出来的文件夹加入 → duplicate_id;搬了家的加入 → 改名册路径
 *
 * 隔离:一切都在一个临时目录里 —— HOME 改指临时目录、默认那台用 --user-data-dir(子进程原样转交)、
 *   默认那台走外部模式连死端口(不起引擎);文件夹 Unit 的引擎照常起(要量它的端口)。窗口一律 TANGU_HARNESS_QUIET=1。
 * 只按自己起的 / 自己临时目录里记下的 pid 结束进程,不按模式杀。不碰用户正在跑的开发版或安装版。
 *
 * ⚠️ 量的是 out/ 里的产物和 ../tangu-agent/dist 里的引擎,源码改了先 `npm run build`(引擎 `cd ../tangu-agent && npm run build`)。
 * 跑:node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="local units" -- npm run e2e:localunits
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const ELECTRON = require('electron')
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-localunits-')))
const FAKE_HOME = path.join(T, 'home-root')
const UD = path.join(T, 'default-ud')
const UD_DEV = `${UD}-dev`
const REGISTRY = path.join(UD_DEV, 'local-units.json')
const PARENT = path.join(T, 'units')
for (const d of [FAKE_HOME, UD_DEV, PARENT]) fs.mkdirSync(d, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms
  let v
  while (Date.now() < end) { v = await Promise.resolve().then(fn).catch(() => undefined); if (v) return v; await sleep(step) }
  return v
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

// 台架自己的环境:去掉这一份的身份与重定向,HOME 指临时目录,窗口静默
const STRIP = /^(TANGU_HOME|FORSION_WORKSPACE_DIR|FORSION_SANDBOX.*|PI_CU_SOCKET_PATH|TANGU_BACKEND_URL|TANGU_BROWSER_EXTENSION.*|FORSION_UNIT.*|FORSION_CLIP_ENTRANCE|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL)$/
const BASE = {}
for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) BASE[k] = v
// 云端地址指死端口:新 Unit 没登录,引擎与 Extend 都不该去连真服务器
Object.assign(BASE, { HOME: FAKE_HOME, TANGU_HARNESS_QUIET: '1', TANGU_CLOUD_URL: 'http://127.0.0.1:1' })

// ── 进程与端口(只读:ps / lsof)──
function processTable() {
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 })
  return out.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }))
}
function tree(root) {
  const rows = processTable()
  const out = [], queue = [root]
  while (queue.length) {
    const p = queue.shift()
    const row = rows.find((r) => r.pid === p)
    if (row) out.push(row)
    for (const r of rows) if (r.ppid === p) queue.push(r.pid)
  }
  return out
}
function listening(pids) {
  if (!pids.length) return []
  let out = ''
  try { out = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }) } catch (e) { out = String(e.stdout || '') } // 没有 = 退出码 1
  return out.split('\n').slice(1).map((l) => { const c = l.trim().split(/\s+/); const m = l.match(/:(\d+) \(LISTEN\)/); return m ? { pid: +c[1], port: +m[1] } : null }).filter(Boolean)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
/** 命令行里带着这个 id 的主进程(Chromium 的子进程带 --type=,不算)。 */
const unitMains = (id) => processTable().filter((r) => r.cmd.includes(`--forsion-unit=${id}`) && !r.cmd.includes('--type=') && !r.cmd.includes('--forsion-unit-quit'))
const runPid = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'app-data', 'local-unit-run.json'), 'utf8')).pid } catch { return null } }
const snapshotDir = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p) } }; try { walk(dir) } catch { /* 没有 */ } return out.sort() }

/** 默认那台自己会写的地方(userData / home / 工作区 / 假家目录):「拒绝不建目录」那项只看别处。 */
const notDefaults = (p) => ![UD_DEV, path.join(T, 'default-home'), path.join(T, 'default-ws'), FAKE_HOME].some((d) => p === d || p.startsWith(d + path.sep))
const FORBIDDEN = new Set([8791, 8792, 8793, 8794, 47654, 47655])
for (let p = 3591; p <= 3611; p++) FORBIDDEN.add(p)

/** 台架直接起一份(= 双击桌面快捷方式那条路),env 自定;回 { child, done } 。 */
function launchDirect(args, env) {
  const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${UD}`, '--lang=zh-CN', ...args, ...electron.MAC_FLAGS], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += b })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
  return { child, done }
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ code: 'timeout' }))])

const ours = new Set() // 台架起的 / 从自己临时目录里读到的 pid:收尾时只结束这些

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const engineEntry = path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
  if (!fs.existsSync(engineEntry)) { console.error('缺 ../tangu-agent/dist —— 先 cd ../tangu-agent && npm run build(否则引擎端口那几项是空测)'); process.exit(1) }
  // 默认那台:外部模式连死端口,不起引擎(要量的是文件夹 Unit 的引擎)
  fs.writeFileSync(path.join(UD_DEV, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: 'http://127.0.0.1:1', token: 'bench' }))
  const dEnv = { ...BASE, TANGU_HOME: path.join(T, 'default-home'), FORSION_WORKSPACE_DIR: path.join(T, 'default-ws'), FORSION_CLIP_ENTRANCE: '0' }
  const app = await electron.launch({ args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: dEnv })
  const dPid = app.process().pid
  ours.add(dPid)
  try {
    const page = await until(async () => {
      for (const p of app.windows()) {
        if (/[?&]window=/.test(p.url())) continue
        if (await p.evaluate(() => !!window.tangu?.localUnits).catch(() => false)) return p
      }
      return undefined
    }, 60000, 500)
    check('默认那台起来,主窗有 window.tangu.localUnits', !!page)
    if (!page) return
    const lu = (fn, ...a) => page.evaluate(([f, args]) => window.tangu.localUnits[f](...args), [fn, a])
    await page.evaluate(() => { window.__luChanged = 0; window.tangu.localUnits.onChanged(() => { window.__luChanged++ }) })

    const snap0 = await lu('list')
    check('list:默认那台、空名册、开发版缺省父目录在(临时)家目录的 .forsion-dev/units 下', snap0.self.kind === 'default' && snap0.registry === 'ok' && snap0.units.length === 0 && snap0.defaultParent === path.join(FAKE_HOME, '.forsion-dev', 'units'), snap0)

    // ── 1 新建 ──
    const made = await lu('create', { name: 'Bench A', icon: '🧪', parentDir: PARENT })
    const A = path.join(PARENT, 'Bench A')
    const idA = made.ok ? made.unit.id : ''
    check('新建 A:ok,文件夹 = 标记 + home / app-data / Forsion', made.ok && fs.readdirSync(A).sort().join(',') === 'Forsion,app-data,forsion-unit.json,home', made)
    const reg1 = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
    check('名册在默认那台的 userData(-dev)下,只记 id + 路径', reg1.units.length === 1 && reg1.units[0].id === idA && reg1.units[0].path === A && Object.keys(reg1.units[0]).sort().join() === 'addedAt,id,path', reg1)
    // 新 Unit 缺省连外部引擎(首启引导里才换托管);台架要量它自己的引擎,先在它的 app-data 里写托管模式
    if (made.ok) fs.writeFileSync(path.join(A, 'app-data', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' }))
    const madeB = await lu('create', { name: 'Bench B', icon: '', parentDir: PARENT })
    const madeC = await lu('create', { name: 'Bench C', icon: '', parentDir: PARENT })
    const idB = madeB.unit?.id, idC = madeC.unit?.id
    check('新建同名 → path_exists', (await lu('create', { name: 'Bench A', icon: '', parentDir: PARENT })).code === 'path_exists')

    // ── 2 打开(默认那台拉起)──
    const changedBefore = await page.evaluate(() => window.__luChanged)
    const opened = await lu('open', idA)
    const p1 = await until(() => runPid(A), 60000)
    if (p1) ours.add(p1)
    const cmd1 = p1 ? (processTable().find((r) => r.pid === p1) || {}).cmd || '' : ''
    check('打开 A:子进程 pid 与默认那台不同,命令行只带 id、不带路径', opened.ok && p1 && p1 !== dPid && alive(p1) && cmd1.includes(`--forsion-unit=${idA}`) && !cmd1.includes(A), { opened, p1, dPid })
    const bridge = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(A, 'home', 'desktop-bridge.json'), 'utf8')) } catch { return undefined } }, 60000)
    const bridgePort = bridge ? Number(new URL(bridge.url).port) : 0
    check('A 的 home / userData 落在文件夹里(MCP 发现文件写进 A/home;app-data 有 Electron 自己的文件)', !!bridge && fs.readdirSync(path.join(A, 'app-data')).length > 1, { bridge: bridge?.url, appData: fs.readdirSync(path.join(A, 'app-data')).slice(0, 8) })
    const t1 = p1 ? tree(p1) : []
    const l1 = listening(t1.map((r) => r.pid))
    check('正面:lsof 按 pid 看得到 A 在听它的 MCP 随机口', bridgePort > 0 && l1.some((x) => x.port === bridgePort), { bridgePort, l1 })
    const bad1 = l1.filter((x) => FORBIDDEN.has(x.port))
    check('A(默认那台拉起的)整棵进程树不听整机固定口(Clip / 门铃 / MCP 3591–3611 / 扩展桥)', bad1.length === 0, { bad: bad1, all: l1 })
    check('默认那台面板收到 localUnits:changed(A 起来了)', await until(async () => (await page.evaluate(() => window.__luChanged)) > changedBefore, 10000), await page.evaluate(() => window.__luChanged))
    const rowA = (await lu('list')).units.find((u) => u.id === idA)
    check('list:A 是 running', rowA?.state === 'running', rowA)

    // ── 4 再开一次 ──
    const again = await lu('open', idA)
    await sleep(5000)
    const mains = unitMains(idA).map((r) => r.pid)
    check('再开一次:ok,没有新 pid(仍只有 A 那一个主进程,运行记录没变)', again.ok && mains.length === 1 && mains[0] === p1 && runPid(A) === p1, { mains, p1 })

    // ── 6 退出请求 ──
    const changedMid = await page.evaluate(() => window.__luChanged)
    const q = launchDirect([`--forsion-unit=${idA}`, '--forsion-unit-quit'], BASE)
    const qr = await within(q.done, 20000)
    const gone = await until(() => !alive(p1), 25000)
    check('--forsion-unit-quit:请求进程很快退出,A 正常退出,运行记录删掉', qr.code === 0 && gone && !fs.existsSync(path.join(A, 'app-data', 'local-unit-run.json')), { quitExit: qr.code, aliveAfter: alive(p1) })
    check('默认那台面板收到 localUnits:changed(A 退出了)', await until(async () => (await page.evaluate(() => window.__luChanged)) > changedMid, 10000))
    const q2 = launchDirect([`--forsion-unit=${idA}`, '--forsion-unit-quit'], BASE)
    const q2r = await within(q2.done, 20000)
    check('没在跑时的 --forsion-unit-quit:什么也不做立刻退出(不留运行记录)', q2r.code === 0 && !fs.existsSync(path.join(A, 'app-data', 'local-unit-run.json')), q2r.code)

    // ── 3 台架直接起(= 桌面快捷方式):不带 Clip 关口开关,钉一个扩展口,量整棵进程树(含引擎) ──
    const extPort = await freePort()
    const direct = launchDirect([`--forsion-unit=${idA}`], { ...BASE, TANGU_BROWSER_EXTENSION_PORT: String(extPort) })
    ours.add(direct.child.pid)
    const p2 = await until(() => (runPid(A) === direct.child.pid ? direct.child.pid : undefined), 60000)
    check('直接起 A:运行记录就是台架起的这个 pid', p2 === direct.child.pid, { run: runPid(A), spawned: direct.child.pid })
    const engine = await until(() => {
      const t = tree(direct.child.pid)
      const eng = t.filter((r) => /tangu-agent[\\/]dist[\\/](standalone[\\/]main|boot[\\/]launch)\.js/.test(r.cmd))
      const l = listening(eng.map((r) => r.pid))
      return l.length ? { pids: eng.map((r) => r.pid), l } : undefined
    }, 120000, 1000)
    check('正面:A 的引擎(孙进程)起来了、在听自己的口', !!engine, engine)
    await sleep(6000) // 引擎就绪后扩展桥若要开也该开了
    const t2 = tree(direct.child.pid)
    const l2 = listening(t2.map((r) => r.pid))
    const forbid2 = new Set([...FORBIDDEN, extPort])
    const bad2 = l2.filter((x) => forbid2.has(x.port))
    check(`直接起的 A 整棵进程树不听整机固定口与钉的扩展口 ${extPort}(Clip 关口开关没设,门铃靠角色门控)`, bad2.length === 0 && l2.length > 0, { bad: bad2, all: l2 })
    const qd = launchDirect([`--forsion-unit=${idA}`, '--forsion-unit-quit'], BASE)
    await within(qd.done, 20000)
    const r2 = await within(direct.done, 25000)
    check('直接起的 A 收到退出请求后退出', r2.code !== 'timeout', r2.code)

    // ── 7 拒绝:不建目录、名册不动 ──
    const regBytes = fs.readFileSync(REGISTRY, 'utf8')
    const before = snapshotDir(T).filter(notDefaults)
    const forged = launchDirect(['--forsion-unit=00000000-0000-4000-8000-0000deadbeef'], BASE)
    ours.add(forged.child.pid)
    const fr = await within(forged.done, 20000)
    check('伪造的 id:退出码 3、说明 not_found', fr.code === 3 && /refused \(not_found\)/.test(fr.stderr), fr)
    fs.renameSync(path.join(PARENT, 'Bench B'), path.join(T, 'moved-B'))
    const missing = launchDirect([`--forsion-unit=${idB}`], BASE)
    ours.add(missing.child.pid)
    const mr = await within(missing.done, 20000)
    check('文件夹不在了:退出码 3、说明 missing、原路径没被建回来', mr.code === 3 && /refused \(missing\)/.test(mr.stderr) && !fs.existsSync(path.join(PARENT, 'Bench B')), mr)
    const C = path.join(PARENT, 'Bench C')
    const markerC = JSON.parse(fs.readFileSync(path.join(C, 'forsion-unit.json'), 'utf8'))
    fs.writeFileSync(path.join(C, 'forsion-unit.json'), JSON.stringify({ ...markerC, id: '00000000-0000-4000-8000-00000000c0de' }))
    const cBefore = snapshotDir(C)
    const mism = launchDirect([`--forsion-unit=${idC}`], BASE)
    ours.add(mism.child.pid)
    const xr = await within(mism.done, 20000)
    check('标记 id 对不上:退出码 3、说明 mismatch、文件夹里一个文件都没多(没设 userData、没拿锁)', xr.code === 3 && /refused \(mismatch\)/.test(xr.stderr) && JSON.stringify(snapshotDir(C)) === JSON.stringify(cBefore), { code: xr.code, stderr: xr.stderr.slice(-200), after: snapshotDir(C) })
    const after = snapshotDir(T).filter(notDefaults)
    const added = after.filter((p) => !before.includes(p) && !p.startsWith(path.join(T, 'moved-B')) && !p.startsWith(PARENT + path.sep + 'Bench B'))
    check('三次拒绝之后临时目录里没有多出任何目录 / 文件,名册一字没改', added.length === 0 && fs.readFileSync(REGISTRY, 'utf8') === regBytes, added.slice(0, 10))

    // ── 8 加入已有:拷贝的 / 搬了家的 ──
    const copy = path.join(T, 'copies', 'Bench A copy')
    fs.cpSync(A, copy, { recursive: true })
    const pick = (p) => app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }) }, p)
    await pick(copy)
    const dup = await lu('addExisting')
    check('拷贝出来的文件夹加入 → duplicate_id,名册不变', dup.code === 'duplicate_id' && JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).units.length === 3, dup)
    await pick(path.join(T, 'moved-B'))
    const moved = await lu('addExisting')
    const regMoved = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).units.find((u) => u.id === idB)
    check('搬了家的文件夹加入 → ok,名册路径改成新位置', moved.ok && regMoved?.path === path.join(T, 'moved-B'), { moved, regMoved })
    const rm = await lu('remove', idC)
    check('从列表移除:只删名册条目,文件夹还在', rm.ok && fs.existsSync(C) && !JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).units.some((u) => u.id === idC), rm)
  } finally {
    await app.close().catch(() => {})
    // 只结束自己起的 / 在自己临时目录的运行记录里读到的 pid
    for (const dir of [path.join(PARENT, 'Bench A'), path.join(T, 'moved-B')]) { const p = runPid(dir); if (p) ours.add(p) }
    for (const pid of ours) if (alive(pid) && pid !== process.pid) { try { process.kill(pid, 'SIGTERM') } catch { /* 已退 */ } }
    await sleep(1500)
    for (const pid of ours) if (alive(pid) && pid !== process.pid) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退 */ } }
  }
}

main()
  .catch((e) => { check('台架本身没抛错', false, e?.stack || String(e)) })
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    if (!process.env.KEEP_TMP) fs.rmSync(T, { recursive: true, force: true }); else console.log(`临时目录留着:${T}`)
    process.exit(failed.length ? 1 : 0)
  })
