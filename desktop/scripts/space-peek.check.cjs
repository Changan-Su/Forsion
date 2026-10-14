/**
 * Space 左面板悬停预览(真 Chromium + 真 Shell / Ribbon / Dockview + 真 SpaceButton,harness.html?peek)。
 *
 * 钉的是接线,纯规则在 lcl/engine/spacePeekRules.test.ts:
 *   · 左面板展开着只有当前 Space 不弹(别的 Space 照弹,卡片盖在眼前这块左栏上);停够 300ms 才弹、路过不弹;没有左栏的 Space 不弹(照旧出名字浮签);
 *   · 卡里是活的 View:点得动、打得了字;卡片不是 View 里 fixed 元素的包含块(右键菜单 / 悬停提示不偏移);
 *   · 什么时候收:指针回到界面别处 150ms 后收;停在卡里弹出的菜单上、卡里输入框拿着焦点时不收;Esc / 点别处立刻收;
 *   · 换图标 = 原地换内容;别的 Space 的卡里点一下不切 Space:要往主区开的开在当前标签旁边(已开着就切过去),
 *     只在左栏里起作用的原样生效;头部换页签不切;头部的名字 = 「进入这个 Space」;
 *   · 列表条目拖进标签栏 = 落点处的新标签,拖进正文 = 分屏;里层落区(聊天插引用、编辑器)先接的让给它们;
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
/** 主区的标签(按组、组内按次序):id / doc 参数 / 是否活动 / 所在组。 */
const mainTabs = (page) => page.evaluate(() => {
  const api = window.__peek.useWorkspace.getState().api
  const active = api.activePanel?.id
  return api.panels.filter((x) => (x.params || {}).__loc === 'main')
    .map((x) => ({ id: x.id, doc: x.params.doc ?? null, active: x.id === active, group: x.group.id, at: x.group.panels.indexOf(x) }))
})
/** 合成一次 HTML5 拖放:src 上 dragstart → 视口点 (x,y) 上 dragover / drop → dragend。返回 dragover 时有没有画落点提示。 */
const dragTo = (page, srcSel, x, y) => page.evaluate(async ({ srcSel, x, y }) => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  const src = document.querySelector(srcSel), dataTransfer = new DataTransfer()
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
  await nap(50)
  const el = document.elementFromPoint(x, y)
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }))
  await nap(50)
  const hint = [...document.querySelectorAll('.wb-drop-line, .wb-drop-zone')].some((e) => getComputedStyle(e).display !== 'none')
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }))
  if (src.isConnected) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
  await nap(300)
  return { hint, on: el.className }
}, { srcSel, x, y })
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

  // ── A. 左面板展开着:当前 Space 不弹(它的左栏就在眼前),别的 Space 照弹 ──
  await hover(page, icon('a'))
  await page.waitForTimeout(700)
  check('A1 左面板展开着,悬停当前 Space 的图标不弹预览', (await peek(page)) === null)
  let p = await openOn(page, 'b')
  check('A2 左面板展开着,悬停别的 Space 照弹(弹的是那个 Space 的左栏)', p?.space === 'b' && p.tags.join() === 'b', JSON.stringify(p))
  const openGeo = await page.evaluate(() => {
    const g = window.__peek.useWorkspace.getState().api.panels.find((x) => (x.params || {}).__loc === 'left').group.element.getBoundingClientRect()
    return { l: g.left, t: g.top, r: g.right, b: g.bottom }
  })
  check('A3 这时卡片正好盖在眼前这块左栏上(四边对齐,不露底下那块,也不多盖)',
    !!p && openGeo.b - openGeo.t > 100 && ['l', 't', 'r', 'b'].every((k) => Math.abs(p.rect[k] - openGeo[k]) <= 1),
    `card ${JSON.stringify(p?.rect)} / left panel ${JSON.stringify(openGeo)}`)
  if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'peek-left-open.png') }) }
  await hover(page, icon('a'))
  await page.waitForTimeout(120)
  check('A4 弹着别的 Space 的卡时移到当前 Space 的图标上:收(露出真的那块左栏)', p?.space === 'b' && (await peek(page)) === null)
  await park(page)
  await page.waitForTimeout(300)

  // ── B. 收起后:停够才弹,路过不弹 ──
  await setLeft(page, false)
  await park(page)
  await hover(page, icon('a'))
  await page.waitForTimeout(120)
  check('B1 刚停上去(120ms)还没弹', (await peek(page)) === null)
  await page.waitForTimeout(330)
  p = await peek(page)
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
  // 当前标签后面再摆一个:「紧挨在右边」才和「追加到组末尾」分得开
  await page.evaluate(() => {
    const w = window.__peek.useWorkspace.getState()
    const main = w.api.panels.filter((x) => (x.params || {}).__loc === 'main')
    const cur = main.find((x) => x.api.isActive) ?? main[0]
    w.openView('mainv', { doc: 'filler' }, 'main', { newTab: true })
    w.activateLeaf(cur.id)
  })
  await page.waitForTimeout(200)
  const tabs0 = await mainTabs(page)
  const rowB = await centerOf(page, '.rb-peek .pk-row[data-row="1"]')
  await page.mouse.move(rowB.x, rowB.y, { steps: 4 })
  await page.mouse.click(rowB.x, rowB.y)
  await page.waitForTimeout(300)
  s = await state(page)
  let tabs = await mainTabs(page)
  check('⚠️E4 在别的 Space 的卡里点一下:不切 Space,这一下点击照常落地', s.space === 'a' && s.hits[s.hits.length - 1] === 'b2:1@a', `active ${s.space} / ${s.hits.join()}`)
  const was = tabs0.find((x) => x.active)
  const made = tabs.find((x) => x.active)
  check('⚠️E5 要往主区开的:开成紧挨在当前标签右边的新标签(原来那个标签内容不动)',
    tabs.length === tabs0.length + 1 && made?.doc === 'b2:1' && made.group === was?.group && made.at === was.at + 1
      && tabs0.every((t) => tabs.some((x) => x.id === t.id && x.doc === t.doc)),
    `before ${JSON.stringify(tabs0)} / after ${JSON.stringify(tabs)}`)
  check('E5b 点完卡片还在(指针没离开)', (await peek(page))?.space === 'b')
  await page.evaluate((id) => window.__peek.useWorkspace.getState().activateLeaf(id), was.id)
  await page.mouse.click(rowB.x, rowB.y)
  await page.waitForTimeout(300)
  tabs = await mainTabs(page)
  check('E5c 同一个再点一次:已经开着,切过去,不再开一份', tabs.length === tabs0.length + 1 && tabs.find((x) => x.active)?.id === made?.id, JSON.stringify(tabs))
  const tog = await centerOf(page, '.rb-peek .pk-toggle')
  await page.mouse.move(tog.x, tog.y, { steps: 4 })
  await page.mouse.click(tog.x, tog.y)
  await page.waitForTimeout(300)
  s = await state(page)
  check('E5d 只在左栏里起作用的(展开 / 收起文件夹之类):原样生效,不切 Space、不开标签',
    s.space === 'a' && (await mainTabs(page)).length === tabs.length && (await page.locator('.rb-peek .pk-toggle').getAttribute('aria-expanded')) === 'true',
    `active ${s.space}`)
  check('E5e 当前 Space 的卡头部没有「进入」钮,别的 Space 的有', (await page.locator('.rb-peek .rb-peek-enter').count()) === 1)
  const enter = await centerOf(page, '.rb-peek .rb-peek-enter')
  await page.mouse.move(enter.x, enter.y, { steps: 4 })
  await page.mouse.click(enter.x, enter.y)
  await page.waitForTimeout(700)
  s = await state(page)
  check('⚠️E6 点卡片头部的名字:进入那个 Space,卡片收起', s.space === 'b' && (await peek(page)) === null, `active ${s.space}`)
  await hover(page, icon('b'))
  await page.waitForTimeout(600)
  check('E7 左栏展开着,悬停当前 Space(刚切过来的 b)不弹', s.left === true && (await peek(page)) === null, `left ${s.left}`)

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
  check('G1 弹着当前 Space 的预览时左面板展开了(不是卡里点出来的)→ 预览收起', p?.space === 'a' && (await peek(page)) === null)
  await setLeft(page, false)
  p = await openOn(page, 'b')
  await page.evaluate(() => window.__peek.useWorkspace.getState().toggleSidebar('left'))
  await page.waitForTimeout(700)
  check('G1b 弹着别的 Space 的预览时左面板展开了:不关它的事,卡片留着', p?.space === 'b' && (await peek(page))?.space === 'b', JSON.stringify(await peek(page)))
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
  // 左面板展开着的那种摆法也在 110% 下量一遍(用户的 dev 界面缩放就是 110%)。
  await setLeft(page, true)
  p = await openOn(page, 'b')
  const zg = await page.evaluate(() => {
    const g = window.__peek.useWorkspace.getState().api.panels.find((x) => (x.params || {}).__loc === 'left').group.element.getBoundingClientRect()
    return { l: g.left, t: g.top, r: g.right, b: g.bottom }
  })
  check('⚠️G3 110% 缩放 + 左面板展开着:别的 Space 的卡片仍正好盖在眼前这块左栏上',
    p?.space === 'b' && zg.b - zg.t > 100 && ['l', 't', 'r', 'b'].every((k) => Math.abs(p.rect[k] - zg[k]) <= 1.5),
    `card ${JSON.stringify(p?.rect)} / left panel ${JSON.stringify(zg)}`)
  await setLeft(page, false)
  await page.evaluate(() => { document.body.style.zoom = '' })
  await page.waitForTimeout(200)

  // ── I. 把卡里(别的 Space)的条目拖进主区 ──
  p = await openOn(page, 'b')
  const t1 = await mainTabs(page)
  const bar = await page.evaluate(() => {
    const api = window.__peek.useWorkspace.getState().api
    const g = (api.activePanel && api.activePanel.params.__loc === 'main' ? api.activePanel : api.panels.find((x) => x.params.__loc === 'main')).group
    const tab = g.element.querySelector('.dv-tab').getBoundingClientRect()
    const body = g.element.querySelector('.dv-content-container').getBoundingClientRect()
    return { gid: g.id, x: tab.left + 3, y: tab.top + tab.height / 2, bx: body.left + body.width * 0.8, by: body.top + body.height * 0.3 }
  })
  let d = await dragTo(page, '.rb-peek .pk-row[data-row="1"]', bar.x, bar.y)
  let t2 = await mainTabs(page)
  s = await state(page)
  const dropped = t2.find((x) => x.doc === 'b:1')
  check('⚠️I1 拖进标签栏(第一个标签的左半边):成了那个位置上的新标签,不切 Space',
    d.hint && t2.length === t1.length + 1 && dropped?.group === bar.gid && dropped.at === 0 && dropped.active && s.space === 'a',
    `hint ${d.hint} on ${d.on} / ${JSON.stringify(t2)} / active ${s.space}`)
  const end = await page.evaluate((gid) => {
    const g = window.__peek.useWorkspace.getState().api.groups.find((x) => x.id === gid)
    const tabs = [...g.element.querySelectorAll('.dv-tab')].map((t) => t.getBoundingClientRect())
    const last = tabs[tabs.length - 1]
    return { x: last.right - 3, y: last.top + last.height / 2 }
  }, bar.gid)
  d = await dragTo(page, '.rb-peek .pk-row[data-row="1"]', end.x, end.y)
  t2 = await mainTabs(page)
  const moved = t2.find((x) => x.doc === 'b:1')
  check('⚠️I1b 已经开着(而且正看着)的那个再拖到标签栏末尾:是把它挪过去,不再开一份',
    d.hint && t2.length === t1.length + 1 && moved?.group === bar.gid && moved.at === t2.filter((x) => x.group === bar.gid).length - 1,
    `hint ${d.hint} / ${JSON.stringify(t2)}`)
  d = await dragTo(page, '.rb-peek .pk-row[data-row="2"]', bar.bx, bar.by)
  const t3 = await mainTabs(page)
  const split = t3.find((x) => x.doc === 'b:2')
  check('⚠️I2 拖进正文右半边:分屏(新开一组放它)', d.hint && t3.length === t2.length + 1 && !!split && new Set(t3.map((x) => x.group)).size === new Set(t2.map((x) => x.group)).size + 1,
    `hint ${d.hint} on ${d.on} / ${JSON.stringify(t3)}`)
  const zone = await centerOf(page, '.pk-main .pk-zone:visible')
  d = await dragTo(page, '.rb-peek .pk-row[data-row="3"]', zone.x, zone.y)
  s = await state(page)
  check('I3 拖到自己接拖放的落区上(聊天插引用那种):让给它,不开、不画提示',
    !d.hint && s.hits[s.hits.length - 1] === 'zone' && (await mainTabs(page)).length === t3.length, `hint ${d.hint} / ${s.hits.join()}`)
  const ta = await centerOf(page, '.pk-main .pk-ta:visible')
  d = await dragTo(page, '.rb-peek .pk-row[data-row="3"]', ta.x, ta.y)
  check('I4 拖到文本框(编辑器)里:让给它,不开、不画提示', !d.hint && (await mainTabs(page)).length === t3.length, `hint ${d.hint} on ${d.on}`)
  const side = await page.evaluate(() => { const r = document.querySelector('.rb-peek .pk-blank').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  d = await dragTo(page, '.rb-peek .pk-row[data-row="3"]', side.x, side.y)
  check('I5 落在左栏(卡片)里:不是开 View 的地方,不开', !d.hint && (await mainTabs(page)).length === t3.length, `hint ${d.hint} on ${d.on}`)
  const stale = await page.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms))
    // 条目拖到一半源被卸掉、dragend 没到:引擎里留着「落点即开」的状态。接着来一次系统文件拖入(没走 dragstart,载荷里没有标记)。
    const src = document.querySelector('.rb-peek .pk-row[data-row="3"]')
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    await nap(50)
    const el = [...document.querySelectorAll('.pk-main')].find((m) => m.getBoundingClientRect().width > 0)
    const r = el.getBoundingClientRect(), x = r.left + r.width * 0.5, y = r.top + r.height * 0.6
    const hit = document.elementFromPoint(x, y)
    hit.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: x, clientY: y }))
    await nap(50)
    const hint = [...document.querySelectorAll('.wb-drop-line, .wb-drop-zone')].some((e) => getComputedStyle(e).display !== 'none')
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    return { hint, on: hit.className }
  })
  check('I6 残留着条目拖拽的状态时来一次系统文件拖入:引擎不接(不画提示)', stale.hint === false, JSON.stringify(stale))
  await park(page)
  await page.waitForTimeout(400)

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
