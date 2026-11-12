// Production Electron smoke: isolated vault, real image asset protocol and disk writes.
// Run npm run build first; the browser suite covers the full interaction matrix.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-editing-'))
  const vault = path.join(home, 'Vault'), userdata = path.join(home, 'userdata')
  const shots = path.join(ROOT, 'out/amadeus-editing')
  fs.mkdirSync(vault); fs.mkdirSync(shots, { recursive: true })
  const file = path.join(vault, 'Editing.md')
  fs.writeFileSync(file, 'Example: $x+y$ and $x^2$ and $\\frac{3!}{2!}=3$.\n\n# ![[pic.svg|200]]\n\n> [!fold]+ Details\n>\n> Inside one\n>\n> Inside two\n\nTail\n')
  fs.writeFileSync(path.join(vault, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="#768698"/></svg>')
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  let app, p
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=en', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    p = await app.firstWindow()
    p.on('pageerror', e => console.log('PAGEERROR', e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 960))
    assert.ok(await skipOnboarding(p), 'onboarding skipped')
    await p.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"], .rb-space[aria-label="Notes"]').first().click()
    await p.locator('.t2s-srow').filter({ hasText: 'Editing' }).first().click()
    await p.waitForTimeout(1200)
    const clickFormula = async () => {
      const at = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.math-rendered')].find(el => el.getBoundingClientRect().width > 0)
        const r = el.getBoundingClientRect()
        return { x: r.x+r.width/2, y: r.y+r.height/2 }
      })
      await p.mouse.click(at.x, at.y)
      await p.waitForTimeout(300)
    }
    await clickFormula()
    assert.equal(await p.locator('.math-preview--inline:visible').count(), 1)
    await p.screenshot({ path: path.join(shots, 'electron-math-light.png') })
    console.log('PASS production formula preview: one active preview')
    await p.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    await p.reload(); await skipOnboarding(p)
    await p.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"], .rb-space[aria-label="Notes"]').first().click()
    await p.locator('.t2s-srow').filter({ hasText: 'Editing' }).first().click()
    await p.waitForTimeout(1200)
    await clickFormula()
    await p.screenshot({ path: path.join(shots, 'electron-math-dark.png') })
    console.log('PASS production dark preview')
    const img = p.locator('.wiki-inline-img:visible').first()
    await img.click()
    assert.equal(await p.locator('.amx-img-resize:visible').count(), 1, 'heading image click exposes resize handle')
    const r = await p.locator('.amx-img-resize:visible').first().boundingBox()
    assert.ok(r)
    await p.mouse.move(r.x + r.width - 2, r.y + r.height / 2)
    await p.mouse.down(); await p.mouse.move(r.x + r.width + 58, r.y + r.height / 2, { steps: 8 }); await p.mouse.up()
    await p.waitForTimeout(1800)
    assert.match(fs.readFileSync(file, 'utf8'), /!\[\[pic\.svg\|260\]\]/)
    console.log('PASS production heading image handle and resize saved to real file')
  } catch (e) {
    if (p) {
      console.log('PAGE', await p.locator('body').innerText().catch(() => 'unavailable'))
      await p.screenshot({ path: path.join(shots, 'electron-failure.png') }).catch(() => {})
    }
    throw e
  } finally {
    if (app) await app.close()
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
