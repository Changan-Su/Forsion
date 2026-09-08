/** 真 Electron 用户消息动作布局与交互回归。npm run build && npm run check:messageactions */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const prompt = '请先阅读项目简报，再按简报开始。\n\n目标：优化窄窗口中的对话阅读体验。\n需要的能力：文件阅读、界面布局和交互验证。\n\n请结合已有文件说明实现方式，并检查输入区、消息正文和操作按钮在不同窗口宽度下的可读性。'
const timestamp = Date.UTC(2026, 8, 7)
let count = 0
function check(name, ok, detail) { assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); console.log(`PASS ${name}`); count++ }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-message-actions-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(userdata)
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine({
    sessions: [{ id: 'message-actions', title: '消息按钮布局', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-09-07 12:00:00', updated_at: '2026-09-07 12:00:00' }],
    messages: [
      { id: 'user-layout', role: 'user', content: prompt, timestamp, attachments: null },
      { id: 'assistant-layout', role: 'model', content: '我会先核对布局，再验证宽窄窗口。', timestamp: timestamp + 1000 },
    ],
    checkpoints: [{ runId: 'layout-run', at: timestamp + 500, files: ['/tmp/layout-fixture.ts'], skipped: [] }],
  })
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1050))
    await win.waitForSelector('#root')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.locator(`button:text-is("${label}")`).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    const view = win.locator('.t2-chat-view').first()
    const row = view.locator('#tocmsg-user-layout')
    await row.waitFor()
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })

    for (const width of [800, 420, 320]) {
      await view.evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width}px`; el.style.height = '820px' }, width)
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      const g = await row.evaluate((el) => {
        const box = (selector) => { const r = el.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width } }
        return { bubble: box('.t2-user'), actions: box('.t2-actions'), width: el.getBoundingClientRect().width }
      })
      check(`${width}px: 动作行在气泡下方`, g.actions.top >= g.bubble.bottom + 4, g)
      check(`${width}px: 动作行与气泡右边缘对齐`, Math.abs(g.actions.right - g.bubble.right) < 1, g)
      check(`${width}px: 短动作行不占正文横向空间`, g.actions.width < g.bubble.width, g)
      if (width <= 420) check(`${width}px: 长消息利用窄栏可读宽度`, g.bubble.width >= g.width - 1, g)
      await row.screenshot({ path: path.join(home, `user-${width}.png`) })
    }

    await win.mouse.move(1, 1)
    await row.locator('button[title="编辑"]').focus()
    await win.waitForTimeout(180)
    check('键盘聚焦时动作行可见', await row.locator('.t2-actions').evaluate((el) => Number(getComputedStyle(el).opacity) === 1))
    await row.locator('button[title="编辑"]').click()
    check('编辑按钮仍载入原文', await view.locator('.t2-edit-ta').inputValue() === prompt)
    await view.locator('.t2-edit-ta').press('Escape')
    await row.hover()
    await row.locator('button[title="回退到这条消息"]').click()
    const menu = row.locator('.rewind-menu')
    await menu.locator('.menu-item').first().waitFor()
    await win.waitForTimeout(220)
    const mg = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const view = el.closest('.t2-chat-view').getBoundingClientRect()
      const composer = el.closest('.t2-chat-col').querySelector('.composer-anchor').getBoundingClientRect()
      const button = el.querySelector('.menu-item:not(:disabled)')
      const b = button.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewLeft: view.left, viewRight: view.right, viewTop: view.top, composerTop: composer.top, clickable: button.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)) }
    })
    check('回退菜单完整留在聊天列内', mg.left >= mg.viewLeft && mg.right <= mg.viewRight && mg.top >= mg.viewTop && mg.bottom <= mg.composerTop, mg)
    check('回退菜单没有被输入区遮住', mg.clickable, mg)
    await view.screenshot({ path: path.join(home, 'rewind-menu.png') })
    await menu.locator('.menu-item').first().click()
    await win.waitForTimeout(200)
    check('回退按钮仍调用正确的消息时间点', stub.seen.restore.length === 1 && stub.seen.restore[0].at === timestamp, stub.seen.restore)
    check('仅回退代码保留消息', await row.count() === 1)
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换明暗模式')
    await win.locator('.cmd-item', { hasText: '切换明暗模式' }).click()
    await row.hover()
    await win.waitForTimeout(400)
    await view.screenshot({ path: path.join(home, 'chat-dark.png') })
    console.log(`${count}/${count} passed; screenshots: ${home}`)
  } catch (error) {
    const win = app?.windows()[0]
    await win?.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
    console.error('Failure screenshot:', path.join(home, 'failure.png'))
    throw error
  } finally { await app?.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
