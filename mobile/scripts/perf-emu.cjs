#!/usr/bin/env node
/**
 * Where the phone shell loses frames: the navigation gestures on the emulator, timed from inside the WebView.
 *   npm run emu:perf                        (debug build installed; `PKG=com.forsion.tangu.nativepreview` for the preview)
 *
 * The backend is stubbed like native-shell-emu.cjs (nothing reaches a server): 60 sessions, and a 60-message chat with
 * headings, lists, a code block and a table in every reply — long enough for the page to hold ~4800 elements.
 * Each row is one gesture: open a chat from the list, fling the chat, drag the page back, system back, fling the list,
 * switch Space on the Dock. Reported per row:
 *   raf N/M            frames the page's main thread produced in the window after the input, of M at 60 Hz
 *   loafMax            the longest stretch the main thread was frozen (long-animation-frame), and when after the input
 *   main script/style/layout   main-thread time by kind; the count after `style` is how many restyles ran
 *   gfx                what Android drew for the app in that window (dumpsys gfxinfo)
 * and once per run `insert`: what adding one element costs, deep in the chat and under <body> (a few ms; ~50 means some
 * selector makes every insertion restyle the whole page — see desktop/frontend/src/cssHasGuard.test.ts).
 *
 * RATES=1,4   CPU throttle (4 ≈ a mid-range phone when the emulator runs on a fast desktop; judge by 4, not by 1)
 * REPS=3      repetitions per rate        ONLY=open,scroll,drag,back,list,space
 * Machine load above ~6 makes the numbers meaningless: check `uptime` first, and never run next to a build.
 * The emulator's GPU is the host's: nothing here says what blur or raster cost on a real phone.
 *
 * Finding a cause (each prints to the console, artefacts under OUT):
 *   MODE=trace [RATE=4] [ROW=2]   devtools.timeline trace → what every long task after the input was made of
 *   MODE=profile                  CPU profiles of the slow gestures + the restyle cost of single mutations
 *   MODE=land [MSGS=short]        does the view stay at the bottom while a long chat mounts in batches? (frame by frame)
 *   MODE=exp EXP=<file.cjs>       your own measurements: a module exporting [{ label, js, n?, noForce?, poll? }]; each
 *                                 `js` is a function body run in the page with the chat open, style / layout time reported
 *   INJECT_CSS=<file.css>         try a stylesheet change on the installed build without rebuilding
 */
const h = require('./lib/emu-cdp.cjs')
const fs = require('node:fs')
const path = require('node:path')
const PKG = process.env.PKG || 'com.forsion.tangu'
const ACTIVITY = `${PKG}/com.forsion.tangu.AppActivity`
const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../outputs/perf-emu'))
const RATES = (process.env.RATES || '1,4').split(',').map(Number)
const REPS = Number(process.env.REPS || 3)
const ONLY = (process.env.ONLY || 'open,scroll,drag,back,list,space').split(',').filter(Boolean)
fs.mkdirSync(OUT, { recursive: true })

const T0 = Date.now()
const iso = (ago) => new Date(T0 - ago).toISOString()
const sessions = Array.from({ length: 60 }, (_, i) => ({ id: `perf-s${i}`, title: `Perf session ${i} — a title long enough to wrap or clip`, summary: 'Last line of the conversation shown under the title', model_id: null, archived: false, emoji: null,
  agent_config: { execMode: 'host', approvalMode: 'auto-edit' }, project_path: null, project_name: null, projectless: true, created_at: iso(i * 3600e3 + 6e4), updated_at: iso(i * 3600e3 + 6e4) }))
const REPLY = (i) => `## Section ${i}\n\nA paragraph of ordinary prose with **bold**, *emphasis*, \`inline code\` and a [link](https://example.com). It runs long enough to wrap over several lines on a phone, the way a real answer does when the model explains what it did and why.\n\n- first point with some detail\n- second point, a little longer than the first one\n  - a nested point\n- third point\n\n\`\`\`ts\nexport function sum(xs: number[]): number {\n  let total = 0\n  for (const x of xs) total += x\n  return total\n}\n\`\`\`\n\n| Name | Value | Note |\n|---|---|---|\n| alpha | 1 | first row |\n| beta | 2 | second row |\n| gamma | 3 | third row |\n\n1. step one\n2. step two\n3. step three\n\n> A quoted remark to close section ${i}.`
const SHORT = process.env.MSGS === 'short'
const messages = Array.from({ length: 60 }, (_, i) => ({ id: `perf-m${i}`, role: i % 2 ? 'model' : 'user', content: SHORT ? (i % 2 ? `ok ${i}` : `q ${i}`) : i % 2 ? REPLY(i) : `Question ${i}: please explain the thing in some detail, with an example.`, reasoning: null, tool_calls: null, tool_results: null, attachments: null, timestamp: T0 - (60 - i) * 6e4, model_id: null, is_error: false }))
const MODELS = [{ id: 'perf-model', name: 'Perf Model', provider: 'E2E', source: 'forsion', modelType: 'llm' }]

function installStub(cdp) {
  cdp.on('Fetch.requestPaused', (ev) => {
    const url = new URL(ev.request.url); const p = url.pathname; const m = ev.request.method
    const json = (data) => cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }).catch(() => {})
    if (m === 'OPTIONS') return cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: '*' }] }).catch(() => {})
    if (p.endsWith('/auth/me')) return json({ username: 'perf', id: 'perf' })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'e2e' })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: [] })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: [] })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: url.searchParams.get('archived') === 'true' ? [] : sessions })
    if (p.endsWith('/agent/runs')) return json({ runs: [] })
    if (p.endsWith('/agent/approvals/pending')) return json({ rev: 'p0', sessions: [] })
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: MODELS, directProviders: [], defaultModelId: MODELS[0].id })
    if (/\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) return json({ checkpoints: [] })
    if (/\/agent\/sessions\/[^/]+\/config$/.test(p)) return json({ agent_config: { execMode: 'host', approvalMode: 'auto-edit' } })
    if (/\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages })
    return cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionRefused' }).catch(() => {})
  })
  return cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.forsion.net*', requestStage: 'Request' }] })
}

const KIT = `(() => {
  if (window.__perf) return
  const P = (window.__perf = { on: false, frames: [], loaf: [], ev: [], marks: [] })
  let last = 0
  const r1 = (n) => Math.round(n * 10) / 10
  const tick = (t) => { if (!P.on) return; if (last) P.frames.push([r1(t), r1(t - last)]); last = t; requestAnimationFrame(tick) }
  const mark = (why, t) => { if (P.on) P.marks.push({ why, t: r1(t ?? performance.now()) }) }
  P.mark = mark
  P.start = () => {
    P.frames = []; P.loaf = []; P.ev = []; P.marks = []; P.on = true; last = 0
    const sh = document.querySelector('.mb-shell')
    if (P.mo) P.mo.disconnect()
    if (sh) { P.mo = new MutationObserver((l) => { for (const m of l) mark(m.attributeName + '=' + (sh.getAttribute(m.attributeName) ?? '')) }); P.mo.observe(sh, { attributes: true, attributeFilter: ['data-space', 'data-nav'] }) }
    requestAnimationFrame(tick); return performance.now()
  }
  P.stop = () => { P.on = false; return { now: performance.now(), marks: P.marks, frames: P.frames, loaf: P.loaf, ev: P.ev, noLoaf: P.noLoaf, noEv: P.noEv } }
  addEventListener('touchstart', (e) => mark('touchstart', e.timeStamp), { capture: true, passive: true })
  addEventListener('touchend', (e) => mark('touchend', e.timeStamp), { capture: true, passive: true })
  addEventListener('forsion:mobile-back', () => mark('back'), true)
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.loaf.push({ s: Math.round(e.startTime), d: Math.round(e.duration), block: Math.round(e.blockingDuration),
    style: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
    scripts: (e.scripts || []).map((s) => ({ inv: String(s.invoker).slice(0, 70), d: Math.round(s.duration), fn: s.sourceFunctionName, forced: Math.round(s.forcedStyleAndLayoutDuration) })).filter((s) => s.d >= 4) }) }).observe({ type: 'long-animation-frame' }) } catch (e) { P.noLoaf = String(e) }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.ev.push({ n: e.name, s: Math.round(e.startTime), d: Math.round(e.duration), wait: Math.round(e.processingStart - e.startTime), run: Math.round(e.processingEnd - e.processingStart) }) }).observe({ type: 'event', durationThreshold: 16 }) } catch (e) { P.noEv = String(e) }
})()`

const gfxReset = () => { try { h.adb('shell', 'dumpsys', 'gfxinfo', PKG, 'reset') } catch { /* */ } }
function gfx() {
  const t = h.adb('shell', 'dumpsys', 'gfxinfo', PKG)
  const n = (re) => { const m = t.match(re); return m ? Number(m[1]) : null }
  return { frames: n(/Total frames rendered: (\d+)/), janky: n(/Janky frames: (\d+)/), p50: n(/50th percentile: (\d+)ms/), p90: n(/90th percentile: (\d+)ms/), p95: n(/95th percentile: (\d+)ms/), p99: n(/99th percentile: (\d+)ms/),
    missedVsync: n(/Number Missed Vsync: (\d+)/), slowUi: n(/Number Slow UI thread: (\d+)/), slowDraw: n(/Number Slow issue draw commands: (\d+)/), deadline: n(/Number Frame deadline missed: (\d+)/) }
}

;(async () => {
  h.adb('shell', 'am', 'force-stop', PKG)
  try { h.adb('shell', 'cmd', 'statusbar', 'collapse') } catch { /* */ }
  h.adb('shell', 'am', 'start', '-n', ACTIVITY)
  const cdp = await h.connect(PKG)
  await cdp.send('Page.enable')
  await cdp.send('Performance.enable')
  const saved = await cdp.eval(`(async () => ({ token: (await Capacitor.Plugins.Preferences.get({ key: 'forsion_token' })).value, locale: localStorage.getItem('tangu_locale'), onboarding: localStorage.getItem('forsion_tangu_onboarding_done') }))()`)
  await cdp.eval(`(async () => { await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: 'e2e-native-shell.fake.token' }); localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('tangu_locale', 'zh'); return true })()`)
  await installStub(cdp)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: KIT })
  await cdp.send('Page.reload', { ignoreCache: true })
  await h.pause(800)
  if (!(await h.waitPage(cdp, "!!document.querySelector('.shell-host .mb-shell')", 25000))) throw new Error('shell did not mount')
  h.adb('shell', 'am', 'start', '-n', ACTIVITY)
  await h.waitNodes((l) => h.byId(l, 'nativeChrome.bar'), { timeout: 12000 })
  await cdp.eval(KIT)
  const ui = () => h.nodes(OUT)
  const wv = () => ui().find((n) => n.class === 'android.webkit.WebView')
  const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const setRate = async (rate) => { try { await cdp.send('Emulation.setCPUThrottlingRate', { rate }); return true } catch (e) { console.log('no CPU throttle here:', e.message); return false } }
  async function elPoint(expr) {
    const r = await cdp.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); let z = 1; for (let e = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1; return { x: (r.left + r.width / 2) * z, y: (r.top + r.height / 2) * z, dpr: devicePixelRatio } })()`)
    if (!r) throw new Error(`element missing: ${expr}`)
    const w = wv()
    return { x: Math.round(w.rect.left + r.x * r.dpr), y: Math.round(w.rect.top + r.y * r.dpr) }
  }
  const nav = "document.querySelector('.mb-shell')?.dataset.nav || ''"
  const space = "document.querySelector('.mb-shell')?.dataset.space || ''"
  const spaceIds = () => h.byIdPrefix(ui(), 'nativeChrome.space.').map((n) => n['resource-id'].slice('nativeChrome.space.'.length))
  async function toSpace(id) {
    const n = h.byId(ui(), `nativeChrome.space.${id}`)
    if (!n) throw new Error(`no Dock cell ${id} (have ${spaceIds().join(',')})`)
    h.tapNode(n)
    await h.waitPage(cdp, `${space} === ${JSON.stringify(id)}`, 6000)
    await h.pause(900)
  }

  const results = []
  /** One measured gesture. `from` = the mark that starts the window (first mark matching), window `win` ms. */
  async function run(name, rate, act, { settle = 1300, from = /touchstart|back|data-/, win = 700 } = {}) {
    gfxReset()
    const m0 = await met()
    await cdp.eval('__perf.start()')
    await act()
    await h.pause(settle)
    const p = await cdp.eval('__perf.stop()')
    const m1 = await met()
    const g = gfx()
    const t0 = p.marks.find((m) => from.test(m.why))?.t
    const inWin = (t) => t0 != null && t >= t0 && t <= t0 + win
    const fr = p.frames.filter((f) => inWin(f[0]))
    const gaps = fr.map((f) => f[1])
    const ms = (k) => Math.round((m1[k] - m0[k]) * 1000)
    const row = {
      name, rate,
      marks: p.marks.filter((m) => t0 == null || (m.t >= t0 - 5 && m.t <= t0 + 1500)).map((m) => `${m.why}@${t0 == null ? m.t : Math.round(m.t - t0)}`).slice(0, 8),
      rafFrames: fr.length, rafExpected: Math.round(win / 16.67), rafOver25: gaps.filter((x) => x > 25).length, rafOver50: gaps.filter((x) => x > 50).length, rafMax: gaps.length ? Math.max(...gaps) : null,
      loaf: p.loaf.filter((l) => t0 == null || (l.s + l.d >= t0 && l.s <= t0 + 1200)).map((l) => ({ at: t0 == null ? l.s : Math.round(l.s - t0), d: l.d, block: l.block, style: l.style, scripts: l.scripts })),
      events: p.ev.filter((e) => /pointerup|click|touchend|pointerdown|touchstart/.test(e.n)).map((e) => `${e.n}:${e.d}ms(wait ${e.wait}, run ${e.run})`),
      main: { script: ms('ScriptDuration'), style: ms('RecalcStyleDuration'), layout: ms('LayoutDuration'), task: ms('TaskDuration'), styleN: m1.RecalcStyleCount - m0.RecalcStyleCount, layoutN: m1.LayoutCount - m0.LayoutCount },
      gfx: g, noLoaf: p.noLoaf, noEv: p.noEv,
    }
    results.push(row)
    const worst = row.loaf.reduce((a, l) => (l.d > (a?.d || 0) ? l : a), null)
    console.log(`${String(rate)}x ${name.padEnd(22)} raf ${String(row.rafFrames).padStart(2)}/${row.rafExpected} >25:${row.rafOver25} >50:${row.rafOver50} max ${row.rafMax}  loafMax ${worst ? `${worst.d}ms@${worst.at}` : '-'}  main script ${row.main.script} style ${row.main.style}(${row.main.styleN}) layout ${row.main.layout}(${row.main.layoutN})  gfx ${g.frames}f janky ${g.janky} p90 ${g.p90} p99 ${g.p99}  ${row.marks.join(' ')}`)
    return row
  }
  const want = (k) => !ONLY.length || ONLY.includes(k)

  console.log('Dock cells:', spaceIds().join(','), '| space', await cdp.eval(space), '| nav', await cdp.eval(nav), '| zoom', await cdp.eval('getComputedStyle(document.body).zoom'), '| dpr', await cdp.eval('devicePixelRatio'), '| UA', (await cdp.eval('navigator.userAgent')).match(/Chrome\/[\d.]+/)?.[0])
  if ((await cdp.eval(space)) !== 'tangu') await toSpace('tangu')
  if (!(await h.waitPage(cdp, "document.querySelectorAll('.mb-drawer--left .t2s-srow').length >= 20", 12000))) throw new Error(`session rows missing: ${await cdp.eval("document.querySelectorAll('.mb-drawer--left .t2s-srow').length")}`)
  const row = (i) => `document.querySelectorAll('.mb-drawer--left .t2s-srow')[${i}]`
  const W = wv().rect
  const midY = Math.round((W.top + W.bottom) / 2)
  const openChat = async (i) => { const p = await elPoint(row(i)); h.tapAt(p.x, p.y) }
  const inDetail = () => h.waitPage(cdp, `${nav} === 'detail' && document.querySelectorAll('.t2-stream .t2-msg, .t2-stream [data-msg-id], .t2-stream .t2m').length >= 1`, 8000)
  const inList = () => h.waitPage(cdp, `${nav} === 'list'`, 6000)
  const ensureList = async () => { for (let i = 0; i < 6 && (await cdp.eval(nav)) !== 'list'; i++) { h.key(4); await h.pause(1100) } if ((await cdp.eval(nav)) !== 'list') throw new Error('could not get back to the list') ; await h.pause(400) }
  const ensureDetail = async (i) => { if ((await cdp.eval(nav)) === 'detail') return; await openChat(i); await inDetail(); await h.pause(1400) }

  if (process.env.INJECT_CSS) { await cdp.eval(`(() => { const st = document.createElement('style'); st.id = 'perf-inject'; st.textContent = ${JSON.stringify(fs.readFileSync(process.env.INJECT_CSS, 'utf8'))}; document.head.appendChild(st); return true })()`); console.log('injected', process.env.INJECT_CSS) }
  if (process.env.MODE === 'exp') {
    // one-off experiments: a module exporting [{ label, js, n? }] — each `js` runs in the page, then layout is forced
    await ensureDetail(0)
    for (const x of require(path.resolve(process.env.EXP))) {
      for (let i = 0; i < (x.n || 2); i++) {
        const m0 = await met()
        const out = await cdp.eval(`(() => { const t = performance.now(); const r = (() => { ${x.js} })(); ${x.noForce ? '' : 'void document.body.offsetHeight;'} return [Math.round((performance.now() - t) * 10) / 10, r === undefined ? null : r] })()`)
        if (x.poll) { for (let k = 0; k < 240 && !(out[1] = await cdp.eval(x.poll)); k++) await h.pause(1000) }
        const m1 = await met()
        console.log(`exp ${x.label.padEnd(46)} style ${String(Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000)).padStart(4)}ms  layout ${String(Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000)).padStart(4)}ms  wall ${out[0]}ms  ${out[1] == null ? '' : JSON.stringify(out[1]).slice(0, 9000)}`)
        await h.pause(250)
      }
    }
  }
  if (process.env.MODE === 'land') {
    // Where the view sits while a long chat mounts in batches (the last messages first, earlier ones above them when the
    // browser is idle). Sampled every frame from the first message on: the distance to the bottom must stay ~0 — a frame
    // away from it is a visible jump. MSGS=short is the case scroll anchoring cannot cover (nothing is scrolled yet).
    for (const rate of RATES) {
      if (!(await setRate(rate)) && rate !== 1) continue
      await ensureList()
      await cdp.eval(`(() => { const L = (window.__land = { on: true, s: [] }); const tick = (t) => { if (!L.on) return
        const sc = [...document.querySelectorAll('.t2-stream')].find((e) => e.offsetParent)
        const n = sc ? sc.querySelectorAll('.t2-stream-inner > .t2-asst, .t2-stream-inner > .t2-userwrap').length : 0
        if (n) L.s.push([Math.round(t), n, Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), sc.scrollHeight > sc.clientHeight + 1 ? 1 : 0])
        requestAnimationFrame(tick) }; requestAnimationFrame(tick); return true })()`)
      await openChat(RATES.indexOf(rate)); await inDetail(); await h.pause(rate > 1 ? 5000 : 2500) // a row not opened yet: reopening the same chat mounts nothing
      const smp = await cdp.eval('(() => { __land.on = false; return __land.s })()')
      const steps = smp.filter((x, i) => !i || x[1] !== smp[i - 1][1]).map((x) => `${x[1]}@${x[0] - smp[0][0]}`)
      const off = smp.filter((x) => x[2] > 8)
      console.log(`${rate}x land${SHORT ? ' (short messages)' : ''}: ${smp.length} frames · messages on the page ${steps.join(' → ')} · frames away from the bottom ${off.length}${off.length ? ` (worst ${Math.max(...off.map((x) => x[2]))}px, first at +${off[0][0] - smp[0][0]}ms with ${off[0][1]} messages)` : ''} · ends ${smp.length ? smp[smp.length - 1][2] : '?'}px from the bottom, ${smp.length && smp[smp.length - 1][3] ? 'scrollable' : 'not scrollable'}`)
      results.push({ name: 'land', rate, short: SHORT, steps, offFrames: off.length, worst: off.length ? Math.max(...off.map((x) => x[2])) : 0 })
      h.screenshot(OUT, `land-${rate}x${SHORT ? '-short' : ''}`)
      h.key(4); await h.pause(1200)
    }
  }
  if (process.env.MODE === 'trace') {
    // devtools.timeline trace of one gesture → what each long main-thread task was made of
    const rate = Number(process.env.RATE || 4)
    const trace = async (label, act, settle = 2500) => {
      const events = []
      const onData = (p) => { events.push(...p.value) }
      cdp.handlers.set('Tracing.dataCollected', [onData])
      await setRate(rate)
      await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8'], excludedCategories: ['*'] } })
      await cdp.eval("performance.mark('probe-armed')")
      await act(); await h.pause(settle)
      const done = new Promise((r) => cdp.on('Tracing.tracingComplete', r))
      await cdp.send('Tracing.end'); await done
      await setRate(1)
      fs.writeFileSync(path.join(OUT, `trace-${label}.json`), JSON.stringify(events))
      // main thread = the thread with the most RunTask time
      const X = events.filter((e) => e.ph === 'X' && e.dur)
      const byTid = new Map(); for (const e of X) if (e.name === 'RunTask') byTid.set(e.tid, (byTid.get(e.tid) || 0) + e.dur)
      const main = [...byTid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      const mt = X.filter((e) => e.tid === main)
      const input = mt.find((e) => e.name === 'EventDispatch' && /touchstart|keydown|click/.test(e.args?.data?.type || ''))
      const t0 = input ? input.ts : mt[0].ts
      const tasks = mt.filter((e) => e.name === 'RunTask' && e.dur >= Number(process.env.MIN_TASK || 20) * 1000 && e.ts >= t0 - 50000).sort((a, b) => a.ts - b.ts)
      console.log(`\n== trace ${label} @${rate}x — long tasks after the input (${input ? input.args.data.type : 'no input event found'})`)
      for (const t of tasks) {
        const inside = mt.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur)
        const sum = new Map()
        for (const e of inside) {
          if (!['UpdateLayoutTree', 'Layout', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'MinorGC', 'MajorGC', 'V8.GC_MC_BACKGROUND_MARKING', 'RunMicrotasks', 'ParseHTML', 'EvaluateScript', 'UpdateLayer', 'HitTest', 'IntersectionObserverController::computeIntersections', 'ResizeObserverController::gatherObservations'].includes(e.name) && !/GC/.test(e.name)) continue
          const k = e.name === 'EventDispatch' ? `Event(${e.args?.data?.type})` : e.name === 'UpdateLayoutTree' ? 'Style' : e.name
          const a = sum.get(k) || { ms: 0, n: 0, els: 0 }; a.ms += e.dur / 1000; a.n++; a.els += e.args?.elementCount || 0; sum.set(k, a)
        }
        const parts = [...sum.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 9).map(([k, a]) => `${k} ${a.ms.toFixed(0)}ms×${a.n}${a.els ? `(${a.els} els)` : ''}`)
        console.log(`  +${String(Math.round((t.ts - t0) / 1000)).padStart(5)}ms  task ${String(Math.round(t.dur / 1000)).padStart(4)}ms  ${parts.join(' · ')}`)
      }
    }
    await ensureList()
    await trace('open-cold', () => openChat(Number(process.env.ROW || 7))); await inDetail(); await h.pause(800)
    await trace('back', async () => { h.key(4) }); await ensureList()
    await trace('open-again', () => openChat(Number(process.env.ROW || 7))); await inDetail(); await h.pause(800)
    await ensureList()
    await trace('open-other', () => openChat(Number(process.env.ROW || 7) + 1)); await inDetail(); await h.pause(800)
    const u = await elPoint("[...document.querySelectorAll('.t2-stream *')].find((e) => { const r = e.getBoundingClientRect(); return e.children.length === 0 && r.top > innerHeight * 0.35 && r.top < innerHeight * 0.6 && r.width > 40 && !e.closest('pre, table, .md-table-scroll') })")
    await trace('drag-back', async () => { h.adb('shell', 'input', 'swipe', '300', String(u.y), '980', String(u.y), '600') })
    await ensureList()
  }
  if (process.env.MODE === 'profile') {
    // (1) where a full style pass comes from: one mutation at a time, forced with offsetHeight, chat mounted
    await ensureDetail(0)
    const cost = async (label, js) => {
      const m0 = await met()
      const wall = await cdp.eval(`(() => { const t = performance.now(); ${js}; void document.body.offsetHeight; return Math.round((performance.now() - t) * 10) / 10 })()`)
      const m1 = await met()
      console.log(`mut ${label.padEnd(44)} style ${String(Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000)).padStart(4)}ms  layout ${String(Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000)).padStart(4)}ms  wall ${wall}ms`)
      await h.pause(250)
    }
    const flip = (sel, js) => `{ const e = document.querySelector(${JSON.stringify(sel)}); ${js} }`
    for (let i = 0; i < 2; i++) {
      await cost('nothing (baseline)', '')
      await cost('body --nc-bottom 0→88', "document.body.style.setProperty('--nc-bottom', '88')")
      await cost('body --nc-bottom 88→(removed)', "document.body.style.removeProperty('--nc-bottom')")
      await cost('.mb-shell data-nav detail→list', flip('.mb-shell', "e.dataset.nav = 'list'"))
      await cost('.mb-shell data-nav list→detail', flip('.mb-shell', "e.dataset.nav = 'detail'"))
      await cost('.mb-body +push-left', flip('.mb-body', "e.classList.add('push-left')"))
      await cost('.mb-body -push-left', flip('.mb-body', "e.classList.remove('push-left')"))
      await cost('.mb-drawer--left +open', flip('.mb-drawer--left', "e.classList.add('open')"))
      await cost('.mb-drawer--left -open', flip('.mb-drawer--left', "e.classList.remove('open')"))
      await cost('.mb-shell data-chrome off', flip('.mb-shell', "e.dataset.chrome = 'off'"))
      await cost('.mb-shell data-chrome (removed)', flip('.mb-shell', "delete e.dataset.chrome"))
      await cost('.mb-body --mb-p (one write)', flip('.mb-body', "e.style.setProperty('--mb-p', '0.5')"))
      await cost('.mb-body --mb-p (removed)', flip('.mb-body', "e.style.removeProperty('--mb-p')"))
      await cost(':root data-glass off', "document.documentElement.dataset.glass = 'off'")
      await cost(':root data-glass (removed)', "delete document.documentElement.dataset.glass")
      await cost('one message +class', flip('.t2-stream p', "e.classList.add('x-probe')"))
    }
    // (2) CPU profiles of the slow gestures (minified names; native getters and chunk names are readable)
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
    const prof = async (label, act, settle = 2200) => {
      await cdp.send('Profiler.start'); await act(); await h.pause(settle)
      const { profile } = await cdp.send('Profiler.stop')
      fs.writeFileSync(path.join(OUT, `profile-${label}.cpuprofile`), JSON.stringify(profile))
      const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((n) => [n.id, n]))
      profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame; const k = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber}:${f.columnNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000) })
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).filter(([k]) => !/^\(idle\)/.test(k)).slice(0, 28)
      console.log(`\n== profile ${label} (self ms)`); for (const [k, v] of top) console.log(`  ${v.toFixed(1).padStart(7)}  ${k}`)
    }
    await ensureList()
    await prof('open', () => openChat(3)); await inDetail()
    await prof('first-fling', async () => { h.adb('shell', 'input', 'swipe', '540', String(midY - 300), '540', String(midY + 500), '120') })
    await prof('back', async () => { h.key(4) }); await ensureList()
    await toSpace('amadeus')
    await prof('dock-tangu', async () => { h.tapNode(h.byId(ui(), 'nativeChrome.space.tangu')) })
    // (3) is the Tracing domain reachable here (for style invalidation attribution)?
    try { await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' }); await h.pause(300); await cdp.send('Tracing.end'); console.log('\nTracing: available on the page target') } catch (e) { console.log('\nTracing: not on the page target —', e.message) }
  }
  for (const rate of (['profile', 'exp', 'trace', 'land'].includes(process.env.MODE) ? [] : RATES)) {
    const throttled = await setRate(rate)
    if (!throttled && rate !== 1) continue
    await h.pause(400)
    for (let r = 0; r < REPS; r++) {
      await ensureList()
      if (want('open')) { await run('open (row → chat)', rate, () => openChat(r), { settle: 2000 }); await inDetail() }
      else await ensureDetail(r)
      if (r === 0 && rate === RATES[0]) console.log('   insert one element [in a message, under <body>] ms:', await cdp.eval(`(() => { const ms = (sel) => { const host = document.querySelector(sel); const one = () => { void document.body.offsetHeight; const t = performance.now(); const p = document.createElement('span'); host.appendChild(p); void document.body.offsetHeight; p.remove(); void document.body.offsetHeight; return performance.now() - t }; one(); one(); return Math.round(Math.min(one(), one(), one()) * 10) / 10 }; return JSON.stringify([ms('.t2-stream-inner > .t2-asst'), ms('body')]) })()`))
      if (r === 0 && rate === RATES[0]) console.log('   chat DOM:', await cdp.eval("JSON.stringify({ nodes: document.querySelector('.mb-main').querySelectorAll('*').length, all: document.querySelectorAll('*').length, streamH: document.querySelector('.t2-stream')?.scrollHeight })"))
      if (want('scroll')) {
        const fling = async () => { h.adb('shell', 'input', 'swipe', String(540), String(midY - 300), String(540), String(midY + 500), '120') }
        await run('chat fling (glass on)', rate, fling, { settle: 1800, win: 1200 })
        await cdp.eval("document.documentElement.dataset.glass = 'off', true"); await h.pause(300)
        await run('chat fling (glass off)', rate, fling, { settle: 1800, win: 1200 })
        await cdp.eval("delete document.documentElement.dataset.glass, true"); await h.pause(300)
      }
      if (want('drag')) {
        await ensureDetail(r)
        const u = await elPoint("[...document.querySelectorAll('.t2-stream *')].find((e) => { const r = e.getBoundingClientRect(); return e.children.length === 0 && r.top > innerHeight * 0.35 && r.top < innerHeight * 0.6 && r.width > 40 && !e.closest('pre, table, .md-table-scroll') })")
        await run('drag back (x=300)', rate, async () => { h.adb('shell', 'input', 'swipe', '300', String(u.y), '980', String(u.y), '600') }, { settle: 1500, win: 600 })
        await ensureDetail(r)
        await run('edge swipe (x=6)', rate, async () => { h.adb('shell', 'input', 'swipe', '6', String(midY), '900', String(midY), '600') }, { settle: 1500, from: /back|data-/, win: 700 })
      }
      if (want('back')) {
        await ensureDetail(r)
        for (let i = 0; i < 5 && (await cdp.eval(nav)) !== 'list'; i++) {
          const rowB = await run('back', rate, async () => { h.key(4) }, { settle: 1500 })
          rowB.name = (await cdp.eval(nav)) === 'list' ? 'back (chat → list)' : 'back (chat → earlier chat)'
          console.log('   ↑', rowB.name)
        }
      }
      await ensureList()
      if (want('list')) await run('list fling', rate, async () => { h.adb('shell', 'input', 'swipe', '540', String(midY + 400), '540', String(midY - 400), '120') }, { settle: 1800, win: 1200 })
      if (want('space')) {
        const other = spaceIds().find((s) => !['tangu', 'home', 'more', 'all'].includes(s)) || 'home'
        const cell = h.byId(ui(), `nativeChrome.space.${other}`)
        await run(`Dock → ${other}`, rate, async () => { h.tapNode(cell) }, { settle: 1800, from: /data-space/ })
        const back = h.byId(ui(), 'nativeChrome.space.tangu')
        await run('Dock → tangu', rate, async () => { h.tapNode(back) }, { settle: 1800, from: /data-space/ })
        await h.waitPage(cdp, "document.querySelectorAll('.mb-drawer--left .t2s-srow').length >= 20", 8000)
      }
    }
  }
  await setRate(1)

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ pkg: PKG, at: new Date().toISOString(), results }, null, 1))
  // put the app back as it was
  await cdp.send('Fetch.disable').catch(() => {})
  await cdp.eval(`(async () => { ${saved.token ? `await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(saved.token)} })` : `await Capacitor.Plugins.Preferences.remove({ key: 'forsion_token' })`}
    ${saved.locale ? `localStorage.setItem('tangu_locale', ${JSON.stringify(saved.locale)})` : `localStorage.removeItem('tangu_locale')`}
    ${saved.onboarding ? '' : `localStorage.removeItem('forsion_tangu_onboarding_done')`}; return true })()`).catch(() => {})
  cdp.close()
  h.adb('shell', 'am', 'force-stop', PKG)
  console.log('done →', path.join(OUT, 'results.json'))
  process.exit(0)
})().catch((e) => { console.error('PROBE FAILED:', e && e.stack || e); try { h.adb('shell', 'am', 'force-stop', PKG) } catch { /* */ } process.exit(1) })
