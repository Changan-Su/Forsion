/**
 * 输入框「上下文进度圈」悬浮层可达性契约(真 Chromium 断言)。
 *
 * 为什么存在:「压缩上下文」这个操作**唯一的按钮**住在进度圈的 hover 浮层里
 * (`.t2c-ctxring:hover .t2c-ctxring-pop`)。浮层用 `bottom: calc(100% + 8px)` 抬高,
 * 那 8px 是**谁都不占的空隙**——鼠标从圆圈往上走的一瞬间既不在圆圈上也不在浮层上,
 * hover 断掉 → 浮层 display:none → 按钮永远点不到(用户口径:「压缩不可用」)。
 * 修法是给浮层补一条透明桥(::after 铺满那 8px),视觉不变、hover 连续。
 *
 * 关键:必须用**分步移动**的鼠标(steps)模拟真人轨迹。Playwright 的 locator.click()
 * 是一步瞬移到目标,浮层还没来得及消失就命中了按钮——那样测什么都是绿的。
 *
 * 页面直接注入仓里真实的 composer2.css(不复制样式),故不会与源码漂移。
 * 改 .t2c-ctxring* 任何一条样式后必跑。
 *
 * 跑:node scripts/ctxring-hover.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/views/chat2/composer2.css'), 'utf8')

/** 复刻 Composer2 的进度圈结构(见 Composer2.tsx 的 t2c-ctxring 块)。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee;
          --overlay-medium:#ddd; --text:#111; --text-muted:#666; --accent-ink:#4a6; --font-ui:system-ui; }
  body { margin:0; }
  /* 圈子在输入框底排,离视口顶足够远,浮层才有地方往上弹 */
  .row { position:absolute; left:200px; top:300px; display:flex; align-items:center; }
  ${CSS}
</style></head><body>
  <div class="row">
    <span class="t2c-ctxring">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle class="t2c-ctxring-track" cx="12" cy="12" r="9"></circle>
        <circle class="t2c-ctxring-fill" cx="12" cy="12" r="9" style="stroke-dasharray:56.5;stroke-dashoffset:48.6"></circle>
      </svg>
      <span class="t2c-ctxring-pop">
        <span class="t2c-ctxring-pct">上下文 14%</span>
        <span>17,607 / 128,000 tokens</span>
        <button class="t2c-ctxring-compact" id="compact">压缩上下文</button>
      </span>
    </span>
  </div>
  <script>
    window.__compacted = false
    document.getElementById('compact').addEventListener('click', () => { window.__compacted = true })
  </script>
</body></html>`

const box = (sel) => {
  const r = document.querySelector(sel).getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom }
}
const popShown = () => getComputedStyle(document.querySelector('.t2c-ctxring-pop')).display !== 'none'

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await p.setContent(PAGE)

  const ring = await p.evaluate(box, '.t2c-ctxring')
  await p.mouse.move(ring.x, ring.y)
  check('悬停进度圈弹出详情浮层', await p.evaluate(popShown))

  // 浮层与圆环左对齐(用户要求;此前是 right:0 右对齐,浮层往左甩出去一大截)
  const pop = await p.evaluate(() => {
    const r = document.querySelector('.t2c-ctxring-pop').getBoundingClientRect()
    return { left: r.left, right: r.right }
  })
  const ringL = await p.evaluate(() => document.querySelector('.t2c-ctxring').getBoundingClientRect().left)
  check('详情浮层与圆环左对齐', Math.abs(pop.left - ringL) < 1, `pop.left=${pop.left.toFixed(1)} ring.left=${ringL.toFixed(1)}`)

  const btn = await p.evaluate(box, '.t2c-ctxring-compact')
  // 空隙中点:浮层底缘与圆圈顶缘之间。真人的鼠标必经此处。
  const gapY = await p.evaluate(() => {
    const pop = document.querySelector('.t2c-ctxring-pop').getBoundingClientRect()
    const ring = document.querySelector('.t2c-ctxring').getBoundingClientRect()
    return (pop.bottom + ring.top) / 2
  })
  await p.mouse.move(ring.x, gapY, { steps: 6 })
  check('⚠️鼠标经过圆圈与浮层之间的空隙时浮层不消失(消失=压缩按钮永远点不到)', await p.evaluate(popShown),
    `gapY=${gapY.toFixed(1)} ringTop=${ring.top.toFixed(1)}`)

  // 真人轨迹:分步移到按钮再点(不是 locator.click 的一步瞬移——那会掩盖 hover 断裂)
  await p.mouse.move(btn.x, btn.y, { steps: 12 })
  await p.mouse.down()
  await p.mouse.up()
  check('沿真人轨迹能点到「压缩上下文」', await p.evaluate(() => window.__compacted))

  // 反向:移开后浮层必须收起(别把桥做成常显)
  await p.mouse.move(ring.x + 300, ring.y + 200, { steps: 8 })
  check('鼠标移开后浮层收起', !(await p.evaluate(popShown)))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
