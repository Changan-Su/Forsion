/**
 * 「手机形态页」台架件(P1 · K9):check:remotechain 与 check:streamrenew 共用。
 *
 * 页面 = mobile 的 dev 风味构建(VITE_API_ORIGIN=http://phone-hub.test,带 __forsionStore / __forsionEngineTargets),
 * 由假 hub 出静态页;Playwright 以 HTTP 代理把 http://phone-hub.test 指到假 hub(页面与 API 同源,不占固定端口)。
 * Capacitor 走「安卓 App」分支:window.CapacitorCustomPlatform + PluginHeaders + nativePromise / nativeCallback(@capacitor/core
 * 自带的自定义平台钩子)—— mobileShim 因此装原生中继;ForsionUnit 插件经 exposeBinding 落到 Node 替身(fake-phone-native.cjs)。
 * 其余插件(Preferences / App / Browser / Filesystem)按 Capacitor 的规矩回落各自的 web 实现;LiveIsland / SpaceShortcuts 空实现。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright-core')
const { GENESIS } = require('./remote-world.cjs') // = 本 worktree 的 Genesis 根(desktop/..)

const MOBILE = path.join(GENESIS, 'mobile')
const PHONE_ORIGIN = 'http://phone-hub.test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const e = path.join(root, d, rel)
        if (fs.existsSync(e)) return e
      }
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

// ── 手机页构建的缓存:只在「同一棵源码」时复用 ─────────────────────────────────────────────────────────────
// mobile 构建经 vite 别名吃进 desktop/frontend(src + public = publicDir)、desktop/shared、lcl、web/src/amadeus(mobile/vite.config.ts),
// 裸包从各自的 node_modules 解析(desktop/frontend 里的 import 走 desktop 的锁文件)。渲染层改一行而台架还拿旧包跑 = 结论说的是别的代码
// (评审 P1:缓存曾落在按用户共享的 os.tmpdir()/forsion-remotechain-dist,二十几个兄弟 worktree 共用一份、从不和源码比对)。
// 戳 = GENESIS 绝对路径 + 这些路径在 HEAD 的树 / blob 哈希(只动别处的提交不触发重建)+ 相对 HEAD 的 diff(含二进制)+ 未跟踪文件的内容;
// 任一变了就重建。git 不可用 → 永不复用。
const STAMP_PATHS = ['mobile', 'desktop/frontend', 'desktop/shared', 'desktop/package.json', 'desktop/package-lock.json', 'lcl', 'web/src/amadeus']
const STAMP_FILE = '.k9-stamp.json'
const git = (args) => spawnSync('git', ['-C', GENESIS, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })

/** 当前源码的戳(sha256 hex);git 不可用 / 出错 → null(调用方按「不可复用」处理)。 */
function phoneDistStamp() {
  const trees = git(['ls-tree', 'HEAD', '--', ...STAMP_PATHS])
  if (trees.status !== 0) return null
  const h = crypto.createHash('sha256')
  h.update(`genesis=${GENESIS}\norigin=${PHONE_ORIGIN}\nmode=development\n`)
  h.update(trees.stdout)
  const diff = git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary', '--', ...STAMP_PATHS])
  if (diff.status !== 0) return null
  h.update(diff.stdout)
  const others = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...STAMP_PATHS])
  if (others.status !== 0) return null
  for (const rel of others.stdout.toString().split('\0').filter(Boolean).sort()) {
    h.update(`\0untracked:${rel}\0`)
    try { h.update(fs.readFileSync(path.join(GENESIS, rel))) } catch { h.update('<unreadable>') }
  }
  return h.digest('hex')
}

/** 缺省缓存目录:按 GENESIS 路径分开(兄弟 worktree 不共用一份)。 */
const defaultPhoneDistDir = () => path.join(os.tmpdir(), `forsion-remotechain-dist-${crypto.createHash('sha256').update(GENESIS).digest('hex').slice(0, 12)}`)

/** dir 里那份构建能不能复用:{ reuse, reason, stamp }。REMOTECHAIN_REUSE_DIST=1 = 不比源码、有就用(打 WARN)。 */
function phoneDistStatus(dir, stamp = phoneDistStamp()) {
  if (!fs.existsSync(path.join(dir, 'index.html')) || !fs.existsSync(path.join(dir, 'forsion-native.json'))) return { reuse: false, reason: '没有构建', stamp }
  try { if (JSON.parse(fs.readFileSync(path.join(dir, 'forsion-native.json'), 'utf8')).apiBase !== `${PHONE_ORIGIN}/api`) return { reuse: false, reason: 'apiBase 不对', stamp } } catch { return { reuse: false, reason: 'forsion-native.json 坏了', stamp } }
  if (process.env.REMOTECHAIN_REUSE_DIST === '1') return { reuse: true, reason: 'REMOTECHAIN_REUSE_DIST=1(未比对源码)', stamp }
  if (!stamp) return { reuse: false, reason: '算不出源码戳(git 不可用)', stamp }
  let old = null
  try { old = JSON.parse(fs.readFileSync(path.join(dir, STAMP_FILE), 'utf8')) } catch { /* 无戳 = 来历不明 */ }
  if (!old?.stamp) return { reuse: false, reason: '构建没有源码戳(来历不明)', stamp }
  if (old.stamp !== stamp) return { reuse: false, reason: `源码变了(构建自 ${old.genesis || '?'} @ ${String(old.head || '?').slice(0, 8)})`, stamp }
  return { reuse: true, reason: '源码戳一致', stamp }
}

/** 取一份与当前源码一致的手机页构建(dev 风味、VITE_API_ORIGIN=phone-hub.test):戳一致就复用,否则现构建(约 1–2 分钟)。
 *  先建进 <dir>.tmp-<pid> 再换名(同一 worktree 两个台架同时跑也不会读到半截构建),戳在构建成功之后才写。 */
function buildPhoneDist(dir = defaultPhoneDistDir()) {
  const st = phoneDistStatus(dir)
  if (st.reuse) {
    console.log(`${process.env.REMOTECHAIN_REUSE_DIST === '1' ? 'WARN ' : ''}… 复用 mobile 构建 ${dir}(${st.reason})`)
    return dir
  }
  const tmp = `${dir}.tmp-${process.pid}`
  console.log(`… 构建 mobile(dev 风味、VITE_API_ORIGIN=${PHONE_ORIGIN};${st.reason})→ ${dir}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  const r = spawnSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', tmp, '--emptyOutDir'], {
    cwd: MOBILE, env: { ...process.env, NODE_ENV: 'development', VITE_API_ORIGIN: PHONE_ORIGIN }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  })
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`mobile 构建失败:\n${String(r.stderr).slice(-1500)}`) }
  // 构建期间源码又变了 → 这份仍按「构建开始时」的戳记;下次跑自然重建(戳对不上)
  if (st.stamp) fs.writeFileSync(path.join(tmp, STAMP_FILE), JSON.stringify({ stamp: st.stamp, genesis: GENESIS, head: git(['rev-parse', 'HEAD']).stdout.toString().trim(), builtAt: new Date().toISOString() }))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(tmp, dir)
  return dir
}

/** 页面 init script(在任何页面脚本之前跑)。 */
function capacitorInit({ token }) {
  try {
    localStorage.setItem('CapacitorStorage.forsion_token', token) // @capacitor/preferences web 实现的键前缀(group 'CapacitorStorage')
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('forsion_tangu_onboarding_dismissed', '1')
    localStorage.setItem('tangu-locale', 'zh')
  } catch { /* ignore */ }
  const cbs = new Map()
  let n = 0
  const P = (name) => ({ name, rtype: 'promise' })
  const C = (name) => ({ name, rtype: 'callback' })
  window.CapacitorCustomPlatform = { name: 'android', plugins: {} }
  window.Capacitor = {
    PluginHeaders: [
      { name: 'ForsionUnit', methods: [P('attach'), P('status'), P('ensureRegistered'), P('forget'), C('request'), P('cancel'), C('addListener'), P('removeListener')] },
      { name: 'LiveIsland', methods: [P('show'), P('reset'), C('addListener'), P('removeListener')] },
      { name: 'SpaceShortcuts', methods: [P('setSpaces'), P('pin'), C('addListener'), P('removeListener')] },
      // P1-DL:安卓 App 存「下载」走原生 ForsionDownloads(分块 begin / append / finish / abort),替身在 Node 侧收字节
      { name: 'ForsionDownloads', methods: [P('begin'), P('append'), P('finish'), P('abort')] },
    ],
    nativePromise: (plugin, method, options) => window.__k9Native({ plugin, method, options: options ?? {}, cbId: null }),
    nativeCallback: (plugin, method, options, cb) => {
      const id = `k9cb${++n}`
      cbs.set(id, cb)
      window.__k9Native({ plugin, method, options: options ?? {}, cbId: id }).catch((e) => { try { cb(null, e) } catch { /* ignore */ } })
      return id
    },
  }
  window.__k9Deliver = (id, msg, err) => { const cb = cbs.get(id); if (cb) cb(msg, err) }
}

/**
 * 起浏览器、装原生桥、打开手机页、等 connState ok。
 * @returns {{ browser, ctx, page, tap, pageErrors }}
 */
async function openPhonePage({ world, native, locale = 'zh-CN', colorScheme = 'light' }) {
  const browser = await chromium.launch({
    executablePath: findChromium(), headless: true,
    proxy: { server: `http://127.0.0.1:${world.hub.port}` },
    args: ['--no-sandbox', `--unsafely-treat-insecure-origin-as-secure=${PHONE_ORIGIN}`],
  })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale, colorScheme })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // 原生桥:页面 → Node 替身。request 的回调按序送回(每条一次 evaluate,SSE 分块逐条到达)
  // ForsionDownloads 替身:同真插件的分块协议;finish 落进 saved(台架据此核「手机上存下来的就是那份产物」)
  const saved = []
  const pending = new Map()
  let dlSeq = 0
  const downloads = {
    begin: ({ name, mime }) => { const id = `dl${++dlSeq}`; pending.set(id, { name, mime, parts: [] }); return { id } },
    append: ({ id, data }) => { const e = pending.get(id); if (!e) throw new Error('unknown_id'); const b = Buffer.from(data, 'base64'); e.parts.push(b); return { written: b.length } },
    finish: ({ id }) => { const e = pending.get(id); if (!e) throw new Error('unknown_id'); pending.delete(id); const bytes = Buffer.concat(e.parts); saved.push({ name: e.name, mime: e.mime, bytes }); return { name: e.name, size: bytes.length } },
    abort: ({ id }) => ({ ok: pending.delete(id) }),
  }
  await page.exposeBinding('__k9Native', async (_src, { plugin, method, options, cbId }) => {
    if (plugin === 'ForsionDownloads') {
      if (typeof downloads[method] !== 'function') throw new Error(`ForsionDownloads.${method} not implemented`)
      return downloads[method](options)
    }
    if (plugin !== 'ForsionUnit') return {}
    if (method === 'request') {
      let chain = Promise.resolve()
      const deliver = (msg) => { chain = chain.then(() => page.evaluate(([id, m]) => window.__k9Deliver(id, m), [cbId, msg]).catch(() => {})) }
      void native.request(options, deliver)
      return cbId
    }
    if (method === 'addListener' || method === 'removeListener') return cbId || {}
    if (typeof native[method] !== 'function') throw new Error(`ForsionUnit.${method} not implemented`)
    return native[method](options)
  })
  await ctx.addInitScript(capacitorInit, { token: world.PHONE_TOKEN })
  // 暗色截图:应用缺省明暗偏好是 light(不跟系统),光模拟 prefers-color-scheme 不够 —— 首屏前把偏好设成 system
  if (colorScheme === 'dark') await ctx.addInitScript(() => { try { if (!localStorage.getItem('forsion_theme_pref')) localStorage.setItem('forsion_theme_pref', 'system') } catch { /* 隐私模式 */ } })
  await page.goto(`${PHONE_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('.mb-shell', { timeout: 60_000 })
  await page.waitForFunction(() => window.__forsionStore?.getState().connState === 'ok', null, { timeout: 30_000 })
  const cdp = await ctx.newCDPSession(page)
  const tap = async (locator) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${locator}`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await sleep(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(350)
  }
  return { browser, ctx, page, tap, pageErrors, saved }
}

/** 左抽屉 → 互联入口 → UnitsSheet(打开时现拉一次名册);等 waitRow 那一行出现。 */
async function openUnitsSheet({ page, tap, waitRow }) {
  for (let i = 0; i < 6 && !(await page.locator('.mb-drawer--left.open').count()); i++) {
    await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
    await sleep(700)
  }
  const entry = page.locator('.mb-drawer--left.open .mb-foot-row [aria-label="Forsion Unit 切换"], .mb-drawer--left.open .mb-foot-row [aria-label="Switch Forsion Unit"]')
  await tap(entry.first())
  await page.waitForSelector(waitRow ? `[data-units-sheet] [data-run-row="${waitRow}"]` : '[data-units-sheet]', { timeout: 10_000 })
}

/** 关 UnitsSheet(点遮罩,同 closeOverlays 的第一步);等它从 DOM 里消失。 */
async function closeUnitsSheet(page) {
  await page.evaluate(() => { const s = document.querySelector('[data-units-sheet]'); if (s) s.click() })
  await page.waitForSelector('[data-units-sheet]', { state: 'detached', timeout: 5000 }).catch(() => {})
}

/** 打开 UnitsSheet,点那台电脑的「在哪运行」行(之后的懒登记 / 确认 / 切换由页面自己走)。 */
async function pickComputer({ page, tap, unitId }) {
  await openUnitsSheet({ page, tap, waitRow: unitId })
  await tap(page.locator(`[data-run-row="${unitId}"]`))
}

/** 收起弹层与抽屉(推开式抽屉的遮罩会拦住输入区)。 */
async function closeOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.evaluate(() => { const s = document.querySelector('[data-units-sheet]'); if (s) s.click() })
  await sleep(600)
  for (let i = 0; i < 4 && (await page.locator('.mb-push-dim.on').count()); i++) {
    const dim = page.locator('.mb-push-dim.on').first()
    const b = await dim.boundingBox()
    if (b) await dim.click({ position: { x: Math.max(1, b.width - 12), y: b.height / 2 }, force: true }).catch(() => {})
    await sleep(500)
  }
}

/** 等输入框可用后打字回车发出(可选先经「添加 › 文件」挂附件)。 */
async function compose(page, text, attach) {
  const ta = page.locator('.t2c-ta').first()
  await ta.waitFor({ timeout: 20_000 })
  for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await sleep(250)
  if (attach) {
    await page.locator('.add-pill-btn').first().click()
    await sleep(300)
    const item = page.locator('.composer-menu--add .menu-item').filter({ hasText: /文件|files/i }).first()
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      item.click({ timeout: 7000 }),
    ]).catch(async (e) => {
      // 留证:当时的界面 + 菜单项文字(界面语言 / 遮挡问题一眼可见)
      const dir = process.env.SHOT_DIR
      if (dir) await page.screenshot({ path: require('node:path').join(dir, 'compose-fail.png') }).catch(() => {})
      const items = await page.locator('.composer-menu--add .menu-item').allTextContents().catch(() => [])
      throw new Error(`${e?.message || e} | 菜单项 ${JSON.stringify(items)}`)
    })
    await chooser.setFiles(attach)
    await sleep(500)
  }
  await ta.click()
  await ta.fill(text)
}

module.exports = { PHONE_ORIGIN, findChromium, buildPhoneDist, phoneDistStamp, phoneDistStatus, defaultPhoneDistDir, STAMP_PATHS, capacitorInit, openPhonePage, openUnitsSheet, closeUnitsSheet, pickComputer, closeOverlays, compose }
