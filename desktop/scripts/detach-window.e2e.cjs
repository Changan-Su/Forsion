/**
 * 「把 View 拖出成新窗口」—— 真 Electron × 真主进程 × 真多窗 IPC。2026-11-07 用户报的三件事都钉在这里:
 *
 *  D  拖出来的窗口只放这一个 View:没有左右栏(工作区 / 文件 / 大纲),也没有左栏开合钮;主区照旧能自己分屏。
 *     (用户原话:「floating panel 应当没有左右分栏」,指 chat 这类 View 单独拖出来成为新窗口。)
 *  P  每个 Space 的第一个 View(固定 View,区内最后一个)也能移到新窗口:源窗口在原处补一个新的同类 View(「区内至少留一个」不破),
 *     撕出去的对话带着它正在看的那条会话(不是新窗自己「跟随」到的别的会话)。
 *  M  标签右键菜单:固定 View 也有菜单;有关闭其他 / 关闭右侧 / 关闭全部 / 向右拆分 / 向下拆分 / 在新窗口打开 / 移到新窗口;
 *     固定 View 没有「关闭」,侧栏(只图标)标签没有「向右拆分」。
 *
 * 拖拽的「松手在窗外 → 主进程路由」那一段走的是 detach 缝(与右键「移到新窗口」同一条),真 OS 拖拽的坐标这里验不到。
 * 需先 npm run build。用法:npm run e2e:detach   (DETACH_SHOTS=<目录> 留截图)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.DETACH_SHOTS || ''
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-detach-'))

/** 这扇窗里每个标签组:区(按 __loc 推:标签的 data-view-type + 组在窗里的位置)与标签类型。 */
const groupsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.dv-groupview')].map((g) => {
  const r = g.getBoundingClientRect()
  return {
    types: [...g.querySelectorAll('.wb-tab')].map((t) => t.getAttribute('data-view-type')),
    icon: !!g.querySelector('.wb-tab--icon'),
    x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
  }
}).filter((g) => g.w > 0 && g.h > 0))

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.log('[pageerror main]', e.message))
    await win.waitForSelector('#root', { timeout: 30000 })
    await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    await win.waitForTimeout(2500)
    await app.evaluate(({ BrowserWindow }) => {
      const m = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('window='))
      m.setSize(1280, 860)
    })
    await win.waitForTimeout(600)
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await win.screenshot({ path: path.join(SHOTS, 'main-before.png') }) }

    const expectWindow = async (act, ms = 10000) => {
      const opened = app.waitForEvent('window', { timeout: ms }).catch(() => null)
      await act()
      const p = await opened
      if (p) { p.on('pageerror', (e) => console.log('[pageerror sat]', e.message)); await p.waitForLoadState('domcontentloaded').catch(() => {}) }
      return p
    }
    const settle = async (p) => { await p.waitForSelector('.dv-groupview', { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(2500) }

    // ── D:拖出一个对话(与拖拽 / 右键「移到新窗口」同一条 IPC)──
    const sat = await expectWindow(() => win.evaluate(() => window.tangu.openDetached([{ type: 'chat', params: { followActive: false } }])))
    check('D0 开出了独立窗', !!sat)
    if (sat) {
      await settle(sat)
      const groups = await groupsOf(sat)
      console.log('   detached groups:', JSON.stringify(groups))
      if (SHOTS) await sat.screenshot({ path: path.join(SHOTS, 'detached-chat.png') })
      check('D1 独立窗只有主区一组,没有左右栏', groups.length === 1 && !groups[0].icon, groups)
      check('D2 那一组里是拖出来的对话', groups.length >= 1 && groups.some((g) => g.types.includes('chat')), groups.map((g) => g.types))
      check('D3 没有左右栏开合钮(底部面板钮照旧)', !(await sat.locator('.dv-prefix .dv-edge-toggle, .dv-edge-right').count()) && (await sat.locator('.dv-edge-bottom').count()) > 0)
      // 快捷键 / 命令也开不出左右栏
      await sat.evaluate(() => { document.body.focus() })
      await sat.keyboard.press(process.platform === 'darwin' ? 'Meta+/' : 'Control+/')
      await sat.waitForTimeout(700)
      const afterKey = await groupsOf(sat)
      check('D4 ⌘/ 也开不出左栏', afterKey.length === 1, afterKey)
      await sat.close().catch(() => {})
    }
    // D5:视图自己往侧栏开东西(Agent 资料页挂载时开左栏名册)在独立视图窗里也开不出来(Codex 评审 P2)
    const sat2 = await expectWindow(() => win.evaluate(() => window.tangu.openDetached([{ type: 'agent-profile', params: {} }])))
    if (sat2) {
      await settle(sat2)
      const g2 = await groupsOf(sat2)
      check('D5 Agent 资料页拖出来:左栏名册没有长出来', g2.length === 1 && !g2[0].icon && g2[0].types.includes('agent-profile'), g2)
      await sat2.close().catch(() => {})
    } else check('D5 Agent 资料页拖出来:开出了窗', false)

    if (process.env.DETACH_ONLY_D) return
    // 后面几段在 Tangu Space 里做:主区第一个 View(固定的主对话)+ 左栏工作区
    await win.evaluate(() => document.querySelector('.rb-slot[data-id="space:tangu"] .rb-space')?.click())
    await win.waitForSelector('.dv-groupview .wb-tab[data-view-type="chat"]', { timeout: 15000 })
    await win.waitForTimeout(1200)
    // ── M:右键菜单 ──
    const pinnedTab = win.locator('.dv-groupview .wb-tab[data-view-type="chat"]').first()
    await pinnedTab.click({ button: 'right' })
    await win.waitForTimeout(400)
    const items = await win.$$eval('.ctx-menu button', (els) => els.map((e) => e.getAttribute('data-act')))
    console.log('   pinned tab menu:', JSON.stringify(items))
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'menu-pinned.png') })
    check('M1 固定 View 右键有菜单', items.length >= 1, items)
    check('M2 固定 View 菜单里没有「关闭」', !items.includes('close'), items)
    // 新配置没有会话:主对话是空的新对话,钉不出副本 → 不给拆分 / 在新窗口打开,只给「移到新窗口」(Codex 评审 P1)
    check('M3 空的新对话:只有「移到新窗口」,没有拆分 / 复制', items.includes('move-window') && !['split-right', 'split-down', 'open-window'].some((k) => items.includes(k)), items)
    await win.keyboard.press('Escape')
    await win.mouse.click(5, 400)
    await win.waitForTimeout(300)

    // 侧栏图标标签:没有向右拆分
    const sideTab = win.locator('.wb-tab--icon').first()
    if (await sideTab.count()) {
      await sideTab.click({ button: 'right' })
      await win.waitForTimeout(400)
      const sideItems = await win.$$eval('.ctx-menu button', (els) => els.map((e) => e.getAttribute('data-act')))
      console.log('   side tab menu:', JSON.stringify(sideItems))
      check('M4 侧栏标签有菜单、没有「向右拆分」', sideItems.length >= 2 && !sideItems.includes('split-right'), sideItems)
      await win.mouse.click(5, 400)
      await win.waitForTimeout(300)
    }

    // 关闭其他 / 关闭右侧:主区开两个新标签页再来
    await win.locator('.dv-new-tab').first().click()
    await win.waitForTimeout(500)
    await win.locator('.dv-new-tab').first().click()
    await win.waitForTimeout(500)
    const mainTypes = async () => (await groupsOf(win)).filter((g) => !g.icon).flatMap((g) => g.types)
    const before = await mainTypes()
    await win.locator('.dv-groupview .wb-tab[data-view-type="chat"]').first().click({ button: 'right' })
    await win.waitForTimeout(300)
    await win.locator('.ctx-menu button[data-act="close-others"]').click()
    await win.waitForTimeout(600)
    const after = await mainTypes()
    check('M5 关闭其他标签:只剩固定的对话', after.length === 1 && after[0] === 'chat', { before, after })

    // 向右拆分(拿新建标签页做:非单例、能复制):主区多一组
    await win.locator('.dv-new-tab').first().click()
    await win.waitForTimeout(500)
    await win.locator('.dv-groupview .wb-tab[data-view-type="launcher"]').first().click({ button: 'right' })
    await win.waitForTimeout(300)
    const launcherItems = await win.$$eval('.ctx-menu button', (els) => els.map((e) => e.getAttribute('data-act')))
    // 同组另一个是固定的对话(关不掉)→ 没有「关闭其他」;其余齐全
    check('M6 普通标签菜单齐全', ['close', 'split-right', 'split-down', 'open-window', 'move-window'].every((k) => launcherItems.includes(k)) && !launcherItems.includes('close-others'), launcherItems)
    await win.locator('.ctx-menu button[data-act="split-right"]').click()
    await win.waitForTimeout(800)
    const mainGroups = (await groupsOf(win)).filter((g) => !g.icon)
    check('M7 向右拆分:主区变两组', mainGroups.length === 2, mainGroups)
    // 收回:右边那组(拆出来的启动页)关掉,再关掉留在左组的那个启动页
    for (let i = 0; i < 3; i++) {
      const tab = win.locator('.dv-groupview .wb-tab[data-view-type="launcher"]').last()
      if (!(await tab.count())) break
      await tab.click({ button: 'right' })
      await win.waitForTimeout(300)
      await win.locator('.ctx-menu button[data-act="close"]').click().catch(() => {})
      await win.waitForTimeout(500)
    }

    // ── P:固定 View 移到新窗口 ──
    const mainBefore = (await groupsOf(win)).filter((g) => !g.icon).flatMap((g) => g.types)
    await win.locator('.dv-groupview .wb-tab[data-view-type="chat"]').first().click({ button: 'right' })
    await win.waitForTimeout(300)
    const moved = await expectWindow(() => win.locator('.ctx-menu button[data-act="move-window"]').click())
    check('P1 固定 View 移到新窗口:开出了窗', !!moved)
    await win.waitForTimeout(1200)
    const mainAfter = (await groupsOf(win)).filter((g) => !g.icon).flatMap((g) => g.types)
    check('P2 源窗口补回一个对话(区内至少留一个)', mainAfter.includes('chat'), { mainBefore, mainAfter })
    if (moved) {
      await settle(moved)
      const g = await groupsOf(moved)
      check('P3 新窗里是那个对话、没有左右栏', g.length === 1 && g[0].types.includes('chat'), g)
      if (SHOTS) await moved.screenshot({ path: path.join(SHOTS, 'detached-pinned.png') })
    }
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'main-after.png') })
  } finally {
    await app.close().catch(() => {})
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
