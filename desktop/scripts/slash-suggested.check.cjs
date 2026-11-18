// 斜杠菜单首屏「常用」+ 桌面悬停预览卡(Notion 对齐 A2)真浏览器检查。
// 常用的顺序与不重复、「基础」里剩下的标题 3–6;只认鼠标悬停出卡(键盘上下 / 刚打开 / 没登记的项都不出);
// 从常用里点「表格」照常插入;英文界面叫 Suggested;手机块面板(+)也是常用在最前。
// 用法:npm run check:slashsuggested(worktree 里设 HARNESS_URL 指到自己起的端口)。截图在 SHOT_DIR。
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const origin = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const out = process.env.SHOT_DIR || '/tmp/forsion-slash-suggested'
fs.mkdirSync(out, { recursive: true })
const checks = [], errors = []
const ok = (name, value, info) => { assert.ok(value, `${name}${info === undefined ? '' : ` — ${JSON.stringify(info)}`}`); checks.push(name); console.log('PASS', name) }
const SEED = '# 发布手册\n\n第一段 ALPHA\n\n尾段 OMEGA\n'
const sleep = (p, ms = 250) => p.waitForTimeout(ms)
const PM = '.unified-body .ProseMirror'

async function open(browser, opts = {}, query = '') {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, ...opts })
  p.setDefaultTimeout(15000); p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(origin + '?upage&upane' + query + '&useed=' + encodeURIComponent(SEED))
  await p.locator(PM).waitFor({ timeout: 120000 }); await sleep(p, 600)
  return p
}
/** 尾段末尾回车出一个空段,打 '/' 开菜单(键盘打开,鼠标不在菜单上)。 */
async function openSlash(p) {
  await p.evaluate(() => {
    const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
    let hit = null
    st.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent.includes('OMEGA')) hit = pos + 1 + n.content.size })
    v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)))
  })
  await p.mouse.move(5, 5)
  await p.keyboard.press('Enter'); await p.keyboard.type('/'); await p.locator('.slash-menu').waitFor(); await sleep(p, 300)
}
const groups = (p) => p.locator('.slash-menu .slash-group').evaluateAll((gs) => gs.map((g) => ({ label: g.querySelector('.slash-group-label')?.textContent, keys: [...g.querySelectorAll('.slash-item')].map((b) => b.dataset.key) })))

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const p = await open(browser)
    await openSlash(p)
    const gs = await groups(p)
    ok('第一组叫「常用」,第二组「基础」', gs[0]?.label === '常用' && gs[1]?.label === '基础', gs.map((g) => g.label))
    // 台架不装内置插件 → 没有「提示标注」;目录块(toc)是另一个分支 —— 有就该排在对应位置
    const want = ['text', 'todo', 'ul', 'h1', 'h2', 'callout-note', 'table', 'image', 'columns', 'toc']
    ok('常用的顺序:文本、待办、无序列表、标题 1、标题 2、(标注)、表格、图片、分栏、(目录)', JSON.stringify(gs[0].keys) === JSON.stringify(want.filter((k) => gs[0].keys.includes(k))) && ['text', 'todo', 'ul', 'h1', 'h2', 'table', 'image', 'columns'].every((k) => gs[0].keys.includes(k)), gs[0].keys)
    const all = gs.flatMap((g) => g.keys)
    ok('「基础」页里每一项只出现一次', new Set(all).size === all.length, all)
    ok('标题 3–6 收进「基础」组', ['h3', 'h4', 'h5', 'h6'].every((k) => gs[1].keys.includes(k)), gs[1].keys)
    ok('引用、折叠、代码不在常用里', ['quote', 'fold', 'code'].every((k) => !gs[0].keys.includes(k) && all.includes(k)))
    ok('首项高亮的是「文本」', (await p.locator('.slash-item[data-active]').getAttribute('data-key')) === 'text')
    ok('键盘打开、鼠标没动:没有预览卡', await p.locator('.slash-preview').count() === 0)

    // ── 悬停预览卡 ──
    const menuBox = await p.locator('.slash-menu').boundingBox()
    const todo = p.locator('.slash-item[data-key="todo"]'), tb = await todo.boundingBox()
    await p.mouse.move(tb.x + 30, tb.y + tb.height / 2, { steps: 4 }); await sleep(p, 250)
    const card = p.locator('.slash-preview')
    ok('鼠标停在「待办」上:出预览卡', await card.count() === 1 && (await card.locator('.slash-preview-title').textContent()) === '待办')
    ok('预览卡有小样和一句话', await card.locator('.slash-preview-sample .sp-box').count() === 3 && ((await card.locator('.slash-preview-desc').textContent()) || '').length > 4)
    const cb = await card.boundingBox()
    ok('预览卡在菜单右边、上沿对着那一项', cb.x >= menuBox.x + menuBox.width - 1 && Math.abs(cb.y - tb.y) < 16, { menu: menuBox, card: cb, item: tb })
    ok('预览卡不吃指针', (await card.evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none')
    await p.screenshot({ path: path.join(out, 'preview-todo.png') })
    const table = p.locator('.slash-item[data-key="table"]'), tbb = await table.boundingBox()
    await p.mouse.move(tbb.x + 30, tbb.y + tbb.height / 2, { steps: 3 }); await sleep(p, 200)
    ok('换到「表格」:卡片跟着换', (await card.locator('.slash-preview-title').textContent()) === '表格' && await card.locator('.sp-table').count() === 1)
    await p.keyboard.press('ArrowDown'); await sleep(p, 200)
    ok('按 ↓ 键盘选:预览卡收起', await p.locator('.slash-preview').count() === 0)
    const cardItem = p.locator('.slash-item[data-key="card"]')
    await cardItem.scrollIntoViewIfNeeded(); const ci = await cardItem.boundingBox()
    await p.mouse.move(ci.x + 30, ci.y + ci.height / 2, { steps: 3 }); await sleep(p, 200)
    ok('没登记小样的项(卡片)不出预览卡', await p.locator('.slash-preview').count() === 0)
    await p.mouse.move(menuBox.x + menuBox.width + 200, menuBox.y - 40, { steps: 3 }); await sleep(p, 150)

    // ── 打字搜索:不分组、不出常用 ──
    await p.keyboard.type('biaoti'); await sleep(p, 300)
    ok('打字搜索照旧是平铺清单(没有组名)', await p.locator('.slash-menu .slash-group-label').count() === 0 && (await p.locator('.slash-item').first().getAttribute('data-key')) === 'h1')
    for (let i = 0; i < 'biaoti'.length; i++) await p.keyboard.press('Backspace')
    await sleep(p, 300)

    // ── 从常用里点「表格」照常插入 ──
    const t2 = await p.locator('.slash-item[data-key="table"]').boundingBox()
    await p.mouse.move(t2.x + 30, t2.y + t2.height / 2); await p.mouse.down(); await p.mouse.up(); await sleep(p, 400)
    const hasTable = await p.evaluate(() => { let t = false; window.__upage.probe.view().state.doc.descendants((n) => { if (n.type.name === 'table') t = true }); return t })
    ok('点常用里的「表格」插入表格,菜单和卡片都关了', hasTable && await p.locator('.slash-menu').count() === 0 && await p.locator('.slash-preview').count() === 0)
    await p.close()

    // ── 英文界面 ──
    {
      const e = await open(browser, { locale: 'en-US' })
      await openSlash(e)
      const eg = await groups(e)
      ok('英文界面:第一组叫 Suggested', eg[0]?.label === 'Suggested', eg.map((g) => g.label))
      const it = await e.locator('.slash-item[data-key="h2"]').boundingBox()
      await e.mouse.move(it.x + 30, it.y + it.height / 2, { steps: 3 }); await sleep(e, 250)
      const desc = await e.locator('.slash-preview-desc').textContent()
      ok('英文界面:预览卡的话是英文', !!desc && !/[一-鿿]/.test(desc), desc)
      await e.close()
    }

    // ── 手机块面板(⋯ 胶囊的 +):常用在最前,不重复 ──
    {
      const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      const m = await ctx.newPage(); m.setDefaultTimeout(15000); m.on('pageerror', (er) => errors.push(er.message))
      await m.goto(origin + '?upage&upane&umbar&useed=' + encodeURIComponent(SEED))
      await m.locator(PM).waitFor({ timeout: 120000 }); await sleep(m, 600)
      const bb = await m.locator(`${PM} p`).filter({ hasText: 'OMEGA' }).boundingBox()
      await m.touchscreen.tap(bb.x + 40, bb.y + bb.height / 2); await sleep(m, 300)
      await m.locator('.amx-mbar button[title="插入块"]').tap(); await m.locator('.amx-bpick').waitFor(); await sleep(m, 300)
      const pg = await m.locator('.amx-bpick-label').evaluateAll((ls) => ls.map((l) => ({ label: l.textContent, names: [...l.nextElementSibling.querySelectorAll('.amx-bpick-name')].map((n) => n.textContent) })))
      ok('手机块面板:第一组是「常用」', pg[0]?.label === '常用', pg.map((g) => g.label))
      ok('手机块面板:常用的前五项', JSON.stringify(pg[0].names.slice(0, 5)) === JSON.stringify(['文本', '待办', '无序列表', '标题 1', '标题 2']), pg[0].names)
      const names = pg.flatMap((g) => g.names)
      ok('手机块面板:每一项只出现一次', new Set(names).size === names.length, names)
      await m.screenshot({ path: path.join(out, 'phone-picker.png') })
      ok('手机上不出预览卡', await m.locator('.slash-preview').count() === 0)
      await ctx.close()
    }

    ok('页面没有报错', errors.length === 0, errors)
    console.log(`\n${checks.length} 项全过;截图在 ${out}`)
  } finally { await browser.close() }
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
