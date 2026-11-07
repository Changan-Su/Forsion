/**
 * LCL 对象层第一期 × 真 Electron(桩引擎):右键哪儿的 Space / 库内文件,出的都是同一份对象菜单。
 * 正典:仓根 docs/ToBeImproved/LCL对象动作统一方案_2026-11-07。
 *
 *   F  笔记树:笔记 / 附件 / 多选的右键菜单列哪几项;复制路径进剪贴板;多选删除只问一次、删完树上没了
 *   M  笔记「⋯」:本处的行(切源码…)在,关于文件本身的(收藏 / 在文件管理器中显示 / 复制路径 / 删除笔记)来自对象层
 *   O  ⌘⇧O 的 Space 收纳面板里右键:菜单压在面板上面(点得中),Esc 只关菜单
 *   R  Ribbon 右键 Space 后按 Esc:菜单关、焦点不掉到 body
 *   N  新标签页 Space 格子右键:对象菜单 + 「X 的全部视图」那一节
 *   H  主页 Dock 格子右键:对象菜单
 *
 * 需先在本检出 `npx electron-vite build`(量的是 out/)。用法:node scripts/lcl-objects.e2e.cjs   旋钮:SHOT_DIR=<目录>
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace, makeReporter, sleep, shotDir, captureWindow } = require('./lib/uiux-electron.cjs')

const MENU = '[data-lcl-menu]'
const menuTexts = (win, sel = `${MENU} button`) => win.evaluate((s) => [...document.querySelectorAll(s)].map((b) => (b.textContent || '').trim()), sel)
const menuUp = (win) => win.locator(MENU).first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
const menuGone = (win) => win.locator(MENU).first().waitFor({ state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)
const row = (win, name) => win.locator('.t2s-srow-title', { hasText: new RegExp(`^${name}$`) }).first()
const rowShown = (win, name, ms = 15000) => row(win, name).waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false)

async function main() {
  const r = makeReporter()
  const shots = shotDir('lcl-objects')
  const env = await launch({
    tag: 'lcl-objects',
    beforeLaunch: ({ vault }) => {
      for (const n of ['Alpha', 'Beta', 'Gamma']) fs.writeFileSync(path.join(vault, `${n}.md`), `# ${n}\n\n${n} body\n`)
      fs.writeFileSync(path.join(vault, 'bundle.zip'), 'PK')
    },
  })
  const { app, win } = env
  let dialogs = 0
  win.on('dialog', (d) => { dialogs++; void d.accept() })
  try {
    await boot(app, win, { space: 'amadeus' })

    // ── F 笔记树 ──
    r.check('F0 树上长出种好的笔记', await rowShown(win, 'Alpha'))
    await row(win, 'Alpha').click({ button: 'right' })
    r.check('F1 右键笔记出对象菜单', await menuUp(win))
    const noteItems = await menuTexts(win)
    r.check('F1a 笔记:在新标签页打开 / 收藏 / 新建子笔记 / 重命名 / 在文件管理器中显示 / 复制路径 / 删除',
      ['在新标签页打开', '收藏', '新建子笔记', '重命名', '在文件管理器中显示', '复制路径', '删除'].every((x) => noteItems.includes(x)) && !noteItems.includes('打开'),
      noteItems.join(' / '))
    await sleep(450) // 等入场动效走完再拍(拍早了是半透明的)
    await captureWindow(app, path.join(shots, 'tree-note-light.png'))
    await win.locator(`${MENU} button:text-is("复制路径")`).click()
    await sleep(300)
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    r.check('F2 复制路径 → 剪贴板里是库内相对路径', clip === 'Alpha.md', JSON.stringify(clip))

    r.check('F3 附件行也在', await rowShown(win, 'bundle.zip', 5000))
    await row(win, 'bundle.zip').click({ button: 'right' })
    await menuUp(win)
    const zipItems = await menuTexts(win)
    r.check('F3a 认不出的附件:「打开」(交系统程序)不重复「用系统程序打开」,没有收藏 / 新建子笔记',
      zipItems.includes('打开') && !zipItems.includes('用系统程序打开') && !zipItems.includes('收藏') && !zipItems.includes('新建子笔记') && zipItems.includes('删除'),
      zipItems.join(' / '))
    await win.keyboard.press('Escape')
    r.check('F3b Esc 关菜单', await menuGone(win))

    // 多选:点 Alpha(开 + 只选它),⌥ 点 Beta 加进选区,右键 Beta = 对整批
    await row(win, 'Alpha').click()
    await sleep(400)
    await row(win, 'Beta').click({ modifiers: ['Alt'] })
    await sleep(200)
    await row(win, 'Beta').click({ button: 'right' })
    await menuUp(win)
    const multi = await menuTexts(win)
    r.check('F4 多选:只有「在新标签页打开 2 项」「删除 2 项」', multi.length === 2 && multi.includes('在新标签页打开 2 项') && multi.includes('删除 2 项'), multi.join(' / '))
    dialogs = 0
    await win.locator(`${MENU} button:text-is("删除 2 项")`).click()
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) { await sleep(150); gone = !(await row(win, 'Alpha').count()) && !(await row(win, 'Beta').count()) }
    r.check('F4a 删除 2 项:只问一次,删完两篇都从树上消失', gone && dialogs === 1, `dialogs=${dialogs} gone=${gone}`)

    // ── M 笔记「⋯」 ──
    await row(win, 'Gamma').click()
    const more = win.locator('.amx-more-btn').first()
    r.check('M0 打开 Gamma,顶栏有「⋯」', await more.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false))
    await more.click()
    const noteMenu = win.locator('.ctx-menu:has([data-note-mode])').first()
    r.check('M1 「⋯」菜单弹出', await noteMenu.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false))
    const moreItems = await menuTexts(win, '.ctx-menu:has([data-note-mode]) button')
    r.check('M1a 本处行在(切源码);文件本身那几项来自对象层:收藏 / 在文件管理器中显示 / 复制路径 / 删除笔记;不列「打开」',
      moreItems.some((x) => /源码|可视/.test(x)) && ['收藏', '在文件管理器中显示', '复制路径', '删除笔记'].every((x) => moreItems.includes(x)) && !moreItems.includes('在新标签页打开'),
      moreItems.join(' / '))
    await sleep(450) // 等入场动效走完再拍(拍早了是半透明的)
    await captureWindow(app, path.join(shots, 'note-more-light.png'))
    await win.locator('.ctx-menu:has([data-note-mode]) button:text-is("复制路径")').click()
    await sleep(300)
    r.check('M2 「⋯」里复制路径:Gamma.md,菜单关了', (await app.evaluate(({ clipboard }) => clipboard.readText())) === 'Gamma.md' && !(await noteMenu.count()))

    // ── O 收纳面板(非主页 Space 里 ⌘⇧O) ──
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+O' : 'Control+Shift+O')
    const panel = win.locator('.hp-organizer-panel').first()
    r.check('O0 ⌘⇧O 弹出 Space 收纳面板', await panel.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false))
    await panel.locator('.hp-tile:not(.hp-folder)').first().click({ button: 'right' })
    r.check('O1 右键 Space 格子出对象菜单', await menuUp(win))
    const onTop = await win.evaluate((sel) => {
      const b = document.querySelector(`${sel} button`)
      if (!b) return false
      const rc = b.getBoundingClientRect()
      const el = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2)
      return !!el && b.contains(el)
    }, MENU)
    r.check('O1a 菜单压在收纳面板上面(菜单项的中心点命中它自己)', onTop)
    await sleep(450) // 等入场动效走完再拍(拍早了是半透明的)
    await captureWindow(app, path.join(shots, 'organizer-menu-light.png'))
    await win.keyboard.press('Escape')
    r.check('O2 Esc 只关菜单,收纳面板还在', (await menuGone(win)) && (await panel.isVisible()))
    await win.keyboard.press('Escape')
    await sleep(300)

    // ── R Ribbon Esc 还焦点 ──
    const rb = win.locator('.rb-slot[data-id="space:tangu"] .rb-btn').first()
    await rb.click({ button: 'right' })
    r.check('R1 Ribbon 右键 Space 出菜单', await menuUp(win))
    await win.keyboard.press('Escape')
    const focusOk = await win.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)
    r.check('R2 Esc 关菜单,焦点没掉到 body', (await menuGone(win)) && focusOk, await win.evaluate(() => document.activeElement?.className || document.activeElement?.tagName))

    // ── N 新标签页 ──
    r.check('N0 进 Tangu', await enterSpace(win, 'tangu'))
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { state: 'visible', timeout: 10000 }).catch(() => {})
    await win.locator('.nt-tile.has-more').first().click({ button: 'right' })
    r.check('N1 新标签页 Space 格子右键出对象菜单', await menuUp(win))
    const heads = await win.evaluate((sel) => [...document.querySelectorAll(`${sel} .ctx-head`)].map((h) => (h.textContent || '').trim()), MENU)
    const ntItems = await menuTexts(win)
    r.check('N1a 有「X 的全部视图」那一节和 Space 对象项', heads.some((h) => h.endsWith('的全部视图')) && ntItems.some((x) => x === '打开' || x === '在新窗口中打开'), `${heads.join(',')} | ${ntItems.join(' / ')}`)
    await win.keyboard.press('Escape')
    await menuGone(win)

    // ── H 主页 Dock ──
    r.check('H0 进主页', await enterSpace(win, 'home'))
    await win.waitForSelector('.hp-dock .hp-tile', { state: 'visible', timeout: 8000 }).catch(() => {})
    await win.locator('.hp-dock .hp-tile:not(.hp-folder)').first().click({ button: 'right' })
    r.check('H1 主页 Dock 格子右键出对象菜单', await menuUp(win))
    const hpItems = await menuTexts(win)
    r.check('H1a 有「在新窗口中打开」', hpItems.includes('在新窗口中打开'), hpItems.join(' / '))
    await sleep(450) // 等入场动效走完再拍(拍早了是半透明的)
    await captureWindow(app, path.join(shots, 'home-dock-light.png'))
    await win.keyboard.press('Escape')

    // 暗色下笔记树菜单一张(观感自查)
    await win.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    if (await enterSpace(win, 'amadeus') && await rowShown(win, 'Gamma', 10000)) {
      await row(win, 'Gamma').click({ button: 'right' })
      await menuUp(win)
      await sleep(450) // 等入场动效走完再拍(拍早了是半透明的)
    await captureWindow(app, path.join(shots, 'tree-note-dark.png'))
      await win.keyboard.press('Escape')
    }
    r.note('截图', shots)
  } finally {
    await env.close()
  }
  process.exit(r.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
