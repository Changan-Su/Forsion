/**
 * U-40「每次启动后第一次进日历 / 造物,三栏同时出骨架」的基线仪器(真 Electron + 桩引擎)。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-40(FEEL-4)。
 *
 * 这是 lazy chunk 首次加载;加载过一次就缓存,只影响每次启动后的第一次进入。评审要求**先量基线**,
 * 再决定要不要在桌面端空闲时预取 —— 所以本仪器不改业务代码,只在页内打点:
 *   - 点 ribbon Space 钮的那一刻 performance.mark('u40:<space>:<n>')(n=1 首进 / 2 同次启动再进)
 *   - 逐帧采样看得见的 `.sk` 骨架,按所在区(左 / 主 / 右,看水平位置)记首见 / 末见
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
 * 断言只钉「量到了」与「缓存有效」两件事(基线本身不设阈值,数字交给拍板):
 *   1 两个 Space 都点进去了,且首进确实挂出过骨架(没挂出 = 首进根本不走 lazy,基线无意义)
 *   2 同次启动再进:没有可见骨架(≥150ms)—— 分块缓存生效;失败说明每次进入都在重拉分块
 *
 * ⚠️ 本脚本额外覆写 `HOME`(同 check:artificial):造物托管根 = <HOME>/Forsion-Dev/Project,不覆写会读用户真目录。
 * 跑法:npx electron-vite build && npm run check:firstenter
 * 旋钮:U40_RUNS(启动几轮,缺省 3)/ U40_PREFETCH=1(对照组:进入前先 import() JS 分块 + 挂上它们的 CSS 依赖,
 *   看预取能省多少;对照组自己也有断言:首进时一个分块都不许再拉,否则对照不完整、结论作废)/ U40_VERBOSE=1(列出首进拉了哪些分块)/ SHOT_DIR(首进骨架截图落点)
 */
const fs = require('fs')
const path = require('path')
const { ROOT, sleep, shotDir, makeReporter, launch, boot, enterSpace, SPACE_NAMES, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const RUNS = Math.max(1, Number(process.env.U40_RUNS || 3)) // 0 轮 = 什么都没量却全绿,不允许
/** U40_PREFETCH=1:进 Space 前先在页内 import() 相关分块(预取方案的对照组)。 */
const PREFETCH = !!process.env.U40_PREFETCH
const VISIBLE_MS = 150
const R = makeReporter()
/** 预取对照组每轮实际预取成功了几个(JS / CSS),写进断言 3。 */
const prefetchLog = []

/** 页内长任务观察器(只装一次)。骨架本身按帧采样(见 COLLECT),不用 MutationObserver:
 *  dockview 会把面板 DOM 挪进挪出,增删记录对不上号(实测漏记「撤下」,把 230ms 的骨架量成 750ms)。 */
const INSTALL = `(() => {
  if (window.__u40) return true
  window.__u40 = { long: [] }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__u40.long.push({ t: e.startTime, ms: e.duration }) }).observe({ type: 'longtask', buffered: false }) } catch {}
  return true
})()`

/** 逐帧采样**看得见的**骨架(连在文档里、盒子非零),按所在区(左 / 主 / 右,看水平位置)记首见 / 末见;
 *  直到「没有可见骨架且造物不在 loading」持续 quietMs,或超时。 */
const COLLECT = (label, space, quietMs = 500, timeoutMs = 10000) => `new Promise((resolve) => {
  const mark = performance.getEntriesByName(${JSON.stringify(label)}, 'mark')[0]
  const t0 = mark ? mark.startTime : performance.now()
  const W = window.innerWidth
  const regionOf = (el) => { const g = el.closest('.dv-groupview') || el; const r = g.getBoundingClientRect(); const cx = r.left + r.width / 2; return cx < W * 0.3 ? 'left' : cx > W * 0.7 ? 'right' : 'main' }
  // region -> { first, last, runStart, prevFrame, maxRun }:只算**连续可见**的一段(两次出现之间的空档不计入时长)
  const seen = {}
  let frame = 0
  let spinnerFrom = null; let spinnerTo = null
  let quietSince = null
  const tick = () => {
    const now = performance.now()
    frame += 1
    // 活动 Space 切过去之前的骨架属于离开的那个 Space,不计(Space 切换在点击处理里同步完成)。
    const arrived = localStorage.getItem('forsion_tangu_active_space') === ${JSON.stringify(space)}
    const visible = arrived ? Array.from(document.querySelectorAll('.sk')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }) : []
    const hit = new Set(visible.map(regionOf))
    for (const k of hit) {
      const e = seen[k] || (seen[k] = { first: now, last: now, runStart: now, prevFrame: frame, maxRun: 0 })
      if (e.prevFrame !== frame - 1 && e.prevFrame !== frame) e.runStart = now // 断开过:新的一段
      e.prevFrame = frame; e.last = now
      e.maxRun = Math.max(e.maxRun, now - e.runStart)
    }
    const spin = !!document.querySelector('[data-artificial-root] [data-state="loading"]')
    if (spin && spinnerFrom == null) spinnerFrom = now
    if (!spin && spinnerFrom != null && spinnerTo == null) spinnerTo = now
    // 活动 Space 还没切过去时不算「安静」(溢出浮层里的 Space 要先 hover 500ms 才点得到)
    if (!arrived || visible.length || spin) quietSince = null; else if (quietSince == null) quietSince = now
    if ((quietSince != null && now - quietSince >= ${quietMs}) || now - t0 > ${timeoutMs}) {
      const spans = Object.entries(seen).map(([region, e]) => ({ region, from: Math.round(e.first - t0), ms: Math.round(e.maxRun) }))
      const lastOff = Object.values(seen).reduce((m, e) => Math.max(m, e.last - t0), 0)
      try { performance.measure(${JSON.stringify(label)} + ':settled', { start: t0, end: t0 + lastOff }) } catch {}
      // 长任务(≥50ms 的主线程占用):分块到了之后骨架还挂着,多半耗在模块求值 / 首渲染上。
      const longs = (window.__u40.long || []).filter((l) => l.t >= t0 && l.t <= t0 + lastOff)
      const longTask = { n: longs.length, ms: Math.round(longs.reduce((m, l) => m + l.ms, 0)), max: Math.round(longs.reduce((m, l) => Math.max(m, l.ms), 0)) }
      resolve({
        spans,
        settled: Math.round(lastOff),
        regions: spans.filter((x) => x.ms >= ${VISIBLE_MS}).map((x) => x.region),
        maxVisible: spans.reduce((m, x) => Math.max(m, x.ms), 0),
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
  await win.evaluate((l) => performance.mark(l), label)
  const collecting = win.evaluate(COLLECT(label, space))
  const hit = await enterSpace(win, SPACE_NAMES[space], { real: true })
  // 首进的骨架截一张(第一轮):DESIGN §8 自查「三栏同时出骨架」到底长什么样。
  if (n === 1 && run === 1 && hit) { await sleep(160); await captureWindow(app, path.join(shots, `firstenter-${space}-skeleton.png`)) }
  const m = await collecting
  const active = await activeSpace(win)
  return { space, n, hit, active, ...m, net: net.since(tNode) }
}

async function oneLaunch(run, shots) {
  const env = await launch({ tag: 'firstenter', overrideHome: true })
  const out = []
  try {
    await boot(env.app, env.win, { space: 'tangu', width: 1440, height: 900 })
    await sleep(1500)
    await env.win.evaluate(INSTALL)
    if (PREFETCH) {
      // 模拟「空闲时预取分块」:JS 模块 import() 进缓存,但 React.lazy 的 payload 仍是未解析态。
      // Vite 的 __vitePreload 解析 lazy 分块前还会等它的 CSS 依赖 <link> 加载完;只 import() JS 的话首进仍要拉 CSS,
      // 对照不完整。这里把 CSS 依赖也挂上(preload 见到同 href 的 link 就跳过)。名单按实测首进拉的分块定,
      // 分块改名后对照断言(3)会红,照 U40_VERBOSE 的「分块」列补正则。
      const assets = fs.readdirSync(path.join(ROOT, 'out/renderer/assets'))
      const js = assets.filter((f) => /^(CalendarView|TodoListView|CalendarConfigView|ArtificialView)-.*\.js$/.test(f))
      const css = assets.filter((f) => /^(astryxBridge|artificial)-.*\.css$/.test(f))
      const res = await env.win.evaluate(async ({ js: js_, css: css_ }) => {
        const jsOk = await Promise.all(js_.map((f) => import(`./assets/${f}`).then(() => true, () => false)))
        const cssOk = await Promise.all(css_.map((f) => new Promise((resolve) => {
          const l = document.createElement('link')
          l.rel = 'stylesheet'
          l.href = new URL(`./assets/${f}`, location.href).href
          l.onload = () => resolve(true); l.onerror = () => resolve(false)
          document.head.appendChild(l)
        })))
        return { jsOk, cssOk }
      }, { js, css })
      prefetchLog.push({ js: js.length, jsOk: res.jsOk.filter(Boolean).length, css: css.length, cssOk: res.cssOk.filter(Boolean).length })
      await sleep(800)
    }
    const net = netRecorder(env.win)
    for (const space of ['calendar', 'artificial']) {
      out.push(await enterAndMeasure(env.app, env.win, space, 1, shots, run, net))
      await enterSpace(env.win, SPACE_NAMES.tangu, { real: true })
      await sleep(900)
      out.push(await enterAndMeasure(env.app, env.win, space, 2, shots, run, net))
      await enterSpace(env.win, SPACE_NAMES.tangu, { real: true })
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
  console.log('\n 轮 | Space      | 第几次 | 落定ms | 最长骨架ms | 可见骨架区(≥150ms) | 造物转圈ms | 分块(个 / 最晚到达ms) | 长任务(个 / 合计 / 最长 ms) | 数据请求(起→止 ms)')
  for (const r of all) {
    console.log(` ${r.run}  | ${r.space.padEnd(10)} | ${r.n}      | ${String(r.settled).padStart(6)} | ${String(r.maxVisible).padStart(10)} | ${(r.regions.join('+') || '-').padEnd(18)} | ${String(r.spinner).padStart(10)} | ${`${r.net.assets.n} / ${r.net.assets.lastEnd}`.padEnd(20)} | ${`${r.longTask.n} / ${r.longTask.ms} / ${r.longTask.max}`.padEnd(26)} | ${r.net.data.join(', ') || '-'}`)
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
    // 预取对照组里骨架消失正是「预取有效」的结果,不能判红;只在基线组要求首进挂出过骨架。
    R.check(PREFETCH
      ? `1 ${space}:${first.length} 轮都点进去了(对照组:骨架出没出现只记数、不判)`
      : `1 ${space}:${first.length} 轮都点进去了,且首进挂出过骨架(否则首进不走 lazy,基线无意义)`,
      first.length === RUNS && first.every((r) => r.hit && r.active === space && (PREFETCH || r.spans.length > 0)),
      JSON.stringify(first.map((r) => ({ hit: r.hit, active: r.active, spans: r.spans.length }))))
    R.check(`2 ${space}:同次启动再进没有可见骨架(≥${VISIBLE_MS}ms)—— 分块缓存生效`,
      again.length === RUNS && again.every((r) => r.hit && r.active === space && r.maxVisible < VISIBLE_MS),
      JSON.stringify(again.map((r) => r.maxVisible)))
  }
  if (PREFETCH) {
    // 对照组自证:预取全部成功,且首进一个分块都没再拉 —— 否则「预取省不省时间」的结论没有依据。
    const firsts = all.filter((r) => r.n === 1)
    R.check('3 预取对照组完整:JS / CSS 依赖全部预取成功,首进零分块请求',
      prefetchLog.length === RUNS && prefetchLog.every((p) => p.js > 0 && p.css > 0 && p.jsOk === p.js && p.cssOk === p.css) && firsts.length > 0 && firsts.every((r) => r.net.assets.n === 0),
      JSON.stringify({ prefetchLog, firstEntryAssets: firsts.map((r) => `${r.space}:${r.net.assets.names.join('+') || 0}`) }))
  }
  console.log(`SHOTS ${shots}`)
  process.exit(R.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
