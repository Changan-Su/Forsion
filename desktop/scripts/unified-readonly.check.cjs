// UnifiedPage 只读实例(公开分享页 /share/<token> 的形态,2026-09-07):零写盘 + 舞台只能平移。
// 用生产 UnifiedPage(readOnly)+ CanvasStage(readOnly),台架 `?upage&upane&uro`(harness.tsx)。
// 用法:npm run check:unifiedro(由 e2e-editor 自起/复用 Vite);`--nc` = 负对照:不带 &uro 跑同一套断言,
// 至少 8 条必须转红,证明这些断言真的量到了「只读」而不是恒真。
// K 组(评审 C-07 锁定页面,`&ulock` = amadeusViews 宿主一半的镜像):锁定 → 同一套只读实例 + 锁定条与解锁键、
// 打字零写盘、外部改动照常回灌;解锁 → 按盘上现文重挂成可编辑,接着打的字与外部那段一起落盘、零冲突副本;
// 锁定态是本机记忆,重开仍锁着;K5/K6(Codex 复核 P1)换实例前的落盘 / 重读失败 → 不切锁定态、保留当前实例
// (没落盘的字还在、还会重试)、出带「重试」的 error 提示,重试成功才锁上。负对照不跑 K 组(它量的是锁定切换,不是 &uro)。
// S 组(评审 V-16):只读画布里双击 = 选词、三击 = 选段、Cmd+C 复制出来;单击按住拖仍是平移(上面那格不动)。负对照同样不跑。
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

  // 右键正文(B-02):只读不接管右键 —— 原生菜单不被吞,不弹编辑块菜单,选区不被换成整块。
  await page.evaluate(() => {
    window.__ctx = []
    document.addEventListener('contextmenu', (e) => window.__ctx.push(e.defaultPrevented), false)
  })
  await page.mouse.click(p1.x + 20, p1.y + p1.height / 2, { button: 'right' })
  await page.waitForTimeout(300)
  const ctx = await page.evaluate(() => ({
    prevented: window.__ctx,
    menu: document.querySelectorAll('.unified-block-menu').length,
    nodeSel: window.__upage.probe.view().state.selection.toJSON().type === 'node',
  }))
  check('右键正文不吞原生菜单、不弹编辑块菜单、不改成整块选中', ctx.prevented.length === 1 && ctx.prevented[0] === false && ctx.menu === 0 && !ctx.nodeSel, JSON.stringify(ctx))
  await page.keyboard.press('Escape')

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

  if (!NC) await groupSelect(browser)
  if (!NC) await groupLock(browser)

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

/** S 组(V-16):只读画布能选中、复制卡片里的字。修前舞台的只读分支对一切按下无条件 preventDefault(= 平移),
 *  浏览器不再派发 mousedown,双击 / 三击 / 拖选全部落空;切到文档模式才能选。现在连击(计数 ≥ 2)落在正文上放行给原生选字。 */
async function groupSelect(browser) {
  const SEED = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":400},"cards":[{"ref":"k1","x":480,"y":0,"w":300}]}',
    '---', '', '# 只读画布', '', '主卡一段。', '', '<!-- a k1 -->', '', 'Alpha beta gamma delta epsilon', '', '<!-- /a k1 -->', '',
  ].join('\n')
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${URL}?upage&upane&uro&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.amx-ucard[data-anchor="k1"] p', { timeout: 20000 })
  await page.waitForTimeout(700)
  const at = await page.evaluate(() => {
    const r = document.createRange(); r.selectNodeContents(document.querySelector('.amx-ucard[data-anchor="k1"] p'))
    const b = r.getBoundingClientRect()
    return { x: b.left + 12, y: b.top + b.height / 2, x2: b.right - 4 }
  })
  const sel = () => page.evaluate(() => getSelection().toString().trim())
  const tf = () => page.evaluate(() => document.querySelector('.amx-stage-inner')?.style.transform ?? '')
  const tf0 = await tf()
  await page.mouse.dblclick(at.x, at.y)
  await page.waitForTimeout(250)
  const word = await sel()
  await page.waitForTimeout(700) // 越过连击间隔,下面是一次独立的三击
  await page.mouse.click(at.x, at.y, { clickCount: 3 })
  await page.waitForTimeout(250)
  const para = await sel()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await page.waitForTimeout(200)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e.message}`))
  const tf1 = await tf()
  await page.waitForTimeout(700)
  // 单击按住拖(文字上)仍是平移,卡片几何不动
  const x0 = await page.evaluate(() => document.querySelector('.amx-ucard[data-anchor="k1"]').dataset.x)
  await page.mouse.move(at.x, at.y); await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + (at.x2 - at.x) * i / 8, at.y + 5 * i)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const tf2 = await tf()
  const x1 = await page.evaluate(() => document.querySelector('.amx-ucard[data-anchor="k1"]').dataset.x)
  const writes = await page.evaluate(() => window.__upage.writes.length)
  await ctx.close()
  check('S1 只读画布双击卡内一个词 = 选中该词(视口不动)', word === 'Alpha' && tf1 === tf0, JSON.stringify({ word, tf0, tf1 }))
  check('S2 三击 = 选中整段,Cmd+C 复制出来', para.startsWith('Alpha beta gamma delta epsilon') && clip.includes('Alpha beta gamma delta epsilon'), JSON.stringify({ para, clip }))
  check('S3 单击按住拖仍 = 平移(视口变、卡片几何不动)、零写盘', tf2 !== tf1 && x0 === x1 && writes === 0, JSON.stringify({ tf1, tf2, x0, x1, writes }))
}

async function groupLock(browser) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.addInitScript(() => {
    window.__toasts = []
    window.addEventListener('amadeus:toast', (e) => window.__toasts.push(e.detail))
  })
  const url = `${URL}?upage&upane&ulock&useed=${encodeURIComponent('# 锁定\n\n第一段。\n\n第二段。\n')}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 20000 })
  await page.evaluate(() => localStorage.clear())
  await page.waitForTimeout(400)
  const disk = () => page.evaluate(() => window.__upage.vault.get('Unified.md'))
  const state = () => page.evaluate(() => ({
    editable: document.querySelector('.unified-body .ProseMirror')?.getAttribute('contenteditable'),
    bar: !!document.querySelector('[data-lock="on"] button'),
    writes: window.__upage.writes.length,
    text: document.querySelector('.unified-body .ProseMirror')?.textContent ?? '',
  }))
  const endOf = async (text) => {
    const box = await page.evaluate((text) => {
      const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent.includes(text))
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect()
      return { x: b.right - 1, y: b.top + b.height / 2 }
    }, text)
    await page.mouse.click(box.x, box.y)
    await page.waitForTimeout(80) // selectionchange 异步:光标就位再打字
  }

  await endOf('第一段。')
  await page.keyboard.type('甲')
  await page.waitForFunction(() => window.__upage.writes.length >= 1, null, { timeout: 5000 }).catch(() => {})
  const s0 = await state()
  check('K0 基线:未锁定时可编辑、打字落盘、没有锁定条', s0.editable === 'true' && !s0.bar && s0.writes >= 1 && (await disk()).includes('第一段。甲'), JSON.stringify(s0))

  await page.evaluate(() => window.__upage.setLocked(true))
  await page.waitForSelector('[data-lock="on"]', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
  const s1 = await state()
  await endOf('第二段。')
  await page.keyboard.type('乙')
  // 按路径的写口(模板 / 块表面插入)也不许往锁着的页里塞 —— 只读闸在实例的 pipe.readOnly 上,而它只在首次渲染
  // 写入:锁定态不进 key(不重挂)时这里照样插得进去(随后既不显示为可编辑、也永远不落盘)。
  const inserted = await page.evaluate(() => window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', '模板插入', 'end'))
  await page.waitForTimeout(1200)
  const s2 = await state()
  check('K1 锁定:只读实例 + 锁定条带解锁键,打字 / 插入都进不去、零写盘',
    s1.editable === 'false' && s1.bar && !s2.text.includes('乙') && !inserted && !s2.text.includes('模板插入') && s2.writes === s1.writes, JSON.stringify({ s1, s2, inserted }))
  if (SHOT) await page.screenshot({ path: path.join(SHOT, 'unified-locked.png') })

  const ext = (await disk()).replace('第二段。', '第二段。外部追加')
  await page.evaluate((t) => window.__upage.fire('Unified.md', t), ext)
  await page.waitForTimeout(800)
  const s3 = await state()
  check('K2 锁定下外部改动照常回灌、不写盘', s3.text.includes('外部追加') && s3.writes === s1.writes, JSON.stringify(s3))

  await page.click('[data-lock="on"] button')
  await page.waitForFunction(() => document.querySelector('.unified-body .ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
  await endOf('外部追加')
  await page.keyboard.type('丙')
  await page.waitForTimeout(1300)
  const s4 = await state()
  const d4 = await disk()
  const copies = await page.evaluate(() => [...window.__upage.vault.keys()].filter((k) => k.includes('(conflict')))
  check('K3 解锁:按盘上现文重挂成可编辑,接着打的字与外部那段一起落盘、零冲突副本',
    s4.editable === 'true' && !s4.bar && d4.includes('外部追加丙') && d4.includes('第一段。甲') && copies.length === 0, JSON.stringify({ s4, d4, copies }))

  await page.evaluate(() => window.__upage.setLocked(true))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 20000 })
  await page.waitForTimeout(400)
  const s5 = await state()
  check('K4 锁定是本机记忆:重开仍锁着', s5.editable === 'false' && s5.bar, JSON.stringify(s5))

  // K5:写不进去时锁定 → 不切、实例留着(字在、还会重试)、error 提示带「重试」;恢复后点重试才锁上且字已落盘
  await page.evaluate(() => { localStorage.clear(); window.__upage.setLocked(false) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 20000 })
  await page.waitForTimeout(400)
  await page.evaluate(() => { window.__upage.failWrites = Infinity; window.__toasts = [] })
  await endOf('第二段。')
  await page.keyboard.type('丁')
  const ok5 = await page.evaluate(() => window.__upage.setLocked(true))
  await page.waitForTimeout(600)
  const s6 = await state()
  const t5 = await page.evaluate(() => window.__toasts.filter((t) => t.level === 'error' && t.action).map((t) => t.text))
  const stored5 = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('amx.noteLocked:')))
  await page.evaluate(() => { window.__upage.failWrites = 0 })
  await page.evaluate(() => window.__toasts.filter((t) => t.level === 'error' && t.action).pop()?.action.run())
  await page.waitForSelector('[data-lock="on"]', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
  const s7 = await state()
  check('K5 写不进去时锁定:不切、实例留着(字还在)、error 提示带「重试」;恢复后重试才锁上且字已落盘',
    ok5 === false && s6.editable === 'true' && !s6.bar && s6.text.includes('丁') && !stored5 && t5.length >= 1
      && s7.editable === 'false' && s7.bar && (await disk()).includes('第二段。丁'),
    JSON.stringify({ ok5, s6, t5, stored5, s7, d: await disk() }))

  // K6:读不到盘上现文时解锁 → 不切(仍锁着)、提示重试
  const real = await page.evaluate(() => { window.__realRead = window.amadeus.readTextFile; window.amadeus.readTextFile = () => Promise.resolve(null); window.__toasts = []; return true })
  const ok6 = await page.evaluate(() => window.__upage.setLocked(false))
  await page.waitForTimeout(400)
  const s8 = await state()
  const t6 = await page.evaluate(() => window.__toasts.filter((t) => t.level === 'error' && t.action).length)
  await page.evaluate(() => { window.amadeus.readTextFile = window.__realRead })
  check('K6 读不到现文时解锁:不切(仍锁着)、提示重试', real && ok6 === false && s8.editable === 'false' && s8.bar && t6 >= 1, JSON.stringify({ ok6, s8, t6 }))
  await page.evaluate(() => localStorage.clear())
  await page.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
