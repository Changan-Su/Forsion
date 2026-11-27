/**
 * 「这台手机」本机引擎的界面走查台架(第 1 期):在 Android 模拟器上用真实触摸走一遍
 *   「在哪运行」→ 这台手机 → 确认下载 → 下载 / 解包 / 自检 → 选中 → 发一条消息 → 拿到回复(回复里带 run_bash 在 PRoot 里跑出的结果)。
 * 判据:界面上能看到的(弹层里的行与面板、药丸上的名字、聊天里的回复)+ 原生状态 + 假模型被问了两次;每步截图。
 *
 * 云端 API(localhost:8788)由 CDP Fetch 拦截应答(同 phone-guide-emu.cjs),本机引擎的请求走原生中继 → 127.0.0.1,不经网络栈。
 * 引擎的模型:home/config.json 里配一个直连 provider(假模型 10.0.2.2:18901),cloud.defaultModel = emu/echo。
 *
 * 前置:
 *   cd mobile && VITE_API_ORIGIN=http://localhost:8788 npm run build && npm run sync:android \
 *     && (cd android && ./gradlew :app:assembleDebug -PlocalEngine -PlocalEngineManifest=http://10.0.2.2:18900/manifest.json)
 *   ⚠️ cap sync 会改写 android/capacitor.settings.gradle —— 别提交那份改动。
 *   ENV_DIR = mobile/scripts/local-engine/build-env.sh 的产物
 * 用法:
 *   ANDROID_SERIAL=emulator-5584 ENV_DIR=<产物> [APK=android/app/build/outputs/apk/debug/app-debug.apk] [OUT=<截图目录>] node scripts/local-engine-ui-emu.cjs
 * ⚠️ 会删掉模拟器上这个 App 已装的本机环境(对话与工作区保留),好让界面从头走下载。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const h = require('./lib/emu-cdp.cjs')
const { startFixtures } = require('./lib/local-engine-fixtures.cjs')

const PKG = 'com.forsion.tangu'
const CDP_PORT = Number(process.env.CDP_PORT || 9354)
const ENV_DIR = process.env.ENV_DIR
const OUT = process.env.OUT || path.join(os.tmpdir(), 'local-engine-ui')
const THROTTLE = Number(process.env.THROTTLE || 4 * 1024 * 1024) // 慢一点,好截到下载中的那一屏
const API_PATTERN = process.env.API_PATTERN || '*localhost:8788*'
fs.mkdirSync(OUT, { recursive: true })
if (!ENV_DIR || !fs.existsSync(path.join(ENV_DIR, 'manifest.json'))) { console.error('ENV_DIR must point at a build-env.sh output (manifest.json)'); process.exit(2) }

const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
const shot = (name) => { const f = h.screenshot(OUT, name); console.log(`  · screenshot ${f}`); return f }

let cdp = null
const stubLog = []
function installStub() {
  cdp.on('Fetch.requestPaused', (ev) => {
    const url = new URL(ev.request.url)
    const p = url.pathname
    const m = ev.request.method
    stubLog.push(`${m} ${p}`)
    const json = (data, code = 200) => cdp.send('Fetch.fulfillRequest', {
      requestId: ev.requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(data)).toString('base64'),
    }).catch(() => {})
    if (m === 'OPTIONS') {
      return cdp.send('Fetch.fulfillRequest', {
        requestId: ev.requestId, responseCode: 204,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: '*' }],
      }).catch(() => {})
    }
    if (p.endsWith('/auth/me')) return json({ username: 'e2e', id: 'e2e' })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'e2e' })
    if (p.endsWith('/units') && m === 'GET') return json({ units: [] }) // 名下没有电脑:「这台手机」也得单独撑起「在哪运行」
    if (p.endsWith('/inbox/broadcasts')) return json({ broadcasts: [] })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: [] })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: [] })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: [] })
    if (p.endsWith('/agent/runs') && m === 'GET') return json({ runs: [] })
    if (p.endsWith('/agent/approvals/pending')) return json({ rev: '1', approvals: [] })
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: [{ id: 'cloud-model', name: 'Cloud Model', provider: 'Forsion', source: 'forsion', modelType: 'llm' }], directProviders: [], defaultModelId: 'cloud-model' })
    return cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionRefused' }).catch(() => {})
  })
  return cdp.send('Fetch.enable', { patterns: [{ urlPattern: API_PATTERN, requestStage: 'Request' }] })
}

const plug = (call, args = {}) => cdp.eval(`Capacitor.Plugins.ForsionLocalEngine.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)
async function waitState(pred, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  let s
  while (Date.now() < end) {
    s = await plug('state')
    if (pred(s)) return s
    await h.pause(1000)
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
}

/** Device-pixel centre of a page element (CSS zoom × dpr + the WebView's place on screen), once it stops moving. */
async function elPoint(expr) {
  const measure = () => cdp.eval(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect()
    let z = 1; for (let e = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1
    return { x: (r.left + r.width / 2) * z, y: (r.top + r.height / 2) * z, dpr: devicePixelRatio } })()`)
  let r = await measure()
  for (let i = 0; i < 20 && r; i++) {
    await h.pause(150)
    const n = await measure()
    if (n && Math.abs(n.x - r.x) < 0.5 && Math.abs(n.y - r.y) < 0.5) { r = n; break }
    r = n
  }
  if (!r) throw new Error(`element missing: ${expr}`)
  const wv = h.nodes(OUT).find((n) => n.class === 'android.webkit.WebView')
  return { x: Math.round((wv ? wv.rect.left : 0) + r.x * r.dpr), y: Math.round((wv ? wv.rect.top : 0) + r.y * r.dpr) }
}
async function tapEl(expr) { const p = await elPoint(expr); h.tapAt(p.x, p.y) }
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`
const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled })`

async function main() {
  const fx = await startFixtures({ envDir: ENV_DIR, throttle: THROTTLE })
  if (process.env.APK) { console.log('installing', process.env.APK); h.adb('install', '-r', '-t', process.env.APK) }
  h.adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
  h.adb('shell', 'am', 'force-stop', PKG)
  h.adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  cdp = await h.connect(PKG, CDP_PORT, 40000)
  await installStub()
  // signed in (fake token; the cloud API is stubbed), Chinese UI, first-run guide already done
  await cdp.eval(`(async () => {
    await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: 'e2e-local-engine.fake.token' })
    localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light')
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    return true })()`)
  // a clean slate for the UI: no environment yet (chats / workspace kept), no partial downloads; engine model = the fake one
  await plug('stop')
  await plug('remove')
  await waitState((x) => !x.installed && x.phase === 'idle', 60000, 'removed')
  h.adb('shell', 'run-as', PKG, 'rm', '-rf', 'cache/local-engine/downloads')
  const cfg = JSON.stringify({ providers: [{ providerId: 'emu', baseUrl: 'http://10.0.2.2:18901/v1', apiKey: 'x', modelIds: ['echo'] }], cloud: { defaultModel: 'emu/echo' } })
  h.adb('shell', 'run-as', PKG, 'sh', '-c', `'mkdir -p files/local-engine/home && echo ${Buffer.from(cfg).toString('base64')} | base64 -d > files/local-engine/home/config.json'`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await h.pause(2000)
  await h.waitPage(cdp, "document.readyState === 'complete'", 20000)

  // ① Chat tab (native bottom bar) → new chat: the run-location pill is there even with no computers (this phone is a choice)
  const tab = (await h.waitNodes((l) => l.find((n) => n.text === '对话' || n['content-desc'] === '对话'), { timeout: 20000, out: OUT })).hit
  if (tab) h.tapNode(tab)
  const compose = (await h.waitNodes((l) => l.find((n) => n.text === '新会话' || n['content-desc'] === '新会话'), { timeout: 20000, out: OUT })).hit
  if (compose) h.tapNode(compose)
  const pill = await h.waitPage(cdp, `!!${visible('.runloc-pill')}`, 30000)
  ok('run-location pill shows with zero computers (this phone counts as a choice)', !!pill)
  shot('01-new-chat')
  await tapEl(visible('.runloc-pill'))
  const row = await h.waitPage(cdp, `!!${q('[data-run-row="phone"]')}`, 10000)
  const order = await cdp.eval(`[...document.querySelectorAll('[data-run-on] [data-run-row]')].map((e) => e.getAttribute('data-run-row')).join(',')`)
  ok('sheet lists This phone right under Forsion cloud', !!row && /^home,phone/.test(order || ''), order)
  const rowText = await cdp.eval(`${q('[data-run-row="phone"]')}?.innerText`)
  ok('row says the environment must be downloaded first (with its size)', /这台手机/.test(rowText || '') && /下载运行环境/.test(rowText || '') && /\d+ MB/.test(rowText || ''), JSON.stringify(rowText))
  shot('02-sheet')

  // ② tap → confirm panel with sizes and the no-sandbox note
  await tapEl(q('[data-run-row="phone"]'))
  const confirm = await h.waitPage(cdp, `${q('[data-phone-confirm]')}?.innerText`, 10000)
  ok('confirm: download / disk sizes, model still in the cloud, no command sandbox', /下载约 \d+ MB/.test(confirm || '') && /占用约 \d+ MB/.test(confirm || '') && /云端/.test(confirm || '') && /沙箱/.test(confirm || ''), JSON.stringify(confirm))
  shot('03-confirm')

  // ③ download → progress → pause → resume → unpack → self-test → ready
  const t0 = Date.now()
  await tapEl(q('[data-phone-download]'))
  await waitState((x) => x.phase === 'downloading' && x.done > 8 * 1024 * 1024, 120000, 'download progress')
  await h.pause(600)
  const prog = await cdp.eval(`(() => { const r = ${q('[data-phone-engine]')}; const bar = r && r.querySelector('[role=progressbar]'); return r ? { text: r.innerText, bar: bar && bar.getAttribute('aria-valuenow') } : null })()`)
  ok('downloading: progress text + progress bar on the row', !!prog && /正在下载 \d+ \/ \d+ MB/.test(prog.text) && Number(prog.bar) > 0, JSON.stringify(prog))
  shot('04-downloading')
  await tapEl(visible('.us-phone-act'))
  const paused = await waitState((x) => x.phase === 'paused', 30000, 'paused')
  const pausedText = await h.waitPage(cdp, `(${q('[data-phone-engine]')}?.innerText || '').includes('已暂停') && ${q('[data-phone-engine]')}.innerText`, 5000)
  ok('pause from the row keeps the partial download', paused.resumeBytes > 0 && !!pausedText, `resumeBytes=${paused.resumeBytes}`)
  shot('05-paused')
  const before = fx.served.length
  await tapEl(visible('.us-phone-act'))
  const done = await waitState((x) => (x.installed && x.phase === 'idle') || x.phase === 'failed', 900000, 'installed')
  const resumed = fx.served.slice(before).find((r) => r.range && /^bytes=[1-9]/.test(r.range))
  ok('resume from the row continues with Range', !!resumed, resumed ? resumed.range : '')
  ok('install completes from the UI', done.installed === true && done.phase === 'idle', `${Math.round((Date.now() - t0) / 1000)}s`)
  const readyText = await h.waitPage(cdp, `(${q('[data-run-row="phone"]')}?.innerText || '').includes('已就绪') && ${q('[data-run-row="phone"]')}.innerText`, 10000)
  ok('row shows ready after install', !!readyText, JSON.stringify(readyText))
  shot('06-ready')

  // ④ details panel: usage, versions, actions
  await tapEl(q('.us-phone-more'))
  const details = await h.waitPage(cdp, `${q('[data-phone-details]')}?.innerText`, 10000)
  ok('details: usage, versions, reset and delete', /环境占用 \d+ MB/.test(details || '') && /引擎 /.test(details || '') && /重置环境/.test(details || '') && /删除环境/.test(details || ''), JSON.stringify(details))
  shot('07-details')
  await tapEl(q('.us-phone-more'))

  // ⑤ pick this phone → engine starts (connect waits for health) → pill names it
  await tapEl(q('[data-run-row="phone"]'))
  const running = await waitState((x) => x.engine === 'running' || x.engine === 'failed', 200000, 'engine running')
  ok('picking This phone starts the local engine', running.engine === 'running', running.engineError || '')
  await h.waitPage(cdp, `(${q('[data-run-row="phone"]')}?.innerText || '').includes('当前')`, 15000)
  shot('08-picked')
  await tapEl(q('.us-head .us-icon-btn'))
  const pillName = await h.waitPage(cdp, `(() => { const p = ${visible('.runloc-pill')}; return p && p.innerText.includes('这台手机') && p.innerText })()`, 15000)
  ok('pill now reads This phone', !!pillName, JSON.stringify(pillName))
  await h.waitPage(cdp, `!!${visible('.t2c-ta')}`, 30000)

  // ⑥ send a message, get the reply (model → run_bash under PRoot → model)
  await cdp.eval(`(() => { const ta = ${visible('.t2c-ta')}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'TOOLTEST 在这台手机上跑一下'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await h.pause(500)
  shot('09-typed')
  await tapEl(visible('.t2c-send'))
  const reply = await h.waitPage(cdp, `(() => { const t = document.body.innerText; return /PHONE-OK/.test(t) && /marker-42/.test(t) && t.match(/PHONE-OK[^\\n]{0,160}/)[0] })()`, 180000)
  ok('the reply shows up in the chat, carrying the tool output from PRoot', !!reply, JSON.stringify(reply))
  ok('the fake model was asked twice (tool call → final answer)', fx.modelCalls.length >= 2, `calls=${fx.modelCalls.length}`)
  const cloudRuns = stubLog.filter((l) => /^POST .*\/agent\/(runs|sessions)/.test(l))
  ok('nothing was sent to the cloud engine', cloudRuns.length === 0, cloudRuns.join(' | '))
  const probe = h.adb('shell', 'run-as', PKG, 'cat', 'files/local-engine/workspace/probe.txt').trim()
  ok('the tool wrote into this phone\'s workspace', probe === 'marker-42', probe)
  await h.pause(1500)
  shot('10-reply')

  cdp.close()
  fx.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); try { shot('fail') } catch { /* no device */ } process.exit(1) })
