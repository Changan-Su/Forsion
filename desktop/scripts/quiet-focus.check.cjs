// 台架静默仪器:Playwright 起的实例开主窗 + 浮窗,全程不许把用户前台 App 切成 Electron(见 main.ts QUIET_WINDOWS),
// 且主窗要压在所有普通窗口之下(系统窗口列表里层级 < 0;见 main.ts sinkForHarness)—— 不抢焦点但盖在用户窗口上面照样打扰。
// 用法:npm run check:quietfocus            —— 只验「不抢、不盖」
//       npm run check:quietfocus -- --control —— 另跑负对照 TANGU_HARNESS_QUIET=0,必须测到抢焦点、主窗回到普通层级(会真抢一次,约 3s)
// 仅 macOS(lsappinfo,无需辅助功能权限);其它平台跳过。
const fs = require('fs'), os = require('os'), path = require('path')
const { execFile, execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')

if (process.platform !== 'darwin') { console.log('SKIP quiet-focus: macOS only'); process.exit(0) }
const ROOT = path.resolve(__dirname, '..')
// lsappinfo 的输出格式跟系统版本走:老版本是 `"LSDisplayName"="Claude"`,macOS 27 是 `"Claude" ASN:0x0-…: (in front)` 外加几行空字段。
// 只按老格式解析的话,新系统上名字永远对不上 'Electron',「不抢焦点」那条就成了恒绿。
const nameOf = (out) => { const s = String(out); return (s.match(/^\s*"([^"]*)"\s+ASN:/) || s.match(/=\s*"?([^"\n]*)"?/) || [0, s.trim()])[1] }
const frontSync = () => nameOf(execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]))
const front = () => new Promise((r) => execFile('lsappinfo', ['front'], (_e, asn) => execFile('lsappinfo', ['info', '-only', 'name', String(asn).trim()], (_e2, out) => r(nameOf(out)))))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
/** 某进程在屏窗口的 [层级, 宽] 列表(CGWindowList;只读层级与尺寸,不读标题,无需屏幕录制权限)。0 = 普通窗口,< 0 = 压在普通窗口之下。 */
const JXA = `ObjC.import('CoreGraphics'); function run(a) { return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).filter((w) => w.kCGWindowOwnerPID == a[0]).map((w) => [w.kCGWindowLayer, w.kCGWindowBounds.Width])) }`
const layersOf = (pid) => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA, String(pid)]).toString())

/** 起应用 → 主窗 → 设置浮窗 → 关;期间每 200ms 采样前台,返回出现过的前台名集合 + 各窗口的系统层级。 */
async function run(env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-focus-'))
  const seen = new Set(); let on = true, layers = []
  const sampler = (async () => { while (on) { seen.add(await front()); await pause(200) } })()
  const app = await electron.launch({ args: [`--user-data-dir=${temp}/ud`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: temp, ...env } })
  try {
    const win = await app.firstWindow()
    await pause(2000)
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'about' } }))
    await pause(2000)
    layers = layersOf(app.process().pid)
  } finally { await app.close().catch(() => {}); on = false; await sampler }
  return { seen, layers }
}

;(async () => {
  const baseline = frontSync()
  if (baseline === 'Electron') { console.log('SKIP quiet-focus: 前台本来就是 Electron(dev 实例?),判不出'); process.exit(0) }
  let fail = 0
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} | ${detail}`); if (!ok) fail++ }
  // 主窗 = 宽 ≥ 880(minWidth)的那些;浮窗是它的子窗,跟着父窗的层级走
  const big = (r) => r.layers.filter(([, w]) => w >= 880).map(([l]) => l)
  const quiet = await run({})
  check('Playwright 起的实例全程不抢前台焦点', !quiet.seen.has('Electron'), [...quiet.seen].join(','))
  check('主窗压在所有普通窗口之下(层级 < 0)', big(quiet).length > 0 && big(quiet).every((l) => l < 0), `[层级,宽] ${JSON.stringify(quiet.layers)}`)
  if (process.argv.includes('--control')) {
    const loud = await run({ TANGU_HARNESS_QUIET: '0' })
    check('负对照:关掉静默必须测到抢焦点', loud.seen.has('Electron'), [...loud.seen].join(','))
    check('负对照:关掉静默主窗在普通层级(0)', big(loud).length > 0 && big(loud).every((l) => l === 0), `[层级,宽] ${JSON.stringify(loud.layers)}`)
  }
  console.log(fail ? `${fail} failed` : 'all passed')
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
