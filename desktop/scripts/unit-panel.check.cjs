/**
 * 账号面板上半的 Unit 段(AccountUnitSection)台架:真 Chromium + 真 Ribbon + 真 AccountCard + 真远程面,
 * harness.html?ribbon&unit&unitpanel(名册 / 探针 / 账号全是桩,不碰真登录、真隧道)。
 *
 * 判据:
 *   A 分组与排序(方案图 ②):Unit 段(这台电脑 / 我的设备 / 管理 Unit…)→ 分隔线 → 账号头部 → 账号项,退出登录是最后一行;面板宽 320
 *   B 勾选态:没在看别的设备时「这台电脑」打勾;一行 = 图标 + 名字 + 灰字(在线 · 中转)
 *   C 离线折成「离线 N 台」,点开灰显;手机不列;本机不列
 *   D 点离线行:不切,面板里就地说「那台没开 Forsion」
 *   E 点在线行:这个窗口切到那台(远程面 = 隧道页),面板关;再开:那台打勾、没有灰字,「这台电脑」不勾
 *   F 面板开着点远程面 → 关;窗口失焦(真 Electron 里点 <webview> 只表现为宿主 blur)→ 关
 *   G 正在看的那台掉线了也不折;手输地址的目标正看着时单独一行
 *   H 点「这台电脑」= 回到本机(远程面收起,胶囊回「本地」,不动智库侧)
 *   I 右键五项「切换到这台」「在新窗口打开」「添加到桌面」「改名字」「改图标」;点菜单外只收菜单、Esc 只收菜单;改名 / 改图标各走一次 unitsUpdate、只带自己那个字段
 *   K 在线行悬停 / 键盘聚焦才露「在新窗口打开」;离线行右键也有新窗口 / 桌面两项;添加到桌面不交名字;手输地址那行没有右键
 *   J 「管理 Unit…」→ 设置 › 设备
 *   K web 主入口(没有设备桥)不出现 Unit 段
 *   L 不出视口、不压头像:1200×720 / 1200×520 × 缩放 1 / 1.1,Unit 多了只滚 Unit 段;名册刷新变高后重新夹位置
 * 顺带拍截图(浅色 / 深色 / 青绿配色 / 英文 / 缩放 110%)到 UNITPANEL_SHOT_DIR。
 *
 * 跑:npm run check:unitpanel(HARNESS_URL 指向本检出起的 vite;没起就在 5173 自起,跑完自收)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try {
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch { /* fallthrough */ }
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?ribbon&unit&unitpanel`
const SHOT_DIR = process.env.UNITPANEL_SHOT_DIR || os.tmpdir()

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const POP = '.account-pop'
const UNITS = '[data-testid="account-units"]'

async function boot(page, extra = '', { expanded = true } = {}) {
  await page.goto(`${URL}${extra}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.rb-bottom .unitsw-pill', { timeout: 20000 })
  await page.evaluate((e) => { window.__rb.setState({ expanded: e }) }, expanded)
  await page.waitForSelector(expanded ? '.account-card' : '.ribbon-account', { timeout: 10000 })
  // 账号卡的 authStatus 桩回来才是「已登录」(之前点 = 去登录)
  await page.waitForFunction(() => !!document.querySelector('.account-card .account-name, .ribbon-account .account-avatar') && !/登录|Sign in/.test(document.querySelector('.account-card .account-name')?.textContent ?? 'x'), null, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(150)
}
async function openPanel(page) {
  // 整窗形态看着别的设备时,本机账号卡被远程面盖住:点宿主画在左下角的那枚头像(.unitfr-avatar)
  const framed = await page.evaluate(() => !!document.querySelector('.unitrs--whole:not(.unitrs-hidden) .unitfr-avatar'))
  await page.click(framed ? '.unitfr-avatar' : '.account-card, .ribbon-account')
  await page.waitForSelector(POP, { timeout: 5000 })
  await page.waitForTimeout(450) // 液滴流出
}
const panelOpen = (page) => page.evaluate((s) => !!document.querySelector(s), POP)
async function closedSoon(page) {
  await page.waitForFunction((s) => !document.querySelector(s), POP, { timeout: 3000 }).catch(() => {})
  return !(await panelOpen(page))
}
const readUnits = (page) => page.evaluate((sel) => {
  const box = document.querySelector(sel)
  if (!box) return null
  return Array.from(box.querySelectorAll('.ap-sec, .ap-item, .ap-unit-note')).map((n) => ({
    sec: n.classList.contains('ap-sec'),
    name: (n.querySelector('.ap-unit-name') ?? n).textContent.trim(),
    state: n.querySelector('.ap-unit-state')?.textContent.trim() ?? '',
    check: !!n.querySelector('.ap-unit-check'),
    off: n.classList.contains('ap-unit--off'),
    current: n.getAttribute('aria-current') === 'true',
    fold: n.classList.contains('ap-unit-fold') ? n.getAttribute('aria-expanded') : null,
    emoji: n.querySelector('.unitsw-emoji')?.textContent ?? '',
    note: n.classList.contains('ap-unit-note'),
  }))
}, UNITS)
const clickUnit = (page, name) => page.evaluate(([sel, n]) => {
  const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => (r.querySelector('.ap-unit-name') ?? r).textContent.trim() === n)
  if (!row) throw new Error(`no row ${n}`)
  row.click()
}, [UNITS, name])
const remoteState = (page) => page.evaluate(() => {
  const s = window.__unitRemote.getState()
  return { active: s.active, key: s.target?.key ?? null, src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '' }
})
/** 面板几何(视口 px):整张在 [8, vh-8] 内、底边不压头像、退出登录那行在面板里看得见。 */
const geometry = (page) => page.evaluate(() => {
  const pop = document.querySelector('.account-pop')
  const avatar = document.querySelector('.account-card, .ribbon-account')
  const list = document.querySelector('.ap-units-list')
  const items = Array.from(pop.querySelectorAll('.ap-item'))
  const last = items[items.length - 1]
  const p = pop.getBoundingClientRect(), a = avatar.getBoundingClientRect(), l = last.getBoundingClientRect()
  const head = pop.querySelector('.ap-head').getBoundingClientRect()
  return {
    top: p.top, bottom: p.bottom, left: p.left, right: p.right, width: p.width, vh: window.innerHeight, vw: window.innerWidth,
    avatarTop: a.top, zoom: document.body.currentCSSZoom || 1,
    lastText: last.textContent.trim(), lastVisible: l.top >= p.top - 0.5 && l.bottom <= p.bottom + 0.5,
    headVisible: head.top >= p.top - 0.5 && head.bottom <= p.bottom + 0.5,
    listScrolls: list.scrollHeight > list.clientHeight + 1,
    bodyScrolls: (() => { const b = pop.querySelector('.ap-body'); return b.scrollHeight > b.clientHeight + 1 })(),
  }
})
function inside(g) {
  return g.top >= 8 - 0.5 && g.bottom <= g.vh - 8 + 0.5 && g.left >= 0 && g.right <= g.vw && g.bottom <= g.avatarTop + 0.5
}

async function shot(page, name) {
  await page.mouse.move(1150, 40)
  await page.waitForTimeout(250)
  const file = path.join(SHOT_DIR, `unit-panel-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shots = []
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 720 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear())
    await boot(page)
    await openPanel(page)
    await page.waitForFunction((s) => document.querySelectorAll(`${s} .ap-item`).length >= 4, UNITS, { timeout: 5000 }).catch(() => {})

    // ── A 分组与排序 ──
    const order = await page.evaluate(() => {
      const body = document.querySelector('.account-pop > .ap-body')
      const kids = Array.from(body?.children ?? [])
      const items = Array.from(document.querySelectorAll('.account-pop .ap-item'))
      return {
        first: kids[0]?.getAttribute('data-testid') ?? '', second: kids[1]?.className ?? '',
        divider: (() => { const u = kids[0]; return !!u && parseFloat(getComputedStyle(u).borderBottomWidth) > 0 })(),
        quotaAfter: (() => { const u = kids.findIndex((k) => k.getAttribute('data-testid') === 'account-units'); const q = kids.findIndex((k) => k.textContent.includes('AI 额度')); return q > u && u >= 0 })(),
        last: items[items.length - 1]?.textContent.trim() ?? '',
        width: document.querySelector('.account-pop').getBoundingClientRect().width,
        manageLast: (() => { const box = document.querySelector('[data-testid="account-units"]'); const b = Array.from(box.querySelectorAll('.ap-item')); return b[b.length - 1]?.textContent.trim() })(),
      }
    })
    check('A Unit 段在最上面 → 分隔线 → 账号头部 → 账号项(AI 额度在 Unit 段之后),退出登录最后一行',
      order.first === 'account-units' && order.divider && order.second.includes('ap-head') && order.quotaAfter && order.last === '退出登录', JSON.stringify(order))
    check('A 面板宽 320', Math.abs(order.width - 320) < 1, String(order.width))
    check('A Unit 段末行 =「管理 Unit…」', order.manageLast === '管理 Unit…', order.manageLast)
    // 探针桩异步点亮客厅 mini(云端不在线、直连探得通 → 走直连,不算离线)
    await page.waitForFunction((s) => Array.from(document.querySelectorAll(`${s} .ap-unit-name`)).some((n) => n.textContent.trim() === '客厅 mini'), UNITS, { timeout: 5000 }).catch(() => {})
    let rows = await readUnits(page)
    const names = rows.map((r) => (r.sec ? `#${r.name}` : r.name))
    check('A 分组:这台电脑 / 我的设备(走得通的在前,含只剩直连的)/ 离线折叠 / 管理',
      JSON.stringify(names) === JSON.stringify(['#这台电脑', '这台电脑', '#我的设备', 'MacBook Air', '客厅 mini', '离线 1 台', '管理 Unit…']), JSON.stringify(names))
    // ── B 勾选态 + 行的构成 ──
    const local = rows[1], mba = rows[3]
    check('B 没在看别的设备:「这台电脑」打勾', local.check && local.current, JSON.stringify(local))
    check('B 在线行 = emoji 图标 + 名字 + 灰字「在线 · 中转」(没选过、云端在线 → 中转,探通了也不改直连),不打勾',
      mba.emoji === '🦊' && mba.state === '在线 · 中转' && !mba.check && !mba.off, JSON.stringify(mba))
    check('B 云端不在线、直连探得通 → 灰字「在线 · 直连」,不算离线', rows[4].state === '在线 · 直连' && !rows[4].off, JSON.stringify(rows[4]))
    check('C 手机 / 本机不列;离线缺省折起', !names.some((n) => n.includes('Pixel')) && !names.some((n) => n.includes('书房')) && rows[5].fold === 'false')
    shots.push(await shot(page, 'light'))

    // ── C 展开离线 ──
    await page.click(`${UNITS} .ap-unit-fold`)
    rows = await readUnits(page)
    const pc = rows.find((r) => r.name === '书房 PC'), mini = rows.find((r) => r.name === '客厅 mini')
    check('C 点开「离线 1 台」→ 书房 PC 灰显、灰字「离线」(客厅 mini 留在外面)', pc?.off && pc.state === '离线' && !mini?.off && rows.indexOf(mini) < rows.indexOf(pc), JSON.stringify([pc, mini]))

    // ── D 点离线行 ──
    await clickUnit(page, '书房 PC')
    await page.waitForTimeout(150)
    rows = await readUnits(page)
    const r0 = await remoteState(page)
    check('D 点离线行:不切、面板留着、就地说「那台没开 Forsion」',
      !r0.active && (await panelOpen(page)) && rows.some((r) => r.note && r.name === '那台没开 Forsion'), JSON.stringify({ r0, notes: rows.filter((r) => r.note) }))

    // ── E 点在线行 ──
    await clickUnit(page, 'MacBook Air')
    const closedE = await closedSoon(page)
    const r1 = await remoteState(page)
    check('E 点在线行:窗口切到那台(隧道页)、面板关闭',
      closedE && r1.active && r1.key === 'u-mba:tunnel' && r1.src === 'https://cloud.test/api/units/u-mba/proxy/', JSON.stringify({ closedE, r1 }))
    await openPanel(page)
    rows = await readUnits(page)
    const mba2 = rows.find((r) => r.name === 'MacBook Air'), local2 = rows.find((r) => !r.sec && r.name === '这台电脑')
    check('E 再开:正在看的那台打勾、没有灰字;「这台电脑」不勾', mba2?.check && mba2.current && mba2.state === '' && !local2.check, JSON.stringify({ mba2, local2 }))

    // ── F 点远程面 / 失焦 ──
    const surf = await page.evaluate(() => { const r = document.querySelector('.unitrs').getBoundingClientRect(); return { x: r.right - 60, y: r.top + 60 } })
    await page.mouse.click(surf.x, surf.y)
    check('F 面板开着点远程面 → 面板关闭', await closedSoon(page))
    await openPanel(page)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    check('F 窗口失焦(点进 <webview> 在宿主侧就是 blur)→ 面板关闭', await closedSoon(page))

    // ── G 正在看的那台掉线 / 手输地址 ──
    await page.evaluate(() => window.__runUnitRoute({ kind: 'unit', id: 'u-pc', name: '书房 PC', icon: null, platform: 'win32', via: 'tunnel' }))
    await openPanel(page)
    rows = await readUnits(page)
    const gNames = rows.map((r) => (r.sec ? `#${r.name}` : r.name))
    const pc2 = rows.find((r) => r.name === '书房 PC')
    check('G 正在看的那台掉线了也不折(在外面、打勾),折叠没了(唯一一台离线的就是它)',
      gNames.indexOf('书房 PC') > -1 && !gNames.some((n) => n.startsWith('离线')) && pc2.check && !pc2.off, JSON.stringify(gNames))
    shots.push(await shot(page, 'viewing-offline'))
    await page.keyboard.press('Escape')
    await closedSoon(page)
    await page.evaluate(() => window.__runUnitRoute({ kind: 'addr', url: 'http://192.168.1.77:8791/' }))
    await openPanel(page)
    rows = await readUnits(page)
    const addr = rows.find((r) => r.name === '192.168.1.77:8791')
    check('G 手输地址的目标正看着:单独一行、打勾', !!addr?.check && addr.current, JSON.stringify(rows.map((r) => r.name)))

    // ── H 点「这台电脑」回本机 ──
    await clickUnit(page, '这台电脑')
    const closedH = await closedSoon(page)
    const r2 = await remoteState(page)
    const pill = await page.evaluate(() => document.querySelector('.unitsw-pill .unitsw-name')?.textContent?.trim())
    check('H 点「这台电脑」:远程面收起(保活)、面板关、胶囊回「本地」', closedH && !r2.active && !!r2.src && pill === '本地', JSON.stringify({ closedH, r2, pill }))

    // ── I 右键 ──
    await openPanel(page)
    await page.evaluate((sel) => {
      const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => r.textContent.includes('MacBook Air'))
      const b = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 120, clientY: b.top + 10 }))
    }, UNITS)
    await page.waitForSelector('.ap-unit-ctx', { timeout: 3000 }).catch(() => {})
    const ctxItems = await page.evaluate(() => Array.from(document.querySelectorAll('.ap-unit-ctx button')).map((b) => b.textContent.trim()))
    check('I 右键五项:切换到这台 / 在新窗口打开 / 添加到桌面 / 改名字 / 改图标(.ctx-menu 样式)',
      JSON.stringify(ctxItems) === JSON.stringify(['切换到这台', '在新窗口打开', '添加到桌面', '改名字', '改图标']) && await page.evaluate(() => !!document.querySelector('.ctx-menu.ap-unit-ctx')), JSON.stringify(ctxItems))
    // 点面板里(菜单外)→ 只收菜单
    const headBox = await page.evaluate(() => { const r = document.querySelector('.account-pop .ap-sec').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })
    await page.mouse.click(headBox.x, headBox.y)
    await page.waitForTimeout(150)
    check('I 点菜单外(面板里)→ 只收右键菜单,面板留着', !(await page.evaluate(() => !!document.querySelector('.ap-unit-ctx'))) && await panelOpen(page))
    await page.evaluate((sel) => {
      const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }))
    }, UNITS)
    await page.waitForSelector('.ap-unit-ctx', { timeout: 3000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('I Esc → 只收右键菜单,面板留着', !(await page.evaluate(() => !!document.querySelector('.ap-unit-ctx'))) && await panelOpen(page))
    // 「改名字」/「改图标」各弹一个输入框:改名只带 name,且只弹一次(没有第二个框);改图标只带 icon
    const ctxOn = async () => {
      if (!(await panelOpen(page))) await openPanel(page)
      await page.evaluate((sel) => {
        const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => r.textContent.includes('MacBook Air'))
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }))
      }, UNITS)
      await page.waitForSelector('.ap-unit-ctx', { timeout: 3000 })
    }
    const answer = async (text) => {
      const input = await page.waitForSelector('.dialog-overlay input', { timeout: 3000 }).catch(() => null)
      if (!input) return false
      await input.fill(text)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      return true
    }
    await ctxOn()
    await page.click('.ap-unit-ctx button:nth-child(4)')
    const asked1 = await answer('书桌 Air')
    const secondDialog = await page.evaluate(() => !!document.querySelector('.dialog-overlay input'))
    let updates = await page.evaluate(() => window.__unitUpdates.slice())
    check('I「改名字」→ 面板关、只弹一个输入框,unitsUpdate(id, { name })',
      asked1 && !secondDialog && !(await panelOpen(page)) && JSON.stringify(updates) === JSON.stringify([['u-mba', { name: '书桌 Air' }]]), JSON.stringify({ secondDialog, updates }))
    await ctxOn()
    await page.click('.ap-unit-ctx button:nth-child(5)')
    const asked2 = await answer('🐼')
    updates = await page.evaluate(() => window.__unitUpdates.slice())
    check('I「改图标」→ 只带 icon,unitsUpdate(id, { icon })',
      asked2 && JSON.stringify(updates[1]) === JSON.stringify(['u-mba', { icon: '🐼' }]) && updates.length === 2, JSON.stringify(updates))
    // 右键「切换到这台」
    await openPanel(page)
    await page.evaluate((sel) => {
      const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => r.textContent.includes('MacBook Air'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }))
    }, UNITS)
    await page.waitForSelector('.ap-unit-ctx', { timeout: 3000 })
    await page.click('.ap-unit-ctx button:nth-child(1)')
    const r3 = await remoteState(page)
    check('I 右键「切换到这台」→ 切过去、面板关', (await closedSoon(page)) && r3.active && r3.key === 'u-mba:tunnel', JSON.stringify(r3))
    await page.evaluate(() => window.__unitRemote.getState().hide())

    // ── K 新窗口入口(第二包):在线行悬停 / 键盘聚焦才露「在新窗口打开」;右键「在新窗口打开」「添加到桌面」离线行也有,手输地址那行没有 ──
    await page.evaluate(() => { window.__unitWinCalls.length = 0 })
    await openPanel(page)
    const newwin = (name) => page.evaluate(([sel, n]) => {
      const wrap = Array.from(document.querySelectorAll(`${sel} .ap-unit-wrap`)).find((w) => w.querySelector('.ap-unit-name')?.textContent.trim() === n)
      const b = wrap?.querySelector('.ap-unit-newwin')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { opacity: getComputedStyle(b).opacity, pe: getComputedStyle(b).pointerEvents, title: b.getAttribute('title'), x: r.left + r.width / 2, y: r.top + r.height / 2,
        stateHidden: getComputedStyle(wrap.querySelector('.ap-unit-state') ?? wrap).visibility === 'hidden' }
    }, [UNITS, name])
    await page.mouse.move(5, 5)
    const idle = await newwin('MacBook Air')
    check('K 在线行的「在新窗口打开」不常驻(没悬停时透明且点不到)', !!idle && idle.opacity === '0' && idle.pe === 'none', JSON.stringify(idle))
    const rowBox = await page.evaluate((sel) => { const r = Array.from(document.querySelectorAll(`${sel} .ap-unit-wrap`)).find((w) => w.textContent.includes('MacBook Air')).getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 } }, UNITS)
    await page.mouse.move(rowBox.x, rowBox.y)
    await page.waitForTimeout(120)
    const hover = await newwin('MacBook Air')
    check('K 悬停在线行 → 行尾出现「在新窗口打开」(带 tooltip),盖住灰字', !!hover && hover.opacity === '1' && hover.pe === 'auto' && hover.title === '在新窗口打开' && hover.stateHidden, JSON.stringify(hover))
    await page.mouse.move(5, 5)
    await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .ap-unit-wrap`)).find((w) => w.textContent.includes('MacBook Air')).querySelector('.ap-unit').focus(), UNITS)
    const focused = await newwin('MacBook Air')
    check('K 键盘聚焦在线行 → 同样出现', !!focused && focused.opacity === '1', JSON.stringify(focused))
    const offlineHasBtn = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .ap-unit--off`)).some((r) => r.parentElement?.querySelector('.ap-unit-newwin')), UNITS)
    check('K 离线行没有悬停按钮', !offlineHasBtn)
    await page.mouse.move(rowBox.x, rowBox.y)
    await page.waitForTimeout(120)
    const hv = await newwin('MacBook Air')
    await page.mouse.click(hv.x, hv.y)
    let wc = await page.evaluate(() => window.__unitWinCalls.slice())
    check('K 点悬停按钮 → unitsOpenWindow(那台的 id)、面板关、不切换主窗', (await closedSoon(page)) && JSON.stringify(wc) === JSON.stringify([['window', 'u-mba']]) && !(await remoteState(page)).active, JSON.stringify(wc))
    // 离线行(展开折叠)的右键:两项照样可用
    await openPanel(page)
    if ((await page.evaluate((sel) => document.querySelector(`${sel} .ap-unit-fold`)?.getAttribute('aria-expanded'), UNITS)) === 'false') await page.click(`${UNITS} .ap-unit-fold`)
    const offCtx = async () => {
      if (!(await panelOpen(page))) await openPanel(page)
      if ((await page.evaluate((sel) => document.querySelector(`${sel} .ap-unit-fold`)?.getAttribute('aria-expanded'), UNITS)) === 'false') await page.click(`${UNITS} .ap-unit-fold`)
      await page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .ap-unit--off`)
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }))
      }, UNITS)
      await page.waitForSelector('.ap-unit-ctx', { timeout: 3000 })
    }
    await offCtx()
    const offItems = await page.evaluate(() => Array.from(document.querySelectorAll('.ap-unit-ctx button')).map((b) => b.textContent.trim()))
    const offId = await page.evaluate((sel) => document.querySelector(`${sel} .ap-unit--off`).getAttribute('data-unit-id'), UNITS)
    check('K 离线行右键照样有「在新窗口打开」「添加到桌面」', offItems.includes('在新窗口打开') && offItems.includes('添加到桌面'), JSON.stringify(offItems))
    await page.click('.ap-unit-ctx [data-unit-act="window"]')
    await closedSoon(page)
    await offCtx()
    await page.click('.ap-unit-ctx [data-unit-act="desktop"]')
    await page.waitForFunction(() => window.__unitWinCalls.length >= 3, null, { timeout: 8000 }).catch(() => {})
    wc = await page.evaluate(() => window.__unitWinCalls.slice())
    check('K 离线行「在新窗口打开」→ unitsOpenWindow(离线那台)', JSON.stringify(wc[1]) === JSON.stringify(['window', offId]), JSON.stringify(wc))
    check('K「添加到桌面」→ 只交 id + 兜底名 + 画好的 PNG 图标,**不交名字**', JSON.stringify(wc[2]) === JSON.stringify(['desktop', offId, 'fallbackName,iconPng,id', 'png']), JSON.stringify(wc[2]))
    // 手输地址那行:没有右键菜单
    await page.evaluate(() => window.__runUnitRoute({ kind: 'addr', url: 'http://192.168.1.77:8791/' }))
    await openPanel(page)
    await page.evaluate((sel) => {
      const row = Array.from(document.querySelectorAll(`${sel} .ap-item`)).find((r) => r.textContent.includes('192.168.1.77'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }))
    }, UNITS)
    await page.waitForTimeout(200)
    check('K 手输地址那行没有右键(也就没有新窗口 / 桌面两项)', !(await page.evaluate(() => !!document.querySelector('.ap-unit-ctx'))))
    // 远程面开着时焦点在 webview 里,宿主收不到 Esc:再点一次头像收面板
    await page.click('.unitfr-avatar')
    await closedSoon(page)
    await page.evaluate(() => window.__unitRemote.getState().hide())
    await page.waitForTimeout(450) // 液滴缩回

    // ── J 管理 Unit… ──
    await openPanel(page)
    await clickUnit(page, '管理 Unit…')
    const tab = await page.evaluate(() => window.__forsionStore?.getState().settingsTab ?? null)
    check('J「管理 Unit…」→ 设置 › 设备、面板关', (await closedSoon(page)) && tab === 'units' && await page.evaluate(() => !!document.querySelector('.unitset-page')), String(tab))
    await page.evaluate(() => window.__forsionStore?.getState().closeSettings?.())

    // ── L 几何 ──
    for (const [h, z, many] of [[720, 1, false], [520, 1, true], [720, 1.1, true], [520, 1.1, true], [720, 1, true]]) {
      await page.setViewportSize({ width: 1200, height: h })
      await boot(page, many ? '&many' : '')
      if (z !== 1) await page.evaluate((v) => { document.body.style.zoom = String(v); window.dispatchEvent(new Event('forsion:uizoom')) }, z)
      await page.waitForTimeout(150)
      await openPanel(page)
      await page.waitForFunction((s) => document.querySelectorAll(`${s} .ap-item`).length >= 4, UNITS, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(250)
      const g = await geometry(page)
      const tag = `${1200}×${h} 缩放 ${z}${many ? ' · 20 台' : ''}`
      check(`L 不出视口、不压头像(${tag})`, inside(g), JSON.stringify(g))
      check(`L 宽 = 320 × 缩放(${tag})`, Math.abs(g.width - 320 * z) < 1.5, String(g.width))
      if (many) check(`L Unit 多了只滚 Unit 段:列表可滚、账号头 / 退出登录都在面板里、整张不滚(${tag})`, g.listScrolls && !g.bodyScrolls && g.headVisible && g.lastVisible && g.lastText === '退出登录', JSON.stringify(g))
      if (h === 720 && z === 1.1 && many) shots.push(await shot(page, 'zoom110'))
    }
    // 名册刷新后变高:打开时只有 2 台,刷新回来 20 台 → 重新夹位置
    await page.setViewportSize({ width: 1200, height: 720 })
    await boot(page)
    await openPanel(page)
    const before = await geometry(page)
    await page.evaluate(async () => {
      for (let i = 1; i <= 18; i++) window.__units.push({ id: `late-${i}`, name: `Late ${i}`, platform: 'linux', icon: null, online: true, lanUrl: null })
      await window.__roster.getState().refresh()
    })
    await page.waitForTimeout(300)
    const after = await geometry(page)
    check('L 名册刷新变高后重新夹位置(仍在视口内、不压头像、列表改为可滚)', after.bottom - after.top > before.bottom - before.top + 20 && inside(after) && after.listScrolls, JSON.stringify({ before: [before.top, before.bottom], after }))

    // ── M Ribbon 收起态(缺省形态:紧凑头像)──
    for (const [h, z] of [[720, 1], [520, 1], [720, 1.1], [520, 1.1]]) {
      await page.setViewportSize({ width: 1200, height: h })
      await boot(page, '&many', { expanded: false })
      if (z !== 1) await page.evaluate((v) => { document.body.style.zoom = String(v); window.dispatchEvent(new Event('forsion:uizoom')) }, z)
      await page.waitForTimeout(150)
      await openPanel(page)
      await page.waitForFunction((s) => document.querySelectorAll(`${s} .ap-item`).length >= 4, UNITS, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(250)
      const g = await geometry(page)
      const tag = `收起态 1200×${h} 缩放 ${z} · 20 台`
      check(`M 不出视口、不压头像、只滚 Unit 段(${tag})`, inside(g) && Math.abs(g.width - 320 * z) < 1.5 && g.listScrolls && !g.bodyScrolls && g.lastVisible, JSON.stringify(g))
    }
    await page.setViewportSize({ width: 1200, height: 720 })
    await boot(page, '', { expanded: false })
    await openPanel(page)
    shots.push(await shot(page, 'collapsed'))
    await page.keyboard.press('Escape')
    await closedSoon(page)
    // 正看着别的设备:真点击头像不许把远程面踢回本机(远程面会把 .rb-slot 上的点击当「回本机」);
    // 面板画在远程面之上,真点击「这台电脑」那一行能点到(不被远程面拦)并回到本机
    await page.evaluate(() => window.__runUnitRoute({ kind: 'unit', id: 'u-mba', name: 'MacBook Air', icon: '🦊', platform: 'darwin', via: 'tunnel' }))
    await page.waitForTimeout(150)
    await openPanel(page)
    const rM = await remoteState(page)
    check('M 收起态:正看着别的设备时点头像 → 远程面还在、面板打开', rM.active && (await panelOpen(page)), JSON.stringify(rM))
    shots.push(await shot(page, 'collapsed-viewing'))
    const onTop = await page.evaluate(() => {
      const row = document.querySelector('[data-unit-local]')
      const b = row.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return !!hit && row.contains(hit)
    })
    await page.click('[data-unit-local]', { timeout: 3000 })
    const rM2 = await remoteState(page)
    check('M 面板压在远程面之上,真点击「这台电脑」→ 回到本机、面板关', onTop && (await closedSoon(page)) && !rM2.active, JSON.stringify({ onTop, rM2 }))

    // ── N 整窗的框(UNIT_SURFACE_WHOLE):左下角宿主头像 + 角标、标题条胶囊、失败态与回落、记住的通路、弹窗让路 ──
    const fire = (name, props = {}) => page.evaluate(([n, p]) => { const e = new Event(n); Object.assign(e, p); document.querySelector('.unitrs-web').dispatchEvent(e) }, [name, props])
    const frameAvatar = () => page.evaluate(() => {
      const a = document.querySelector('.unitfr-avatar')
      if (!a) return null
      const r = a.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, visible: getComputedStyle(a).visibility === 'visible', badge: a.querySelector('.unitfr-badge')?.textContent ?? null }
    })
    for (const z of [1, 1.1]) {
      await page.setViewportSize({ width: 1200, height: 720 })
      await boot(page, '', { expanded: false })
      if (z !== 1) await page.evaluate((v) => { document.body.style.zoom = String(v); window.dispatchEvent(new Event('forsion:uizoom')) }, z)
      await page.waitForTimeout(150)
      const local = await page.evaluate(() => { const r = document.querySelector('.ribbon-account').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
      const before = await frameAvatar()
      await page.evaluate(() => window.__runUnitRoute({ kind: 'unit', id: 'u-mba', name: 'MacBook Air', icon: '🦊', platform: 'darwin', via: 'tunnel' }))
      await page.waitForSelector('.unitfr-avatar', { timeout: 5000 })
      const fa = await frameAvatar()
      const d = { dx: +(fa.x - local.x).toFixed(2), dy: +(fa.y - local.y).toFixed(2), dw: +(fa.w - local.w).toFixed(2) }
      check(`N 宿主头像盖在本机折叠态账号槽上(差 ≤ 1px,缩放 ${z})`, Math.abs(d.dx) <= 1 && Math.abs(d.dy) <= 1 && Math.abs(d.dw) <= 1, JSON.stringify({ d, local, fa }))
      if (z === 1) {
        check('N 角标只在远程面激活时出现(那台的图标)', before === null && fa.visible && fa.badge === '🦊', JSON.stringify({ before, fa }))
        await page.click('.unitfr-avatar')
        await page.waitForSelector(POP, { timeout: 5000 })
        await page.waitForTimeout(450)
        rows = await readUnits(page)
        const anchored = await page.evaluate(() => { const p = document.querySelector('.account-pop').getBoundingClientRect(); const a = document.querySelector('.unitfr-avatar').getBoundingClientRect(); return { gap: +(a.top - p.bottom).toFixed(2) } })
        const mbaN = rows.find((r) => r.name === 'MacBook Air')
        check('N 点宿主头像 → 本机账号面板,锚在这枚头像上、打勾的是那台', mbaN?.check && !rows.find((r) => !r.sec && r.name === '这台电脑').check && anchored.gap >= -0.5 && anchored.gap < 2, JSON.stringify({ anchored, mbaN }))
        shots.push(await shot(page, 'frame-panel'))
        await page.click('.unitfr-avatar')
        check('N 再点宿主头像 → 面板收起', await closedSoon(page))
        check('N 看着别的设备时本机弹窗 / 上手提示让路(popupQueue.blocked)', await page.evaluate(() => window.__popupQueue.getState().blocked))
        await page.click('.unitfr-back')
        await page.waitForTimeout(150)
        const afterBack = await frameAvatar()
        check('N 回到本机:角标(连同宿主头像)收起,弹窗不再挡', !afterBack?.visible && !(await page.evaluate(() => window.__popupQueue.getState().blocked)), JSON.stringify(afterBack))
      }
    }
    await page.evaluate(() => { document.body.style.zoom = ''; window.dispatchEvent(new Event('forsion:uizoom')) })

    // 记住的通路:设置页明确点「直连」且加载成功 → 记下;面板灰字跟着写「在线 · 直连」,点下去走直连
    await page.evaluate(() => localStorage.removeItem('forsion_unit_via:u-mba'))
    await page.evaluate(() => window.__runUnitRoute({ kind: 'unit', id: 'u-mba', name: 'MacBook Air', icon: '🦊', platform: 'darwin', via: 'lan', lanUrl: 'http://192.168.1.20:8791', explicit: true }))
    await page.waitForTimeout(100)
    await fire('did-fail-load', { errorCode: -3, isMainFrame: true }) // ABORTED 不算失败
    await fire('did-finish-load')
    const remembered = await page.evaluate(() => localStorage.getItem('forsion_unit_via:u-mba'))
    check('A 设置页明确选的直连、加载成功 → 记住(-3 ABORTED 不算失败)', remembered === 'lan', String(remembered))
    await page.click('.unitfr-back')
    await openPanel(page)
    rows = await readUnits(page)
    check('A 记住直连 + 探针通 → 面板灰字「在线 · 直连」', rows.find((r) => r.name === 'MacBook Air')?.state === '在线 · 直连', JSON.stringify(rows.find((r) => r.name === 'MacBook Air')))
    await clickUnit(page, 'MacBook Air')
    const rLan = await remoteState(page)
    check('A 点它 → 走直连', rLan.key === 'u-mba:lan' && rLan.src === 'http://192.168.1.20:8791/', JSON.stringify(rLan))
    // 主框架加载失败 → 这台在线 → 出声改走中转
    await fire('did-fail-load', { errorCode: -105, isMainFrame: true })
    await page.waitForTimeout(150)
    const rFb = await remoteState(page)
    check('A 直连加载失败、这台在线 → 自动改走中转', rFb.active && rFb.key === 'u-mba:tunnel' && rFb.src.endsWith('/api/units/u-mba/proxy/'), JSON.stringify(rFb))
    check('A 面板行自己走出来的 / 回落的中转不算「选」,记住的仍是直连', (await page.evaluate(() => localStorage.getItem('forsion_unit_via:u-mba'))) === 'lan')
    // 中转也失败 → 宿主画的失败态
    await fire('did-fail-load', { errorCode: -105, isMainFrame: true })
    await page.waitForSelector('.unitfr-fail', { timeout: 3000 }).catch(() => {})
    const failA = await page.evaluate(() => ({ text: document.querySelector('.unitfr-fail')?.textContent ?? '', avatar: getComputedStyle(document.querySelector('.unitfr-avatar')).visibility }))
    check('B5 中转还失败 →「连不上这台设备」+ 重试 + 回到这台电脑,头像照常', failA.text === '连不上这台设备重试回到这台电脑' && failA.avatar === 'visible', JSON.stringify(failA))
    shots.push(await shot(page, 'frame-fail'))
    await page.evaluate(() => { document.querySelector('.unitrs-web').__beforeRetry = 1 })
    await page.click('.unitfr-fail .btn.primary')
    await page.waitForTimeout(150)
    // 「重挂」= 换了一个新的 webview 节点(旧节点上的记号不在了),不是只看节点还在(Codex 评审:原断言去掉重挂也会过)
    check('B5 重试 → 失败态收起、页面重挂', !(await page.evaluate(() => !!document.querySelector('.unitfr-fail'))) && (await page.evaluate(() => { const w = document.querySelector('.unitrs-web'); return !!w && w.__beforeRetry !== 1 })))
    await fire('render-process-gone')
    await page.waitForSelector('.unitfr-fail', { timeout: 3000 }).catch(() => {})
    const crash = await page.evaluate(() => document.querySelector('.unitfr-fail-title')?.textContent ?? '')
    check('B5 渲染进程没了 → 失败态', crash === '这台设备的页面停止响应了', crash)
    await page.click('.unitfr-fail .btn:not(.primary)')
    await page.waitForTimeout(150)
    check('B5 失败态里「回到这台电脑」可点 → 回本机', !(await remoteState(page)).active)
    // 记住直连、这次探针不通 → 灰字「在线 · 中转」,点下去走中转
    await page.evaluate(async () => { window.tangu.unitsProbeLan = async () => null; await window.__roster.getState().refresh(); await new Promise((r) => setTimeout(r, 50)) })
    await openPanel(page)
    rows = await readUnits(page)
    check('A 记住直连、这次探针不通 → 灰字「在线 · 中转」', rows.find((r) => r.name === 'MacBook Air')?.state === '在线 · 中转', JSON.stringify(rows.find((r) => r.name === 'MacBook Air')))
    await clickUnit(page, 'MacBook Air')
    check('A 点它 → 这次走中转', (await remoteState(page)).key === 'u-mba:tunnel')
    await page.evaluate(() => { window.__unitRemote.getState().hide(); localStorage.removeItem('forsion_unit_via:u-mba') })

    // ── R 回到本机以后,迟到的东西不许把远程面重新打开;同一张已加载的页面被明确选中要记住(Codex 评审三条)──
    const lanRoute = { kind: 'unit', id: 'u-mba', name: 'MacBook Air', icon: '🦊', platform: 'darwin', via: 'lan', lanUrl: 'http://192.168.1.20:8791' }
    const tunRoute = { kind: 'unit', id: 'u-mba', name: 'MacBook Air', icon: '🦊', platform: 'darwin', via: 'tunnel' }
    // R1 直连页还没加载完就回本机,保活在暗处的页面这时才失败:不回落、不激活;用户回到这台才回落中转
    await page.evaluate((r) => window.__runUnitRoute(r), lanRoute)
    await page.waitForTimeout(100)
    await page.click('.unitfr-back')
    await page.waitForTimeout(100)
    await fire('did-fail-load', { errorCode: -105, isMainFrame: true })
    await page.waitForTimeout(200)
    const rHid = await remoteState(page)
    check('R1 保活在暗处的页面加载失败 → 不把人拽回设备页、目标不换', !rHid.active && rHid.key === 'u-mba:lan', JSON.stringify(rHid))
    await page.evaluate((r) => window.__runUnitRoute(r), lanRoute)
    await page.waitForTimeout(200)
    const rBackIn = await remoteState(page)
    check('R1 用户回到那台 → 这时才回落中转', rBackIn.active && rBackIn.key === 'u-mba:tunnel', JSON.stringify(rBackIn))
    // R2 正看着 A,选了 B 的 P2P,打洞期间回本机:迟到的成功回包 / 失败回落都不再打开远程面
    for (const how of ['res', 'rej']) {
      await page.evaluate(() => { window.__p2p = {}; window.tangu.unitsP2pOpen = () => new Promise((res, rej) => { window.__p2p.res = res; window.__p2p.rej = rej }) })
      await page.evaluate((r) => window.__runUnitRoute(r), tunRoute)
      await page.waitForTimeout(100)
      await page.evaluate(() => window.__runUnitRoute({ kind: 'unit', id: 'u-b', name: 'B', platform: 'darwin', via: 'p2p' }))
      await page.waitForTimeout(50)
      await page.click('.unitfr-back')
      await page.evaluate((h) => { if (h === 'res') window.__p2p.res({ url: 'http://127.0.0.1:47123/' }); else window.__p2p.rej(new Error('打洞超时(桩)')) }, how)
      await page.waitForTimeout(200)
      const rP = await remoteState(page)
      check(`R2 打洞期间回到本机 → 迟到的${how === 'res' ? '成功回包' : '失败回落'}不再打开远程面`, !rP.active && rP.key === 'u-mba:tunnel', JSON.stringify(rP))
    }
    // R3 不是明确选的直连加载成功 → 不记;同一张已加载的页面随后在设置页被明确点中 → 不重载也记住
    await page.evaluate(() => localStorage.removeItem('forsion_unit_via:u-mba'))
    await page.evaluate((r) => window.__runUnitRoute(r), lanRoute)
    await page.waitForTimeout(100)
    await fire('did-finish-load')
    check('R3 不是明确选的 → 加载成功也不记', (await page.evaluate(() => localStorage.getItem('forsion_unit_via:u-mba'))) === null)
    await page.evaluate(() => { document.querySelector('.unitrs-web').__same = 1 })
    await page.evaluate((r) => window.__runUnitRoute({ ...r, explicit: true }), lanRoute)
    await page.waitForTimeout(150)
    const same = await page.evaluate(() => ({ kept: document.querySelector('.unitrs-web').__same === 1, via: localStorage.getItem('forsion_unit_via:u-mba') }))
    check('R3 同一张已加载成功的页面被明确选中 → 不重载也记住', same.kept && same.via === 'lan', JSON.stringify(same))
    await page.evaluate(() => { window.__unitRemote.getState().hide(); localStorage.removeItem('forsion_unit_via:u-mba') })

    // ── 截图:深色 / 青绿 / 英文 ──
    for (const [extra, name, opts] of [['&dark', 'dark', {}], ['&skin=teal', 'teal', {}], ['&lang=en', 'en', { locale: 'en-US' }]]) {
      const p2 = await browser.newPage({ locale: opts.locale || 'zh-CN', viewport: { width: 1200, height: 720 } })
      p2.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await p2.addInitScript(() => localStorage.clear())
      await boot(p2, extra)
      await openPanel(p2)
      await p2.waitForFunction((s) => document.querySelectorAll(`${s} .ap-item`).length >= 4, UNITS, { timeout: 5000 }).catch(() => {})
      if (name === 'en') {
        const en = await readUnits(p2)
        const enNames = en.map((r) => (r.sec ? `#${r.name}` : r.name))
        check('英文:This computer / My devices / Online · Relay / Online · Direct / 1 offline / Manage Units…',
          JSON.stringify(enNames) === JSON.stringify(['#This computer', 'This computer', '#My devices', 'MacBook Air', '客厅 mini', '1 offline', 'Manage Units…']) && en[3].state === 'Online · Relay' && en[4].state === 'Online · Direct', JSON.stringify({ enNames, s: en[3]?.state }))
      }
      shots.push(await shot(p2, name))
      await p2.close()
    }

    // ── K2 本机不进自己的列表(互联关着:unitId null,selfUnitId 认得出)──
    const ps = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 720 } })
    await ps.addInitScript(() => localStorage.clear())
    await boot(ps, '&self')
    await openPanel(ps)
    await ps.click(`${UNITS} .ap-unit-fold`).catch(() => {})
    const selfPanel = await ps.evaluate((s) => document.querySelector(s)?.textContent ?? '', UNITS)
    await ps.evaluate((s) => { const b = Array.from(document.querySelectorAll(`${s} .ap-item`)).find((r) => r.textContent.includes('管理 Unit')); b.click() }, UNITS)
    await ps.waitForSelector('.unitset-page', { timeout: 5000 }).catch(() => {})
    await ps.waitForTimeout(400)
    const selfSettings = await ps.evaluate(() => document.querySelector('.unitset-list')?.textContent ?? '')
    check('K2 本机(selfUnitId)不出现在面板、也不出现在设置 › 设备', !selfPanel.includes('本机自己') && selfPanel.includes('MacBook Air') && !!selfSettings && !selfSettings.includes('本机自己'), JSON.stringify({ panel: selfPanel.slice(0, 80), settings: selfSettings.slice(0, 80) }))
    await ps.close()

    // ── K web ──
    const pw = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 720 } })
    await pw.addInitScript(() => localStorage.clear())
    await boot(pw, '&web')
    await openPanel(pw)
    const web = await pw.evaluate(() => ({ units: !!document.querySelector('[data-testid="account-units"]'), wide: !!document.querySelector('.account-pop--units'), text: document.querySelector('.account-pop').textContent }))
    check('K web 主入口:账号面板里没有 Unit 段', !web.units && !web.wide && !web.text.includes('管理 Unit'), JSON.stringify({ units: web.units, wide: web.wide }))
    await pw.close()
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  console.log('截图:\n' + shots.join('\n'))
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : `\n✅ 全部通过(${results.length} 条)`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
