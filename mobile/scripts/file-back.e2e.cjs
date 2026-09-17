/**
 * 移动端「笔记里打开 PDF / 仪表盘,按返回回到笔记」回归闸 —— `npm run e2e:fileback`(mobile 目录,先 npm run build)。
 *
 * 2026-09-16:`bootstrapEngine` 那条 mainTabs 订阅(文件类 / 功能视图的 per-tab 历史 + 「最近使用」)
 * 原先只认 `activeMainPanel(api)`,而单列壳 `api` 恒 null → 手机上一条都不记:笔记 → 就地开 PDF →
 * 返回,栈里只有笔记那一条(idx 0)→ `useAndroidBack` 走到 closeLeaf,**标签被关成空态,笔记丢了**。
 * 仪表盘当时靠 amadeusViews 笔记订阅顺手记的 `amadeus:X.dashboard.md` 碰巧能退;修好 mainTabs 那条后
 * 笔记订阅必须**两壳都**跳过仪表盘,否则同页两条 → 返回空按一下(仍停在仪表盘)、最近使用重复。
 *
 * 一次返回就要回到笔记,且编辑器里是**那篇笔记**(光看 data-view 是假绿:修前复原 `amadeus:X.dashboard.md`
 * 也会落进编辑器,只是装的是仪表盘文件)。负对照(09-16 实跑):纯 HEAD → PDF 那条红(关成 home);
 * 只修 mainTabs、笔记订阅仍按 api 放行 → 仪表盘那条红(空按)+ 最近使用重复。
 *
 * 第 4 段(同日晚):切 Space 往返后的历史 —— 换布局清栈、但还原出来的前台文件视图要有栈底,见段内注释。
 *
 * 骨架照抄 home-back.e2e.cjs(返回键)+ note-open.e2e.cjs(种库 / 抽屉点行)。
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
const { tinyPdf } = require('../../desktop/scripts/lib/tiny-pdf.cjs')

const PORT = 5293 // 避开 dev 5274 / boot 5279 / unitsentry 5281 / noteopen 5283 / editorbar 5285 / drawerdrag 5289 / spacetrap 5291 / homeback 5297
const URL = `http://localhost:${PORT}/`
const NOTE = 'e2e笔记', PDF = 'e2e文档.pdf', DASH = 'e2e看板'

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

  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-500)}`)
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-fileback')
        localStorage.setItem('amadeus_vault_mode', 'local')
      } catch { /* ignore */ }
      // MobileRoot 的返回监听第一步就派发 forsion:mobile-back —— 数它,才知道这一下真打进去了。
      window.__backSeen = 0
      window.addEventListener('forsion:mobile-back', () => { window.__backSeen++ })
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const cdp = await ctx.newCDPSession(page)
    const tap = async (locator) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error('目标不可见')
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const state = () => page.evaluate(() => {
      const t = document.querySelector('.amx-doc input, .amx-doc textarea, .amx-doc [contenteditable]')
      return {
        view: document.querySelector('.mb-main .mb-view')?.getAttribute('data-view') ?? null,
        title: ((t && ('value' in t ? t.value : t.textContent)) || '').trim(),
        drawer: !!document.querySelector('.mb-drawer--left.open'),
      }
    })
    /** 打真返回键(见 home-back.e2e),返回「MobileRoot 的监听真的跑了」。 */
    const back = async () => {
      const n0 = await page.evaluate(() => window.__backSeen)
      await page.evaluate(() => window.Capacitor?.Plugins?.App?.notifyListeners?.('backButton', { canGoBack: false }))
      await page.waitForTimeout(1500)
      return (await page.evaluate(() => window.__backSeen)) > n0
    }
    /** 左抽屉里点名字含 name 的行(抽屉没开先开;点完行抽屉会自动收回)。 */
    const openRow = async (name) => {
      if (!(await page.$('.mb-drawer--left.open'))) { await tap(page.locator('.mb-topbar .mb-icon-btn').first()); await page.waitForTimeout(600) }
      const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: name }).first()
      // locator.boundingBox() 会自己等满 30s 才抛 —— 先短等,不在就把现有行打出来。
      if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false))) {
        const rows = await page.$$eval('.mb-drawer--left .t2s-srow', (els) => els.slice(0, 12).map((e) => e.textContent.trim()))
        throw new Error(`抽屉里没有「${name}」行(现有: ${rows.join(' / ')})`)
      }
      await tap(row)
      await page.waitForTimeout(1500)
    }

    // 种库:笔记 + 库根 PDF + 仪表盘,然后重开(预热早把空库读进 store 了,见 note-open 同款告警)。
    // PDF 走 writeTextFile:tinyPdf 是纯 ASCII,逐字节等价(当初为绕开 saveAttachment 碰 process.cwd() 的崩溃,60d5ed90 已修)。
    const pdf = tinyPdf(['e2e fileback']).toString('latin1')
    await page.evaluate(async ({ NOTE, PDF, DASH, pdf }) => {
      await window.amadeus.newPage(`${NOTE}.md`)
      await window.amadeus.writeTextFile(PDF, pdf)
      await window.amadeus.writeTextFile(`${DASH}.dashboard.md`, `---\ntitle: ${DASH}\n---\n`)
    }, { NOTE, PDF, DASH, pdf })

    // 重开 → 进 Note Space(按 data-space 选,文案会随语言变)→ 抽屉开着时按返回探一发:应当收抽屉。
    // ⚠️ 浏览器台架里 @capacitor/app 走 web 实现,而 Capacitor core 的 loadPluginImplementation 没有并发去重:
    //    启动时 mobileShim / spaceShortcuts / capacitorAuth / MobileRoot 同时首调 App.*,各 new 一个 AppWeb,
    //    返回监听可能挂在被后来者覆盖掉的实例上 → 这次页面加载里的返回键全打不到(09-16 实测约 1/4 次)。
    //    原生壳走 bridge,没有这个竞态。探不通就重开页面(每次加载只赌一次)。
    let delivered = false
    for (let attempt = 1; attempt <= 4 && !delivered; attempt++) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(4000)
      await tap(page.locator('.mb-topbar .mb-icon-btn').first())
      await page.waitForTimeout(600)
      const spaces = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.dataset.space || ''))
      const idx = spaces.indexOf('amadeus')
      if (idx < 0) throw new Error(`左抽屉底部没有 amadeus space tab(现有: ${spaces.join(',')})`)
      await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
      await page.waitForTimeout(900)
      if (!(await page.$('.mb-drawer--left.open'))) { await tap(page.locator('.mb-topbar .mb-icon-btn').first()); await page.waitForTimeout(600) }
      delivered = (await back()) && !(await page.$('.mb-drawer--left.open'))
      if (!delivered) console.log(`  (第 ${attempt} 次加载:返回键没打进 MobileRoot —— Capacitor web 插件并发加载竞态,重开页面)`)
    }
    if (!delivered) throw new Error('连续 4 次页面加载返回键都打不进 MobileRoot(抽屉开着按返回没收),下面的断言没法信')

    await openRow(NOTE)
    const s0 = await state()
    ok('0 起点:主区是编辑器,装着笔记', s0.view === 'amadeus-editor' && s0.title === NOTE, JSON.stringify(s0))

    // ── 1. 笔记 → 就地开 PDF → 返回 ──
    await openRow(PDF)
    const s1 = await state()
    ok('1a 抽屉点 PDF → 同一标签就地切成 PDF 视图,抽屉已收(否则返回先被抽屉吃掉)', s1.view === 'amadeus-pdf' && !s1.drawer, JSON.stringify(s1))
    ok('1b 这一下返回真的打进了 MobileRoot(不通就别信下面的红绿)', await back())
    const s1b = await state()
    ok('1c ⚠️ PDF 上按一次返回 → 回到那篇笔记(修前:栈里没有 PDF 那条,返回把标签关成 home)',
      s1b.view === 'amadeus-editor' && s1b.title === NOTE, JSON.stringify(s1b))

    // ── 2. 笔记 → 就地开仪表盘 → 返回(只按一次)──
    if (s1b.view !== 'amadeus-editor' || s1b.title !== NOTE) await openRow(NOTE) // 让第 2 段独立于第 1 段的成败
    await openRow(DASH)
    const s2 = await state()
    ok('2a 抽屉点仪表盘 → 同一标签就地切成仪表盘,抽屉已收', s2.view === 'dashboard' && !s2.drawer, JSON.stringify(s2))
    ok('2b0 这一下返回真的打进了 MobileRoot', await back())
    const s2b = await state()
    ok('2b ⚠️ 仪表盘上按一次返回 → 回到那篇笔记(同页记两条时这一下是空按,还停在仪表盘)',
      s2b.view === 'amadeus-editor' && s2b.title === NOTE, JSON.stringify(s2b))

    // ── 3. 最近使用:文件视图记进去了,仪表盘只有一条 ──
    const recent = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('forsion_tangu_recent_views') || '[]').map((i) => i.key) } catch { return [] } })
    ok('3a 最近使用里有 PDF(修前手机上文件视图一条都不记)', recent.includes(`file:amadeus-pdf:${PDF}`), JSON.stringify(recent))
    const dashKeys = recent.filter((k) => k.includes(`${DASH}.dashboard`))
    ok('3b 最近使用里仪表盘恰好一条 file:dashboard:*(没有 note:*.dashboard.md 重复)',
      dashKeys.length === 1 && dashKeys[0] === `file:dashboard:${DASH}.dashboard.md`, JSON.stringify(dashKeys))

    // ── 4. 切 Space 往返:换布局时清历史,但还原出来的前台文件视图要有栈底 ──
    // 09-16 起单列 store 在 applyNamed(applySCBlob)/ resetLayout 里自己清;setActiveSpace 结尾那次 reset 删了 ——
    // 它跑在重建之后,会把还原出来的前台视图刚记的栈底一起清掉(桌面 active-tab.e2e 的 S3/D1 就是它)。
    // 手机上 4c 在修前也是绿的(实测),这一段真正钉的是 4d:删了结尾 reset 却没在单列 store 里补清 →
    // 切换前的笔记条目串进来,第二下返回退回笔记(负对照实跑 4d 红)。
    const switchSpace = async (id) => {
      if (!(await page.$('.mb-drawer--left.open'))) { await tap(page.locator('.mb-topbar .mb-icon-btn').first()); await page.waitForTimeout(600) }
      const all = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.dataset.space || ''))
      if (!all.includes(id)) throw new Error(`左抽屉底部没有 ${id} space tab(现有: ${all.join(',')})`)
      await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${all.indexOf(id)}`))
      await page.waitForTimeout(1200)
    }
    await openRow(PDF) // 栈:[笔记, PDF]
    await switchSpace('tangu')
    await switchSpace('amadeus')
    const s4 = await state()
    ok('4a 切到 Tangu 再切回 Note:PDF 还原在前台', s4.view === 'amadeus-pdf', JSON.stringify(s4))
    await openRow(NOTE) // 就地开笔记,点行顺带收抽屉
    ok('4b 这一下返回真的打进了 MobileRoot', await back())
    const s4c = await state()
    ok('4c 往返后就地开笔记再返回 → 回到还原出来的 PDF(栈底得在)',
      s4c.view === 'amadeus-pdf', JSON.stringify(s4c))
    ok('4d0 这一下返回真的打进了 MobileRoot', await back())
    const s4d = await state()
    ok('4d ⚠️ 再返回 → 到栈底关掉标签,不许退回切 Space 之前的笔记(没清历史 = 串栈)', s4d.view !== 'amadeus-editor', JSON.stringify(s4d))
    await ctx.close()
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }

  console.log(fails.length ? `\n✗ ${fails.length} 条未通过:\n- ${fails.join('\n- ')}` : '\n✓ 全绿')
  process.exit(fails.length ? 1 : 0)
}

main()
