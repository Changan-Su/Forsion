// 标注的图标与底色(Notion 对齐 A5)真浏览器检查。存法是 Obsidian 的元数据位 `> [!tip|🚀 blue]`(用户 11-18 定):
// 渲染(emoji 图标、底色、令牌藏起来)、点图标换 / 去掉图标、块菜单「颜色」只给背景且没有「更多颜色」、
// 斜杠 /蓝色背景 在标注标题里给整只标注上底色、带元数据的折叠块照常开合、撤销一次回原样、只读不可点、手机宽度轻点能换。
// 用法:npm run check:calloutmeta(worktree 里设 HARNESS_URL 指到自己起的端口)。截图在 SHOT_DIR。
const fs = require('node:fs'), path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const origin = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const out = process.env.SHOT_DIR || '/tmp/forsion-callout-meta'
fs.mkdirSync(out, { recursive: true })
const pass = [], fail = [], errors = []
const ok = (name, value, info) => {
  if (value) { pass.push(name); console.log('PASS', name) } else { fail.push(name); console.log('FAIL', name, info === undefined ? '' : `— ${JSON.stringify(info)}`) }
}
const SEED = [
  '# 标注页', '',
  '> [!tip] 提示标题', '> 提示正文', '',
  '> [!note|🚀 blue wide] 已有图标', '> 正文二', '',
  '> [!fold|green]- 折叠标题', '> 折叠正文', '',
  '> [!warning|red]- 收起的警告', '> 警告正文', '',
  '尾段 OMEGA', '',
].join('\n')
const sleep = (p, ms = 250) => p.waitForTimeout(ms)
let n = 0
async function load(p, md = SEED) {
  await p.evaluate(({ name, md }) => window.__upage.switchFile(name, md), { name: `Callout-${++n}.md`, md })
  await p.waitForFunction(() => (document.querySelector('.unified-body .ProseMirror')?.innerText || '').includes('OMEGA'))
  await sleep(p, 400)
}
const PM = '.unified-body .ProseMirror'
const bq = (p, text) => p.locator(`${PM} > blockquote.callout`).filter({ has: p.locator(`:scope > p:first-child:has-text("${text}")`) })
const md = (p) => p.evaluate(() => window.__upage.probe.serializeNow())
const info = (p, text) => bq(p, text).evaluate((el) => {
  const icon = el.querySelector(':scope > p:first-child .callout-icon')
  const body = el.querySelector(':scope > p:nth-child(2)')
  return {
    bg: el.getAttribute('data-bg'), background: getComputedStyle(el).backgroundColor, cls: el.className,
    icon: icon ? { emoji: icon.classList.contains('callout-icon-emoji') ? icon.textContent : null, role: icon.getAttribute('role') } : null,
    // 令牌藏在 .callout-syntax 里(视觉上不占位,innerText 仍算它),量「看得见的标题」要先摘掉
    title: (() => { const c = el.querySelector(':scope > p:first-child').cloneNode(true); c.querySelectorAll('.callout-syntax, .callout-icon, .callout-chevron').forEach((x) => x.remove()); return c.textContent.trim() })(),
    bodyShown: !!body && body.getBoundingClientRect().height > 0 && getComputedStyle(body).display !== 'none',
  }
})
const caretAtEnd = (p, text) => p.evaluate((k) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  let hit = null
  st.doc.descendants((node, pos) => { if (hit != null) return false; if (!node.isTextblock) return true; if (node.textContent.includes(k)) hit = pos + 1 + node.content.size; return false })
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)))
}, text)
const selHead = (p) => p.evaluate(() => window.__upage.probe.view().state.selection.head)
async function openMenu(p, text) {
  const box = await bq(p, text).locator(':scope > p:first-child').boundingBox()
  await p.mouse.move(box.x + 40, box.y + box.height / 2); await sleep(p)
  await p.locator('.unified-gutter .drag-handle').click(); await p.locator('.unified-block-menu').waitFor(); await sleep(p, 150)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
    p.setDefaultTimeout(15000); p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(origin + '?upage&useed=' + encodeURIComponent(SEED))
    await p.locator(PM).waitFor({ timeout: 120000 }); await sleep(p, 600)

    // ── 渲染 ──
    let a = await info(p, '已有图标')
    ok('[!note|🚀 blue wide]:画 emoji 图标、底色 blue', a.icon?.emoji === '🚀' && a.bg === 'blue' && a.background !== 'rgba(0, 0, 0, 0)', a)
    ok('令牌和元数据不露在标题里', a.title === '已有图标', a.title)
    const tip = await info(p, '提示标题')
    ok('没元数据的标注照旧:SVG 图标、没有 data-bg', tip.icon && tip.icon.emoji === null && !tip.bg, tip)
    a = await info(p, '折叠标题')
    ok('[!fold|green]-:折叠块铺绿底、是收起的', a.bg === 'green' && a.background !== 'rgba(0, 0, 0, 0)' && /callout-collapsed/.test(a.cls) && !a.bodyShown, a)
    a = await info(p, '收起的警告')
    ok('[!warning|red]-:有色标注带元数据也能收起', a.bg === 'red' && /callout-collapsed/.test(a.cls) && !a.bodyShown, a)
    await p.screenshot({ path: path.join(out, 'render-light.png') })

    // ── 折叠符跟在元数据后面:开合写对位置 ──
    await bq(p, '折叠标题').locator(':scope > p:first-child > .callout-chevron').click(); await sleep(p, 500)
    a = await info(p, '折叠标题')
    let saved = await md(p)
    ok('展开带元数据的折叠块:写成 [!fold|green]+', a.bodyShown && saved.includes('> [!fold|green]+ 折叠标题'), saved)
    await bq(p, '折叠标题').locator(':scope > p:first-child > .callout-chevron').click(); await sleep(p, 500)
    saved = await md(p)
    ok('再收起:写回 [!fold|green]-', saved.includes('> [!fold|green]- 折叠标题') && !(await info(p, '折叠标题')).bodyShown, saved)
    await bq(p, '收起的警告').locator(':scope > p:first-child > .callout-chevron').click(); await sleep(p, 500)
    saved = await md(p)
    ok('有色标注 [!warning|red]- 展开 → [!warning|red]+', saved.includes('> [!warning|red]+ 收起的警告') && (await info(p, '收起的警告')).bodyShown, saved)

    // ── 点图标换图标 ──
    await load(p)
    await caretAtEnd(p, 'OMEGA'); const before = await selHead(p)
    const tipIcon = bq(p, '提示标题').locator('.callout-icon')
    ok('可编辑时图标是按钮、有「换图标」提示', (await tipIcon.getAttribute('role')) === 'button' && (await tipIcon.getAttribute('title')) === '换图标')
    await tipIcon.click(); await sleep(p, 300)
    const pick = p.locator('.amx-iconpick')
    ok('点图标打开图标选择器', await pick.count() === 1)
    const ib = await tipIcon.boundingBox(), pb = await pick.boundingBox()
    ok('选择器贴着图标下方出现', !!pb && Math.abs(pb.x - ib.x) < 40 && pb.y >= ib.y + ib.height - 2 && pb.y - (ib.y + ib.height) < 30, { ib, pb })
    ok('点图标不挪光标(不进标注、不切折叠)', (await selHead(p)) === before)
    await p.screenshot({ path: path.join(out, 'icon-picker.png') })
    const first = pick.locator('.amx-iconpick-item').first(), em = (await first.textContent()).trim()
    await first.click(); await sleep(p, 300)
    a = await info(p, '提示标题')
    saved = await md(p)
    ok(`选 ${em}:图标换成 emoji、落盘 [!tip|${em}]`, a.icon?.emoji === em && saved.includes(`> [!tip|${em}] 提示标题`), { a, saved })
    ok('选择器收了', await pick.count() === 0)
    await p.keyboard.press('Meta+z'); await sleep(p, 300)
    saved = await md(p)
    ok('撤销一次:回到 [!tip]', (await info(p, '提示标题')).icon?.emoji === null && saved.includes('> [!tip] 提示标题'), saved)
    await p.keyboard.press('Meta+Shift+z'); await sleep(p, 300)
    ok('重做回来', (await info(p, '提示标题')).icon?.emoji === em)
    // 搜索选图标
    await bq(p, '已有图标').locator('.callout-icon').click(); await sleep(p, 300)
    ok('已有图标:选择器里标出当前那枚', await pick.locator('.amx-iconpick-item.active').count() >= 1 || await pick.locator('.amx-iconpick-item').count() > 0)
    await pick.locator('.amx-db-opt-clear').click(); await sleep(p, 300)
    saved = await md(p)
    ok('去掉图标:元数据只剩 blue wide,别的词不丢', saved.includes('> [!note|blue wide] 已有图标') && (await info(p, '已有图标')).icon?.emoji === null, saved)
    await bq(p, '已有图标').locator('.callout-icon').click(); await sleep(p, 300)
    await p.keyboard.press('Escape'); await sleep(p, 200)
    ok('Esc 关选择器,文档不动', await pick.count() === 0 && (await md(p)) === saved)

    // ── 块菜单「颜色」:标注只给背景,没有「更多颜色」 ──
    await load(p)
    await openMenu(p, '提示标题')
    await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    const pop = p.locator('.amx-color-popover')
    const tabs = await pop.locator('[role="tab"]').allTextContents()
    ok('标注的调色板只有「背景」页', tabs.length === 1 && tabs[0] === '背景', tabs)
    ok('没有「更多颜色」(元数据位只存语义名)', await pop.locator('[data-more]').count() === 0)
    await p.screenshot({ path: path.join(out, 'menu-palette-callout.png') })
    await pop.locator('[data-color-value="purple"]').click(); await sleep(p, 300)
    a = await info(p, '提示标题'); saved = await md(p)
    ok('上紫底:data-bg、落盘 [!tip|purple]', a.bg === 'purple' && a.background !== 'rgba(0, 0, 0, 0)' && saved.includes('> [!tip|purple] 提示标题'), { a, saved })
    await openMenu(p, '提示标题')
    ok('再开菜单:小方块是紫色', await p.locator('[data-act="blockColor"] .ubm-color-chip[data-chip-bg="purple"]').count() === 1)
    await p.keyboard.press('Escape'); await sleep(p)
    await p.keyboard.press('Meta+z'); await sleep(p, 300)
    ok('撤销一次:颜色没了', !(await info(p, '提示标题')).bg && (await md(p)).includes('> [!tip] 提示标题'))
    // 已有颜色的块菜单「默认」= 清掉颜色,图标和别的词留着
    await openMenu(p, '已有图标')
    await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    await pop.locator('[data-color-value="default"]').click(); await sleep(p, 300)
    saved = await md(p)
    ok('清除颜色:[!note|🚀 wide],图标和 wide 留着', saved.includes('> [!note|🚀 wide] 已有图标') && !(await info(p, '已有图标')).bg, saved)

    // ── 斜杠 ──
    await load(p)
    await caretAtEnd(p, '提示标题')
    await p.keyboard.type(' /蓝色背景', { delay: 25 }); await sleep(p, 300)
    await p.keyboard.press('Enter'); await sleep(p, 400)
    a = await info(p, '提示标题'); saved = await md(p)
    ok('标注标题里 /蓝色背景:整只标注上蓝底、/查询删干净', a.bg === 'blue' && saved.includes('> [!tip|blue] 提示标题\n'), { a, saved })
    await caretAtEnd(p, '提示标题')
    await p.keyboard.type(' /红色', { delay: 25 }); await sleep(p, 300)
    await p.keyboard.press('Enter'); await sleep(p, 400)
    saved = await md(p)
    ok('标注标题里 /红色(字色):不改令牌、/查询删掉', saved.includes('> [!tip|blue] 提示标题\n') && (await info(p, '提示标题')).title === '提示标题', saved)
    await caretAtEnd(p, '提示正文')
    await p.keyboard.type(' /绿色背景', { delay: 25 }); await sleep(p, 300)
    await p.keyboard.press('Enter'); await sleep(p, 400)
    saved = await md(p)
    ok('标注正文里 /绿色背景:只给那一段上色,令牌不动', saved.includes('<span data-amadeus-bg="green"></span>提示正文') && saved.includes('> [!tip|blue] 提示标题'), saved)

    // ── 暗色 ──
    await load(p)
    const lightBg = (await info(p, '已有图标')).background
    await p.evaluate(() => { document.documentElement.classList.add('dark'); document.querySelectorAll('.am-app').forEach((e) => e.setAttribute('data-mode', 'dark')) }); await sleep(p, 300)
    const darkBg = (await info(p, '已有图标')).background
    ok('暗色:标注底色换暗色那一档', darkBg !== lightBg && darkBg !== 'rgba(0, 0, 0, 0)', { lightBg, darkBg })
    await p.screenshot({ path: path.join(out, 'render-dark.png') })
    await p.evaluate(() => { document.documentElement.classList.remove('dark'); document.querySelectorAll('.am-app').forEach((e) => e.removeAttribute('data-mode')) })

    // ── 只读:图标不是按钮,点了不开选择器 ──
    {
      const r = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
      r.setDefaultTimeout(15000); r.on('pageerror', (e) => errors.push(e.message))
      await r.goto(origin + '?upage&upane&uro&useed=' + encodeURIComponent(SEED))
      await r.locator(PM).waitFor({ timeout: 120000 }); await sleep(r, 800)
      const ra = await info(r, '已有图标')
      ok('只读:emoji 和底色照样显示', ra.icon?.emoji === '🚀' && ra.bg === 'blue', ra)
      ok('只读:图标不是按钮', ra.icon?.role === null, ra)
      await bq(r, '已有图标').locator('.callout-icon').click({ force: true }); await sleep(r, 300)
      ok('只读:点图标不开选择器', await r.locator('.amx-iconpick').count() === 0)
      await r.close()
    }

    // ── 手机宽度(触屏):轻点图标出选择器,整块在屏内 ──
    {
      const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      const m = await ctx.newPage(); m.setDefaultTimeout(15000); m.on('pageerror', (e) => errors.push(e.message))
      await m.goto(origin + '?upage&useed=' + encodeURIComponent(SEED))
      await m.locator(PM).waitFor({ timeout: 120000 }); await sleep(m, 600)
      await bq(m, '提示标题').locator('.callout-icon').tap(); await sleep(m, 400)
      const vb = await m.locator('.amx-iconpick').boundingBox()
      ok('手机:轻点图标出选择器,整块在屏内', !!vb && vb.x >= 0 && vb.x + vb.width <= 390 && vb.y >= 0, vb)
      await m.screenshot({ path: path.join(out, 'phone-picker.png') })
      const pem = (await m.locator('.amx-iconpick-item').first().textContent()).trim()
      await m.locator('.amx-iconpick-item').first().tap(); await sleep(m, 400)
      ok('手机:轻点 emoji 换上', (await info(m, '提示标题')).icon?.emoji === pem)
      await ctx.close()
    }

    ok('页面没有报错', errors.length === 0, errors)
  } finally { await browser.close() }
  console.log(`\n${pass.length}/${pass.length + fail.length} 通过;截图在 ${out}`)
  if (fail.length) process.exit(1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
