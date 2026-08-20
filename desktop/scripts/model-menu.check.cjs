/**
 * 模型 / Effort 菜单的几何契约 —— 全是 CSS 层面的、改样式会静默塌掉的东西:
 *
 *  A 打开时药丸撑到与菜单同宽、右缘对齐(用户要的「展开对齐」)。
 *  B 展开走的是**可插值**属性:width:auto→224px 不可插值、动画根本不跑,故必须是 min-width。
 *    钉法是查 transition 是否真的产生了一条 min-width 的 CSSTransition,不是查声明字符串。
 *  C 子面板不被菜单裁掉:.composer-menu 通用规则带 overflow-y:auto,变体必须改回 visible,
 *    否则子面板整块被裁 → 表现为「点了行没反应」。用 elementFromPoint 打命中,裁切会漏出来。
 *  D 主面板固定为「高级 → 模型 → Effort」且 Effort 是可拖动 range；Max 有独立渐变 / 星点层。
 *  E 高级内容从高级行上方向上展开，卡片有高度过渡且高级 / 模型 / Effort 三行不位移。
 *  F 模型 / 辅助 / 生图 / 识图共用 View 感知的右 → 左 → 上方落位；极窄 View 下仍不得越界。
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
const COMPOSER_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/views/chat2/composer2.css'), 'utf8')

const ic = (n) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/></svg>`
const item = (name, on) =>
  `<button class="menu-item${on ? ' active' : ''}"><span class="grow">${name}</span><span class="mi-check">${on ? '✓' : ''}</span></button>`

/** 复刻 ModelPill 的 DOM(见 components/ModelPill.tsx);开合由测试脚本切 is-open。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
${COMPOSER_CSS}
body { margin: 0; }
.model-stage { position: fixed; inset: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
/* 药丸在输入框底排右端:离视口右缘还有点余量,子面板默认能贴右侧 */
.row { position: absolute; right: 260px; top: 420px; display: flex; align-items: center; gap: 8px; }
button { font: inherit; background: none; border: 0; cursor: pointer; }
</style></head><body>
<div class="t2c-card" style="position:fixed;visibility:hidden;pointer-events:none"><textarea class="t2c-ta"></textarea></div>
<div class="model-stage t2c-card">
<div class="row t2c-row">
  <button class="t2c-pill">模式</button>
  <span class="model-pill-wrap" data-cmenu>
    <button class="composer-chip model-pill-btn">
      ${ic(13)}<span class="pill-marquee"><span class="pill-marquee__inner">GLM-4.7 · 深</span></span>${ic(10)}
    </button>
    <div class="composer-menu composer-menu--model">
      <div class="cm-advanced-reveal" aria-hidden="true"><div class="cm-advanced-reveal-inner"><div class="cm-advanced-list">
        <div class="cm-row cm-row--static"><span class="cm-row-k">推理强度</span><span class="cm-row-v is-max">Max</span></div>
        <button class="cm-row"><span class="cm-row-k">默认辅助模型</span><span class="cm-row-v">GLM-4.7</span>${ic(13)}</button>
        <button class="cm-row"><span class="cm-row-k">生图模型</span><span class="cm-row-v">Imagen 4</span>${ic(13)}</button>
        <button class="cm-row"><span class="cm-row-k">识图辅助模型</span><span class="cm-row-v">Gemini 2.5</span>${ic(13)}</button>
      </div></div></div>
      <button class="cm-row cm-advanced-toggle"><span class="cm-row-k">高级</span><span class="cm-row-v"></span>${ic(13)}</button>
      <button class="cm-row cm-model-row is-open"><span class="cm-row-k">模型</span><span class="cm-row-v">GLM-4.7</span>${ic(13)}</button>
      <div class="cm-effort is-max" data-effort="max">
        <div class="cm-effort-head"><span>Effort</span><span class="cm-effort-value">Max</span></div>
        <div class="cm-effort-ends"><span>更快</span><span>更智能</span></div>
        <div class="cm-effort-slider-wrap">
          <span class="cm-effort-track"><span class="cm-effort-range" style="width:100%"></span><span class="cm-effort-sparkles">${'<i></i>'.repeat(10)}</span></span>
          <span class="cm-effort-thumb" style="left:calc(100% - 12.5px)"></span>
          <input class="cm-effort-input" aria-label="推理强度" type="range" min="0" max="6" step="1" value="6">
        </div>
      </div>
      <div class="cm-sub" data-pane="model">
        <div class="menu-section">zhipu</div>
        ${item('GLM-4.7', true)}${item('GLM-4.6')}${item('GLM-4.5-Air')}
        <div class="menu-section">deepseek</div>
        ${item('DeepSeek-V3.2-Exp')}${item('DeepSeek-R1')}
      </div>
    </div>
  </span>
</div>
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
  await p.evaluate(() => document.querySelectorAll('.model-pill-btn,.composer-menu--model,.cm-sub').forEach((el) => el.getAnimations().forEach((a) => a.finish())))

  // ── A:打开后药丸与菜单等宽 + 右缘对齐 ──
  const btn = await p.evaluate(box, '.model-pill-btn')
  const menu = await p.evaluate(box, '.composer-menu--model')
  check('打开时药丸与菜单等宽', Math.abs(btn.w - menu.w) < 1, `btn=${btn.w.toFixed(1)} menu=${menu.w.toFixed(1)}`)
  check('打开时药丸与菜单右缘对齐', Math.abs(btn.right - menu.right) < 1, `btn.right=${btn.right.toFixed(1)} menu.right=${menu.right.toFixed(1)}`)
  check('展开确实变宽了(不是本来就同宽 → 上面两条会变成废断言)', btn.w > closedW + 20, `${closedW.toFixed(1)} → ${btn.w.toFixed(1)}`)
  const pillCenter = await p.evaluate(() => {
    const b = document.querySelector('.model-pill-btn').getBoundingClientRect()
    const l = document.querySelector('.model-pill-btn .pill-marquee').getBoundingClientRect()
    return { button: b.left + b.width / 2, label: l.left + l.width / 2 }
  })
  check('胶囊展开后「模型 · Effort」仍精确居中', Math.abs(pillCenter.button - pillCenter.label) < 0.6, JSON.stringify(pillCenter))
  const typeScale = await p.evaluate(() => ({
    chatbox: getComputedStyle(document.querySelector('.t2c-ta')).fontSize,
    mode: getComputedStyle(document.querySelector('.t2c-pill')).fontSize,
    model: getComputedStyle(document.querySelector('.model-pill-btn')).fontSize,
    menu: getComputedStyle(document.querySelector('.cm-model-row')).fontSize,
    helper: getComputedStyle(document.querySelector('.cm-effort-ends')).fontSize,
  }))
  check('Chatbox 字号阶梯固定为正文 13 / 胶囊与菜单 12 / 辅助 11',
    typeScale.chatbox === '13px' && typeScale.mode === '12px' && typeScale.model === '12px' && typeScale.menu === '12px' && typeScale.helper === '11px',
    JSON.stringify(typeScale))

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

  // ── D:主面板三行顺序 + 真 range + Max 特效层 ──
  const mainOrder = await p.evaluate(() => [...document.querySelector('.composer-menu--model').children]
    .filter((el) => el.matches('.cm-advanced-toggle,.cm-model-row,.cm-effort'))
    .map((el) => el.classList.contains('cm-advanced-toggle') ? 'advanced' : el.classList.contains('cm-model-row') ? 'model' : 'effort'))
  check('主面板顺序固定为 高级 → 模型 → Effort', mainOrder.join(',') === 'advanced,model,effort', mainOrder.join(' → '))
  const range = await p.evaluate(() => {
    const el = document.querySelector('.cm-effort-input')
    return { type: el?.getAttribute('type'), min: el?.getAttribute('min'), max: el?.getAttribute('max'), label: el?.getAttribute('aria-label') }
  })
  check('Effort 使用可拖动/键盘调节的原生 range(七档)', range.type === 'range' && range.min === '0' && range.max === '6' && !!range.label, JSON.stringify(range))
  const maxFx = await p.evaluate(() => ({
    bg: getComputedStyle(document.querySelector('.cm-effort-range')).backgroundImage,
    sparkles: document.querySelectorAll('.cm-effort-sparkles i').length,
    thumbGlow: getComputedStyle(document.querySelector('.cm-effort-thumb')).boxShadow,
  }))
  check('Max 有蓝紫渐变轨道 + 星点层 + 强化滑块', /gradient/.test(maxFx.bg) && maxFx.sparkles >= 8 && maxFx.thumbGlow !== 'none', JSON.stringify(maxFx))
  const effortOrder = await p.evaluate(() => [...document.querySelector('.cm-effort').children].map((el) => el.className))
  check('「更快 / 更智能」位于标题与拖动条之间', effortOrder.join('|').startsWith('cm-effort-head|cm-effort-ends|cm-effort-slider-wrap'), effortOrder.join(' → '))

  // ── E:高级内容从上方展开；菜单底锚不动，所以原三行也必须留在原位。 ──
  const advancedMotion = await p.evaluate(() => new Promise((resolve) => {
    const reveal = document.querySelector('.cm-advanced-reveal')
    const toggle = document.querySelector('.cm-advanced-toggle')
    const model = document.querySelector('.cm-model-row')
    const effort = document.querySelector('.cm-effort')
    const menu = document.querySelector('.composer-menu--model')
    const read = () => ({
      height: menu.getBoundingClientRect().height,
      advancedTop: toggle.getBoundingClientRect().top,
      modelTop: model.getBoundingClientRect().top,
      effortTop: effort.getBoundingClientRect().top,
    })
    const before = read()
    const frames = []
    const t0 = performance.now()
    reveal.classList.add('is-open')
    toggle.classList.add('is-open')
    const tick = () => {
      frames.push({ t: performance.now() - t0, ...read() })
      if (performance.now() - t0 < 300) requestAnimationFrame(tick)
      else resolve({ before, after: read(), frames, list: document.querySelector('.cm-advanced-list').getBoundingClientRect(), toggle: toggle.getBoundingClientRect() })
    }
    requestAnimationFrame(tick)
  }))
  const heightMids = advancedMotion.frames.filter((f) => f.t > 35 && f.t < 190 && f.height > advancedMotion.before.height + 8 && f.height < advancedMotion.after.height - 8).length
  check('高级卡片展开有连续高度动画', heightMids >= 3, `${advancedMotion.before.height.toFixed(1)} → ${advancedMotion.after.height.toFixed(1)},中间帧 ${heightMids}`)
  check('高级内容从高级行上方展开', advancedMotion.list.bottom <= advancedMotion.toggle.top + 1, `content.bottom=${advancedMotion.list.bottom.toFixed(1)} advanced.top=${advancedMotion.toggle.top.toFixed(1)}`)
  check('高级 / 模型 / Effort 三行展开时保持原位', ['advancedTop', 'modelTop', 'effortTop'].every((k) => Math.abs(advancedMotion.before[k] - advancedMotion.after[k]) < 1.5), JSON.stringify({ before: advancedMotion.before, after: advancedMotion.after }))

  // 档位变化时自绘滑块与填充都应在中途出现可见中间态，而不是从一档瞬跳到下一档。
  const effortMotion = await p.evaluate(() => new Promise((resolve) => {
    const thumb = document.querySelector('.cm-effort-thumb')
    const fill = document.querySelector('.cm-effort-range')
    const start = thumb.getBoundingClientRect().left
    const fillStart = fill.getBoundingClientRect().width
    thumb.style.left = 'calc(66.6667% - 4.1667px)'
    fill.style.width = '66.6667%'
    const frames = []
    const t0 = performance.now()
    const tick = () => {
      frames.push({ t: performance.now() - t0, left: thumb.getBoundingClientRect().left, fill: fill.getBoundingClientRect().width })
      if (performance.now() - t0 < 270) requestAnimationFrame(tick)
      else resolve({ start, fillStart, end: thumb.getBoundingClientRect().left, fillEnd: fill.getBoundingClientRect().width, frames })
    }
    requestAnimationFrame(tick)
  }))
  const thumbMids = effortMotion.frames.filter((f) => f.t > 25 && f.t < 180 && f.left < effortMotion.start - 3 && f.left > effortMotion.end + 3).length
  const fillMids = effortMotion.frames.filter((f) => f.t > 25 && f.t < 180 && f.fill < effortMotion.fillStart - 3 && f.fill > effortMotion.fillEnd + 3).length
  check('Effort 档位切换时滑块与填充都有中间过渡帧', thumbMids >= 3 && fillMids >= 3, `thumb=${thumbMids}, fill=${fillMids}`)

  // ── F:左侧与上方叠放都走 class，JS 的 View 边界决策由 menuAnchor.test.ts 钉。 ──
  await p.evaluate(() => document.querySelector('.cm-sub').classList.add('left'))
  const flipped = await p.evaluate(box, '.cm-sub')
  check('.left 生效:子面板整块落到菜单左侧', flipped.right <= menu.left + 1,
    `sub.right=${flipped.right.toFixed(1)} menu.left=${menu.left.toFixed(1)}`)

  await p.evaluate(() => {
    const stage = document.querySelector('.model-stage')
    const row = document.querySelector('.row')
    const sub = document.querySelector('.cm-sub')
    stage.style.inset = 'auto'
    stage.style.left = '400px'
    stage.style.top = '0'
    stage.style.width = '250px'
    stage.style.height = '700px'
    row.style.right = '16px'
    sub.classList.remove('left')
    sub.classList.add('stacked')
  })
  await p.evaluate(() => document.querySelectorAll('.composer-menu--model,.cm-sub').forEach((el) => el.getAnimations().forEach((a) => a.finish())))
  const narrowStage = await p.evaluate(box, '.model-stage')
  const stackedMenu = await p.evaluate(box, '.composer-menu--model')
  const stackedSub = await p.evaluate(box, '.cm-sub')
  check('两侧都不足时模型类二级面板叠到一级菜单上方', stackedSub.bottom < stackedMenu.top,
    `main.top=${stackedMenu.top.toFixed(1)} sub.bottom=${stackedSub.bottom.toFixed(1)}`)
  check('极窄 Chat View 下模型类二级面板收缩且完整留在 View 内', stackedSub.left >= narrowStage.left && stackedSub.right <= narrowStage.right,
    `View ${narrowStage.left.toFixed(1)}..${narrowStage.right.toFixed(1)} sub ${stackedSub.left.toFixed(1)}..${stackedSub.right.toFixed(1)}`)

  // ── F:扁平/立体开关。阴影必须走 --card-shadow 这类高程 token —— 写死 `0 10px 32px var(--shadow)`
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
