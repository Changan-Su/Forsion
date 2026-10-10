/** Real Electron: native controls, state replay, theme, narrow layout and sandbox boundary.
 * npm run build && npm run check:visualize
 * LIVE_SKETCH_HTML=<real-model fragment> also renders and exercises that generated output.
 */
const electron = require('./lib/launch-electron.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const out = path.resolve(process.env.VISUALIZE_OUT || path.join(ROOT, 'outputs/visualize-acceptance'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-visualize-'))
const sid = 'visualize-acceptance'
const html = fs.readFileSync(path.join(__dirname, 'fixtures/sketch-wave.html'), 'utf8')
const figuresHtml = fs.readFileSync(path.join(__dirname, 'fixtures/sketch-figures.html'), 'utf8')
const partsHtml = fs.readFileSync(path.join(__dirname, 'fixtures/sketch-parts.html'), 'utf8') // 10-09 二轮:统一拼装部件 compare / checklist / choice
const config = { execMode: 'host', cwd: home }
const session = { id: sid, title: 'Visualize acceptance', archived: false, model_id: 'm1', agent_config: config, projectless: false, project_path: home, project_name: 'Visualize', created_at: '2026-10-01 00:00:00', updated_at: '2026-10-01 00:00:00' }
const message = (id, content) => ({ id: `message-${id}`, role: 'model', content: '', timestamp: 2, tool_calls: [{ id, function: { name: 'sketch', arguments: JSON.stringify({ html: content }) }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: id, content: 'Sketch card rendered in the conversation.' }] })
let app, win
async function main() {
  fs.mkdirSync(out, { recursive: true })
  const messages = [message('wave', html), message('wave-other', html), message('figures', figuresHtml), message('parts', partsHtml)]
  if (process.env.LIVE_SKETCH_HTML) messages.push(message('live', fs.readFileSync(process.env.LIVE_SKETCH_HTML, 'utf8')))
  if (process.env.LIVE_FIGURES_HTML) messages.push(message('live-figures', fs.readFileSync(process.env.LIVE_FIGURES_HTML, 'utf8')))
  const stub = await startStubEngine({ sessions: [session], messages, override: async ({ path: p, method }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p.endsWith('/config')) return { agent_config: config }
  } })
  try {
    const ud = path.join(home, 'userdata')
    for (const dir of [ud, `${ud}-dev`]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'test' }))
    }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    win.setDefaultTimeout(20000)
    const errors = []
    win.on('pageerror', (e) => { errors.push(String(e)); console.error('RENDER ERROR', String(e)) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1100))
    await win.waitForSelector('#root')
    await win.waitForTimeout(1800)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByText(label, { exact: true }).first()
      if (await button.count()) { await button.click(); break }
    }
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload()
    const releaseScrollAnchor = async () => {
      const box = await win.locator('[data-chat-surface="chat"] .t2-stream').boundingBox()
      if (!box) throw new Error('Chat stream is missing')
      // ChatView intentionally ignores programmatic scrolling when following the tail.
      // A real upward gesture releases that anchor before inspecting an older card.
      await win.mouse.move(box.x + 4, box.y + Math.min(80, box.height / 2))
      await win.mouse.wheel(0, -360)
      await win.waitForTimeout(150)
    }
    const open = async () => {
      await win.locator('.t2s-srow, .t2o-row').filter({ hasText: session.title }).first().click()
      await win.locator('[data-sketch-call-id="wave"] iframe').waitFor()
      await releaseScrollAnchor()
    }
    await open()
    const card = win.locator('[data-sketch-call-id="wave"]')
    const frame = card.frameLocator('iframe')
    const other = win.locator('[data-sketch-call-id="wave-other"]').frameLocator('iframe')
    await win.waitForTimeout(600)
    await card.scrollIntoViewIfNeeded()
    assert.equal(await frame.locator('#wave-amplitude').inputValue(), '40')
    assert.equal(await card.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    const initialPath = await frame.locator('.wave-line').first().getAttribute('d')
    await frame.locator('#wave-amplitude').fill('70')
    assert.equal(await frame.locator('#wave-amplitude-value').textContent(), '70%')
    assert.notEqual(await frame.locator('.wave-line').first().getAttribute('d'), initialPath)
    assert.equal(await other.locator('#wave-amplitude').inputValue(), '40')
    await frame.getByRole('tab', { name: '三角波' }).click()
    assert.equal(await frame.locator('#wave-triangle-panel').isVisible(), true)
    await frame.getByRole('tab', { name: '三角波' }).press('ArrowLeft')
    assert.equal(await frame.locator('#wave-sine-panel').isVisible(), true)
    await card.screenshot({ path: path.join(out, 'light.png') })
    console.log('PASS slider updates SVG, independent cards, native tabs and keyboard')

    // A sibling/host message cannot overwrite the source-checked snapshot.
    await win.evaluate(() => window.postMessage({ type: 'sketch-state', state: { amplitude: 11 } }, '*'))
    await win.waitForFunction(() => JSON.parse(localStorage.getItem('forsion_sketch_state_v1') || '[]').some((e) => e.state?.amplitude === 70))
    await win.reload()
    await open()
    assert.equal(await frame.locator('#wave-amplitude').inputValue(), '70')
    assert.equal(await other.locator('#wave-amplitude').inputValue(), '40')
    const beforeTheme = await frame.locator('.wave-line').first().getAttribute('d')
    const beforeColor = await frame.locator('.wave-line').first().evaluate((el) => getComputedStyle(el).stroke)
    await win.locator('.rb-slot[data-id="rb-mode"] .rb-btn').click()
    await win.waitForTimeout(350)
    assert.equal(await frame.locator('#wave-amplitude').inputValue(), '70')
    assert.equal(await frame.locator('.wave-line').first().getAttribute('d'), beforeTheme)
    const afterColor = await frame.locator('.wave-line').first().evaluate((el) => getComputedStyle(el).stroke)
    assert.notEqual(afterColor, beforeColor)
    await card.screenshot({ path: path.join(out, 'dark.png') })
    console.log('PASS reload restores only this card; live theme preserves state and geometry')

    // Exact embedded width catches label/control overflow even with app-level narrow columns.
    await card.evaluate((el) => { el.style.width = '320px'; el.style.maxWidth = '100%' })
    await win.waitForTimeout(200)
    assert.equal(await frame.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true)
    await frame.locator('#wave-frequency').fill('4')
    assert.equal(await frame.locator('#wave-frequency-value').textContent(), '4')
    await card.screenshot({ path: path.join(out, 'narrow.png') })
    const security = await frame.locator('body').evaluate(async () => {
      let storage = false, network = false
      try { localStorage.getItem('test'); storage = true } catch {}
      try { await fetch('https://example.com/'); network = true } catch {}
      return { storage, network, bridge: !!window.tangu }
    })
    assert.deepEqual(security, { storage: false, network: false, bridge: false })
    console.log('PASS 320px layout and sandbox: no storage, network or native host bridge')

    const figures = win.locator('[data-sketch-call-id="figures"]')
    if (await figures.locator('.sketch-card-toggle').count()) await figures.locator('.sketch-card-toggle').click()
    const ff = figures.frameLocator('iframe')
    await ff.locator('.fs-chart-bar').first().waitFor()
    assert.equal(await ff.locator('.fs-chart-bar').count(), 3)
    assert.equal(await ff.locator('.fs-flow-step').count(), 4)
    assert.equal(await ff.locator('.fs-flow-branch').count(), 2)
    assert.equal(await ff.locator('.fs-flow-steps--vertical').count(), 0)
    const hit = ff.locator('.fs-chart-hit')
    await hit.focus()
    await hit.press('End')
    assert.match(await ff.locator('.fs-chart-detail').textContent(), /周五.*32/)
    await hit.press('Home')
    assert.match(await ff.locator('.fs-chart-detail').textContent(), /周一.*12/)
    await hit.evaluate((el) => el.blur())
    const captureFigures = async (theme) => {
      for (const [selector, name] of [['fs-chart[type="bar"]', 'bar'], ['fs-chart[type="line"]', 'line'], ['fs-flow', 'flow']]) {
        await releaseScrollAnchor()
        await ff.locator(selector).screenshot({ path: path.join(out, `${name}-${theme}.png`) })
      }
    }
    await captureFigures('dark')
    await win.locator('.rb-slot[data-id="rb-mode"] .rb-btn').click()
    await win.waitForTimeout(200)
    await captureFigures('light')
    await figures.evaluate((el) => { el.style.width = '320px'; el.style.maxWidth = '100%' })
    await win.waitForTimeout(200)
    assert.equal(await ff.locator('.fs-flow-steps--vertical').count(), 1)
    assert.equal(await ff.locator('.fs-chart-bars--narrow').count(), 1)
    assert.equal(await ff.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true)
    await captureFigures('narrow')
    // Numeric edge cases must retain an honest zero baseline; labels are text, never HTML.
    await ff.locator('fs-chart[type="bar"]').evaluate((el) => el.setData({ title: 'Signed data', data: [{ label: '<img src=x>', value: -10 }, { label: 'Zero', value: 0 }, { label: 'Positive', value: 10 }] }))
    assert.equal(await ff.locator('fs-chart img').count(), 0)
    const bars = await ff.locator('.fs-chart-bar').evaluateAll((els) => els.map((el) => [el.style.left, el.style.width]))
    assert.deepEqual(bars, [['0%', '50%'], ['50%', '0%'], ['50%', '50%']])
    await ff.locator('fs-chart[type="line"]').evaluate((el) => el.setData({ title: 'Small values', data: [{ label: 'A', value: .001 }, { label: 'B', value: .002 }] }))
    assert.equal(await ff.locator('.fs-chart-line').evaluate((el) => !/NaN|Infinity/.test(el.getAttribute('d'))), true)
    assert.match(await ff.locator('fs-chart[type="line"] title').textContent(), /0\.001/)
    await ff.locator('fs-chart[type="bar"]').evaluate((el) => el.setData({ emptyLabel: '数据无效', data: [{ label: 'Missing', value: null }] }))
    assert.equal(await ff.locator('fs-chart[type="bar"] [role="alert"]').textContent(), '数据无效')
    console.log('PASS chart baseline/labels/keyboard, responsive flow branches, invalid data and text escaping')

    if (process.env.LIVE_SKETCH_HTML) {
      const live = win.locator('[data-sketch-call-id="live"]')
      const toggle = live.locator('.sketch-card-toggle')
      if (await toggle.count()) await toggle.click()
      const lf = live.frameLocator('iframe')
      const slider = lf.locator('input[type="range"]').first()
      await slider.waitFor()
      const initial = await slider.inputValue()
      const next = await slider.evaluate((el) => el.value === el.max ? el.min : el.max)
      const before = await lf.locator('body').innerHTML()
      await slider.fill(next)
      assert.notEqual(await slider.inputValue(), initial)
      assert.notEqual(await lf.locator('body').innerHTML(), before)
      await win.waitForTimeout(300)
      await live.screenshot({ path: path.join(out, 'live-model.png') })
      await win.reload()
      await open()
      assert.equal(await slider.inputValue(), next)
      console.log('PASS real-model generated fragment renders, responds and restores its value')
    }
    // 统一部件:compare 画出 3 个选项 + 3 个追问钮;人数滑块经 setData 改 checklist 用量;勾选经 setState 存本机(重开会话还在);choice 3 个按钮
    {
      const pc = win.locator('[data-sketch-call-id="parts"]')
      await pc.scrollIntoViewIfNeeded()
      const pf = pc.frameLocator('iframe')
      await pf.locator('.fs-option').first().waitFor()
      assert.equal(await pf.locator('.fs-option').count(), 3)
      assert.equal(await pf.locator('.fs-option .fs-button').count(), 3)
      assert.equal(await pf.locator('.fs-choice-options .fs-button').count(), 3)
      assert.match(await pf.locator('.fs-checklist-items li').first().textContent(), /600 g/)
      await pf.locator('#parts-people').fill('8')
      assert.match(await pf.locator('.fs-checklist-items li').first().textContent(), /1200 g/)
      await pf.locator('.fs-checklist-items input').nth(1).check()
      await win.waitForFunction(() => JSON.parse(localStorage.getItem('forsion_sketch_state_v1') || '[]').some((e) => Array.isArray(e.state?.checklists?.['parts-shopping'])))
      await win.screenshot({ path: path.join(out, 'parts-page.png') }).catch(() => {})
      await pc.screenshot({ path: path.join(out, 'parts-card.png') })
      await win.reload()
      await open()
      await pc.scrollIntoViewIfNeeded()
      await pf.locator('.fs-option').first().waitFor()
      assert.equal(await pf.locator('.fs-checklist-items input').nth(1).isChecked(), true)
      assert.equal(await pf.locator('.fs-checklist-items input').nth(0).isChecked(), false)
      console.log('PASS unified parts: compare/choice render, slider rescales checklist via setData, ticks persist across reopen')
    }
    if (process.env.LIVE_FIGURES_HTML) {
      const live = win.locator('[data-sketch-call-id="live-figures"]')
      const toggle = live.locator('.sketch-card-toggle')
      if (await toggle.count()) await toggle.click()
      const lf = live.frameLocator('iframe')
      await lf.locator('.fs-chart-bar').first().waitFor()
      assert.equal(await lf.locator('.fs-chart-bar').count(), 3)
      assert.equal(await lf.locator('.fs-flow-step').count(), 4)
      assert.equal(await lf.locator('.fs-flow-branch').count(), 2)
      await live.screenshot({ path: path.join(out, 'live-model-figures.png') })
      await live.evaluate((el) => { el.style.width = '320px'; el.style.maxWidth = '100%' })
      await win.waitForTimeout(200)
      assert.equal(await lf.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true)
      await live.screenshot({ path: path.join(out, 'live-model-figures-narrow.png') })
      console.log('PASS real-model generated chart and flow: full data, parallel stages and narrow layout')
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, liveModel: !!process.env.LIVE_SKETCH_HTML, liveFigures: !!process.env.LIVE_FIGURES_HTML, screenshots: ['light.png', 'dark.png', 'narrow.png', ...['light', 'dark', 'narrow'].flatMap((mode) => ['bar', 'line', 'flow'].map((name) => `${name}-${mode}.png`))], errors }, null, 2))
    console.log(`PASS Visualize acceptance: ${out}`)
  } catch (error) {
    if (win) {
      await win.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
      console.error('Layout at failure', await win.locator('.sketch-card').evaluateAll((cards) => cards.map((card) => ({
        id: card.getAttribute('data-sketch-call-id'), rect: card.getBoundingClientRect().toJSON(),
        clip: card.querySelector('.sketch-clip')?.getBoundingClientRect().toJSON(),
      }))).catch(() => []))
    }
    throw error
  } finally {
    if (app) await app.close()
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
