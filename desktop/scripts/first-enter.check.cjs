/**
 * U-40「每次启动后第一次进日历 / 造物,三栏同时出骨架」的仪器(真 Electron + 桩引擎)。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-40(FEEL-4)。
 *
 * 成因(09-26 定位):React.lazy 首次渲染**总会**挂起一次(哪怕分块早已下载),再叠 React 19 的 Suspense
 * 揭示节流,首进就是一闪骨架 —— 所以当初「只 import() 预取分块」实测省不下来。修法在 lazyRetry:模块到手后
 * 新挂载的实例直接渲染真组件;宿主在 Electron 主窗空闲时对日历 / 造物的 View 调 preload()。本仪器只在页内打点:
 *   - 真实点击那一刻(捕获阶段的 pointerdown,落在 Space 钮 / 溢出行上)performance.mark('u40:<space>:<n>')
 *     (n=1 首进 / 2 同次启动再进)。不在查按钮之前打点:溢出区要先 hover 500ms,会算进「点击→撤下」(Codex 第一轮 F-3)
 *   - 逐帧采样 `.sk` 骨架,按所在区(左 / 主 / 右,看水平位置)分别记**挂载**(盒子非零)与**可见**(再加 computed
 *     opacity>0 —— 骨架前 150ms 是透明的,挂 140ms 就撤的骨架用户根本看不见,不能记成「可见」;Codex 第一轮 F-2)
 *     (不用 MutationObserver:dockview 挪面板 DOM 时增删对不上号,实测会把 230ms 量成 750ms)
 *   - performance.measure 记「点击 → 最后一块骨架撤下」
 *   - 分块到达时刻走 Playwright 的 request 事件(打包产物是 file://,Resource Timing 里没有它们);
 *     再用 longtask 观察器量这段里主线程被占了多久 —— 分块早到了骨架还挂着 = 耗在模块求值 / 首渲染 / 数据上
 *   - 造物另记 U-39 的「转圈 + 正在读取…」状态位([data-artificial-root] [data-state="loading"])持续多久
 *     (那是 U-39 的包在修,这里只并排给数)
 * 骨架自带 150ms 出现延迟(skeleton.css):挂着 <150ms 的骨架用户看不见,表里单列「可见」= 挂着 ≥150ms。
 *
 * 每轮 = 一次全新启动(落在 Tangu)→ 日历首进 → 回 Tangu → 日历再进 → 造物首进 → 回 Tangu → 造物再进。
 * 跑 U40_RUNS 轮(缺省 3),打印每轮明细与 中位 / 最小 / 最大。
 *
 * 断言:
 *   1 两个 Space 都点进去了,首进没有可见骨架(≥150ms)且 150ms 内落定 —— 空闲预热生效。
 *     基线组(U40_BASELINE=1,关掉预热)改判「首进确实**拉了它自己的 lazy 分块**(CalendarView / ArtificialView,
 *     Codex 第一轮 F-4:造物读产物时自己也会出 .sk,光看骨架证明不了走了 lazy)且挂出过骨架」。
 *   2 同次启动再进:没有可见骨架(≥150ms)—— 分块缓存生效;失败说明每次进入都在重拉分块
 * 负对照:U40_NEGATIVE=1 关掉预热、但按已修组判 —— 断言 1 必须红(证明它真在看骨架)。
 *
 * ⚠️ 本脚本额外覆写 `HOME`(同 check:artificial):造物托管根 = <HOME>/Forsion-Dev/Project,不覆写会读用户真目录。
 * 跑法:npx electron-vite build && npm run check:firstenter
 * 旋钮:U40_RUNS(启动几轮,缺省 3)/ U40_BASELINE=1(关掉预热量基线)/ U40_VERBOSE=1(列出首进拉了哪些分块)/ SHOT_DIR(首进骨架截图落点)
 */
const path = require('path')
const { ROOT, sleep, shotDir, makeReporter, launch, boot, enterSpace, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const RUNS = Math.max(1, Number(process.env.U40_RUNS || 3)) // 0 轮 = 什么都没量却全绿,不允许
/** U40_BASELINE=1:关掉宿主的空闲预热(localStorage forsion_no_idle_preload),量改之前的基线。 */
const BASELINE = !!process.env.U40_BASELINE
/** 负对照:同样关掉预热,但按「已修」组判 —— 断言 1 必须红(证明它真在看骨架)。 */
const NEGATIVE = !!process.env.U40_NEGATIVE
const NO_PRELOAD = BASELINE || NEGATIVE
/** 首进必须拉到的 lazy 分块(去掉 hash 后的名字前缀)。 */
const LAZY_CHUNK = { calendar: /^CalendarView\.js$/, artificial: /^ArtificialView\.js$/ }
const VISIBLE_MS = 150
const R = makeReporter()

/** 页内长任务观察器(只装一次)。骨架本身按帧采样(见 COLLECT),不用 MutationObserver:
 *  dockview 会把面板 DOM 挪进挪出,增删记录对不上号(实测漏记「撤下」,把 230ms 的骨架量成 750ms)。 */
const INSTALL = `(() => {
  if (window.__u40) return true
  window.__u40 = { long: [], pending: null, clickEpoch: 0 }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__u40.long.push({ t: e.startTime, ms: e.duration }) }).observe({ type: 'longtask', buffered: false }) } catch {}
  // 计时起点 = 真实点击:捕获阶段的 pointerdown 落在 Space 钮 / 溢出行上时,给挂起的标签打点。
  document.addEventListener('pointerdown', (e) => {
    const label = window.__u40.pending
    if (!label || !(e.target && e.target.closest && e.target.closest('.rb-space, .rb-fly-row'))) return
    window.__u40.pending = null
    window.__u40.clickEpoch = Date.now()
    performance.mark(label)
  }, true)
  return true
})()`

/** 逐帧采样**看得见的**骨架(连在文档里、盒子非零),按所在区(左 / 主 / 右,看水平位置)记首见 / 末见;
 *  直到「没有可见骨架且造物不在 loading」持续 quietMs,或超时。 */
const COLLECT = (label, space, quietMs = 500, timeoutMs = 10000) => `new Promise((resolve) => {
  const started = performance.now()
  let t0 = null // 等真实点击打点(见 INSTALL);点击前的一切都不算
  const W = window.innerWidth
  const regionOf = (el) => { const g = el.closest('.dv-groupview') || el; const r = g.getBoundingClientRect(); const cx = r.left + r.width / 2; return cx < W * 0.3 ? 'left' : cx > W * 0.7 ? 'right' : 'main' }
  // region -> { first, last, runStart, prevFrame, maxRun }:只算**连续可见**的一段(两次出现之间的空档不计入时长)
  const seen = {}     // 可见骨架(盒子非零 + opacity>0)
  const mounted = {}  // 挂载骨架(盒子非零,不管透明与否)
  let frame = 0
  let spinnerFrom = null; let spinnerTo = null
  let quietSince = null
  const track = (bag, keys, now) => {
    for (const k of keys) {
      const e = bag[k] || (bag[k] = { first: now, last: now, runStart: now, prevFrame: frame, maxRun: 0 })
      if (e.prevFrame !== frame - 1 && e.prevFrame !== frame) e.runStart = now // 断开过:新的一段
      e.prevFrame = frame; e.last = now
      e.maxRun = Math.max(e.maxRun, now - e.runStart)
    }
  }
  const tick = () => {
    const now = performance.now()
    if (t0 == null) {
      const mark = performance.getEntriesByName(${JSON.stringify(label)}, 'mark')[0]
      if (mark) t0 = mark.startTime
      else if (now - started > ${timeoutMs}) { resolve({ spans: [], mountedSpans: [], settled: 0, regions: [], maxVisible: 0, maxMounted: 0, spinner: 0, longTask: { n: 0, ms: 0, max: 0 }, timedOut: true, noClick: true }); return }
      else { requestAnimationFrame(tick); return }
    }
    frame += 1
    // 活动 Space 切过去之前的骨架属于离开的那个 Space,不计(Space 切换在点击处理里同步完成)。
    const arrived = localStorage.getItem('forsion_tangu_active_space') === ${JSON.stringify(space)}
    const boxed = arrived ? Array.from(document.querySelectorAll('.sk')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }) : []
    const visible = boxed.filter((el) => parseFloat(getComputedStyle(el).opacity) > 0.01)
    track(mounted, new Set(boxed.map(regionOf)), now)
    track(seen, new Set(visible.map(regionOf)), now)
    const spin = !!document.querySelector('[data-artificial-root] [data-state="loading"]')
    if (spin && spinnerFrom == null) spinnerFrom = now
    if (!spin && spinnerFrom != null && spinnerTo == null) spinnerTo = now
    // 活动 Space 还没切过去时不算「安静」(溢出浮层里的 Space 要先 hover 500ms 才点得到)
    if (!arrived || boxed.length || spin) quietSince = null; else if (quietSince == null) quietSince = now
    if ((quietSince != null && now - quietSince >= ${quietMs}) || now - t0 > ${timeoutMs}) {
      const spanOf = (bag) => Object.entries(bag).map(([region, e]) => ({ region, from: Math.round(e.first - t0), ms: Math.round(e.maxRun) }))
      const spans = spanOf(seen)
      const mountedSpans = spanOf(mounted)
      const lastOff = Object.values(mounted).reduce((m, e) => Math.max(m, e.last - t0), 0)
      try { performance.measure(${JSON.stringify(label)} + ':settled', { start: t0, end: t0 + lastOff }) } catch {}
      // 长任务(≥50ms 的主线程占用):分块到了之后骨架还挂着,多半耗在模块求值 / 首渲染上。
      const longs = (window.__u40.long || []).filter((l) => l.t >= t0 && l.t <= t0 + lastOff)
      const longTask = { n: longs.length, ms: Math.round(longs.reduce((m, l) => m + l.ms, 0)), max: Math.round(longs.reduce((m, l) => Math.max(m, l.ms), 0)) }
      resolve({
        spans,
        mountedSpans,
        settled: Math.round(lastOff),
        regions: spans.filter((x) => x.ms >= ${VISIBLE_MS}).map((x) => x.region),
        maxVisible: spans.reduce((m, x) => Math.max(m, x.ms), 0),
        maxMounted: mountedSpans.reduce((m, x) => Math.max(m, x.ms), 0),
        spinner: spinnerFrom != null ? Math.round((spinnerTo ?? now) - spinnerFrom) : 0,
        longTask,
        timedOut: now - t0 > ${timeoutMs},
      })
    } else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})`

/** 网络时间线(Playwright 的 request / requestfinished;打包产物走 file://,Resource Timing 里看不见它们)。 */
function netRecorder(win) {
  const log = []
  win.on('request', (r) => log.push({ req: r, u: r.url(), start: Date.now(), end: null }))
  win.on('requestfinished', (r) => { const e = log.find((x) => x.req === r); if (e) e.end = Date.now() })
  win.on('requestfailed', (r) => { const e = log.find((x) => x.req === r); if (e) { e.end = Date.now(); e.failed = true } })
  return {
    since(t0) {
      const xs = log.filter((e) => e.start >= t0)
      const assets = xs.filter((e) => /\.(m?js|css)(\?|$)/.test(e.u))
      const data = xs.filter((e) => !/\.(m?js|css)(\?|$)/.test(e.u) && /^https?:/.test(e.u))
      const name = (u) => u.split('?')[0].split('/').pop().replace(/-[A-Za-z0-9_-]{8}\.(m?js|css)$/, '.$1')
      return {
        assets: { n: assets.length, lastEnd: assets.reduce((m, e) => Math.max(m, (e.end || e.start) - t0), 0), names: assets.map((e) => name(e.u)) },
        data: data.map((e) => `${name(e.u)} ${e.start - t0}→${e.end ? e.end - t0 : '…'}${e.failed ? '✗' : ''}`),
      }
    },
  }
}

async function enterAndMeasure(app, win, space, n, shots, run, net) {
  const label = `u40:${space}:${n}`
  const tNode = Date.now()
  await win.evaluate((l) => { window.__u40.pending = l }, label) // 真点击时由 INSTALL 的捕获监听打点
  const collecting = win.evaluate(COLLECT(label, space))
  const hit = await enterSpace(win, space, { real: true })
  // 首进的骨架截一张(第一轮):DESIGN §8 自查「三栏同时出骨架」到底长什么样。
  if (n === 1 && run === 1 && hit) { await sleep(160); await captureWindow(app, path.join(shots, `firstenter-${space}-skeleton.png`)) }
  const m = await collecting
  const active = await activeSpace(win)
  const clickEpoch = await win.evaluate(() => window.__u40.clickEpoch || 0)
  return { space, n, hit, active, ...m, net: net.since(clickEpoch >= tNode ? clickEpoch : tNode) }
}

async function oneLaunch(run, shots) {
  const env = await launch({ tag: 'firstenter', overrideHome: true })
  const out = []
  try {
    await boot(env.app, env.win, { space: 'tangu', width: 1440, height: 900 })
    await sleep(1500)
    await env.win.evaluate(INSTALL)
    if (NO_PRELOAD) {
      await env.win.evaluate(() => localStorage.setItem('forsion_no_idle_preload', '1'))
      await env.win.reload({ waitUntil: 'domcontentloaded' })
      await env.win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await sleep(1500)
      await env.win.evaluate(INSTALL)
    }
    // 空闲预热由 requestIdleCallback(timeout 5s)触发:等够它的上限再点,免得量到「还没来得及预热」。
    await sleep(4000)
    const net = netRecorder(env.win)
    for (const space of ['calendar', 'artificial']) {
      out.push(await enterAndMeasure(env.app, env.win, space, 1, shots, run, net))
      await enterSpace(env.win, 'tangu', { real: true })
      await sleep(900)
      out.push(await enterAndMeasure(env.app, env.win, space, 2, shots, run, net))
      await enterSpace(env.win, 'tangu', { real: true })
      await sleep(900)
    }
  } finally { await env.close() }
  return out
}

const stats = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return '-'
  return `中位 ${s[Math.floor(s.length / 2)]} / 最小 ${s[0]} / 最大 ${s[s.length - 1]}`
}

async function main() {
  const shots = shotDir('firstenter')
  const all = []
  for (let run = 1; run <= RUNS; run += 1) {
    try { all.push(...(await oneLaunch(run, shots)).map((r) => ({ ...r, run }))) }
    catch (e) { console.error(e); R.check(`第 ${run} 轮 runner 未捕获异常`, false, String((e && e.message) || e)) }
  }
  console.log('\n 轮 | Space      | 第几次 | 落定ms | 最长可见骨架ms | 最长挂载ms | 可见骨架区(≥150ms) | 造物转圈ms | 分块(个 / 最晚到达ms) | 长任务(个 / 合计 / 最长 ms) | 数据请求(起→止 ms)')
  for (const r of all) {
    console.log(` ${r.run}  | ${r.space.padEnd(10)} | ${r.n}      | ${String(r.settled).padStart(6)} | ${String(r.maxVisible).padStart(14)} | ${String(r.maxMounted).padStart(10)} | ${(r.regions.join('+') || '-').padEnd(18)} | ${String(r.spinner).padStart(10)} | ${`${r.net.assets.n} / ${r.net.assets.lastEnd}`.padEnd(20)} | ${`${r.longTask.n} / ${r.longTask.ms} / ${r.longTask.max}`.padEnd(26)} | ${r.net.data.join(', ') || '-'}`)
    if (r.n === 1 && process.env.U40_VERBOSE) {
      console.log(`      分块:${r.net.assets.names.join(' ')}`)
      console.log(`      骨架(区 起点+时长 ms):${r.spans.map((x) => `${x.region} ${x.from}+${x.ms}`).join(', ')}`)
    }
  }
  console.log('')
  for (const space of ['calendar', 'artificial']) {
    for (const n of [1, 2]) {
      const rows = all.filter((r) => r.space === space && r.n === n)
      console.log(`BASELINE ${space} 第${n}次进入:落定 ${stats(rows.map((r) => r.settled))};最长骨架 ${stats(rows.map((r) => r.maxVisible))}${space === 'artificial' ? `;转圈 ${stats(rows.map((r) => r.spinner))}` : ''}`)
    }
  }
  console.log('')
  for (const space of ['calendar', 'artificial']) {
    const first = all.filter((r) => r.space === space && r.n === 1)
    const again = all.filter((r) => r.space === space && r.n === 2)
    const lazyHit = (r) => r.net.assets.names.some((nm) => LAZY_CHUNK[space].test(nm))
    R.check(BASELINE
      ? `1 ${space}(基线):${first.length} 轮都点进去了,首进拉了自己的 lazy 分块(${LAZY_CHUNK[space].source})且挂出过骨架`
      : `1 ${space}:${first.length} 轮都点进去了,首进没有可见骨架(≥${VISIBLE_MS}ms)且 ${VISIBLE_MS}ms 内落定 —— 空闲预热生效`,
      first.length === RUNS && first.every((r) => r.hit && r.active === space && !r.noClick && (BASELINE ? lazyHit(r) && r.mountedSpans.length > 0 : r.maxVisible < VISIBLE_MS && r.settled < VISIBLE_MS)),
      // ↑ 造物的骨架多半在 150ms 透明期内就撤,光看「可见」分不出修没修;落定(点击→最后一块骨架撤下)分得出:无预热约 250ms,有预热个位数
      JSON.stringify(first.map((r) => ({ hit: r.hit, active: r.active, lazyChunk: lazyHit(r), visible: r.maxVisible, settled: r.settled, noClick: !!r.noClick }))))
    R.check(`2 ${space}:同次启动再进没有可见骨架(≥${VISIBLE_MS}ms)—— 分块缓存生效`,
      again.length === RUNS && again.every((r) => r.hit && r.active === space && r.maxVisible < VISIBLE_MS),
      JSON.stringify(again.map((r) => r.maxVisible)))
  }
  console.log(`SHOTS ${shots}`)
  process.exit(R.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
