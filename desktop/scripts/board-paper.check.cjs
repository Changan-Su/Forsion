/**
 * 白板「纸张 + 网格 + 紧凑面板」的**合成契约**。这里量的全是 vitest 量不到的东西 ——
 * 混合模式的最终像素、clip-path 的命中测试、以及第三方 CSS 里谁压过谁。
 * (几何与钳制那部分是纯函数,归 shared/amadeus/excalidraw/board.test.ts 管,别在这儿重复。)
 *
 *  A 网格看得见:白纸上网格线位置的像素比空白处暗(multiply 真的生效了)。
 *  B 网格在内容之下:黑笔画上的网格线不该把笔画冲淡 —— 这正是选 multiply 而不是直接铺一层灰的理由。
 *  C ⚠️ 层叠上下文陷阱:把 .amx-grid 包进任何带 z-index 的容器,混合就只在容器内部发生,
 *    网格立刻从「内容之下」变成「盖在内容之上的一层灰」。本条把这个失败形态钉死 —— 有人图省事
 *    加个包裹层时,它会先红。
 *  D clip-path(evenodd)真的改命中测试:纸外点中遮罩(= 越界不可画),纸内穿到画布(照常画)。
 *  (深色 screen 与紧凑面板已迁去 board-live.check.cjs 的 L15 / L6,理由见文末。)
 *
 * 改 amadeus-host.css 的 .amx-* / 升级 @excalidraw/excalidraw 后必跑:node scripts/board-paper.check.cjs
 */
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

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const HOST_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/amadeus-host.css'), 'utf8')
const EXCALIDRAW_CSS = fs.readFileSync(path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/index.css'), 'utf8')

// 纸张(50,50)+300×300,网格 25px;黑笔画盖住 (60,60)-(160,160)。
// 竖线落在 x = 50/75/100/125…,横线同理 → (100,85) 是「线压在黑笔画上」,(85,85) 是「黑笔画空白处」。
const PAPER = { x: 50, y: 50, w: 300, h: 300 }
const STEP = 25
/** 取样行:必须**避开横线**(50/75/100… 都是横线),否则整行都是线色,量什么都一样。 */
const ROW = 210
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${EXCALIDRAW_CSS}
${HOST_CSS}
html,body{margin:0;background:#888}
#stage{width:600px;height:400px}
.excalidraw{position:relative;width:100%;height:100%}
canvas.excalidraw__canvas{position:absolute;left:0;top:0;z-index:1}
</style></head><body>
<div id="stage" class="amx-boardhost">
  <div id="ex" class="excalidraw">
    <canvas class="excalidraw__canvas static" id="cv" width="600" height="400"></canvas>
    <div class="amx-matte" id="matte"></div>
    <div class="amx-grid" id="grid"></div>
  </div>
</div>
<script>
const P = ${JSON.stringify(PAPER)}, S = ${STEP}
function paint(bg, ink) {
  const c = document.getElementById('cv').getContext('2d')
  c.fillStyle = bg; c.fillRect(0, 0, 600, 400)
  c.fillStyle = ink; c.fillRect(60, 60, 100, 100)
}
function place() {
  const g = document.getElementById('grid')
  Object.assign(g.style, { left: P.x+'px', top: P.y+'px', width: P.w+'px', height: P.h+'px',
    backgroundImage: 'linear-gradient(90deg, var(--amx-grid-line) 0 1px, transparent 1px), linear-gradient(180deg, var(--amx-grid-line) 0 1px, transparent 1px)',
    backgroundSize: S+'px 100%, 100% '+S+'px', backgroundPosition: '0px 0px, 0px 0px' })
  document.getElementById('matte').style.clipPath =
    'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
    P.x+'px '+P.y+'px, '+(P.x+P.w)+'px '+P.y+'px, '+(P.x+P.w)+'px '+(P.y+P.h)+'px, '+P.x+'px '+(P.y+P.h)+'px, '+P.x+'px '+P.y+'px)'
}
paint('#ffffff', '#000000'); place()
</script>
</body></html>`

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 640, height: 440 }, deviceScaleFactor: 1 })
  await p.setContent(PAGE)

  /** 截图后回灌进页面读像素 —— mix-blend-mode 的合成结果 JS 直接读不到,只有截图看得见。 */
  const shot = async () => {
    const b64 = (await p.screenshot({ clip: { x: 0, y: 0, width: 600, height: 400 } })).toString('base64')
    await p.evaluate(async (b64) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      c.getContext('2d').drawImage(img, 0, 0)
      window.__probe = (x, y) => [...c.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3)
    }, b64)
  }
  const px = (x, y) => p.evaluate(([x, y]) => window.__probe(x, y), [x, y])
  const lum = (c) => (c[0] + c[1] + c[2]) / 3

  // ── 浅色:A 网格可见 / B 网格在内容之下 ──
  await shot()
  const onLine = await px(PAPER.x + STEP, ROW) // 竖线,压在白纸上
  const offLine = await px(PAPER.x + STEP + 8, ROW) // 同一行的空白
  check('A 浅色下网格线比纸面暗(multiply 生效)', lum(onLine) < lum(offLine) - 10 && lum(offLine) > 240,
    `线=${onLine} 空白=${offLine}`)

  const inkPlain = await px(85, 85) // 黑笔画空白处
  const inkOnLine = await px(100, 85) // 竖线正压在黑笔画上
  check('B 网格不冲淡黑笔画(视觉上在内容之下)', lum(inkPlain) < 12 && lum(inkOnLine) < 12,
    `笔画=${inkPlain} 笔画上的线=${inkOnLine}`)

  // ── D clip-path 的命中测试 ──
  const hitOut = await p.evaluate(() => document.elementFromPoint(20, 20)?.className)
  const hitIn = await p.evaluate(() => document.elementFromPoint(250, 250)?.className)
  check('D 纸外点中遮罩 = 越界不可画', String(hitOut).includes('amx-matte'), `实得=${hitOut}`)
  // 纸内只要不落在这两层上就算穿透(真 excalidraw 里接手的是 interactive 画布;静态画布本身 pointer-events:none)
  check('D 纸内穿透两层 = 照常画', !/amx-matte|amx-grid/.test(String(hitIn)), `实得=${hitIn}`)

  // ── C 层叠上下文陷阱:包一层带 z-index 的容器,混合立刻失效 ──
  await p.evaluate(() => {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:absolute;inset:0;z-index:3'
    const g = document.getElementById('grid')
    g.parentElement.appendChild(wrap)
    wrap.appendChild(g)
  })
  await shot()
  const trapped = await px(100, 85)
  check('C 拿带 z-index 的容器包住 .amx-grid → 网格改盖在笔画之上(所以永远别包)',
    lum(trapped) > 60, `实得=${trapped}(该是灰而不是黑,说明混合被容器隔离了)`)
  await p.evaluate(() => {
    const g = document.getElementById('grid')
    const wrap = g.parentElement
    document.getElementById('ex').appendChild(g)
    wrap.remove()
  })

  // E(深色 screen)与 F(紧凑面板)已迁走,2026-08-13 换 zsviczian 引擎那次:
  // - E:深色档到底怎么画,是**引擎的实现细节**(上游 0.18.1 是 CSS 反相白画布,fork 改成原生画深色)。
  //   合成页必须替它假设一种,一换引擎就假红/假绿 —— 现在归 board-live 的 L15,直接量真画布的像素。
  // - F:紧凑/托盘现在是引擎自带的真档位,我们那套压 .App-menu__left 的 CSS 已删 → 归 board-live 的 L6。

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
