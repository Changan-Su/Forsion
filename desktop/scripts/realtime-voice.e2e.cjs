/**
 * 实时语音通话(对标 GPT Live)桌面整链 e2e:真 Electron × 真 Composer2 × 假麦克风 × 可编剧的假引擎(stub + ws /agent/realtime)。
 *   设置 → 模型 → 语音 选实时模型(真设置浮窗,跨窗生效)→ 主页输入框出「实时语音通话」按钮 → 点它:建会话、切到会话视图、接通
 *   → 第一句说完,假引擎回 3.5s 语音 → 第二句在放音中途开口 = 插话:播放必须当场清空(不是放完)→ 假引擎报 Tangu 代办
 *   → 状态显示「Tangu 处理中…」→ 静音后不再上传音频、取消静音恢复 → 挂断:连接断开、麦克风真停。
 * 引擎那半(真百炼 × 中转 × 委派 × 落库)由 tangu-agent 的 `npm run live:harness -- --only realtime` 管;这里不花额度。
 * 要 macOS(say 合成假麦克风)。需先 npm run build。用法:npm run e2e:realtimevoice   截图落在输出目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { WebSocketServer } = require('ws')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { synthMic, fakeMicSwitches } = require('./lib/voice-fixture.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) }
}

const RT_MODEL = 'bailian/qwen3.8-omni-flash-realtime'
// 假麦克风从通话接通(设备打开)那一刻开始放:句前 1.5s;第一句后 2s 开口第二句 —— 那时假引擎 3.5s 的回复还在放(= 插话)
const LINES = ['你好，今天天气怎么样', '等一下，帮我看看桌面上有什么文件']
const GAPS = [1.5, 2.0, 12.0]

/** 假引擎的 /agent/realtime:收 16k PCM、按电平判开口/说完(像服务端 VAD),按剧本回 24k PCM + 事件。 */
function fakeRealtime(stub) {
  const rt = { url: '', start: null, frames: 0, speechStarts: [], turns: 0, closed: false, sent: [] }
  const wss = new WebSocketServer({ noServer: true })
  const tone = (sec) => { // 440Hz 正弦,24k s16le
    const n = Math.round(24000 * sec), b = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 6000), i * 2)
    return b
  }
  wss.on('connection', (ws) => {
    const send = (o) => { rt.sent.push(o.type); ws.send(JSON.stringify(o)) }
    let speaking = false, lastLoud = 0
    const reply = async (text, sec) => {
      send({ type: 'response.created' })
      const pcm = tone(sec)
      for (let o = 0; o < pcm.length && ws.readyState === 1; o += 4800) { ws.send(pcm.subarray(o, o + 4800)); await sleep(20) } // 100ms/帧,比实时快
      send({ type: 'response.audio_transcript.done', transcript: text })
      stub.state.messages.push({ id: `rt-a${rt.turns}`, role: 'model', content: text, timestamp: Date.now() })
      send({ type: 'response.done', response: { status: 'completed', output: [{ type: 'message' }] } })
    }
    const turn = async () => {
      rt.turns++
      const said = LINES[rt.turns - 1] || '……'
      send({ type: 'conversation.item.input_audio_transcription.completed', transcript: said })
      stub.state.messages.push({ id: `rt-u${rt.turns}`, role: 'user', content: said, timestamp: Date.now() })
      if (rt.turns === 1) await reply('今天晴，二十度，适合出门走走。', 3.5)
      else {
        await reply('好，我让 Tangu 去看看。', 0.8)
        send({ type: 'tangu.run', status: 'started', run_id: 'r-voice', task: '列出桌面上的文件' })
        await sleep(4000)
        send({ type: 'tangu.run', status: 'done', run_id: 'r-voice', task: '列出桌面上的文件' })
      }
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { rt.start = JSON.parse(data.toString()); send({ type: 'ready' }); return }
      rt.frames++
      const pcm = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1)
      let sum = 0
      for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2
      const loud = Math.sqrt(sum / (pcm.length || 1)) > 0.02
      const now = Date.now()
      if (loud) { lastLoud = now; if (!speaking) { speaking = true; rt.speechStarts.push(now); send({ type: 'input_audio_buffer.speech_started' }) } }
      else if (speaking && now - lastLoud > 500) { speaking = false; send({ type: 'input_audio_buffer.speech_stopped' }); void turn() }
    })
    ws.on('close', () => { rt.closed = true })
  })
  rt.upgrade = (req, socket, head) => {
    if (!req.url.startsWith('/agent/realtime')) return socket.destroy()
    rt.url = req.url
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  return rt
}

async function main() {
  if (process.platform !== 'darwin') { console.error('要 macOS(say 合成假麦克风)'); process.exit(1) }
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-realtime-'))
  // 假的百炼 provider(只为让设置页出实时通话那一节;stub 引擎不会拿它去连任何地方)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [{ providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-e2e-placeholder', modelIds: [] }] }))
  const mic = synthMic(home, LINES, GAPS)
  console.log(`假麦克风 ${mic.file}(${mic.seconds.toFixed(1)}s)`)

  let rt = null
  const stub = await startStubEngine({ sessions: [], messages: [], upgrade: (...a) => rt.upgrade(...a) })
  rt = fakeRealtime(stub)
  const port = 9400 + Math.floor(Math.random() * 400)
  // 裸起 Electron + CDP:playwright 的 _electron.launch 会顶掉 AudioServiceOutOfProcess → 假麦克风电平恒 0
  const child = spawn(require('electron'), [...fakeMicSwitches(mic.file), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], {
    cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }, stdio: 'ignore',
  })
  const shot = (win, name) => win.screenshot({ path: path.join(home, `${name}.png`) }).catch(() => {})
  let browser = null
  try {
    await until(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false), 30_000, 300)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const win = await until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (await pg.locator('#root').count().catch(() => 0)) return pg
      return null
    }, 30_000, 500)
    if (!win) throw new Error('30s 内没找到主窗口')
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(2000)

    const before = await win.locator('.t2c-live-control').count().catch(() => 0)
    check('R0 没选实时模型时不画通话按钮', before === 0, `实得 ${before} 枚`)

    // 走真设置浮窗选模型(设置窗与主窗是两个 renderer,配置经主进程落 config.json 再同步回来)
    await win.keyboard.press('Meta+Comma').catch(() => {})
    const sp = await until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (await pg.locator('.settings-main').count().catch(() => 0)) return pg
      return null
    }, 15_000, 400)
    let picked = ''
    if (sp) {
      await sp.locator('.settings-nav').getByRole('button', { name: '模型', exact: true }).first().click().catch(() => {})
      await sp.waitForTimeout(500)
      await sp.locator('.settings-nav-subitem', { hasText: '语音' }).first().click().catch(() => {})
      const sel = sp.locator('select.realtime-model').first()
      await sel.waitFor({ timeout: 8000 }).catch(() => {})
      await sel.selectOption(RT_MODEL).catch(() => {})
      await sp.waitForTimeout(600)
      picked = await sel.inputValue().catch(() => '')
      await shot(sp, '0-settings')
      const closed = sp.waitForEvent('close').catch(() => {})
      await sp.locator('.settings-nav button:text-is("返回应用")').first().click({ timeout: 5000 }).catch(() => {})
      await closed
    }
    const cfgRt = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).tts?.realtimeModel
    check('R1 设置 → 模型 → 语音里选得到实时模型,落进 config.json', picked === RT_MODEL && cfgRt === RT_MODEL, `下拉 ${picked || '-'};config.tts.realtimeModel=${cfgRt}`)
    const btn = win.locator('.t2c-live-control').first()
    const shown = await until(() => btn.isVisible().catch(() => false), 8000)
    check('R2 关掉设置后主页输入框当场出现通话按钮(跨窗生效)', !!shown)
    await shot(win, '1-idle')
    if (!shown) throw new Error('没有通话按钮,后面不跑')

    // 外部观测(不往产品代码里埋测试钩子):麦克风流、播放源的 start/stop
    await win.evaluate(() => {
      const w = window
      w.__streams = []; w.__srcStart = 0; w.__srcStop = 0
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); w.__streams.push(s); return s }
      const P = AudioBufferSourceNode.prototype
      const st = P.start, sp = P.stop
      P.start = function (...a) { w.__srcStart++; return st.apply(this, a) }
      P.stop = function (...a) { w.__srcStop++; return sp.apply(this, a) }
    })
    const idsBefore = new Set((await fetch(`${stub.url}/agent/sessions`).then((r) => r.json())).sessions.map((x) => x.id))
    await btn.click()
    const ready = await until(() => rt.start, 10_000)
    const newSessions = (await fetch(`${stub.url}/agent/sessions`).then((r) => r.json())).sessions
    const created = newSessions.find((x) => !idsBefore.has(x.id)) || null
    check('R3 主页点通话:先建会话,再带着会话 / 模型 / 起 run 参数接通',
      !!ready && !!created && rt.start?.session_id === created.id && rt.start?.model === RT_MODEL && !!rt.start?.run?.model_id && typeof rt.start?.run?.agent_config === 'object' && /[?&]token=/.test(rt.url), // 外接 stub 引擎没有 token,只核带了这个参数
      `新会话 ${created?.id || '-'};start=${JSON.stringify(rt.start)?.slice(0, 160)};url=${rt.url.replace(/token=[^&]*/, 'token=…')}`)
    const bar = await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 5000)
    check('R4 通话跟到新会话视图:那里的输入框换成通话条', !!bar)
    await shot(win, '2-connected')

    // 第一句 → 假引擎回 3.5s 语音:放音中状态是「正在说」
    const speaking = await until(async () => (await win.locator('.t2c-voicebar .t2c-voicetime').first().textContent().catch(() => '')) === '正在说', 20_000, 100)
    check('R5 麦克风帧真送到了、第一句被听完,回复放出来时状态是「正在说」', rt.frames > 20 && rt.turns >= 1 && !!speaking, `帧 ${rt.frames};轮 ${rt.turns}`)
    await shot(win, '3-speaking')

    // 第二句在放音中途开口 → speech_started → 渲染端必须当场掐掉排着的播放(stop),不是等它放完
    const barge = await until(() => rt.speechStarts.length >= 2, 15_000, 100)
    await sleep(300)
    const srcStops = await win.evaluate(() => window.__srcStop)
    const srcStarts = await win.evaluate(() => window.__srcStart)
    check('R6 放音中插话:播放队列当场清空(半双工闸没把真人声当回声吞掉)', !!barge && srcStops > 0, `开口 ${rt.speechStarts.length} 次;播放源 start ${srcStarts} / stop ${srcStops}`)

    const working = await until(async () => (await win.locator('.t2c-voicebar .t2c-voicetime').first().textContent().catch(() => '')) === 'Tangu 处理中…', 20_000, 100)
    const title = await win.locator('.t2c-voicebar .t2c-voicetime').first().getAttribute('title').catch(() => null)
    check('R7 Agent 代办期间状态「Tangu 处理中…」,悬停看得到在办什么', !!working && title === '列出桌面上的文件', `title=${title}`)
    await shot(win, '4-working')
    const cleared = await until(async () => (await win.locator('.t2c-voicebar .t2c-voicetime').first().textContent().catch(() => '')) !== 'Tangu 处理中…', 8000, 200)
    check('R8 代办结束状态恢复', !!cleared)

    const chat = await until(async () => {
      const txt = await win.evaluate(() => document.body.innerText).catch(() => '')
      return txt.includes('今天晴') && txt.includes('今天天气怎么样')
    }, 8000, 300)
    check('R9 双方的话出现在聊天区(引擎写库 → 渲染端拉取)', !!chat)

    // 静音:不再上传;取消静音:恢复
    await win.locator('.t2c-voicebar .t2c-voicemute').first().click()
    await sleep(400)
    const f0 = rt.frames
    await sleep(1200)
    const mutedFrames = rt.frames - f0
    const mutedLabel = await win.locator('.t2c-voicebar .t2c-voicetime').first().textContent().catch(() => '')
    await win.locator('.t2c-voicebar .t2c-voicemute').first().click()
    await sleep(1200)
    const resumed = rt.frames - f0 - mutedFrames
    check('R10 静音后一帧不传、显示「已静音」;取消后恢复', mutedFrames === 0 && mutedLabel === '已静音' && resumed > 5, `静音期 ${mutedFrames} 帧;恢复 ${resumed} 帧;「${mutedLabel}」`)

    await win.locator('.t2c-voicebar .t2c-voicestop:not(.t2c-voicemute)').first().click()
    const hung = await until(() => rt.closed, 5000)
    await sleep(500)
    const after = await win.evaluate(() => ({
      bar: !!document.querySelector('.t2c-voicebar'),
      live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length,
    }))
    check('R11 挂断:连接断开、通话条收起、麦克风真停', !!hung && !after.bar && after.live === 0, JSON.stringify(after))
    await shot(win, '5-ended')
  } finally {
    try { await browser?.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    stub.close()
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过;截图 ${home}`)
  process.exit(results.every(Boolean) && results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
