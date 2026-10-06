// 方框与首行文字对齐、固定留白、真实点击,以及空待办输入/删除后的光标高度。
// node scripts/e2e-editor.cjs --check=task-checkbox [--electron] [--shot=/tmp/checkbox-shots]
// --electron 在隔离 Electron 窗口加载同一生产 UnifiedPage 台架,不碰用户的库或应用实例。
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium, _electron } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const TASK = `${PM} li[data-item-type="task"]`
const seed = '- [ ]\n- [ ] ' + 'A task that wraps across several visual lines. '.repeat(12)
  + '\n  - [ ] Child task\n- [x] Completed task\n\nPlain paragraph\n'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`)
}
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter(x => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  throw new Error('找不到 Chromium,请设 CHROMIUM_EXE')
}
const shotArg = process.argv.find(a => a.startsWith('--shot='))
const shotDir = shotArg?.slice('--shot='.length)
const electronMode = process.argv.includes('--electron')
const negativeControl = process.argv.includes('--negative-control')

async function geometry(page) {
  return page.locator(TASK).evaluateAll(items => items.map(li => {
    const p = li.querySelector(':scope > p'), r = li.getBoundingClientRect()
    const z = li.currentCSSZoom || 1, c = getComputedStyle(li, '::before')
    const outer = (axis) => parseFloat(c[axis]) + (c.boxSizing === 'border-box' ? 0
      : parseFloat(c[axis === 'width' ? 'borderLeftWidth' : 'borderTopWidth'])
        + parseFloat(c[axis === 'width' ? 'borderRightWidth' : 'borderBottomWidth']))
    const box = { left: r.left + parseFloat(c.left) * z, top: r.top + parseFloat(c.top) * z,
      width: outer('width') * z, height: outer('height') * z }
    const n = Array.from(p.childNodes).find(n => n.nodeType === 3)
    let text
    if (n) {
      const range = document.createRange()
      range.setStart(n, 0); range.collapse(true)
      text = range.getBoundingClientRect()
    } else text = p.querySelector('br').getBoundingClientRect()
    const after = getComputedStyle(li, '::after')
    let tickInside = true
    if (li.dataset.checked === 'true') {
      const w = parseFloat(after.width), h = parseFloat(after.height)
      const half = (w + h) / Math.SQRT2 / 2 * z
      const cx = r.left + (parseFloat(after.left) + w / 2) * z
      const cy = r.top + (parseFloat(after.top) + h / 2) * z
      tickInside = cx - half >= box.left && cx + half <= box.left + box.width
        && cy - half >= box.top && cy + half <= box.top + box.height
    }
    return { text: p.textContent.slice(0, 20), box, z, gap: (text.left - box.left - box.width) / z,
      delta: (box.top + box.height / 2 - text.top - text.height / 2) / z,
      wrapped: p.getBoundingClientRect().height > parseFloat(getComputedStyle(p).lineHeight) * z * 1.5,
      tickInside }
  }))
}
const caret = page => page.locator('.sc-caret').evaluate(el => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, height: r.height, visible: el.style.display !== 'none' }
})

async function run(page, name, options) {
  await page.goto(`${URL}?upage&upane&caret${options.dark ? '&udark' : ''}&useed=${encodeURIComponent(seed)}`)
  await page.waitForSelector(TASK)
  await page.evaluate(() => document.fonts.ready)
  if (negativeControl) await page.addStyleTag({ content: `.am-app .milkdown .ProseMirror li[data-item-type='task']::before {
    box-sizing:content-box;left:-1.5em;top:0.28em;width:16px;height:16px;
  }` })
  if (options.small || options.font) {
    await page.getByRole('button', { name: '⋯', exact: true }).click()
    if (options.small) await page.getByRole('menuitemcheckbox', { name: /Small text|小字号/ }).click()
    if (options.font) await page.getByRole('menuitemradio', { name: options.font }).click()
    await page.getByRole('button', { name: '⋯', exact: true }).click()
  }
  if (options.zoom) await page.evaluate(z => { document.body.style.zoom = String(z) }, options.zoom)
  await page.locator(PM).press('ControlOrMeta+Home')
  await page.waitForTimeout(160) // 等覆盖层的 90ms 过渡结束。
  const rows = await geometry(page)
  check(`${name}:空/多行/嵌套待办与首行文字居中`, rows.length === 4 && rows.every(r => Math.abs(r.delta) <= 1), JSON.stringify(rows.map(r => r.delta)))
  check(`${name}:所有待办保留 8px 留白`, rows.every(r => Math.abs(r.gap - 8) <= 0.3), JSON.stringify(rows.map(r => r.gap)))
  check(`${name}:多行内容真实换行`, rows[1]?.wrapped)
  check(`${name}:勾号完全位于方框内`, rows[3]?.tickInside)

  const empty = await caret(page)
  await page.keyboard.type('x')
  await page.waitForTimeout(160)
  const typed = await caret(page)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(160)
  const cleared = await caret(page)
  check(`${name}:首个字输入/删除不改变光标高度或基线`, empty.visible && typed.visible && cleared.visible
    && Math.abs(empty.height - typed.height) <= 1 && Math.abs(empty.top - typed.top) <= 1
    && Math.abs(cleared.height - typed.height) <= 1 && Math.abs(cleared.top - typed.top) <= 1,
    JSON.stringify({ empty, typed, cleared }))

  // 必须真点伪元素;程序 click 隐藏的读屏 widget 不能证明鼠标命中仍正确。
  const box = rows[0].box
  await page.mouse.click(box.left + box.width / 2, box.top + box.height / 2)
  await page.waitForFunction(s => document.querySelector(s).dataset.checked === 'true', TASK)
  check(`${name}:鼠标点方框可勾选`, await page.locator(TASK).first().getAttribute('data-checked') === 'true')
  await page.waitForTimeout(600) // 两次独立单击,避开 PM 对双击的文本选区分支。
  await page.mouse.click(box.left + box.width / 2, box.top + box.height / 2)
  await page.waitForFunction(s => document.querySelector(s).dataset.checked === 'false', TASK)
  check(`${name}:再点可取消`, await page.locator(TASK).first().getAttribute('data-checked') === 'false')
  if (shotDir) {
    await page.locator(PM).press('ControlOrMeta+Home')
    await page.waitForTimeout(160)
    await page.screenshot({ path: path.join(shotDir, `${name}.png`) })
  }
}

async function main() {
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
  let browser, app
  if (electronMode) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-checkbox-'))
    const main = path.join(home, 'main.cjs')
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');
app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:760,webPreferences:{contextIsolation:true}});w.loadURL(${JSON.stringify(URL)});});`)
    app = await _electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, main], env: { ...process.env, TANGU_HOME: home } })
  } else browser = await chromium.launch({ executablePath: findChromium() })
  try {
    const cases = [
      ['light', {}], ['dark', { dark: true }], ['small', { dark: true, small: true }],
      ['serif', { font: /Serif|衬线/ }], ['mono', { font: /Mono|等宽/ }], ['zoom125', { dark: true, zoom: 1.25 }],
    ]
    for (const [name, options] of (negativeControl ? cases.slice(0, 1) : cases)) {
      const page = app ? await app.firstWindow() : await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 760 } })
      // 页面排版偏好按路径持久化,每个场景先清隔离台架的偏好再加载。
      if (app) { await page.goto(URL); await page.evaluate(() => localStorage.clear()) }
      await run(page, name, options)
      if (!app) await page.close()
    }
  } finally { if (app) await app.close(); else await browser.close() }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
  process.exitCode = results.every(Boolean) ? 0 : 1
}
main().catch(e => { console.error(e); process.exitCode = 1 })
