// 台架静默仪器:Playwright 起的实例开主窗 + 浮窗,全程不许把用户前台 App 切成 Electron(见 main.ts QUIET_WINDOWS)。
// 用法:npm run check:quietfocus            —— 只验「不抢」
//       npm run check:quietfocus -- --control —— 另跑负对照 TANGU_HARNESS_QUIET=0,必须测到抢焦点(会真抢一次,约 3s)
// 仅 macOS(lsappinfo,无需辅助功能权限);其它平台跳过。
const fs = require('fs'), os = require('os'), path = require('path')
const { execFile, execFileSync } = require('child_process')
const { _electron: electron } = require('playwright-core')

if (process.platform !== 'darwin') { console.log('SKIP quiet-focus: macOS only'); process.exit(0) }
const ROOT = path.resolve(__dirname, '..')
const frontSync = () => execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]).toString().replace(/.*=/, '').replace(/"/g, '').trim()
const front = () => new Promise((r) => execFile('lsappinfo', ['front'], (_e, asn) => execFile('lsappinfo', ['info', '-only', 'name', String(asn).trim()], (_e2, out) => r(String(out).replace(/.*=/, '').replace(/"/g, '').trim()))))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起应用 → 主窗 → 设置浮窗 → 关;期间每 200ms 采样前台,返回出现过的前台名集合。 */
async function run(env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-focus-'))
  const seen = new Set(); let on = true
  const sampler = (async () => { while (on) { seen.add(await front()); await pause(200) } })()
  const app = await electron.launch({ args: [`--user-data-dir=${temp}/ud`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: temp, ...env } })
  try {
    const win = await app.firstWindow()
    await pause(2000)
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'about' } }))
    await pause(2000)
  } finally { await app.close().catch(() => {}); on = false; await sampler }
  return seen
}

;(async () => {
  const baseline = frontSync()
  if (baseline === 'Electron') { console.log('SKIP quiet-focus: 前台本来就是 Electron(dev 实例?),判不出'); process.exit(0) }
  let fail = 0
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} | ${detail}`); if (!ok) fail++ }
  const quiet = await run({})
  check('Playwright 起的实例全程不抢前台焦点', !quiet.has('Electron'), [...quiet].join(','))
  if (process.argv.includes('--control')) {
    const loud = await run({ TANGU_HARNESS_QUIET: '0' })
    check('负对照:关掉静默必须测到抢焦点', loud.has('Electron'), [...loud].join(','))
  }
  console.log(fail ? `${fail} failed` : 'all passed')
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
