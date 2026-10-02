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
 * dark and an English pass. Web page taps go through real touches (zoom-aware) — never element.click() for
 * anything that needs user activation.
 *
 * Build + install (README「Android 原生外壳」): rm -rf dist && npm run build && npx cap sync android &&
 *   ./android/gradlew -p android :app:assembleDebug && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 * Run: OUT=/absolute/dir npm run emu:nativeshell   (Node 22+, one device; ANDROID_SERIAL picks one)
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
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
    for (let i = 0; i < 3 && !h.byId(h.nodes(), 'nativeChrome.bar'); i++) { h.key(4); await h.pause(500) }
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
const stubLog = [] // "METHOD /path body"
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
    if (p.endsWith('/auth/me')) return json({ username: 'e2e', id: 'e2e' })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'e2e' })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: [{ slug: 'e2e-agent', name: 'E2E Agent', description: 'Harness fixture' }, { slug: 'e2e-helper', name: 'E2E Helper', description: 'Second fixture' }] })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: [{ name: 'E2E Alpha' }, { name: 'E2E Beta' }] })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: url.searchParams.get('archived') === 'true' ? [] : sessions })
    if (p.endsWith('/agent/runs')) return json({ runs: [] })
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
const resumed = () => /topResumedActivity=.*com\.forsion\.tangu\//.test(h.adb('shell', 'dumpsys', 'activity', 'activities'))
const webViewNode = (list) => list.find((n) => n.class === 'android.webkit.WebView')
const sheetOpen = (list) => !!h.byId(list, 'nativeSheet.sheet')
async function waitSheet(open = true, timeout = 6000) {
  const r = await h.waitNodes((l) => (sheetOpen(l) === open ? l : null), { timeout })
  assert.ok(r.hit, open ? 'native sheet did not open' : 'native sheet did not close')
  await h.pause(open ? 450 : 200) // let the slide-in settle before screenshots / taps
  return open ? ui() : r.nodes
}
async function tapId(id, list) {
  const n = h.byId(list || ui(), id)
  assert.ok(n, `node missing: ${id}`)
  h.tapNode(n)
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
  h.adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
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
  const reload = async () => {
    await cdp.send('Page.reload', { ignoreCache: true })
    await h.pause(800)
    assert.ok(await h.waitPage(cdp, dom.shellUp, 20000), 'shell did not mount after reload')
    h.adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`) // back to front if anything else took it
    const r = await h.waitNodes((l) => h.byId(l, 'nativeChrome.bar'), { timeout: 10000 })
    assert.ok(r.hit, 'native bar did not appear')
    await h.pause(600)
  }
  await reload()

  // ── WebView helpers. Mobile CSS zooms (body 1.15, drawer body 1.15): rects × cumulative zoom × dpr = device px.
  /** Tap a page element like a finger would (real touch → real user activation), once it stops moving. */
  async function tapEl(expr) {
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
    h.tapAt(Math.round(wv.rect.left + r.x * r.dpr), Math.round(wv.rect.top + r.y * r.dpr))
  }
  const drawerOpen = "!!document.querySelector('.mb-drawer--left.open')"
  async function openDrawer() {
    if (await cdp.eval(drawerOpen)) return
    await tapId('nativeChrome.left')
    assert.ok(await h.waitPage(cdp, drawerOpen, 5000), 'drawer did not open')
    await h.pause(500)
  }
  async function closeDrawer() {
    if (await cdp.eval(drawerOpen)) h.key(4)
    assert.ok(await h.waitPage(cdp, `!(${drawerOpen})`, 5000), 'drawer stayed open')
  }
  async function toSpace(id) {
    await openDrawer()
    if (!(await cdp.eval(`!!document.querySelector('.mb-drawer--left .mb-tab.on[data-space="${id}"]')`))) {
      await cdp.eval(`(document.querySelector('.mb-drawer--left .mb-tab[data-space="${id}"]').click(), true)`)
      await h.pause(1200)
      await openDrawer()
    }
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
  async function goHome() {
    if (await cdp.eval("!!document.querySelector('.hp-spaces-actions button')")) return
    await toSpace('home')
    await closeDrawer()
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.hp-spaces-actions button')", 6000), 'homepage did not come back')
  }

  let statusBar = 0
  const barPx = Math.round(56 * Number(h.adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]) / 160)

  await check('native top bar replaces the web .mb-topbar (zh, light)', async () => {
    const list = ui()
    for (const id of ['nativeChrome.bar', 'nativeChrome.left', 'nativeChrome.tabs', 'nativeChrome.more', 'nativeChrome.title']) assert.ok(h.byId(list, id), `missing ${id}`)
    assert.equal(descOf(list, 'nativeChrome.left'), '左侧面板')
    assert.equal(descOf(list, 'nativeChrome.tabs'), '标签页')
    const web = await cdp.eval(`({ topbar: !!document.querySelector('.mb-topbar'), native: document.querySelector('.mb-shell').hasAttribute('data-native-chrome'),
      mbTop: getComputedStyle(document.querySelector('.mb-shell')).getPropertyValue('--mb-top').trim(), lang: document.documentElement.lang })`)
    assert.deepEqual(web, { topbar: false, native: true, mbTop: '0px', lang: 'zh-CN' })
    shot('01-shell-light-zh')
  })

  // Units sheet = an overlay that still claims `hidden` (it draws its own header). Settings no longer does.
  const unitsBtn = `document.querySelector('.mb-drawer-foot .mb-icon-btn:not([aria-label="settings"])')`
  await check('hidden overlay (units sheet) hides the bar; WebView then starts at the status bar (measured)', async () => {
    await openDrawer() // the drawer foot (units + settings) mounts on first open
    assert.ok(await h.waitPage(cdp, `!!${unitsBtn}`, 5000), 'units button not in drawer')
    await cdp.eval(`(${unitsBtn}.click(), true)`)
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
    await openDrawer()
    await cdp.eval(`(document.querySelector('.mb-drawer-foot button[aria-label="settings"]').click(), true)`)
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

  await check('left button opens the drawer; system back closes it and stays in the app', async () => {
    await tapId('nativeChrome.left')
    assert.ok(await h.waitPage(cdp, "!!document.querySelector('.mb-drawer--left.open')", 5000), 'drawer did not open')
    await h.pause(1000)
    shot('03-left-drawer')
    h.key(4)
    assert.ok(await h.waitPage(cdp, "!document.querySelector('.mb-drawer--left.open')", 5000), 'drawer did not close')
    assert.ok(resumed(), 'app left the foreground')
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
    await tapId('nativeSheet.prompt.ok')
    await waitSheet(false)
    const patch = await waitLog(sent, (l) => l.startsWith('PATCH ') && l.includes('/agent/sessions/e2e-s2 '))
    assert.ok(patch && JSON.parse(patch.slice(patch.indexOf('{'))).title === 'E2E Renamed Two', `rename PATCH: ${patch}`)
    assert.ok(await h.waitPage(cdp, `!!${rowExpr('E2E Renamed Two')}`, 5000), 'row title did not update')
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
    assert.ok(!h.byId(list, 'nativeSheet.item.rb-settings') && !h.byId(list, 'nativeSheet.item.rb-account'), 'account/settings must stay in the drawer')
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
    const openPrompt = () => cdp.eval(`(() => { const b = document.querySelector('.hp-spaces-actions button'); if (!b) throw new Error('new folder button'); b.click(); return true })()`)
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

  await check('English labels arrive from shared i18n (bar + sheets)', async () => {
    await seed('en')
    await cdp.eval("localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_theme', 'dark'); true")
    await reload()
    let list = ui()
    assert.equal(descOf(list, 'nativeChrome.left'), 'Left panel')
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
  cdp.close()
  fs.writeFileSync(path.join(OUT, 'acceptance.json'), JSON.stringify({ package: PKG, checks, screenshots: shots.map((s) => path.basename(s)), stubRequests: stubLog.length, completedAt: new Date().toISOString() }, null, 2))
  console.log(`\n${checks.length - failed}/${checks.length} passed · artifacts: ${OUT}`)
  process.exitCode = failed ? 1 : 0
})().catch((e) => { console.error(e); process.exitCode = 1 })
