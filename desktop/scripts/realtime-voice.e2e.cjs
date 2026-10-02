/**
 * 语音通话桌面整链 e2e:真 Electron × 真 Composer2 × 真 Mini 卡片 × 假麦克风 × 可编剧的假引擎(stub + ws /agent/realtime)。
 *   设置 → 模型 → 语音 选实时模型(真设置浮窗,跨窗生效)→ 主页输入框出电话键(只在普通模式)→ 点它:建会话、主窗切到会话、
 *   Mini 卡片弹出并在 Mini 里接通(头像 / 名字 / 麦克风 / 扬声器 / Effort)→ 第一句说完,假引擎回 3.5s 语音 → 第二句在放音中途开口
 *   = 插话:播放必须当场清空 → 假引擎报 Tangu 代办 → Mini 状态「Tangu 处理中…」→ 双方的话出现在**主窗**聊天区(跨窗拉取)
 *   → 静音 / 换麦克风 / 换 Effort(引擎收到新委派参数、主窗档位跟着变)→ 同会话再按电话键不重拨 → 挂断:连接断开、Mini 关窗。
 * 引擎那半(真百炼 × 中转 × 委派 × 落库)由 tangu-agent 的 `npm run live:harness -- --only realtime` 管;这里不花额度。
 * 要 macOS(say 合成假麦克风)。需先 npm run build。用法:npm run e2e:realtimevoice   截图落在输出目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { WebSocketServer } = require('ws')
const { MAC_FLAGS } = require('./lib/launch-electron.cjs') // 裸起 Electron 也要跳过 macOS 崩溃后的重开窗口模态
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
  const rt = { url: '', start: null, starts: 0, texts: [], frames: 0, speechStarts: [], turns: 0, closed: false, sent: [] }
  const wss = new WebSocketServer({ noServer: true })
  const tone = (sec) => { // 440Hz 正弦,24k s16le
    const n = Math.round(24000 * sec), b = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 6000), i * 2)
    return b
  }
  wss.on('connection', (ws) => {
    rt.ws = ws
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
      if (!isBinary) {
        const m = JSON.parse(data.toString())
        if (m.type === 'start') { rt.starts++; rt.start = m; send({ type: 'ready' }) } else rt.texts.push(m)
        // 打的字:像真引擎那样落库(聊天区靠 Mini 的 activity 叫主窗拉到)
        if (m.type === 'text') stub.state.messages.push({ id: `rt-t${rt.texts.length}`, role: 'user', content: m.text, timestamp: Date.now() })
        return
      }
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
  const child = spawn(require('electron'), [...fakeMicSwitches(mic.file), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, ...MAC_FLAGS], {
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

    const liveBtn = () => win.locator('.t2c-live-control')
    const before = await liveBtn().count().catch(() => 0)
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
    const btn = liveBtn().first()
    const shown = await until(() => btn.isVisible().catch(() => false), 8000)
    const phoneIcon = await btn.locator('svg.lucide-phone').count().catch(() => 0)
    check('R2 关掉设置后主页输入框当场出现电话键(跨窗生效)', !!shown && phoneIcon === 1, `phone 图标 ${phoneIcon}`)
    await shot(win, '1-idle')
    if (!shown) throw new Error('没有通话按钮,后面不跑')

    // 只在普通模式:开计划模式电话键消失,关掉回来
    const modeMenu = async (label) => {
      await win.locator('.mode-pill-btn').first().click()
      await win.locator('.composer-menu--mode .menu-item', { hasText: label }).first().click()
      await sleep(300)
    }
    await modeMenu('开启计划模式')
    const inPlan = await liveBtn().count()
    await modeMenu('计划模式·已开')
    const back = await until(() => liveBtn().first().isVisible().catch(() => false), 3000)
    check('R3 电话键只在普通模式:计划模式下不画,关掉计划模式回来', inPlan === 0 && !!back, `计划模式下 ${inPlan} 枚`)

    // Mini 卡片是点了才开的新窗:先挂外部观测(不往产品代码里埋测试钩子),新页面载入前就生效
    await browser.contexts()[0].addInitScript(() => {
      if (!location.search.includes('window=mini')) return
      const w = window
      w.__streams = []; w.__srcStart = 0; w.__srcStop = 0
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); w.__streams.push(s); return s }
      const P = AudioBufferSourceNode.prototype
      const st = P.start, sp = P.stop
      P.start = function (...a) { w.__srcStart++; return st.apply(this, a) }
      P.stop = function (...a) { w.__srcStop++; return sp.apply(this, a) }
    })
    // 主窗收到的跨窗事件(Mini → localStorage storage 事件)
    await win.evaluate(() => {
      window.__callEvts = []
      window.addEventListener('storage', (e) => { if (e.key === 'forsion_voice_call_evt' && e.newValue) window.__callEvts.push(JSON.parse(e.newValue)) })
    })
    const idsBefore = new Set((await fetch(`${stub.url}/agent/sessions`).then((r) => r.json())).sessions.map((x) => x.id))
    await btn.click()
    const mini = await until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (pg.url().includes('window=mini')) return pg
      return null
    }, 15_000, 300)
    const ready = await until(() => rt.start, 15_000)
    const newSessions = (await fetch(`${stub.url}/agent/sessions`).then((r) => r.json())).sessions
    const created = newSessions.find((x) => !idsBefore.has(x.id)) || null
    check('R4 点电话键:先建会话,弹出 Mini 卡片,由 Mini 带着会话 / 模型 / 起 run 参数接通',
      !!mini && !!ready && !!created && rt.start?.session_id === created.id && rt.start?.model === RT_MODEL && !!rt.start?.run?.model_id && typeof rt.start?.run?.agent_config === 'object' && /[?&]token=/.test(rt.url), // 外接 stub 引擎没有 token,只核带了这个参数
      `Mini ${mini ? 'ok' : '-'};新会话 ${created?.id || '-'};start=${JSON.stringify(rt.start)?.slice(0, 160)}`)
    if (!mini) throw new Error('没有 Mini 卡片,后面不跑')
    const ui = await until(async () => {
      const r = await mini.evaluate(() => ({
        name: document.querySelector('.voice-call .vc-name')?.textContent || '',
        avatar: !!document.querySelector('.voice-call .vc-avatar'),
        selects: [...document.querySelectorAll('.voice-call select')].map((x) => x.getAttribute('aria-label')),
        buttons: !!document.querySelector('.vc-mute') && !!document.querySelector('.vc-hangup'),
      })).catch(() => null)
      return r?.name && r.selects.length === 3 && r.buttons ? r : null
    }, 8000, 200)
    const mainChat = await until(async () => (await win.locator('.t2c-voicebar').count()) === 0 && await win.locator('.t2c-live-control').first().isVisible().catch(() => false), 5000)
    check('R5 Mini 是打电话界面:头像 + 名字 + 麦克风 / 扬声器 / Effort + 静音 / 挂断;主窗输入框不变', !!ui && !!mainChat, JSON.stringify(ui))
    await shot(mini, '2-mini-connected')

    const status = () => mini.locator('.vc-status-text').first().textContent().catch(() => '')
    // 第一句 → 假引擎回 3.5s 语音:放音中状态是「正在说」
    const speaking = await until(async () => (await status()) === '正在说', 20_000, 100)
    check('R6 麦克风帧真送到了、第一句被听完,回复放出来时状态是「正在说」', rt.frames > 20 && rt.turns >= 1 && !!speaking, `帧 ${rt.frames};轮 ${rt.turns}`)
    const halo = await mini.evaluate(async () => {
      const el = document.querySelector('.vc-portrait'), h = document.querySelector('.vc-halo')
      let max = 0
      for (let i = 0; i < 10; i++) { max = Math.max(max, Number(getComputedStyle(el).getPropertyValue('--vc-level')) || 0); await new Promise((r) => setTimeout(r, 60)) }
      const cs = getComputedStyle(h)
      return { max, transform: cs.transform, opacity: cs.opacity, bg: cs.backgroundColor }
    }).catch((e) => ({ err: String(e) }))
    check('R6b 放音时头像光环跟着电平放大', halo.max > 0.1, JSON.stringify(halo))
    await shot(mini, '3-speaking')

    // 第二句在放音中途开口 → speech_started → 渲染端必须当场掐掉排着的播放(stop),不是等它放完
    const barge = await until(() => rt.speechStarts.length >= 2, 15_000, 100)
    await sleep(300)
    const srcStops = await mini.evaluate(() => window.__srcStop)
    const srcStarts = await mini.evaluate(() => window.__srcStart)
    check('R7 放音中插话:播放队列当场清空(半双工闸没把真人声当回声吞掉)', !!barge && srcStops > 0, `开口 ${rt.speechStarts.length} 次;播放源 start ${srcStarts} / stop ${srcStops}`)

    const working = await until(async () => (await status()) === 'Tangu 处理中…', 20_000, 100)
    const title = await mini.locator('.vc-status').first().getAttribute('title').catch(() => null)
    check('R8 Agent 代办期间状态「Tangu 处理中…」,悬停看得到在办什么', !!working && title === '列出桌面上的文件', `title=${title}`)
    await shot(mini, '4-working')
    const cleared = await until(async () => (await status()) !== 'Tangu 处理中…', 8000, 200)
    check('R9 代办结束状态恢复', !!cleared)

    const chat = await until(async () => {
      const txt = await win.evaluate(() => document.body.innerText).catch(() => '')
      return txt.includes('今天晴') && txt.includes('今天天气怎么样')
    }, 8000, 300)
    const evts = await win.evaluate(() => window.__callEvts.filter((e) => e.kind === 'activity').map((e) => e.sessionId))
    // 主窗自己也有常规轮询,话迟早会出来;跨窗事件是为了不等那一轮(所以单独核事件到了没有)
    check('R10 双方的话出现在主窗聊天区;Mini 有新话时跨窗通知了主窗', !!chat && evts.length > 0 && evts.every((x) => x === created?.id), `activity 事件 ${evts.length} 条`)

    // 静音:不再上传;取消静音:恢复
    await mini.locator('.vc-mute').first().click()
    await sleep(400)
    const f0 = rt.frames
    await sleep(1200)
    const mutedFrames = rt.frames - f0
    const mutedLabel = await status()
    await mini.locator('.vc-mute').first().click()
    await sleep(1200)
    const resumed = rt.frames - f0 - mutedFrames
    check('R11 静音后一帧不传、显示「已静音」;取消后恢复', mutedFrames === 0 && mutedLabel === '已静音' && resumed > 5, `静音期 ${mutedFrames} 帧;恢复 ${resumed} 帧;「${mutedLabel}」`)

    // 换麦克风:新流接上继续上传,旧流真停
    const mics = await mini.evaluate(() => [...document.querySelectorAll('.voice-call select')][0].querySelectorAll('option').length)
    const micSel = mini.locator('.voice-call select').nth(0)
    const otherMic = await micSel.evaluate((el) => [...el.options].map((o) => o.value).find((v) => v && v !== el.value) || '')
    let swapped = null
    if (otherMic) {
      await micSel.selectOption(otherMic)
      await sleep(800)
      const f1 = rt.frames
      await sleep(1000)
      swapped = await mini.evaluate(() => ({ streams: window.__streams.length, live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length }))
      swapped.frames = rt.frames - f1
    }
    const savedDev = await mini.evaluate(() => localStorage.getItem('forsion_voice_call_devices')).catch(() => '')
    check('R12 换麦克风:新流接上照常上传、旧流真停,选择记住', !!swapped && swapped.streams >= 2 && swapped.live === 1 && swapped.frames > 5 && (savedDev || '').includes(otherMic),
      `选项 ${mics} 个;${JSON.stringify(swapped)}`)

    // 换 Effort:引擎收到新的委派参数;会话配置落盘;主窗输入框的档位跟着变
    const nConfigs = stub.seen.configs.length
    await mini.locator('.voice-call select').nth(2).selectOption('high')
    const runMsg = await until(() => rt.texts.find((m) => m.type === 'run' && m.run?.agent_config?.thinkingLevel === 'high'), 5000)
    const patched = await until(() => stub.seen.configs.slice(nConfigs).find((c) => c.sessionId === created?.id && c.config?.thinkingLevel === 'high'), 5000)
    const pillHigh = await until(async () => (await win.evaluate(() => document.querySelector('.t2c-card')?.innerText || '')).includes('High'), 5000, 200)
    check('R13 Mini 里换 Effort:引擎收到新委派参数、会话配置落盘、主窗输入框档位同步', !!runMsg && !!patched && !!pillHigh,
      `run=${!!runMsg};PATCH=${JSON.stringify(patched?.config || null)};主窗 High=${!!pillHigh}`)
    await shot(mini, '5-mini-settings')
    // 暗色观感(只截图不断言):base.css 的明暗 token 挂在 html[data-mode] 上
    const mode = await mini.evaluate(() => document.documentElement.getAttribute('data-mode'))
    // theme/loader.applyTheme 的两处:data-mode + .dark(只写一处只拿到半套变量)
    await mini.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await sleep(300)
    await shot(mini, '5b-mini-dark')
    await mini.evaluate((m) => { document.documentElement.setAttribute('data-mode', m || 'light'); document.documentElement.classList.toggle('dark', m === 'dark') }, mode)

    // 同会话再按电话键 = 叫回卡片,不重拨
    await win.locator('.t2c-live-control').first().click()
    await sleep(1500)
    check('R14 同一会话再按电话键不重拨(只叫回卡片)', rt.starts === 1 && !rt.closed, `start ${rt.starts} 次;已断 ${rt.closed}`)

    // 通话中在主窗打字:送进电话(Mini 转给引擎),不起普通 run;输入框提示换成通话状态
    const ta = win.locator('.t2c-ta:visible').first()
    const placeholder = await ta.getAttribute('placeholder').catch(() => '')
    const runsBefore = stub.seen.runs.length
    await ta.fill('帮我记一下明天下午开会')
    await ta.press('Enter')
    const typed = await until(() => rt.texts.find((m) => m.type === 'text' && m.text === '帮我记一下明天下午开会'), 4000)
    await sleep(800)
    const shownTyped = await until(async () => (await win.evaluate(() => document.body.innerText)).includes('帮我记一下明天下午开会'), 4000, 200)
    check('R16 通话中打字送进电话:Mini 转给引擎、不起普通 run、草稿清空、出现在聊天区;输入框提示是通话状态',
      !!typed && stub.seen.runs.length === runsBefore && (await ta.inputValue()) === '' && !!shownTyped && /通话中/.test(placeholder || ''),
      `placeholder「${placeholder}」;普通 run +${stub.seen.runs.length - runsBefore}`)

    // 引擎用实时模型听到的原话改正了一行语音转写 → 主窗那条当场换掉(轮询不刷已显示的消息)
    const fixedText = '你好，今天天气到底怎么样'
    const row = stub.state.messages.find((m) => m.id === 'rt-u1')
    if (row) row.content = fixedText
    rt.ws.send(JSON.stringify({ type: 'transcript.corrected', message_id: 'rt-u1', text: fixedText }))
    const fixedShown = await until(async () => {
      const txt = await win.evaluate(() => document.body.innerText)
      return txt.includes(fixedText) && !txt.includes('你好，今天天气怎么样\n') ? true : null
    }, 4000, 200)
    check('R17 语音转写被改正后,主窗聊天区那条当场换成改正后的原话', !!fixedShown)

    // 改正比这行先到(在途那次轮询拿的是旧行,合并时本地已有的优先):主窗要等这行出现再改,不能丢
    const lateText = '帮我写一个贪吃蛇小游戏'
    rt.ws.send(JSON.stringify({ type: 'transcript.corrected', message_id: 'rt-late', text: lateText }))
    await sleep(500)
    stub.state.messages.push({ id: 'rt-late', role: 'user', content: '帮我写一个看知识小游戏', timestamp: Date.now() })
    const lateShown = await until(async () => {
      const txt = await win.evaluate(() => document.body.innerText)
      return txt.includes(lateText) && !txt.includes('看知识') ? true : null
    }, 10000, 300)
    check('R17b 改正先到、这行后到:主窗拉到这行时换成改正后的原话', !!lateShown)

    // 主窗超时改发 Tangu 之后才到的 text 事件:Mini 不再送进电话(否则一句话办两遍)
    const nStale = rt.texts.length
    await win.evaluate((sid) => localStorage.setItem('forsion_voice_call_evt', JSON.stringify({ kind: 'text', sessionId: sid, text: '过期的一句', id: 'stale-1', at: Date.now() - 5000, n: 'stale-1' })), created?.id)
    await sleep(1000)
    check('R16b 过期的 text 事件 Mini 不接', rt.texts.length === nStale, `rt 收到 ${rt.texts.length - nStale} 条`)

    // 超过通话上限的长文:照常交给 Tangu,不被截断后当成送进了电话
    const runsLong = stub.seen.runs.length
    const nLong = rt.texts.length
    await ta.fill('长'.repeat(4001))
    await ta.press('Enter')
    const longRun = await until(() => stub.seen.runs.slice(runsLong).find((r) => String(r.message || '').length > 4000), 5000)
    check('R16c 超长文字不进电话,照常交给 Tangu', !!longRun && rt.texts.length === nLong)
    await until(async () => (await win.locator('.t2c-stop').count()) === 0, 8000, 200)

    // 引擎换上游重连(百炼服务端出错):卡片显示「重新接通」,接上后计时不清零、麦克风不重复上传
    const secs = async () => { const t = await mini.locator('.vc-timer').first().textContent().catch(() => ''); const [a, b] = String(t).split(':').map(Number); return a * 60 + b }
    const rate = async () => { const f = rt.frames; await sleep(1000); return rt.frames - f }
    const rateBefore = await rate()
    const tBefore = await secs()
    rt.ws.send(JSON.stringify({ type: 'reconnecting' }))
    const reconnLabel = await until(async () => { const x = await mini.locator('.vc-status-text').first().textContent().catch(() => ''); return /重新接通/.test(x || '') ? x : null }, 3000, 100)
    await sleep(500)
    rt.ws.send(JSON.stringify({ type: 'ready' }))
    await sleep(300)
    const after = await rate()
    const tAfter = await secs()
    const backLabel = await mini.locator('.vc-status-text').first().textContent().catch(() => '')
    check('R20 上游重连:卡片显示「重新接通」,接上后回到正在听、计时不清零、麦克风帧率不翻倍',
      !!reconnLabel && !/重新接通/.test(backLabel || '') && tAfter >= tBefore && after > 3 && after <= rateBefore * 1.5,
      `「${reconnLabel}」→「${backLabel}」;计时 ${tBefore}s→${tAfter}s;帧/秒 ${rateBefore}→${after}`)

    const miniClosed = mini.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
    await mini.locator('.vc-hangup').first().click()
    const hung = await until(() => rt.closed, 5000)
    check('R15 挂断:连接断开、Mini 卡片关窗', !!hung && await miniClosed)

    // 挂断后打字 = 普通消息(交给 Tangu)
    const runsAfterHang = stub.seen.runs.length
    const nTexts = rt.texts.length
    const ph2 = await ta.getAttribute('placeholder').catch(() => '')
    await ta.fill('挂断后的普通消息')
    await ta.press('Enter')
    const normalRun = await until(() => stub.seen.runs.slice(runsAfterHang).find((r) => String(r.message || '').includes('挂断后的普通消息')), 5000)
    check('R18 挂断后打字照常发给 Tangu,输入框提示恢复', !!normalRun && rt.texts.length === nTexts && !/通话中/.test(ph2 || ''), `placeholder「${ph2}」`)
    await until(async () => (await win.locator('.t2c-stop').count()) === 0, 8000, 200) // 等那条 run 收尾,下一句别变成插队
    await sleep(500)

    // 登记残留(Mini 崩了没撤):打字等不到 Mini 确认 → 2s 后改发给 Tangu 并提示,不丢
    await win.evaluate((sid) => {
      localStorage.setItem('forsion_voice_call_active', sid)
      window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_voice_call_active', newValue: sid }))
    }, created?.id)
    await sleep(300)
    const runsStale = stub.seen.runs.length
    await ta.fill('没人接的一句')
    await ta.press('Enter')
    const fellBack = await until(() => stub.seen.runs.slice(runsStale).find((r) => String(r.message || '').includes('没人接的一句')), 6000, 200)
    const hint = await win.evaluate(() => document.body.innerText.includes('通话没接上，这条改发给 Tangu 了'))
    const stale = await win.evaluate(() => localStorage.getItem('forsion_voice_call_active'))
    check('R19 登记残留时打字:等不到 Mini 确认就改发给 Tangu、提示一句、清掉登记', !!fellBack && hint && stale === null,
      `run=${!!fellBack};提示=${hint};登记=${stale}`)
    await shot(win, '6-ended')

    // 百炼服务端出错挂断:卡片说人话(原文在悬停里),不溢出卡片
    await until(async () => (await win.locator('.t2c-stop').count()) === 0, 8000, 200)
    const startsBefore = rt.starts
    await win.locator('.t2c-live-control').first().click()
    const mini2 = await until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (pg.url().includes('window=mini') && !pg.isClosed()) return pg
      return null
    }, 15_000, 300)
    await until(() => rt.starts > startsBefore, 10_000)
    await sleep(800)
    const ERR = '<50002> InternalError.Algo.ModelServingError: Internal Error calling model processing.'
    rt.ws.send(JSON.stringify({ type: 'end', reason: ERR }))
    const errUi = await until(async () => {
      const r = await mini2?.evaluate(() => {
        const el = document.querySelector('.vc-status.is-error')
        const txt = el?.querySelector('.vc-status-text')
        if (!el || !txt) return null
        return { text: txt.textContent, title: el.getAttribute('title'), lines: Math.round(txt.getBoundingClientRect().height / parseFloat(getComputedStyle(txt).lineHeight)),
          clipped: document.querySelector('.vc-settings').getBoundingClientRect().top < txt.getBoundingClientRect().bottom }
      }).catch(() => null)
      return r
    }, 5000, 200)
    if (mini2) await shot(mini2, '7-mini-service-error')
    check('R21 百炼服务端出错挂断:卡片显示「语音服务出错」、原文在悬停里、最多两行不压住下面',
      !!errUi && /语音服务出错/.test(errUi.text) && !/InternalError/.test(errUi.text) && (errUi.title || '').includes('<50002>') && errUi.lines <= 2 && !errUi.clipped,
      JSON.stringify(errUi))
  } finally {
    try { await browser?.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    stub.close()
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过;截图 ${home}`)
  process.exit(results.every(Boolean) && results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
