/** Chat View 窄栏回归：真 Electron / 真 ChatView、引擎与 Agent 选择(工具行里的收件人芯片,11-02 方案 A)、草稿增高、zoom、中英与明暗。
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
  const meta = { defaultSlug: 'xyra', order: [] }
  const stub = await startStubEngine({ agents, engines, override: async ({ path: p, method, body }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p === '/agent/agents-meta' && method === 'PUT') Object.assign(meta, await body())
    if (p === '/agent/agents-meta') return meta
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
    await view.locator('.t2c-row .agent-select-strip .compact-chat-picker').waitFor({ timeout: 30000 })
    // 真 Electron 会沿用系统指针位置；缩宽恰好把指针压在某个控件上会改变它的样子。
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

    // 收件人芯片(方案页 docs/ToBeImproved/主页生成式组件方案_2026-11-02/agent.html A):输入框上方那一行没了,芯片在工具行模式芯片右边,宽窄同一枚。
    const chip = view.locator('.agent-select-strip .compact-chat-picker')
    const chipName = () => chip.locator('.compact-chat-picker-name').textContent()
    // 收起时 OverlayAt 留一个淡出的替身(data-lcl-exit,同类名):只认活的那只
    const pop = win.locator('.chat-pick-pop:not([data-lcl-exit])')
    const search = pop.locator('.chat-pick-search input')
    const row = (id) => win.locator(`.chat-pick-pop:not([data-lcl-exit]) .chat-pick-row[data-pick-id="${id}"], .chat-pick-sheet .chat-pick-row[data-pick-id="${id}"]`)
    // 选中集 = 浮层里打勾 / 带序号的行(按序号排);调用时浮层须开着
    const picks = () => pop.locator('.chat-pick-row[aria-selected="true"]').evaluateAll((els) => els
      .map((el) => ({ id: el.dataset.pickId, at: Number(el.querySelector('.chat-pick-index')?.textContent || 0) }))
      .sort((x, y) => x.at - y.at).map((x) => x.id.replace(/^engine:/, '')))
    const openPop = async () => { if (!(await pop.count())) await chip.click(); await pop.waitFor() }

    await resize(800, 820)
    const wide = await safe('宽栏')
    // 10-25 起(freshLayout)空状态连同输入区整块居中,不再是空状态单独居中(这条断言当时没跟着改)
    check('宽栏空状态 + 输入区整块在 View 中心', wide.emptyVisible && Math.abs((wide.empty.top + wide.composer.bottom - wide.col.top - wide.col.bottom) / 2) < 2, wide)
    check('输入框上方不再有 Agent 那一行', await view.locator('.composer-anchor > .newchat-pickers, .engine-picker-bar').count() === 0)
    const placed = await view.locator('.t2c-row').evaluate((rowEl) => {
      const kids = [...rowEl.children]
      const at = (sel) => kids.findIndex((k) => k.matches(sel))
      const r = (sel) => rowEl.querySelector(sel)?.getBoundingClientRect()
      return { mode: at('.mode-pill-wrap'), agent: at('.agent-select-strip'), chip: r('.compact-chat-picker'), modeBtn: r('.mode-pill-btn') }
    })
    check('芯片在工具行里、紧挨模式芯片右边', placed.agent >= 0 && placed.agent === placed.mode + 1, placed)
    check('芯片最宽 160px、与模式芯片等高', placed.chip.width <= 160.5 && Math.abs(placed.chip.height - placed.modeBtn.height) <= 1, placed)
    check('没选人时芯片写默认 Agent 的名字', (await chipName()) === 'Xyra')
    check('宽栏只有一枚芯片', wide.compact.length === 1, wide)

    await chip.click()
    await pop.waitFor()
    const popBox = await pop.boundingBox()
    const chipBox = await chip.boundingBox()
    check('浮层朝上开、左缘对齐芯片', popBox.y + popBox.height <= chipBox.y + 1 && Math.abs(popBox.x - chipBox.x) <= 2, { popBox, chipBox })
    check('打开即聚焦搜索框', await search.evaluate((el) => document.activeElement === el))
    check('底部说明区默认是状态句', (await pop.locator('.chat-pick-desc').textContent()).includes('Xyra'))
    const rowText = await row('agent:agent-17').locator('.chat-pick-name').textContent()
    check('浮层行只放名字,不带简介', rowText === agents[17].name && !(await row('agent:agent-17').textContent()).includes(agents[17].description), rowText)
    check('默认 Agent 那一位带「默认」标', (await row('agent:xyra').textContent()).includes('默认'))
    const scroller = await pop.locator('.ctx-menu-scroll').evaluate((el) => ({
      h: el.clientHeight, sh: el.scrollHeight, row: el.querySelector('.chat-pick-row').getBoundingClientRect().height,
    }))
    check('最多显示 8 行,其余滚动', scroller.h <= scroller.row * 8 + 9 && scroller.sh > scroller.h, scroller)
    await row('agent:agent-17').hover()
    check('悬停行时说明区换成它的简介', (await pop.locator('.chat-pick-desc').textContent()).includes(agents[17].description))
    await search.fill('agent-17')
    check('搜索按 slug / 名字筛', (await pop.locator('.chat-pick-row').count()) === 1)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(150)
    check('↵ 选中命中的那位,浮层不收(好接着组队)', await pop.isVisible() && (await chipName()) === agents[17].name)
    check('单选打勾', await row('agent:agent-17').locator('.chat-pick-check').count() === 1)
    await search.fill('')
    await row('agent:agent-3').click()
    await win.waitForTimeout(150)
    check('两人 = 团队,序号按点选顺序', (await picks()).join(',') === 'agent:agent-17,agent:agent-3', (await picks()).join(','))
    check('团队芯片叠头像、写「X 等 N 位」', (await chipName()) === `${agents[17].name} 等 2 位` && await chip.locator('.chat-pick-stack > *').count() === 2, await chipName())
    check('模式芯片照旧写「团队」', /团队/.test(await view.locator('.mode-pill-btn .t2c-pill-label').textContent()))
    await search.focus()
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('ArrowDown')
    check('↑↓ 在行间移动活动行', (await pop.locator('.chat-pick-row[data-active]').getAttribute('data-pick-id')) !== null)
    // 右键行:私聊 + 设为默认;Esc 先收右键菜单,浮层留着
    await row('agent:agent-5').click({ button: 'right' })
    const rowMenu = win.locator('.ctx-menu[role="menu"]')
    await rowMenu.waitFor()
    check('右键行 = 私聊 + 设为默认', (await rowMenu.textContent()).includes('私聊') && (await rowMenu.textContent()).includes('设为默认'))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(120)
    check('Esc 先收右键菜单,浮层留着', (await rowMenu.count()) === 0 && await pop.isVisible())
    await row('agent:agent-5').click({ button: 'right' })
    await rowMenu.locator('button', { hasText: '设为默认' }).click()
    await win.waitForTimeout(300)
    check('设为默认写进名册、标随之挪过去', meta.defaultSlug === 'agent-5' && (await row('agent:agent-5').textContent()).includes('默认') && !(await row('agent:xyra').textContent()).includes('默认'), meta)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    check('Esc 收起浮层', (await pop.count()) === 0)
    await openPop()
    await row('engine:codex').click()
    await win.waitForTimeout(150)
    check('选引擎后浮层收起', (await pop.count()) === 0)
    await openPop()
    // 「外部引擎与 Agent 互斥」的老意图:选中集只剩引擎那一枚。
    const enginePicked = await picks()
    check('选外部引擎即清空 Agent(单选互斥)', enginePicked.length === 1 && enginePicked[0] === 'codex', enginePicked.join(','))
    await win.keyboard.press('Escape')
    await view.locator('.agent-select-strip .compact-chat-picker:not([aria-busy])').waitFor({ timeout: 30000 })
    await openPop()
    await row('agent:xyra').click()
    await win.waitForTimeout(150)
    const agentPicked = await picks()
    check('再选 Agent 即退掉外部引擎', agentPicked.length === 1 && agentPicked[0] === 'agent:xyra', agentPicked.join(','))
    await row('').click()
    await win.waitForTimeout(150)
    check('默认 Agent = 清空并收起', (await pop.count()) === 0)
    await openPop()
    const cleared = await picks()
    check('清空后什么都没勾,只有「默认 Agent」行打勾', cleared.length === 1 && cleared[0] === '', cleared)
    await win.keyboard.press('Escape')
    // ⌘⇧A / 命令面板「换 Agent」
    await view.locator('.t2c-ta').focus()
    await win.keyboard.press('Meta+Shift+A')
    await pop.waitFor()
    check('⌘⇧A 打开浮层且搜索框聚焦', await search.evaluate((el) => document.activeElement === el))
    await win.keyboard.press('Meta+Shift+A')
    await win.waitForTimeout(150)
    check('再按 ⌘⇧A 收起', (await pop.count()) === 0)
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('换 Agent')
    await win.locator('.cmd-item', { hasText: '换 Agent' }).click()
    await pop.waitFor()
    check('命令面板「换 Agent」打开浮层', await pop.isVisible())
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    await view.screenshot({ path: path.join(home, 'wide.png') })

    await resize(420, 720)
    const narrow = await safe('窄栏')
    check('窄栏还是工具行里那一枚芯片', narrow.compact.length === 1 && await view.locator('.t2c-row .agent-select-strip').count() === 1, narrow)
    // 触屏 = 贴底抽屉(10-24 定的,不变):Electron 里假装 pointer: coarse
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
    check('极窄栏仍只有一枚芯片且不出列', small.compact.length === 1 && small.compact[0].right <= small.col.right + 1, small)
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
    check('英文芯片已翻译', await view.locator('.agent-select-strip').getAttribute('aria-label') === 'Pick agents')
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
