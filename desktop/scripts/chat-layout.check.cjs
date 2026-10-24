/** Chat View 窄栏回归：真 Electron / 真 ChatView、引擎与 Agent 选择、草稿增高、zoom、中英与明暗。
 * npm run build && npm run check:chatlayout
 * 使用临时 userData / TANGU_HOME / Vault 与假后端，不读写用户会话和笔记。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const APP_ROOT = process.env.FORSION_APP_ROOT || ROOT
const agents = Array.from({ length: 28 }, (_, i) => ({
  slug: i ? `agent-${i}` : 'xyra', name: i ? `Research assistant ${i}` : 'Xyra',
  description: i ? 'Analyze project files and explain the results' : 'General assistant',
  createdBy: 'user',
}))
const engines = ['claude', 'codex', 'gemini'].map((id) => ({ id, name: id, available: true }))
let checks = 0
function check(name, ok, detail) {
  assert.ok(ok, `${name}: ${JSON.stringify(detail)}`)
  console.log(`PASS ${name}`)
  checks++
}

async function main() {
  assert.ok(fs.existsSync(path.join(APP_ROOT, 'out/main/main.js')), '先运行 npm run build')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-layout-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(userdata)
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, 'Layout.md'), '# Layout verification\n')
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine({ agents, engines, override: ({ path: p, method }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
  } })
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', APP_ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1050))
    await win.waitForSelector('#root')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.locator(`button:text-is("${label}")`).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    const view = win.locator('.t2-chat-view').first()
    await view.waitFor({ timeout: 30000 })
    await view.locator('.agent-select-strip .agent-pill').first().waitFor({ state: 'attached', timeout: 30000 })
    // 真 Electron 会沿用系统指针位置；缩宽恰好把 pill 移到指针下时会展开名称，改变内容宽度。
    await win.mouse.move(1, 1)
    await win.waitForTimeout(700)
    check('未开始的新会话不挂载 Agent Desk 卡片与侧板', await view.locator('.agent-desk-card, .agent-desk').count() === 0)

    const resize = async (width, height, zoom = 1) => {
      await view.evaluate((el, size) => {
        el.style.flex = 'none'
        el.style.width = `${size.width}px`
        el.style.height = `${size.height}px`
        el.style.zoom = String(size.zoom)
      }, { width, height, zoom })
      await win.waitForTimeout(180)
    }
    const geometry = () => view.evaluate((el) => {
      const col = el.querySelector('.t2-chat-col')
      const empty = col.querySelector(':scope > .t2-empty')
      const composer = col.querySelector(':scope > .composer-anchor')
      const rect = (node) => {
        const r = node.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
      }
      return {
        col: rect(col), empty: rect(empty), composer: rect(composer),
        logo: rect(empty.querySelector('.t2-empty-mark') || empty),
        input: rect(composer.querySelector('.t2c-inner')),
        emptyVisible: getComputedStyle(empty).visibility !== 'hidden',
        density: empty.dataset.density, zoom: el.currentCSSZoom || 1,
        composerMeasured: parseFloat(getComputedStyle(col).getPropertyValue('--t2-composer-h')),
        streamPadding: parseFloat(getComputedStyle(col.querySelector('.t2-stream-inner')).paddingBottom),
        controls: [...el.querySelectorAll('.compact-chat-picker, .t2c-send, .t2c-stop, .t2c-row > *')]
          .filter((node) => node.getClientRects().length).map(rect),
        compact: [...el.querySelectorAll('.compact-chat-picker')].filter((node) => node.getClientRects().length).map(rect),
      }
    })
    const safe = async (name) => {
      const g = await geometry()
      check(`${name}: 欢迎区与输入区不重叠`, !g.emptyVisible || g.empty.bottom + 23 * g.zoom <= g.composer.top, g)
      check(`${name}: 控件不超出聊天列`, g.controls.every((r) => r.left >= g.col.left - 1 && r.right <= g.col.right + 1), g)
      check(`${name}: 高度测量不重复缩放`, Math.abs(g.composerMeasured * g.zoom - g.composer.height) < 2, g)
      check(`${name}: 消息流保留输入区高度`, g.streamPadding * g.zoom >= g.composer.height, g)
      check(`${name}: Logo 与输入框同轴居中`, !g.emptyVisible || Math.abs((g.logo.left + g.logo.right - g.input.left - g.input.right) / 2) < 2, g)
      return g
    }

    await resize(800, 820)
    const wide = await safe('宽栏')
    check('宽栏仍在 View 中心', wide.emptyVisible && Math.abs((wide.empty.top + wide.empty.bottom - wide.col.top - wide.col.bottom) / 2) < 2, wide)
    check('宽栏保留胶囊', wide.compact.length === 0, wide)
    const more = await view.locator('.agent-select-strip').evaluate((el) => {
      const scroll = el.querySelector('.engine-picker-scroll')
      const button = el.querySelector('.engine-picker-more')
      scroll.scrollLeft = scroll.scrollWidth
      return { scrollRight: scroll.getBoundingClientRect().right, moreLeft: button?.getBoundingClientRect().left }
    })
    check('更多按钮不盖住选项', more.moreLeft >= more.scrollRight, more)
    const fitsWidth = await view.locator('.agent-select-strip .engine-picker-scroll').evaluate((el) => el.scrollWidth + 16)
    await resize(fitsWidth, 820)
    const fit = await view.locator('.agent-select-strip .engine-picker-scroll').evaluate((el) => ({
      content: el.scrollWidth, viewport: el.clientWidth, bar: el.parentElement.clientWidth,
      col: el.closest('.t2-chat-col').clientWidth, padding: getComputedStyle(el.parentElement).padding,
    }))
    // Composer has a reading-width cap: expanding the column does not necessarily expand its option bar.
    // Judge overflow against the actual scroll viewport, not the outer column width.
    check('加宽后更多按钮与实际溢出一致（包含输入区宽度上限）',
      (await view.locator('.agent-select-strip .engine-picker-more').count() > 0) === (fit.content > fit.viewport + 1), { fitsWidth, ...fit })

    await resize(420, 720)
    const narrow = await safe('窄栏')
    // 轨道方案 §4:引擎选择器并入 Agent 选择条,窄栏因此只剩**一个**带名称的入口(原来是引擎 + Agent 两个)。
    check('窄栏折叠成单个带名称的入口', narrow.compact.length === 1, narrow)
    // 窄栏芯片点开 = 自绘浮层(方案页 docs/ToBeImproved/窄栏Agent选择器方案_2026-10-23,B+C):行只放名字,简介在底部说明区。
    const chip = view.locator('.agent-select-strip .compact-chat-picker')
    const pop = win.locator('.chat-pick-pop')
    const row = (id) => win.locator(`.chat-pick-row[data-pick-id="${id}"]`)
    const picks = () => view.locator('.agent-select-strip .agent-pill[aria-pressed="true"]').evaluateAll(
      (els) => els.map((el) => el.dataset.engineId || `agent:${el.dataset.agentSlug}`))
    await chip.click()
    await pop.waitFor()
    const rowText = await row('agent:agent-17').locator('.chat-pick-name').textContent()
    check('浮层行只放名字,不带简介', rowText === agents[17].name && !(await row('agent:agent-17').textContent()).includes(agents[17].description), rowText)
    await row('agent:agent-17').hover()
    check('悬停行时说明区显示它的简介', (await pop.locator('.chat-pick-desc').textContent()).includes(agents[17].description))
    await row('agent:agent-17').click()
    await win.waitForTimeout(150)
    check('点 Agent 后浮层不收(好接着组队)', await pop.isVisible())
    check('选择 Agent 更新当前名称', (await view.locator('.agent-select-strip .compact-chat-picker-name').textContent()) === agents[17].name)
    check('单选打勾', await row('agent:agent-17').locator('.chat-pick-check').count() === 1)
    await row('agent:agent-3').click()
    await win.waitForTimeout(150)
    const idx = (await pop.locator('.chat-pick-row .chat-pick-index').evaluateAll((els) => els.map((el) => `${el.closest('[data-pick-id]').dataset.pickId}=${el.textContent}`)))
      .sort((x, y) => x.split('=')[1] - y.split('=')[1])
    check('两人 = 团队,序号按点选顺序', idx.join(',') === 'agent:agent-17=1,agent:agent-3=2', idx.join(','))
    check('团队芯片:前缀换成团队、名字串两人', /团队|Team/.test(await chip.locator('.compact-chat-picker-kind').textContent())
      && (await chip.locator('.compact-chat-picker-name').textContent()).includes(agents[3].name))
    check('团队写进选中集', (await picks()).join(',') === 'agent:agent-17,agent:agent-3', (await picks()).join(','))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    check('Esc 收起浮层', (await pop.count()) === 0)
    await chip.click()
    await row('engine:codex').click()
    await win.waitForTimeout(150)
    // 「外部引擎与 Agent 互斥」的老意图:以前靠整条 Agent 选择器消失,现在靠选中集只剩引擎那一枚。
    const enginePicked = await picks()
    check('选外部引擎即清空 Agent(单选互斥)', enginePicked.length === 1 && enginePicked[0] === 'codex', enginePicked.join(','))
    check('选引擎后浮层收起', (await pop.count()) === 0)
    await view.locator('.agent-select-strip .agent-pill[data-agent-slug="xyra"]:not([disabled])').waitFor({ state: 'attached', timeout: 30000 })
    await chip.click()
    await row('agent:xyra').click()
    await win.waitForTimeout(150)
    const agentPicked = await picks()
    check('再选 Agent 即退掉外部引擎', agentPicked.length === 1 && agentPicked[0] === 'agent:xyra', agentPicked.join(','))
    await row('').click()
    await win.waitForTimeout(150)
    check('默认 Agent = 清空并收起', (await picks()).length === 0 && (await pop.count()) === 0)
    // 触屏 = 贴底抽屉:Electron 里假装 pointer: coarse
    await win.evaluate(() => {
      const real = window.matchMedia.bind(window)
      window.__realMatchMedia = real
      window.matchMedia = (q) => (q.includes('pointer: coarse') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q))
    })
    await chip.click()
    await win.locator('.chat-pick-sheet').waitFor()
    check('触屏打开贴底抽屉而不是浮层', (await pop.count()) === 0)
    await win.locator('.chat-pick-sheet .chat-pick-row[data-pick-id="agent:agent-3"]').dispatchEvent('contextmenu')
    check('抽屉长按 = 简介 + 私聊卡片', (await win.locator('.chat-pick-held').textContent()).includes(agents[3].description))
    await win.locator('.chat-pick-scrim').click({ position: { x: 10, y: 10 } })
    await win.evaluate(() => { window.matchMedia = window.__realMatchMedia })
    check('点遮罩收起抽屉', (await win.locator('.chat-pick-sheet').count()) === 0)
    await view.screenshot({ path: path.join(home, 'narrow.png') })

    await resize(320, 620)
    const small = await safe('极窄栏')
    check('极窄栏仍只有一个入口且不出列', small.compact.length === 1 && small.compact[0].right <= small.col.right + 1, small)
    await view.screenshot({ path: path.join(home, 'small.png') })
    await resize(420, 360)
    await safe('矮窗口')
    await view.locator('.t2c-ta').fill('A draft with multiple lines\n'.repeat(8))
    await win.waitForTimeout(120)
    await safe('多行草稿')
    await view.locator('.t2c-ta').fill('')
    await resize(420, 720, 1.25)
    await safe('界面缩放 125%')
    await resize(420, 720)
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换明暗模式')
    await win.locator('.cmd-item', { hasText: '切换明暗模式' }).click()
    await win.waitForTimeout(400)
    await view.screenshot({ path: path.join(home, 'narrow-dark.png') })
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换语言')
    await win.locator('.cmd-item', { hasText: '切换语言' }).click()
    await win.waitForTimeout(180)
    await resize(420, 720)
    await safe('英文窄栏')
    check('英文选择条已翻译', await view.locator('.agent-select-strip').getAttribute('aria-label') === 'Pick agents')
    await view.screenshot({ path: path.join(home, 'narrow-en.png') })

    await win.evaluate(() => window.tangu.openMini({}))
    let mini
    for (let i = 0; i < 100 && !mini; i++) {
      mini = app.windows().find((page) => page.url().includes('window=mini'))
      if (!mini) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(mini, 'Mini window did not open')
    await mini.locator('.t2-chat-col > .t2-empty').waitFor({ state: 'attached', timeout: 30000 })
    await mini.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 10000 })
    await mini.waitForTimeout(200)
    const miniGeometry = await mini.locator('.t2-chat-col').evaluate((col) => {
      const empty = col.querySelector(':scope > .t2-empty')
      const composer = col.querySelector(':scope > .composer-anchor')
      return { visible: getComputedStyle(empty).visibility !== 'hidden', bottom: empty.getBoundingClientRect().bottom, top: composer.getBoundingClientRect().top,
        colHeight: col.clientHeight, colTop: col.getBoundingClientRect().top, composerHeight: composer.offsetHeight, composerTop: composer.offsetTop,
        emptyHeight: empty.offsetHeight, emptyTop: empty.offsetTop, inline: empty.style.cssText, density: empty.dataset.density }
    })
    await mini.screenshot({ path: path.join(home, 'mini.png') })
    check('Mini 卡片欢迎区可读且不重叠', miniGeometry.visible && miniGeometry.bottom <= miniGeometry.top - 23, miniGeometry)

    // 已有空会话也有任务概览；与新会话不同，它会占用右侧车道。
    // 经真实侧栏打开，防止只测「没有卡片的新会话」漏掉欢迎区偏右。
    stub.state.sessions = [{ id: 'empty-with-summary', title: 'Empty with task summary', archived: false,
      model_id: 'm1', created_at: '2026-09-17 00:00:00', updated_at: '2026-09-17 00:00:00',
      projectless: false, project_path: vault, project_name: 'Layout',
      agent_config: { execMode: 'host', cwd: vault, agentSlug: 'xyra' } }]
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Empty with task summary' }).first().click()
    await view.locator('.t2-empty-mark').waitFor()
    await resize(1000, 820)
    await win.waitForTimeout(550)
    check('已有空会话显示任务概览', await view.locator('.t2-tsum.show').isVisible())
    check('已有 ID 但未发消息的会话也不挂载 Agent Desk', await view.locator('.agent-desk-card, .agent-desk').count() === 0)
    await view.screenshot({ path: path.join(home, 'empty-summary.png') })
    await safe('任务概览在场')
    for (const width of [760, 759, 620]) {
      await resize(width, 720)
      await win.waitForTimeout(550)
      check(`${width}px: 任务概览按阈值显示`, await view.locator('.t2-tsum.show').isVisible() === (width >= 760))
      await safe(`${width}px 任务概览响应式`)
    }
    await resize(1000, 640, 1.25)
    await win.waitForTimeout(550)
    await safe('任务概览与 125% 缩放')
    await resize(1000, 820)
    await win.waitForTimeout(550)
    // 卡片内容出现/消失时，两条中线在整个让位动画中都要重合。
    const shifts = await view.evaluate(async (el) => {
      const card = el.querySelector('.t2-tsum')
      const logo = el.querySelector('.t2-empty-mark')
      const input = el.querySelector('.t2c-inner')
      const errors = []
      for (const show of [false, true]) {
        card.classList.toggle('show', show)
        const start = performance.now()
        while (performance.now() - start < 550) {
          await new Promise(requestAnimationFrame)
          const a = logo.getBoundingClientRect(), b = input.getBoundingClientRect()
          errors.push(Math.abs((a.left + a.right - b.left - b.right) / 2))
        }
      }
      return { frames: errors.length, maxOffset: Math.max(...errors) }
    })
    check('任务概览进出动画中 Logo 与输入框同步', shifts.frames > 2 && shifts.maxOffset < 2, shifts)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await safe('减少动态效果')

    // 真正发送首条消息后才上场;零条目仍保留卡片。回到草稿必须卸载,再次打开历史后恢复。
    await view.locator('.t2c-ta').fill('Start the session')
    await view.locator('.t2c-ta').press('Enter')
    await view.locator('.agent-desk-card[data-desk-session="empty-with-summary"]').waitFor({ state: 'visible' })
    check('首条消息发出后 Agent Desk 卡片显示', await view.locator('.agent-desk-card').isVisible())
    await view.screenshot({ path: path.join(home, 'started-desk.png') })
    await win.locator('button[data-act="new-chat"]').first().click()
    await view.locator('.t2-empty-mark').waitFor()
    check('重新新建会话卸载 Agent Desk', await view.locator('.agent-desk-card, .agent-desk').count() === 0)
    await view.screenshot({ path: path.join(home, 'new-session-no-desk.png') })
    stub.state.messages = [{ id: 'layout-first-message', role: 'user', content: 'Start the session', created_at: '2026-09-30 00:00:00' }]
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Empty with task summary' }).first().click()
    await view.locator('.agent-desk-card[data-desk-session="empty-with-summary"]').waitFor({ state: 'visible' })
    check('切回已开始的历史会话恢复 Agent Desk', await view.locator('.agent-desk-card').isVisible())
    console.log(`${checks}/${checks} passed; screenshots: ${home}`)
  } catch (error) {
    const win = app?.windows()[0]
    if (win) {
      await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
      console.error('Failure screenshot:', path.join(home, 'failure.png'))
      console.error((await win.locator('body').innerText().catch(() => '')).slice(0, 1600))
    }
    throw error
  } finally {
    await app?.close()
    await stub.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
