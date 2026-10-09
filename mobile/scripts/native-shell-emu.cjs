/** Real-app acceptance for the Android native shell surfaces (NativeChrome top bar + NativeSheet sheets).
 *
 * Runs the REAL app shell (not the preview page) on one connected emulator/device with a debug APK
 * (`com.forsion.tangu`, WebView debugging on). Drives Compose through uiautomator (testTags exposed as
 * resource-ids: `nativeChrome.*`, `nativeSheet.*`) and the WebView through one persistent CDP session.
 * Backend: a fake token is seeded through the app's own storage (Capacitor Preferences `forsion_token`), the
 * onboarding flag is set, and every request to the API origin is answered by CDP Fetch interception —
 * `/auth/me`, `/health`, agents ×2, cloud projects ×2, two host-mode sessions (config GET/PATCH, messages, rename)
 * get fixtures, everything else fails like an unreachable backend. Nothing reaches a real server. The previous
 * token / locale / theme are restored at the end.
 * Covers: top bar + insets, tabs / more sheets, prompt + confirm kinds, context menus, and the chat consumers of
 * the sheet-menu seam (session ⋯ → rename, mode menu → approval tier + nested agent page, rewind, add menu →
 * nested search + Files → system picker, project selector), settings as a native page (back / ×), zh light,
 * dark and an English pass. Plugins (feat/android-plugins): ⋯ → market as a native page (detail adds ×), install through
 * the native downloader from a host server (adb reverse; PLUGIN_HOST overrides), plugin commands in the native ⋯ under
 * the plugin's name (toggle state), the plugin view running in the WebView (CSP 'unsafe-eval' + new Function), a cold
 * restart (force-stop + relaunch), uninstall from Settings removing files/plugins/<slug>; plus the native model sheet. Web page taps go through real touches (zoom-aware) — never element.click() for
 * anything that needs user activation.
 * Review fixes (2026-10-02): a menu replaced by another keeps the second one open; a rewind request is withdrawn when
 * its session goes away (pending stat or open sheet); the prompt field clips at 100,000 chars and still answers;
 * oversized packages (declared / endless) are refused by the capped native download with nothing left in cache;
 * reinstalling over an installed plugin leaves no .staging- / .backup- directory; the native back on a plugin's
 * detail page returns to the plugin list. System file picker end to end: three fixture files are pushed to the
 * device's Download/ and Documents/ (removed again at the end); picks arrive in the composer with the right bytes
 * (content URIs streamed through https://localhost/_capacitor_content_/), the > 25 MB one is named in the toast and
 * not attached, cancel changes nothing. Needs an English system language (DocumentsUI labels).
 * Phone polish (2026-10-05): a tapped <select> opens on the native sheet (never the WebView's own dialog); "+" → Photos
 * goes through the system photo picker and "+" → Take photo through the permission question (refused once, then allowed)
 * and the device's camera app (com.android.camera2 on the emulator image) — an image fixture is pushed to Pictures/ and
 * the app's CAMERA grant is reset before the app starts; session rows end with a time; "Failed to fetch" is reworded.
 * System notifications (2026-10-05, three checks, `ONLY='island:,notifications:'`): a stubbed run in flight (events
 * stream + approvals) puts the island up with its answer buttons; what the buttons send is read from the system's own
 * records, Deny is sent the way the system sends it (root shell → needs an emulator image) and Allow is tapped in the
 * real shade, both with the app in the background; in-app notifications are mirrored only while the app is away; a
 * finished run always leaves "finished" (six rounds). The app gets POST_NOTIFICATIONS before it starts, and a shade
 * left open is closed.
 *
 * Build + install (README「Android 原生外壳」): rm -rf dist && npm run build && npx cap sync android &&
 *   ./android/gradlew -p android :app:assembleDebug && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 * Run: OUT=/absolute/dir npm run emu:nativeshell   (Node 22+, one device; ANDROID_SERIAL picks one)
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')
const JSZip = require('jszip')
const h = require('./lib/emu-cdp.cjs')

const PKG = process.env.PKG || 'com.forsion.tangu'
const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../outputs/native-shell'))
const API_PATTERN = process.env.API_PATTERN || '*api.forsion.net*'
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) if (/^fail-\d+\.png$/.test(f)) fs.rmSync(path.join(OUT, f))

const checks = []
const shots = []
let failed = 0
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
async function check(name, fn) {
  if (ONLY.length && !ONLY.some((k) => name.includes(k))) return
  try {
    await fn()
    checks.push({ name, ok: true })
    console.log('PASS', name)
  } catch (e) {
    failed++
    checks.push({ name, ok: false, error: String(e && e.message || e) })
    console.log('FAIL', name, '—', e && e.message || e)
    try { shots.push(h.screenshot(OUT, `fail-${checks.length}`)) } catch { /* no device */ }
    // Leave a clean stage for the next check: dismiss sheets / drawers left open by the failure.
    // (page mode — settings — keeps the bar: its back button means "still inside a page")
    for (let i = 0; i < 4; i++) {
      const l = h.nodes()
      if (h.byId(l, 'nativeChrome.bar') && !h.byId(l, 'nativeChrome.back') && !h.byId(l, 'nativeSheet.sheet')) break
      h.key(4); await h.pause(500)
    }
  }
}
const shot = (name) => { shots.push(h.screenshot(OUT, name)); return name }

// Chat fixtures (ASCII titles: the English pass asserts no CJK in sheets that list them). execMode 'host' so the
// composer shows the approval tiers — real Android cloud sessions are usually sandboxed and have none.
const T0 = Date.now()
const iso = (ago) => new Date(T0 - ago).toISOString()
const session = (id, title, ago) => ({ id, title, summary: null, model_id: null, archived: false, emoji: null, agent_config: { execMode: 'host', approvalMode: 'auto-edit' },
  project_path: null, project_name: null, projectless: true, created_at: iso(ago), updated_at: iso(ago) })
const sessions = [session('e2e-s1', 'E2E Session One', 60000), session('e2e-s2', 'E2E Session Two', 120000)]
const configs = Object.fromEntries(sessions.map((s) => [s.id, { ...s.agent_config }]))
const messages = [
  { id: 'e2e-m1', role: 'user', content: 'Hello fixture', reasoning: null, tool_calls: null, tool_results: null, attachments: null, timestamp: T0 - 50000, model_id: null, is_error: false },
  { id: 'e2e-m2', role: 'model', content: 'Hi! This is the fixture reply.', reasoning: null, tool_calls: null, tool_results: null, attachments: null, timestamp: T0 - 49000, model_id: null, is_error: false },
]
// Model catalog for the composer's model pill (the native model sheet needs something to list).
const MODELS = [
  { id: 'e2e-model-alpha', name: 'E2E Model Alpha', provider: 'E2E', source: 'forsion', modelType: 'llm' },
  { id: 'e2e-model-beta', name: 'E2E Model Beta', provider: 'E2E', source: 'forsion', modelType: 'llm' },
]

// ── Android plugin flow: a fake market (CDP-stubbed API) + a REAL host HTTP server for the package download, so the
// native downloader (Capacitor Filesystem.downloadFile → HttpURLConnection, not the WebView) is what fetches it.
// Reachability: the emulator is normally reached at 10.0.2.2, but an emulator in airplane mode has no route there
// (and the harness never flips device settings) → `adb reverse` exposes the host port as the device's localhost.
// Debug builds allow cleartext to localhost / 10.0.2.2 (src/debug network_security_config). PLUGIN_HOST overrides.
const PLUGIN_ID = 'e2e-native-hello'
const PLUGIN_CMD = `amadeus:${PLUGIN_ID}:open-panel`
// The Space the fixture plugin ships (spaces/desk/space.json — the folder name differs from the recipe id on purpose:
// hosts go by the id). Its recipe has a left panel: on the phone a recipe Space still opens on its main view.
// `iconFile: icon.png` with no picture of its own = the plugin's icon.png, a solid colour the bottom bar must show.
const PLUGIN_SPACE = 'e2e-desk'
const PLUGIN_SPACE_JSON = JSON.stringify({
  id: PLUGIN_SPACE, name: 'E2E Desk', icon: 'boxes', iconFile: 'icon.png', version: '1.0.0',
  layout: { main: [{ type: `plugin:${PLUGIN_ID}:panel` }], left: [{ type: 'workspace' }], right: [] },
})
const PLUGIN_ICON_RGB = [0, 200, 255]
// A second Space of the same plugin with a name no bar can hold. The native side refuses a label over 128 characters —
// and with it the whole bar state: before the page cut labels at the bridge, one such recipe took the native bars down.
const PLUGIN_SPACE_LONG_JSON = JSON.stringify({
  id: 'e2e-long', name: `E2E ${'long '.repeat(40)}name`, icon: 'boxes', version: '1.0.0',
  layout: { main: [{ type: `plugin:${PLUGIN_ID}:panel` }], left: [], right: [] },
})
/** A real PNG, `side`×`side`, one opaque colour (zlib.crc32: Node 22.2+). */
function solidPng(side, [r, g, b]) {
  const zlib = require('node:zlib')
  const row = Buffer.alloc(1 + side * 3)
  for (let i = 0; i < side; i++) row.set([r, g, b], 1 + i * 3)
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(side).fill(row)))), chunk('IEND', Buffer.alloc(0)),
  ])
}
const PLUGIN_TOGGLE = `amadeus:${PLUGIN_ID}:toggle-flag`
const PLUGIN_PORT = Number(process.env.PLUGIN_PORT || 5317)
const PLUGIN_HOST = process.env.PLUGIN_HOST || `http://localhost:${PLUGIN_PORT}`
// The plugin's own code also calls `new Function` at runtime (on top of the host evaluating main.js with it):
// a CSP without 'unsafe-eval' would stop it before the view ever mounts.
const PLUGIN_MAIN = `
let flag = false
ctx.registerView({
  id: 'panel',
  title: 'E2E native plugin panel',
  async mount(el) {
    const d = (await ctx.loadData()) || { runs: 0 }
    const box = document.createElement('div')
    box.setAttribute('data-e2e-plugin-view', '')
    box.setAttribute('data-e2e-runs', String(d.runs))
    box.setAttribute('data-e2e-eval', String(new Function('return 6 * 7')()))
    box.style.cssText = 'padding:24px;font:16px/1.5 system-ui'
    box.textContent = 'E2E native plugin view, runs=' + d.runs
    el.appendChild(box)
    return () => box.remove()
  },
})
ctx.registerCommand({
  id: 'open-panel',
  title: 'E2E plugin: open panel',
  async run() {
    const d = (await ctx.loadData()) || { runs: 0 }
    d.runs += 1
    await ctx.saveData(d)
    ctx.openView('panel')
  },
})
ctx.registerCommand({ id: 'toggle-flag', title: 'E2E plugin: toggle flag', checked: () => flag, run() { flag = !flag } })
`
const marketCards = [{
  id: PLUGIN_ID, type: 'amadeus-plugin', source: 'zip', name: 'E2E Native Hello', summary: 'Harness fixture plugin', author: 'e2e',
  installSlug: PLUGIN_ID, downloads: 10, latestVersion: '1.0.0', tags: ['e2e'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
}]
const pluginHits = [] // { url, ua }
let pluginZip = null
let pluginZipV2 = null // same plugin, version 1.0.1: the reinstall (update switch) check serves it
// Oversized packages for the capped native download (ForsionMarketDownload / CappedDownload.kt, cap 25 MB): one declares
// a Content-Length over the cap, one streams with no length until the client hangs up (hard stop: a broken cap must
// not hang the run). Not listed in the fake market: the check calls window.tangu.marketInstall(id) itself.
const BIG_DECLARED = 'e2e-too-large'
const BIG_ENDLESS = 'e2e-endless'
const BIG_DECLARED_BYTES = 30 * 1024 * 1024
const BIG_ENDLESS_STOP = 512 * 1024 * 1024 // far past what the adb tunnel buffers before the client's hang-up reaches the host
const bigServed = {} // url → { sent, closedEarly }
const pluginServer = http.createServer((req, res) => {
  pluginHits.push({ url: req.url, ua: String(req.headers['user-agent'] || '') })
  if (req.url === `/${PLUGIN_ID}.zip` && pluginZip) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': pluginZip.length })
    return res.end(pluginZip)
  }
  if (req.url === `/${BIG_DECLARED}.zip` || req.url === `/${BIG_ENDLESS}.zip`) {
    const declared = req.url === `/${BIG_DECLARED}.zip`
    const limit = declared ? BIG_DECLARED_BYTES : BIG_ENDLESS_STOP
    res.writeHead(200, { 'Content-Type': 'application/zip', ...(declared ? { 'Content-Length': limit } : {}) })
    const chunk = Buffer.alloc(256 * 1024, 0x50)
    const state = (bigServed[req.url] = { sent: 0, closedEarly: false })
    let open = true
    res.on('close', () => { open = false; state.closedEarly = state.sent < limit })
    const pump = () => {
      while (open && state.sent < limit) {
        state.sent += chunk.length
        if (!res.write(chunk)) return res.once('drain', pump)
      }
      if (open) res.end()
    }
    return pump()
  }
  res.writeHead(404); res.end('no')
})

const stubLog = [] // "METHOD /path body"
// Rewind stat (GET …/checkpoints): answered with an empty list; while `hold.checkpoints` is set the answers are parked
// in `hold.release` instead (the "user leaves while the stat is still loading" check lets them go later).
const hold = { checkpoints: false, release: [] }
// "Waiting for the user" index (GET …/agent/approvals/pending, polled by attentionStore): empty unless a check fills it.
const pending = { rev: 'e2e-0', sessions: [] }
// Cloud speech-to-text (POST …/brain/transcribe): answers a transcript, or the status a check sets.
const transcribe = { status: 200 }
// A run in flight, off unless a check names its session: the session then lists the run as running (GET …/agent/runs
// ?session_id=), its event stream (GET …/agent/runs/<id>/events?fromSeq=N) hands out `events` past N and ends — the
// client asks again 0.8 s later, like after any dropped stream — and answers to its approvals (POST …/approvals/<id>)
// are collected in `answers`.
const live = { sessionId: '', runId: 'e2e-run', assistantId: 'e2e-run-reply', events: [], answers: [] }
function installStub(cdp) {
  cdp.on('Fetch.requestPaused', (ev) => {
    const url = new URL(ev.request.url)
    const p = url.pathname
    const m = ev.request.method
    const body = ev.request.postData || ''
    stubLog.push(`${m} ${p}${body ? ' ' + body : ''}`)
    const json = (data) => cdp.send('Fetch.fulfillRequest', {
      requestId: ev.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(data)).toString('base64'),
    }).catch(() => {})
    if (m === 'OPTIONS') {
      return cdp.send('Fetch.fulfillRequest', {
        requestId: ev.requestId, responseCode: 204,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: '*' }],
      }).catch(() => {})
    }
    if (p.endsWith('/auth/me')) return json({ username: 'e2e', id: 'e2e', avatar: AVATAR })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'e2e' })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: [{ slug: 'e2e-agent', name: 'E2E Agent', description: 'Harness fixture' }, { slug: 'e2e-helper', name: 'E2E Helper', description: 'Second fixture' }] })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: [{ name: 'E2E Alpha' }, { name: 'E2E Beta' }] })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: url.searchParams.get('archived') === 'true' ? [] : sessions })
    const stream = p.match(/\/agent\/runs\/([^/]+)\/events$/)
    if (stream && live.sessionId && decodeURIComponent(stream[1]) === live.runId) {
      stubLog.pop() // asked for every 0.8 s while the run lasts: keep the log readable
      const from = Number(url.searchParams.get('fromSeq') || 0)
      return cdp.send('Fetch.fulfillRequest', {
        requestId: ev.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(live.events.filter((e) => e.seq > from).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')).toString('base64'),
      }).catch(() => {})
    }
    const decided = p.match(/\/agent\/runs\/([^/]+)\/approvals\/([^/]+)$/)
    if (decided && m === 'POST') {
      live.answers.push({ runId: decodeURIComponent(decided[1]), approvalId: decodeURIComponent(decided[2]), ...JSON.parse(body || '{}') })
      return json({ ok: true })
    }
    if (p.endsWith('/agent/runs')) {
      const running = live.sessionId && url.searchParams.get('session_id') === live.sessionId && !live.events.some((e) => e.type === 'done')
      return json({ runs: running ? [{ id: live.runId, status: 'running', assistant_message_id: live.assistantId }] : [] })
    }
    if (p.endsWith('/brain/transcribe') && m === 'POST') {
      if (transcribe.status === 200) return json({ text: ' e2e transcript ' })
      return cdp.send('Fetch.fulfillRequest', {
        requestId: ev.requestId, responseCode: transcribe.status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(JSON.stringify({ detail: '服务端的中文原话' })).toString('base64'),
      }).catch(() => {})
    }
    if (p.endsWith('/agent/approvals/pending')) return json(url.searchParams.get('rev') === pending.rev ? { rev: pending.rev, unchanged: true } : pending)
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: MODELS, directProviders: [], defaultModelId: MODELS[0].id })
    // fake market (only Forsion plugins are requested on the phone); install hands out the host download URL
    const mk = p.match(/\/market\/items(?:\/([^/]+))?(\/install)?$/)
    if (mk) {
      const type = url.searchParams.get('type')
      if (!mk[1]) return json({ items: marketCards.filter((c) => !type || c.type === type) })
      const card = marketCards.find((c) => c.id === decodeURIComponent(mk[1]))
      if (card && mk[2]) return json({ type: card.type, installSlug: card.installSlug, source: 'zip', downloadUrl: `${PLUGIN_HOST}/${card.id}.zip` })
      if (card) return json({ ...card, readme: `# ${card.name}\n\nA harness fixture: one view, two commands.` })
      const big = mk[1] && [BIG_DECLARED, BIG_ENDLESS].find((id) => id === decodeURIComponent(mk[1]))
      if (big && mk[2]) return json({ type: 'amadeus-plugin', installSlug: big, source: 'zip', downloadUrl: `${PLUGIN_HOST}/${big}.zip` })
    }
    if (/\/agent\/sessions\/[^/]+\/checkpoints$/.test(p) && m === 'GET') {
      const answer = () => json({ checkpoints: [] })
      if (hold.checkpoints) { hold.release.push(answer); return }
      return answer()
    }
    const cfg = p.match(/\/agent\/sessions\/([^/]+)\/config$/)
    if (cfg) {
      const id = decodeURIComponent(cfg[1])
      if (m === 'PATCH' || m === 'PUT') configs[id] = { ...(m === 'PUT' ? {} : configs[id]), ...JSON.parse(body || '{}') }
      return json({ agent_config: configs[id] || {} })
    }
    if (/\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: p.includes('/e2e-s1/') ? messages : [] })
    const one = p.match(/\/agent\/sessions\/([^/]+)$/)
    if (one && m === 'PATCH') {
      const s = sessions.find((x) => x.id === decodeURIComponent(one[1]))
      if (s) Object.assign(s, JSON.parse(body || '{}'), { updated_at: new Date().toISOString() })
      return json({ session: s })
    }
    return cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionRefused' }).catch(() => {})
  })
  return cdp.send('Fetch.enable', { patterns: [{ urlPattern: API_PATTERN, requestStage: 'Request' }] })
}
async function waitLog(since, pred, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const hit = stubLog.slice(since).find(pred)
    if (hit) return hit
    await h.pause(200)
  }
  return null
}

const dom = {
  shellUp: "!!document.querySelector('.shell-host .mb-shell')",
  view: "document.querySelector('.mb-main > .mb-view')?.dataset.view || ''",
  mode: 'document.documentElement.dataset.mode',
}
const ui = () => h.nodes(OUT)
// The activity class keeps its name under any applicationId (`-PnativePreview` installs com.forsion.tangu.nativepreview):
// PKG=com.forsion.tangu.nativepreview runs the same harness against the side-by-side preview package.
const ACTIVITY = `${PKG}/com.forsion.tangu.MainActivity`
const resumed = () => h.adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some((l) => l.includes('topResumedActivity=') && l.includes(` ${PKG}/`))
const webViewNode = (list) => list.find((n) => n.class === 'android.webkit.WebView')
const sheetOpen = (list) => !!h.byId(list, 'nativeSheet.sheet')
/** Poll uiautomator until the native sheet is (not) there. One dump normally takes ~1 s, but uiautomator first waits
 *  for the UI to go idle and a busy WebView can hold a single dump for several seconds: the window is generous, and a
 *  timeout reports how many dumps fit in it (1–2 dumps = the dumps were slow, not the sheet). */
async function waitSheet(open = true, timeout = 12000) {
  const start = Date.now()
  const took = []
  let list = []
  let hit = false
  while (!hit && Date.now() - start < timeout) {
    const t = Date.now()
    list = h.nodes(OUT)
    took.push(Date.now() - t)
    hit = sheetOpen(list) === open
    if (!hit) await h.pause(250)
  }
  assert.ok(hit, `native sheet did not ${open ? 'open' : 'close'} (${took.length} uiautomator dumps in ${Date.now() - start} ms: ${took.join(', ')} ms)`)
  if (Date.now() - start > 6000) console.log(`  (slow sheet wait: ${Date.now() - start} ms over ${took.length} dumps: ${took.join(', ')} ms)`)
  await h.pause(open ? 450 : 200) // let the slide-in settle before screenshots / taps
  return open ? ui() : list
}
async function tapId(id, list) {
  const n = h.byId(list || ui(), id)
  assert.ok(n, `node missing: ${id}`)
  h.tapNode(n)
}
/** The fixture account's picture: 8×8 solid magenta. The native top bar must show it (see pixelAt), not the initial. */
const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z/AfK2IYWhIA0ad/gQofP30AAAAASUVORK5CYII='
/** One screen pixel (raw screencap: width, height, format[, colour space] header, then RGBA rows). */
function pixelAt(x, y) {
  const raw = h.adbBuffer('exec-out', 'screencap')
  const w = raw.readUInt32LE(0)
  const o = raw.length - w * raw.readUInt32LE(4) * 4 + (y * w + x) * 4
  return { r: raw[o], g: raw[o + 1], b: raw[o + 2] }
}
/** Vibrations the system recorded for the app ("Recent vibrations" of `dumpsys vibrator_manager`), one line each; null on
 *  a device that keeps no such list. Each carries the View haptic constant that asked for it: 4 = CLOCK_TICK, 0 = LONG_PRESS. */
function hapticLog() {
  const dump = h.adb('shell', 'dumpsys', 'vibrator_manager')
  const at = dump.indexOf('Recent vibrations:')
  if (at < 0) return null
  const end = dump.indexOf('Aggregated vibration history', at)
  return dump.slice(at, end < 0 ? undefined : end).split('\n').filter((l) => l.includes(PKG) && l.includes('performHapticFeedback(constant='))
}
/** The constants of the vibrations recorded since `before` (a hapticLog()); null where there is no list. A record is
 *  told apart by its creation + start times (its status and end are filled in later). */
function hapticsSince(before) {
  const now = hapticLog()
  if (!before || !now) return null
  const key = (l) => `${l.trim().slice(0, 18)}|${(l.match(/start: (\S+)/) || [])[1]}`
  const old = new Set(before.map(key))
  return now.filter((l) => !old.has(key(l))).map((l) => Number(l.match(/constant=(\d+)/)[1]))
}
const within = (outer, n) => n !== outer && n.rect.left >= outer.rect.left && n.rect.right <= outer.rect.right && n.rect.top >= outer.rect.top && n.rect.bottom <= outer.rect.bottom
/** Merged Compose buttons may expose label / count on child nodes: read the node or anything inside its bounds. */
const descOf = (list, id) => {
  const n = h.byId(list, id)
  return n ? (n['content-desc'] || list.find((c) => within(n, c) && c['content-desc'])?.['content-desc'] || '') : ''
}
const ids = (list, prefix = 'nativeSheet.item.') => h.byIdPrefix(list, prefix).map((n) => n['resource-id'].slice(prefix.length))
const hasCjk = (list) => list.some((n) => /[一-鿿]/.test(`${n.text || ''}${n['content-desc'] || ''}`))
const textOf = (list, id) => h.byId(list, id)?.text || ''
/** Visible label of a sheet row (merged Compose rows keep their text on child nodes). */
const rowLabel = (list, id) => { const n = h.byId(list, id); return n ? (n.text || list.filter((c) => within(n, c) && c.text).map((c) => c.text).join(' ')) : '' }
/** Clear a prefilled native text field and type ASCII (adb `input text` cannot type spaces: use %s). */
function retype(text) {
  h.adb('shell', 'input', 'keyevent', ...Array(40).fill('67'))
  h.adb('shell', 'input', 'text', text.replace(/ /g, '%s'))
}
const tabCountText = (list) => {
  const n = h.byId(list, 'nativeChrome.tabs')
  return n ? (n.text || list.find((c) => c !== n && c.text && /^\d+$/.test(c.text) && c.rect.left >= n.rect.left && c.rect.right <= n.rect.right && c.rect.top >= n.rect.top && c.rect.bottom <= n.rect.bottom)?.text || '') : ''
}

;(async () => {
  assert.ok(h.adb('shell', 'pm', 'path', PKG).includes('package:'), `${PKG} is not installed`)
  h.adb('shell', 'am', 'force-stop', PKG)
  try { h.adb('shell', 'cmd', 'statusbar', 'collapse') } catch { /* no shade service */ } // a shade left open covers the app: uiautomator would read the shade
  // The camera check walks the system's permission question (refuse once, then allow). It is only asked while the app
  // neither holds the permission nor was refused for good, so the app's own grant is reset here — before the app starts:
  // revoking a held permission ends the process.
  for (const args of [['revoke', PKG, 'android.permission.CAMERA'], ['clear-permission-flags', PKG, 'android.permission.CAMERA', 'user-set', 'user-fixed']]) {
    try { h.adb('shell', 'pm', ...args) } catch { /* not held / a shell without the command */ }
  }
  // The island asks for the notification permission on its first run. The notification checks read what the system
  // holds, so the app has it from the start (its own runtime permission, like the camera above).
  try { h.adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS') } catch { /* before Android 13: not a runtime permission */ }
  h.adb('shell', 'am', 'start', '-n', ACTIVITY)
  let cdp = await h.connect(PKG)
  await cdp.send('Page.enable')
  // Remember what we overwrite; restored at the end.
  const saved = await cdp.eval(`(async () => ({
    token: (await Capacitor.Plugins.Preferences.get({ key: 'forsion_token' })).value,
    locale: localStorage.getItem('tangu_locale'), pref: localStorage.getItem('forsion_theme_pref'), legacy: localStorage.getItem('forsion_theme'),
    onboarding: localStorage.getItem('forsion_tangu_onboarding_done'),
  }))()`)
  const seed = (locale) => cdp.eval(`(async () => {
    await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: 'e2e-native-shell.fake.token' })
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('tangu_locale', '${locale}')
    localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light')
    return true
  })()`)
  await seed('zh')
  await installStub(cdp)
  // plugin flow: package zip (wrapped in a folder like a GitHub archive), host server, device → host port
  const runAs = (...args) => { try { return h.adb('shell', 'run-as', PKG, ...args) } catch (e) { return `${e.stdout || ''}${e.stderr || ''}` || String(e.message) } }
  const cleanPluginFiles = () => runAs('rm', '-rf', `files/plugins/${PLUGIN_ID}`, `files/plugins-data/${PLUGIN_ID}.json`, `files/plugins-data/${PLUGIN_ID}.json.alt`)
  {
    const z = new JSZip()
    z.file(`${PLUGIN_ID}-main/manifest.json`, JSON.stringify({ id: PLUGIN_ID, name: 'E2E Native Hello', version: '1.0.0', apiVersion: 1 }))
    z.file(`${PLUGIN_ID}-main/main.js`, PLUGIN_MAIN)
    z.file(`${PLUGIN_ID}-main/icon.png`, solidPng(64, PLUGIN_ICON_RGB))
    z.file(`${PLUGIN_ID}-main/spaces/desk/space.json`, PLUGIN_SPACE_JSON)
    z.file(`${PLUGIN_ID}-main/spaces/long/space.json`, PLUGIN_SPACE_LONG_JSON)
    pluginZip = Buffer.from(await z.generateAsync({ type: 'uint8array' }))
    z.file(`${PLUGIN_ID}-main/manifest.json`, JSON.stringify({ id: PLUGIN_ID, name: 'E2E Native Hello', version: '1.0.1', apiVersion: 1 }))
    pluginZipV2 = Buffer.from(await z.generateAsync({ type: 'uint8array' }))
  }
  // system file picker fixtures: generated here, pushed to shared storage, removed again at the end
  const crypto = require('node:crypto')
  const PICK = {
    small: { name: 'e2e-pick-small.txt', dir: 'Download', data: Buffer.from('Forsion native picker fixture: small\n') },
    mid: { name: 'e2e-pick-1m.bin', dir: 'Documents', data: crypto.randomBytes(1024 * 1024) },
    big: { name: 'e2e-pick-big.bin', dir: 'Download', data: crypto.randomBytes(26 * 1024 * 1024) }, // past the 25 MB per-file cap
    photo: { name: 'e2e-pick-photo.png', dir: 'Pictures', data: Buffer.from(AVATAR.split(',')[1], 'base64') }, // the photo picker lists indexed images only
  }
  /** MediaStore learns about a pushed / removed file from this broadcast (deprecated for apps, still honoured from the shell). */
  const mediaScan = (f) => { try { h.adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file:///sdcard/${f.dir}/${f.name}`) } catch { /* best effort */ } }
  const pickTmp = path.join(OUT, 'pick-fixtures')
  const pushPickFixtures = () => {
    fs.mkdirSync(pickTmp, { recursive: true })
    for (const f of Object.values(PICK)) {
      fs.writeFileSync(path.join(pickTmp, f.name), f.data)
      f.sha256 = crypto.createHash('sha256').update(f.data).digest('hex')
      h.adb('push', path.join(pickTmp, f.name), `/sdcard/${f.dir}/${f.name}`)
    }
    fs.rmSync(pickTmp, { recursive: true, force: true })
    mediaScan(PICK.photo)
  }
  const removePickFixtures = () => {
    for (const f of Object.values(PICK)) { try { h.adb('shell', 'rm', '-f', `/sdcard/${f.dir}/${f.name}`) } catch { /* not there */ } }
    mediaScan(PICK.photo) // drops its MediaStore row
  }
  await new Promise((resolve, reject) => { pluginServer.once('error', reject); pluginServer.listen(PLUGIN_PORT, '127.0.0.1', resolve) })
  if (!process.env.PLUGIN_HOST) h.adb('reverse', `tcp:${PLUGIN_PORT}`, `tcp:${PLUGIN_PORT}`)
  cleanPluginFiles() // leftovers of an aborted earlier run
  const reload = async () => {
    await cdp.send('Page.reload', { ignoreCache: true })
    await h.pause(800)
    assert.ok(await h.waitPage(cdp, dom.shellUp, 20000), 'shell did not mount after reload')
    h.adb('shell', 'am', 'start', '-n', ACTIVITY) // back to front if anything else took it
    const r = await h.waitNodes((l) => h.byId(l, 'nativeChrome.bar'), { timeout: 10000 })
    assert.ok(r.hit, 'native bar did not appear')
    await h.pause(600)
  }
  await reload()

  // ── WebView helpers. Mobile CSS zooms (body 1.15, drawer body 1.15): rects × cumulative zoom × dpr = device px.
  /** Tap a page element like a finger would (real touch → real user activation), once it stops moving. */
  async function tapEl(expr) { const p = await elPoint(expr); h.tapAt(p.x, p.y) }
  /** Device-pixel centre of a page element, once it stops moving. */
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
    assert.ok(r, `element missing: ${expr}`)
    const wv = webViewNode(ui())
    return { x: Math.round(wv.rect.left + r.x * r.dpr), y: Math.round(wv.rect.top + r.y * r.dpr) }
  }
  const drawerOpen = "!!document.querySelector('.mb-drawer--left.open')"
  // Two-level navigation (a Space with a left list): `.mb-shell[data-nav]` is 'list' (the Space's first level, the left
  // panel full-screen, bottom bar shown) or 'detail' (its main view, no bottom bar, the left button goes back).
  // Without the attribute the Space has no list level: its main view is the first level and a left panel is a drawer.
  const nav = "document.querySelector('.mb-shell')?.dataset.nav || ''"
  /** Show the left panel: a two-level Space's list (from its detail page: the back arrow) or a drawer Space's drawer.
   *  A Space without a left panel (Home) has neither: use Tangu's list. */
  async function openDrawer() {
    if (await cdp.eval(drawerOpen)) return
    if (!h.byId(ui(), 'nativeChrome.left')) { await toSpace('tangu'); return }
    await tapId('nativeChrome.left')
    assert.ok(await h.waitPage(cdp, drawerOpen, 5000), 'drawer did not open')
    await h.pause(500)
  }
  /** Leave the left panel. On a two-level Space that means entering its main page — through the tabs sheet when there
   *  is one (two or more tabs), which needs no particular list item; on a drawer Space system back closes the drawer. */
  async function closeDrawer() {
    if (!(await cdp.eval(drawerOpen))) return
    if ((await cdp.eval(nav)) === 'list') {
      if (h.byId(ui(), 'nativeChrome.tabs')) {
        await tapId('nativeChrome.tabs')
        const cur = h.byIdPrefix(await waitSheet(true), 'nativeSheet.item.tab:').find((n) => n.checked === 'true')
        assert.ok(cur, 'no active tab row to enter the main page with')
        h.tapNode(cur)
        await waitSheet(false)
      } else {
        // One tab = no count button. In the way a user gets there: the row of what is open, else "new chat".
        const row = `(document.querySelector('.mb-drawer--left .t2s-srow.active') || document.querySelector('.mb-drawer--left [data-act="new-chat"]'))`
        assert.ok(await cdp.eval(`!!${row}`), 'one tab, no open row and no "new chat": nothing leads into the main page')
        await tapEl(row)
      }
    } else h.key(4)
    assert.ok(await h.waitPage(cdp, `!(${drawerOpen})`, 5000), 'drawer stayed open')
    await h.pause(500)
  }
  /** No row at the foot of the left panel under the native bottom bar. The account is the avatar at the end of the top
   *  bar (first-level pages only) and its menu carries settings and the Unit switcher (2026-10-05, like WeChat's
   *  "Me → Settings"; they led the ⋯ sheet for one day). From a detail page go back to the Space's list first. */
  async function accountItem(id) {
    if (!h.byId(ui(), 'nativeChrome.account')) await openDrawer()
    await tapId('nativeChrome.account')
    await tapId(`nativeSheet.item.${id}`, await waitSheet(true))
    await waitSheet(false)
  }
  /** Tap a Space of the native bottom bar. With more than five the bar scrolls: bring the item in first. */
  async function tapSpace(id) {
    // The bar is away while a keyboard or an overlay is up and returns a moment after it leaves: wait, do not judge the first dump.
    const up = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.spaces') ? l : null), { timeout: 8000 })
    assert.ok(up.hit, 'no native space bar')
    for (const dir of [0, 1, -1]) {
      let list = dir ? ui() : up.hit
      const bar = h.byId(list, 'nativeChrome.spaces')
      assert.ok(bar, 'no native space bar')
      if (dir) {
        // the first cell (Home) is pinned once the bar scrolls: swipe over the part that does scroll
        const [near, far] = [Math.round(bar.rect.left + (bar.rect.right - bar.rect.left) * 0.3), bar.rect.right - 80]
        const [from, to] = dir > 0 ? [near, far] : [far, near]
        h.adb('shell', 'input', 'swipe', String(from), String(bar.rect.cy), String(to), String(bar.rect.cy), '250')
        await h.pause(700)
        list = ui()
      }
      const n = h.byId(list, `nativeChrome.space.${id}`)
      if (!n) continue
      // More than five: the first cell is pinned and the others slide under it. A cell's reported bounds reach up to
      // 24dp under the pinned one (Compose relaxes a scroll container's clip by half a touch target for touch bounds):
      // only the part to the right of the pinned cell is on screen, and that is where a finger goes.
      const cells = h.byIdPrefix(list, 'nativeChrome.space.')
      const first = cells[0] && cells[0]['resource-id'] === n['resource-id']
      const from = cells.length > 5 && !first ? Math.max(n.rect.left, Math.ceil(bar.rect.left + (bar.rect.right - bar.rect.left) / 5.5)) : n.rect.left
      if (n.rect.right - from > 40) { h.tapAt(Math.round((from + n.rect.right) / 2), n.rect.cy); return }
    }
    assert.fail(`Space "${id}" is not in the native bar`)
  }
  /** Switch Space. Ends on its first level: the list of a two-level Space (left panel open), else its main view. */
  async function toSpace(id) {
    // The bottom bar exists on a Space's first level only: from a detail page go back to the list first.
    if ((await cdp.eval(nav)) === 'detail') await openDrawer()
    // The shell mirrors the active Space on `.mb-shell[data-space]`.
    const active = `document.querySelector('.mb-shell')?.dataset.space === ${JSON.stringify(id)}`
    if (!(await cdp.eval(active))) {
      await tapSpace(id)
      assert.ok(await h.waitPage(cdp, active, 6000), `Space "${id}" did not become active`)
      await h.pause(1200)
    }
    assert.notEqual(await cdp.eval(nav), 'detail', `Space "${id}" did not land on its first level`)
  }
  /** Tangu Space with its drawer open and the fixture session rows listed. */
  async function tanguDrawer() {
    await toSpace('tangu')
    // a group collapsed by the user (or an earlier run) stays collapsed: expand the projectless group
    await cdp.eval(`(() => { if (document.querySelector('.mb-drawer--left .t2s-srow')) return true; try { localStorage.removeItem('forsion_tangu_collapsed_projects') } catch {}
      const g = [...document.querySelectorAll('.mb-drawer--left .t2s-group')].find((e) => e.textContent.includes('无项目') || /project/i.test(e.textContent)); g?.querySelector('button')?.click(); return true })()`)
    assert.ok(await h.waitPage(cdp, `!!${rowExpr('E2E Session One')}`, 10000), `fixture sessions not listed (stub: ${stubLog.slice(-8).join(' | ')})`)
    await h.pause(500)
  }
  const rowExpr = (title) => `[...document.querySelectorAll('.mb-drawer--left .t2s-srow')].find((e) => e.textContent.includes(${JSON.stringify(title)}))`
  async function openChat(title) {
    await tanguDrawer()
    await tapEl(rowExpr(title))
    assert.ok(await h.waitPage(cdp, `!(${drawerOpen}) && !!document.querySelector('.mode-pill-btn')`, 8000), `chat "${title}" did not open`)
    await h.pause(800)
  }
  const homeShown = "!!document.querySelector('.hp-root .hp-spaces')"
  async function goHome() {
    if (await cdp.eval(homeShown)) return
    await toSpace('home')
    await closeDrawer()
    assert.ok(await h.waitPage(cdp, homeShown, 6000), 'homepage did not come back')
  }
  /** Homepage "new folder": the button lives in the All-Spaces layer, opened the way a long-press on the blank page does. */
  const newFolderPrompt = () => cdp.eval(`(async () => {
    if (!document.querySelector('.hp-organizer-new')) document.querySelector('.hp-root').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && !document.querySelector('.hp-organizer-new'); i++) await new Promise((r) => setTimeout(r, 100))
    const b = document.querySelector('.hp-organizer-new'); if (!b) throw new Error('new folder button'); b.click(); return true })()`)

  let statusBar = 0
  let detailBottom = 0
  const density = Number(h.adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]) / 160
  const barPx = Math.round(58 * density) // the capsules' room below the status bar (NATIVE_CHROME_HEIGHT)
  const dockPx = Math.round(68 * density) // the dock's room above the navigation inset (NATIVE_SPACE_BAR_HEIGHT)
  const screen = (() => { const m = h.adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/); return { w: Number(m[1]), h: Number(m[2]) } })()
  /** A page element's box in device pixels (see elPoint for the zoom arithmetic); null when it is not there. */
  const elRect = async (expr) => {
    const r = await cdp.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect()
      let z = 1; for (let e = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1
      return { left: r.left * z, top: r.top * z, right: r.right * z, bottom: r.bottom * z, dpr: devicePixelRatio } })()`)
    if (!r) return null
    const wv = webViewNode(ui())
    const px = (v, o) => Math.round(o + v * r.dpr)
    return { left: px(r.left, wv.rect.left), top: px(r.top, wv.rect.top), right: px(r.right, wv.rect.left), bottom: px(r.bottom, wv.rect.top) }
  }
  /** What the page was told about the floating chrome (dp) and what it made of it: the room it keeps clear (device px,
   *  measured on a probe) and the plates it draws behind the capsules (device px). */
  const chromeOnPage = async () => {
    const page = await cdp.eval(`(() => { const cs = getComputedStyle(document.body), shell = document.querySelector('.mb-shell')
      const num = (k) => Number(cs.getPropertyValue(k)) || 0
      const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:var(--mb-top);padding-bottom:var(--mb-bottom);box-sizing:content-box'
      shell.appendChild(probe); const z = parseFloat(getComputedStyle(document.body).zoom) || 1
      const top = parseFloat(getComputedStyle(probe).height) * z, bottom = parseFloat(getComputedStyle(probe).paddingBottom) * z; probe.remove()
      const scrim = getComputedStyle(shell, '::before')
      return { nc: { top: num('--nc-top'), bottom: num('--nc-bottom'), status: num('--nc-status') }, clear: { top, bottom }, dpr: devicePixelRatio,
        scrim: scrim.display === 'none' ? 0 : parseFloat(scrim.height) * z,
        plates: [...document.querySelectorAll('#nc-plates .nc-plate')].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
          return { id: e.dataset.plate, left: r.left * z, top: r.top * z, right: r.right * z, bottom: r.bottom * z, blur: cs.backdropFilter || cs.webkitBackdropFilter || '' } }) } })()`)
    const wv = webViewNode(ui())
    const px = (v, o) => Math.round(o + v * page.dpr)
    return { ...page, clearPx: { top: Math.round(page.clear.top * page.dpr), bottom: Math.round(page.clear.bottom * page.dpr) }, scrimPx: Math.round(page.scrim * page.dpr),
      plates: page.plates.map((p) => ({ id: p.id, blur: p.blur, rect: { left: px(p.left, wv.rect.left), top: px(p.top, wv.rect.top), right: px(p.right, wv.rect.left), bottom: px(p.bottom, wv.rect.top) } })) }
  }
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol
  const sameRect = (a, b, tol = 2) => near(a.left, b.left, tol) && near(a.top, b.top, tol) && near(a.right, b.right, tol) && near(a.bottom, b.bottom, tol)
  const fmt = (r) => `[${r.left},${r.top}][${r.right},${r.bottom}]`

  await check('native top bar replaces the web .mb-topbar (zh, light)', async () => {
    const list = ui()
    for (const id of ['nativeChrome.bar', 'nativeChrome.more', 'nativeChrome.title']) assert.ok(h.byId(list, id), `missing ${id}`)
    // the count button is there with two or more tabs only (the tabs check below walks both states)
    if (h.byId(list, 'nativeChrome.tabs')) assert.ok(Number(tabCountText(list)) > 1, `a count button showing ${tabCountText(list)}`)
    const web = await cdp.eval(`({ topbar: !!document.querySelector('.mb-topbar'), native: document.querySelector('.mb-shell').hasAttribute('data-native-chrome'), lang: document.documentElement.lang })`)
    assert.deepEqual(web, { topbar: false, native: true, lang: 'zh-CN' })
    shot('01-shell-light-zh')
  })

  // Units sheet = an overlay that still claims `hidden` (it draws its own header). Settings no longer does.
  await check('hidden overlay (units sheet) hides the bar; WebView then starts at the status bar (measured)', async () => {
    await accountItem('rb-units-mobile')
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('[data-units-sheet]')", 5000), 'units sheet did not open')
    const r = await h.waitNodes((l) => (!h.byId(l, 'nativeChrome.bar') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, 'bar still visible over the units sheet')
    await h.pause(500)
    const wv = webViewNode(ui())
    statusBar = wv.rect.top
    assert.ok(statusBar > 0, 'WebView must not extend under the status bar')
    shot('02-units-hidden-bar')
    h.key(4) // system back closes the sheet (forsion:mobile-back)
    const back = await h.waitNodes((l) => h.byId(l, 'nativeChrome.bar'), { timeout: 6000 })
    assert.ok(back.hit, 'bar did not return after closing the units sheet')
    await closeDrawer()
  })

  const settingsOpen = "!!document.querySelector('.settings-page--mobile')"
  const settingsWeb = `(() => { const p = document.querySelector('.settings-page--mobile'); if (!p) return null
    const d = (s) => { const e = p.querySelector(s); return e ? getComputedStyle(e).display : 'absent' }
    return { native: p.hasAttribute('data-native-chrome'), home: d('.settings-mobile-home-head'), detail: d('.settings-mobile-detail-head') } })()`
  /** Settings as a native page: home = title + back (back to app); a category = its label + back (to settings)
   *  + × (back to app). The web headers are hidden only while the native bar is in charge. */
  async function settingsPageMode(lang, tag) {
    const L = lang === 'en'
      ? { title: 'Settings', toApp: 'Back to app' }
      : { title: '设置', toApp: '返回应用' }
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    let r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.back') && textOf(l, 'nativeChrome.title') === L.title ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `settings home: no page bar titled ${L.title} (title=${textOf(r.nodes, 'nativeChrome.title')})`)
    assert.equal(descOf(r.nodes, 'nativeChrome.back'), L.toApp)
    assert.ok(!h.byId(r.nodes, 'nativeChrome.close') && !h.byId(r.nodes, 'nativeChrome.more'), 'home page must show back only')
    assert.deepEqual(await cdp.eval(settingsWeb), { native: true, home: 'none', detail: 'none' }) // both heads mounted, neither shown
    await h.pause(400)
    if (tag) shot(`${tag}-settings-home`)
    // into the first plain category
    const cat = `document.querySelector('.settings-mobile-row:not([aria-expanded])')`
    const label = await cdp.eval(`${cat}?.querySelector('strong')?.textContent.trim()`)
    assert.ok(label, 'no settings category')
    await tapEl(cat)
    r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === label && h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `category page: title ${label} + close expected (title=${textOf(r.nodes, 'nativeChrome.title')})`)
    assert.equal(descOf(r.nodes, 'nativeChrome.back'), L.title)
    assert.equal(descOf(r.nodes, 'nativeChrome.close'), L.toApp)
    assert.deepEqual(await cdp.eval(settingsWeb), { native: true, home: 'none', detail: 'none' })
    await h.pause(400)
    if (tag) shot(`${tag}-settings-detail`)
    if (lang === 'en') assert.ok(!hasCjk(r.nodes.filter((n) => (n['resource-id'] || '').startsWith('nativeChrome.'))), 'Chinese in the English bar')
    return { label }
  }
  await check('settings: native page mode — title/back, category adds ×, back + × + system back route right', async () => {
    const { label } = await settingsPageMode('zh', '02b')
    // back → settings home (still open)
    await tapId('nativeChrome.back')
    let r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === '设置' && !h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 5000 })
    assert.ok(r.hit, 'back did not return to the settings home')
    assert.ok(await cdp.eval(settingsOpen), 'back closed settings instead of returning home')
    // into the category again, × closes settings entirely
    await tapEl(`document.querySelector('.settings-mobile-row:not([aria-expanded])')`)
    r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === label ? l : null), { timeout: 5000 })
    assert.ok(r.hit, 'category did not reopen')
    await tapId('nativeChrome.close', r.nodes)
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), '× did not close settings')
    r = await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })
    assert.ok(r.hit, 'shell bar did not return after ×')
    // system back from the settings home closes it (useAndroidBack) and stays in the app
    await settingsPageMode('zh', null)
    await tapId('nativeChrome.back') // detail → home
    await h.waitNodes((l) => (!h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 4000 })
    h.key(4)
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), 'system back did not close settings')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })).hit, 'shell bar did not return')
    assert.ok(resumed(), 'back left the app')
    await closeDrawer()
  })

  // 2026-10-09 (the user picked variant B of the mock-up): on the shell's own pages the WebView reaches the screen's top
  // edge and the chrome floats over it as two capsules; a first-level page also runs under the dock, down to the
  // screen's bottom edge. The page keeps clear of them and draws a frosted plate exactly behind each capsule.
  await check('floating chrome (detail page): the WebView starts at the screen top; two capsules over it; the page keeps their room clear and the status bar covered', async () => {
    await openChat('E2E Session One') // a main view under a list Space: back arrow on the left, no dock
    const list = ui()
    const bar = h.byId(list, 'nativeChrome.bar')
    const wv = webViewNode(list)
    assert.equal(bar.rect.top, 0)
    assert.ok(near(bar.rect.bottom, statusBar + barPx, 1), `chrome strip bottom ${bar.rect.bottom} vs ${statusBar}+${barPx}`)
    assert.equal(wv.rect.top, 0, 'the WebView does not start at the screen top')
    assert.ok(statusBar > 0, 'status bar height unknown: run the "hidden overlay" check first (it measures it)')
    detailBottom = wv.rect.bottom // compared with the navigation inset in the first-level check
    assert.ok(!h.byId(list, 'nativeChrome.spaces'), 'the dock is up on a detail page')
    const [capL, capR, left] = ['nativeChrome.capLeft', 'nativeChrome.capRight', 'nativeChrome.left'].map((id) => h.byId(list, id))
    assert.ok(capL && capR && left, 'capsules / back button missing')
    assert.ok(capL.rect.top >= statusBar && capR.rect.top >= statusBar, 'a capsule under the status bar')
    assert.ok(capL.rect.right < capR.rect.left, `the capsules touch (${fmt(capL.rect)} / ${fmt(capR.rect)})`)
    assert.ok(left.rect.bottom - left.rect.top >= 40 * density - 1 && left.rect.right - left.rect.left >= 40 * density - 1, 'touch target < 40dp')
    const page = await chromeOnPage()
    assert.ok(near(page.nc.status * density, statusBar, 1) && near(page.nc.top * density, statusBar + barPx, 1), `the page was told ${JSON.stringify(page.nc)} (status bar ${statusBar}px, capsules ${barPx}px)`)
    assert.equal(page.nc.bottom, 0, 'no dock: nothing to keep clear at the bottom')
    assert.ok(near(page.clearPx.top, statusBar + barPx, 2), `--mb-top = ${page.clearPx.top}px, the capsules end at ${statusBar + barPx}px (zoom arithmetic)`)
    assert.ok(page.scrimPx >= statusBar, `the status bar is not covered (scrim ${page.scrimPx}px of ${statusBar}px)`)
    // one plate per capsule, exactly behind it, and it blurs
    assert.deepEqual(page.plates.map((p) => p.id).sort(), ['capLeft', 'capRight'])
    for (const [id, node] of [['capLeft', capL], ['capRight', capR]]) {
      const plate = page.plates.find((p) => p.id === id)
      assert.ok(sameRect(plate.rect, node.rect), `${id}: plate ${fmt(plate.rect)} vs capsule ${fmt(node.rect)}`)
      assert.match(plate.blur, /blur\(/, `${id}: the plate does not blur (${plate.blur})`)
    }
    // the stream starts below the capsules (its own padding), and its scroller reaches the screen top (content passes under)
    const stream = await elRect("document.querySelector('.mb-main .t2-stream')")
    const first = await elRect("document.querySelector('.mb-main .t2-stream > *')")
    assert.ok(stream && stream.top <= 1, `the stream does not reach the top (${stream && fmt(stream)})`)
    assert.ok(first && first.top >= capL.rect.bottom - 2, `the first message starts under a capsule (${first && first.top} < ${capL.rect.bottom})`)
    shot('03-floating-detail')
  })

  await check('floating chrome (first level): the page reaches both screen edges; the dock is one centred capsule; list rows end above it; Home keeps its wallpaper to the edges', async () => {
    await tanguDrawer()
    let list = ui()
    let wv = webViewNode(list)
    assert.deepEqual([wv.rect.top, wv.rect.bottom], [0, screen.h], 'the WebView does not span the whole screen on a first-level page')
    const strip = h.byId(list, 'nativeChrome.spaces')
    const dock = h.byId(list, 'nativeChrome.dock')
    assert.ok(strip && dock, 'dock missing')
    const navInset = screen.h - strip.rect.top - dockPx
    assert.equal(detailBottom, screen.h - navInset, `a detail page ends at the navigation inset (WebView bottom ${detailBottom}, inset ${navInset}px of ${screen.h})`)
    assert.ok(navInset >= 0 && near(dock.rect.bottom, screen.h - navInset - Math.round(6 * density), 2), `dock ${fmt(dock.rect)} does not sit 6dp above the navigation inset (${navInset}px)`)
    assert.ok(near((dock.rect.left + dock.rect.right) / 2, screen.w / 2, 2) && dock.rect.left >= Math.round(12 * density) - 1, `dock not centred / too wide: ${fmt(dock.rect)}`)
    let page = await chromeOnPage()
    assert.ok(near(page.nc.bottom * density, navInset + dockPx, 1), `the page was told bottom=${page.nc.bottom}dp (inset ${navInset}px + dock ${dockPx}px)`)
    assert.ok(near(page.clearPx.bottom, navInset + dockPx, 2), `--mb-bottom = ${page.clearPx.bottom}px`)
    const plate = page.plates.find((p) => p.id === 'dock')
    assert.ok(plate && sameRect(plate.rect, dock.rect), `dock plate ${plate && fmt(plate.rect)} vs ${fmt(dock.rect)}`)
    // the list: its scroller runs to the screen's bottom edge (rows pass under the dock), its last row can end above the dock
    const scroller = "document.querySelector('.mb-drawer--left .t2s-scroll')"
    await cdp.eval(`(() => { const s = ${scroller}; s.scrollTop = s.scrollHeight; return true })()`)
    await h.pause(300)
    const box = await elRect(scroller)
    const last = await elRect(`[...${scroller}.querySelectorAll('.t2s-srow, .t2s-viewmore, .t2s-foot')].pop()`)
    assert.ok(box && near(box.bottom, screen.h, 2), `the list does not reach the screen bottom (${box && fmt(box)})`)
    assert.ok(last && last.bottom <= dock.rect.top + 1, `the last row ends under the dock (${last && last.bottom} > ${dock.rect.top})`)
    const firstRow = await elRect(`${scroller}.firstElementChild`)
    const capL = h.byId(list, 'nativeChrome.capLeft')
    assert.ok(firstRow && firstRow.top >= capL.rect.bottom - 2, 'the list starts under the capsules')
    shot('03b-floating-list')
    // Home: wallpaper to both edges (no scrim over the status bar), its own dock of Spaces above ours
    await goHome()
    list = ui(); wv = webViewNode(list)
    assert.deepEqual([wv.rect.top, wv.rect.bottom], [0, screen.h])
    page = await chromeOnPage()
    assert.equal(page.scrimPx, 0, 'Home covers the status bar (the wallpaper should run to the top)')
    const root = await elRect("document.querySelector('.hp-root')")
    const lowest = await elRect("document.querySelector('.hp-root .hp-spaces')")
    const nativeDock = h.byId(list, 'nativeChrome.dock')
    assert.ok(root && root.top <= 1 && near(root.bottom, screen.h, 2), `the homepage does not span the screen (${root && fmt(root)})`)
    assert.ok(lowest && lowest.bottom <= nativeDock.rect.top + 1, `homepage content under the dock (${lowest && lowest.bottom} > ${nativeDock.rect.top})`)
    shot('03c-floating-home')
  })

  // A ComposeView only takes the touches one of its pointer inputs is hit by: what misses a capsule must reach the page,
  // or the strip beside the capsules is a dead zone (and the edge swipe that opens the list dies with it).
  await check('floating chrome: touches between / beside the capsules reach the page; a capsule keeps its own', async () => {
    await openChat('E2E Session One')
    let list = ui()
    const [capL, capR] = ['nativeChrome.capLeft', 'nativeChrome.capRight'].map((id) => h.byId(list, id))
    const gap = { x: Math.round((capL.rect.right + capR.rect.left) / 2), y: capL.rect.cy }
    assert.ok(capR.rect.left - capL.rect.right >= 8 * density - 1, `no room between the capsules (${capL.rect.right}..${capR.rect.left})`)
    const arm = "(() => { window.__taps = []; window.__tapSpy ||= document.addEventListener('pointerdown', (e) => window.__taps.push([Math.round(e.clientX * devicePixelRatio), Math.round(e.clientY * devicePixelRatio)]), true) || 1; return true })()"
    const taps = () => cdp.eval('window.__taps')
    await cdp.eval(arm)
    h.tapAt(gap.x, gap.y)
    await h.pause(500)
    let got = await taps()
    assert.ok(got.length === 1 && near(got[0][0], gap.x, 3) && near(got[0][1], gap.y, 3), `a tap between the capsules (${gap.x},${gap.y}) reached the page as ${JSON.stringify(got)}`)
    // the title's capsule takes its own touch
    await cdp.eval(arm)
    const title = h.byId(list, 'nativeChrome.title')
    h.tapAt(title.rect.cx, title.rect.cy)
    await h.pause(500)
    assert.deepEqual(await taps(), [], 'a tap on a capsule fell through to the page')
    // a swipe that starts between the capsules still drags the list in
    h.adb('shell', 'input', 'swipe', String(gap.x), String(gap.y), String(Math.min(screen.w - 20, gap.x + Math.round(260 * density))), String(gap.y), '220')
    assert.ok(await h.waitPage(cdp, `${nav} === 'list'`, 5000), 'a swipe starting between the capsules did not bring the list back')
    await h.pause(500)
    // beside the dock
    list = ui()
    const dock = h.byId(list, 'nativeChrome.dock')
    assert.ok(dock && dock.rect.left > 30, 'no room beside the dock to test')
    await cdp.eval(arm)
    h.tapAt(Math.round(dock.rect.left / 2), dock.rect.cy)
    await h.pause(500)
    got = await taps()
    assert.ok(got.length === 1 && near(got[0][0], Math.round(dock.rect.left / 2), 3), `a tap beside the dock reached the page as ${JSON.stringify(got)}`)
  })

  await check('floating chrome is the shell\'s only: a page (settings) and a covering overlay keep the WebView between two strips; glass off → solid capsules, no blur', async () => {
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    let r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.back') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, 'no page bar')
    await h.pause(600)
    let list = ui()
    const bar = h.byId(list, 'nativeChrome.bar')
    let wv = webViewNode(list)
    assert.ok(near(wv.rect.top, bar.rect.bottom, 1) && near(bar.rect.bottom, statusBar + barPx, 1), `settings: WebView top ${wv.rect.top}, strip bottom ${bar.rect.bottom}`)
    assert.ok(h.byId(list, 'nativeChrome.capLeft'), 'the page bar is not a capsule')
    let page = await chromeOnPage()
    assert.deepEqual([page.nc, page.plates.length, page.clearPx], [{ top: 0, bottom: 0, status: 0 }, 0, { top: 0, bottom: 0 }], 'a page was given room to keep clear / plates')
    await tapId('nativeChrome.back')
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), 'settings did not close')
    r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.more') ? l : null), { timeout: 5000 })
    assert.ok(r.hit, 'shell chrome did not return')
    await h.pause(600)
    page = await chromeOnPage()
    assert.ok(page.nc.top > 0 && page.plates.length >= 2, `back in the shell: ${JSON.stringify(page.nc)}, ${page.plates.length} plates`)
    // glass off (Settings → Appearance writes data-glass): the plates stop blurring; the capsules stay
    await cdp.eval("(document.documentElement.dataset.glass = 'off', true)")
    assert.ok(await h.waitPage(cdp, "[...document.querySelectorAll('#nc-plates .nc-plate')].every((e) => getComputedStyle(e).backdropFilter === 'none')", 4000), 'plates still blur with glass off')
    await h.pause(500)
    shot('03d-floating-glass-off')
    await cdp.eval("(delete document.documentElement.dataset.glass, true)")
    assert.ok(await h.waitPage(cdp, "[...document.querySelectorAll('#nc-plates .nc-plate')].every((e) => /blur/.test(getComputedStyle(e).backdropFilter))", 4000), 'plates did not blur again')
  })

  // 2026-10-04 (user: "like WeChat"): a Space with a left list opens ON the list (full screen, bottom bar below);
  // tapping an item enters the main view (no bottom bar, back arrow); back returns to the list, back again leaves the app.
  await check('two-level navigation: a Space opens on its list; an item enters the main view (no bottom bar); back returns; back on the list leaves the app', async () => {
    await tanguDrawer() // = Tangu's first level with the fixture sessions listed
    const level = async () => ({ nav: await cdp.eval(nav), list: ui() })
    let at = await level()
    assert.equal(at.nav, 'list')
    assert.ok(h.byId(at.list, 'nativeChrome.spaces'), 'no bottom bar on the list level')
    assert.ok(!h.byId(at.list, 'nativeChrome.left'), 'the list level shows a left button (nothing to go back to)')
    assert.ok(!h.byId(at.list, 'nativeChrome.right'), 'the list level shows the right-panel button')
    assert.equal(textOf(at.list, 'nativeChrome.title'), 'Tangu', 'the list level is titled after its Space')
    const geo = await cdp.eval(`(() => { const d = document.querySelector('.mb-drawer--left').getBoundingClientRect(), b = document.querySelector('.mb-body').getBoundingClientRect()
      return { full: Math.abs(d.width - b.width) < 1 && Math.abs(d.left - b.left) < 1, bar: !!document.querySelector('.mb-drawer--left .mb-drawer-bar'), dim: getComputedStyle(document.querySelector('.mb-push-dim')).opacity,
        foot: !!document.querySelector('.mb-drawer-foot') } })()`)
    assert.deepEqual(geo, { full: true, bar: false, dim: '0', foot: false }, 'list level is not a plain full-screen page (no bar of its own, no row at its foot)')
    // the account is the avatar at the end of the top bar (first-level pages only): label = the signed-in name
    const more = h.byId(at.list, 'nativeChrome.more')
    const avatar = h.byId(at.list, 'nativeChrome.account')
    assert.ok(avatar, 'no account avatar on the list level')
    assert.equal(descOf(at.list, 'nativeChrome.account'), 'e2e')
    assert.ok(avatar.rect.left >= more.rect.right - 1 && avatar.rect.right - avatar.rect.left >= 120, 'avatar is not the trailing 48dp target')
    // … and it is the account's picture (the fixture's is solid magenta), not the initial on a tinted disc
    let px = pixelAt(avatar.rect.cx, avatar.rect.cy)
    for (let i = 0; i < 10 && !(px.r > 200 && px.g < 80 && px.b > 200); i++) { await h.pause(300); px = pixelAt(avatar.rect.cx, avatar.rect.cy) }
    assert.ok(px.r > 200 && px.g < 80 && px.b > 200, `the avatar does not show the account picture (centre pixel ${JSON.stringify(px)})`)
    shot('03-list-level')
    h.tapNode(avatar)
    const accountSheet = await waitSheet(true)
    assert.ok(h.byId(accountSheet, 'nativeSheet.item.logout'), `the avatar did not open the account sheet (${ids(accountSheet)})`)
    // settings and the Unit switcher live in this menu (no row at the foot of the left panel to hold them), in that order
    const rows = ids(accountSheet)
    assert.ok(rows.includes('rb-settings') && rows.indexOf('rb-units-mobile') === rows.indexOf('rb-settings') + 1, `settings + Unit switcher expected in the account sheet (${rows})`)
    assert.ok(rows.indexOf('rb-settings') < rows.indexOf('logout'), 'sign out must stay the last row')
    assert.equal(rowLabel(accountSheet, 'nativeSheet.item.rb-settings'), '设置')
    shot('03b-account-sheet')
    h.key(4)
    await waitSheet(false)
    // a horizontal swipe over the list must not slide it away (only an item enters the main view)
    const wv = webViewNode(at.list).rect
    h.adb('shell', 'input', 'swipe', String(wv.right - 120), String(wv.cy), String(wv.left + 120), String(wv.cy), '200')
    await h.pause(900)
    assert.equal(await cdp.eval(nav), 'list', 'a swipe over the list left it')
    // tapping the active Space again does nothing (it used to open a drawer)
    await tapSpace('tangu')
    await h.pause(700)
    assert.equal(await cdp.eval(nav), 'list', 're-tapping the active Space left the list')
    // item → main view
    await tapEl(rowExpr('E2E Session One'))
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'detail' && !!document.querySelector('.mode-pill-btn')`, 8000), 'the session did not open')
    const gone = await h.waitNodes((l) => (!h.byId(l, 'nativeChrome.spaces') && h.byId(l, 'nativeChrome.left') ? l : null), { timeout: 8000 })
    assert.ok(gone.hit, 'the bottom bar stayed on the detail level, or there is no back button')
    assert.equal(descOf(gone.nodes, 'nativeChrome.left'), '返回')
    assert.ok(!h.byId(gone.nodes, 'nativeChrome.account'), 'the avatar stayed on the detail level')
    const screenH = Number(h.adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/)[2])
    assert.ok(webViewNode(gone.nodes).rect.bottom > screenH * 0.93, 'the WebView did not take the room of the bottom bar')
    await h.pause(600)
    shot('03-detail-level')
    // back arrow → list
    await tapId('nativeChrome.left')
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'list'`, 5000), 'the back arrow did not return to the list')
    assert.ok((await h.waitNodes((l) => !!h.byId(l, 'nativeChrome.spaces'), { timeout: 8000 })).hit, 'the bottom bar did not come back on the list')
    // item again, then system back → list, and the app is still in front
    await tapEl(rowExpr('E2E Session One'))
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'detail'`, 8000), 'the session did not reopen')
    await h.pause(600)
    h.key(4)
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'list'`, 5000), 'system back did not return to the list')
    assert.ok(resumed(), 'system back from the main view left the app')
    // a swipe from the main view back to the list (same gesture as the drawer had)
    await tapEl(rowExpr('E2E Session One'))
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'detail'`, 8000), 'the session did not reopen')
    await h.pause(600)
    h.adb('shell', 'input', 'swipe', String(wv.left + 150), String(wv.cy), String(wv.right - 100), String(wv.cy), '200')
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'list'`, 5000), 'swiping right on the main view did not return to the list')
    await h.pause(600)
    // system back on the list = bottom of the chain: the app goes to the background (and comes back as it was)
    h.key(4)
    await h.pause(1200)
    assert.ok(!resumed(), 'system back on the list level did not leave the app')
    h.adb('shell', 'am', 'start', '-n', ACTIVITY)
    assert.ok((await h.waitNodes((l) => !!h.byId(l, 'nativeChrome.spaces'), { timeout: 10000 })).hit, 'the app did not come back with its bottom bar')
    assert.equal(await cdp.eval(nav), 'list')
    // a Space without a left list (Home): its main view is the first level — bottom bar, no left button, the avatar
    await toSpace('home')
    at = await level()
    assert.equal(at.nav, '')
    assert.ok(h.byId(at.list, 'nativeChrome.spaces') && !h.byId(at.list, 'nativeChrome.left'), 'Home: bottom bar expected, left button not')
    assert.ok(await h.waitPage(cdp, homeShown, 6000), 'Home does not show the homepage')
    await tapSpace('home') // re-tap: used to slide an empty drawer over the homepage
    await h.pause(700)
    assert.ok(!(await cdp.eval(drawerOpen)), 're-tapping Home opened a drawer')
    await tapId('nativeChrome.more')
    let list = await waitSheet(true)
    assert.ok(h.byId(at.list, 'nativeChrome.account'), 'Home is a first-level page: avatar expected')
    assert.ok(!ids(list).includes('rb-settings') && !ids(list).includes('rb-units-mobile'), `settings / the Unit switcher are in the avatar menu, not in ⋯ (${ids(list)})`)
    h.key(4)
    await waitSheet(false)
    // a start-up lands on the list too, not on the main view that was open (start-up Space pinned to Tangu for this:
    // the default start-up Space is Home, which has no list)
    await toSpace('tangu')
    await closeDrawer()
    assert.equal(await cdp.eval(nav), 'detail')
    await h.pause(600) // layout autosave (200 ms throttle)
    const startPref = await cdp.eval("(() => { const v = localStorage.getItem('forsion_default_space'); localStorage.setItem('forsion_default_space', 'tangu'); return v })()")
    try {
      await reload()
      assert.deepEqual(await cdp.eval(`({ space: document.querySelector('.mb-shell').dataset.space, nav: ${nav} })`), { space: 'tangu', nav: 'list' }, 'a start-up did not land on the Space list')
    } finally {
      await cdp.eval(`(${startPref === null ? "localStorage.removeItem('forsion_default_space')" : `localStorage.setItem('forsion_default_space', ${JSON.stringify(startPref)})`}, true)`)
    }
  })

  // 2026-10-05 (user: "why is the local | cloud capsule still there? wasn't it folded into Unit?"): on a phone the two
  // sides are rows of the Unit sheet (desktop moved them into its Unit switcher on 08-23); the capsule no longer takes
  // the top of every left panel.
  await check('vault side: no capsule on top of the left panel; the Unit sheet leads with Local / Cloud and switches both ways', async () => {
    await tanguDrawer()
    assert.ok(!(await cdp.eval("!!document.querySelector('.mb-drawer--left [aria-label=\"vault side\"]')")), 'the local | cloud capsule is still on top of the left panel')
    await accountItem('rb-units-mobile')
    const side = "(document.querySelector('[data-units-sheet] [data-vault-side]')?.dataset.vaultSide || '')"
    assert.ok(await h.waitPage(cdp, `!!${side}`, 5000), 'the Unit sheet has no vault section')
    // Same order as the desktop Unit switcher: Local / Cloud first, then where sessions run.
    assert.ok(await cdp.eval("document.querySelector('[data-units-sheet] .us-section')?.hasAttribute('data-vault-side') === true"), 'the vault section is not the first section of the Unit sheet')
    const start = await cdp.eval(side)
    const other = start === 'cloud' ? 'local' : 'cloud'
    const row = (s) => `document.querySelector('[data-units-sheet] [data-vault-row="${s}"]')`
    const settled = (s) => `${side} === '${s}' && ${row(s)}.getAttribute('aria-pressed') === 'true' && !${row(s)}.hasAttribute('aria-busy')`
    assert.ok(await cdp.eval(settled(start)), 'the current side is not the marked row')
    await h.pause(500)
    shot('02c-units-vault')
    await tapEl(row(other))
    assert.ok(await h.waitPage(cdp, settled(other), 20000), `tapping "${other}" did not switch the vault side`)
    assert.equal(await cdp.eval("localStorage.getItem('amadeus_vault_mode') || ''"), other, 'the choice was not remembered')
    await tapEl(row(start)) // and back: the rest of the run works on the fixture vault
    assert.ok(await h.waitPage(cdp, settled(start), 20000), `could not switch back to "${start}"`)
    h.key(4)
    assert.ok(await h.waitPage(cdp, "!document.querySelector('[data-units-sheet]')", 5000), 'the Unit sheet did not close')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.bar'), { timeout: 6000 })).hit, 'the bar did not return after the Unit sheet')
  })

  await check('keyboard: the focused composer stays visible above the keyboard', async () => {
    await toSpace('tangu'); await closeDrawer()
    const field = "document.querySelector('.composer textarea, .composer [contenteditable], textarea')"
    await tapEl(field)
    const shown = () => /mInputShown=true/.test(h.adb('shell', 'dumpsys', 'input_method'))
    for (let i = 0; i < 20 && !shown(); i++) await h.pause(300)
    assert.ok(shown(), 'the keyboard did not come up')
    await h.pause(1500)
    // Android 15 edge-to-edge: nothing resizes the window for the keyboard, the plugin ends the WebView at its top edge.
    const screenH = Number(h.adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/)[2])
    const wv = webViewNode(ui())
    const p = await elPoint(field)
    assert.ok(wv.rect.bottom < screenH * 0.8, `the WebView kept its full height under the keyboard (bottom ${wv.rect.bottom} of ${screenH})`)
    assert.ok(p.y < wv.rect.bottom, `composer at y=${p.y}, below the WebView's visible bottom ${wv.rect.bottom}`)
    assert.ok(await cdp.eval(`document.activeElement === ${field}`), 'the composer lost focus')
    shot('03f-keyboard-composer')
    h.key(4); await h.pause(800)
    await cdp.eval('(document.activeElement && document.activeElement.blur(), true)')
  })

  // The Space switcher is a native bottom navigation bar (it used to be a web row at the bottom of the drawer).
  await check('bottom space bar: native, switches Space, Home pinned at the left, away with the keyboard and in settings', async () => {
    await goHome()
    const density = Number(h.adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]) / 160
    const screenH = Number(h.adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/)[2])
    let list = ui()
    const bar = h.byId(list, 'nativeChrome.spaces')
    assert.ok(bar, 'no native space bar')
    const items = h.byIdPrefix(list, 'nativeChrome.space.')
    const ids = items.map((n) => n['resource-id'].slice('nativeChrome.space.'.length))
    for (const id of ['home', 'tangu', 'agents']) assert.ok(ids.includes(id), `Space "${id}" missing from the bar (${ids.join(', ')})`)
    assert.equal(bar.rect.bottom, screenH, 'bar does not reach the screen edge')
    const wv = webViewNode(list)
    assert.ok(Math.abs(wv.rect.bottom - bar.rect.top) <= 1, `WebView bottom ${wv.rect.bottom} vs bar top ${bar.rect.top}`)
    for (const n of items) assert.ok(n.rect.bottom - n.rect.top >= 48 * density - 1, 'space item shorter than 48dp')
    assert.equal(await cdp.eval("document.querySelectorAll('.mb-spacebar, .mb-tab').length"), 0, 'the web Space row is still rendered')
    assert.equal(await cdp.eval("document.querySelector('.mb-shell').dataset.space"), 'home')
    assert.equal(h.byId(list, 'nativeChrome.space.home').selected || h.byId(list, 'nativeChrome.space.home').checked, 'true', 'active Space not marked selected')
    // keyboard (Home's composer — a first-level page with a text field): the bar leaves, the WebView takes its room; back brings it back
    await tapEl("document.querySelector('.composer textarea, .composer [contenteditable], textarea')")
    assert.ok((await h.waitNodes((l) => !h.byId(l, 'nativeChrome.spaces'), { timeout: 12000 })).hit, 'the bar stayed up with the keyboard')
    shot('03e-space-bar-keyboard')
    h.key(4)
    assert.ok((await h.waitNodes((l) => !!h.byId(l, 'nativeChrome.spaces'), { timeout: 12000 })).hit, 'the bar did not come back after the keyboard')
    await cdp.eval('(document.activeElement && document.activeElement.blur(), true)')
    // switch to a Space with a list: lands on the list, the bar stays (it is that Space's first level)
    await tapSpace('agents')
    assert.ok(await h.waitPage(cdp, `document.querySelector('.mb-shell').dataset.space === 'agents' && (${nav}) === 'list'`, 6000), 'tap did not switch to the Agents list')
    await h.pause(800)
    assert.ok(h.byId(ui(), 'nativeChrome.spaces'), 'the bar left on the Agents list')
    shot('03c-space-bar')
    // an Agents row enters the profile. That main view used to crash on the single-column shell (it read the dockview-only `stash`).
    await tapEl("document.querySelector('.mb-drawer--left .agents-roster-item')")
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'detail'`, 6000), 'an Agents row did not enter the main view')
    await h.pause(800)
    assert.equal(await cdp.eval("document.querySelector('.mb-main .sk-error')?.textContent || ''"), '', 'the Space main view failed to render')
    shot('03d-agents-detail')
    // a Space whose left panel is not a list of things to open (Calendar: to-dos) opts out: its main view is the first level
    if (ids.includes('calendar')) {
      await toSpace('calendar')
      assert.equal(await cdp.eval(nav), '', 'Calendar must not be a two-level Space')
      list = ui()
      assert.ok(h.byId(list, 'nativeChrome.spaces') && h.byId(list, 'nativeChrome.left'), 'Calendar: bottom bar + drawer button expected')
      assert.equal(descOf(list, 'nativeChrome.left'), '左侧面板')
      await openDrawer()
      const d = await cdp.eval(`(() => { const d = document.querySelector('.mb-drawer--left').getBoundingClientRect(), b = document.querySelector('.mb-body').getBoundingClientRect(); return d.width < b.width - 40 })()`)
      assert.ok(d, 'Calendar\'s left panel is not a drawer')
      await closeDrawer() // system back closes a drawer and stays in the app
      assert.ok(resumed(), 'closing the drawer left the app')
      // … and once more on the main view: Calendar is a pinned view (cannot be closed) = the bottom of the chain, the app
      // goes to the background. It used to do nothing at all (the handler stopped at the no-op close).
      h.key(4)
      await h.pause(1200)
      assert.ok(!resumed(), 'system back on a pinned main view did nothing (the app should go to the background)')
      h.adb('shell', 'am', 'start', '-n', ACTIVITY)
      assert.ok((await h.waitNodes((l) => !!h.byId(l, 'nativeChrome.spaces'), { timeout: 10000 })).hit, 'the app did not come back with its bottom bar')
      assert.equal(await cdp.eval("document.querySelector('.mb-shell').dataset.space"), 'calendar', 'the app came back on another Space')
    }
    // … and a Space whose left panel became such a list keeps the default: Image Studio's left panel is its project
    // navigation since 2026-10-05 (it was the chat, and the Space opted out). It opens on that list; an entry enters the main view.
    await toSpace('image-studio')
    assert.equal(await cdp.eval(nav), 'list', 'Image Studio must open on its project navigation')
    assert.ok(await h.waitPage(cdp, "document.querySelectorAll('.mb-drawer--left .csn-item').length >= 2", 8000), 'Image Studio: no navigation entries on the list level')
    assert.ok(h.byId(ui(), 'nativeChrome.spaces'), 'the bar left on the Image Studio list')
    shot('03h-image-studio-list')
    await tapEl("document.querySelectorAll('.mb-drawer--left .csn-item')[1]") // 「项目」: the launchpad
    assert.ok(await h.waitPage(cdp, `(${nav}) === 'detail'`, 6000), 'an Image Studio navigation entry did not enter the main view')
    await h.pause(800)
    assert.equal(await cdp.eval("document.querySelector('.mb-main .sk-error')?.textContent || ''"), '', 'Image Studio\'s main view failed to render')
    shot('03h-image-studio-detail')
    await openDrawer() // the back arrow: its list again
    // more Spaces than fit → Home (the first cell) stays put and the rest scroll beside it. While one of the first five is
    // active nothing scrolls (the bar used to centre the active Space, which scrolled Home away from the fourth Space on —
    // "the Home page is gone"; then it only scrolled as far as needed, and Home still left on the sixth).
    // The bar leaves composition on a detail level / in page mode and is recreated at offset 0: a Space past the fifth
    // must be scrolled back into view.
    if (ids.length > 5) {
      const fullWidth = items[0].rect.right - items[0].rect.left
      const widthOf = (id) => { const n = h.byId(ui(), `nativeChrome.space.${id}`); return n ? n.rect.right - n.rect.left : 0 }
      await toSpace(ids[4])
      assert.ok(widthOf('home') >= fullWidth - 2, `Home is not fully in view while the fifth Space is active (${widthOf('home')} of ${fullWidth}px)`)
      assert.ok(widthOf(ids[4]) >= fullWidth - 2, 'the fifth Space is not fully in view')
      shot('03g-space-bar-fifth')
      const last = ids[ids.length - 1]
      await toSpace(last)
      assert.ok(widthOf(last) >= fullWidth - 2, `active Space "${last}" is not fully in view`)
      // Home is pinned (2026-10-05): with the last Space active the rest of the bar has scrolled, Home has not moved
      // (reported width: a neighbour that slid under Home claims up to 24dp of its cell in the accessibility tree — see
      // tapSpace — so "most of a cell at the left edge" is what can be read here; the real-finger tap below settles it)
      const homeAt = () => { const n = h.byId(ui(), 'nativeChrome.space.home'); return n ? { left: n.rect.left, wide: n.rect.right - n.rect.left >= fullWidth * 0.6 } : null }
      const pinnedHome = { left: bar.rect.left, wide: true }
      assert.deepEqual(homeAt(), pinnedHome, `Home is not pinned at the left edge while "${last}" is active`)
      await accountItem('rb-settings')
      assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
      assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.back') && !h.byId(l, 'nativeChrome.spaces'), { timeout: 12000 })).hit, 'the space bar stayed up in page mode')
      await tapId('nativeChrome.back')
      const r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.spaces') ? l : null), { timeout: 12000 })
      assert.ok(r.hit, 'the space bar did not come back after settings')
      await h.pause(600)
      assert.ok(widthOf(last) >= fullWidth - 2, `active Space "${last}" is not fully in view after page mode (${widthOf(last)} of ${fullWidth}px)`)
      assert.deepEqual(homeAt(), pinnedHome, 'Home is not pinned at the left edge after page mode')
      shot('03g-space-bar-scrolled')
      // … and the whole pinned cell is Home's to tap: a finger near its right edge (where a scrolled-under neighbour's
      // reported bounds reach) must switch to Home, not to that neighbour
      h.tapAt(bar.rect.left + fullWidth - 24, h.byId(ui(), 'nativeChrome.space.home').rect.cy)
      assert.ok(await h.waitPage(cdp, "document.querySelector('.mb-shell').dataset.space === 'home'", 6000), `a tap on the right part of the pinned Home cell did not switch to Home (now: ${await cdp.eval("document.querySelector('.mb-shell').dataset.space")})`)
      await h.pause(800)
      await toSpace(last)
      if ((await cdp.eval(nav)) === '') await closeDrawer() // a drawer Space: close its drawer again
    }
  })

  // 2026-10-02 real-phone recording: every tap flashed the WebView's blue tap-highlight box. It is off now, and a press
  // tints the element instead (base.css, @media (pointer: coarse)). The pressed state is sampled while a finger is down.
  // Badges on the bottom bar's cells. Only "waiting for the user" is driven here: the stub token is no account, so the
  // per-account unread set does not survive a reload (cloudAccountCache: a fresh anonymous scope every boot), and a
  // running session needs a live run stream. The other two kinds are covered by the payload unit test (Kotlin).
  await check('bottom bar badge: no dot at rest; a session waiting for the user puts a warning dot on Tangu; answered → the dot leaves', async () => {
    const badges = (l) => h.byIdPrefix(l, 'nativeChrome.badge')
    const refetch = () => cdp.eval("(document.dispatchEvent(new Event('visibilitychange')), true)") // attentionStore refetches when the page comes to the front
    const polled = () => stubLog.filter((l) => l.includes('/agent/approvals/pending')).slice(-3).join(' | ')
    await goHome()
    // An earlier check may have swiped the bar: Tangu then sits under the pinned Home cell, and so would its dot.
    // Finger to the right = back to the first cells.
    let list = ui()
    const bar = h.byId(list, 'nativeChrome.spaces')
    assert.ok(bar, 'no native space bar')
    for (let i = 0; i < 2; i++) {
      h.adb('shell', 'input', 'swipe', String(Math.round(bar.rect.left + (bar.rect.right - bar.rect.left) * 0.3)), String(bar.rect.cy), String(bar.rect.right - 80), String(bar.rect.cy), '250')
      await h.pause(600)
    }
    list = ui()
    const [homeCell, tanguCell] = [h.byId(list, 'nativeChrome.space.home'), h.byId(list, 'nativeChrome.space.tangu')]
    assert.ok(homeCell && tanguCell && tanguCell.rect.left >= homeCell.rect.right - 2, `Tangu cell not fully on screen (${tanguCell?.bounds} beside ${homeCell?.bounds})`)
    assert.equal(badges(list).length, 0, 'a dot at rest')
    Object.assign(pending, { rev: 'e2e-1', sessions: [{ sessionId: 'e2e-s2', approvals: 1, inquiries: 0, localOnly: 0, oldestAt: iso(1000), remote: false }] })
    try {
      await refetch()
      const r = await h.waitNodes((l) => (badges(l).length ? l : null), { timeout: 12000 })
      assert.ok(r.hit, `no dot for a waiting session (index requests: ${polled() || 'none'})`)
      assert.equal(badges(r.hit).length, 1, 'more than one dot')
      const [dot, cell] = [badges(r.hit)[0], h.byId(r.hit, 'nativeChrome.space.tangu')]
      assert.ok(cell && within(cell, dot), `the dot is not on the Tangu cell (${dot.bounds} vs ${cell?.bounds})`)
      const c = pixelAt(dot.rect.cx, dot.rect.cy) // --warning: #806000 light, #e0b85b dark — warm either way
      assert.ok(c.r > c.b + 60 && c.g > c.b + 40, `the dot is not the warning colour: ${JSON.stringify(c)}`)
      shot('03f-space-bar-waiting')
    } finally {
      Object.assign(pending, { rev: 'e2e-2', sessions: [] })
    }
    await refetch()
    const r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.spaces') && !badges(l).length ? l : null), { timeout: 12000 })
    assert.ok(r.hit, `the dot stayed after the session was answered (index requests: ${polled()})`)
  })

  await check('haptics: switching Space ticks once (not on the Space you are on); the page-side seam ticks; an unknown kind is silent', async () => {
    const call = (kind) => cdp.eval(`Capacitor.Plugins.NativeChrome.haptic({ kind: ${JSON.stringify(kind)} }).then(() => 'ok', (e) => 'rejected: ' + (e && e.message))`)
    const onTangu = "document.querySelector('.mb-shell')?.dataset.space === 'tangu'"
    await goHome()
    let seen = hapticLog()
    if (!seen) console.log('  (this device keeps no vibration records: only the plugin calls are checked)')
    // the bottom bar (Kotlin): one CLOCK_TICK for a switch, none for the cell that is already active
    await tapSpace('tangu')
    assert.ok(await h.waitPage(cdp, onTangu, 6000), 'tap did not switch to Tangu')
    await h.pause(600)
    if (seen) assert.deepEqual(hapticsSince(seen), [4], 'switching Space')
    seen = hapticLog()
    await tapSpace('tangu')
    await h.pause(900)
    if (seen) assert.deepEqual(hapticsSince(seen), [], 'tapping the active Space')
    // the seam the page uses (a message was sent): "tick" vibrates, anything else is a silent no-op
    seen = hapticLog()
    assert.equal(await call('no-such-kind'), 'ok')
    await h.pause(400)
    if (seen) assert.deepEqual(hapticsSince(seen), [], 'an unknown kind')
    assert.equal(await call('tick'), 'ok')
    await h.pause(400)
    if (seen) assert.deepEqual(hapticsSince(seen), [4], 'the page-side tick')
    assert.match(String(await cdp.eval("Capacitor.Plugins.NativeChrome.noSuchMethod ? Capacitor.Plugins.NativeChrome.noSuchMethod({}).then(() => 'ok', () => 'rejected') : 'rejected'")), /rejected/, 'control: a method the plugin lacks also resolves — the calls above prove nothing')
    await goHome()
  })

  await check('settings on the phone: no Shortcuts / Status bar pages; the Space page drops the ribbon home slot', async () => {
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    await h.pause(600)
    const rows = await cdp.eval("[...document.querySelectorAll('.settings-mobile-row strong')].map((e) => e.textContent.trim())")
    for (const want of ['Space', '通知', '关于']) assert.ok(rows.includes(want), `control: "${want}" not among the settings rows (${rows.join(', ')})`)
    for (const gone of ['快捷键', '状态栏']) assert.ok(!rows.includes(gone), `"${gone}" is still listed on the phone`)
    shot('02c-settings-home-phone')
    await tapEl("[...document.querySelectorAll('.settings-mobile-row')].find((e) => e.querySelector('strong')?.textContent.trim() === 'Space')")
    assert.ok((await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === 'Space' ? l : null), { timeout: 6000 })).hit, 'the Space page did not open')
    await h.pause(500)
    const text = await cdp.eval("(() => { const el = document.querySelector('.settings-page--mobile'); return el.innerText + ' | ' + [...el.querySelectorAll('option')].map((o) => o.textContent).join(' | ') })()")
    assert.ok(text.includes('打开应用时进入'), 'control: the startup row is not on the page')
    assert.ok(!/ribbon|主位槽|右键/i.test(text), `desktop wording on the phone: ${(text.match(/.{0,12}(ribbon|主位槽|右键).{0,12}/i) || [''])[0]}`)
    assert.ok(text.includes('默认（当前是「'), 'the default startup option does not use the phone wording')
    shot('02d-settings-space-phone')
    await tapId('nativeChrome.close')
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), '× did not close settings')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })).hit, 'shell bar did not return')
  })

  // A <select> tapped in the WebView opens Chromium's own dialog (white, centred, untitled; rows are CheckedTextView
  // android:id/text1) whatever the theme. Under the native sheet host the same options come up on the sheet and the pick
  // reaches the control exactly like a browser pick (input + change), so the page's own onChange runs.
  await check('dropdown: a tapped <select> opens on the native sheet (not the WebView dialog), titled by its row; a pick changes the setting, cancel does not', async () => {
    const KEY = 'forsion_default_space' // what this select writes (spaces.tsx DEFAULT_SPACE_KEY)
    const select = "document.querySelector('.settings-page--mobile .settings-setting-row select')"
    const webDialog = (l) => l.some((n) => n['resource-id'] === 'android:id/text1' || /CheckedTextView$/.test(n.class || ''))
    /** What opened must be the sheet. */
    const opened = async () => {
      const r = await h.waitNodes((l) => (sheetOpen(l) || webDialog(l) ? l : null), { timeout: 6000 })
      assert.ok(r.hit, 'nothing opened')
      assert.ok(!webDialog(r.nodes), "the WebView's own dialog opened")
      return waitSheet(true)
    }
    const open = async () => { await tapEl(select); return opened() }
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    await h.pause(600)
    await tapEl("[...document.querySelectorAll('.settings-mobile-row')].find((e) => e.querySelector('strong')?.textContent.trim() === 'Space')")
    assert.ok((await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === 'Space' ? l : null), { timeout: 6000 })).hit, 'the Space page did not open')
    await h.pause(500)
    try {
      const options = await cdp.eval(`[...${select}.options].map((o) => ({ value: o.value, label: o.textContent.trim() }))`)
      const before = await cdp.eval(`${select}.value`)
      const agents = options.findIndex((o) => o.value === 'agents')
      assert.ok(agents > 0 && before !== 'agents', `control: unexpected options / start value (${before}; ${options.map((o) => o.value)})`)
      let list = await open()
      assert.equal(textOf(list, 'nativeSheet.title'), '打开应用时进入', 'the sheet is not titled by the row')
      const rows = ids(list)
      assert.deepEqual(rows, rows.map((_, i) => `opt:${i}`), `rows are not the options in order: ${rows}`)
      assert.ok(rows.length >= 4, `too few rows on screen: ${rows}`)
      rows.forEach((id, i) => assert.equal(rowLabel(list, `nativeSheet.item.${id}`), options[i].label, `row ${i}`))
      assert.deepEqual(rows.filter((id) => h.byId(list, `nativeSheet.item.${id}`).checked === 'true'), [`opt:${options.findIndex((o) => o.value === before)}`], 'the current option is not the checked row')
      shot('39-dropdown-sheet')
      h.key(4)
      await waitSheet(false)
      await h.pause(300)
      assert.deepEqual(await cdp.eval(`[${select}.value, localStorage.getItem('${KEY}')]`), [before, null], 'cancel changed something')
      await tapId(`nativeSheet.item.opt:${agents}`, await open())
      await waitSheet(false)
      assert.ok(await h.waitPage(cdp, `${select}.value === 'agents' && localStorage.getItem('${KEY}') === 'agents'`, 4000), `the pick did not reach the setting (${await cdp.eval(`[${select}.value, localStorage.getItem('${KEY}')].join()`)})`)
      list = await open()
      assert.equal(h.byId(list, `nativeSheet.item.opt:${agents}`).checked, 'true', 'the sheet does not show the new choice')
      // a hardware key opens the same sheet (Space on the focused control)
      h.key(4)
      await waitSheet(false)
      await cdp.eval(`(${select}.focus(), true)`)
      h.key(62)
      await tapId(`nativeSheet.item.opt:${options.findIndex((o) => o.value === before)}`, await opened())
      await waitSheet(false)
      assert.ok(await h.waitPage(cdp, `${select}.value === ${JSON.stringify(before)}`, 4000), 'picking the first choice back did not restore the control')
    } finally {
      if (sheetOpen(ui())) { h.key(4); await waitSheet(false) }
      if (webDialog(ui())) h.key(4)
      await cdp.eval(`(localStorage.removeItem('${KEY}'), true)`)
      await tapId('nativeChrome.close')
      assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), '× did not close settings')
      assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })).hit, 'shell bar did not return')
    }
  })

  // The phone's settings keep "open the app in" (Settings → Space). It must do something there: the boot code that reads
  // it was written for the desktop shell (bootstrapEngine: `UI_MODE !== 'mobile'`, and UI_MODE is 'desktop' inside the app).
  await check('startup Space on the phone: a boot lands on the default (Home), on the Space the setting names, or on the last one — as set', async () => {
    const space = "document.querySelector('.mb-shell')?.dataset.space"
    const KEY = 'forsion_default_space' // spaces.tsx DEFAULT_SPACE_KEY; '__last__' = LAST_EXIT_SPACE
    const bootWith = async (value) => {
      await toSpace('tangu') // where the user "was"
      await cdp.eval(`(${value === null ? `localStorage.removeItem('${KEY}')` : `localStorage.setItem('${KEY}', ${JSON.stringify(value)})`}, true)`)
      await reload()
      return cdp.eval(space)
    }
    try {
      assert.equal(await bootWith('agents'), 'agents', 'a pinned startup Space')
      assert.equal(await bootWith('__last__'), 'tangu', 'last Space on exit')
    } finally {
      assert.equal(await bootWith(null), 'home', 'the default: the home slot')
    }
  })

  await check('touch feedback: no WebView tap highlight; a held press tints the element; long-press selects no text', async () => {
    await tanguDrawer()
    // held target = the "new chat" button: a long-press there does nothing (a Space tab's long-press raises the
    // system "pin to home screen" dialog, a session row's opens its menu — both would cover what is being sampled)
    const tab = `document.querySelector('.mb-drawer--left [data-act="new-chat"]')`
    const probe = await cdp.eval(`(() => { const hl = (s) => getComputedStyle(document.querySelector(s)).webkitTapHighlightColor
      const match = 'button, a, summary, input, textarea, select, label, [role="button"], [role="tab"], [role="menuitem"], [role="option"]'
      // informational: what a finger can press that the press-tint selector does not cover (nearest cursor:pointer owner)
      const missed = new Set(); for (const e of document.querySelectorAll('.mb-shell *')) { if (getComputedStyle(e).cursor !== 'pointer' || e.closest(match)) continue
        if (e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer') continue
        missed.add(e.tagName.toLowerCase() + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).split(' ')[0]) }
      return { tab: hl('.mb-drawer--left [data-act="new-chat"]'), row: hl('.mb-drawer--left .t2s-srow'), coarse: matchMedia('(pointer: coarse)').matches, missed: [...missed] } })()`)
    console.log('  tappable elements outside the press-tint selector:', probe.missed.join(', ') || '(none)')
    assert.deepEqual({ tab: probe.tab, row: probe.row, coarse: probe.coarse }, { tab: 'rgba(0, 0, 0, 0)', row: 'rgba(0, 0, 0, 0)', coarse: true })
    const p = await elPoint(tab)
    const lifted = h.holdAt(p.x, p.y, 2500)
    const pressed = await h.waitPage(cdp, `(() => { const e = ${tab}; return e.matches(':active') ? { shadow: getComputedStyle(e).boxShadow } : null })()`, 2200)
    shot('03b-press-feedback')
    await lifted
    assert.ok(pressed, 'the held button never became :active')
    assert.match(pressed.shadow, /inset/, `no press tint on the held button (box-shadow: ${pressed.shadow})`)
    await h.pause(400)
    assert.equal(await cdp.eval('String(getSelection())'), '', 'long-press selected text')
    assert.ok(await cdp.eval(drawerOpen), 'the long-press was taken as a tap')
    await closeDrawer()
  })

  /** The tabs sheet, opened for a look (screenshots in another theme / language). With one tab there is no count button
   *  to open it with: a second tab is made through ⋯ first and closed again by the returned function, which also
   *  dismisses the sheet (and first hands the sheet's nodes to `look`, if given). */
  async function tabsSheet() {
    const extra = !h.byId(ui(), 'nativeChrome.tabs')
    if (extra) {
      await tapId('nativeChrome.more')
      await tapId('nativeSheet.item.tab:new', await waitSheet(true))
      await waitSheet(false)
      assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.tabs'), { timeout: 6000 })).hit, 'no count button with two tabs')
    }
    await tapId('nativeChrome.tabs')
    const list = await waitSheet(true)
    return async (look) => {
      if (look) look(list)
      if (extra) { // the tab made above is the open one: its × leaves the sheet up with the one tab that was there
        const mine = h.byIdPrefix(list, 'nativeSheet.trailing.tab:').find((n) => h.byId(list, n['resource-id'].replace('nativeSheet.trailing.', 'nativeSheet.item.'))?.checked === 'true')
        assert.ok(mine, 'no close action on the tab that was just made')
        h.tapNode(mine)
        assert.ok((await h.waitNodes((l) => (sheetOpen(l) && h.byIdPrefix(l, 'nativeSheet.item.tab:').length === 1 ? l : null), { timeout: 6000 })).hit, 'the extra tab was not closed')
      }
      h.key(4)
      await waitSheet(false)
    }
  }

  let firstView = ''
  await check('tabs: no count button for a single tab and "New tab" in ⋯; the sheet lists tabs, + new tab, switch, close (re-presents), back cancels', async () => {
    firstView = await cdp.eval(dom.view)
    const before = Number(tabCountText(ui()) || '1')
    // One tab: no count button (nothing to switch between). "New tab" is in ⋯, and the button comes with the second tab.
    assert.equal(!!h.byId(ui(), 'nativeChrome.tabs'), before > 1, 'the count button must be there with two or more tabs only')
    await tapId('nativeChrome.more')
    let list = await waitSheet(true)
    assert.equal(rowLabel(list, 'nativeSheet.item.tab:new'), '新建标签页')
    await tapId('nativeSheet.item.tab:new', list)
    await waitSheet(false)
    const r = await h.waitNodes((l) => (Number(tabCountText(l)) === before + 1 ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `tab count did not become ${before + 1} (is ${tabCountText(r.nodes)})`)
    assert.equal(descOf(r.nodes, 'nativeChrome.tabs'), '标签页')
    const newView = await cdp.eval(dom.view)
    // the tabs sheet: every tab, the open one marked, its own "new tab" row
    await tapId('nativeChrome.tabs')
    list = await waitSheet(true)
    const tabs = h.byIdPrefix(list, 'nativeSheet.item.tab:')
    assert.equal(tabs.length, before + 1, 'tab rows != tab count')
    assert.ok(tabs.some((n) => n.checked === 'true'), 'active tab not marked')
    assert.ok(h.byId(list, 'nativeSheet.item.new'), 'new tab row missing')
    shot('04-tabs-sheet-light')
    // switch back to the first tab
    const other = h.byIdPrefix(list, 'nativeSheet.item.tab:').find((n) => n.checked !== 'true')
    assert.ok(other, 'no inactive tab row')
    h.tapNode(other)
    await waitSheet(false)
    assert.equal(await h.waitPage(cdp, `(${dom.view}) === ${JSON.stringify(firstView)} && 'ok'`, 5000), 'ok', `did not switch back from ${newView}`)
    // close the new tab with its trailing ×: the sheet re-presents with the shorter list
    await tapId('nativeChrome.tabs')
    list = await waitSheet(true)
    const closeBtn = h.byIdPrefix(list, 'nativeSheet.trailing.tab:').find((n) => {
      const row = h.byId(list, n['resource-id'].replace('nativeSheet.trailing.', 'nativeSheet.item.'))
      return row && row.checked !== 'true'
    })
    assert.ok(closeBtn, 'no close action on the inactive tab')
    h.tapNode(closeBtn)
    const again = await h.waitNodes((l) => (sheetOpen(l) && h.byIdPrefix(l, 'nativeSheet.item.tab:').length === before ? l : null), { timeout: 6000 })
    assert.ok(again.hit, 'sheet was not re-presented with the shorter list')
    h.key(4) // system back cancels the sheet without leaving the app
    await waitSheet(false)
    assert.ok(resumed(), 'back left the app')
    assert.equal(Number(tabCountText(ui()) || '1'), before)
    assert.equal(!!h.byId(ui(), 'nativeChrome.tabs'), before > 1, 'the count button did not follow the tab count back')
    assert.equal(await cdp.eval(dom.view), firstView)
  })

  // The native ⋯ sheet cannot always be presented (a ribbon item drawn by a React component, a host that fails): the web
  // sheet takes over. With one tab the bar has no count button, so "New tab" has to be on that sheet as well.
  await check('more sheet fallback: when the host cannot present, the web sheet opens and carries "New tab", which opens one', async () => {
    assert.equal(Number(tabCountText(ui()) || '1'), 1, 'control: this check starts from a single tab')
    const row = `document.querySelector('.mb-sheet [data-act="new-tab"]')`
    // the presenter's own bridge call fails → the sheet seam reports "not handled"
    await cdp.eval(`(() => { const cap = window.Capacitor, real = cap.nativePromise
      window.__e2eSheetBack = () => { cap.nativePromise = real; delete window.__e2eSheetBack }
      cap.nativePromise = (plugin, method, options) => (plugin === 'NativeSheet' && method === 'present' ? Promise.reject(new Error('e2e: cannot present')) : real.call(cap, plugin, method, options))
      return true })()`)
    try {
      await tapId('nativeChrome.more')
      assert.ok(await h.waitPage(cdp, `!!${row}`, 6000), `the web sheet has no "New tab" row (sheet: ${await cdp.eval("document.querySelector('.mb-sheet')?.innerText || 'none'")})`)
      assert.ok(!sheetOpen(ui()), 'a native sheet opened although the host refused')
      assert.equal(await cdp.eval(`${row}.textContent.trim()`), '新建标签页')
      shot('05b-more-web-fallback')
      await tapEl(row)
      assert.ok((await h.waitNodes((l) => (Number(tabCountText(l)) === 2 ? l : null), { timeout: 6000 })).hit, 'the row did not open a second tab')
      assert.ok(await h.waitPage(cdp, "!document.querySelector('.mb-sheet')", 3000), 'the web sheet stayed open')
    } finally {
      await cdp.eval('(window.__e2eSheetBack?.(), true)')
    }
    // back to one tab: the new one is the open one, its × leaves the sheet up with the tab that was there
    await tapId('nativeChrome.tabs')
    const list = await waitSheet(true)
    const mine = h.byIdPrefix(list, 'nativeSheet.trailing.tab:').find((n) => h.byId(list, n['resource-id'].replace('nativeSheet.trailing.', 'nativeSheet.item.'))?.checked === 'true')
    assert.ok(mine, 'no close action on the tab that was just made')
    h.tapNode(mine)
    assert.ok((await h.waitNodes((l) => (sheetOpen(l) && h.byIdPrefix(l, 'nativeSheet.item.tab:').length === 1 ? l : null), { timeout: 6000 })).hit, 'the extra tab was not closed')
    h.key(4)
    await waitSheet(false)
    assert.ok(!h.byId(ui(), 'nativeChrome.tabs'), 'the count button stayed with one tab')
  })

  // ── chat surfaces (T1 consumers): JS owns the state, the sheet only renders the same item list ──
  await check('session rows end with when the session was last touched (today → the time), in the meta size', async () => {
    await tanguDrawer()
    const at = sessions[0].updated_at
    const t = await cdp.eval(`(() => { const row = ${rowExpr('E2E Session One')}; const el = row?.querySelector('.t2s-srow-time'); if (!el) return null
      const d = new Date(${JSON.stringify(at)}), n = new Date(), r = el.getBoundingClientRect(), menu = row.querySelector('.t2s-srow-menu').getBoundingClientRect(), title = row.querySelector('.t2s-srow-title, .t2s-srow-name, .grow')?.getBoundingClientRect()
      return { text: el.textContent, today: d.toDateString() === n.toDateString(), clock: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
        display: getComputedStyle(el).display, size: getComputedStyle(el).fontSize, width: Math.round(r.width), beforeMenu: r.right <= menu.left + 1, afterTitle: !title || title.right <= r.left + 1 } })()`)
    assert.ok(t, 'the row has no time element')
    assert.notEqual(t.display, 'none', 'the time is hidden under the native shell')
    assert.ok(t.width > 0, 'the time takes no room')
    if (t.today) assert.equal(t.text, t.clock, 'a session touched today shows its time')
    else assert.equal(t.text, '昨天', 'the run crossed midnight: the stub sessions are from yesterday')
    assert.equal(t.size, '12px', 'meta size')
    assert.ok(t.beforeMenu && t.afterTitle, `the time is not between the title and the ⋯ (${JSON.stringify(t)})`)
    shot('40-session-row-time')
  })

  // A failed request surfaces as the browser's own words ("TypeError: Failed to fetch"). On the phone the notification
  // says it plainly; the rest of the message (what failed) is kept.
  await check('offline wording: "Failed to fetch" in an error notification reads as "network unavailable"', async () => {
    const texts = "[...document.querySelectorAll('.ntf-text')].map((e) => e.textContent)"
    const closeToasts = () => cdp.eval(`(async () => { for (let i = 0; i < 8; i++) { const b = document.querySelector('.ntf-close'); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)
    await closeToasts()
    try {
      for (const [raw, want] of [['TypeError: Failed to fetch', '网络不可用，请稍后再试'], ['同步失败：Failed to fetch', '同步失败：网络不可用，请稍后再试'], ['同步失败：磁盘已满', '同步失败：磁盘已满']]) {
        await cdp.eval(`(window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: ${JSON.stringify(raw)}, level: 'error' } })), true)`)
        assert.ok(await h.waitPage(cdp, `${texts}.includes(${JSON.stringify(want)})`, 4000), `"${raw}" was shown as: ${await cdp.eval(`${texts}.join(' | ')`)}`)
      }
      assert.ok(!(await cdp.eval(`${texts}.join(' | ')`)).includes('Failed to fetch'), "the browser's wording is still on screen")
      shot('41-offline-wording')
    } finally { await closeToasts() }
  })

  await check('session row ⋯ menu: native sheet, rename through the native prompt reaches the server', async () => {
    await tanguDrawer()
    assert.equal(await cdp.eval(`getComputedStyle(${rowExpr('E2E Session Two')}.querySelector('.t2s-srow-menu')).opacity`), '0.7', '⋯ not visible on touch')
    await tapEl(`${rowExpr('E2E Session Two')}.querySelector('.t2s-srow-menu')`)
    let list = await waitSheet(true)
    const got = ids(list)
    for (const id of ['open-new-tab', 'rename', 'archive']) assert.ok(got.includes(id), `missing ${id} in ${got}`)
    assert.ok(!got.includes('delete'), 'delete is only offered for archived sessions')
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'web menu rendered as well')
    shot('17-session-menu-light')
    const sent = stubLog.length
    await tapId('nativeSheet.item.rename', list)
    list = await waitSheet(true) // the prompt replaces the menu
    assert.ok(h.byId(list, 'nativeSheet.prompt.field'), 'rename prompt missing')
    retype('E2E Renamed Two')
    await h.pause(300)
    shot('17c-rename-prompt-keyboard-light')
    await tapId('nativeSheet.prompt.ok')
    await waitSheet(false)
    const patch = await waitLog(sent, (l) => l.startsWith('PATCH ') && l.includes('/agent/sessions/e2e-s2 '))
    assert.ok(patch && JSON.parse(patch.slice(patch.indexOf('{'))).title === 'E2E Renamed Two', `rename PATCH: ${patch}`)
    assert.ok(await h.waitPage(cdp, `!!${rowExpr('E2E Renamed Two')}`, 5000), 'row title did not update')
  })

  await check('replaced menu: a second native menu opened while one is up stays open and is live (the withdrawn request closes nothing)', async () => {
    await tanguDrawer()
    await tapEl(`${rowExpr('E2E Session One')}.querySelector('.t2s-srow-menu')`)
    let list = await waitSheet(true)
    assert.equal(textOf(list, 'nativeSheet.title'), 'E2E Session One')
    // The second menu while the first sheet is still up. A finger cannot reach the page under the modal sheet, so this
    // one is a JS click: the same state change (setMenu) a second trigger would cause.
    await cdp.eval(`(${rowExpr('Two')}.querySelector('.t2s-srow-menu').click(), true)`)
    const second = (l) => sheetOpen(l) && /Two$/.test(textOf(l, 'nativeSheet.title'))
    const r = await h.waitNodes((l) => (second(l) ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `second menu did not replace the first (title=${textOf(r.nodes, 'nativeSheet.title')}, open=${sheetOpen(r.nodes)})`)
    await h.pause(2000) // the first request has been withdrawn by now: its onClose must not have closed this one
    list = ui()
    assert.ok(second(list), `second menu was closed by the withdrawn first request (open=${sheetOpen(list)}, title=${textOf(list, 'nativeSheet.title')})`)
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'web menu rendered as well')
    // …and it answers for ITS session: rename opens the prompt prefilled with the second session's title
    await tapId('nativeSheet.item.rename', list)
    list = await waitSheet(true)
    assert.match(textOf(list, 'nativeSheet.prompt.field'), /Two$/, 'the surviving menu is not bound to the second session')
    h.key(4) // IME first
    await h.pause(400)
    if (sheetOpen(ui())) h.key(4)
    await waitSheet(false)
  })

  await check('Orbits row ⋯ (pin round-trip) and "+" menus open natively', async () => {
    await tanguDrawer()
    const tail = `[...document.querySelectorAll('.mb-drawer--left .t2o-tail')][0]`
    const pins = "document.querySelectorAll('.mb-drawer--left .t2o-pin-mark').length"
    const before = await cdp.eval(pins)
    for (const step of [1, 2]) { // pin, then unpin again (leaves the pin store as found)
      await tapEl(tail)
      const list = await waitSheet(true)
      const got = ids(list)
      assert.ok(got.includes('agent-details') && (got.includes('pin') || got.includes('unpin')), `row ids: ${got}`)
      assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'web menu rendered as well')
      if (step === 1) shot('17b-orbit-row-menu')
      const pin = got.includes('pin')
      await tapId(`nativeSheet.item.${pin ? 'pin' : 'unpin'}`, list)
      await waitSheet(false)
      const want = step === 1 ? before + (pin ? 1 : -1) : before
      assert.ok(await h.waitPage(cdp, `(${pins}) === ${want} || null`, 4000), `pin mark count after step ${step} != ${want}`)
    }
    await tapEl("document.querySelector('.mb-drawer--left .t2o-plus')")
    const list = await waitSheet(true)
    assert.deepEqual(ids(list), ['new-agent', 'new-team', 'new-project'])
    h.key(4)
    await waitSheet(false)
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'cancel left a web menu behind')
  })

  await check('mode menu: approval tier switches through the same setter (pill + session config), nested agent page', async () => {
    await openChat('E2E Session One')
    assert.equal(await cdp.eval("document.querySelector('.mode-pill-btn').hasAttribute('data-danger')"), false, 'fixture starts in auto-edit')
    await tapEl("document.querySelector('.mode-pill-btn')")
    let list = await waitSheet(true)
    const got = ids(list)
    for (const id of ['normal-work', 'agent-switch', 'plan-mode', 'approval:auto-edit', 'approval:full-auto']) assert.ok(got.includes(id), `missing ${id} in ${got}`)
    assert.equal(h.byId(list, 'nativeSheet.item.approval:auto-edit').checked, 'true', 'current tier not checked')
    assert.equal(await cdp.eval("!!document.querySelector('.mode-pill-btn.is-open')"), false, 'web mode menu opened as well')
    shot('18-mode-sheet-light')
    const sent = stubLog.length
    await tapId('nativeSheet.item.approval:full-auto', list)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, "document.querySelector('.mode-pill-btn').hasAttribute('data-danger')", 5000), 'pill did not turn into full-auto (data-danger)')
    const patch = await waitLog(sent, (l) => /^(PATCH|PUT) \S+\/agent\/sessions\/e2e-s1\/config /.test(l))
    assert.ok(patch && JSON.parse(patch.slice(patch.indexOf('{'))).approvalMode === 'full-auto', `config write: ${patch}`)
    assert.equal(configs['e2e-s1'].approvalMode, 'full-auto')
    // nested page: agents, then back to the root page, then system back cancels
    await tapEl("document.querySelector('.mode-pill-btn')")
    list = await waitSheet(true)
    assert.equal(h.byId(list, 'nativeSheet.item.approval:full-auto').checked, 'true', 'sheet does not reflect the new tier')
    await tapId('nativeSheet.item.agent-switch', list)
    const page = await h.waitNodes((l) => (h.byId(l, 'nativeSheet.item.agent:e2e-helper') ? l : null), { timeout: 4000 })
    assert.ok(page.hit, `agent page: ${ids(page.nodes)}`)
    assert.ok(h.byId(page.nodes, 'nativeSheet.item.agent:e2e-agent') && h.byId(page.nodes, 'nativeSheet.back'), 'agent page incomplete')
    shot('19-mode-agents-page')
    await tapId('nativeSheet.back', page.nodes)
    assert.ok((await h.waitNodes((l) => (h.byId(l, 'nativeSheet.item.approval:full-auto') ? l : null), { timeout: 3000 })).hit, 'back did not return to the root page')
    h.key(4)
    await waitSheet(false)
    // restore the fixture tier natively too (exercises the setter once more)
    await tapEl("document.querySelector('.mode-pill-btn')")
    list = await waitSheet(true)
    await tapId('nativeSheet.item.approval:auto-edit', list)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, "!document.querySelector('.mode-pill-btn').hasAttribute('data-danger')", 5000), 'tier did not switch back')
  })

  // A user message has no inline buttons under the native host (2026-10-05): a long-press on the bubble opens the same
  // three actions natively. Rewind is therefore two sheets in a row — the message menu, then the rewind choices.
  const bubble = "document.querySelector('.t2-userwrap .t2-user')"
  /** Long-press the fixture user message (a real finger: the WebView turns it into `contextmenu`); the menu's nodes. */
  async function bubbleMenu() {
    const p = await elPoint(bubble)
    await h.holdAt(p.x, p.y, 900)
    return waitSheet(true, 8000)
  }
  async function pickRewind() { await tapId('nativeSheet.item.2', await bubbleMenu()) }
  /** The second sheet opens right behind the first: wait for one of its own rows, not for "a sheet". */
  const rewindSheet = async (timeout = 8000) => (await h.waitNodes((l) => (h.byId(l, 'nativeSheet.item.conversation') ? l : null), { timeout })).hit

  await check('user message: no inline buttons — a long-press opens copy / edit / rewind natively and edit runs; the reply keeps its row with a taller touch area', async () => {
    await openChat('E2E Session One')
    assert.ok(await h.waitPage(cdp, `!!${bubble}`, 4000), 'fixture user message missing')
    const css = await cdp.eval(`(() => { const u = [...document.querySelectorAll('.t2-userwrap .t2-actions .t2-iconbtn')], a = document.querySelector('.t2-asst .t2-actions .t2-iconbtn')
      const r = a.getBoundingClientRect(); let z = 1; for (let e = a; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1
      const hit = (dy) => document.elementFromPoint((r.left + r.width / 2) * z, (r.top + dy) * z) === a
      // out of sight, not out of the tree: a screen reader still reaches them (and each keeps its name)
      const size = (e) => { const b = e.getBoundingClientRect(); return Math.max(b.width, b.height) }
      return { user: u.map(size), named: u.every((e) => e.title && getComputedStyle(e).display !== 'none'), asst: getComputedStyle(a).display, above: hit(-6), far: hit(-14) } })()`)
    assert.ok(css.user.length >= 2 && css.user.every((d) => d <= 1), `inline buttons still visible under the user message: ${css.user}`)
    assert.ok(css.named, 'the hidden buttons left the accessibility tree (display:none) or lost their names')
    assert.notEqual(css.asst, 'none', 'the reply lost its action row')
    assert.ok(css.above, 'the reply button does not take a touch 6px above its edge')
    assert.ok(!css.far, 'control: 14px above the reply button still hits it (the probe proves nothing)')
    const felt = hapticLog()
    const list = await bubbleMenu()
    // The WebView vibrates by itself when the page takes a long-press. A second one from the page cut it short 1–2 ms in.
    if (felt) assert.deepEqual(hapticsSince(felt), [0], 'one LONG_PRESS per long-press')
    assert.deepEqual(ids(list), ['0', '1', '2'])
    assert.deepEqual(['0', '1', '2'].map((i) => rowLabel(list, `nativeSheet.item.${i}`)), ['复制', '编辑', '回退到这条消息'])
    assert.equal(textOf(list, 'nativeSheet.title'), 'Hello fixture')
    assert.equal(await cdp.eval('String(getSelection())'), '', 'the long-press selected text')
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'a web menu rendered as well')
    shot('20a-message-menu')
    await tapId('nativeSheet.item.1', list)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, "document.querySelector('.t2-edit-ta')?.value === 'Hello fixture'", 5000), 'Edit did not open the edit box')
    await cdp.eval("(document.activeElement?.blur(), document.querySelector('.t2-edit .t2-btn.ghost').click(), true)")
    assert.ok(await h.waitPage(cdp, `!document.querySelector('.t2-edit') && !!${bubble}`, 5000), 'cancel did not bring the message back')
    await h.pause(1200) // the keyboard the edit box raised leaves
    // The menu belongs to its message: the session changes underneath (no key press) → the sheet leaves by itself,
    // so Edit / Rewind can never run against a session the user is no longer in.
    await bubbleMenu()
    await cdp.eval(`(${rowExpr('Two')}.click(), true)`)
    await waitSheet(false, 6000)
    assert.ok(await h.waitPage(cdp, `!${bubble}`, 5000), 'did not switch to the other session')
    await h.pause(600)
    assert.ok(resumed(), 'left the app')
  })

  await check('rewind menu: native sheet with the note as footer; cancel changes nothing', async () => {
    const btn = `document.querySelector('[data-act="rewind"]')` // still in the DOM (hidden under the native host): tells the fixture message is up
    if (!(await cdp.eval(`!!${btn}`))) await openChat('E2E Session One')
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'the fixture user message offers no rewind')
    const sent = stubLog.length
    await pickRewind()
    const list = await rewindSheet()
    assert.ok(list, 'the rewind sheet did not open after the message menu')
    const got = ids(list)
    assert.ok(got.includes('conversation'), `rewind items: ${got}`)
    assert.ok(h.byId(list, 'nativeSheet.footer')?.text, 'footer note missing')
    shot('20-rewind-sheet')
    h.key(4)
    await waitSheet(false)
    await h.pause(500)
    assert.ok(!stubLog.slice(sent).some((l) => /^(POST|PATCH|DELETE|PUT) /.test(l) && /rewind|truncate|messages/.test(l)), 'cancel wrote something')
  })

  await check('rewind: leaving the session withdraws the request — a pending stat never opens a sheet, an open sheet is dismissed, nothing is written', async () => {
    const btn = `document.querySelector('[data-act="rewind"]')`
    const wrote = (since) => stubLog.slice(since).filter((l) => /^(POST|PATCH|DELETE|PUT) /.test(l) && /rewind|truncate|checkpoints|messages/.test(l))
    await openChat('E2E Session One')
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'the fixture user message offers no rewind')
    // (1) the checkpoint stat is still loading when the user switches session
    hold.checkpoints = true
    let sent = stubLog.length
    try {
      await pickRewind()
      assert.ok(await waitLog(sent, (l) => /^GET \S+\/e2e-s1\/checkpoints/.test(l), 6000), 'checkpoint stat was not requested')
      await waitSheet(false) // the message menu is gone, and nothing may follow it while the stat is parked
      await openChat('Two') // drawer → the other session: the message that asked is gone
    } finally {
      hold.checkpoints = false
      for (const go of hold.release.splice(0)) go()
    }
    const late = await h.waitNodes((l) => (sheetOpen(l) ? l : null), { timeout: 3500 })
    assert.ok(!late.hit, 'the rewind sheet opened for a session the user already left')
    assert.equal(await cdp.eval("!!document.querySelector('.rewind-menu')"), false, 'web rewind menu opened instead')
    assert.deepEqual(wrote(sent), [])
    // (2) the sheet is open and the session changes underneath (no key press: only the abort can close it)
    await openChat('E2E Session One')
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'the fixture user message offers no rewind after coming back')
    sent = stubLog.length
    await pickRewind()
    const list = await rewindSheet()
    assert.ok(list, 'the rewind sheet did not open after the message menu')
    await cdp.eval(`(${rowExpr('Two')}.click(), true)`)
    await waitSheet(false, 6000)
    assert.ok(await h.waitPage(cdp, `!${btn}`, 5000), 'did not switch to the other session')
    await h.pause(600)
    assert.deepEqual(wrote(sent), [])
    assert.ok(resumed(), 'left the app')
  })

  await check('add menu: nested conversation page with native search; Files opens the system picker', async () => {
    await openChat('E2E Session One')
    await tapEl("document.querySelector('.add-pill-btn')")
    let list = await waitSheet(true)
    const got = ids(list)
    for (const id of ['new-chat', 'camera', 'photos', 'files', 'conversation', 'view']) assert.ok(got.includes(id), `missing ${id} in ${got}`)
    // "Add files or folders" is three rows on the phone, in this order, between the actions and the references
    assert.deepEqual(got.slice(got.indexOf('camera'), got.indexOf('camera') + 4), ['camera', 'photos', 'files', 'conversation'], `source rows out of place: ${got}`)
    assert.deepEqual(['camera', 'photos', 'files'].map((id) => rowLabel(list, `nativeSheet.item.${id}`)), ['拍照', '相册', '文件'])
    assert.equal(await cdp.eval("!!document.querySelector('.add-pill-btn.is-open')"), false, 'web add menu opened as well')
    shot('21-add-sheet-light')
    await tapId('nativeSheet.item.conversation', list)
    let r = await h.waitNodes((l) => (h.byId(l, 'nativeSheet.search') && ids(l).some((x) => x.startsWith('session:')) ? l : null), { timeout: 4000 })
    assert.ok(r.hit, `conversation page: ${ids(r.nodes)}`)
    await tapId('nativeSheet.search', r.nodes)
    await h.pause(300)
    h.adb('shell', 'input', 'text', 'zzqx')
    r = await h.waitNodes((l) => (h.byId(l, 'nativeSheet.empty') ? l : null), { timeout: 3000 })
    assert.ok(r.hit && !ids(r.nodes).some((x) => x.startsWith('session:')), 'no-match state missing')
    retype('Two')
    r = await h.waitNodes((l) => (ids(l).join() === 'session:e2e-s2' ? l : null), { timeout: 3000 })
    assert.ok(r.hit, `search did not narrow to e2e-s2: ${ids(r.nodes)}`)
    shot('22-add-conversation-search')
    h.key(4) // IME first
    await h.pause(400)
    if (sheetOpen(ui()) && h.byId(ui(), 'nativeSheet.search')) h.key(4)
    await h.pause(300)
    if (sheetOpen(ui())) h.key(4)
    await waitSheet(false)
    // Files: chosen inside the Compose dialog (no WebView user activation) → native document picker
    await tapEl("document.querySelector('.add-pill-btn')")
    list = await waitSheet(true)
    await tapId('nativeSheet.item.files', list)
    const deadline = Date.now() + 6000
    let top = ''
    while (Date.now() < deadline) {
      top = h.adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=.*/)?.[0] || ''
      if (/documentsui/i.test(top)) break
      await h.pause(300)
    }
    assert.match(top, /documentsui/i, 'system document picker did not open')
    shot('23-files-picker')
    h.key(4) // cancel the picker: resolves with no files
    assert.ok((await h.waitNodes(() => resumed(), { timeout: 6000 })).hit, 'did not return to the app')
  })

  // ── picked content → composer: what the file, photo and camera checks all read ──
  const top = () => h.adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=.*/)?.[0] || ''
  /** Composer state (attachments + workspace files) read from the React fiber of a chip: name, declared size, decoded bytes, sha256. */
  const composerFiles = `(async () => { const el = document.querySelector('.t2c-chiprow .attach-chip'); if (!el) return []
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    for (let f = el[key]; f; f = f.return) {
      const found = []
      for (let st = f.memoizedState; st && typeof st === 'object' && 'next' in st; st = st.next) {
        const v = st.memoizedState
        if (Array.isArray(v) && v.length && v.every((a) => a && typeof a.name === 'string' && typeof a.data === 'string' && typeof a.size === 'number')) found.push(...v)
      }
      if (found.length) return Promise.all(found.map(async (a) => { const bin = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bin))
        return { name: a.name, size: a.size, bytes: bin.length, sha256: [...d].map((b) => b.toString(16).padStart(2, '0')).join('') } }))
    }
    return null })()`
  const want = (f) => ({ name: f.name, size: f.data.length, bytes: f.data.length, sha256: f.sha256 })
  const chipNames = "[...document.querySelectorAll('.t2c-chiprow .attach-chip > span:first-of-type')].map((e) => e.textContent)"
  const toasts = "[...document.querySelectorAll('.ntf-text')].map((e) => e.textContent).join(' | ')"

  const backInApp = async () => assert.ok((await h.waitNodes(() => resumed(), { timeout: 15000 })).hit, 'did not return to the app (picker hung?)')
  /** The composer's files once there are `count` of them (or whatever is there when the wait runs out). */
  const settled = async (count) => {
    const end = Date.now() + 20000
    let got = null
    while (Date.now() < end) { got = await cdp.eval(composerFiles); if (got && got.length === count) return got; await h.pause(400) }
    return got
  }
  /** No attachments in the composer and no notification left on screen. */
  const clearComposer = () => cdp.eval(`(async () => { for (const sel of ['.t2c-chiprow .attach-chip button', '.ntf-close']) for (let i = 0; i < 8; i++) {
    const b = document.querySelector(sel); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)

  await check('files: system picker → composer (content URIs streamed through the local server): right name + bytes, > 25 MB named in the toast and not attached, cancel is a no-op', async () => {
    pushPickFixtures()
    const title = (l, text) => l.find((n) => n['resource-id'] === 'android:id/title' && n.text === text)
    const DEVICE_ROOT = h.adb('shell', 'getprop', 'ro.product.model').trim() // the raw-storage root is labelled with the model name
    // every local-server answer for a picked document (a 404 here = "Unable to open content URL" in logcat)
    const served = []
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', (ev) => { if (ev.response.url.includes('/_capacitor_content_/')) served.push(ev.response.status) })
    h.adb('logcat', '-c')

    /** Add sheet → Files → the system picker is in front. */
    async function openPicker() {
      await tapEl("document.querySelector('.add-pill-btn')")
      await tapId('nativeSheet.item.files', await waitSheet(true))
      assert.ok((await h.waitNodes(() => /documentsui/i.test(top()), { timeout: 8000 })).hit, 'system document picker did not open')
      await h.pause(700)
    }
    /** Roots drawer → a root by its label (DocumentsUI remembers the last directory per caller: always start from a root). */
    async function toRoot(label) {
      const open = (await h.waitNodes((l) => l.find((n) => n['content-desc'] === 'Show roots'), { timeout: 6000 })).hit
      assert.ok(open, 'picker: "Show roots" not found (the system language must be English)')
      h.tapNode(open)
      // A tap that lands on a root closes the drawer. In one full run on a freshly booted emulator it did not land (the
      // drawer was still up 8 s later, the directory behind it unchanged): read again and tap once more.
      for (let attempt = 0; ; attempt++) {
        const root = (await h.waitNodes((l) => (l.some((n) => n.text === 'Open from') ? title(l, label) : null), { timeout: 6000 })).hit
        assert.ok(root, `picker: root "${label}" not listed`)
        h.tapNode(root)
        await h.pause(1200)
        if (attempt || !ui().some((n) => n.text === 'Open from')) break
        console.log(`  (picker: the tap on "${label}" left the roots drawer open — tapping again)`)
      }
    }
    const entry = async (text) => {
      const n = (await h.waitNodes((l) => (l.some((x) => x.text === 'Open from') ? null : title(l, text)), { timeout: 8000 })).hit
      assert.ok(n, `picker: "${text}" not listed`)
      return n
    }

    await openChat('E2E Session One')
    assert.deepEqual(await cdp.eval(chipNames), [], 'precondition: composer already has attachments')

    // cancel first: nothing is attached, and the pick promise settles (the next pick works)
    await openPicker()
    h.key(4)
    await backInApp()
    await h.pause(800)
    assert.deepEqual(await cdp.eval(chipNames), [])
    assert.equal(await cdp.eval(toasts), '', 'cancel showed a toast')

    // 1) small text file from Downloads
    await openPicker()
    await toRoot('Downloads')
    h.tapNode(await entry(PICK.small.name))
    await backInApp()
    assert.deepEqual(await settled(1), [want(PICK.small)])

    // 2) 1 MB binary from <device>/Documents
    await openPicker()
    await toRoot(DEVICE_ROOT)
    h.tapNode(await entry('Documents'))
    await h.pause(1000)
    h.tapNode(await entry(PICK.mid.name))
    await backInApp()
    assert.deepEqual(await settled(2), [want(PICK.small), want(PICK.mid)])
    assert.deepEqual(await cdp.eval(chipNames), [PICK.small.name, PICK.mid.name])
    shot('23b-files-attached')

    // 3) the > 25 MB file alone: refused, named in the toast, nothing added
    await openPicker()
    await toRoot('Downloads')
    h.tapNode(await entry(PICK.big.name))
    await backInApp()
    const toast = await h.waitPage(cdp, `(() => { const t = ${toasts}; return t.includes(${JSON.stringify(PICK.big.name)}) ? t : null })()`, 10000)
    assert.ok(toast, `no toast named the skipped file (toasts: ${await cdp.eval(toasts)})`)
    console.log('  skipped toast:', toast)
    shot('23c-files-skipped-toast')
    assert.deepEqual((await settled(2)).map((f) => f.name), [PICK.small.name, PICK.mid.name], 'the oversized file was attached')

    // 4) multi-select (clipData path): small + big in one go → small attached again, big skipped
    await openPicker()
    await toRoot('Downloads')
    h.longPress(await entry(PICK.small.name))
    await h.pause(800)
    h.tapNode(await entry(PICK.big.name))
    const select = (await h.waitNodes((l) => h.byId(l, 'com.google.android.documentsui:id/action_menu_select'), { timeout: 5000 })).hit
    assert.ok(select, 'picker: multi-select "Select" action missing')
    h.tapNode(select)
    await backInApp()
    assert.deepEqual(await settled(3), [want(PICK.small), want(PICK.mid), want(PICK.small)])

    const log = h.adb('logcat', '-d').split('\n').filter((l) => /Unable to open content URL/.test(l))
    assert.deepEqual(log, [], 'local server could not open a picked content URL')
    console.log(`  _capacitor_content_ responses: ${JSON.stringify(served)}`)
    assert.ok(served.length >= 3 && served.every((x) => x === 200), `content fetches: ${JSON.stringify(served)}`)
    await cdp.send('Network.disable')
  })
  // Leave a clean stage whatever the check's outcome: no attachments in the composer, and no error toast left on
  // screen (they stay up for a while and cover the top of the drawer, where the next check taps "new chat").
  try {
    await cdp.eval(`(async () => { for (const sel of ['.t2c-chiprow .attach-chip button', '.ntf-close']) for (let i = 0; i < 8; i++) {
      const b = document.querySelector(sel); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)
  } catch { /* page reloading */ }

  // "+" → Photos / Take photo. Both leave the app for a system surface (the photo picker, the camera app) and come back
  // with content the page reads like any other picked document. The camera needs the runtime permission first: the merged
  // manifest declares CAMERA, and Android refuses ACTION_IMAGE_CAPTURE to an app that declares it without holding it.
  await check('photos and camera: Photos → system photo picker → the image is attached (cancel adds nothing); Take photo asks for the camera, a refusal is told, an allowed shot from the camera app is attached and backing out leaves no file behind', async () => {
    pushPickFixtures()
    const indexed = () => h.adb('shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', '_display_name').includes(PICK.photo.name)
    assert.ok((await h.waitNodes(() => indexed(), { timeout: 15000 })).hit, 'control: MediaStore did not index the pushed image')
    const idEnds = (suffix) => (l) => l.find((n) => (n['resource-id'] || '').endsWith(suffix))
    const source = async (id) => {
      await tapEl("document.querySelector('.add-pill-btn')")
      await tapId(`nativeSheet.item.${id}`, await waitSheet(true))
    }
    const openPhotos = async () => {
      await source('photos')
      assert.ok((await h.waitNodes(() => /photopicker/i.test(top()), { timeout: 8000 })).hit, `the system photo picker did not open (${top()})`)
      await h.pause(700)
    }
    await openChat('E2E Session One')
    assert.deepEqual(await cdp.eval(chipNames), [], 'precondition: composer already has attachments')

    // Photos: cancel → nothing, no toast; then one image
    await openPhotos()
    shot('42-photo-picker')
    h.key(4)
    await backInApp()
    await h.pause(800)
    assert.deepEqual([await cdp.eval(chipNames), await cdp.eval(toasts)], [[], ''], 'cancelling the photo picker changed something')
    await openPhotos()
    const thumb = (await h.waitNodes(idEnds(':id/icon_thumbnail'), { timeout: 8000 })).hit
    assert.ok(thumb, 'photo picker: no photo listed')
    h.tapNode(thumb) // the newest = the fixture just pushed (the attached name + hash below prove which one it was)
    const add = (await h.waitNodes(idEnds(':id/button_add'), { timeout: 6000 })).hit
    assert.ok(add, 'photo picker: no "Add" after selecting a photo')
    h.tapNode(add)
    await backInApp()
    // The system photo picker does not reveal a photo's own file name: what it hands over is called by its media id
    // ("1000000071.png"). Which photo it was is told by its bytes.
    const content = (f) => ({ size: f.size, bytes: f.bytes, sha256: f.sha256 })
    const picked = await settled(1)
    assert.deepEqual((picked || []).map(content), [content(want(PICK.photo))], `the picked photo is not in the composer: ${JSON.stringify(picked)} (toasts: ${await cdp.eval(toasts)})`)
    assert.match(picked[0].name, /\.png$/, 'the photo lost its type')
    const photoName = picked[0].name

    // Take photo, refused: told in the user's words, nothing attached, no file left
    await source('camera')
    let asked = (await h.waitNodes(idEnds('permissioncontroller:id/permission_deny_button'), { timeout: 8000 })).hit
    assert.ok(asked, `the system did not ask for the camera (${top()})`)
    shot('43-camera-permission')
    h.tapNode(asked)
    assert.ok(await h.waitPage(cdp, `(${toasts}).includes('没有相机权限')`, 8000), `a refused camera was not told (toasts: ${await cdp.eval(toasts)})`)
    assert.deepEqual(await cdp.eval(chipNames), [photoName], 'a refusal attached something')
    assert.ok(!/camera/i.test(top()), 'the camera opened without the permission')
    await cdp.eval(`(async () => { for (let i = 0; i < 8; i++) { const b = document.querySelector('.ntf-close'); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)

    // Take photo, allowed: the camera app takes it into our cache file; the page attaches it
    const shoot = async () => {
      assert.ok((await h.waitNodes(() => /camera/i.test(top()), { timeout: 12000 })).hit, `the camera app did not open (${top()})`)
      const shutter = (await h.waitNodes(idEnds(':id/shutter_button'), { timeout: 12000 })).hit
      assert.ok(shutter, 'camera: no shutter button')
      await h.pause(1500) // preview warm-up
      return shutter
    }
    await source('camera')
    asked = (await h.waitNodes(idEnds('permissioncontroller:id/permission_allow_foreground_only_button'), { timeout: 8000 })).hit
    assert.ok(asked, 'a second request did not ask again')
    h.tapNode(asked)
    h.tapNode(await shoot())
    const done = (await h.waitNodes(idEnds(':id/done_button'), { timeout: 20000 })).hit
    assert.ok(done, 'camera: no "Done" after the shot')
    h.tapNode(done)
    await backInApp()
    const files = await settled(2)
    assert.ok(files && files.length === 2, `the shot was not attached: ${JSON.stringify(files)} (toasts: ${await cdp.eval(toasts)})`)
    assert.deepEqual(files[0], picked[0])
    assert.match(files[1].name, /^IMG_\d{8}_\d{6}\.jpg$/, 'the shot is named by when it was taken')
    assert.ok(files[1].bytes > 1000 && files[1].bytes === files[1].size, `the shot has no content: ${JSON.stringify(files[1])}`)
    assert.deepEqual(runAs('ls', 'cache/camera').split(/\s+/).filter(Boolean), [files[1].name], 'the cache holds something else than this shot')
    shot('44-camera-attached')

    // Backing out of the camera: nothing is added, and neither the empty target nor the earlier shot stays behind
    await source('camera') // no question this time: the permission is held
    await shoot()
    h.key(4)
    await backInApp()
    await h.pause(800)
    assert.deepEqual([(await settled(2)).map((f) => f.name), await cdp.eval(toasts)], [[photoName, files[1].name], ''], 'backing out of the camera changed something')
    // the shot read a moment ago is kept for a minute (the next capture or app start removes it); the abandoned target is not
    const left = runAs('ls', 'cache/camera').split(/\s+/).filter(Boolean)
    assert.ok(left.every((f) => f === files[1].name), `files left in cache/camera: ${left}`)
  })
  try { await clearComposer() } catch { /* page reloading */ }

  await check('voice input: the mic is live; the shim posts the recording to the cloud and returns its text; failures are worded for the user; a real tap records', async () => {
    await goHome()
    const mic = "document.querySelector('.t2c-mic-control')"
    assert.equal(await cdp.eval(`${mic}?.disabled`), false, 'the mic button is disabled (window.tangu.transcribeAudio missing?)')
    // the seam the shared hook calls: recording (base64 WAV) → POST …/brain/transcribe → text
    let sent = stubLog.length
    assert.equal(await cdp.eval("window.tangu.transcribeAudio({ audioBase64: 'UklGRg==', mime: 'audio/wav' })"), 'e2e transcript')
    const line = stubLog.slice(sent).find((l) => l.startsWith('POST ') && l.includes('/brain/transcribe '))
    assert.ok(line, `no POST …/brain/transcribe (${stubLog.slice(sent).join(' | ')})`)
    const body = JSON.parse(line.slice(line.indexOf('{')))
    assert.deepEqual({ audio: body.audioBase64, mime: body.mime, app: body.projectSource, model: 'modelId' in body }, { audio: 'UklGRg==', mime: 'audio/wav', app: 'tangu', model: false })
    assert.match(String(body.client), /^mobile\/\d/, 'client tag')
    // a refusal is told in the user's words, not with the server's (Chinese-only) detail
    for (const [status, want] of [[402, '额度不够，这段语音没有转写'], [401, '请先登录，再用语音输入'], [500, '语音转写失败（500）']]) {
      transcribe.status = status
      try {
        assert.equal(await cdp.eval("window.tangu.transcribeAudio({ audioBase64: 'UklGRg==' }).then(() => 'resolved', (e) => e.message)"), want)
      } finally { transcribe.status = 200 }
    }
    // A real tap: the WebView asks for the microphone → Capacitor asks the system once → recording starts. The emulator's
    // microphone is silent unless host audio is on, so the take ends either in the "nothing recorded" hint (the silence
    // check runs after MediaRecorder → decode → 16 kHz WAV, i.e. the whole capture path ran) or in the stub's transcript.
    await tapEl(mic)
    const asked = await h.waitNodes((l) => l.find((n) => /permission_allow_foreground_only_button$/.test(n['resource-id'] || '')), { timeout: 5000 })
    if (asked.hit) { console.log('  microphone permission asked: allowing while in use'); h.tapNode(asked.hit) }
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.t2c-voicebar')", 8000), `recording did not start (hint: ${await cdp.eval("document.querySelector('.t2c-hint')?.textContent || ''")})`)
    await h.pause(1500)
    shot('24-voice-recording')
    sent = stubLog.length
    await tapEl("document.querySelector('.t2c-voicebar button')") // stop → transcribe
    const done = "(document.querySelector('.t2c-hint')?.textContent || '') + '|' + (document.querySelector('.t2c-ta')?.value || '')"
    assert.ok(await h.waitPage(cdp, `!document.querySelector('.t2c-voicebar') && (${done}).length > 1`, 15000), 'the take never ended')
    const end = await cdp.eval(done)
    console.log(`  take ended with: ${end}`)
    assert.ok(end.includes('e2e transcript') || end.includes('没录到声音'), `neither a transcript nor the silence hint: ${end}`)
    await cdp.eval("(() => { const ta = document.querySelector('.t2c-ta'); if (ta && ta.value) { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })) } return true })()")
  })

  await check('share → Forsion: a share asks where it goes; a chat gets it in the message box (after what is typed, unsent), a document is attached, a note is written; a file path and our own provider are refused', async () => {
    const share = (...extra) => h.adb('shell', 'am', 'start', '-n', ACTIVITY, '-a', 'android.intent.action.SEND', ...extra)
    const shareText = (text) => share('-t', 'text/plain', '--es', 'android.intent.extra.TEXT', `'${text}'`)
    const draft = "document.querySelector('.t2c-ta')?.value"
    const setDraft = async (v) => assert.ok(await cdp.eval(`(() => { const ta = document.querySelector('.t2c-ta'); if (!ta) return false
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`), 'no message box on screen')
    const closeToasts = () => cdp.eval(`(async () => { for (let i = 0; i < 8; i++) { const b = document.querySelector('.ntf-close'); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)
    const chips = "[...document.querySelectorAll('.t2c-chiprow .attach-chip > span:first-of-type')].map((e) => e.textContent)"
    const toasts = "[...document.querySelectorAll('.ntf-text')].map((e) => e.textContent).join(' | ')"
    const inChat = "!!document.querySelector('.t2-userwrap')" // a message on screen = not a new chat
    const unsent = (from) => assert.ok(!stubLog.slice(from).some((l) => /^POST \S+\/agent\/runs/.test(l)), 'the share was sent on its own')
    /** The sheet a share lands on: its rows, then pick one. */
    const destination = async (want, to) => {
      const list = await waitSheet(true)
      assert.equal(textOf(list, 'nativeSheet.title'), '分享到 Forsion')
      assert.deepEqual(ids(list), want)
      assert.ok(resumed(), 'the app is not in front')
      if (to) { await tapId(`nativeSheet.item.${to}`, list); await waitSheet(false) }
      return list
    }
    pushPickFixtures()
    // The system offers the app for a share (the starts below name the activity, which would work without any filter).
    for (const [action, type] of [['android.intent.action.SEND', 'text/plain'], ['android.intent.action.SEND', 'image/png'], ['android.intent.action.SEND_MULTIPLE', 'application/pdf']]) {
      const offered = h.adb('shell', 'cmd', 'package', 'query-activities', '--brief', '-a', action, '-t', type)
      assert.ok(offered.includes(`${PKG}/com.forsion.tangu.MainActivity`), `not a share target for ${action} ${type}`)
    }
    await openChat('E2E Session One')
    await setDraft('typed first')
    let sent = stubLog.length
    // (1) the sheet: what is shared, the three places, and nothing moves before one is picked. Back = the share is dropped.
    shareText('Shared from the harness')
    const list = await destination(['new-chat', 'session', 'note'])
    assert.equal(rowLabel(list, 'nativeSheet.item.session'), '发到「E2E Session One」')
    assert.ok(list.some((n) => (n.text || '').includes('Shared from the harness')), 'the sheet does not say what is being shared')
    assert.ok(h.byId(list, 'nativeSheet.footer')?.text, 'footer note missing')
    shot('26-share-sheet')
    h.key(4)
    await waitSheet(false)
    await h.pause(600)
    assert.equal(await cdp.eval(draft), 'typed first', 'a cancelled share reached the message box')
    // (2) → the chat on screen: after what was typed, the chat stays, nothing is sent
    shareText('Shared from the harness')
    await destination(['new-chat', 'session', 'note'], 'session')
    assert.ok(await h.waitPage(cdp, `${draft} === 'typed first\\n\\nShared from the harness'`, 8000), `the shared text did not follow the typed draft (draft: ${JSON.stringify(await cdp.eval(draft))})`)
    assert.equal(await cdp.eval(inChat), true, 'the chat was left')
    unsent(sent)
    shot('27-share-to-chat')
    // (3) → a new chat
    await setDraft('')
    shareText('Second share')
    await destination(['new-chat', 'session', 'note'], 'new-chat')
    assert.ok(await h.waitPage(cdp, `${draft} === 'Second share' && !${inChat}`, 10000), `not a new chat holding the text (draft: ${JSON.stringify(await cdp.eval(draft))}, message on screen: ${await cdp.eval(inChat)})`)
    assert.equal(await cdp.eval("document.querySelector('.mb-shell')?.dataset.space"), 'tangu')
    unsent(sent)
    await setDraft('')
    // (4) a document, shared for real: the system Files app → Share → this app in the system share sheet. (A share started
    // from the shell cannot hand over a read grant, and the read grant is the point: the document is another app's.)
    // No note row for it (a note is its text); it is attached, like "Add files".
    h.adb('shell', 'am', 'force-stop', 'com.google.android.documentsui') // no selection left over from an earlier run
    h.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-t', 'vnd.android.document/root', '-d', 'content://com.android.providers.downloads.documents/root/downloads')
    const inFiles = (await h.waitNodes((l) => l.find((n) => /documentsui/.test(n.package || '') && n.text === PICK.small.name), { timeout: 12000 })).hit
    assert.ok(inFiles, `Files app: ${PICK.small.name} is not listed in Downloads`)
    h.longPress(inFiles)
    const shareAction = (await h.waitNodes((l) => h.byId(l, 'com.google.android.documentsui:id/action_menu_share'), { timeout: 6000 })).hit
    assert.ok(shareAction, 'Files app: no Share action for the selected file')
    h.tapNode(shareAction)
    const offered = await h.waitNodes((l) => l.find((n) => /intentresolver/.test(n.package || '') && /^Forsion/.test(n.text || '')), { timeout: 10000 })
    assert.ok(offered.hit, `the system share sheet does not offer the app (targets: ${offered.nodes.filter((n) => /intentresolver/.test(n.package || '') && n.text).map((n) => n.text).join(', ')})`)
    await h.pause(500)
    shot('28-system-share-sheet')
    h.tapAt(offered.hit.rect.cx, offered.hit.rect.top - 75) // its icon, above the label
    const fileSheet = await destination(['new-chat', 'session'])
    assert.ok(fileSheet.some((n) => (n.text || '').includes('1 个文件')), 'the sheet does not say a file is being shared')
    shot('28b-share-file-sheet')
    await tapId('nativeSheet.item.new-chat', fileSheet)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, `(${chips}).includes(${JSON.stringify(PICK.small.name)})`, 12000), `the shared document was not attached (chips: ${await cdp.eval(chips)}; toasts: ${await cdp.eval(toasts)})`)
    unsent(sent)
    shot('29-share-file')
    // (5) what another app must not be able to make us attach: a raw path, anything from our own providers, and an
    // address that only looks like someone else's — the WebView resolves `..` before it asks the local server, which
    // would turn the last two into that server's raw-file route for this app's own private files (the sign-in is there).
    // Each is named in the "not added" toast; there is nothing left to place, so no sheet, and the composer keeps what it had.
    const had = await cdp.eval(chips)
    const prefs = `data/data/${PKG}/shared_prefs/CapacitorStorage.xml`
    for (const [uri, name] of [
      [`file:///sdcard/Download/${PICK.small.name}`, PICK.small.name],
      [`content://${PKG}.fileprovider/root/${prefs}`, 'CapacitorStorage.xml'],
      [`content://x/../../_capacitor_file_/${prefs}`, 'CapacitorStorage.xml'],
      [`content://x/%2e%2e/%2e%2e/_capacitor_file_/${prefs}`, 'CapacitorStorage.xml'],
    ]) {
      await closeToasts() // the same name is refused more than once: each case reads its own toast
      share('-t', 'text/plain', '--eu', 'android.intent.extra.STREAM', uri)
      assert.ok(await h.waitPage(cdp, `[...document.querySelectorAll('.ntf-text')].some((e) => e.textContent.includes('没有添加') && e.textContent.includes(${JSON.stringify(name)}))`, 10000), `no refusal toast for ${uri} (toasts: ${await cdp.eval(toasts)})`)
      assert.equal(sheetOpen(ui()), false, `a sheet opened for ${uri}`)
      assert.deepEqual(await cdp.eval(chips), had, `the composer changed for ${uri}`)
      assert.ok(resumed(), 'the app is not in front')
      await h.pause(600)
    }
    // (6) → a note: the text as it came, in a note named after its first line (on the device's own vault: no server in it)
    const side = await cdp.eval('window.amadeusVaultMode.side')
    // raced against a timer: a switch that never settles is reported as that, not as the bridge's "Promise was collected"
    const vaultSide = async (to) => {
      const r = await cdp.eval(`Promise.race([window.amadeusVaultMode.switch(${JSON.stringify(to)}).then(() => 'done', (e) => 'rejected: ' + e), new Promise((r) => setTimeout(() => r('still pending after 15 s'), 15000))])`)
      assert.equal(r, 'done', `vault switch to ${to}: ${r} (side now ${await cdp.eval('window.amadeusVaultMode.side')})`)
    }
    const NOTE = 'E2E shared note'
    await closeToasts() // the refusals above: they sit where the note's first line is
    try {
      if (side !== 'local') await vaultSide('local')
      await cdp.eval(`window.amadeus.deletePage?.(${JSON.stringify(`${NOTE}.md`)}).then(() => true, () => true)`) // an earlier run's
      shareText(NOTE)
      await destination(['new-chat', 'session', 'note'], 'note')
      assert.ok(await h.waitPage(cdp, `window.amadeus.readTextFile(${JSON.stringify(`${NOTE}.md`)}).then((t) => t === ${JSON.stringify(`${NOTE}\n`)}, () => false)`, 10000), `the note was not written (toasts: ${await cdp.eval(toasts)})`)
      assert.ok(await h.waitPage(cdp, `[...document.querySelectorAll('.ntf-text')].some((e) => e.textContent.includes('已存为笔记「${NOTE}」'))`, 6000), `no receipt for the note (toasts: ${await cdp.eval(toasts)})`)
      // … and the user is taken to it: the note is the page on screen, its text in the editor
      assert.ok(await h.waitPage(cdp, `!document.querySelector('.t2c-ta') && [...document.querySelectorAll('[contenteditable="true"]')].some((e) => e.textContent.includes(${JSON.stringify(NOTE)}))`, 10000),
        `the note did not open (editable: ${await cdp.eval(`JSON.stringify([...document.querySelectorAll('[contenteditable]')].map((e) => e.className + ':' + e.textContent.slice(0, 40)))`)})`)
      assert.equal(textOf(ui(), 'nativeChrome.title'), NOTE, 'the top bar does not name the note')
      await closeToasts()
      await h.pause(600)
      shot('30-share-note')
    } finally {
      await cdp.eval(`window.amadeus.deletePage?.(${JSON.stringify(`${NOTE}.md`)}).then(() => true, () => true)`).catch(() => {})
      if (side !== 'local') await vaultSide(side)
    }
    // (7) what the task is started with again when it comes back from Recents is its last intent — not a second share
    // (the plugin says so in the log: the absence of a sheet alone would also be what a share that never arrived looks like)
    const skips = (why) => h.adb('logcat', '-d', '-s', 'ShareInbox:D').split('\n').filter((l) => l.includes('not a new share') && l.includes(why)).length
    await openChat('E2E Session One') // back from the note
    await setDraft('')
    let skipped = skips('from Recents')
    share('-f', '0x10100000', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT', "'Old share'") // NEW_TASK | LAUNCHED_FROM_HISTORY
    await h.pause(3000)
    assert.equal(sheetOpen(ui()), false, 'an intent replayed from Recents was taken as a new share')
    assert.equal(await cdp.eval(draft), '')
    assert.equal(skips('from Recents'), skipped + 1, 'the replayed intent did not reach the plugin (flag stripped?)')
    // (8) cold: the app is not running. The share starts it and is kept until the page gets to listen.
    const boot = async () => {
      cdp = await h.connect(PKG)
      await cdp.send('Page.enable')
      await installStub(cdp)
      assert.ok(await h.waitPage(cdp, dom.shellUp, 30000), 'shell did not mount after the cold start')
    }
    cdp.close()
    h.adb('shell', 'am', 'force-stop', PKG)
    shareText('Cold share')
    await boot()
    const cold = await waitSheet(true, 30000)
    assert.equal(textOf(cold, 'nativeSheet.title'), '分享到 Forsion')
    assert.ok(cold.some((n) => (n.text || '').includes('Cold share')), 'the sheet does not say what is being shared')
    await tapId('nativeSheet.item.new-chat', cold)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, `${draft} === 'Cold share'`, 10000), `the cold share did not reach the message box (draft: ${JSON.stringify(await cdp.eval(draft))})`)
    // (9) … and it is acted on once: the system kills the app in the background, the user comes back, the activity is
    // re-created with that same launch intent — no second sheet.
    cdp.close()
    skipped = skips('activity recreated')
    h.key(3) // home: the activity saves its state
    await h.pause(1500)
    const pid = () => h.adb('shell', 'pidof', PKG, '||', 'true').trim()
    h.adb('shell', 'am', 'kill', PKG)
    await h.pause(800)
    if (pid()) { runAs('kill', '-9', pid()); await h.pause(800) } // not cached yet (a service still bound): end it like the low-memory killer would
    assert.equal(pid(), '', 'the backgrounded app was not killed')
    h.adb('shell', 'am', 'start', '-n', ACTIVITY)
    await boot()
    await h.pause(4000)
    assert.equal(sheetOpen(ui()), false, 'the launch share came back after the activity was re-created')
    assert.equal(skips('activity recreated'), skipped + 1, 'the activity was not re-created with the share as its launch intent: this case proved nothing')
    await reload() // a clean stubbed boot (the cold starts' first requests went out before the stub)
  })
  // Leave a clean stage (see the same block before the voice check): no attachments, no toast over the drawer's top.
  try {
    await cdp.eval(`(async () => { for (const sel of ['.t2c-chiprow .attach-chip button', '.ntf-close']) for (let i = 0; i < 8; i++) {
      const b = document.querySelector(sel); if (!b) break; b.click(); await new Promise((r) => setTimeout(r, 150)) } return true })()`)
  } catch { /* page reloading */ }

  await check('project selector (new chat): native list, pick a cloud project, add-cloud opens a prompt', async () => {
    await tanguDrawer()
    await tapEl(`document.querySelector('.mb-drawer--left [data-act="new-chat"]')`)
    assert.ok(await h.waitPage(cdp, `!(${drawerOpen}) && !!document.querySelector('.project-pill')`, 6000), 'new chat composer has no project pill')
    await h.pause(600)
    await tapEl("document.querySelector('.project-pill')")
    let list = await waitSheet(true)
    const got = ids(list)
    const alpha = got.find((x) => x.startsWith('ws:') && x.endsWith('E2E Alpha'))
    assert.ok(alpha && got.some((x) => x.endsWith('E2E Beta')) && got.includes('add-cloud'), `project ids: ${got}`)
    assert.equal(await cdp.eval("!!document.querySelector('.project-pill.is-open')"), false, 'web project menu opened as well')
    shot('24-project-sheet-light')
    await tapId(`nativeSheet.item.${alpha}`, list)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, "document.querySelector('.project-pill')?.textContent.includes('E2E Alpha')", 4000), 'pill does not show the picked project')
    await tapEl("document.querySelector('.project-pill')")
    list = await waitSheet(true)
    assert.equal(h.byId(list, `nativeSheet.item.${alpha}`).checked, 'true', 'picked project not checked')
    const sent = stubLog.length
    await tapId('nativeSheet.item.add-cloud', list)
    list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.prompt.field'), 'add-cloud prompt missing')
    h.key(4)
    await h.pause(400)
    if (sheetOpen(ui())) h.key(4)
    await waitSheet(false)
    await h.pause(400)
    assert.ok(!stubLog.slice(sent).some((l) => /^POST \S+\/agent\/projects/.test(l)), 'cancel created a project')
  })

  await check('more sheet runs a command (theme mode) — dark renders', async () => {
    const mode = await cdp.eval(dom.mode)
    await tapId('nativeChrome.more')
    const list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.item.rb-mode'), 'theme mode command missing')
    assert.ok(!h.byId(list, 'nativeSheet.item.rb-settings') && !h.byId(list, 'nativeSheet.item.rb-account'), 'neither the account (the avatar) nor settings (in its menu) belongs in ⋯')
    // a phone has no ⌘K: what the desktop calls the command palette is "Search" here (same panel)
    assert.equal(rowLabel(list, 'nativeSheet.item.rb-cmd'), '搜索')
    assert.equal(ids(list)[0], 'tab:new', '"New tab" does not lead the ⋯ sheet')
    shot('05-more-sheet-light')
    await tapId('nativeSheet.item.rb-mode', list)
    await waitSheet(false)
    assert.equal(await h.waitPage(cdp, `(${dom.mode}) !== ${JSON.stringify(mode)} && (${dom.mode})`, 5000), 'dark')
    await h.pause(700) // the bar repaints from the MutationObserver
    shot('06-shell-dark')
    await tapId('nativeChrome.more')
    await waitSheet(true)
    shot('07-more-sheet-dark')
    h.key(4)
    await waitSheet(false)
    assert.equal(await cdp.eval(dom.mode), 'dark', 'cancel must not run anything')
    const closeTabs = await tabsSheet()
    shot('08-tabs-sheet-dark')
    await closeTabs()
  })

  await check('page reload dismisses an open native sheet and the bar comes back', async () => {
    await tapId('nativeChrome.more')
    await waitSheet(true)
    await reload()
    assert.ok(!sheetOpen(ui()), 'sheet survived the reload')
  })

  const FOLDER = `E2E${Date.now() % 1000000}` // unique per run; dissolved again below
  const folderTiles = `[...document.querySelectorAll('.hp-tile')].filter((e) => e.textContent.includes('${FOLDER}')).length`
  await check('prompt (askString): homepage "new folder" returns typed text to the web side', async () => {
    await goHome()
    assert.equal(await cdp.eval(folderTiles), 0, 'fixture name already present')
    const openPrompt = newFolderPrompt
    await openPrompt()
    let list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.prompt.field'), 'prompt field missing')
    await h.pause(500)
    shot('09-prompt-keyboard')
    // clear the prefilled name, type ours, confirm with the IME action (Done)
    for (let i = 0; i < 12; i++) h.key(67)
    h.adb('shell', 'input', 'text', FOLDER)
    await h.pause(300)
    h.key(66)
    let closed = await h.waitNodes((l) => (!sheetOpen(l) ? l : null), { timeout: 3000 })
    if (!closed.hit) { await tapId('nativeSheet.prompt.ok'); closed = await h.waitNodes((l) => (!sheetOpen(l) ? l : null), { timeout: 3000 }) }
    assert.ok(closed.hit, 'prompt did not close')
    assert.ok(await h.waitPage(cdp, `(${folderTiles}) > 0`, 5000), 'typed folder name did not reach the web side')
    await h.pause(400)
    shot('10-prompt-result')
    // cancel path: system back = nothing created
    const count = await cdp.eval(folderTiles)
    await openPrompt()
    list = await waitSheet(true)
    h.key(4) // first back may only hide the IME
    await h.pause(400)
    if (sheetOpen(ui())) h.key(4)
    await waitSheet(false)
    assert.ok(resumed(), 'back left the app')
    assert.equal(await cdp.eval(folderTiles), count, 'cancel changed the folders')
  })
  // Also the cleanup: the fixture folder is dissolved through the homepage folder menu (state-driven hook).
  await check('homepage folder menu (useNativeSheetMenu): native sheet titled with the folder, dissolve runs', async () => {
    assert.ok(await cdp.eval(`(${folderTiles}) > 0`), 'fixture folder missing (prompt check failed?)')
    await cdp.eval(`(() => { const el = [...document.querySelectorAll('.hp-tile')].find((e) => e.textContent.includes('${FOLDER}')); const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 })); return true })()`)
    const list = await waitSheet(true)
    assert.equal(textOf(list, 'nativeSheet.title'), FOLDER)
    assert.deepEqual(ids(list), ['rename', 'dissolve'])
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'web menu rendered as well')
    shot('11a-folder-menu-native')
    await tapId('nativeSheet.item.dissolve', list)
    await waitSheet(false)
    assert.ok(await h.waitPage(cdp, `(${folderTiles}) === 0`, 5000), 'folder not dissolved')
  })
  try { await cdp.eval("(document.querySelector('.hp-organizer-stage')?.click(), true)") } catch { /* creating a folder opened the organizer layer */ }
  if (failed) { // a failed run must not leave fixture folders behind: dissolve through the web menu if present
    try {
      await cdp.eval(`(async () => { const el = [...document.querySelectorAll('.hp-tile')].find((e) => e.textContent.includes('${FOLDER}')); if (!el) return true
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await new Promise((r) => setTimeout(r, 300))
        document.querySelectorAll('.ctx-menu button')[1]?.click(); return true })()`)
      if (sheetOpen(ui())) await tapId('nativeSheet.item.dissolve')
    } catch { /* best effort */ }
  }

  await check('context menu primitive (AgentSelectStrip long-press) opens natively and runs its action', async () => {
    const pill = await h.waitPage(cdp, "!!document.querySelector('[data-agent-slug=\"e2e-agent\"]')", 12000)
    assert.ok(pill, `agent fixture did not render (stub log: ${stubLog.slice(-12).join(', ')})`)
    await cdp.eval("(window.__e2eCtx = 0, window.addEventListener('contextmenu', () => window.__e2eCtx++, true), true)")
    const node = (await h.waitNodes((l) => l.find((n) => n.text === 'E2E Agent' || n['content-desc'] === 'E2E Agent'), { timeout: 4000 })).hit
    console.log('  long-press target:', node ? `${node.class} ${node.bounds}` : 'not in a11y tree → synthetic contextmenu')
    if (node) h.longPress(node)
    else await cdp.eval(`(() => { const el = document.querySelector('[data-agent-slug="e2e-agent"]'); const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 })); return true })()`)
    await h.pause(300)
    console.log('  contextmenu events:', await cdp.eval('window.__e2eCtx'), 'web menu:', await cdp.eval("!!document.querySelector('.ctx-menu')"))
    const list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.item.0'), 'menu item missing')
    assert.equal(await cdp.eval("!!document.querySelector('.ctx-menu')"), false, 'web menu rendered as well')
    shot('11-context-menu-native')
    const sent = stubLog.length
    await tapId('nativeSheet.item.0', list)
    await waitSheet(false)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !stubLog.slice(sent).some((l) => l.includes('/agent/solo/agent/e2e-agent/open'))) await h.pause(200)
    assert.ok(stubLog.slice(sent).some((l) => l.includes('/agent/solo/agent/e2e-agent/open')), `action did not run (requests: ${stubLog.slice(sent).join(', ')})`)
  })

  await check('confirm kind renders and answers through the plugin (ok + cancel)', async () => {
    const theme = await cdp.eval(`(() => { const d = document.documentElement.dataset.mode === 'dark'; return { dark: d, background: d ? '#FF1E2022' : '#FFF8F7F6', surface: d ? '#FF26292B' : '#FFFFFFFF', text: d ? '#FFECEEF0' : '#FF202124', muted: '#FF8A8D93', border: '#1F808080', accent: '#FF4D8794', onAccent: '#FFFFFFFF', danger: '#FFD04040' } })()`)
    const call = (id) => cdp.eval(`(window.__e2eConfirm = Capacitor.Plugins.NativeSheet.present(${JSON.stringify({ requestId: id, kind: 'confirm', title: '删除这个收纳夹?', message: '只解散收纳夹,里面的 Space 不受影响。', confirm: '删除', cancel: '取消', danger: true, theme })}).then((r) => (window.__e2eConfirmResult = r)), true)`)
    await call('e2e-confirm-1')
    let list = await waitSheet(true)
    shot('12-confirm-dark')
    await tapId('nativeSheet.confirm.ok', list)
    assert.deepEqual(await h.waitPage(cdp, 'window.__e2eConfirmResult', 5000), { result: { ok: true } })
    await waitSheet(false)
    await cdp.eval('window.__e2eConfirmResult = null')
    await call('e2e-confirm-2')
    list = await waitSheet(true)
    h.key(4)
    assert.deepEqual(await h.waitPage(cdp, 'window.__e2eConfirmResult', 5000), { cancelled: true })
    await waitSheet(false)
    assert.ok(resumed())
  })

  await check('prompt: input past 100,000 chars is clipped in the field and confirm still returns text (not a silent cancel)', async () => {
    const MAX = 100000
    // 60,000 chars on the clipboard, pasted twice after a 4-char seed. Written while the WebView has focus (no sheet up).
    const wrote = await cdp.send('Runtime.evaluate', { expression: "navigator.clipboard.writeText('x'.repeat(60000)).then(() => 'ok', (e) => String(e))", awaitPromise: true, returnByValue: true, userGesture: true })
    assert.equal(wrote.result?.value, 'ok', 'could not put the long text on the clipboard')
    const theme = await cdp.eval(`(() => { const d = document.documentElement.dataset.mode === 'dark'; return { dark: d, background: d ? '#FF1E2022' : '#FFF8F7F6', surface: d ? '#FF26292B' : '#FFFFFFFF', text: d ? '#FFECEEF0' : '#FF202124', muted: '#FF8A8D93', border: '#1F808080', accent: '#FF4D8794', onAccent: '#FFFFFFFF', danger: '#FFD04040' } })()`)
    await cdp.eval(`(window.__e2ePrompt = null, Capacitor.Plugins.NativeSheet.present(${JSON.stringify({ requestId: 'e2e-prompt-clamp', kind: 'prompt', title: 'E2E clamp', initial: 'seed', confirm: 'OK', cancel: 'Cancel', theme })}).then((r) => (window.__e2ePrompt = { cancelled: !!r.cancelled, length: r.result ? r.result.text.length : -1, head: r.result ? r.result.text.slice(0, 8) : '', tail: r.result ? r.result.text.slice(-4) : '' }), (e) => (window.__e2ePrompt = { error: String(e && e.message || e) })), true)`)
    let list = await waitSheet(true)
    assert.equal(textOf(list, 'nativeSheet.prompt.field'), 'seed')
    await tapId('nativeSheet.prompt.field', list)
    await h.pause(400)
    h.key(123) // MOVE_END
    h.key(279) // PASTE
    await h.pause(1500)
    h.key(279)
    await h.pause(2500)
    list = ui()
    // Only proves the paste arrived: accessibility text is itself cut at 100,000 chars, so it reads the same with or
    // without the clip. The answer below is what tells them apart (unclipped input used to come back as a cancel).
    const held = textOf(list, 'nativeSheet.prompt.field').length
    assert.ok(held >= MAX, `paste did not arrive: the field holds ${held} chars`)
    await tapId('nativeSheet.prompt.ok', list)
    const out = await h.waitPage(cdp, 'window.__e2ePrompt', 8000)
    assert.deepEqual(out, { cancelled: false, length: MAX, head: 'seedxxxx', tail: 'xxxx' })
    await waitSheet(false)
  })

  await check('page mode (back + title) renders and reports back; shell state returns', async () => {
    const theme = await cdp.eval(`({ dark: true, background: '#FF1E2022', surface: '#FF26292B', text: '#FFECEEF0', muted: '#FF8A8D93', border: '#1F808080', accent: '#FF4D8794', onAccent: '#FFFFFFFF', danger: '#FFD04040' })`)
    await cdp.eval(`(window.__e2eActions = [], Capacitor.Plugins.NativeChrome.addListener('action', (e) => window.__e2eActions.push(e.action)), true)`)
    await cdp.eval(`Capacitor.Plugins.NativeChrome.setState(${JSON.stringify({ mode: 'page', title: '设置', back: '返回', theme, icons: {} })}).then(() => true)`)
    const r = await h.waitNodes((l) => h.byId(l, 'nativeChrome.back'), { timeout: 4000 })
    assert.ok(r.hit, 'page back button missing')
    assert.ok(!h.byId(r.nodes, 'nativeChrome.more'), 'shell buttons in page mode')
    assert.equal(descOf(r.nodes, 'nativeChrome.back'), '返回')
    shot('13-page-mode')
    h.tapNode(h.byId(r.nodes, 'nativeChrome.back'))
    assert.deepEqual(await h.waitPage(cdp, "window.__e2eActions.length && window.__e2eActions", 4000), ['back'])
    await reload() // the app's host pushes its own (shell) state again
    assert.ok(h.byId(ui(), 'nativeChrome.more'), 'shell state did not return')
  })

  // ── Android plugins (merged feat/android-plugins × native shell): market as a native page, native download from the
  // host, plugin commands in the native ⋯ sheet, the plugin running inside the WebView (CSP + new Function), a cold
  // restart, and uninstall removing its files. Plus the model sheet. Dark / English shots further down.
  const pluginFiles = () => runAs('ls', `files/plugins/${PLUGIN_ID}`).split(/\s+/).filter(Boolean)
  // One uiautomator dump of a content-heavy WebView takes 3–5 s on the emulator, so a 6 s window can end after a
  // single dump that started just before the sheet appeared. The plugin checks poll with a longer window.
  const SLOW = 15000
  const marketOpen = "!!document.querySelector('[data-mobile-market] .mk-page')"
  const marketWeb = `(() => { const p = document.querySelector('[data-mobile-market] .mk-page'); if (!p) return null
    const d = (s) => { const e = p.querySelector(s); return e ? getComputedStyle(e).display : 'absent' }
    return { native: p.hasAttribute('data-native-chrome'), top: d('.settings-nav-top'), pills: d('.settings-nav-list'), detailBack: d('.mk-detail-back'),
      brand: p.querySelector('.mk-nav-brand strong')?.textContent.trim() || '' } })()`
  const pluginItem = (id) => `nativeSheet.item.cmd:${id}`
  /** ⋯ → market: page bar titled like the (hidden) web brand, back only; web back + brand hidden, category pills kept. */
  async function openMarket(lang) {
    await tapId('nativeChrome.more')
    const list = await waitSheet(true, SLOW)
    await tapId('nativeSheet.item.rb-market', list)
    await waitSheet(false, SLOW)
    assert.ok(await h.waitPage(cdp, marketOpen, 6000), 'market did not open')
    await h.pause(400)
    const web = await cdp.eval(marketWeb)
    const r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.back') && web.brand && textOf(l, 'nativeChrome.title') === web.brand ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `market: no page bar titled "${web.brand}" (title=${textOf(r.nodes, 'nativeChrome.title')})`)
    assert.ok(!h.byId(r.nodes, 'nativeChrome.more') && !h.byId(r.nodes, 'nativeChrome.close'), 'market list page: back only')
    assert.ok(web.native && web.top === 'none' && web.pills !== 'none' && web.pills !== 'absent', `market web head: ${JSON.stringify(web)}`)
    if (lang === 'en') assert.ok(!hasCjk(r.nodes.filter((n) => (n['resource-id'] || '').startsWith('nativeChrome.'))), 'Chinese in the English market bar')
    assert.ok(await h.waitPage(cdp, `!!document.querySelector('[data-market-install="${PLUGIN_ID}"], [data-market-uninstall="${PLUGIN_ID}"]')`, 10000),
      `market card missing (stub: ${stubLog.filter((l) => l.includes('/market/')).slice(-4).join(' | ')})`)
    await h.pause(500)
    return r.nodes
  }
  async function closeMarket() {
    await tapId('nativeChrome.back')
    assert.ok(await h.waitPage(cdp, `!(${marketOpen})`, 5000), 'back did not close the market')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })).hit, 'shell bar did not return after the market')
  }
  // saveData counter as last observed: every run must add exactly one (an earlier failed check must not cascade)
  let pluginRuns = 0
  async function runPluginCommand() {
    await tapId('nativeChrome.more')
    const list = await waitSheet(true, SLOW)
    assert.ok(h.byId(list, pluginItem(PLUGIN_CMD)), `plugin command not in ⋯: ${ids(list)}`)
    await tapId(pluginItem(PLUGIN_CMD), list)
    await waitSheet(false, SLOW)
    const runs = Number(await h.waitPage(cdp, "document.querySelector('[data-e2e-plugin-view]')?.dataset.e2eRuns", 8000))
    const prev = pluginRuns
    if (runs) pluginRuns = runs
    assert.equal(runs, prev + 1, 'plugin view (runs = loadData/saveData across runs)')
    assert.equal(await cdp.eval("document.querySelector('[data-e2e-plugin-view]')?.dataset.e2eEval"), '42', 'new Function inside the plugin under the app CSP')
    await h.pause(500)
  }
  /** Composer model pill → the Compose model sheet lists the stubbed catalog; the web menu stays closed. */
  async function modelSheet(name) {
    await openChat('E2E Session One')
    await tapEl("document.querySelector('.model-pill-btn')")
    const r = await h.waitNodes((l) => (l.some((n) => n.text === 'E2E Model Beta') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, 'native model sheet did not list the catalog')
    assert.equal(await cdp.eval("!!document.querySelector('.cm-advanced-reveal')"), false, 'web model menu rendered as well')
    await h.pause(400)
    shot(name)
    h.key(4)
    assert.ok((await h.waitNodes((l) => (!l.some((n) => n.text === 'E2E Model Beta') ? l : null), { timeout: 5000 })).hit, 'model sheet did not close on back')
  }

  await check('plugins: ⋯ → market is a native page; install downloads natively from the host; detail adds ×', async () => {
    // the checks above leave the app dark (theme-mode command): this block's shots are the light pass
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light'); true")
    await reload()
    await openMarket('zh')
    shot('p01-market-light')
    assert.ok(stubLog.some((l) => /^GET \S*\/market\/items$/.test(l)), 'market list never requested')
    const hits = pluginHits.length
    await tapEl(`document.querySelector('[data-market-install="${PLUGIN_ID}"]')`)
    const notice = await h.waitPage(cdp, "document.querySelector('[data-market-notice]')?.dataset.marketNotice", 20000)
    assert.equal(notice, 'ok', `install notice: ${await cdp.eval("document.querySelector('[data-market-notice]')?.innerText")}`)
    const dl = pluginHits.slice(hits).find((x) => x.url === `/${PLUGIN_ID}.zip`)
    assert.ok(dl, `host server never saw the download (hits: ${JSON.stringify(pluginHits.slice(hits))})`)
    assert.ok(!/Mozilla|Chrome/.test(dl.ua), `download did not come from the native downloader (UA: ${dl.ua})`)
    const files = pluginFiles()
    assert.ok(files.includes('manifest.json') && files.includes('main.js'), `files/plugins/${PLUGIN_ID}: ${files.join(' ')}`)
    await h.pause(300)
    shot('p02-market-installed-light')
    // detail page: title = item name, back → list, × → leave the market (the list re-scans after an install)
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.mk-featured-copy h2')", 20000), 'market list did not come back after the install')
    await tapEl("document.querySelector('.mk-featured-copy h2')")
    let r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === 'E2E Native Hello' && h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `detail: title + × expected (title=${textOf(r.nodes, 'nativeChrome.title')})`)
    assert.equal((await cdp.eval(marketWeb)).detailBack, 'none', 'web "back to list" still shown under the native bar')
    await h.pause(400)
    shot('p03-market-detail-light')
    await tapId('nativeChrome.back', r.nodes)
    const brand = (await cdp.eval(marketWeb)).brand
    r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === brand && !h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 5000 })
    assert.ok(r.hit && await cdp.eval(marketOpen), 'detail back did not return to the market list')
    await closeMarket()
  })

  // 2026-10-09: the phone host never read the Spaces plugins ship (spaces/<slug>/space.json) — commands and views were
  // there after an install, the Space was not. Most store plugins declare their Space this way.
  await check('plugins: the Space a plugin ships joins the bottom bar with the plugin\'s own picture and opens on its main view', async () => {
    assert.match(runAs('ls', `files/plugins/${PLUGIN_ID}/spaces/desk`), /space\.json/, 'the Space recipe was not written with the plugin')
    // the plugin also ships a Space with a 200-character name: the native bars must still be there
    assert.ok((await h.waitNodes((l) => (h.byId(l, 'nativeChrome.bar') && h.byId(l, 'nativeChrome.spaces') ? l : null), { timeout: 8000 })).hit,
      'the native bars went away after the install (a Space label the native side refuses?)')
    await toSpace(PLUGIN_SPACE) // fails with "is not in the native bar" when the Space was not registered
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.mb-main [data-e2e-plugin-view]')", 8000), 'the Space did not open the plugin view its recipe names')
    // A recipe Space is main-first on the phone even with a left panel (written for the desktop's three columns, the
    // panel may not lead into the main view at all): no list level, the bar stays, the panel is a drawer.
    assert.equal(await cdp.eval(nav), '', 'a recipe Space must open on its main view, not on its left panel')
    const cellId = `nativeChrome.space.${PLUGIN_SPACE}`
    // the picture goes out with a second push (converted off the bar's path): wait for it
    const r = await h.waitNodes((l) => { const c = h.byId(l, cellId); return c && h.byIdPrefix(l, 'nativeChrome.spacePicture').some((n) => within(c, n)) ? l : null }, { timeout: 10000 })
    assert.ok(h.byId(r.nodes, 'nativeChrome.spaces') && h.byId(r.nodes, cellId), 'the bottom bar must stay on a main-first Space')
    assert.ok(h.byId(r.nodes, 'nativeChrome.left'), 'the recipe\'s left panel must be reachable (drawer button)')
    assert.equal(h.byId(r.nodes, cellId).selected || h.byId(r.nodes, cellId).checked, 'true', 'the plugin Space is not the selected cell')
    assert.ok(r.hit, 'the cell shows no picture (the plugin\'s icon.png)')
    const pic = h.byIdPrefix(r.hit, 'nativeChrome.spacePicture').find((n) => within(h.byId(r.hit, cellId), n))
    const px = pixelAt(pic.rect.cx, pic.rect.cy)
    assert.ok(PLUGIN_ICON_RGB.every((v, i) => Math.abs(v - [px.r, px.g, px.b][i]) <= 8), `the cell's picture is not the plugin icon: ${JSON.stringify(px)}`)
    shot('p02b-plugin-space')
    await goHome() // where the install check left the app
  })

  await check('plugins: oversized downloads (declared > 25 MB, endless stream) are refused by the native capped download; cache and files/plugins stay clean', async () => {
    const cacheLeft = () => runAs('ls', '-a', 'cache').split(/\s+/).filter((n) => n.startsWith('forsion-market-'))
    assert.deepEqual(cacheLeft(), [], 'precondition: temp files of an earlier download still in cache')
    for (const id of [BIG_DECLARED, BIG_ENDLESS]) {
      const hits = pluginHits.length
      // the same entry the market UI calls (marketService → window.tangu.marketInstall); not awaited: the endless one runs to the cap
      await cdp.eval(`(window.__e2eBig = null, window.tangu.marketInstall(${JSON.stringify(id)}).then((r) => (window.__e2eBig = { ok: true }), (e) => (window.__e2eBig = { ok: false, error: String(e && e.message || e) })), true)`)
      // while it runs, watch the temp file: the disk must never hold more than the cap
      let out = null
      let peak = 0
      for (const end = Date.now() + 90000; Date.now() < end && !out;) {
        for (const m of runAs('ls', '-l', 'cache').matchAll(/\s(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+forsion-market-/g)) peak = Math.max(peak, Number(m[1]))
        out = await cdp.eval('window.__e2eBig')
      }
      const left = cacheLeft() // right away: MarketDownloadPlugin.load() sweeps leftovers on the next launch, which would hide a leak
      const served = bigServed[`/${id}.zip`]
      const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10
      console.log(`  ${id}: ${JSON.stringify(out)} · temp file peak ${mb(peak)} MB · host wrote ${served ? mb(served.sent) : '?'} MB before the hang-up (tunnel buffers included)`)
      assert.ok(peak <= 25 * 1024 * 1024, `${id}: the temp file grew to ${peak} bytes, past the 25 MB cap`)
      assert.ok(out && out.ok === false && /too large/.test(out.error), `${id}: expected the size error, got ${JSON.stringify(out)}`)
      const dl = pluginHits.slice(hits).find((x) => x.url === `/${id}.zip`)
      assert.ok(dl && !/Mozilla|Chrome/.test(dl.ua), `${id}: not fetched by the native downloader (${JSON.stringify(pluginHits.slice(hits))})`)
      assert.deepEqual(left, [], `${id}: temp file left in the app cache`)
      assert.match(runAs('ls', `files/plugins/${id}`), /No such file/, `${id}: something was written under files/plugins`)
    }
    // the endless stream must have been cut by the client around the cap, not run to the host's hard stop
    await h.pause(500)
    const endless = bigServed[`/${BIG_ENDLESS}.zip`]
    assert.ok(endless.closedEarly && endless.sent < BIG_ENDLESS_STOP, `endless stream was not aborted by the client (sent ${endless.sent})`)
  })

  await check('plugins: reinstall over the installed plugin (update switch on the real filesystem): new version live, no .staging- / .backup- left', async () => {
    const version = () => { try { return JSON.parse(runAs('cat', `files/plugins/${PLUGIN_ID}/manifest.json`)).version } catch { return null } }
    assert.equal(version(), '1.0.0', 'precondition: the fixture plugin is installed')
    const v1 = pluginZip
    pluginZip = pluginZipV2
    try {
      await openMarket('zh')
      const hits = pluginHits.length
      await tapEl(`document.querySelector('[data-market-install="${PLUGIN_ID}"]')`) // installed card: the button reads "reinstall"
      const end = Date.now() + 30000
      while (Date.now() < end && version() !== '1.0.1') await h.pause(500)
      assert.ok(pluginHits.slice(hits).some((x) => x.url === `/${PLUGIN_ID}.zip`), 'reinstall did not download the package again')
      assert.equal(version(), '1.0.1', 'the installed directory was not switched to the new version')
      const notice = await h.waitPage(cdp, "document.querySelector('[data-market-notice]')?.dataset.marketNotice", 20000)
      assert.equal(notice, 'ok', `reinstall notice: ${await cdp.eval("document.querySelector('[data-market-notice]')?.innerText")}`)
      const names = runAs('ls', '-a', 'files/plugins').split(/\s+/).filter((n) => n && n !== '.' && n !== '..')
      console.log('  files/plugins after the switch:', names.join(' '))
      assert.deepEqual(names.filter((n) => n.startsWith('.staging-') || n.startsWith('.backup-')), [], 'staging / backup directory left behind')
      const files = pluginFiles()
      assert.ok(files.includes('manifest.json') && files.includes('main.js'), `files/plugins/${PLUGIN_ID}: ${files.join(' ')}`)
      assert.equal(await cdp.eval(`(async () => (await window.amadeus.listPlugins()).find((p) => p.id === '${PLUGIN_ID}')?.version ?? null)()`), '1.0.1', 'host does not list the new version')
      assert.ok(await h.waitPage(cdp, "!!document.querySelector('.mk-featured-copy h2')", 20000), 'market list did not come back after the reinstall')
      await closeMarket()
    } finally {
      pluginZip = v1
    }
  })

  await check('plugins: commands listed in the native ⋯ under the plugin (toggle state shown); one opens the plugin view', async () => {
    await tapId('nativeChrome.more')
    let list = await waitSheet(true, SLOW)
    for (const id of [PLUGIN_CMD, PLUGIN_TOGGLE]) assert.ok(h.byId(list, pluginItem(id)), `missing ${id}: ${ids(list)}`)
    assert.ok(list.some((n) => n.text === 'E2E Native Hello'), 'plugin section title (= plugin name) missing')
    // Compose `selected` semantics surface in uiautomator as checkable/checked (not `selected`)
    assert.equal(h.byId(list, pluginItem(PLUGIN_TOGGLE)).checked, 'false', 'toggle starts off')
    shot('p04-more-plugin-light')
    await tapId(pluginItem(PLUGIN_TOGGLE), list)
    await waitSheet(false, SLOW)
    await tapId('nativeChrome.more')
    list = await waitSheet(true, SLOW)
    const on = h.byId(list, pluginItem(PLUGIN_TOGGLE))
    assert.equal(on.checked, 'true', `toggle state not reflected after running it: ${JSON.stringify({ ...on, rect: undefined })}`)
    await tapId(pluginItem(PLUGIN_TOGGLE), list) // back off
    await waitSheet(false, SLOW)
    await runPluginCommand()
    const csp = await cdp.eval("(/script-src[^;]*/.exec(document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.getAttribute('content') || '') || [''])[0]")
    assert.ok(csp.includes("'unsafe-eval'"), `CSP: ${csp}`)
    shot('p05-plugin-view-light')
  })

  await check('model pill opens the native model sheet (stubbed catalog)', async () => {
    await modelSheet('p06-model-sheet-light')
  })

  /** Settings → Plugins → Forsion plugins as a native page (the card list that painted scrambled under software GL). */
  async function settingsPluginsPage(name) {
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    await h.pause(400)
    if (!(await cdp.eval(`!!document.querySelector('[data-settings-sub="pl-forsion"]')`))) await tapEl(`document.querySelector('[data-settings-tab="amadeus-plugins"]')`)
    await tapEl(`document.querySelector('[data-settings-sub="pl-forsion"]')`)
    assert.ok(await h.waitPage(cdp, `!document.querySelector('.settings-page--mobile-menu') && !!document.querySelector('[data-plugin-id="${PLUGIN_ID}"]')`, 8000), 'installed plugin not listed in Settings → Forsion plugins')
    const r = await h.waitNodes((l) => (h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 5000 })
    assert.ok(r.hit, 'plugins page: native bar without ×')
    await h.pause(800)
    shot(name)
    await tapId('nativeChrome.close', r.nodes)
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), '× did not close settings')
    await closeDrawer()
  }
  await check('Settings → Forsion plugins lists the installed plugin under the native bar (light)', async () => {
    await settingsPluginsPage('p08-settings-plugins-light')
  })

  // ── system notifications: the island's answer buttons, and in-app notifications mirrored while the app is away ──
  /** This app's notifications as the system holds them (dumpsys, its "Notification List" only; raw = the record's dump). */
  const notifications = () => {
    const out = h.adb('shell', 'dumpsys', 'notification', '--noredact').split('\n')
    const list = []
    let cur = null
    for (const l of out.slice(out.findIndex((x) => x.startsWith('  Notification List:')) + 1)) {
      if (/^ {2}\S/.test(l)) break
      const rec = l.match(/NotificationRecord\(\S+ pkg=(\S+) user=\S+ id=(\d+) tag=(\S+) /)
      if (rec) { cur = rec[1] === PKG ? { id: Number(rec[2]), tag: rec[3], raw: '' } : null; if (cur) list.push(cur) }
      if (cur) cur.raw += `${l}\n`
    }
    return list.map((n) => ({
      ...n,
      title: n.raw.match(/android\.title=String \((.*)\)/)?.[1] ?? '',
      text: n.raw.match(/android\.text=String \((.*)\)/)?.[1] ?? '',
      bigText: n.raw.match(/android\.bigText=String \(([\s\S]*?)\)\n/)?.[1] ?? '',
      actions: [...n.raw.matchAll(/^\s*\[\d+\] "(.*)" -> PendingIntent/gm)].map((a) => a[1]),
      ongoing: /flags=\S*ONGOING_EVENT/.test(n.raw),
    }))
  }
  const ISLAND = 7201 // LiveIslandPlugin: ID (the ongoing island), EVENT_ID = 7202 (one tag per kind of event), DONE_ID = 7203
  const island = () => notifications().find((n) => n.id === ISLAND)
  const eventNotes = () => notifications().filter((n) => n.id === 7202)
  const finished = () => notifications().find((n) => n.id === 7203)
  const until = async (fn, timeout = 15000) => {
    const end = Date.now() + timeout
    for (;;) {
      const hit = await fn()
      if (hit || Date.now() > end) return hit
      await h.pause(400)
    }
  }
  const shade = (open) => h.adb('shell', 'cmd', 'statusbar', open ? 'expand-notifications' : 'collapse')
  // The shade cannot be read through uiautomator while the island is up: its chronometer ticks every second and the
  // UI never counts as idle (8 of 8 dumps failed, 11 s each). What the buttons do is read from the system's own
  // records instead, and the island's place in the shade from the system UI's dump.
  /** What a button of the island sends, as the system recorded it: the notification names one pending intent per
   *  button, the activity manager knows what each of them sends. */
  const buttonIntent = (n, label) => {
    const rec = n.raw.match(new RegExp(`"${label}" -> PendingIntent\\{\\w+: PendingIntentRecord\\{(\\w+) `))?.[1]
    assert.ok(rec, `no "${label}" button on the island (${JSON.stringify(n.actions)})`)
    const all = h.adb('shell', 'dumpsys', 'activity', 'intents')
    const at = all.indexOf(`PendingIntentRecord{${rec} `)
    assert.ok(at >= 0, `the activity manager does not know the pending intent of "${label}"`)
    const block = all.slice(at).split('\n').slice(0, 4).join('\n')
    return { type: block.match(/type=(\w+)/)?.[1], send: block.match(/requestIntent=(.*)/)?.[1]?.trim() }
  }
  const answerBroadcast = (approvalId, action) => `act=com.forsion.tangu.island.ANSWER dat=tangu://answer?sessionId=e2e-s2&messageId=${live.assistantId}&approvalId=${approvalId}&action=${action} pkg=${PKG}`
  /** A tap on a button makes the system send its broadcast; a root shell may deliver to the app's non-exported
   *  receiver the same way (emulator images have one). */
  const sendButton = (intent) => {
    const m = intent.send.match(/^act=(\S+) dat=(\S+) pkg=(\S+)$/)
    assert.ok(m, `not a broadcast with data: ${intent.send}`)
    h.adb('shell', `su 0 am broadcast -a ${m[1]} -d '${m[2]}' -p ${m[3]}`)
  }
  const dp = (n) => Math.round(n * Number(h.adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]) / 160)
  /** Where the system UI drew the island in the open shade. */
  const islandRow = () => {
    const all = h.adb('shell', 'dumpsys', 'activity', 'service', 'com.android.systemui/.SystemUIService', 'NotificationStackScrollLayout')
    const at = all.indexOf(`|${PKG}|${ISLAND}|`)
    if (at < 0) return null
    const rest = all.slice(at)
    const next = rest.indexOf('\n      Notification: ')
    const block = next > 0 ? rest.slice(0, next) : rest
    const b = block.match(/ExpandableNotificationRow\{\S+ \S+ \S+ (\d+),\d+-(\d+),\d+/)
    const v = block.match(/ViewState \{.*?height: (\d+),.*?mYTranslation: ([\d.]+)/)
    const max = block.match(/maxExpanded=(\d+)/)
    return b && v && max ? { left: Number(b[1]), right: Number(b[2]), top: Math.round(Number(v[2])), height: Number(v[1]), unfolded: Number(max[1]) } : null
  }
  /** Open the shade with the island unfolded (rows of the silent section come folded; the buttons are on the unfolded
   *  row). Geometry of the AOSP shade: the fold chevron sits 28dp inside the row's right edge, at mid height. */
  async function unfoldIsland() {
    shade(true)
    await h.pause(1500)
    let row = islandRow()
    assert.ok(row, 'the island is not in the shade')
    if (row.height < row.unfolded) {
      h.tapAt(row.right - dp(28), row.top + Math.round(row.height / 2))
      row = await until(() => { const r = islandRow(); return r && r.height >= r.unfolded ? r : null }, 6000)
      assert.ok(row, `the island did not unfold: ${JSON.stringify(islandRow())}`)
      await h.pause(600)
    }
    return row
  }
  /** uiautomator over the open shade, for the moments nothing in it ticks. */
  const shadeTitle = (l, title) => l.find((n) => n['resource-id'] === 'android:id/title' && n.text === title)
  const leaveApp = async () => {
    h.key(3) // HOME
    assert.ok(await until(() => !resumed(), 6000), 'the app is still in front after HOME')
    await h.pause(800)
  }
  const INBOX_KEY = 'tangu_inbox_msgs' // the phone's local inbox (desktop/frontend/src/services/localInbox.ts)
  /** A new message in the local inbox, the way the periodic pull stores one; the inbox's own poll (15 s) finds it. */
  const inboxArrives = (id, title) => cdp.eval(`(() => {
    const rows = JSON.parse(localStorage.getItem(${JSON.stringify(INBOX_KEY)}) || '[]')
    rows.push({ id: 'bc:' + ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, body: 'Harness fixture', sender_kind: 'server', sender_id: 'forsion', origin_broadcast_id: ${JSON.stringify(id)},
      read_at: null, archived_at: null, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), deleted_at: null })
    localStorage.setItem(${JSON.stringify(INBOX_KEY)}, JSON.stringify(rows))
    return true
  })()`)

  await check('island: a run that ends while the app is in the background always leaves "finished" (6 rounds), never the last running state', async () => {
    // The finished state used to replace the ongoing notification under the same id, right after the keep-alive
    // service let go of it; the system re-posts the service's last notification at that moment, and when that landed
    // second the island was back on "thinking…" for good (3 rounds of 6 on API 35). Raw plugin calls: no run needed.
    const show = (o) => cdp.eval(`Capacitor.Plugins.LiveIsland.show(${JSON.stringify({ title: 'E2E island', chip: '', sessionId: 'e2e-s1', channelName: 'Agent 运行状态', more: 0, ...o })}).then(() => true)`)
    const stale = []
    try {
      for (let round = 1; round <= 6; round++) {
        h.adb('shell', 'am', 'start', '-n', ACTIVITY)
        assert.ok(await until(() => resumed(), 6000), 'the app did not come to the front')
        const since = Date.now()
        await cdp.eval('Capacitor.Plugins.LiveIsland.reset().then(() => true)')
        await show({ text: 'running', since })
        assert.ok(await until(() => island()?.text === 'running', 8000), `round ${round}: no island`)
        await leaveApp()
        await show({ text: 'thinking', since })
        await h.pause(1200) // the page sends at most one update a second
        await show({ text: 'finished', since, done: true, quiet: false })
        await h.pause(2500)
        const left = notifications().filter((n) => n.id === ISLAND || n.id === 7203).map((n) => `${n.id}:${n.text}${n.ongoing ? ' (ongoing)' : ''}`)
        if (left.join() !== '7203:finished') stale.push(`round ${round}: ${left.join(' + ') || 'nothing'}`)
      }
      assert.deepEqual(stale, [], 'the finished state lost against a stale island')
    } finally {
      // leave nothing in the shade: a new island takes the last "finished" away, reset takes the island
      h.adb('shell', 'am', 'start', '-n', ACTIVITY)
      await until(() => resumed(), 6000)
      await show({ text: 'running', since: Date.now() }).catch(() => {})
      await h.pause(800)
      await cdp.eval('Capacitor.Plugins.LiveIsland.reset().then(() => true)').catch(() => {})
    }
  })

  await check('notifications: a waiting approval carries Deny, and Allow only when the whole request is on the notification; a tap in the shade answers it with the app in the background; the finished run is reported once, with its time, and a tap returns to its session', async () => {
    const TWO = sessions.find((x) => x.id === 'e2e-s2').title // as listed now: the session-row check renames it
    const LONG = `node scripts/build.mjs --target=android ${'--flag '.repeat(20)}`.trim() // past what a notification shows whole
    // (the engine's wording: a shell command is previewed as `$ <command>`, whole)
    const request = (seq, approvalId, command) => ({ seq, type: 'approval_request', payload: { approvalId, name: 'run_bash', arguments: JSON.stringify({ command }), preview: `$ ${command}`, reason: { kind: 'mode', mode: 'auto-edit' } } })
    const waiting = (actions) => until(() => { const n = island(); return n && n.ongoing && n.text === '等你批准：run_bash' && n.actions.length === actions ? n : null })
    Object.assign(live, { sessionId: 'e2e-s2', events: [request(1, 'apv-e2e-long', LONG)], answers: [] })
    try {
      await reload() // a session's history — and with it a run in flight — is loaded once per page
      await openChat(TWO)
      // 1. a request too long to be shown whole: Deny only, and none of it on the notification
      let n = await waiting(1)
      assert.ok(n, `no island for the waiting approval: ${JSON.stringify(island() || null)} (stub: ${stubLog.slice(-6).join(' | ')})`)
      assert.equal(n.title, TWO)
      assert.deepEqual(n.actions, ['拒绝'], 'a request that cannot be read whole must not offer Allow')
      assert.ok(!n.raw.includes('build.mjs'), 'part of a long request is on the notification')
      // … seen from another session, so the run's end below is also an in-app "finished" notification
      await openChat('E2E Session One')
      await leaveApp()
      const deny = buttonIntent(island(), '拒绝')
      assert.deepEqual(deny, { type: 'broadcastIntent', send: answerBroadcast('apv-e2e-long', 'reject') })
      sendButton(deny)
      assert.ok(await until(() => live.answers.length === 1, 10000), `Deny did not reach the engine with the app in the background (answers: ${JSON.stringify(live.answers)})`)
      assert.deepEqual(live.answers[0], { runId: 'e2e-run', approvalId: 'apv-e2e-long', action: 'reject' })
      assert.ok(!resumed(), 'answering from the shade brought the app to the front')
      // 2. the next request fits: Deny + Allow, and the request itself is what the unfolded notification shows
      live.events.push({ seq: 2, type: 'approval_result', payload: { approvalId: 'apv-e2e-long', action: 'reject' } }, request(3, 'apv-e2e-short', 'npm test'))
      n = await waiting(2)
      assert.ok(n, `no Allow for a short request: ${JSON.stringify(island()?.actions)}`)
      assert.deepEqual(n.actions, ['拒绝', '允许'])
      assert.equal(n.bigText, '等你批准：run_bash\n$ npm test')
      assert.deepEqual(buttonIntent(n, '拒绝'), { type: 'broadcastIntent', send: answerBroadcast('apv-e2e-short', 'reject') })
      const allow = buttonIntent(n, '允许')
      assert.deepEqual(allow, { type: 'broadcastIntent', send: answerBroadcast('apv-e2e-short', 'approve') })
      // … and this one is tapped for real: the buttons sit in a row 29dp above the unfolded row's bottom, the second
      // 121dp from its left (two-glyph labels). Should the shade be laid out otherwise, the tap misses every button,
      // which is said, and the button's broadcast is sent the other way.
      const row = await unfoldIsland()
      shot('46-island-approval-buttons')
      h.tapAt(row.left + dp(121), row.top + row.height - dp(29))
      if (!(await until(() => live.answers.length === 2, 8000))) {
        console.log(`  (the tap on Allow at the assumed place did not answer — row ${JSON.stringify(row)}; sending its broadcast instead)`)
        sendButton(allow)
      }
      assert.ok(await until(() => live.answers.length === 2, 10000), `Allow did not reach the engine with the app in the background (answers: ${JSON.stringify(live.answers)})`)
      try { shade(false) } catch { /* already closed by the tap */ }
      assert.deepEqual(live.answers[1], { runId: 'e2e-run', approvalId: 'apv-e2e-short', action: 'approve' }) // never approve_always
      assert.ok(!resumed(), 'answering from the shade brought the app to the front')
      live.events.push({ seq: 4, type: 'approval_result', payload: { approvalId: 'apv-e2e-short', action: 'approve' } })
      n = await until(() => { const i = island(); return i && i.ongoing && !i.actions.length ? i : null })
      assert.ok(n, `the answered approval kept its buttons: ${JSON.stringify(island()?.actions)}`)
      // 3. the run ends: the ongoing island leaves, "finished · <time>" stays (no buttons); the app's own "finished"
      //    notification for that session (it is not the one on screen) is not a second system notification
      live.events.push({ seq: 5, type: 'done', payload: { content: 'E2E run reply.' } })
      n = await until(() => finished())
      assert.ok(n, `the run's end was not reported: ${JSON.stringify(notifications().map((x) => [x.id, x.text]))}`)
      assert.deepEqual([n.title, n.ongoing, n.actions], [TWO, false, []])
      assert.match(n.text, /^已完成 · (\d+s|\d+m \d+s)$/)
      await h.pause(1500)
      assert.ok(!island(), `the ongoing island outlived its run: ${island()?.text}`)
      assert.deepEqual(eventNotes().map((e) => [e.tag, e.text]), [], 'the finished run was reported twice')
      shade(true)
      await h.pause(1500)
      shot('47-run-finished-in-the-shade')
      // (should the app have a second notification up, the system folds both into a group whose lines carry another
      //  id: unfold it with the count button at its right, then the finished run is a row of its own)
      const listed = await h.waitNodes((l) => l.find((x) => x.text === TWO && /:id\/(title|notification_title)$/.test(x['resource-id'] || '')), { timeout: 20000, out: OUT })
      assert.ok(listed.hit, 'the finished run is not in the shade')
      let done = listed.hit
      if (done['resource-id'] !== 'android:id/title') {
        h.tapNode(listed.nodes.find((x) => x['resource-id'] === 'android:id/expand_button_number') || done)
        done = (await h.waitNodes((l) => shadeTitle(l, TWO), { timeout: 10000, out: OUT })).hit
        assert.ok(done, 'the notification group did not unfold')
        await h.pause(600)
      }
      // 4. a tap on it returns to that session and takes the notification away
      h.tapNode(done)
      assert.ok(await until(() => resumed(), 8000), 'the finished notification did not open the app')
      // (the run's reply exists in Session Two only; the app was left on Session One)
      assert.ok(await h.waitPage(cdp, `!(${drawerOpen}) && !!document.querySelector('.mb-main')?.textContent.includes('E2E run reply.')`, 8000), 'the tap did not open the session whose run finished')
      assert.ok(await until(() => !notifications().length, 8000), `notifications left behind: ${JSON.stringify(notifications().map((x) => [x.id, x.tag, x.text]))}`)
    } finally {
      live.sessionId = ''
      try { shade(false) } catch { /* no shade service */ }
      h.adb('shell', 'am', 'start', '-n', ACTIVITY)
      await reload()
    }
  })

  await check('notifications: what the app notifies in-app is mirrored as a system notification while it is in the background (one per kind, not "run finished": the island reports that), never in front, and gone on return', async () => {
    const inboxBefore = await cdp.eval(`localStorage.getItem(${JSON.stringify(INBOX_KEY)})`)
    const bridge = (title, text, event) => cdp.eval(`window.tangu.notify(${JSON.stringify(title)}, ${JSON.stringify(text)}, { event: ${JSON.stringify(event)} }).then(() => true)`)
    const problems = []
    try {
      await goHome()
      // an island keeps the process alive in the background, like a running agent does
      await cdp.eval(`Capacitor.Plugins.LiveIsland.show(${JSON.stringify({ title: 'E2E island', text: 'running', chip: '', since: Date.now(), sessionId: 'e2e-s1', channelName: 'Agent 运行状态', more: 0 })}).then(() => true)`)
      assert.ok(await until(() => island()?.text === 'running', 8000), 'no island')
      await leaveApp()
      // the product path: the inbox's own poll (15 s) finds a new message and notifies; the store sees the page hidden
      await inboxArrives('e2e-inbox-1', 'E2E inbox one')
      let notes = await until(() => { const e = eventNotes(); return e.length ? e : null }, 25000)
      assert.ok(notes, 'no system notification for an inbox message that arrived while the app was away')
      assert.deepEqual(notes.map((e) => [e.tag, e.title, e.text]), [['inbox.message', 'Forsion', 'E2E inbox one']])
      await inboxArrives('e2e-inbox-2', 'E2E inbox two')
      notes = await until(() => { const e = eventNotes(); return e.some((x) => x.text === 'E2E inbox two') ? e : null }, 25000)
      assert.ok(notes, `the second message did not arrive: ${JSON.stringify(eventNotes().map((e) => e.text))}`)
      assert.equal(notes.length, 1, `one notification per kind expected: ${JSON.stringify(notes.map((e) => [e.tag, e.text]))}`)
      // the bridge itself: another kind is a second notification, "run finished" is none
      await bridge('E2E sync', 'E2E sync failed', 'sync.error')
      await bridge('E2E', 'E2E run finished', 'agent.done')
      await h.pause(1500)
      const tags = eventNotes().map((e) => e.tag).sort()
      if (tags.join() !== 'inbox.message,sync.error') problems.push(`in the background: ${tags.join(', ') || 'none'} (expected inbox.message, sync.error)`)
      shade(true)
      await h.pause(1500)
      shot('48-event-notifications-in-the-shade')
      shade(false)
      // back in front: the mirrored notifications leave (the same items are in the app) …
      h.adb('shell', 'am', 'start', '-n', ACTIVITY)
      assert.ok(await until(() => resumed(), 6000), 'the app did not come to the front')
      if (!(await until(() => !eventNotes().length, 6000))) problems.push(`left in the shade after returning: ${eventNotes().map((e) => e.tag).join(', ')}`)
      // … and in front nothing is mirrored: neither through the app's own notifications, nor when the bridge is called
      // (the page counts as unfocused under a native sheet too; the plugin goes by the activity)
      await inboxArrives('e2e-inbox-3', 'E2E inbox three')
      assert.ok(await h.waitPage(cdp, "[...document.querySelectorAll('.ntf-text')].some((e) => e.textContent.includes('E2E inbox three'))", 25000), 'no in-app card for the inbox message')
      await bridge('E2E', 'E2E in front', 'sync.error')
      await h.pause(1500)
      if (eventNotes().length) problems.push(`posted while the app was in front: ${eventNotes().map((e) => `${e.tag} "${e.text}"`).join(', ')}`)
      assert.deepEqual(problems, [])
    } finally {
      try { shade(false) } catch { /* no shade service */ }
      h.adb('shell', 'am', 'start', '-n', ACTIVITY)
      await cdp.eval('Capacitor.Plugins.LiveIsland.reset().then(() => true)').catch(() => {})
      await cdp.eval(`(() => { const v = ${JSON.stringify(inboxBefore)}; v == null ? localStorage.removeItem(${JSON.stringify(INBOX_KEY)}) : localStorage.setItem(${JSON.stringify(INBOX_KEY)}, v); return true })()`).catch(() => {})
      await reload()
    }
  })

  await check('plugins: survive a cold restart (force-stop + relaunch): files, enabled state and data persist', async () => {
    cdp.close()
    h.adb('shell', 'am', 'force-stop', PKG)
    h.adb('shell', 'am', 'start', '-n', ACTIVITY)
    cdp = await h.connect(PKG)
    await cdp.send('Page.enable')
    await installStub(cdp)
    assert.ok(await h.waitPage(cdp, dom.shellUp, 30000), 'shell did not mount after the cold start')
    await reload() // a clean stubbed boot (the cold start's first requests went out before the stub; airplane mode drops them)
    assert.ok(pluginFiles().includes('main.js'), 'plugin files gone after restart')
    assert.ok(pluginRuns >= 1, 'precondition: the plugin ran (and saved data) before the restart')
    await runPluginCommand()
    shot('p07-plugin-view-after-restart')
    // its Space registers only after the plugins have loaded: back on the bar, and it opens
    await toSpace(PLUGIN_SPACE)
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.mb-main [data-e2e-plugin-view]')", 8000), 'the plugin Space did not open after the restart')
    await toSpace('home') // where the command above left the app: Home, the plugin view on top of the homepage
  })

  /** Mode + add sheets in the chat, then settings as a native page (screenshots for the given pass). */
  async function chatSheetsPass(tag, lang) {
    await openChat('E2E Session One')
    await tapEl("document.querySelector('.mode-pill-btn')")
    let list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.item.approval:auto-edit'), `mode sheet: ${ids(list)}`)
    if (lang === 'en') assert.ok(!hasCjk(list), 'Chinese text in the English mode sheet')
    shot(`${tag}-mode-sheet`)
    h.key(4)
    await waitSheet(false)
    await tapEl("document.querySelector('.add-pill-btn')")
    list = await waitSheet(true)
    if (lang === 'en') assert.ok(!hasCjk(list), 'Chinese text in the English add sheet')
    if (lang === 'en') assert.deepEqual(['camera', 'photos', 'files'].map((id) => rowLabel(list, `nativeSheet.item.${id}`)), ['Take photo', 'Photos', 'Files'])
    shot(`${tag}-add-sheet`)
    h.key(4)
    await waitSheet(false)
    await tanguDrawer()
    await tapEl(`${rowExpr('Two')}.querySelector('.t2s-srow-menu')`) // renamed by the session-row check
    list = await waitSheet(true)
    if (lang === 'en') assert.ok(!hasCjk(list), 'Chinese text in the English session menu')
    shot(`${tag}-session-menu`)
    h.key(4)
    await waitSheet(false)
    await closeDrawer()
    await settingsPageMode(lang, tag)
    await tapId('nativeChrome.close')
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), '× did not close settings')
    await closeDrawer()
  }
  await check('dark: chat sheets and the settings page bar follow the theme', async () => {
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_theme', 'dark'); true")
    await reload()
    assert.equal(await cdp.eval(dom.mode), 'dark')
    await chatSheetsPass('25-dark', 'zh')
  })

  await check('dark: market page, plugin ⋯ section, plugin view and model sheet', async () => {
    await openMarket('zh')
    shot('p11-market-dark')
    await closeMarket()
    await tapId('nativeChrome.more')
    const list = await waitSheet(true, SLOW)
    assert.ok(h.byId(list, pluginItem(PLUGIN_CMD)), 'plugin command missing in the dark ⋯')
    shot('p12-more-plugin-dark')
    h.key(4)
    await waitSheet(false, SLOW)
    await runPluginCommand()
    shot('p13-plugin-view-dark')
    await modelSheet('p14-model-sheet-dark')
  })

  await check('dark: market detail, project sheet, prompt with keyboard, Settings → Forsion plugins', async () => {
    assert.equal(await cdp.eval(dom.mode), 'dark')
    await openMarket('zh')
    await tapEl("document.querySelector('.mk-featured-copy h2')")
    let r = await h.waitNodes((l) => (textOf(l, 'nativeChrome.title') === 'E2E Native Hello' && h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `detail: title + × expected (title=${textOf(r.nodes, 'nativeChrome.title')})`)
    await h.pause(500)
    shot('p15-market-detail-dark')
    await tapId('nativeChrome.close', r.nodes)
    assert.ok(await h.waitPage(cdp, `!(${marketOpen})`, 5000), '× did not leave the market from the detail page')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.more'), { timeout: 5000 })).hit, 'shell bar did not return after the market')
    // project sheet
    await tanguDrawer()
    await tapEl(`document.querySelector('.mb-drawer--left [data-act="new-chat"]')`)
    assert.ok(await h.waitPage(cdp, `!(${drawerOpen}) && !!document.querySelector('.project-pill')`, 6000), 'new chat composer has no project pill')
    await h.pause(600)
    await tapEl("document.querySelector('.project-pill')")
    await waitSheet(true)
    shot('p16-project-sheet-dark')
    h.key(4)
    await waitSheet(false)
    // prompt with the keyboard up (cancelled: nothing is created)
    await goHome()
    await newFolderPrompt()
    const list = await waitSheet(true)
    assert.ok(h.byId(list, 'nativeSheet.prompt.field'), 'prompt field missing')
    await h.pause(600)
    shot('p17-prompt-keyboard-dark')
    h.key(4) // first back may only hide the IME
    await h.pause(400)
    if (sheetOpen(ui())) h.key(4)
    await waitSheet(false)
    try { await cdp.eval("(document.querySelector('.hp-organizer-stage')?.click(), true)") } catch { /* no organizer layer */ }
    await settingsPluginsPage('p18-settings-plugins-dark')
  })

  await check('English labels arrive from shared i18n (bar + sheets)', async () => {
    await seed('en')
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_theme', 'dark'); true")
    await reload()
    await toSpace('tangu')
    await closeDrawer() // the main view: its left button goes back to the list
    let list = ui()
    assert.equal(descOf(list, 'nativeChrome.left'), 'Back')
    shot('14-shell-dark-en')
    await tapId('nativeChrome.more', list)
    list = await waitSheet(true)
    assert.ok(list.some((n) => n.text === 'More'), 'sheet title not English')
    assert.ok(!list.some((n) => /[一-鿿]/.test(n.text || '')), 'Chinese text in the English sheet')
    assert.deepEqual([rowLabel(list, 'nativeSheet.item.tab:new'), rowLabel(list, 'nativeSheet.item.rb-cmd')], ['New tab', 'Search'])
    shot('15-more-sheet-dark-en')
    h.key(4)
    await waitSheet(false)
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light'); true")
    await reload()
    const closeTabs = await tabsSheet()
    shot('16-tabs-sheet-light-en')
    await closeTabs((sheet) => assert.equal(textOf(sheet, 'nativeSheet.title'), 'Tabs'))
  })

  await check('English: chat sheets and the settings page bar (light)', async () => {
    assert.match(await cdp.eval('document.documentElement.lang'), /^en/)
    await chatSheetsPass('26-en', 'en')
  })

  await check('English: market page, plugin ⋯ section (no CJK in native copy), plugin view and model sheet', async () => {
    await openMarket('en')
    shot('p21-market-en')
    await closeMarket()
    await tapId('nativeChrome.more')
    const list = await waitSheet(true, SLOW)
    assert.ok(h.byId(list, pluginItem(PLUGIN_CMD)), 'plugin command missing in the English ⋯')
    assert.ok(!hasCjk(list), 'Chinese text in the English ⋯ sheet')
    shot('p22-more-plugin-en')
    h.key(4)
    await waitSheet(false, SLOW)
    await runPluginCommand()
    shot('p23-plugin-view-en')
    await modelSheet('p24-model-sheet-en')
  })

  await check('plugins: uninstall from Settings → Plugins removes its files; ⋯ no longer lists its commands', async () => {
    await accountItem('rb-settings')
    assert.ok(await h.waitPage(cdp, settingsOpen, 5000), 'settings did not open')
    const row = `document.querySelector('[data-plugin-id="${PLUGIN_ID}"]')`
    if (!(await cdp.eval(`!!${row}`))) {
      if (!(await cdp.eval(`!!document.querySelector('[data-settings-sub="pl-forsion"]')`))) await tapEl(`document.querySelector('[data-settings-tab="amadeus-plugins"]')`)
      await tapEl(`document.querySelector('[data-settings-sub="pl-forsion"]')`)
    }
    assert.ok(await h.waitPage(cdp, `!!${row}`, 8000), 'plugin row not listed in Settings → Plugins')
    await h.pause(600)
    shot('p31-settings-plugins-en')
    await h.pause(3000) // a second shot later: tells a transient raster glitch from a layout defect
    shot('p31b-settings-plugins-en-3s')
    await tapEl(`${row}.querySelector('b')`) // the name (not the on/off checkbox)
    const detailOpen = "!!document.querySelector('[data-plugin-uninstall]')"
    const onList = `!document.querySelector('[data-plugin-detail]') && !!${row} && ${settingsOpen} && !document.querySelector('.settings-page--mobile-menu')`
    assert.ok(await h.waitPage(cdp, detailOpen, 6000), 'plugin detail (uninstall button) did not open')
    // the native bar owns "back" here: the web "Back to list" row is hidden, native back and system back return to the list
    assert.equal(await cdp.eval("getComputedStyle(document.querySelector('[data-plugin-back-row]')).display"), 'none', 'web "Back to list" still shown under the native bar')
    await tapId('nativeChrome.back')
    assert.ok(await h.waitPage(cdp, onList, 5000), 'native back from the plugin detail did not return to the plugin list')
    await tapEl(`${row}.querySelector('b')`)
    assert.ok(await h.waitPage(cdp, detailOpen, 6000), 'plugin detail did not reopen')
    h.key(4)
    assert.ok(await h.waitPage(cdp, onList, 5000), 'system back from the plugin detail did not return to the plugin list')
    await tapEl(`${row}.querySelector('b')`)
    assert.ok(await h.waitPage(cdp, detailOpen, 6000), 'plugin detail did not reopen')
    await h.pause(400)
    shot('p32-plugin-detail-en')
    await tapEl("document.querySelector('[data-plugin-uninstall]')")
    // window.confirm → the WebView's system AlertDialog
    const ok = await h.waitNodes((l) => h.byId(l, 'android:id/button1'), { timeout: 6000 })
    assert.ok(ok.hit, 'uninstall confirmation dialog missing')
    h.tapNode(ok.hit)
    assert.ok(await h.waitPage(cdp, `(async () => !(await window.amadeus.listPlugins()).some((p) => p.id === '${PLUGIN_ID}'))()`, 8000), 'still listed after uninstall')
    const left = runAs('ls', `files/plugins/${PLUGIN_ID}`)
    assert.match(left, /No such file/, `files/plugins/${PLUGIN_ID} still there: ${left}`)
    h.key(4) // close settings (system back)
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 6000) || (h.key(4), await h.waitPage(cdp, `!(${settingsOpen})`, 6000)), 'settings stayed open')
    await closeDrawer()
    await tapId('nativeChrome.more')
    const list = await waitSheet(true, SLOW)
    assert.ok(!h.byId(list, pluginItem(PLUGIN_CMD)) && !h.byId(list, pluginItem(PLUGIN_TOGGLE)), `uninstalled plugin still in ⋯: ${ids(list)}`)
    h.key(4)
    await waitSheet(false, SLOW)
  })

  // ── restore the device state we touched ──
  try {
    await cdp.eval(`(async () => {
      const s = ${JSON.stringify(saved)}
      if (s.token) await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: s.token }); else await Capacitor.Plugins.Preferences.remove({ key: 'forsion_token' })
      const put = (k, v) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v)
      put('tangu_locale', s.locale); put('forsion_theme_pref', s.pref); put('forsion_theme', s.legacy); put('forsion_tangu_onboarding_done', s.onboarding)
      return true
    })()`)
    await cdp.send('Fetch.disable')
    await cdp.send('Page.reload')
  } catch (e) { console.log('restore failed:', e.message) }
  cleanPluginFiles()
  removePickFixtures()
  if (!process.env.PLUGIN_HOST) try { h.adb('reverse', '--remove', `tcp:${PLUGIN_PORT}`) } catch { /* already gone */ }
  pluginServer.close()
  cdp.close()
  fs.writeFileSync(path.join(OUT, 'acceptance.json'), JSON.stringify({ package: PKG, checks, screenshots: shots.map((s) => path.basename(s)), stubRequests: stubLog.length, completedAt: new Date().toISOString() }, null, 2))
  console.log(`\n${checks.length - failed}/${checks.length} passed · artifacts: ${OUT}`)
  process.exitCode = failed ? 1 : 0
})().catch((e) => { console.error(e); pluginServer.close(); process.exit(1) }) // exit: the DevTools socket would keep a failed run alive for good
