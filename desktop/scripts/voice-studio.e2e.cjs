/**
 * 朗读音色工作室 e2e:复刻模型可选(真 Electron × 真设置浮窗)。
 *   设置 → 模型 → 语音 →「百炼朗读音色工作室」:复刻模型下拉(百炼支持的朗读模型 + 自定义 ID)→ 选模型 + 选本地录音 → 复刻请求带上
 *   targetModel(用哪个复刻服务由引擎判)→ 成功后朗读模型 / 音色联动 → 「我的音色」列出绑定的模型,绑在通话模型上的音色不给「使用」。
 * 引擎的音色接口由脚本里的小代理顶替(其余请求转给 stub 引擎),不花百炼额度;真百炼那半(各模型复刻 + 用复刻音色朗读)由 tangu-agent 的
 * `npm run live:harness -- --only voiceclone` 管。需先 npm run build。用法:npm run e2e:voicestudio   截图落在输出目录。
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) }
}

/** 挡在 stub 引擎前面:handlers 里的 POST 路由自己答,其余原样转给 stub。(playwright 的 route.fulfill 在设置窗里读出来是 HTTP 0,不用它。) */
function frontEngine(stubUrl, handlers) {
  const target = new URL(stubUrl)
  const server = http.createServer((req, res) => {
    const h = req.method === 'POST' && handlers[req.url.split('?')[0]]
    if (h) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(h(JSON.parse(body || '{}')))) })
      return
    }
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-voicestudio-'))
  // 假的百炼 provider(只为让设置页出音色工作室;音色接口全被下面的路由拦截顶替,不连百炼)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [{ providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-e2e-placeholder', modelIds: [] }] }))
  const stub = await startStubEngine({ sessions: [], messages: [] })
  // 引擎的音色接口:记下请求,回固定结果
  const clones = []
  let voices = [
    { voice: 'qwen-omni-vc-me-voice-1', kind: 'clone', targetModel: 'qwen3.8-omni-flash-realtime' },
    { voice: 'cosyvoice-v3.5-plus-old-1', kind: 'cosy', targetModel: 'cosyvoice-v3.5-plus' },
  ]
  const front = await frontEngine(stub.url, {
    '/agent/tts/voices/clone': (body) => {
      clones.push(body)
      const voice = `v-e2e-${clones.length}`
      voices = [...voices, { voice, kind: 'cosy', targetModel: body.targetModel }]
      return { voice, targetModel: body.targetModel }
    },
    '/agent/tts/voices/list': () => ({ voices }),
  })
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN'],
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: front.url, TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.keyboard.press('Meta+Comma').catch(() => {})
    const sp = await until(async () => {
      for (const pg of app.windows()) if (await pg.locator('.settings-main').count().catch(() => 0)) return pg
      return null
    }, 15_000, 400)
    if (!sp) throw new Error('15s 内没等到设置浮窗')

    await sp.locator('.settings-nav').getByRole('button', { name: '模型', exact: true }).first().click()
    await sp.waitForTimeout(500)
    await sp.locator('.settings-nav-subitem', { hasText: '语音' }).first().click()
    const sel = sp.locator('select.tts-clone-model')
    await sel.waitFor({ timeout: 10_000 })
    await sel.scrollIntoViewIfNeeded()

    const opts = await sel.locator('option').allTextContents()
    const def = await sel.inputValue()
    check('S1 复刻模型下拉:9 个模型 + 自定义,缺省是官方推荐的 qwen-audio-3.0-tts-plus',
      opts.length === 10 && def === 'qwen-audio-3.0-tts-plus' && /推荐/.test(opts[0]) && opts.some((o) => o === 'cosyvoice-v3.5-plus') && opts.some((o) => o === 'qwen3-tts-vc-2026-01-22'),
      `缺省 ${def};${opts.join(' / ')}`)
    const urlInputs = await sp.locator('.settings-main input[type="url"]').count()
    check('S2 不再要公网 URL:各模型都收本地录音', urlInputs === 0, `URL 输入框 ${urlInputs} 个`)

    const go = sp.locator('.tts-clone-go')
    const file = sp.locator('.settings-main input[type="file"][accept="audio/*"]').first()
    const wav = { name: 'me.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVEfmt ') }
    await sel.selectOption('cosyvoice-v3.5-plus')
    await file.setInputFiles(wav)
    await go.click()
    await until(() => clones.length >= 1, 8000)
    const c1 = clones[0] || {}
    check('S3 复刻请求带选中的模型和本地录音(data URI),不带旧的 engine 字段',
      c1.targetModel === 'cosyvoice-v3.5-plus' && /^data:audio\/wav;base64,/.test(c1.audioData || '') && !('engine' in c1) && !c1.audioUrl,
      JSON.stringify({ ...c1, apiKey: '…', audioData: String(c1.audioData).slice(0, 28) }))
    const cfg = await until(async () => {
      const c = await sp.evaluate(() => window.tangu.getConfig())
      return c.ttsVoice === 'v-e2e-1' ? c : null
    }, 8000)
    check('S4 复刻成功 → 朗读模型和音色联动到新音色', cfg?.ttsModelId === 'bailian/cosyvoice-v3.5-plus' && cfg?.ttsVoice === 'v-e2e-1', `${cfg?.ttsModelId} / ${cfg?.ttsVoice}`)

    const rows = await until(async () => {
      const r = await sp.locator('.settings-main .file-row').evaluateAll((els) => els.map((el) => ({
        name: el.querySelector('.file-name')?.textContent || '', tag: el.querySelector('.file-size')?.textContent || '',
        btns: [...el.querySelectorAll('button')].map((b) => b.title),
      })))
      return r.length >= 3 ? r : null
    }, 8000) || []
    const call = rows.find((r) => r.name.startsWith('qwen-omni-vc')), read = rows.find((r) => r.name === 'v-e2e-1')
    check('S5 我的音色:列出绑定的模型;通话音色不给「使用」(朗读用不了),仍可删除',
      !!call && !!read && /通话音色/.test(call.tag) && /qwen3\.8-omni-flash-realtime/.test(call.tag) && !call.btns.includes('使用') && call.btns.includes('删除')
        && read.tag === 'cosyvoice-v3.5-plus' && read.btns.includes('使用'),
      rows.map((r) => `${r.name}〔${r.tag}〕[${r.btns.join(',')}]`).join('  '))

    await sel.selectOption('__custom__')
    const custom = sp.locator('input.tts-clone-model-custom')
    await custom.waitFor({ timeout: 5000 })
    await file.setInputFiles(wav)
    const disabledEmpty = await go.isDisabled()
    await custom.fill('my-future-tts-model')
    await go.click()
    await until(() => clones.length >= 2, 8000)
    check('S6 自定义模型 ID:空着不能复刻,填了就按填的发', disabledEmpty && clones[1]?.targetModel === 'my-future-tts-model', `空着禁用=${disabledEmpty};发出 ${clones[1]?.targetModel}`)

    await sel.scrollIntoViewIfNeeded()
    await sp.screenshot({ path: path.join(home, 'voice-studio.png') }).catch(() => {})
    console.log(`截图 ${path.join(home, 'voice-studio.png')}`)
  } finally {
    await app.close().catch(() => {})
    front.close()
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} PASS`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
