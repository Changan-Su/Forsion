// 设置 → 快捷键 的冲突检测 / 按键查找,在真设置浮窗里用真按键走一遍(隔离 home,不连后端)。
// 用法(desktop/,先 npm run build):node ../../../.claude/hooks/devlock.cjs run --vehicle=e2e --what=check:shortcuts --eta=2 -- npm run check:shortcuts
// 截图落在 $TMPDIR/forsion-shortcut-conflicts/。方案:docs/ToBeImproved/快捷键录入与冲突方案_2026-10-17。
const fs = require('fs'); const os = require('os'); const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const DESK = path.resolve(__dirname, '..')
const OUT = path.join(os.tmpdir(), 'forsion-shortcut-conflicts'); fs.mkdirSync(OUT, { recursive: true })
let failed = 0
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info)}`); if (!ok) failed++ }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-shortcuts-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await win.waitForTimeout(1000)
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'shortcuts' })))
    let page = null
    for (let i = 0; i < 30 && !page; i++) {
      for (const p of app.windows()) { if (await p.locator('.shortcut-list').count().catch(() => 0)) { page = p; break } }
      if (!page) await win.waitForTimeout(500)
    }
    if (!page) throw new Error('设置 → 快捷键 没打开')
    await page.bringToFront().catch(() => {})
    const row = (title) => page.locator('.shortcut-row', { has: page.locator('.shortcut-name', { hasText: new RegExp(`^${title}`) }) }).first()
    const keyText = (title) => row(title).locator('.shortcut-key').innerText()
    const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
    const overrides = () => page.evaluate(() => JSON.parse(localStorage.getItem('forsion_shortcuts') || '{}'))

    // ⓪ 录制 / 按键查找期间主进程的全局快捷键挂起(合成按键到不了 globalShortcut,这里直接问主进程注册状态)。
    //    ⌘⇧M 若被别的进程占着(比如开着的 dev 实例),这次注册本来就失败,跳过这一组。
    const miniReg = () => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+M'))
    if (await miniReg()) {
      await row('打开浏览器').locator('.shortcut-key').click(); await page.waitForTimeout(400)
      check('⓪ 录制中 ⌘⇧M(Mini)已挂起', (await miniReg()) === false, null)
      await page.keyboard.press('Escape'); await page.waitForTimeout(400)
      check('⓪ Esc 后 ⌘⇧M 恢复', (await miniReg()) === true, null)
      await page.locator('.shortcut-keymode').click(); await page.waitForTimeout(400)
      check('⓪ 按键查找中 ⌘⇧M 已挂起', (await miniReg()) === false, null)
      await page.keyboard.press('Escape'); await page.waitForTimeout(400)
      check('⓪ 退出按键查找后 ⌘⇧M 恢复', (await miniReg()) === true, null)
    } else console.log('SKIP ⓪ ⌘⇧M 本来就没注册上(被别的进程占着),挂起检查跳过')

    // ① 录制撞上已有命令:不存,行下出提示;点「改绑到这里」才解绑对方
    await row('打开浏览器').locator('.shortcut-key').click()
    await page.keyboard.press('Meta+N')
    await page.locator('.shortcut-pending--conflict').waitFor({ timeout: 5000 })
    check('① 撞上「新会话」时出现冲突提示行', await page.locator('.shortcut-pending--conflict').innerText().then((s) => s.includes('新会话')), null)
    check('① 确认前没有改动任何覆盖', Object.keys(await overrides()).length === 0, await overrides())
    await shot('1-conflict-light')
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.classList.add('dark') })
    await shot('1-conflict-dark')
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
    await page.getByRole('button', { name: '改绑到这里' }).click()
    check('① 改绑后「打开浏览器」= ⌘N', (await keyText('打开浏览器')).includes('⌘N'), await keyText('打开浏览器'))
    check('① 改绑后「新会话」= 未设置', (await keyText('新会话')).includes('未设置'), await keyText('新会话'))

    // ② 「换一个」/ Esc:不存
    await row('打开终端').locator('.shortcut-key').click()
    await page.keyboard.press('Meta+K')
    await page.locator('.shortcut-pending--conflict').waitFor({ timeout: 5000 })
    await page.keyboard.press('Escape')
    check('② Esc 收起提示行且不存', (await page.locator('.shortcut-pending').count()) === 0 && (await keyText('打开终端')).includes('未设置'), await keyText('打开终端'))

    // ③ 系统保留:拦下,只有「换一个」
    await row('打开终端').locator('.shortcut-key').click()
    await page.keyboard.press('Meta+Q')
    await page.locator('.shortcut-pending--system').waitFor({ timeout: 5000 })
    check('③ ⌘Q 被拦下且没有「改绑到这里」', (await page.getByRole('button', { name: '改绑到这里' }).count()) === 0, null)
    await shot('3-system-light')
    await page.getByRole('button', { name: '换一个' }).click()
    check('③ 「换一个」回到录制', (await page.locator('input.shortcut-capture').count()) === 1, null)
    await page.keyboard.press('Meta+Shift+Y')
    check('③ 换成不冲突的键直接存', (await keyText('打开终端')).includes('⌘⇧Y'), await keyText('打开终端'))

    // ④ ⌫ 解绑
    await row('打开终端').locator('.shortcut-key').click()
    await page.keyboard.press('Backspace')
    check('④ ⌫ 解绑', (await keyText('打开终端')).includes('未设置'), await keyText('打开终端'))

    // ⑤ 编辑器层:能存,存完提示一句
    await row('打开终端').locator('.shortcut-key').click()
    await page.keyboard.press('Meta+B')
    check('⑤ ⌘B 直接存', (await keyText('打开终端')).includes('⌘B'), await keyText('打开终端'))
    check('⑤ 存完提示「加粗」', (await page.locator('.settings-inline-notice').innerText().catch(() => '')).includes('加粗'), null)

    // ⑥ 按键查找:⌘B → 命令里是「打开终端」,其他地方有编辑器的加粗;⌘C → 系统保留
    await page.locator('.shortcut-keymode').click()
    await page.keyboard.press('Meta+B')
    await page.waitForTimeout(200)
    const list = await page.locator('.shortcut-list').innerText()
    check('⑥ 按键查找 ⌘B 列出「打开终端」与编辑器的「加粗」', list.includes('打开终端') && list.includes('加粗') && list.includes('笔记编辑器'), list)
    await shot('6-keymode-light')
    await page.keyboard.press('Meta+C')
    await page.waitForTimeout(200)
    const list2 = await page.locator('.shortcut-list').innerText()
    check('⑥ 按键查找 ⌘C 显示系统保留的「复制」', list2.includes('复制') && list2.includes('系统保留') && list2.includes('没有命令使用'), list2)
    await page.keyboard.press('Escape')
    check('⑥ Esc 退出按键查找,回到搜索框', (await page.locator('.settings-filter-input input').count()) === 1, null)

    // ⑦ 静止冲突:两条命令同一个键 → 工具栏计数 + 行尾标签 + 筛选
    await page.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('forsion_shortcuts') || '{}')
      localStorage.setItem('forsion_shortcuts', JSON.stringify({ ...o, 'command-palette': 'mod+p' }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_shortcuts' }))
    })
    await page.waitForTimeout(300)
    const chip = page.locator('.shortcut-conflict-chip')
    check('⑦ 工具栏出现「1 处冲突」', (await chip.count()) === 1 && (await chip.innerText()).includes('1'), await chip.count())
    await chip.click()
    const rows = await page.locator('.shortcut-row .shortcut-name').allInnerTexts()
    check('⑦ 点计数只剩冲突的两行', rows.length === 2 && rows.some((r) => r.includes('命令面板')) && rows.some((r) => r.includes('快速查找')), rows)
    await shot('7-static-conflict-light')
  } finally { await app.close() }
  console.log(failed ? `\n${failed} 项失败;截图 ${OUT}` : `\n全部通过;截图 ${OUT}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
