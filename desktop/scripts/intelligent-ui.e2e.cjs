/** Native Intelligent UI in real isolated Electron. Stub transports deterministic events;
 * --evidence=<live archive raw directory> additionally replays actual GPT-6 Luna documents.
 * --demo leaves the isolated window open for review. Never touches installed app data. */
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'outputs/intelligent-ui')
const fixtures = require('./fixtures/intelligent-ui.json')
const DEMO = process.argv.includes('--demo')
const PREVIEW = process.argv.includes('--preview')
const evidence = process.argv.find(s => s.startsWith('--evidence='))?.slice(11)
const SESSION = { id: 's1', title: 'Forsion Intelligent UI', summary: '', model_id: 'm1', archived: false, agent_config: null, project_path: '/tmp/intelligent-ui-demo', project_name: 'Intelligent UI', created_at: '2026-10-09 09:00:00', updated_at: '2026-10-09 09:00:00' }
const argsOf = doc => JSON.stringify({ document: JSON.stringify(doc) })
const record = (id, callId, doc) => ({ id, role: 'model', content: '', timestamp: Date.now(), tool_calls: [{ id: callId, type: 'function', function: { name: 'intelligent_ui', arguments: argsOf(doc) }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: callId, name: 'intelligent_ui', content: 'Intelligent UI rendered.', isError: false }] })
async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  await ta.waitFor({ timeout: 15000 }); await ta.fill(text); await ta.press('Enter')
}
async function openSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30000 })
  await enterSpace(win, 'tangu')
  if (!(await win.locator('.t2s-search input').first().isVisible().catch(() => false))) await win.locator('.dv-edge-left').click().catch(() => {})
  await win.locator('.t2s-srow[data-sel-id="s1"]').first().click({ timeout: 15000 })
}
async function reveal(win, target) {
  const box = await win.locator('.t2-asst-col').first().boundingBox()
  await win.mouse.move(box.x + 40, 180)
  await win.mouse.wheel(0, -800)
  await target.evaluate(el => el.scrollIntoView({ block: 'start' }))
  await win.waitForTimeout(250)
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const checks = [], timings = []
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
  const stub = await startStubEngine({ sessions: [SESSION], messages: [], models: [{ id: 'm1', name: 'Intelligent UI test', provider: 'stub', contextWindow: 128000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-intelligent-ui-'))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'test' }))
  }
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  let win
  try {
    win = await app.firstWindow()
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await win.reload()
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) await b.first().click().catch(() => {}) }
    await openSession(win)
    if (PREVIEW) {
      const previews = [record('preview-dinner', 'preview-dinner', fixtures.dinner), record('preview-media', 'preview-media', fixtures.media), record('preview-research', 'preview-research', fixtures.research)]
      previews[0].content = 'Intelligent UI · 本地演示。人数、选项、清单与图片可直接操作。下方附真模型生成样本；此窗口使用隔离的测试后端。'
      if (evidence) for (const name of ['intelligentplan', 'intelligentmedia']) {
        const payload = JSON.parse(fs.readFileSync(path.join(evidence, `${name}-evidence.json`), 'utf8'))
        payload.documents.forEach((doc, i) => previews.push(record(`${name}-${i}`, `${name}-${i}`, doc)))
      }
      stub.state.messages = previews
      stub.script([{ type: 'token', payload: { delta: '此窗口是本地交互演示，追问消息已正确发送到测试后端。真实 GPT-6 Luna 生成结果见下面的样本与验证报告。' } }])
      await win.reload(); await openSession(win)
      await reveal(win, win.locator('[data-document-id="dinner"]'))
      await win.screenshot({ path: path.join(OUT, 'preview-dinner.png') })
      console.log(`PREVIEW_READY ${OUT}`)
      await new Promise(resolve => app.on('close', resolve))
      return
    }
    const args = argsOf(fixtures.dinner)
    const cut = args.indexOf('\\"id\\":\\"menu\\"') - 2
    assert.ok(cut > 0, 'stream boundary fixture')
    stub.script([
      { type: 'tool_stream', payload: { id: 'ui1', name: 'intelligent_ui', delta: args.slice(0, cut) }, delay: 100 },
      { type: 'tool_stream', payload: { id: 'ui1', name: 'intelligent_ui', delta: args.slice(cut) }, delay: 4000 },
      { type: 'tool_call', payload: { id: 'ui1', name: 'intelligent_ui', arguments: args } },
      { type: 'tool_result', payload: { id: 'ui1', result: 'Intelligent UI rendered.' } },
    ])
    await send(win, '安排一顿周末晚餐，用 Intelligent UI 展示')
    const dinner = win.locator('.intelligent-ui[data-document-id="dinner"]')
    const plus = dinner.getByRole('button', { name: '用餐人数 +', exact: true })
    await plus.waitFor({ timeout: 15000 })
    check('streaming controls available before completion', await dinner.getAttribute('data-complete') === 'false')
    await plus.click(); await plus.click()
    await plus.focus()
    await plus.evaluate(el => { el.dataset.identityProbe = 'same-node' })
    await win.waitForSelector('.intelligent-ui[data-document-id="dinner"][data-complete="true"]')
    check('user edit survives late completion', await dinner.locator('output').textContent() === '6')
    check('control identity and focus survive new blocks', await plus.evaluate(el => el.dataset.identityProbe === 'same-node' && document.activeElement === el))
    const chicken = dinner.locator('.iui-check-rows label').filter({ hasText: '去骨鸡腿肉' })
    check('quantity is computed locally', (await chicken.innerText()).includes('900 g'))
    await chicken.getByRole('checkbox').check()
    await plus.click()
    check('increased requirement shows shortfall', (await chicken.innerText()).includes('还需 150 g') && await chicken.getByRole('checkbox').evaluate(el => el.indeterminate))
    await dinner.getByRole('radio', { name: /香菇烧豆腐/ }).check()
    check('choice changes current checklist', await chicken.count() === 0 && await dinner.locator('.iui-check-rows label').filter({ hasText: '豆腐' }).count() === 1)
    await dinner.getByRole('radio', { name: /宫保鸡丁/ }).check()
    check('returning choice retains purchased amount', (await chicken.innerText()).includes('还需 150 g'))
    await dinner.getByRole('button', { name: '用餐人数 −', exact: true }).click()
    await dinner.locator('summary').filter({ hasText: '准备顺序' }).click()
    await dinner.getByRole('button', { name: '复制清单', exact: true }).click()
    await dinner.getByText('已复制', { exact: true }).waitFor()
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    check('copy uses current derived quantities', clipboard.includes('900 g') && clipboard.includes('去骨鸡腿肉'))
    check('all local interactions produce no model request', stub.seen.runs.length === 1)
    await reveal(win, dinner); await win.screenshot({ path: path.join(OUT, 'dinner-light.png') })
    // Authoritative history on reload; state must remain scoped to original message/call.
    stub.state.messages = [record('a-r1', 'ui1', fixtures.dinner)]
    await win.reload(); await openSession(win)
    await dinner.waitFor()
    check('refresh restores values, checks and disclosure', await dinner.locator('output').textContent() === '6' && await chicken.getByRole('checkbox').isChecked() && await dinner.locator('[data-block-id="steps"] details').getAttribute('open') !== null)
    const radio = dinner.getByRole('radio', { name: /宫保鸡丁/ })
    await radio.focus(); await win.keyboard.press('ArrowRight')
    check('native choice group supports keyboard arrows', await dinner.getByRole('radio', { name: /番茄炖牛腩/ }).isChecked())
    await win.keyboard.press('ArrowLeft')
    const disclosure = dinner.locator('summary').filter({ hasText: '准备顺序' })
    await disclosure.focus(); await win.keyboard.press('Space')
    check('disclosure supports keyboard toggle', await dinner.locator('[data-block-id="steps"] details').getAttribute('open') === null)
    await win.keyboard.press('Enter')
    // Measure the actual event-to-paint path; Playwright scheduling is excluded from these timings.
    for (let i = 0; i < 12; i++) timings.push(await plus.evaluate(el => new Promise(resolve => {
      const start = performance.now(); const buttons = el.parentElement.querySelectorAll('button'); const value = Number(el.parentElement.querySelector('output').textContent); (value >= 7 ? buttons[0] : buttons[1]).click(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
    })))
    check('local P95 feedback under 100 ms', timings.sort((a, b) => a - b)[Math.ceil(timings.length * .95) - 1] < 100)
    // Explicit follow-up is the one path that starts a new turn.
    stub.script([{ type: 'token', payload: { delta: '收到全素菜单请求。' } }])
    await dinner.getByRole('button', { name: '改成全素菜单', exact: true }).click()
    await win.waitForTimeout(350)
    check('model action sends exactly one visible contextual prompt', stub.seen.runs.length === 2 && /当前选择/.test(stub.seen.runs[1].message))
    // Replay multimedia + linked research as persisted events, including a historical Sketch.
    const legacy = { id: 'legacy', role: 'model', content: '', timestamp: Date.now(), tool_calls: [{ id: 'sk-old', type: 'function', function: { name: 'sketch', arguments: JSON.stringify({ html: '<p>Legacy Sketch still renders</p>', title: 'Historical Sketch' }) } }], tool_results: [{ tool_call_id: 'sk-old', name: 'sketch', content: 'Sketch rendered.' }] }
    const records = [record('a-r1', 'ui1', fixtures.dinner), record('media', 'ui-media', fixtures.media), record('sources', 'ui-sources', fixtures.research), legacy]
    if (evidence) for (const name of ['intelligentplan', 'intelligentmedia']) {
      const payload = JSON.parse(fs.readFileSync(path.join(evidence, `${name}-evidence.json`), 'utf8'))
      payload.documents.forEach((doc, i) => records.push(record(`${name}-${i}`, `${name}-${i}`, doc)))
    }
    stub.state.messages = records
    await win.reload(); await openSession(win)
    const media = win.locator('.intelligent-ui[data-document-id="images"]')
    await media.scrollIntoViewIfNeeded()
    await win.waitForFunction(() => [...document.querySelectorAll('[data-document-id="images"] img')].length === 3 && [...document.querySelectorAll('[data-document-id="images"] img')].every(i => i.complete && i.naturalWidth > 0), { timeout: 20000 })
    check('three real remote images load in native renderer', await media.locator('img').count() === 3)
    await media.locator('.iui-image-toggle').first().click()
    check('image expands at original ratio', await media.locator('.iui-picture[data-expanded]').count() === 1)
    await media.locator('.iui-image-toggle').first().click()
    check('image source is an ordinary attributed link', await media.getByRole('link', { name: 'github.com', exact: true }).first().getAttribute('href') === 'https://github.com/sachinchoolur/lightGallery')
    await reveal(win, media); await win.screenshot({ path: path.join(OUT, 'media-light.png') })
    check('historical Sketch is still sandboxed', await win.locator('iframe.sketch-frame').getAttribute('sandbox') === 'allow-scripts')
    const sources = win.locator('[data-document-id="research"]')
    await sources.getByText('摘要', { exact: true }).first().click()
    check('source summary expands independently', await sources.locator('.iui-source details[open]').count() === 1)
    // Component widths within the real chat container, not a separate prototype page.
    for (const width of [320, 375, 768]) {
      await media.evaluate((el, w) => { el.style.width = `${w}px`; el.style.maxWidth = '100%' }, width)
      check(`no horizontal overflow at container ${width}`, await media.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      if (width === 320) { await reveal(win, media); await win.screenshot({ path: path.join(OUT, 'media-320.png') }) }
    }
    await media.evaluate(el => { el.style.removeProperty('width'); el.style.removeProperty('max-width') })
    await win.emulateMedia({ reducedMotion: 'reduce' })
    check('reduced motion removes chevron transitions', await sources.locator('summary svg').first().evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) <= 0.00001))
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme_pref', 'dark') })
    await win.reload(); await openSession(win); await media.scrollIntoViewIfNeeded()
    check('English native controls', await win.getByRole('button', { name: 'Copy list', exact: true }).count() >= 1)
    await win.screenshot({ path: path.join(OUT, 'media-dark-en.png') })
    if (evidence) check('real model documents render after history hydration', await win.locator('.intelligent-ui').count() === records.length - 1)
    await win.route('**/1-480.jpg', route => route.abort())
    await win.reload(); await openSession(win)
    await reveal(win, media)
    const retry = media.getByRole('button', { name: 'Retry image', exact: true }).first()
    await retry.waitFor({ timeout: 20000 })
    check('failed image preserves readable fallback', await media.getByText('Image unavailable', { exact: true }).count() >= 1)
    await win.unroute('**/1-480.jpg'); await retry.click()
    await win.waitForFunction(() => document.querySelector('[data-document-id="images"] img')?.naturalWidth > 0)
    check('failed image can be retried', await media.locator('img').count() === 3)
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, p95Ms: timings[Math.ceil(timings.length * .95) - 1], evidence: evidence || null }, null, 2))
    console.log(`${checks.length} checks passed. Screenshots: ${OUT}`)
    if (DEMO) {
      await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light') }); await win.reload(); await openSession(win); await dinner.scrollIntoViewIfNeeded()
      console.log('Review window remains open; close it to finish.')
      await new Promise(resolve => app.on('close', resolve))
    }
  } catch (error) {
    if (win) await win.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {})
    throw error
  } finally { await app.close().catch(() => {}); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
