// 整块颜色(Notion 对齐 A1)真浏览器检查:块菜单「颜色 ›」→ 调色板 → 上色 / 撤销 / 存盘重开;页边框选多块一次上色;
// 斜杠 /蓝色背景、/blue background(带空格)、/默认颜色;暗色下颜色跟着换。
// 用法:npm run check:blockcolor(worktree 里设 HARNESS_URL 指到自己起的端口)。截图在 SHOT_DIR。
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const origin = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const out = process.env.SHOT_DIR || '/tmp/forsion-block-color'
fs.mkdirSync(out, { recursive: true })
const checks = [], errors = []
const ok = (name, value, info) => { assert.ok(value, `${name}${info === undefined ? '' : ` — ${JSON.stringify(info)}`}`); checks.push(name); console.log('PASS', name) }
const SEED = '# 发布手册\n\n第一段 ALPHA\n\n第二段 BETA\n\n第三段 GAMMA\n\n- 项一\n- 项二\n\n> 引用一段\n\n尾段 OMEGA\n'
const sleep = (p, ms = 250) => p.waitForTimeout(ms)
let n = 0
async function load(p, md = SEED) {
  await p.evaluate(({ name, md }) => window.__upage.switchFile(name, md), { name: `Color-${++n}.md`, md })
  await p.waitForFunction(() => (document.querySelector('.unified-body .ProseMirror')?.innerText || '').includes('OMEGA'))
  await sleep(p, 400)
}
const block = (p, text) => p.locator('.unified-body .ProseMirror').locator(`:is(p, h1, h2, li, blockquote):has-text("${text}")`).last()
const attrs = (p, text) => block(p, text).evaluate((el) => {
  const host = el.closest('li, blockquote') && !el.matches('li, blockquote') && el.parentElement.firstElementChild === el ? el.parentElement : el
  return { tag: host.tagName, bg: host.getAttribute('data-bg'), fg: host.getAttribute('data-fg'), color: getComputedStyle(host).color, background: getComputedStyle(host).backgroundColor }
})
const md = (p) => p.evaluate(() => window.__upage.probe.serializeNow())
async function openMenu(p, text) {
  const box = await block(p, text).boundingBox()
  await p.mouse.move(box.x + 12, box.y + box.height / 2); await sleep(p)
  await p.locator('.unified-gutter .drag-handle').click(); await p.locator('.unified-block-menu').waitFor(); await sleep(p, 150)
}
async function slash(p, text, query) {
  await p.evaluate((k) => {
    const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
    let hit = null
    st.doc.descendants((node, pos) => { if (hit != null) return false; if (!node.isTextblock) return true; const i = node.textContent.indexOf(k); if (i >= 0) hit = pos + 1 + node.textContent.length; return false })
    v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)))
  }, text)
  await p.keyboard.type(' /' + query, { delay: 25 }); await sleep(p, 300)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
    p.setDefaultTimeout(15000); p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(origin + '?upage&useed=' + encodeURIComponent(SEED))
    await p.locator('.unified-body .ProseMirror').waitFor({ timeout: 120000 }); await sleep(p, 600)

    // ── 块菜单「颜色 ›」 ──
    await openMenu(p, 'ALPHA')
    const rows = await p.locator('.unified-block-menu > button').evaluateAll((bs) => bs.map((b) => b.dataset.sub || b.dataset.act || b.textContent.trim()))
    ok('块菜单有「颜色」,紧跟「转换为」', rows[rows.indexOf('turnInto') + 1] === 'blockColor', rows)
    ok('「颜色」行的文案', (await p.locator('[data-act="blockColor"]').textContent()).includes('颜色'))
    await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    const pop = p.locator('.amx-color-popover')
    ok('悬停「颜色」打开调色板', await pop.count() === 1)
    const mb = await p.locator('.unified-block-menu').boundingBox(), pb = await pop.boundingBox()
    ok('调色板在菜单右侧', pb.x >= mb.x + mb.width - 2, { menu: mb, pop: pb })
    ok('底部写「应用于整个分块」', (await pop.locator('.amx-palette-scope').textContent()) === '应用于整个分块')
    ok('九色 + 默认 + 跟随强调色 + 更多颜色', await pop.locator('.amx-palette-grid [data-color-option]').count() === 9 && await pop.locator('[data-color-value="accent"]').count() === 1)
    await p.screenshot({ path: path.join(out, 'menu-palette.png') })
    await pop.locator('[data-color-value="blue"]').click(); await sleep(p, 300)
    let a = await attrs(p, 'ALPHA')
    ok('上了蓝底:DOM 带 data-bg、真有底色', a.bg === 'blue' && a.background !== 'rgba(0, 0, 0, 0)', a)
    ok('菜单与调色板都收了', await p.locator('.unified-block-menu, .amx-color-popover').count() === 0)
    await p.waitForTimeout(1200)
    ok('落盘是段首空标记', (await md(p)).includes('<span data-amadeus-bg="blue"></span>第一段 ALPHA'), await md(p))
    await p.keyboard.press('Meta+z'); await sleep(p)
    a = await attrs(p, 'ALPHA')
    ok('撤销一次就回去', !a.bg, a)
    await p.keyboard.press('Meta+Shift+z'); await sleep(p)
    ok('重做回来', (await attrs(p, 'ALPHA')).bg === 'blue')

    // 字色:切到「文字」页
    await openMenu(p, 'BETA'); await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    await pop.getByRole('tab', { name: '文字' }).click(); await pop.locator('[data-color-value="red"]').click(); await sleep(p, 300)
    a = await attrs(p, 'BETA')
    ok('字色红:data-fg 与计算后的颜色', a.fg === 'red' && a.color === 'rgb(182, 31, 31)', a)
    await openMenu(p, 'BETA')
    ok('再开菜单:行尾小方块是当前颜色', await p.locator('[data-act="blockColor"] .ubm-color-chip[data-chip-fg="red"]').count() === 1)
    // 截图里抓到过:<i> 是行内元素,宽高不生效 → 小方块看不见、箭头贴着字。要求它有尺寸且和「转换为」的尾巴一样靠右
    const geo = await p.evaluate(() => {
      const r = (q) => document.querySelector(q)?.getBoundingClientRect()
      const row = r('[data-act="blockColor"]'), chip = r('[data-act="blockColor"] .ubm-color-chip'), turn = r('[data-sub="turnInto"] .ubm-sub-tail')
      return row && chip && turn ? { w: chip.width, gap: Math.round(row.right - chip.right), tailRight: Math.round(turn.right), colorTailRight: Math.round(r('[data-act="blockColor"] .ubm-sub-tail').right) } : null
    })
    ok('小方块有尺寸、尾巴和「转换为」同一右边', !!geo && geo.w >= 10 && geo.gap < 40 && Math.abs(geo.tailRight - geo.colorTailRight) <= 1, geo)
    await p.keyboard.press('Escape'); await sleep(p)

    // 列表项 / 引用
    await openMenu(p, '项一'); await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    await pop.locator('[data-color-value="green"]').click(); await sleep(p, 300)
    a = await attrs(p, '项一')
    ok('列表项:颜色挂在 li 上', a.tag === 'LI' && a.bg === 'green', a)
    await openMenu(p, '引用一段'); await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    await pop.locator('[data-color-value="purple"]').click(); await sleep(p, 300)
    a = await attrs(p, '引用一段')
    ok('引用:颜色挂在 blockquote 上', a.tag === 'BLOCKQUOTE' && a.bg === 'purple', a)
    await p.waitForTimeout(1200)
    const saved = await md(p)
    ok('列表项 / 引用落盘在第一段段首', saved.includes('- <span data-amadeus-bg="green"></span>项一') && saved.includes('> <span data-amadeus-bg="purple"></span>引用一段'), saved)

    // 存 → 重开
    await p.evaluate((md) => window.__upage.switchFile('Reopened.md', md), saved)
    await p.waitForFunction(() => (document.querySelector('.unified-body .ProseMirror')?.innerText || '').includes('OMEGA')); await sleep(p, 500)
    ok('重开:颜色都在、正文里没有标记', (await attrs(p, 'ALPHA')).bg === 'blue' && (await attrs(p, 'BETA')).fg === 'red' && (await attrs(p, '项一')).bg === 'green' && (await attrs(p, '引用一段')).bg === 'purple'
      && !(await p.locator('.unified-body .ProseMirror').innerText()).includes('data-amadeus'))
    ok('重开后再序列化逐字不变', (await md(p)) === saved)
    await p.screenshot({ path: path.join(out, 'colored-light.png') })

    // ── 页边框选多块 → 右键块菜单 → 一次上色 ──
    await load(p)
    // 起框照 block-file-ops 的 marquee:正文列左边 20px、第一块上缘之上(块矩形之外才起框)
    const mq = await p.evaluate(() => {
      const els = [...document.querySelectorAll('.unified-body .ProseMirror > *')]
      const a = els.find((x) => x.textContent.includes('ALPHA')).getBoundingClientRect(), b = els.find((x) => x.textContent.includes('GAMMA')).getBoundingClientRect()
      const pm = document.querySelector('.unified-body .ProseMirror').getBoundingClientRect()
      return { sx: pm.left - 20, sy: a.top - 4, ex: pm.right - 4, ey: b.bottom - 2, cx: a.left + 30, cy: a.top + a.height / 2 }
    })
    await p.mouse.move(mq.sx, mq.sy); await p.mouse.down(); await p.mouse.move(mq.ex, mq.ey, { steps: 8 }); await p.mouse.up(); await sleep(p, 300)
    ok('页边框选选中三块', await p.locator('.amx-block-selected').count() === 3, await p.locator('.amx-block-selected').count())
    await p.mouse.click(mq.cx, mq.cy, { button: 'right' }); await sleep(p, 300)
    ok('框选三块后右键 = 块菜单', await p.locator('.unified-block-menu').count() === 1)
    await p.locator('[data-act="blockColor"]').hover(); await sleep(p, 300)
    await pop.locator('[data-color-value="yellow"]').click(); await sleep(p, 300)
    const ys = await Promise.all(['ALPHA', 'BETA', 'GAMMA'].map(async (t) => (await attrs(p, t)).bg))
    ok('三块一次上黄底', ys.every((v) => v === 'yellow'), ys)
    ok('没选中的块不动', !(await attrs(p, 'OMEGA')).bg)
    await p.keyboard.press('Meta+z'); await sleep(p)
    ok('多块上色也是一个撤销步', (await Promise.all(['ALPHA', 'BETA', 'GAMMA'].map(async (t) => (await attrs(p, t)).bg))).every((v) => !v))

    // ── 斜杠 ──
    await load(p)
    await slash(p, 'GAMMA', '蓝色背景')
    ok('/蓝色背景 出现在菜单首位', (await p.locator('.slash-item').first().getAttribute('data-key')) === 'bg-blue')
    await p.screenshot({ path: path.join(out, 'slash-zh.png') })
    await p.keyboard.press('Enter'); await sleep(p, 300)
    a = await attrs(p, 'GAMMA')
    ok('/蓝色背景 上色且删掉了 /query', a.bg === 'blue' && !(await block(p, 'GAMMA').innerText()).includes('/'), a)
    await slash(p, 'GAMMA', 'mrys')
    ok('拼音首字母 /mrys 找到「默认颜色」', (await p.locator('.slash-item').first().getAttribute('data-key')) === 'color-default')
    await p.keyboard.press('Enter'); await sleep(p, 300)
    ok('/默认颜色 清掉', !(await attrs(p, 'GAMMA')).bg)
    await slash(p, 'BETA', 'blue background')
    ok('/blue background 打了空格菜单还在', await p.locator('.slash-item').count() > 0)
    ok('/blue background 首位是蓝色背景', (await p.locator('.slash-item').first().getAttribute('data-key')) === 'bg-blue')
    await p.keyboard.press('Enter'); await sleep(p, 300)
    ok('/blue background 上色', (await attrs(p, 'BETA')).bg === 'blue')
    await slash(p, 'ALPHA', 'red x')
    ok('多词名对不上的空格照旧关菜单、留字面', await p.locator('.slash-item').count() === 0 && (await block(p, 'ALPHA').innerText()).includes('/red x'))
    await slash(p, 'OMEGA', '')
    ok('浏览(没打字)时不列颜色项', await p.locator('.slash-item[data-key^="bg-"], .slash-item[data-key^="color-"]').count() === 0)
    await p.keyboard.press('Escape')
    await slash(p, '项二', 'hongse')
    await p.keyboard.press('Enter'); await sleep(p, 300)
    ok('列表项里 /hongse(拼音)= 整个列表项字色红', (await attrs(p, '项二')).fg === 'red')

    // ── 暗色 ──
    await load(p, SEED.replace('第一段 ALPHA', '<span data-amadeus-bg="blue"></span>第一段 ALPHA').replace('第二段 BETA', '<span data-amadeus-fg="red"></span>第二段 BETA'))
    const lightBg = (await attrs(p, 'ALPHA')).background
    await p.evaluate(() => { document.documentElement.classList.add('dark'); document.querySelectorAll('.am-app').forEach((e) => e.setAttribute('data-mode', 'dark')) }); await sleep(p, 300)
    const dark = await attrs(p, 'ALPHA'), darkFg = await attrs(p, 'BETA')
    ok('暗色:底色换成暗色那一档', dark.background !== lightBg, { lightBg, dark: dark.background })
    ok('暗色:字色换亮一档', darkFg.color === 'rgb(249, 141, 141)', darkFg)
    await p.screenshot({ path: path.join(out, 'colored-dark.png') })

    ok('页面没有报错', errors.length === 0, errors)
    console.log(`\n${checks.length} 项全过;截图在 ${out}`)
  } finally { await browser.close() }
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
