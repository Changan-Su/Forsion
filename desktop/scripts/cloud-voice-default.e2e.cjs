/**
 * 语音通话的云端缺省(真 Electron × 假引擎 × 假 Forsion 云端,不花额度、不连真账号):
 *   A 已登录 Forsion、从没动过「语音通话」、云端有通话模型 → 输入框直接有通话键;拨出去交给引擎的是云端那个模型 + 明说的缺省音色;
 *     设置 → 模型 → 语音里开关是开的、选着「Forsion 云端 · …」、说明是按通话时长扣额度,而且**看一眼不落盘**;
 *     关掉 = 落盘空串、通话键当场消失;重启后仍然关着(不会因为登录着又自己开回来);再打开 = 落盘云端模型。
 *   B 没登录(同一份云端目录)→ 没有通话键;设置里提示「登录 Forsion 账号就能直接用云端的通话模型」。
 *   C 设置窗开着的时候登录(登录前的模型目录里没有云端通话模型)→ 「语音通话」这节当场变成开着 + 云端模型,和主窗的通话键对得上。
 * 通话本体(麦克风 / 放音 / 插话)在 e2e:realtimevoice;云端中转那半在 tangu-agent check:realtime 的 H 段与 server 的 realtime.test.ts。
 * 需先 npm run build。用法:npm run e2e:cloudvoice   截图落在输出目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { WebSocketServer } = require('ws')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { startFakeForsionCloud } = require('./lib/fake-forsion-cloud.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every) }
}

// 云端通话模型:id 故意不带家族信息(导入出来的 pr-<hash> 就长这样),家族只能从上游模型名看
const CLOUD_MODEL = { id: 'pr-voice-01', name: 'Forsion Voice', apiModelId: 'qwen3.5-omni-flash-realtime' }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

const signIn = (home, cloud) => fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'u1', username: 'demo_user' })}.e2e` }))

async function launch({ home, signedIn, cloud, stub }) {
  if (signedIn) signIn(home, cloud)
  const app = await electron.launch({
    // 假麦克风设备:只为让 getUserMedia 不弹系统授权、当场成功(电平是什么无所谓,这里不测通话本体)
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }, timeout: 90_000,
  })
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('tangu_locale', 'zh') })
  await win.reload({ waitUntil: 'domcontentloaded' })
  const left = await skipOnboarding(win)
  await win.locator('.t2c-ta').first().waitFor({ timeout: 30_000 })
  return { app, win, left }
}

/** 打开设置浮窗并走到 模型 → 语音。 */
async function openVoiceSettings(app, win) {
  const opened = app.waitForEvent('window', { timeout: 15_000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma')
  const sp = await opened
  if (!sp) return null
  await sp.waitForSelector('.settings-main', { timeout: 15_000 })
  await sp.locator('.settings-nav').getByRole('button', { name: '模型', exact: true }).first().click()
  await sp.locator('.settings-nav-subitem', { hasText: '语音' }).first().click()
  await sp.locator('.settings-sec', { hasText: '语音通话' }).first().waitFor({ timeout: 8000 })
  return sp
}
const closeSettings = async (sp) => {
  const closed = sp.waitForEvent('close').catch(() => {})
  await sp.locator('.settings-nav button:text-is("返回应用")').first().click({ timeout: 5000 }).catch(() => sp.close())
  await closed
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cloudvoice-'))
  const rt = { starts: [] }
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws) => ws.on('message', (d, bin) => {
    if (bin) return
    const m = JSON.parse(d.toString())
    if (m.type === 'start') { rt.starts.push(m); ws.send(JSON.stringify({ type: 'ready' })) }
  }))
  let catalogMeta = { realtimeModel: CLOUD_MODEL } // C 段中途换
  let catalogReads = 0 // 引擎的模型目录被拉了几次(/agent/models 每次读一遍 modelsMeta)
  const stubData = {
    sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub', provider: 'stub', source: 'forsion', contextWindow: 128_000, thinkingLevels: ['off'] }],
    get modelsMeta() { catalogReads++; return catalogMeta },
    upgrade: (req, socket, head) => (req.url.startsWith('/agent/realtime') ? wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)) : socket.destroy()),
  }
  const stub = await startStubEngine(stubData)
  const cloud = await startFakeForsionCloud({ scenario: 'both' })
  const cfgOf = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).tts || {} } catch { return {} } }
  const liveBtn = (win) => win.locator('.t2c-live-control')
  let app = null
  try {
    // ── A:已登录、从没动过
    const home = path.join(out, 'signed-in'); fs.mkdirSync(home)
    let s = await launch({ home, signedIn: true, cloud, stub }); app = s.app
    let win = s.win
    check('A0 主窗离开首启引导', s.left)
    const shown = await until(() => liveBtn(win).first().isVisible(), 15_000)
    check('A1 已登录、没配过任何通话模型:输入框直接有通话键', !!shown && cfgOf(home).realtimeModel === undefined, `config.tts.realtimeModel=${JSON.stringify(cfgOf(home).realtimeModel)}`)
    await win.screenshot({ path: path.join(out, 'a1-call-button.png') }).catch(() => {})

    // 设置页:开着、选着云端、看一眼不落盘
    let sp = await openVoiceSettings(app, win)
    if (!sp) throw new Error('设置浮窗没打开')
    const view = {
      on: await sp.locator('.realtime-switch.on').count(),
      model: await sp.locator('select.realtime-model').first().inputValue().catch(() => ''),
      label: await sp.locator('select.realtime-model option:checked').first().textContent().catch(() => ''),
      voice: await sp.locator('select.realtime-voice').first().inputValue().catch(() => ''),
      hint: (await sp.locator('.field', { has: sp.locator('select.realtime-model') }).first().textContent().catch(() => '')) || '',
      clone: await sp.locator('.realtime-clone-toggle').count(),
    }
    check('A2 设置里开关是开的,选着「Forsion 云端 · Forsion Voice」,说明按通话时长扣额度,没有「复刻」(那是自带百炼才有的)',
      view.on === 1 && view.model === CLOUD_MODEL.id && view.label === 'Forsion 云端 · Forsion Voice' && view.voice === 'Tina' && /按通话时长/.test(view.hint) && view.clone === 0, JSON.stringify(view))
    await sp.screenshot({ path: path.join(out, 'a2-settings.png') }).catch(() => {})
    check('A2b 只是看一眼设置:不落盘(仍算「没动过」)', cfgOf(home).realtimeModel === undefined, JSON.stringify(cfgOf(home)))
    await closeSettings(sp)

    // 拨出去:引擎收到的是云端模型 + 明说的缺省音色
    const mini = app.waitForEvent('window', { timeout: 15_000 }).catch(() => null)
    await liveBtn(win).first().click()
    const card = await mini
    const start = await until(async () => rt.starts[0], 15_000)
    check('A3 点通话键:交给引擎的是云端的通话模型,缺省音色按上游模型名的家族明说', start?.model === CLOUD_MODEL.id && start?.voice === 'Tina', JSON.stringify({ model: start?.model, voice: start?.voice }))
    if (card) { await card.locator('.vc-hangup').first().click({ timeout: 5000 }).catch(() => {}); await card.waitForEvent('close', { timeout: 5000 }).catch(() => card.close().catch(() => {})) }

    // 关掉:落盘空串,通话键当场消失
    sp = await openVoiceSettings(app, win)
    await sp.locator('.realtime-switch').first().click()
    const offSaved = await until(async () => cfgOf(home).realtimeModel === '', 5000)
    const selGone = (await until(async () => (await sp.locator('select.realtime-model').count()) === 0, 3000)) ? 0 : 1 // 落盘在前、设置窗重画在后:等一下再数
    await closeSettings(sp)
    const gone = await until(async () => (await liveBtn(win).count()) === 0, 8000)
    check('A4 关掉:config 落盘空串、模型下拉收起、主窗通话键当场消失', !!offSaved && selGone === 0 && !!gone, JSON.stringify({ cfg: cfgOf(home), selGone, gone: !!gone }))
    await app.close().catch(() => {}); app = null

    // 重启:登录着也不自己开回来
    s = await launch({ home, signedIn: true, cloud, stub }); app = s.app; win = s.win
    await sleep(3000) // 给登录态与模型目录到位的时间:要证的是「到位之后也不出」
    const stillOff = (await liveBtn(win).count()) === 0
    sp = await openVoiceSettings(app, win)
    const swOff = await sp.locator('.realtime-switch.on').count()
    check('A5 重启后仍然关着(关掉是用户的决定,登录着也不替他开回来)', stillOff && swOff === 0 && cfgOf(home).realtimeModel === '', JSON.stringify({ stillOff, swOff, cfg: cfgOf(home) }))
    await sp.locator('.realtime-switch').first().click() // 再打开:回到云端那个
    const onSaved = await until(async () => cfgOf(home).realtimeModel === CLOUD_MODEL.id, 5000)
    await closeSettings(sp)
    const back = await until(() => liveBtn(win).first().isVisible(), 8000)
    check('A6 再打开:落盘云端模型,通话键回来', !!onSaved && !!back, JSON.stringify(cfgOf(home)))
    await app.close().catch(() => {}); app = null

    // ── B:没登录
    const home2 = path.join(out, 'signed-out'); fs.mkdirSync(home2)
    s = await launch({ home: home2, signedIn: false, cloud, stub }); app = s.app; win = s.win
    await sleep(3000)
    const none = (await liveBtn(win).count()) === 0
    sp = await openVoiceSettings(app, win)
    const hint2 = (await sp.locator('.field', { hasText: '语音通话' }).first().textContent().catch(() => '')) || ''
    const sw2 = await sp.locator('.realtime-switch').count()
    await sp.screenshot({ path: path.join(out, 'b-signed-out.png') }).catch(() => {})
    check('B 没登录:没有通话键;设置里不给开关,提示登录 Forsion 或添加自己的百炼提供方', none && sw2 === 0 && /登录 Forsion 账号/.test(hint2) && cfgOf(home2).realtimeModel === undefined, JSON.stringify({ none, sw2, hint: hint2.slice(0, 60) }))
    await app.close().catch(() => {}); app = null

    // ── C:设置窗开着时登录。登录前引擎的目录里没有云端通话模型(没登录的引擎拿不到),登录后才有
    catalogMeta = {}
    const home3 = path.join(out, 'sign-in-live'); fs.mkdirSync(home3)
    s = await launch({ home: home3, signedIn: false, cloud, stub }); app = s.app; win = s.win
    sp = await openVoiceSettings(app, win)
    const before = await sp.locator('.realtime-switch').count()
    catalogMeta = { realtimeModel: CLOUD_MODEL }
    const readsBefore = catalogReads
    await sp.evaluate(() => { window.__authChanged = 0; window.tangu.onAuthChanged(() => { window.__authChanged++ }) })
    signIn(home3, cloud) // 主进程盯着 auth.json,变了就广播登录态变化(广播前先等各窗口应答,最长 15 秒)
    const tC = Date.now()
    const live = await until(async () => (await sp.locator('.realtime-switch.on').count()) === 1 && (await sp.locator('select.realtime-model').first().inputValue().catch(() => '')) === CLOUD_MODEL.id, 45_000)
    const liveMs = Date.now() - tC
    // 没过时的线索:广播到了几次、主进程认不认这份登录、设置窗这节现在写着什么
    const probeC = live ? undefined : await sp.evaluate(async () => ({ broadcasts: window.__authChanged, cfg: await window.tangu.getConfig().then((c) => ({ backendUrl: c.backendUrl, mode: c.mode, hasToken: !!c.token })).catch((e) => String(e)), auth: await window.tangu.authStatus().catch((e) => String(e)), text: (document.querySelector('.realtime-switch')?.className || '') + ' | ' + (Array.from(document.querySelectorAll('.field')).find((f) => /语音通话/.test(f.textContent || ''))?.textContent || '').slice(0, 80) })).catch((e) => String(e))
    await sp.screenshot({ path: path.join(out, 'c-signed-in-live.png') }).catch(() => {})
    // 主窗那半只报不判:它靠「登录 → 引擎带新凭据重启 → 重连 → 重拉目录」(既有机制),这里的假引擎是外接的、不会重启
    const btn = await until(() => liveBtn(win).first().isVisible(), 5000)
    check('C 设置窗开着时登录:「语音通话」当场变成开着 + 云端模型(不用关了重开),仍然不落盘',
      before === 0 && !!live && cfgOf(home3).realtimeModel === undefined, JSON.stringify({ before, live: !!live, liveMs, mainWindowButton: !!btn, cfg: cfgOf(home3), catalogReadsAfterSignIn: catalogReads - readsBefore, probe: probeC }))
  } catch (e) {
    check('台架异常', false, String(e?.stack || e))
  } finally {
    await app?.close().catch(() => {})
    try { await stub.close() } catch { /* ignore */ }
    try { await cloud.close() } catch { /* ignore */ }
    wss.close()
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过;截图与隔离 home 在 ${out}`)
  process.exit(results.length && results.every(Boolean) ? 0 : 1)
}
main()
