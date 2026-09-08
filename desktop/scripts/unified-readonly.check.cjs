// UnifiedPage 只读实例(公开分享页 /share/<token> 的形态,2026-09-07):零写盘 + 舞台只能平移。
// 用生产 UnifiedPage(readOnly)+ CanvasStage(readOnly),台架 `?upage&upane&uro`(harness.tsx)。
// 用法:npm run check:unifiedro(由 e2e-editor 自起/复用 Vite);`--nc` = 负对照:不带 &uro 跑同一套断言,
// 至少 8 条必须转红,证明这些断言真的量到了「只读」而不是恒真。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const NC = process.argv.includes('--nc')
const RO = NC ? '' : '&uro'
// `--shot=<目录>`:文档 / 画布两态各留一张真实截图(DESIGN.md §8:观感类改动交付前必看一张真图)。
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length)

const DOC_SEED = [
  '---',
  'tags:',
  '  - alpha',
  '  - beta',
  '---',
  '# 只读标题',
  '',
  '第一段正文。',
  '',
  '- [ ] 待办一',
  '- [x] 待办二',
  '',
  '第二段正文,带 [[Embedded]] 双链。',
  '',
].join('\n')
const CANVAS_SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":700,"y":40,"w":300}]}',
  '---',
  '',
  '主卡正文。',
  '',
  '<!-- a k1 -->',
  '卡片正文。',
  '',
].join('\n')

const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  // ── 文档模式 ──────────────────────────────────────────────────────────────
  await page.goto(`${URL}?upage&upane${RO}&useed=${encodeURIComponent(DOC_SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 20000 })
  await page.waitForTimeout(500)

  const doc = await page.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    return {
      editable: pm?.getAttribute('contenteditable'),
      titleInput: !!document.querySelector('input.amx-title-input'),
      titleStatic: document.querySelector('h1.amx-title-static')?.textContent ?? null,
      titleActions: !!document.querySelector('.amx-title-actions'),
      pageTail: !!document.querySelector('.page-tail'),
    }
  })
  check('正文 contenteditable=false', doc.editable === 'false', JSON.stringify(doc))
  check('标题是静态 h1,不是 input', !doc.titleInput && doc.titleStatic === 'Unified', JSON.stringify(doc))
  check('没有「添加图标/封面」动作条', !doc.titleActions)
  check('没有尾部空白点击区(page-tail)', !doc.pageTail)
  if (SHOT) { fs.mkdirSync(SHOT, { recursive: true }); await page.screenshot({ path: path.join(SHOT, `unified-ro-doc${NC ? '-nc' : ''}.png`) }) }

  // 悬停第一段:只读文档不给 ⠿ 把手(blockLayer 按 view.editable 闸)。
  const p1 = await page.locator('.unified-body .ProseMirror p').first().boundingBox()
  await page.mouse.move(p1.x + 20, p1.y + p1.height / 2)
  await page.waitForTimeout(300)
  // gutter 的 DOM 恒在场(挂载即建),显隐靠 data-show —— 量 DOM 个数恒为 3,量不到只读(首版假红/假绿同源)。
  const handle = await page.evaluate(() => document.querySelectorAll('.unified-gutter[data-show="true"]').length)
  check('悬停正文不出 ⠿ / ＋ 把手', handle === 0, `shownGutters=${handle}`)

  // 点进正文打字 → 一个字都进不去,更不写盘(等过 800ms 防抖窗)。
  const bodyBefore = await page.evaluate(() => window.__upage.probe.fmState().body)
  await page.mouse.click(p1.x + 20, p1.y + p1.height / 2)
  await page.keyboard.type('xyz')
  await page.waitForTimeout(1300)
  const afterType = await page.evaluate(() => ({
    body: window.__upage.probe.fmState().body,
    writes: window.__upage.writes.length,
    text: document.querySelector('.unified-body .ProseMirror')?.textContent ?? '',
  }))
  check('打字进不去正文', afterType.body === bodyBefore && !afterType.text.includes('xyz'), JSON.stringify({ writes: afterType.writes, hasXyz: afterType.text.includes('xyz') }))
  check('打字后零写盘', afterType.writes === 0, `writes=${afterType.writes}`)

  // 待办勾选框:点左侧 gutter 不翻转。
  const li = page.locator('li[data-item-type="task"]').first()
  const liBox = await li.boundingBox()
  const checkedBefore = await li.getAttribute('data-checked')
  await page.mouse.click(liBox.x + 1, liBox.y + liBox.height / 2)
  await page.waitForTimeout(200)
  const checkedAfter = await li.getAttribute('data-checked')
  check('点待办勾选框不翻转', checkedBefore === checkedAfter, `${checkedBefore} → ${checkedAfter}`)

  // 属性面板:只展示,不给添加/改键/删除。
  await page.click('.amx-props-chip')
  await page.waitForTimeout(150)
  const props = await page.evaluate(() => ({
    roRows: document.querySelectorAll('.amx-prop-row-ro').length,
    add: !!document.querySelector('.amx-props-add'),
    keyInputs: document.querySelectorAll('input.amx-prop-key').length,
    chips: document.querySelectorAll('.amx-prop-row-ro .amx-chip').length,
  }))
  check('属性面板只读:1 行静态、2 枚 chip、无添加钮、无键名输入框', props.roRows === 1 && props.chips === 2 && !props.add && props.keyInputs === 0, JSON.stringify(props))

  // ── 画布模式 ──────────────────────────────────────────────────────────────
  await page.goto(`${URL}?upage&upane${RO}&useed=${encodeURIComponent(CANVAS_SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.amx-ucard[data-anchor="k1"] p', { timeout: 20000 })
  await page.waitForTimeout(600)

  const stage = await page.evaluate(() => ({
    active: !!document.querySelector('.amx-stage:not(.amx-stage-off)'),
    ro: !!document.querySelector('.amx-stage.amx-stage-ro'),
    tools: !!document.querySelector('.amx-stage-tools'),
    chrome: !!document.querySelector('.amx-stage-hud, .amx-stage-zoom, [aria-label]'),
  }))
  check('画布模式已进入且带只读标记', stage.active && stage.ro, JSON.stringify(stage))
  check('只读舞台不出工具栏', !stage.tools, JSON.stringify(stage))
  if (SHOT) await page.screenshot({ path: path.join(SHOT, `unified-ro-canvas${NC ? '-nc' : ''}.png`) })

  // 拖卡片:只读下 = 平移视口,卡片几何一动不动。
  const card = page.locator('.amx-ucard[data-anchor="k1"]')
  const before = await page.evaluate(() => {
    const el = document.querySelector('.amx-ucard[data-anchor="k1"]')
    return { x: el.dataset.x, y: el.dataset.y, tf: document.querySelector('.amx-stage-inner')?.style.transform ?? '' }
  })
  const cb = await card.boundingBox()
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2)
  await page.mouse.down()
  await page.mouse.move(cb.x + cb.width / 2 + 60, cb.y + cb.height / 2 + 40, { steps: 6 })
  await page.mouse.move(cb.x + cb.width / 2 + 150, cb.y + cb.height / 2 + 100, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => {
    const el = document.querySelector('.amx-ucard[data-anchor="k1"]')
    return { x: el.dataset.x, y: el.dataset.y, tf: document.querySelector('.amx-stage-inner')?.style.transform ?? '' }
  })
  check('拖卡片不改卡片几何', before.x === after.x && before.y === after.y, `${before.x},${before.y} → ${after.x},${after.y}`)
  check('拖动 = 平移视口(transform 变了)', before.tf !== after.tf, `${before.tf} → ${after.tf}`)

  // 双击卡片不进编辑;选中后 Delete 也删不掉。
  const cb2 = await card.boundingBox()
  await page.mouse.dblclick(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2)
  await page.waitForTimeout(300)
  const focusInPm = await page.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror'))
  check('双击卡片不进编辑态', !focusInPm)
  await page.mouse.click(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)
  const cards = await page.evaluate(() => document.querySelectorAll('.amx-ucard').length)
  check('Delete 删不掉卡片', cards === 1, `cards=${cards}`)

  await page.waitForTimeout(1200)
  const writes = await page.evaluate(() => window.__upage.writes.length)
  check('画布一轮交互后零写盘', writes === 0, `writes=${writes}`)

  await browser.close()
  const ok = results.filter(Boolean).length
  const failed = results.length - ok
  if (NC) {
    // 负对照:同一套断言跑在可编辑实例上,必须大面积转红(至少 8 条)才说明它们量到了只读本身。
    console.log(`\n负对照(不带 &uro):${failed}/${results.length} 条转红`)
    process.exit(failed >= 8 ? 0 : 1)
  }
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
