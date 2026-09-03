/**
 * 移动端「设置里改的配置真的存下来了吗」仪器。
 *
 * 病理(2026-09-03):`mobileShim` 不给 `setConfig`,而 appStore.patchConfig 写的是
 * `window.tangu?.setConfig(patch)` —— `window.tangu` 真值,可选链**不短路**,方法缺席即 TypeError,
 * 且它抛在 zustand 的 set 更新器里。表现:设置→模型里点一个模型,勾选出现(setDraft 先跑完),
 * cfg 纹丝不动 —— 看着存上了,实际没有。typecheck 抓不到(types.ts 把 setConfig 声明成必填,
 * 而垫片是 `as unknown` 硬塞的),boot 冒烟也抓不到(它不点设置)。
 *
 * 两条断言:
 *   A. 点模型不抛未捕获异常(崩溃回归)
 *   B. reload 后那一项仍然选中(持久化回归 —— 光修崩溃的话,这条依旧红:重启即回默认)
 *
 * 跑法:npm run build && npm run e2e:settingscfg。机制照抄 units-entry.e2e.cjs。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = 5283 // 与 boot(5279)/unitsentry(5281) 错开
const URL = `http://localhost:${PORT}/`
const MODEL_ID = 'e2e/alpha'
const MODEL_NAME = 'Alpha 1'
const MODELS_BODY = JSON.stringify({
  models: [
    { id: MODEL_ID, name: MODEL_NAME, provider: 'e2e', source: 'forsion', modelType: 'llm' },
    { id: 'e2e/beta', name: 'Beta 2', provider: 'e2e', source: 'forsion', modelType: 'llm' },
  ],
  directProviders: [],
  defaultModelId: null,
})
/** 一级项「模型/Provider」与它的子项「模型」——两语都认(台架不钉语言)。 */
const TAB_LABELS = ['模型/Provider', 'Model / Provider']
const SUB_LABELS = ['模型', 'Models']

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
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
  const pageErrors = []
  const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
  const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-settings-cfg') } catch { /* ignore */ } })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // ⚠️ 必须**后**注册:playwright 后注册的路由先匹配,写在 abort 前面会被整片 abort 吃掉。
    await page.route('**/api/agent/models*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: MODELS_BODY }))
    page.on('pageerror', (e) => pageErrors.push(e.message))

    // body 有 zoom:1.15,Playwright 的可点性判定在 zoom 下判「视口外」→ 套件口径:CDP 触摸打 boundingBox。
    const cdp = await ctx.newCDPSession(page)
    const tapBox = async (b) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const tap = async (locator, what) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error(`目标不可见: ${what}`)
      await tapBox(b)
    }
    /** 抽屉 → 设置 → 模型页(m-models)。每次 reload 后都要重走一遍。 */
    const openModelPage = async () => {
      await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      await page.waitForTimeout(500)
      await tap(page.locator('.mb-drawer--left.open .mb-foot-row .mb-icon-btn[aria-label="settings"]'), '设置钮')
      await page.waitForTimeout(700)
      const tabRow = page.locator('.settings-mobile-row', { hasText: new RegExp(TAB_LABELS.map((s) => s.replace(/[/]/g, '\\/')).join('|')) }).first()
      await tap(tabRow, '模型/Provider 一级项')        // 有子项 → 首次点击=展开
      await tap(page.locator('.settings-mobile-subitems .settings-mobile-subrow')
        .filter({ hasText: new RegExp(`^\\s*(${SUB_LABELS.join('|')})\\s*$`) }).first(), '模型 子项')
      await page.waitForSelector('.model-group-list', { timeout: 8000 })
    }

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    await openModelPage()
    // 分组默认折叠(没有选中项时);先展开再点模型。
    await tap(page.locator('.model-group-list .model-group-head').first(), '模型分组')
    await tap(page.locator('.model-group-list .file-row', { hasText: MODEL_NAME }).first(), `模型 ${MODEL_NAME}`)

    // A. 点一下不许抛。这一条就是本次 bug 的直接复现(setConfig is not a function)。
    const cfgErr = pageErrors.filter((m) => /setConfig|is not a function/.test(m))
    if (cfgErr.length) fail('选模型不抛未捕获异常', cfgErr.join(' / '))
    else pass('选模型不抛未捕获异常')

    // 勾选真的落到 cfg(不是只落 draft):没有崩的话这里必须是选中态。
    const marked = await page.locator('.model-group-list .file-row.active').count()
    if (marked !== 1) fail('选中项唯一', `active=${marked}`)
    else pass('选中项唯一')

    // B. 重启后仍然选中 = 真的存下来了(mobileShim.setConfig/getConfig 落盘 + boot 回灌 cfg)。
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)
    await openModelPage()
    // 选中项所在分组会自动展开 → 直接查勾。
    const keptName = await page.locator('.model-group-list .file-row.active .file-name').first()
      .innerText().catch(() => '')
    if (keptName.trim() === MODEL_NAME) pass('重启后默认模型仍是刚选的', keptName.trim())
    else fail('重启后默认模型仍是刚选的', `实际选中「${keptName.trim() || '(无)'}」`)

    const stored = await page.evaluate(async () => {
      const c = await window.tangu.getConfig()
      return { modelId: c.modelId, backendUrl: c.backendUrl, token: c.token }
    }).catch((e) => ({ err: String(e && e.message || e) }))
    if (stored.modelId === MODEL_ID) pass('getConfig 读回选中模型', JSON.stringify(stored.modelId))
    else fail('getConfig 读回选中模型', JSON.stringify(stored))
    // 身份字段绝不许被落盘的偏好盖掉(token 在 native 上住 Capacitor Preferences,不进 localStorage)。
    if (stored.token && stored.token !== 'e2e-settings-cfg') fail('token 未被落盘偏好污染', String(stored.token))
    else pass('token 未被落盘偏好污染')

    const shot = path.join(os.tmpdir(), 'forsion-settings-config.png')
    await page.screenshot({ path: shot })
    console.log(`screenshot → ${shot}`)
  } catch (e) {
    fails.push(String(e && e.message || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (pageErrors.length) console.log(`(pageerror 全量:${pageErrors.join(' | ')})`)
  if (fails.length) {
    console.error(`\n✗ e2e:settingscfg ${fails.length} 项失败:\n- ${fails.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\n✅ e2e:settingscfg —— 设置改配置不崩 + 重启仍在')
}

main().catch((e) => { console.error(e); process.exit(1) })
