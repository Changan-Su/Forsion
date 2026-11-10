/** Real Electron renderers, isolated vault and profile. Run after npm run build. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const root = path.join(__dirname, '..')
const noteTab = (page, title) => page.locator('.wb-tab[data-view-type="amadeus-editor"]').filter({ hasText: title })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const search = (page) => page.locator('.amx-qf-input')
const noteBody = (page, value) => page.locator('.unified-body .ProseMirror').getByText(value, { exact: true }).filter({ visible: true })
const indicator = (page) => page.locator('.wb-drop-line:visible')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-detached-workflow-'))
  const userData = path.join(home, 'profile')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(vault)
  fs.mkdirSync(userData + '-dev')
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  fs.writeFileSync(path.join(vault, 'Window Source.md'), '# Window Source\n\nSource body.\n\n[[Window Destination]]\n')
  fs.writeFileSync(path.join(vault, 'Window Destination.md'), '# Window Destination\n\nDestination body.\n')
  const stub = await startStubEngine()
  let app, first, second
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=en-US', root],
      cwd: root,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') },
    })
    const main = await app.firstWindow()
    assert.ok(await skipOnboarding(main))
    main.setDefaultTimeout(10000)
    await main.locator('.dv-groupview').first().waitFor()
    const openDetached = async (act) => {
      const [page] = await Promise.all([app.waitForEvent('window'), act()])
      page.setDefaultTimeout(10000)
      await page.locator('.dv-groupview').first().waitFor()
      return page
    }
    const findNote = async (page, title) => {
      await page.keyboard.press(`${mod}+p`)
      await search(page).fill(title)
      await page.locator('.amx-qf-row').filter({ hasText: title }).first().waitFor()
      await search(page).press('Enter')
      await noteTab(page, title).waitFor()
    }
    await findNote(main, 'Window Source')
    const link = (page) => page.locator('.wikilink[data-wiki="Window Destination"]:not(.wikilink-unresolved)').filter({ visible: true })
    await link(main).waitFor()
    const copyNote = async (page) => {
      await noteTab(page, 'Window Source').click({ button: 'right' })
      return openDetached(() => page.locator('.ctx-menu [data-act="open-window"]').click())
    }
    first = await copyNote(main)
    await link(first).waitFor()
    console.log('PASS Wiki resolves without the Notes Space')
    second = await copyNote(first)
    await noteBody(second, 'Source body.').waitFor()
    assert.equal(await noteTab(main, 'Window Source').count(), 1)
    assert.equal(await noteTab(first, 'Window Source').count(), 1)
    assert.equal(await noteTab(second, 'Window Source').count(), 1)
    console.log('PASS Open in new window keeps the same note open in two independent windows')

    await noteBody(second, 'Source body.').click()
    await second.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await second.keyboard.insertText(' Shared update.')
    await noteBody(first, 'Source body. Shared update.').waitFor()
    await noteBody(main, 'Source body. Shared update.').waitFor()
    console.log('PASS An edit saved in the second window appears in both peers')

    await first.keyboard.press(`${mod}+f`)
    await first.locator('.amx-findbar input').first().waitFor()
    await first.keyboard.press('Escape')
    await link(first).click()
    await noteBody(first, 'Destination body.').waitFor()
    await noteBody(second, 'Source body. Shared update.').waitFor()
    console.log('PASS In-page find and wiki navigation work locally')
    await findNote(first, 'Window Source')
    await findNote(second, 'Window Destination')
    await noteBody(second, 'Destination body.').waitFor()
    console.log('PASS Quick Find searches and opens notes in both detached windows')

    // Exercise the renderer, IPC and native hit testing without moving the user's physical mouse.
    await app.evaluate(({ BrowserWindow, screen }, urls) => {
      const area = screen.getPrimaryDisplay().workArea
      const width = Math.floor(area.width / 2)
      urls.forEach((url, i) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)
        win.setBounds({ x: area.x + width * i, y: area.y, width, height: Math.min(680, area.height) })
        win.show()
      })
      screen.getCursorScreenPoint = () => globalThis.detachedTestCursor || { x: area.x, y: area.y }
    }, [first.url(), second.url()])
    const pointAt = async (page, locator, dx, dy) => {
      const box = await locator.boundingBox()
      assert.ok(box)
      await app.evaluate(({ BrowserWindow }, { url, x, y }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)
        const bounds = win.getContentBounds()
        const zoom = win.webContents.getZoomFactor()
        globalThis.detachedTestCursor = { x: bounds.x + x * zoom, y: bounds.y + y * zoom }
      }, { url: page.url(), x: box.x + box.width * dx, y: box.y + box.height * dy })
    }
    const beginDrag = () => noteTab(first, 'Window Source').evaluate((tab) => {
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    })
    const endDrag = (outside) => noteTab(first, 'Window Source').evaluate((tab, outside) => {
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: outside ? innerWidth + 20 : 0 }))
    }, outside)
    await pointAt(second, noteTab(second, 'Window Destination'), 0.2, 0.5)
    await beginDrag()
    await indicator(second).waitFor()
    await pointAt(first, noteTab(first, 'Window Source'), 0.5, 0.5)
    await indicator(second).waitFor({ state: 'hidden' })
    await pointAt(second, noteTab(second, 'Window Destination'), 0.2, 0.5)
    await indicator(second).waitFor()
    await endDrag(false)
    await indicator(second).waitFor({ state: 'hidden' })
    assert.equal(await noteTab(first, 'Window Source').count(), 1)
    console.log('PASS Target insertion line follows the cursor and clears on cancel')

    await beginDrag()
    await indicator(second).waitFor()
    if (process.env.DETACH_SHOTS) {
      fs.mkdirSync(process.env.DETACH_SHOTS, { recursive: true })
      await second.screenshot({ path: path.join(process.env.DETACH_SHOTS, 'tab-insertion.png') })
    }
    await endDrag(true)
    await noteTab(second, 'Window Source').waitFor()
    await noteTab(first, 'Window Source').waitFor({ state: 'detached' })
    assert.deepEqual(await second.locator('.wb-tab[data-view-type="amadeus-editor"] .wb-tab-name').allTextContents(), ['Window Source', 'Window Destination'])
    console.log('PASS Cross-window drop inserts at the previewed position and preserves the destination tab')

    await findNote(first, 'Window Source')
    const content = second.locator('.dv-content-container:visible').first()
    await pointAt(second, content, 0.85, 0.5)
    await beginDrag()
    await second.locator('.wb-drop-zone:visible').waitFor()
    await endDrag(true)
    await noteTab(first, 'Window Source').waitFor({ state: 'detached' })
    assert.equal(await second.locator('.dv-groupview:visible').count(), 2)
    assert.equal(await noteTab(second, 'Window Source').count(), 2)
    console.log('PASS Dropping over the body opens the same note in the previewed split')
  } catch (error) {
    for (const page of [first, second].filter(Boolean)) {
      console.error(page.url(), (await page.locator('.shell-host').innerText().catch(() => '')).slice(0, 700))
    }
    throw error
  } finally {
    await app?.close()
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
