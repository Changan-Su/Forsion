// 结构化网格版 Dashboard 的**真浏览器**契约检查(harness ?dashgrid 模式)。
//
// 分工:纯逻辑(读写往返 / 三态 / 列数与跨度 / 排序 / 自愈 / 迁移)在 shared/amadeus/dashboard3.test.ts。
// 这支只钉单测**看不见**的那一层 —— 全都是浏览器真实排版行为:
//   G1 自动编排在声明尺寸内改档、成组填行；不足一行时整组居中
//   G2 响应式:宿主变窄 → 实际列数降档,**永不横向滚动**,且半宽仍是半宽
//   G3 统一外壳:锁定/解锁两态里卡片的圆角·描边·底色完全一致(这是「统一」的可证伪判据)
//   G4 分区标题不是卡片(无壳无边),且恒整行
//   G5 两态语义(2026-08-28 拍板):锁定=内容单击直达;解锁=整卡罩层起拖(画布同款),**双击**进卡片
//   G6 拖拽重排 → 顺序变了**且落进 frontmatter**(不是只有画面动)
//   G7 右下把手按格量化:拖一点点不变,拖过半格才跳一档;落盘的是 12 列参考跨度
//   G8 空仪表盘给模板,点一下真的成型
//   G9 文字尺寸不随窗宽变(与画布版「整页缩放」相反 —— 这是响应式重排,不是拉伸海报)
//
// 用法:npm run check:dashgrid;截图:npm run shot:dashgrid
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

const SHOT_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith('--shot'))
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'dashgrid-shots')) : null
})()
async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  console.log(`SHOT  ${path.join(SHOT_DIR, `${name}.png`)}`)
}

const fm = (page) => page.evaluate(() => window.__pageStore.getState().manifest.fmExtra || '')

/** 仪器自己解一遍 dashboard3(不复用被测代码)。 */
function cellOf(text, id) {
  const body = text.split(/^dashboard3:\s*$/m)[1]
  if (!body) return null
  const m = new RegExp(`^\\s*"?${id}"?:\\s*\\[(.+)\\]\\s*$`, 'm').exec(body)
  if (!m) return null
  const n = m[1].split(',').map((v) => Number(v.trim()))
  return { order: n[0], w: n[1], h: n[2] }
}

const cardRect = (page, id) => page.evaluate((k) => {
  const el = document.querySelector(`.dash3-card[data-key="${k}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}, id)

/** 卡片外壳的实测样式 —— 「统一」这件事只有它能证伪。 */
const shellOf = (page, id) => page.evaluate((k) => {
  const el = document.querySelector(`.dash3-card[data-key="${k}"]`)
  if (!el) return null
  const s = getComputedStyle(el)
  const head = el.querySelector('.dash3-card-head')
  const hs = head ? getComputedStyle(head) : null
  return {
    radius: s.borderTopLeftRadius,
    border: s.borderTopWidth + ' ' + s.borderTopStyle,
    bg: s.backgroundColor,
    borderColor: s.borderTopColor,
    // ⚠️ 只比圆角/描边/底色是不够的:编辑态偷偷抹掉阴影、改标题条高度或内边距,一样是「两态不一样」
    //    (Codex 2026-08-27 评审:G3 有假绿空间)。
    shadow: s.boxShadow,
    padding: `${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft}`,
    headH: head ? Math.round(head.getBoundingClientRect().height) : null,
    headPad: hs ? `${hs.paddingTop}/${hs.paddingBottom}` : null,
  }
}, id)

async function open(browser, locked, width = 1280, dark = false, mode = 'dashgrid') {
  const page = await browser.newPage()
  page.on('pageerror', (e) => check(`页面无未捕获异常(${e.message.slice(0, 80)})`, false))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${BASE}?${mode}${dark ? '&dark' : ''}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dash3-host .dash3-card', { timeout: 20000 })
  // 首帧 ResizeObserver 会把 1 列参考布局切到真列数；等布局动效完整收口后再量最终几何。
  await page.waitForTimeout(750)
  if (!locked) {
    await page.locator('.amx-toolbar button[title^="编辑布局"]').click()
    await page.waitForTimeout(300)
  }
  return page
}

async function drag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(12)
  }
  await page.mouse.up()
  await page.waitForTimeout(320)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── G1 / G3 / G4 / G5 正面 / G9:锁定态 = 成品页 ────────────────────────────
  {
    const page = await open(browser, true)
    await shot(page, 'locked')

    const n = await page.locator('.dash3-card').count()
    check('G1 七张卡片都渲染出来了', n === 7, `cards=${n}`)

    const spans = await page.evaluate(() => [...document.querySelectorAll('.dash3-card')].map((el) => ({
      key: el.dataset.key, column: getComputedStyle(el).gridColumn, size: el.dataset.size,
    })))
    check('G1 旧任意尺寸经契约自动改档(clock/text → wide，view → lg)',
      spans[1].size === 'wide' && spans[2].size === 'wide' && spans[3].size === 'lg',
      JSON.stringify(spans.slice(0, 4)))

    // 顺序 = DOM 顺序 = frontmatter 的 order(不开 dense,看到的就是排的)
    const domOrder = await page.evaluate(() => [...document.querySelectorAll('.dash3-card')].map((el) => el.dataset.key))
    check('G1 DOM 顺序 = order 顺序(没开 dense,看到的顺序就是排的顺序)',
      domOrder.join(',') === '1,2,3,4,5,6,7', domOrder.join(','))

    // clock + text 自动换成两个 half，完整填一行；后面的单张摘要维持 lg 并整组居中。
    const [r2, r3, r4] = await Promise.all([cardRect(page, '2'), cardRect(page, '3'), cardRect(page, '4')])
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol
    check('G1 相邻可兼容卡自动拼满(两个 half 顶边齐平)，不把 view 强塞进同行',
      near(r2.top, r3.top) && r4.top > r2.top + r2.height && near(r2.width, r3.width, 3),
      JSON.stringify({ r2: r2.top, r3: r3.top, r4: r4.top }))

    // 拍平后没有 .dash3-row 容器了:行 = gridRowStart 相同的槽位组(几何语义不变)。
    const rowUse = await page.evaluate(() => {
      const grid = document.querySelector('.dash3-grid')
      const cs = getComputedStyle(grid)
      const gr = grid.getBoundingClientRect()
      const gl = gr.left + parseFloat(cs.paddingLeft)
      const gright = gr.right - parseFloat(cs.paddingRight)
      const groups = new Map()
      for (const slot of grid.querySelectorAll('.dash3-card-slot')) {
        const key = getComputedStyle(slot).gridRowStart
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(slot)
      }
      return [...groups.values()].map((slots) => {
        const rects = slots.map((s) => s.getBoundingClientRect())
        const left = Math.min(...rects.map((r) => r.left))
        const right = Math.max(...rects.map((r) => r.right))
        return {
          chrome: !!slots[0].querySelector('.dash3-card--chrome'),
          count: slots.length,
          ratio: (right - left) / (gright - gl),
          left: left - gl,
          right: gright - right,
        }
      })
    })
    check('G1 每个内容行至少占半宽；不足整行的组左右留白对称，不再永远贴左',
      rowUse.filter((row) => !row.chrome).every((row) => row.ratio >= 0.48 && (row.ratio > 0.9 || Math.abs(row.left - row.right) < 4)),
      JSON.stringify(rowUse))

    const shellLocked = await shellOf(page, '4')
    check('G3 锁定态卡片有语义外壳(圆角 + 底色，装饰边透明)',
      shellLocked.radius !== '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(shellLocked.borderColor) && shellLocked.bg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(shellLocked))

    const contract = await page.evaluate(() => {
      const metric = document.querySelector('.dash3-card[data-key="2"]')
      const summary = document.querySelector('.dash3-card[data-key="4"]')
      return {
        container: getComputedStyle(metric).containerType,
        metricShadow: getComputedStyle(metric).boxShadow,
        summaryShadow: getComputedStyle(summary).boxShadow,
        compactFaces: document.querySelectorAll('.dash-viewcard--compact [data-tag="dashcompact"]').length,
      }
    })
    check('G3 卡片是真 container，尺寸感知 CSS(cqw)接在新外壳上', contract.container.includes('inline-size'), JSON.stringify(contract))
    check('G3 metric / summary 使用不同语义表面，不再所有卡一套边框阴影', contract.metricShadow === 'none' && contract.summaryShadow !== 'none', JSON.stringify(contract))
    check('G3 view 走专用紧凑卡片面，而不是缩小后的完整页面', contract.compactFaces === 2, JSON.stringify(contract))

    const sectionShell = await shellOf(page, '1')
    check('G4 分区标题不是卡片(透明底 + 透明边)',
      sectionShell.bg === 'rgba(0, 0, 0, 0)' && /rgba\(0, 0, 0, 0\)|transparent/.test(sectionShell.borderColor),
      JSON.stringify(sectionShell))
    const sec = await cardRect(page, '1')
    const host = await page.evaluate(() => {
      const g = document.querySelector('.dash3-grid')
      const cs = getComputedStyle(g)
      // 整行 = 网格的**内容宽**;boundingRect 含 padding,拿它比必然差两个 padding。
      return { width: g.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) }
    })
    check('G4 分区标题恒整行', near(sec.width, host.width, 3), JSON.stringify({ sec: sec.width, host: host.width }))

    // G5 正面:锁定态没有拖拽面/把手,卡内容直接可点(单击就该管用 —— 这里没有手势层要抢)
    check('G5 锁定态没有拖拽面', (await page.locator('.dash3-shield').count()) === 0)
    check('G5 锁定态没有调整把手', (await page.locator('.dash3-grip').count()) === 0)
    const before = await page.locator('[data-act="hit"]').first().getAttribute('data-hits')
    await page.locator('[data-act="hit"]').first().click()
    await page.waitForTimeout(150)
    const after = await page.locator('[data-act="hit"]').first().getAttribute('data-hits')
    check('G5 锁定态单击直达卡内容(不需要双击 —— 成品页本来就没有手势层)',
      before === '0' && after === '1', `${before} → ${after}`)

    // ⚠️ 别拿时钟量:`.dash-clock-time` 是 `clamp(…, cqw, …)`,按**卡片宽度**缩放 —— 那是挂件
    //    自己的设计(小卡片里字小一点),不是页面缩放。要证伪的是「整页被 scale」,所以量正文。
    const bodyFont = () => page.evaluate(() => {
      const el = document.querySelector('.dash3-card[data-key="3"] .dash3-card-body')
      return { size: getComputedStyle(el).fontSize, zoom: getComputedStyle(document.querySelector('.dash3-grid')).transform }
    })
    const fontA = await bodyFont()
    await page.setViewportSize({ width: 760, height: 900 })
    await page.waitForTimeout(350)
    const fontB = await bodyFont()
    check('G9 窗口变窄:正文字号一个像素都不变、网格也没被 scale(重排,不是拉伸海报)',
      fontA.size === fontB.size && fontA.zoom === 'none' && fontB.zoom === 'none',
      `${JSON.stringify(fontA)} → ${JSON.stringify(fontB)}`)
    await page.close()
  }

  // ── 暗色一档:观感契约两档都算数(DESIGN.md §8),截图 + 一条可证伪的断言 ────────
  {
    const page = await open(browser, true, 1280, true)
    await shot(page, 'locked-dark')
    const shell = await shellOf(page, '4')
    const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(shell.bg)
    check('暗色档卡片底色真的跟着换(不是浅色 token 直接套上来)',
      !!rgb && Number(rgb[1]) < 90 && Number(rgb[2]) < 90 && Number(rgb[3]) < 90, JSON.stringify(shell))
    await page.close()
  }

  // ── G2 响应式降档 ─────────────────────────────────────────────────────────
  {
    const page = await open(browser, true, 1400)
    const colsAt = async (w) => {
      await page.setViewportSize({ width: w, height: 900 })
      await page.waitForTimeout(300)
      return page.evaluate(() => {
        const g = document.querySelector('.dash3-grid')
        const cs = getComputedStyle(g)
        return {
          cols: cs.gridTemplateColumns.split(' ').length,
          overflow: document.querySelector('.dash3-host').scrollWidth - document.querySelector('.dash3-host').clientWidth,
          half: document.querySelector('.dash3-card[data-key="4"]').getBoundingClientRect().width,
          grid: g.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        }
      })
    }
    const wide = await colsAt(1400)
    const mid = await colsAt(820)
    const narrow = await colsAt(430)
    check('G2 宽窗 12 列', wide.cols === 12, JSON.stringify(wide))
    check('G2 变窄自动降档(列数只减不增)', mid.cols <= wide.cols && narrow.cols <= mid.cols,
      `${wide.cols} → ${mid.cols} → ${narrow.cols}`)
    check('G2 任何宽度都不横向滚动',
      wide.overflow <= 1 && mid.overflow <= 1 && narrow.overflow <= 1,
      JSON.stringify([wide.overflow, mid.overflow, narrow.overflow]))
    // 卡片4 的自动选择是 lg(6/12)，且作为单卡居中；降档后仍保持半宽比例。
    const halfRatio = (x) => x.half / x.grid
    check('G2 半宽卡在每一档都还是半宽(候选列数全为偶数的意义)',
      Math.abs(halfRatio(wide) - 0.5) < 0.06 && Math.abs(halfRatio(mid) - 0.5) < 0.06,
      JSON.stringify([halfRatio(wide).toFixed(3), halfRatio(mid).toFixed(3), halfRatio(narrow).toFixed(3)]))
    await page.close()
  }

  // ── G3 反面 + G5 反面 + G6 + G7:解锁 = 排版台 ─────────────────────────────
  {
    const page = await open(browser, false)
    await shot(page, 'editing')

    const shellEdit = await shellOf(page, '4')
    const page2 = await open(browser, true)
    const shellLocked = await shellOf(page2, '4')
    await page2.close()
    check('G3 **外壳在两态里完全一致**(圆角/描边/底色逐项相同)—— 这就是「统一」的判据',
      JSON.stringify(shellEdit) === JSON.stringify(shellLocked),
      `${JSON.stringify(shellEdit)} vs ${JSON.stringify(shellLocked)}`)

    check('G5 解锁态每张卡都有整卡拖拽罩层(画布同款,2026-08-28 用户拍板)',
      (await page.locator('.dash3-shield').count()) === 7)
    const shieldGeometry = await page.evaluate(() => {
      const card = document.querySelector('.dash3-card[data-key="4"]')
      const shield = card.querySelector('.dash3-shield')
      const c = card.getBoundingClientRect(), sr = shield.getBoundingClientRect()
      return { cover: (sr.width * sr.height) / (c.width * c.height) }
    })
    check('G5 罩层盖满整卡(拖哪儿都能拖)', shieldGeometry.cover > 0.95, JSON.stringify(shieldGeometry))
    // 双击分层:单击被罩层拦下;双击进交互态(撤罩+描边)后内容可点;点卡外退出、罩层回来。
    const hitsBefore = await page.locator('[data-act="hit"]').first().getAttribute('data-hits')
    await page.locator('.dash3-card[data-key="4"] .dash3-shield').click()
    await page.waitForTimeout(150)
    const hitsMid = await page.locator('[data-act="hit"]').first().getAttribute('data-hits')
    check('G5 解锁态单击被罩层拦下(不再直达内容)', hitsMid === hitsBefore, `${hitsBefore} → ${hitsMid}`)
    await page.locator('.dash3-card[data-key="4"] .dash3-shield').dblclick()
    await page.waitForTimeout(250)
    check('G5 双击进入交互态(撤罩 + primary 描边)',
      (await page.locator('.dash3-card[data-key="4"] .dash3-shield').count()) === 0
        && (await page.locator('.dash3-card[data-key="4"][data-interact]').count()) === 1)
    await page.locator('[data-act="hit"]').first().click()
    await page.waitForTimeout(150)
    const hitsAfter = await page.locator('[data-act="hit"]').first().getAttribute('data-hits')
    check('G5 交互态内容可点(双击分层,不是永久封死)',
      Number(hitsAfter) === Number(hitsMid) + 1, `${hitsMid} → ${hitsAfter}`)
    await page.mouse.click(20, 400) // 卡外(宿主左留白)
    await page.waitForTimeout(250)
    check('G5 点卡外退出交互态(罩层回来)',
      (await page.locator('.dash3-card[data-key="4"] .dash3-shield').count()) === 1
        && (await page.locator('.dash3-card[data-interact]').count()) === 0)

    await page.locator('.dash3-card[data-key="2"] .dash3-card-more').click({ force: true })
    const sizeLabels = await page.locator('.dash-add-menu button:not(.dash-danger)').allTextContents()
    check('G5 尺寸菜单只列这类卡真正支持的档(clock 只有小/宽)，不会给出任意矩形',
      sizeLabels.length === 2 && sizeLabels.some((text) => text.includes('小')) && sizeLabels.some((text) => text.includes('宽')),
      JSON.stringify(sizeLabels))
    await page.locator('.dash-menu-scrim').click({ position: { x: 2, y: 2 } })

    // G6 拖拽重排:底部同行内把 7 拖到 6 前，避免测试依赖页面滚动位置。
    const orderBefore = cellOf(await fm(page), '7').order
    await page.locator('.dash3-card[data-key="7"]').scrollIntoViewIfNeeded()
    const from = await page.locator('.dash3-card[data-key="7"] .dash3-shield').boundingBox()
    const to = await page.locator('.dash3-card[data-key="6"] .dash3-shield').boundingBox()
    await drag(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: to.x + to.width / 2, y: to.y + to.height / 2 })
    const textAfter = await fm(page)
    const orderAfter = cellOf(textAfter, '7').order
    check('G6 拖拽真的改了顺序,且落进 frontmatter(不是只有画面动)',
      orderAfter !== orderBefore, `order ${orderBefore} → ${orderAfter}`)
    const orders = ['1', '2', '3', '4', '5', '6', '7'].map((id) => cellOf(textAfter, id).order).sort((a, b) => a - b)
    check('G6 重排后 order 仍是稠密的 0..6(不留洞、不重号)',
      orders.join(',') === '0,1,2,3,4,5,6', orders.join(','))

    // G7 把手量化:先拖 6px(不足半格,不该变),再拖一整格
    const page3 = await open(browser, false)
    const g0 = cellOf(await fm(page3), '3')
    const c2 = await cardRect(page3, '3')
    const grip = { x: c2.left + c2.width - 6, y: c2.top + c2.height - 6 }
    await drag(page3, grip, { x: grip.x + 6, y: grip.y + 4 })
    const g1 = cellOf(await fm(page3), '3')
    check('G7 把手拖不足半格 → 尺寸不变(量化,不是无级)',
      g1.w === g0.w && g1.h === g0.h, `${JSON.stringify(g0)} → ${JSON.stringify(g1)}`)
    const c2b = await cardRect(page3, '3')
    const grip2 = { x: c2b.left + c2b.width - 6, y: c2b.top + c2b.height - 6 }
    await drag(page3, grip2, { x: grip2.x, y: grip2.y + 170 })
    const g2 = cellOf(await fm(page3), '3')
    check('G7 拖过阈值只会跳到声明过的下一档(text:wide → lg)',
      g2.w === 6 && g2.h === 5, JSON.stringify(g2))
    await shot(page3, 'resized')
    await page3.close()
    await page.close()
  }

  // ── G8 空仪表盘 → 模板一键成型 ───────────────────────────────────────────
  {
    const page = await open(browser, false)
    await page.evaluate(() => {
      const st = window.__pageStore.getState()
      st.setFmExtra('tags: [harness]')
      window.__pageStore.setState({
        manifest: { ...st.manifest, fmExtra: 'tags: [harness]', root: { type: 'stack', children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [] }] }] }, blocks: {} },
        blocks: {},
      })
    })
    await page.waitForTimeout(300)
    check('G8 空仪表盘给的是模板,不是一片空白', (await page.locator('.dash3-template').count()) >= 2)
    await shot(page, 'empty')
    await page.locator('.dash3-template').first().click()
    await page.waitForTimeout(500)
    const made = await page.locator('.dash3-card').count()
    check('G8 点模板真的成型(卡片落下来了)', made >= 4, `cards=${made}`)
    const text = await fm(page)
    check('G8 模板落盘写了 dashboard3 布局键', /^dashboard3:/m.test(text), text.slice(0, 120))
    await shot(page, 'template')
    await page.close()
  }

  // ── G10-G12 数据卡 + 页面级筛选(?dashdata)────────────────────────────────
  //     钉的是复合 view 的**定义性行为**:加一条筛选,这一页上每一张数据卡同时变。
  {
    const page = await open(browser, false, 1280, false, 'dashdata')
    const statTexts = () => page.$$eval('.dash-stat-value', (els) => els.map((e) => e.textContent.replace(/\s+/g, '')))
    const barRows = () => page.$$eval('.dash-bar-row', (els) => els.map((e) => ({
      key: e.querySelector('.dash-bar-key').textContent,
      val: e.querySelector('.dash-bar-val').textContent,
    })))

    const before = await statTexts()
    check('G10 数字卡取到真数(行数 4 / 金额合计 350)', before.join('|') === '4|350', JSON.stringify(before))
    const bars = await barRows()
    check('G11 图表卡按状态分组各 2 条', bars.length === 2 && bars.every((b) => b.val === '2'), JSON.stringify(bars))
    await shot(page, 'data')

    // 经**真 UI** 加一条筛选:状态 = 进行中
    await page.locator('.dash-filter-add').click()
    await page.waitForTimeout(250)
    const selects = page.locator('.dash-filter-editor select')
    await selects.nth(0).selectOption({ label: '状态' })
    await page.waitForTimeout(150)
    await page.locator('.dash-filter-editor select').last().selectOption('进行中')
    await page.locator('.dash-filter-commit').click()
    await page.waitForTimeout(400)

    const after = await statTexts()
    check('G12 **一处改、全页跟随**:两张数字卡同时收窄(4→2、350→300)',
      after.join('|') === '2|300', `${before.join('|')} → ${after.join('|')}`)
    const barsAfter = await barRows()
    check('G12 图表卡同一条筛选也跟着走(只剩「进行中」)',
      barsAfter.length === 1 && barsAfter[0].key === '进行中', JSON.stringify(barsAfter))
    const fmText = await fm(page)
    check('G12 筛选落进 frontmatter 的 dashFilter 键(刷新还在)', /dashFilter:/.test(fmText), fmText.slice(0, 160))
    await shot(page, 'data-filtered')

    // 去掉筛选 → 回到原值(证明上一格不是「卡片坏了变小」)
    await page.locator('.dash-filter-chip button').first().click()
    await page.waitForTimeout(400)
    check('G12 反面:去掉筛选,数字回到 4|350(不是卡片坏了)',
      (await statTexts()).join('|') === '4|350', JSON.stringify(await statTexts()))
    await page.close()
  }

  // ── G16-G18 原生编辑 View + 动效契约(?dashinteractive)─────────────────────
  {
    const page = await open(browser, true, 1280, false, 'dashinteractive')
    const card = page.locator('.dash3-card[data-key="1"]')
    const editor = page.locator('[data-act="editor-input"]')
    const workspace = await card.evaluate((el) => ({ size: el.dataset.size, height: el.getBoundingClientRect().height }))
    check('G16 编辑器按原生契约落在工作区尺寸，不再被压进摘要小卡',
      workspace.size === 'workspace' && workspace.height > 560, JSON.stringify(workspace))

    await editor.fill('锁定布局时也能编辑')
    await page.locator('[data-act="editor-save"]').click()
    check('G16 锁定布局时编辑器可输入、按钮可点',
      (await editor.inputValue()) === '锁定布局时也能编辑'
        && (await page.locator('[data-act="editor-save"]').getAttribute('data-saved')) === '1')
    await shot(page, 'interactive-locked')

    await page.locator('.amx-toolbar button[title^="编辑布局"]').click()
    await page.waitForTimeout(220)
    // 排版台 = 整卡罩层;编辑内容要**双击**进入交互态(画布同款双击分层,2026-08-28 拍板)
    const shield16 = await page.locator('.dash3-card[data-key="1"] .dash3-shield').boundingBox()
    check('G16 排版台里编辑器卡也是整卡罩层(拖拽语汇与画布一致)',
      !!shield16 && shield16.height > 100, JSON.stringify(shield16))
    await page.locator('.dash3-card[data-key="1"] .dash3-shield').dblclick()
    await page.waitForTimeout(250)
    await editor.fill('排版台双击进入后仍能编辑')
    await page.locator('[data-act="editor-save"]').click()
    check('G16 双击进入交互态后编辑器可输入、可保存(不是永久封死)',
      (await editor.inputValue()) === '排版台双击进入后仍能编辑'
        && (await page.locator('[data-act="editor-save"]').getAttribute('data-saved')) === '2')

    await page.locator('.dash-add-wrap > button').click()
    const addMenu = page.locator('.dash-add-menu')
    const menuContract = await addMenu.evaluate((el) => {
      const style = getComputedStyle(el)
      return { animationName: style.animationName, duration: style.animationDuration, text: el.textContent }
    })
    check('G17 添加菜单有真实入场动画，不再瞬间闪现',
      menuContract.animationName.includes('dash3-menu-in') && menuContract.duration !== '0s', JSON.stringify(menuContract))
    check('G18 添加菜单能看到原生笔记编辑器入口', menuContract.text.includes('笔记编辑器'), menuContract.text)
    await page.locator('.dash-menu-scrim').click({ position: { x: 2, y: 2 } })

    await page.locator('.dash3-card[data-key="1"] .dash3-card-more').click({ force: true })
    const sizeLabels = await page.locator('.dash-add-menu button:not(.dash-danger)').allTextContents()
    check('G18 编辑器只给大/整行/工作区三档，工作区档真实可选',
      sizeLabels.length === 3 && sizeLabels.some((text) => text.includes('工作区')), JSON.stringify(sizeLabels))
    const beforeH = (await card.boundingBox()).height
    await page.locator('.dash-add-menu button', { hasText: '整行' }).click()
    await page.waitForTimeout(45)
    const mid = await card.evaluate((el) => ({ height: el.getBoundingClientRect().height, transform: getComputedStyle(el.parentElement).transform }))
    await page.waitForTimeout(420)
    const afterH = (await card.boundingBox()).height
    check('G17 改尺寸会做布局过渡，再收口到新的离散高度',
      afterH < beforeH - 100 && (mid.transform !== 'none' || (mid.height < beforeH && mid.height > afterH)),
      JSON.stringify({ beforeH, mid, afterH }))

    const motionContract = await page.evaluate(() => {
      const host = getComputedStyle(document.querySelector('.dash3-host'))
      const shell = getComputedStyle(document.querySelector('.dash3-card'))
      return { host: host.transitionDuration, shell: shell.transitionProperty, shellDuration: shell.transitionDuration }
    })
    check('G17 模式背景与卡片材质也走 Genesis 动效 token',
      motionContract.host !== '0s' && motionContract.shell.includes('background-color') && motionContract.shellDuration !== '0s',
      JSON.stringify(motionContract))
    await shot(page, 'interactive-editing')
    await page.close()
  }

  // ── G13-G15 落盘防线(Codex 2026-08-27 评审的两条 P0 + 一条 P2,修完留仪器)──────────
  {
    // G13:坏 dashboard3(合法 YAML、非法布局)→ 模板必须**停手**,一个字节都不许改
    const page = await open(browser, false)
    await page.evaluate(() => {
      const st = window.__pageStore.getState()
      const bad = 'dashboard3:\n  "1": [0, 6]'   // 元组只有两项 = 读不懂
      window.__pageStore.setState({
        manifest: { ...st.manifest, fmExtra: bad, root: { type: 'stack', children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [] }] }] } },
        blocks: {},
      })
    })
    await page.waitForTimeout(300)
    const beforeBad = await fm(page)
    const tpl = page.locator('.dash3-template')
    if (await tpl.count()) { await tpl.first().click(); await page.waitForTimeout(500) }
    check('G13 布局读不懂时点模板 → frontmatter 一个字节没动(不许拿默认值覆盖用户布局)',
      (await fm(page)) === beforeBad, JSON.stringify(await fm(page)))
    check('G13 且没有偷偷插进块去(停手要停干净)', (await page.locator('.dash3-card').count()) === 0)
    await page.close()
  }

  {
    // G14:在途 resize 期间**整页回灌**(loadNonce 换新)→ 松手整笔作废
    const page = await open(browser, false)
    const before = await fm(page)
    const c = await cardRect(page, '3')
    const grip = { x: c.left + c.width - 6, y: c.top + c.height - 6 }
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, grip.y + 170, { steps: 8 })
    await page.waitForTimeout(80)
    // 模拟外部回灌:路径与块 id 全不变,只有整页装载身份换了 —— 光比 activePage 是挡不住的
    await page.evaluate(() => window.__pageStore.setState({ loadNonce: {} }))
    await page.mouse.up()
    await page.waitForTimeout(350)
    check('G14 在途 resize 撞上整页回灌 → 旧几何**不写进**新文档(loadNonce 身份令牌)',
      (await fm(page)) === before, `${JSON.stringify(cellOf(before, '3'))} → ${JSON.stringify(cellOf(await fm(page), '3'))}`)

    // 反面:不回灌的同样一笔,必须真的写进去(否则上一格只是「resize 根本没工作」的假绿)
    const page2 = await open(browser, false)
    const b2 = await fm(page2)
    const c2 = await cardRect(page2, '3')
    const g2 = { x: c2.left + c2.width - 6, y: c2.top + c2.height - 6 }
    await drag(page2, g2, { x: g2.x, y: g2.y + 170 })
    check('G14 反面:同一笔 resize 不回灌时确实落盘了(证明上一格不是假绿)',
      JSON.stringify(cellOf(await fm(page2), '3')) !== JSON.stringify(cellOf(b2, '3')),
      `${JSON.stringify(cellOf(b2, '3'))} → ${JSON.stringify(cellOf(await fm(page2), '3'))}`)
    await page2.close()
    await page.close()
  }

  {
    // G15:Esc 取消拖拽 → 别把卡片永久留在「拖拽中」的观感里
    const page = await open(browser, false)
    await page.locator('.dash3-card[data-key="6"]').scrollIntoViewIfNeeded()
    const from = await page.locator('.dash3-card[data-key="6"] .dash3-shield').boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 100, from.y + 60, { steps: 8 })
    await page.waitForTimeout(120)
    check('G15 前置:确实进入了拖拽态', (await page.locator('.dash3-card[data-dragging]').count()) > 0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForTimeout(250)
    check('G15 Esc 取消后拖拽态清干净(没有卡片永久半透明/浮起)',
      (await page.locator('.dash3-card[data-dragging]').count()) === 0)
    await page.close()
  }

  // ── G19 拖拽观感契约:实时让位 + 跟手壳 + 无残影 + 不叠压(结构修复的可证伪判据)────
  //     动机:53/53 全绿的那一版,拖动中卡片飞到无意义位置、松手后闪残影 —— 仪器全测不到。
  {
    const page = await open(browser, false)
    await page.locator('.dash3-card[data-key="6"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    const snap = () => page.evaluate(() => {
      const cards = [...document.querySelectorAll('.dash3-card:not(.dash3-card--lift)')]
      return cards.map((el) => {
        const r = el.getBoundingClientRect()
        return { key: el.dataset.key, left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })
    })
    const before = await snap()
    const from = await page.locator('.dash3-card[data-key="6"] .dash3-shield').boundingBox()
    const to = await page.locator('.dash3-card[data-key="7"]').boundingBox()
    const fy = from.y + from.height / 2
    await page.mouse.move(from.x + from.width / 2, fy)
    await page.mouse.down()
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(
        from.x + from.width / 2 + ((to.x + to.width / 2 - from.x - from.width / 2) * i) / 14,
        fy + ((to.y + to.height / 2 - fy) * i) / 14,
      )
      await page.waitForTimeout(20)
    }
    await page.waitForTimeout(380) // 等让位 FLIP 收口再量
    const mid = await snap()
    check('G19 拖动中恰有一张落点占位卡(原卡降透明度,不消失)',
      (await page.locator('.dash3-card[data-dragging]').count()) === 1)
    check('G19 拖动中有跟手壳(DragOverlay),且只画壳不挂活视图',
      (await page.locator('.dash3-card--lift').count()) === 1
        && (await page.locator('.dash3-card--lift .dash-viewcard').count()) === 0)
    const moved = mid.filter((c) => c.key !== '6').filter((c) => {
      const b = before.find((x) => x.key === c.key)
      return b && (Math.abs(b.left - c.left) > 4 || Math.abs(b.top - c.top) > 4)
    })
    check('G19 拖动中其它卡**实时让位**(至少一张非拖拽卡真的挪了位置)',
      moved.length >= 1, `moved=${moved.map((c) => c.key).join(',') || '无'}`)
    const overlapped = []
    for (let i = 0; i < mid.length; i++) for (let j = i + 1; j < mid.length; j++) {
      const a = mid[i], b = mid[j]
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (ox > 6 && oy > 6) overlapped.push(`${a.key}×${b.key}`)
    }
    check('G19 拖动中让位是**有序重排**,卡片互不叠压(不是满屏乱飞)',
      overlapped.length === 0, overlapped.join(' ') || 'clean')
    await page.mouse.up()
    await page.waitForTimeout(650)
    const settledA = await snap()
    await page.waitForTimeout(250)
    const settledB = await snap()
    check('G19 松手后无残影:卡片数恒等于块数(退场动画不留孤儿)',
      settledA.length === 7 && (await page.locator('.dash3-card--lift').count()) === 0, `cards=${settledA.length}`)
    check('G19 松手后布局收口稳定(没有永不停歇的动画)',
      JSON.stringify(settledA) === JSON.stringify(settledB))
    const textAfter = await fm(page)
    check('G19 预览序 = 落盘序(拖到哪就落在哪,零跳变)',
      cellOf(textAfter, '6').order === 6 && cellOf(textAfter, '7').order === 5,
      `6→order ${cellOf(textAfter, '6').order}, 7→order ${cellOf(textAfter, '7').order}`)
    await shot(page, 'drag-settled')
    await page.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  console.log('SKIP  触屏拖拽 / 真机 Electron:前者待接 canvastouch 同款口径,后者只有人工点得了')
  console.log('SKIP  「落盘→重读」的完整往返:台架没有磁盘后端(window.amadeus 不在),只能验到 store 里的 frontmatter 文本')
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
