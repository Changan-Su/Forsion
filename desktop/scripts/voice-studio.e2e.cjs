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
      req.on('end', () => { const { __status = 200, ...out } = h(JSON.parse(body || '{}')); res.writeHead(__status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)) })
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
  const m4a = path.join(home, 'me.m4a') // 压缩格式:应当原样交,不重编码
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', path.join(home, 'l0.aiff'), m4a])
  const lowM4a = path.join(home, 'low.m4a') // 16 kHz 的压缩文件:低于百炼的采样率下限,不能原样交
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', path.join(home, 'l0.wav'), lowM4a])
  const long = path.join(home, 'long.wav') // 70 秒:同一段话接 5 遍再截
  writeWav(long, Int16Array.from({ length: 70 * 48000 }, ((src) => (_, i) => src[i % src.length])(readWav(mono))), 48000)
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
      if (body.name === 'slow') return { __status: 502, detail: 'The operation was aborted due to timeout' } // 引擎等百炼等到超时时的原话
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

    // 记下页面里每次 play() 的来源和结果(「试听」那条:CSP 的 media-src 不放行 data:)
    await sp.evaluate(() => {
      const play = HTMLMediaElement.prototype.play
      window.__plays = []
      HTMLMediaElement.prototype.play = function () {
        const r = play.call(this)
        r.then(() => window.__plays.push(`ok ${this.src.slice(0, 5)}`), (e) => window.__plays.push(`${e.name} ${this.src.slice(0, 5)}`))
        return r
      }
    })
    const direct = await sp.evaluate((uri) => { const a = new Audio(uri); return a.play().then(() => { a.pause(); return 'ok' }, (e) => e.name) }, `data:audio/wav;base64,${fs.readFileSync(tiny).toString('base64')}`)
    console.log(`(对照)同一个 WAV 直接当 data: URI 播 → ${direct}`)

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

    await file.setInputFiles(long)
    const longErr = await until(() => studio.locator('.voice-sample-error').innerText().catch(() => ''), 8000) || ''
    const longBlocked = await go.isDisabled()
    check('S3b 超过 60 秒的文件:只读时长就拦下(不整个解码),不能复刻', /超过 60 秒/.test(longErr) && !(await reportEl.count()) && longBlocked, `${flat(longErr)};复刻键禁用=${longBlocked}`)

    await sel.selectOption('cosyvoice-v3.5-plus')
    await file.setInputFiles(good)
    const goodText = await until(async () => { const s = await report(); return /me-48k/.test(s) ? s : null }, 8000) || ''
    const goodMarks = await marks()
    await studio.locator('.voice-sample-play').click()
    const played = await until(() => sp.evaluate(() => window.__plays.find((p) => p.endsWith('blob:')) || ''), 5000) || ''
    check('S4 干净的样本:报出时长,没有问题;「试听」真能播', /me-48k\.wav · \d+\.\d 秒，人声 \d+\.\d 秒/.test(goodText) && goodMarks.ok === 1 && goodMarks.warn + goodMarks.block === 0 && played === 'ok blob:', `${flat(goodText)};试听 ${played || '没播'}`)
    await sp.evaluate(() => document.querySelectorAll('audio').forEach((a) => a.pause()))
    await go.click()
    await until(() => clones.length >= 1, 8000)
    const c1 = clones[0] || {}, w1 = wavOf(c1.audioData)
    check('S5 复刻请求:带选中的模型;双声道 WAV 被重编码成 24 kHz 单声道 16-bit(体积减半);选的文件不带文案',
      c1.targetModel === 'cosyvoice-v3.5-plus' && !!w1 && w1.channels === 1 && w1.bits === 16 && w1.rate === 24000 && Math.abs(w1.seconds - mic.lineSeconds[0]) < 0.5 && !('text' in c1) && !('language' in c1) && !('engine' in c1),
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
    const c2 = clones[1] || {}
    const recBytes = Buffer.from(String(c2.audioData || '').replace(/^data:audio\/mp4;base64,/, ''), 'base64')
    fs.writeFileSync(path.join(home, 'recorded.m4a'), recBytes)
    let recSec = 0 // 交来的不是 m4a 时 afinfo 会报错 —— 那就是 0,由下面的断言判红
    try { recSec = +(/estimated duration: ([\d.]+)/.exec(execFileSync('afinfo', [path.join(home, 'recorded.m4a')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())?.[1] || 0) } catch { /* ignore */ }
    check('S10 录音的复刻请求:交的是 m4a(20 秒不到 300 KB,WAV 要 2 MB),时长对得上,带文案原文和语种',
      c2.targetModel === 'qwen3-tts-vc-2026-01-22' && /^data:audio\/mp4;base64,/.test(c2.audioData || '') && recBytes.length > 20_000 && recBytes.length < 300_000 && Math.abs(recSec - mic.seconds) < 3 && c2.text === SCRIPT && c2.language === 'zh',
      JSON.stringify({ targetModel: c2.targetModel, 开头: String(c2.audioData).slice(0, 22), KB: Math.round(recBytes.length / 1024), 秒: recSec, language: c2.language, text: String(c2.text).slice(0, 12) + '…' }))
    await until(async () => !(await reportEl.count()), 5000)

    // ── 自定义模型 ──
    await sel.selectOption('__custom__')
    const custom = sp.locator('input.tts-clone-model-custom')
    await custom.waitFor({ timeout: 5000 })
    await file.setInputFiles(m4a)
    const m4aText = await until(async () => { const s = await report(); return /me\.m4a/.test(s) ? s : null }, 8000) || ''
    const disabledEmpty = await go.isDisabled()
    await custom.fill('my-future-tts-model')
    await go.click()
    await until(() => clones.length >= 3, 8000)
    const c3 = clones[2] || {}
    const sameBytes = String(c3.audioData || '') === `data:audio/mp4;base64,${fs.readFileSync(m4a).toString('base64')}`
    check('S11 自定义模型 ID:空着不能复刻,填了就按填的发;选的 m4a 照样过检查,原样交不重编码',
      disabledEmpty && c3.targetModel === 'my-future-tts-model' && /人声 \d+\.\d 秒/.test(m4aText) && sameBytes && !('text' in c3),
      `空着禁用=${disabledEmpty};发出 ${c3.targetModel};${flat(m4aText)};字节一致=${sameBytes}(${Math.round(fs.statSync(m4a).size / 1024)} KB)`)
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

    // 上传超时:把引擎的英文原话换成人话,带上样本体积
    await custom.fill('my-future-tts-model')
    await studio.locator('input[placeholder^="名称"]').first().fill('slow')
    await go.click()
    const slowMsg = await until(async () => { const s = await studio.innerText(); return /超时/.test(s) ? (/✗[^\n]*/.exec(s)?.[0] || s) : null }, 8000) || ''
    check('S12b 上传超时:提示说清是传给百炼超时、样本多大、怎么办;不出现引擎的英文原话', /样本（\d+ KB）传给百炼超时/.test(slowMsg) && /录短一点/.test(slowMsg) && !/aborted/.test(slowMsg) && clones.length === 3, slowMsg)
    await studio.locator('input[placeholder^="名称"]').first().fill('')

    // ── 语音通话那边的复刻面板:同一个录音区,绑当前通话模型 ──
    await sp.locator('.realtime-switch').click()
    const toggle = sp.locator('.realtime-clone-toggle')
    await toggle.waitFor({ timeout: 8000 })
    await toggle.click()
    const callBox = sp.locator('.field', { has: toggle })
    const callGo = callBox.locator('.realtime-clone-go')
    const callIdle = await callGo.isDisabled()
    const callPick = async () => {
      await callBox.locator('input[type="file"][accept="audio/*"]').setInputFiles(good)
      await until(async () => /me-48k/.test(await callBox.locator('.voice-sample-report').innerText().catch(() => '')), 8000)
    }
    await callPick()
    const armed = !(await callGo.isDisabled())
    await toggle.click(); await toggle.click() // 收起再展开:录音区是空的,之前选的样本不能还留着
    const stale = !(await callGo.isDisabled())
    await callPick()
    await toggle.scrollIntoViewIfNeeded()
    await shot('voice-call-clone')
    await callGo.click()
    await until(() => clones.length >= 4, 8000)
    const c4 = clones[3] || {}, w4 = wavOf(c4.audioData)
    const callCfg = await until(async () => { const c = await sp.evaluate(() => window.tangu.getConfig()); return c.realtimeVoice === 'v-e2e-4' ? c : null }, 8000)
    check('S13 通话音色复刻:没样本不能点,收起再展开样本作废;绑当前通话模型发单声道 WAV;成功后通话音色切过去,朗读配置不动',
      callIdle && armed && !stale && /omni.*realtime/.test(c4.targetModel || '') && callCfg?.realtimeModelId === `bailian/${c4.targetModel}` && !!w4 && w4.channels === 1 && !('text' in c4)
        && callCfg?.realtimeVoice === 'v-e2e-4' && callCfg?.ttsVoice === after.ttsVoice && callCfg?.ttsModelId === after.ttsModelId,
      JSON.stringify({ 选了可点: armed, 收起后还可点: stale, targetModel: c4.targetModel, wav: w4, realtimeVoice: callCfg?.realtimeVoice, ttsVoice: callCfg?.ttsVoice }))

    // 16 kHz 的 m4a:提醒音质偏低,交出去的是重编码的 24 kHz WAV(原样交会被百炼的采样率下限拒掉)
    await sel.scrollIntoViewIfNeeded()
    await file.setInputFiles(lowM4a)
    const lowText = await until(async () => { const s = await report(); return /low\.m4a/.test(s) ? s : null }, 8000) || ''
    await go.click()
    await until(() => clones.length >= 5, 8000)
    const w5 = wavOf(clones[4]?.audioData)
    check('S14 16 kHz 的 m4a:提醒音质偏低;不原样交,重编码成 24 kHz WAV', /音质偏低/.test(lowText) && !!w5 && w5.rate === 24000 && w5.channels === 1, `${flat(lowText).slice(0, 60)};交出 ${String(clones[4]?.audioData).slice(0, 22)} ${JSON.stringify(w5)}`)

    // ── 换到 Qwen-Audio 通话模型:音色换一套,带不过去的回默认;复刻绑新模型;切回来能把原来的挑回来 ──
    const modelSel = sp.locator('select.realtime-model'), voiceSel = sp.locator('select.realtime-voice')
    const cfgNow = () => sp.evaluate(() => window.tangu.getConfig())
    const voiceOpts = () => voiceSel.locator('option').allTextContents()
    await modelSel.scrollIntoViewIfNeeded()
    const modelOpts = await modelSel.locator('option').allTextContents()
    await modelSel.selectOption('bailian/qwen-audio-3.1-realtime-plus')
    const a1 = await until(async () => { const c = await cfgNow(); return c.realtimeModelId === 'bailian/qwen-audio-3.1-realtime-plus' ? c : null }, 8000)
    const audioOpts = await voiceOpts(), audioShown = await voiceSel.inputValue()
    check('S15 换到 Qwen-Audio 通话模型:下拉里有它;Omni 的复刻音色带不过去 → 回默认 longanqian;音色表换成它那一套(只显示 ID)',
      modelOpts.includes('qwen-audio-3.1-realtime-plus') && a1?.realtimeVoice === '' && audioShown === 'longanqian' && audioOpts.includes('longanqian') && audioOpts.includes('cally_v3.1')
        && !audioOpts.some((o) => /Tina|v-e2e-4|settings\.realtime/.test(o)),
      `模型 ${modelOpts.join(' / ')};realtimeVoice=${JSON.stringify(a1?.realtimeVoice)};显示 ${audioShown};音色 ${audioOpts.length} 个:${audioOpts.slice(0, 3).join(',')}…${audioOpts.slice(-2).join(',')}`)
    await modelSel.scrollIntoViewIfNeeded()
    await shot('voice-call-qwen-audio')
    await toggle.scrollIntoViewIfNeeded()
    await callBox.locator('input[type="file"][accept="audio/*"]').setInputFiles(m4a)
    await until(async () => /me\.m4a/.test(await callBox.locator('.voice-sample-report').innerText().catch(() => '')), 8000)
    await callGo.click()
    await until(() => clones.length >= 6, 8000)
    const c6 = clones[5] || {}
    const a2 = await until(async () => { const c = await cfgNow(); return c.realtimeVoice === 'v-e2e-6' ? c : null }, 8000)
    const audioMine = await until(async () => { const o = await voiceOpts(); return o.some((x) => /我的音色 · v-e2e-6/.test(x)) ? o : null }, 8000) || []
    check('S16 在 Qwen-Audio 模型下复刻:请求绑这个模型、不带文案;成功后采用,并列进「我的音色」',
      c6.targetModel === 'qwen-audio-3.1-realtime-plus' && !('text' in c6) && a2?.realtimeVoice === 'v-e2e-6' && audioMine.length > 0 && !audioMine.some((o) => /v-e2e-4/.test(o)),
      JSON.stringify({ targetModel: c6.targetModel, realtimeVoice: a2?.realtimeVoice, 我的音色: audioMine.filter((o) => /我的音色/.test(o)) }))
    await modelSel.selectOption('bailian/qwen3.8-omni-flash-realtime')
    const a3 = await until(async () => { const c = await cfgNow(); return c.realtimeModelId === 'bailian/qwen3.8-omni-flash-realtime' ? c : null }, 8000)
    const omniOpts = await until(async () => { const o = await voiceOpts(); return o.some((x) => /我的音色 · v-e2e-4/.test(x)) ? o : null }, 8000) || await voiceOpts()
    await voiceSel.selectOption('v-e2e-4').catch(() => {})
    const a4 = await until(async () => { const c = await cfgNow(); return c.realtimeVoice === 'v-e2e-4' ? c : null }, 8000)
    check('S17 切回 Omni 模型:Qwen-Audio 的复刻音色不跟过来(回默认 Tina);之前在这个模型上复刻的列在下拉里,一点就挑回来',
      a3?.realtimeVoice === '' && omniOpts.some((o) => /^Tina/.test(o)) && omniOpts.some((o) => /我的音色 · v-e2e-4/.test(o)) && !omniOpts.some((o) => /v-e2e-6|longanqian/.test(o)) && a4?.realtimeVoice === 'v-e2e-4',
      `切回后 realtimeVoice=${JSON.stringify(a3?.realtimeVoice)};我的音色:${omniOpts.filter((o) => /我的音色/.test(o)).join(' | ')};挑回 ${a4?.realtimeVoice}`)
    await modelSel.selectOption('bailian/qwen3.5-omni-flash-realtime')
    const a5 = await until(async () => { const c = await cfgNow(); return c.realtimeModelId === 'bailian/qwen3.5-omni-flash-realtime' ? c : null }, 8000)
    await modelSel.selectOption('bailian/qwen3.8-omni-flash-realtime'); await sp.waitForTimeout(600)
    await voiceSel.selectOption('Cindy'); await until(async () => (await cfgNow()).realtimeVoice === 'Cindy', 5000)
    await modelSel.selectOption('bailian/qwen3.5-omni-plus-realtime')
    const a6 = await until(async () => { const c = await cfgNow(); return c.realtimeModelId === 'bailian/qwen3.5-omni-plus-realtime' ? c : null }, 8000)
    check('S18 同一家族里换型号:复刻音色照样带不过去(绑死在型号上);系统音色通用,留着',
      a5?.realtimeVoice === '' && a6?.realtimeVoice === 'Cindy', `带着复刻音色换型号 → ${JSON.stringify(a5?.realtimeVoice)};带着 Cindy 换型号 → ${JSON.stringify(a6?.realtimeVoice)}`)

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
