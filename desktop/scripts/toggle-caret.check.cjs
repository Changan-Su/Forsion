// 折叠标题行首：原生/丝滑光标、删除、方向键与 Chromium 原生 IME 组合输入。
// node scripts/e2e-editor.cjs --check=toggle-caret [--electron] [--quick] [--shot=/tmp/toggle-caret]
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const HEAD = '.unified-body .ProseMirror .callout-toggle-title'
const results = []
const shotDir = process.argv.find(a => a.startsWith('--shot='))?.slice(7)
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`)
}
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium-')).sort().reverse())
    for (const name of ['Google Chrome for Testing', 'Chromium']) {
      const exe = path.join(root, dir, 'chrome-mac-arm64', `${name}.app/Contents/MacOS/${name}`)
      if (fs.existsSync(exe)) return exe
    }
  throw new Error('找不到 Chromium，请设 CHROMIUM_EXE')
}
// 真值来自可见首字/空标题 trailingBreak 的字体盒；不能把隐藏 token 的 Range 当真值。
async function geometry(page) {
  return page.locator(HEAD).first().evaluate(head => {
    const v = window.__upage.probe.view(), sel = getSelection()
    const origin = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement
    const nodes = [], walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()))
      if (!node.parentElement.closest('button,.callout-syntax,.ProseMirror-widget')) nodes.push(node)
    const r = document.createRange()
    let truth
    if (nodes.length) {
      r.setStart(nodes[0], 0); r.collapse(true); truth = r.getBoundingClientRect()
    } else truth = head.querySelector('br.ProseMirror-trailingBreak').getBoundingClientRect()
    const box = r => ({ x: r.left, y: r.top, h: r.height })
    const caret = document.querySelector('.sc-caret')
    const coords = v.coordsAtPos(v.state.selection.from)
    const anchorBox = head.querySelector('.callout-title-anchor')?.getBoundingClientRect()
    const activeRange = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
    const atBoundary = sel.anchorNode === head
      && head.childNodes[sel.anchorOffset - 1]?.classList?.contains('callout-title-anchor')
    return {
      truth: box(truth), coords: { x: coords.left, y: coords.top, h: coords.bottom - coords.top },
      drawn: caret && getComputedStyle(caret).display !== 'none' ? box(caret.getBoundingClientRect()) : null,
      range: activeRange && box(activeRange), anchor: anchorBox && box(anchorBox),
      hidden: !!origin?.closest('.callout-syntax'), inside: !!origin && head.contains(origin),
      atBoundary, font: origin && parseFloat(getComputedStyle(origin).fontSize),
      text: v.state.selection.$from.parent.textContent,
      selection: v.state.selection.toJSON(),
    }
  })
}
const near = (a, b) => a && b && Math.abs(a.x - b.x) <= 1.1 && Math.abs(a.y - b.y) <= 1.1 && Math.abs(a.h - b.h) <= 1.1
async function atStart(page, name, smooth) {
  await page.waitForTimeout(160)
  const g = await geometry(page)
  // paragraph 边界的 collapsed Range 本身没有 rect，但其前一 widget 必须是有真实行高的插入点。
  check(`${name}:原生选区位于标题字体盒`, g.inside && !g.hidden && g.font > 0
    && (near(g.range, g.truth) || (g.atBoundary && g.anchor?.h > 0)) && near(g.coords, g.truth), g)
  if (smooth) check(`${name}:丝滑光标与首字基线重合`, near(g.drawn, g.truth), g)
  return g
}
async function run(page, config, smooth, empty) {
  const prefix = config.prefix || ''
  const title = empty ? '' : `${prefix}Title`
  const seed = `Before\n\n> [!fold]- ${title}\n>\n> Body content\n\nAfter`
  const name = `${config.name}/${smooth ? 'smooth' : 'native'}/${empty ? 'empty' : 'title'}`
  await page.goto(`${URL}?upage&upane${smooth ? '&caret' : ''}${config.dark ? '&udark' : ''}&useed=${encodeURIComponent(seed)}`)
  await page.waitForSelector(HEAD)
  await page.evaluate(() => document.fonts.ready)
  if (config.small || config.font) {
    await page.getByRole('button', { name: '⋯', exact: true }).click()
    if (config.small) await page.getByRole('menuitemcheckbox', { name: /Small text|小字号/ }).click()
    if (config.font) await page.getByRole('menuitemradio', { name: config.font }).click()
    await page.getByRole('button', { name: '⋯', exact: true }).click()
  }
  if (config.zoom) await page.evaluate(z => { document.body.style.zoom = String(z) }, config.zoom)
  await page.locator(HEAD).first().click({ position: { x: 1, y: 10 } })
  await page.keyboard.press('Home')
  await atStart(page, `${name}/click+Home`, smooth)
  if (shotDir) await page.screenshot({ caret: 'initial', path: path.join(shotDir, `${name.replaceAll('/', '-')}-start.png`) })
  await page.keyboard.type('x')
  await page.keyboard.press('Backspace')
  await atStart(page, `${name}/delete-first`, smooth)
  if (!empty) {
    const start = (await geometry(page)).selection.head
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(80)
    check(`${name}:右键前进一个可见字符`, (await geometry(page)).selection.head === start + 1)
    await page.keyboard.press('ArrowLeft')
    await atStart(page, `${name}/arrow-left`, smooth)
  }
  const cdp = await page.context().newCDPSession(page)
  try {
    const before = (await geometry(page)).text
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 })
    await page.waitForTimeout(160)
    const composed = await geometry(page)
    check(`${name}:IME 组合文字与原有首字同一字体和基线`, composed.inside && !composed.hidden && composed.font > 0
      && composed.range?.h > 0 && Math.abs(composed.range.y - composed.truth.y) <= 1
      && Math.abs(composed.range.h - composed.truth.h) <= 1, composed)
    if (smooth) check(`${name}:组合期间丝滑光标跟随真实选区`, near(composed.drawn, composed.range), composed)
    if (shotDir) await page.screenshot({ caret: 'initial', path: path.join(shotDir, `${name.replaceAll('/', '-')}-ime.png`) })
    await cdp.send('Input.insertText', { text: '你好' })
    await page.waitForTimeout(600)
    const committed = (await geometry(page)).text
    check(`${name}:IME 提交位于标题开头且不改变令牌`, committed === before.replace(/^(\[!fold\]-\s*(?:#{1,6} )?)/, '$1你好'), { before, committed })
    await page.keyboard.press('Home')
    await atStart(page, `${name}/after-commit`, smooth)
    if (!empty) {
      const pending = await page.locator(HEAD).first().evaluate(head => {
        const v = window.__upage.probe.view(), sel = getSelection()
        const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT)
        let text
        while ((text = walker.nextNode()))
          if (!text.parentElement.closest('button,.callout-syntax,.ProseMirror-widget')) break
        const model = v.state.selection.from
        const r = document.createRange()
        r.setStart(text, 2); r.setEnd(text, 4)
        sel.removeAllRanges(); sel.addRange(r)
        v.updateState(v.state) // 模拟原生 selectionchange 之前的无文档更新。
        const rangeKept = !sel.isCollapsed && sel.anchorNode === text && sel.anchorOffset === 2 && sel.focusOffset === 4
        sel.collapse(text, 2)
        v.updateState(v.state)
        return { rangeKept, caretKept: sel.isCollapsed && sel.anchorNode === text && sel.anchorOffset === 2,
          modelStillAtStart: v.state.selection.from === model }
      })
      check(`${name}:未同步的鼠标划选不会被校正收起`, pending.rangeKept && pending.modelStillAtStart, pending)
      check(`${name}:未同步的原生光标不会被拉回行首`, pending.caretKept && pending.modelStillAtStart, pending)
      await page.keyboard.press('Home')
    }
    await cdp.send('Input.imeSetComposition', { text: 'cancel', selectionStart: 6, selectionEnd: 6 })
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await page.waitForTimeout(160)
    check(`${name}:取消组合输入保持标题与折叠状态`, (await geometry(page)).text === committed
      && await page.locator('.callout-fold').first().getAttribute('class').then(c => c.includes('callout-collapsed')))
    await page.waitForTimeout(1200)
    const saved = await page.evaluate(() => window.__upage.writes.at(-1)?.text || '')
    check(`${name}:定位字符不写入 Markdown，正文保留`, saved.includes('你好') && saved.includes('[!fold]-')
      && saved.includes('Body content') && !saved.includes('\u200b'), saved)
    if (shotDir) {
      await page.keyboard.press('Home')
      await page.waitForTimeout(180)
      await page.screenshot({ caret: 'initial', path: path.join(shotDir, `${name.replaceAll('/', '-')}.png`) })
    }
    if (config.name === 'light' && !empty) {
      await page.locator(HEAD).first().hover()
      await page.locator('.callout-source').first().click()
      check(`${name}:源码模式显示令牌并撤下定位装饰`, await page.locator('.callout-title-anchor').count() === 0
        && (await page.locator('.callout-token').first().boundingBox()).width > 10)
      await page.locator('.unified-body .ProseMirror > p').last().click()
      check(`${name}:离开源码模式恢复定位装饰`, await page.locator('.callout-title-anchor').count() === 1)
    }
  } finally { await cdp.detach() }
}
async function main() {
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
  let browser, app
  const errors = []
  const configs = [
    { name: 'light' }, { name: 'dark', dark: true }, { name: 'small', small: true },
    { name: 'serif', font: /Serif|衬线/ }, { name: 'mono', font: /Mono|等宽/ },
    { name: 'zoom125', zoom: 1.25, dark: true }, { name: 'narrow', width: 460 },
    { name: 'heading', prefix: '## ' },
  ]
  if (process.argv.includes('--electron')) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-toggle-caret-'))
    const main = path.join(home, 'main.cjs')
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:860,webPreferences:{contextIsolation:true}});w.loadURL(${JSON.stringify(URL)});});`)
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', main], env: { ...process.env, TANGU_HOME: home } })
  } else browser = await chromium.launch({ executablePath: findChromium() })
  try {
    for (const config of process.argv.includes('--quick') ? configs.slice(0, 1) : configs)
      for (const smooth of [false, true]) for (const empty of [false, true]) {
        if (empty && config.prefix) continue
        const page = app ? await app.firstWindow() : await browser.newPage({ locale: 'zh-CN', viewport: { width: config.width || 1200, height: 860 } })
        page.on('pageerror', e => errors.push(e.message))
        if (app) {
          await page.goto(URL); await page.evaluate(() => localStorage.clear())
          await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), config.width || 1200)
        }
        await run(page, config, smooth, empty)
        if (!app) await page.close()
      }
    check('无页面运行时错误', errors.length === 0, errors)
  } finally { if (app) await app.close(); else await browser?.close() }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  process.exitCode = results.every(Boolean) ? 0 : 1
}
main().catch(e => { console.error(e); process.exitCode = 1 })
