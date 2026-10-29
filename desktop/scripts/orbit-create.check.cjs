/** Tangu category-aware creation: real Electron, isolated data, existing native creation flows.
 * Run after npm run build. SHOT_DIR selects the evidence directory. No model calls are needed.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { launch, boot, enterSpace, shotDir } = require('./lib/uiux-electron.cjs')
const OUT = shotDir('orbit-create')
const categories = ['all', 'agent', 'team', 'project']
const zh = ['新会话', '新 Agent', '新团队', '新项目']
const en = ['New session', 'New agent', 'New team', 'New project']
let passed = 0
const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS ${++passed}: ${name}`) }

async function main() {
  const fxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-orbit-create-fixture-'))
  const project = path.join(fxHome, 'Forsion Genesis'); fs.mkdirSync(project)
  const at = { created_at: '2026-10-29 09:00:00', updated_at: '2026-10-29 10:00:00' }
  const cloudProjects = []
  const ctx = await launch({ tag: 'orbit-create', fixtures: {
    agents: [{ slug: 'xyra', name: 'Xyra', createdBy: 'user', libraryDir: '/tmp/xyra/Library' }, { slug: 'researcher', name: 'Researcher', createdBy: 'user', libraryDir: '/tmp/researcher/Library' }],
    sessions: ['整理本周的开发计划', '侧栏交互与布局', '项目资料与参考'].map((title, i) => ({ ...at, id: `create-${i}`, title, summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: project, project_name: 'Forsion Genesis', projectless: false })),
  }, stubOverride: async ({ path: route, method, body }) => {
    if (route === '/agent/teams') return { teams: [{ slug: 'product-team', name: 'Product Team', members: [{ slug: 'xyra' }, { slug: 'researcher' }] }] }
    if (route === '/agent/projects') {
      if (method === 'POST') { const input = await body(); cloudProjects.push(input.name); return { name: input.name } }
      return { projects: [{ name: 'Tangu', isDefault: true }, ...cloudProjects.map(name => ({ name }))] }
    }
  } })
  const { app, win, stub } = ctx
  const errors = []; win.on('pageerror', e => errors.push(String(e)))
  const select = async category => { await win.locator(`.t2o [data-filter="${category}"]`).click(); await win.waitForTimeout(80) }
  const primary = () => win.locator('.t2o-head .t2s-special')
  const back = async () => { assert.ok(await enterSpace(win, 'tangu', { real: true })); await win.waitForSelector('.t2o-head') }
  try {
    await boot(app, win, { width: 1512, height: 950 })
    await win.evaluate(() => { localStorage.setItem('forsion_ui_zoom', '1.1'); localStorage.setItem('forsion_orbits_filter', 'all') })
    await win.reload(); await win.waitForSelector('.t2o-head')
    for (const theme of ['light', 'dark', 'blue']) {
      await win.evaluate(theme => {
        const r = document.documentElement; r.dataset.mode = theme === 'dark' ? 'dark' : 'light'; r.classList.toggle('dark', theme === 'dark'); r.dataset.skin = theme === 'blue' ? 'zhi' : 'cream'; r.dataset.bg = 'cream'
      }, theme)
      for (const [i, category] of categories.entries()) {
        await select(category)
        check(`${theme}/${category}: label and action match the category`, (await primary().innerText()).trim() === zh[i] && await primary().getAttribute('data-act') === (i ? `new-${category}` : 'new-chat'))
        const geometry = await win.evaluate(() => {
          const head = document.querySelector('.t2o-head .t2s-special').getBoundingClientRect()
          const filters = document.querySelector('.t2o-filters').getBoundingClientRect()
          const first = [...document.querySelectorAll('.t2o .t2s-scroll .t2s-group, .t2o .t2s-scroll .t2o-row')].find(e => e.getBoundingClientRect().height > 0).getBoundingClientRect()
          const zoom = Number(getComputedStyle(document.body).zoom)
          return { height: head.height / zoom, gap: (first.top - head.bottom) / zoom, filterGap: (head.top - filters.bottom) / zoom }
        })
        check(`${theme}/${category}: approved 40px row, filter above, one 4px list gap`, Math.abs(geometry.height - 40) < .1 && Math.abs(geometry.gap - 4) < .1 && Math.abs(geometry.filterGap - 4) < .1)
        await win.mouse.move(1100, 180); await win.waitForTimeout(150)
        const box = await win.locator('.t2o').boundingBox()
        await win.screenshot({ path: path.join(OUT, `${theme}-${category}-side.png`), clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: 560 } })
        if (category === 'all') await win.screenshot({ path: path.join(OUT, `${theme}-full.png`) })
      }
    }
    await select('team'); await primary().click(); await win.locator('.team-editor').waitFor()
    check('Team directly opens the existing creation editor', (await win.locator('.team-editor').innerText()).includes('新建团队'))
    await win.locator('.team-editor .icon-btn[title="取消"]').click()
    await win.locator('.t2o-plus').click()
    check('+ retains all three cross-category creation choices', await win.locator('.ctx-menu button').count() === 3)
    await win.locator('.ctx-menu').getByRole('button', { name: '新建 Agent', exact: true }).click()
    await win.locator('.agent-create-form').waitFor()
    check('+ New agent directly opens the native creation form', await win.locator('.agent-create-form input').count() === 2 && await win.locator('.agent-create-form textarea').count() === 1)
    await win.locator('.agent-create-form').getByRole('button', { name: '放弃修改', exact: true }).click()
    await back(); await select('agent'); await primary().click(); await win.locator('.agent-create-form').waitFor()
    check('Agent primary action opens creation even when the Agents view already exists', await win.locator('.agent-create-form').isVisible())
    await win.screenshot({ path: path.join(OUT, 'agent-creation.png') })
    await win.locator('.agent-create-form').getByRole('button', { name: '放弃修改', exact: true }).click(); await back()
    await app.evaluate(({ dialog }) => { globalThis.__orbitPickCount = 0; dialog.showOpenDialog = async () => { globalThis.__orbitPickCount++; return { canceled: true, filePaths: [] } } })
    await select('project'); await primary().click()
    await win.waitForTimeout(250)
    check('Project primary action reaches the native directory picker through real IPC', await app.evaluate(() => globalThis.__orbitPickCount) === 1)
    check('Canceling creation does not create an empty session', stub.seen.sessionCreates.length === 0)
    await select('all'); await primary().click(); await win.waitForTimeout(350)
    check('All keeps the existing new-session draft action', (await win.locator('.t2c').count()) > 0 && stub.seen.sessionCreates.length === 0)
    await select('project'); await win.reload(); await win.waitForSelector('.t2o-head')
    check('Reload restores the selected category and its creation action', (await primary().innerText()).trim() === '新项目')
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en')); await win.reload(); await win.waitForSelector('.t2o-head')
    for (const [i, category] of categories.entries()) {
      await select(category)
      check(`English/${category}: translated creation label`, (await primary().innerText()).trim() === en[i])
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 800))
    await win.waitForFunction(() => innerWidth === 880)
    for (const [i, category] of categories.entries()) {
      await select(category)
      const contained = await primary().evaluate(e => { const row = e.getBoundingClientRect(), pane = e.closest('.t2o').getBoundingClientRect(); return row.left >= pane.left && row.right <= pane.right && getComputedStyle(e.querySelector('.t2s-special-title')).textOverflow === 'ellipsis' })
      check(`Narrow/${category}: action stays inside the pane and retains its full accessible label`, contained && await win.locator('.t2o-head').getByRole('button', { name: en[i], exact: true }).count() === 1)
    }
    await win.screenshot({ path: path.join(OUT, 'english-narrow.png') })
    // Same real renderer/IPC, with only the directory-picker capability removed.
    // This reproduces the Web/mobile branch without pretending to test an APK.
    const preload = path.join(__dirname, '../out/preload/preload.mjs')
    const noPickerPreload = path.join(fxHome, 'no-picker-preload.mjs')
    const expose = 'contextBridge.exposeInMainWorld("tangu", api);'
    const preloadCode = fs.readFileSync(preload, 'utf8')
    assert.ok(preloadCode.includes(expose), 'locate the actual bridge export before removing one capability')
    fs.writeFileSync(noPickerPreload, preloadCode.replace(expose, 'delete api.pickDirectory;\n' + expose))
    const nextWindow = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, opts) => {
      const w = new BrowserWindow({ width: 1100, height: 850, webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: false } })
      await w.loadURL(opts.url)
    }, { preload: noPickerPreload, url: win.url() })
    const noPicker = await nextWindow
    noPicker.on('pageerror', e => errors.push(String(e)))
    await noPicker.waitForSelector('.t2o-head')
    check('No-picker fixture really has no directory capability', await noPicker.evaluate(() => !window.tangu?.pickDirectory))
    await noPicker.evaluate(() => localStorage.setItem('tangu_locale', 'zh')); await noPicker.reload(); await noPicker.waitForSelector('.t2o-head')
    await noPicker.locator('.t2o [data-filter="project"]').click()
    await noPicker.locator('.t2o-head .t2s-special').click()
    await noPicker.locator('.dialog-input').waitFor()
    check('Without a picker, New project opens the existing name prompt', (await noPicker.locator('.dialog-title').innerText()) === '新项目')
    await noPicker.locator('.dialog-input').fill('New cloud project')
    await noPicker.locator('.dialog-btn[data-primary]').click()
    await noPicker.locator('.t2o .t2s-group', { hasText: 'New cloud project' }).waitFor()
    check('Named project is sent to the API and appears immediately in the project list', cloudProjects.includes('New cloud project'))
    await noPicker.screenshot({ path: path.join(OUT, 'without-picker-created.png') })
    check('No renderer exceptions', errors.length === 0)
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ passed, errors, coverage: 'real macOS Electron, stub backend, native picker cancellation through dialog stand-in, directory-capability absence through preload stand-in; no APK device coverage' }, null, 2))
    console.log(`SHOTS ${OUT}`)
  } finally { await ctx.close(); fs.rmSync(fxHome, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exit(1) })
