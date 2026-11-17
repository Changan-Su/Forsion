/** Real-app acceptance for the phone's short onboarding (option A, 2026-11-13) on one Android emulator.
 *
 * What a browser bench cannot show: the signed-out cold start (welcome screen, sign-in tab), the system permission
 * dialogs and the app's own phone-control confirmation over the wizard (order, one at a time), system back, a killed
 * and relaunched process resuming on the same screen, the native dock under the home suggestions, and "the
 * notification question is never asked twice" (guide asked → LiveIsland.show asks nothing).
 *
 * Mechanics as in native-shell-emu.cjs: debug APK (WebView debugging on), one CDP session per process, a fake token
 * through Capacitor Preferences, every request to the API origin answered by CDP Fetch interception (GET /units gives
 * one ready desktop, or none). The emulator should be offline (airplane mode): between a relaunch and the stub being
 * attached, nothing reaches a real server. Each scenario starts from `pm clear` + revoked runtime permissions.
 * Dialogs are found by resource-id (com.android.permissioncontroller:id/permission_*, android:id/button1 for the
 * app's AlertDialog) and reported with the package / activity on top.
 *
 * Build + install (README「Android 原生外壳」): rm -rf dist && npm run build && npm run sync:android &&
 *   ./android/gradlew -p android :app:assembleDebug && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 * Run: ANDROID_SERIAL=emulator-5584 OUT=/abs/dir ONLY=C,D node scripts/phone-guide-emu.cjs
 *   ONLY matches check-name prefixes (A, B, C, D, E, F). CDP_PORT (9353) picks the host port of the devtools forward.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const h = require('./lib/emu-cdp.cjs')

const PKG = process.env.PKG || 'com.forsion.tangu'
const ACTIVITY = `${PKG}/com.forsion.tangu.AppActivity`
const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../outputs/phone-guide'))
const API_PATTERN = process.env.API_PATTERN || '*api.forsion.net*'
const CDP_PORT = Number(process.env.CDP_PORT || 9353)
fs.mkdirSync(OUT, { recursive: true })
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
const want = (scenario) => !ONLY.length || ONLY.some((k) => scenario.startsWith(k))
const checks = []
const evidence = []
let failed = 0
const note = (line) => { evidence.push(line); console.log('  ·', line) }
async function check(name, fn) {
  if (!want(name)) return
  try {
    await fn()
    checks.push({ name, ok: true })
    console.log('PASS', name)
  } catch (e) {
    failed++
    checks.push({ name, ok: false, error: String((e && e.message) || e) })
    console.log('FAIL', name, '—', (e && e.message) || e)
    try { h.screenshot(OUT, `fail-${checks.length}`) } catch { /* no device */ }
    try { h.nodes(OUT); fs.copyFileSync(path.join(OUT, 'last-ui.xml'), path.join(OUT, `fail-${checks.length}.xml`)) } catch { /* no device */ }
  }
}
const shot = (name) => { const f = h.screenshot(OUT, name); note(`screenshot ${f}`); return f }

// ── Fixtures ──
const READY = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const ROSTER_ONE = { units: [{ id: READY, name: 'MacBook Pro', platform: 'darwin', icon: null, online: true, kind: 'desktop', capsLive: true, caps: { engine: 'ready', tools: [] }, lanUrl: 'http://10.0.0.9:8791' }] }
const ROSTER_NONE = { units: [] }
const fx = { roster: ROSTER_ONE }
const stubLog = []
function installStub(cdp) {
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
    if (p.endsWith('/units') && m === 'GET') return json(fx.roster)
    if (p.endsWith('/inbox/broadcasts')) return json({ broadcasts: [] })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: [{ slug: 'e2e-agent', name: 'E2E Agent', description: 'Harness fixture' }] })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: [] })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: [] })
    if (p.endsWith('/agent/runs') && m === 'GET') return json({ runs: [] })
    if (p.endsWith('/agent/approvals/pending')) return json({ rev: '1', approvals: [] })
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: [{ id: 'e2e-model', name: 'E2E Model', provider: 'E2E', source: 'forsion', modelType: 'llm' }], directProviders: [], defaultModelId: 'e2e-model' })
    return cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'ConnectionRefused' }).catch(() => {})
  })
  return cdp.send('Fetch.enable', { patterns: [{ urlPattern: API_PATTERN, requestStage: 'Request' }] })
}

// ── Device helpers ──
const adbQ = (...a) => { try { return h.adb(...a) } catch (e) { return `${e.stdout || ''}${e.stderr || ''}` } }
/** The resumed activity on top ("pkg/.Cls"), from the activity manager. */
function topActivity() {
  // between two activities there is no resumed one for a moment: ask again rather than answer '?'
  for (let i = 0; i < 12; i++) {
    const out = h.adb('shell', 'dumpsys', 'activity', 'activities').split('\n')
    const line = out.find((l) => l.includes('topResumedActivity=')) || out.find((l) => /^\s*ResumedActivity:/.test(l))
    const m = line && line.match(/ (\S+\/\S+)/)
    if (m) return m[1]
    h.adb('shell', 'sleep', '0.25')
  }
  return '?'
}
const inApp = (top) => top.startsWith(`${PKG}/`) && !top.includes('BrowserController')
/** Activity starts the system logged since `mark` (logcat -c at the mark). */
const starts = () => h.adb('logcat', '-d', '-s', 'ActivityTaskManager:I').split('\n').filter((l) => / START /.test(l)).map((l) => (l.match(/cmp=(\S+)/) || [])[1]).filter(Boolean)
/** Wait for a browser (anything not ours) on top. */
async function waitBrowser(timeout = 15000) {
  const end = Date.now() + timeout
  let top = topActivity()
  while (Date.now() < end && (inApp(top) || top === '?')) { await h.pause(400); top = topActivity() }
  return top
}
async function backToApp() {
  for (let i = 0; i < 4 && !inApp(topActivity()); i++) { h.key(4); await h.pause(1500) }
  return topActivity()
}
/** The focused window's owner (the dialog windows of the app share its activity). */
function focusedWindow() {
  const out = h.adb('shell', 'dumpsys', 'window')
  const line = out.split('\n').find((l) => /mCurrentFocus=/.test(l)) || ''
  return line.trim()
}
const PERMS = ['android.permission.POST_NOTIFICATIONS', 'android.permission.RECORD_AUDIO']
function resetPerms() {
  for (const p of PERMS) {
    adbQ('shell', 'pm', 'revoke', PKG, p)
    adbQ('shell', 'pm', 'clear-permission-flags', PKG, p, 'user-set', 'user-fixed')
  }
}
function permFlags(p) {
  const dump = h.adb('shell', 'dumpsys', 'package', PKG)
  const line = dump.split('\n').find((l) => l.includes(`${p}: granted=`) && /runtime|flags/.test(l)) || dump.split('\n').find((l) => l.includes(`${p}: granted=`)) || ''
  return line.trim()
}
const pmClear = () => { h.adb('shell', 'am', 'force-stop', PKG); adbQ('shell', 'pm', 'clear', PKG); resetPerms() }
const start = () => h.adb('shell', 'am', 'start', '-n', ACTIVITY)
const webViewNode = (list) => list.find((n) => n.class === 'android.webkit.WebView')

// ── Page helpers (zoom-aware real touches, as native-shell-emu.cjs) ──
let cdp = null
async function attach({ stub = true } = {}) {
  if (cdp) cdp.close()
  cdp = await h.connect(PKG, CDP_PORT, 30000)
  await cdp.send('Page.enable')
  if (stub) await installStub(cdp)
  assert.ok(await h.waitPage(cdp, "document.readyState === 'complete' && !!window.Capacitor?.Plugins", 20000), 'page did not load')
  return cdp
}
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
  const wv = webViewNode(h.nodes(OUT))
  assert.ok(wv, 'no WebView on screen')
  return { x: Math.round(wv.rect.left + r.x * r.dpr), y: Math.round(wv.rect.top + r.y * r.dpr) }
}
async function tapEl(expr) { const p = await elPoint(expr); h.tapAt(p.x, p.y) }
/** Device-pixel rect of a page element. */
const elRect = (expr) => cdp.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect()
  let z = 1; for (let e = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1
  const k = z * devicePixelRatio; return { top: r.top * k, bottom: r.bottom * k, left: r.left * k, right: r.right * k } })()`)

const STEP = "document.querySelector('.ob-shell.ob-flow')?.dataset.step || ''"
const wizard = () => cdp.eval(`(() => { const w = document.querySelector('.ob-shell.ob-flow'); if (!w) return null
  return { step: w.dataset.step, phone: w.dataset.phone || null, mode: w.dataset.mode || null, dots: w.querySelectorAll('.ob3-dots button').length,
    skip: !!w.querySelector('.ob-skip'), primary: w.querySelector('[data-ob-primary]')?.textContent.trim() || null,
    primaryDisabled: !!w.querySelector('[data-ob-primary]')?.disabled, title: w.querySelector('[data-ob-title]')?.textContent.trim() || null } })()`)
async function waitStep(step, timeout = 10000) {
  const got = await h.waitPage(cdp, `(${STEP}) === ${JSON.stringify(step)}`, timeout)
  assert.ok(got, `wizard not on "${step}" (now: ${JSON.stringify(await cdp.eval(STEP).catch(() => '?'))})`)
  await h.pause(500) // step change animation
}
const keys = () => cdp.eval(`Object.fromEntries(['forsion_tangu_onboarding_done','forsion_tangu_onboarding_version','forsion_phone_guide_rev','forsion_phone_guide_step','forsion_phone_guide_suggest'].map((k) => [k, localStorage.getItem(k)]))`)
const permsRows = () => cdp.eval(`[...document.querySelectorAll('.ob3-perm')].map((r) => ({ cap: r.dataset.cap, state: r.dataset.state,
  on: !!r.querySelector('.settings-switch')?.classList.contains('active') || r.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true',
  name: r.querySelector('strong')?.textContent.trim() }))`)
const nativeStatus = () => cdp.eval(`Promise.all([Capacitor.Plugins.PhonePermissions.status(), Capacitor.Plugins.PhoneControl?.status?.().catch((e) => 'err ' + e)]).then(([p, c]) => ({ ...p, control: c }))`)

/**
 * Fresh install, then (signed in) token + keys seeded and the page reloaded under the stub.
 * seedKeys: extra localStorage entries; locale pinned to zh unless given.
 */
async function freshSignedIn(seedKeys = {}, { roster = ROSTER_ONE } = {}) {
  fx.roster = roster
  pmClear()
  start()
  await attach()
  await cdp.eval(`(async () => {
    await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: 'e2e-phone-guide.fake.token' })
    localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light')
    for (const [k, v] of Object.entries(${JSON.stringify(seedKeys)})) localStorage.setItem(k, v)
    return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await h.pause(1500)
  assert.ok(await h.waitPage(cdp, "document.readyState === 'complete'", 20000), 'reload did not finish')
}

// ── System dialogs ──
/** What dialog (if any) is in front: 'notify' | 'mic' | 'control' | 'other-perm' | null, with its evidence. */
function readDialog(list) {
  const perm = list.find((n) => (n['resource-id'] || '').startsWith('com.android.permissioncontroller:id/permission_'))
  if (perm) {
    const msg = list.find((n) => n['resource-id'] === 'com.android.permissioncontroller:id/permission_message')?.text || ''
    const kind = /notif|通知/i.test(msg) ? 'notify' : /audio|record|microphone|麦克风|录音/i.test(msg) ? 'mic' : 'other-perm'
    const buttons = list.filter((n) => /permission_(allow|deny)/.test(n['resource-id'] || '')).map((n) => `${n['resource-id'].split('/')[1]}="${n.text}"`)
    return { kind, pkg: perm.package, msg, buttons }
  }
  const b1 = list.find((n) => n['resource-id'] === 'android:id/button1')
  if (b1 && b1.package === PKG) {
    const title = list.find((n) => (n['resource-id'] || '').endsWith('alertTitle'))?.text || ''
    const msg = list.find((n) => n['resource-id'] === 'android:id/message')?.text || ''
    return { kind: 'control', pkg: b1.package, msg: `${title} | ${msg}`, buttons: list.filter((n) => /android:id\/button\d/.test(n['resource-id'] || '')).map((n) => `${n['resource-id'].split('/')[1]}="${n.text}"`) }
  }
  return null
}
async function waitDialog(timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    let list = []
    try { list = h.nodes(OUT) } catch { await h.pause(300); continue }
    const d = readDialog(list)
    if (d) return { ...d, list, top: topActivity(), focus: focusedWindow() }
    await h.pause(300)
  }
  return null
}
function tapRes(list, id) {
  const n = list.find((x) => x['resource-id'] === id)
  assert.ok(n, `no ${id} on screen`)
  h.tapNode(n)
}
/** Wait until the dialog of this kind is gone (the next one may already be up). */
async function waitNoDialog(kind = null, timeout = 6000) {
  const r = await h.waitNodes((l) => { const d = readDialog(l); return !d || (kind && d.kind !== kind) }, { timeout })
  assert.ok(r.hit, `a ${kind || ''} dialog stayed up`)
}
const tick = (cap) => tapEl(`document.querySelector('.ob3-perm[data-cap=${cap}] .settings-switch, .ob3-perm[data-cap=${cap}] [role=switch]')`)
const tapPrimary = () => tapEl("document.querySelector('.ob-shell.ob-flow [data-ob-primary]')")

;(async () => {
  assert.ok(h.adb('shell', 'pm', 'path', PKG).includes('package:'), `${PKG} is not installed`)
  { const info = h.adb('shell', 'dumpsys', 'package', PKG); const of = (re) => (info.match(re) || [])[1] || '?'
    console.log(`package: ${PKG} ${of(/versionName=(\S+)/)} (code ${of(/versionCode=(\d+)/)}), installed ${of(/lastUpdateTime=(.+)/)}; sdk ${h.adb('shell', 'getprop', 'ro.build.version.sdk').trim()}; airplane ${h.adb('shell', 'settings', 'get', 'global', 'airplane_mode_on').trim()}`) }
  try { h.adb('shell', 'cmd', 'statusbar', 'collapse') } catch { /* none */ }

  // ── C: signed in, fresh install, the whole wizard ──
  if (want('C')) {
    await check('C1 fresh signed-in start: pending → where, three dots, a computer to choose', async () => {
      await freshSignedIn()
      const sawPending = await h.waitPage(cdp, `(${STEP}) === 'pending' || (${STEP}) === 'where'`, 15000)
      note(`C1 first wizard step seen: ${sawPending ? await cdp.eval(STEP) : 'none'}`)
      await waitStep('where', 15000)
      const w = await wizard()
      note(`C1 wizard ${JSON.stringify(w)}`)
      assert.equal(w.phone, 'full')
      assert.equal(w.dots, 3, 'three dots (where, theme, perms)')
      assert.ok(w.skip, 'skip-guide link present in full mode')
      const radios = await cdp.eval("[...document.querySelectorAll('.ob3-main [role=radio]')].map((r) => r.textContent.trim().slice(0, 60))")
      note(`C1 where choices ${JSON.stringify(radios)}`)
      assert.ok(radios.length >= 2, `cloud + one computer expected, got ${radios.length} (stub saw /units: ${stubLog.some((l) => l.endsWith('/units'))})`)
      shot('C1-where')
    })
    await check('C2 system back on the first screen sends the app to the background, wizard kept', async () => {
      h.key(4)
      await h.pause(1500)
      const top = topActivity()
      note(`C2 after BACK top=${top} focus=${focusedWindow()}`)
      assert.ok(!top.startsWith(`${PKG}/`), `the app is still on top (${top})`)
      start()
      await h.pause(1500)
      note(`C2 after relaunch top=${topActivity()}`)
      assert.equal(await cdp.eval(STEP), 'where', 'back on the first screen closed or moved the wizard')
    })
    await check('C3 next → theme (phone variant); system back → where', async () => {
      await tapPrimary()
      await waitStep('theme')
      const v = await cdp.eval(`({ phone: !!document.querySelector('.ob3-theme.phone'), styles: !!document.querySelector('.ob3-styles'), preview: !!document.querySelector('.ob3-preview'), desc: document.querySelector('.ob3-head p')?.textContent.trim() })`)
      note(`C3 theme ${JSON.stringify(v)}`)
      shot('C3-theme')
      assert.ok(v.phone && !v.styles && !v.preview, 'phone theme variant: no style cards / preview')
      h.key(4)
      await waitStep('where')
      assert.ok(topActivity().startsWith(`${PKG}/`), 'back on theme left the app')
    })
    await check('C4 killed on theme → relaunch resumes on theme', async () => {
      await tapPrimary()
      await waitStep('theme')
      await h.pause(3000) // WebView flushes localStorage lazily
      const before = await keys()
      note(`C4 keys before kill ${JSON.stringify(before)}`)
      assert.equal(before.forsion_phone_guide_step, 'theme')
      h.adb('shell', 'am', 'force-stop', PKG)
      start()
      await attach()
      const after = await keys()
      note(`C4 keys after relaunch ${JSON.stringify(after)}`)
      await waitStep('theme', 15000)
      // under the stub from here on: reload keeps the same screen
      await cdp.send('Page.reload', { ignoreCache: true })
      await h.pause(1500)
      await waitStep('theme', 15000)
    })
    await check('C5 perms: three rows, all off, primary 跳过', async () => {
      await tapPrimary()
      await waitStep('perms')
      await h.pause(800)
      const rows = await permsRows()
      const w = await wizard()
      note(`C5 rows ${JSON.stringify(rows)} primary=${w.primary} native=${JSON.stringify(await nativeStatus())}`)
      shot('C5-perms')
      assert.deepEqual(rows.map((r) => r.cap), ['notify', 'control', 'voice'])
      assert.ok(rows.every((r) => r.state === 'off' && !r.on), 'all three off')
      assert.equal(w.primary, '跳过')
    })
    await check('C6 tick three → notification dialog, phone-control confirmation, microphone dialog, in order → guide closes', async () => {
      for (const c of ['notify', 'control', 'voice']) { await tick(c); await h.pause(400) }
      const w = await wizard()
      note(`C6 primary after ticking: ${w.primary}`)
      assert.equal(w.primary, '开启 3 项')
      await tapPrimary()
      const seen = []
      const answer = { notify: 'com.android.permissioncontroller:id/permission_allow_button', control: 'android:id/button1', mic: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button' }
      for (let i = 0; i < 3; i++) {
        const d = await waitDialog(15000)
        assert.ok(d, `dialog #${i + 1} never appeared (seen so far: ${seen.join(', ') || 'none'})`)
        seen.push(d.kind)
        note(`C6 dialog #${i + 1}: kind=${d.kind} pkg=${d.pkg} top=${d.top} ${d.focus} msg="${d.msg}" buttons=[${d.buttons.join(', ')}]`)
        shot(`C6-dialog-${i + 1}-${d.kind}`)
        assert.ok(answer[d.kind], `unexpected dialog ${d.kind}`)
        tapRes(d.list, answer[d.kind])
        await waitNoDialog(d.kind)
        await h.pause(600)
      }
      assert.deepEqual(seen, ['notify', 'control', 'mic'], 'dialog order')
      const closed = await h.waitPage(cdp, "!document.querySelector('.ob-shell.ob-flow')", 10000)
      note(`C6 after dialogs: wizard ${closed ? 'closed' : JSON.stringify(await wizard())}; native ${JSON.stringify(await nativeStatus())}; keys ${JSON.stringify(await keys())}`)
      assert.ok(closed, 'the wizard did not finish by itself after everything was allowed')
    })
    await check('C7 home: suggestions shown above the cards (4, or 2 where the screen is short), pill above the native dock', async () => {
      // the page steps down when one screen cannot hold everything: all → rows (cards: first two rows) → two (first two suggestions) → none
      assert.ok(await h.waitPage(cdp, "['all','rows','two'].includes(document.querySelector('.hp-root')?.getAttribute('data-suggest-fit'))", 10000), `suggestion block not shown (fit=${await cdp.eval("document.querySelector('.hp-root')?.getAttribute('data-suggest-fit') ?? null")})`)
      await h.pause(1200)
      const order = await cdp.eval(`(() => { const s = document.querySelector('.hp-suggest').getBoundingClientRect(), c = document.querySelector('.hp-cards')?.getBoundingClientRect()
        const drawn = (sel) => [...document.querySelectorAll(sel)].filter((b) => b.getBoundingClientRect().height > 0)
        return { fit: document.querySelector('.hp-root').getAttribute('data-suggest-fit'), suggestBottom: s.bottom, cardsTop: c ? c.top : null,
          chips: drawn('.hp-suggest-chip').map((b) => b.textContent.trim()), cardsDrawn: drawn('.hp-card').length, cardsInList: document.querySelectorAll('.hp-card').length } })()`)
      assert.ok(order.chips.length === (order.fit === 'two' ? 2 : 4), `fit ${order.fit} but ${order.chips.length} suggestions drawn`)
      assert.ok(order.cardsDrawn === (order.fit === 'all' ? order.cardsInList : Math.min(order.cardsInList, 4)), `fit ${order.fit} but ${order.cardsDrawn}/${order.cardsInList} cards drawn`)
      const pill = await elRect("document.querySelector('.hp-pill')")
      const wv = webViewNode(h.nodes(OUT))
      const dock = h.byId(h.nodes(OUT), 'nativeChrome.dock')
      note(`C7 ${JSON.stringify(order)} pill(device px, in WebView)=${JSON.stringify(pill)} webview=${JSON.stringify(wv && wv.rect)} dock=${JSON.stringify(dock && dock.rect)}`)
      shot('C7-home-suggest')
      assert.ok(order.cardsTop === null || order.suggestBottom <= order.cardsTop + 1, 'suggestions not above the cards')
      const pillBottom = wv.rect.top + pill.bottom
      if (dock) assert.ok(pillBottom <= dock.rect.top, `pill bottom ${Math.round(pillBottom)} below dock top ${dock.rect.top}`)
      else {
        // a tablet in landscape has the Spaces on a side rail, no bottom dock: the pill only has to stay inside the page
        assert.ok(h.byId(h.nodes(OUT), 'nativeChrome.rail'), 'neither a native dock nor a side rail on screen')
        assert.ok(pillBottom <= wv.rect.bottom, `pill bottom ${Math.round(pillBottom)} below the page bottom ${wv.rect.bottom}`)
      }
    })
    await check('C8 tap a suggestion: composer opens with the text, keyboard up, nothing sent', async () => {
      const text = await cdp.eval("document.querySelector('.hp-suggest-chip[data-suggest=today]').textContent.trim()")
      const since = stubLog.length
      await tapEl("document.querySelector('.hp-suggest-chip[data-suggest=today]')")
      await h.pause(1500)
      const field = "document.querySelector('.hp-root .hp-composer textarea, .hp-root .composer textarea, textarea')"
      const st = await cdp.eval(`(() => { const f = ${field}; return { value: f ? f.value : null, focused: document.activeElement === f, composer: getComputedStyle(document.querySelector('.hp-root .hp-composer')).display } })()`)
      const ime = /mInputShown=true/.test(h.adb('shell', 'dumpsys', 'input_method'))
      const sent = stubLog.slice(since).filter((l) => /^POST .*\/(runs|messages|sessions)/.test(l))
      note(`C8 chip="${text}" composer=${JSON.stringify(st)} ime=${ime} posts=${JSON.stringify(sent)}`)
      shot('C8-suggest-tapped')
      assert.equal(st.value, text, 'composer text is the suggestion')
      assert.ok(ime, 'keyboard is not up')
      assert.deepEqual(sent, [], 'something was sent')
      h.key(4) // keyboard down
    })
  }

  // ── D: refusal + never ask twice ──
  if (want('D')) {
    await check('D1 deny the notification dialog: wizard stays, switch off, result line, primary = shell default', async () => {
      await freshSignedIn()
      await waitStep('where', 15000)
      await tapPrimary(); await waitStep('theme')
      await tapPrimary(); await waitStep('perms'); await h.pause(800)
      await tick('notify'); await h.pause(400)
      await tapPrimary()
      const d = await waitDialog(15000)
      assert.ok(d && d.kind === 'notify', `notification dialog expected, got ${d && d.kind}`)
      note(`D1 dialog kind=${d.kind} pkg=${d.pkg} top=${d.top} msg="${d.msg}" buttons=[${d.buttons.join(', ')}]`)
      tapRes(d.list, 'com.android.permissioncontroller:id/permission_deny_button')
      await waitNoDialog()
      await h.pause(1500)
      const w = await wizard()
      const rows = await permsRows()
      const result = await cdp.eval("document.querySelector('.ob3-perms-result')?.textContent.trim() || null")
      note(`D1 wizard=${JSON.stringify(w)} rows=${JSON.stringify(rows)} result="${result}" native=${JSON.stringify(await nativeStatus())}`)
      shot('D1-denied')
      assert.ok(w && w.step === 'perms', 'wizard left the perms screen')
      assert.ok(!rows.find((r) => r.cap === 'notify').on, 'notify switch back to off')
      // Spec copy table: 「已开 {n} 项，还有 {m} 项没开…」 — nothing was turned on; the one asked is not on.
      assert.equal(result, '已开 0 项，还有 3 项没开，可在 设置 里补开')
      assert.equal(w.primary, '开始使用', 'primary falls back to the shell default')
    })
    await check('D2 finish; LiveIsland.show asks nothing (the guide already asked)', async () => {
      await tapPrimary()
      assert.ok(await h.waitPage(cdp, "!document.querySelector('.ob-shell.ob-flow')", 10000), 'wizard did not close')
      note(`D2 keys ${JSON.stringify(await keys())} flags ${permFlags('android.permission.POST_NOTIFICATIONS')}`)
      note(`D2 prefs ${adbQ('shell', 'run-as', PKG, 'cat', 'shared_prefs/forsion_phone_permissions.xml').replace(/\s+/g, ' ')}`)
      await cdp.eval(`void Capacitor.Plugins.LiveIsland.show({ title: 'perm', text: 'running', chip: '', sessionId: 's', channelName: 'c', more: 0, since: Date.now() }); 1`)
      const d = await waitDialog(6000)
      note(`D2 after LiveIsland.show: ${d ? `dialog ${d.kind} msg="${d.msg}"` : 'no dialog'}; top=${topActivity()}`)
      if (d) { shot('D2-unexpected-dialog'); tapRes(d.list, 'com.android.permissioncontroller:id/permission_deny_button') }
      await cdp.eval(`void Capacitor.Plugins.LiveIsland.show({ title: 'perm', text: 'done', chip: '', sessionId: 's', channelName: 'c', more: 0, since: Date.now(), done: true, quiet: true }); 1`).catch(() => {})
      assert.equal(d, null, 'LiveIsland asked for notifications a second time')
    })
    await check('D3 control: fresh install where the guide never asked → LiveIsland.show does ask', async () => {
      await freshSignedIn({ forsion_tangu_onboarding_done: '1' }) // no guide at all
      await h.pause(3000)
      assert.equal(await cdp.eval("!!document.querySelector('.ob-shell.ob-flow')"), false, 'a wizard showed with only the done key')
      await cdp.eval(`void Capacitor.Plugins.LiveIsland.show({ title: 'perm', text: 'running', chip: '', sessionId: 's', channelName: 'c', more: 0, since: Date.now() }); 1`)
      const d = await waitDialog(8000)
      note(`D3 after LiveIsland.show: ${d ? `dialog ${d.kind} pkg=${d.pkg} top=${d.top} msg="${d.msg}"` : 'no dialog'}`)
      if (d) { shot('D3-island-asks'); tapRes(d.list, 'com.android.permissioncontroller:id/permission_allow_button'); await waitNoDialog() }
      await cdp.eval(`void Capacitor.Plugins.LiveIsland.show({ title: 'perm', text: 'done', chip: '', sessionId: 's', channelName: 'c', more: 0, since: Date.now(), done: true, quiet: true }); 1`).catch(() => {})
      assert.ok(d && d.kind === 'notify', 'LiveIsland did not ask on a fresh install')
    })
  }

  // ── A: signed out, first run ──
  if (want('A')) {
    await check('A1 first run signed out: welcome (signin/full), no browser by itself', async () => {
      pmClear()
      h.adb('logcat', '-c')
      start()
      await attach({ stub: false })
      const ok = await h.waitPage(cdp, "!!document.querySelector('.ob3[data-step=signin]')", 15000)
      await h.pause(2500) // a browser opening by itself would be up by now
      const top = topActivity()
      const v = await cdp.eval(`(() => { const w = document.querySelector('.ob3[data-step=signin]'); return w && { mode: w.dataset.mode, h1: w.querySelector('h1')?.textContent.trim(), btn: w.querySelector('[data-ob-primary]')?.textContent.trim(), lang: document.documentElement.lang } })()`)
      note(`A1 welcome=${JSON.stringify(v)} top=${top} activity starts since launch=${JSON.stringify(starts())}`)
      assert.ok(!starts().some((c) => /BrowserController|chrome/i.test(c)), 'a browser was started by itself')
      shot('A1-welcome-cold')
      assert.ok(ok && v, 'welcome not rendered')
      assert.equal(v.mode, 'full')
      assert.ok(top.startsWith(`${PKG}/`), `something else came to the front: ${top}`)
    })
    await check('A2 welcome in zh vs mock a0; system bars do not overlap content', async () => {
      await cdp.eval("localStorage.setItem('tangu_locale', 'zh'); true")
      await cdp.send('Page.reload', { ignoreCache: true })
      await h.pause(1500)
      assert.ok(await h.waitPage(cdp, "!!document.querySelector('.ob3[data-step=signin]')", 15000), 'welcome not rendered after reload')
      await h.pause(1500)
      const list = h.nodes(OUT)
      const wv = webViewNode(list)
      const head = await elRect("document.querySelector('.ob3[data-step=signin] .ob3-top')")
      const btn = await elRect("document.querySelector('.ob3[data-step=signin] [data-ob-primary]')")
      const brand = await elRect("document.querySelector('.ob3[data-step=signin] .ob3-brand')")
      const bars = h.adb('shell', 'dumpsys', 'window', 'windows').split('\n').filter((l) => /StatusBar|NavigationBar/.test(l) && /Window\{/.test(l)).map((l) => l.trim()).slice(0, 4)
      const sizes = h.adb('shell', 'wm', 'size').trim()
      note(`A2 webview=${JSON.stringify(wv && wv.rect)} top=${JSON.stringify(head)} brand=${JSON.stringify(brand)} button=${JSON.stringify(btn)} ${sizes}`)
      const insets = await cdp.eval("(() => { const s = getComputedStyle(document.documentElement); return { top: s.getPropertyValue('--safe-top') || s.getPropertyValue('--sat'), envTop: getComputedStyle(document.body).paddingTop } })()")
      note(`A2 insets ${JSON.stringify(insets)} bars ${JSON.stringify(bars)}`)
      shot('A2-welcome-zh')
      // status bar ≈ 63 px at 420 dpi (24 dp), gesture bar ≈ 63 px: content must sit inside
      const screenH = Number(sizes.match(/x(\d+)/)[1])
      assert.ok(wv.rect.top + head.top >= 60 || wv.rect.top >= 60, `top row at ${Math.round(wv.rect.top + head.top)} px, under the status bar`)
      assert.ok(wv.rect.top + btn.bottom <= screenH - 40, `primary button bottom ${Math.round(wv.rect.top + btn.bottom)} px, under the navigation bar`)
    })
    await check('A3 tap the primary → a browser tab in front; BACK → welcome again, button usable', async () => {
      h.adb('logcat', '-c')
      await tapEl("document.querySelector('.ob3[data-step=signin] [data-ob-primary]')")
      const top = await waitBrowser()
      await h.pause(1000)
      note(`A3 after tap top=${top} starts=${JSON.stringify(starts())}`)
      shot('A3-browser')
      assert.ok(!inApp(top) && top !== '?', 'no browser came to the front')
      const back = await backToApp()
      note(`A3 after BACK top=${back}`)
      assert.ok(inApp(back), `app not back in front (${back})`)
      await h.pause(4500) // the button re-arms on resume or after 4 s
      const v = await cdp.eval(`(() => { const w = document.querySelector('.ob3[data-step=signin]'); const b = w?.querySelector('[data-ob-primary]'); return w && { mode: w.dataset.mode, disabled: !!b?.disabled, busy: !!b?.querySelector('.spin'), text: b?.textContent.trim() } })()`)
      note(`A3 welcome after back ${JSON.stringify(v)}`)
      shot('A3-back-welcome')
      assert.ok(v && v.mode === 'full', 'welcome gone after back')
      assert.ok(!v.disabled && !v.busy, 'button still busy after coming back')
    })
  }

  // ── B: signed out, returning user ──
  if (want('B')) {
    await check('B1 returning user signed out: browser opens at once; BACK → compact welcome with 登录', async () => {
      pmClear()
      start()
      await attach({ stub: false })
      assert.ok(await h.waitPage(cdp, "!!document.querySelector('.ob3[data-step=signin]')", 15000), 'welcome not rendered on first run')
      await cdp.eval("localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('tangu_locale', 'zh'); true")
      await h.pause(3000)
      h.adb('shell', 'am', 'force-stop', PKG)
      h.adb('logcat', '-c')
      start()
      const top = await waitBrowser()
      await h.pause(1000)
      note(`B1 after relaunch top=${top} starts=${JSON.stringify(starts())}`)
      shot('B1-browser')
      assert.ok(!inApp(top) && top !== '?', 'the sign-in browser did not open by itself')
      const back = await backToApp()
      note(`B1 after BACK top=${back}`)
      assert.ok(inApp(back), `app not back in front (${back})`)
      await attach({ stub: false })
      const k = await cdp.eval("localStorage.getItem('forsion_tangu_onboarding_done')")
      const v = await h.waitPage(cdp, `(() => { const w = document.querySelector('.ob3[data-step=signin]'); return w && { mode: w.dataset.mode, h1: w.querySelector('h1')?.textContent.trim(), btn: w.querySelector('[data-ob-primary]')?.textContent.trim(), card: !!w.querySelector('.ob3-card') } })()`, 8000)
      note(`B1 done key after relaunch=${k} welcome=${JSON.stringify(v)}`)
      shot('B1-compact')
      assert.ok(v, 'blank page after back (no welcome)')
      assert.equal(v.mode, 'returning')
      assert.equal(v.btn, '登录')
    })
  }

  // ── E: existing signed-in users ──
  if (want('E')) {
    await check('E1 done + version, no rev: only perms, no dots, no skip; Skip → rev 1, no suggest; relaunch → none', async () => {
      await freshSignedIn({ forsion_tangu_onboarding_done: '1', forsion_tangu_onboarding_version: '2.13.7' })
      await waitStep('perms', 15000)
      await h.pause(800)
      const w = await wizard()
      note(`E1 wizard ${JSON.stringify(w)}`)
      shot('E1-update-perms')
      assert.equal(w.phone, 'update')
      assert.equal(w.dots, 0, 'no dots')
      assert.equal(w.skip, false, 'no skip-guide link')
      assert.equal(w.primary, '跳过')
      await tapPrimary()
      assert.ok(await h.waitPage(cdp, "!document.querySelector('.ob-shell.ob-flow')", 8000), 'wizard did not close')
      await h.pause(3000)
      const k = await keys()
      note(`E1 keys after skip ${JSON.stringify(k)}`)
      assert.equal(k.forsion_phone_guide_rev, '1')
      assert.equal(k.forsion_phone_guide_suggest, null)
      assert.equal(await cdp.eval("document.querySelectorAll('.hp-suggest-chip').length"), 0, 'suggestions shown after an update run')
      h.adb('shell', 'am', 'force-stop', PKG)
      start()
      await attach()
      await cdp.send('Page.reload', { ignoreCache: true })
      await h.pause(5000)
      assert.equal(await cdp.eval("!!document.querySelector('.ob-shell.ob-flow')"), false, 'wizard again after relaunch')
    })
    await check('E2 only the done key (what other benches seed): no wizard at all', async () => {
      await freshSignedIn({ forsion_tangu_onboarding_done: '1' })
      await h.pause(5000)
      const shell = await cdp.eval("!!document.querySelector('.hp-root, .mb-shell')")
      assert.ok(shell, 'app shell not mounted')
      assert.equal(await cdp.eval("!!document.querySelector('.ob-shell.ob-flow')"), false, 'a wizard showed')
    })
  }

  // ── F: Settings › device permissions ──
  if (want('F')) {
    await check('F1 settings › permissions: rows reflect real state; blocked notify → system settings', async () => {
      // state: microphone allowed (granted before start); notifications get denied twice through the row itself below.
      // (pm set-permission-flags user-fixed is not enough: Capacitor reads "prompt" until it asked once itself.)
      await freshSignedIn({ forsion_tangu_onboarding_done: '1' })
      await h.pause(2000)
      h.adb('shell', 'pm', 'grant', PKG, 'android.permission.RECORD_AUDIO')
      await h.pause(1000)
      note(`F1 native ${JSON.stringify(await nativeStatus())}`)
      // open settings through the account menu (top bar)
      let list = h.nodes(OUT)
      if (!h.byId(list, 'nativeChrome.account') && h.byId(list, 'nativeChrome.left')) { h.tapNode(h.byId(list, 'nativeChrome.left')); await h.pause(1200); list = h.nodes(OUT) }
      const acct = h.byId(list, 'nativeChrome.account')
      assert.ok(acct, 'no account button to reach settings')
      h.tapNode(acct)
      const sheet = await h.waitNodes((l) => h.byId(l, 'nativeSheet.item.rb-settings'), { timeout: 8000 })
      assert.ok(sheet.hit, 'account sheet has no settings item')
      h.tapNode(sheet.hit)
      assert.ok(await h.waitPage(cdp, "!!document.querySelector('.settings-page--mobile')", 8000), 'settings did not open')
      await h.pause(1200)
      const rows = await cdp.eval("[...document.querySelectorAll('.settings-mobile-row')].map((e) => e.querySelector('strong')?.textContent.trim())")
      note(`F1 settings rows ${JSON.stringify(rows)}`)
      const label = rows.find((r) => /权限/.test(r || ''))
      assert.ok(label, 'no permissions entry in settings')
      await tapEl(`[...document.querySelectorAll('.settings-mobile-row')].find((e) => e.querySelector('strong')?.textContent.trim() === ${JSON.stringify(label)})`)
      await h.pause(1500)
      const rowSwitch = (name) => `[...document.querySelectorAll('.settings-page--mobile .settings-control-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}))?.querySelector('.settings-switch, [role=switch]')`
      const states = () => cdp.eval(`(() => { const p = document.querySelector('.settings-page--mobile'); const sw = (n) => { const e = ${rowSwitch('NAME')}; return e ? { on: e.classList.contains('active') || e.getAttribute('aria-checked') === 'true', disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' } : null }
        return { notify: sw('提醒我'), voice: sw('用语音说'), notifyOpen: !!p.querySelector('[data-cap-open=notify]') } })()`.replace(/"NAME"/g, 'n'))
      note(`F1 rows before ${JSON.stringify(await states())} native ${JSON.stringify(await nativeStatus())}`)
      shot('F1-settings-perms-before')
      // ask from the row and deny, until the system stops asking (Android 13+: after the second refusal)
      for (let i = 1; i <= 3 && !(await cdp.eval("!!document.querySelector('[data-cap-open=notify]')")); i++) {
        await tapEl(rowSwitch('提醒我'))
        const d = await waitDialog(6000)
        note(`F1 ask #${i} from the settings row: ${d ? `dialog ${d.kind} top=${d.top} msg="${d.msg}"` : 'no dialog'}`)
        if (d) {
          note(`F1 ask #${i} buttons=[${d.buttons.join(', ')}]`)
          const deny = d.list.find((n) => /permission_deny_and_dont_ask_again_button$/.test(n['resource-id'] || '')) || d.list.find((n) => /permission_deny_button$/.test(n['resource-id'] || ''))
          assert.ok(deny, 'no deny button'); h.tapNode(deny); await waitNoDialog(d.kind)
        }
        await h.pause(1500)
        note(`F1 after ask #${i}: rows ${JSON.stringify(await states())} native ${JSON.stringify(await nativeStatus())}`)
      }
      const panel = await cdp.eval(`(() => { const p = document.querySelector('.settings-page--mobile'); return { open: !!p.querySelector('[data-cap-open=notify]'), text: p.innerText.slice(0, 600) } })()`)
      note(`F1 panel ${JSON.stringify(panel)}`)
      shot('F1-settings-perms')
      assert.ok(panel.open, 'blocked notifications row has no system-settings button')
      await tapEl("document.querySelector('[data-cap-open=notify]')")
      await h.pause(2500)
      const top = topActivity()
      note(`F1 after tap top=${top}`)
      shot('F1-system-settings')
      assert.ok(/com\.android\.settings/.test(top), `system settings not in front (${top})`)
      h.key(4); await h.pause(1500)
      start()
    })
  }

  if (cdp) cdp.close()
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} passed · ${h.timing()}`)
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, evidence, stubLog: stubLog.slice(-200) }, null, 2))
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(2) })
