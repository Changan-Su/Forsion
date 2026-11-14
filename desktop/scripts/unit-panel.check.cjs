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
 *   I 右键三项「切换到这台」「改名字」「改图标」;点菜单外只收菜单、Esc 只收菜单;改名 / 改图标各走一次 unitsUpdate、只带自己那个字段
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
  await page.click('.account-card, .ribbon-account')
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
    let rows = await readUnits(page)
    const names = rows.map((r) => (r.sec ? `#${r.name}` : r.name))
    check('A 分组:这台电脑 / 我的设备(在线在前)/ 离线折叠 / 管理',
      JSON.stringify(names) === JSON.stringify(['#这台电脑', '这台电脑', '#我的设备', 'MacBook Air', '离线 2 台', '管理 Unit…']), JSON.stringify(names))
    // ── B 勾选态 + 行的构成 ──
    const local = rows[1], mba = rows[3]
    check('B 没在看别的设备:「这台电脑」打勾', local.check && local.current, JSON.stringify(local))
    check('B 在线行 = emoji 图标 + 名字 + 灰字「在线 · 中转」(临时规则只走中转),不打勾',
      mba.emoji === '🦊' && mba.state === '在线 · 中转' && !mba.check && !mba.off, JSON.stringify(mba))
    check('C 手机 / 本机不列;离线缺省折起', !names.some((n) => n.includes('Pixel')) && !names.some((n) => n.includes('书房')) && rows[4].fold === 'false')
    shots.push(await shot(page, 'light'))

    // ── C 展开离线 ──
    await page.click(`${UNITS} .ap-unit-fold`)
    rows = await readUnits(page)
    const pc = rows.find((r) => r.name === '书房 PC'), mini = rows.find((r) => r.name === '客厅 mini')
    check('C 点开「离线 2 台」→ 书房 PC / 客厅 mini 灰显、灰字「离线」', pc?.off && pc.state === '离线' && mini?.off && mini.state === '离线', JSON.stringify([pc, mini]))

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
    check('G 正在看的那台掉线了也不折(在外面、打勾),折叠剩「离线 1 台」',
      gNames.indexOf('书房 PC') > -1 && gNames.indexOf('书房 PC') < gNames.indexOf('离线 1 台') && pc2.check && !pc2.off, JSON.stringify(gNames))
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
    check('I 右键三项:切换到这台 / 改名字 / 改图标(.ctx-menu 样式)',
      JSON.stringify(ctxItems) === JSON.stringify(['切换到这台', '改名字', '改图标']) && await page.evaluate(() => !!document.querySelector('.ctx-menu.ap-unit-ctx')), JSON.stringify(ctxItems))
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
    await page.click('.ap-unit-ctx button:nth-child(2)')
    const asked1 = await answer('书桌 Air')
    const secondDialog = await page.evaluate(() => !!document.querySelector('.dialog-overlay input'))
    let updates = await page.evaluate(() => window.__unitUpdates.slice())
    check('I「改名字」→ 面板关、只弹一个输入框,unitsUpdate(id, { name })',
      asked1 && !secondDialog && !(await panelOpen(page)) && JSON.stringify(updates) === JSON.stringify([['u-mba', { name: '书桌 Air' }]]), JSON.stringify({ secondDialog, updates }))
    await ctxOn()
    await page.click('.ap-unit-ctx button:nth-child(3)')
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
        check('英文:This computer / My devices / Online · Relay / 1 offline… / Manage Units…',
          JSON.stringify(enNames) === JSON.stringify(['#This computer', 'This computer', '#My devices', 'MacBook Air', '2 offline', 'Manage Units…']) && en[3].state === 'Online · Relay', JSON.stringify({ enNames, s: en[3]?.state }))
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
