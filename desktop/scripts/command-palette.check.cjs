// Real Shell, command registry, and Ribbon in the Chromium harness.
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const url = `${process.env.HARNESS_URL || 'http://localhost:5173/harness.html'}?commandpalette`

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    const page = await browser.newPage({ locale: 'en-GB', viewport: { width: 1000, height: 700 } })
    page.on('pageerror', (error) => console.error(error.message))
    const input = page.locator('.cmd-input')
    const items = page.locator('.cmd-item[data-command-id]')
    const last = items.filter({ hasText: 'Open test console' })
    const pin = page.locator('.cmd-command-row', { has: last }).locator('.cmd-pin')
    const ribbonItem = page.locator('.rb-bottom [data-id="cmd:fixture-55"] .rb-btn')
    const open = async () => {
      await page.keyboard.press('Control+k')
      await input.waitFor()
    }
    await page.goto(url)
    await page.locator('.rb').waitFor()
    await open()
    await input.fill('console')
    assert.equal(await last.count(), 1, 'A command beyond row 40 is searchable')
    await input.clear()
    assert.equal(await items.count(), 55, 'The empty palette lists all registered commands')
    assert.equal(await page.locator('.cmd-foot-count').textContent(), '55 commands')
    await items.first().hover()
    await page.mouse.wheel(0, 2400)
    await page.waitForFunction(() => {
      const list = document.querySelector('.cmd-list')
      return list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1
    })
    await input.fill('fixture')
    assert.equal(await items.count(), 55, 'Broad searches include all matches')
    assert.equal(await page.locator('.cmd-list').evaluate((list) => list.scrollTop), 0)
    await input.clear()

    // Leave the cursor over a row while using the keyboard. Scrolling the list under it must not steal the selection.
    await items.first().hover()
    for (let i = 1; i < 55; i++) await page.keyboard.press('ArrowDown')
    assert.equal(await last.getAttribute('data-active'), 'true')
    assert.equal(await last.evaluate((row) => {
      const bounds = row.getBoundingClientRect()
      const list = row.closest('.cmd-list').getBoundingClientRect()
      return bounds.top >= list.top && bounds.bottom <= list.bottom
    }), true, 'Keyboard selection scrolls the last command into view')
    await page.keyboard.press('Enter')
    await input.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#root').getAttribute('data-last-command'), 'fixture-55')

    await page.reload()
    await page.locator('.rb').waitFor()
    await open()
    await input.fill('console')
    await pin.click()
    assert.equal(await pin.getAttribute('aria-disabled'), 'true')
    assert.equal(await input.inputValue(), 'console')
    assert.equal(await page.locator('#root').getAttribute('data-last-command'), null, 'Adding to the Ribbon does not run the command')
    await page.keyboard.press('Escape')
    await input.waitFor({ state: 'hidden' })
    await ribbonItem.click()
    assert.equal(await page.locator('#root').getAttribute('data-last-command'), 'fixture-55')
    await page.reload()
    await ribbonItem.waitFor()

    await page.locator('.rb-bottom .rb-plus').click()
    await page.locator('.rb-menu').getByText('Add command', { exact: true }).click()
    await input.waitFor()
    assert.equal(await input.getAttribute('placeholder'), 'Pick a command to add…')
    assert.equal(await page.locator('.cmd-pin').count(), 0)
    await input.fill('Test command 31')
    await items.filter({ hasText: /^Test command 31$/ }).click()
    await page.locator('.rb-bottom [data-id="cmd:fixture-31"]').waitFor()

    for (const mode of ['readonly', 'noribbon']) {
      await page.goto(`${url}&${mode}`)
      await page.waitForSelector('.shell')
      await open()
      assert.equal(await page.locator('.cmd-pin').count(), 0, `${mode} exposes no Ribbon editing action`)
    }
    console.log('PASS Command palette lists, scrolls, runs, and pins commands')
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
