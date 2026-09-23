/**
 * pageStore 门面(「当前这篇」)落在哪 —— 真 Electron × 真磁盘。编辑器之外的一切(左栏树高亮、状态栏字数、
 * 大纲、插件 getActivePage)读门面 = activePageScope();它不跟主区编辑器走时,就读到 restoreVault 装进
 * 'main' 的启动页。2026-09-23 两条都是真机实测:
 *
 *   F0 ⚠️ 从主页点进 Note Space、还没点任何笔记:主区是空白编辑器,树上不许亮启动那篇
 *        (修前亮 Alpha、状态栏是 Alpha 的字数 —— Note Space 配方最后把焦点给了左栏树,编辑器从没被激活过)
 *   F0b ⚠️ 冷启动直接落在 Note Space:空白编辑器仍是欢迎页,树也不亮。这条考「收养等 vaultRoot」:
 *        restoreVault 经门面调用、此时和编辑器挂载同拍,抢先收养 = 启动页装进编辑器、欢迎页被顶成 Alpha(实测)
 *   F1-F2 夹具:树上开 Gamma → 新标签 X → 新标签 Y 里开 Beta
 *   F3 ⚠️ 关掉 Beta(旁边顶上来的是新标签页 X):树退回剩下的编辑器 Gamma,不回启动那篇
 *        (修前:dispose 改投 stores 里第一个 = 'main')
 *   F4 夹具:聚焦 Gamma → ⌘\ 分屏 → 树上开 Beta 进右组
 *   F5 ⚠️ 关掉右组的 Beta(整组没了,Dockview 不激活左组):树亮左组的 Gamma
 *
 * 判门面只读 DOM(树行 .active),不信 store 自证。三篇正文长度不同,状态栏字数也能认出是哪篇(写进 detail)。
 * 夹具换 Beta 进标签用树行点击:焦点留在左栏,正是「编辑器没被激活」这条路。
 *
 * 用法:npm run build && npm run check:facade
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-facade-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  for (const [n, body] of [['Alpha', 'a'], ['Beta', 'bb bb'], ['Gamma', 'ccc ccc ccc']]) {
    fs.writeFileSync(path.join(vault, `${n}.md`), `# ${n}\n\n${body}\n`, 'utf8')
  }
  // ⚠️ 未打包时 userData 是 `<dir>-dev`,只种一份会打开本机真 dev 库。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }

  const launch = () => electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  let app
  let win
  const state = () => win.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    return {
      tabs: [...document.querySelectorAll('.wb-tab')].filter(vis).map((e) => (e.querySelector('.wb-tab-name')?.textContent || '').trim()),
      active: [...document.querySelectorAll('.dv-tab.dv-active-tab')].filter(vis).map((e) => (e.textContent || '').trim()),
      row: [...document.querySelectorAll('.t2s-srow.active')].map((e) => (e.textContent || '').trim()),
      chars: [...document.querySelectorAll('.sb-plain, .status-item')].map((e) => (e.textContent || '').trim()).filter((t) => /字|chars/i.test(t)),
      groups: [...document.querySelectorAll('.dv-groupview')].filter((g) => g.querySelector('.dv-nav-btn')).length,
      welcome: /从左栏选一篇笔记开始/.test(document.body.innerText),
    }
  })
  try {
    // ── 第一程:从(缺省的)主页点进 Note Space ──
    app = await launch()
    win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[title="Note"]').first().click({ timeout: 15_000 })
    await win.waitForSelector('.t2s-srow:has-text("Gamma")', { timeout: 20_000 })
    await win.waitForTimeout(2500)
    const f0 = await state()
    check('⚠️F0 从主页点进 Note Space、还没点任何笔记:主区是空白编辑器,树上不亮启动那篇', f0.tabs.includes('编辑器') && f0.row.length === 0, JSON.stringify(f0))

    // ── 第二程:冷启动直接落在 Note Space(进程重来,模块状态清零)──
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.waitForTimeout(800)
    await app.close()
    app = await launch()
    win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForSelector('.t2s-srow:has-text("Gamma")', { timeout: 30_000 })
    await win.waitForTimeout(3000)
    const f0b = await state()
    check('⚠️F0b 冷启动直接落在 Note Space:空白编辑器仍是欢迎页(没被启动页顶掉),树上不亮', f0b.tabs.includes('编辑器') && f0b.welcome && f0b.row.length === 0, JSON.stringify(f0b))

    const rowIs = (name) => (s) => s.row.length === 1 && s.row[0] === name
    const openRow = async (name) => { await win.locator('.t2s-srow', { hasText: name }).first().click(); await win.waitForTimeout(1800) }
    const closeTab = async (name) => {
      const hit = await win.evaluate((n) => {
        const t = [...document.querySelectorAll('.wb-tab')].reverse().find((e) => (e.querySelector('.wb-tab-name')?.textContent || '').trim() === n)
        const x = t && t.querySelector('.wb-tab-close')
        if (x) x.click()
        return !!x
      }, name)
      if (!hit) throw new Error(`找不到「${name}」标签的关闭钮 —— 选择器过时就当场红,别让夹具半成品混过断言`)
      await win.waitForTimeout(1800)
    }

    await openRow('Gamma')
    const f1 = await state()
    check('F1 夹具:树上开 Gamma,树亮 Gamma', rowIs('Gamma')(f1), JSON.stringify(f1))
    await win.click('.dv-new-tab'); await win.waitForTimeout(900)
    await win.click('.dv-new-tab'); await win.waitForTimeout(900)
    await openRow('Beta')
    const f2 = await state()
    check('F2 夹具:新标签 X、新标签 Y 里开 Beta,树亮 Beta', f2.active.includes('Beta') && rowIs('Beta')(f2), JSON.stringify(f2))

    await closeTab('Beta')
    const f3 = await state()
    check('⚠️F3 关掉活动编辑器 Beta(顶上来的是新标签页):树退回剩下的 Gamma,不回启动那篇', !f3.tabs.includes('Beta') && rowIs('Gamma')(f3), JSON.stringify(f3))

    await win.locator('.wb-tab', { hasText: 'Gamma' }).first().click(); await win.waitForTimeout(800)
    await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Backslash`); await win.waitForTimeout(1500)
    await openRow('Beta')
    const f4 = await state()
    check('F4 夹具:分屏后树上开 Beta 进右组', f4.groups >= 2 && f4.active.includes('Gamma') && f4.active.includes('Beta') && rowIs('Beta')(f4), JSON.stringify(f4))

    await closeTab('Beta')
    const f5 = await state()
    check('⚠️F5 关掉右组的 Beta(整组没了):树亮左组剩下的 Gamma', f5.groups === 1 && !f5.tabs.includes('Beta') && rowIs('Gamma')(f5), JSON.stringify(f5))
  } catch (e) {
    check('台架自身跑完', false, String(e && e.stack || e))
  } finally {
    await app?.close().catch(() => {})
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main()
