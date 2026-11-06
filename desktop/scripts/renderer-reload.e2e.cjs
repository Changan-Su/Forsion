/**
 * 整窗重载在打包形态下真的生效(2026-11-05):打包版页面是 file:,渲染层自己 location.reload() 会被主进程 hardenNav
 * 当成一次 file: 导航拦下、静默无效(dev 走 http://localhost,拦不到)。错误页「重新加载」、Space 窗口定义变了、
 * 切移动端 UI 预览都走 reloadWindow.ts → window.tangu.reloadWindow → 主进程 webContents.reload()。
 *
 * 真 Electron × 构建产物 out/(loadFile,和安装版同为 file:)× 假引擎:
 *  R0 页面是 file:(否则这台架测不到 hardenNav);
 *  R1 负对照:渲染层 location.reload() 被拦,页面没重载(修之前错误页按钮就是这样);
 *  R2 window.tangu.reloadWindow() 让页面重载;
 *  R3 重载后应用照常起来(#root 有内容)。
 *
 * 需先:../tangu-agent 的 npm run build + 本目录 npm run build。用法:npm run e2e:reload
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out', 'renderer', 'index.html'))) throw new Error('out/ 不在:先 npm run build')
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-reload-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await win.waitForSelector('#root', { timeout: 60_000 })
    await win.waitForFunction(() => (document.getElementById('root')?.innerHTML.length ?? 0) > 0, null, { timeout: 60_000 })
    check('R0 页面是 file:', win.url().startsWith('file:'), win.url().slice(0, 60))
    const mark = () => win.evaluate(() => { window.__reloadMark = Math.random(); return window.__reloadMark })
    const marked = () => win.evaluate(() => window.__reloadMark ?? null).catch(() => 'gone')

    const m1 = await mark()
    await win.evaluate(() => { location.reload() }).catch(() => {})
    await wait(2500)
    const after1 = await marked()
    check('R1 负对照:渲染层 location.reload() 被拦,页面没重载', after1 === m1, `mark ${after1 === m1 ? '还在' : '没了'}`)

    await mark()
    const loaded = win.waitForEvent('load', { timeout: 30_000 }).then(() => true, () => false)
    await win.evaluate(() => window.tangu.reloadWindow()).catch(() => {})
    const didLoad = await loaded
    const after2 = await marked()
    check('R2 window.tangu.reloadWindow() 重载了这扇窗', didLoad && after2 === null, `load ${didLoad}, mark ${after2}`)

    await win.waitForFunction(() => (document.getElementById('root')?.innerHTML.length ?? 0) > 0, null, { timeout: 60_000 }).then(() => true, () => false)
      .then((ok) => check('R3 重载后应用照常起来', ok))
  } finally {
    await app.close().catch(() => {})
    await stub.close?.()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\nrenderer-reload: ${results.length - failed}/${results.length} PASS`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
