// 逐帧量仪表盘的拖动手感:起 vite,打开 harness.html?dashgrid,跑一组慢拖手势。
// 量的是:布局换了几次、A→B→A 回摆、手停住后布局还变不变、松手后再跳几次、别的卡走到一半掉头、壳跟不跟手。
// check:dashgrid 等动画结束才取样,这些它看不见。验收:回摆 0、stillChanges 0、dropChanges 0。
// 用法:npm run probe:dashdrag [-- --json=<文件>];ZOOM=1.1 = 用户开发版的缩放(uiZoom 写 body zoom)。
const { spawn } = require('child_process'), path = require('path'), fs = require('fs')
const DESK = path.join(__dirname, '..')
const { chromium } = require(path.join(DESK, 'node_modules/playwright-core'))
const PORT = +(process.env.PORT || 5271)
const SETTLE = 350 // 手停住 350 ms 之后布局还在变，才算自己在抖

const REC = (cfg) => {
  const R = { t0: performance.now(), frames: [], changes: [], moves: 0, stops: [] }
  addEventListener('pointermove', () => { R.moves++ }, true)
  addEventListener('mousemove', (e) => { R.px = e.clientX; R.py = e.clientY }, true)
  let last = null, off = false
  const sigOf = () => [...document.querySelectorAll('.dash3-card-slot')].map((s) => `${s.querySelector('.dash3-card')?.dataset.key}:${s.style.gridRow}/${s.style.gridColumn}`).sort().join('|')
  const tick = () => {
    if (off) return
    const t = performance.now() - R.t0, sig = sigOf()
    if (sig !== last) { R.changes.push({ t, sig }); last = sig }
    const cards = {}
    for (const n of document.querySelectorAll('.dash3-card')) {
      if (n.classList.contains('dash3-card--lift')) continue
      const r = n.getBoundingClientRect(); const id = n.dataset.key
      const z = cfg.zoom || 1 // 卡被 FLIP 压扁拉伸的比例:视觉宽 / 布局宽
      cards[id] = [+r.left.toFixed(1), +r.top.toFixed(1), +(r.width / (n.offsetWidth * z || 1)).toFixed(3), +(r.height / (n.offsetHeight * z || 1)).toFixed(3)]
    }
    let ov = null
    const o = document.querySelector('.dash3-card--lift')
    if (o) { const r = o.getBoundingClientRect(); ov = [+r.left.toFixed(1), +r.top.toFixed(1)] }
    R.frames.push({ t, cards, ov, px: R.px, py: R.py })
    requestAnimationFrame(tick)
  }
  tick()
  window.__rec = { R, stop: () => { off = true; return R } }
}

function metrics(R, dragged) {
  const up = R.upAt ?? Infinity
  const sigs = R.changes.slice(1).filter((c) => c.t < up) // 第一条是起手状态
  const dropChanges = R.changes.slice(1).filter((c) => c.t >= up).length // 松手之后布局又换了
  const frames = R.frames.filter((f) => f.t < up)
  let squash = 0, squashFrames = 0
  for (const f of frames) { let m = 0; for (const [id, c] of Object.entries(f.cards)) if (id !== dragged) m = Math.max(m, Math.abs(c[2] - 1), Math.abs(c[3] - 1)); squash = Math.max(squash, m); if (m > 0.015) squashFrames++ }
  let aba = 0
  for (let i = 2; i < R.changes.length; i++) if (R.changes[i].sig === R.changes[i - 2].sig && R.changes[i].t - R.changes[i - 2].t < 900) aba++
  let still = 0
  for (const c of sigs) if (R.stops.some(([a, b]) => c.t > a + SETTLE && c.t < b)) still++
  // 别的卡走到一半掉头：相邻帧位移方向反了，且两边都超过 1.5 px
  let rev = 0, maxStep = 0
  const ids = Object.keys(R.frames[0]?.cards || {})
  for (const id of ids) {
    if (id === dragged) continue
    for (const ax of [0, 1]) {
      let prev = 0
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1].cards[id], b = frames[i].cards[id]; if (!a || !b) continue
        const d = b[ax] - a[ax]; maxStep = Math.max(maxStep, Math.abs(d))
        if (Math.abs(d) > 1.5) { if (prev && Math.sign(prev) !== Math.sign(d)) rev++; prev = d } else if (d === 0) prev = 0
      }
    }
  }
  // 跟手：卡相对指针的偏移在一笔里应该恒定
  const off = frames.filter((f) => f.ov && f.px != null).map((f) => [f.ov[0] - f.px, f.ov[1] - f.py])
  let lag = 0
  for (let i = 2; i < off.length; i++) lag = Math.max(lag, Math.abs(off[i][0] - off[0][0]), Math.abs(off[i][1] - off[0][1]))
  return { layoutChanges: sigs.length, aba, stillChanges: still, dropChanges, squashPct: +(squash * 100).toFixed(1), squashFrames, frames: frames.length, reversals: rev, maxStepPx: +maxStep.toFixed(1), followErrPx: +lag.toFixed(1), overlayFrames: off.length, pointerEvents: R.moves }
}

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
async function gesture(page, cfg, g) {
  await page.evaluate((id) => document.querySelector(`.dash3-card[data-key="${id}"]`).scrollIntoView({ block: 'center' }), g.drag)
  await page.waitForTimeout(120)
  await page.evaluate(REC, cfg)
  const rect = (id) => page.evaluate((i) => { const r = document.querySelector(`.dash3-card[data-key="${i}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }, id)
  const from = await rect(g.drag)
  const start = center(from)
  const pts = []
  for (const w of g.via) {
    if (typeof w === 'string') pts.push(center(await rect(w)))
    else if (w.at) { const r = await rect(w.at); pts.push({ x: r.x + r.width * w.fx, y: r.y + r.height / 2 }) }
    else if (w.cx != null) pts.push(await page.evaluate(({ cx, cy }) => { const g = document.querySelector('.dash3-grid'), r = g.getBoundingClientRect(), s = getComputedStyle(g); return { x: r.x + parseFloat(s.paddingLeft) + cx, y: r.y + parseFloat(s.paddingTop) + cy } }, w)) // 内容盒坐标
    else pts.push(w)
  }
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  let cur = start, sent = 0
  const now = () => page.evaluate(() => performance.now() - window.__rec.R.t0)
  const stops = []
  for (const p of pts) {
    const n = g.steps || 50
    for (let i = 1; i <= n; i++) { await page.mouse.move(cur.x + (p.x - cur.x) * i / n, cur.y + (p.y - cur.y) * i / n); sent++; await page.waitForTimeout(16) }
    cur = p
    const a = await now(); await page.waitForTimeout(g.hold || 900); stops.push([a, await now()])
  }
  const upAt = await now(); await page.mouse.up(); await page.waitForTimeout(450)
  const R = await page.evaluate(() => window.__rec.stop())
  R.stops = stops; R.upAt = upAt
  return { name: g.name, ...metrics(R, g.drag), sent, R }
}

// 格点扫：同一笔里停遍一张网，找「手不动、布局自己来回翻」的点
async function lattice(page, cfg, drag, box, nx, ny) {
  const via = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j % 2 ? nx - 1 - i : i
    via.push({ x: box.x + box.w * (c + 0.5) / nx, y: box.y + box.h * (j + 0.5) / ny })
  }
  return gesture(page, cfg, { name: `格点扫 ${drag}（${nx}×${ny}）`, drag, via, steps: 14, hold: 620 })
}

async function run(browser) {
  const vite = spawn(process.execPath, [path.join(DESK, 'node_modules/vite/bin/vite.js'), 'frontend', '--port', String(PORT), '--strictPort'], { cwd: DESK, stdio: 'ignore' })
  const URL_ = `http://localhost:${PORT}/harness.html?dashgrid`
  for (let i = 0; i < 60; i++) { try { const r = await fetch(URL_); if (r.ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) }
  const out = []
  try {
    const zoom = +(process.env.ZOOM || 1)
    const open = async (query = '', width = 1280, height = +(process.env.VH || 1100)) => {
      const p = await browser.newPage({ locale: 'zh-CN', viewport: { width, height } })
      await p.goto(URL_ + query, { waitUntil: 'domcontentloaded' }); await p.waitForSelector('.dash3-host .dash3-card', { timeout: 60000 }); await p.waitForTimeout(800)
      await p.locator('.amx-toolbar button[title^="编辑布局"]').click(); await p.waitForTimeout(350)
      if (zoom !== 1) { await p.evaluate((z) => { document.body.style.zoom = String(z) }, zoom); await p.waitForTimeout(500) }
      return p
    }
    const cfg = { zoom }
    for (const g of [
      { name: '等大两卡来回', drag: '6', via: ['7', { at: '6', fx: 0.3 }] },
      { name: '小卡穿过大卡', drag: '2', via: ['4', '6'] },
      { name: '大卡压小卡', drag: '4', via: ['2', '3', '6'] },
    ]) { const p = await open(); out.push(await gesture(p, cfg, g)); await p.close() }
    // Codex 第三轮的反例:最后一站换了就翻回去,防回摆拒掉;松手不能绕过这道检查再落一次盘。
    const r = await open('&cards=4x3,6x5,12x3,4x7,8x4', 1120, 1700) // 内容宽 996
    out.push(await gesture(r, cfg, { name: '防回摆拒掉后松手', drag: '1', via: [{ cx: 876, cy: 1314 }, { cx: 921, cy: 1333 }], steps: 14, hold: 300 })); await r.close()
    const p = await open()
    const box = await p.evaluate(() => { const r = document.querySelector('.dash3-grid').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10, w: r.width - 20, h: Math.min(r.height, 760) - 20 } })
    out.push(await lattice(p, cfg, '7', box, 7, 5)); await p.close()
    const q = await open()
    out.push(await lattice(q, cfg, '4', box, 7, 5)); await q.close()
  } finally { vite.kill() }
  return out
}

;(async () => {
  const b = await chromium.launch()
  const out = await run(b)
  await b.close()
  const jsonArg = process.argv.find((x) => x.startsWith('--json='))
  if (jsonArg) fs.writeFileSync(jsonArg.slice(7), JSON.stringify(out.map(({ R, ...m }) => ({ ...m, changes: R.changes.map((c) => ({ t: Math.round(c.t), sig: c.sig })), stops: R.stops })), null, 1))
  let bad = 0
  for (const { R, ...m } of out) { console.log(JSON.stringify(m)); bad += m.aba + m.stillChanges + m.dropChanges }
  if (bad) { console.error(`不合格:回摆 + 手停住时变化 + 松手再跳 = ${bad}`); process.exit(1) }
})().catch((e) => { console.error(e); process.exit(1) })
