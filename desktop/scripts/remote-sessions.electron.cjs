/**
 * 「允许远程会话」真 Electron 接线(P1 · K4):真主进程 × 真 preload / IPC × 真 remote-sessions.json × 真 config.json × 真设置页 × 真设备切换器。
 * 单测(remoteSessions.test / RemoteSessionsSettings.test)注入的是假文件与假桥,证不了「main.ts 真的在 deviceSecrets.init 之后迁移、
 * IPC 真的写到 userData、审批档真的只写进 config.json 的 remote.maxApprovalMode、渲染层真的拿得到 window.tangu.remoteSessions」这条线。
 *
 * 隔离:TANGU_HOME / --user-data-dir 都是临时目录;auth.json 放一枚假票(JWT 形状,只为算出账号 id),TANGU_CLOUD_URL 指本机一个不监听的端口
 *   → 设备通道永远连不上、名册查不到,不碰真账号 / 真名册;桩引擎(external 模式),不起真后端、不调模型。
 *
 * 判据:
 *   R1 迁移:老用户(shell 里 unitHostEnabled=true、没有 remote-sessions.json)→ 启动后文件出现,enabled=true、账号行 preconfirmed、权限 0600、落在 userData
 *   R2 设置 › 远程会话:开关开、「本账号的浏览器与网页版」标注「更新时自动允许」;截图 zh
 *   R3 关开关 → 盘上 enabled=false;再开 → true(IPC 落盘)
 *   R4 选全自动:勾「我了解风险」确认 → config.json 只多 remote.maxApprovalMode=full-auto,其他段原样;常驻警示
 *   R5 撤销账号行 → 盘上 trusted=[] + accountStrict 记下当前账号(D8 严格档,评审 P1);行变「已撤销」+「允许」
 *   R5b 点「允许」(真 preload remoteSessions.allowAccount → IPC)→ 盘上账号行回来、accountStrict 清空
 *   R6 config:get(渲染层能读到的整份配置)里没有远程会话的开关 / 信任 / 审批档
 *   R7 设备切换器脚部:父开关下出现子开关,与设置页同一状态;截图
 * 负对照:把 main.ts 里 `void remoteSessions.init()` 那行删掉再 build → R1 红(文件不出现)、R2 挂在加载态。
 *
 * 跑:npm run build && node scripts/remote-sessions.electron.cjs   (自己 acquire / release devlock;只杀自己拉起的 Electron)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawnSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
/** 仓根的 devlock 钩子:主检出在 ../..,worktree 里要往上多找几层。 */
const DEVLOCK = (() => {
  for (let d = ROOT; d !== path.dirname(d); d = path.dirname(d)) {
    const f = path.join(d, '.claude/hooks/devlock.cjs')
    if (fs.existsSync(f)) return f
  }
  return ''
})()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-remote-sessions-'))
const shots = process.env.RS_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { if (await fn()) return true } catch { /* retry */ } await pause(100) }
  return false
}
const deadPort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(2) }
  const lock = DEVLOCK ? spawnSync(process.execPath, [DEVLOCK, 'acquire', '--vehicle=e2e'], { stdio: 'inherit' }) : { status: 0 }
  if (lock.status !== 0) process.exit(3)
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const cloud = `http://127.0.0.1:${await deadPort()}`
  const userdata = path.join(home, 'userdata')
  // 老用户:互联开着、还没有 remote-sessions.json(dev 态 userData = 目录名 + '-dev',两处都放)
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e', unitHostEnabled: true }))
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sandbox: 'auto', cloud: { url: cloud }, approval: { base: 'auto-edit' } }))
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud, token: `${b64({ alg: 'none' })}.${b64({ userId: 'e2e-user' })}.x` }), { mode: 0o600 })
  const rsFile = path.join(`${userdata}-dev`, 'remote-sessions.json')
  const readRs = () => { try { return JSON.parse(fs.readFileSync(rsFile, 'utf8')) } catch { return null } }
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: cloud },
    })
    const mainWin = await app.firstWindow()
    await mainWin.waitForSelector('#root', { timeout: 40000 })
    check('主窗已离开首启引导', await skipOnboarding(mainWin))

    // R1 迁移
    await waitFor(() => !!readRs(), 15000)
    const rs = readRs()
    const mode = fs.existsSync(rsFile) ? (fs.statSync(rsFile).mode & 0o777).toString(8) : null
    check('R1 老用户迁移:remote-sessions.json 出现在 userData,enabled=true、账号行 preconfirmed、0600',
      rs?.enabled === true && rs?.migratedFromUnitHost === true && rs?.trusted?.length === 1 && rs.trusted[0].principal === 'account' && rs.trusted[0].preconfirmed === true && mode === '600', { rs, mode })

    // R6 渲染层整份配置里没有远程会话的键
    const cfg = await mainWin.evaluate(() => window.tangu.getConfig())
    const leaked = Object.keys(cfg).filter((k) => /remote|maxApproval|trusted/i.test(k))
    check('R6 config:get 不带远程会话的开关 / 信任 / 审批档', leaked.length === 0, leaked)

    // R2 设置页
    await mainWin.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'remote-sessions' } }))
    let fl
    await waitFor(async () => { fl = app.windows().find((w) => w.url().includes('window=floating')); return !!fl }, 15000)
    await fl.locator('[data-setting-anchor="remote-sessions-switch"]').waitFor({ timeout: 30000 })
    await pause(500)
    const sw = fl.locator('[data-setting-anchor="remote-sessions-switch"] [role="switch"]')
    const accountText = await fl.locator('[data-setting-anchor="remote-trusted-devices"]').innerText()
    check('R2 设置 › 远程会话:开关开、账号行标注「更新时自动允许」', (await sw.getAttribute('aria-checked')) === 'true' && !(await sw.isDisabled())
      && accountText.includes('本账号的浏览器与网页版') && accountText.includes('更新时自动允许'), accountText.slice(0, 120))
    await fl.screenshot({ path: path.join(shots, 'electron-remote-sessions-zh.png') })

    // R3 开关落盘
    await sw.click()
    const offOk = await waitFor(() => readRs()?.enabled === false)
    await sw.click()
    const onOk = await waitFor(() => readRs()?.enabled === true)
    check('R3 关 → 盘上 enabled=false;再开 → true', offOk && onOk, readRs())

    // R4 全自动
    await fl.locator('[data-cap="full-auto"]').click()
    await fl.locator('[data-rs-fullauto-confirm] input[type="checkbox"]').check()
    await fl.locator('[data-rs-fullauto-confirm] .btn.danger').click()
    const capOk = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).remote?.maxApprovalMode === 'full-auto' } catch { return false } })
    const conf = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    check('R4 全自动:config.json 只多 remote.maxApprovalMode,其他段原样;常驻警示', capOk && conf.sandbox === 'auto' && conf.approval?.base === 'auto-edit'
      && JSON.stringify(conf.remote) === JSON.stringify({ maxApprovalMode: 'full-auto' }) && await fl.locator('[data-rs-fullauto-warn]').isVisible(), conf)
    await fl.screenshot({ path: path.join(shots, 'electron-remote-sessions-fullauto.png') })

    // R5 撤销账号行
    await fl.locator('[data-rs-revoke="account"]').click()
    const revoked = await waitFor(() => readRs()?.trusted?.length === 0)
    check('R5 撤销「本账号的浏览器与网页版」→ 盘上 trusted=[]', revoked && (await fl.locator('[data-rs-revoke="account"]').count()) === 0, readRs())
    const strictOk = await waitFor(() => readRs()?.accountStrict?.length === 1 && typeof readRs().accountStrict[0].accountId === 'string')
    await fl.locator('[data-rs-allow-account="strict"]').waitFor({ timeout: 5000 })
    check('R5 撤销 = D8 严格档:盘上 accountStrict 记下当前账号,行变「已撤销」+「允许」', strictOk
      && (await fl.locator('[data-setting-anchor="remote-trusted-devices"]').textContent()).includes('不会再弹框询问'), readRs())
    await fl.screenshot({ path: path.join(shots, 'electron-remote-sessions-strict.png') })
    await fl.locator('[data-rs-allow-account]').click()
    const reallowed = await waitFor(() => readRs()?.accountStrict?.length === 0 && readRs()?.trusted?.some((r) => r.principal === 'account' && !r.preconfirmed))
    check('R5b 设置里点「允许」→ 真 IPC allowAccount:盘上账号行回来、严格档清空', reallowed && await fl.locator('[data-rs-revoke="account"]').isVisible(), readRs())

    // R7 设备切换器子开关
    await mainWin.bringToFront()
    await mainWin.locator('.unitsw-pill').first().click()
    await mainWin.locator('[data-unitsw-remote]').waitFor({ timeout: 8000 })
    const sub = await mainWin.evaluate(() => ({ on: document.querySelector('[data-unitsw-remote]')?.getAttribute('aria-checked'), label: document.querySelector('.unitsw-subrow .unitsw-foot-label')?.textContent }))
    check('R7 设备切换器脚部:父开关下出现「允许远程会话」子开关,状态与设置页一致(开)', sub.on === 'true' && sub.label === '允许远程会话', sub)
    await pause(300)
    await mainWin.screenshot({ path: path.join(shots, 'electron-unit-switcher.png') })
    await mainWin.locator('[data-unitsw-remote]').click()
    check('R7b 切换器里关子开关 → 盘上 enabled=false', await waitFor(() => readRs()?.enabled === false), readRs())
  } finally {
    await app?.close().catch(() => {})
    stub.close()
    if (DEVLOCK) spawnSync(process.execPath, [DEVLOCK, 'release'], { stdio: 'ignore' })
  }
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : `\n✅ 全部通过 —— 截图:${shots}`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); if (DEVLOCK) spawnSync(process.execPath, [DEVLOCK, 'release'], { stdio: 'ignore' }); process.exit(1) })
