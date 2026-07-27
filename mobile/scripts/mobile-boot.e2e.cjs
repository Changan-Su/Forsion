/**
 * 移动端「能不能开机」冒烟:构建产物 → vite preview → headless chromium 真跑一遍 → 断言没崩。
 *
 * 为什么需要它:mobile 经 vite 别名复用 desktop 渲染层,而 `vite build` 用 esbuild 剥类型、
 * **不做类型检查也不执行代码**。`npm run typecheck` 能挡住"字段没了/prop 少了"这类静态错,
 * 但挡不住运行期才炸的东西(装载顺序、shim 缺方法、第三方模块在非 Electron 环境摸 window)。
 * v2.7.1 的安卓包就是一开就崩(`appStore.toasts` 被删,MobileRoot 还在 .map),
 * 三平台桌面包全绿、CI 也全绿 —— 因为没有任何一环真的把移动端跑起来过。
 *
 * 用法:npm run e2e:boot(mobile 目录下)。CHROMIUM_EXE 可覆盖 chromium 路径。
 * 判定:页面加载后既没有未捕获异常,也没有渲染出错误边界,且外壳容器真的挂上了。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
// playwright-core 借 desktop 的(mobile 不为一台冒烟仪器多背一个依赖);本地有就先用本地。
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

// preview 专用端口:刻意避开 dev 的 5274,免得本地开着 dev 就跑不了。
// (前端环境变量约定禁的是 **dev 脚本**带 --port;测试 harness 自己钉端口是另一回事。)
const PORT = 5279
const URL = `http://localhost:${PORT}/`

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
      // playwright 的目录名随 CPU 架构变(chrome-mac / chrome-mac-arm64 / chrome-linux),别只钉一种。
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  // 兜底:系统装的 Chrome(CI 的 ubuntu runner 也有 google-chrome)。
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

function ping() {
  return new Promise((res) => {
    const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }

  // detached + 杀进程组:npx 只是壳,真正听端口的是它 fork 出来的 vite;只 kill npx 会留孤儿占着端口
  // (下次跑就报「端口被占」——Codex 评审本地就撞上了这一发)。stderr 留着,起不来时要能说出原因。
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => {
    try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } }
  }

  let browser = null
  const fails = []
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(preview 无 stderr 输出)'}`)

    // CI 常以 root 跑,系统 chrome 不加 --no-sandbox 会直接起不来。
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    // 手机视口 + touch:单列外壳的分支按它走。
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    // ⚠️ 关键:没 token 时 mobileShim 直接跳 /auth,MobileRoot 压根不渲染 —— 那样这台仪器就是假绿
    // (原来那个 `appStore.toasts` 崩溃就在 MobileRoot 里,登录闸后面才炸)。种一枚假 token 越过闸。
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-boot-smoke') } catch { /* ignore */ } })
    const page = await ctx.newPage()
    // ⚠️ 后端调用必须全部桩成 2xx。vite preview 会继承 server.proxy 把 /api 代理到**真后端**,
    // 假 token 换回 401 → mobileShim 的「401 兜底」当场 logout 并跳 /auth,又变成测登录页。
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    // 其余后端调用一律 abort = 「后端不可达」,这是应用本来就有 catch 的既有路径。
    // (别图省事 fulfill 一个 `{}`:那等于喂畸形响应,会把 sessions 之类字段冲成 undefined,
    //  测出来的是「API 形状容错」而不是「能不能开机」,属于自造假红。)
    await page.route('**/api/**', (r) => r.abort())
    // 未捕获异常 = 直接判负。console.error 不算(离线环境下连接失败会刷一片,那是预期的)。
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000) // 给懒加载 chunk + store 初始化留时间

    // 错误边界标题出现 = 渲染塌了。中英两版都查(ErrorBoundary 按语言切,别只钉中文)。
    const boundary =
      (await page.locator('text=界面渲染出错').count()) +
      (await page.locator('text=Something broke while rendering').count())
    if (boundary > 0) {
      const detail = await page.locator('pre, code').first().innerText().catch(() => '(取不到详情)')
      fails.push(`渲染出了错误边界:\n${detail.slice(0, 600)}`)
    }
    // 正向断言:外壳真的挂上了(只查"没报错"会把白屏放过去)。
    if ((await page.locator('.shell-host').count()) === 0) fails.push('.shell-host 没挂上(白屏)')
  } finally {
    // 浏览器起不来(找不到 chrome / 启动失败)也必须收掉 preview —— 原来 launch 在 try 之外,
    // 这条路径会把 preview 漏在后台。
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }

  if (fails.length) {
    console.error('✗ 移动端开机冒烟失败:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✓ 移动端开机冒烟通过(无未捕获异常 / 无错误边界 / 外壳已挂载)')
}

main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(1) })
