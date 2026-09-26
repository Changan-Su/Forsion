// Windows 真机台架(由 .github/workflows/probe-env-install.yml 手动触发):当前分支现场构建、不打包,走 envCheck → envRun(git) → envCheck。
// 有 winget:必须装上并被认出;没有 winget:必须不给安装命令、只给下载页。否则 exit 1。
const path = require('path'), fs = require('fs'), os = require('os')
const desktop = path.resolve(process.argv[2])
const { _electron: electron } = require(path.join(desktop, 'node_modules', 'playwright-core'))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const hasWinget = process.argv[3] === 'winget'
;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dev-probe-'))
  const app = await electron.launch({ executablePath: require(path.join(desktop, 'node_modules', 'electron')), args: [`--user-data-dir=${path.join(home, 'ud')}`, desktop],
    cwd: desktop, env: { ...process.env, TANGU_HOME: path.join(home, 'tangu') }, timeout: 90000 })
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.tangu?.envCheck, null, { timeout: 60000 })
  const check = () => win.evaluate(() => window.tangu.envCheck())
  const before = await check()
  const git = before.find((p) => p.tool === 'git')
  log('BEFORE git =', JSON.stringify(git))
  let ok = false
  if (!hasWinget) {
    ok = !git.found && git.installId === null && /^https:\/\//.test(git.downloadUrl || '')
    log(ok ? 'PASS no winget → no install button, download page offered' : 'FAIL no-winget gating')
  } else if (git.found || !git.installId || !/--accept-source-agreements/.test(git.installCommand)) {
    log('FAIL git not in missing+installable(non-interactive) state')
  } else {
    await win.evaluate(() => { window.__envLog = []; window.tangu.onEnvOutput((ev) => window.__envLog.push(ev.line)) })
    const t0 = Date.now()
    const res = await Promise.race([
      win.evaluate((id) => window.tangu.envRun(id), git.installId),
      new Promise((r) => setTimeout(() => r({ hung: true }), 12 * 60000)),
    ])
    const lines = (await win.evaluate(() => window.__envLog)).join('').replace(/\r/g, '\n').split('\n').map((s) => s.trim()).filter((s) => s && !/^[-\\|/]$/.test(s) && !/[█▒]/.test(s))
    for (const l of lines.slice(-15)) log('  |', l.slice(0, 200))
    log('envRun', JSON.stringify(res), `after ${Math.round((Date.now() - t0) / 1000)}s`)
    const after = (await check()).find((p) => p.tool === 'git')
    log('AFTER git =', JSON.stringify(after))
    ok = res.exitCode === 0 && after.found
    log(ok ? 'PASS installed via envRun and detected without restart' : 'FAIL install chain')
  }
  await app.close().catch(() => {})
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
