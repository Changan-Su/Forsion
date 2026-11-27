/**
 * 胶囊 / Ribbon 开合的帧率与闪烁探针(2026-11-27,用户报 2.14.3-beta.3 这些动画掉帧、偶尔闪)。
 * 真 Electron(out/ 产物)+ 桩引擎;每个动作开 / 合各量 REPS 次,复用 check:fps 的两把尺子(lib/fps-trace.cjs):
 * 上屏帧(PipelineReporter,整帧 / 主线程没赶上 / 全丢)+ 主线程去向(脚本 / 样式 / 布局 / 绘制)。
 *
 * 用法:npm run build && node scripts/motion-fps.probe.cjs [--reps=4] [--zoom=1.1] [--only=ribbon,mode,model] [--msgs=80]
 *       [--variants=warm,base,pre903,…]  同一进程里轮流注入样式、交错着量,负载噪声各变量均摊(本机负载高时帧率读数很吵)
 *       FPS_BRIEF=1 只打「层数 / 重绘次数 / 重绘面积」—— 不受负载影响,先看它;FPS_GPU=1 再加光栅 / GPU 线程耗时(吵,trace 大,轮数别多)
 *       FPS_DELTAS=1 打每次的 rAF 帧间隔与长动画帧;FPS_TOP=1 打主线程自耗时前几名。
 *       负对照:在老检出(有 out/)里放同一份脚本跑。报告式,不判红绿。
 * 2026-11-27 首次用它定位:#903 让每个 Ribbon 名字各自过渡 filter(+ mask)且跟着条宽伸缩 → 开合时层数 52→85、重绘 ~250→~750 次,
 *       一半的帧掉成 16ms;改成名字定宽 + 淡入读 .rb 上的登记属性后回到 #903 之前的水平。 */
const fs = require('fs')
const os = require('os')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U
const { RECORDER, rafStats, parseTrace } = require('./lib/fps-trace.cjs')

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const REPS = Number(arg('reps', 4))
const ZOOM = Number(arg('zoom', 1))
const ONLY = arg('only', 'ribbon,mode,model').split(',')
// 同一进程里轮流套变量(注入样式 / 改 animate),每轮按变量交错量,负载噪声各变量均摊。base = 不动
const VARIANTS = arg('variants', 'base').split(',')
const MSGS = Number(arg('msgs', 80))
const body = (i) => `第 ${i} 条。把聊天区撑长的正文,有 **粗体**、\`代码\` 和列表:\n\n- 一\n- 二\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`\n`
const MESSAGES = Array.from({ length: MSGS }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: body(i), timestamp: i + 1 }))
const LABEL = '.rb > :is(.rb-head, .rb-group) .rb-btn > .rb-label'
const CSS = {
  base: '',
  warm: '', // 排在第一个当热身:一次会话里第一次展开会多建几十个层,别让它算到要比的那个变量头上
  // 2026-11-27 定位用:还原 #903 之前名字的做法(收起不渲染、无 mask / filter、旧的 0.15s 条宽)
  pre903: `.rb { transition: width 0.15s ease !important; } .rb:not(.rb-expanded) > :is(.rb-head, .rb-group) .rb-btn > .rb-label { display: none !important; } .rb > :is(.rb-head, .rb-group) .rb-btn > .rb-label { -webkit-mask-image: none !important; mask-image: none !important; filter: none !important; transition: none !important; }`,
  nolabelfx: `${LABEL} { -webkit-mask-image: none !important; mask-image: none !important; filter: none !important; transition: visibility 0s !important; }`,
  flexpill: `.t2c-pill.mode-pill-btn:not(.is-open), .composer-chip.model-pill-btn.has-icon:not(.is-open) { display: inline-flex !important; }`,
  nodrift: '', // 菜单内容收起时不挪不缩(见下面 animate 包装)
  calmoff: '', // 关掉外围淡出(calm.css)
  nomask: `${LABEL} { -webkit-mask-image: none !important; mask-image: none !important; }`,
  nofilter: `${LABEL} { filter: none !important; }`,
  hiddennotr: `.rb:not(.rb-expanded) > :is(.rb-head, .rb-group) .rb-btn > .rb-label { transition: visibility 0s linear var(--menu-exit-duration, 80ms) !important; }`,
  noclip: `.rb > :is(.rb-head, .rb-group) .rb-btn { overflow: visible !important; }`,
}
const pad = (v, n) => String(v).padStart(n)

async function main() {
  const { app, win, close } = await U.launch({ tag: 'motionfps', messages: MSGS ? MESSAGES : undefined })
  const lines = []
  const say = (l) => { lines.push(l); console.log(l) }
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    if (ZOOM !== 1) { await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), ZOOM); await sleep(800) }
    const info = await app.evaluate(({ screen }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, hz: screen.getPrimaryDisplay().displayFrequency }))
    say(`Electron ${info.electron} / Chromium ${info.chrome} | 主屏 ${Math.round(info.hz)}Hz | zoom ${ZOOM} | 负载 ${os.loadavg()[0].toFixed(1)} / ${os.cpus().length} 核`)
    if (MSGS) { await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 }).catch((e) => say(`⚠️ 没点开会话: ${String(e).slice(0, 80)}`)); await sleep(2500) }
    // nodrift:菜单内容收起时不挪不缩(去掉 animate 关键帧里的 translate / scale),只留透明度
    await win.evaluate(() => {
      const orig = Element.prototype.animate
      Element.prototype.animate = function (kf, o) {
        if (window.__noDrift && Array.isArray(kf) && kf.some((k) => k && ('translate' in k || 'scale' in k))) kf = kf.map((k) => { const { translate, scale, ...rest } = k; return rest })
        return orig.call(this, kf, o)
      }
    })
    const setVariant = (v) => win.evaluate(([v, css]) => {
      document.getElementById('__probe_variant')?.remove()
      if (css) { const st = document.createElement('style'); st.id = '__probe_variant'; st.textContent = css; document.head.appendChild(st) }
      window.__noDrift = v === 'nodrift'
      // 只在 calmoff 时改,其余变量还原成开场时的设置(新配置缺省就是 off,别顺手打开外围淡出)
      const root = document.documentElement
      if (!('__calm0' in window)) window.__calm0 = root.dataset.calmDim ?? null
      if (v === 'calmoff') root.dataset.calmDim = 'off'; else if (window.__calm0 == null) delete root.dataset.calmDim; else root.dataset.calmDim = window.__calm0
    }, [v, CSS[v]])
    for (const v of VARIANTS) if (!(v in CSS)) throw new Error(`未知变量 ${v}`)
    const st = await win.evaluate(() => ({ nodes: document.querySelectorAll('*').length, msgs: document.querySelectorAll('.t2-content').length, rb: document.querySelectorAll('.rb .rb-btn').length }))
    say(`DOM ${st.nodes} 节点 | 消息 ${st.msgs} | Ribbon 按钮 ${st.rb} | 变量 ${VARIANTS.join(' / ')}`)
    // 从 Ribbon 收起开始
    if (await win.locator('.rb.rb-expanded').count()) { await win.locator('.rb .rb-toggle').click(); await sleep(600) }
    await win.mouse.move(700, 300)
    await win.evaluate(RECORDER)
    // 确定性量具(不受负载影响):LayerTree 的层数与每次重绘(layerPainted)的次数、面积
    const cdp = await win.context().newCDPSession(win)
    let paints = [], maxLayers = 0, layerNow = 0
    cdp.on('LayerTree.layerPainted', (e) => paints.push(e.clip.width * e.clip.height))
    cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) { layerNow = e.layers.length; maxLayers = Math.max(maxLayers, layerNow) } })
    await cdp.send('LayerTree.enable')
    const cats = ['benchmark', 'blink.user_timing', 'devtools.timeline', 'v8', ...(process.env.FPS_GPU ? ['cc', 'gpu', 'viz', 'toplevel'] : [])]
    await app.evaluate(({ contentTracing }, c) => contentTracing.startRecording({ included_categories: c }), cats)
    const results = []
    let seq = 0
    let cur = 'base'
    const phase = async (name0, action, ms) => {
      const name = VARIANTS.length > 1 ? `${cur}·${name0}` : name0
      const id = `p${seq++}`
      paints = []; maxLayers = layerNow
      const t0 = await win.evaluate((id) => { performance.mark(`fps|${id}|s`); return performance.now() }, id)
      await action()
      await sleep(ms)
      const r = await win.evaluate(([a, id]) => { performance.mark(`fps|${id}|e`); return { t: window.__fps.t.filter((x) => x >= a), loaf: window.__fps.loaf.filter((x) => x.s >= a) } }, [t0, id])
      results.push({ paintN: paints.length, paintArea: paints.reduce((a, b) => a + b, 0), maxLayers, name, id, raf: rafStats(r.t), loaf: r.loaf, t0, deltas: r.t.slice(1).map((x, i) => Math.round(x - r.t[i])) })
    }
    const click = (sel) => async () => { await win.locator(sel).first().click({ noWaitAfter: true }) }
    await phase('静止', async () => {}, 800)
    for (let i = 0; i < REPS; i++) for (const v of VARIANTS) {
      cur = v; await setVariant(v); await sleep(150)
      if (ONLY.includes('ribbon')) {
        await phase('Ribbon 展开', click('.rb .rb-toggle'), 500)
        await phase('Ribbon 收起', click('.rb .rb-toggle'), 500)
      }
      if (ONLY.includes('mode')) {
        await phase('模式胶囊 开', click('.t2c-pill.mode-pill-btn'), 650)
        await phase('模式胶囊 合', () => win.keyboard.press('Escape'), 500)
      }
      if (ONLY.includes('model')) {
        await phase('模型胶囊 开', click('.composer-chip.model-pill-btn'), 650)
        await phase('模型胶囊 合', () => win.keyboard.press('Escape'), 500)
      }
      await win.mouse.move(700, 300)
      await sleep(200)
    }
    const traceFile = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording())
    const tr = parseTrace(traceFile)
    // 光栅 / GPU 线程在每个阶段的总耗时(顶层任务,不重复计嵌套):主线程之外的那半
    {
      const ev = JSON.parse(fs.readFileSync(traceFile, 'utf8')).traceEvents
      const tname = new Map(ev.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]))
      const marks = ev.filter((e) => typeof e.name === 'string' && e.name.startsWith('fps|'))
      const w = {}
      for (const m of marks) { const [, id, edge] = m.name.split('|'); (w[id] = w[id] || {})[edge] = m.ts }
      const tops = ev.filter((e) => e.ph === 'X' && e.dur > 0 && /^(ThreadControllerImpl::RunTask|RunTask|TaskGraphRunner::RunTask)$/.test(e.name))
      for (const r of results) {
        const ww = w[r.id]; if (!ww) continue
        let raster = 0, gpu = 0, viz = 0
        for (const e of tops) {
          if (e.ts < ww.s || e.ts > ww.e) continue
          const n = tname.get(`${e.pid}:${e.tid}`) || ''
          if (/CompositorTileWorker/.test(n)) raster += e.dur
          else if (/CrGpuMain/.test(n)) gpu += e.dur
          else if (/VizCompositor/.test(n)) viz += e.dur
        }
        Object.assign(r, { raster: raster / 1000, gpu: gpu / 1000, viz: viz / 1000 })
      }
    }
    const vsync = 1000 / (info.hz || 60)
    say(`\n列:应出帧 → 整帧上屏(全丢率) | 主线程没赶上 | 活跃段 fps | 最长停顿 | rAF 最慢帧 || 主线程(ms) 脚本/样式/布局/绘制/GC | 布局次数(单次最大) | 样式重算 × 平均元素 | 最长任务`)
    for (const name of [...new Set(results.map((r) => r.name))]) {
      const rs = results.filter((r) => r.name === name)
      const f = rs.map((r) => tr.out[r.id]).filter(Boolean)
      const n = f.length || 1
      const sum = (k) => f.reduce((a, x) => a + x[k], 0)
      const cpu = (k) => (f.reduce((a, x) => a + x.cpu[k], 0) / n).toFixed(0)
      const want = sum('want'), shown = sum('shown'), dropped = sum('dropped'), partial = sum('partial'), active = sum('activeMs')
      const gap = Math.max(0, ...f.map((x) => x.gap))
      const rafMax = Math.max(0, ...rs.map((r) => (r.raf ? r.raf.max : 0)))
      const rafP95 = Math.max(0, ...rs.map((r) => (r.raf ? r.raf.p95 : 0)))
      const longF = rs.reduce((a, r) => a + r.deltas.filter((d) => d > vsync * 1.5).length, 0) / (rs.length || 1)
      const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / (rs.length || 1)
      say(`${name.padEnd(VARIANTS.length > 1 ? 18 : 10)} 层 ≤${pad(Math.max(...rs.map((r) => r.maxLayers)), 3)} | 重绘 ${pad(avg('paintN').toFixed(0), 4)} 次 ${pad((avg('paintArea') / 1e6).toFixed(2), 6)} Mpx | 光栅 ${pad(avg('raster').toFixed(0), 4)} GPU ${pad(avg('gpu').toFixed(0), 4)} ms(每帧 ${(rs.reduce((a, r) => a + r.gpu, 0) / Math.max(1, rs.reduce((a, r) => a + ((tr.out[r.id] || {}).want || 0), 0))).toFixed(1)}) viz ${pad(avg('viz').toFixed(0), 3)} ms`)
      if (process.env.FPS_BRIEF) continue
      say(`${name.padEnd(VARIANTS.length > 1 ? 18 : 10)} ${pad((want / n).toFixed(0), 3)} → ${pad((shown / n).toFixed(0), 3)} (丢 ${pad(want ? (dropped / want * 100).toFixed(0) : 0, 2)}%) | 长帧(>1.5 vsync) ${pad(longF.toFixed(1), 4)} | 没赶上 ${pad((partial / n).toFixed(1), 4)} | ${pad(active > 0 ? (shown / active * 1000).toFixed(0) : '-', 3)} fps | 停顿 ${pad(gap.toFixed(0), 3)}ms | rAF p95 ${pad(rafP95.toFixed(1), 4)} 最慢 ${pad(rafMax.toFixed(0), 3)}ms${rafMax > vsync * 2.5 ? '!' : ' '} || ${pad(cpu('script'), 3)}/${pad(cpu('style'), 3)}/${pad(cpu('layout'), 3)}/${pad(cpu('paint'), 3)}/${pad(cpu('gc'), 2)} | ${pad((sum('layouts') / n).toFixed(0), 3)} 次(${Math.max(0, ...f.map((x) => x.maxLayout)).toFixed(1)}ms) | ${pad((sum('recalcs') / n).toFixed(0), 3)} × ${pad(sum('recalcs') ? (sum('recalcEls') / sum('recalcs')).toFixed(0) : 0, 4)} | ${Math.max(0, ...f.map((x) => x.maxTask)).toFixed(1)}ms`)
      if (process.env.FPS_DELTAS) for (const r of rs.slice(0, 3)) { const t = r.raf ? null : null; say(`      帧间隔: ${(r.deltas || []).join(' ')}`); for (const x of r.loaf.filter((x) => x.d >= 12)) say(`      LoAF ${x.d}ms @${Math.round(x.s - r.t0)} 阻塞 ${x.block} 布局 ${x.layout} ${x.scripts.map((s) => `${s.fn || s.inv}@${s.src} ${s.d}(强制 ${s.forced})`).join('; ')}`) }
      if (process.env.FPS_TOP && f[0]) say(`      自耗时前几名(ms,第一次): ${f[0].top}`)
      const lo = rs.flatMap((r) => r.loaf).filter((x) => x.d >= vsync * 1.5)
      if (lo.length && process.env.FPS_LOAF) say(`      长动画帧: ${lo.slice(0, 4).map((x) => `${x.d}ms(布局 ${x.layout}) ${x.scripts.map((s) => `${s.fn || s.inv}@${s.src} ${s.d}/${s.forced}`).join(';')}`).join(' | ')}`)
    }
    try { fs.rmSync(traceFile) } catch {}
  } finally {
    await close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
