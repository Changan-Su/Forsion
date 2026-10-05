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
    if (p.endsWith('/agent/runs')) return json({ runs: [] })
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
  }
  const pickTmp = path.join(OUT, 'pick-fixtures')
  const pushPickFixtures = () => {
    fs.mkdirSync(pickTmp, { recursive: true })
    for (const f of Object.values(PICK)) {
      fs.writeFileSync(path.join(pickTmp, f.name), f.data)
      f.sha256 = crypto.createHash('sha256').update(f.data).digest('hex')
      h.adb('push', path.join(pickTmp, f.name), `/sdcard/${f.dir}/${f.name}`)
    }
    fs.rmSync(pickTmp, { recursive: true, force: true })
  }
  const removePickFixtures = () => { for (const f of Object.values(PICK)) { try { h.adb('shell', 'rm', '-f', `/sdcard/${f.dir}/${f.name}`) } catch { /* not there */ } } }
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
  /** Leave the left panel. On a two-level Space that means entering its main page — through the tabs sheet, which
   *  needs no particular list item; on a drawer Space system back closes the drawer. */
  async function closeDrawer() {
    if (!(await cdp.eval(drawerOpen))) return
    if ((await cdp.eval(nav)) === 'list') {
      await tapId('nativeChrome.tabs')
      const cur = h.byIdPrefix(await waitSheet(true), 'nativeSheet.item.tab:').find((n) => n.checked === 'true')
      assert.ok(cur, 'no active tab row to enter the main page with')
      h.tapNode(cur)
      await waitSheet(false)
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
    for (const dir of [0, 1, -1]) {
      let list = ui()
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
  const barPx = Math.round(56 * Number(h.adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]) / 160)

  await check('native top bar replaces the web .mb-topbar (zh, light)', async () => {
    const list = ui()
    for (const id of ['nativeChrome.bar', 'nativeChrome.tabs', 'nativeChrome.more', 'nativeChrome.title']) assert.ok(h.byId(list, id), `missing ${id}`)
    assert.equal(descOf(list, 'nativeChrome.tabs'), '标签页')
    const web = await cdp.eval(`({ topbar: !!document.querySelector('.mb-topbar'), native: document.querySelector('.mb-shell').hasAttribute('data-native-chrome'),
      mbTop: getComputedStyle(document.querySelector('.mb-shell')).getPropertyValue('--mb-top').trim(), lang: document.documentElement.lang })`)
    assert.deepEqual(web, { topbar: false, native: true, mbTop: '0px', lang: 'zh-CN' })
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
    assert.ok(!h.byId(r.nodes, 'nativeChrome.close') && !h.byId(r.nodes, 'nativeChrome.tabs'), 'home page must show back only')
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
    r = await h.waitNodes((l) => h.byId(l, 'nativeChrome.tabs'), { timeout: 5000 })
    assert.ok(r.hit, 'shell bar did not return after ×')
    // system back from the settings home closes it (useAndroidBack) and stays in the app
    await settingsPageMode('zh', null)
    await tapId('nativeChrome.back') // detail → home
    await h.waitNodes((l) => (!h.byId(l, 'nativeChrome.close') ? l : null), { timeout: 4000 })
    h.key(4)
    assert.ok(await h.waitPage(cdp, `!(${settingsOpen})`, 5000), 'system back did not close settings')
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.tabs'), { timeout: 5000 })).hit, 'shell bar did not return')
    assert.ok(resumed(), 'back left the app')
    await closeDrawer()
  })

  await check('insets: bar = status bar + 56dp, WebView directly below, no double padding', async () => {
    await toSpace('tangu')
    await closeDrawer() // a main view under a list Space: the bar has its left (back) button
    await h.pause(400)
    const list = ui()
    const bar = h.byId(list, 'nativeChrome.bar')
    const wv = webViewNode(list)
    assert.equal(bar.rect.top, 0)
    assert.ok(Math.abs(bar.rect.bottom - (statusBar + barPx)) <= 1, `bar bottom ${bar.rect.bottom} vs ${statusBar}+${barPx}`)
    assert.ok(Math.abs(wv.rect.top - bar.rect.bottom) <= 1, `WebView top ${wv.rect.top} vs bar bottom ${bar.rect.bottom}`)
    const left = h.byId(list, 'nativeChrome.left')
    assert.ok(left.rect.top >= statusBar, 'bar buttons under the status bar')
    assert.ok(left.rect.bottom - left.rect.top >= 120 && left.rect.right - left.rect.left >= 120, 'touch target < 48dp')
    const page = await cdp.eval(`(() => { const p = document.createElement('div'); p.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);width:1px'; document.body.appendChild(p)
      const inset = p.getBoundingClientRect().height; p.remove()
      return { inset, mainTop: document.querySelector('.mb-main').getBoundingClientRect().top, viewPad: getComputedStyle(document.querySelector('.mb-main > .mb-view')).paddingTop } })()`)
    assert.deepEqual(page, { inset: 0, mainTop: 0, viewPad: '0px' })
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

  let firstView = ''
  await check('tabs sheet: lists tabs, + new tab, switch, close (re-presents), back cancels', async () => {
    firstView = await cdp.eval(dom.view)
    const before = Number(tabCountText(ui()) || '1')
    await tapId('nativeChrome.tabs')
    let list = await waitSheet(true)
    const tabs = h.byIdPrefix(list, 'nativeSheet.item.tab:')
    assert.equal(tabs.length, before, 'tab rows != tab count')
    assert.ok(tabs.some((n) => n.checked === 'true'), 'active tab not marked')
    assert.ok(h.byId(list, 'nativeSheet.item.new'), 'new tab row missing')
    shot('04-tabs-sheet-light')
    await tapId('nativeSheet.item.new', list)
    await waitSheet(false)
    const r = await h.waitNodes((l) => (Number(tabCountText(l)) === before + 1 ? l : null), { timeout: 6000 })
    assert.ok(r.hit, `tab count did not become ${before + 1} (is ${tabCountText(r.nodes)})`)
    const newView = await cdp.eval(dom.view)
    // switch back to the first tab
    await tapId('nativeChrome.tabs')
    list = await waitSheet(true)
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
    assert.equal(await cdp.eval(dom.view), firstView)
  })

  // ── chat surfaces (T1 consumers): JS owns the state, the sheet only renders the same item list ──
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

  await check('rewind menu: native sheet with the note as footer; cancel changes nothing', async () => {
    const btn = `document.querySelector('[data-act="rewind"]')`
    if (!(await cdp.eval(`!!${btn}`))) await openChat('E2E Session One')
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'rewind button missing on the fixture user message')
    const sent = stubLog.length
    await tapEl(btn)
    const list = await waitSheet(true, 8000)
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
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'rewind button missing on the fixture user message')
    // (1) the checkpoint stat is still loading when the user switches session
    hold.checkpoints = true
    let sent = stubLog.length
    try {
      await tapEl(btn)
      assert.ok(await waitLog(sent, (l) => /^GET \S+\/e2e-s1\/checkpoints/.test(l), 6000), 'checkpoint stat was not requested')
      assert.ok(!sheetOpen(ui()), 'sheet opened before the stat answered')
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
    assert.ok(await h.waitPage(cdp, `!!${btn}`, 4000), 'rewind button missing after coming back')
    sent = stubLog.length
    await tapEl(btn)
    const list = await waitSheet(true, 8000)
    assert.ok(ids(list).includes('conversation'), `rewind items: ${ids(list)}`)
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
    for (const id of ['new-chat', 'files', 'conversation', 'view']) assert.ok(got.includes(id), `missing ${id} in ${got}`)
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

  await check('files: system picker → composer (content URIs streamed through the local server): right name + bytes, > 25 MB named in the toast and not attached, cancel is a no-op', async () => {
    pushPickFixtures()
    const top = () => h.adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=.*/)?.[0] || ''
    const title = (l, text) => l.find((n) => n['resource-id'] === 'android:id/title' && n.text === text)
    const DEVICE_ROOT = h.adb('shell', 'getprop', 'ro.product.model').trim() // the raw-storage root is labelled with the model name
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
      const root = (await h.waitNodes((l) => (l.some((n) => n.text === 'Open from') ? title(l, label) : null), { timeout: 6000 })).hit
      assert.ok(root, `picker: root "${label}" not listed`)
      h.tapNode(root)
      await h.pause(1200)
    }
    const entry = async (text) => {
      const n = (await h.waitNodes((l) => (l.some((x) => x.text === 'Open from') ? null : title(l, text)), { timeout: 8000 })).hit
      assert.ok(n, `picker: "${text}" not listed`)
      return n
    }
    const backInApp = async () => assert.ok((await h.waitNodes(() => resumed(), { timeout: 15000 })).hit, 'did not return to the app (picker hung?)')
    const settled = async (count) => {
      const end = Date.now() + 20000
      let got = null
      while (Date.now() < end) { got = await cdp.eval(composerFiles); if (got && got.length === count) return got; await h.pause(400) }
      return got
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
    // a phone has no ⌘K: the desktop tooltip's shortcut hint is dropped from the row
    const palette = rowLabel(list, 'nativeSheet.item.rb-cmd')
    assert.ok(palette && !/[⌘(（]/.test(palette), `command palette row: "${palette}"`)
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
    await tapId('nativeChrome.tabs')
    await waitSheet(true)
    shot('08-tabs-sheet-dark')
    h.key(4)
    await waitSheet(false)
  })

  await check('page reload dismisses an open native sheet and the bar comes back', async () => {
    await tapId('nativeChrome.tabs')
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
    assert.ok(!h.byId(r.nodes, 'nativeChrome.tabs'), 'shell buttons in page mode')
    assert.equal(descOf(r.nodes, 'nativeChrome.back'), '返回')
    shot('13-page-mode')
    h.tapNode(h.byId(r.nodes, 'nativeChrome.back'))
    assert.deepEqual(await h.waitPage(cdp, "window.__e2eActions.length && window.__e2eActions", 4000), ['back'])
    await reload() // the app's host pushes its own (shell) state again
    assert.ok(h.byId(ui(), 'nativeChrome.tabs'), 'shell state did not return')
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
    assert.ok(!h.byId(r.nodes, 'nativeChrome.tabs') && !h.byId(r.nodes, 'nativeChrome.close'), 'market list page: back only')
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
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.tabs'), { timeout: 5000 })).hit, 'shell bar did not return after the market')
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
    assert.ok((await h.waitNodes((l) => h.byId(l, 'nativeChrome.tabs'), { timeout: 5000 })).hit, 'shell bar did not return after the market')
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
    assert.equal(descOf(list, 'nativeChrome.tabs'), 'Tabs')
    shot('14-shell-dark-en')
    await tapId('nativeChrome.more', list)
    list = await waitSheet(true)
    assert.ok(list.some((n) => n.text === 'More'), 'sheet title not English')
    assert.ok(!list.some((n) => /[一-鿿]/.test(n.text || '')), 'Chinese text in the English sheet')
    shot('15-more-sheet-dark-en')
    h.key(4)
    await waitSheet(false)
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light'); true")
    await reload()
    await tapId('nativeChrome.tabs')
    await waitSheet(true)
    shot('16-tabs-sheet-light-en')
    h.key(4)
    await waitSheet(false)
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
})().catch((e) => { console.error(e); process.exitCode = 1; pluginServer.close() })
