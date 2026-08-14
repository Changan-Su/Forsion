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

  // ── L0 出厂档 = 紧凑 ──
  // 干净 localStorage 下的第一屏才量得到,所以放在最前面;量完切回常规,后面几十条都按常规档写的。
  // ⚠️ 顺带钉死「托盘档已下线」:存了 'tray' 也必须回落到紧凑,不能真挂上 .excalidraw--tray。
  check('L0 出厂默认是紧凑档', await p.evaluate(() =>
    !localStorage.getItem('amx.boardUiMode') && !!document.querySelector('.excalidraw .compact-shape-actions-island, .excalidraw .selected-shape-actions-container--compact')))
  await p.evaluate(() => localStorage.setItem('amx.boardUiMode', 'tray'))
  await p.reload()
  await p.waitForSelector('.excalidraw canvas.excalidraw__canvas.interactive', { timeout: 20000 })
  await p.waitForTimeout(500)
  check('L0 托盘档已下线:存了 tray 也回落到紧凑', await p.evaluate(() => !document.querySelector('.excalidraw--tray')))
  await p.evaluate(() => localStorage.setItem('amx.boardUiMode', 'full'))
  await p.reload()
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

  // ── L6 属性面板两档(常规 / 紧凑)──
  // 这两档是引擎(zsviczian fork)自带的真实现,不是我们压的 CSS —— 所以量的是**它的**特征类名与几何:
  //   常规 = .App-menu__left 那根 200px 竖条;紧凑 = .compact-shape-actions 细图标条(约 48px)。
  //   走汉堡菜单里的真 chip 点,顺带验了面板可达。(第三档 tray 已于 2026-08-14 下线,见 L0。)
  // ⚠️ 偏好落在 localStorage(全局),量完必须切回常规,否则后面的 L14/L10 都在紧凑档下跑。
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
  check('L6 常规:属性面板是左侧竖条', !!before && before.h > before.w && before.w < 260 && before.x < box.x + 60,
    before ? `${before.w.toFixed(0)}×${before.h.toFixed(0)} @ x=${before.x.toFixed(0)}` : '面板没出现')

  // 引擎给的 5 档线宽(上游只有 thin/bold/extraBold 三档)—— 用户要的「画笔粗细」就是这个
  const widths = await p.evaluate(() =>
    [...document.querySelectorAll('.excalidraw [data-testid^="strokeWidth-"]')].map((e) => e.dataset.testid.slice(12)))
  check('L6 线宽 5 档(fork 才有 extraThin/medium)',
    ['extraThin', 'thin', 'medium', 'bold', 'extraBold'].every((k) => widths.includes(k)), widths.join(',') || '一个都没有')

  /** 点汉堡菜单里那排形态 chip。返回是否点着了。 */
  const pickMode = async (label) => {
    await p.click('.excalidraw [data-testid="main-menu-trigger"]')
    await p.waitForTimeout(200)
    const hit = await p.evaluate((label) => {
      const b = [...document.querySelectorAll('.amx-bs-chip')].find((e) => e.textContent.trim() === label)
      if (!b) return false
      b.click()
      return true
    }, label)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(350)
    return hit
  }

  check('L6 汉堡菜单里有形态 chip', await pickMode('紧凑'))
  const compactPanel = await rect(p, '.excalidraw .compact-shape-actions')
  check('L6 紧凑:换成引擎自己的细图标条(不是 200px 竖条)',
    !!compactPanel && compactPanel.w < 90 && !(await rect(p, '.excalidraw .App-menu__left')),
    compactPanel ? `${compactPanel.w.toFixed(0)}×${compactPanel.h.toFixed(0)}` : '.compact-shape-actions 没出现')

  // ⚠️ 笔排现在住在**属性面板里**(2026-08-14 从 renderTopLeftUI 搬过来的),而属性面板每换一次
  //    工具就整块重挂 —— 锚点必须由 MutationObserver 补,只插一次的话换个工具就永远没了。
  //    这条是那个坑的哨兵:两档都得能在面板里找到笔,且必须在**岛内**(不能飘在岛外面)。
  /** 切到画笔、看面板里有没有笔排,然后**把工具还回选择**。
   *  ⚠️ 两头的「切回选择」都不能省:带着画笔离开这一段,后面 L14 往画布上点「新建页面」时
   *     那一下会变成一个墨点,页数判据当场跑偏(栽过一次,症状是 L14「1 → 0」)。 */
  const hasPens = async () => {
    await p.keyboard.press('1') // 选择工具:下面那一下点击才不会在画布上留东西
    await p.mouse.click(box.x + 700, box.y + 650) // 焦点给画布,否则快捷键落空
    await p.keyboard.press('4') // 中段第 4 颗 = 画笔(笔排只在选中它时出现在面板里)
    await p.waitForTimeout(350)
    const ok = await p.evaluate(() =>
      !!document.querySelector('.excalidraw .Island .selected-shape-actions .amx-penrow, .excalidraw .Island .compact-shape-actions .amx-penrow'))
    // 收尾切**形状**而不是选择:选择工具且没选中任何东西时属性面板整块不渲染,下一条
    // 「切回常规:竖条回来了」就量不到 .App-menu__left(栽过一次)。形状工具单击画布不产生元素,安全。
    await p.keyboard.press('2')
    await p.waitForTimeout(200)
    return ok
  }
  check('L6 紧凑档:笔排在属性面板岛内', await hasPens())

  await pickMode('常规')
  check('L6 切回常规:竖条回来了', !!(await rect(p, '.excalidraw .App-menu__left')))
  check('L6 常规档:笔排在属性面板岛内', await hasPens())

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

  // ── L15 深色档:网格必须换 screen(在暗底上**变亮**,而不是继续 multiply 糊成一片黑) ──
  // 从合成页(board-paper 的 E)迁来的。合成页量这条必须替引擎假设深色怎么实现 —— 上游 0.18.1 是
  // `.theme--dark canvas{filter:invert(...)}` 反相白画布,zsviczian fork 改成了原生画深色,
  // 假设一变就整条假红。这里直接读真画布的像素,引擎怎么实现都无所谓,只认「线比底亮」这个结果。
  /** 纸可能只有一角在视野里(前面的用例把视口推得到处都是)→ 取样带必须先跟视口求交,
   *  否则采到纸外的深色遮罩,量出来永远是「全黑」。 */
  const scanRow = async () => {
    const g = await rect(p, '.amx-grid')
    if (!g) return null
    const x0 = Math.max(g.x, box.x) + 6
    const x1 = Math.min(g.x + g.w, box.x + box.w) - 6
    const y = Math.round(Math.max(g.y, box.y) + (Math.min(g.y + g.h, box.y + box.h) - Math.max(g.y, box.y)) / 2) + 3
    if (x1 - x0 < 60) return null // 纸没露出足够宽度,量不了
    const pts = []
    for (let i = 0; i < 60; i++) pts.push([Math.round(x0 + ((x1 - x0) * i) / 59), y])
    const rows = await probes(p, pts)
    const L = rows.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
    return { lo: Math.round(Math.min(...L)), hi: Math.round(Math.max(...L)) }
  }
  await setBoard(p, { gridH: 40, gridV: 40, paper: 'A4', landscape: false, flow: 'v', gridOpacity: 100, pageFirst: 0, pageLast: 0 })
  await p.waitForTimeout(600)
  await zoomOut(p, box, 3) // 缩到能看见整张纸,取样带才有足够宽度
  await p.waitForTimeout(400)
  const lightScan = await scanRow()
  check('L15 浅色:纸面亮、网格线暗(multiply)', !!lightScan && lightScan.hi > 200 && lightScan.lo < lightScan.hi - 15,
    lightScan ? `底 ${lightScan.hi} / 线 ${lightScan.lo}` : '没量到网格层')
  await p.evaluate(() => window.__board.setTheme('dark'))
  await p.waitForTimeout(700)
  const darkScan = await scanRow()
  // 深色下「底」是最暗的那些点,「线」是最亮的 —— 正好和浅色反过来,这就是 screen 生效的判据
  check('L15 深色:纸面暗、网格线反而更亮(screen 生效,没被层叠上下文隔离)',
    !!darkScan && darkScan.lo < 60 && darkScan.hi > darkScan.lo + 15,
    darkScan ? `底 ${darkScan.lo} / 线 ${darkScan.hi}` : '没量到网格层')
  await p.evaluate(() => window.__board.setTheme('light'))

  // ── L16 自定义笔(荧光笔/钢笔…):点一支就套上它的参数,再点一次还原 ──
  // 这些参数只有 zsviczian fork 吃(appState.currentStrokeOptions);上游把 perfect-freehand 的
  // options 写死在渲染器里 —— 所以这条同时也是「引擎没被换回上游」的哨兵。
  await setBoard(p, { gridH: 0, gridV: 0, paper: null, landscape: false, pageFirst: 0, pageLast: 0 })
  await p.waitForTimeout(500)
  await p.keyboard.press('Escape')
  // ⚠️ 下面要**量笔迹的屏幕粗细**,所以这一段必须先把场地清干净:
  //    ① 复位缩放 —— 前面的用例把视口缩得很小(L15 的 zoomOut),粗笔细笔会一起缩成同样几个像素;
  //    ② 清空场景 —— 前面留下的十来个元素只要有一个横穿取样列,数出来的就不是这一笔的粗细。
  await p.mouse.click(box.x + 700, box.y + 650)
  await p.keyboard.press('Control+a')
  await p.keyboard.press('Delete')
  await p.keyboard.press('Control+0')
  await p.waitForTimeout(500)
  // 笔排现在只在**选中自由画笔**时出现在属性面板里(4 = 中段第 4 颗 = 画笔,见 L17)
  await p.keyboard.press('4')
  await p.waitForTimeout(300)
  const penTitles = await p.evaluate(() =>
    [...document.querySelectorAll('.excalidraw .amx-penrow label')].map((e) => e.title))
  check('L16 属性面板里挂着 7 支笔', penTitles.length === 7, penTitles.join(' ') || '一支都没有')

  const clickPen = (name) => p.evaluate((name) => {
    const b = [...document.querySelectorAll('.excalidraw .amx-penrow label')].find((e) => e.title === name)
    if (!b) return false
    b.click()
    return true
  }, name)
  /** ⚠️ 判据必须是「这一笔新增的那个元素」,不能拿 elements 末尾 —— 场景是按 fractional index 排的,
   *  新画的一笔不保证排在最后(实测新 freedraw 排在了先画的矩形前面,照末尾取就是恒红的假失败)。 */
  const stroke = async (y) => {
    const before = await p.evaluate(() => (window.__scene?.elements ?? []).map((e) => e.id))
    await p.mouse.move(box.x + 300, box.y + y)
    await p.mouse.down()
    await p.mouse.move(box.x + 640, box.y + y, { steps: 12 })
    await p.mouse.up()
    await p.waitForTimeout(350)
    return p.evaluate((before) => {
      const seen = new Set(before)
      const e = (window.__scene?.elements ?? []).find((x) => !seen.has(x.id) && !x.isDeleted)
      return e ? { type: e.type, stroke: e.strokeColor, fill: e.fillStyle, bg: e.backgroundColor } : null
    }, before)
  }

  /** 笔迹的**实际粗细**:竖着穿过刚画的那道横线数非背景像素。
   *  这是唯一能证明 `currentStrokeOptions`(perfect-freehand 参数)真的进了渲染的判据 ——
   *  只看元素上的 strokeColor/fillStyle 的话,一支普通画笔碰巧调成黄色也能骗过去。 */
  const bandPx = async (y) => {
    const x = Math.round(box.x + 470)
    const pts = []
    for (let dy = -22; dy <= 22; dy++) pts.push([x, Math.round(box.y + y) + dy])
    const col = await probes(p, pts)
    return col.filter((c) => c[0] < 245 || c[1] < 245 || c[2] < 245).length
  }

  // 基线 = **一支笔都没选**时的自由画笔(不是「默认」那支预设笔:选它同样会写快照,
  // 还原本就该回到选任何笔之前的这套设定)。后面「还原」要精确比回这里,而不是只判「不是荧光黄」
  // —— 还原掉回引擎出厂值同样是 bug,松判据抓不到。
  const base = await stroke(240)

  const okHl = await clickPen('荧光笔')
  await p.waitForTimeout(400)
  check('L16 画完一笔后笔排还在(自由画笔是粘性工具,面板不该塌掉)', okHl,
    `面板里 ${await p.evaluate(() => document.querySelectorAll('.excalidraw .amx-penrow label').length)} 支笔`)

  // ⚠️ 属性面板每换一次工具就整块重挂 = 笔排卸载重建。选中态若放在笔排自己的 ref 上就会归零
  //    (而引擎里的快照还在)→ 笔看着没选中、离开自由画笔也不还原。所以它归画布持有;
  //    这条就是那个决定的哨兵:切去形状再切回自由画笔,笔还得是选中的、参数还得自己套回来
  //    (插件的 freedrawOnly 语义)。
  // ⚠️ 回来必须走**引擎自己的** x,不能按 4 —— 中段第 4 颗是「画笔」按钮,它按设计就是要清笔的
  //    (画笔 ≠ 荧光笔),用它回来这条永远红。
  await p.keyboard.press('2') // 形状(合并按钮)
  await p.waitForTimeout(300)
  await p.keyboard.press('x') // 引擎的自由画笔快捷键
  await p.waitForTimeout(400)
  // 判据用 data-on(笔排自己标的选中态),别去嗅内联 style —— 换个高亮配色测试就假红。
  const stillOn = await p.evaluate(() => !!document.querySelector('.excalidraw .amx-penrow label[data-on]'))
  check('L16 切走工具再回来,选中的笔还在(选中态归画布,不归笔排组件)', stillOn)

  const hl = await stroke(330)
  const hlBand = await bandPx(330)
  check('L16 荧光笔画出来就是荧光笔(预设的颜色/填充真的落到元素上)',
    !!hl && hl.type === 'freedraw' && hl.stroke.toUpperCase() === '#FFC47C' && hl.fill === 'solid',
    hl ? JSON.stringify(hl) : '没画出元素')

  await clickPen('荧光笔') // 再点一次 = 还原
  await p.waitForTimeout(300)
  const back = await stroke(430)
  const backBand = await bandPx(430)
  check('L16 再点同一支 = 精确还原成还原前那支笔(不是掉回引擎出厂值)',
    !!back && !!base && back.stroke === base.stroke && back.fill === base.fill,
    back ? `${JSON.stringify(back)} vs 基线 ${JSON.stringify(base)}` : '没画出元素')
  // 元素上的 strokeWidth 两笔都是 2/1 这种小数字,光看它证明不了 perfect-freehand 的参数进没进渲染
  // —— 只有屏幕上的实际笔迹宽度能。拿**同一轮里普通笔迹**当分母(而不是拿更早那道基线):
  // 基线那道横穿的是被前面用例用过的画布,取样列上偶尔还压着别的东西,比过来不稳。
  check('L16 荧光笔的笔迹宽出好几倍(= currentStrokeOptions 真的进了渲染,不只是换了颜色)',
    backBand > 0 && hlBand >= backBand * 2.5, `普通笔迹 ${backBand}px → 荧光笔 ${hlBand}px`)

  // ── L17 自建工具胶囊:三段 + 中段按位置编号 + 拖拽改顺序会**同时改快捷键** ──
  // 引擎自己那条工具栏在预编译 bundle 里改不动,所以整条是我们画的(BoardToolbar.tsx);
  // 它塞在引擎那张已定位的 `.App-toolbar` Island 里,引擎的按钮用 CSS 藏掉 —— 这两件事都得钉:
  // 藏漏了会两条工具栏并排,藏过头会连 HintViewer 一起没。
  await p.evaluate(() => localStorage.removeItem('amx.boardToolbar'))
  await p.reload()
  await p.waitForSelector('.excalidraw canvas.excalidraw__canvas.interactive', { timeout: 20000 })
  await p.waitForTimeout(600)
  const tb = await p.evaluate(() => ({
    inIsland: !!document.querySelector('.excalidraw .App-toolbar .amx-toolbar'),
    segs: ['left', 'mid', 'right'].map((s) => [...document.querySelectorAll(`.amx-toolbar [data-seg="${s}"] [data-tool]`)].map((b) => b.dataset.tool)),
    keys: [...document.querySelectorAll('.amx-toolbar [data-seg="mid"] .amx-tool-key')].map((k) => k.textContent),
    seps: document.querySelectorAll('.amx-toolbar .amx-toolbar-sep').length,
    engineBtns: [...document.querySelectorAll('.excalidraw .App-toolbar [data-testid^="toolbar-"]')].filter((e) => e.offsetParent !== null).length,
    hint: !!document.querySelector('.excalidraw .App-toolbar > .HintViewer'),
  }))
  check('L17 工具栏塞进了引擎那张 Island(白捡它的定位/圆角/投影)', tb.inIsland)
  check('L17 引擎自带的工具按钮全藏了(否则两条并排)', tb.engineBtns === 0, `还露着 ${tb.engineBtns} 颗`)
  check('L17 HintViewer 没被一起藏掉', tb.hint)
  check('L17 两条分隔线分三段', tb.seps === 2, `实得 ${tb.seps}`)
  check('L17 锁和抓手在第一条分隔线左边', JSON.stringify(tb.segs[0]) === JSON.stringify(['lock', 'hand']), JSON.stringify(tb.segs[0]))
  check('L17 荧光笔在画笔右边', tb.segs[1].indexOf('highlighter') === tb.segs[1].indexOf('freedraw') + 1, tb.segs[1].join(','))
  check('L17 image 不在工具表里(fork 里它是死的,见 toolbarOrder.ts)',
    !tb.segs.flat().includes('image'), tb.segs.flat().join(','))
  check('L17 形状/线各合并成一颗', tb.segs[1].includes('shape') && tb.segs[1].includes('line') &&
    !tb.segs[1].some((t) => ['rectangle', 'diamond', 'ellipse', 'arrow'].includes(t)), tb.segs[1].join(','))
  check('L17 中段按位置编号 1..n(左右段没有数字)', JSON.stringify(tb.keys) === JSON.stringify(['1', '2', '3', '4', '5', '6', '7']), tb.keys.join(''))

  // ⚠️ 「按钮画出来了」≠「按钮能用」。fork 把图片插入整个改道给了 Obsidian 宿主,`setActiveTool({type:'image'})`
  //    在它这儿是**死的**(不弹文件选择器、activeTool 当场退回 selection)—— 所以 image 已从工具表移除。
  //    这条挨个点一遍,确保工具表里没有第二颗这样的死按钮溜进来。
  await p.mouse.click(box.x + 700, box.y + 650)
  const dead = []
  for (const t of ['selection', 'hand', 'shape', 'line', 'freedraw', 'highlighter', 'text', 'eraser', 'frame', 'laser']) {
    await p.evaluate((t) => document.querySelector(`.amx-toolbar [data-tool="${t}"]`)?.click(), t)
    await p.waitForTimeout(260)
    if (!(await p.evaluate((t) => !!document.querySelector(`.amx-toolbar [data-tool="${t}"][data-on]`), t))) dead.push(t)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(120)
  }
  check('L17 每一颗都真的能激活(没有画得出来点不动的死按钮)', dead.length === 0, dead.length ? `死按钮:${dead.join(',')}` : '10 颗全活')
  // 锁不是工具而是「画完保持工具选中」的开关 —— 点它不该把当前工具换掉
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="shape"]')?.click())
  await p.waitForTimeout(250)
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="lock"]')?.click())
  await p.waitForTimeout(250)
  check('L17 锁是开关不是工具(翻 activeTool.locked,当前工具不变)',
    await p.evaluate(() => !!document.querySelector('.amx-toolbar [data-tool="lock"][data-on]') &&
      !!document.querySelector('.amx-toolbar [data-tool="shape"][data-on]')),
    await p.evaluate(() => [...document.querySelectorAll('.amx-toolbar [data-tool]')].filter((b) => b.dataset.on !== undefined).map((b) => b.dataset.tool).join(',')))
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="lock"]')?.click())
  await p.waitForTimeout(200)

  /** 真拖:pointerdown → 越过 5px 阈值 → 移到目标中心 → up。HTML5 DnD 在触屏上是死的,所以实现走 pointer,
   *  这里也必须用 pointer 驱动,不能用 dragAndDrop。 */
  const dragTool = async (from, to) => {
    const at = (t) => p.evaluate((t) => {
      const e = document.querySelector(`.amx-toolbar [data-tool="${t}"]`)
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, t)
    const a = await at(from)
    const b = await at(to)
    if (!a || !b) return false
    await p.mouse.move(a.x, a.y)
    await p.mouse.down()
    await p.mouse.move(a.x + 8, a.y, { steps: 2 })
    await p.mouse.move(b.x - 4, b.y, { steps: 8 })
    await p.mouse.up()
    await p.waitForTimeout(300)
    return true
  }
  // 把橡皮拖到中段最前面:它应该抢走数字 1,而原来的 selection 顺延
  await dragTool('eraser', 'selection')
  const afterDrag = await p.evaluate(() => ({
    mid: [...document.querySelectorAll('.amx-toolbar [data-seg="mid"] [data-tool]')].map((b) => b.dataset.tool),
    stored: JSON.parse(localStorage.getItem('amx.boardToolbar') || 'null'),
  }))
  check('L17 拖拽真的改了顺序', afterDrag.mid[0] === 'eraser', afterDrag.mid.join(','))
  check('L17 顺序落盘(全局,所有白板共享)', !!afterDrag.stored && afterDrag.stored.mid[0] === 'eraser')
  // 数字键必须跟着位置走 —— 这才是「拖动 = 改快捷键」这条语义的真判据
  await p.mouse.click(box.x + 700, box.y + 650)
  await p.keyboard.press('1')
  await p.waitForTimeout(250)
  check('L17 按 1 现在是橡皮(数字键跟着拖出来的位置走)',
    await p.evaluate(() => !!document.querySelector('.amx-toolbar [data-tool="eraser"][data-on]')))
  // 跨段拖:锁从左段拖进中段,它就该拿到数字键
  await dragTool('lock', 'eraser')
  check('L17 三段之间也能拖(锁进中段就有数字键了)',
    await p.evaluate(() => {
      const mid = [...document.querySelectorAll('.amx-toolbar [data-seg="mid"] [data-tool]')].map((b) => b.dataset.tool)
      const left = [...document.querySelectorAll('.amx-toolbar [data-seg="left"] [data-tool]')].map((b) => b.dataset.tool)
      return mid.includes('lock') && !left.includes('lock')
    }))
  // 恢复默认(汉堡菜单里那颗),顺带验证那颗按钮在
  await p.click('.excalidraw [data-testid="main-menu-trigger"]')
  await p.waitForTimeout(250)
  const reset = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.amx-bs-chip')].find((e) => e.textContent.trim() === '恢复默认顺序')
    if (!b) return false
    b.click()
    return true
  })
  await p.keyboard.press('Escape')
  await p.waitForTimeout(300)
  check('L17 汉堡菜单里有「恢复默认顺序」且真的复位', reset &&
    await p.evaluate(() => [...document.querySelectorAll('.amx-toolbar [data-seg="left"] [data-tool]')].map((b) => b.dataset.tool).join() === 'lock,hand'))

  // ── L18 合并按钮:成员切换在属性面板里,按钮记住最近用过的那个,数字键**不循环** ──
  await p.mouse.click(box.x + 700, box.y + 650)
  await p.keyboard.press('2')
  await p.waitForTimeout(300)
  const shapeBtns = await p.evaluate(() => [...document.querySelectorAll('.excalidraw .amx-panelrow label')].map((e) => e.title))
  check('L18 选中形状时,属性面板里出现三个成员', JSON.stringify(shapeBtns) === JSON.stringify(['矩形', '菱形', '椭圆']), shapeBtns.join(','))
  await p.evaluate(() => [...document.querySelectorAll('.excalidraw .amx-panelrow label')].find((e) => e.title === '椭圆')?.click())
  await p.waitForTimeout(300)
  check('L18 在面板里换成员真的切了工具',
    await p.evaluate(() => !!document.querySelector('.excalidraw .amx-panelrow label[title="椭圆"][data-on]')))
  await p.keyboard.press('4') // 走开
  await p.waitForTimeout(250)
  await p.keyboard.press('2') // 再回来
  await p.waitForTimeout(300)
  check('L18 合并按钮记住了最近用过的成员(回来还是椭圆)',
    await p.evaluate(() => !!document.querySelector('.excalidraw .amx-panelrow label[title="椭圆"][data-on]')))
  await p.keyboard.press('2')
  await p.waitForTimeout(300)
  check('L18 连按同一个数字**不**在组内循环(用户明确选的语义)',
    await p.evaluate(() => !!document.querySelector('.excalidraw .amx-panelrow label[title="椭圆"][data-on]')))
  await p.keyboard.press('3')
  await p.waitForTimeout(300)
  const lineBtns = await p.evaluate(() => [...document.querySelectorAll('.excalidraw .amx-panelrow label')].map((e) => e.title))
  check('L18 线也合并了,成员切换同样在面板里', JSON.stringify(lineBtns) === JSON.stringify(['箭头', '线段']), lineBtns.join(','))

  // ── L19 荧光笔按钮 = 主工具栏直达那支笔;点「画笔」要把它卸干净 ──
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="highlighter"]')?.click())
  await p.waitForTimeout(600)
  check('L19 点荧光笔按钮 = 切到自由画笔并选中荧光笔',
    await p.evaluate(() => !!document.querySelector('.amx-toolbar [data-tool="highlighter"][data-on]')),
    await p.evaluate(() => [...document.querySelectorAll('.amx-toolbar [data-tool]')].filter((b) => b.dataset.on !== undefined).map((b) => b.dataset.tool).join(',') || '一颗都没亮'))
  check('L19 工具栏那颗和面板里那支是同一支(笔的选中态单源)',
    await p.evaluate(() => !!document.querySelector('.excalidraw .amx-penrow label[title="荧光笔"][data-on]')),
    await p.evaluate(() => [...document.querySelectorAll('.excalidraw .amx-penrow label')].map((l) => l.title + (l.dataset.on !== undefined ? '*' : '')).join(' ') || '面板里没有笔排'))
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="freedraw"]')?.click())
  await p.waitForTimeout(350)
  check('L19 点「画笔」把荧光参数卸掉(否则两颗按钮没区别)',
    await p.evaluate(() => !!document.querySelector('.amx-toolbar [data-tool="freedraw"][data-on]') &&
      !document.querySelector('.excalidraw .amx-penrow label[data-on]')))

  // ── L22 荧光笔专用面板(2026-08-14 用户要求)──
  // 四件事:①不带描边 ②快选色的橙换成黄(且切走就还原)③方头/圆头**真的画得不一样** ④宽度 5 档留着。
  // ⚠️ ③ 是重点哨兵:第一版把「方/圆」写成只翻 cap,而实测 cap 只有在 thinning=0 时才生效 ——
  //    thinning=1 下两种 cap 的笔迹**逐像素相同**,那就是一颗死按钮。这条钉的就是它别再死回去。
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="freedraw"]')?.click())
  await p.waitForTimeout(450)
  const picksOf = () => p.evaluate(() =>
    [...document.querySelectorAll('.excalidraw button[data-testid^="color-top-pick-"]')].map((b) => b.dataset.testid.replace('color-top-pick-', '')))
  const plainPicks = await picksOf()
  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="highlighter"]')?.click())
  await p.waitForTimeout(550)
  const hlPicks = await picksOf()
  check('L22 荧光笔档下快选色的橙换成了黄(走 appState.colorPalette,不进存档)',
    plainPicks[4] === '#f08c00' && hlPicks[4] === '#ffd43b' && hlPicks.slice(0, 4).join() === plainPicks.slice(0, 4).join(),
    `普通笔 ${plainPicks.slice(0, 5).join(',')} → 荧光笔 ${hlPicks.slice(0, 5).join(',')}`)
  check('L22 宽度 5 档仍在(用户要求保留)', await p.evaluate(() => document.querySelectorAll('.excalidraw [data-testid^="strokeWidth-"]').length) === 5)
  check('L22 笔触两颗在,且默认方头',
    await p.evaluate(() => {
      const l = [...document.querySelectorAll('.excalidraw .amx-panelrow label')].map((e) => e.title + (e.dataset.on !== undefined ? '*' : ''))
      return l.join(',') === '方头*,圆头'
    }), await p.evaluate(() => [...document.querySelectorAll('.excalidraw .amx-panelrow label')].map((e) => e.title + (e.dataset.on !== undefined ? '*' : '')).join(',')))

  /** 末端墨迹高度剖面:方头 = 满高到底一刀切;圆头 = 末尾多出一段收拢的圆顶。 */
  const capProfile = async (y) => {
    const pts = []
    for (let x = 660; x <= 716; x += 4) for (let dy = -45; dy <= 45; dy++) pts.push([Math.round(box.x + x), Math.round(box.y + y) + dy])
    const px = await probes(p, pts)
    const out = []
    for (let i = 0; i < px.length; i += 91) out.push(px.slice(i, i + 91).filter((c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 250).length)
    return out
  }
  const capStroke = async (y) => {
    await p.mouse.move(box.x + 300, box.y + y)
    await p.mouse.down()
    await p.mouse.move(box.x + 700, box.y + y, { steps: 16 })
    await p.mouse.up()
    await p.waitForTimeout(450)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(250)
  }
  /** ⚠️ 点荧光笔按钮是 **toggle**:已经选中时再点一次 = 取消选中(pickPen 的语义)。
   *  仪器里必须先看 data-on 再决定点不点,否则「连点两次」= 两笔都用普通笔画,
   *  两条剖面当然一模一样,这条就成了假红(栽过一次)。 */
  const ensureHighlighter = async () => {
    if (await p.evaluate(() => !!document.querySelector('.amx-toolbar [data-tool="highlighter"][data-on]'))) return
    await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="highlighter"]')?.click())
    await p.waitForTimeout(500)
  }
  await p.mouse.click(box.x + 800, box.y + 680)
  await p.keyboard.press('Control+a')
  await p.keyboard.press('Delete')
  await p.keyboard.press('Control+0')
  await p.waitForTimeout(400)
  await ensureHighlighter()
  await capStroke(200)
  const squareProf = await capProfile(200)
  const hlEl = await p.evaluate(() => {
    const e = (window.__scene?.elements ?? []).filter((x) => x.type === 'freedraw' && !x.isDeleted).pop()
    const so = e?.customData?.strokeOptions
    return so ? { hasOutline: so.hasOutline, thinning: so.options?.thinning, cap: so.options?.start?.cap } : null
  })
  check('L22 荧光笔不带描边(hasOutline=false),且 thinning 归零(端头开关的前提)',
    !!hlEl && hlEl.hasOutline === false && hlEl.thinning === 0, JSON.stringify(hlEl))

  await ensureHighlighter()
  const gotRound = await p.evaluate(() => {
    const l = [...document.querySelectorAll('.excalidraw .amx-panelrow label')].find((e) => e.title === '圆头')
    if (!l) return false
    l.click()
    return true
  })
  await p.waitForTimeout(500)
  await capStroke(400)
  const roundProf = await capProfile(400)
  check('L22 方头 / 圆头画出来真的不一样(不是死按钮)',
    gotRound && JSON.stringify(squareProf) !== JSON.stringify(roundProf) && roundProf.filter(Boolean).length > squareProf.filter(Boolean).length,
    `点到圆头=${gotRound} 方头 ${squareProf.join(',')} | 圆头 ${roundProf.join(',')}`)

  await p.evaluate(() => document.querySelector('.amx-toolbar [data-tool="freedraw"]')?.click())
  await p.waitForTimeout(500)
  check('L22 切走荧光笔后调色盘还原(别把黄留给普通笔)', (await picksOf())[4] === '#f08c00')

  // ── L20 弹层的皮:它**不在画布里**(引擎 portal 到 document.body 的另一个 .excalidraw 根)──
  // 少了标记类 → 主题桥够不着 → 弹层字体/圆角/配色全是引擎原样,和触发器两张皮。
  await p.click('.excalidraw [data-testid="main-menu-trigger"]')
  await p.waitForTimeout(400)
  const pop = await p.evaluate(() => {
    const menu = document.querySelector('.dropdown-menu .Island')
    const root = document.querySelector('.dropdown-menu')?.closest('.excalidraw')
    const trig = document.querySelector('.excalidraw [data-testid="main-menu-trigger"]')
    if (!menu || !root || !trig) return null
    const f = (e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '')
    return { outsideHost: !root.closest('.amx-boardhost'), tagged: root.classList.contains('amx-board-portal'), menuFont: f(menu), trigFont: f(trig) }
  })
  check('L20 弹层确实在画布外(引擎 portal 到 body)——这就是它够不着主题桥的原因', !!pop && pop.outsideHost)
  check('L20 弹层挂上了 amx-board-portal 标记类', !!pop && pop.tagged)
  check('L20 弹层的字跟触发器同一套(= 主题桥真的够到了)', !!pop && pop.menuFont === pop.trigFont,
    pop ? `弹层=${pop.menuFont} 触发器=${pop.trigFont}` : '没量到')
  await p.keyboard.press('Escape')
  await p.waitForTimeout(200)

  // ── L21 端级 UI 缩放:光标偏移的哨兵 ──
  // `Element.currentCSSZoom` 规范规定「元素未参与渲染时返回 1」—— 白板在隐藏的 Dockview 面板里挂载时
  // 读到 1,反补偿被跳过,而唯一的重算信号 UI_ZOOM_EVENT 只在用户**改**缩放时才发 → 那块画布从此一直偏
  // (2026-08-14 用户报的「墨迹落在光标旁边」)。修法是 ResizeObserver 也当信号;这条钉的就是它。
  await p.evaluate(() => {
    document.body.style.zoom = '1.25'
    document.querySelector('.amx-drawview').style.display = 'none' // 先藏起来:模拟后台 tab
  })
  await p.waitForTimeout(200)
  await p.evaluate(() => { document.querySelector('.amx-boardhost').style.zoom = '' }) // 抹掉补偿,当作它没算过
  await p.evaluate(() => { document.querySelector('.amx-drawview').style.display = '' }) // 露出来
  await p.waitForTimeout(500)
  const z = await p.evaluate(() => document.querySelector('.amx-boardhost').style.zoom)
  check('L21 隐藏时挂载、露出后补偿会自己补上(否则光标与落点全程错位)',
    !!z && Math.abs(Number(z) - 1 / 1.25) < 0.01, `实得 zoom=${z || '(空)'} 期望 ${(1 / 1.25).toFixed(3)}`)
  // 弹层也得跟着同一份补偿,否则它在 body 的缩放空间里被放大并错位(实测 1.1 偏 27px)
  await p.click('.excalidraw [data-testid="main-menu-trigger"]')
  await p.waitForTimeout(400)
  check('L21 弹层跟着同一份 zoom 补偿(否则菜单被放大并整体错位)',
    await p.evaluate(() => {
      const root = document.querySelector('.dropdown-menu')?.closest('.excalidraw')
      return !!root && root.style.zoom === document.querySelector('.amx-boardhost').style.zoom
    }))
  await p.evaluate(() => { document.body.style.zoom = '' })

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
