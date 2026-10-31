/** Real Electron: native controls, state replay, theme, narrow layout and sandbox boundary.
 * npm run build && npm run check:visualize
 * LIVE_SKETCH_HTML=<real-model fragment> also renders and exercises that generated output.
 */
const electron = require('./lib/launch-electron.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')
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
  // 外发探针:桌面宿主 frame-src 放行 127.0.0.1,没有 form-action 'none' 时表单真能把数据送到这里(10-31 负对照实跑过)。
  const sinkHits = []
  const sink = http.createServer((req, res) => { sinkHits.push(req.url); res.end('leaked') })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/sink`
  const formHtml = `<ul id="items"></ul>
<form id="add" action="${sinkUrl}?via=submit"><input id="title" name="title" required><button id="add-btn">添加</button></form>
<button id="request" type="button">requestSubmit</button><button id="raw" type="button">form.submit</button><button id="bypass" type="button">bypass</button>
<form id="leak" action="${sinkUrl}?via=bypass"><input name="secret" value="1"></form>
<script>
const add = document.getElementById('add'), title = document.getElementById('title')
add.addEventListener('submit', (event) => {
  event.preventDefault()
  const li = document.createElement('li'); li.textContent = title.value
  document.getElementById('items').append(li); title.value = ''
})
document.getElementById('request').onclick = () => add.requestSubmit()
document.getElementById('raw').onclick = () => { add.action = '${sinkUrl}?via=form.submit'; add.submit() }
document.getElementById('bypass').onclick = () => {
  window.addEventListener('submit', (event) => event.stopImmediatePropagation(), true)
  document.getElementById('leak').requestSubmit()
}
</script>`
  // 自身导航:内层 CSP 管不到,没有壳时这些写法都能到探针。load 之后一直报 77 高(运行时自己也会量,报一次会被盖掉),再走:卡片确实跑到了这一步,没跑到的不算拦住,也顺带验中转。
  const NAV_EXTERNAL = ['https://www.youtube-nocookie.com/*', 'https://player.bilibili.com/*']
  const navCard = (via, go, markup = '') => `${markup}<script>window.addEventListener('load', () => { setInterval(() => parent.postMessage({ type: 'sketch-height', height: 77 }, '*'), 100); setTimeout(() => { ${go} }, 100) })</script>`
  const anchorBypass = `window.addEventListener('click', (event) => event.stopImmediatePropagation(), true); document.getElementById('go')`
  const navVectors = (u) => [
    ['href', `location.href = '${u}?via=href'`],
    ['replace', `location.replace('${u}?via=replace')`],
    ['assign', `location.assign('${u}?via=assign')`],
    ['open-self', `window.open('${u}?via=open-self', '_self')`],
    ['navigation', `navigation.navigate('${u}?via=navigation')`],
    ['meta-script', `const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${u}?via=meta-script'; document.head.append(m)`],
    ['meta', '', `<meta http-equiv="refresh" content="3;url=${u}?via=meta">`],
    ['a-click', `document.getElementById('go').click()`, `<a id="go" href="${u}?via=a-click">go</a>`],
    ['a-bypass', `${anchorBypass}.click()`, `<a id="go" href="${u}?via=a-bypass">go</a>`],
    ['a-dispatch', `${anchorBypass}.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`, `<a id="go" href="${u}?via=a-dispatch">go</a>`],
    ['svg-a', `document.getElementById('go').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`, `<svg><a id="go" xlink:href="${u}?via=svg-a"><text y="20">go</text></a></svg>`],
    ['area', `document.getElementById('go').click()`, `<map name="m"><area id="go" shape="rect" coords="0,0,9,9" href="${u}?via=area"></map>`],
  ]
  const navMessages = [
    ...navVectors(sinkUrl).map(([via, go, markup]) => message(`nav-${via}`, navCard(via, go, markup))),
    ...['https://www.youtube-nocookie.com/embed/x', 'https://player.bilibili.com/player.html'].flatMap((u, i) => navVectors(u).filter(([via]) => ['href', 'meta', 'a-bypass'].includes(via)).map(([via, go, markup]) => message(`nav-${i}-${via}`, navCard(via, go, markup)))),
  ]
  // 下面两张给默认进程模型那一段用:卡里的结果经 postMessage 报给宿主,不靠 Playwright 进帧。
  const typingHtml = `<form id="typing"><input id="typing-input" style="display:block;box-sizing:border-box;width:240px;height:36px;margin:0"></form>
<script>document.getElementById('typing').addEventListener('submit', () => parent.postMessage({ type: 'probe-typed', value: document.getElementById('typing-input').value }, '*'))</script>`
  const gestureHtml = `<button id="ask" type="button" style="display:block;width:240px;height:36px;margin:0" onclick="window.forsionIntelligentUi.ask('ASK-REAL')">ask</button>
<script>
addEventListener('message', (event) => {
  if (event.data?.type !== 'probe-steal') return
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  parent.postMessage({ type: 'sketch-ask', text: 'STEAL-RAW' }, '*')
  let viaRuntime = 'sent'
  try { window.forsionIntelligentUi.ask('STEAL-RUNTIME') } catch (error) { viaRuntime = error.message }
  parent.postMessage({ type: 'probe-stolen', viaRuntime, nonceVisible: new RegExp('NON' + "CE = '").test(document.documentElement.outerHTML) }, '*')
})
</script>`
  const messages = [message('wave', html), message('wave-other', html), message('figures', figuresHtml), message('parts', partsHtml), message('form', formHtml), ...navMessages, message('typing', typingHtml), message('gesture', gestureHtml)]
  if (process.env.LIVE_SKETCH_HTML) messages.push(message('live', fs.readFileSync(process.env.LIVE_SKETCH_HTML, 'utf8')))
  if (process.env.LIVE_FIGURES_HTML) messages.push(message('live-figures', fs.readFileSync(process.env.LIVE_FIGURES_HTML, 'utf8')))
  if (process.env.LIVE_FORM_HTML) messages.push(message('live-form', fs.readFileSync(process.env.LIVE_FORM_HTML, 'utf8')))
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
    const errors = []
    const boot = async (extraArgs) => {
      app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ...extraArgs, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
      // 外网地址记下就取消,不真发(应用自己没用 onBeforeRequest,一个 session 只能挂一个)。
      await app.evaluate(({ session }, urls) => {
        globalThis.__navOut = []
        session.defaultSession.webRequest.onBeforeRequest({ urls }, (details, cb) => { globalThis.__navOut.push(details.url); cb({ cancel: true }) })
      }, NAV_EXTERNAL)
      win = await app.firstWindow()
      win.setDefaultTimeout(20000)
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
    }
    await boot(electron.NESTED_SANDBOX_ARGS)
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
    const frame = card.frameLocator('iframe').frameLocator('iframe')
    const other = win.locator('[data-sketch-call-id="wave-other"]').frameLocator('iframe').frameLocator('iframe')
    await win.waitForTimeout(600)
    await card.scrollIntoViewIfNeeded()
    assert.equal(await frame.locator('#wave-amplitude').inputValue(), '40')
    assert.equal(await card.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms')
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
    // 壳和卡片的 color-scheme 对不上时浏览器铺一层不透明底,DOM 上什么也量不出来:比卡边内外的像素(卡片画布是透明的,里外同色)。
    const box = await card.boundingBox()
    const edge = (await win.screenshot({ clip: { x: box.x - 8, y: box.y + box.height / 2, width: 16, height: 2 } })).toString('base64')
    const [outside, inside] = await app.evaluate(({ nativeImage }, png) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
      const bitmap = image.toBitmap()
      const width = image.getSize().width
      return [0, width - 1].map((x) => [...bitmap.subarray(x * 4, x * 4 + 3)])
    }, edge)
    assert.ok(outside.every((value, i) => Math.abs(value - inside[i]) <= 2), `dark card canvas is transparent: ${outside} vs ${inside}`)
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
    const ff = figures.frameLocator('iframe').frameLocator('iframe')
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
      const lf = live.frameLocator('iframe').frameLocator('iframe')
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
      const pf = pc.frameLocator('iframe').frameLocator('iframe')
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
      const lf = live.frameLocator('iframe').frameLocator('iframe')
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
    // <form> 卡:提交有反应(点击 / 回车 / requestSubmit / required 校验都是原生的),但任何写法都发不出去。
    const form = win.locator('[data-sketch-call-id="form"]')
    const fm = form.frameLocator('iframe').frameLocator('iframe')
    await releaseScrollAnchor()
    await form.scrollIntoViewIfNeeded()
    await fm.locator('#add-btn').click()
    assert.equal(await fm.locator('#items li').count(), 0, 'required 空值不提交')
    await fm.locator('#title').fill('交论文')
    await fm.locator('#add-btn').click()
    await fm.locator('#title').fill('考试')
    await fm.locator('#title').press('Enter')
    await fm.locator('#title').fill('回家')
    await fm.locator('#request').click()
    assert.deepEqual(await fm.locator('#items li').allTextContents(), ['交论文', '考试', '回家'])
    await fm.locator('#title').fill('secret')
    await fm.locator('#raw').click()
    await win.waitForTimeout(200)
    assert.deepEqual(await fm.locator('#items li').allTextContents(), ['交论文', '考试', '回家'], 'form.submit() 不动卡片,状态还在')
    await fm.locator('#bypass').click()
    await win.waitForTimeout(400)
    assert.deepEqual(sinkHits, [], 'form.submit() 与绕过 runtime 监听都发不出去')
    console.log('PASS <form> card responds to submit; form.submit() and listener bypass reach nothing')

    // 每张探针卡都得真跑到导航那一行(高度 77 经壳中转回来),否则下面的「没到探针」不算数。
    const assertNavBlocked = async () => {
      const unfinished = () => win.locator('[data-sketch-call-id^="nav-"] iframe').evaluateAll((els) => els.map((el) => [el.closest('[data-sketch-call-id]').dataset.sketchCallId, el.style.height]).filter(([, height]) => height !== '77px'))
      for (let i = 0; i < 50 && (await unfinished()).length; i++) await win.waitForTimeout(200)
      assert.equal(await win.locator('[data-sketch-call-id^="nav-"] iframe').count(), navMessages.length)
      assert.deepEqual(await unfinished(), [], 'every navigation card reached its navigation')
      await win.waitForTimeout(3000) // 等 meta refresh;它要晚于 load 后的探针,不然卡片报不出 77
      assert.deepEqual(sinkHits, [], 'self-navigation must not reach a loopback port')
      assert.deepEqual(await app.evaluate(() => globalThis.__navOut), [], 'self-navigation must not reach the allowed embed hosts')
    }
    await assertNavBlocked()
    await win.locator('[data-sketch-call-id="nav-href"]').scrollIntoViewIfNeeded()
    await win.locator('[data-sketch-call-id="nav-href"]').screenshot({ path: path.join(out, 'nav-blocked.png') })
    console.log(`PASS ${navMessages.length} self-navigation cards ran and reached nothing`)

    if (process.env.LIVE_FORM_HTML) {
      // 真模型写的表单:每个可见输入框填上,点提交,新内容要出现在卡里。
      const lf = win.locator('[data-sketch-call-id="live-form"]').frameLocator('iframe').frameLocator('iframe')
      assert.ok(await lf.locator('form').count(), 'model used <form>')
      const inputs = lf.locator('form input:visible')
      for (let i = 0; i < await inputs.count(); i++) {
        const input = inputs.nth(i), type = await input.getAttribute('type')
        await input.fill(type === 'date' ? '2027-03-01' : type === 'number' ? '7' : '验收事项')
      }
      const before = await lf.locator('body').innerText()
      await lf.locator('form button:not([type="button"]), form input[type="submit"]').first().click()
      await win.waitForTimeout(300)
      const after = await lf.locator('body').innerText()
      assert.notEqual(after, before, 'real model <form> reacted')
      assert.match(after, /验收事项/)
      assert.deepEqual(sinkHits, [])
      await win.locator('[data-sketch-call-id="live-form"]').screenshot({ path: path.join(out, 'live-form.png') })
      console.log('PASS real-model <form> card adds an entry')
    }

    // 第二段:默认进程模型,和用户跑的一样。沙箱帧各在自己的进程里,Playwright 进不去第二层,这里只用真实鼠标键盘和宿主看得到的结果。
    await app.close()
    await boot(process.env.VISUALIZE_NEG_GESTURE ? electron.NESTED_SANDBOX_ARGS : [])
    await open()
    await assertNavBlocked()
    await win.evaluate(() => {
      window.__probe = []
      window.addEventListener('message', (event) => { if (String(event.data?.type).startsWith('probe-')) window.__probe.push(event.data) })
    })
    const probe = async (type) => {
      await win.waitForFunction((t) => window.__probe.some((m) => m.type === t), type)
      return win.evaluate((t) => window.__probe.find((m) => m.type === t), type)
    }
    const typing = win.locator('[data-sketch-call-id="typing"]')
    await typing.scrollIntoViewIfNeeded()
    await win.waitForTimeout(300)
    const typingBox = await typing.locator('iframe').boundingBox()
    await win.mouse.click(typingBox.x + 60, typingBox.y + 32) // 卡片 body 有内边距
    await win.keyboard.type('hello')
    await win.keyboard.press('Enter')
    assert.equal((await probe('probe-typed')).value, 'hello')

    // 滚轮要穿过两层帧传回对话流,否则鼠标停在卡上滚不动。
    const stream = win.locator('[data-chat-surface="chat"] .t2-stream')
    const scrollTop = () => stream.evaluate((el) => el.scrollTop)
    const scrolledFrom = await scrollTop()
    await win.mouse.wheel(0, -240)
    await win.waitForTimeout(400)
    assert.notEqual(await scrollTop(), scrolledFrom, 'wheel over a card scrolls the chat')

    // 用户刚在输入框敲过键,卡内脚本抢走焦点再冒充点击:裸 postMessage 没有 nonce,经运行时过不了卡内手势判定,outerHTML 里也找不到 nonce。
    // 只能在这里测:帧同进程时(NESTED_SANDBOX_ARGS)宿主的激活会传进卡片,判定被放过去(VISUALIZE_NEG_GESTURE 是这条的负对照)。
    const gesture = win.locator('[data-sketch-call-id="gesture"]')
    const runsBefore = stub.seen.runs.length
    await win.locator('.t2c-ta').first().click()
    await win.keyboard.type('x')
    await gesture.locator('iframe').evaluate((el) => el.contentWindow.postMessage({ type: 'probe-steal' }, '*'))
    const stolen = await probe('probe-stolen')
    assert.match(stolen.viaRuntime, /user gesture/)
    assert.equal(stolen.nonceVisible, false)
    await win.waitForTimeout(600)
    assert.deepEqual(stub.seen.runs.slice(runsBefore).map((r) => r.message), [], 'stolen focus cannot send as the user')
    await win.locator('.t2c-ta').first().click()
    await win.keyboard.press('ControlOrMeta+A')
    await win.keyboard.press('Backspace')

    await gesture.scrollIntoViewIfNeeded()
    await win.waitForTimeout(300)
    const askBox = await gesture.locator('iframe').boundingBox()
    await win.mouse.click(askBox.x + 60, askBox.y + 32)
    await win.waitForFunction(() => document.activeElement?.classList.contains('sketch-frame'))
    for (let i = 0; i < 20 && stub.seen.runs.length === runsBefore; i++) await win.waitForTimeout(200)
    assert.deepEqual(stub.seen.runs.slice(runsBefore).map((r) => r.message), ['ASK-REAL'], 'a real click still asks')
    assert.deepEqual(errors, [])
    console.log('PASS default process model: navigation blocked, real input, wheel, and the ask gesture gate')

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
    sink.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
