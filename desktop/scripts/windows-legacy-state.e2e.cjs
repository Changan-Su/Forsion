/** Replay old Windows localStorage keys in an isolated real Electron profile, then restart.
 * This is a persisted-state fixture, not an installation/upgrade of an old released app.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-legacy-win-'))
  const vault = path.join(home, 'Vault'), rel = '子目录/升级笔记.md', legacy = rel.replaceAll('/', '\\')
  fs.mkdirSync(path.join(vault, '子目录'), { recursive: true })
  fs.writeFileSync(path.join(vault, rel), '# 升级笔记\n\nLegacy Windows state fixture.\n')
  const ud = path.join(home, 'userdata')
  fs.mkdirSync(`${ud}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${ud}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine()
  let app, win
  const boot = async (file = false) => {
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT, ...(file ? [path.join(vault, rel)] : [])], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    await skipOnboarding(win)
    if (!file) {
      const tab = win.locator('.dv-tab').filter({ hasText: '升级笔记' })
      await tab.first().waitFor({ timeout: 30000 })
      assert.equal(await tab.count(), 1, 'restored note tab must not duplicate')
      await tab.first().click()
    }
    await win.locator(`[data-unified-path="${rel}"]`).waitFor({ timeout: 30000 })
  }
  const crashAfterFlush = async () => {
    await app.evaluate(({ session }) => session.defaultSession.flushStorageData())
    await win.waitForTimeout(200)
    await Promise.all([app.waitForEvent('close'), app.evaluate(({ app }) => app.exit(0)).catch(() => {})])
    app = null
  }
  const checks = []
  const check = (ok, name) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`) }
  try {
    await boot(true)
    // Preserve actual current layout schema, replacing only the old per-vault relative paths.
    await win.waitForTimeout(1000)
    const patched = await win.evaluate(({ vault, rel, legacy }) => {
      const rewrite = value => typeof value === 'string' ? value === rel ? legacy : value
        : Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)])) : value
      let changed = 0
      for (const key of Object.keys(localStorage).filter(k => /layout/.test(k))) {
        const raw = localStorage.getItem(key)
        if (!raw.includes(rel)) continue
        try { localStorage.setItem(key, JSON.stringify(rewrite(JSON.parse(raw)))); changed++ } catch {}
      }
      localStorage.setItem('forsion_default_space', '__last__')
      localStorage.setItem(`amadeus_prefs:${vault}`, JSON.stringify({ starred: [legacy, rel], pins: [legacy, rel], recents: [legacy, rel], collections: [] }))
      localStorage.setItem(`amx.noteLocked:${JSON.stringify([vault, legacy])}`, '1')
      localStorage.setItem(`amadeus.unsavedDraft:${vault}:${legacy}`, JSON.stringify({ text: '# 升级笔记\n\nRecovered legacy draft.\n', base: 'legacy-fingerprint', at: Date.now() }))
      return changed
    }, { vault, rel, legacy })
    check(patched > 0, 'fixture contains real persisted tab layout with legacy backslashes')
    await crashAfterFlush()
    await boot()
    check(await win.locator(`[data-unified-path="${rel}"]`).count() === 1, 'old backslash tab restores to one canonical editor after process restart')
    await win.getByRole('button', { name: '解锁', exact: true }).waitFor()
    check(await win.locator(`[data-unified-path="${rel}"] [contenteditable="true"]`).count() === 0, 'old backslash lock remains read-only')
    await win.getByRole('button', { name: '解锁', exact: true }).click()
    const draft = win.locator('[data-save="draft"]')
    await draft.waitFor()
    check(true, 'old backslash draft offers recovery after unlocking')
    await draft.locator('button').last().click()
    await draft.waitFor({ state: 'detached' })
    const canonical = await win.evaluate(({ vault, rel }) => {
      const p = JSON.parse(localStorage.getItem(`amadeus_prefs:${vault}`))
      return { p, locks: Object.keys(localStorage).filter(k => k.startsWith('amx.noteLocked:')), drafts: Object.keys(localStorage).filter(k => k.startsWith(`amadeus.unsavedDraft:${vault}:`)) }
    }, { vault, rel })
    for (const kind of ['starred', 'pins', 'recents']) check(canonical.p[kind].filter(p => p === rel).length === 1 && !canonical.p[kind].includes(legacy), `${kind}: mixed old/new keys persist once under canonical path`)
    check(!canonical.locks.length && !canonical.drafts.length, 'unlock and discard remove both old and canonical recovery keys')
    await win.screenshot({ path: path.join(home, 'legacy-state.png') })
    console.log(`SCREENSHOT ${path.join(home, 'legacy-state.png')}`)
    await app.close(); app = null
    await boot()
    check(await win.locator('[data-save="draft"]').count() === 0 && await win.getByRole('button', { name: '解锁', exact: true }).count() === 0, 'unlock and draft dismissal survive another complete restart')
    console.log(`${checks.length}/${checks.length} passed`)
  } catch (e) {
    if (win && !win.isClosed()) { await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {}); console.error(await win.locator('body').innerText().catch(() => '')) }
    console.error(`EVIDENCE ${home}`)
    throw e
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
