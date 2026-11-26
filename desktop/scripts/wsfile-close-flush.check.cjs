/**
 * Close a tab, reload the window or quit the app right after typing: the last keystrokes must reach the disk.
 *
 * Workspace (outside-vault) `.md` tabs are WsFileView → MdFileEditor → PlainMarkdownEditor (Milkdown). Typing sits in
 * two places before it is on disk: the Milkdown listener's 200ms debounce (the editor holds it) and MdFileEditor's 800ms
 * save debounce. Baselines (2026-11-24):
 *   close — the listener *cancels* its pending call when the editor is destroyed: lost at 1 / 51 / 101 ms and via the
 *     tab menu at 6 ms, kept at 200 / 400 ms. Fixed by #857 (PlainMarkdownEditor hands the held edit over on unmount).
 *   reload / quit — React cleanup never runs when the renderer goes away, and WsFileView had no unload / quit flush: up
 *     to ~1s of typing lost (see the PR that added the `reload` / `quit` phases for the measured baseline).
 *   toolbar Reload — the file was read before the outgoing editor saved: the new editor showed pre-save text with the
 *     old mtime and the next edit raised a false conflict.
 *
 * Real Electron (built out/) × isolated home × stub engine. Each trial opens its own file through the OS "open file"
 * route (same as a Finder double-click), types chunk A, waits until A is saved, types chunk B, then acts DELAY ms after
 * the last keyup (measured in the page) and reads the bytes on disk.
 *   PHASES=close  × close at each DELAY · tab menu → Close · flushed bytes == debounced bytes · untouched open/click/close
 *                 stays byte-identical · file changed on disk meanwhile → external bytes kept, B goes to the sidecar
 *                 (CAS, not around it) · edit → source right after typing keeps B · vault notes reported (LIB=0 skips).
 *   PHASES=reload webContents.reload() from the main process (what recoverRenderer / Cmd+R do) at 0 / 500 ms, the
 *                 renderer's own reloadWindow() (app:reloadWindow) · after the reload the editor shows B and typing C
 *                 saves without a conflict · file changed on disk → external kept, B in exactly one sidecar · untouched
 *                 stays byte-identical · toolbar Reload right after typing → editor shows B, C saves without a conflict ·
 *                 conflict banner → Reload → external shown, B in exactly one sidecar.
 *   PHASES=quit   app.quit() (Cmd+Q / tray Quit) at 0 / 500 ms, one launch per trial, bytes read after the process
 *                 exited · ENGINE=1 trial emulates the managed engine's exit (before-quit prevented, app.exit(0) 50ms
 *                 later: no unload events) · file changed on disk → external kept, B in exactly one sidecar · untouched
 *                 stays byte-identical.
 * INFO lines: whether an async write fired from `pagehide` lands on each exit route, and whether before-quit was
 * already prevented when the probe's listener ran (after the app's own).
 * Not covered: a renderer that crashed or hangs (render-process-gone / unresponsive → reload) cannot run anything.
 *
 *   node <repo root>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="wsfile close flush" --eta=8 -- npm run check:wsfileflush
 *
 * Run `npm run build` first. DELAYS=0,50,100,200,400 (close phase). Evidence: OUT (default <tmp>/wsfile-close-flush/result.json).
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const DESK = path.join(__dirname, '..')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'wsfile-close-flush'); fs.mkdirSync(OUT, { recursive: true })
const DELAYS = (process.env.DELAYS || '0,50,100,200,400').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
const PHASES = new Set((process.env.PHASES || 'close,reload,quit').split(',').map((s) => s.trim()))
const LIB = process.env.LIB !== '0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FM = '---\ntitle: Close flush\ntags: [a, b]\n---\n'
const INITIAL = `${FM}# Close flush\n\nFirst paragraph.\n`
const EXTERNAL = `${FM}# Changed elsewhere\n\nSomeone else wrote this.\n`
const UNTOUCHED = `${FM}###   Title   ###\n\n* star bullet\n*   spaced\n\nPara  with  two  spaces\n`
const A = ' alpha'; const B = ' QZomega'; const C = ' XKgamma'

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-wsflush-'))
  const proj = path.join(root, 'proj'); fs.mkdirSync(proj, { recursive: true })
  const stub = await startStubEngine()
  const out = { root, checks: [], trials: [], errors: [], rendererEvents: [], mainLog: [] }
  const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2))
  const check = (name, ok, got) => { out.checks.push({ name, ok: !!ok, got }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(got ?? null).slice(0, 300)) }
  const info = (name, got) => { out.checks.push({ name: `INFO ${name}`, ok: true, got }); console.log('INFO', name, JSON.stringify(got ?? null).slice(0, 300)) }
  let app = null; let win = null; let vault = null; let launches = 0

  /** A fresh isolated home per launch (the quit phase needs one per trial); the project folder is shared. */
  const launch = async () => {
    const home = path.join(root, `home-${++launches}`)
    const ud = path.join(home, 'userdata'); vault = path.join(home, 'Vault')
    for (const d of [ud, `${ud}-dev`, vault]) fs.mkdirSync(d, { recursive: true })
    for (const d of [ud, `${ud}-dev`]) for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
    app = await electron.launch({
      args: [`--user-data-dir=${ud}`, '--lang=zh-CN', DESK], cwd: DESK,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') },
    })
    // The main process reloads the renderer when it goes unresponsive (a loaded machine) or an engine/UI hot update
    // rolls back; record why. Probe lines from the main process too.
    for (const st of [app.process().stdout, app.process().stderr]) st?.on('data', (b) => {
      for (const line of String(b).split('\n')) {
        if (/renderer recover|render-process-gone|rolled-back/.test(line)) out.rendererEvents.push(line.slice(0, 200))
        if (line.includes('[wsflush-probe]')) out.mainLog.push(line.slice(0, 200))
      }
    })
    win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000, state: 'attached' })
    const skipped = await skipOnboarding(win)
    if (launches === 1) check('onboarding skipped', skipped)
    await sleep(1500)
  }

  // Last keystroke time, read in the page so the measured gap has no CDP round trip in it. Re-installed per trial:
  // a renderer reload drops it.
  const hook = () => win.evaluate(() => {
    const w = window
    if (w.__wsflushKeyHook) return
    w.__wsflushKeyHook = true
    document.addEventListener('keyup', () => { w.__wsflushLastKey = performance.now() }, true)
  })
  const openFile = (file) => app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), file)
  const stemOf = (file) => path.basename(file).replace(/\.md$/, '')
  /** Runs in the page: wait until `d` ms after the last keyup, then do `act`; returns the measured gap (ms) or null. */
  const inPage = (d, stem, act) => win.evaluate(async ({ d: delay, stem: s, act: what }) => {
    const w = window
    const tab = [...document.querySelectorAll('.wb-tab')].find((t) => (t.getAttribute('title') || '').startsWith(s))
    if (!tab) return null
    let target = null
    if (what === 'x') target = tab.querySelector('.wb-tab-close')
    else if (what === 'menu') {
      // Right-click menu → Close, driven in the page: a real mouse round trip alone is ~350ms, past the 200ms window.
      const before = new Set(document.querySelectorAll('button[data-act="close"]'))
      const r = tab.getBoundingClientRect()
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 12, clientY: r.y + r.height / 2 }))
      for (let i = 0; i < 60 && !target; i++) {
        await new Promise((res) => requestAnimationFrame(res))
        target = [...document.querySelectorAll('button[data-act="close"]')].find((b) => !before.has(b) && b.offsetParent) || null
      }
    } else if (what === 'reload') {
      // the wsfile header's ⟳ (the visible one; html files have a second one in their own segment)
      target = [...document.querySelectorAll('.wsfile-head button.icon-btn')].find((b) => b.offsetParent && b.querySelector('svg.lucide-refresh-cw')) || null
    } else if (what === 'banner-reload') {
      target = [...document.querySelectorAll('.wsmd-banner')].find((b) => b.offsetParent)?.querySelector('button') || null
    } else if (what === 'wait' || what === 'reloadwin') {
      target = { click: what === 'reloadwin' ? () => setTimeout(() => { void w.tangu.reloadWindow() }, 0) : () => {} }
    } else {
      // 'source' / 'edit': the view-mode pill of the visible wsfile view (edit = 0, source = 1)
      const pills = [...document.querySelectorAll('.lcl-vmode-pill')].filter((p) => p.offsetParent)
      target = pills[0]?.querySelectorAll('button[role="tab"]')[what === 'source' ? 1 : 0] || null
    }
    if (!target) return null
    const wait = delay - (performance.now() - w.__wsflushLastKey)
    if (wait > 0) await new Promise((res) => setTimeout(res, wait))
    const gap = performance.now() - w.__wsflushLastKey
    target.click()
    return Math.round(gap)
  }, { d, stem, act })
  const tabOpen = (stem) => win.evaluate((s) => [...document.querySelectorAll('.wb-tab')].some((t) => (t.getAttribute('title') || '').startsWith(s)), stem)
  const closeQuietly = (stem) => win.evaluate((s) => { const t = [...document.querySelectorAll('.wb-tab')].find((x) => (x.getAttribute('title') || '').startsWith(s)); t?.querySelector('.wb-tab-close')?.click() }, stem).catch(() => {})
  const sidecars = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(stemOf(file)) && f !== path.basename(file) && f.endsWith('.md'))
  const sidecarsWithB = (file) => sidecars(file).map((f) => ({ f, b: fs.readFileSync(path.join(path.dirname(file), f), 'utf8').includes(B.trim()) }))
  const visibleBanner = () => win.evaluate(() => [...document.querySelectorAll('.wsmd-banner')].filter((b) => b.offsetParent).map((b) => b.textContent || ''))
  /** Probe-only: does a write fired from `pagehide` (async IPC) land on this exit route? */
  const unloadMarker = async (name) => {
    const marker = path.join(proj, `${name}.pagehide-marker`)
    await win.evaluate((m) => { addEventListener('pagehide', () => { void window.tangu?.writeHostFile?.(m, 'pagehide', undefined, true) }) }, marker)
    return marker
  }

  /** Opens `file`, puts the caret at the end of the last paragraph; returns the editor locator. */
  const openAndFocus = async (file, kind) => {
    await hook()
    await openFile(file)
    const ed = win.locator(`${kind === 'ws' ? '.wsmd-scope' : '.unified-body'} .ProseMirror`).filter({ visible: true }).first() // one file open at a time
    await ed.waitFor({ timeout: 20_000 })
    await sleep(1200) // editor `ready` flips on the next frame; let the mount settle
    await ed.locator('p').last().click()
    await win.keyboard.press('End')
    return ed
  }
  /** Opens `file`, clicks into the text and moves the caret without typing. */
  const openUntouched = async (file) => {
    await hook()
    await openFile(file)
    const ed = win.locator('.wsmd-scope .ProseMirror').filter({ visible: true }).first()
    await ed.waitFor({ timeout: 20_000 }); await sleep(1200)
    await ed.locator('p').last().click(); await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft')
    return ed
  }
  /** open → type A → A saved → type B → (`between`) */
  const typeAB = async (file, kind, rec, between) => {
    const ed = await openAndFocus(file, kind)
    await win.keyboard.type(A)
    await sleep(2200) // A: 200ms listener + 800ms save debounce (ws) / note autosave → on disk before B
    rec.aBefore = fs.readFileSync(file, 'utf8').includes(A.trim())
    await win.keyboard.type(B)
    if (between) await between(file)
    return ed
  }
  const readBack = (file, rec) => {
    rec.disk = fs.readFileSync(file, 'utf8')
    rec.a = rec.disk.includes(A.trim()); rec.b = rec.disk.includes(B.trim())
    rec.sidecars = sidecarsWithB(file)
  }
  const logTrial = (rec) => {
    out.trials.push(rec)
    const { disk, file: _f, sourceShows, editorShows, diskAfter, ...brief } = rec
    console.log('TRIAL', rec.name, JSON.stringify(brief).slice(0, 500))
    save()
  }
  /** After a reload: reopen the file; the editor must show B, and typing C must save without a conflict. */
  const keepEditing = async (file, rec) => {
    const ed = await openAndFocus(file, 'ws')
    rec.editorShowsB = ((await ed.textContent().catch(() => '')) || '').includes(B.trim())
    await win.keyboard.type(C)
    await sleep(2400)
    rec.bannerAfterC = await visibleBanner()
    rec.diskAfter = fs.readFileSync(file, 'utf8')
    rec.c = rec.diskAfter.includes(C.trim()); rec.bAfter = rec.diskAfter.includes(B.trim())
    rec.sidecarsAfter = sidecars(file)
  }

  /** open → type A → A saved → type B → (`between`) → `act` `delay` ms after the last key → read the disk. */
  const trial = async (opts, retried = false) => {
    const { kind, name, delay, act, between } = opts
    const file = path.join(kind === 'ws' ? proj : vault, `${name}.md`)
    fs.writeFileSync(file, INITIAL)
    const rec = { name, kind, act, delay, file }
    try {
      const ed = await typeAB(file, kind, rec, between)
      rec.gap = await inPage(delay, name, act)
      if (rec.gap == null) throw new Error(`no target for ${act}`)
      await sleep(300)
      if (act === 'source') {
        rec.sourceShows = await win.evaluate(() => document.querySelector('.wsmd-edit')?.textContent || '')
        await inPage(0, name, 'edit')
        await sleep(1200)
        rec.editorShows = (await ed.textContent().catch(() => '')) || ''
        await sleep(1500) // 800ms save debounce
      } else {
        rec.tabGone = !(await tabOpen(name))
        await sleep(3000) // unmount save + any note autosave
      }
      readBack(file, rec)
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 400)
      await win.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {})
      if (!retried && /Execution context was destroyed|navigation/.test(rec.error)) {
        // The renderer reloaded under the trial (not something the trial did): record it, let the page come back, re-run once.
        rec.disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
        out.trials.push({ ...rec, reloaded: true })
        console.log('RELOAD during', name, '- re-running once; renderer events:', JSON.stringify(out.rendererEvents.slice(-3)))
        await win.waitForSelector('.dv-groupview', { timeout: 40_000, state: 'attached' }).catch(() => {})
        await sleep(2500)
        if (await tabOpen(name).catch(() => false)) { await closeQuietly(name); await sleep(1500) }
        return trial({ ...opts, name: `${name}-retry` }, true)
      }
      out.errors.push({ trial: name, err: rec.error })
    }
    if (await tabOpen(name).catch(() => false)) { await closeQuietly(name); await sleep(1500) }
    logTrial(rec)
    return rec
  }
  const okB = (r) => !r.error && r.tabGone && r.a && r.b && !r.sidecars.length

  /** Window reload `delay` ms after B: `how` = 'main' (webContents.reload() from the main process) | 'host' (the
   *  renderer's reloadWindow() → app:reloadWindow). `between` runs after B (external change); `untouched` skips typing. */
  const reloadTrial = async ({ name, delay = 0, how = 'main', between, untouched }) => {
    const file = path.join(proj, `${name}.md`)
    fs.writeFileSync(file, untouched ? UNTOUCHED : INITIAL)
    const rec = { name, act: `reload:${how}`, delay, file }
    const events = out.rendererEvents.length
    try {
      if (untouched) await openUntouched(file)
      else await typeAB(file, 'ws', rec, between)
      const marker = await unloadMarker(name)
      rec.gap = await inPage(delay, name, how === 'host' ? 'reloadwin' : 'wait')
      if (rec.gap == null) throw new Error('no tab')
      if (how === 'main') await app.evaluate(({ BrowserWindow }) => { (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]).webContents.reload() })
      await sleep(800)
      await win.waitForSelector('.dv-groupview', { timeout: 40_000, state: 'attached' })
      await sleep(2500)
      rec.pagehideWriteLanded = fs.existsSync(marker)
      if (untouched) { rec.disk = fs.readFileSync(file, 'utf8'); rec.sidecars = sidecarsWithB(file) } else readBack(file, rec)
      if (!untouched && !between) await keepEditing(file, rec)
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 400)
      await win.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {})
      out.errors.push({ trial: name, err: rec.error })
    }
    rec.rendererEvents = out.rendererEvents.slice(events)
    if (await tabOpen(name).catch(() => false)) { await closeQuietly(name); await sleep(1500) }
    logTrial(rec)
    return rec
  }

  /** Toolbar ⟳ `delay` ms after B (banner: the file changes on disk after A, B's save conflicts, then the banner's Reload). */
  const toolbarTrial = async ({ name, delay = 0, banner = false }) => {
    const file = path.join(proj, `${name}.md`)
    fs.writeFileSync(file, INITIAL)
    const rec = { name, act: banner ? 'banner-reload' : 'toolbar-reload', delay, file }
    try {
      const ed = await openAndFocus(file, 'ws')
      await win.keyboard.type(A)
      await sleep(2200)
      rec.aBefore = fs.readFileSync(file, 'utf8').includes(A.trim())
      if (banner) {
        fs.writeFileSync(file, EXTERNAL)
        await win.keyboard.type(B)
        await sleep(2200) // B's debounced save hits the CAS and raises the banner
        rec.bannerBefore = await visibleBanner()
      } else await win.keyboard.type(B)
      rec.gap = await inPage(delay, name, banner ? 'banner-reload' : 'reload')
      if (rec.gap == null) throw new Error('no reload button')
      await sleep(2500)
      rec.editorShows = (await ed.textContent().catch(() => '')) || ''
      readBack(file, rec)
      if (!banner) {
        await ed.locator('p').last().click()
        await win.keyboard.press('End')
        await win.keyboard.type(C)
        await sleep(2400)
        rec.bannerAfterC = await visibleBanner()
        rec.diskAfter = fs.readFileSync(file, 'utf8')
        rec.c = rec.diskAfter.includes(C.trim()); rec.bAfter = rec.diskAfter.includes(B.trim())
        rec.sidecarsAfter = sidecars(file)
      }
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 400)
      await win.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {})
      out.errors.push({ trial: name, err: rec.error })
    }
    if (await tabOpen(name).catch(() => false)) { await closeQuietly(name); await sleep(1500) }
    logTrial(rec)
    return rec
  }

  /** Own launch: type, then app.quit() `delay` ms after B and read the bytes once the process exited.
   *  engine: emulate the managed engine's exit (before-quit prevented, app.exit(0) 50ms later — no unload events). */
  const quitTrial = async ({ name, delay = 0, engine = false, between, untouched }) => {
    const file = path.join(proj, `${name}.md`)
    fs.writeFileSync(file, untouched ? UNTOUCHED : INITIAL)
    const rec = { name, act: engine ? 'quit:engine-exit' : 'quit', delay, file }
    let exited = null
    try {
      await launch()
      exited = new Promise((res) => app.process().once('exit', (code, sig) => res(code ?? sig)))
      if (untouched) await openUntouched(file)
      else await typeAB(file, 'ws', rec, between)
      const marker = await unloadMarker(name)
      const log = out.mainLog.length
      await app.evaluate(({ app: a }, emulate) => {
        a.on('before-quit', (e) => {
          console.error(`[wsflush-probe] before-quit prevented=${e.defaultPrevented}`)
          if (!emulate || e.defaultPrevented) return
          e.preventDefault()
          setTimeout(() => a.exit(0), 50)
        })
      }, engine)
      rec.gap = await inPage(delay, name, 'wait')
      if (rec.gap == null) throw new Error('no tab')
      await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0) })
      rec.exit = await Promise.race([exited, sleep(30_000).then(() => 'timeout')])
      rec.beforeQuit = out.mainLog.slice(log)
      rec.pagehideWriteLanded = fs.existsSync(marker)
      if (untouched) { rec.disk = fs.readFileSync(file, 'utf8'); rec.sidecars = sidecarsWithB(file) } else readBack(file, rec)
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 400)
      await win?.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {})
      out.errors.push({ trial: name, err: rec.error })
    } finally {
      if (rec.exit == null || rec.exit === 'timeout') await app?.close().catch(() => {})
      app = null; win = null
    }
    logTrial(rec)
    return rec
  }

  try {
    if (PHASES.has('close') || PHASES.has('reload')) await launch()
    if (PHASES.has('close')) {
      // 1. × close at each delay
      const byDelay = {}
      for (const d of DELAYS) {
        const r = byDelay[d] = await trial({ kind: 'ws', name: `ws-x-${d}`, delay: d, act: 'x' })
        check(`ws × close at ${d}ms: B on disk`, okB(r), { gap: r.gap, a: r.a, b: r.b, sidecars: r.sidecars, error: r.error })
      }
      // 2. tab menu → Close
      {
        const r = await trial({ kind: 'ws', name: 'ws-menu-0', delay: 0, act: 'menu' })
        check('ws tab menu → Close at ~0ms: B on disk', okB(r), { gap: r.gap, a: r.a, b: r.b, sidecars: r.sidecars, error: r.error })
      }
      // 3. flushed bytes == debounced bytes; frontmatter kept
      {
        const lo = byDelay[Math.min(...DELAYS)]; const hi = byDelay[Math.max(...DELAYS)]
        const same = !!(lo?.disk && hi?.disk && lo.disk === hi.disk)
        check('ws bytes written by the close flush == bytes written after the debounce', same, same ? { bytes: lo.disk.length } : { flushed: lo?.disk, debounced: hi?.disk })
        check('ws frontmatter kept byte-for-byte', !!hi?.disk?.startsWith(FM), hi?.disk?.slice(0, 80))
      }
      // 4. untouched: open → click into the text → arrows → close; normalization-prone source must stay byte-identical
      {
        const file = path.join(proj, 'ws-untouched.md')
        fs.writeFileSync(file, UNTOUCHED)
        try {
          await openUntouched(file)
          if (await inPage(0, 'ws-untouched', 'x') == null) throw new Error('no close button')
          await sleep(2000)
        } catch (e) { out.errors.push({ trial: 'ws-untouched', err: String(e && e.message || e).slice(0, 300) }) }
        const after = fs.readFileSync(file, 'utf8')
        check('ws open → click → close without typing: file byte-identical, no sidecar', after === UNTOUCHED && !sidecars(file).length,
          after === UNTOUCHED ? { sidecars: sidecars(file) } : after)
      }
      // 5. the file changed on disk meanwhile: the flushed edit must go through the CAS save (conflict → sidecar)
      {
        const r = await trial({ kind: 'ws', name: 'ws-conflict-0', delay: 0, act: 'x', between: async (file) => { await sleep(30); fs.writeFileSync(file, EXTERNAL) } })
        const side = (r.sidecars || []).find((s) => s.b)
        check('ws changed on disk + close at ~0ms: external bytes kept, B saved to a sidecar', !r.error && r.disk === EXTERNAL && !!side,
          { gap: r.gap, keptExternal: r.disk === EXTERNAL, sidecars: r.sidecars, error: r.error })
      }
      // 6. edit → source right after typing (the editor unmounts, MdFileEditor stays)
      {
        const r = await trial({ kind: 'ws', name: 'ws-source-0', delay: 0, act: 'source' })
        check('ws edit → source at ~0ms → back to edit: B on disk, in the source pane and in the editor', !r.error && r.a && r.b && (r.sourceShows || '').includes(B.trim()) && (r.editorShows || '').includes(B.trim()),
          { gap: r.gap, a: r.a, b: r.b, editor: (r.editorShows || '').includes(B.trim()), sourcePane: (r.sourceShows || '').includes(B.trim()), error: r.error })
      }
      // 7. vault notes (v4 unified editor), same × gesture — reported only
      if (LIB) {
        for (const d of DELAYS) {
          const r = await trial({ kind: 'lib', name: `lib-x-${d}`, delay: d, act: 'x' })
          info(`lib × close at ${d}ms`, { gap: r.gap, a: r.a, b: r.b, error: r.error })
        }
      }
    }
    if (PHASES.has('reload')) {
      const reloaded = (r) => !r.error && r.a && r.b && !r.sidecars.length && r.editorShowsB && r.c && r.bAfter && !r.bannerAfterC?.length && !r.sidecarsAfter?.length
      const brief = (r) => ({ gap: r.gap, a: r.a, b: r.b, sidecars: r.sidecars, editorShowsB: r.editorShowsB, c: r.c, bannerAfterC: r.bannerAfterC, sidecarsAfter: r.sidecarsAfter, rendererEvents: r.rendererEvents, error: r.error })
      // 8. window reload from the main process (recoverRenderer / Cmd+R) inside the listener window and the save debounce
      for (const d of [0, 500]) {
        const r = await reloadTrial({ name: `ws-reload-${d}`, delay: d, how: 'main' })
        check(`ws window reload (main process) at ${d}ms: B on disk; after it the editor shows B and C saves without a conflict`, reloaded(r), brief(r))
        info(`async write from pagehide landed (main-process reload at ${d}ms)`, r.pagehideWriteLanded)
      }
      // 9. the renderer's own reloadWindow() (app:reloadWindow)
      {
        const r = await reloadTrial({ name: 'ws-reloadwin-0', delay: 0, how: 'host' })
        check('ws reloadWindow() at ~0ms: B on disk; after it the editor shows B and C saves without a conflict', reloaded(r), brief(r))
        info('async write from pagehide landed (reloadWindow)', r.pagehideWriteLanded)
      }
      // 10. file changed on disk, then reload: CAS keeps the external bytes, B goes to exactly one sidecar
      {
        const r = await reloadTrial({ name: 'ws-reload-conflict-0', delay: 0, how: 'main', between: async (file) => { await sleep(30); fs.writeFileSync(file, EXTERNAL) } })
        const withB = (r.sidecars || []).filter((s) => s.b)
        check('ws changed on disk + window reload at ~0ms: external bytes kept, B in exactly one sidecar', !r.error && r.disk === EXTERNAL && withB.length === 1 && r.sidecars.length === 1,
          { gap: r.gap, keptExternal: r.disk === EXTERNAL, sidecars: r.sidecars, error: r.error })
      }
      // 11. untouched through a reload
      {
        const r = await reloadTrial({ name: 'ws-reload-untouched', how: 'main', untouched: true })
        check('ws open → click → window reload without typing: file byte-identical, no sidecar', !r.error && r.disk === UNTOUCHED && !r.sidecars.length,
          r.disk === UNTOUCHED ? { sidecars: r.sidecars, error: r.error } : { disk: r.disk, error: r.error })
      }
      // 12. toolbar ⟳ right after typing: read after the outgoing editor saved
      {
        const r = await toolbarTrial({ name: 'ws-toolbar-reload-0', delay: 0 })
        const shows = (r.editorShows || '').includes(B.trim())
        check('ws toolbar Reload at ~0ms: B on disk and in the editor; C then saves without a conflict', !r.error && r.a && r.b && shows && r.c && r.bAfter && !r.bannerAfterC?.length && !r.sidecarsAfter?.length,
          { gap: r.gap, b: r.b, editorShowsB: shows, c: r.c, bannerAfterC: r.bannerAfterC, sidecars: r.sidecars, sidecarsAfter: r.sidecarsAfter, error: r.error })
      }
      // 13. conflict banner → Reload: the disk version is shown, B goes to exactly one sidecar
      {
        const r = await toolbarTrial({ name: 'ws-banner-reload', delay: 0, banner: true })
        const withB = (r.sidecars || []).filter((s) => s.b)
        check('ws conflict banner → Reload: external bytes kept and shown, B in exactly one sidecar', !r.error && !!r.bannerBefore?.length && r.disk === EXTERNAL && (r.editorShows || '').includes('Someone else wrote this') && withB.length === 1 && r.sidecars.length === 1,
          { bannerBefore: r.bannerBefore, keptExternal: r.disk === EXTERNAL, editorShowsExternal: (r.editorShows || '').includes('Someone else wrote this'), sidecars: r.sidecars, error: r.error })
      }
    }
    if (app) { await app.close().catch(() => {}); app = null; win = null }
    if (PHASES.has('quit')) {
      const quitOk = (r) => !r.error && r.exit === 0 && r.a && r.b && !r.sidecars.length
      const brief = (r) => ({ gap: r.gap, exit: r.exit, a: r.a, b: r.b, sidecars: r.sidecars, beforeQuit: r.beforeQuit, error: r.error })
      // 14. app.quit() (Cmd+Q / tray Quit) inside the listener window and the save debounce
      for (const d of [0, 500]) {
        const r = await quitTrial({ name: `ws-quit-${d}`, delay: d })
        check(`ws app quit at ${d}ms: B on disk after the process exited`, quitOk(r), brief(r))
        info(`async write from pagehide landed (app quit at ${d}ms)`, r.pagehideWriteLanded)
      }
      // 15. the managed engine's exit route: before-quit prevented, then app.exit(0) — no unload events in the renderer
      {
        const r = await quitTrial({ name: 'ws-quit-engine-0', delay: 0, engine: true })
        check('ws app quit at ~0ms, engine-stop exit route (app.exit): B on disk after the process exited', quitOk(r), brief(r))
        info('async write from pagehide landed (app.exit route)', r.pagehideWriteLanded)
      }
      // 16. file changed on disk, then quit
      {
        const r = await quitTrial({ name: 'ws-quit-conflict-0', delay: 0, between: async (file) => { await sleep(30); fs.writeFileSync(file, EXTERNAL) } })
        const withB = (r.sidecars || []).filter((s) => s.b)
        check('ws changed on disk + app quit at ~0ms: external bytes kept, B in exactly one sidecar', !r.error && r.exit === 0 && r.disk === EXTERNAL && withB.length === 1 && r.sidecars.length === 1,
          { gap: r.gap, exit: r.exit, keptExternal: r.disk === EXTERNAL, sidecars: r.sidecars, error: r.error })
      }
      // 17. untouched through a quit
      {
        const r = await quitTrial({ name: 'ws-quit-untouched', untouched: true })
        check('ws open → click → app quit without typing: file byte-identical, no sidecar', !r.error && r.exit === 0 && r.disk === UNTOUCHED && !r.sidecars.length,
          r.disk === UNTOUCHED ? { exit: r.exit, sidecars: r.sidecars, error: r.error } : { disk: r.disk, error: r.error })
      }
    }
  } catch (e) {
    out.errors.push({ step: 'main', err: String(e && e.stack || e).slice(0, 800) })
    console.log('ERROR', String(e && e.message || e).slice(0, 400))
  } finally {
    save()
    await app?.close().catch(() => {})
    try { stub.close() } catch { /* already down */ }
  }
  const fails = out.checks.filter((c) => !c.ok)
  console.log(`\n${out.checks.length - fails.length}/${out.checks.length} passed, ${out.errors.length} errors → ${path.join(OUT, 'result.json')}`)
  process.exit(fails.length || out.errors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
