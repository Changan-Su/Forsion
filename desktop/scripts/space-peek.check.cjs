/**
 * Space 左面板悬停预览(真 Chromium + 真 Shell / Ribbon / Dockview + 真 SpaceButton,harness.html?peek)。
 *
 * 钉的是接线,纯规则在 lcl/engine/spacePeekRules.test.ts:
 *   · 只在左面板收起时弹;停够 300ms 才弹、路过不弹;没有左栏的 Space 不弹(照旧出名字浮签);
 *   · 卡里是活的 View:点得动、打得了字;卡片不是 View 里 fixed 元素的包含块(右键菜单 / 悬停提示不偏移);
 *   · 什么时候收:指针回到界面别处 150ms 后收;停在卡里弹出的菜单上、卡里输入框拿着焦点时不收;Esc / 点别处立刻收;
 *   · 换图标 = 原地换内容;别的 Space 的卡里点一下 = 先切到那个 Space,这一下点击照常落地;头部换页签不切;
 *   · 几何:贴 Ribbon 右沿、让开标签条(左栏展开钮点得到)、110% 缩放下不偏。
 *
 * 跑:npm run check:spacepeek   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖;--shot[=目录] 存亮 / 暗两张截图)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const shotArg = process.argv.find((a) => a.startsWith('--shot'))
const SHOT_DIR = shotArg ? (shotArg.split('=')[1] || path.join(os.tmpdir(), 'space-peek')) : null

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const icon = (id) => `[data-space-id="${id}"]`
async function centerOf(page, sel) {
  const b = await page.locator(sel).first().boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
async function hover(page, sel) {
  const c = await centerOf(page, sel)
  await page.mouse.move(c.x, c.y, { steps: 4 })
}
/** 指针挪到主区正中偏右(界面别处),不点。 */
const park = (page) => page.mouse.move(980, 620, { steps: 4 })
const peek = (page) => page.evaluate(() => {
  const el = document.querySelector('.rb-peek')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    space: el.dataset.space,
    tags: [...el.querySelectorAll('.pk-list')].map((e) => e.dataset.tag),
    tabs: el.querySelectorAll('.rb-peek-tab').length,
    name: el.querySelector('.rb-peek-name')?.textContent,
    kept: !!el.__kept,
    rect: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width },
  }
})
const state = (page) => page.evaluate(() => ({
  space: window.__peek.useSpaceStore.getState().activeSpaceId,
  left: window.__peek.useWorkspace.getState().leftVisible,
  hits: [...window.__peek.hits],
}))
async function setLeft(page, open) {
  await page.evaluate((want) => { const w = window.__peek.useWorkspace.getState(); if (w.leftVisible !== want) w.toggleSidebar('left') }, open)
  await page.waitForTimeout(700) // 收 / 展补间 200ms + 沉降
}
/** 悬停某个 Space 图标并等到卡片弹出(弹不出返回 null)。 */
async function openOn(page, id) {
  await park(page)
  await page.waitForTimeout(250)
  await hover(page, icon(id))
  await page.waitForTimeout(450)
  return peek(page)
}

async function run(page) {
  await page.waitForSelector('.pk-main', { timeout: 20000 })
  await page.waitForSelector(icon('a'))
  await page.waitForTimeout(600)

  const leftW = await page.evaluate(() => {
    const p = window.__peek.useWorkspace.getState().api.panels.find((x) => (x.params || {}).__loc === 'left')
    return p.group.api.width
  })

  // ── A. 左面板展开着:不弹 ──
  await hover(page, icon('a'))
  await page.waitForTimeout(700)
  check('A1 左面板展开着,悬停 Space 图标不弹预览', (await peek(page)) === null)

  // ── B. 收起后:停够才弹,路过不弹 ──
  await setLeft(page, false)
  await park(page)
  await hover(page, icon('a'))
  await page.waitForTimeout(120)
  check('B1 刚停上去(120ms)还没弹', (await peek(page)) === null)
  await page.waitForTimeout(330)
  let p = await peek(page)
  check('B2 停够 300ms 弹出当前 Space 的左面板', p?.space === 'a' && p.tags.join() === 'a', JSON.stringify(p))
  check('B3 卡片头部是 Space 名,单个 View 不出页签', p?.name === 'Space A' && p?.tabs === 0, `${p?.name} / tabs ${p?.tabs}`)
  await page.waitForTimeout(900)
  check('B4 预览弹着时不再叠名字浮签', (await page.locator('.rb-tip').count()) === 0)
  await park(page)
  await page.waitForTimeout(250)
  await hover(page, icon('a'))
  await page.waitForTimeout(100)
  await park(page)
  await page.waitForTimeout(500)
  check('B5 路过(100ms 就移走)不弹', (await peek(page)) === null)

  // ── C. 几何 ──
  p = await openOn(page, 'a')
  await page.waitForTimeout(300) // 入场(180ms)播完再量:滑动那一下卡片带着 translate
  p = await peek(page)
  const geo = await page.evaluate(() => {
    const rb = document.querySelector('.rb').getBoundingClientRect()
    const work = document.querySelector('.shell-work').getBoundingClientRect()
    const toggle = document.querySelector('.dv-edge-toggle')
    const t = toggle.getBoundingClientRect()
    const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
    const fixed = document.querySelector('.rb-peek .pk-fixed').getBoundingClientRect()
    const card = document.querySelector('.rb-peek')
    return {
      inRibbon: document.querySelector('.rb').contains(card),
      rbRight: rb.right, workBottom: work.bottom, toggleBottom: t.bottom, toggleHit: !!hit && toggle.contains(hit), fixedLeft: fixed.left, fixedTop: fixed.top,
      transform: getComputedStyle(card).transform, translate: getComputedStyle(card).translate, filter: getComputedStyle(card).backdropFilter, opacity: getComputedStyle(card).opacity,
    }
  })
  check('C1 卡片贴 Ribbon 右沿(4px 缝)', !!p && Math.abs(p.rect.l - (geo.rbRight + 4)) <= 1, `${p?.rect.l} vs ${geo.rbRight + 4}`)
  check('C2 卡片让开标签条:左栏展开钮没被盖住、点得到', !!p && p.rect.t >= geo.toggleBottom && geo.toggleHit, `top ${p?.rect.t} / 钮底 ${geo.toggleBottom} / 命中 ${geo.toggleHit}`)
  check('C3 卡片通到工作区底(留 8px)', !!p && Math.abs(p.rect.b - (geo.workBottom - 8)) <= 1, `${p?.rect.b} vs ${geo.workBottom - 8}`)
  check('C4 卡片宽 = 左栏展开时的宽', !!p && Math.abs(p.rect.w - leftW) <= 2, `${p?.rect.w} vs ${leftW}`)
  check('C7 卡片不在 Ribbon 的 DOM 里(条上「点在条内 / 条外」的旧判定把它算条外)', geo.inRibbon === false)
  check('⚠️C5 卡片不是 View 里 fixed 元素的包含块(菜单 / 提示不偏移)', Math.abs(geo.fixedLeft - 640) <= 1 && Math.abs(geo.fixedTop - 420) <= 1, `fixed 落在 ${geo.fixedLeft},${geo.fixedTop}(应为 640,420)`)
  check('C6 入场播完卡片上不残留 transform / translate / backdrop-filter / opacity', geo.transform === 'none' && geo.translate === 'none' && geo.filter === 'none' && geo.opacity === '1', JSON.stringify([geo.transform, geo.translate, geo.filter, geo.opacity]))
  if (SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const dark = await page.evaluate(() => new URLSearchParams(location.search).has('dark'))
    await page.screenshot({ path: path.join(SHOT_DIR, `peek-${dark ? 'dark' : 'light'}.png`) })
  }

  // ── D. 卡里能操作;什么时候收 ──
  const row = await centerOf(page, '.rb-peek .pk-row[data-row="2"]')
  await page.mouse.move(row.x, row.y, { steps: 6 })
  await page.waitForTimeout(400)
  check('D1 指针从图标移进卡片,卡片留着', (await peek(page))?.space === 'a')
  await page.mouse.click(row.x, row.y)
  let s = await state(page)
  check('D2 卡里的行点得动(当前 Space 不变)', s.hits.join() === 'a:2@a' && s.space === 'a', s.hits.join())
  check('D3 点完卡片还在', (await peek(page))?.space === 'a')
  await page.mouse.click(row.x, row.y, { button: 'right' })
  await page.waitForSelector('.pk-menu')
  check('D4 卡里右键是 View 自己的菜单,不弹 Ribbon 的区菜单', (await page.locator('.rb-menu').count()) === 0)
  const item = await centerOf(page, '.pk-menu-item')
  await page.mouse.move(item.x, item.y, { steps: 8 }) // 途经主区,终点在挂到 body 的菜单上
  await page.waitForTimeout(450)
  check('⚠️D5 指针停在卡里弹出的菜单上(外壳之外),卡片不收', (await peek(page))?.space === 'a')
  const menuBox = await page.locator('.pk-menu').boundingBox()
  await page.mouse.click(menuBox.x + 3, menuBox.y + 3, { button: 'right' }) // 菜单自己的留白:没人接这次右键
  await page.waitForTimeout(150)
  check('D5b 在卡里弹出的菜单上右键(挂在 body,React 树上仍是卡的后代):不弹 Ribbon 的区菜单,卡片和菜单都还在',
    (await page.locator('.rb-menu').count()) === 0 && (await peek(page))?.space === 'a' && (await page.locator('.pk-menu').count()) === 1)
  await page.mouse.click(item.x, item.y)
  s = await state(page)
  check('D6 菜单项点得到,点菜单不收卡片', s.hits.includes('menu:a') && (await peek(page))?.space === 'a', s.hits.join())
  await park(page)
  await page.waitForTimeout(80)
  check('D7 指针回到界面别处,150ms 内还在', (await peek(page)) !== null)
  await page.waitForTimeout(350)
  check('D8 150ms 后收起', (await peek(page)) === null)
  const mountsA = await page.evaluate(() => window.__peek.mounts.a)

  p = await openOn(page, 'a')
  await page.locator('.rb-peek .pk-input').click()
  await page.keyboard.type('abc')
  await park(page)
  await page.waitForTimeout(450)
  check('⚠️D9 卡里输入框拿着焦点,指针滑出去也不收(打了一半的字不丢)', (await page.locator('.rb-peek .pk-input').inputValue().catch(() => null)) === 'abc')
  await page.keyboard.press('Escape')
  check('D10 输入框里的 Esc 归输入框,不收卡片', (await peek(page)) !== null)
  await page.evaluate(() => document.activeElement.blur())
  await page.waitForTimeout(400)
  check('D11 输入框失焦时指针早已停在界面别处(不再动)→ 也收起', (await peek(page)) === null)
  check('D12 收起即卸载,再弹是重新挂的(预览不进布局)', (await page.evaluate(() => window.__peek.mounts.a)) === mountsA + 1 && (await state(page)).left === false)

  p = await openOn(page, 'a')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(60)
  check('D13 Esc 立刻收', p?.space === 'a' && (await peek(page)) === null)
  await page.waitForTimeout(600)
  check('D14 收了之后指针还停在图标上,不再自己弹回来', (await peek(page)) === null)
  p = await openOn(page, 'a')
  await page.mouse.click(980, 620)
  await page.waitForTimeout(60)
  check('D15 点界面别处立刻收', p?.space === 'a' && (await peek(page)) === null)

  p = await openOn(page, 'a')
  const frame = await centerOf(page, '.pk-frame')
  await page.mouse.move(frame.x, frame.y, { steps: 1 }) // 一步跳进去:途中不经过主区别的元素
  await page.waitForTimeout(400)
  check('⚠️D16 指针直接进了主区里的 iframe(之后的事件到不了本窗口)也收', p?.space === 'a' && (await peek(page)) === null)

  // ── E. 换图标 / 别的 Space ──
  p = await openOn(page, 'a')
  await page.evaluate(() => { document.querySelector('.rb-peek').__kept = true })
  await hover(page, icon('b'))
  await page.waitForTimeout(80)
  p = await peek(page)
  check('E1 已经弹着时换到别的 Space 图标:不等、原地换内容(卡片元素不重建)', p?.space === 'b' && p.tags.join() === 'b' && p.kept, JSON.stringify(p))
  check('E2 两个 View 的左栏:头部出两枚页签', p?.tabs === 2, `tabs ${p?.tabs}`)
  const tab2 = await centerOf(page, '.rb-peek .rb-peek-tab >> nth=1')
  await page.mouse.move(tab2.x, tab2.y, { steps: 6 })
  await page.mouse.click(tab2.x, tab2.y)
  p = await peek(page)
  s = await state(page)
  check('E3 点页签换 View;换页签不算操作这个 Space(不切)', p?.tags.join() === 'b2' && s.space === 'a', `${p?.tags.join()} / active ${s.space}`)
  const rowB = await centerOf(page, '.rb-peek .pk-row[data-row="1"]')
  await page.mouse.move(rowB.x, rowB.y, { steps: 4 })
  await page.mouse.click(rowB.x, rowB.y)
  await page.waitForTimeout(500)
  s = await state(page)
  check('⚠️E4 在别的 Space 的卡里点一下:先切到那个 Space,这一下点击照常落地', s.space === 'b' && s.hits[s.hits.length - 1] === 'b2:1@b', `active ${s.space} / ${s.hits.join()}`)
  p = await peek(page)
  check('⚠️E5 那个 Space 的左栏本来就展开着:卡片先留着(这一下点开的菜单 / 表单还挂在卡里),不当场卸掉', s.left === true && p?.space === 'b' && p.tags.join() === 'b2', `left ${s.left} / ${JSON.stringify(p)}`)
  await hover(page, icon('a'))
  await page.waitForTimeout(120)
  check('E6 留着的卡不跟着换图标:指针到别的 Space 图标上就收', (await peek(page)) === null)
  await park(page)
  await page.waitForTimeout(300)
  await hover(page, icon('b'))
  await page.waitForTimeout(600)
  check('E7 左栏展开着,再悬停也不弹', (await peek(page)) === null)

  // ── F. 没有左栏的 Space;点图标 ──
  await setLeft(page, false)
  await park(page)
  await page.waitForTimeout(250)
  await hover(page, icon('c'))
  await page.waitForTimeout(700)
  check('F1 没有左栏的 Space 不弹预览', (await peek(page)) === null)
  await page.waitForTimeout(600)
  check('F2 它照旧出名字浮签', (await page.locator('.rb-tip').count()) === 1)
  p = await openOn(page, 'a')
  check('F3 人在 b 时悬停 a:弹的是 a 的默认左栏', p?.space === 'a' && p.tags.join() === 'a', JSON.stringify(p))
  const ia = await centerOf(page, icon('a'))
  await page.mouse.click(ia.x, ia.y)
  await page.waitForTimeout(700)
  s = await state(page)
  check('F4 点图标 = 进那个 Space,预览收起且不再弹回', s.space === 'a' && (await peek(page)) === null, `active ${s.space}`)

  // ── G. 展开左面板时让位;110% 缩放 ──
  await setLeft(page, false)
  p = await openOn(page, 'a')
  await page.evaluate(() => window.__peek.useWorkspace.getState().toggleSidebar('left'))
  await page.waitForTimeout(700)
  check('G1 预览弹着时左面板展开了(不是卡里点出来的)→ 预览收起', p?.space === 'a' && (await peek(page)) === null)
  await setLeft(page, false)
  await page.evaluate(() => { document.body.style.zoom = '1.1' })
  await page.waitForTimeout(200)
  p = await openOn(page, 'a')
  const z = await page.evaluate(() => {
    const rb = document.querySelector('.rb').getBoundingClientRect()
    const t = document.querySelector('.dv-edge-toggle').getBoundingClientRect()
    const work = document.querySelector('.shell-work').getBoundingClientRect()
    return { rbRight: rb.right, toggleBottom: t.bottom, workBottom: work.bottom }
  })
  check('⚠️G2 110% 缩放:卡片仍贴 Ribbon 右沿、让开标签条、通到底(fixed 坐标按 zoom 折算)',
    !!p && Math.abs(p.rect.l - (z.rbRight + 4)) <= 1.5 && p.rect.t >= z.toggleBottom && Math.abs(p.rect.b - (z.workBottom - 8)) <= 1.5,
    `left ${p?.rect.l} vs ${z.rbRight + 4};top ${p?.rect.t} ≥ ${z.toggleBottom};bottom ${p?.rect.b} vs ${z.workBottom - 8}`)
  await page.evaluate(() => { document.body.style.zoom = '' })
  await page.waitForTimeout(200)

  // ── H. 弹着时窗口变了大小;卡里的 View 被注销 ──
  // 只改窗口宽:Ribbon 自己不会因此重渲(它只盯自己的高),卡片得靠自己听 resize。没记过宽 → 卡宽 = 按工作区宽算的默认值,跟着变。
  await page.evaluate(() => { const w = window.__peek.useWorkspace; w.setState({ sideWidths: { ...w.getState().sideWidths, left: null } }) })
  p = await openOn(page, 'b')
  await page.setViewportSize({ width: 1150, height: 900 })
  await page.waitForTimeout(300)
  const after = await peek(page)
  check('H1 弹着时窗口变窄:卡片跟着重排(不停在旧宽度)', p?.space === 'b' && !!after && p.rect.w - after.rect.w > 20, `${p?.rect.w} → ${after?.rect.w}`)
  await page.evaluate(() => window.__peek.unregisterView('pk-b'))
  await page.waitForTimeout(150)
  check('H2 卡里的 View 被注销(插件停用)→ 预览收起,不留没人管的实例', !!after && (await peek(page)) === null)
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => { if (!sessionStorage.getItem('pk')) { localStorage.clear(); sessionStorage.setItem('pk', '1') } })
    await page.goto(`${BASE}?peek`, { waitUntil: 'domcontentloaded' })
    await run(page)
    if (SHOT_DIR) {
      // 暗色只为截图自查(观感两档都算数,DESIGN §8);断言在亮色那一遍已经跑完。
      const dark = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
      await dark.goto(`${BASE}?peek&dark`, { waitUntil: 'domcontentloaded' })
      await dark.waitForSelector('.pk-main', { timeout: 20000 })
      await dark.waitForTimeout(600)
      await setLeft(dark, false)
      await openOn(dark, 'b')
      await dark.screenshot({ path: path.join(SHOT_DIR, 'peek-dark.png') })
      console.log(`截图:${SHOT_DIR}`)
    }
    const bad = results.filter((r) => !r.ok)
    console.log(`\n${results.length - bad.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
