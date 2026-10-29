/**
 * check:settingscopy —— 设置页文案与小排版(走查续五 5.5–5.9,2026-10-25)的真 Electron 仪器。
 *
 *  C 5.5 文案:通道不再写「（桌面版）」;浏览器控制说明不露工具名 / RFC1918,超时按秒(30)、单位跟在输入框后;
 *    设备权限副标题不再叫你「稍后到设置」、没有「都可稍后设置」那行;远程同步的「保存」在远程服务卡里;
 *    本机 Agent CLI 一个名字、空态带「重新检测」;MCP 标题「MCP 服务器」,路径和工具名用代码样式。
 *  B 5.6 状态栏:第二张卡叫「显示的条目」,徽标是「左侧 / 右侧」。
 *  S 5.7 Space 列表每行写用途、不露 id(id 在悬停提示);「重载主题」带字;附件下拉和日记文件夹输入框同宽。
 *  P 5.8 插件卡:核心 / 内置功能卡不再全是拼图(⚠ 负对照:改前每张都是 .lucide-puzzle);日历卡的说明不是电脑操作那条;
 *    「核心插件更新」收进一张 .settings-panel,和上面的卡片同一左缘。
 *  U 5.9 设备页「登录以查看…」那行文字和上下行标题对齐;卡头不是圆点;左栏分组「界面」;收件箱 ↔ 通知互指、点得动。
 *  E 英文:分组 Interface、Shown items · Left / Right、MCP servers。
 *
 * 跑:npx electron-vite build 之后 `npm run check:settingscopy`。截图(亮 / 暗 / 英文青绿)落 SETTINGS_SHOTS(缺省临时目录),
 * 交付前自己看一眼(DESIGN §8)。隔离 userData / TANGU_HOME + 假引擎(engines: [] → Agent CLI 空态;external → 通道不可用态)。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-settings-copy-'))
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
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sandbox: 'auto', workspace: path.join(home, 'ws') }))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('前置 主窗已离开首启引导', await skipOnboarding(main))

    const floating = () => app.windows().filter((w) => !w.isClosed() && w.url().includes('window=floating')).pop()
    const openSettings = async (tab) => {
      await main.evaluate((p) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: p }), { tab, n: Date.now() })
      let fl
      await waitFor(async () => { fl = floating(); return !!fl && (await fl.locator('.settings-nav').count()) > 0 }, 30000)
      if (!fl) throw new Error('settings floating window missing')
      const sub = tab.includes('/') ? tab.split('/')[1] : null
      if (sub) await fl.locator(`.settings-sub[data-settings-sub="${sub}"]`).waitFor({ timeout: 15000 })
      else await fl.locator(`.settings-sub--${tab}`).waitFor({ timeout: 15000 })
      await pause(500)
      return fl
    }
    const setFloatingSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('window=floating')) win.setContentSize(w, h)
    }, [w, h])
    const shot = (fl, name) => fl.screenshot({ path: path.join(shots, `${name}.png`) })
    const body = (fl) => fl.evaluate(() => document.querySelector('.settings-sub')?.innerText || '')
    /** 换外观:主窗写偏好再重载(设置浮窗重开时读同一份 localStorage)。 */
    const look = async ({ mode, lang = 'zh', skin = null }) => {
      await main.evaluate(([mode, lang, skin]) => {
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.setItem('tangu_locale', lang)
        if (skin) { localStorage.setItem('forsion_theme_skin', skin); localStorage.setItem('forsion_theme_bg', skin) } else { localStorage.removeItem('forsion_theme_skin'); localStorage.removeItem('forsion_theme_bg') }
      }, [mode, lang, skin])
      const fl = floating()
      if (fl) await fl.close().catch(() => {})
      await main.reload({ waitUntil: 'domcontentloaded' })
      await main.waitForSelector('#root', { timeout: 30000 })
      await pause(1500)
    }
    const TABS = ['channels', 'browser', 'permissions', 'sync/s-remote', 'agents/ag-clis', 'mcp', 'statusbar', 'spaces', 'theme', 'notes',
      'amadeus-plugins/pl-core', 'amadeus-plugins/pl-forsion', 'units', 'general/g-inbox', 'notifications']
    const shotAll = async (tag) => {
      for (const tab of TABS) {
        let f
        try { f = await openSettings(tab) } catch (e) { check(`截图前置 ${tab} 打得开(${tag})`, false, String(e).slice(0, 120)); continue }
        await setFloatingSize(1040, 720)
        await pause(300)
        await shot(f, `${tab.replace(/\//g, '_')}-${tag}`)
      }
    }

    await setFloatingSize(1040, 720).catch(() => {})

    // ── C 5.5 文案 ──
    let fl = await openSettings('channels')
    await waitFor(async () => !(await body(fl)).includes('正在加载'), 30000)
    let txt = await body(fl)
    check('C1 通道:「通道需要本机后端」,不再写「（桌面版）」', txt.includes('通道需要本机后端') && !txt.includes('桌面版'), txt.slice(0, 120))

    fl = await openSettings('browser')
    txt = await body(fl)
    check('C2 浏览器控制:说明里没有 browser_* / web_search / RFC1918 / link-local', !/browser_|web_search|RFC1918|link-local/.test(txt), txt.match(/browser_\w*|RFC1918/g))
    const timeout = await fl.evaluate(() => {
      const i = document.querySelector('input[aria-label="超时"]')
      return i ? { value: i.value, type: i.type, unit: i.nextElementSibling?.textContent } : null
    })
    check('C3 超时按秒显示(30),单位「秒」跟在输入框后', timeout?.value === '30' && timeout.unit === '秒', timeout)

    fl = await openSettings('permissions')
    txt = await fl.evaluate(() => document.querySelector('.settings-main')?.innerText || '')
    check('C4 设备权限:副标题「查看并管理…」,没有「稍后到设置」与「都可稍后设置」,「刷新状态」还在',
      txt.includes('查看并管理电脑操作与媒体权限。') && !txt.includes('稍后到设置') && !txt.includes('所有权限都可稍后设置') && txt.includes('刷新状态'))

    fl = await openSettings('sync/s-remote')
    const save = await fl.evaluate(() => {
      const service = [...document.querySelectorAll('.settings-sub .field')].find((f) => f.querySelector('select'))
      return { inService: !!service?.querySelector('button.btn.primary'), fields: document.querySelectorAll('.settings-sub .field').length, text: document.querySelector('.settings-sub')?.innerText || '' }
    })
    check('C5 远程同步:「保存」在远程服务卡里,没有独占一张卡;说明不再提「上方的在线同步」', save.inService && !save.text.includes('互不相干'), { inService: save.inService, fields: save.fields })

    fl = await openSettings('agents/ag-clis')
    const clis = await fl.evaluate(() => ({
      title: document.querySelector('.settings-sub .settings-section-title')?.textContent,
      nav: document.querySelector('.settings-nav-subitem.active')?.textContent?.trim(),
      empty: document.querySelector('.agent-clis-empty')?.innerText || '',
      recheck: document.querySelector('.agent-clis-recheck')?.textContent?.trim(),
    }))
    check('C6 本机 Agent CLI:左栏与卡片同名,空态「未检测到 · …」+「重新检测」', clis.title === '本机 Agent CLI' && clis.nav === '本机 Agent CLI' && clis.empty.includes('未检测到 · 安装并登录后会自动出现') && clis.recheck === '重新检测', clis)
    await fl.locator('.agent-clis-recheck').click()
    check('C7 点「重新检测」后原地刷新(列表还是空态、按钮可再点)', await waitFor(() => fl.evaluate(() => !!document.querySelector('.agent-clis-empty') && !!document.querySelector('.agent-clis-recheck:not([disabled])')), 8000))

    fl = await openSettings('mcp')
    const mcp = await fl.evaluate(() => {
      const f = document.querySelector('.settings-sub--mcp .field')
      return { label: f?.querySelector('label')?.textContent, codes: [...(f?.querySelector('.hint')?.querySelectorAll('code') || [])].map((c) => c.textContent), add: [...f?.querySelectorAll('button') || []].map((b) => b.textContent?.trim()).find((x) => x?.includes('MCP')) }
    })
    check('C8 MCP:标题「MCP 服务器」,工具名是代码样式,按钮「添加 MCP 服务器」',
      mcp.label === 'MCP 服务器' && mcp.codes.join('|') === 'mcp__服务器__工具' && mcp.add === '添加 MCP 服务器', mcp)

    // ── B 5.6 状态栏 ──
    fl = await openSettings('statusbar')
    const sb = await fl.evaluate(() => ({
      heads: [...document.querySelectorAll('.settings-sub--statusbar .settings-panel-head strong')].map((s) => s.textContent),
      badges: [...new Set([...document.querySelectorAll('.settings-sub--statusbar .settings-badge')].map((b) => b.textContent.trim()))],
    }))
    check('B1 状态栏:第二张卡「显示的条目」,徽标只有「左侧 / 右侧」', sb.heads[1] === '显示的条目' && sb.badges.length > 0 && sb.badges.every((b) => b === '左侧' || b === '右侧'), sb)

    // ── S 5.7 ──
    fl = await openSettings('spaces')
    const sp = await fl.evaluate(() => [...document.querySelectorAll('.settings-collection-row')].map((r) => ({ id: r.title, sub: r.querySelector('.settings-collection-name small')?.textContent || '' })))
    check('S1 Space 列表:每个内置 Space 都写用途,副标题里没有 id(id 在 title 悬停提示)',
      sp.length >= 4 && sp.every((r) => r.id && r.sub !== r.id) && sp.filter((r) => ['home', 'tangu', 'amadeus', 'inbox'].includes(r.id)).every((r) => r.sub.length > 4), sp.slice(0, 5))

    fl = await openSettings('theme')
    const reload = await fl.evaluate(() => [...document.querySelectorAll('.settings-theme-language .settings-panel-actions button')].map((b) => ({ text: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) })))
    const rb = reload.find((b) => b.text === '重载主题')
    check('S2 外观:重载主题按钮带字,一行放得下(不竖着折)', !!rb && rb.h <= 32, reload)

    fl = await openSettings('notes')
    const notes = await fl.evaluate(() => {
      const sel = document.querySelector('[data-setting-anchor="notes-attachments"] select')
      const inp = document.querySelector('[data-setting-anchor="daily-notes"] input')
      const w = (e) => e && Math.round(e.getBoundingClientRect().width)
      const r = (e) => e && Math.round(e.getBoundingClientRect().right)
      return { sel: w(sel), inp: w(inp), selR: r(sel), inpR: r(inp), fits: sel ? sel.scrollWidth <= sel.clientWidth + 1 : false }
    })
    check('S3 笔记:附件下拉与日记文件夹输入框同宽、右缘对齐', notes.sel && Math.abs(notes.sel - notes.inp) <= 1 && Math.abs(notes.selR - notes.inpR) <= 1 && notes.sel > 260, notes)

    // ── P 5.8 插件卡 ──
    fl = await openSettings('amadeus-plugins/pl-core')
    const core = await fl.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-plugin-section="core"] .plugin-card')]
      const upd = document.querySelector('.core-plugin-updates')
      return {
        cards: cards.map((c) => ({ id: c.dataset.pluginId, puzzle: !!c.querySelector('.plugin-logo .lucide-puzzle'), desc: c.querySelector('.plugin-card-description, .hint')?.textContent })),
        upd: upd ? { panel: upd.classList.contains('settings-panel'), left: Math.round(upd.getBoundingClientRect().left), action: upd.querySelector('.settings-panel-head button')?.textContent?.trim() } : null,
        cardLeft: cards[0] ? Math.round(cards[0].getBoundingClientRect().left) : null,
      }
    })
    check('P1 核心插件卡都有自己的图标(没有一张是拼图)', core.cards.length >= 2 && core.cards.every((c) => !c.puzzle), core.cards.map((c) => `${c.id}:${c.puzzle ? 'puzzle' : 'own'}`))
    const cal = core.cards.find((c) => c.id === 'forsion-calendar')
    if (cal) check('P2 日历与待办卡的说明是它自己的那条', cal.desc === '日历和待办：快捷添加、安排日期、完成与撤销。', cal.desc)
    else console.log('NOTE  P2 本次启动没有日历与待办卡(未预装),跳过')
    if (core.upd) check('P3 核心插件更新收进一张设置卡,和上面的卡片同一左缘;卡头带「检查所有更新」', core.upd.panel && Math.abs(core.upd.left - core.cardLeft) <= 1 && core.upd.action === '检查所有更新', { ...core.upd, cardLeft: core.cardLeft })
    else console.log('NOTE  P3 本次启动没有核心插件更新条目(getCorePluginUpdates 为空),跳过')

    fl = await openSettings('amadeus-plugins/pl-forsion')
    const builtin = await fl.evaluate(() => {
      const g = [...document.querySelectorAll('details.plugin-management-group')].find((d) => d.querySelector('summary')?.textContent?.includes('内置功能'))
      return [...(g?.querySelectorAll('.plugin-card .plugin-logo svg') || [])].map((s) => [...s.classList].find((c) => c.startsWith('lucide-')))
    })
    check('P4 内置功能卡各用自己的 Space / View 图标,不再全是拼图', builtin.length >= 2 && !builtin.includes('lucide-puzzle') && new Set(builtin).size === builtin.length, builtin)

    // ── U 5.9 ──
    fl = await openSettings('units')
    const units = await fl.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-setting-anchor="units-switch"] .unitsw-row')]
      const login = rows.find((r) => r.textContent.includes('登录以查看你的其他设备'))
      const titled = rows.filter((r) => r !== login && r.querySelector('.unitsw-ic'))
      const left = (r) => Math.round(r.querySelector('.unitsw-col').getBoundingClientRect().left)
      const head = document.querySelector('[data-setting-anchor="units-host"] .settings-panel-icon')
      return { login: login ? left(login) : null, others: titled.map(left), headDot: !!head?.querySelector('.unitsw-dot'), headSvg: !!head?.querySelector('svg') }
    })
    if (units.login !== null) check('U1 设备:「登录以查看你的其他设备」那行文字和上下行标题对齐', units.others.length > 0 && units.others.every((l) => Math.abs(l - units.login) <= 1), units)
    else console.log('NOTE  U1 本次启动没有「登录以查看」那一行(已登录或无登录 IPC),跳过')
    check('U2 「允许其他设备连接本机」卡头是图标,不是圆点', units.headSvg && !units.headDot, units)

    const groups = await fl.evaluate(() => [...document.querySelectorAll('.settings-nav-grouphead')].map((g) => g.textContent.trim()))
    check('U3 左栏分组「界面」,不再叫「外观」', groups.includes('界面') && !groups.includes('外观'), groups)

    fl = await openSettings('general/g-inbox')
    const xref = fl.locator('.settings-xref-link')
    check('U4 收件箱:有一行指向「界面 › 通知」', (await xref.count()) === 1 && (await xref.innerText()) === '界面 › 通知')
    await xref.click()
    check('U5 点它就到通知页', await waitFor(() => fl.locator('.settings-sub--notifications').count().then((n) => n > 0), 5000))
    const back = fl.getByRole('button', { name: '常规 › 收件箱', exact: true })
    check('U6 通知:系统通知下面一行「收件箱的新消息另有一个开关」', (await back.count()) === 1 && (await body(fl)).includes('收件箱的新消息另有一个开关'))
    await back.click()
    check('U7 点「常规 › 收件箱」就到收件箱那一页', await waitFor(() => fl.locator('.settings-sub[data-settings-sub="g-inbox"]').count().then((n) => n > 0), 5000))

    await shotAll('light')

    // ── 暗色截图 / 英文青绿(断言 + 截图) ──
    await look({ mode: 'dark' })
    await shotAll('dark')
    await look({ mode: 'light', lang: 'en', skin: 'teal' })
    fl = await openSettings('statusbar')
    const en = await fl.evaluate(() => ({
      groups: [...document.querySelectorAll('.settings-nav-grouphead')].map((g) => g.textContent.trim()),
      heads: [...document.querySelectorAll('.settings-sub--statusbar .settings-panel-head strong')].map((s) => s.textContent),
      badges: [...new Set([...document.querySelectorAll('.settings-sub--statusbar .settings-badge')].map((b) => b.textContent.trim()))],
    }))
    check('E1 英文:分组 Interface,卡片 Shown items,徽标 Left / Right', en.groups.includes('Interface') && !en.groups.includes('Appearance') && en.heads[1] === 'Shown items' && en.badges.every((b) => b === 'Left' || b === 'Right'), en)
    fl = await openSettings('mcp')
    const enMcp = await fl.evaluate(() => document.querySelector('.settings-sub--mcp .field label')?.textContent)
    check('E2 英文:MCP servers', enMcp === 'MCP servers', enMcp)
    await shotAll('teal-en')
    if (process.env.SETTINGS_SHOTS) console.log(`截图 → ${shots}`)
  } finally {
    if (app) await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (!process.env.SETTINGS_SHOTS) try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
