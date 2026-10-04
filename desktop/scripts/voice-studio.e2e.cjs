/**
 * 朗读音色工作室 e2e:复刻模型可选 + 应用内引导录音 + 样本检查(真 Electron × 真设置浮窗 × 假麦克风)。
 *   设置 → 模型 → 语音 →「百炼朗读音色工作室」:
 *   · 复刻模型下拉(百炼支持的朗读模型 + 自定义 ID);
 *   · 选一个录音文件 → 本地检查出结果 → 复刻请求带 targetModel 和重编码后的单声道 WAV;太短的样本被拦住;
 *   · 「录一段」→ 出文案 → 假麦克风念完 → 停止 → 检查结果(假麦克风是 16 kHz 的,应当提醒音质偏低)→ 复刻请求带上文案和语种;
 *   · 成功后朗读模型 / 音色联动;「我的音色」列出绑定的模型,绑在通话模型上的音色不给「使用」。
 * 引擎的音色接口由脚本里的小代理顶替(其余请求转给 stub 引擎),不花百炼额度;真百炼那半(各模型复刻 + 用复刻音色朗读 +
 * 文案参数)由 tangu-agent 的 `npm run live:harness -- --only voiceclone` 管。
 * 要 macOS(say 合成人声)。需先 npm run build。用法:npm run e2e:voicestudio   截图落在输出目录。
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { MAC_FLAGS } = require('./lib/launch-electron.cjs') // 裸起 Electron 也要跳过 macOS 崩溃后的重开窗口模态
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { synthMic, fakeMicSwitches, readWav, writeWav } = require('./lib/voice-fixture.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) }
}

// 与界面上的中文文案逐字一致(components/VoiceSamplePicker.tsx 的 voicesample.script)
const SCRIPT = '今天天气不错，我想跟你聊一聊最近在忙的事情。上周我去了一趟海边，傍晚的风很凉快，沿着沙滩走了很久。回来以后整理了照片，也顺便把下个月的计划重新排了一遍。'

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

/** 复刻请求里的 data URI → WAV 头信息(应用自己编的 WAV,头是规整的 44 字节)。 */
function wavOf(dataUri) {
  const m = /^data:audio\/wav;base64,(.+)$/.exec(dataUri || '')
  if (!m) return null
  const b = Buffer.from(m[1], 'base64')
  return { channels: b.readUInt16LE(22), rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), seconds: +((b.length - 44) / b.readUInt32LE(28)).toFixed(1) }
}

async function main() {
  if (process.platform !== 'darwin') { console.error('要 macOS(say 合成人声)'); process.exit(1) }
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-voicestudio-'))
  // 假的百炼 provider(只为让设置页出音色工作室;音色接口全被下面的小代理顶替,不连百炼)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [{ providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-e2e-placeholder', modelIds: [] }] }))
  // 假麦克风:句前 1.5 秒静音,念一遍文案(16 kHz —— 正好拿来验「音质偏低」那条提醒)
  const mic = synthMic(home, [SCRIPT], [1.5, 1.5])
  // 选文件那条路的样本:同一段话的 48 kHz 双声道版(应当被重编码成单声道);再剪一个 3 秒的短样本
  const good = path.join(home, 'me-48k.wav'), mono = path.join(home, 'mono-48k.wav'), tiny = path.join(home, 'tiny.wav')
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '2', path.join(home, 'l0.aiff'), good])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', path.join(home, 'l0.aiff'), mono])
  writeWav(tiny, readWav(mono).subarray(0, 3 * 48000), 48000)
  console.log(`假麦克风 ${mic.file}(${mic.seconds.toFixed(1)}s)`)

  const stub = await startStubEngine({ sessions: [], messages: [] })
  // 引擎的音色接口:记下请求,回固定结果
  const clones = []
  let voices = [
    { voice: 'qwen-omni-vc-me-voice-1', kind: 'clone', targetModel: 'qwen3.8-omni-flash-realtime' },
    { voice: 'cosyvoice-v3.5-plus-old-1', kind: 'cosy', targetModel: 'cosyvoice-v3.5-plus' },
    { voice: 'unknown-binding-1', kind: 'cosy' }, // 百炼没回绑定的模型
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
  const port = 9400 + Math.floor(Math.random() * 400)
  // 裸起 Electron + CDP:playwright 的 _electron.launch 会顶掉 AudioServiceOutOfProcess → 假麦克风电平恒 0
  const child = spawn(require('electron'), [...fakeMicSwitches(mic.file), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, ...MAC_FLAGS], {
    cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: front.url, TANGU_HARNESS_QUIET: '1' }, stdio: 'ignore',
  })
  let browser = null
  try {
    await until(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false), 30_000, 300)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const pageWith = (selector, ms) => until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (await pg.locator(selector).count().catch(() => 0)) return pg
      return null
    }, ms, 400)
    const win = await pageWith('#root', 30_000)
    if (!win) throw new Error('30s 内没找到主窗口')
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.keyboard.press('Meta+Comma').catch(() => {})
    const sp = await pageWith('.settings-main', 15_000)
    if (!sp) throw new Error('15s 内没等到设置浮窗')

    await sp.locator('.settings-nav').getByRole('button', { name: '模型', exact: true }).first().click()
    await sp.waitForTimeout(500)
    await sp.locator('.settings-nav-subitem', { hasText: '语音' }).first().click()
    const sel = sp.locator('select.tts-clone-model')
    await sel.waitFor({ timeout: 10_000 })
    await sel.scrollIntoViewIfNeeded()
    // 朗读工作室这一块(「语音通话」那边的复刻面板缺省收着,整页只有这一个录音区)
    const studio = sp.locator('.field', { has: sel })
    const go = studio.locator('.tts-clone-go')
    const file = studio.locator('input[type="file"][accept="audio/*"]')
    const reportEl = studio.locator('.voice-sample-report')
    const report = () => reportEl.innerText().catch(() => '')
    const marks = async () => ({ warn: await reportEl.locator('.voice-sample-check--warn').count(), block: await reportEl.locator('.voice-sample-check--block').count(), ok: await reportEl.locator('.voice-sample-check--ok').count() })
    const shot = (name) => sp.screenshot({ path: path.join(home, `${name}.png`) }).catch(() => {})
    const flat = (s) => s.replace(/\n+/g, ' / ')

    const opts = await sel.locator('option').allTextContents()
    const def = await sel.inputValue()
    check('S1 复刻模型下拉:9 个模型 + 自定义,缺省是官方推荐的 qwen-audio-3.0-tts-plus',
      opts.length === 10 && def === 'qwen-audio-3.0-tts-plus' && /推荐/.test(opts[0]) && opts.some((o) => o === 'cosyvoice-v3.5-plus') && opts.some((o) => o === 'qwen3-tts-vc-2026-01-22'),
      `缺省 ${def};${opts.join(' / ')}`)
    const urlInputs = await sp.locator('.settings-main input[type="url"]').count()
    const idle = await go.isDisabled()
    check('S2 不要公网 URL;还没有样本时不能复刻', urlInputs === 0 && idle, `URL 输入框 ${urlInputs} 个;复刻键禁用=${idle}`)

    // ── 选文件 ──
    await file.setInputFiles(tiny)
    const tinyText = await until(async () => { const s = await report(); return /tiny\.wav/.test(s) ? s : null }, 8000) || ''
    const tinyMarks = await marks(), tinyBlocked = await go.isDisabled()
    check('S3 人声不到 5 秒的样本被拦住,说得出原因', /人声不到 5 秒/.test(tinyText) && tinyMarks.block === 1 && tinyBlocked, `${flat(tinyText)};复刻键禁用=${tinyBlocked}`)

    await sel.selectOption('cosyvoice-v3.5-plus')
    await file.setInputFiles(good)
    const goodText = await until(async () => { const s = await report(); return /me-48k/.test(s) ? s : null }, 8000) || ''
    const goodMarks = await marks()
    check('S4 干净的样本:报出时长,没有问题', /me-48k\.wav · \d+\.\d 秒，人声 \d+\.\d 秒/.test(goodText) && goodMarks.ok === 1 && goodMarks.warn + goodMarks.block === 0, flat(goodText))
    await go.click()
    await until(() => clones.length >= 1, 8000)
    const c1 = clones[0] || {}, w1 = wavOf(c1.audioData)
    check('S5 复刻请求:带选中的模型;双声道文件被重编码成单声道 16-bit WAV;选的文件不带文案',
      c1.targetModel === 'cosyvoice-v3.5-plus' && !!w1 && w1.channels === 1 && w1.bits === 16 && w1.rate === 48000 && Math.abs(w1.seconds - mic.lineSeconds[0]) < 0.5 && !('text' in c1) && !('language' in c1) && !('engine' in c1),
      JSON.stringify({ targetModel: c1.targetModel, wav: w1, text: c1.text }))
    const cfg = await until(async () => {
      const c = await sp.evaluate(() => window.tangu.getConfig())
      return c.ttsVoice === 'v-e2e-1' ? c : null
    }, 8000)
    const cleared = await until(async () => !(await reportEl.count()), 5000)
    check('S6 复刻成功 → 朗读模型和音色联动到新音色,录音区清回初始', cfg?.ttsModelId === 'bailian/cosyvoice-v3.5-plus' && cfg?.ttsVoice === 'v-e2e-1' && !!cleared, `${cfg?.ttsModelId} / ${cfg?.ttsVoice};已清=${!!cleared}`)

    const rows = await until(async () => {
      const r = await sp.locator('.settings-main .file-row').evaluateAll((els) => els.map((el) => ({
        name: el.querySelector('.file-name')?.textContent || '', tag: el.querySelector('.file-size')?.textContent || '',
        btns: [...el.querySelectorAll('button')].map((b) => b.title),
      })))
      return r.length >= 4 ? r : null
    }, 8000) || []
    const call = rows.find((r) => r.name.startsWith('qwen-omni-vc')), read = rows.find((r) => r.name === 'v-e2e-1'), unknown = rows.find((r) => r.name === 'unknown-binding-1')
    check('S7 我的音色:列出绑定的模型;通话音色、不知道绑了哪个模型的音色都不给「使用」,仍可删除',
      !!call && !!read && !!unknown && /通话音色/.test(call.tag) && /qwen3\.8-omni-flash-realtime/.test(call.tag) && !call.btns.includes('使用') && call.btns.includes('删除')
        && read.tag === 'cosyvoice-v3.5-plus' && read.btns.includes('使用') && !unknown.btns.includes('使用') && unknown.btns.includes('删除'),
      rows.map((r) => `${r.name}〔${r.tag}〕[${r.btns.join(',')}]`).join('  '))

    // ── 录一段 ──(假麦克风的文件从第一次开麦起播,只能录这一次)
    await sel.selectOption('qwen3-tts-vc-2026-01-22')
    await sel.scrollIntoViewIfNeeded()
    await studio.locator('.voice-sample-record').click()
    const startedAt = Date.now()
    const stopBtn = studio.locator('.voice-sample-stop')
    await stopBtn.waitFor({ timeout: 8000 })
    const shown = await studio.locator('.voice-sample-script').innerText().catch(() => '')
    const level = await until(() => studio.locator('.voice-sample-level > div').evaluate((el) => parseFloat(el.style.width) || 0).catch(() => 0), 8000, 100) || 0
    await shot('voice-studio-recording')
    check('S8 录音中:亮出文案和录音建议,电平条在动', shown.includes(SCRIPT) && /安静/.test(shown) && level > 0, `文案在=${shown.includes(SCRIPT)};电平 ${level}%`)
    await sleep(Math.max(0, startedAt + mic.seconds * 1000 + 700 - Date.now())) // 等假麦克风把话念完
    const label = await stopBtn.innerText()
    await stopBtn.click()
    const recText = await until(async () => { const s = await report(); return /刚录的/.test(s) ? s : null }, 8000) || ''
    const recMarks = await marks(), speech = +(/人声 (\d+\.\d) 秒/.exec(recText)?.[1] || 0)
    await shot('voice-studio-report')
    check('S9 录完出检查结果:人声够长;假麦克风是 16 kHz 的 → 只提醒音质偏低,不拦',
      /停止 · 0:\d\d/.test(label) && speech >= 10 && /音质偏低/.test(recText) && recMarks.warn === 1 && recMarks.block === 0 && !(await go.isDisabled()),
      `${label.trim()};${flat(recText)}`)
    await go.click()
    await until(() => clones.length >= 2, 8000)
    const c2 = clones[1] || {}, w2 = wavOf(c2.audioData)
    check('S10 录音的复刻请求:单声道 16-bit WAV(≥ 24 kHz),带上文案原文和语种',
      c2.targetModel === 'qwen3-tts-vc-2026-01-22' && !!w2 && w2.channels === 1 && w2.bits === 16 && w2.rate >= 24000 && Math.abs(w2.seconds - mic.seconds) < 3 && c2.text === SCRIPT && c2.language === 'zh',
      JSON.stringify({ targetModel: c2.targetModel, wav: w2, language: c2.language, text: String(c2.text).slice(0, 12) + '…' }))
    await until(async () => !(await reportEl.count()), 5000)

    // ── 自定义模型 ──
    await sel.selectOption('__custom__')
    const custom = sp.locator('input.tts-clone-model-custom')
    await custom.waitFor({ timeout: 5000 })
    await file.setInputFiles(good)
    await until(async () => /me-48k/.test(await report()), 8000)
    const disabledEmpty = await go.isDisabled()
    await custom.fill('my-future-tts-model')
    await go.click()
    await until(() => clones.length >= 3, 8000)
    check('S11 自定义模型 ID:空着不能复刻,填了就按填的发', disabledEmpty && clones[2]?.targetModel === 'my-future-tts-model', `空着禁用=${disabledEmpty};发出 ${clones[2]?.targetModel}`)
    await until(async () => !(await reportEl.count()), 5000)

    // 手填通话模型:不发请求,朗读配置不动
    await file.setInputFiles(good)
    await until(async () => /me-48k/.test(await report()), 8000)
    await custom.fill('qwen3.8-omni-flash-realtime')
    await go.click()
    await sp.waitForTimeout(1200)
    const after = await sp.evaluate(() => window.tangu.getConfig())
    const said = await sp.locator('.settings-main', { hasText: '这是通话模型' }).count()
    check('S12 在朗读工作室手填通话模型:拦住不复刻,朗读配置不被写坏', clones.length === 3 && said > 0 && after.ttsModelId === 'bailian/my-future-tts-model', `请求 ${clones.length} 次;提示=${said > 0};朗读模型 ${after.ttsModelId}`)

    console.log(`截图目录 ${home}`)
  } finally {
    await browser?.close().catch(() => {})
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    front.close()
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} PASS`)
  process.exit(failed || !results.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
