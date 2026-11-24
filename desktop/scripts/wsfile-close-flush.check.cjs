/**
 * Close a tab right after typing: the last keystrokes must reach the disk.
 *
 * Workspace (outside-vault) `.md` tabs are WsFileView → MdFileEditor → PlainMarkdownEditor (Milkdown). The Milkdown
 * listener debounces `markdownUpdated` by 200ms and *cancels* the pending call when the editor is destroyed, so text
 * typed in the last ~200ms before the tab closed never reached MdFileEditor's unmount save (baseline 2026-11-24:
 * lost at 1 / 51 / 101 ms and via the tab menu at 6 ms, kept at 200 / 400 ms). PlainMarkdownEditor now hands the held
 * edit over synchronously when it unmounts (flush, not cancel).
 *
 * Real Electron (built out/) × isolated home × stub engine. Each trial opens its own file through the OS "open file"
 * route (same as a Finder double-click), types chunk A, waits until A is saved, types chunk B, then closes / switches
 * after DELAY ms (measured in the page from the last keyup) and reads the bytes on disk.
 *   × close at each DELAY · tab menu → Close · flushed bytes == debounced bytes · untouched open/click/close stays
 *   byte-identical · file changed on disk meanwhile → external bytes kept, B goes to the sidecar (CAS, not around it) ·
 *   edit → source right after typing keeps B.
 * Every other close gesture (drag elsewhere, closing a group/window) ends in the same closeLeaf → unmount.
 * Vault notes (Amadeus v4 unified editor) are measured with the same × gesture and reported (LIB=0 skips them).
 *
 *   node <repo root>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="wsfile close flush" --eta=5 -- npm run check:wsfileflush
 *
 * Run `npm run build` first. DELAYS=0,50,100,200,400 (default). Evidence: OUT (default <tmp>/wsfile-close-flush/result.json).
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const DESK = path.join(__dirname, '..')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'wsfile-close-flush'); fs.mkdirSync(OUT, { recursive: true })
const DELAYS = (process.env.DELAYS || '0,50,100,200,400').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
const LIB = process.env.LIB !== '0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FM = '---\ntitle: Close flush\ntags: [a, b]\n---\n'
const INITIAL = `${FM}# Close flush\n\nFirst paragraph.\n`
const A = ' alpha'; const B = ' QZomega'

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-wsflush-'))
  const ud = path.join(home, 'userdata'); const vault = path.join(home, 'Vault'); const proj = path.join(home, 'proj')
  for (const d of [ud, `${ud}-dev`, vault, proj]) fs.mkdirSync(d, { recursive: true })
  for (const d of [ud, `${ud}-dev`]) for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine()
  const app = await electron.launch({
    args: [`--user-data-dir=${ud}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') },
  })
  const out = { home, checks: [], trials: [], errors: [], rendererEvents: [] }
  // The main process reloads the renderer when it goes unresponsive (a loaded machine) or an engine/UI hot update
  // rolls back; record why, a trial caught in one is re-run (see `trial`).
  for (const st of [app.process().stdout, app.process().stderr]) st?.on('data', (b) => {
    for (const line of String(b).split('\n')) if (/renderer recover|render-process-gone|rolled-back/.test(line)) out.rendererEvents.push(line.slice(0, 200))
  })
  const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2))
  const check = (name, ok, got) => { out.checks.push({ name, ok: !!ok, got }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(got ?? null).slice(0, 300)) }
  let win
  try {
    win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000, state: 'attached' })
    check('onboarding skipped', await skipOnboarding(win))
    await sleep(1500)
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
    const sidecars = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(stemOf(file)) && f !== path.basename(file))

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
    /** open → type A → A saved → type B → (`between`) → `act` `delay` ms after the last key → read the disk. */
    const trial = async (opts, retried = false) => {
      const { kind, name, delay, act, between } = opts
      const file = path.join(kind === 'ws' ? proj : vault, `${name}.md`)
      fs.writeFileSync(file, INITIAL)
      const rec = { name, kind, act, delay, file }
      try {
        const ed = await openAndFocus(file, kind)
        await win.keyboard.type(A)
        await sleep(2200) // A: 200ms listener + 800ms save debounce (ws) / note autosave → on disk before B
        rec.aBefore = fs.readFileSync(file, 'utf8').includes(A.trim())
        await win.keyboard.type(B)
        if (between) await between(file)
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
        rec.disk = fs.readFileSync(file, 'utf8')
        rec.a = rec.disk.includes(A.trim()); rec.b = rec.disk.includes(B.trim())
        rec.sidecars = sidecars(file).map((f) => ({ f, b: fs.readFileSync(path.join(path.dirname(file), f), 'utf8').includes(B.trim()) }))
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
      out.trials.push(rec)
      const { disk, file: _f, sourceShows, editorShows, ...brief } = rec
      console.log('TRIAL', name, JSON.stringify(brief).slice(0, 400))
      save()
      return rec
    }
    const okB = (r) => !r.error && r.tabGone && r.a && r.b && !r.sidecars.length

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
      const raw = `${FM}###   Title   ###\n\n* star bullet\n*   spaced\n\nPara  with  two  spaces\n`
      fs.writeFileSync(file, raw)
      try {
        await openFile(file)
        const ed = win.locator('.wsmd-scope .ProseMirror').filter({ visible: true }).first()
        await ed.waitFor({ timeout: 20_000 }); await sleep(1200)
        await ed.locator('p').last().click(); await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft')
        if (await inPage(0, 'ws-untouched', 'x') == null) throw new Error('no close button')
        await sleep(2000)
      } catch (e) { out.errors.push({ trial: 'ws-untouched', err: String(e && e.message || e).slice(0, 300) }) }
      const after = fs.readFileSync(file, 'utf8')
      check('ws open → click → close without typing: file byte-identical, no sidecar', after === raw && !sidecars(file).length,
        after === raw ? { sidecars: sidecars(file) } : after)
    }
    // 5. the file changed on disk meanwhile: the flushed edit must go through the CAS save (conflict → sidecar)
    {
      const EXTERNAL = `${FM}# Changed elsewhere\n\nSomeone else wrote this.\n`
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
        console.log(`INFO lib × close at ${d}ms: B ${r.error ? `not measured (${r.error.slice(0, 80)})` : r.b ? 'on disk' : 'LOST'}`)
        out.checks.push({ name: `INFO lib × close at ${d}ms`, ok: true, got: { gap: r.gap, a: r.a, b: r.b, error: r.error } })
      }
    }
  } catch (e) {
    out.errors.push({ step: 'main', err: String(e && e.stack || e).slice(0, 800) })
    console.log('ERROR', String(e && e.message || e).slice(0, 400))
  } finally {
    save()
    await app.close().catch(() => {})
    try { stub.close() } catch { /* already down */ }
  }
  const fails = out.checks.filter((c) => !c.ok)
  console.log(`\n${out.checks.length - fails.length}/${out.checks.length} passed, ${out.errors.length} errors → ${path.join(OUT, 'result.json')}`)
  process.exit(fails.length || out.errors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
