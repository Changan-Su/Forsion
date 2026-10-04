/** Image Studio: real Electron, project list ⇄ project layout, native canvas gestures, IndexedDB, project roundtrip and chat SSE.
 * Only the model backend is scripted. No paid model run or personal data is touched.
 * Run after npm run build: node scripts/image-studio.e2e.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const contextOnly = process.argv.includes('--context-menu-only')
const OUT = path.resolve(ROOT, contextOnly ? '../outputs/image-studio-context-menu' : '../outputs/image-studio')
const results = [], errors = []
const check = (name, value) => { results.push({ name, pass: !!value }); assert.ok(value, name); console.log(`PASS ${name}`) }
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-image-studio-'))
  const userdata = path.join(home, 'userdata')
  const stub = await startStubEngine({ sessions: [{ id: 'unrelated', title: 'Unrelated conversation', model_id: 'm1', agent_config: {}, created_at: '2026-09-20 00:00:00', updated_at: '2026-09-20 00:00:00' }], override: ({ path, method }) => path === '/agent/runs' && method === 'GET' ? { runs: [] } : undefined })
  let app, win, failed = false
  const screenshot = async name => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    await win.mouse.move(12, 12)
    if (name.startsWith('workspace-')) await win.locator('.ach-toast').waitFor({ state: 'hidden', timeout: 15000 })
    await win.evaluate(async () => { const svgImages = [...document.querySelectorAll('svg image')].map(node => { const img = new Image(); img.src = node.getAttribute('href') || ''; return img }); await Promise.all([...document.images, ...svgImages].map(img => img.decode().catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await win.waitForTimeout(1000) // Native theme transitions and canvas fit settle before capture.
    const png = await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.focus(); return (await window.capturePage(undefined, { stayAwake: true })).toPNG().toString('base64') })
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, 'base64'))
  }
  const openStudio = async () => {
    await win.waitForSelector('.dv-groupview', { timeout: 45000 })
    if (await win.locator('.ims, .ims-launch').first().isVisible().catch(() => false)) return
    const icon = win.locator('.rb-space[aria-label="图像工作室"]').first()
    if (!await icon.isVisible().catch(() => false)) await win.locator('.rb-top .rb-more').first().click() // 「…」= 展开
    await icon.click()
    await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click()) // 收起:展开时命令区让出来,后续步骤要用
    await win.waitForSelector('.ims, .ims-launch')
  }
  // 布局(项目 + 详情):面板在主区的哪一侧(没画出来 = null);右栏开合读顶栏那枚开关。
  const sideOf = selector => win.evaluate(sel => {
    const el = document.querySelector(sel), main = document.querySelector('.ims, .ims-launch')
    if (!el || !main) return null
    const r = el.getBoundingClientRect(), m = main.getBoundingClientRect()
    return !r.width ? null : r.right <= m.left + 1 ? 'left' : r.left >= m.right - 1 ? 'right' : 'main'
  }, selector)
  const rightOpen = async () => await win.locator('.dv-edge-right').getAttribute('aria-pressed') === 'true'
  const rightSettles = async open => { await win.waitForFunction(want => document.querySelector('.dv-edge-right')?.getAttribute('aria-pressed') === String(want), open); await win.waitForTimeout(700) } // 开合有补间 + 沉降
  // After a (re)start or a layout rebuild the side panels arrive later than the main view (lazy chunks, restore tween):
  // poll until every probed fact holds. The first unsettled reading and the last one on timeout are printed, so a
  // failure says which fact was off instead of leaving a bare assertion.
  const eventually = async (label, probe) => {
    const started = Date.now(); let seen
    for (let first = true; Date.now() - started < 6000; first = false) {
      seen = await probe()
      if (Object.values(seen).every(Boolean)) return true
      if (first) console.log(`  settling — ${label}: ${JSON.stringify(seen)}`)
      await win.waitForTimeout(100)
    }
    console.log(`  not settled — ${label}: ${JSON.stringify(seen)}`); return false
  }
  const toProjects = async () => { await win.locator('.ims-back').click(); await win.waitForSelector('.ims-launch') }
  const newProject = async () => { await win.locator('.ims-launch').getByRole('button', { name: /^(新建项目|New project)$/ }).click(); await win.waitForSelector('.ims') }
  const projectCard = id => win.locator(`.ims-launch-card[data-project-id="${id}"]`)
  const openProjectId = async id => { await toProjects(); await projectCard(id).click(); await win.waitForSelector('.ims') }
  const mode = async value => {
    if (await win.evaluate(() => document.documentElement.dataset.mode) !== value) await win.locator('[data-id="rb-mode"]').click()
    await win.waitForFunction(expected => document.documentElement.dataset.mode === expected, value)
  }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 45000 })
    win = await app.firstWindow(); win.setDefaultTimeout(15000)
    await app.evaluate(({ session }, directory) => {
      process.imageStudioDownloads = []
      session.defaultSession.on('will-download', (_event, item) => {
        const file = directory + '/' + item.getFilename()
        item.setSavePath(file)
        item.once('done', (_event, state) => process.imageStudioDownloads.push({ file, state }))
      })
    }, home)
    win.on('pageerror', e => errors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 980))
    await win.waitForSelector('#root')
    const skip = win.getByText(/^(跳过引导|Skip)$/).first()
    await Promise.race([skip.waitFor({ state: 'visible', timeout: 45000 }), win.locator('.dv-groupview').first().waitFor({ state: 'visible', timeout: 45000 })])
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await win.waitForSelector('.dv-groupview', { timeout: 45000 })
    await openStudio()
    await win.waitForSelector('.ims-launch')
    check('The Space opens on the project list: navigation on the left, right side folded', await eventually('first open', async () => ({ nav: await sideOf('.ims-nav') === 'left', rightFolded: !await rightOpen(), empty: await win.locator('.ims-launch .csl-empty').isVisible() })))
    await screenshot('launchpad-empty')
    await newProject()
    await win.waitForSelector('.ims-empty')
    check('Native Space opens with an honest empty canvas', await win.locator('.ims-empty h1').isVisible())
    await rightSettles(true)
    check('Opening a project puts Layers beside the navigation and brings the chat out on the right', await sideOf('.ims-layers') === 'left' && await sideOf('.ims-chat-empty') === 'right' && await win.locator('.wb-tab--left').count() === 2)
    await screenshot('welcome')

    // Deterministic image fixtures: export tests compare real decoded pixels, not placeholders.
    const fixtures = await win.evaluate(() => [0, 1].map(index => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1000
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = index ? '#dae0d9' : '#efe8dc'; ctx.fillRect(0, 0, 800, 1000)
      ctx.fillStyle = index ? '#263f35' : '#853f2b'; ctx.beginPath(); ctx.arc(400, 430, 225, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = index ? '#dae0d9' : '#efe8dc'; ctx.font = '100px Georgia'; ctx.textAlign = 'center'; ctx.fillText(index ? 'FORM' : 'STILL', 400, 455)
      ctx.fillStyle = '#282925'; ctx.textAlign = 'left'; ctx.font = '26px sans-serif'; ctx.fillText('STUDIO / 0' + (index + 1), 70, 90)
      ctx.font = '52px Georgia'; ctx.fillText(index ? 'A quieter perspective.' : 'Room to imagine.', 70, 855)
      ctx.font = '20px sans-serif'; ctx.fillText('IMAGE STUDIO · ACCEPTANCE FIXTURE', 70, 913)
      return canvas.toDataURL('image/png')
    }))
    const fixtureFiles = fixtures.map((url, index) => { const file = path.join(home, `reference-${index + 1}.png`); fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64')); return file })
    await win.locator('.ims input[type="file"][multiple]').setInputFiles(fixtureFiles)
    await win.waitForSelector('.ims-image:nth-child(2) .ims-raster image')
    check('Image import uses real decoded files', await win.locator('.ims-image').count() === 2)
    await win.locator('.ims-footer input').fill('Autumn studies')
    await win.locator('.ims-stage').click({ position: { x: 10, y: 10 } })
    const first = win.locator('.ims-image').first()
    const box = await first.boundingBox()
    await win.mouse.move(box.x + 70, box.y + 70); await win.mouse.down(); await win.mouse.move(box.x + 110, box.y + 130, { steps: 8 }); await win.mouse.up()
    const moved = await first.boundingBox()
    check('Native canvas drag changes geometry', Math.abs(moved.x - box.x) > 20 && Math.abs(moved.y - box.y) > 20)
    await win.getByRole('button', { name: /^(撤销|Undo)$/ }).click()
    const undone = await first.boundingBox()
    check('Undo restores canvas geometry', Math.abs(undone.x - box.x) < 2)
    await first.click(); await win.locator('.ims-image').nth(1).click({ modifiers: ['Shift'] })
    check('Native Shift selection can select multiple images', await win.locator('.ims-image.is-selected').count() === 2)
    await win.getByRole('button', { name: /^(从画布移除|Remove from canvas)$/ }).click()
    check('Removing a selection updates the canvas', await win.locator('.ims-image').count() === 0)
    await win.getByRole('button', { name: /^(撤销|Undo)$/ }).click()
    await win.waitForSelector('.ims-image:nth-child(2)')
    check('Undo restores removed images', await win.locator('.ims-image').count() === 2)
    await first.dblclick()
    await win.waitForSelector('.ims-inspector')
    check('Inspector is a native docked View', !!await win.locator('.ims-inspector').evaluate(el => el.closest('.dv-groupview')))
    const brightness = win.locator('.ims-inspector input[type="range"]').first()
    await brightness.fill('120')
    check('Non-destructive adjustment updates the visible image', (await first.locator('.ims-raster').first().getAttribute('style')).includes('brightness(120%)'))
    const before = Number(await first.locator('.ims-raster').first().getAttribute('data-original-width'))
    check('Original resolution is preserved', before === 800)
    await win.locator('.ims-inspector').getByRole('button', { name: /^(导出 PNG|Export PNG)$/ }).click()
    let downloadCount = 0
    const waitDownload = async () => {
      const count = ++downloadCount
      const until = Date.now() + 15000
      while (Date.now() < until) {
        const downloaded = await app.evaluate(() => process.imageStudioDownloads)
        if (downloaded.length >= count) { assert.equal(downloaded[count - 1].state, 'completed'); return downloaded[count - 1].file }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Native download did not complete')
    }
    const png = await waitDownload(); fs.copyFileSync(png, path.join(OUT, 'export.png'))
    check('PNG export contains a real image', fs.statSync(path.join(OUT, 'export.png')).size > 5000)
    const menu = win.getByRole('menu')
    const menuAction = name => menu.getByRole('menuitem', { name })
    const rightClick = async (target = first) => {
      // Canvas pan is a transform, not DOM scrolling. Use a visible point without scrollIntoView.
      await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const rect = await target.boundingBox(), stage = await win.locator('.ims-stage').boundingBox()
      const x = (Math.max(rect.x, stage.x) + Math.min(rect.x + rect.width, stage.x + stage.width)) / 2
      const y = (Math.max(rect.y, stage.y) + Math.min(rect.y + rect.height, stage.y + stage.height)) / 2
      // A theme ViewTransition temporarily intercepts hit testing even after data-mode changes.
      await win.waitForFunction(({ x, y, id }) => document.elementFromPoint(x, y)?.closest('[data-image-id]')?.getAttribute('data-image-id') === id, { x, y, id: await target.getAttribute('data-image-id') }, { timeout: 5000 })
      await win.mouse.click(x, y, { button: 'right' })
      await menu.waitFor({ state: 'visible' })
    }
    await rightClick()
    check('Right-clicking an image opens native image actions', await menuAction(/^(下载图片|Download image)$/).isVisible())
    check('Image actions receive keyboard focus', await menuAction(/^(下载图片|Download image)$/).evaluate(el => el === document.activeElement))
    await menuAction(/^(下载图片|Download image)$/).click()
    const editedDownload = await waitDownload()
    check('Context download preserves the visible adjustment and full original resolution', fs.readFileSync(editedDownload).equals(fs.readFileSync(path.join(OUT, 'export.png'))))
    fs.copyFileSync(editedDownload, path.join(OUT, 'context-edited.png'))
    await rightClick()
    await menuAction(/^(下载原图|Download original)$/).click()
    const originalDownload = await waitDownload()
    check('Original download preserves the untouched source bytes', fs.readFileSync(originalDownload).equals(Buffer.from(fixtures[0].split(',')[1], 'base64')))
    fs.copyFileSync(originalDownload, path.join(OUT, 'context-original.png'))

    await first.click(); await win.locator('.ims-image').nth(1).click({ modifiers: ['Shift'] })
    await rightClick()
    check('Right-click preserves a multi-selection and offers selection export', await win.locator('.ims-image.is-selected').count() === 2 && await menuAction(/^(导出选区…|Export selection…)$/).isVisible() && await menuAction(/^(下载图片|Download image)$/).count() === 0)
    await menuAction(/^(创建副本|Duplicate)$/).click()
    await win.waitForFunction(() => document.querySelectorAll('.ims-image').length === 4)
    check('Context duplicate copies every selected image', await win.locator('.ims-image.is-selected').count() === 2)
    await rightClick(win.locator('.ims-image.is-selected').last())
    await menuAction(/^(从画布移除|Remove from canvas)$/).click()
    await win.waitForFunction(() => document.querySelectorAll('.ims-image').length === 2)
    check('Context delete removes only the chosen copies', await win.locator('.ims-image').count() === 2)
    await rightClick(win.locator('.ims-image').nth(1))
    check('Right-click selects an unselected image', await win.locator('.ims-image.is-selected').count() === 1 && (await win.locator('.ims-image').nth(1).getAttribute('class')).includes('is-selected'))
    await rightClick()
    check('A second right-click replaces the open menu target', (await first.getAttribute('class')).includes('is-selected') && await menu.isVisible())
    await menuAction(/^(复制对象|Copy objects)$/).click()
    await win.locator('.ims-stage').click({ button: 'right', position: { x: 10, y: 10 } })
    check('Blank canvas offers paste without retaining the image selection', await win.locator('.ims-image.is-selected').count() === 0 && await menuAction(/^(粘贴对象|Paste objects)$/).isEnabled())
    await menuAction(/^(粘贴对象|Paste objects)$/).click()
    await win.waitForFunction(() => document.querySelectorAll('.ims-image').length === 3)
    check('Context paste adds the copied canvas object', await win.locator('.ims-image.is-selected').count() === 1)
    await win.getByRole('button', { name: /^(从画布移除|Remove from canvas)$/ }).first().click()
    await rightClick()
    await menuAction(/^(锁定图层|Lock layer)$/).click()
    await rightClick()
    check('Locked images allow downloads but disable deletion and reordering', await menuAction(/^(下载图片|Download image)$/).isEnabled() && await menuAction(/^(从画布移除|Remove from canvas)$/).isDisabled() && await menuAction(/^(上移一层|Bring forward)$/).isDisabled())
    await win.keyboard.press('End')
    check('Keyboard navigation skips disabled menu actions', await menuAction(/^(解锁图层|Unlock layer)$/).evaluate(el => el === document.activeElement))
    await win.keyboard.press('Enter')
    check('Unlock action restores editability', !(await first.getAttribute('class')).includes('is-locked'))
    await rightClick()
    await win.keyboard.press('Escape')
    check('Escape closes the menu and preserves the selection', !await menu.isVisible() && await win.locator('.ims-image.is-selected').count() === 1)
    await rightClick()
    await menuAction(/^(上移一层|Bring forward)$/).click()
    check('Context layer ordering moves the target above its sibling', (await win.locator('.ims-image').last().locator('.ims-raster').getAttribute('style')).includes('brightness(120%)'))
    await win.getByRole('button', { name: /^(撤销|Undo)$/ }).click()
    await win.getByRole('button', { name: /^(平移 · H \/ 空格|Pan · H \/ Space)$/ }).click()
    await rightClick()
    check('Pan tool still permits image context actions', await menuAction(/^(下载图片|Download image)$/).isVisible())
    await win.keyboard.press('Escape')
    await win.getByRole('button', { name: /^(选择 · V|Select · V)$/ }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760))
    await mode('light')
    await win.getByTitle(/^(适应内容|Fit to content)$/).click()
    await rightClick()
    const menuBounds = await menu.boundingBox(), viewport = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    check('Native menu stays within a narrow window', menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= viewport.w && menuBounds.y + menuBounds.height <= viewport.h)
    await screenshot('context-menu-light')
    await win.keyboard.press('Escape'); await mode('dark'); await rightClick()
    await screenshot('context-menu-dark')
    await win.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 980))
    await win.getByTitle(/^(适应内容|Fit to content)$/).click()
    if (contextOnly) return
    await mode('light'); await screenshot('canvas-light')
    await mode('dark')
    await screenshot('canvas-dark')

    await win.getByRole('button', { name: /^(下载项目|Download project)$/ }).click()
    const project = await waitDownload(); const projectFile = path.join(home, 'roundtrip.forsion-image.json'); fs.copyFileSync(project, projectFile)
    check('Portable project contains images and adjustments', JSON.parse(fs.readFileSync(projectFile)).images[0].brightness === 120)
    await toProjects(); await rightSettles(false)
    check('Going back takes Layers away and folds the right side', await sideOf('.ims-layers') === null && await sideOf('.ims-nav') === 'left' && await win.locator('.wb-tab--left').count() === 1)
    await win.waitForSelector('.ims-launch-card .ims-cover-img:nth-child(2) image')
    check('The project list shows the project with a cover made from its images', await win.locator('.ims-launch-card').count() === 1 && await win.locator('.ims-launch-card .ims-cover-img image').count() === 2 && (await win.locator('.ims-launch-card strong').textContent()) === 'Autumn studies')
    await newProject()
    check('A new project has an independent canvas', await win.locator('.ims-image').count() === 0)
    await rightSettles(true)
    // 在项目里把右栏亲手收起:换项目、回启动台再进,都不该再自动弹出来。
    await win.locator('.dv-edge-right').click(); await rightSettles(false)
    await win.locator('.wb-tab--left[title="图像工作室"]').click() // 左栏的导航标签还在图层旁边
    await win.locator('.ims-nav').getByRole('button', { name: 'Autumn studies' }).click()
    await win.waitForSelector('.ims-image:nth-child(2)')
    check('Switching projects from the navigation restores images', await win.locator('.ims-image').count() === 2 && (await win.locator('.ims-back').textContent()) === 'Autumn studies')
    await toProjects(); await win.locator('.ims-launch-card', { hasText: 'Autumn studies' }).click(); await win.waitForSelector('.ims-image:nth-child(2)'); await win.waitForTimeout(900)
    check('A right side the user folded stays folded for the next project', !await rightOpen() && await sideOf('.ims-layers') === 'left')
    await toProjects()
    await win.locator('.ims-launch input[type="file"][accept=".json"]').setInputFiles(projectFile)
    await win.waitForSelector('.ims-image:nth-child(2)')
    check('Project import restores adjustments without borrowing a session', (await win.locator('.ims-image .ims-raster').first().getAttribute('style')).includes('brightness(120%)'))
    await toProjects()
    check('The imported copy is a third project', await win.locator('.ims-launch-card').count() === 3)
    await win.locator('.ims-launch input[type="search"]').fill('zzz')
    check('Searching the project list can come up empty', await win.locator('.ims-launch-card').count() === 0 && await win.locator('.ims-launch .csl-empty').isVisible())
    await win.locator('.ims-launch input[type="search"]').fill('')
    await mode('light'); await screenshot('launchpad-light'); await mode('dark'); await screenshot('launchpad-dark')
    await win.locator('.ims-launch-card').first().click(); await win.waitForSelector('.ims-image:nth-child(2)') // 最近改动的在最前 = 刚导入的那份
    // 生成的起手提示要有输入框接:显式动作不受「收起过就不再自动弹」的限制。
    await win.locator('.ims-toolbar').getByRole('button', { name: /^(创作对话|Creative chat)$/ }).click(); await rightSettles(true)
    check('Asking for the chat opens the folded right side with the chat in front', await sideOf('.ims-chat-empty') === 'right')

    await win.getByRole('button', { name: /^(开启创作对话|Open creative chat)$/ }).click()
    await win.waitForSelector('[data-image-studio-chat] textarea')
    check('Native chat fills its panel', await win.locator('[data-image-studio-chat] .t2-chat-view').evaluate(el => el.getBoundingClientRect().height > 400))
    stub.script([
      { type: 'tool_call', payload: { id: 'generate-test', name: 'generate_image', arguments: JSON.stringify({ prompt: 'Autumn art poster', size: '1:1', n: 1 }) } },
      { type: 'display_file', payload: { name: 'generated.png', mime: 'image/png', dataUrl: fixtures[0] }, delay: 1200 },
      { type: 'tool_result', payload: { id: 'generate-test', name: 'generate_image', result: 'Image displayed.', isError: false } },
      { type: 'token', payload: { text: 'Here is your image.' } },
    ])
    const composer = win.locator('[data-image-studio-chat] textarea').first()
    await composer.fill('Generate an autumn art poster.'); await composer.press('Enter')
    await win.waitForSelector('.ims-generation')
    check('Chat generation reserves its final canvas shape before pixels arrive', await win.locator('.ims-generation').count() === 1 && await win.locator('.ims-image').count() === 2)
    await win.waitForFunction(() => document.querySelectorAll('.ims-image').length === 3, { timeout: 30000 })
    check('The completed chat image replaces its placeholder', await win.locator('.ims-generation').count() === 0)
    check('Generated output lands on the project canvas through native chat SSE', stub.seen.runs.length === 1 && stub.seen.runs[0].sessionId !== 'unrelated')
    await win.locator('.ims-image').first().dblclick()
    await win.locator('.ims-inspector').getByRole('button', { name: /^(添加到对话|Add to chat)$/ }).click()
    await win.waitForSelector('[data-image-studio-chat] .attach-chip')
    check('Selected image is attached to its own project composer', await win.locator('[data-image-studio-chat] .attach-chip').count() > 0)
    const inspector = win.locator('.ims-inspector')
    // 对话与属性是右栏的两个标签:「添加到对话」把对话带到了前面,回属性要点一下。
    check('Adding to the chat brings the chat tab forward in the shared right side', await sideOf('[data-image-studio-chat]') === 'right' && !await inspector.isVisible())
    await win.locator('.ims-toolbar').getByRole('button', { name: /^(属性与调整|Properties and adjustments)$/ }).click()
    await inspector.getByRole('button', { name: /^(裁切|Crop)$/ }).click()
    await inspector.getByRole('combobox', { name: /^(裁切比例|Crop ratio)$/ }).selectOption({ label: '16:9' })
    await inspector.getByRole('button', { name: /^(应用裁切|Apply crop)$/ }).click()
    const cropped = await first.boundingBox()
    check('Crop preserves original bytes and changes the visible aspect ratio', Math.abs(cropped.width / cropped.height - 16 / 9) < .02 && Number(await first.locator('.ims-raster').first().getAttribute('data-original-width')) === 800)
    await inspector.getByRole('button', { name: /^(顺时针旋转 90°|Rotate 90° clockwise)$/ }).click()
    await inspector.getByRole('button', { name: /^(水平翻转|Flip horizontally)$/ }).click()
    check('Rotation and flip are visible non-destructive transforms', (await first.locator('.ims-raster > g').getAttribute('transform')).includes('rotate(90) scale(-1 1)'))
    await inspector.getByRole('button', { name: /^(导出 PNG|Export PNG)$/ }).click()
    const cropFile = await waitDownload()
    const cropSize = await app.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), cropFile)
    check('Cropped rotated PNG has the exact output dimensions', cropSize.width === 450 && cropSize.height === 800)
    await inspector.getByRole('button', { name: /^(还原裁切与变换|Reset crop and transform)$/ }).click()
    check('Reset transform recovers the original dimensions', Math.abs((await first.boundingBox()).width / (await first.boundingBox()).height - .8) < .02)

    await first.click(); await win.locator('.ims-image').nth(1).click({ modifiers: ['Shift'] })
    await win.locator('.ims-toolbar').getByRole('button', { name: /^(添加到对话|Add to chat)$/ }).click()
    await win.waitForFunction(() => document.querySelectorAll('[data-image-studio-chat] .attach-chip').length === 3)
    check('Multiple references enter the existing project composer together', await win.locator('[data-image-studio-chat] .attach-chip').count() === 3)

    await win.getByRole('button', { name: /^(添加文字|Add text)$/ }).click()
    await inspector.getByRole('textbox', { name: /^(文字内容|Text content)$/ }).fill('AUTUMN / 2026\nRoom to imagine.')
    const fontSize = inspector.getByRole('spinbutton', { name: /^(字号|Font size)$/ })
    await fontSize.fill('48'); await fontSize.press('Tab')
    check('Text is an editable vector layer with real typography', (await win.locator('.ims-text text').textContent()).includes('AUTUMN') && await win.locator('.ims-text text').getAttribute('font-size') === '48')
    await win.getByRole('button', { name: /^(添加矩形|Add rectangle)$/ }).click()
    await inspector.locator('input[type="color"]').first().fill('#c8d2be')
    check('Shape fill updates the actual vector artwork', await win.locator('.ims-rectangle rect').getAttribute('fill') === '#c8d2be')
    const shapeId = await win.locator('.ims-rectangle').getAttribute('data-image-id')
    await win.locator('.ims-toolbar').getByRole('button', { name: /^(图层|Layers)$/ }).click()
    const layerRow = win.locator(`[data-layer-id="${shapeId}"]`)
    await layerRow.getByRole('button', { name: /^(隐藏图层|Hide layer)$/ }).click()
    check('Hiding a layer removes it from the scene without deleting its row', await win.locator('.ims-rectangle').count() === 0 && await layerRow.count() === 1)
    await layerRow.getByRole('button', { name: /^(显示图层|Show layer)$/ }).click()
    await layerRow.getByRole('button', { name: /^(锁定图层|Lock layer)$/ }).click()
    const lockedBefore = await win.locator('.ims-rectangle').getAttribute('style')
    await win.locator('.ims-stage').focus(); await win.keyboard.press('Delete')
    check('Locked layers survive the native Delete shortcut', await win.locator('.ims-rectangle').getAttribute('style') === lockedBefore)
    await layerRow.getByRole('button', { name: /^(解锁图层|Unlock layer)$/ }).click()

    await win.getByRole('button', { name: /^(添加画板|Add artboard)$/ }).click()
    await inspector.getByRole('combobox', { name: /^(画板尺寸|Artboard size)$/ }).selectOption('1080x1080')
    // Fit existing artwork inside a precisely positioned artboard through the native inspector.
    for (const [label, value] of [[/^(X 坐标|X position)$/, '-50'], [/^(Y 坐标|Y position)$/, '-50']]) {
      const input = inspector.getByRole('spinbutton', { name: label }); await input.fill(value); await input.press('Tab')
    }
    const frameId = await win.locator('.ims-frame').getAttribute('data-image-id')
    check('Artboard remains behind image, text and shape layers', await win.locator('.ims-world > .ims-layer').first().getAttribute('data-image-id') === frameId)
    const textId = await win.locator('.ims-text').getAttribute('data-image-id')
    const photoIds = await win.locator('.ims-image').evaluateAll(els => els.map(el => el.dataset.imageId))
    const pickLayer = async id => {
      await win.locator('.ims-toolbar').getByRole('button', { name: /^(图层|Layers)$/ }).click()
      await win.locator(`[data-layer-id="${id}"] .ims-asset`).click()
      await win.locator('.ims-toolbar').getByRole('button', { name: /^(属性与调整|Properties and adjustments)$/ }).click()
    }
    const positionLayer = async (id, values) => {
      await pickLayer(id)
      const names = [/^(X 坐标|X position)$/, /^(Y 坐标|Y position)$/, /^(宽度|Width)$/, /^(高度|Height)$/]
      for (let index = 0; index < values.length; index++) {
        const input = inspector.getByRole('spinbutton', { name: names[index] }); await input.fill(String(values[index])); await input.press('Tab')
      }
    }
    await positionLayer(textId, [30, 20, 920, 140])
    await inspector.getByRole('textbox', { name: /^(文字内容|Text content)$/ }).fill('Room to imagine.\nAUTUMN / 2026')
    await positionLayer(photoIds[0], [30, 190, 400])
    await positionLayer(photoIds[1], [550, 190, 400])
    await inspector.getByRole('button', { name: /^(水平翻转|Flip horizontally)$/ }).click()
    await positionLayer(photoIds[2], [1210, 190, 288])
    await positionLayer(shapeId, [-10, 160, 1000, 640])
    for (let index = 0; index < 4; index++) await inspector.getByRole('button', { name: /^(下移一层|Send backward)$/ }).click()
    check('Layer ordering moves the shape behind the other artwork', await win.locator('.ims-world > .ims-layer').nth(1).getAttribute('data-image-id') === shapeId)
    await pickLayer(frameId)
    await win.getByTitle(/^(适应内容|Fit to content)$/).click()
    const frameBox = await win.locator('.ims-frame').boundingBox(), firstStyle = await first.getAttribute('style')
    const imageBeforeMove = await first.boundingBox()
    // Artboard blank corner is a real draggable surface; its contents follow during the gesture.
    const dragX = frameBox.x + frameBox.width - 12, dragY = frameBox.y + 12
    check('Frame drag targets its exposed native surface', await win.evaluate(({ x, y, id }) => document.elementFromPoint(x, y)?.closest('[data-image-id]')?.getAttribute('data-image-id') === id, { x: dragX, y: dragY, id: frameId }))
    await win.mouse.move(dragX, dragY); await win.mouse.down(); await win.mouse.move(dragX + 50, dragY + 40, { steps: 8 })
    const duringMove = await first.boundingBox()
    check('Frame contents follow the native drag before pointer release', duringMove.x > imageBeforeMove.x + 30 && duringMove.y > imageBeforeMove.y + 20)
    await win.mouse.up()
    await win.getByRole('button', { name: /^(撤销|Undo)$/ }).click()
    check('A frame drag and all carried content undo as one edit', await first.getAttribute('style') === firstStyle)
    await pickLayer(frameId)
    await win.getByRole('button', { name: /^(导出作品|Export artwork)$/ }).click()
    const panel = win.locator('.ims-export')
    check('Artboard export uses its explicit pixel bounds', (await panel.textContent()).includes('1080 × 1080'))
    await panel.getByRole('combobox', { name: /^(格式|Format)$/ }).selectOption('jpeg')
    await panel.getByRole('button', { name: /^(下载|Download)$/ }).click()
    const jpg = await waitDownload()
    const jpgSize = await app.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), jpg)
    check('JPEG is a decodable image with the artboard dimensions', fs.readFileSync(jpg)[0] === 255 && jpgSize.width === 1080 && jpgSize.height === 1080)
    fs.copyFileSync(jpg, path.join(OUT, 'artboard.jpg'))
    await panel.getByRole('combobox', { name: /^(格式|Format)$/ }).selectOption('svg')
    await panel.getByRole('button', { name: /^(下载|Download)$/ }).click()
    const svgFile = await waitDownload(), svg = fs.readFileSync(svgFile, 'utf8')
    check('SVG retains text, vector shapes and embedded image pixels', svg.includes('<text') && svg.includes('<rect') && svg.includes('data:image/png;base64,'))
    fs.copyFileSync(svgFile, path.join(OUT, 'artboard.svg'))
    await panel.getByRole('combobox', { name: /^(格式|Format)$/ }).selectOption('webp')
    await panel.getByRole('button', { name: /^(下载|Download)$/ }).click()
    const webpFile = await waitDownload()
    check('WebP export has a genuine WebP payload', fs.readFileSync(webpFile).subarray(8, 12).toString() === 'WEBP')
    await panel.getByRole('button', { name: /^(关闭|Close)$/ }).click()
    await win.getByRole('button', { name: /^(下载项目|Download project)$/ }).click()
    const mixedFile = await waitDownload(), mixed = JSON.parse(fs.readFileSync(mixedFile, 'utf8'))
    check('Portable v2 project preserves mixed objects and layer order', mixed.version === 2 && mixed.elements.length === 3 && mixed.order.length === 6 && mixed.images.length === 3)
    await toProjects()
    await win.locator('.ims-launch input[type="file"][accept=".json"]').setInputFiles(mixedFile)
    await win.waitForSelector('.ims-text')
    check('Mixed project import restores editable text, shapes and image transforms', await win.locator('.ims-text').count() === 1 && await win.locator('.ims-rectangle').count() === 1 && (await win.locator('.ims-image').nth(1).locator('.ims-raster > g').getAttribute('transform')).includes('scale(-1 1)'))
    // Imported projects deliberately do not borrow the original chat session.
    await openProjectId(mixed.id)
    await pickLayer(textId)
    await win.locator('.ims-stage').focus(); await win.keyboard.press('Meta+c')
    await toProjects(); await newProject()
    await win.locator('.ims-stage').focus(); await win.keyboard.press('Meta+v')
    check('Native canvas clipboard can reuse objects in another project', await win.locator('.ims-text').count() === 1 && await win.locator('.ims-image').count() === 0)
    await openProjectId(mixed.id)
    await pickLayer(textId)
    await inspector.getByRole('textbox', { name: /^(图层名称|Layer name)$/ }).fill('Exhibition headline')
    await win.getByTitle(/^(适应内容|Fit to content)$/).click()
    await screenshot('editing-properties')
    await mode('dark'); await screenshot('workspace-dark')
    await mode('light')
    await screenshot('workspace-light')
    await win.locator('.ims-footer input').fill('Persisted project')
    await win.waitForFunction(() => /Saved on this device|自动保存在此设备/.test(document.querySelector('.ims-footer').textContent))
    await win.reload(); await openStudio(); await win.waitForSelector('.ims-image:nth-child(3)', { timeout: 45000 })
    check('Reload restores persisted blobs, layout and adjustments', (await win.locator('.ims-image .ims-raster').first().getAttribute('style')).includes('brightness(120%)'))
    await app.close()
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, timeout: 45000 })
    win = await app.firstWindow(); win.setDefaultTimeout(15000); win.on('pageerror', e => errors.push(e.message))
    // The application starts at its configured home; the named Image Studio layout must survive.
    await openStudio()
    await win.waitForSelector('.ims-image:nth-child(3)', { timeout: 45000 })
    check('Mixed objects survive a complete restart', await win.locator('.ims-text').count() === 1 && await win.locator('.ims-frame').count() === 1 && await win.locator('.ims-rectangle').count() === 1)
    check('Full Electron restart preserves the project and native Space layout', await win.locator('.ims-footer input').inputValue() === 'Persisted project')
    check('After a restart the project is still laid out with Layers on the left and the chat on the right', await eventually('restart layout', async () => ({ leftTabs: await win.locator('.wb-tab--left').count() === 2, layers: await sideOf('.ims-layers') === 'left', right: await rightOpen(), rightTabs: await win.locator('.wb-tab--icon:not(.wb-tab--left)').count() === 2 })))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760))
    await screenshot('narrow')
    check('Narrow main View has no horizontal overflow', await win.locator('.ims').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    // AI actions must send source pixels to the project session, not just prepare a draft.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 980))
    await pickLayer(photoIds[0])
    const ai = win.locator('.ims-ai')
    check('AI edit requires an instruction before sending', await ai.getByRole('button', { name: /^(生成新版本|Create new version)$/ }).isDisabled())
    check('AI edit defaults to the selected image ratio', await ai.getByRole('combobox', { name: /^(结果比例|Output ratio)$/ }).inputValue() === 'original')
    check('AI edit can choose the untouched original file', await ai.getByRole('combobox', { name: /^(输入内容|Source content)$/ }).locator('option[value="original"]').count() === 1)
    await ai.getByRole('combobox', { name: /^(输入内容|Source content)$/ }).selectOption('original')
    await ai.getByRole('textbox').fill('Change only the background to teal.')
    stub.script([
      { type: 'tool_call', payload: { id: 'edit-test', name: 'edit_image', arguments: JSON.stringify({ size: '2:3', n: 1 }) } },
      { type: 'display_file', payload: { name: 'edited.png', mime: 'image/png', dataUrl: fixtures[1] }, delay: 3500 },
      { type: 'tool_result', payload: { id: 'edit-test', name: 'edit_image', result: 'Edited image displayed.', isError: false } },
    ])
    const editingRequest = win.waitForRequest(req => req.url().endsWith('/agent/runs') && req.method() === 'POST')
    await ai.getByRole('button', { name: /^(生成新版本|Create new version)$/ }).click()
    const slot = win.locator('.ims-generation').last()
    await slot.waitFor({ state: 'visible' })
    const reserved = await slot.evaluate(el => ({ left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }))
    check('AI edit shows an adjacent placeholder before the run is accepted', await win.locator('.ims-generation').count() === 1)
    check('AI edit keeps its form in front instead of flipping the right side to the chat', await ai.isVisible())
    await screenshot('ai-edit-placeholder')
    const editingBody = (await editingRequest).postDataJSON()
    check('AI edit sends real reference pixels to its own project session', editingBody.session_id === stub.seen.runs[0].sessionId && editingBody.attachments.length === 1 && editingBody.attachments[0].data.startsWith('iVBOR'))
    check('AI edit tells the model to use original parameters and preserve the target crop', /原始文件|original file/i.test(editingBody.message) && /4:5/.test(editingBody.message))
    const sourcePixel = await app.evaluate(({ nativeImage }, data) => [...nativeImage.createFromDataURL(`data:image/png;base64,${data}`).toBitmap().subarray(0, 4)], editingBody.attachments[0].data)
    check('Original-file mode ignores the visible brightness adjustment', Math.max(...sourcePixel.slice(0, 3)) < 250)
    await win.waitForFunction(() => document.querySelectorAll('.ims-image').length === 4)
    check('AI result is added as a new version without replacing its source', await win.locator(`[data-image-id="${photoIds[0]}"]`).count() === 1)
    const landed = await win.locator('.ims-image').last().evaluate(el => ({ left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }))
    check('AI result replaces the exact reserved canvas slot', JSON.stringify(landed) === JSON.stringify(reserved))
    await win.locator('.ims-image').last().dblclick()
    check('Generated versions keep a navigable link to their source', await win.locator('.ims-inspector .ims-lineage').isVisible())
    await screenshot('ai-edit-light')
    await mode('dark'); await screenshot('ai-edit-dark')

    await ai.getByRole('textbox').fill('Create a failed version for the error-state test.')
    stub.script([
      { type: 'tool_call', payload: { id: 'edit-failed', name: 'edit_image', arguments: JSON.stringify({ size: '2:3', n: 1 }) } },
      { type: 'tool_result', payload: { id: 'edit-failed', name: 'edit_image', result: 'Error: scripted image failure', isError: false }, delay: 250 },
    ])
    await ai.getByRole('button', { name: /^(生成新版本|Create new version)$/ }).click()
    await win.waitForSelector('.ims-generation.is-failed')
    check('A failed tool call owns exactly one placeholder', await win.locator('.ims-generation.is-failed').count() === 1)
    check('Failed image jobs stay visible with contextual recovery actions', await win.getByRole('button', { name: /^(查看对话|Open chat)$/ }).isVisible())
    await win.getByRole('button', { name: /^(移除占位|Remove placeholder)$/ }).click()
    await win.waitForFunction(() => document.querySelectorAll('.ims-generation').length === 0)
    check('Failed placeholders can be dismissed without changing artwork', await win.locator('.ims-image').count() === 4)

    // Upgrade path: layouts saved before "project + detail" kept the chat pinned on the left. Rewrite the layouts on disk
    // into that old panel set (same schema), take the one-time flag away and load the page again: the Space has to be
    // rebuilt in the new arrangement. Restoring the old one would leave the chat on the left for good, because a
    // singleton is reused wherever it already sits.
    await toProjects(); await rightSettles(false)
    await win.waitForTimeout(1200) // the layout save is debounced
    await win.addInitScript(() => {
      if (sessionStorage.getItem('ims-old-layout') !== null) return
      let rewritten = 0
      for (const key of Object.keys(localStorage)) {
        const value = localStorage.getItem(key)
        if (!value || !value.includes('image-studio-nav')) continue
        localStorage.setItem(key, value.replaceAll('image-studio-chat', 'image-studio-assets').replaceAll('image-studio-nav', 'image-studio-chat')); rewritten++
      }
      localStorage.removeItem('forsion_image_studio_layout_v2')
      sessionStorage.setItem('ims-old-layout', String(rewritten))
    })
    await win.reload(); await openStudio(); await win.waitForSelector('.ims-launch')
    check('The upgrade check really planted a layout from the old arrangement', Number(await win.evaluate(() => sessionStorage.getItem('ims-old-layout'))) > 0)
    check('A layout saved by the old arrangement is rebuilt once instead of restored', await eventually('upgrade', async () => ({ nav: await sideOf('.ims-nav') === 'left', leftTabs: await win.locator('.wb-tab--left').count() === 1, rightFolded: !await rightOpen(), flag: await win.evaluate(() => localStorage.getItem('forsion_image_studio_layout_v2')) === '1' })))
    await win.locator('.ims-launch-card').first().click(); await win.waitForSelector('.ims'); await rightSettles(true)
    check('After the upgrade the chat opens on the right and Layers beside the navigation', await eventually('upgrade, project open', async () => ({ layers: await sideOf('.ims-layers') === 'left', chat: await sideOf('[data-image-studio-chat], .ims-chat-empty') === 'right', leftTabs: await win.locator('.wb-tab--left').count() === 2 })))
    check('No renderer exceptions', errors.length === 0)
  } catch (error) {
    failed = true
    if (win) { await screenshot('failure').catch(() => {}); fs.writeFileSync(path.join(OUT, 'failure.txt'), await win.locator('body').innerText().catch(() => '')) }
    throw error
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ home, results, errors }, null, 2))
    if (app) await app.close()
    await stub.close()
    if (!failed) fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
