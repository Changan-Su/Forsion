/**
 * 实时语音对话(免手)整链 e2e:真 Electron × 真 Composer2 × 假麦克风 × 本地 SenseVoice × 可编剧假引擎。
 *   macOS say 合成两句(句间长静音)→ 点输入框的「实时对话」→ 说完自动转写 → 自动发送 → 桩收到 run
 *   → Agent 回复期间暂停收音(录音条让位、按钮保持脉动)→ 回复完恢复 → 第二句同样发出 → 点 ■ 挂断。
 * 第二幕(在途竞态,评审 09-15):会话视图里再开一次(假设备从头重放),桩把「起 run」拖 14s —— 第一句还在发送途中
 *   第二句就到了:必须等第一句发完再单独发(走 steer),不许把草稿里没清的第一句带着重发。
 * 第三幕:草稿里先手打几个字 → 语音只追加不自动发;再切到另一个已有会话 → 挂断。
 * 第四幕:回主页开口,起 run 拖 14s → 交接途中第二句到达,必须排队进同一个新会话(评审 r2 #2)。
 * 第五幕:空白新对话开着通话点开已有会话 → 挂断。第六幕:起 run 回 500 → 那句回到草稿、通话结束(评审 r3)。
 * 开场先钉 L0:功能未完成,入口默认藏在开发者选项后面(localStorage forsion_tangu_live_voice),台架自己拨开。
 * 第七/八幕:通话中关掉那个开关 —— 按钮与录音条当场撤走(L15),发送在途那条路上麦克风也必须真停(L16)。
 * 无人值守、不花模型额度;要 macOS + 本地模型 ~/.forsion-dev/models/sensevoice(软链进隔离家目录,只读)。
 *
 * 需先 npm run build。用法:npm run e2e:livevoice   截图落在输出目录(观感自查用)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { synthMic, fakeMicSwitches } = require('./lib/voice-fixture.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SESSION = {
  id: 's1', title: '语音会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-09-15 09:00:00', updated_at: '2026-09-15 09:00:00',
}
// 假麦克风从「点实时对话、设备打开」那一刻开始放:句前 1.5s;句间 7s 要盖住「收口 0.7s + ASR 冷启 + 假回复 ~2s」
const LINES = [
  { text: '今天有点累,随便陪我聊两句吧。', keys: ['今天', '累'] },
  { text: '周末去爬山还是在家看电影好?', keys: ['周末', '爬山'] },
]
const REPLY = [{ type: 'token', payload: { delta: '嗯,' }, delay: 700 }, { type: 'token', payload: { delta: '我在听。' }, delay: 1200 }]

async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const models = path.join(os.homedir(), '.forsion-dev', 'models', 'sensevoice')
  if (!fs.existsSync(path.join(models, 'model.int8.onnx'))) { console.error(`本地 SenseVoice 模型不在 ${models}`); process.exit(1) }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-livevoice-'))
  fs.mkdirSync(path.join(home, 'models'), { recursive: true })
  fs.symlinkSync(models, path.join(home, 'models', 'sensevoice'))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ asr: { backend: 'local' } }))
  const mic = synthMic(home, LINES.map((l) => l.text), [1.5, 7.0, 4.0])
  console.log(`假麦克风 ${mic.file}(${mic.seconds.toFixed(1)}s)`)

  const steers = []
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [],
    handle: async ({ path: p, method, body }) => { if (method === 'POST' && /\/steer$/.test(p)) { steers.push((await body()).message || ''); return { ok: true, userMessageId: `st${steers.length}` } } },
  })
  stub.script(REPLY); stub.script(REPLY)
  // ⚠️ 不用 playwright 的 _electron.launch:它的 loader 启动时 appendSwitch('disable-features', 自己的列表),
  // 把命令行上的 AudioServiceOutOfProcess 顶掉 → 假麦克风电平恒 0(实测)。改为裸起 Electron + CDP 附着。
  const port = 9400 + Math.floor(Math.random() * 400)
  const child = spawn(require('electron'), [...fakeMicSwitches(mic.file), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], {
    cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }, stdio: 'ignore',
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
    win.on('console', (m) => { if (m.text().includes('[voice]')) console.log('   ', m.text()) })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1200)
    await win.waitForTimeout(1500)
    // 功能未完成(还没逐句朗读/打断),入口藏在 设置 → 开发者选项 后面:先钉「缺省不画」,再拨开关。
    const beforeOptIn = await win.locator('.t2c-live-control').count().catch(() => 0)
    check('L0 缺省不画「实时对话」按钮(藏在开发者选项后)', beforeOptIn === 0, `实得 ${beforeOptIn} 枚`)
    // 拨开关走**真 UI**:开关画在独立的设置浮窗里、按钮画在主窗,跨窗同步(storage 事件 + 切回主窗的 focus)
    // 正是这次改动唯一的新线。抄近路直接 setItem 等于把要验的那根线换成桩。
    await win.evaluate(() => localStorage.setItem('forsion_tangu_dev_mode', '1')) // 连点版本号解锁由 active-window T5 盯着
    await win.keyboard.press('Meta+Comma').catch(() => {})
    const sp = await until(async () => {
      for (const ctx of browser.contexts()) for (const pg of ctx.pages()) {
        if (await pg.locator('.settings-main').count().catch(() => 0)) return pg
      }
      return null
    }, 15_000, 400)
    let toggled = false
    if (sp) {
      const nav = sp.locator('.settings-nav')
      for (const label of ['开发者选项', 'Developer options']) {
        const b = nav.getByRole('button', { name: label, exact: true }).first()
        if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); await sp.waitForTimeout(600); break }
      }
      const row = sp.locator('.settings-main .field').filter({ hasText: /实时语音对话|Live voice conversation/ }).first()
      const box = row.locator('input[type="checkbox"]').first()
      if (await box.count().catch(() => 0)) { await box.check().catch(() => {}); toggled = true }
      await sp.waitForTimeout(400)
      const closed = sp.waitForEvent('close').catch(() => {})
      await sp.locator('.settings-nav button:text-is("返回应用"), .settings-nav button:text-is("Back to app")').first().click({ timeout: 5000 }).catch(() => {})
      await closed
    }
    check('L0b 设置 → 开发者选项里拨得动「实时语音对话」', toggled)
    await win.waitForTimeout(1000)

    // 刻意从**主页**输入框开始(最自然的入口):第一句发出后会切到会话视图、Composer 换实例 —— 实时对话必须跟过去。
    const onHome = await win.locator('.t2c-live-control').count().catch(() => 0)
    const liveBtn = win.locator('.t2c-live-control').first()
    check('L1 拨开关后主页输入框当场出现「实时对话」按钮(跨窗生效,不用重启)', onHome > 0 && await liveBtn.isVisible().catch(() => false))
    await shot(win, '1-idle')
    if (!(await liveBtn.isVisible().catch(() => false))) throw new Error('没有实时对话按钮,后面不跑')

    const t0 = Date.now()
    await liveBtn.click()
    const bar = await until(() => win.locator('.t2c-voicebar .t2c-voicetime').first().textContent().catch(() => null), 5000)
    check('L2 点击后录音条就位,显示「聆听中」', bar === '聆听中', `实得「${bar}」`)
    await shot(win, '2-listening')

    const firstRun = await until(() => stub.seen.runs.length >= 1, 25_000)
    const msg1 = stub.seen.runs[0]?.message || ''
    check('L3 第一句说完自动发送,内容对', !!firstRun && LINES[0].keys.every((k) => msg1.includes(k)), `${((Date.now() - t0) / 1000).toFixed(1)}s 「${msg1}」`)
    await sleep(400)
    const during = await win.evaluate(() => ({
      bar: !!document.querySelector('.t2c-voicebar'),
      pulsing: !!document.querySelector('.t2c-live-control.recording'),
      stop: !!document.querySelector('.t2c-stop'),
    }))
    check('L4 回复期间(已切到会话视图)录音条让位、停止键可点、实时按钮保持脉动', !during.bar && during.stop && during.pulsing, JSON.stringify(during))
    await shot(win, '3-replying')

    const secondRun = await until(() => stub.seen.runs.length >= 2, 25_000)
    const msg2 = stub.seen.runs[1]?.message || ''
    check('L5 回复完恢复收音,第二句同样发出', !!secondRun && LINES[1].keys.every((k) => msg2.includes(k)), `${((Date.now() - t0) / 1000).toFixed(1)}s 「${msg2}」`)
    await sleep(4000) // 句后静音放完:不该再冒出第三条(噪声/回声误触发)
    check('L6 静音期不误触发,总共恰好 2 条', stub.seen.runs.length === 2, `runs=${stub.seen.runs.length}`)
    const draft = await win.locator('.t2c-ta').first().inputValue().catch(() => '?')
    check('L7 发送后草稿清空', draft === '', `草稿「${draft}」`)

    await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 5000)
    await win.locator('.t2c-voicebar .t2c-voicestop').first().click().catch(() => {})
    await win.waitForTimeout(500)
    const after = await win.evaluate(() => ({ bar: !!document.querySelector('.t2c-voicebar'), pulsing: !!document.querySelector('.t2c-live-control.recording') }))
    check('L8 点 ■ 挂断:录音条消失、按钮复位', !after.bar && !after.pulsing, JSON.stringify(after))
    await shot(win, '4-ended')

    // ── 第二幕:发送往返途中又说一句 ──
    const before = stub.seen.runs.length
    stub.state.runDelayMs = 14_000
    stub.script(REPLY)
    await win.locator('.t2c-live-control').first().click()
    const t1 = Date.now()
    const got = await until(() => stub.seen.runs.length > before && steers.length + stub.seen.runs.length - before >= 2, 45_000, 300)
    const sent = [...stub.seen.runs.slice(before).map((r) => r.message || ''), ...steers]
    const hasA = sent.filter((m) => m.includes(LINES[0].keys[1]))
    check('L9 在途期间第一句只发一次、第二句单独发出(不合并不重发)', !!got && hasA.length === 1 && sent.some((m) => m.includes(LINES[1].keys[1]) && !m.includes(LINES[0].keys[1])),
      `${((Date.now() - t1) / 1000).toFixed(1)}s runs=${JSON.stringify(stub.seen.runs.slice(before).map((r) => r.message))} steers=${JSON.stringify(steers)}`)
    stub.state.runDelayMs = 0
    await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 10_000)
    await win.locator('.t2c-voicebar .t2c-voicestop').first().click().catch(() => {})
    await win.waitForTimeout(800)

    // ── 第三幕:草稿里有手打的字 → 语音只追加不自动发;说完 >5s 后切到另一个会话 → 挂断 ──
    const sentBefore = stub.seen.runs.length + steers.length
    await win.locator('.t2c-live-control').first().click()
    await win.locator('.t2c-ta').first().fill('手打草稿')
    const appended = await until(async () => { const v = await win.locator('.t2c-ta').first().inputValue().catch(() => ''); return v.includes(LINES[0].keys[1]) ? v : null }, 20_000, 300)
    const tA = Date.now() // ≈ 第一句交出时刻(切换窗口从这里起算)
    await sleep(1500)
    check('L10 草稿有手打内容时语音只追加、不自动发送', !!appended && appended.startsWith('手打草稿') && stub.seen.runs.length + steers.length === sentBefore,
      `草稿「${appended}」 新发送 ${stub.seen.runs.length + steers.length - sentBefore}`)
    await sleep(Math.max(0, 5600 - (Date.now() - tA))) // 过了「发送自己引起的切换」窗口,才算用户主动切走
    await win.locator('.t2s-srow', { hasText: SESSION.title }).first().click().catch(() => {})
    await win.waitForTimeout(1200)
    const switched = await win.evaluate(() => ({ bar: !!document.querySelector('.t2c-voicebar'), pulsing: !!document.querySelector('.t2c-live-control.recording') }))
    check('L11 切到另一个已有会话即挂断', !switched.bar && !switched.pulsing, JSON.stringify(switched))
    await shot(win, '5-switched')

    // ── 第四幕(评审 r2 #2 直接复现):主页开口 + 起 run 慢 14s → 第二句在第一句发送途中到达,且此时已交接到会话视图 ──
    await win.locator('.rb-home').first().click().catch(() => {})
    await until(() => win.locator('.t2c-live-control').first().isVisible().catch(() => false), 10_000)
    const runsBefore4 = stub.seen.runs.length, steersBefore4 = steers.length
    stub.state.runDelayMs = 14_000
    stub.script(REPLY)
    await win.locator('.t2c-live-control').first().click()
    const t4 = Date.now()
    const got4 = await until(() => stub.seen.runs.length - runsBefore4 + steers.length - steersBefore4 >= 2, 50_000, 300)
    const runs4 = stub.seen.runs.slice(runsBefore4), steers4 = steers.slice(steersBefore4)
    const all4 = [...runs4.map((r) => r.message || ''), ...steers4]
    check('L12 主页入口在途竞态:第一句只发一次、第二句单独进同一个新会话(不串旧会话、不另建会话)',
      !!got4 && all4.filter((m) => m.includes(LINES[0].keys[1])).length === 1
        && all4.some((m) => m.includes(LINES[1].keys[1]) && !m.includes(LINES[0].keys[1]))
        && new Set(runs4.map((r) => r.sessionId)).size === 1 && runs4[0]?.sessionId !== SESSION.id,
      `${((Date.now() - t4) / 1000).toFixed(1)}s runs=${JSON.stringify(runs4.map((r) => [r.sessionId, r.message]))} steers=${JSON.stringify(steers4)}`)
    stub.state.runDelayMs = 0
    await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 10_000)
    await win.locator('.t2c-voicebar .t2c-voicestop').first().click().catch(() => {})
    await win.waitForTimeout(800)

    // ── 第五幕(评审 r3):空白新对话里开着通话,点开已有会话 → 挂断(旧版 `prev &&` 放过了 null→A) ──
    await win.locator('text=新对话').first().click().catch(() => {})
    await win.waitForTimeout(1200)
    await win.locator('.t2c-live-control').first().click()
    await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 5000)
    await win.locator('.t2s-srow', { hasText: SESSION.title }).first().click().catch(() => {})
    await win.waitForTimeout(1200)
    const fromEmpty = await win.evaluate(() => ({ bar: !!document.querySelector('.t2c-voicebar'), pulsing: !!document.querySelector('.t2c-live-control.recording') }))
    check('L13 空白新对话开着通话、点开已有会话即挂断', !fromEmpty.bar && !fromEmpty.pulsing, JSON.stringify(fromEmpty))

    // ── 第六幕(评审 r3):发送没被接受 → 这句回到当前输入框草稿、通话收场(别丢话,也别继续往出错的会话里说) ──
    // 桩从不消费 steer:L9/L12 里以 steer 发出的第二句,run 结束后会被应用按「未消费插话退回草稿」放回输入框 → 先清掉,别触发手打闸
    await win.locator('.t2c-ta').first().fill('')
    const runsBefore6 = stub.seen.runs.length
    stub.state.failRuns = true
    await win.locator('.t2c-live-control').first().click()
    const kept = await until(async () => { const v = await win.locator('.t2c-ta').first().inputValue().catch(() => ''); return v.includes(LINES[0].keys[1]) ? v : null }, 25_000, 300)
    await win.waitForTimeout(800)
    const after6 = await win.evaluate(() => ({ bar: !!document.querySelector('.t2c-voicebar'), pulsing: !!document.querySelector('.t2c-live-control.recording') }))
    check('L14 发送失败:那句回到草稿、通话结束', !!kept && !after6.bar && !after6.pulsing && stub.seen.runs.length === runsBefore6 + 1,
      `草稿「${kept}」 ${JSON.stringify(after6)} runs+${stub.seen.runs.length - runsBefore6}`)
    stub.state.failRuns = false
    await shot(win, '6-failed-kept')

    // ── 第七幕:通话进行中把开发者开关关掉 —— 按钮没了、麦克风也不许还开着 ──
    await win.locator('.t2c-ta').first().fill('').catch(() => {})
    await win.locator('.t2c-live-control').first().click()
    const live7 = await until(() => win.locator('.t2c-voicebar').first().isVisible().catch(() => false), 5000)
    await win.evaluate(() => {
      localStorage.setItem('forsion_tangu_live_voice', '0')
      window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_tangu_live_voice', newValue: '0' }))
    })
    await win.waitForTimeout(1200)
    const off7 = await win.evaluate(() => ({
      btn: document.querySelectorAll('.t2c-live-control').length,
      bar: !!document.querySelector('.t2c-voicebar'),
    }))
    check('L15 通话中关掉开关:按钮撤走、录音条收起', !!live7 && off7.btn === 0 && !off7.bar,
      `开着时 bar=${!!live7} → ${JSON.stringify(off7)}`)
    await shot(win, '7-gate-off')

    // ── 第八幕:空白新对话里「发送在途」时关掉开关 —— 这条路会走交接槽(只暂停不停采集),麦克风必须真的停,
    //    不许留到 HANDOFF_MS 超时(评审确认:开关关掉时全窗 owner 皆假,槽没人接得走,白开 5s)。
    //    断言看 MediaStream 轨道本身,不看 DOM:DOM 那半 L15 已经钉过,这里要钉的是麦克风。
    await win.evaluate(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      window.__liveStreams = []
      window.__trackEndAt = null
      navigator.mediaDevices.getUserMedia = async (c) => { const st = await orig(c); window.__liveStreams.push(st); return st }
      // 采样轨道何时真停:交接槽那条路要等 HANDOFF_MS=5000 才 kill,直接停则是即刻 —— 只有时刻能分辨两者。
      setInterval(() => {
        const st = (window.__liveStreams || []).at(-1)
        if (st && !window.__trackEndAt && st.getAudioTracks().every((t) => t.readyState === 'ended')) window.__trackEndAt = performance.now()
      }, 100)
      localStorage.setItem('forsion_tangu_live_voice', '1')
      window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_tangu_live_voice', newValue: '1' }))
    })
    await win.locator('.rb-home').first().click().catch(() => {})
    await win.waitForTimeout(600)
    await win.locator('text=新对话').first().click().catch(() => {}) // 空白新对话:它自己的 sessionId===null → handoffOnSend
    await until(() => win.locator('.t2c-live-control').first().isVisible().catch(() => false), 10_000)
    const runsBefore8 = stub.seen.runs.length
    stub.state.runDelayMs = 12_000 // 第一句发送途中(promise 未 resolve)= 交接槽那条分支的触发条件
    stub.script(REPLY)
    await win.locator('.t2c-live-control').first().click()
    const inFlight8 = await until(() => stub.seen.runs.length > runsBefore8, 40_000, 200)
    await win.evaluate(() => {
      window.__flipAt = performance.now()
      localStorage.setItem('forsion_tangu_live_voice', '0')
      window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_tangu_live_voice', newValue: '0' }))
    })
    await win.waitForTimeout(6500) // > HANDOFF_MS=5000:交接槽那条路到这会儿也停了,靠「停在什么时刻」分辨
    const t8 = await win.evaluate(() => ({ end: window.__trackEndAt, flip: window.__flipAt }))
    const delay8 = t8.end == null ? null : Math.round(t8.end - t8.flip)
    check('L16 在途时关掉开关:麦克风当场停(不是留到交接超时 5s)',
      !!inFlight8 && delay8 != null && delay8 >= 0 && delay8 < 1500,
      `在途=${!!inFlight8} 关开关后 ${delay8}ms 轨道停(负数=关之前就停了,说明这条路没复现)`)
    stub.state.runDelayMs = 0
    await shot(win, '8-gate-off-inflight')
  } catch (e) {
    console.error('e2e 异常:', e?.stack || e)
    results.push(false)
  } finally {
    await browser?.close().catch(() => {})
    child.kill('SIGTERM')
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    stub.close()
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} PASS  截图 ${home}`)
  process.exit(results.length && results.every(Boolean) ? 0 : 1)
}
main()
