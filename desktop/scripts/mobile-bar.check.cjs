// 移动端底栏胶囊的撤销 / 重做在 v4 笔记上生效(评审 2026-09-27 G2-05)。
//
//  Android WebView 没有系统级撤销,胶囊是唯一入口。旧版两颗键按 v3 的 activePage 门控(`if (activePage) myPs().undo()`),
//  而 v4 统一页不设 activePage → 每篇 v4 笔记上都是死键(键盘 Meta+Z 却能撤,证明 PM 历史本身在)。
//  现在 UnifiedPage 经 historyRef 把本实例的撤销交给宿主(文档态 = PM history,画布态 = 舞台统一仲裁,与 Cmd+Z 同路)。
//
//  做法:触屏形态(390×844,hasTouch/isMobile → pointer:coarse)下,在 ?upage 台架页里用台架**同一份** React /
//  amadeusViews 模块实例挂一个生产 AmadeusEditorView(假 leaf,notePath=Mob.md),真点胶囊按钮。
//  M1 打字后点胶囊「撤销」→ 字没了,且落盘的是撤销后的内容
//  M2 再点胶囊「重做」→ 字回来;M2b 键盘撤销后点胶囊「重做」→ 字回来(重做键单独验)
//  M3 连点两次撤销不越界、不报错(历史到底 = no-op)
//  M4 缩进 / 提升两颗键(G2-06,软键盘没有 Tab):排在画布键之后;点「增加缩进」= Tab(乙成为甲的子项并落盘)、
//     「减少缩进」= Shift-Tab(提回同级);点键不抢编辑器焦点;加了两颗键后 390 / 窄机 360 下最后一颗仍在药丸内
//  M5 宿主能力门控(G2-13):移动本地库桥声明 hostCaps 三件 false → 「⋯」里没有导出 PDF / 在文件管理器中显示,
//     视频卡没有「打开」、其他文件卡不是按钮(点了没反应的死键);PDF 卡照旧能开。对照:不声明(桌面桥)时它们都在。
//  M6 Android 返回(G2-12):MobileRoot 派发的可取消 forsion:mobile-back 先关编辑器最上层的浮层 —— 胶囊「⋯」弹层、
//     「+」块面板、⠿ 块菜单、图片大图、askString 对话框;一次只关一层(后开的先关),关完了才轮到壳(不再被拦)。
//
// 用法:npm run check:mobilebar(= node scripts/e2e-editor.cjs --check=mobile-bar;worktree 里设 HARNESS_URL)
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const MOB = '#mob-host .unified-body .ProseMirror'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 用台架页已加载的同一份 React / react-dom / amadeusViews(按 harness.tsx 的已转换源码里的 import URL 取,
 *  保证模块实例一致 —— 另起一份 React 会让 hooks 直接炸)挂一个生产 AmadeusEditorView。 */
async function mount(page, md = '# 移动标题\n\n第一段。\n\n第二段。\n') {
  return page.evaluate(async (md) => {
    const hsrc = await (await fetch('/src/harness.tsx')).text()
    const find = (re) => { const m = hsrc.match(re); return m ? m[1] : null }
    const Rm = await import(find(/["']([^"']*\/deps\/react\.js[^"']*)["']/))
    const React = Rm.default ?? Rm
    const rdc = await import(find(/["']([^"']*\/deps\/react-dom_client\.js[^"']*)["']/))
    const createRoot = rdc.createRoot ?? rdc.default.createRoot
    const av = await import(find(/["'](\/src\/amadeusViews\.tsx[^"']*)["']/))
    window.__upage.vault.set('Mob.md', md)
    document.getElementById('root').style.display = 'none' // 台架自己那份 UnifiedPage 别抢焦点 / 几何
    const host = document.createElement('div')
    host.id = 'mob-host'
    host.className = 'am-app tangu-lovable'
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:#fff'
    document.body.appendChild(host)
    const leaf = { id: 'mob-leaf-1', type: 'amadeus-editor', loc: 'main', params: { notePath: 'Mob.md' }, setParams(p) { leaf.params = p }, setTitle() {} }
    createRoot(host).render(React.createElement(av.AmadeusEditorView, { leaf }))
    return matchMedia('(pointer: coarse)').matches
  }, md)
}
const bodyText = (p) => p.evaluate((s) => document.querySelector(s)?.innerText ?? '', MOB)
const lastWrite = (p) => p.evaluate(() => { const w = window.__upage.writes.filter((x) => x.path === 'Mob.md'); return w.length ? w[w.length - 1].text : null })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message) })
    await page.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
    await page.waitForTimeout(400)
    const coarse = await mount(page)
    await page.waitForSelector(MOB, { timeout: 60000 })
    await page.waitForTimeout(800)
    const undoBtn = page.locator('#mob-host .amx-mbar button[title="撤销"]')
    const redoBtn = page.locator('#mob-host .amx-mbar button[title="重做"]')
    if (!coarse || (await undoBtn.count()) !== 1 || (await redoBtn.count()) !== 1) {
      record('前置:触屏形态 + 胶囊撤销/重做键在', false, `coarse=${coarse} undo=${await undoBtn.count()} redo=${await redoBtn.count()}`)
      return
    }
    // 光标放到「第二段。」末尾并打字(真点击 + 真键入)
    const c = await page.evaluate((s) => {
      const el = [...document.querySelectorAll(s + ' p')].find((p) => p.textContent.includes('第二段'))
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 }
    }, MOB)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(200)
    await page.keyboard.type('XYZ')
    await page.waitForTimeout(900)
    const typed = (await bodyText(page)).includes('XYZ')

    await undoBtn.click()
    await page.waitForTimeout(1400) // 过一个落盘防抖(800ms)
    const t1 = await bodyText(page)
    const w1 = await lastWrite(page)
    record('M1 打字后点胶囊「撤销」→ 字没了、落盘的是撤销后的内容', typed && !t1.includes('XYZ') && !!w1 && !w1.includes('XYZ') && w1.includes('第二段。'),
      JSON.stringify({ typed, text: t1.replace(/\n+/g, '|'), lastWrite: w1 }))

    await redoBtn.click()
    await page.waitForTimeout(500)
    const t2 = await bodyText(page)
    record('M2 点胶囊「重做」→ 字回来', !t1.includes('XYZ') && t2.includes('XYZ'), t2.replace(/\n+/g, '|'))

    // 重做键单独验:撤销走键盘(已知可用的那条),重做走胶囊 —— 不让「撤销键坏了」把重做的结论一起带偏。
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(400)
    const t2b = await bodyText(page)
    await redoBtn.click()
    await page.waitForTimeout(500)
    const t2c = await bodyText(page)
    record('M2b 键盘撤销后点胶囊「重做」→ 字回来', !t2b.includes('XYZ') && t2c.includes('XYZ'), JSON.stringify({ afterKeyUndo: t2b.replace(/\n+/g, '|'), afterBarRedo: t2c.replace(/\n+/g, '|') }))

    await undoBtn.click(); await page.waitForTimeout(200)
    await undoBtn.click(); await page.waitForTimeout(200)
    await undoBtn.click(); await page.waitForTimeout(400)
    const t3 = await bodyText(page)
    record('M3 撤到底再点 → no-op,正文完好、零运行时报错', !t3.includes('XYZ') && t3.includes('第二段。') && errs.length === 0, JSON.stringify({ text: t3.replace(/\n+/g, '|'), errs }))
    await page.close()

    // ── M4:缩进 / 提升(G2-06)──
    {
      const pg = await ctx.newPage()
      pg.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message) })
      await pg.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await pg.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
      await pg.waitForTimeout(400)
      await mount(pg, '# 移动标题\n\n- 甲\n- 乙\n')
      await pg.waitForSelector(MOB + ' li', { timeout: 60000 })
      await pg.waitForTimeout(800)
      const titles = await pg.evaluate(() => [...document.querySelectorAll('#mob-host .amx-mbar button')].map((b) => b.title))
      const ci = titles.indexOf('切换到画布')
      record('M4a 缩进 / 提升两颗键在胶囊里、紧跟画布键', ci >= 0 && titles[ci + 1] === '减少缩进' && titles[ci + 2] === '增加缩进', titles.join(' | '))
      const c = await pg.evaluate((s) => {
        const li = [...document.querySelectorAll(s + ' li')].find((e) => e.textContent.trim() === '乙')
        const r = document.createRange(); r.selectNodeContents(li.querySelector('p') || li); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 }
      }, MOB)
      await pg.mouse.click(c.x, c.y)
      await pg.waitForTimeout(250)
      const nested = (p) => p.evaluate((s) => {
        const inner = [...document.querySelectorAll(s + ' li li')].map((e) => e.textContent.trim())
        return { inner, active: document.activeElement?.classList?.contains('ProseMirror') ?? false }
      }, MOB)
      await pg.locator('#mob-host .amx-mbar button[title="增加缩进"]').click()
      await pg.waitForTimeout(1400)
      const a = await nested(pg)
      const wa = await pg.evaluate(() => { const w = window.__upage.writes.filter((x) => x.path === 'Mob.md'); return w.length ? w[w.length - 1].text : null })
      record('M4b 点「增加缩进」= Tab:乙成为甲的子项并落盘,焦点仍在正文', a.inner.join('|') === '乙' && a.active && /[-*] 甲\n\s+[-*] 乙/.test(wa || ''), JSON.stringify({ ...a, lastWrite: wa }))
      await pg.locator('#mob-host .amx-mbar button[title="减少缩进"]').click()
      await pg.waitForTimeout(300)
      const b = await nested(pg)
      const items = await pg.evaluate((s) => [...document.querySelectorAll(s + ' li')].map((e) => e.textContent.trim()).join('|'), MOB)
      record('M4c 点「减少缩进」= Shift-Tab:乙提回同级', b.inner.length === 0 && items === '甲|乙', JSON.stringify({ ...b, items }))
      // 九颗键的宽度账(同 editor-capsule e2e 的 4a2 口径:量最后一颗键越没越出药丸,390 与窄机 360 各一次)。
      const fitsAt = async (w) => {
        await pg.setViewportSize({ width: w, height: 844 })
        await pg.waitForTimeout(400)
        return pg.evaluate(() => {
          const bar = document.querySelector('#mob-host .amx-mbar')
          const r = bar.getBoundingClientRect()
          const last = [...bar.querySelectorAll('button')].pop()
          return { n: bar.querySelectorAll('button').length, inScreen: r.left >= -1 && r.right <= window.innerWidth + 1, spill: Math.round(last.getBoundingClientRect().right - r.right) }
        })
      }
      const f390 = await fitsAt(390)
      const f360 = await fitsAt(360)
      record('M4d 加两颗键后 390 / 360 下药丸不破(最后一颗键仍在药丸内)', f390.n === 9 && f390.inScreen && f390.spill <= 1 && f360.inScreen && f360.spill <= 1, JSON.stringify({ f390, f360 }))
      await pg.close()
    }
    // ── M5:宿主能力门控(G2-13)──
    for (const caps of [null, { revealInFileManager: false, exportPdf: false, openAttachment: false }]) {
      const pg = await ctx.newPage()
      pg.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message) })
      await pg.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await pg.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
      await pg.waitForTimeout(400)
      // 与生产同一个 window.amadeus 对象上声明(api.ts 抓的是这个引用,整份替换会失联)
      await pg.evaluate((caps) => { if (caps) window.amadeus.hostCaps = caps; else delete window.amadeus.hostCaps }, caps)
      await mount(pg, '# 移动标题\n\n第一段。\n\n![[clip.mp4]]\n\n![[pack.zip]]\n\n![[doc.pdf]]\n')
      await pg.waitForSelector(MOB, { timeout: 60000 })
      await pg.waitForTimeout(1000)
      await pg.locator('#mob-host .amx-mbar button[title="更多操作"]').click()
      await pg.waitForTimeout(300)
      const st = await pg.evaluate(() => ({
        rows: [...document.querySelectorAll('.mb-sheet .mb-sheet-row span')].map((e) => e.textContent),
        mediaOpen: [...document.querySelectorAll('#mob-host .embed-media')].map((m) => `${m.querySelector('.embed-file-name')?.textContent}:${[...m.querySelectorAll('.embed-media-btn')].some((b) => b.textContent.startsWith('打开'))}`),
        otherIsButton: [...document.querySelectorAll('#mob-host .embed-file')].map((e) => e.tagName),
      }))
      const hasPdf = st.rows.includes('导出为 PDF'), hasReveal = st.rows.includes('在文件管理器中显示')
      const mp4Open = st.mediaOpen.includes('clip.mp4:true'), pdfOpen = st.mediaOpen.includes('doc.pdf:true')
      if (!caps) record('M5a 对照:桥不声明 hostCaps(桌面)→ 导出 PDF / 在文件管理器中显示 / 视频「打开」/ 文件卡按钮都在',
        hasPdf && hasReveal && mp4Open && pdfOpen && st.otherIsButton.includes('BUTTON'), JSON.stringify(st))
      else record('M5b 移动本地库(hostCaps 三件 false)→ 这些死键都不渲染,PDF 卡「打开」照旧',
        !hasPdf && !hasReveal && !mp4Open && pdfOpen && !st.otherIsButton.includes('BUTTON') && st.rows.includes('删除笔记'), JSON.stringify(st))
      await pg.close()
    }
    // ── M6:Android 返回先关编辑器浮层(G2-12)──
    {
      const back = () => { const ev = new Event('forsion:mobile-back', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented }
      const pg = await ctx.newPage()
      pg.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message) })
      await pg.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await pg.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
      await pg.waitForTimeout(400)
      await mount(pg)
      await pg.waitForSelector(MOB, { timeout: 60000 })
      await pg.waitForTimeout(800)
      await pg.locator('#mob-host .amx-mbar button[title="更多操作"]').click()
      await pg.waitForTimeout(200)
      const sheetOpen = await pg.evaluate(() => !!document.querySelector('.mb-sheet'))
      const b1 = await pg.evaluate(back)
      await pg.waitForTimeout(200)
      const sheetAfter = await pg.evaluate(() => !!document.querySelector('.mb-sheet'))
      if (sheetAfter) { await pg.mouse.click(195, 40); await pg.waitForTimeout(200) } // 没关掉(回归):点遮罩收掉,别让下一步卡死
      // 「+」块面板
      await pg.locator('#mob-host .amx-mbar button[title="插入块"]').click()
      await pg.waitForTimeout(300)
      const pickOpen = await pg.evaluate(() => !!document.querySelector('.amx-bpick'))
      const b2 = await pg.evaluate(back)
      await pg.waitForTimeout(200)
      const pickAfter = await pg.evaluate(() => !!document.querySelector('.amx-bpick'))
      const b3 = await pg.evaluate(back) // 什么都没开:不拦,交给壳
      record('M6a 胶囊「⋯」弹层 / 「+」块面板:返回先关它们(拦下),都关了之后不再拦',
        sheetOpen && b1 && !sheetAfter && pickOpen && b2 && !pickAfter && !b3, JSON.stringify({ sheetOpen, b1, sheetAfter, pickOpen, b2, pickAfter, b3 }))
      await pg.close()

      // 块菜单 / 大图 / askString:与指针形态无关,桌面尺寸页面里点 ⠿ 更稳(手机上 ⠿ 的可达性是 P-14 那一条)
      const dp = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PAQ0AAAgDoL9/aYOLMZgFkA4mJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiZ2WlUBfgdx1f8AAAAASUVORK5CYII='
      await dp.goto(`${URL}?upage&useed=${encodeURIComponent(`# T\n\nfirst para.\n\n![](${PNG})\n\nafter.\n`)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await dp.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
      await dp.waitForTimeout(500)
      const p = await dp.evaluate(() => { const b = document.querySelector('.unified-body .ProseMirror > p').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 } })
      await dp.mouse.move(p.x, p.y); await dp.waitForTimeout(150); await dp.mouse.move(p.x + 2, p.y + 1); await dp.waitForTimeout(300)
      const h = await dp.evaluate(() => { const el = [...document.querySelectorAll('.drag-handle')].find((e) => e.getBoundingClientRect().width > 0); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
      if (h) { await dp.mouse.click(h.x, h.y); await dp.waitForTimeout(300) }
      const menuOpen = await dp.evaluate(() => !!document.querySelector('.unified-block-menu'))
      // 菜单开着时再弹 askString(后开的在上):第一次返回只关对话框(取消 = null),第二次才关菜单
      await dp.evaluate(async () => {
        const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/components/askString.tsx')) ?? '/src/amadeus/components/askString.tsx'
        const m = await import(url)
        window.__askResult = 'pending'
        m.askString('Rename', 'abc').then((v) => { window.__askResult = v })
      })
      await dp.waitForTimeout(300)
      const askOpen = await dp.evaluate(() => !!document.querySelector('.dialog'))
      const r1 = await dp.evaluate(back)
      await dp.waitForTimeout(200)
      const s1 = await dp.evaluate(() => ({ ask: !!document.querySelector('.dialog'), menu: !!document.querySelector('.unified-block-menu'), result: window.__askResult }))
      const r2 = await dp.evaluate(back)
      await dp.waitForTimeout(200)
      const s2 = await dp.evaluate(() => ({ menu: !!document.querySelector('.unified-block-menu') }))
      record('M6b askString 压在块菜单上:第一次返回只关对话框(取消),第二次关块菜单',
        menuOpen && askOpen && r1 && !s1.ask && s1.menu && s1.result === null && r2 && !s2.menu, JSON.stringify({ menuOpen, askOpen, r1, s1, r2, s2 }))
      const img = await dp.evaluate(() => { const el = document.querySelector('.unified-body img'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
      if (img) { await dp.mouse.dblclick(img.x, img.y); await dp.waitForTimeout(300) }
      const lbOpen = await dp.evaluate(() => !!document.querySelector('.amx-lightbox'))
      const r3 = await dp.evaluate(back)
      await dp.waitForTimeout(200)
      const lbAfter = await dp.evaluate(() => !!document.querySelector('.amx-lightbox'))
      record('M6c 图片大图:返回关大图', lbOpen && r3 && !lbAfter, JSON.stringify({ lbOpen, r3, lbAfter }))
      await dp.close()
    }
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
