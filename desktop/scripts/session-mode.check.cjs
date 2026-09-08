/**
 * 侧栏 Chat / Work 模式胶囊(2026-09-07 用户拍板):真 Electron 起一个、灌两个会话、切胶囊、截图。
 * 钉的是:
 *   1 桌面端默认 Work:复用 Local/Cloud 滑块胶囊、Work 亮且滑块在右;列表按项目分组(≥2 组,含「不在项目中工作」),chat 与 work 会话都在
 *     会话面自身不再画搜索框(搜索统一走全局快速查找)
 *   2 切 Chat:只剩 chat 会话、平铺(0 个组头,.t2s-flat 在);work 会话不在列表里;空态项目选择器不露出
 *     且输入区不显示模式胶囊、上下文圆环和 Agent 选择器
 *   3 reload 恢复模式，且工作区组的 name/key 均唯一
 *   4 模式跟着打开的会话走:在 Chat 里打开 work 会话 → 胶囊切回 Work、组头回来
 *   5 截图(亮/暗各一张侧栏)—— DESIGN.md §8:几何断言全绿 ≠ 看起来对,自己看
 *   6 本地 managed Chat 的模型菜单保留本机直连 Provider(不能再把 sandbox 等同于云 worker)
 * 跑法:npm run build && npm run check:sessionmode(单实例锁:先退掉 dev 版 Electron)。
 * 会话靠 window.__forsionStore(appStore 暴露的 zustand 句柄)直接 createInWorkspace,不依赖模型/网络。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SIDEBAR_STATE = () => {
  const visibleCount = (selector) => Array.from(document.querySelectorAll(selector)).filter((e) => {
    const style = getComputedStyle(e)
    const rect = e.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }).length
  const groupDetails = Array.from(document.querySelectorAll('.t2s-side .t2s-group')).map((e) => ({
    key: e.dataset.workspaceKey || '',
    name: (e.querySelector('.t2s-group-label')?.textContent || '').trim(),
  }))
  return {
    active: (document.querySelector('.t2s-mode button.on') || {}).dataset?.mode || null,
    modeUsesVaultSeg: document.querySelectorAll('.t2s-mode.t2s-vaultseg').length === 1,
    modeThumb: (document.querySelector('.t2s-mode .t2s-vaultseg-thumb') || {}).dataset?.side || null,
    sessionSearches: document.querySelectorAll('.t2s-side > .t2s-search').length,
    groups: groupDetails.length,
    groupDetails,
    flat: document.querySelectorAll('.t2s-side .t2s-flat').length,
    rows: Array.from(document.querySelectorAll('.t2s-side .t2s-srow')).map((e) => (e.textContent || '').trim().slice(0, 30)),
    projectBar: document.querySelectorAll('.newchat-projectbar').length,
    addWs: document.querySelectorAll('.t2s-add-ws').length,
    stored: localStorage.getItem('forsion_tangu_session_mode'),
    activeRow: ((document.querySelector('.t2s-side .t2s-srow.active') || {}).textContent || '').trim().slice(0, 30),
    composerModeChips: visibleCount('.t2c .mode-pill-btn'),
    contextRings: visibleCount('.t2c .t2c-ctxring'),
    agentPickers: visibleCount('.t2c .agent-picker'),
  }
}

function uniqueWorkspaceGroups(groups) {
  const keys = groups.map((g) => g.key)
  const names = groups.map((g) => g.name)
  return keys.every(Boolean) && new Set(keys).size === keys.length && new Set(names).size === names.length
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-sessionmode-'))
  const userData = path.join(home, 'userdata')
  // 本地 managed Chat 虽然是 sandbox，但仍由本机 Tangu 后端执行，应拿到本机 Provider 目录。
  // 用不可达假端点即可：本仪器只验证模型目录，不发推理请求，也不会泄露真实凭证。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    providers: [{ providerId: 'local-check', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'instrument-only', modelIds: ['direct-chat-check'] }],
  }), 'utf8')
  // 全新家目录必须预置 mode:managed(否则停在引导页 / 没有本地引擎,建不了会话);未打包时主进程用 `<dir>-dev`,两份都种。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' }), 'utf8')
  }
  const shots = {
    work: path.join(os.tmpdir(), `forsion-sessionmode-work-${process.pid}.png`),
    chat: path.join(os.tmpdir(), `forsion-sessionmode-chat-${process.pid}.png`),
    chatDark: path.join(os.tmpdir(), `forsion-sessionmode-chat-dark-${process.pid}.png`),
    full: path.join(os.tmpdir(), `forsion-sessionmode-full-${process.pid}.png`),
  }
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
  } catch (e) {
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    throw e
  }
  try {
    let win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    // 钉住启动 Space = Tangu(缺省是主页 Space,没有侧栏)。
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'tangu'); localStorage.removeItem('forsion_tangu_session_mode')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForSelector('.t2s-side', { timeout: 30_000 })

    // 生产构建没有 __forsionStore(DEV-only),全部走 UI:Work 模式(桌面默认)下点组头的「+」建会话。
    // 无根组的 + → chat 会话;云项目组的 + → work 会话。等本地引擎起来:组头「+」建会话要经 HTTP,先等侧栏出组头。
    await win.waitForSelector('.t2s-group', { timeout: 30_000 })
    await sleep(1500)
    const dump = await win.evaluate(`(() => ({
      groups: Array.from(document.querySelectorAll('.t2s-side .t2s-group')).map((e) => (e.textContent || '').trim().slice(0, 30)),
      special: (document.querySelector('.t2s-special-row') || {}).textContent,
      modeBtns: document.querySelectorAll('.t2s-mode button').length,
      lang: document.documentElement.lang,
    }))()`)
    console.log('sidebar dump ' + JSON.stringify(dump))
    // 语言可能落到 en(--lang 只是提示,首屏语言链见 CLAUDE.md):zh/en 两个名都认
    const groupAdd = (name) => win.locator('.t2s-group', { hasText: name }).first().locator('button.t2s-group-add').last()
    const rename = async (title) => {
      // 建完即打开(activeId = 新会话)→ 活动行右键 → 菜单第 2 项 = 重命名(第 1 项是「在新标签页打开」)
      const row = win.locator('.t2s-side .t2s-srow.active').first()
      await row.click({ button: 'right' })
      await win.locator('.ctx-menu button').nth(1).click()
      await win.locator('.t2s-rename').fill(title)
      await win.keyboard.press('Enter')
      await sleep(400)
    }
    let seeded = { ok: false }
    try {
      await groupAdd(/不在项目中工作|Not in a project|Don't work in a project|Without a project/i).click({ timeout: 10_000 })
      await win.waitForSelector('.t2s-side .t2s-srow.active', { timeout: 20_000 })
      await rename('CHAT 会话')
      // 第二个:任一云项目组(默认 Tangu);没有云项目组就用默认本地工作区组
      const cloudGroup = win.locator('.t2s-group', { hasText: 'Tangu' }).first()
      const target = (await cloudGroup.count()) ? cloudGroup.locator('button.t2s-group-add').last() : win.locator('.t2s-group').nth(0).locator('button.t2s-group-add').last()
      await target.click({ timeout: 10_000 })
      await sleep(1200)
      await rename('WORK 会话')
      seeded = await win.evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('.t2s-side .t2s-srow')).map((e) => (e.textContent || '').trim())
        return { ok: rows.some((r) => r.includes('CHAT')) && rows.some((r) => r.includes('WORK')), rows }
      })()`)
    } catch (e) { seeded = { ok: false, err: String(e && e.message || e) } }
    check('0 UI 灌了 chat + work 两个会话(无根组 + / 项目组 +,各重命名)', seeded.ok, JSON.stringify(seeded))
    if (!seeded.ok) throw new Error('会话没灌上,后面没法验')
    const stateOf = () => win.evaluate(SIDEBAR_STATE)

    // ── 1 桌面默认 Work ───────────────────────────────────────────────────────
    // 刚建完 work 会话时它是活动会话;胶囊此刻 Work(桌面默认,且没手选过)。
    let st = await stateOf()
    check('1 桌面端默认 Work:复用 Local/Cloud 滑块胶囊、Work 亮且滑块在右', st.modeUsesVaultSeg && st.active === 'work' && st.modeThumb === 'work',
      JSON.stringify({ modeUsesVaultSeg: st.modeUsesVaultSeg, active: st.active, modeThumb: st.modeThumb }))
    check('1a 会话面不再画「搜索会话」框', st.sessionSearches === 0, `sessionSearches=${st.sessionSearches}`)
    check('1b Work 列表有 ≥2 个组头、两个会话都在', st.groups >= 2 && st.rows.some((r) => r.includes('CHAT')) && st.rows.some((r) => r.includes('WORK')),
      JSON.stringify(st))
    check('1c Work 输入区保留模式胶囊', st.composerModeChips >= 1, `composerModeChips=${st.composerModeChips}`)
    await win.locator('.t2c .mode-pill-btn:visible').first().click()
    await win.waitForSelector('.composer-menu--mode', { state: 'visible', timeout: 5_000 })
    const presetItems = await win.locator('.composer-menu--mode button').evaluateAll((buttons) => buttons
      .map((button) => (button.textContent || '').trim())
      .filter((text) => text === 'Chat' || text === 'Work'))
    check('1d 输入区模式菜单不再重复 Chat / Work 切换', presetItems.length === 0, JSON.stringify(presetItems))
    await win.keyboard.press('Escape')
    await win.locator('.t2s-side').screenshot({ path: shots.work })

    // ── 2 开着 work 会话点 Chat:列表只剩 chat 会话、平铺;主区顺手开成新对话(空态,chat) ──
    await win.locator('.t2s-mode button[data-mode="chat"]').click()
    await sleep(700)
    st = await stateOf()
    check('2 Chat:滑块回左、只剩 chat 会话、平铺(0 组头,.t2s-flat 在)、work 会话不在', st.active === 'chat' && st.modeThumb === 'chat' && st.groups === 0 && st.flat === 1 && st.rows.some((r) => r.includes('CHAT')) && !st.rows.some((r) => r.includes('WORK')),
      JSON.stringify(st))
    check('2b 开着 work 会话切 Chat → 主区变成新对话空态,且不露出项目选择器', st.activeRow === '' && st.projectBar === 0, JSON.stringify({ activeRow: st.activeRow, projectBar: st.projectBar }))
    check('2c Chat 模式不露出「添加本地工作区」(Work 的事)', st.addWs === 0, `addWs=${st.addWs}`)
    check('2d Chat 输入区不显示模式胶囊、上下文圆环和 Agent 选择器', st.composerModeChips === 0 && st.contextRings === 0 && st.agentPickers === 0,
      JSON.stringify({ composerModeChips: st.composerModeChips, contextRings: st.contextRings, agentPickers: st.agentPickers }))
    await win.locator('.model-pill-btn').click()
    await win.locator('.cm-model-row').hover()
    await win.waitForSelector('.cm-sub[data-pane="model"]', { timeout: 5_000 })
    const chatModels = await win.locator('.cm-sub[data-pane="model"] .menu-item').evaluateAll((items) => items.map((item) => (item.textContent || '').trim()))
    const directItem = win.locator('.cm-sub[data-pane="model"] .menu-item', { hasText: 'direct-chat-check' }).first()
    if (await directItem.count()) await directItem.click()
    const selectedDirect = ((await win.locator('.model-pill-btn').textContent().catch(() => '')) || '').includes('direct-chat-check')
    check('2e 本地 managed Chat 能拿到并选择本机直连 Provider 模型', chatModels.some((name) => name.includes('direct-chat-check')) && selectedDirect,
      JSON.stringify({ chatModels, selectedDirect }))
    await win.locator('.t2s-side').screenshot({ path: shots.chat })
    await win.screenshot({ path: shots.full })

    // ── 3 持久 ────────────────────────────────────────────────────────────────
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.t2s-side', { timeout: 30_000 })
    await sleep(1500)
    st = await stateOf()
    // 布局恢复会把上一个会话(work)重新打开 → 单向跟随把模式切到 Work(开着 work 会话不能停在 Chat);这是设计,记下来。
    check('3 reload 恢复了 work 会话 → 模式跟随到 Work(单向跟随也管恢复)', st.active === 'work' && st.activeRow.includes('WORK'), JSON.stringify({ active: st.active, stored: st.stored, activeRow: st.activeRow }))
    check('3b reload 后工作区组的 name/key 均唯一', uniqueWorkspaceGroups(st.groupDetails), JSON.stringify(st.groupDetails))

    // ── 4 搜索统一走全局快速查找:Chat 里搜到 work 会话、点开 → 胶囊切回 Work、组头回来、该行高亮 ──
    await win.locator('.t2s-mode button[data-mode="chat"]').click()
    await sleep(300)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await win.waitForSelector('.amx-qf-input', { timeout: 10_000 })
    await win.locator('.amx-qf-input').fill('WORK')
    await sleep(500)
    const hit = win.locator('.amx-qf-row', { hasText: 'WORK' }).first()
    check('4a Chat 模式下全局快速查找仍能搜到 work 会话', (await hit.count()) === 1)
    await hit.click()
    await sleep(700)
    st = await stateOf()
    check('4 在 Chat 里打开 work 会话 → 胶囊切回 Work、组头回来、该行高亮', st.active === 'work' && st.groups >= 2 && st.activeRow.includes('WORK'), JSON.stringify(st))
    // 反向不跟:Work 里打开 chat 会话(无根组里看得见)→ 仍是 Work
    await win.locator('.t2s-side .t2s-srow', { hasText: 'CHAT' }).first().click()
    await sleep(500)
    st = await stateOf()
    check('4b Work 里打开 chat 会话 → 仍是 Work(无根组里看得见,不跳)', st.active === 'work' && st.activeRow.includes('CHAT'), JSON.stringify({ active: st.active, activeRow: st.activeRow }))

    // ── 5 暗色截图(切 Chat 再截)─────────────────────────────────────────────
    await win.locator('.t2s-mode button[data-mode="chat"]').click()
    await sleep(300)
    st = await stateOf()
    check('5a 开着 chat 会话切 Chat → 会话留着(它在列表里,行高亮)', st.active === 'chat' && st.activeRow.includes('CHAT'), JSON.stringify({ active: st.active, activeRow: st.activeRow }))
    // 5b 持久:模式偏好住 localStorage。启动/reload 恢复的是「最近更新」的会话(3 里恢复了刚改名的 work 会话并触发单向跟随),
    // 这里先把 chat 会话再改一次名让它成为最近更新的,reload 后恢复的就是它 → 模式必须还是 Chat。
    await rename('CHAT 会话')
    await sleep(1500)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.t2s-side', { timeout: 30_000 })
    await sleep(1500)
    st = await stateOf()
    check('5b 开着(最近更新的)chat 会话 reload → 恢复它、模式仍 Chat(localStorage 持久)', st.active === 'chat' && st.stored === 'chat' && st.groups === 0, JSON.stringify({ active: st.active, stored: st.stored, groups: st.groups, activeRow: st.activeRow }))
    check('5c reload 后 Chat 输入区仍不显示模式胶囊、上下文圆环和 Agent 选择器', st.composerModeChips === 0 && st.contextRings === 0 && st.agentPickers === 0,
      JSON.stringify({ composerModeChips: st.composerModeChips, contextRings: st.contextRings, agentPickers: st.agentPickers }))
    // 暗色:用户明暗偏好的真源是 forsion_theme_pref(themeStore persistPref;forced_scheme 只是首屏防闪的派生提示,会被 apply 抹掉),
    // 落盘后 reload,装载器按它重算 token(只改 html[data-mode] 不重算,截出来还是亮的)。
    await win.evaluate(`localStorage.setItem('forsion_theme_pref', 'dark')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.t2s-side', { timeout: 30_000 })
    await sleep(1500)
    await win.locator('.t2s-side').screenshot({ path: shots.chatDark })
    const darkOn = await win.evaluate(`document.documentElement.dataset.mode`)
    check('5d 暗色截图确实是暗色(html[data-mode]=dark)', darkOn === 'dark', `data-mode=${darkOn}`)
    check('5 截图落盘(自己看)', Object.values(shots).every((p) => fs.existsSync(p)), Object.values(shots).join(' '))
  } finally {
    await app.close().catch(() => {})
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log('SHOTS ' + JSON.stringify(shots))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
