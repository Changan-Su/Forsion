/**
 * 移动端 Amadeus 编辑器「胶囊底栏 + 双列块面板 + 动作 sheet」e2e —— `npm run e2e:editorbar`
 * (mobile 目录,先 npm run build)。2026-08-13 改版的仪器。
 *
 * 钉三件事(都是纯推演验不出来的):
 *  1. 顶栏(面包屑那行 .amx-toolbar)在移动端**整行不渲染**,而「上传」用的隐藏 <input type=file>
 *     仍在场 —— 那个 input 原本寄生在顶栏里,顶栏一藏 ref 就是 null,上传会静默失效(改版时的头号坑)。
 *  2. 底栏是悬浮胶囊,「⋯」弹出的 sheet 里能找回原顶栏那排动作(源码切换/置顶/收藏/导出/删除…)。
 *  3. 「+」不再往正文里打「/」:收键盘 → 在键盘位置开双列块面板 → 点「标题 1」真把当前块转成 H1。
 *     清单取自 SLASH_ITEMS(与桌面 slash 菜单同源),这里顺带断言双列与分组标题都在。
 *
 * 骨架照抄 note-open.e2e.cjs(同一套 vite preview + 假 token + CDP 真 touch)。
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

const PORT = 5285 // 避开 dev 5274 / boot 5279 / noteopen 5283
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
      try { localStorage.setItem('forsion_token', 'e2e-capsule'); localStorage.setItem('amadeus_vault_mode', 'local') } catch { /* ignore */ }
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
    /** 关 sheet 专用:点**遮罩顶部**而不是它的几何中心 —— 遮罩铺满全屏,而 sheet 从底部长上来,
     *  动作多加一条(2026-08-20 加画布项时实测)中心就落进 sheet 里,变成误点某一行(当时点到了
     *  删除笔记,后面全线超时)。顶部 60px 恒在 sheet 之上。 */
    const closeSheet = async () => {
      const b = await page.locator('.mb-sheet-scrim').boundingBox()
      if (!b) return
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + 60 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }

    // 进 Amadeus space(Space 切换条在左抽屉底部)→ 用侧栏自己的「新建笔记」开一篇。
    // ⚠️ 不走 window.amadeus.newPage():那条只写库、不通知侧栏刷新结构,列表里根本不出现(实测)。
    await tap(page.locator('.mb-topbar .mb-icon-btn').first())
    await page.waitForTimeout(600)
    const tabs = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.textContent.trim()))
    const idx = tabs.findIndex((t) => /amadeus|笔记/i.test(t))
    if (idx < 0) throw new Error(`左抽屉底部没有 Amadeus space tab(现有: ${tabs.join(',')})`)
    await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
    await page.waitForTimeout(900)
    await tap(page.locator('.mb-topbar .mb-icon-btn').first())
    await page.waitForTimeout(600)
    // ⚠️ 2026-08-20 从「抽屉里的新建笔记」改成**欢迎页**那颗:抽屉那条在本台架里已经建不出笔记
    //    (点完 .t2s-srow 一行都不多,主区仍停在欢迎页),而欢迎页这颗直接 myPs().createPage()。
    //    抽屉那条为什么不灵是另一码事,跟本文件钉的三件事无关 —— 别为了它把台架卡在这儿。
    await tap(page.locator('.amx-welcome-btn', { hasText: '新建笔记' }).first())
    await page.waitForTimeout(1800)
    if (!(await page.$('.amx-editor .page-view'))) throw new Error('新建笔记后主区没有出现编辑器')
    // 「新建笔记」不收抽屉(既有行为,与本次改动无关),而**点笔记行**会自动收(note-open e2e 钉着)。
    // 所以再开一次抽屉、点刚建那行进来 —— 主区不带 push 位移,后面的几何与截图才是真状态。
    const rowName = await page.$eval('.mb-drawer--left .t2s-srow.active, .mb-drawer--left .t2s-srow', (e) => e.textContent.trim())
    await tap(page.locator('.mb-topbar .mb-icon-btn').first())
    await page.waitForTimeout(700)
    await tap(page.locator('.mb-drawer--left .t2s-srow', { hasText: rowName }).first())
    await page.waitForTimeout(1200)
    const shell = await page.evaluate(() => ({
      drawerOpen: !!document.querySelector('.mb-drawer--left.open'),
      push: document.querySelector('.mb-body')?.className,
      // ⚠️ 回归点:.mb-body 若是 overflow:hidden 就仍是个滚动容器(被 transform 推出去的抽屉照样计入
      //    可滚动溢出),浏览器给焦点做 scrollIntoView 会把它横滚,整个主区连浮动顶栏一起滑出屏幕。
      //    正解是 overflow:clip(压根不建滚动容器)。这里钉 scrollLeft 恒 0。
      bodyScrollLeft: document.querySelector('.mb-body')?.scrollLeft,
      capLeft: document.querySelector('.mb-cap')?.getBoundingClientRect().left,
      mainLeft: document.querySelector('.mb-main')?.getBoundingClientRect().left,
    }))
    ok('0 抽屉已收 + .mb-body 没被横滚(main 与胶囊都在屏内,后续几何/截图才可信)',
      !shell.drawerOpen && !/push-/.test(shell.push || '') && shell.bodyScrollLeft === 0 && shell.mainLeft === 0 && shell.capLeft > 0 && shell.capLeft < 20,
      JSON.stringify(shell))

    // ── 1. 顶栏整行隐藏,但隐藏的上传 input 仍在场 ──────────────────────────────
    const t1 = await page.evaluate(() => ({
      toolbar: document.querySelectorAll('.amx-editor .amx-toolbar').length,
      crumbs: document.querySelectorAll('.amx-crumbs').length,
      upload: document.querySelectorAll('.amx-editor input[type=file]').length,
      bar: document.querySelectorAll('.amx-mbar').length,
      barPos: document.querySelector('.amx-mbar') && getComputedStyle(document.querySelector('.amx-mbar')).position,
      barRadius: document.querySelector('.amx-mbar') && getComputedStyle(document.querySelector('.amx-mbar')).borderRadius,
    }))
    ok('1a 顶栏(面包屑那行)在移动端不渲染', t1.toolbar === 0 && t1.crumbs === 0, `toolbar=${t1.toolbar} crumbs=${t1.crumbs}`)
    ok('1b ⚠️ 上传用的隐藏 <input type=file> 仍在场(它原本寄生在顶栏里)', t1.upload === 1, `input=${t1.upload}`)
    ok('1c 底栏是悬浮胶囊', t1.bar === 1 && t1.barPos === 'absolute' && parseFloat(t1.barRadius) > 100, `${t1.barPos} r=${t1.barRadius}`)

    // ── 2. 「⋯」sheet 收下了原顶栏那排动作 ───────────────────────────────────
    await tap(page.locator('.amx-mbar button[title="更多操作"]'))
    await page.waitForTimeout(500)
    const rows = await page.$$eval('.mb-sheet .mb-sheet-row', (els) => els.map((e) => e.textContent.trim()))
    const want = ['源码', '上传文件到本页', '置顶', '收藏', '导出为 PDF', '在文件管理器中显示', '删除笔记']
    const missing = want.filter((w) => !rows.some((r) => r.includes(w)))
    ok('2 「⋯」sheet 收下了原顶栏 + 原「更多操作」的全部动作', missing.length === 0, missing.length ? `缺:${missing.join('/')}(现有:${rows.join('|')})` : rows.join(' | '))
    // 一个功能一个入口:画布搬进常驻胶囊后,「⋯」里不许再留一条(用户 2026-08-20 拍板)。
    ok('2b 「⋯」里没有重复的画布条目', !rows.some((r) => r.includes('画布')), rows.join(' | '))
    await closeSheet()

    // ── 3. 「+」→ 双列块面板 → 真插块 ────────────────────────────────────────
    await tap(page.locator('.page-view .ProseMirror').first())
    await page.waitForTimeout(300)
    // CDP 触摸落到空段落上不一定把 contenteditable 真聚焦(headless 无软键盘)→ 显式 focus 再打字。
    await page.evaluate(() => document.querySelector('.page-view .ProseMirror')?.focus())
    await page.waitForTimeout(200)
    await page.keyboard.type('转成标题')
    await page.waitForTimeout(500)

    await tap(page.locator('.amx-mbar button[title="插入块"]'))
    await page.waitForTimeout(600)
    const p = await page.evaluate(() => {
      const el = document.querySelector('.amx-bpick')
      if (!el) return null
      const items = [...el.querySelectorAll('.amx-bpick-item')]
      const lefts = new Set(items.map((i) => Math.round(i.getBoundingClientRect().left)))
      const r = el.getBoundingClientRect()
      return {
        n: items.length,
        cols: lefts.size,
        labels: [...el.querySelectorAll('.amx-bpick-label')].map((x) => x.textContent.trim()),
        names: items.slice(0, 4).map((x) => x.textContent.trim()),
        rect: r.toJSON(),
        vh: window.innerHeight,
        slashInDoc: (document.querySelector('.page-view .ProseMirror')?.textContent || '').includes('/'),
      }
    })
    ok('3a 「+」开出块面板', !!p, p ? `${p.n} 项` : '没开出来')
    if (p) {
      ok('3b 面板是双列', p.cols === 2, `列数=${p.cols}`)
      ok('3c 面板贴屏底、占住键盘那块地', Math.abs(p.rect.bottom - p.vh) < 2 && p.rect.height > 150, `bottom=${p.rect.bottom} vh=${p.vh} h=${p.rect.height.toFixed(0)}`)
      ok('3d 清单取自 SLASH_ITEMS(分组标题 + 头几项对得上)', p.labels.includes('基础') && p.names.includes('文本') && p.names.includes('标题 1'), `${p.labels.join('/')} → ${p.names.join(',')}`)
      ok('3e ⚠️ 没有往正文里打「/」(旧做法是 execCommand 插字符)', !p.slashInDoc, `slashInDoc=${p.slashInDoc}`)
    }

    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-editorbar-'))
    await page.screenshot({ path: path.join(shotDir, 'block-picker.png') })
    console.log('screenshot →', path.join(shotDir, 'block-picker.png'))

    await tap(page.locator('.amx-bpick-item', { hasText: '标题 1' }).first())
    await page.waitForTimeout(900)
    const after = await page.evaluate(() => ({
      h1: !!document.querySelector('.page-view .ProseMirror h1'),
      // 光标在标题行时会**露出字面 `# `**(headingSource 的设计,见 e2e:editor T35)→ 断言前剥掉。
      h1text: (document.querySelector('.page-view .ProseMirror h1')?.textContent ?? '').replace(/^#+\s*/, '').trim(),
      text: (document.querySelector('.page-view .ProseMirror')?.textContent || '').trim(),
      pickClosed: !document.querySelector('.amx-bpick'),
    }))
    ok('3f 点「标题 1」真把当前块转成了 H1', after.h1 && after.h1text === '转成标题', `h1=${after.h1} text="${after.h1text || after.text}"`)
    ok('3g 选完面板自动收起', after.pickClosed, `closed=${after.pickClosed}`)

    await page.screenshot({ path: path.join(shotDir, 'after-insert.png') })
    console.log('screenshot →', path.join(shotDir, 'after-insert.png'))

    // ── 4. 画布模式(2026-08-20 补入口)────────────────────────────────────────
    // 桌面那颗「文档 | 画布」胶囊是 portal 进 .amx-toolbar 里的插槽的,而顶栏在移动端整行不渲染
    // (1a 钉着)→ 手机上一直没有任何进画布的路,v4 画布代码在包里但点不到。入口补在「⋯」里。
    // ⚠️ 顺带:UnifiedPage 那道「移动端忽略盘上 mode:canvas」的门原来判 UI_MODE,而 APK 里
    //    UI_MODE 恒 'desktop'(mobile/index.html 没有写 lcl.uiMode 的那段脚本),从来没生效过;
    //    已改判 isCoarsePointer() —— 与 1a「顶栏不渲染」同一个信号,1a 绿就说明这门在手机上真会关。
    const capsule = await page.evaluate(() => {
      const bar = document.querySelector('.amx-mbar')
      if (!bar) return null
      const r = bar.getBoundingClientRect()
      return {
        titles: [...bar.querySelectorAll('button')].map((b) => b.title || b.getAttribute('aria-label') || ''),
        // 药丸不许被撑破:多加一颗键后仍须整条留在屏内(按钮已改可收缩,见 amadeus-host.css)。
        fits: r.left >= -1 && r.right <= window.innerWidth + 1,
      }
    })
    ok('4a 画布键常驻在底栏胶囊里、就排在上传后面(用户 2026-08-20 拍板)',
      !!capsule && capsule.titles.indexOf('切换到画布') === capsule.titles.indexOf('上传文件到本页') + 1,
      capsule ? capsule.titles.join(' | ') : '没有胶囊')
    // ⚠️ 390pt 下七颗键(7×40 + 间隙 ≈ 298)本来就塞得进 ~315 的上限 —— 只在这一档量,
    //    等于这条断言**加不加那道收缩兜底都绿**(= 恒真断言)。真正会顶穿的是窄机,所以临时
    //    切到 360pt 再量一次,量完切回去(后面几段的点击几何是按 390 算的)。
    const fitsAt = async (w) => {
      await page.setViewportSize({ width: w, height: 844 })
      await page.waitForTimeout(400)
      return await page.evaluate(() => {
        const b = document.querySelector('.amx-mbar')
        if (!b) return null
        const r = b.getBoundingClientRect()
        const last = [...b.querySelectorAll('button')].pop()
        // ⚠️ 量的是**最后一颗键有没有越出药丸**,不是药丸有没有越出屏:药丸有 max-width,
        //    撑不撑得住都被裁在同一个盒子里 —— 只量盒子的话,去掉收缩兜底这条照样绿。
        return {
          w: Math.round(r.width),
          vw: window.innerWidth,
          spill: last ? Math.round(last.getBoundingClientRect().right - r.right) : null,
        }
      })
    }
    const narrow = await fitsAt(360)
    await fitsAt(390)
    ok('4a2 加了一颗之后药丸没被撑出屏(390 与窄机 360 各量一次)',
      !!capsule && capsule.fits && !!narrow && narrow.spill !== null && narrow.spill <= 1,
      JSON.stringify({ at390: capsule && capsule.fits, at360: narrow }))
    await tap(page.locator('.amx-mbar button[title="切换到画布"]'))
    await page.waitForTimeout(1000)
    const c1 = await page.evaluate(() => ({
      on: !!document.querySelector('.unified-body.amx-canvas'),
      full: !!document.querySelector('.unified-body.amx-canvas-full'),
      stage: !!document.querySelector('.amx-stage'),
      // 底栏胶囊必须还在:满铺画布是 .amx-pane 内的 absolute inset:0,而胶囊是 pane 的兄弟 —— 盖掉就出不来了。
      barVisible: (() => { const b = document.querySelector('.amx-mbar'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.bottom <= window.innerHeight + 1 })(),
      sheetClosed: !document.querySelector('.mb-sheet'),
    }))
    ok('4b 点了真进画布(满铺舞台在场;底栏胶囊没被盖掉 = 还回得来)',
      c1.on && c1.full && c1.stage && c1.barVisible && c1.sheetClosed, JSON.stringify(c1))
    await page.screenshot({ path: path.join(shotDir, 'canvas-mode.png') })
    console.log('screenshot →', path.join(shotDir, 'canvas-mode.png'))

    const seg = await page.evaluate(() => {
      const b = document.querySelector('.amx-mbar button[title="切换到文档"]')
      const sheetRows = [...document.querySelectorAll('.mb-sheet .mb-sheet-row')].map((e) => e.textContent.trim())
      return { flipped: !!b, on: !!b && b.classList.contains('on'), sheetRows }
    })
    ok('4c 画布态下同一颗翻成「切换到文档」并点亮(不是两颗并列的死键)', seg.flipped && seg.on, JSON.stringify(seg))
    await tap(page.locator('.amx-mbar button[title="切换到文档"]'))
    await page.waitForTimeout(900)
    const c2 = await page.evaluate(() => ({
      on: !!document.querySelector('.unified-body.amx-canvas'),
      h1: !!document.querySelector('.page-view .ProseMirror h1'),
    }))
    ok('4d 真回得到文档态,正文原样还在', !c2.on && c2.h1, JSON.stringify(c2))
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:editorbar\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:editorbar —— 顶栏已隐/上传仍在/胶囊底栏/⋯ 动作齐全/「+」双列面板真插块/画布模式进得去回得来')
}

main()
