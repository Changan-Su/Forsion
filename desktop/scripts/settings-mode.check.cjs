/**
 * check:settingsmode —— 设置页「点一下就生效 / 静默丢草稿 / 落错页 / 搜不到」的真 Electron 仪器(UIUX 评审 U-01/02/05/14/15)。
 *
 *  A 后端运行方式卡只改草稿:点「自动托管」卡 → 磁盘 config 的 mode 仍是 external、内置后端状态不变(仍 stopped),
 *    但连接页就地出现「切换到托管并启动」吸底栏(托管参数在「本机运行环境」子页,只认落盘);「放弃」后草稿收回。
 *    ⚠ 负对照:旧实现 onClick = setConfig({mode}) → mode 落盘 + ensureBackend 起后端,A 必红。
 *  B 草稿不被即时开关冲掉:「浏览器控制」里改超时(草稿)→ 切到「基本」拨「阻止休眠」(即时写盘,回来的
 *    effectiveConfig 以前会整体覆盖共享 stored)→ 回到「浏览器控制」,超时仍是草稿值,磁盘未变,吸底栏仍在。
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
    // 合并 origin 的 g-runtime 子页后(09-26):托管参数只在已落盘为托管时出现在「本机运行环境」页;
    // 连接页上把草稿切到托管时,就地给「切换到托管并启动」吸底栏(U-01 的显式切换不变)。
    const applyBarOf = () => fl.locator('.settings-body .special-save').filter({ has: fl.locator('button', { hasText: '切换到托管并启动' }) })
    check('A3 草稿态就地给「切换到托管并启动」,连接页不再内嵌托管参数', await applyBarOf().isVisible()
      && await fl.locator('.settings-runtime-panel').count() === 0)
    await fl.screenshot({ path: path.join(shots, 'settings-mode-draft.png') })
    // 吸底栏真的吸在 .settings-body 底部:页面比可视区高时,滚到顶部,栏仍在可视区内。
    const setFloatingSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('window=floating')) win.setSize(w, h)
    }, [w, h])
    await setFloatingSize(1040, 400)
    await pause(400)
    const sticky = await fl.evaluate(() => {
      const body = document.querySelector('.settings-body')
      const bar = [...document.querySelectorAll('.settings-body .special-save')].find((b) => /切换到托管并启动/.test(b.textContent || ''))
      if (!body || !bar) return { ok: false, why: 'missing' }
      body.scrollTop = 0
      const b = body.getBoundingClientRect(), r = bar.getBoundingClientRect()
      return { tall: body.scrollHeight > body.clientHeight + 4, ok: r.bottom <= b.bottom + 1 && r.top >= b.top, bar: [r.top, r.bottom], body: [b.top, b.bottom], scroll: [body.scrollHeight, body.clientHeight] }
    })
    check('A5 吸底栏在页面高于可视区时仍吸在底部(前置:页面确实比可视区高)', sticky.tall && sticky.ok, sticky)
    await fl.screenshot({ path: path.join(shots, 'settings-savebar-sticky.png') })
    await setFloatingSize(1040, 720)
    await pause(300)
    await applyBarOf().locator('button', { hasText: '放弃' }).click()
    await pause(300)
    check('A4 放弃后草稿收回:切换栏消失、磁盘 mode 仍是外部', !(await applyBarOf().isVisible()) && (await diskConfig()).mode === 'external')

    // ── B 草稿不被即时开关冲掉(外部模式下托管参数不出现,改用同为 managedKeys 草稿的「浏览器控制」设置) ──
    const navTo = async (label) => { await fl.locator('.settings-nav-list button', { hasText: label }).first().click(); await pause(300) }
    await navTo('浏览器控制')
    const timeoutInput = fl.locator('.settings-number-input').first()
    const diskTimeout = (await diskConfig()).browserCommandTimeoutMs
    await timeoutInput.fill('45000')
    await pause(300)
    check('B0a 浏览器草稿出现吸底栏(前置)', await fl.locator('.settings-body .special-save').isVisible())
    // 「常规」是展开 / 收起开关:已展开时再点会收起,子项只在不可见时才点它。
    const basicSub = fl.locator('.settings-nav-subitem', { hasText: '基本' })
    if (!(await basicSub.isVisible())) await navTo('常规')
    await basicSub.click()
    await fl.locator('[data-setting-anchor="keep-awake"] [role="switch"]').click()
    await waitFor(async () => (await diskConfig()).keepAwakeWhileRunning === true)
    check('B0 即时开关确实写了盘(前置,否则 B1 是假绿)', (await diskConfig()).keepAwakeWhileRunning === true)
    await navTo('浏览器控制')
    const draftNow = await fl.locator('.settings-number-input').first().inputValue().catch(() => '')
    check('B1 拨即时开关后,未保存的浏览器草稿仍在', draftNow === '45000', draftNow)
    check('B2 草稿未落盘', (await diskConfig()).browserCommandTimeoutMs === diskTimeout, { disk: (await diskConfig()).browserCommandTimeoutMs, before: diskTimeout })
    check('B3 吸底栏仍提示未保存', await fl.locator('.settings-body .special-save').isVisible())
    await fl.locator('.settings-body .special-save button', { hasText: '放弃' }).click()
    await pause(300)
    check('B4 放弃后草稿收回、吸底栏消失', !(await fl.locator('.settings-body .special-save').isVisible()))
    // 工作目录:失焦提交
    await fl.locator('.settings-nav-subitem', { hasText: '基本' }).click()
    const wsInput = fl.locator('[data-setting-anchor="workspace-dir"] input')
    const wsTarget = path.join(home, 'ws-after')
    await wsInput.fill(wsTarget)
    await wsInput.press('Tab')
    check('B4 工作目录失焦提交', await waitFor(async () => (await diskConfig()).defaultWorkspaceDir === wsTarget), (await diskConfig()).defaultWorkspaceDir)
    // B5(Codex 第一轮 A-2):失焦提交写盘失败 → 就地提示 + 草稿保留 + 「重试」。把 TANGU_HOME 临时设成只读
    // (config.json 与它的写锁都落在这里),真让主进程的 config:set 失败,再放开点重试。
    const wsFail = path.join(home, 'ws-after-retry')
    try {
      fs.chmodSync(home, 0o555)
      await wsInput.fill(wsFail)
      await wsInput.press('Tab')
      const errRow = fl.locator('[data-commit-error="defaultWorkspaceDir"]')
      check('B5 写盘失败:工作目录旁就地出现「未保存」提示(role=alert)', await waitFor(async () => (await errRow.count()) === 1 && (await errRow.getAttribute('role')) === 'alert', 6000))
      check('B5 失败后草稿仍在输入框、盘上仍是旧值', (await wsInput.inputValue()) === wsFail && (await diskConfig()).defaultWorkspaceDir === wsTarget)
      await fl.screenshot({ path: path.join(shots, 'settings-commit-error.png') })
      fs.chmodSync(home, 0o755)
      await errRow.locator('button').click()
      check('B5 点「重试」后写盘成功、提示消失', await waitFor(async () => (await diskConfig()).defaultWorkspaceDir === wsFail && (await errRow.count()) === 0, 6000))
      // B6(复核补漏):失败后用户**改了新值、不失焦直接点「重试」**—— 点击先让输入框失焦提交新值,重试不能再把
      // 失败那一刻的旧快照写回去(retry 闭包曾绑着旧 edits:盘上落旧值、新草稿被回执抹掉)。
      const wsStale = path.join(home, 'ws-stale'), wsFresh = path.join(home, 'ws-fresh')
      fs.chmodSync(home, 0o555)
      await wsInput.fill(wsStale)
      await wsInput.press('Tab')
      const failedAgain = await waitFor(async () => (await errRow.count()) === 1, 6000)
      fs.chmodSync(home, 0o755)
      await wsInput.fill(wsFresh)
      await errRow.locator('button').click()
      await pause(1200)
      check('B6 失败后改新值再点「重试」:盘上与输入框都是新值(不被旧快照覆盖)', failedAgain
        && await waitFor(async () => (await diskConfig()).defaultWorkspaceDir === wsFresh, 4000)
        && (await diskConfig()).defaultWorkspaceDir === wsFresh && (await wsInput.inputValue()) === wsFresh,
      { disk: (await diskConfig()).defaultWorkspaceDir, input: await wsInput.inputValue() })
    } finally { fs.chmodSync(home, 0o755) }

    // ── D 设置搜索 ──
    const search = fl.locator('.settings-nav-search input')
    check('D0 搜索框有可访问名', !!(await search.getAttribute('aria-label')))
    await search.fill('zzqx-不存在')
    check('D1 搜不到有空态', await fl.locator('.settings-nav-empty').isVisible())
    await search.fill('字体')
    check('D2 搜「字体」出具体设置项(不只是分类名)', await fl.locator('[data-setting-result="fonts"]').count() === 1)
    await search.fill('镜像')
    check('D3 外部连接下不给「镜像」结果(托管参数本端不可见,不许点进白板)', await fl.locator('[data-setting-result="mirror"]').count() === 0)
    // 托管参数只在**已落盘**为托管时渲染(g-runtime 子页,09-26 合并 origin 后):造一个托管草稿,运行组仍不该出现在结果里。
    await search.fill('')
    await fl.locator('.settings-nav-subitem', { hasText: '连接' }).click()
    if (!(await fl.locator('.settings-mode-panel .settings-choice-card').count())) await fl.locator('.settings-mode-panel [data-action="mode-change"]').click()
    await fl.locator('.settings-mode-panel .settings-choice-card').filter({ hasText: '托管' }).click()
    await search.fill('镜像')
    await pause(400)
    check('D4 托管草稿(未落盘)下仍不给「镜像」结果(点进去会是白板)', await fl.locator('[data-setting-result="mirror"]').count() === 0)
    await fl.screenshot({ path: path.join(shots, 'settings-search.png') })
    // 本端此刻应可见的索引项(Codex 第一轮 A-4):桌面 + 已读回落盘配置(外部)+ 运行方式草稿=托管 →
    // needs 含 'external'(外部连接面板随草稿收起)或 'managed'(托管参数只认落盘)的项按门控该藏。逐项要求**必须**搜得到,不再「搜不到就跳过、够 15 个就绿」——
    // 否则某个本该可见的项消失 / 门控写错,只要其余凑够门槛照样全绿。
    const expectHidden = (e) => (e.needs || []).some((n) => n === 'external' || n === 'managed')
    let reached = 0
    const missing = [], leaked = []
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const query = entry.keywords.split(/\s+/)[0]
      await search.fill(query)
      const row = fl.locator(`[data-setting-result="${entry.id}"]`)
      const present = await waitFor(async () => (await row.count()) > 0, 1500)
      if (expectHidden(entry)) { if (present) leaked.push(entry.id); continue }
      if (!present) { missing.push(entry.id); check(`D 结果 ${entry.id} 搜得到(本端应可见)`, false, { query }); continue }
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
    const expected = SETTINGS_SEARCH_INDEX.filter((e) => !expectHidden(e)).length
    check(`D 本端应可见的 ${expected} 个索引项全部搜得到并落点`, missing.length === 0 && reached === expected, { reached, expected, missing })
    check('D 按门控该藏的项(外部连接面板 / 托管参数,托管草稿下)一个都没漏出来', leaked.length === 0, { leaked })
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
