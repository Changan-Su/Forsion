/**
 * 输入框「上下文进度圈」详情浮层的开合契约(真 Chromium 断言)。
 *
 * 2026-08-24 起由 hover 改为**点击**开合(`.t2c-ctxring.is-open .t2c-ctxring-pop`):
 * 悬停式浮层与圆圈之间那 8px 空隙谁都不占,鼠标往上走 hover 就断,里面唯一的
 * 「压缩上下文」按钮点不到,当年靠一条 ::after 透明桥补的——点击式不需要那条桥。
 * 这个仪器现在钉的是:①平时不显示 ②光悬停不弹(防退回 hover 式)③点击弹出
 * ④与圆环左对齐 ⑤压缩按钮点得到 ⑥点浮层外收起。
 *
 * 页面直接注入仓里真实的 composer2.css(不复制样式),故不会与源码漂移;
 * 开合的那点 JS 是 Composer2 的 `openMenu === 'ctx'` + `[data-cmenu]` 外点关的复刻。
 * 改 .t2c-ctxring* 任何一条样式后必跑。
 *
 * 跑:node scripts/ctxring.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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
    <span class="t2c-ctxring" data-cmenu>
      <button type="button" class="t2c-ctxring-btn" aria-label="上下文 14%">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle class="t2c-ctxring-track" cx="12" cy="12" r="9"></circle>
          <circle class="t2c-ctxring-fill" cx="12" cy="12" r="9" style="stroke-dasharray:56.5;stroke-dashoffset:48.6"></circle>
        </svg>
      </button>
      <span class="t2c-ctxring-pop">
        <span class="t2c-ctxring-pct">上下文 14%</span>
        <span>17.6k / 128k tokens</span>
        <button class="t2c-ctxring-compact" id="compact">压缩上下文</button>
      </span>
    </span>
  </div>
  <script>
    // Composer2 的 openMenu==='ctx' 复刻:点圆环切换,点 [data-cmenu] 外收起
    const ring = document.querySelector('.t2c-ctxring')
    ring.querySelector('.t2c-ctxring-btn').addEventListener('click', () => ring.classList.toggle('is-open'))
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('[data-cmenu]')) ring.classList.remove('is-open') })
    window.__compacted = false
    document.getElementById('compact').addEventListener('click', () => { window.__compacted = true; ring.classList.remove('is-open') })
  </script>
</body></html>`

const box = (sel) => {
  const r = document.querySelector(sel).getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
const popShown = () => getComputedStyle(document.querySelector('.t2c-ctxring-pop')).display !== 'none'

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await p.setContent(PAGE)

  check('初始不显示详情浮层', !(await p.evaluate(popShown)))

  const ring = await p.evaluate(box, '.t2c-ctxring')
  await p.mouse.move(ring.x, ring.y)
  check('⚠️只悬停不弹出(2026-08-24 改点击式,退回 hover 即红)', !(await p.evaluate(popShown)))

  await p.mouse.down()
  await p.mouse.up()
  check('点击进度圈弹出详情浮层', await p.evaluate(popShown))

  // 浮层与圆环左对齐(用户要求;此前是 right:0 右对齐,浮层往左甩出去一大截)
  const pop = await p.evaluate(() => document.querySelector('.t2c-ctxring-pop').getBoundingClientRect().left)
  const ringL = await p.evaluate(() => document.querySelector('.t2c-ctxring').getBoundingClientRect().left)
  check('详情浮层与圆环左对齐', Math.abs(pop - ringL) < 1, `pop.left=${pop.toFixed(1)} ring.left=${ringL.toFixed(1)}`)

  const btn = await p.evaluate(box, '.t2c-ctxring-compact')
  await p.mouse.move(btn.x, btn.y, { steps: 12 })
  await p.mouse.down()
  await p.mouse.up()
  check('能点到「压缩上下文」', await p.evaluate(() => window.__compacted))

  // 外点收起(压缩那下已顺带关掉,重开一次再验)
  await p.mouse.move(ring.x, ring.y); await p.mouse.down(); await p.mouse.up()
  await p.mouse.move(ring.x + 300, ring.y + 200); await p.mouse.down(); await p.mouse.up()
  check('点浮层外收起', !(await p.evaluate(popShown)))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
