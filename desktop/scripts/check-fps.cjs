/**
 * 帧率探针:真 Electron 里回答「是不是锁帧 / 哪个动画掉帧 / 掉在哪」。量的是 out/ 产物(先 npx electron-vite build)。
 * npm run check:fps -- [选项]          报告式:只打表,不判红绿
 *
 * 两把尺子:
 *  - 上屏帧:Chromium 自己的帧管线记录(trace 里的 PipelineReporter,按 vsync 去重)—— 该出的帧里多少整帧上了屏、
 *    多少全丢、多少是「合成器上了屏但主线程那份没赶上」(布局驱动的动画就卡在这)。
 *  - 主线程去向:trace 里主线程事件按自耗时归类(脚本 / 样式 / 布局 / 绘制提交 / GC),外加样式重算每次波及多少元素。
 * 读数时优先看:滚动的等效 fps、样式耗时与波及元素数、rAF 最慢帧。「最长停顿」「活跃段等效 fps」在中间有空档的阶段
 * (切 Space)偏悲观。
 *
 * 选项:
 *   --configs=default,ambient,default   default = 毛玻璃开、取色关(出厂缺省);ambient = 取色开;glass-off = 毛玻璃关;
 *                                       ambient-noset = 取色照跑但结果不写入;ambient-notrans = 去掉取色的 700ms 过渡
 *   --msgs=80      会话里的消息条数(400 = 长会话)
 *   --reps=2       第一次(冷)之后每个动作再量几次
 *   --burn         期间把每个 CPU 核都占满(看本机负载的影响)
 *   FPS_TOP=1      每个阶段多打一行「主线程自耗时前几名」
 *
 * 2026-10-05 首次用它量出:外壳取色(theme/spaceAmbient.css)在 :root 上对会继承的登记属性做过渡,过渡期间整页样式
 * 逐帧重算 —— 80 条消息滚动 52–58 fps(不取色 97–107),400 条 21–23 fps。取色因此改成缺省关。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const BURN = process.argv.includes('--burn')
const REPS = Number(arg('reps', 2))
const CONFIGS = arg('configs', 'default,ambient,default').split(',')
const LABELS = { default: '缺省(毛玻璃开·取色关)', ambient: '取色开', 'glass-off': '毛玻璃关', 'ambient-noset': '取色开·结果不写入', 'ambient-notrans': '取色开·去掉过渡' }

const body = (i) => `第 ${i} 条。这是一段把聊天区撑长的正文,有 **粗体**、\`代码\` 和列表:\n\n- 一\n- 二\n- 三\n\n\`\`\`ts\nconst x = ${i}\nfor (let k = 0; k < x; k++) console.log(k)\n\`\`\`\n\n| 列 A | 列 B |\n|---|---|\n| ${i} | ${i * 2} |\n`
const MESSAGES = Array.from({ length: Number(arg('msgs', 80)) }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: body(i), timestamp: i + 1 }))

const pad = (v, n) => String(v).padStart(n)
function rafStats(ts) {
  const d = []
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1])
  if (!d.length) return null
  const s = [...d].sort((a, b) => a - b)
  return { fps: d.length / (ts[ts.length - 1] - ts[0]) * 1000, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: d.length }
}

/** 纯净窗口:只有一个每帧挪一下的小方块。 */
const control = (app, o) => app.evaluate(async ({ BrowserWindow }, o) => {
  const w = new BrowserWindow({ width: 640, height: 420, show: false, transparent: !!o.transparent, backgroundColor: o.transparent ? '#00000000' : '#888888' })
  if (o.vibrancy) w.setVibrancy('sidebar')
  await w.loadURL('data:text/html,<body style="margin:0"><div id=a style="width:60px;height:60px;background:red"></div>')
  w.showInactive()
  await new Promise((r) => setTimeout(r, 600))
  const t = await w.webContents.executeJavaScript(`new Promise((res) => { const t = []; const a = document.getElementById('a'); const loop = (ts) => { t.push(ts); a.style.transform = 'translateX(' + (t.length % 300) + 'px)'; if (t.length < 300) requestAnimationFrame(loop); else res(t) }; requestAnimationFrame(loop) })`)
  w.destroy()
  return t
}, o)

const RECORDER = `(() => {
  const t = [], loaf = []
  const loop = (ts) => { t.push(ts); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) loaf.push({
      s: e.startTime, d: Math.round(e.duration), block: Math.round(e.blockingDuration),
      layout: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
      scripts: e.scripts.map((x) => ({ d: Math.round(x.duration), inv: String(x.invoker).slice(0, 50), fn: x.sourceFunctionName, src: String(x.sourceURL).split('/').pop().split('?')[0].slice(0, 36), forced: Math.round(x.forcedStyleAndLayoutDuration) })).filter((x) => x.d >= 4),
    }) }).observe({ type: 'long-animation-frame' })
  } catch {}
  window.__fps = { t, loaf }
})()`

/** 主线程事件名 → 归类(按自耗时算,嵌套不重复计)。 */
const bucket = (n) => /GC/.test(n) ? 'gc' : n === 'Layout' ? 'layout' : /UpdateLayoutTree|RecalcStyle/.test(n) ? 'style'
  : /Paint|Layerize|Commit|UpdateLayer|Composite|Raster/.test(n) ? 'paint'
  : /FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|FireIdleCallback|CompileScript|ResizeObserver|IntersectionObserver/.test(n) ? 'script' : 'other'

/** trace → 每个阶段的上屏帧统计 + 主线程时间去向。阶段靠 performance.mark('fps|<id>|s' / '|e') 圈定。 */
function parseTrace(file) {
  const ev = (JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents || []).filter((e) => e.ts != null).sort((x, y) => x.ts - y.ts)
  const marks = ev.filter((e) => typeof e.name === 'string' && e.name.startsWith('fps|'))
  const out = {}
  if (!marks.length) return { out, total: 0, marks: 0 }
  const { pid, tid } = marks[0]
  // 帧记录:async b/e 按 id 配对,id 会复用 → 必须按时间顺序开合
  const open = new Map(), frames = []
  for (const e of ev) {
    if (e.name !== 'PipelineReporter' || e.pid !== pid) continue
    const k = JSON.stringify(e.id2 || e.id)
    const args = (e.args && (e.args.chrome_frame_reporter || e.args.frame_reporter)) || {}
    if (e.ph === 'b') open.set(k, { b: e.ts, ...args })
    else if (e.ph === 'e') { const f = open.get(k); if (f) { open.delete(k); Object.assign(f, args); f.e = e.ts; if (f.state) frames.push(f) } }
  }
  // 主线程 X 事件 → 自耗时
  const xs = ev.filter((e) => e.ph === 'X' && e.pid === pid && e.tid === tid && e.dur > 0)
  const stack = []
  for (const e of xs) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop()
    e.self = e.dur
    if (stack.length) stack[stack.length - 1].self -= e.dur
    stack.push(e)
  }
  const win = {}
  for (const m of marks) { const [, id, edge] = m.name.split('|'); (win[id] = win[id] || {})[edge] = m.ts }
  for (const [id, w] of Object.entries(win)) {
    if (w.s == null || w.e == null) continue
    const bySeq = new Map()
    for (const f of frames) { if (f.b < w.s || f.b > w.e) continue; const k = `${f.frame_source}:${f.frame_sequence}`; (bySeq.get(k) || bySeq.set(k, []).get(k)).push(f) }
    // 一个 vsync:full = 整帧上屏;partial = 合成器上了屏、主线程那份没赶上(布局驱动的动画停一拍);dropped = 什么都没上
    const vs = [...bySeq.values()].map((g) => {
      const all = g.some((f) => f.state === 'STATE_PRESENTED_ALL'), part = g.some((f) => f.state === 'STATE_PRESENTED_PARTIAL')
      const drop = g.some((f) => f.state === 'STATE_DROPPED' && f.affects_smoothness)
      const mainMiss = g.some((f) => f.affects_smoothness && f.state !== 'STATE_PRESENTED_ALL')
      const kind = all && !mainMiss ? 'full' : (all || part) ? 'partial' : drop ? 'dropped' : null
      return kind && { kind, b: Math.min(...g.map((f) => f.b)), e: Math.max(...g.map((f) => f.e)) }
    }).filter(Boolean).sort((x, y) => x.b - y.b)
    const want = vs, shown = vs.filter((v) => v.kind === 'full'), dropped = vs.filter((v) => v.kind === 'dropped')
    const partialN = vs.filter((v) => v.kind === 'partial').length
    const pres = shown.map((v) => v.e).sort((x, y) => x - y)
    let gap = 0
    for (let i = 1; i < pres.length; i++) gap = Math.max(gap, (pres[i] - pres[i - 1]) / 1000)
    const cpu = { script: 0, style: 0, layout: 0, paint: 0, gc: 0, other: 0 }
    let layouts = 0, maxLayout = 0, maxTask = 0, recalcs = 0, recalcEls = 0
    const byName = {}
    for (const e of xs) {
      if (e.ts < w.s || e.ts > w.e) continue
      cpu[bucket(e.name)] += Math.max(0, e.self) / 1000
      byName[e.name] = (byName[e.name] || 0) + Math.max(0, e.self) / 1000
      if (e.name === 'UpdateLayoutTree') { recalcs++; recalcEls += (e.args && e.args.elementCount) || 0 }
      if (e.name === 'Layout') { layouts++; maxLayout = Math.max(maxLayout, e.dur / 1000) }
      if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') maxTask = Math.max(maxTask, e.dur / 1000)
    }
    out[id] = {
      want: want.length, shown: shown.length, dropped: dropped.length,
      partial: partialN,
      activeMs: want.length > 1 ? (want[want.length - 1].b - want[0].b) / 1000 : 0, gap, cpu, layouts, maxLayout, maxTask, recalcs, recalcEls,
      top: Object.entries(byName).sort((x, y) => y[1] - x[1]).slice(0, 7).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '),
    }
  }
  return { out, total: frames.length, marks: marks.length }
}

async function main() {
  const burners = []
  const { app, win, close } = await U.launch({ tag: 'fps', messages: MESSAGES })
  const lines = []
  const say = (l) => { lines.push(l); console.log(l) }
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    const info = await app.evaluate(({ screen }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, hz: screen.getPrimaryDisplay().displayFrequency }))
    const url = await win.evaluate(() => location.protocol + '//' + location.host)
    say(`Electron ${info.electron} / Chromium ${info.chrome} | 主屏 ${Math.round(info.hz)}Hz | 渲染层 ${url.startsWith('http') ? 'dev(vite)' : 'out/ 产物(生产构建)'} | 开场负载 ${os.loadavg()[0].toFixed(1)} / ${os.cpus().length} 核${BURN ? ' | --burn' : ''}`)

    say('\n== 纯净窗口(这块屏 + Chromium 实际给多少帧) ==')
    for (const [name, o] of [['不透明', {}], ['透明', { transparent: true }], ['透明 + vibrancy', { transparent: true, vibrancy: true }]]) {
      const s = rafStats(await control(app, o))
      say(`${name.padEnd(16)} ${s.fps.toFixed(1)} fps  p95 ${s.p95.toFixed(1)}ms  最慢 ${s.max.toFixed(1)}ms`)
    }

    if (BURN) for (let i = 0; i < os.cpus().length; i++) burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }))

    const tr = { out: {}, total: 0, marks: 0 }
    const results = [] // { cfg, name, kind: 'cold'|'hot', raf, loaf, key }
    let seq = 0
    const key = (k) => () => win.keyboard.press(k)
    const phase = async (cfg, name, kind, action, ms) => {
      const id = `p${seq++}`
      const t0 = await win.evaluate((id) => { performance.mark(`fps|${id}|s`); return performance.now() }, id)
      const ok = await action()
      await sleep(ms)
      const r = await win.evaluate(([a, id]) => { performance.mark(`fps|${id}|e`); return { vis: document.visibilityState, t: window.__fps.t.filter((x) => x >= a), loaf: window.__fps.loaf.filter((x) => x.s >= a) } }, [t0, id])
      results.push({ cfg, name, kind, id, raf: rafStats(r.t), loaf: r.loaf, vis: r.vis, ok })
    }

    for (let c = 0; c < CONFIGS.length; c++) {
      const name = CONFIGS[c]
      if (!LABELS[name]) throw new Error(`未知配置 ${name};可用:${Object.keys(LABELS).join(' / ')}`)
      const cfg = `${c + 1}. ${LABELS[name]}`
      await win.evaluate(([glass, ambient]) => {
        localStorage.setItem('forsion_glass', glass ? 'on' : 'off'); localStorage.setItem('forsion_theme_flat', '0')
        if (ambient) localStorage.setItem('forsion_theme_ambient', 'on'); else localStorage.removeItem('forsion_theme_ambient')
      }, [name !== 'glass-off', name.startsWith('ambient')])
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      if (name === 'ambient-notrans') await win.addStyleTag({ content: ':root{transition:none!important}' })
      if (name === 'ambient-noset') await win.evaluate(() => { const o = CSSStyleDeclaration.prototype.setProperty; CSSStyleDeclaration.prototype.setProperty = function (k, ...r) { if (String(k).startsWith('--space-ambient-')) return; return o.call(this, k, ...r) } })
      await sleep(2000)
      await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 }).catch((e) => say(`⚠️ 没点开会话: ${String(e).slice(0, 80)}`))
      await sleep(2500)
      await win.evaluate(RECORDER)
      await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['benchmark', 'blink.user_timing', 'devtools.timeline', 'v8'] }))
      const st = await win.evaluate(() => ({ ds: document.documentElement.dataset.glass, amb: document.documentElement.dataset.ambient, nodes: document.querySelectorAll('*').length, msgs: document.querySelectorAll('.t2-content').length, blur: [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e).backdropFilter; return s && s !== 'none' }).length }))
      say(`\n[${cfg}] data-glass=${st.ds} data-ambient=${st.amb} | DOM 节点 ${st.nodes} | 消息 ${st.msgs} | 生效的 backdrop-filter ${st.blur} 处 | 负载 ${os.loadavg()[0].toFixed(1)}`)
      const shot = path.join(U.shotDir('fps'), `cfg${c + 1}-${name}.png`)
      await U.captureWindow(app, shot)
      const round = async (kind) => {
        await phase(cfg, '静止', kind, async () => {}, 1000)
        await phase(cfg, '左栏 收起', kind, key('Meta+Slash'), 450)
        await phase(cfg, '左栏 展开', kind, key('Meta+Slash'), 450)
        await phase(cfg, '底部面板 展开', kind, key('Meta+KeyJ'), 450)
        await phase(cfg, '底部面板 收起', kind, key('Meta+KeyJ'), 450)
        await phase(cfg, '聊天区滚动', kind, async () => { await win.mouse.move(760, 420); for (let i = 0; i < 40; i++) { await win.mouse.wheel(0, i < 20 ? -200 : 200); await sleep(16) } }, 300)
        await phase(cfg, '切到 笔记', kind, () => U.enterSpace(win, 'amadeus'), 800)
        await phase(cfg, '切到 日历', kind, () => U.enterSpace(win, 'calendar'), 800)
        await phase(cfg, '切回 Tangu', kind, () => U.enterSpace(win, 'tangu'), 800)
      }
      await round('cold')
      for (let i = 0; i < REPS; i++) await round('hot')
      const traceFile = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording())
      const one = parseTrace(traceFile)
      Object.assign(tr.out, one.out); tr.total += one.total; tr.marks += one.marks
      try { fs.rmSync(traceFile) } catch {}
      await win.evaluate(() => { delete window.__fps })
      say(`    截图 ${shot} | trace 帧记录 ${one.total} 条`)
    }
    for (const b of burners.splice(0)) b.kill('SIGKILL')

    const vsync = 1000 / (info.hz || 60)
    say(`\n列:应出帧 → 整帧上屏(全丢率) | 主线程没赶上 | 活跃段等效 fps | 最长停顿 | rAF 最慢帧 || 主线程去向(ms):脚本/样式/布局/绘制提交/GC | 布局次数(单次最大) | 样式重算次数 × 平均波及元素`)
    const names = [...new Set(results.map((r) => r.name))]
    for (const cfg of [...new Set(results.map((r) => r.cfg))]) {
      for (const kind of ['cold', 'hot']) {
        say(`\n== ${cfg} · ${kind === 'cold' ? '第一次(冷)' : `之后 ${REPS} 次,每次平均(热)`} ==`)
        for (const name of names) {
          const rs = results.filter((r) => r.cfg === cfg && r.kind === kind && r.name === name)
          const f = rs.map((r) => tr.out[r.id]).filter(Boolean)
          const n = f.length || 1
          const sum = (k) => f.reduce((a, x) => a + x[k], 0)
          const cpu = (k) => (f.reduce((a, x) => a + x.cpu[k], 0) / n).toFixed(0)
          const want = sum('want'), shown = sum('shown'), dropped = sum('dropped'), partial = sum('partial'), active = sum('activeMs')
          const gap = Math.max(0, ...f.map((x) => x.gap))
          const rafMax = Math.max(0, ...rs.map((r) => (r.raf ? r.raf.max : 0)))
          const bad = rs.some((r) => r.vis !== 'visible') ? ' ⚠️窗口被遮' : rs.some((r) => r.ok === false) ? ' ⚠️没切成' : ''
          say(`${name.padEnd(9)} ${pad((want / n).toFixed(0), 3)} → ${pad((shown / n).toFixed(0), 3)} (丢 ${pad(want ? (dropped / want * 100).toFixed(0) : 0, 2)}%) | 没赶上 ${pad((partial / n).toFixed(0), 2)} | ${pad(active > 0 ? (shown / active * 1000).toFixed(0) : '-', 3)} fps | 停顿 ${pad(gap.toFixed(0), 3)}ms | ${pad(rafMax.toFixed(0), 3)}ms${rafMax > vsync * 2.5 ? '!' : ' '} || ${pad(cpu('script'), 3)}/${pad(cpu('style'), 3)}/${pad(cpu('layout'), 3)}/${pad(cpu('paint'), 3)}/${pad(cpu('gc'), 2)} | ${pad((sum('layouts') / n).toFixed(0), 3)} 次(${Math.max(0, ...f.map((x) => x.maxLayout)).toFixed(1)}ms) | ${pad((sum('recalcs') / n).toFixed(0), 3)} × ${pad(sum('recalcs') ? (sum('recalcEls') / sum('recalcs')).toFixed(0) : 0, 4)}${bad}`)
          if (process.env.FPS_TOP && f[0]) say(`      自耗时前几名(ms,第一次): ${f[0].top}`)
        }
      }
    }
    say(`\n收场负载 ${os.loadavg()[0].toFixed(1)}`)
  } finally {
    for (const b of burners) b.kill('SIGKILL')
    await close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
