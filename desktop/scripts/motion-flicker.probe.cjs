/**
 * 胶囊 / Ribbon 开合的闪烁探针(2026-11-27,用户报 2.14.3-beta.3「画面偶尔闪烁」)。
 * 真 Electron(out/ 产物)+ 桩引擎;主进程 webContents.beginFrameSubscription 收每一帧真实画面,裁出 Ribbon / 底排 + 菜单两块,
 * 逐像素找「瞬态」:第 i 帧和前后两帧都差得多(> 48),而前后两帧彼此几乎一样(< 14)—— 亮了一帧又回去 / 空了一帧又回来。
 * 连续动的东西(宽度补间、淡入淡出、平移)走单调路径,不会被算成瞬态。每个动作报瞬态像素最多的那帧,超过阈值的帧落盘(前 / 中 / 后三张)。
 *
 * 用法:npm run build && node scripts/motion-flicker.probe.cjs [--reps=12] [--zoom=1.1] [--only=ribbon,mode,model] [--out=<目录>] [--variant=<css>]
 * 报告式,不判红绿;阈值 --min=40(瞬态像素数)。
 * ⚠️ 局限(2026-11-27 Codex 评审):Electron 40 的 beginFrameSubscription 限 30fps,120Hz 下只闪一帧(8.3ms)可能落在两次采样之间 —— 零检出 ≠ 没闪;
 *    细的深色边缘扫过浅底也会被算成瞬态(平移中的误报)。所以它主要用来落盘整段画面(--dump)人工看胶片,瞬态数只当线索。 */
const fs = require('fs')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const REPS = Number(arg('reps', 12))
const ZOOM = Number(arg('zoom', 1.1))
const ONLY = arg('only', 'ribbon,mode,model').split(',')
const MIN = Number(arg('min', 40))
const OUT = arg('out', U.shotDir('motionflicker'))
const MSGS = Number(arg('msgs', 80))
const VARIANT_CSS = arg('variant', '')
const DUMP = arg('dump', '') // 动作名含这些字(逗号分隔)的,每帧都落盘(看胶片)
const body = (i) => `第 ${i} 条。把聊天区撑长的正文,有 **粗体** 和列表:\n\n- 一\n- 二\n`
const MESSAGES = Array.from({ length: MSGS }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: body(i), timestamp: i + 1 }))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { app, win, close } = await U.launch({ tag: 'motionflicker', messages: MSGS ? MESSAGES : undefined })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1280, height: 860 })
    if (MSGS) { await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 }).catch(() => {}); await sleep(2000) }
    if (ZOOM !== 1) { await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), ZOOM); await sleep(800) }
    if (VARIANT_CSS) await win.addStyleTag({ content: VARIANT_CSS })
    if (await win.locator('.rb.rb-expanded').count()) { await win.locator('.rb .rb-toggle').click(); await sleep(600) }
    await win.mouse.move(700, 300)

    // 两块裁切区(CSS px):Ribbon 整条(展开宽 + 余量)、底排胶囊 + 上方菜单
    const regions = await win.evaluate(() => {
      const rb = document.querySelector('.rb').getBoundingClientRect()
      const pill = document.querySelector('.t2c-pill.mode-pill-btn').getBoundingClientRect()
      const model = document.querySelector('.composer-chip.model-pill-btn').getBoundingClientRect()
      const l = Math.max(0, Math.min(pill.left, model.left) - 40), r = Math.min(innerWidth, Math.max(pill.right, model.right) + 260)
      return { iw: innerWidth, ribbon: { x: 0, y: rb.top, w: Math.min(innerWidth, 260), h: rb.height }, composer: { x: l, y: Math.max(0, pill.top - 480), w: r - l, h: Math.min(innerHeight, pill.bottom + 12) - Math.max(0, pill.top - 480) } }
    })
    console.log(`裁切区(CSS px) ribbon ${JSON.stringify(regions.ribbon)} composer ${JSON.stringify(regions.composer)} | 阈值 ${MIN} 瞬态像素`)

    // 主进程:开始 / 停止收帧;停止时按区算瞬态,超阈值的帧连同前后两帧写 PNG
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      globalThis.__fl = { wc, frames: [], on: false }
      wc.beginFrameSubscription(false, (img) => { if (globalThis.__fl.on) globalThis.__fl.frames.push({ t: Date.now(), img }) })
    })
    const film = async (label, region, action, ms) => {
      await app.evaluate(() => { globalThis.__fl.frames = []; globalThis.__fl.on = true })
      await action()
      await sleep(ms)
      return app.evaluate(({ }, a) => {
        const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
        const fl = globalThis.__fl; fl.on = false
        const frames = fl.frames; fl.frames = []
        if (frames.length < 3) return { n: frames.length, worst: -1, flagged: [] } // -1 = 采样不足,不是零检出
        const sz = frames[0].img.getSize(), s = sz.width / a.iw
        const rect = { x: Math.round(a.region.x * s), y: Math.round(a.region.y * s), width: Math.round(a.region.w * s), height: Math.round(a.region.h * s) }
        rect.width = Math.min(rect.width, sz.width - rect.x); rect.height = Math.min(rect.height, sz.height - rect.y)
        const crops = frames.map((f) => f.img.crop(rect))
        const bm = crops.map((c) => c.toBitmap())
        const lum = (b, i) => (b[i] * 29 + b[i + 1] * 150 + b[i + 2] * 77) >> 8 // BGRA
        const res = []
        for (let i = 1; i < bm.length - 1; i++) {
          const p = bm[i - 1], c = bm[i], nx = bm[i + 1]
          if (p.length !== c.length || c.length !== nx.length) continue
          let tr = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
          for (let k = 0; k < c.length; k += 4) {
            const a0 = lum(p, k), a1 = lum(c, k), a2 = lum(nx, k)
            if (Math.abs(a1 - a0) > 48 && Math.abs(a1 - a2) > 48 && Math.abs(a2 - a0) < 14) {
              tr++; const px = (k / 4) % rect.width, py = Math.floor(k / 4 / rect.width)
              if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py
            }
          }
          res.push({ i, tr, box: tr ? [minX, minY, maxX, maxY].map((v) => Math.round(v / s)) : null, dt: frames[i].t - frames[0].t })
        }
        const flagged = res.filter((r) => r.tr >= a.min)
        if (a.dump) crops.forEach((c, j) => fs.writeFileSync(path.join(a.out, `${a.label}-all-${String(j).padStart(2, '0')}-${frames[j].t - frames[0].t}ms.png`), c.toPNG()))
        flagged.slice(0, 3).forEach((r) => {
          for (const [suf, j] of [['a', r.i - 1], ['b', r.i], ['c', r.i + 1]]) fs.writeFileSync(path.join(a.out, `${a.label}-f${r.i}-${suf}.png`), crops[j].toPNG())
        })
        return { n: frames.length, worst: Math.max(0, ...res.map((r) => r.tr)), flagged: flagged.map((r) => ({ i: r.i, tr: r.tr, box: r.box, dt: r.dt })) }
      }, { region, label, iw: regions.iw, min: MIN, out: OUT, dump: !!DUMP && DUMP.split(',').some((d) => label.includes(d)) })
    }
    const click = (sel) => () => win.locator(sel).first().click({ noWaitAfter: true })
    const report = []
    const run = async (label, region, action, ms) => {
      const r = await film(label, region, action, ms)
      report.push({ label, ...r })
      if (r.flagged.length) console.log(`⚠️ ${label}: ${r.n} 帧,瞬态 ${r.flagged.map((f) => `#${f.i}(${f.dt}ms) ${f.tr}px @${JSON.stringify(f.box)}`).join(' · ')}`)
    }
    for (let i = 0; i < REPS; i++) {
      if (ONLY.includes('ribbon')) {
        await run(`r${i}-ribbon-open`, regions.ribbon, click('.rb .rb-toggle'), 450)
        await run(`r${i}-ribbon-close`, regions.ribbon, click('.rb .rb-toggle'), 450)
        // 第二下用 DOM click:locator.click 会等折叠钮几何稳定(它跟着条宽在动),等到展开快结束才点,测不到中途反向
        await run(`r${i}-ribbon-fast`, regions.ribbon, async () => { await click('.rb .rb-toggle')(); await sleep(60 + i * 7); await win.evaluate(() => document.querySelector('.rb .rb-toggle').click()) }, 500)
      }
      for (const [k, sel] of [['mode', '.t2c-pill.mode-pill-btn'], ['model', '.composer-chip.model-pill-btn']]) {
        if (!ONLY.includes(k)) continue
        await run(`r${i}-${k}-open`, regions.composer, click(sel), 600)
        await run(`r${i}-${k}-close`, regions.composer, () => win.keyboard.press('Escape'), 450)
        // 开到一半就收、收到一半又开(掉头),再收
        await run(`r${i}-${k}-flip`, regions.composer, async () => { await click(sel)(); await sleep(90 + i * 11); await win.keyboard.press('Escape'); await sleep(50 + i * 5); await click(sel)(); await sleep(500); await win.keyboard.press('Escape') }, 500)
        await win.mouse.move(700, 300)
        await sleep(150)
      }
    }
    await app.evaluate(() => { globalThis.__fl.wc.endFrameSubscription() })
    const by = {}
    for (const r of report) { const k = r.label.replace(/^r\d+-/, ''); (by[k] = by[k] || []).push(r) }
    console.log(`\n动作              帧数(均)  有瞬态的次数  最多瞬态像素`)
    for (const [k, rs] of Object.entries(by)) console.log(`${k.padEnd(16)} ${String(Math.round(rs.reduce((a, r) => a + r.n, 0) / rs.length)).padStart(6)}  ${String(rs.filter((r) => r.flagged.length).length).padStart(4)}/${rs.length}  ${String(Math.max(...rs.map((r) => r.worst))).padStart(8)}`)
    console.log(`\n落盘:${OUT}`)
  } finally {
    await close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
