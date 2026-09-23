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
 *   (以下每段先切 Tangu 再切回:编辑器全部重挂、认领历史清空,只能靠收养)
 *   F8 ⚠️ 前台是新标签页、Gamma 只剩后台标签:树仍亮 Gamma
 *   F6 夹具:左组 [新标签页, Beta] | 右组 Gamma(右组那份从没被认领过)
 *   F7 ⚠️ 关掉 Beta、左组顶上来新标签页:树亮右组看得见的 Gamma(Codex 评审的场景)
 *   F9 ⚠️ 最后一个编辑器也关掉:树什么都不亮 —— 'main' 里的启动页已交出,不再冒出来
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
      byGroup: [...document.querySelectorAll('.dv-groupview')].filter((g) => g.querySelector('.dv-nav-btn'))
        .map((g) => [...g.querySelectorAll('.wb-tab-name')].map((e) => (e.textContent || '').trim())),
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
    const closeTab = async (name, which = 'last') => {
      const hit = await win.evaluate(([n, w]) => {
        const all = [...document.querySelectorAll('.wb-tab')]
        const t = (w === 'first' ? all : all.reverse()).find((e) => (e.querySelector('.wb-tab-name')?.textContent || '').trim() === n)
        const x = t && t.querySelector('.wb-tab-close')
        if (x) x.click()
        return !!x
      }, [name, which])
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

    // ── 往返后的收养人(Codex 评审):切到 Tangu 再切回 → 编辑器全部重挂、认领历史清空,只能靠 ②b 收养 ──
    // ⚠️ 组头的「+」一律开在主区第一组,点哪一组的都一样(实测);要把新标签放进哪组只能靠这个顺序安排。
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const roundTrip = async () => {
      await win.locator('.rb-space[title="Tangu"]').first().click({ timeout: 15_000 }); await win.waitForTimeout(2500)
      await win.locator('.rb-space[title="Note"]').first().click({ timeout: 15_000 }); await win.waitForTimeout(3000)
    }
    // F8:单组 [Gamma, 新标签页],前台切到新标签页再往返 → 主区没有前台编辑器,Gamma 只在后台
    await win.locator('.wb-tab', { hasText: '新建标签页' }).first().click(); await win.waitForTimeout(800)
    await roundTrip()
    const f8 = await state()
    check('⚠️F8 往返后前台是新标签页、Gamma 只在后台:树亮 Gamma,不落回启动页', f8.tabs.includes('Gamma') && !f8.active.includes('Gamma') && rowIs('Gamma')(f8), JSON.stringify(f8))

    // F6/F7:左组 [新标签页, Beta] | 右组 [Gamma](右组那份从没被认领过)
    await win.locator('.wb-tab', { hasText: 'Gamma' }).first().click(); await win.waitForTimeout(800)
    await win.keyboard.press(`${mod}+Backslash`); await win.waitForTimeout(1500) // 右组 = Gamma 副本
    await win.click('.dv-new-tab'); await win.waitForTimeout(900) // 开进左组
    await openRow('Beta') // 左组前台是空白新标签 → 就地变成 Beta
    await closeTab('Gamma', 'first') // 关左组那份 Gamma
    await roundTrip()
    const f6 = await state()
    check('F6 夹具:往返后左组 [新标签页, Beta]、右组 Gamma', JSON.stringify(f6.byGroup) === JSON.stringify([['新建标签页', 'Beta'], ['Gamma']]) && f6.active.includes('Beta') && f6.active.includes('Gamma'), JSON.stringify(f6))
    await closeTab('Beta')
    const f7 = await state()
    // 左组顶上来的是新标签页(activeMainPanel 不是编辑器),认领过的都关了 → 收养人得是右组看得见的 Gamma
    check('⚠️F7 关掉 Beta、左组剩新标签页:树亮右组看得见、从没认领过的 Gamma', JSON.stringify(f7.byGroup) === JSON.stringify([['新建标签页'], ['Gamma']]) && rowIs('Gamma')(f7), JSON.stringify(f7))

    await closeTab('Gamma')
    const f9 = await state()
    check('⚠️F9 最后一个编辑器也关了:树上什么都不亮,启动页不再冒出来', !f9.tabs.includes('Gamma') && f9.row.length === 0, JSON.stringify(f9))
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
