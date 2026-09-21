/** Opt-in paid live acceptance. Real isolated standalone + Electron + configured image model.
 * Uses only synthetic test art. Credentials are read in memory, never printed or copied into artifacts.
 * npm run build; npm run e2e:image-studio:live (also build ../tangu-agent first).
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { randomUUID } = require('node:crypto')
const { createServer } = require('node:net'), assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(ROOT, '../outputs/image-studio-live', new Date().toISOString().replace(/[:.]/g, '-'))
const MODEL = process.env.TANGU_LIVE_MODEL || 'codex/gpt-5.6-luna'
const AUTH_HOME = process.env.IMAGE_STUDIO_AUTH_HOME || path.join(os.homedir(), '.forsion-dev')
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = [], runs = []
const check = (name, value) => { results.push({ name, pass: !!value }); assert.ok(value, name); console.log(`PASS ${name}`) }
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-image-live-')), shared = path.join(home, 'forsion'), engineHome = path.join(shared, 'tangu')
  fs.mkdirSync(engineHome, { recursive: true })
  const creds = JSON.parse(fs.readFileSync(path.join(AUTH_HOME, 'auth.json'), 'utf8')), token = randomUUID()
  assert.ok(creds.token && creds.cloudUrl, 'A configured Forsion image account is required')
  const cloud = creds.cloudUrl.replace(/\/$/, '')
  const catalogResponse = await fetch(cloud + '/api/brain/models?projectId=tangu', { headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15000) })
  assert.ok(catalogResponse.ok, `Image catalog HTTP ${catalogResponse.status}`)
  // IMAGE_STUDIO_MODEL=<model id> 覆盖默认生图模型(换方言验证:Seedream 回 JPEG、Qwen 无 n 等);缺省跟随 admin 生图槽。
  const catalog = await catalogResponse.json(), imageModel = process.env.IMAGE_STUDIO_MODEL || catalog.imageModelId || catalog.models?.find(m => m.modelType === 'image_gen')?.id
  // Seedream / Qwen 出不了 alpha 通道(Seedream 只回 JPEG):去背景那条像素断言只对能出透明底的模型成立。
  const alphaCapable = !/seedream|qwen-image/i.test(imageModel)
  assert.ok(imageModel, 'A configured image model is required')
  fs.symlinkSync(path.join(AUTH_HOME, 'provider-auth.json'), path.join(shared, 'provider-auth.json'))
  // Desktop uses a random local-only credential. The cloud token stays in the engine environment.
  fs.writeFileSync(path.join(shared, 'desktop-local-token'), token, { mode: 0o600 })
  fs.writeFileSync(path.join(shared, 'config.json'), JSON.stringify({ specialAgentMigrations: { enableByDefaultVersion: 999, harnessCandidatesVersion: 999, museBudgetVersion: 999 }, specialAgents: { historian: { enabled: false }, muse: { enabled: false } } }))
  const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)) }) })
  const base = `http://127.0.0.1:${port}`
  const engine = spawn(process.execPath, [path.resolve(ROOT, '../tangu-agent/dist/standalone/main.js'), '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(engineHome, 'state.db'), '--sandbox', 'none'], {
    env: { ...process.env, TANGU_HOME: engineHome, TANGU_TOKEN: creds.token, TANGU_LOCAL_TOKEN: token, TANGU_CLOUD_URL: cloud, TANGU_MODEL: MODEL }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = fs.createWriteStream(path.join(OUT, 'engine.log'))
  // Redact credentials defensively from engine diagnostics.
  const capture = d => log.write(String(d).split(creds.token).join('[REDACTED]').split(token).join('[LOCAL_TOKEN]'))
  engine.stdout.on('data', capture); engine.stderr.on('data', capture)
  let app, win
  const api = async (url, body) => {
    const res = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`); return res.json()
  }
  const consume = async (runId, label) => {
    const entry = { label, runId, tools: [], errors: [], files: [], text: '', startedAt: Date.now() }; runs.push(entry)
    const res = await fetch(base + `/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300000) })
    assert.ok(res.ok, `SSE HTTP ${res.status}`)
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8'); let at
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let event; try { event = JSON.parse(line.slice(5)) } catch { continue }
          const p = event.payload || {}
          if (event.type === 'tool_call') entry.tools.push(p.name)
          if (event.type === 'token') entry.text += p.delta || p.text || ''
          if (event.type === 'tool_result' && p.isError) entry.errors.push(String(p.result || p.preview || 'tool error').slice(0, 500))
          if (event.type === 'display_file' && p.dataUrl?.startsWith('data:image/')) {
            const ext = p.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : p.dataUrl.startsWith('data:image/webp') ? 'webp' : 'png' // 扩展名跟 mime 走,否则导入后声明类型与字节不符
            const file = `${label}-${entry.files.length + 1}.${ext}`; fs.writeFileSync(path.join(OUT, file), Buffer.from(p.dataUrl.split(',')[1], 'base64')); entry.files.push(file)
          }
          if (event.type === 'error') { entry.errors.push(p.message || JSON.stringify(p)); throw new Error(entry.errors.at(-1)) }
          if (event.type === 'done') { entry.ms = Date.now() - entry.startedAt; return entry }
        }
      }
    }
    throw new Error('Stream ended without done')
  }
  const screenshot = async name => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await win.waitForTimeout(1000)
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayAwake: true })).toPNG().toString('base64'))
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'))
  }
  try {
    const until = Date.now() + 60000
    while (true) { try { await api('/health'); break } catch (e) { if (Date.now() > until || engine.exitCode !== null) throw e; await sleep(500) } }
    fs.unlinkSync(path.join(shared, 'provider-auth.json'))
    console.log(`Live models: ${MODEL}; image ${imageModel}`)
    let generated
    if (process.env.IMAGE_STUDIO_LIVE_SOURCE) {
      fs.copyFileSync(process.env.IMAGE_STUDIO_LIVE_SOURCE, path.join(OUT, 'source-1.png'))
      generated = { files: ['source-1.png'] }
      console.log('Reusing previously verified generated test source')
    } else {
    const session = await api('/agent/sessions', { title: 'Image Studio live source', projectless: true, model_id: MODEL, agent_config: { execMode: 'sandbox', preset: 'chat', imageModelId: imageModel } })
    const run = await api('/agent/runs', { session_id: session.session?.id || session.id, model_id: MODEL, userMessageId: randomUUID(), message: 'Generate one square product photograph: a single terracotta ceramic mug with a round handle on its right, on a pale cream tabletop, soft daylight, centered with plenty of empty space, realistic ceramic texture, no text or logos. Use the image generation tool and display the result.', agent_config: { execMode: 'sandbox', preset: 'chat', imageModelId: imageModel } })
    generated = await consume(run.runId, 'source')
    check('Real model generates source pixels through generate_image', generated.tools.includes('generate_image') && generated.files.length === 1 && !generated.errors.length)
    }
    fs.mkdirSync(path.join(home, 'userdata-dev'), { recursive: true })
    fs.writeFileSync(path.join(home, 'userdata-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token, defaultWorkspaceDir: path.join(home, 'workspace') }), { mode: 0o600 })
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: shared, TANGU_BACKEND_URL: base, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 45000 })
    win = await app.firstWindow(); win.setDefaultTimeout(30000)
    const rendererErrors = []; win.on('pageerror', e => rendererErrors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 980))
    await win.waitForSelector('#root')
    const effective = await win.evaluate(() => window.tangu.getConfig())
    check('Isolated desktop uses the expected engine and local credential', effective.backendUrl === base && effective.token === token)
    // ⚠️ IMAGE_STUDIO_MODEL 只钉住上面那次显式生成;Image Studio 的编辑轮没有显式模型,引擎回落**服务端的
    // app 级生图槽**(/api/brain/models 的 imageModelId)。要整轮验一个方言,先把那个槽指过去再跑。
    const skip = win.getByText(/^(跳过引导|Skip)$/).first()
    await Promise.race([skip.waitFor({ state: 'visible', timeout: 45000 }), win.locator('.dv-groupview').first().waitFor({ state: 'visible', timeout: 45000 })])
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await win.waitForSelector('.dv-groupview')
    const icon = win.locator('.rb-space[title="Image Studio"]').first()
    if (!await icon.isVisible().catch(() => false)) await win.locator('.rb-top .rb-more').first().hover()
    await icon.click(); await win.waitForSelector('.ims-empty')
    await win.locator('.ims input[type="file"][multiple]').setInputFiles(path.join(OUT, generated.files[0]))
    await win.locator('.ims-footer input').fill('Live · ceramic studies')
    const first = win.locator('.ims-image').first(); await first.click()
    await win.locator('.ims-toolbar').getByRole('button', { name: /^(属性与调整|Properties and adjustments)$/ }).click()
    await win.waitForSelector('.ims-ai')
    console.log('Native Image Studio imported the real source and opened AI editing')
    const sourceId = await first.getAttribute('data-image-id')
    async function edit(mode, text, expectedCount) {
      const panel = win.locator('.ims-ai')
      await panel.getByRole('button', { name: mode, exact: true }).click()
      await panel.getByRole('textbox').fill(text)
      if (mode === '改图') {
        await panel.getByRole('combobox', { name: '输入内容', exact: true }).selectOption('original')
        check('edit: original ratio and untouched source are available to the real run',
          await panel.getByRole('combobox', { name: '结果比例', exact: true }).inputValue() === 'original'
          && await panel.getByRole('combobox', { name: '输入内容', exact: true }).inputValue() === 'original')
      }
      if (mode === '扩展画面') await panel.getByRole('combobox', { name: '结果比例', exact: true }).selectOption('16:9')
      const before = await win.locator('.ims-image').count()
      const response = win.waitForResponse(r => r.url().endsWith('/agent/runs') && r.request().method() === 'POST', { timeout: 45000 })
      await panel.getByRole('button', { name: '生成新版本', exact: true }).click()
      const label = mode === '改图' ? 'edit' : mode === '去除背景' ? 'cutout' : 'expand'
      await win.waitForSelector('.ims-generation')
      check(`${label}: the real run reserves one final canvas slot immediately`, await win.locator('.ims-generation').count() === 1 && await win.locator('.ims-image').count() === before)
      if (label === 'edit') await screenshot('edit-placeholder')
      const started = await (await response).json()
      const entry = await consume(started.runId, label)
      check(`${label}: real model selects edit_image with a displayed result`, entry.tools.includes('edit_image') && entry.files.length === 1 && !entry.errors.length)
      await win.waitForFunction(n => document.querySelectorAll('.ims-image').length === n, expectedCount, { timeout: 30000 })
      await win.waitForFunction(() => document.querySelectorAll('.ims-generation').length === 0, undefined, { timeout: 30000 })
      check(`${label}: output is collected beside the preserved original`, await win.locator(`[data-image-id="${sourceId}"]`).count() === 1)
      await win.getByTitle(/^(适应内容|Fit to content)$/).click()
      await screenshot(label + '-workspace')
      return entry
    }
    await edit('改图', '把陶土杯的釉色改为深青绿色。保持同一只杯子的形状、把手、位置、桌面与柔和光照。', 2)
    await edit('去除背景', '', 3)
    const cutout = path.join(OUT, runs.find(r => r.label === 'cutout').files[0])
    const alpha = await win.evaluate(async encoded => {
      const img = new Image(); img.src = 'data:image/png;base64,' + encoded; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data; let clear = 0, opaque = 0
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] < 10) clear++; if (pixels[i] > 245) opaque++ }
      return { clear, opaque, total: pixels.length / 4 }
    }, fs.readFileSync(cutout).toString('base64'))
    if (alphaCapable) check('Background removal produces real transparent and opaque pixels', alpha.clear > alpha.total * .1 && alpha.opaque > alpha.total * .05)
    else console.log(`SKIP background-removal alpha check: ${imageModel} has no alpha channel`)
    await edit('扩展画面', '自然延续奶油色桌面与背景，保持中央陶土杯。', 4)
    const expanded = runs.find(r => r.label === 'expand')
    const dimensions = await app.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), path.join(OUT, expanded.files[0]))
    check('Expanded result is a landscape image', dimensions.width > dimensions.height * 1.4)
    check('No renderer exceptions', rendererErrors.length === 0)
  } catch (e) {
    process.exitCode = 1; console.error(e.message)
    fs.writeFileSync(path.join(OUT, 'failure.txt'), e.stack || String(e))
    if (win) await screenshot('failure').catch(() => {})
  } finally {
    if (app) await app.close().catch(() => {})
    engine.kill('SIGTERM'); await Promise.race([new Promise(r => engine.once('exit', r)), sleep(5000)])
    if (engine.exitCode === null && !engine.signalCode) engine.kill('SIGKILL')
    log.end()
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ model: MODEL, imageModel, results, runs }, null, 2))
    fs.rmSync(home, { recursive: true, force: true })
    console.log(`Artifacts: ${OUT}`)
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
