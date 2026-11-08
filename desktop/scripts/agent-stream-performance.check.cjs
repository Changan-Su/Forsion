#!/usr/bin/env node
/** Real Electron + deterministic SSE, isolated profile. Build first. Run under devlock --vehicle=e2e.
 * npm run check:agentstream -- --json=<report> [--cpu=4] [--baseline] [--profile]
 * Measures automation-request-to-next-paint typing and real ribbon clicks during streaming.
 * --baseline records the old build without enforcing responsiveness budgets; correctness always gates.
 * This checks UI responsiveness and event delivery, not model behavior or real tool execution.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('node:assert/strict')
const U = require('./lib/uiux-electron.cjs')
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const reportPath = path.resolve(arg('json', path.join(os.tmpdir(), 'forsion-agent-stream.json')))
const cpu = Number(arg('cpu', '1'))
const baseline = process.argv.includes('--baseline')
const profile = process.argv.includes('--profile')
const sleep = U.sleep
const prefix = Array.from({ length: 35 }, (_, i) => [
  `## Section ${i}`,
  `Stable paragraph ${i}. **Strong text**, inline \`code\`, and $x^2 + y^2 = z^2$. `.repeat(3),
  '```typescript\n' + Array.from({ length: 8 }, (_, j) => `const result${j} = values.map(value => value + ${i + j});`).join('\n') + '\n```',
  '| A | B |\n|---|---|\n| stable | table |',
].join('\n\n')).join('\n\n') + '\n\n'
const chunks = Array.from({ length: 1600 }, (_, i) => `word${String(i).padStart(4, '0')} ${i % 8 === 7 ? '\n\n' : ''}`)
const stats = (values) => {
  const a = [...values].sort((x, y) => x - y)
  const at = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0)
  return { count: a.length, p50: at(.5), p95: at(.95), max: at(1) }
}

async function main() {
  const active = new Set()
  const { app, win, stub, close } = await U.launch({ tag: 'agent-stream-performance', stubOverride: ({ path: route, method }) => {
    // The shared stub normally returns no active runs. Long (>30s) fixtures must report
    // their live runs or the real watchdog correctly ends them before their SSE is finished.
    if (route === '/agent/runs' && method === 'GET') return { runs: [...active].map((id) => ({ id, status: 'running' })) }
  } })
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  const report = { baseline, profiled: profile, cpu, prefixChars: prefix.length, events: chunks.length, platform: process.platform,
    budgets: { typingP95Ms: 150, switchP95Ms: 700 }, typing: null, switches: [], errors }
  const waitForRun = async (count) => {
    const deadline = Date.now() + 15000
    while (stub.seen.runs.length <= count && Date.now() < deadline) await sleep(10)
    assert(stub.seen.runs.length > count, 'Enter must create the expected run before registering it as active')
    const run = stub.seen.runs[count]
    active.add(run.runId)
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    report.runtime = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click()
    const ta = win.locator('.t2c-ta').first()
    await ta.waitFor({ state: 'visible' })
    // Warm the destination before measuring clicks; no network or cold module load in the comparison.
    assert(await U.enterSpace(win, 'amadeus', { real: true }))
    assert(await U.enterSpace(win, 'tangu', { real: true }))
    await ta.waitFor({ state: 'visible' })
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    stub.script([
      { type: 'token', payload: { delta: prefix } },
      { type: 'token', delay: 1500, payload: { delta: 'STREAM_READY\n\n' } },
      ...chunks.map((delta) => ({ type: 'token', delay: 20, payload: { delta } })),
      { type: 'token', payload: { delta: '\n\nSTREAM_COMPLETE' } },
    ])
    await ta.fill('Stream performance fixture')
    const firstRunCount = stub.seen.runs.length
    await ta.press('Enter')
    await waitForRun(firstRunCount)
    await win.waitForFunction(() => [...document.querySelectorAll('.t2-content')].some((el) => el.textContent.includes('STREAM_READY')), null, { timeout: 30000 })
    await ta.click()
    await win.evaluate(() => {
      const sample = window.__streamPerf = { typed: [], frames: [], last: performance.now(), longTasks: [] }
      const frame = (now) => { sample.frames.push(now - sample.last); sample.last = now; sample.raf = requestAnimationFrame(frame) }
      sample.raf = requestAnimationFrame(frame)
      sample.observer = new PerformanceObserver((list) => sample.longTasks.push(...list.getEntries().map((e) => e.duration)))
      sample.observer.observe({ type: 'longtask', buffered: false })
      sample.input = (e) => {
        if (!e.target.matches('.t2c-ta')) return
        const sent = window.__keySentAt
        const streaming = !!document.querySelector('.t2-asst[data-streaming]')
        requestAnimationFrame(() => setTimeout(() => sample.typed.push({ ms: Date.now() - sent, streaming }), 0))
      }
      document.addEventListener('input', sample.input, true)
    })
    const draft = 'typing while the agent streams remains accurate and responsive'
    const typingStarted = Date.now()
    for (const ch of draft) {
      // Stamp via Node wall clock: includes the renderer queue, not just handler execution time.
      const sent = Date.now()
      await win.evaluate((at) => { window.__keySentAt = at }, sent)
      await win.keyboard.type(ch)
      await sleep(35)
    }
    report.typingWallMs = Date.now() - typingStarted
    console.log('Typing wall time:', report.typingWallMs)
    assert.equal(await ta.inputValue(), draft, 'every typed character must reach the draft in order')
    report.typingFinishedDuringRun = !!(await win.locator('.t2-asst[data-streaming]').count())
    if (!baseline) assert(report.typingFinishedDuringRun, 'run must still be streaming during typing')
    await win.waitForFunction(() => !document.querySelector('.t2-asst[data-streaming]') && [...document.querySelectorAll('.t2-content')].some((el) => el.textContent.includes('STREAM_COMPLETE')), null, { timeout: 60000 })
    active.clear()
    const words = await win.locator('.t2-content').allTextContents()
    assert.deepEqual(words.join('\n').match(/word\d{4}/g), chunks.map((c) => c.match(/word\d{4}/)[0]), 'all streamed words must appear once, in order')
    // A fresh run makes the switch measurement valid even when the baseline blocked typing
    // until its first run ended. Its output stays bounded so the failing baseline can recover.
    stub.script([
      { type: 'token', payload: { delta: prefix + '\nSWITCH_READY\n\n' } },
      ...Array.from({ length: 1000 }, (_, i) => ({ type: 'token', delay: 20, payload: { delta: `switch${i} ${i % 8 === 7 ? '\n\n' : ''}` } })),
      { type: 'token', payload: { delta: '\n\nSWITCH_COMPLETE' } },
    ])
    const secondRunCount = stub.seen.runs.length
    await ta.fill('Switch performance fixture'); await ta.press('Enter')
    await waitForRun(secondRunCount)
    await win.waitForFunction(() => [...document.querySelectorAll('.t2-content')].some((el) => el.textContent.includes('SWITCH_READY')))
    await ta.fill(draft)
    if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
    for (let i = 0; i < 3; i++) {
      for (const space of ['amadeus', 'tangu']) {
        const start = Date.now()
        assert(await U.enterSpace(win, space, { real: true }), `real click must activate ${space}`)
        const activated = Date.now()
        if (space === 'tangu') {
          await ta.waitFor({ state: 'visible' })
          assert.equal(await ta.inputValue(), draft, 'switching pages must preserve the draft')
          const active = !!(await win.locator('.t2-asst[data-streaming]').count())
          if (!active) report.switchFinishedAfterRun = true
          if (!baseline) assert(active, 'switches must occur during the run')
        }
        await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
        report.switches.push({ space, ms: Date.now() - start, activationMs: activated - start })
        await sleep(100)
      }
    }
    if (profile) fs.writeFileSync(reportPath + '.cpuprofile', JSON.stringify((await cdp.send('Profiler.stop')).profile))
    const sample = await win.evaluate(() => {
      const s = window.__streamPerf
      cancelAnimationFrame(s.raf); s.observer.disconnect(); document.removeEventListener('input', s.input, true)
      return { typed: s.typed, frames: s.frames, longTasks: s.longTasks }
    })
    // fill() calls used to start the second fixture are not key samples.
    sample.typed = sample.typed.slice(0, draft.length)
    assert.equal(sample.typed.length, draft.length, 'all key-to-paint samples must be present')
    report.typing = stats(sample.typed.map((x) => x.ms))
    report.keysDuringRun = sample.typed.filter((x) => x.streaming).length
    report.typingDuringRun = stats(sample.typed.filter((x) => x.streaming).map((x) => x.ms))
    report.frames = stats(sample.frames)
    report.longTasks = stats(sample.longTasks)
    report.switchLatency = stats(report.switches.map((x) => x.ms))
    report.samples = sample
    await win.waitForFunction(() => !document.querySelector('.t2-asst[data-streaming]') && [...document.querySelectorAll('.t2-content')].some((el) => el.textContent.includes('SWITCH_COMPLETE')), null, { timeout: 60000 })
    active.clear()
    const switched = (await win.locator('.t2-content').allTextContents()).join('\n').match(/switch\d+/g)
    assert.deepEqual(switched, Array.from({ length: 1000 }, (_, i) => `switch${i}`), 'background output must be complete after switching back')
    assert.equal(await ta.inputValue(), draft)
    report.screenshot = reportPath.replace(/\.json$/, '') + '.png'
    await win.screenshot({ path: report.screenshot })
    assert.equal(errors.length, 0, 'no uncaught renderer errors')
    report.correctnessPassed = true
    if (!baseline) {
      assert(report.typingDuringRun.p95 < report.budgets.typingP95Ms, `typing p95 ${report.typingDuringRun.p95}ms must stay below ${report.budgets.typingP95Ms}ms`)
      assert(report.switchLatency.p95 < report.budgets.switchP95Ms, `switch p95 ${report.switchLatency.p95}ms must stay below ${report.budgets.switchP95Ms}ms`)
    }
    report.passed = true
  } catch (e) {
    report.passed = false
    report.failure = e.stack || String(e)
    await win.screenshot({ path: reportPath + '.failure.png' }).catch(() => {})
    throw e
  } finally {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2))
    await close()
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
