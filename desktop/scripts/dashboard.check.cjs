// 画布版 Dashboard 的**真浏览器**契约检查(harness ?dashboard 模式)。
//
// 分工:纯逻辑(px 几何 / frontmatter 编解码 / 迁移 / 自愈)在 shared/amadeus/dashboard*.test.ts,
// 手势与几何内核在 amadeus/unified/canvasKit/geometry.test.ts。这支仪器只钉单测**看不见**的那层:
//   D1 `dashboard2:` 的 [x,y,w,h] 在成品页按固定画板比例映射到整个 View
//   D2 时钟卡是活的(秒真的在走)
//   D3 锁定 = 浏览:块不可编辑、无把手、无块菜单;解锁后全部反过来
//   D4 拖动 → 卡挪位**且落进 frontmatter**(布局真持久化,不只是画面动了)
//   D5 八向把手:拉右下改 w/h,拉左上钉住右下角(单向把手时代这条测不出来)
//   D6 点阵吸附:开着落到 24 的倍数;从 chrome 关掉后自由落点
//   D7 view 卡片:注册视图活在卡里 + 视图的 setParams 写回卡片源码
//   D8 框选多选 → 一起拖(刚体:两张卡位移完全相同)
//   D9 松手排斥:拖到压住别人 → **被推开**(画布同款;不是旧网格版的「回弹」)
//   D10 双击进交互态 → 卡内可编辑;退出后恢复
//   D11 嵌卡白名单在**渲染入口**复查(卡片源码里手写非 embeddable 的 type → 只出提示)
//   D12 chrome 三件套(缩放胶囊 / 吸附开关 / 缩略图)在场且缩略图跟着卡片走
//   D24 编辑态卡片的背景 / 描边 / 圆角 / 高程与生产 Canvas 同款
//   D25 嵌卡的视图顶栏(笔记条 + 画板工具盘)平时隐去、指针进卡才淡入;笔记条还悬浮化(负边距抵平)不占正文
//
// ⚠️ 2026-08-25:本文件整支重写。此前那版钉的是**旧网格版**(量 24 列 CSS Grid、断言「压住别人
//    就回弹」),P3a 换成画布后它等 `.dash-grid .dash-card` 超时 —— 整整一轮没人发现仪器已经死了。
//    改这里之前先想清楚:断言写的是画布语义,还是又在写网格语义。
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

/** 落盘真相:store 里的 frontmatter 文本(拖完必须变的就是它)。 */
const fm = (page) => page.evaluate(() => window.__pageStore.getState().manifest.fmExtra || '')

/** 从 fmExtra 里读某个块的矩形。**仪器自己解一遍**,不复用被测代码。 */
function rectOf(text, id) {
  const body = text.split(/^dashboard2:\s*$/m)[1]
  if (!body) return null
  const m = new RegExp(`^\\s*"?${id}"?:\\s*\\[(.+)\\]\\s*$`, 'm').exec(body)
  if (!m) return null
  const n = m[1].split(',').map((v) => Number(v.trim()))
  return { x: n[0], y: n[1], w: n[2], h: n[3] }
}

/** 卡片在**视口**里的矩形(按块 id 找,不按文档序 —— 序号会随重排静默测错卡)。 */
const cardRect = (page, id) =>
  page.evaluate((k) => {
    const el = document.querySelector(`.dash2-card[data-key="${k}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }, id)

/** 舞台宿主的视口矩形 + 当前变换(舞台坐标 ↔ 屏幕坐标的换算靠它)。 */
const stageInfo = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('.dash2-host')
    const stage = document.querySelector('.dash2-stage')
    const r = host.getBoundingClientRect()
    const m = new DOMMatrixReadOnly(getComputedStyle(stage).transform)
    return { left: r.left, top: r.top, w: r.width, h: r.height, tx: m.e, ty: m.f, z: m.a }
  })

/** 舞台坐标 → 屏幕坐标。 */
const toScreen = (s, x, y) => ({ x: s.left + s.tx + x * s.z, y: s.top + s.ty + y * s.z })

/** 按住 from 拖到 to(慢速多步:pointermove 少了浏览器会合并成一步,拖不动)。 */
async function drag(page, from, to, opts = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
    await page.waitForTimeout(16)
  }
  if (opts.holdThen) await opts.holdThen()
  await page.mouse.up()
  if (opts.afterUp) await opts.afterUp()
  await page.waitForTimeout(280)
}

/** 选中一张卡(单击卡片中心;八向把手只在选中态渲染)。 */
async function selectCard(page, id) {
  const r = await cardRect(page, id)
  await page.mouse.click(r.left + r.width / 2, r.top + 12)
  await page.waitForTimeout(150)
}

/** 某条边的把手中心(选中态才有)。 */
const gripAt = (page, id, edge) =>
  page.evaluate(([k, e]) => {
    const el = document.querySelector(`.dash2-card[data-key="${k}"] [data-edge="${e}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, [id, edge])

/** 对块宿主派发一次真 contextmenu 并回报是否弹出**块**菜单。
 *  ⚠️ 不用 mouse.click({button:'right'}):卡片中心被 ProseMirror 铺满,真右键在那儿会被舞台的
 *  contextmenu 先接走(画布菜单),测不出 readOnly 到底管没管住结构操作。派到 .block-host 才精确。 */
async function blockMenuOpens(page) {
  await page.evaluate(() => {
    const h = document.querySelector('.dash2-card .block-host')
    h && h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
  })
  await page.waitForTimeout(300)
  const n = await page.locator('.ctx-menu').count()
  // ⚠️ 舞台也听 contextmenu(右键卡片 = 画布菜单),它会连带铺一层 `.dash-menu-scrim` 罩住全屏。
  //    只关 `.ctx-menu` 的话罩层留在那儿,**后面每一次拖拽都点在罩层上**(2026-08-25 实测:
  //    D4 整格因此假红,而 D5 因为顺手点掉了罩层又变绿 —— 典型的「上一格污染下一格」)。
  await page.keyboard.press('Escape')
  const scrim = page.locator('.dash-menu-scrim')
  if (await scrim.count()) await scrim.first().click({ force: true })
  await page.waitForTimeout(180)
  return n > 0
}

/** `--shot[=目录]` 顺手把三张真实截图落盘 —— DESIGN.md §8:观感类改动交付前必须自查一张真图。
 *  P3a 就是漏了这一步(几何断言全绿,而画面上「跟画布完全不像」),所以把它焊进仪器里。 */
const SHOT_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith('--shot'))
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'dashboard-shots')) : null
})()
async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  console.log(`SHOT  ${path.join(SHOT_DIR, `${name}.png`)}`)
}

/** CDP 真触点(与 canvas-touch.check.cjs 同一套口径:`hasTouch` 是地基,没有它触摸事件不落地)。 */
const tp = (x, y, id) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 8, radiusY: 8, force: 1 })
const sendTouch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })

async function openTouch(browser, locked) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true })
  page.on('pageerror', (e) => check(`页面无未捕获异常(${e.message.slice(0, 80)})`, false))
  await page.goto(`${BASE}?dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dash2-host .dash2-card', { timeout: 20000 })
  await page.waitForTimeout(500)
  if (!locked) {
    await page.locator('.amx-toolbar button[title^="解锁编辑"]').click()
    await page.waitForTimeout(350)
  }
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}

async function open(browser, locked) {
  const page = await browser.newPage()
  // ⚠️ 光 console.log 就是假绿:页面抛异常照样 0 退出。收进 results,收尾一起判。
  page.on('pageerror', (e) => check(`页面无未捕获异常(${e.message.slice(0, 80)})`, false))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${BASE}?dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dash2-host .dash2-card', { timeout: 20000 })
  await page.waitForTimeout(500)
  if (!locked) {
    await page.locator('.amx-toolbar button[title^="解锁编辑"]').click()
    await page.waitForTimeout(350)
  }
  return page
}

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── 锁定态:D1 / D2 / D3 正面 / D11 / D12 ──────────────────────────────────
  {
    const page = await open(browser, true)
    const n = await page.locator('.dash2-card').count()
    check('D1 四张卡片都渲染出来了', n === 4, `cards=${n}`)
    check('D1 没出「转换为画布版」横幅(harness 种的就是新键;出了 = 又把旧网格键种回去了)',
      !(await page.getByText('转换为画布版').count()))

    const s = await stageInfo(page)
    const want = { 1: [0, 0, 300, 180], 2: [360, 0, 260, 150], 3: [0, 240, 300, 180], 4: [700, 320, 300, 200] }
    for (const [id, [x, y, w, h]] of Object.entries(want)) {
      const r = await cardRect(page, id)
      const p = { x: s.left + (x / 1152) * s.w, y: s.top + (y / 648) * s.h }
      const near = (a, b, tol = 2) => Math.abs(a - b) <= tol
      check(`D1 卡片${id} 按 (${x},${y},${w},${h}) 比例铺进 View`,
        !!r && near(r.left, p.x) && near(r.top, p.y) && near(r.width, (w / 1152) * s.w) && near(r.height, (h / 648) * s.h),
        JSON.stringify({ got: r && { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, want: { l: Math.round(p.x), t: Math.round(p.y), w, h } }))
    }
    check('D1 宿主永不出滚动条(舞台自己管平移)', await page.evaluate(() => {
      const el = document.querySelector('.dash2-host')
      return el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1
    }))

    const t1 = await page.evaluate(() => document.querySelector('.dash-clock-time')?.textContent || '')
    check('D2 时钟渲染成了时间', /^\d{2}:\d{2}:\d{2}$/.test(t1.trim()), JSON.stringify(t1))
    await page.waitForTimeout(1600)
    const t2 = await page.evaluate(() => document.querySelector('.dash-clock-time')?.textContent || '')
    check('D2 秒在走', t1 !== t2, `${t1} → ${t2}`)
    check('D2 时钟卡片里没有代码块源码', !(await page.evaluate(() =>
      (document.querySelector('.dash2-card[data-key="2"]')?.innerText || '').includes('```'))))

    await shot(page, 'locked')
    check('D3 锁定态无调整把手', (await page.locator('.amx-card-size-grip').count()) === 0)
    check('D3 锁定态无删除钮', (await page.locator('.dash2-del').count()) === 0)
    const editable = await page.evaluate(() => document.querySelector('.dash2-card .ProseMirror')?.getAttribute('contenteditable') ?? 'none')
    check('D3 锁定态块不可编辑', editable === 'false', `contenteditable=${editable}`)
    // ⚠️ 只查 contenteditable 是**假绿**:块菜单里有 删除/复制块/移到新列,全是结构写操作。
    check('D3 锁定态不出块菜单(删除/复制/分栏)', !(await blockMenuOpens(page)))

    // ── D16 锁定 = 成品页(不是画布)。用户 2026-08-25:「锁定之后就变成一个 view 的展示页面」──
    check('D16 成品页没有画布 chrome(缩放胶囊/吸附/缩略图全收起)',
      (await page.locator('.amx-stage-hud').count()) === 0 && (await page.locator('.amx-stage-minimap').count()) === 0)
    {
      // 自动适配:拼好的版整个铺进面板 —— 每张卡都落在宿主的可视矩形之内。
      const host = await page.evaluate(() => { const r = document.querySelector('.dash2-host').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })
      const all = await page.locator('.dash2-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }))
      const inside = all.every((c) => c.l >= host.l - 1 && c.t >= host.t - 1 && c.r <= host.r + 1 && c.b <= host.b + 1)
      check('D16 自动适配:四张卡全部铺进了面板(不用平移就看得全)', inside, JSON.stringify({ host, all }))
    }
    {
      const measure = () => page.evaluate(() => {
        const host = document.querySelector('.dash2-host').getBoundingClientRect()
        const stage = document.querySelector('.dash2-stage').getBoundingClientRect()
        const card = document.querySelector('.dash2-card[data-key="4"]').getBoundingClientRect()
        return {
          host: { w: host.width, h: host.height },
          fills: Math.abs(stage.left - host.left) <= 1 && Math.abs(stage.top - host.top) <= 1
            && Math.abs(stage.width - host.width) <= 1 && Math.abs(stage.height - host.height) <= 1,
          ratio: {
            x: (card.left - host.left) / host.width,
            y: (card.top - host.top) / host.height,
            w: card.width / host.width,
            h: card.height / host.height,
          },
        }
      })
      const large = await measure()
      await page.setViewportSize({ width: 960, height: 720 })
      await page.waitForTimeout(350)
      const small = await measure()
      const wantRatio = { x: 700 / 1152, y: 320 / 648, w: 300 / 1152, h: 200 / 648 }
      const follows = (got) => Object.keys(wantRatio).every((k) => Math.abs(got[k] - wantRatio[k]) < 0.002)
      check('D16 复合 View 在不同宽高下都真正铺满宿主', large.fills && small.fills && large.host.w !== small.host.w && large.host.h !== small.host.h,
        JSON.stringify({ large: large.host, small: small.host }))
      check('D16 响应式按横纵比例重排(不是整张画布等比缩放)', follows(large.ratio) && follows(small.ratio),
        JSON.stringify({ large: large.ratio, small: small.ratio }))
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.waitForTimeout(350)
    }
    {
      // 成品页不接管手势:滚轮不缩放、空白拖不平移。
      const before = await stageInfo(page)
      await page.mouse.move(640, 500)
      await page.mouse.wheel(0, -300)
      await page.waitForTimeout(200)
      const s1 = await stageInfo(page)
      check('D16 滚轮不缩放(成品页不是画布)', Math.abs(s1.z - before.z) < 1e-6, JSON.stringify({ z0: before.z, z1: s1.z }))
      await drag(page, { x: 900, y: 700 }, { x: 700, y: 560 })
      const s2 = await stageInfo(page)
      check('D16 空白拖不平移', Math.abs(s2.tx - before.tx) < 1 && Math.abs(s2.ty - before.ty) < 1,
        JSON.stringify({ tx0: before.tx, tx1: s2.tx, ty0: before.ty, ty1: s2.ty }))
    }
    {
      // 整体化由铺满宿主的复合 View 承担,不再在宿主里套一张有外边距的缩放纸面。
      const skin = await page.evaluate(() => {
        const card = getComputedStyle(document.querySelector('.dash2-card'))
        const host = getComputedStyle(document.querySelector('.dash2-host'))
        return {
          card: { bg: card.backgroundColor, l: card.borderLeftColor, r: card.borderRightColor, radius: card.borderTopLeftRadius },
          host: { bg: host.backgroundColor },
          boards: document.querySelectorAll('.dash2-board').length,
        }
      })
      check('D16 成品页背景属于铺满 View 的宿主,没有内嵌纸面与外边距', skin.host.bg !== 'rgba(0, 0, 0, 0)' && skin.boards === 0, JSON.stringify(skin))
      check('D16 卡片 chrome 全退场(透明底 + 透明边 + 方形内容区域)',
        skin.card.bg === 'rgba(0, 0, 0, 0)' && skin.card.l === 'rgba(0, 0, 0, 0)'
        && skin.card.r === 'rgba(0, 0, 0, 0)' && skin.card.radius === '0px', JSON.stringify(skin.card))
    }
    {
      // 已有越界数据也要收回固定画板,不能靠扩画板或滚动把错误藏起来。
      await page.evaluate(() => {
        const st = window.__pageStore.getState()
        st.setFmExtra(st.manifest.fmExtra.replace('"4": [700, 320, 300, 200]', '"4": [2000, 1200, 300, 200]'))
      })
      await page.waitForTimeout(500)
      const got = rectOf(await fm(page), 4)
      const overflow = await page.evaluate(() => {
        const host = document.querySelector('.dash2-host')
        return { x: host.scrollWidth > host.clientWidth + 1, y: host.scrollHeight > host.clientHeight + 1 }
      })
      check('D16 旧越界几何自动收回固定画板', !!got && got.x === 852 && got.y === 448, JSON.stringify(got))
      check('D16 成品页始终铺满且不靠双向滚动兜底', !overflow.x && !overflow.y, JSON.stringify(overflow))
    }

    // D25 嵌卡的视图顶栏(.amx-toolbar):平时隐去,指针进卡才淡入,且不占正文的地方。纯 CSS 契约 ——
    //     组件里看不见,单测也量不到 computed opacity;而它一坏就是「成品页上每张卡都顶着一条工具栏」。
    {
      const bar = '.dash2-card[data-key="4"] .dash-viewcard .amx-toolbar'
      const opacity = () => page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).opacity, bar)
      const bodyTop = () => page.evaluate(() => document.querySelector('.dash2-card[data-key="4"] [data-act="bump"]').getBoundingClientRect().top)
      const idle = await opacity()
      check('D25 没悬停时嵌卡顶栏隐去', idle === '0', `opacity=${idle}`)
      check('D25 有过渡动画(不是硬切)', await page.evaluate((sel) =>
        parseFloat(getComputedStyle(document.querySelector(sel)).transitionDuration) > 0, bar))
      // 隐着的时候不许吃掉落在那条带上的点击。
      check('D25 隐着时不拦指针', await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).pointerEvents === 'none', bar))
      // 负边距抵掉自身高度 = 顶栏改为悬浮盖层,不再占正文的地方。**常数写错就在这里红**,不会静默错位。
      const geo = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        const card = document.querySelector('.dash2-card[data-key="4"] .dash-viewcard').getBoundingClientRect()
        return { h: el.getBoundingClientRect().height, mb: parseFloat(getComputedStyle(el).marginBottom), gap: el.getBoundingClientRect().top - card.top }
      }, bar)
      check('D25 顶栏高度被负边距抵平(空带还给正文)', Math.abs(geo.h + geo.mb) < 1, JSON.stringify(geo))
      check('D25 顶栏就贴在卡沿上(不是被别的东西推下去了)', Math.abs(geo.gap) < 1, JSON.stringify(geo))
      // 画板工具盘(excalidraw 里的浮岛,同名不同物)跟着藏,但**不吃**那条负边距 —— 给它负边距会把面板拽歪。
      const board = await page.evaluate(() => {
        const vc = document.querySelector('.dash2-card[data-key="4"] .dash-viewcard')
        const host = document.createElement('div')
        host.className = 'excalidraw'
        host.innerHTML = '<div class="amx-toolbar"></div>'
        vc.appendChild(host)
        const cs = getComputedStyle(host.firstChild)
        const out = { opacity: cs.opacity, mb: cs.marginBottom }
        host.remove()
        return out
      })
      check('D25 画板工具盘同样隐去', board.opacity === '0', JSON.stringify(board))
      check('D25 画板工具盘不吃负边距(浮岛自有定位)', board.mb === '0px', JSON.stringify(board))
      await shot(page, 'viewcard-bar-idle')
      const topIdle = await bodyTop()
      const r = await cardRect(page, '4')
      await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2)
      await page.waitForTimeout(400) // 0.18s 过渡 + 余量
      const hov = await opacity()
      check('D25 指针进卡后顶栏淡入', hov === '1', `opacity=${hov}`)
      check('D25 悬停是盖在正文上,不推动正文', Math.abs((await bodyTop()) - topIdle) < 1, `${topIdle} → ${await bodyTop()}`)
      // 悬浮化的**代价**,明写出来:顶栏现身时会盖住卡内最上面那一条(生产里是封面/标题带)。
      // 这不是 bug 是取舍 —— 想要那条不被盖,就得把空间还回去(改回占位式)。
      const covered = await page.evaluate(() => {
        const r = document.querySelector('.dash2-card[data-key="4"] .dash-viewcard').getBoundingClientRect()
        return document.elementFromPoint(r.left + r.width / 2, r.top + 8)?.closest('.amx-toolbar') !== null
      })
      check('D25 悬停时顶栏确实盖住卡内最上面那 32px(取舍,不是 bug)', covered)
      await shot(page, 'viewcard-bar-hover')
      // 反面:仪表盘**自己**那条顶栏(不在卡里)一律不受影响,否则「解锁编辑」按钮会跟着消失。
      check('D25 只作用于嵌卡,仪表盘自身顶栏照旧常显', await page.evaluate(() =>
        getComputedStyle(document.querySelector('.dash2 > .amx-toolbar')).opacity === '1'))
      await page.mouse.move(4, 4) // 复位,别把 hover 态留给后面的用例
      await page.waitForTimeout(250)
    }

    // D11 白名单必须在**渲染入口**复查:源码是 md 文本,同步/共享/手写都能塞进任意注册键。
    await page.evaluate(() => window.__pageStore.getState().setBlockContent('1', '```view\ntype: chat\n```'))
    await page.waitForTimeout(250)
    check('D11 手写进卡片源码的非 embeddable 视图被渲染入口拦下',
      (await page.locator('.dash2-card[data-key="1"] .dash-widget-note').count()) === 1,
      await page.evaluate(() => document.querySelector('.dash2-card[data-key="1"]')?.innerText?.slice(0, 40)))
    await page.close()
  }

  // ── 解锁态:D3 反面 / D4 / D5 / D6 / D7 / D10 ─────────────────────────────
  {
    const page = await open(browser, false)
    const surface = await page.evaluate(() => {
      const card = getComputedStyle(document.querySelector('.dash2-card'))
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;background:var(--bg);border:1px solid var(--border);border-radius:10px;box-shadow:var(--card-shadow)'
      document.body.appendChild(probe)
      const canvas = getComputedStyle(probe)
      const got = { bg: card.backgroundColor, border: card.borderTopColor, radius: card.borderTopLeftRadius, shadow: card.boxShadow }
      const want = { bg: canvas.backgroundColor, border: canvas.borderTopColor, radius: canvas.borderTopLeftRadius, shadow: canvas.boxShadow }
      probe.remove()
      return { got, want }
    })
    check('D24 编辑卡片的完整表面与 Canvas 同款(背景/描边/圆角/高程)',
      JSON.stringify(surface.got) === JSON.stringify(surface.want), JSON.stringify(surface))
    check('D3 解锁态出现删除钮', (await page.locator('.dash2-del').count()) === 4)
    check('D12 chrome:缩放胶囊在场且读数是百分比(**只在编辑态**)', /^\d+%$/.test((await page.evaluate(() =>
      document.querySelector('.amx-stage-hud span')?.textContent?.trim() || '')) ))
    check('D12 chrome:吸附开关与缩略图开关都在(与画布同一套 .amx-stage-hud)',
      (await page.locator('.amx-stage-hud .amx-snap-toggle').count()) === 1
      && (await page.locator('.amx-stage-hud [aria-pressed]').count()) >= 2)
    check('D12 缩略图渲染有限画板边界 + 四个卡片矩形',
      (await page.locator('.amx-stage-minimap .amx-mini-item.is-frame').count()) === 1
      && (await page.locator('.amx-stage-minimap .amx-mini-item.is-card').count()) === 4)
    // ⚠️ 画布语义:解锁 ≠ 可编辑。单击 = 选中/拖动,**双击(或选中后按空格)才进卡片**。
    //    「解锁就能直接打字」是旧网格版的口径,别把它写回断言里(D10 才是编辑那一格)。
    const editable2 = await page.evaluate(() => document.querySelector('.dash2-card .ProseMirror')?.getAttribute('contenteditable'))
    check('D3 解锁但没进卡片时,块仍是只读(手势归舞台)', editable2 === 'false', `contenteditable=${editable2}`)
    check('D3 没进卡片时不出块菜单', !(await blockMenuOpens(page)))

    // D4 卡片3 (0,240) 往右拖 120px(24 的倍数,吸附不改结果)
    {
      const s = await stageInfo(page)
      const r = await cardRect(page, '3')
      await drag(page, { x: r.left + r.width / 2, y: r.top + 12 }, { x: r.left + r.width / 2 + 120 * s.z, y: r.top + 12 })
      const got = rectOf(await fm(page), 3)
      check('D4 拖动落进 frontmatter(卡片3 → x=120)', !!got && got.x === 120 && got.y === 240, JSON.stringify(got))
      const after = await cardRect(page, '3')
      const p = toScreen(await stageInfo(page), 120, 240)
      check('D4 画面与落盘一致', Math.abs(after.left - p.x) <= 2, JSON.stringify({ left: Math.round(after.left), want: Math.round(p.x) }))
    }

    // D5 八向把手:卡片2 (360,0,260,150)
    {
      await selectCard(page, '2')
      check('D5 选中后出八向把手', (await page.locator('.dash2-card[data-key="2"] .amx-card-size-grip').count()) === 8)
      await shot(page, 'selected')
      const s = await stageInfo(page)
      const se = await gripAt(page, '2', 'se')
      await drag(page, se, { x: se.x + 48 * s.z, y: se.y + 24 * s.z })
      let got = rectOf(await fm(page), 2)
      // 与生产 Canvas 同款：过程自由跟手，松手时只量化正在移动的右/下边到 24px 点阵。
      check('D5 拉右下:松手后右/下边吸点阵且固定的左上不动',
        !!got && got.x === 360 && got.y === 0 && got.w === 312 && got.h === 168, JSON.stringify(got))

      await selectCard(page, '2')
      const nw = await gripAt(page, '2', 'nw')
      const right = got.x + got.w
      const bottom = got.y + got.h
      await drag(page, nw, { x: nw.x + 48 * s.z, y: nw.y + 24 * s.z })
      got = rectOf(await fm(page), 2)
      check('D5 拉左上:右下角钉住不动(单向把手时代测不出这条)',
        !!got && got.x + got.w === right && got.y + got.h === bottom && got.x === 408 && got.y === 24, JSON.stringify({ got, right, bottom }))
    }

    // D6 点阵吸附:默认开 → 落到 24 的倍数;从 chrome 关掉 → 自由落点
    {
      const s = await stageInfo(page)
      const r = await cardRect(page, '3')
      await drag(page, { x: r.left + r.width / 2, y: r.top + 12 }, { x: r.left + r.width / 2 + 50 * s.z, y: r.top + 12 })
      let got = rectOf(await fm(page), 3)
      check('D6 吸附开:120+50 落到 168(24 的倍数)', !!got && got.x === 168, JSON.stringify(got))

      await page.locator('.amx-stage-hud .amx-snap-toggle').click()
      await page.waitForTimeout(150)
      check('D6 吸附开关按下去了', (await page.locator('.amx-stage-hud .amx-snap-toggle').getAttribute('aria-pressed')) === 'false')
      const r2 = await cardRect(page, '3')
      await drag(page, { x: r2.left + r2.width / 2, y: r2.top + 12 }, { x: r2.left + r2.width / 2 + 50 * s.z, y: r2.top + 12 })
      got = rectOf(await fm(page), 3)
      check('D6 吸附关:自由落点(168+50=218,不再被吸到 216)', !!got && got.x === 218, JSON.stringify(got))
      await page.locator('.amx-stage-hud .amx-snap-toggle').click() // 恢复默认,别污染后面的用例
      await page.waitForTimeout(150)
    }

    // D7 view 卡片:跨了「合成 Leaf → 视图工厂 → 回写块内容」三层真运行时,单测测不到。
    {
      const probe = page.locator('.dash2-card [data-tag="dashv"]')
      check('D7 view 卡片渲染出注册视图', (await probe.count()) === 1)
      const p0 = await probe.getAttribute('data-params')
      check('D7 视图拿到卡片源码里的 params(不含 type)', p0 === '{"n":"1"}', p0)
      await page.locator('.dash2-card [data-act="bump"]').click()
      await page.waitForTimeout(250)
      const src = await page.evaluate(() => window.__pageStore.getState().blocks['4'].content)
      check('D7 setParams 写回卡片源码', src === '```view\ntype: dashv\nn: 2\n```', JSON.stringify(src))
      const p1 = await probe.getAttribute('data-params')
      check('D7 写回后视图看到的是新值', p1 === '{"n":"2"}', p1)
    }

    // D10 双击进交互态:卡内可编辑,且手势层让路(卡片不再跟着指针跑)
    {
      const r = await cardRect(page, '1')
      const before = rectOf(await fm(page), 1)
      await page.mouse.dblclick(r.left + r.width / 2, r.top + 30)
      await page.waitForTimeout(250)
      check('D10 双击进交互态', (await page.locator('.dash2-card[data-key="1"][data-interact]').count()) === 1)
      const ed = await page.evaluate(() => document.querySelector('.dash2-card[data-key="1"] .ProseMirror')?.getAttribute('contenteditable'))
      check('D10 交互态里块可编辑(反面:D3 那格证明没进卡片时是只读)', ed === 'true', `contenteditable=${ed}`)
      check('D10 交互态里块菜单在(别把结构操作一刀切死)', await blockMenuOpens(page))
      // 交互态里按住拖:事件归卡内容,几何一个字节都不许变。
      await drag(page, { x: r.left + r.width / 2, y: r.top + 30 }, { x: r.left + r.width / 2 + 96, y: r.top + 30 })
      const after = rectOf(await fm(page), 1)
      check('D10 交互态里拖 = 手势层让路,几何不动', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }))
    }
    await page.close()
  }

  // ── D21 固定画板硬边界:在途画面、落盘、键盘微移与八向缩放都不能越界 ──────────
  {
    const page = await open(browser, false)
    const insideBoard = (id) => page.evaluate((key) => {
      const board = document.querySelector('.dash2-board').getBoundingClientRect()
      const card = document.querySelector(`.dash2-card[data-key="${key}"]`).getBoundingClientRect()
      return card.left >= board.left - 1 && card.top >= board.top - 1
        && card.right <= board.right + 1 && card.bottom <= board.bottom + 1
    }, id)
    const host = await page.evaluate(() => {
      const r = document.querySelector('.dash2-host').getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    })

    const r1 = await cardRect(page, '1')
    let liveLeftTop = false
    await drag(page, { x: r1.left + r1.width / 2, y: r1.top + 12 }, { x: host.left + 2, y: host.top + 2 }, {
      holdThen: async () => { liveLeftTop = await insideBoard('1') },
    })
    let got = rectOf(await fm(page), 1)
    check('D21 往左上拉时在途画面已被画板截住(不等松手跳回)', liveLeftTop)
    check('D21 往左上拉的落盘坐标被限制为 (0,0)', !!got && got.x === 0 && got.y === 0, JSON.stringify(got))
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(200)
    got = rectOf(await fm(page), 1)
    check('D21 边界上的方向键微移也不能把卡推出去', !!got && got.x === 0 && got.y === 0, JSON.stringify(got))

    const r4 = await cardRect(page, '4')
    let liveRightBottom = false
    await drag(page, { x: r4.left + r4.width / 2, y: r4.top + 12 }, { x: host.right - 2, y: host.bottom - 2 }, {
      holdThen: async () => { liveRightBottom = await insideBoard('4') },
    })
    got = rectOf(await fm(page), 4)
    check('D21 往右下拉时在途画面仍完整留在画板内', liveRightBottom)
    check('D21 往右下拉的落盘坐标贴住右下边界', !!got && got.x === 852 && got.y === 448, JSON.stringify(got))

    await selectCard(page, '2')
    const se = await gripAt(page, '2', 'se')
    let liveResize = false
    await drag(page, se, { x: host.right - 2, y: host.bottom - 2 }, {
      holdThen: async () => { liveResize = await insideBoard('2') },
    })
    got = rectOf(await fm(page), 2)
    check('D21 缩放进行中也不能越过画板右下边界', liveResize)
    check('D21 右下缩放最大只到固定画板边缘', !!got && got.x === 360 && got.y === 0 && got.w === 792 && got.h === 648, JSON.stringify(got))
    await page.close()
  }

  // ── D22 固定画板的相机边界:所有视口入口都不能把画板拖出可浏览范围 ──────────
  {
    const page = await open(browser, false)
    const frame = () => page.evaluate(() => {
      const host = document.querySelector('.dash2-host').getBoundingClientRect()
      const board = document.querySelector('.dash2-board').getBoundingClientRect()
      return {
        host: { l: host.left, t: host.top, r: host.right, b: host.bottom, w: host.width, h: host.height },
        board: { l: board.left, t: board.top, r: board.right, b: board.bottom, w: board.width, h: board.height },
      }
    })
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

    const home = await frame()
    check('D22 100% 下画板小于 View 的轴自动居中',
      near(home.board.l - home.host.l, home.host.r - home.board.r)
      && near(home.board.t - home.host.t, home.host.b - home.board.b), JSON.stringify(home))

    const s0 = await stageInfo(page)
    const blank = toScreen(s0, 1100, 600)
    await page.keyboard.down('Alt')
    await drag(page, blank, { x: blank.x - 420, y: blank.y - 300 })
    await page.keyboard.up('Alt')
    const afterDrag = await stageInfo(page)
    check('D22 画板比 View 小时 Alt 拖动不能把相机带到画板外',
      near(afterDrag.tx, s0.tx) && near(afterDrag.ty, s0.ty), JSON.stringify({ before: s0, after: afterDrag }))

    await page.mouse.move(blank.x, blank.y)
    await page.mouse.wheel(500, 500)
    await page.waitForTimeout(250)
    const afterWheel = await stageInfo(page)
    check('D22 滚轮平移同样经过相机边界',
      near(afterWheel.tx, s0.tx) && near(afterWheel.ty, s0.ty), JSON.stringify({ before: s0, after: afterWheel }))

    await page.locator('.amx-stage-hud button[title="放大"]').click()
    await page.locator('.amx-stage-hud button[title="放大"]').click()
    await page.waitForTimeout(250)
    const host = (await frame()).host
    await page.keyboard.down('Alt')
    await drag(page, { x: (host.l + host.r) / 2, y: (host.t + host.b) / 2 }, { x: host.r - 10, y: host.b - 10 })
    await page.keyboard.up('Alt')
    const atStartEdges = await frame()
    check('D22 放大后向右下浏览最多只到画板左上边贴住 View',
      near(atStartEdges.board.l, atStartEdges.host.l) && near(atStartEdges.board.t, atStartEdges.host.t), JSON.stringify(atStartEdges))

    await page.keyboard.down('Alt')
    for (let i = 0; i < 3; i++) {
      const h = (await frame()).host
      await drag(page, { x: h.r - 10, y: h.b - 10 }, { x: h.l + 10, y: h.t + 10 })
    }
    await page.keyboard.up('Alt')
    const atEndEdges = await frame()
    check('D22 放大后向左上浏览最多只到画板右下边贴住 View',
      near(atEndEdges.board.r, atEndEdges.host.r) && near(atEndEdges.board.b, atEndEdges.host.b), JSON.stringify(atEndEdges))
    await page.close()
  }

  // ── D8 框选多选 + 刚体拖;D9 松手排斥 ─────────────────────────────────────
  {
    const page = await open(browser, false)
    const s = await stageInfo(page)
    // 空白起手(340,440):卡2 从 x=360 起、卡4 从 y=320,x=700 起 —— 都不在这一片。
    const a = toScreen(s, 340, 440)
    const b = toScreen(s, 4, 4)
    await drag(page, a, b, {
      holdThen: async () => check('D8 拖动过程中画得出框选矩形', (await page.locator('.amx-el-marquee').count()) === 1),
    })
    const sel = await page.locator('.dash2-card[data-selected]').evaluateAll((els) => els.map((e) => e.dataset.key).sort())
    check('D8 框选相交即中:选到卡片1 与 3,没误选 2/4', JSON.stringify(sel) === '["1","3"]', JSON.stringify(sel))

    const before = { 1: rectOf(await fm(page), 1), 3: rectOf(await fm(page), 3) }
    const r1 = await cardRect(page, '1')
    await drag(page, { x: r1.left + r1.width / 2, y: r1.top + 12 }, { x: r1.left + r1.width / 2 + 48 * s.z, y: r1.top + 12 + 24 * s.z })
    const after = { 1: rectOf(await fm(page), 1), 3: rectOf(await fm(page), 3) }
    const d1 = { x: after[1].x - before[1].x, y: after[1].y - before[1].y }
    const d3 = { x: after[3].x - before[3].x, y: after[3].y - before[3].y }
    check('D8 多选按刚体走:两张卡位移完全相同且真的动了',
      d1.x === d3.x && d1.y === d3.y && (d1.x !== 0 || d1.y !== 0), JSON.stringify({ d1, d3 }))

    await page.close()
  }

  // ── D9 与生产 Canvas 同款松手防穿透:18px 空气层 + repel settle ────────
  {
    const page = await open(browser, false)
    // 关掉点阵单独测 repel：防穿透与磁铁开关无关，这也是 Canvas 的语义。
    await page.locator('.amx-stage-hud .amx-snap-toggle').click()
    await page.waitForTimeout(150)
    const s = await stageInfo(page)
    const r3 = await cardRect(page, '3')
    let motion = false
    // 卡片3 (0,240) 上移 60 → 松手 y=180，但 Canvas 会将它推到卡片1 下方 y=198。
    await drag(page, { x: r3.left + r3.width / 2, y: r3.top + 12 }, { x: r3.left + r3.width / 2, y: r3.top + 12 - 60 * s.z }, {
      afterUp: async () => {
        await page.waitForTimeout(40)
        motion = await page.evaluate(() => document.querySelector('.dash2-card[data-key="3"]')?.getAnimations().some((a) => a.id === 'amx-card-repel') ?? false)
      },
    })
    const got = rectOf(await fm(page), 3)
    check('D9 压住邻居时被 Canvas 的 18px 空气层推开',
      !!got && got.x === 0 && got.y === 198, JSON.stringify(got))
    const g1 = await cardRect(page, '1')
    const g3 = await cardRect(page, '3')
    check('D9 画面上实际保留 18px 间距',
      Math.abs(g3.top - g1.bottom - 18 * s.z) <= 1 && !overlaps(g1, g3), JSON.stringify({ top: Math.round(g3.top), bottom: Math.round(g1.bottom) }))
    check('D9 松手后播放 Canvas 同款 repel settle', motion)
    // 有限画板的反面：向上推会越界，必须选画板内的候选，不能推出去再 clamp 回重叠。
    const r3b = await cardRect(page, '3')
    await drag(page, { x: r3b.left + r3b.width / 2, y: r3b.top + 12 }, { x: r3b.left + r3b.width / 2, y: r3b.top + 12 - 198 * s.z })
    const got2 = rectOf(await fm(page), 3)
    check('D9 靠着画板上边仍不穿透，repel 改选界内落点', !!got2 && got2.x === 0 && got2.y === 198, JSON.stringify(got2))
    await page.close()
  }

  // ── D18 「双击才进卡片」在**成品页**同样成立(用户 2026-08-25:「Canvas 里面是双击进入卡片
  //     编辑,这个怎么直接就点进去了」)。修前锁定态整条手势层不挂 = 单击直接穿透进卡内容。
  {
    const page = await open(browser, true)
    const hit = page.locator('[data-act="hit"]')
    const bump = page.locator('[data-act="bump"]')
    const box = await hit.boundingBox()
    check('D18 前置:探针的裸 div 可点面在场', !!box)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    check('D18 成品页单击卡片正文:**不穿透**(卡内没收到 click)', (await hit.getAttribute('data-hits')) === '0', await hit.getAttribute('data-hits'))
    check('D18 单击也不进交互态', (await page.locator('.dash2-card[data-interact]').count()) === 0)
    // 反面 1:卡里的**按钮**照常可点(CARD_CTL 放行,与画布 08-20「点图片的 `</>` 没反应」同一条规则)。
    const n0 = await bump.textContent()
    await bump.click()
    await page.waitForTimeout(250)
    check('D18 卡里的按钮不受影响(CARD_CTL 照常放行)', (await bump.textContent()) !== n0, `${n0} → ${await bump.textContent()}`)
    // 反面 2:双击才进;进去之后裸 div 也点得动了。
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(300)
    check('D18 双击进交互态', (await page.locator('.dash2-card[data-interact]').count()) === 1)
    const b2 = await hit.boundingBox()
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2)
    await page.waitForTimeout(250)
    check('D18 进去之后单击才落到卡内容上', (await hit.getAttribute('data-hits')) === '1', await hit.getAttribute('data-hits'))
    // 点卡外空白 = 退出交互态(成品页的空白不平移、不框选,只负责退出)。
    await page.mouse.click(20, 700)
    await page.waitForTimeout(250)
    check('D18 点空白退出交互态', (await page.locator('.dash2-card[data-interact]').count()) === 0)
    await page.close()
  }

  // ── D19 两态切换的边界(Codex 2026-08-25 评审)────────────────────────────────
  {
    const page = await open(browser, false)
    const r = await cardRect(page, '1')
    await page.mouse.dblclick(r.left + r.width / 2, r.top + 30)
    await page.waitForTimeout(300)
    check('D19 前置:排版台里双击进了交互态', (await page.locator('.dash2-card[data-interact]').count()) === 1)
    // 带着交互态直接按锁定 —— 修前 interactId 会被原样带进成品页,那张卡继续以编辑态让路。
    await page.locator('.amx-toolbar button[title^="锁定"]').click()
    await page.waitForTimeout(300)
    check('D19 锁定即退出交互态', (await page.locator('.dash2-card[data-interact]').count()) === 0)
    check('D19 锁定即清选中描边', (await page.locator('.dash2-card[data-selected]').count()) === 0)
    const hit = page.locator('[data-act="hit"]')
    const before = await hit.getAttribute('data-hits')
    const b = await hit.boundingBox()
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    await page.waitForTimeout(250)
    check('D19 锁定后单击立刻恢复「不穿透」(不是等到下一次交互)',
      (await hit.getAttribute('data-hits')) === before, `${before} → ${await hit.getAttribute('data-hits')}`)
    await page.close()
  }

  // ── D20 成品页的触屏:双指不许改视口(Codex:锁定判定曾晚于双指分支)────────────
  {
    const { page, cdp } = await openTouch(browser, true)
    const s0 = await stageInfo(page)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1)])
    await page.waitForTimeout(30)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1), tp(700, 400, 2)])
    await page.waitForTimeout(40)
    await sendTouch(cdp, 'touchMove', [tp(420, 400, 1), tp(820, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchMove', [tp(360, 400, 1), tp(900, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchEnd', [])
    await page.waitForTimeout(250)
    const s1 = await stageInfo(page)
    check('D20 成品页双指捏合不改视口(缩放与平移都纹丝不动)',
      Math.abs(s1.z - s0.z) < 1e-6 && Math.abs(s1.tx - s0.tx) < 1 && Math.abs(s1.ty - s0.ty) < 1,
      JSON.stringify({ z: [s0.z, s1.z], tx: [Math.round(s0.tx), Math.round(s1.tx)] }))
    await page.close()
  }
  // 反面:排版台里双指照样能缩放(否则上一格可能只是「触屏事件根本没进来」的假绿)。
  {
    const { page, cdp } = await openTouch(browser, false)
    const s0 = await stageInfo(page)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1)])
    await page.waitForTimeout(30)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1), tp(700, 400, 2)])
    await page.waitForTimeout(40)
    await sendTouch(cdp, 'touchMove', [tp(420, 400, 1), tp(820, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchMove', [tp(360, 400, 1), tp(900, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchEnd', [])
    await page.waitForTimeout(250)
    const s1 = await stageInfo(page)
    check('D20 反面:排版台里双指**能**缩放(证明触屏事件真的进来了,上一格不是假绿)',
      Math.abs(s1.z - s0.z) > 0.05, JSON.stringify({ z: [s0.z, s1.z] }))
    await page.close()
  }

  // ── D23 与生产 Canvas 同一套吸附时序:过程自由跟手，松手才吸点阵并 settle ──────────
  {
    const page = await open(browser, false)
    const s = await stageInfo(page)
    const r3 = await cardRect(page, '3')
    let mid = null
    let motion = false
    await drag(page,
      { x: r3.left + r3.width / 2, y: r3.top + 12 },
      { x: r3.left + r3.width / 2 + 13 * s.z, y: r3.top + 12 + 13 * s.z }, {
        holdThen: async () => {
          const r = await cardRect(page, '3')
          mid = { x: Math.round((r.left - s.left - s.tx) / s.z), y: Math.round((r.top - s.top - s.ty) / s.z) }
        },
        afterUp: async () => {
          await page.waitForTimeout(40)
          motion = await page.evaluate(() => document.querySelector('.dash2-card[data-key="3"]')?.getAnimations().some((a) => a.id === 'amx-card-snap') ?? false)
        },
      })
    const after = rectOf(await fm(page), 3)
    check('D23 与 Canvas 一致:拖动过程逐像素跟手,不提前黏在网格上', mid?.x === 13 && mid?.y === 253, JSON.stringify(mid))
    check('D23 与 Canvas 一致:松手后才落到 24px 点阵', !!after && after.x === 24 && after.y === 264, JSON.stringify(after))
    check('D23 与 Canvas 一致:从松手位置播放吸附 settle 动画', motion)
    await page.close()
  }

  // ── D15 点阵背景:编辑态才铺,且跟着缩放走(用户 2026-08-25 实报「连背景点点都没有」)──
  {
    const page = await open(browser, true)
    check('D15 锁定态不铺点阵(browse 就该是干净的板子)', (await page.locator('.amx-stage-grid').count()) === 0)
    await page.locator('.amx-toolbar button[title^="解锁编辑"]').click()
    await page.waitForTimeout(300)
    check('D15 解锁即铺点阵', (await page.locator('.amx-stage-grid').count()) === 1)
    const grid1 = await page.evaluate(() => {
      const step = Number.parseFloat(getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundSize)
      const z = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.dash2-stage')).transform).a
      return { css: step, screen: step * z }
    })
    const dot = await page.evaluate(() => getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundImage)
    check('D15 点阵是 radial-gradient 的点,不是别的花样(与画布同一份 CSS)', dot.includes('radial-gradient'), dot.slice(0, 60))
    check('D15 有限画板里的格距 = 24px × 当前缩放', grid1.css === 24 && grid1.screen === 24, JSON.stringify(grid1))
    check('D15 点阵被裁在有限画板里(不是铺满整个宿主)', await page.evaluate(() => {
      const g = document.querySelector('.amx-stage-grid')
      return g?.parentElement?.classList.contains('dash2-board') && getComputedStyle(g.parentElement).overflow === 'hidden'
    }))
    await page.locator('.amx-stage-hud button[title="放大"]').click()
    await page.waitForTimeout(250)
    const grid2 = await page.evaluate(() => {
      const step = Number.parseFloat(getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundSize)
      const z = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.dash2-stage')).transform).a
      return { css: step, screen: step * z }
    })
    check('D15 放大后点阵随画板一起缩放(点阵是画布内容,不是壁纸)', grid2.css === 24 && grid2.screen > grid1.screen, `${JSON.stringify(grid1)} → ${JSON.stringify(grid2)}`)
    await page.close()
  }

  // ── D13 嵌卡能力面(方案 §6.4 S1):需要身份的视图先经快速查找选文件,再落卡 ──────
  {
    const page = await open(browser, false)
    await page.locator('.amx-toolbar button[title="添加卡片"]').click()
    await page.waitForTimeout(250)
    await shot(page, 'addmenu')
    const labels = await page.locator('.dash-add-menu button').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    check('D13 加卡菜单按 embeddable 白名单列视图(全局面直接落,身份面带「…」)',
      labels.includes('Dash Probe') && labels.includes('File Probe…'), JSON.stringify(labels))
    check('D13 非 embeddable 的视图不进菜单', !labels.some((l) => l.includes('Chat')), JSON.stringify(labels))

    await page.locator('.dash-add-menu button', { hasText: 'File Probe' }).click()
    await page.waitForTimeout(300)
    check('D13 身份面先开选取面板(复用快速查找,不另造 picker)', (await page.locator('.amx-qf').count()) === 1)
    await shot(page, 'picker')
    const rows = await page.locator('.amx-qf-row .amx-qf-title').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    // 候选按 `fileMatchViewType(path) === type` 收窄 —— 只该出 .pdf,不该出笔记与图片。
    check('D13 候选按后缀声明收窄(只出 .pdf)', JSON.stringify(rows) === '["手册.pdf"]', JSON.stringify(rows))

    const before = await page.locator('.dash2-card').count()
    await page.locator('.amx-qf-row').first().click()
    await page.waitForTimeout(400)
    check('D13 选中后真落了一张卡', (await page.locator('.dash2-card').count()) === before + 1)
    const src = await page.evaluate(() => Object.values(window.__pageStore.getState().blocks).map((b) => b.content).find((c) => c.includes('File') || c.includes('probePath')))
    check('D13 卡片源码写的是该视图的 idParam(不是硬编码的键)',
      src === '```view\ntype: amadeus-pdf\nprobePath: 手册.pdf\n```', JSON.stringify(src))
    check('D13 卡里那个视图真的拿到了这个身份', (await page.locator('[data-tag="dashfile"]').getAttribute('data-src')) === '手册.pdf')
    await page.close()
  }

  // ── D14 嵌卡的 PageScope 隔离(方案 §6.4 S1 的那条不变式)────────────────────
  //     档 1 的视图会 `loadPage`。仪表盘用 PageScopeCtx.Provider 包着整棵树 —— 卡里不自建作用域
  //     就会把**仪表盘那份 store** 的 activePage 换掉:屏幕上是「加了一张笔记卡,整个仪表盘变成
  //     了那篇笔记」。类型系统一个字都拦不住,只有真运行时测得出来。
  //     ⚠️ 测的是**生产的** `OutlineView` / `ScopedPageOutline`,不是台架自实现的替身 —— 自实现
  //     的探针只能证明「探针写对了」,真正会切走仪表盘 store 的风险在生产组件身上(Codex 评审)。
  {
    const page = await open(browser, false)
    await page.locator('.amx-toolbar button[title="添加卡片"]').click()
    await page.waitForTimeout(250)
    await page.locator('.dash-add-menu button', { hasText: 'Outline' }).click()
    await page.waitForTimeout(300)
    await page.locator('.amx-qf-row').first().click()
    await page.waitForTimeout(700)

    const head = page.locator('.dash2-card .amx-panel-head')
    check('D14 卡片渲染出的是真 OutlineView 的大纲面(走了 sourcePath 那一支)',
      (await head.count()) === 1 && (await head.first().textContent())?.trim() === '大纲',
      JSON.stringify({ n: await head.count(), text: (await head.first().textContent().catch(() => null)) }))
    check('D14 没落进「跟随活动主视图」的空态(那正是 2026-08-25 用户实报的「大纲卡永远空白」)',
      (await page.locator('.dash2-card .t2sw-empty').count()) === 0)

    // 正面:装载真的发生了,而且落在**卡自己那份 store** 上。台架的 window.amadeus 垫片没有
    // loadPage → 这一趟必然失败,那条 error 就是「这一趟归谁」的凭据。
    const blockId = await page.evaluate(() => {
      const e = Object.entries(window.__pageStore.getState().blocks).find(([, b]) => b.content.includes('type: outline'))
      return e ? e[0] : null
    })
    check('D14 卡片源码写的是 outline + sourcePath', !!blockId, String(blockId))
    const scoped = await page.evaluate((id) => {
      const st = window.__pageStoreFor(`main::${id}::src`).getState()
      return { active: st.activePage, err: !!st.error }
    }, blockId)
    check('D14 卡自己那份 store 去装载了它自己的那篇(隔离的正面;摘掉 Provider 时这里会变成仪表盘那篇)',
      scoped.err && scoped.active !== 'Harness.dashboard.md', JSON.stringify(scoped))

    const dash = await page.evaluate(() => {
      const st = window.__pageStore.getState()
      return { active: st.activePage, pending: st.pendingPage }
    })
    // ⚠️ 不查 `error`:台架垫片没有 savePage,落卡那一下的保存本来就会失败 —— 那是台架的既有缺口,
    //    不是作用域泄漏。真正的不变式只有这两条:仪表盘的 activePage 没被换、也没被拖进 loading。
    check('D14 **仪表盘那份 store 一个字没动**', dash.active === 'Harness.dashboard.md' && !dash.pending, JSON.stringify(dash))
    check('D14 仪表盘的卡还在原位(没被换成那篇笔记的正文)',
      (await page.locator('.dash2-card').count()) === 5, String(await page.locator('.dash2-card').count()))
    await page.close()
  }

  // ── D19 两态切换的边界(Codex 2026-08-25 评审)────────────────────────────────
  {
    const page = await open(browser, false)
    const r = await cardRect(page, '1')
    await page.mouse.dblclick(r.left + r.width / 2, r.top + 30)
    await page.waitForTimeout(300)
    check('D19 前置:排版台里双击进了交互态', (await page.locator('.dash2-card[data-interact]').count()) === 1)
    // 带着交互态直接按锁定 —— 修前 interactId 会被原样带进成品页,那张卡继续以编辑态让路。
    await page.locator('.amx-toolbar button[title^="锁定"]').click()
    await page.waitForTimeout(300)
    check('D19 锁定即退出交互态', (await page.locator('.dash2-card[data-interact]').count()) === 0)
    check('D19 锁定即清选中描边', (await page.locator('.dash2-card[data-selected]').count()) === 0)
    const hit = page.locator('[data-act="hit"]')
    const before = await hit.getAttribute('data-hits')
    const b = await hit.boundingBox()
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    await page.waitForTimeout(250)
    check('D19 锁定后单击立刻恢复「不穿透」(不是等到下一次交互)',
      (await hit.getAttribute('data-hits')) === before, `${before} → ${await hit.getAttribute('data-hits')}`)
    await page.close()
  }

  // ── D20 成品页的触屏:双指不许改视口(Codex:锁定判定曾晚于双指分支)────────────
  {
    const { page, cdp } = await openTouch(browser, true)
    const s0 = await stageInfo(page)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1)])
    await page.waitForTimeout(30)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1), tp(700, 400, 2)])
    await page.waitForTimeout(40)
    await sendTouch(cdp, 'touchMove', [tp(420, 400, 1), tp(820, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchMove', [tp(360, 400, 1), tp(900, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchEnd', [])
    await page.waitForTimeout(250)
    const s1 = await stageInfo(page)
    check('D20 成品页双指捏合不改视口(缩放与平移都纹丝不动)',
      Math.abs(s1.z - s0.z) < 1e-6 && Math.abs(s1.tx - s0.tx) < 1 && Math.abs(s1.ty - s0.ty) < 1,
      JSON.stringify({ z: [s0.z, s1.z], tx: [Math.round(s0.tx), Math.round(s1.tx)] }))
    await page.close()
  }
  // 反面:排版台里双指照样能缩放(否则上一格可能只是「触屏事件根本没进来」的假绿)。
  {
    const { page, cdp } = await openTouch(browser, false)
    const s0 = await stageInfo(page)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1)])
    await page.waitForTimeout(30)
    await sendTouch(cdp, 'touchStart', [tp(500, 400, 1), tp(700, 400, 2)])
    await page.waitForTimeout(40)
    await sendTouch(cdp, 'touchMove', [tp(420, 400, 1), tp(820, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchMove', [tp(360, 400, 1), tp(900, 400, 2)])
    await page.waitForTimeout(60)
    await sendTouch(cdp, 'touchEnd', [])
    await page.waitForTimeout(250)
    const s1 = await stageInfo(page)
    check('D20 反面:排版台里双指**能**缩放(证明触屏事件真的进来了,上一格不是假绿)',
      Math.abs(s1.z - s0.z) > 0.05, JSON.stringify({ z: [s0.z, s1.z] }))
    await page.close()
  }

  // ── D15 点阵背景:编辑态才铺,且跟着缩放走(用户 2026-08-25 实报「连背景点点都没有」)──
  {
    const page = await open(browser, true)
    check('D15 锁定态不铺点阵(browse 就该是干净的板子)', (await page.locator('.amx-stage-grid').count()) === 0)
    await page.locator('.amx-toolbar button[title^="解锁编辑"]').click()
    await page.waitForTimeout(300)
    check('D15 解锁即铺点阵', (await page.locator('.amx-stage-grid').count()) === 1)
    const grid1 = await page.evaluate(() => {
      const step = Number.parseFloat(getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundSize)
      const z = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.dash2-stage')).transform).a
      return { css: step, screen: step * z }
    })
    const dot = await page.evaluate(() => getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundImage)
    check('D15 点阵是 radial-gradient 的点,不是别的花样(与画布同一份 CSS)', dot.includes('radial-gradient'), dot.slice(0, 60))
    check('D15 有限画板里的格距 = 24px × 当前缩放', grid1.css === 24 && grid1.screen === 24, JSON.stringify(grid1))
    check('D15 点阵被裁在有限画板里(不是铺满整个宿主)', await page.evaluate(() => {
      const g = document.querySelector('.amx-stage-grid')
      return g?.parentElement?.classList.contains('dash2-board') && getComputedStyle(g.parentElement).overflow === 'hidden'
    }))
    await page.locator('.amx-stage-hud button[title="放大"]').click()
    await page.waitForTimeout(250)
    const grid2 = await page.evaluate(() => {
      const step = Number.parseFloat(getComputedStyle(document.querySelector('.amx-stage-grid')).backgroundSize)
      const z = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.dash2-stage')).transform).a
      return { css: step, screen: step * z }
    })
    check('D15 放大后点阵随画板一起缩放(点阵是画布内容,不是壁纸)', grid2.css === 24 && grid2.screen > grid1.screen, `${JSON.stringify(grid1)} → ${JSON.stringify(grid2)}`)
    await page.close()
  }

  // ── D13 嵌卡能力面(方案 §6.4 S1):需要身份的视图先经快速查找选文件,再落卡 ──────
  {
    const page = await open(browser, false)
    await page.locator('.amx-toolbar button[title="添加卡片"]').click()
    await page.waitForTimeout(250)
    await shot(page, 'addmenu')
    const labels = await page.locator('.dash-add-menu button').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    check('D13 加卡菜单按 embeddable 白名单列视图(全局面直接落,身份面带「…」)',
      labels.includes('Dash Probe') && labels.includes('File Probe…'), JSON.stringify(labels))
    check('D13 非 embeddable 的视图不进菜单', !labels.some((l) => l.includes('Chat')), JSON.stringify(labels))

    await page.locator('.dash-add-menu button', { hasText: 'File Probe' }).click()
    await page.waitForTimeout(300)
    check('D13 身份面先开选取面板(复用快速查找,不另造 picker)', (await page.locator('.amx-qf').count()) === 1)
    await shot(page, 'picker')
    const rows = await page.locator('.amx-qf-row .amx-qf-title').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    // 候选按 `fileMatchViewType(path) === type` 收窄 —— 只该出 .pdf,不该出笔记与图片。
    check('D13 候选按后缀声明收窄(只出 .pdf)', JSON.stringify(rows) === '["手册.pdf"]', JSON.stringify(rows))

    const before = await page.locator('.dash2-card').count()
    await page.locator('.amx-qf-row').first().click()
    await page.waitForTimeout(400)
    check('D13 选中后真落了一张卡', (await page.locator('.dash2-card').count()) === before + 1)
    const src = await page.evaluate(() => Object.values(window.__pageStore.getState().blocks).map((b) => b.content).find((c) => c.includes('File') || c.includes('probePath')))
    check('D13 卡片源码写的是该视图的 idParam(不是硬编码的键)',
      src === '```view\ntype: amadeus-pdf\nprobePath: 手册.pdf\n```', JSON.stringify(src))
    check('D13 卡里那个视图真的拿到了这个身份', (await page.locator('[data-tag="dashfile"]').getAttribute('data-src')) === '手册.pdf')
    await page.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  console.log('SKIP  触屏双指 / 真机 Electron:前者走 check:canvastouch 同款口径(未接),后者只有人工点得了')
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
