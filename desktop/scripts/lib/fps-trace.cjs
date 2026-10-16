/** 真 Electron 帧率 / 主线程去向的共用件(check-fps 与 long-content.probe 用):
 *  RECORDER 注进页面记 rAF 时间戳与长动画帧;parseTrace 把 contentTracing 的 trace 按 performance.mark('fps|<id>|s' / '|e') 圈出的阶段
 *  算成上屏帧统计 + 主线程自耗时(脚本 / 样式 / 布局 / 绘制提交 / GC)。 */
const fs = require('fs')

function rafStats(ts) {
  const d = []
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1])
  if (!d.length) return null
  const s = [...d].sort((a, b) => a - b)
  return { fps: d.length / (ts[ts.length - 1] - ts[0]) * 1000, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: d.length }
}

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

module.exports = { RECORDER, rafStats, parseTrace }
