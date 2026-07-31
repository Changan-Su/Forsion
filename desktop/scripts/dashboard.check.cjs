// Dashboard 视图的**真浏览器**契约检查(harness ?dashboard 模式)。
//
// 分工:格子几何 / frontmatter 编解码 / 冲突判定 / 过真编译器往返 —— 全在
// shared/amadeus/dashboard.test.ts(vitest,19 条)。这支仪器只钉单测**看不见**的那一层:
//   D1 CSS Grid 真把 [x,y,w,h] 摆到了对应的格子(24 列的像素换算对不对);
//   D2 时钟卡片是活的(秒真的在走);
//   D3 锁定 = 浏览:块不可编辑、没有拖动条/缩放把手;解锁后反过来;
//   D4 拖动 → 卡片挪位 **且落进 frontmatter**(布局真持久化了,不只是画面动了);
//   D5 拖到压住别人 → 回弹(冲突策略是「拒绝」,不是自动挤开);
//   D6 右下角把手缩放改的是 w/h,不是 x/y。
//
// 用法:npm run check:dashboard(自带起停 vite);或 npm run web 后 node scripts/dashboard.check.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 网格的一格步长(列宽+gap / 行高+gap),从真 DOM 量 —— 和视图里 steps() 同一算法。 */
const steps = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.dash-grid')
    const cs = getComputedStyle(el)
    const gap = parseFloat(cs.columnGap) || 0
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const cell = (inner - 23 * gap) / 24
    const rowPx = parseFloat(cs.gridTemplateRows.split(' ')[0]) || 0
    return { x: cell + gap, y: rowPx + gap, gap, cell, rowPx, originX: el.getBoundingClientRect().left + parseFloat(cs.paddingLeft), originY: el.getBoundingClientRect().top + parseFloat(cs.paddingTop) }
  })

/** 第 i 张卡片(文档顺序)的视口矩形。 */
const cardRect = (page, i) =>
  page.evaluate((n) => {
    const el = document.querySelectorAll('.dash-card')[n]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, i)

/** 落盘真相:store 里的 frontmatter 文本(拖完必须变的就是它)。 */
const fm = (page) => page.evaluate(() => window.__pageStore.getState().manifest.fmExtra || '')

/** 从 fmExtra 里读某个块的矩形(仪器自己解一遍,不复用被测代码)。 */
function rectOf(text, id) {
  const m = new RegExp(`^\\s*"?${id}"?:\\s*\\[(.+)\\]\\s*$`, 'm').exec(text)
  if (!m) return null
  const n = m[1].split(',').map((v) => Number(v.trim()))
  return { x: n[0], y: n[1], w: n[2], h: n[3] }
}

/** 按住 from 拖到 to(慢速多步:pointermove 少了浏览器可能合并成一步,拖不动)。 */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
  await page.waitForTimeout(250)
}

/** 对块宿主派发一次真 contextmenu 并回报是否弹出块菜单。
 *  ⚠️ 不用 mouse.click({button:'right'}):卡片中心被 ProseMirror 铺满,真实右键在那儿会被编辑器吞掉,
 *  事件根本到不了 BlockHost.onCtxMenu —— 那样「锁定态没菜单」会因为「事件没到」而假绿,
 *  测不出 readOnly 到底管没管住结构操作。派发到 .block-host 才是精确打在被测处理器上。 */
async function ctxMenuOpens(page) {
  await page.evaluate(() => {
    const h = document.querySelector('.dash-card .block-host')
    h && h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
  })
  await page.waitForTimeout(300)
  const n = await page.locator('.ctx-menu').count()
  if (n) {
    await page.keyboard.press('Escape')
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.waitForTimeout(150)
  }
  return n > 0
}

async function open(browser, locked) {
  const page = await browser.newPage()
  // ⚠️ 光 console.log 就是假绿:页面抛异常照样 0 退出。收进 results,收尾一起判。
  page.on('pageerror', (e) => check(`页面无未捕获异常(${e.message.slice(0, 60)})`, false))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${BASE}?dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dash-grid .dash-card', { timeout: 20000 })
  await page.waitForTimeout(500)
  if (!locked) {
    await page.locator('.amx-toolbar button[title^="解锁编辑"]').click()
    await page.waitForTimeout(350)
  }
  return page
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // D1 frontmatter 里的 [x,y,w,h] 真的落在对应格子上(种的是 1:[0,0,8,6] 2:[8,0,5,4] 3:[0,6,6,4])
  {
    const page = await open(browser, true)
    const n = await page.locator('.dash-card').count()
    check('D1 三张卡片都渲染出来了', n === 3, `cards=${n}`)
    const s = await steps(page)
    const [c1, c2, c3] = [await cardRect(page, 0), await cardRect(page, 1), await cardRect(page, 2)]
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol
    check('D1 卡片1 落在 (0,0) 且宽 8 格', near(c1.left, s.originX) && near(c1.width, 8 * s.cell + 7 * s.gap), JSON.stringify({ left: Math.round(c1.left), want: Math.round(s.originX), w: Math.round(c1.width) }))
    check('D1 卡片2 落在第 8 列(与卡片1 右侧相邻不重叠)', near(c2.left, s.originX + 8 * s.x) && near(c2.top, c1.top), JSON.stringify({ left: Math.round(c2.left), want: Math.round(s.originX + 8 * s.x) }))
    check('D1 卡片3 落在第 6 行(y=6 → 在卡片1 下方)', near(c3.left, s.originX) && near(c3.top, c1.top + 6 * s.y), JSON.stringify({ top: Math.round(c3.top), want: Math.round(c1.top + 6 * s.y) }))
    check('D1 高度按行数走(卡片1 h=6)', near(c1.height, 6 * s.rowPx + 5 * s.gap), JSON.stringify({ h: Math.round(c1.height), want: Math.round(6 * s.rowPx + 5 * s.gap) }))
    check('D1 永不横向溢出', await page.evaluate(() => document.querySelector('.dash-grid').scrollWidth <= document.querySelector('.dash-grid').clientWidth + 1))

    // D2 时钟卡片是活的
    const t1 = await page.evaluate(() => document.querySelector('.dash-clock-time')?.textContent || '')
    check('D2 时钟渲染成了时间', /^\d{2}:\d{2}:\d{2}$/.test(t1.trim()), JSON.stringify(t1))
    await page.waitForTimeout(1600)
    const t2 = await page.evaluate(() => document.querySelector('.dash-clock-time')?.textContent || '')
    check('D2 秒在走', t1 !== t2, `${t1} → ${t2}`)
    // 时钟块**不能**同时被当成普通 markdown 渲染出源码
    check('D2 时钟卡片里没有代码块源码', !(await page.evaluate(() => (document.querySelectorAll('.dash-card')[1]?.innerText || '').includes('```'))))

    // D3 锁定 = 浏览
    check('D3 锁定态无拖动条', (await page.locator('.dash-card-bar').count()) === 0)
    check('D3 锁定态无缩放把手', (await page.locator('.dash-card-resize').count()) === 0)
    const editable = await page.evaluate(() => {
      const pm = document.querySelector('.dash-card .ProseMirror')
      return pm ? pm.getAttribute('contenteditable') : 'none'
    })
    check('D3 锁定态块不可编辑', editable === 'false', `contenteditable=${editable}`)
    // ⚠️ 只查 contenteditable 是**假绿**:块菜单里有 删除/复制块/移到新列,全是结构写操作,
    //    而它们此前完全不看 readOnly(CSS 只把手柄藏了)。Codex 评审揪出来的。
    check('D3 锁定态不出块菜单(删除/复制/分栏)', !(await ctxMenuOpens(page)))
    await page.close()
  }

  // 解锁态:D3 反面 + D4/D5/D6
  {
    const page = await open(browser, false)
    check('D3 解锁态出现拖动条/把手', (await page.locator('.dash-card-bar').count()) === 3 && (await page.locator('.dash-card-resize').count()) === 3)
    // 反面:解锁态菜单必须还在(否则「锁定态没菜单」可能只是把功能整个删了)
    check('D3 解锁态块菜单仍在(别一刀切死)', await ctxMenuOpens(page))
    const editable2 = await page.evaluate(() => document.querySelector('.dash-card .ProseMirror')?.getAttribute('contenteditable'))
    check('D3 解锁态块可编辑', editable2 === 'true', `contenteditable=${editable2}`)

    const s = await steps(page)

    // D4 把卡片3(0,6)往右拖 3 格 → 应落到 (3,6),且 frontmatter 跟着变
    {
      const bar = await page.evaluate(() => {
        const r = document.querySelectorAll('.dash-card')[2].querySelector('.dash-card-bar').getBoundingClientRect()
        return { x: r.left + 6, y: r.top + r.height / 2 }
      })
      await drag(page, bar, { x: bar.x + 3 * s.x, y: bar.y })
      const r3 = rectOf(await fm(page), 3)
      check('D4 拖动落进 frontmatter(卡片3 → x=3)', !!r3 && r3.x === 3 && r3.y === 6, JSON.stringify(r3))
      const c3 = await cardRect(page, 2)
      check('D4 画面与落盘一致', Math.abs(c3.left - (s.originX + 3 * s.x)) <= 2, JSON.stringify({ left: Math.round(c3.left) }))
    }

    // D5 把卡片3 往上拖到卡片1 身上(0..8 × 0..6 已被占)→ 必须回弹,布局不变
    {
      const before = await fm(page)
      const bar = await page.evaluate(() => {
        const r = document.querySelectorAll('.dash-card')[2].querySelector('.dash-card-bar').getBoundingClientRect()
        return { x: r.left + 6, y: r.top + r.height / 2 }
      })
      await drag(page, bar, { x: bar.x - 2 * s.x, y: bar.y - 4 * s.y })
      const after = await fm(page)
      check('D5 压到别人 → 回弹(布局一个字节没变)', before === after, JSON.stringify(rectOf(after, 3)))
    }

    // D6 缩放把手:卡片2 (8,0,5,4) 往右下拖 2×2 格 → w/h 变、x/y 不变
    {
      const h = await page.evaluate(() => {
        const r = document.querySelectorAll('.dash-card')[1].querySelector('.dash-card-resize').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await drag(page, h, { x: h.x + 2 * s.x, y: h.y + 2 * s.y })
      const r2 = rectOf(await fm(page), 2)
      check('D6 缩放改的是 w/h', !!r2 && r2.w === 7 && r2.h === 6, JSON.stringify(r2))
      check('D6 缩放不动 x/y', !!r2 && r2.x === 8 && r2.y === 0, JSON.stringify(r2))
    }
    await page.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
