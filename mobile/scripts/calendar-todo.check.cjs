/** Full mobile entry + real local vault bridge + touch. Native chrome/haptic stand-in is explicit.
 *  Default: the pinned renderer from desktop/node_modules (what the App bundles).
 *  FORSION_CALENDAR_PACKAGE / FORSION_EXTEND_UPDATE_PACKAGE=<npm tgz>(not FORSION_EXTEND_PACKAGE:
 *  vite.config reads that one as the bundled Extend): run the real npm updater (coreUpdates.ts) against that
 *  package with a stubbed registry, relaunch, and assert the downloaded version is running before the same flow. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')
const { stubApi, installChrome, stage, moduleUrl, loaded, SCREEN, LAYOUT } = require('./phone-stage.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.CALENDAR_TODO_PHONE_OUT || path.join(os.tmpdir(), 'forsion-calendar-todo-phone')
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ root: ROOT, server: { port: 5296, strictPort: true } }); await server.listen()
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true }), errors = [], unknown = new Set()
  let page
  try {
    const context = await browser.newContext({ viewport: SCREEN, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await context.addInitScript(() => {
      localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('forsion_token', 'stage'); localStorage.setItem('amadeus_vault_mode', 'local')
    })
    page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => { const u = new URL(r.url()); if (/\.(tsx?|jsx?)$/.test(u.pathname)) loaded.set(u.pathname, u.pathname + u.search) })
    await stubApi(page, unknown); await page.goto('http://localhost:5296/', { waitUntil: 'domcontentloaded' })
    await page.locator('.mb-shell').waitFor({ timeout: 180000 }); await installChrome(page)
    // npm 更新路径:FORSION_CALENDAR_PACKAGE / FORSION_EXTEND_UPDATE_PACKAGE = <npm tgz>,用真的更新器(coreUpdates.ts)暂存,再重开 App 换上。
    const pkgs = [['FORSION_CALENDAR_PACKAGE', 'forsion-calendar', 'bundledCalendar.ts', 'calendarCoreBundle'], ['FORSION_EXTEND_UPDATE_PACKAGE', 'forsion-extend', 'bundledExtend.ts', 'extendCoreBundle']]
      .filter(([env]) => process.env[env]).map(([env, id, file, name]) => {
        const tgz = fs.readFileSync(path.resolve(process.env[env]))
        const version = JSON.parse(require('node:child_process').execFileSync('tar', ['-xzOf', path.resolve(process.env[env]), 'package/manifest.json'], { encoding: 'utf8' })).version
        return { id, file, name, tgz, version }
      })
    for (const p of pkgs) {
      const staged = await page.evaluate(async ({ updatesUrl, fsUrl, bundleUrl, name, versionUrl, b64, integrity, version }) => {
        const { checkCoreUpdates } = await import(updatesUrl), { capacitorPluginFs } = await import(fsUrl)
        const bundle = (await import(bundleUrl))[name], { APP_VERSION } = await import(versionUrl)
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        let last
        const staged = await checkCoreUpdates({
          fs: capacitorPluginFs(), bundles: [bundle], appVersion: () => APP_VERSION, registries: async () => ['https://registry.npmjs.org'],
          fetch: async () => new Response(JSON.stringify({ 'dist-tags': { latest: version }, versions: { [version]: { dist: { integrity } } } })),
          download: async () => bytes, log: () => {}, onStatus: (st) => { last = st },
        })
        return { staged, last }
      }, { updatesUrl: moduleUrl('src/plugins/coreUpdates.ts'), fsUrl: moduleUrl('src/plugins/capacitorPluginFs.ts'), bundleUrl: moduleUrl(`src/plugins/${p.file}`), name: p.name, versionUrl: moduleUrl('../desktop/frontend/src/changelog.ts'),
        b64: p.tgz.toString('base64'), integrity: `sha512-${require('node:crypto').createHash('sha512').update(p.tgz).digest('base64')}`, version: p.version })
      assert.deepEqual(staged.staged, [`${p.id}@${p.version}`], `${p.id}: the npm package passes every updater gate and is staged (${JSON.stringify(staged.last)})`)
    }
    if (pkgs.length) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.mb-shell').waitFor({ timeout: 180000 }); await installChrome(page) }
    await page.evaluate(async ({ chromeUrl, storeUrl, pageUrl, dbUrl, configUrl, spaceUrl, layout }) => {
      const host = await import(chromeUrl), engine = window.__stage.engine
      window.__todoTicks = 0
      const plain = { floating: false, status: layout.status, top: 0, bottom: 0, plates: [] }
      engine.installNativeChromeHost({ spaces: true, haptic() { window.__todoTicks++ }, render(state) { window.__stage.state = state; host.applyChromeLayout(state.mode === 'shell' ? layout : plain) } })
      const { usePageStore } = await import(pageUrl), { useDbStore } = await import(dbUrl), { useCalendarConfig } = await import(configUrl), { usePluginStore } = await import(storeUrl)
      await usePageStore.getState().restoreVault()
      const data = { version: 1, name: '手机待办', columns: [{ id: 'name', name: '事项', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }], rows: [
        { id: 'one', cells: { name: '整理购物清单' }, body: '# Full mobile record body' }, { id: 'two', cells: { name: '给植物浇水' } },
      ] }
      await window.amadeus.writeDatabase('PhoneTasks.db', data); await usePageStore.getState().refreshStructure(); await useDbStore.getState().reload('PhoneTasks.db', 'PhoneTasks.db')
      useCalendarConfig.getState().migrate(usePageStore.getState().vaultRoot, [{ dbPath: 'PhoneTasks.db', dateCol: 'date', checkboxCol: 'done' }])
      // The actual Android host is installed before plugin startup. This late browser stand-in needs a reload.
      await usePluginStore.getState().reloadOne('forsion-calendar', { force: true })
      window.__todoPhone = { usePageStore, useDbStore, usePluginStore, useSpaceStore: (await import(spaceUrl)).useSpaceStore }
    }, { chromeUrl: moduleUrl('src/nativeChrome.ts'), storeUrl: moduleUrl('../desktop/frontend/src/amadeus/plugins/pluginStore.ts'), pageUrl: moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'), dbUrl: moduleUrl('../desktop/frontend/src/amadeus/store/dbStore.ts'), configUrl: moduleUrl('../desktop/frontend/src/amadeus/store/calendarConfigStore.ts'), spaceUrl: moduleUrl('../lcl/engine/spaceRegistry.ts'), layout: LAYOUT })
    await page.waitForFunction(() => window.__todoPhone.useSpaceStore.getState().spaces.some((s) => s.id === 'forsion-todo'))
    await stage.space(page, 'forsion-todo')
    const root = page.locator('.fc-view-todo .amx-todo'); await root.locator('[data-task="db:PhoneTasks.db:one"]').waitFor()
    assert.ok(await page.evaluate(() => window.__todoPhone.usePluginStore.getState().plugins.some((p) => p.id === 'forsion-calendar' && p.preinstalled)), 'the bundled mobile renderer is core')
    for (const p of pkgs) {
      await page.waitForFunction((id) => window.__todoPhone.usePluginStore.getState().activeIds.includes(id), p.id)
      assert.equal(await page.evaluate((id) => window.__todoPhone.usePluginStore.getState().plugins.find((x) => x.id === id)?.version, p.id), p.version, `${p.id}: the downloaded version replaced the bundled one on relaunch`)
    }
    const ticks = () => page.evaluate(() => window.__todoTicks), before = await ticks()
    const one = root.locator('[data-task="db:PhoneTasks.db:one"]')
    await one.getByRole('checkbox').tap(); await one.getByRole('checkbox', { checked: true }).waitFor()
    assert.equal(await ticks(), before + 1, 'one accepted completion produces one native tick request')
    assert.ok(await one.isVisible(), 'completed row lingers')
    await page.locator('.ntf-action', { hasText: '撤销' }).last().tap()
    await one.getByRole('checkbox', { checked: false }).waitFor()
    assert.equal(await ticks(), before + 1, 'undo is silent')
    await page.evaluate(() => window.__todoPhone.useDbStore.getState().flushAll(true))
    const record = await page.evaluate(async () => (await window.amadeus.readDatabase('PhoneTasks.db', 'PhoneTasks.db')).data.rows.find((r) => r.id === 'one'))
    assert.equal(record.cells.done, undefined); assert.equal(record.body, '# Full mobile record body')
    await root.getByRole('textbox', { name: '添加待办', exact: true }).fill('接着记下一条')
    await root.getByRole('button', { name: '添加待办', exact: true }).tap()
    await root.getByText('接着记下一条', { exact: true }).waitFor()
    await root.getByRole('button', { name: '全部', exact: true }).tap()
    await page.getByRole('menuitemcheckbox', { name: '完成时轻触反馈', exact: true }).tap()
    const quiet = await ticks(); await root.locator('[data-task="db:PhoneTasks.db:two"]').getByRole('checkbox').tap()
    assert.equal(await ticks(), quiet, 'completion preference suppresses native tick requests')
    const hit = await one.getByRole('checkbox').boundingBox(); assert.ok(hit.height >= 44 && hit.width >= 44, '44px touch target')
    const overflow = await root.evaluate((e) => e.scrollWidth - e.clientWidth); assert.ok(overflow <= 1, `no horizontal overflow: ${overflow}`)
    await page.screenshot({ path: path.join(OUT, 'phone-todo-light.png') })
    await page.evaluate(async (url) => { await (await import(url)).useTheme.getState().setModePref('dark') }, moduleUrl('../desktop/frontend/src/stores/themeStore.ts'))
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(OUT, 'phone-todo-dark.png') })
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ passed: 9, errors, unknown: [...unknown], vehicle: 'full mobile entry + real IndexedDB vault bridge + Chromium touch; native chrome and haptic stand-ins' }, null, 2))
    console.log(`PASS mobile Todo: core bundle, completion, one tick, linger, silent undo, body persistence, quick add, preference and touch geometry. ${OUT}`)
  } catch (e) { if (page) { await page.screenshot({ path: path.join(OUT, 'failure.png') }); fs.writeFileSync(path.join(OUT, 'failure.txt'), await page.locator('body').innerText()) }; throw e }
  finally { await browser.close(); await server.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
