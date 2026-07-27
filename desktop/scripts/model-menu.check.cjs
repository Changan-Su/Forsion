/**
 * 模型菜单(ModelPill 两级形)的几何契约 —— 全是 CSS 层面的、改样式会静默塌掉的东西:
 *
 *  A 打开时药丸撑到与菜单同宽、右缘对齐(用户要的「展开对齐」)。
 *  B 展开走的是**可插值**属性:width:auto→224px 不可插值、动画根本不跑,故必须是 min-width。
 *    钉法是查 transition 是否真的产生了一条 min-width 的 CSSTransition,不是查声明字符串。
 *  C 子面板不被菜单裁掉:.composer-menu 通用规则带 overflow-y:auto,变体必须改回 visible,
 *    否则子面板整块被裁 → 表现为「点了行没反应」。用 elementFromPoint 打命中,裁切会漏出来。
 *  D .flip 生效:加上 flip class 后子面板整个落到菜单**左**侧(翻面的另一半是 JS 决策,
 *    那部分在 frontend/src/components/modelPill.test.ts 里钉,含 zoom≠1 的坐标系换算)。
 *
 * 改 .model-pill-btn / .composer-menu--model / .cm-sub 任何一条样式后必跑。
 * 跑:node scripts/model-menu.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/styles/base.css'), 'utf8')

const ic = (n) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/></svg>`
const item = (name, on) =>
  `<button class="menu-item${on ? ' active' : ''}"><span class="grow">${name}</span><span class="mi-check">${on ? '✓' : ''}</span></button>`

/** 复刻 ModelPill 的 DOM(见 components/ModelPill.tsx);开合由测试脚本切 is-open。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
body { margin: 0; }
/* 药丸在输入框底排右端:离视口右缘还有点余量,子面板默认能贴右侧 */
.row { position: absolute; right: 260px; top: 420px; display: flex; align-items: center; gap: 8px; }
button { font: inherit; background: none; border: 0; cursor: pointer; }
</style></head><body>
<div class="row">
  <span class="model-pill-wrap" data-cmenu>
    <button class="composer-chip model-pill-btn">
      ${ic(13)}<span class="pill-marquee"><span class="pill-marquee__inner">GLM-4.7 · 深</span></span>${ic(10)}
    </button>
    <div class="composer-menu composer-menu--model">
      <button class="cm-row is-open"><span class="cm-row-k">模型</span><span class="cm-row-v">GLM-4.7</span>${ic(13)}</button>
      <button class="cm-row"><span class="cm-row-k">思考</span><span class="cm-row-v">深</span>${ic(13)}</button>
      <div class="cm-sub" data-pane="model">
        <div class="menu-section">zhipu</div>
        ${item('GLM-4.7', true)}${item('GLM-4.6')}${item('GLM-4.5-Air')}
        <div class="menu-section">deepseek</div>
        ${item('DeepSeek-V3.2-Exp')}${item('DeepSeek-R1')}
      </div>
    </div>
  </span>
</div>
</body></html>`

const box = (sel) => {
  const r = document.querySelector(sel).getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await p.setContent(PAGE)

  // ── B:开 / 收**各采样一遍宽度轨迹**。只查「有没有过渡对象」是不够的:min-width 那版
  //    getAnimations() 照样报 min-width 在动,但可见区间只占动画区间的一小段,收起来是瞬变的。
  //    钉的必须是「中途真的停在中间某个宽度上」。 ──
  const closedW = (await p.evaluate(box, '.model-pill-btn')).w
  const trace = (openIt) => p.evaluate((on) => new Promise((res) => {
    const el = document.querySelector('.model-pill-btn')
    document.querySelector('.model-pill-wrap').classList.toggle('is-open', on)
    el.classList.toggle('is-open', on)
    const out = []
    const t0 = performance.now()
    const tick = () => {
      out.push([performance.now() - t0, el.getBoundingClientRect().width])
      if (performance.now() - t0 < 240) requestAnimationFrame(tick)
      else res(out)
    }
    requestAnimationFrame(tick)
  }), openIt)
  const midOf = (tr, lo, hi) => tr.filter(([t]) => t > 40 && t < 140).filter(([, w]) => w > lo + 8 && w < hi - 8).length

  const opening = await trace(true)
  const openW = opening[opening.length - 1][1]
  check('展开有动画:中途停在自然宽与终宽之间(不是瞬变)', midOf(opening, closedW, openW) >= 3,
    `${closedW.toFixed(1)} → ${openW.toFixed(1)},中间帧 ${midOf(opening, closedW, openW)}`)
  await p.evaluate(() => document.querySelector('.model-pill-btn').classList.add('is-open'))

  const closing = await trace(false)
  check('⚠️收回也有动画:min-width 那版这里是瞬变(可见区间只占动画区间的一小截)',
    midOf(closing, closedW, openW) >= 3,
    `${openW.toFixed(1)} → ${closedW.toFixed(1)},中间帧 ${midOf(closing, closedW, openW)}`)

  // 复位到打开态,继续量几何
  await p.evaluate(() => {
    document.querySelector('.model-pill-wrap').classList.add('is-open')
    document.querySelector('.model-pill-btn').classList.add('is-open')
  })
  // 菜单/子面板的入场 pop 动画会 scale,跑着的时候量 rect 全是缩过的:先一律推到终态。
  await p.evaluate(() => document.getAnimations().forEach((a) => a.finish()))

  // ── A:打开后药丸与菜单等宽 + 右缘对齐 ──
  const btn = await p.evaluate(box, '.model-pill-btn')
  const menu = await p.evaluate(box, '.composer-menu--model')
  check('打开时药丸与菜单等宽', Math.abs(btn.w - menu.w) < 1, `btn=${btn.w.toFixed(1)} menu=${menu.w.toFixed(1)}`)
  check('打开时药丸与菜单右缘对齐', Math.abs(btn.right - menu.right) < 1, `btn.right=${btn.right.toFixed(1)} menu.right=${menu.right.toFixed(1)}`)
  check('展开确实变宽了(不是本来就同宽 → 上面两条会变成废断言)', btn.w > closedW + 20, `${closedW.toFixed(1)} → ${btn.w.toFixed(1)}`)

  // ── C:子面板没被菜单裁掉(命中测试;裁切不会改 rect,只会改可见性与命中) ──
  const sub = await p.evaluate(box, '.cm-sub')
  const hit = await p.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el ? !!el.closest('.cm-sub') : false
  }, { x: sub.cx, y: sub.cy })
  check('⚠️子面板不被菜单 overflow 裁掉(裁了=点了行没反应)', hit, `sub=${sub.left.toFixed(1)}..${sub.right.toFixed(1)}`)
  check('子面板默认贴在菜单右侧', sub.left >= menu.right - 1, `sub.left=${sub.left.toFixed(1)} menu.right=${menu.right.toFixed(1)}`)
  // bottom:0 参照的是菜单的 padding box,故正常就差一条边框(1px)。
  check('子面板底边与菜单底对齐、向上生长(向下会盖住输入框)', Math.abs(sub.bottom - menu.bottom) <= 2,
    `sub.bottom=${sub.bottom.toFixed(1)} menu.bottom=${menu.bottom.toFixed(1)}`)

  // ── D:.flip 把子面板整块搬到菜单左侧 ──
  await p.evaluate(() => document.querySelector('.cm-sub').classList.add('flip'))
  const flipped = await p.evaluate(box, '.cm-sub')
  check('.flip 生效:子面板整块落到菜单左侧', flipped.right <= menu.left + 1,
    `sub.right=${flipped.right.toFixed(1)} menu.left=${menu.left.toFixed(1)}`)

  // ── E:扁平/立体开关。阴影必须走 --card-shadow 这类高程 token —— 写死 `0 10px 32px var(--shadow)`
  //    在扁平模式下照样投影(用户实报)。立体态那半边同样要钉,否则「全都写死 none」也能骗过去。 ──
  const shadows = (flat) => p.evaluate((f) => {
    document.documentElement.dataset.mode = 'light'
    document.documentElement.dataset.flat = f
    return ['.composer-menu--model', '.cm-sub'].map((s) => getComputedStyle(document.querySelector(s)).boxShadow)
  }, flat)
  const raised = await shadows('0')
  const flat = await shadows('1')
  check('立体态(data-flat=0)菜单与子面板都有阴影', raised.every((s) => s && s !== 'none'), raised.join(' / '))
  check('⚠️扁平态(data-flat=1)菜单与子面板阴影一并消失', flat.every((s) => s === 'none'), flat.join(' / '))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
