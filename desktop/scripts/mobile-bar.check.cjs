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
async function mount(page) {
  return page.evaluate(async () => {
    const hsrc = await (await fetch('/src/harness.tsx')).text()
    const find = (re) => { const m = hsrc.match(re); return m ? m[1] : null }
    const Rm = await import(find(/["']([^"']*\/deps\/react\.js[^"']*)["']/))
    const React = Rm.default ?? Rm
    const rdc = await import(find(/["']([^"']*\/deps\/react-dom_client\.js[^"']*)["']/))
    const createRoot = rdc.createRoot ?? rdc.default.createRoot
    const av = await import(find(/["'](\/src\/amadeusViews\.tsx[^"']*)["']/))
    window.__upage.vault.set('Mob.md', '# 移动标题\n\n第一段。\n\n第二段。\n')
    document.getElementById('root').style.display = 'none' // 台架自己那份 UnifiedPage 别抢焦点 / 几何
    const host = document.createElement('div')
    host.id = 'mob-host'
    host.className = 'am-app tangu-lovable'
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:#fff'
    document.body.appendChild(host)
    const leaf = { id: 'mob-leaf-1', type: 'amadeus-editor', loc: 'main', params: { notePath: 'Mob.md' }, setParams(p) { leaf.params = p }, setTitle() {} }
    createRoot(host).render(React.createElement(av.AmadeusEditorView, { leaf }))
    return matchMedia('(pointer: coarse)').matches
  })
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
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
