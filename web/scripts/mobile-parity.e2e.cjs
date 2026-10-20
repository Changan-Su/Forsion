/** Real built Web mobile shell, with isolated browser storage and fixture APIs. No native host or live account.
 * Run after web build: npm run e2e:mobile. Saves screenshots and a machine-readable report. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { startPreview } = require('../../mobile/scripts/lib/preview.cjs')
const { startStubEngine } = require('../../desktop/scripts/lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.resolve(process.env.OUT || path.join(ROOT, 'outputs/mobile-parity'))
const results = []
fs.mkdirSync(OUT, { recursive: true })
function executable() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath()
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const file = path.join(root, dir, rel)
        if (fs.existsSync(file)) return file
      }
    }
  }
  throw new Error('Install Chromium or set CHROMIUM_EXE')
}
const session = (id, title) => ({ id, title, summary: 'Fixture preview', model_id: 'fixture-model', archived: false,
  emoji: null, agent_config: { execMode: 'host', approvalMode: 'auto-edit' }, project_path: null, project_name: null,
  projectless: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
const messages = [{ id: 'fixture-message', role: 'model', content: 'Fixture reply', timestamp: Date.now(), model_id: 'fixture-model' }]

async function main() {
  const preview = await startPreview(ROOT)
  await preview.ready()
  const renames = []
  const stub = await startStubEngine({ sessions: [session('fixture-one', 'Fixture session one'), session('fixture-two', 'Fixture session two')], messages,
    models: [{ id: 'fixture-model', name: 'Fixture model', provider: 'Fixture', source: 'forsion', modelType: 'llm' }],
    override: async ({ path: url, method, body }) => {
      if (url === '/agent/sessions/fixture-one' && method === 'PATCH') { const value = await body(); renames.push(value); return { ...session('fixture-one', value.title), ...value } }
    },
  })
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const boards = new Map()
  const fixtureApi = (ctx) => ctx.route('**/api/**', async (route) => {
    const u = new URL(route.request().url())
    const p = u.pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/auth/me') return json({ id: 'fixture-user', username: 'Fixture' })
    if (p === '/auth/region') return json({ country: 'GB' })
    if (p === '/amadeus/vaults') return json({ vaults: [{ id: 'default', name: 'Fixture vault', lastChangeSeq: 1, sizeBytes: 0, createdAt: new Date().toISOString() }] })
    if (p.endsWith('/tree')) return json({ pages: ['Fixture note.md', ...[...boards.keys()]], folders: [], files: [], seq: 1 })
    if (p.endsWith('/file')) {
      // Boards round-trip through this in-memory store (the tablet board check creates one); everything else reads the note.
      const file = route.request().method() === 'PUT' ? route.request().postDataJSON() : null
      const at = file?.path ?? u.searchParams.get('path') ?? ''
      if (/\.excalidraw\.md$/.test(at)) {
        if (file) { const seq = (boards.get(at)?.seq ?? 1) + 1; boards.set(at, { content: file.content, seq }); return json({ seq, hash: `fixture-${seq}` }) }
        const board = boards.get(at)
        if (!board) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) })
        return json({ path: at, kind: 'page', content: board.content, seq: board.seq, hash: `fixture-${board.seq}`, updatedAt: new Date().toISOString() })
      }
      return json({ path: 'Fixture note.md', kind: 'page', content: '# Fixture note\n\nFixture body.\n', seq: 1, hash: 'fixture', updatedAt: new Date().toISOString() })
    }
    if (p.endsWith('/asset-token')) return json({ token: 'fixture-asset', ttlSec: 300 })
    if (/\/events$|\/stream$/.test(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    const response = await route.fetch({ url: stub.url + p + u.search })
    return route.fulfill({ response })
  })
  try {
    for (const config of [{ width: 390, locale: 'zh-CN', mode: 'light' }, { width: 320, locale: 'en-GB', mode: 'dark' }]) {
      const ctx = await browser.newContext({ viewport: { width: config.width, height: 844 }, hasTouch: true, isMobile: true, locale: config.locale })
      const errors = []
      await ctx.addInitScript((cfg) => {
        localStorage.setItem('forsion_token', 'fixture-only')
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('tangu_locale', cfg.locale.startsWith('zh') ? 'zh' : 'en')
        localStorage.setItem('forsion_theme', cfg.mode)
        localStorage.setItem('forsion_theme_lang', 'lovable')
      }, config)
      await fixtureApi(ctx)
      const page = await ctx.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/before-forsion', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Before Forsion</title><p>Previous page</p>' }))
      await page.goto(preview.url + 'before-forsion')
      await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-browser-mobile-chrome]', { timeout: 60_000 })
      await page.waitForTimeout(1600)
      const check = async (name, fn) => {
        try { await fn(); results.push({ name: `${config.width}/${config.locale}/${config.mode}: ${name}`, ok: true }); console.log('PASS', name) }
        catch (error) {
          results.push({ name, ok: false, error: String(error) })
          const geometry = await page.evaluate(() => [...document.querySelectorAll('.bmc-chrome,.bmc-top,.bmc-dock,.bmc-capsule,.mb-shell')].map((el) => {
            const c = getComputedStyle(el); return { class: el.className, mode: el.getAttribute('data-mode'), text: el.textContent, rect: el.getBoundingClientRect().toJSON(), css: { position: c.position, display: c.display, visibility: c.visibility, opacity: c.opacity, zIndex: c.zIndex, zoom: c.zoom }, sheets: [...document.styleSheets].map((s) => ({href:s.href,disabled:s.disabled})) }
          }))
          fs.writeFileSync(path.join(OUT, `fail-${results.length}.json`), JSON.stringify({ geometry, errors }, null, 2))
          await page.screenshot({ path: path.join(OUT, `fail-${results.length}.png`) })
          throw error
        }
      }
      const sheet = () => page.locator('[data-browser-mobile-sheet]')
      const shot = async (name) => { await page.waitForTimeout(650); await page.screenshot({ path: path.join(OUT, name) }) }
      const listGeometry = async () => {
        await page.waitForTimeout(650)
        const value = await page.locator('.mb-drawer--left').evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, width: r.width, viewport: innerWidth } })
        assert(Math.abs(value.left) < 1 && Math.abs(value.width - value.viewport) < 1, JSON.stringify(value))
      }
      const closeSheet = () => page.locator('.bmc-sheet-head > button').last().click()
      // installBrowserBack keeps one same-URL history entry while the app has somewhere to go back to (true) and prunes it at
      // the boundary (false). Both happen a frame after the state change; a goBack / reload before that races the history.
      const guardSettled = (guarded) => page.waitForFunction((g) => !!(history.state && history.state.forsionMobileBack) === g, guarded, { timeout: 5000 })
      const item = (id) => page.locator(`button.bmc-sheet-row[data-sheet-item="${id}"]`)
      await check('touch viewport automatically installs mobile dock', async () => {
        // Product default remains Tangu; explicitly visit Home for the home screenshot below.
        assert.equal(await page.locator('.mb-shell').getAttribute('data-space'), 'tangu')
        assert(await page.locator('.bmc-dock [data-space]').count() > 1)
        assert.equal(await page.locator('.mb-drawer-foot').count(), 0)
        assert.equal(await page.locator('.bmc-chrome').evaluate((el) => getComputedStyle(el).position), 'fixed', 'Chrome CSS is loaded in the actual Web bundle')
        const hit = await page.locator('.bmc-dock').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
        assert(hit, 'Dock fits the viewport')
      })
      await page.locator('.bmc-dock [data-space="home"]').click()
      await page.waitForSelector('.mb-shell[data-space="home"]')
      await shot(`home-${config.width}-${config.mode}.png`)
      await check('all Spaces and dock picks stay usable and save on close', async () => {
        await page.locator('[data-chrome-action="spacesAll"]').click()
        await item('dock:edit').click()
        await page.waitForSelector('[data-browser-mobile-sheet="checklist"]')
        await sheet().evaluate((el) => { el.dataset.stable = 'same-sheet' })
        const toggles = sheet().locator('input[type=checkbox]')
        const n = await toggles.count()
        assert(n > 3)
        for (let i = 0; i < n; i++) if (await toggles.nth(i).isChecked()) await toggles.nth(i).uncheck()
        await toggles.nth(n - 1).check()
        assert.equal(await sheet().getAttribute('data-stable'), 'same-sheet')
        await closeSheet()
        assert((await page.evaluate(() => JSON.parse(localStorage.getItem('lcl_dock_pins_v1')))).length === 1)
        // Home is the back boundary: closing the sheet prunes the guard entry with history.back(). Reloading while that
        // traversal is in flight aborts the reload (ERR_ABORTED). Wait for the guard to settle, as a person would.
        await guardSettled(false)
        await page.reload()
        await page.waitForSelector('.bmc-dock')
        assert.equal(await page.locator('.bmc-dock [data-space]').count(), 2)
      })
      await check('Space list is first level; session opens detail and Back returns to the list', async () => {
        await page.locator('[data-chrome-action="spacesAll"]').click()
        await item('space:tangu').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await page.getByText('Fixture session one', { exact: true }).click()
        await page.waitForSelector('.mb-shell[data-nav="detail"]')
        assert.equal(await page.locator('.bmc-dock').count(), 0)
        assert(await page.locator('[data-chrome-action="left"] svg').count())
        await page.locator('[data-chrome-action="left"]').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await page.getByText('Fixture session one', { exact: true }).click()
        await page.waitForSelector('.mb-shell[data-nav="detail"]')
        await guardSettled(true)
        await page.goBack()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await listGeometry()
      })
      await shot(`sessions-${config.width}-${config.mode}.png`)
      await check('session menu action opens prompt and delivers rename; cancel preserves it', async () => {
        await page.getByText('Fixture session one', { exact: true }).click({ button: 'right' })
        await item('rename').click()
        await page.waitForSelector('[data-browser-mobile-sheet="prompt"]')
        await page.locator('#bmc-prompt').fill('Renamed fixture')
        const before = renames.length
        await sheet().locator('button[type="submit"]').click()
        await page.getByText('Renamed fixture', { exact: true }).waitFor()
        await page.waitForTimeout(150)
        assert.equal(renames.length, before + 1)
        assert.equal(renames.at(-1).title, 'Renamed fixture')
        await page.getByText('Renamed fixture', { exact: true }).click({ button: 'right' })
        await item('rename').click()
        await page.waitForSelector('#bmc-prompt')
        await page.locator('#bmc-prompt').fill('Discard this')
        await closeSheet()
        assert.equal(renames.length, before + 1)
        assert(await page.getByText('Renamed fixture', { exact: true }).count())
      })
      await check('view search and More use mobile actions; browser Back closes the sheet', async () => {
        await page.locator('[data-chrome-action="search"]').click()
        await page.waitForSelector('.amx-qf-scrim')
        await page.goBack()
        await page.waitForTimeout(200)
        assert.equal(await page.locator('.amx-qf-scrim').count(), 0)
        await page.locator('[data-chrome-action="more"]').click()
        await page.waitForSelector('[data-browser-mobile-sheet="menu"]')
        assert(await sheet().locator('[data-sheet-item="rb-cmd"]').count())
        await page.waitForTimeout(100)
        await page.goBack()
        await page.waitForSelector('[data-browser-mobile-sheet]', { state: 'detached' })
      })
      await check('account menu reaches settings; mobile page header Back and Close work', async () => {
        await page.locator('[data-chrome-action="account"]').click()
        await item('rb-settings').click()
        await page.waitForSelector('.settings-page--mobile')
        assert.equal(await page.locator('[data-browser-mobile-chrome]').getAttribute('data-mode'), 'page')
        const header = await page.locator('[data-chrome-action="back"]').evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2)?.closest('button') === el })
        assert(header, 'Back is not blocked by settings')
        await shot(`settings-${config.width}-${config.mode}.png`)
        await page.locator('.settings-mobile-row').filter({ has: page.locator('strong', { hasText: config.locale.startsWith('zh') ? /^外观$/ : /^Appearance$/ }) }).click()
        await page.waitForSelector('[data-chrome-action="close"]')
        await page.locator('[data-chrome-action="back"]').click()
        await page.waitForSelector('.settings-page--mobile-menu')
        await page.waitForTimeout(100)
        await page.goBack()
        await page.waitForSelector('.settings-page--mobile', { state: 'detached' })
      })
      await check('Note retains mobile categories, search, note detail and return', async () => {
        await page.locator('[data-chrome-action="spacesAll"]').click()
        await item('space:amadeus').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await page.waitForSelector('.amx-tree .pl-chips')
        assert.equal(await page.locator('.bmc-heading .bmc-title > small').textContent(), config.locale.startsWith('zh') ? '云端智库' : 'Cloud vault')
        assert.equal(await page.locator('.amx-tree [data-filter="boards"]').count(), 1)
        assert.equal(await page.locator('[data-chrome-action="search"]').count(), 1)
        await page.locator('.amx-tree [data-filter="tree"]').click()
        await page.getByText('Fixture note', { exact: true }).click()
        await page.waitForSelector('.mb-shell[data-nav="detail"]')
        await page.waitForSelector('.ProseMirror')
        await page.locator('[data-chrome-action="left"]').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await listGeometry()
        assert.equal(await page.locator('.amx-tree .t2s-foot .t2s-special').filter({ hasText: config.locale.startsWith('zh') ? '云端智库' : 'Cloud vault' }).count(), 1, 'Cloud vault management stays reachable')
        await shot(`notes-${config.width}-${config.mode}.png`)
      })
      await check('return Home then browser Back leaves the app; no empty-page trap', async () => {
        await page.locator('.bmc-dock [data-space="home"]').click()
        await page.waitForSelector('.mb-shell[data-space="home"]')
        await guardSettled(false)
        await page.goBack()
        await page.waitForFunction(() => document.title === 'Before Forsion')
        assert.equal(errors.length, 0, errors.join('\n'))
      })
      await ctx.close()
    }
    // Tablet (Pad A2 × the browser chrome, same layout as Android). Portrait = the phone layout: list level, bottom dock, no
    // rail, no docked column. Landscape (the shell's wide line) = the Space rail at the left edge (Home first, avatar at its
    // foot) instead of the dock, the whole shell starts after it, docked left column beside the main view, and the title
    // capsule starts after the column (rail + `leftInset`) so the column's header — aligned with the capsule row by
    // singleColumn.css — is not under it. A tablet turned on its side keeps the mobile shell (index.html leaves it only for a
    // fine pointer). Switching Space and reloading keep all of it.
    {
      const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
      await ctx.addInitScript(() => {
        // Also stands in for an insecure context (a Unit device page over plain HTTP on the LAN): no crypto.randomUUID.
        // browserBack used to call it on mount and the error boundary replaced the app.
        try { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }) } catch { /* ignore */ }
        localStorage.setItem('forsion_token', 'fixture-only')
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('tangu_locale', 'zh')
      })
      await fixtureApi(ctx)
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-browser-mobile-chrome]', { timeout: 60_000 })
      await page.waitForTimeout(1200)
      const check = async (name, fn) => {
        try { await fn(); results.push({ name: `tablet/zh-CN: ${name}`, ok: true }); console.log('PASS', name) }
        catch (error) {
          results.push({ name: `tablet/zh-CN: ${name}`, ok: false, error: String(error) })
          await page.screenshot({ path: path.join(OUT, `fail-${results.length}.png`) })
          throw error
        }
      }
      const shot = async (name) => { await page.waitForTimeout(650); await page.screenshot({ path: path.join(OUT, name) }) }
      const rect = (sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })
      const phoneGeometry = async () => {
        assert.equal(await page.locator('.mb-shell').getAttribute('data-wide'), null)
        assert.equal(await page.locator('.bmc-rail').count(), 0, 'no rail in portrait')
        assert.equal(await page.locator('.mb-sidecol').count(), 0)
        assert(await page.locator('.bmc-dock [data-space]').count() > 1, 'dock in portrait')
        assert(Math.abs((await rect('.mb-shell')).left) < 1, 'shell at the page edge')
      }
      const wideGeometry = async (space) => {
        assert.equal(await page.locator('.mb-shell').getAttribute('data-wide'), '')
        assert.equal(await page.locator('.bmc-dock').count(), 0, 'no dock beside the rail')
        const rail = await rect('.bmc-rail')
        assert(Math.abs(rail.left) < 1 && Math.abs(rail.width - 76) < 1 && rail.height >= 819, `rail: ${JSON.stringify(rail)}`)
        const cells = await page.locator('.bmc-rail [data-space]').evaluateAll((els) => els.map((el) => ({ id: el.getAttribute('data-space'), on: el.getAttribute('aria-current') === 'page' })))
        assert.equal(cells[0]?.id, 'home', `Home first: ${JSON.stringify(cells)}`)
        assert.deepEqual(cells.filter((c) => c.on).map((c) => c.id), [space], `current Space marked: ${JSON.stringify(cells)}`)
        assert.equal(await page.locator('.bmc-rail [data-chrome-action="account"]').count(), 1, 'avatar at the rail foot')
        assert.equal(await page.locator('.bmc-actions [data-chrome-action="account"]').count(), 0, 'avatar not in the right capsule')
        const shell = await rect('.mb-shell')
        assert(Math.abs(shell.left - rail.right) < 1, `shell starts after the rail: ${JSON.stringify({ rail, shell })}`)
        const side = await rect('.mb-sidecol')
        assert(side.width > 200 && side.left >= rail.right - 1, `docked column after the rail: ${JSON.stringify(side)}`)
        const heading = await rect('.bmc-heading')
        assert(heading.left >= side.right - 1 && heading.left - side.right < 20, `title capsule right after the docked column: ${JSON.stringify({ side, heading })}`)
        // The column's header row is the column's own, not the capsule's.
        const bar = await page.locator('.mb-sidecol .mb-drawer-bar').count()
        if (bar) {
          const own = await page.locator('.mb-sidecol .mb-drawer-bar').first().evaluate((el) => {
            const r = el.getBoundingClientRect()
            return [0.2, 0.5, 0.8].every((f) => el.contains(document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2)))
          })
          assert(own, 'docked column header is not covered')
        }
      }
      let pinnedIds = []
      await check('portrait 820×1180 keeps the phone layout', async () => {
        assert.equal(await page.locator('[data-error-boundary]').count(), 0)
        await page.locator('.bmc-dock [data-space="amadeus"]').click()
        await page.waitForSelector('.mb-shell[data-space="amadeus"][data-nav="list"]')
        await phoneGeometry()
        pinnedIds = await page.locator('.bmc-dock [data-space]').evaluateAll((els) => els.map((el) => el.getAttribute('data-space')))
      })
      await shot('tablet-820x1180-notes.png')
      await check('landscape 1180×820: rail instead of the dock, shell after it, capsule after the docked column', async () => {
        await page.setViewportSize({ width: 1180, height: 820 })
        await page.waitForSelector('.mb-shell[data-wide] .mb-sidecol')
        await page.waitForSelector('.bmc-rail')
        await page.waitForTimeout(700)
        await wideGeometry('amadeus')
      })
      await shot('tablet-1180x820-notes.png')
      await check('landscape board: menu button and tool island clear of both capsules', async () => {
        await page.locator('.mb-sidecol').getByText('新建白板', { exact: true }).first().click()
        await page.getByRole('button', { name: '创建', exact: true }).click()
        await page.waitForSelector('.mb-view[data-view="amadeus-drawing"] .excalidraw .App-menu_top > .shapes-section')
        await page.waitForTimeout(900)
        const g = await page.evaluate(() => {
          const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom } }
          return { heading: r('.bmc-heading'), actions: r('.bmc-actions'), rail: r('.bmc-rail'), menu: r('.amx-boardhost .main-menu-trigger'), island: r('.amx-boardhost .App-menu_top > .shapes-section'), row: document.querySelector('.amx-boardhost')?.getAttribute('data-cap-row') ?? null }
        })
        const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
        assert(g.menu && g.island, JSON.stringify(g))
        for (const cap of [g.heading, g.actions, g.rail]) for (const el of [g.menu, g.island]) assert(apart(cap, el), `overlap: ${JSON.stringify(g)}`)
        // In the capsule row unless the board judged it too tight ('off' = its own row below the capsules, as on Android).
        if (g.row !== 'off') assert(g.island.top < g.heading.bottom, JSON.stringify(g))
        else assert(g.island.top >= g.heading.bottom, JSON.stringify(g))
      })
      await shot('tablet-1180x820-board.png')
      await check('landscape: switching Space from the rail keeps the layout', async () => {
        await page.locator('.bmc-rail [data-space="tangu"]').click()
        await page.waitForSelector('.mb-shell[data-space="tangu"][data-wide] .mb-sidecol')
        await page.waitForTimeout(700)
        await wideGeometry('tangu')
      })
      await shot('tablet-1180x820-tangu.png')
      await check('short rail (1180×420): as many cells as fit, the pinned ones first, the last cell "all"', async () => {
        await page.setViewportSize({ width: 1180, height: 420 })
        await page.waitForTimeout(700)
        const fit = await page.locator('.bmc-rail-cells').evaluate((el) => Math.floor((el.clientHeight + 4) / 62))
        const ids = await page.locator('.bmc-rail [data-space]').evaluateAll((els) => els.map((el) => el.getAttribute('data-space')))
        assert(fit >= 2 && ids.length === fit - 1, JSON.stringify({ fit, ids }))
        assert.equal(await page.locator('.bmc-rail [data-chrome-action="spacesAll"]').count(), 1)
        // Pinned (= the portrait dock's Spaces) take the places first; on screen in list order, Home first.
        const pinnedShown = pinnedIds.slice(0, ids.length)
        assert.deepEqual(ids.filter((id) => pinnedIds.includes(id)).slice(0, pinnedShown.length), pinnedShown, JSON.stringify({ ids, pinnedIds }))
        assert.equal(ids[0], 'home')
        await page.setViewportSize({ width: 1180, height: 820 })
        await page.waitForTimeout(700)
        await wideGeometry('tangu')
      })
      await check('landscape: reload keeps the rail, the shell after it and the capsule after the column', async () => {
        await page.reload()
        await page.waitForSelector('.mb-shell[data-space="tangu"][data-wide] .mb-sidecol', { timeout: 60_000 })
        await page.waitForSelector('.bmc-rail')
        // The start-up splash (#tangu-splash, ~2.1s) still covers the page right after a reload.
        await page.waitForFunction(() => { const el = document.getElementById('tangu-splash'); return !el || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none' }, null, { timeout: 15_000 })
        await page.waitForTimeout(500)
        await wideGeometry('tangu')
      })
      await check('back to portrait: phone layout again, capsule at the edge', async () => {
        await page.setViewportSize({ width: 820, height: 1180 })
        await page.waitForSelector('.mb-shell:not([data-wide])')
        await page.waitForTimeout(700)
        await phoneGeometry()
        const heading = await rect('.bmc-heading')
        assert(heading.left < 24, JSON.stringify(heading))
      })
      await shot('tablet-820x1180-tangu.png')
      await check('portrait board opens at the detail level (no dock, no rail)', async () => {
        await page.locator('.bmc-dock [data-space="amadeus"]').click()
        await page.waitForSelector('.mb-shell[data-space="amadeus"][data-nav="list"]')
        await page.locator('.mb-drawer--left').getByText('未命名白板', { exact: true }).first().click()
        await page.waitForSelector('.mb-shell[data-nav="detail"] .mb-view[data-view="amadeus-drawing"] .excalidraw')
        await page.waitForTimeout(900)
        assert.equal(await page.locator('.bmc-dock').count(), 0)
        assert.equal(await page.locator('.bmc-rail').count(), 0)
        assert.equal(errors.length, 0, errors.join('\n'))
      })
      await shot('tablet-820x1180-board.png')
      await check('an explicit Desktop choice (command palette) survives reload on a wide touch device', async () => {
        await page.setViewportSize({ width: 1180, height: 820 })
        // = setUiMode('desktop'): the value without the auto-detection's ownership mark.
        await page.evaluate(() => { localStorage.setItem('lcl.uiMode', 'desktop'); localStorage.removeItem('lcl.uiMode.auto') })
        await page.reload()
        await page.waitForSelector('.shell', { timeout: 60_000 })
        assert.equal(await page.locator('[data-browser-mobile-chrome]').count(), 0)
        assert.equal(await page.evaluate(() => localStorage.getItem('lcl.uiMode')), 'desktop')
      })
      await ctx.close()
    }
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await desktop.addInitScript(() => { localStorage.setItem('forsion_token', 'fixture-only'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await desktop.route('**/api/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ username: 'Fixture', ok: true, sessions: [], agents: [], models: [], items: [], vaults: [] }) }))
    const desktopPage = await desktop.newPage()
    await desktopPage.goto(preview.url)
    await desktopPage.waitForSelector('.shell', { timeout: 60_000 })
    assert.equal(await desktopPage.locator('[data-browser-mobile-chrome]').count(), 0)
    results.push({ name: 'Desktop browser retains desktop shell', ok: true })
    await desktop.close()
  } finally {
    await browser.close()
    preview.kill()
    await stub.close()
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
