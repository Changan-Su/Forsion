/**
 * check:settingsmode —— 设置页「点一下就生效 / 静默丢草稿 / 落错页 / 搜不到」的真 Electron 仪器(UIUX 评审 U-01/02/05/14/15)。
 *
 *  A 后端运行方式卡只改草稿:点「自动托管」卡 → 磁盘 config 的 mode 仍是 external、内置后端状态不变(仍 stopped),
 *    但托管参数面板与「切换到托管并启动」吸底栏出现;「放弃」后草稿收回。
 *    ⚠ 负对照:旧实现 onClick = setConfig({mode}) → mode 落盘 + ensureBackend 起后端,A 必红。
 *  B 草稿不被即时开关冲掉:托管草稿下把沙箱改成「不使用」→ 切到「基本」拨「阻止休眠」(即时写盘,回来的
 *    effectiveConfig 以前会整体覆盖共享 stored)→ 回到「连接」,沙箱仍是草稿值,磁盘沙箱未变,吸底栏仍在。
 *    工作目录改成失焦提交:输入 → Tab → 磁盘值更新。
 *  C 深链落点:tab='forsion' → 常规/Forsion(登录所在);'model/m-providers' → 模型/提供方;'connection' → 常规/连接;
 *    缺省 → 常规/基本(第一屏不再是后端技术项)。
 *  D 设置搜索:搜不到有空态;索引里每一项在本端可见时,点结果 → 落到对应子页,且锚点(有的话)在正文可视区内。
 *
 * 跑:npx electron-vite build 之后 `npm run check:settingsmode`。SETTINGS_SHOTS=<dir> 另存截图。
 * 隔离 userData / TANGU_HOME + 假引擎,不碰 ~/.forsion,不起真后端,不调模型。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

require('sucrase/register/ts')
const { SETTINGS_SEARCH_INDEX } = require(path.join(__dirname, '../frontend/src/components/settingsSearchIndex.ts'))

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-settings-mode-'))
const shots = process.env.SETTINGS_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await pause(80)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sandbox: 'auto', workspace: path.join(home, 'ws-before') }))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('主窗已离开首启引导', await skipOnboarding(main))

    /** 打开(或重定向)设置浮窗;params 变 → SettingsModal 按 key 重挂。 */
    const openSettings = async (params) => {
      await main.evaluate((p) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: p }), params)
      let fl
      await waitFor(async () => { fl = app.windows().find((w) => w.url().includes('window=floating')); return !!fl }, 15000)
      if (!fl) throw new Error('settings floating window missing')
      await fl.locator('.settings-nav').waitFor({ timeout: 30000 })
      await pause(400)
      return fl
    }
    const activeSubLabel = (fl) => fl.evaluate(() => document.querySelector('.settings-nav-subitem.active')?.textContent?.trim() || '')
    const diskConfig = () => main.evaluate(() => window.tangu.getConfig())

    // ── C 深链落点 ──
    let fl = await openSettings({})
    await waitFor(async () => (await activeSubLabel(fl)) === '基本')
    check('C0 缺省落点 = 常规/基本(工作目录在第一屏)', (await activeSubLabel(fl)) === '基本' && await fl.locator('[data-setting-anchor="workspace-dir"]').isVisible(), await activeSubLabel(fl))
    await fl.screenshot({ path: path.join(shots, 'settings-default.png') })
    for (const [target, expected] of [['forsion', 'Forsion'], ['model/m-providers', '提供方'], ['connection', '连接']]) {
      fl = await openSettings({ tab: target })
      await waitFor(async () => (await activeSubLabel(fl)) === expected)
      check(`C 深链 ${target} → ${expected}`, (await activeSubLabel(fl)) === expected, await activeSubLabel(fl))
    }

    // ── A 后端运行方式卡只改草稿 ──
    fl = await openSettings({ tab: 'connection' })
    const before = await diskConfig()
    const stBefore = await main.evaluate(() => window.tangu.backendStatus())
    const toggle = fl.locator('.settings-mode-panel [data-action="mode-change"]')
    if (await toggle.count()) await toggle.click()
    await fl.locator('.settings-mode-panel .settings-choice-card').filter({ hasText: '托管' }).click()
    await pause(1500)
    const after = await diskConfig()
    const stAfter = await main.evaluate(() => window.tangu.backendStatus())
    check('A1 点托管卡:磁盘 mode 不变', before.mode === 'external' && after.mode === 'external', { before: before.mode, after: after.mode })
    check('A2 点托管卡:内置后端状态不变(不启停)', stAfter.state === stBefore.state, { before: stBefore.state, after: stAfter.state })
    check('A3 草稿态显示托管参数与「切换到托管并启动」', await fl.locator('.settings-runtime-panel').isVisible()
      && await fl.locator('.settings-runtime-panel .special-save button', { hasText: '切换到托管并启动' }).count() === 1)
    await fl.screenshot({ path: path.join(shots, 'settings-mode-draft.png') })
    // 吸底栏真的吸在 .settings-body 底部:面板比可视区高时,滚到面板顶部,栏仍在可视区内(面板 overflow:hidden 会让它跟着滚走)。
    const setFloatingSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('window=floating')) win.setSize(w, h)
    }, [w, h])
    await setFloatingSize(1040, 520)
    await pause(400)
    const sticky = await fl.evaluate(() => {
      const body = document.querySelector('.settings-body')
      const panel = document.querySelector('.settings-runtime-panel')
      const bar = panel?.querySelector('.special-save')
      if (!body || !panel || !bar) return { ok: false, why: 'missing' }
      body.scrollTop += panel.getBoundingClientRect().top - body.getBoundingClientRect().top
      const b = body.getBoundingClientRect(), r = bar.getBoundingClientRect(), pr = panel.getBoundingClientRect()
      return { tall: pr.bottom > b.bottom + 4, ok: r.bottom <= b.bottom + 1 && r.top >= b.top, bar: [r.top, r.bottom], body: [b.top, b.bottom], panelBottom: pr.bottom }
    })
    check('A5 吸底栏在面板高于可视区时仍吸在底部(前置:面板确实比可视区高)', sticky.tall && sticky.ok, sticky)
    await fl.screenshot({ path: path.join(shots, 'settings-savebar-sticky.png') })
    await setFloatingSize(1040, 720)
    await pause(300)

    // ── B 草稿不被即时开关冲掉 ──
    await fl.locator('.settings-runtime-panel select').first().selectOption('none')
    await fl.locator('.settings-nav-subitem', { hasText: '基本' }).click()
    await fl.locator('[data-setting-anchor="keep-awake"] [role="switch"]').click()
    await waitFor(async () => (await diskConfig()).keepAwakeWhileRunning === true)
    check('B0 即时开关确实写了盘(前置,否则 B1 是假绿)', (await diskConfig()).keepAwakeWhileRunning === true)
    await fl.locator('.settings-nav-subitem', { hasText: '连接' }).click()
    await fl.locator('.settings-runtime-panel').waitFor({ timeout: 5000 }).catch(() => {})
    const sandboxDraft = await fl.locator('.settings-runtime-panel select').first().inputValue().catch(() => '')
    check('B1 拨即时开关后,未保存的沙箱草稿仍在', sandboxDraft === 'none', sandboxDraft)
    check('B2 草稿未落盘', (await diskConfig()).sandbox === 'auto' && (await diskConfig()).mode === 'external', { sandbox: (await diskConfig()).sandbox })
    check('B3 吸底栏仍提示未保存', await fl.locator('.settings-runtime-panel .special-save').isVisible())
    await fl.locator('.settings-runtime-panel .special-save button', { hasText: '放弃' }).click()
    await pause(300)
    check('A4 放弃后草稿收回:托管参数面板消失', !(await fl.locator('.settings-runtime-panel').isVisible()))
    // 工作目录:失焦提交
    await fl.locator('.settings-nav-subitem', { hasText: '基本' }).click()
    const wsInput = fl.locator('[data-setting-anchor="workspace-dir"] input')
    const wsTarget = path.join(home, 'ws-after')
    await wsInput.fill(wsTarget)
    await wsInput.press('Tab')
    check('B4 工作目录失焦提交', await waitFor(async () => (await diskConfig()).defaultWorkspaceDir === wsTarget), (await diskConfig()).defaultWorkspaceDir)

    // ── D 设置搜索 ──
    const search = fl.locator('.settings-nav-search input')
    check('D0 搜索框有可访问名', !!(await search.getAttribute('aria-label')))
    await search.fill('zzqx-不存在')
    check('D1 搜不到有空态', await fl.locator('.settings-nav-empty').isVisible())
    await search.fill('字体')
    check('D2 搜「字体」出具体设置项(不只是分类名)', await fl.locator('[data-setting-result="fonts"]').count() === 1)
    await search.fill('镜像')
    check('D3 外部连接下不给「镜像」结果(托管参数本端不可见,不许点进白板)', await fl.locator('[data-setting-result="mirror"]').count() === 0)
    // 托管草稿下,运行组那几项才可见 —— 造一个草稿让 D 循环也把它们点一遍(草稿不落盘,A 已证)。
    await search.fill('')
    await fl.locator('.settings-nav-subitem', { hasText: '连接' }).click()
    if (!(await fl.locator('.settings-mode-panel .settings-choice-card').count())) await fl.locator('.settings-mode-panel [data-action="mode-change"]').click()
    await fl.locator('.settings-mode-panel .settings-choice-card').filter({ hasText: '托管' }).click()
    await search.fill('镜像')
    check('D4 托管草稿下「镜像」结果出现', await waitFor(async () => (await fl.locator('[data-setting-result="mirror"]').count()) === 1, 3000))
    await fl.screenshot({ path: path.join(shots, 'settings-search.png') })
    let reached = 0, skipped = []
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const query = entry.keywords.split(/\s+/)[0]
      await search.fill(query)
      const row = fl.locator(`[data-setting-result="${entry.id}"]`)
      if (!(await row.count())) { skipped.push(entry.id); continue }
      await row.click()
      if (entry.anchor) {
        const ok = await waitFor(async () => fl.evaluate((a) => {
          const el = document.querySelector(`[data-setting-anchor="${a}"]`)
          const body = document.querySelector('.settings-body')
          if (!el || !body) return false
          const r = el.getBoundingClientRect(), b = body.getBoundingClientRect()
          return r.height > 0 && r.top < b.bottom && r.bottom > b.top
        }, entry.anchor), 4000)
        check(`D 结果 ${entry.id} → 锚点 ${entry.anchor} 在可视区`, ok)
      } else {
        check(`D 结果 ${entry.id} → 子页 ${entry.sub}`, await waitFor(async () => fl.evaluate((s) => document.querySelector(`.settings-sub[data-settings-sub="${s}"]`) !== null, entry.sub), 4000))
      }
      reached++
    }
    check('D 本端至少覆盖 15 个索引项', reached >= 15, { reached, skipped })
    await search.fill('')
    // 英文界面:新文案不漏中文
    await fl.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    fl = await openSettings({ tab: 'connection', probe: 'en' })
    await fl.reload({ waitUntil: 'domcontentloaded' })
    await fl.locator('.settings-nav').waitFor({ timeout: 30000 })
    await pause(600)
    const navText = await fl.locator('.settings-nav').innerText()
    check('E 英文导航无汉字', !/[㐀-鿿]/u.test(navText), navText.match(/[㐀-鿿]+/gu))
    await fl.screenshot({ path: path.join(shots, 'settings-en.png') })
    await fl.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))

    // ── F 外观页 + 窄高窗体(观感,出截图自查;断言只钉可访问语义) ──
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('window=floating')) w.setSize(1040, 600)
    })
    await fl.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    fl = await openSettings({ tab: 'theme', probe: 'dark' })
    await fl.reload({ waitUntil: 'domcontentloaded' })
    await fl.locator('.settings-theme-language .theme-card').first().waitFor({ timeout: 30000 })
    await pause(600)
    const radios = await fl.evaluate(() => [...document.querySelectorAll('.theme-grid [role="radio"]')].map((el) => ({
      checked: el.getAttribute('aria-checked'), hidden: el.querySelector('.theme-preview')?.getAttribute('aria-hidden'),
    })))
    check('F1 主题卡为 radiogroup/radio,恰一张选中,预览对读屏隐藏', radios.length >= 2 && radios.filter((r) => r.checked === 'true').length === 1 && radios.every((r) => r.hidden === 'true'), radios)
    check('F2 明暗 / 玻璃分段钮带 aria-pressed', await fl.locator('[data-setting-anchor="color-mode"] button[aria-pressed="true"]').count() === 1
      && await fl.locator('[data-setting-anchor="glass"] button[aria-pressed="true"]').count() === 1)
    check('F3 丝滑光标开关有可访问名', !!(await fl.locator('[data-setting-anchor="smooth-caret"] [role="switch"]').getAttribute('aria-label')))
    check('F4 窄高窗体下左栏可滚时挂底部渐隐', await fl.evaluate(() => document.querySelector('.settings-nav-list')?.dataset.overflow === 'bottom'))
    await fl.screenshot({ path: path.join(shots, 'settings-theme-dark-1040x600.png') })
    await fl.locator('.settings-theme-language').screenshot({ path: path.join(shots, 'settings-theme-grid-dark.png') })
    await fl.evaluate(() => localStorage.setItem('forsion_theme_pref', 'light'))
  } finally {
    await app?.close().catch(() => {})
    await stub.close?.()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · shots: ${shots}`)
  if (failed.length) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
