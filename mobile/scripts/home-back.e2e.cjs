/**
 * 移动端「Android 返回键把主页按没了」回归闸 —— `npm run e2e:homeback`(mobile 目录,先 npm run build)。
 *
 * 2026-08-30 用户实报「默认 Homepage View 空白,没有内容」。根因**不是主页渲染坏了**(它在任何
 * 尺寸/主题/冷热启动下都渲染得出内容,探针逐个证伪过),而是:
 *   `MobileRoot.useAndroidBack` 里判「已经在链底」的条件写的是 `active.type !== 'home'`,
 *   而 v2.9.0 的主页落地页类型叫 **`homepage`** —— 于是在主页上按一下系统返回 = `closeLeaf`,
 *   单列壳的 closeLeaf 对唯一主 leaf 是「就地变 `home` 空态占位」(只有 logo 和一个新建按钮),
 *   随后被 200ms 节流的 saveCurrent 存进 `lcl_sc_layout_v1` → **重启也回不来**。
 *
 * 全面屏安卓的返回是侧滑手势,谁都会在主页上误滑一下,所以这条一旦回退就是「开机即空白」。
 * 两侧都钉:
 *   1. 主页上按返回 → 还是主页(不是 `home` 空态)。
 *   2. **负对照**:非落地页的 tab 上按返回 → 照旧被关掉(没把返回键整个焊死)。
 *   3. **自愈**:把「只剩空态占位」的旧存档种进 localStorage 再启动 → 主页应当自己回来
 *      (applySCBlob 把纯占位的主区当空的,交回 buildDefault)—— 已经中招的用户升级后要能好。
 *
 * ⚠️ 浏览器台架里 Capacitor 的 `backButton` 不会自己发,靠 `Capacitor.Plugins.App.notifyListeners`
 *    直接打进 MobileRoot 那个真监听(WebPlugin 的公开方法,不是我们自己造的桩)。若哪天这条路
 *    不通,`fired.ok` 会是 false 并当场判红,不会假绿。
 *
 * 骨架照抄 drawer-drag.e2e.cjs(同一套 vite preview + 假 token)。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = 5297 // 避开 dev 5274 / boot 5279 / noteopen 5283 / editorbar 5285 / drawerdrag 5289
const URL = `http://localhost:${PORT}/`
const LAYOUT_KEY = 'lcl_sc_layout_v1'

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}
const ping = () => new Promise((res) => {
  const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }

  let browser = null
  const fails = []
  const ok = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
    if (!cond) fails.push(`${name}${detail ? ' | ' + detail : ''}`)
  }

  /** 一个干净的会话:seed 写进 localStorage,返回 page。 */
  const session = async (seed) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript((s) => {
      try {
        localStorage.setItem('forsion_token', 'e2e-homeback')
        localStorage.setItem('amadeus_vault_mode', 'local')
        for (const [k, v] of Object.entries(s || {})) localStorage.setItem(k, v)
      } catch { /* 隐私模式 */ }
    }, seed || {})
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // `CapApp.minimizeApp()` 在浏览器里必抛 "Not implemented on web" —— 那正是「返回走到了链底
    // 挂起 app 这一档」的**证据**,收进 seen 供断言,不算失败;其余未捕获异常照旧判红。
    const seen = []
    page.on('pageerror', (e) => {
      if (/not implemented on web/i.test(e.message)) { seen.push(e.message); return }
      fails.push(`未捕获异常: ${e.message}`)
    })
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4500)
    return { ctx, page, seen }
  }
  const view = (page) => page.evaluate(() => ({
    type: document.querySelector('.mb-view')?.getAttribute('data-view') ?? null,
    hp: !!document.querySelector('.hp-root'),
    empty: !!document.querySelector('.wb-home'),
  }))
  /** 打真返回键:走 Capacitor web 插件的 notifyListeners,命中 MobileRoot 注册的那个监听。 */
  const back = (page) => page.evaluate(() => {
    const P = window.Capacitor?.Plugins?.App
    if (!P || typeof P.notifyListeners !== 'function') return { ok: false, why: 'Capacitor.Plugins.App.notifyListeners 不可用' }
    P.notifyListeners('backButton', { canGoBack: false })
    return { ok: true }
  })

  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-500)}`)
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })

    // ── 1. 主页上按返回 → 还是主页;再启动一次也还是主页 ─────────────────────────────
    {
      const { ctx, page, seen } = await session()
      const start = await view(page)
      ok('0 起点:冷启动落在主页', start.type === 'homepage' && start.hp, JSON.stringify(start))
      const fired = await back(page)
      ok('1a 台架真的把 backButton 打进去了(不通就别信下面的绿)', fired.ok === true, JSON.stringify(fired))
      await page.waitForTimeout(1000)
      const after = await view(page)
      ok('1b ⚠️ 主页上按返回 → 还是主页,不许变成 home 空态占位',
        after.type === 'homepage' && after.hp && !after.empty, JSON.stringify(after))
      // 光「主页还在」还不够:也可能是返回链在更早一环被别的东西吃掉了。minimizeApp 在浏览器里
      // 必抛 "Not implemented on web",抛了才说明真的走到了链底那一档(= 安卓上会挂起 app)。
      ok('1d 返回走到了链底「挂起 app」那一档(而不是被链上某环静默吃掉)',
        seen.some((m) => /not implemented on web/i.test(m)), JSON.stringify(seen))
      await page.waitForTimeout(500) // 让 saveCurrent 的 200ms 节流落一次盘
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(4500)
      const relaunch = await view(page)
      ok('1c 重启后依旧是主页(空白态一旦被存盘就再也回不来,所以这条必须一起钉)',
        relaunch.type === 'homepage' && relaunch.hp, JSON.stringify(relaunch))
      await ctx.close()
    }

    // ── 2. 负对照:非落地页的 tab 上按返回,照旧关掉 ──────────────────────────────────
    // 启动落点改到 Tangu Space(主位槽键),主区是会话不是主页 → 返回应当把它关成空态。
    {
      const { ctx, page } = await session({ forsion_home_slot_space: 'tangu' })
      const start = await view(page)
      ok('2a 负对照起点:落在 Tangu Space(主区不是主页)', start.type === 'chat', JSON.stringify(start))
      if (start.type === 'chat') {
        await back(page)
        await page.waitForTimeout(1000)
        const after = await view(page)
        ok('2b ⚠️ 负对照:非落地页上返回照旧关掉它(证明没把返回键整个焊死)',
          after.type === 'home' && after.empty, JSON.stringify(after))
      }
      await ctx.close()
    }

    // ── 3. 自愈:已经存成「只剩空态占位」的旧存档,启动时要被丢弃并重建主页 ─────────────
    {
      const blank = JSON.stringify({
        v: 1,
        main: [{ id: 'leaf-blank', type: 'home', loc: 'main', params: {}, title: '新建标签页' }],
        left: [], right: [], activeMainId: 'leaf-blank', leftActiveId: null, rightActiveId: null,
      })
      const { ctx, page } = await session({ [LAYOUT_KEY]: blank })
      const healed = await view(page)
      ok('3 ⚠️ 自愈:主区只剩 home 空态占位的旧存档 → 交回 buildDefault,主页自己回来',
        healed.type === 'homepage' && healed.hp && !healed.empty, JSON.stringify(healed))
      await ctx.close()
    }
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close()
    killPreview()
  }

  console.log(fails.length ? `\n✗ ${fails.length} 条未通过:\n- ${fails.join('\n- ')}` : '\n✓ 全绿')
  process.exit(fails.length ? 1 : 0)
}

main()
