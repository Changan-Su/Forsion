/** 手机 Calendar「点空白 → 填标题 → 保存」新建事件的复现台架(10-23)。
 *  载具 = 完整 mobile 入口 + 单列壳 + 真本地库桥 + Chromium 触屏,原生 chrome 用 phone-stage 的替身;后端走桩:
 *  /agent/human/CALENDAR.db 由本脚本按 HUMAN 档位答(ok = 带 CAS 的内存文件 / missing = 404)。
 *  每个场景单独起一页:RENDER=plugin(随包 @forsion/calendar 接管,手机缺省)| native(关掉插件,走宿主 CalendarView)。
 *    node scripts/calendar-create.check.cjs                 # 全部场景
 *    ONLY=plugin-human,native-human node scripts/…          # 只跑点名的
 *  输出:每步 PASS/FAIL + 失败那步的截图 + 控制台错误 + 未桩的请求,落在 CAL_CREATE_OUT(缺省系统临时目录)。 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')
const { stubApi, installChrome, stage, moduleUrl, loaded, SCREEN } = require('./phone-stage.cjs')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.CAL_CREATE_PORT || 5296) // phone-stage 的 stubApi 只把 localhost:5296 当作页面源放行
const OUT = process.env.CAL_CREATE_OUT || path.join(os.tmpdir(), 'forsion-calendar-create')
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const DAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

// render: plugin | native;human: ok | missing;vaultDb: 库里有没有一张带日期列的表
const SCENARIOS = {
  'plugin-human': { render: 'plugin', human: 'ok', vaultDb: false },
  'plugin-human+vault': { render: 'plugin', human: 'ok', vaultDb: true },
  'plugin-vault': { render: 'plugin', human: 'missing', vaultDb: true },
  'native-human': { render: 'native', human: 'ok', vaultDb: false },
  'native-human+vault': { render: 'native', human: 'ok', vaultDb: true },
  'native-vault': { render: 'native', human: 'missing', vaultDb: true },
  // 没有任何可写日历:点空白本来就建不出(只缺一句提示),缺省不跑,点名 ONLY=plugin-none 才跑
  'plugin-none': { render: 'plugin', human: 'missing', vaultDb: false, optIn: true },
  // 真 server(agent-core/humanCalendar.ts)对没有这份文件的新用户答 200 {status:'missing'},第一次 PUT 带 version:null
  'plugin-fresh': { render: 'plugin', human: 'fresh', vaultDb: false },
  'native-fresh': { render: 'native', human: 'fresh', vaultDb: false },
  // 手机上没开任何笔记库(vaultRoot = null):个人日历是唯一一本可写日历
  'plugin-novault': { render: 'plugin', human: 'fresh', vaultDb: false, noVault: true },
  'native-novault': { render: 'native', human: 'fresh', vaultDb: false, noVault: true },
}
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)

function humanCalendar() {
  let file = { version: 2, name: '我的日历', columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }], rows: [] }
  let version = 1
  let fresh = true // 只对 human:'fresh' 有意义:还没写过
  const puts = []
  return {
    puts, rows: () => file.rows,
    async handle(route, mode) {
      const req = route.request(), m = req.method()
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
      if (mode === 'missing') return json(404, { error: 'not_found' })
      if (m === 'GET') return mode === 'fresh' && fresh ? json(200, { status: 'missing', legacy: null }) : json(200, { status: 'ok', data: file, version: String(version) })
      if (m === 'PUT') {
        const body = JSON.parse(req.postData() || '{}')
        puts.push({ version: body.version, rows: (body.data?.rows || []).map((r) => r.cells?.name) })
        const expected = mode === 'fresh' && fresh ? null : String(version)
        if ((body.version ?? null) !== expected) return json(409, { error: 'conflict' })
        file = body.data; version++; fresh = false
        return json(200, { version: String(version) })
      }
      return json(405, {})
    },
  }
}

async function runScenario(browser, name, sc) {
  const results = []
  const check = (what, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  | ${detail}` : ''}`); return !!ok }
  const errors = [], consoleErrs = [], unknown = new Set(), human = humanCalendar()
  const context = await browser.newContext({ viewport: SCREEN, hasTouch: true, isMobile: true, locale: 'zh-CN' })
  await context.addInitScript(() => {
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('forsion_token', 'stage')
    localStorage.setItem('amadeus_vault_mode', 'local')
  })
  const page = await context.newPage({ locale: 'zh-CN' })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
  page.on('request', (r) => { const u = new URL(r.url()); if (/\.(tsx?|jsx?)$/.test(u.pathname)) loaded.set(u.pathname, u.pathname + u.search) })
  await stubApi(page, unknown)
  await page.route('**/agent/human/CALENDAR.db', (route) => human.handle(route, sc.human)) // 后注册的先匹配
  const shot = (tag) => page.screenshot({ path: path.join(OUT, `${name}-${tag}.png`) }).catch(() => {})
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('.mb-shell').waitFor({ timeout: 180000 })
    await installChrome(page)
    await page.evaluate(async ({ urls, sc, day }) => {
      const { usePageStore } = await import(urls.page)
      const { useDbStore } = await import(urls.db)
      const { useCalendarConfig } = await import(urls.config)
      const { useCalendarNav } = await import(urls.nav)
      const { usePluginStore } = await import(urls.plugin)
      window.__ccBootVault = `${usePageStore.getState().vaultSide}:${usePageStore.getState().vaultRoot}` // 壳起来那一刻(还没人手动 restoreVault)
      if (!sc.noVault) await usePageStore.getState().restoreVault()
      if (sc.vaultDb) {
        await window.amadeus.writeDatabase('Phone.db', { version: 1, name: 'Phone events', columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }], rows: [
          { id: 'short', cells: { name: 'Phone stand-up', date: `${day}T08:30/${day}T08:45` } },
        ] })
        await usePageStore.getState().refreshStructure()
        await useDbStore.getState().reload('Phone.db', 'Phone.db')
      }
      if (!sc.noVault) useCalendarConfig.getState().migrate(usePageStore.getState().vaultRoot, sc.vaultDb ? [{ dbPath: 'Phone.db', dateCol: 'date' }] : [])
      useCalendarNav.getState().setMode('3day')
      // 真机上原生 chrome 先于插件启动装好;浏览器里替身装得晚,插件要重载一次(同 calendar-phone.check)
      if (sc.render === 'plugin') await usePluginStore.getState().reloadOne('forsion-calendar', { force: true })
      else usePluginStore.getState().disable('forsion-calendar')
      window.__cc = { useDbStore, useCalendarNav, usePluginStore, usePageStore, day }
    }, {
      sc, day: DAY,
      urls: {
        page: moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'),
        db: moduleUrl('../desktop/frontend/src/amadeus/store/dbStore.ts'),
        config: moduleUrl('../desktop/frontend/src/amadeus/store/calendarConfigStore.ts'),
        nav: moduleUrl('../desktop/frontend/src/amadeus/store/calendarNavStore.ts'),
        plugin: moduleUrl('../desktop/frontend/src/amadeus/plugins/pluginStore.ts'),
      },
    })
    await stage.space(page, 'calendar')
    await page.locator('.amx-cal').first().waitFor({ timeout: 20000 })
    // 没开库:等日历上屏后再清(更早清的话,关插件触发的重载会把库重新 restore 回来)
    if (sc.noVault) { await page.evaluate(() => window.__cc.usePageStore.setState({ vaultRoot: null })); await page.waitForTimeout(800) }
    const render = await page.evaluate(() => ({
      pluginStyle: !!document.querySelector('style[data-plugin="forsion-calendar"]'),
      pluginLoaded: !!window.__cc.usePluginStore.getState().plugins.find((p) => p.id === 'forsion-calendar' && p.enabled !== false),
      calRoots: document.querySelectorAll('.amx-cal').length,
      mobileClass: !!document.querySelector('.amx-cal.mobile'),
    }))
    check(`渲染者 = ${sc.render}`, sc.render === 'plugin' ? render.pluginStyle : !render.pluginStyle, JSON.stringify(render))
    const legend = await page.evaluate(() => ({ boot: window.__ccBootVault, vault: `${window.__cc.usePageStore.getState().vaultSide}:${window.__cc.usePageStore.getState().vaultRoot}`, entries: Object.fromEntries(Object.entries(window.__cc.useDbStore.getState().entries).map(([k, v]) => [k, v?.status])) }))
    console.log(`  info  壳起来时库 ${legend.boot};现在库 ${legend.vault};dbStore 条目: ${JSON.stringify(legend.entries)}`)
    // 滚到今天 13:00 附近,点一下空白
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const sc = document.querySelector('.amx-cal-tscroll'), cell = document.querySelector(`.amx-cal-daycol2[data-date="${window.__cc.day}"]`)
      if (!sc || !cell) return
      sc.scrollLeft = cell.offsetLeft
      const px = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
      sc.scrollTop = cell.offsetTop + 11 * px
      sc.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(300)
    const pt = await page.evaluate(() => {
      const cell = document.querySelector(`.amx-cal-daycol2[data-date="${window.__cc.day}"]`)
      if (!cell) return null
      const r = cell.getBoundingClientRect(), z = cell.currentCSSZoom || 1
      const px = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
      return { x: r.left + r.width / 2, y: r.top + (13 * px + 4) * z, hit: (() => { const el = document.elementFromPoint(r.left + r.width / 2, r.top + (13 * px + 4) * z); return el ? `${el.tagName}.${el.className}` : null })() }
    })
    if (!check('今天那一列在', !!pt)) { await shot('no-col'); return results }
    console.log(`  info  点击点 ${Math.round(pt.x)},${Math.round(pt.y)} 命中 ${pt.hit}`)
    await page.touchscreen.tap(pt.x, pt.y)
    const drawer = await page.locator('.amx-cal-draftcard').waitFor({ timeout: 3000 }).then(() => true, () => false)
    if (!check('① 点空白 → 新事件抽屉出现', drawer)) {
      await shot('no-draft')
      const st = await page.evaluate(() => ({ draft: window.__cc.useCalendarNav.getState().draft, sel: window.__cc.useCalendarNav.getState().selection?.key }))
      console.log(`  info  宿主 nav store: ${JSON.stringify(st)}`)
      return results
    }
    await page.waitForTimeout(400)
    const still = await page.locator('.amx-cal-draftcard').count()
    check('① 抽屉 400ms 后还在(没被返回事件当场关掉)', still > 0)
    if (!still) { await shot('draft-vanished'); return results }
    const chrome = await stage.state(page)
    console.log(`  info  原生 chrome: mode=${chrome?.mode} title=${chrome?.title}`)
    const title = `手机新建 ${name}`
    const input = page.locator('.amx-cal-draftcard input.amx-cal-card-title')
    await input.tap()
    await page.keyboard.type(title)
    await page.waitForTimeout(200)
    check('② 标题进了输入框', (await input.inputValue().catch(() => '')) === title, await input.inputValue().catch((e) => String(e)))
    const save = page.locator('.amx-cal-draftcard .amx-cal-draft-save')
    check('② 保存可点', await save.isEnabled().catch(() => false))
    await shot('before-save')
    await save.tap()
    await page.waitForTimeout(400)
    check('③ 保存后抽屉收起', (await page.locator('.amx-cal-draftcard').count()) === 0)
    let wrote = '', ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      await page.waitForTimeout(250)
      if (human.rows().some((r) => r.cells?.name === title)) { ok = true; wrote = 'human://CALENDAR.db(PUT 落盘)' }
      else if (sc.vaultDb) {
        await page.evaluate(() => window.__cc.useDbStore.getState().flushAll?.(true)).catch(() => {})
        const rows = await page.evaluate(async () => (await window.amadeus.readDatabase('Phone.db', 'Phone.db'))?.data?.rows?.map((r) => r.cells.name) ?? []).catch(() => [])
        if (rows.includes(title)) { ok = true; wrote = 'Phone.db(库桥落盘)' }
      }
    }
    check('④ 这条写进了某本日历', ok, wrote || `human PUTs=${JSON.stringify(human.puts)}`)
    const onGrid = await page.waitForSelector(`.amx-cal-event[aria-label^="${title}"]`, { timeout: 4000 }).then(() => true, () => false)
    check('④ 网格上出现这条事件', onGrid)
    await shot('after-save')
  } catch (e) {
    check('台架没抛异常', false, String(e && e.stack || e).slice(0, 600))
    await shot('exception')
  } finally {
    if (errors.length) console.log(`  info  pageerror: ${errors.slice(0, 5).join(' / ')}`)
    const ce = consoleErrs.filter((x) => !/Download the React DevTools|ERR_FAILED|net::/.test(x))
    if (ce.length) console.log(`  info  console(${ce.length}): ${ce.slice(0, 6).join('\n          ')}`)
    if (unknown.size) console.log(`  info  未桩请求: ${[...unknown].slice(0, 12).join(', ')}`)
    await context.close()
  }
  return results
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const summary = []
  try {
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      if (ONLY.length ? !ONLY.includes(name) : SCENARIOS[name].optIn) continue
      console.log(`\n== ${name}  ${JSON.stringify(sc)}`)
      const r = await runScenario(browser, name, sc)
      summary.push(`${r.every(Boolean) ? 'PASS' : 'FAIL'} ${name} (${r.filter(Boolean).length}/${r.length})`)
    }
  } finally { await browser.close(); await server.close() }
  console.log(`\n${summary.join('\n')}\n截图:${OUT}`)
  process.exitCode = summary.some((s) => s.startsWith('FAIL')) ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
