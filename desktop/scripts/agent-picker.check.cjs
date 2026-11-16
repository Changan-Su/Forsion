/** Real picker: stationary pointer, long/short/empty copy, locale changes, search and keyboard scrolling.
 * npm run check:agentpicker (HARNESS_URL selects an isolated Vite port; PICKER_SHOTS preserves evidence).
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const base = new URL('/agent-picker-harness.html', process.env.HARNESS_URL || 'http://localhost:5173')
const output = process.env.PICKER_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-agent-picker-'))
fs.mkdirSync(output, { recursive: true })
const results = [], errors = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`)
}
;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, locale: 'zh-CN' })
    page.on('pageerror', e => errors.push(String(e)))
    const pop = page.locator('.chat-pick-pop:not([data-lcl-exit])')
    const row = id => pop.locator(`[data-pick-id="agent:${id}"]`)
    const settle = () => page.waitForTimeout(180)
    for (const lang of ['zh', 'en']) for (const zoom of [1, 1.1]) {
      const label = `${lang} ${zoom}`
      await page.goto(`${base}?lang=${lang}&zoom=${zoom}${lang === 'en' ? '&light' : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      const chip = page.locator('.compact-chat-picker')
      await chip.click({ timeout: 60000 })
      await settle()
      const initial = await pop.boundingBox()
      const positions = [initial]
      for (const id of ['coding', 'muse', 'listener', 'recita']) {
        await row(id).hover({ position: { x: 90, y: 6 } })
        // Do not move the pointer again: layout changes must not select a neighbouring row.
        const samples = await page.evaluate(async () => {
          const frames = []
          for (let i = 0; i < 30; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            const menu = document.querySelector('.chat-pick-pop:not([data-lcl-exit])')
            const r = menu.getBoundingClientRect()
            frames.push({ id: menu.querySelector('[data-active]')?.getAttribute('data-pick-id'), y: r.y, height: r.height })
          }
          return frames
        })
        check(`${label} stationary pointer stays on ${id}`, samples.every(s => s.id === `agent:${id}`), samples)
        positions.push(await pop.boundingBox())
        if (id === 'coding') {
          const text = await pop.locator('.chat-pick-desc').textContent()
          check(`${label} stock description follows UI language`, text.includes(lang === 'zh' ? '从需求到可运行的网页应用' : 'Build and refine working web apps'), text)
          await page.screenshot({ path: path.join(output, `coding-${lang}-${zoom}.png`) })
        }
      }
      check(`${label} status and descriptions keep menu geometry`, positions.every(r => Math.abs(r.y - initial.y) <= 1 && Math.abs(r.height - initial.height) <= 1), positions)
      await row('aria').hover()
      check(`${label} user-authored description stays verbatim`, (await pop.locator('.chat-pick-desc').textContent()).includes('用户编写的说明 / User-authored description'))
      await row('long').hover()
      await settle()
      const long = await pop.locator('.chat-pick-desc').evaluate(el => {
        const before = el.scrollTop
        el.scrollTop = el.scrollHeight
        return { height: el.clientHeight, scroll: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth, moved: el.scrollTop > before }
      })
      check(`${label} full long description is scrollable without widening menu`, long.scroll > long.height && long.moved && long.scrollWidth <= long.width + 1, long)
      await row('long-two').hover()
      await settle()
      const reset = await pop.locator('.chat-pick-desc').evaluate(el => ({ top: el.scrollTop, overflowing: el.scrollHeight > el.clientHeight }))
      check(`${label} another long description starts at the top`, reset.overflowing && reset.top === 0, reset)
      await pop.locator('input').fill('extra-11')
      check(`${label} search still filters aliases`, await pop.locator('.chat-pick-row').count() === 1)
      await pop.locator('input').fill('')
      await pop.locator('input').focus()
      for (let i = 0; i < 23; i++) await page.keyboard.press('ArrowDown')
      await settle()
      const scroll = await pop.evaluate(el => {
        const search = el.querySelector('.chat-pick-search').getBoundingClientRect()
        const row = el.querySelector('[data-active]').getBoundingClientRect()
        const list = el.querySelector('.ctx-menu-scroll').getBoundingClientRect()
        const menu = el.getBoundingClientRect()
        return { search: search.top >= menu.top && search.bottom <= menu.bottom, row: row.top >= list.top - 1 && row.bottom <= list.bottom + 1 }
      })
      check(`${label} keyboard scroll keeps search and active row visible`, scroll.search && scroll.row, scroll)
      await page.screenshot({ path: path.join(output, `picker-${lang}-${zoom}.png`) })
      await pop.locator('input').fill('coding')
      await settle()
      if (zoom === 1.1) {
        await page.setViewportSize({ width: 320, height: 560 })
        await settle()
        const bounds = await pop.boundingBox()
        check(`${label} narrow viewport keeps popup visible`, bounds.x >= 0 && bounds.x + bounds.width <= 321 && bounds.y >= 0 && bounds.y + bounds.height <= 561, bounds)
        await page.screenshot({ path: path.join(output, `narrow-${lang}.png`) })
        await page.setViewportSize({ width: 1000, height: 760 })
        await settle()
      }
      await pop.locator('input').fill('')
      await page.setViewportSize({ width: 320, height: 360 })
      await settle()
      const short = await pop.boundingBox()
      check(`${label} full roster fits a short viewport`, short.x >= 0 && short.x + short.width <= 321 && short.y >= 0 && short.y + short.height <= 361, short)
      await pop.locator('input').focus()
      await page.keyboard.press('ArrowUp')
      await settle()
      const visible = await pop.evaluate(el => {
        const search = el.querySelector('.chat-pick-search').getBoundingClientRect()
        const list = el.querySelector('.ctx-menu-scroll').getBoundingClientRect()
        const active = el.querySelector('[data-active]').getBoundingClientRect()
        return search.top >= 0 && search.bottom <= innerHeight && active.top >= list.top - 1 && active.bottom <= list.bottom + 1
      })
      check(`${label} short viewport keeps search and keyboard target visible`, visible)
      await page.screenshot({ path: path.join(output, `short-${lang}-${zoom}.png`) })
      await page.setViewportSize({ width: 1000, height: 760 })
      await pop.locator('input').fill('coding')
      await settle()
      await page.evaluate(next => window.__agentPicker.setLocale(next), lang === 'zh' ? 'en' : 'zh')
      await settle()
      const changed = await row('coding').locator('.chat-pick-name').textContent()
      const description = await pop.locator('.chat-pick-desc').textContent()
      check(`${label} open picker updates names and description after locale change`, changed === (lang === 'zh' ? 'Logos' : '逻各斯') && description.includes(lang === 'zh' ? 'Build and refine' : '从需求到可运行'), { changed, description })
      await page.keyboard.press('Escape')
      check(`${label} Escape closes and returns focus`, await chip.getAttribute('aria-expanded') === 'false' && await chip.evaluate(el => document.activeElement === el))
    }
    check('no runtime errors', errors.length === 0, errors)
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2))
    console.log(`${results.filter(r => r.ok).length}/${results.length} passed; evidence: ${output}`)
    if (results.some(r => !r.ok)) process.exitCode = 1
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
