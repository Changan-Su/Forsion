/**
 * 移动端「点列表行能不能真打开」e2e —— `npm run e2e:noteopen`(mobile 目录,先 npm run build)。
 *
 * 起因(2026-08-05):移动端 Amadeus 点笔记行「有按压反馈但没打开」。根因是单列壳 LeafHost
 * 只订阅 active leaf 的 id+type,而主区就地导航在「编辑器→编辑器」时只换 params.notePath ——
 * 宿主不重渲,编辑器永远不知道要换笔记。Amadeus space 主区恒为编辑器,故该 space 100% 中招。
 *
 * 断言链(真 touch 事件,手机视口):
 *  1. 种两篇笔记 → **重开页面**(见下)→ 进 Amadeus space(此时主区已是 amadeus-editor);
 *  2. 切 Space 后左抽屉**留着**(2026-08-13 拍板);
 *  3. 抽屉里 touch 点「甲」/「乙」 → 编辑器标题跟着换、点完抽屉自动收回;
 *  4. **横屏 docked 左栏**里再点一遍 → 这一档才是 params-only 的独木桥(见该段注释)。
 *
 * ⚠️ 2026-08-25 大修一轮,三处坑都记在正文的注释里,别再踩:
 *  - 第 2 步原本钉的是改版**前**的「切完自动收回」,自 08-13 起一直红着(CI 只跑 e2e:boot,没人跑这台);
 *  - 种完笔记必须重开页面(newPage 走桥、绕过 pageStore,而工作区预热早把空库读进去了);
 *  - 竖屏那两发**证明不了**当年那个病灶(点行收抽屉 → Host 自己重渲,把 LeafHost 的订阅盖过去了),
 *    所以补了第 4 步;负对照实测:改坏 params 订阅 → 只有第 4 步会红。
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

const PORT = 5283 // 避开 dev 5274 / boot-e2e 5279
const URL = `http://localhost:${PORT}/`

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
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-500)}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    // 假 token 过登录闸(同 mobile-boot.e2e);本地库模式(Capacitor FS 的 web 实现 = IndexedDB,免真机)。
    await ctx.addInitScript(() => {
      try { localStorage.setItem('forsion_token', 'e2e-note-open'); localStorage.setItem('amadeus_vault_mode', 'local') } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const cdp = await ctx.newCDPSession(page)
    const tapBox = async (b) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const tap = async (locator) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error('目标不可见')
      await tapBox(b)
    }
    /** 编辑器标题控件的当前值(input/textarea/contenteditable 三种形态都接)。 */
    const editorTitle = () => page.evaluate(() => {
      const t = document.querySelector('.amx-doc input, .amx-doc textarea, .amx-doc [contenteditable]')
      return ((t && ('value' in t ? t.value : t.textContent)) || '').trim()
    })

    await page.evaluate(async () => { await window.amadeus.newPage('e2e甲.md'); await window.amadeus.newPage('e2e乙.md') })
    // ⚠️ 种完必须重开一次页面。newPage 走的是**桥**,绕过了 pageStore —— 而 MobileRoot 的工作区预热
    // (启动后 1.2s 的 ensureAmadeusReady)早就把当时还空的库读进 store 了,直接往下走树里恒 0 行。
    // (库里确实有,诊断打印的「库里页数」就是 listPages() 读的。)重开 = 冷启动读一个已经有笔记的库,
    // 也更贴近真实用法。此前预热是懒的(首开抽屉才 restoreVault),晚于种笔记,所以这台仪器当年是绿的。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)

    // 进 Amadeus space:Space 切换条在**左抽屉底部**(2026-08-05 改版)→ 先开抽屉再点。
    await tap(page.locator('.mb-topbar .mb-icon-btn').first())
    await page.waitForTimeout(600)
    const tabs = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.textContent.trim()))
    const idx = tabs.findIndex((t) => /amadeus|笔记/i.test(t))
    if (idx < 0) throw new Error(`左抽屉底部没有 Amadeus space tab(现有: ${tabs.join(',')})`)
    await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
    await page.waitForTimeout(900)
    // 切 Space **留在左抽屉里**(2026-08-13 用户拍板:切完接着在面板里找东西,不要被甩回主区)。
    // switchSpaceKeepDrawer:resetLayout 把 leftVisible 复位,它随后再开一次(新 Space 有左栏内容才开;
    // Amadeus 有 —— AMADEUS_SIDE_VIEWS.left 三项)。
    // ⚠️ 这里原本钉的是改版**前**的「切完自动收回」,自 08-13 起一直红着没人发现 —— CI 的
    //    build-android 只跑 e2e:boot,这台仪器只在本地手动跑(2026-08-25 修正)。
    if (!(await page.$('.mb-drawer--left.open'))) fails.push('切 Space 后左抽屉没留住(2026-08-13 拍板:切完留在面板里)')

    /** 抽屉开着就别再点了 —— 顶栏那颗是 toggle,状态已对时再点一下等于关掉它。
     *  切 Space 后抽屉是开着的、点完笔记行又会自动收回,两种前置状态都要能接上。 */
    const ensureDrawerOpen = async () => {
      if (await page.$('.mb-drawer--left.open')) return
      await tap(page.locator('.mb-topbar .mb-icon-btn').first())
      await page.waitForTimeout(600)
    }

    /** 开抽屉 → touch 点名为 name 的笔记行 → 断言编辑器装入它且抽屉收回。
     *  ⚠️ push 形态抽屉容器**恒挂载**(开合动画需要),开没开只认 .open 类。 */
    const openAndAssert = async (name, label) => {
      await ensureDrawerOpen()
      if (!(await page.$('.mb-drawer--left.open'))) { fails.push(`${label}: 左抽屉没开`); return }
      const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: name }).first()
      // ⚠️ 先短等一发再取 boundingBox:locator 的 boundingBox() 会**自己等满 30s 再抛**,
      //    于是「行不在」这条路径永远走不到下面那句诊断,只留一条读不懂的 Timeout(踩过)。
      const there = await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
      if (!there) {
        // 三个量足够分诊:面板选错了 / 库里压根没笔记 / 库里有但树没渲染出来。
        const seen = await page.evaluate(async () => {
          const sel = document.querySelector('.mb-drawer--left .mb-drawer-select')
          const title = document.querySelector('.mb-drawer--left .mb-drawer-title')
          let vault = null
          try { const l = await window.amadeus?.listPages?.(); vault = Array.isArray(l) ? l.length : String(l) } catch (e) { vault = 'ERR ' + e.message }
          return {
            面板: sel ? [...sel.options].map((o) => o.text + (o.value === sel.value ? '*' : '')) : (title ? title.textContent.trim() : null),
            行: [...document.querySelectorAll('.mb-drawer--left .t2s-srow')].slice(0, 12).map((r) => r.textContent.trim()),
            库里页数: vault,
            抽屉正文: (document.querySelector('.mb-drawer--left .mb-drawer-body')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
          }
        })
        fails.push(`${label}: 抽屉里没有「${name}」行 | ${JSON.stringify(seen)}`)
        return
      }
      const b = await row.boundingBox()
      if (!b) { fails.push(`${label}: 「${name}」行取不到几何`); return }
      await tapBox(b)
      await page.waitForTimeout(1100)
      const got = await editorTitle()
      if (got !== name) fails.push(`${label}: 点了「${name}」,编辑器却是「${got || '(空)'}」—— 行点开没生效`)
      if (await page.$('.mb-drawer--left.open')) fails.push(`${label}: 点行后抽屉没有自动收回`)
    }

    await openAndAssert('e2e甲', '首开(type 变化路径)')
    await openAndAssert('e2e乙', '连续切换(编辑器→编辑器)')

    // ⚠️ 上面两发**盖不住**当年那个病灶(2026-08-25 实测:把 LeafHost 的 params 订阅改坏,竖屏两发
    //    照样全绿)。原因:点行会自动收抽屉 → leftVisible 变 → SingleColumnHost 自己重渲 → 它 JSX 里的
    //    LeafHost 跟着重渲,于是 getState() 读到的新 params 照样进得去,订阅坏了也看不出来。
    //    宽屏(>4:3)左栏是 docked 常驻、点行**不收**,主区换笔记时 Host 一点状态都没变 —— 只有
    //    LeafHost 真订阅了 params 对象身份才喂得进新笔记。这才是 params-only 的独木桥。
    await page.setViewportSize({ width: 844, height: 390 })
    await page.waitForTimeout(1000)
    if (!(await page.$('.mb-sidecol'))) { // 宽屏进来左栏应自动并排展开;没有就自己开一次
      await tap(page.locator('.mb-topbar .mb-icon-btn').first())
      await page.waitForTimeout(700)
    }
    // 捕获阶段记一笔「click 到底落在谁身上」——「编辑器没换」有两种可能(点没点中 / 点中了但没导航),
    // 光看行高亮分不开(高亮跟的是编辑器当前文件,不是这一下点击)。
    await page.evaluate(() => {
      window.__hits = []
      document.addEventListener('click', (e) => {
        const t = e.target
        const r = t && t.closest && t.closest('.t2s-srow')
        window.__hits.push(r ? 'ROW:' + r.textContent.trim().slice(0, 8) : (t && t.tagName ? t.tagName + '.' + String(t.className).slice(0, 24) : '?'))
      }, true)
    })
    const dockRow = async (name, label) => {
      const row = page.locator('.mb-sidecol .t2s-srow', { hasText: name }).first()
      const there = await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
      if (!there) { fails.push(`${label}: docked 左栏里没有「${name}」行`); return }
      await page.evaluate(() => { window.__hits = [] })
      // ⚠️ 这里用 Playwright 的 locator.tap() 而不是上面那套 CDP touch:`setViewportSize` 之后
      //    CDP 发的 touch 不再合成 click(实测「这一下点到了: []」—— 一个事件都没有),竖屏那套
      //    在这儿会静默空转,把「点没点中」伪装成「导航没生效」。locator.tap() 自己管触摸模拟。
      await row.tap()
      await page.waitForTimeout(1100)
      if (!(await page.$('.mb-sidecol'))) { fails.push(`${label}: 宽屏 docked 左栏被收掉了(它不该收)`); return }
      const got = await editorTitle()
      if (got !== name) {
        // 分诊:行有没有被点中(.active 跟着走了没)/ 是不是开去了别的 tab / 主区还是不是编辑器。
        const seen = await page.evaluate(() => ({
          这一下点到了: window.__hits,
          高亮行: [...document.querySelectorAll('.mb-sidecol .t2s-srow.active')].map((r) => r.textContent.trim()),
          主区视图: document.querySelector('.mb-main .mb-view')?.getAttribute('data-view') ?? null,
          标签数: document.querySelector('.mb-tabcount')?.textContent ?? null,
        }))
        fails.push(`${label}: 点了「${name}」,编辑器却是「${got || '(空)'}」—— LeafHost 没收到新 params | ${JSON.stringify(seen)}`)
      }
    }
    await dockRow('e2e甲', '宽屏 docked(params-only 独木桥)')
    await dockRow('e2e乙', '宽屏 docked(params-only 独木桥)')
  } catch (e) {
    fails.push(String(e && e.message || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:noteopen\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:noteopen —— 移动端点笔记行:两连切换都真打开,抽屉自动收回')
}

main()
