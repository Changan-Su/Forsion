/** Load the actual IPC-created Clip copy in a fresh headless Chromium profile.
 * The dead proxy includes loopback: this extension must never pair with the
 * user's running Forsion. No user browser, clipboard or Explorer is touched. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright-core')

exports.verifyUnpacked = async (dir, home) => {
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const browser = await chromium.launchPersistentContext(path.join(home, 'chromium'), {
    executablePath: process.env.CHROMIUM_EXE || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
  })
  try {
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 30000 })
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest())
    assert.equal(manifest.version, expected.version)
    assert.equal(manifest.manifest_version, 3)
    assert.ok(worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js'))
    console.log('PASS the actual copied MV3 extension starts its real service worker')
    const page = await browser.newPage()
    await page.goto('chrome://extensions')
    const info = await page.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve)))
    const extension = info.find(item => item.id === new URL(worker.url()).hostname)
    assert.ok(extension && extension.location === 'UNPACKED' && extension.state === 'ENABLED', JSON.stringify(extension))
    assert.equal(extension.path.toLowerCase(), dir.toLowerCase())
    console.log('PASS Chrome lists the copied folder as an enabled unpacked extension')
    await page.screenshot({ path: path.join(home, 'clip-unpacked.png') })
    await page.goto(`chrome-extension://${extension.id}/options.html`)
    await page.locator('body').waitFor()
    assert.ok((await page.locator('body').innerText()).trim().length > 10)
    console.log('PASS the installed Clip options page renders')
  } finally { await browser.close() }
}

if (require.main === module) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'windows-clip.e2e.cjs')], {
    env: { ...process.env, CLIP_BROWSER: '1' }, stdio: 'inherit', windowsHide: true,
  })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
}
