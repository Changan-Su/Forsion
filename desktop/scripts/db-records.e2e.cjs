/** Real Electron + isolated vault: page content must survive immediate close, disk writes and restart.
 * Run after npm run build: node scripts/db-records.e2e.cjs
 * Visual-only review (same real boot, no restart): node scripts/db-records.e2e.cjs --visual
 * Companion renderer coverage: e2e-editor.cjs --check=db-interactions / --check=embed-inputs.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.join(__dirname, '..')
const visual = process.argv.includes('--visual')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-db-records-'))
const vault = path.join(home, 'vault')
const userData = path.join(home, 'userdata')
const shots = path.join(home, 'screenshots')
const DB = 'Records.db'
const NOTE = 'Database acceptance'
const BODY = 'Record content survives immediate close.'
const fixture = {
  version: 1, name: 'Project records',
  columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'state', name: 'Status', type: 'select', options: ['Planned', 'In progress', 'Done'] }, { id: 'hours', name: 'Hours', type: 'number' }],
  rows: [{ id: 'r1', cells: { name: 'Research database interactions', state: 'In progress', hours: 8 } }, { id: 'r2', cells: { name: 'Validate keyboard editing', state: 'Planned', hours: 3 } }],
  views: [{ id: 'table', name: 'Table', type: 'table' }, { id: 'list', name: 'List', type: 'list' }],
}
if (visual) {
  fixture.version = 2
  fixture.name = '项目记录 · Project records'
  fixture.columns[0].name = '任务名称 · Name'
  fixture.columns[1].name = '状态 · Status'
  fixture.columns[2].name = '工时 · Hours'
  fixture.rows[0].cells.name = 'Research database interactions · 交互调研'
  fixture.rows[1].cells.name = '验证键盘编辑与中文输入'
  fixture.rows[0].body = '## Research notes\n\n让编辑、菜单与记录页面保持一致。Keep the reading rhythm comfortable.\n\n- Review keyboard navigation\n- Check narrow windows\n'
  fixture.rows.push({ id: 'r3', cells: { name: 'Review the completed experience', state: 'Done', hours: 5 } })
}
fs.mkdirSync(vault, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(`${userData}-dev`, { recursive: true })
fs.writeFileSync(path.join(vault, DB), JSON.stringify(fixture, null, 2))
fs.writeFileSync(path.join(vault, `${NOTE}.md`), `# ${NOTE}\n\nBefore the database.\n\n![[${DB}]]\n\nAfter the database.\n`)
fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
const disk = () => JSON.parse(fs.readFileSync(path.join(vault, DB), 'utf8'))
async function until(predicate, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for persisted record')
}
let app, win, stub
let passed = 0
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail ? ': ' + JSON.stringify(detail) : ''}`); passed++; console.log(`PASS ${name}`) }
async function boot() {
  app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1440, height: 960 })
  await win.waitForSelector('#root', { timeout: 40000 })
  check('shell onboarding completes', await skipOnboarding(win))
  await win.evaluate(() => {
    localStorage.setItem('forsion_default_space', 'amadeus')
  })
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.am-app', { timeout: 30000 })
  const note = win.locator('.t2s-srow').filter({ hasText: NOTE }).first()
  if (!(await note.count())) await win.locator('.dv-edge-left').click().catch(() => {})
  await note.waitFor({ timeout: 30000 })
  await note.click()
  await win.waitForSelector('.amx-db [data-db-cell]', { timeout: 30000 })
}

async function visualReview() {
  const errors = []
  const failures = []
  // Collect visual mismatches so one bad focus ring does not hide the remaining screenshots.
  const verify = (name, ok, detail) => {
    if (ok) { passed++; console.log(`PASS ${name}`); return }
    failures.push({ name, detail }); console.error(`FAIL ${name}: ${JSON.stringify(detail)}`)
  }
  win.on('pageerror', (error) => errors.push(error.message))
  const table = win.locator('.unified-embed .amx-db').first()
  const cell = (row, col) => table.locator(`[data-row="${row}"] [data-db-cell="${col}"]`)
  const pause = () => win.waitForTimeout(160)
  const shoot = async (name, keepPointer = false) => {
    if (!keepPointer) await win.mouse.move(1, 1)
    await pause()
    await win.evaluate(() => document.fonts.ready)
    const file = path.join(shots, `${name}.png`)
    await win.screenshot({ path: file })
    console.log(`SCREENSHOT ${file}`)
  }
  const resize = async (width) => {
    await app.evaluate(({ BrowserWindow }, w) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(600, 600)
      window.setContentSize(w, 900)
    }, width)
    await win.setViewportSize({ width, height: 900 })
    await pause()
  }
  // Exercise the actual command/theme store. Mutating data-mode alone would leave light tokens behind.
  const mode = async (wanted) => {
    if (await win.locator('html').getAttribute('data-mode') === wanted) return
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换明暗模式')
    await win.locator('.cmd-item').filter({ hasText: '切换明暗模式' }).first().click()
    await win.waitForFunction((value) => document.documentElement.dataset.mode === value, wanted)
    await win.waitForTimeout(350)
  }
  const cellGeometry = (target) => target.evaluate((el) => {
    const text = el.querySelector('input, .amx-db-value-text')
    const row = el.closest('[data-row]')
    const r = el.getBoundingClientRect(), rr = row.getBoundingClientRect(), tr = text.getBoundingClientRect()
    const cs = getComputedStyle(text)
    const n = (v) => parseFloat(v) || 0
    const top = n(cs.paddingTop) + n(cs.borderTopWidth), bottom = n(cs.paddingBottom) + n(cs.borderBottomWidth)
    return { rowHeight: rr.height, cellHeight: r.height, textX: tr.left + n(cs.paddingLeft) + n(cs.borderLeftWidth),
      textCenter: tr.top + top + (tr.height - top - bottom) / 2, font: cs.fontSize, line: cs.lineHeight,
      rowTop: rr.top, cellWidth: r.width }
  })
  const focusSurface = async (target, name) => {
    const report = await target.evaluate((el) => {
      const painted = (cs) => cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
      const active = document.activeElement
      const nodes = [el]
      for (let node = active; node && node !== el && el.contains(node); node = node.parentElement) nodes.push(node)
      const layers = nodes.filter((node) => painted(getComputedStyle(node))).map((node) => ({
        tag: node.tagName, class: node.className, outline: getComputedStyle(node).outline, shadow: getComputedStyle(node).boxShadow,
      }))
      return { focused: el === active || el.contains(active), layers }
    })
    verify(`${name}: one cell focus surface`, report.focused && report.layers.length <= 1, report)
  }
  const checkToolbar = async (label) => {
    const report = await table.locator('.amx-db-viewbar').evaluate((bar) => {
      const db = bar.closest('.amx-db').getBoundingClientRect()
      const nodes = [...bar.querySelectorAll('.amx-db-viewtools > button, .amx-db-viewtools > input')]
      const items = nodes.map((node) => {
        const r = node.getBoundingClientRect(), cs = getComputedStyle(node)
        return { name: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim(),
          visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
          left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      })
      return { items, left: db.left, right: Math.min(db.right, innerWidth), bottom: innerHeight, width: db.width }
    })
    verify(`${label}: toolbar controls remain visible`, report.items.length === 7 && report.items.every((item) =>
      item.visible && item.left >= report.left - 1 && item.right <= report.right + 1 && item.top >= 0 && item.bottom <= report.bottom + 1), report)
  }
  const checkMenu = async (label) => {
    const pop = win.locator('.amx-db-pop').last()
    await pop.waitFor()
    const report = await pop.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.left + r.width / 2), Math.min(innerHeight - 1, r.top + Math.min(24, r.height / 2)))
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
        hit: !!hit && el.contains(hit), overflowX: el.scrollWidth - el.clientWidth }
    })
    verify(`${label}: menu remains inside viewport and receives clicks`, report.left >= -1 && report.top >= -1 &&
      report.right <= report.width + 1 && report.bottom <= report.height + 1 && report.hit && report.overflowX <= 1, report)
    return pop
  }
  const checkMenuFocus = async (input, label) => {
    await input.focus()
    const report = await input.evaluate((el) => {
      const marked = []
      // The menu's outer elevation is intentional; only nested field wrappers count as duplicate focus.
      for (let node = el; node && !node.classList.contains('amx-db-pop'); node = node.parentElement) {
        const cs = getComputedStyle(node)
        if (cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0))
          marked.push({ class: node.className, shadow: cs.boxShadow, outline: cs.outline })
      }
      return marked
    })
    verify(`${label}: field does not stack nested focus rings`, report.length <= 1, report)
  }
  const dismissMenu = async () => {
    await win.keyboard.press('Escape')
    if (await win.locator('.amx-db-pop').count()) {
      const head = table.locator('.amx-db-head')
      const box = await head.boundingBox()
      await win.mouse.click(box.x + 5, box.y + box.height / 2)
    }
    await win.waitForSelector('.amx-db-pop', { state: 'detached' })
  }
  const colors = () => table.evaluate((el) => ({
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(el).color, bg: getComputedStyle(el).getPropertyValue('--bg'),
    mode: document.documentElement.dataset.mode,
    language: document.documentElement.dataset.theme,
  }))

  await resize(1440)
  await mode('light')
  verify('Default appearance is raised at boot', await win.evaluate(() => localStorage.getItem('forsion_theme_flat') === null && document.documentElement.dataset.flat === '0'))
  const light = await colors()
  await win.locator('.amx-more-btn').click()
  await win.locator('.ctx-menu').evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})))
  })
  const referenceMenu = await win.locator('.ctx-menu button').first().evaluate(el => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect()
    return { size: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), height: r.height, gap: cs.gap, shadow: getComputedStyle(el.parentElement).boxShadow }
  })
  verify('Approved More menu retains its existing scale', referenceMenu.size === 14 && referenceMenu.height === 32, referenceMenu)
  verify('More menu has a subtle surface shadow', referenceMenu.shadow !== 'none', referenceMenu)
  await shoot('visual-light-reference-more')
  await win.locator('.amx-more-btn').click()
  await win.mouse.click(1, 1)
  await win.locator('.ctx-menu').waitFor({ state: 'detached' })
  await checkToolbar('Light / 1440')
  await shoot('visual-light-table')
  await table.locator('.amx-db-head').hover()
  await pause()
  const sourceCount = await table.evaluate((el) => {
    const source = el.closest('.unified-embed')?.querySelector(':scope > .amx-src-btn--block')
    const count = el.querySelector('.amx-db-count')
    if (!source || !count) return { missing: !source ? 'source button' : 'row count' }
    const box = (node) => {
      const r = node.getBoundingClientRect(), cs = getComputedStyle(node)
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0 }
    }
    const sourceRect = box(source), countRect = box(count)
    return { sourceRect, countRect, overlap: sourceRect.left < countRect.right && sourceRect.right > countRect.left &&
      sourceRect.top < countRect.bottom && sourceRect.bottom > countRect.top }
  })
  verify('Hovered source button does not cover the row count', sourceCount.sourceRect?.visible &&
    sourceCount.countRect?.visible && !sourceCount.overlap, sourceCount)
  await shoot('visual-light-header-hover', true)
  const title = cell('r1', 'name')
  await title.focus()
  await pause()
  await focusSurface(title, 'Light selected cell')
  await shoot('visual-light-selected')
  const before = await cellGeometry(title)
  const typography = await table.evaluate((el) => {
    const style = (selector) => {
      const node = el.querySelector(selector), cs = getComputedStyle(node)
      return { font: cs.fontFamily, size: parseFloat(cs.fontSize), weight: cs.fontWeight, line: parseFloat(cs.lineHeight) }
    }
    const names = [...el.querySelectorAll('[data-db-cell="name"] .amx-db-value-text')].map((node) =>
      ({ text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1 }))
    return { body: style('.amx-db-value-text'), header: style('.amx-db-thbtn'), chip: style('.amx-db-chip'),
      title: style('.amx-db-name'), names }
  })
  verify('Compact Chinese / Latin text stays readable at automatic widths', typography.body.size === 13 &&
    typography.body.line >= typography.body.size * 1.4 && typography.chip.size >= 12 && before.rowHeight <= 34 &&
    typography.names.every((name) => !name.clipped), typography)
  await title.locator('.amx-db-value-display').click()
  await title.locator('input').waitFor()
  await pause()
  const editing = await cellGeometry(title)
  verify('Editing preserves text origin, font and row geometry', Math.abs(before.rowHeight - editing.rowHeight) <= 1 &&
    Math.abs(before.cellHeight - editing.cellHeight) <= 1 && Math.abs(before.textX - editing.textX) <= 1 &&
    Math.abs(before.textCenter - editing.textCenter) <= 1 && before.font === editing.font && before.line === editing.line,
    { before, editing })
  await focusSurface(title, 'Light editing cell')
  await shoot('visual-light-editing')
  await win.keyboard.press('Escape')

  await cell('r1', 'state').locator('.amx-db-cellbtn').click()
  await checkMenu('Select options')
  const menuType = await win.locator('.amx-db-pop').last().evaluate((el) => {
    const cs = getComputedStyle(el), input = el.querySelector('input'), field = getComputedStyle(input)
    return { font: cs.fontFamily, size: parseFloat(cs.fontSize), fieldFont: field.fontFamily, fieldSize: parseFloat(field.fontSize) }
  })
  verify('Portal menu and search field match the approved More menu scale', menuType.font === typography.body.font &&
    menuType.size === referenceMenu.size && menuType.fieldSize === menuType.size, menuType)
  await checkMenuFocus(win.locator('.amx-db-option-search'), 'Option search')
  await shoot('visual-light-select-menu')
  await dismissMenu()
  await table.locator('.amx-db-thbtn').filter({ hasText: 'Hours' }).click()
  const columnMenu = await checkMenu('Column configuration')
  // Sample the actual production entrance in the real window, without altering its keyframes.
  await columnMenu.evaluate((el) => {
    el.style.animation = 'none'; void el.offsetWidth; el.style.removeProperty('animation')
    const animation = el.getAnimations()[0]
    if (animation) { animation.pause(); animation.currentTime = 0 }
  })
  for (const time of [0, 45, 90, 180]) {
    await columnMenu.evaluate((el, time) => { const animation = el.getAnimations()[0]; if (animation) animation.currentTime = time }, time)
    await win.screenshot({ path: path.join(shots, `visual-menu-enter-${time}.png`) })
  }
  await columnMenu.evaluate((el) => el.getAnimations().forEach((animation) => animation.finish()))

  await checkMenuFocus(columnMenu.locator('.amx-db-pop-input').first(), 'Column rename')
  await shoot('visual-light-column-menu')
  verify('Property types are not expanded into the root menu', await columnMenu.locator('.amx-db-type-menu').count() === 0)
  await columnMenu.locator('.amx-db-type-trigger').click()
  await shoot('visual-light-property-types')
  await win.keyboard.press('Escape')
  verify('Escape returns from types to the property menu and restores focus',
    await columnMenu.locator('.amx-db-type-trigger').evaluate(el => document.activeElement === el))
  await columnMenu.locator('.amx-db-type-trigger').click()
  await columnMenu.getByRole('button', { name: '数字', exact: true }).click()
  verify('Choosing a type returns to its configuration', await columnMenu.locator('.amx-db-type-trigger').isVisible() && await columnMenu.getByLabel('precision', { exact: true }).count() === 1)
  await dismissMenu()
  await table.locator('[aria-label="view settings"]').click()
  const viewMenu = await checkMenu('View configuration')
  await checkMenuFocus(viewMenu.locator('.amx-db-pop-input').first(), 'View rename')
  await shoot('visual-light-view-menu')
  verify('Layout controls live in settings rather than the toolbar',
    await table.locator('.amx-db-viewbar .amx-db-autosize, .amx-db-viewbar .amx-db-groupbtn, .amx-db-viewbar .amx-db-foldbtn').count() === 0 &&
    await viewMenu.locator('.amx-db-autosize, .amx-db-groupbtn, .amx-db-foldbtn').count() === 3)
  await viewMenu.locator('.amx-db-groupbtn').click()
  await win.getByRole('combobox', { name: '按属性分组', exact: true }).selectOption('state')
  await win.locator('.amx-db-menu-back').click()
  verify('Group submenu returns to settings with its selection intact', await win.locator('.amx-db-groupbtn').getAttribute('data-on') === 'true')
  await win.locator('.amx-db-groupbtn').click()
  await win.getByRole('combobox', { name: '按属性分组', exact: true }).selectOption('')
  await win.locator('.amx-db-menu-back').click()
  await win.locator('.amx-db-foldbtn').click()
  await shoot('visual-light-fold-menu')
  await win.locator('.amx-db-menu-back').click()
  verify('Fold submenu returns directly to view settings', await win.locator('.amx-db-autosize').isVisible())
  await viewMenu.locator('.amx-db-opt-danger').scrollIntoViewIfNeeded()
  await shoot('visual-light-view-actions')
  await dismissMenu()

  await title.hover()
  await title.locator('.amx-db-rowopen').click()
  await win.waitForSelector('.amx-db-peek-body .ProseMirror')
  await shoot('visual-light-peek')
  const prop = win.locator('.amx-db-peek [data-db-cell="name"]')
  await prop.locator('.amx-db-value-display').click()
  await prop.locator('input').waitFor()
  await focusSurface(prop, 'Peek property editor')
  await shoot('visual-light-peek-editing')
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: '关闭记录', exact: true }).click()
  await table.getByRole('tab', { name: 'List', exact: true }).click()
  verify('List displays all fixture records', await table.locator('.amx-db-list-row').count() === fixture.rows.length)
  await shoot('visual-light-list')
  await table.getByRole('tab', { name: 'Table', exact: true }).click()

  await mode('dark')
  const dark = await colors()
  verify('Real theme command updates the palette as well as mode', dark.mode === 'dark' && dark.text !== light.text &&
    (dark.body !== light.body || dark.bg !== light.bg), { light, dark })
  await title.focus()
  await focusSurface(title, 'Dark selected cell')
  await shoot('visual-dark-selected')
  await cell('r1', 'state').locator('.amx-db-cellbtn').click()
  await checkMenu('Dark select options')
  await checkMenuFocus(win.locator('.amx-db-option-search'), 'Dark option search')
  await shoot('visual-dark-select-menu')
  await dismissMenu()

  for (const width of [900, 700]) {
    await resize(width)
    await table.locator('.amx-db-viewbar').scrollIntoViewIfNeeded()
    await checkToolbar(`Dark / ${width}`)
    await shoot(`visual-dark-${width}-table`)
    await table.locator('[aria-label="view settings"]').click()
    await checkMenu(`Dark / ${width} view menu`)
    await shoot(`visual-dark-${width}-view-menu`)
    await dismissMenu()
  }
  await mode('light')
  await table.locator('.amx-db-viewbar').scrollIntoViewIfNeeded()
  await checkToolbar('Light / 700')
  await shoot('visual-light-700-table')
  await resize(1440)
  // Deliberately local media fixtures: geometry/focus/persistence do not depend on a remote photo service.
  const coverSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#dde7df"/><path d="M0 180 100 45 200 180M100 180 245 65 320 180" fill="#a3b6aa"/></svg>'
  await win.route('https://picsum.photos/**', route => route.fulfill({ contentType: 'image/svg+xml', body: coverSvg }))
  await win.route('https://example.com/forsion-cover.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: coverSvg }))
  const addCover = win.getByRole('button', { name: '添加封面', exact: true })
  await win.locator('.amx-title-wrap').hover()
  await addCover.click()
  const cover = win.getByRole('dialog', { name: '封面', exact: true })
  await cover.waitFor()
  const coverStyle = await cover.evaluate(el => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect()
    return { size: cs.fontSize, line: cs.lineHeight, radius: cs.borderRadius, token: cs.getPropertyValue('--radius-md').trim(),
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
      overflow: el.scrollWidth - el.clientWidth }
  })
  verify('Cover picker shares application text and surface tokens', coverStyle.size === '14px' && coverStyle.line === '20px' && coverStyle.radius === coverStyle.token, coverStyle)
  verify('Cover picker is clamped without horizontal overflow', coverStyle.left >= 0 && coverStyle.right <= coverStyle.width && coverStyle.top >= 0 && coverStyle.bottom <= coverStyle.height && coverStyle.overflow <= 1, coverStyle)
  await shoot('visual-light-cover-gallery')
  await cover.getByRole('tab', { name: '图库', exact: true }).focus()
  await win.keyboard.press('ArrowRight')
  verify('Cover tabs support arrow key selection', await cover.getByRole('tab', { name: '链接', exact: true }).getAttribute('aria-selected') === 'true')
  await cover.getByLabel('图片链接', { exact: true }).fill('not-a-url')
  verify('Invalid image URLs cannot be applied', await cover.getByRole('button', { name: '设为封面' }).isDisabled())
  await shoot('visual-light-cover-link')
  await cover.getByRole('tab', { name: '上传', exact: true }).click()
  await shoot('visual-light-cover-upload')
  await win.keyboard.press('Escape')
  await cover.waitFor({ state: 'detached' })
  verify('Escape restores focus to the cover opener', await addCover.evaluate(el => document.activeElement === el))
  await mode('dark')
  await resize(700)
  await win.locator('.amx-title-wrap').hover()
  await addCover.click()
  await cover.waitFor()
  await shoot('visual-dark-700-cover-gallery')
  await cover.getByRole('tab', { name: '链接', exact: true }).click()
  await cover.getByLabel('图片链接', { exact: true }).fill('https://example.com/forsion-cover.svg')
  const noteBody = () => fs.readFileSync(path.join(vault, `${NOTE}.md`), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const beforeCoverBody = noteBody()
  await cover.getByRole('button', { name: '设为封面' }).click()
  await until(() => fs.readFileSync(path.join(vault, `${NOTE}.md`), 'utf8').includes('https://example.com/forsion-cover.svg'))
  verify('Cover writes preserve the database embed and surrounding note', noteBody() === beforeCoverBody &&
    /Before the database\.[\s\S]*!\[\[Records\.db(?:\|[^\]]*)?\]\][\s\S]*After the database\./.test(noteBody()))
  await win.keyboard.press('Escape')
  verify('Visual-only run has no renderer exceptions', errors.length === 0, errors)
  fs.writeFileSync(path.join(shots, 'visual-report.json'), JSON.stringify({ passed, light, dark, before, editing, sourceCount, typography, menuType, errors, failures }, null, 2))
  assert.equal(failures.length, 0, `${failures.length} visual checks failed; inspect ${shots}`)
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first')
  stub = await startStubEngine()
  try {
    await boot()
    if (visual) {
      await visualReview()
      console.log(`${passed}/${passed} passed. Visual evidence: ${shots}`)
      return
    }
    await win.locator('.amx-db-rowopen').first().click()
    await win.waitForSelector('.amx-db-peek-body .ProseMirror', { timeout: 15000 })
    check('table records open in a non-modal side peek', await win.locator('.amx-db-peek').getAttribute('aria-modal') === 'false')
    const body = win.locator('.amx-db-peek-body .ProseMirror')
    await body.fill(BODY)
    // No debounce wait: closing must not cancel the last content change.
    await win.getByRole('button', { name: '关闭记录', exact: true }).click()
    await until(() => disk().rows[0].body?.includes(BODY))
    check('immediate close saves page content through real IPC', disk().rows[0].body.includes(BODY))
    check('page content upgrades the format to protect against older clients', disk().version === 2)
    check('the embedding note still contains its database reference', fs.readFileSync(path.join(vault, `${NOTE}.md`), 'utf8').includes(`![[${DB}]]`))
    await win.locator('.amx-db-rowopen').first().click()
    await win.waitForSelector('.amx-db-peek-body .ProseMirror')
    check('reopening shows the saved content', (await body.innerText()).includes(BODY))
    await win.screenshot({ path: path.join(shots, 'side-peek.png') })
    await win.getByRole('button', { name: '居中预览', exact: true }).click()
    await until(() => disk().views[0].openMode === 'center')
    check('the view remembers its record opening mode on disk', disk().views[0].openMode === 'center')
    await win.screenshot({ path: path.join(shots, 'center-peek.png') })
    await win.getByRole('button', { name: '下一条记录', exact: true }).click()
    check('next record does not inherit the previous body', !(await body.innerText()).includes(BODY))
    await app.close(); app = null
    await boot()
    await win.locator('.amx-db-rowopen').first().click()
    await win.waitForSelector('.amx-db-peek-body .ProseMirror')
    check('content survives an application restart', (await win.locator('.amx-db-peek-body .ProseMirror').innerText()).includes(BODY))
    check('opening mode survives an application restart', await win.locator('.amx-db-peek-shade').getAttribute('data-mode') === 'center')
    console.log(`${passed}/${passed} passed. Evidence: ${home}`)
  } catch (error) {
    if (win) await win.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
    console.error(`Evidence: ${home}`)
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    if (stub) await stub.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
