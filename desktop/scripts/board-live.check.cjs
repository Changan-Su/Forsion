// 白板纸张/网格层的**真 Excalidraw** 契约(harness ?board 模式)。
//
// 分工:纯数学(frontmatter 往返 / 纸张尺寸 / 视口钳制不动点)在 shared/amadeus/excalidraw/board.test.ts;
// 纯 CSS(混合模式像素 / clip-path 命中测试 / 紧凑宽度)在 scripts/board-paper.check.cjs(合成页,秒级)。
// 这支只钉那两支**都看不见**的东西 —— 挂到真画布上才会露的:
//   L1 两层真的挂进了 .excalidraw。⚠️<Excalidraw> 首帧渲染的是 LoadingMessage,`.excalidraw` 那一刻
//      **还不在 DOM 里** —— 只在 mount 时 querySelector 一次会永远落空,网格从此不显示。
//   L2 指针落点 == 场景坐标(光标与实际作用位置不许偏)。
//   L3 打开网格后纸面上真的出现网格线(截图回灌读像素,mix-blend-mode 的结果 JS 读不到)。
//   L4 选了纸张后视口被钳住,且纸外点不进画布。
//
// 用法:npm run check:boardlive(自带起停 vite);或 npm run web 后 node scripts/board-live.check.cjs
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

const setBoard = (p, s) => p.evaluate((s) => window.__board.setSettings(s), s)
/** 缩小到能一眼看见整条页带 —— 页比视口高得多时,缝隙 / 末尾按钮都在视口外,量不到。 */
async function zoomOut(p, box, n = 8) {
  await p.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
  await p.keyboard.down('Control')
  for (let i = 0; i < n; i++) await p.mouse.wheel(0, 300)
  await p.keyboard.up('Control')
  await p.waitForTimeout(450)
}
const scene = (p) => p.evaluate(() => window.__scene)
const rect = (p, sel) => p.evaluate((sel) => {
  const r = document.querySelector(sel)?.getBoundingClientRect()
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
}, sel)

/** 截图回灌:mix-blend-mode 的合成结果只有截图看得见。 */
async function probes(p, pts) {
  const b64 = (await p.screenshot()).toString('base64')
  return p.evaluate(async ({ b64, pts }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return pts.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3))
  }, { b64, pts })
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 })
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await p.goto(`${BASE}?board`)
  await p.waitForSelector('.excalidraw canvas.excalidraw__canvas.interactive', { timeout: 20000 })
  await p.waitForTimeout(600)

  // ── L1 两层挂上没有 ──
  const mounted = await p.evaluate(() => ({
    grid: !!document.querySelector('.excalidraw .amx-grid'),
    matte: !!document.querySelector('.excalidraw .amx-matte'),
    // 载体不能是个带 z-index 的盒子(会隔离混合)—— display:contents 是硬要求
    hostDisplay: document.querySelector('.excalidraw .amx-grid')?.parentElement?.style.display ?? '(无)',
  }))
  check('L1 网格/遮罩两层真的挂进了 .excalidraw', mounted.grid && mounted.matte,
    `grid=${mounted.grid} matte=${mounted.matte}`)
  check('L1 portal 载体是 display:contents(否则混合被隔离)', mounted.hostDisplay === 'contents', `实得=${mounted.hostDisplay}`)

  // 几何快照(排查光标偏移时先看这个:哪一层的矩形对不上,偏移就出在哪)
  console.log('  [几何]', JSON.stringify(await p.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
    const cv = document.querySelector('canvas.excalidraw__canvas.interactive')
    return { pane: r('.amx-drawview'), draw: r('.amx-draw'), host: r('.amx-boardhost'), ex: r('.excalidraw'),
      cvRect: r('canvas.excalidraw__canvas.interactive'), cvAttr: cv ? [cv.width, cv.height] : null, dpr: devicePixelRatio, zoom: getComputedStyle(document.body).zoom }
  })))

  // ── L2 指针落点 == 场景坐标 ──
  // 无限画布 + 初始视口(scrollX/Y=0, zoom=1)下,场景坐标 = 视口坐标 − 容器左上角。
  const box = await rect(p, '.excalidraw')
  await p.mouse.click(box.x + 600, box.y + 600) // 先把焦点给画布,否则快捷键落空
  await p.keyboard.press('r') // 矩形工具
  await p.waitForTimeout(120)
  const from = { x: box.x + 300, y: box.y + 220 }
  const to = { x: box.x + 420, y: box.y + 320 }
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(to.x, to.y, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(200)
  const sc = await scene(p)
  const els = sc?.elements ?? []
  if (!els.length) console.log('  [诊断] __scene =', JSON.stringify(sc)?.slice(0, 200))
  const el = els[els.length - 1]
  const dx = el ? el.x - 300 : NaN
  const dy = el ? el.y - 220 : NaN
  check('L2 指针落点与场景坐标不偏移', !!el && Math.abs(dx) <= 1.5 && Math.abs(dy) <= 1.5,
    el ? `画在 (300,220) 实得 (${el.x.toFixed(1)},${el.y.toFixed(1)}) 偏移 (${dx.toFixed(1)},${dy.toFixed(1)})` : '没画出元素')
  check('L2 拖出的尺寸也对', !!el && Math.abs(el.width - 120) <= 2 && Math.abs(el.height - 100) <= 2,
    el ? `${el.width?.toFixed(1)}×${el.height?.toFixed(1)}(该是 120×100)` : '—')

  // ── L3 网格真的画出来了 ──
  await setBoard(p, { gridH: 40, gridV: 40, paper: null, landscape: false })
  await p.waitForTimeout(300)
  // 横扫一行,数暗像素的间距 —— 比钉死某个 x 稳(视口被平移过就对不上了),而且顺带验了「间距」这个功能本身。
  // ⚠️ 扫描带必须避开 excalidraw 自己的 UI:选中态会在左侧弹出属性岛,它的像素也是暗的,会混进来。
  await p.keyboard.press('Escape')
  await p.waitForTimeout(150)
  const y = Math.round(box.y + 501) // 奇数 y,避开横线
  const scanX = []
  for (let x = Math.round(box.x + 560); x < Math.round(box.x + 960); x++) scanX.push([x, y])
  const scan = await probes(p, scanX)
  const dark = scan.map((c, i) => [c[0], scanX[i][0]]).filter(([v]) => v < 245).map(([, x]) => x)
  const gaps = dark.slice(1).map((x, i) => x - dark[i]).filter((d) => d > 1)
  check('L3 网格线可见', dark.length >= 8, `暗像素 ${dark.length} 个 / 共 ${scan.length}`)
  check('L3 线距 = 设定的 40px', gaps.length >= 5 && gaps.every((d) => Math.abs(d - 40) <= 1), `实测间距 ${gaps.slice(0, 6).join(',')}`)

  // ── L4 纸张:视口被钳住 + 纸外不可画 ──
  await setBoard(p, { gridH: 40, gridV: 40, paper: 'A4', landscape: false })
  await p.waitForTimeout(500)
  const paper = await rect(p, '.amx-grid')
  check('L4 纸张层出现且是 A4 比例(1:1.414)', !!paper && Math.abs(paper.h / paper.w - 1123 / 794) < 0.02,
    paper ? `${paper.w.toFixed(0)}×${paper.h.toFixed(0)} 比 ${(paper.h / paper.w).toFixed(3)}` : '没有')
  const hit = await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: Math.round(box.x + 4), y: Math.round(box.y + box.h / 2) })
  check('L4 纸外点中遮罩 = 越界不可画', String(hit).includes('amx-matte'), `实得=${hit}`)
  // 滚到天边,钳制必须把纸拉回视野
  await p.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
  await p.mouse.wheel(0, 6000)
  await p.waitForTimeout(400)
  // 多页:只要**有页**还在视野内就算硬边界生效(首页跑出屏幕是正常的)
  const vis = await p.evaluate(({ top, bottom }) => [...document.querySelectorAll('.amx-grid')]
    .map((e) => e.getBoundingClientRect()).filter((r) => r.y < bottom && r.y + r.height > top).length,
    { top: box.y, bottom: box.y + box.h })
  check('L4 狂滚之后仍有纸张在视野内(硬边界生效)', vis > 0, `视野内 ${vis} 页`)

  // ── L5 拖拽中不许纠偏视口 ──
  // 这是「光标和实际作用位置偏移」的病根:excalidraw 按**当下的** scrollX/zoom 把指针换算成场景坐标,
  // 半途 updateScene 改视口,正在画的那一笔就从光标底下滑开。放大到纸比视口大(钳制随时想动手)再拖。
  await p.keyboard.down('Control')
  for (let i = 0; i < 6; i++) await p.mouse.wheel(0, -300)
  await p.keyboard.up('Control')
  await p.waitForTimeout(400)
  await p.keyboard.press('r')
  const g0 = await rect(p, '.amx-grid[data-page="0"]') // 必须取**第 0 页** —— 它才锚在场景原点
  const z0 = g0.w / 794
  const sx = Math.round(box.x + box.w / 2)
  const sy = Math.round(box.y + box.h / 2)
  await p.mouse.move(sx, sy)
  await p.mouse.down()
  await p.mouse.move(sx + 90, sy + 70, { steps: 8 })
  const g1 = await rect(p, '.amx-grid[data-page="0"]') // 与 g0 同一页,否则量的是两个不同的层
  await p.mouse.up()
  await p.waitForTimeout(250)
  check('L5 拖拽途中视口纹丝不动(纸张钳制不许跟指针抢)',
    Math.abs(g1.x - g0.x) < 0.6 && Math.abs(g1.y - g0.y) < 0.6 && Math.abs(g1.w - g0.w) < 0.6,
    `拖前 ${g0.x.toFixed(1)},${g0.y.toFixed(1)},${g0.w.toFixed(1)} → 拖中 ${g1.x.toFixed(1)},${g1.y.toFixed(1)},${g1.w.toFixed(1)}`)
  const els2 = (await scene(p))?.elements ?? []
  const el2 = els2[els2.length - 1]
  const wantX = (sx - g0.x) / z0 // 纸锚在场景原点 → 场景坐标可由纸张矩形反推
  const wantY = (sy - g0.y) / z0
  check('L5 放大 + 纸张钳制下,落点仍在光标处',
    !!el2 && Math.abs(el2.x - wantX) <= 2 && Math.abs(el2.y - wantY) <= 2,
    el2 ? `期望 (${wantX.toFixed(1)},${wantY.toFixed(1)}) 实得 (${el2.x.toFixed(1)},${el2.y.toFixed(1)})` : '没画出元素')

  // ── L8 平移途中,层必须跟着画布一起动 ──
  // 病根:`onChange` **只在场景(元素)变化时**来,平移/缩放一律不触发 → 一整趟平移里画布重画几十次
  // 而我们的层一次都不更新,内容就从纸和网格底下滑走(用户报的「跟随的漂移」)。这里直接数两边的次数。
  // ⚠️ 必须在**无限画布**下量:开着纸张时视口一顶到边界就被钳住,层不动是正确行为,数出来会假红。
  await setBoard(p, { gridH: 40, gridV: 40, paper: null, landscape: false })
  await p.waitForTimeout(300)
  await p.evaluate(() => {
    window.__ev = { layer: 0, canvas: 0 }
    const grid = document.querySelector('.amx-grid')
    new MutationObserver(() => window.__ev.layer++).observe(grid, { attributes: true, attributeFilter: ['style'] })
    const proto = Object.getPrototypeOf(document.querySelector('canvas.excalidraw__canvas.static').getContext('2d'))
    let last = 0
    for (const m of ['clearRect', 'setTransform', 'drawImage', 'fillRect']) {
      const orig = proto[m]
      proto[m] = function (...a) {
        if (this.canvas?.classList?.contains('static')) {
          const t = performance.now()
          if (t - last > 1) { last = t; window.__ev.canvas++ } // 一次重画只记头一笔
        }
        return orig.apply(this, a)
      }
    }
  })
  await p.mouse.move(box.x + 500, box.y + 400)
  for (let i = 0; i < 20; i++) {
    await p.mouse.wheel(0, 40)
    await p.waitForTimeout(16)
  }
  await p.waitForTimeout(200)
  const ev = await p.evaluate(() => window.__ev)
  check('L8 平移途中层跟着画布一起动(不是等场景变了才醒)', ev.canvas > 5 && ev.layer >= ev.canvas * 0.8,
    `画布重画 ${ev.canvas} 次 / 层更新 ${ev.layer} 次`)

  // ── L7 光标在页面里晃的时候,画布不许漂 ──
  // 钳制挂在 onChange 上,而 excalidraw 每次指针移动都会改 appState(悬停/光标)→ onChange。
  // 只要钳制不是一次到不动点(比如 excalidraw 把我们下发的 scroll/zoom 规整过),
  // 每动一下鼠标就推一把,内容就会跟着光标一路漂。
  await setBoard(p, { gridH: 40, gridV: 40, paper: 'A4', landscape: false }) // L8 把纸关了,这里和 L9 都要开着
  await p.waitForTimeout(500)
  const drift = []
  for (let i = 0; i < 8; i++) {
    await p.mouse.move(box.x + 200 + i * 60, box.y + 200 + (i % 3) * 80)
    await p.waitForTimeout(90)
    drift.push(await rect(p, '.amx-grid'))
  }
  const span = (k) => Math.max(...drift.map((r) => Math.abs(r[k] - drift[0][k])))
  check('L7 纯移动光标不产生漂移(钳制必须一次到不动点)', span('x') < 0.6 && span('y') < 0.6 && span('w') < 0.6,
    `最大位移 dx=${span('x').toFixed(2)} dy=${span('y').toFixed(2)} dw=${span('w').toFixed(2)};轨迹 y=${drift.map((r) => r.y.toFixed(1)).join(' → ')}`)

  // ── L9 贴着纸边硬推,一帧都不许越界 ──
  // 钳制若等到下一帧才下发,越界的那一帧就真的画出去了 → 贴边推的时候一路「推出去→弹回来」的闪烁拖影。
  // 判据:**每个滚轮事件之后立刻**(不等稳定)读层的位置,必须纹丝不动 —— 层是用钳制后的值排的,
  // 一旦钳制退回异步,层就会先带着越界值排一次,这里当场变红。
  await p.mouse.move(box.x + 500, box.y + 400)
  // 自校准地顶到上边界:一直推到层不再动为止(页带有多高取决于内容,不能写死推几下)
  let prevTop = null
  for (let i = 0; i < 40; i++) {
    await p.mouse.wheel(0, -2000)
    await p.waitForTimeout(30)
    const r = await rect(p, '.amx-grid')
    if (prevTop !== null && Math.abs(r.y - prevTop) < 0.5) break
    prevTop = r.y
  }
  await p.waitForTimeout(300)
  const edge = []
  for (let i = 0; i < 10; i++) {
    await p.mouse.wheel(0, -300) // 继续朝界外推
    edge.push(await rect(p, '.amx-grid'))
  }
  const edgeSpan = (k) => Math.max(...edge.map((r) => Math.abs(r[k] - edge[0][k])))
  check('L9 顶到纸边后继续推,层一帧都不越界(钳制必须同步下发)',
    edgeSpan('x') < 0.6 && edgeSpan('y') < 0.6,
    `dx=${edgeSpan('x').toFixed(2)} dy=${edgeSpan('y').toFixed(2)};轨迹 y=${edge.map((r) => r.y.toFixed(1)).join(' → ')}`)

  // ── L6 紧凑模式:属性面板从左侧竖条变成底部横排(compact 的定义特征) ──
  // 走真 UI 路径(汉堡菜单里的复选框),顺带验了面板本身可达。
  await p.keyboard.press('Escape')
  await setBoard(p, { gridH: 0, gridV: 0, paper: null, landscape: false })
  await p.mouse.click(box.x + 600, box.y + 600)
  await p.keyboard.press('r')
  await p.mouse.move(box.x + 300, box.y + 220)
  await p.mouse.down()
  await p.mouse.move(box.x + 400, box.y + 300, { steps: 6 })
  await p.mouse.up()
  await p.waitForTimeout(300)
  const before = await rect(p, '.excalidraw .App-menu__left')
  check('L6 默认:属性面板是左侧竖条', !!before && before.h > before.w && before.w < 260 && before.x < box.x + 60,
    before ? `${before.w.toFixed(0)}×${before.h.toFixed(0)} @ x=${before.x.toFixed(0)}` : '面板没出现')

  await p.click('.excalidraw [data-testid="main-menu-trigger"]')
  await p.waitForTimeout(200)
  const toggled = await p.evaluate(() => {
    const cb = [...document.querySelectorAll('.amx-bs-check input[type=checkbox]')].pop()
    if (!cb) return false
    cb.click()
    return true
  })
  check('L6 汉堡菜单里有紧凑开关', toggled)
  await p.keyboard.press('Escape')
  await p.waitForTimeout(300)
  const after2 = await rect(p, '.excalidraw .App-menu__left')
  check('L6 紧凑后变成底部横排(宽>高,且贴底)',
    !!after2 && after2.w > after2.h && after2.w > box.w * 0.7 && after2.y > box.y + box.h * 0.5,
    after2 ? `${after2.w.toFixed(0)}×${after2.h.toFixed(0)} @ y=${after2.y.toFixed(0)}(容器高 ${box.h}）` : '面板没了')
  check('L6 紧凑后左侧画布让出来了(整条竖栏消失)', !!after2 && after2.h < (before?.h ?? 1e9) * 0.5,
    after2 ? `高 ${before?.h.toFixed(0)} → ${after2.h.toFixed(0)}` : '—')

  // ── L14 页数手动控:加得动、减得动、但**减不掉有内容的那页**(不许把已画的东西甩到页外) ──
  await setBoard(p, { gridH: 0, gridV: 0, paper: 'A4', landscape: false, flow: 'v', pageFirst: 0, pageLast: 0 })
  await p.waitForTimeout(500)
  const pageN = () => p.evaluate(() => document.querySelectorAll('.amx-grid').length)
  const n1 = await pageN()
  await setBoard(p, { pageFirst: -2, pageLast: 3 })
  await p.waitForTimeout(500)
  const n2 = await pageN()
  await setBoard(p, { pageFirst: 0, pageLast: 0 })
  await p.waitForTimeout(500)
  const n3 = await pageN()
  check('L14 页数跟着设置走(不再自动长)', n1 >= 1 && n2 === n1 + 5 && n3 === n1, `${n1} → 前2后3 → ${n2} → 归零 → ${n3}`)
  check('L14 归零后内容仍在页带内(内容兜底)', n3 >= 1, `归零后 ${n3} 页`)

  // 页带两端的「新建页面」按钮:得点得到(它压在遮罩上),点一下真加一页,加完的空白页可以删掉
  const addBtn = (end) => `.amx-pageadd[data-end="${end}"] button:not(.amx-pageadd-del)`
  await zoomOut(p, box)
  // playwright 的 click 自带可达性检查(有东西挡着就超时报 intercepts)→ 点成了就等于
  // 「没被吃掉指针事件的遮罩挡住」,比自己 elementFromPoint 更严也更稳。
  let clickErr = null
  const n4 = await p
    .click(addBtn('after'), { timeout: 5000 })
    .then(() => p.waitForTimeout(500))
    .then(pageN)
    .catch((e) => {
      clickErr = String(e).split('\n')[0]
      return -1
    })
  check('L14 末尾「新建页面」点得到、且真的多一页(遮罩没吃掉它)', n4 === n3 + 1, clickErr ?? `${n3} → ${n4}`)
  // 开头那颗只验几何:它落在首页外侧。(缩得太小时它可能被 excalidraw 自己的顶部工具条盖住 ——
  //  UI 在 z-index 4,我们在 3,层级本身是对的,滚一点就露出来。)
  const bBtn = await rect(p, '.amx-pageadd[data-end="before"]')
  const p0 = await rect(p, `.amx-grid[data-page="${await p.evaluate(() => Math.min(...[...document.querySelectorAll('.amx-grid')].map((e) => +e.dataset.page)))}"]`)
  check('L14 开头那颗按钮贴在首页外侧', !!bBtn && !!p0 && bBtn.y < p0.y, `按钮 y=${bBtn?.y.toFixed(0)} 首页 y=${p0?.y.toFixed(0)}`)
  await p.click(`.amx-pageadd[data-end="after"] .amx-pageadd-del`)
  await p.waitForTimeout(500)
  check('L14 刚加的空白页可以删掉', (await pageN()) === n4 - 1, `${n4} → 删末页 → ${await pageN()}`)
  await setBoard(p, { pageFirst: 0, pageLast: 0 })
  await p.waitForTimeout(400)

  // ── L10/L11 多页:页带、缝隙的命中、以及换方向时内容跟着页一起搬 ──
  const layers = () => p.evaluate(() => [...document.querySelectorAll('.amx-grid')].map((e) => {
    const r = e.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }))
  // 页数是手动控的:前后各加一页,凑出「上中下」三页来验几何与缝隙
  await setBoard(p, { gridH: 0, gridV: 0, paper: 'A4', landscape: false, flow: 'v', pageFirst: -1, pageLast: 1 })
  await p.waitForTimeout(600)
  await zoomOut(p, box) // 不缩小的话页比视口高得多,缝隙落在视口外量不到
  const vlay = await layers()
  const zoomOf = vlay.length ? vlay[0].h / 1123 : 0
  check('L10 竖排:页上下相接、各页等宽同列、缝隙 = PAGE_GAP',
    vlay.length >= 3 &&
      vlay.every((r) => Math.abs(r.x - vlay[0].x) < 1) &&
      Math.abs(vlay[1].y - (vlay[0].y + vlay[0].h) - 48 * zoomOf) < 2,
    `${vlay.length} 页;缝 ${(vlay[1] ? vlay[1].y - vlay[0].y - vlay[0].h : 0).toFixed(1)}px(该 ${(48 * zoomOf).toFixed(1)})`)

  // 缝隙里必须点不进画布(它不是纸面),而每一页里都可以画 —— 这就是「上下都有新增页面」的实证。
  // ⚠️ 取样点必须落在视口内,否则 elementFromPoint 回 null;页带比视口高得多,得先挑一条看得见的缝。
  const inView = (y) => y > box.y + 8 && y < box.y + box.h - 8
  let gapY = null
  let pageY = null
  for (let i = 0; i < vlay.length; i++) {
    const g = vlay[i].y + vlay[i].h + 24 * zoomOf
    if (gapY === null && i + 1 < vlay.length && inView(g)) gapY = g
  }
  // 页可能比视口高得多,中心点未必看得见 → 沿视口扫一遍,找第一个落在某页内部的 y
  for (let y = box.y + 140; y < box.y + box.h - 80 && pageY === null; y += 20) {  // 避开顶部工具条
    if (vlay.some((r) => y > r.y + 4 && y < r.y + r.h - 4)) pageY = y
  }
  const cx = Math.round(vlay[0].x + vlay[0].w / 2)
  const gapHit = gapY === null ? '(视口内没有缝)' : await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: cx, y: Math.round(gapY) })
  const pageHit = pageY === null ? '(视口内没有整页)' : await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: cx, y: Math.round(pageY) })
  check('L10 页与页之间的缝点不进画布', String(gapHit).includes('amx-matte'), `实得=${gapHit}`)
  check('L10 每一页本身都可以画(遮罩给每页各挖了洞)', pageY !== null && !/amx-matte/.test(String(pageHit)), `实得=${pageHit}`)

  const preFlow = ((await scene(p))?.elements ?? []).filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: e.x, y: e.y }))
  await setBoard(p, { gridH: 0, gridV: 0, paper: 'A4', landscape: false, flow: 'h' })
  await p.waitForTimeout(700)
  const hlay = await layers()
  check('L11 切成左右排:页左右相接、各页等高同行',
    hlay.length >= 3 && hlay.every((r) => Math.abs(r.y - hlay[0].y) < 1) && hlay[1].x > hlay[0].x + hlay[0].w - 1,
    `${hlay.length} 页;首页 x=${hlay[0]?.x.toFixed(0)} 次页 x=${hlay[1]?.x.toFixed(0)}`)
  const addV = await rect(p, '.amx-pageadd[data-end="after"]')
  check('L11 左右排时「新建页面」按钮立起来(竖着比横着窄一大截,正好塞进页间余量)',
    !!addV && addV.h > addV.w * 1.5, addV ? `${addV.w.toFixed(0)}×${addV.h.toFixed(0)}` : '没渲染')
  const postFlow = ((await scene(p))?.elements ?? []).filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: e.x, y: e.y }))
  // 内容跟着页一起搬:页内偏移一点不变,只换页原点(A4 794×1123,PAGE_GAP=48)
  const wrong = preFlow
    .map((b) => {
      const k = Math.floor(b.y / (1123 + 48))
      const want = { x: k * (794 + 48) + b.x, y: b.y - k * (1123 + 48) }
      const a = postFlow.find((z) => z.id === b.id)
      return a && (Math.abs(a.x - want.x) > 0.01 || Math.abs(a.y - want.y) > 0.01) ? { b, a, want, k } : null
    })
    .filter(Boolean)
  check('L11 内容跟着页一起搬(页内偏移不变,只换页原点)', preFlow.length > 0 && wrong.length === 0,
    wrong.length
      ? `${wrong.length}/${preFlow.length} 个不对,例:第 ${wrong[0].k} 页 (${wrong[0].b.x.toFixed(0)},${wrong[0].b.y.toFixed(0)}) 期望 (${wrong[0].want.x.toFixed(0)},${wrong[0].want.y.toFixed(0)}) 实得 (${wrong[0].a.x.toFixed(0)},${wrong[0].a.y.toFixed(0)})`
      : `${preFlow.length} 个元素全部落到新页对应位置`)

  // ── L12 端级 UI 缩放下落点仍然精确 ──
  // 病根:excalidraw 拿 getBoundingClientRect() 当 CSS 像素用,而 body `zoom` 已经把 rect 缩放过 →
  // 落点误差 = 位置 ×(zoom-1)/zoom(实测 zoom=1.1 时 500px 处偏 45px,离原点越远越大)。
  // 我们的层用未缩放的局部 px 是对的,于是层与内容也对不上。修 = 在画布容器上反向抵消祖先 zoom。
  // ⚠️ 判据必须是**绝对**落点:按「两点定映射看残差」量,均匀的比例错误会被拟合吸收,假绿。
  await setBoard(p, { gridH: 0, gridV: 0, paper: 'A4', landscape: false, flow: 'v', gridOpacity: 100 })
  await p.waitForTimeout(500)
  for (const uiz of [1.1, 0.85]) {
    await p.evaluate((v) => {
      document.body.style.zoom = String(v)
      window.dispatchEvent(new Event('forsion:uizoom'))
    }, uiz)
    await p.waitForTimeout(500)
    const g = await rect(p, '.amx-grid[data-page="0"]')
    const zz = g.w / 794
    const bx = await rect(p, '.excalidraw')
    let worst = 0
    for (const [ox, oy] of [[340, 230], [620, 330], [500, 500]]) {
      const vx = bx.x + ox
      const vy = bx.y + oy
      const want = { x: (vx - g.x) / zz, y: (vy - g.y) / zz }
      await p.mouse.click(vx, vy)
      await p.keyboard.press('Escape')
      await p.keyboard.press('r')
      const n = ((await scene(p))?.elements ?? []).length
      await p.mouse.move(vx, vy)
      await p.mouse.down()
      await p.mouse.move(vx + 40, vy + 30, { steps: 4 })
      await p.mouse.up()
      await p.waitForTimeout(140)
      const els3 = (await scene(p))?.elements ?? []
      const e3 = els3.length > n ? els3[els3.length - 1] : null
      if (e3) worst = Math.max(worst, Math.abs(e3.x - want.x), Math.abs(e3.y - want.y))
    }
    check(`L12 body zoom=${uiz} 下落点仍然精确`, worst < 1.5, `最大偏 ${worst.toFixed(1)}px`)
  }
  await p.evaluate(() => {
    document.body.style.zoom = ''
    window.dispatchEvent(new Event('forsion:uizoom'))
  })
  await p.waitForTimeout(400)

  // ── L13 网格淡浓真的作用在混合结果上 ──
  await setBoard(p, { gridH: 40, gridV: 40, paper: null, landscape: false, flow: 'v', gridOpacity: 100 })
  await p.waitForTimeout(400)
  await p.keyboard.press('Escape')
  const row = Math.round(box.y + 501)
  const scanPts = []
  for (let x = Math.round(box.x + 560); x < Math.round(box.x + 960); x++) scanPts.push([x, row])
  const full = await probes(p, scanPts)
  await setBoard(p, { gridH: 40, gridV: 40, paper: null, landscape: false, flow: 'v', gridOpacity: 25 })
  await p.waitForTimeout(400)
  const faint = await probes(p, scanPts)
  const darkest = (a) => Math.min(...a.map((c) => c[0]))
  check('L13 调淡后网格线确实更浅(opacity 参与了混合,没被层叠上下文吃掉)',
    darkest(faint) > darkest(full) + 8 && darkest(faint) < 253,
    `100% 最深 ${darkest(full)} → 25% 最深 ${darkest(faint)}`)

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
