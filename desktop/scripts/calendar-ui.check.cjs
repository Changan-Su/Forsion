/** Calendar Space UIUX 真 Electron 回归：隔离 Vault，不碰用户数据。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.CALENDAR_UI_ARTIFACT_DIR || path.join(os.tmpdir(), 'forsion-calendar-ui')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

async function clickSpace(win, names) {
  const clicked = await win.evaluate((labels) => {
    const buttons = [...document.querySelectorAll('button.rb-space')]
    const hit = buttons.find((b) => labels.includes((b.getAttribute('title') || b.textContent || '').trim()))
    if (!hit) return false
    hit.click()
    return true
  }, names)
  if (!clicked) throw new Error(`找不到 Space：${names.join('/')}`)
}

async function forceMode(win, mode) {
  await win.evaluate((next) => {
    localStorage.setItem('forsion_theme_pref', next)
    localStorage.setItem('forsion_theme', next)
    const dark = next === 'dark'
    document.documentElement.dataset.mode = next
    document.documentElement.classList.toggle('dark', dark)
    for (const el of document.querySelectorAll('[data-mode]')) el.dataset.mode = next
  }, mode)
  await win.waitForTimeout(800)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先跑 npm run build')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-calendar-ui-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  const userDataDev = `${userData}-dev`
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(userDataDev, { recursive: true })

  const today = new Date()
  const d0 = ymd(today)
  const dm1 = ymd(addDays(today, -1))
  const d1 = ymd(addDays(today, 1))
  const rows = [
    ['focus-a', '产品深度工作', `${d0}T09:00/${d0}T10:30`],
    ['focus-b', '设计评审', `${d0}T09:30/${d0}T11:00`],
    ['all-day', '版本发布', d0],
    ['roadmap', '路线图工作坊', `${dm1}/${d1}`],
    ['lunch', '团队午餐', `${d0}T12:30/${d0}T13:30`],
    ['review', '周度复盘', `${d0}T15:00/${d0}T16:00`],
    ['wrap', '整理会议纪要', `${d0}T17:00/${d0}T17:30`],
    ['overdue', '补交上周总结', dm1],
    ['tomorrow', '准备明日议程', `${d1}T10:00/${d1}T10:45`],
  ].map(([id, name, date]) => ({ id, cells: { name, date } }))
  fs.writeFileSync(path.join(vault, 'calendar-demo.db'), `${JSON.stringify({
    version: 1,
    name: '产品日历',
    columns: [
      { id: 'name', name: '名称', type: 'text' },
      { id: 'date', name: '日期', type: 'calendarDate' },
      { id: 'done', name: '完成', type: 'checkbox' },
    ],
    rows,
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# Calendar UI 检查\n')
  fs.writeFileSync(path.join(userDataDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const errors = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(e.message))
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2200)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.getByText(label, { exact: true }).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })

    // Amadeus 编辑器先挂一次，让 vaultRoot 与全库扫描正式就绪。
    await clickSpace(win, ['Amadeus'])
    await win.waitForSelector('.am-app', { timeout: 30_000 })
    await win.waitForTimeout(2200)
    await clickSpace(win, ['日历', 'Calendar'])
    await win.waitForSelector('.amx-cal', { timeout: 30_000 })
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 30_000 })
    await win.waitForTimeout(1200)

    const sticky = await win.evaluate(() => {
      const sc = document.querySelector('.amx-cal-tscroll')
      const inside = (sel) => [...document.querySelectorAll(sel)].find((e) => {
        const r = e.getBoundingClientRect()
        const s = sc.getBoundingClientRect()
        return r.right > s.left && r.left < s.right
      })
      if (!sc) return null
      sc.scrollTop = Math.max(sc.scrollTop, 520)
      sc.dispatchEvent(new Event('scroll'))
      const s = sc.getBoundingClientRect()
      const h = inside('.amx-cal-thead2')?.getBoundingClientRect()
      const a = inside('.amx-cal-allday2')?.getBoundingClientRect()
      return h && a ? { scrollTop: sc.scrollTop, headTop: h.top, allTop: a.top, scTop: s.top } : null
    })
    check('纵向滚动后日期栏与全天行仍固定可见', sticky && sticky.scrollTop > 300 && Math.abs(sticky.headTop - sticky.scTop) <= 2 && sticky.allTop > sticky.headTop, JSON.stringify(sticky))

    const overlaps = await win.evaluate(() => {
      const a = document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')?.getBoundingClientRect()
      const b = document.querySelector('.amx-cal-event[aria-label^="设计评审"]')?.getBoundingClientRect()
      const cal = document.querySelector('.amx-cal')
      const ev = document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')
      return a && b && cal && ev ? { ax: a.left, bx: b.left, aw: a.width, bw: b.width, color: getComputedStyle(ev).color, text: getComputedStyle(cal).color } : null
    })
    check('重叠事件并排分栏，不再互相覆盖', overlaps && Math.abs(overlaps.ax - overlaps.bx) > 20 && overlaps.aw < 100 && overlaps.bw < 100, JSON.stringify(overlaps))
    check('事件文字跟随主题正文色，而非固定白字', overlaps && overlaps.color === overlaps.text, overlaps && `${overlaps.color} / ${overlaps.text}`)
    check('跨日事件使用连续条首尾样式', (await win.locator('.amx-cal-allday2 .continues-left.continues-right').count()) >= 1)

    const event = win.locator('.amx-cal-event[aria-label^="产品深度工作"]').first()
    await event.click()
    const dialog = win.getByRole('dialog', { name: /编辑事件/ })
    await dialog.waitFor({ timeout: 5000 })
    check('事件详情具有 dialog 语义并自动聚焦标题', await win.evaluate(() => document.activeElement?.getAttribute('aria-label') === '名称'))
    check('事件详情提供打开数据库入口', (await dialog.getByRole('button', { name: /打开数据库/ }).count()) === 1)
    await win.keyboard.press('Escape')
    check('Escape 可关闭事件详情', (await dialog.count()) === 0)

    await event.click()
    const beforeDelete = await win.locator('.amx-cal-event').count()
    await win.getByRole('button', { name: '删除', exact: true }).click()
    await win.getByRole('button', { name: '撤销', exact: true }).waitFor({ timeout: 5000 })
    await win.getByRole('button', { name: '撤销', exact: true }).click()
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 5000 })
    check('删除事件后可从通知条一键撤销', (await win.locator('.amx-cal-event').count()) === beforeDelete)

    const dueLabels = await win.locator('.amx-todo-due').allTextContents()
    check('待办行显示今天/逾期等日期状态', dueLabels.some((x) => x.startsWith('今天')) && dueLabels.some((x) => x.startsWith('逾期')), JSON.stringify(dueLabels))
    check('来源配置只保留一个主“添加日历”入口', (await win.getByRole('button', { name: /添加日历/ }).count()) === 1)

    await win.keyboard.press('m')
    await win.waitForSelector('.amx-cal-mscroll', { timeout: 5000 })
    const more = win.locator('.amx-cal-more').first()
    await more.waitFor({ timeout: 5000 })
    await more.click()
    check('月视图溢出入口可打开当日完整日程', (await win.locator('.amx-cal-agenda[role="dialog"]').count()) === 1 && (await win.locator('.amx-cal-agenda-list > button').count()) >= 4)
    await win.keyboard.press('Escape')
    check('当日日程列表支持 Esc 关闭', (await win.locator('.amx-cal-agenda').count()) === 0)
    await win.keyboard.press('w')
    await win.waitForSelector('.amx-cal-tscroll', { timeout: 5000 })

    await win.setViewportSize({ width: 1100, height: 800 })
    await win.waitForTimeout(900)
    const narrow = await win.evaluate(() => {
      const sc = document.querySelector('.amx-cal-tscroll')
      const col = document.querySelector('.amx-cal-daycol2')?.getBoundingClientRect()
      return sc && col ? { colW: col.width, clientW: sc.clientWidth, scrollW: sc.scrollWidth, densityVisible: !!document.querySelector('.amx-cal-density') && getComputedStyle(document.querySelector('.amx-cal-density')).display !== 'none' } : null
    })
    check('窄主区保持可读列宽并允许横向滚动', narrow && narrow.colW >= 111 && narrow.scrollW > narrow.clientW, JSON.stringify(narrow))

    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForTimeout(800)
    await win.locator('.amx-cal-event[aria-label^="产品深度工作"]').click()
    for (const close of await win.locator('.ntf-close').all()) await close.click().catch(() => {})
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(OUT, 'calendar-ui-light.png') })
    await win.keyboard.press('Escape')

    await forceMode(win, 'dark')
    await win.screenshot({ path: path.join(OUT, 'calendar-ui-dark.png') })
    check('明暗主题截图均已产出', fs.existsSync(path.join(OUT, 'calendar-ui-light.png')) && fs.existsSync(path.join(OUT, 'calendar-ui-dark.png')), OUT)
    check('Calendar 主链无渲染异常', errors.length === 0, errors.join(' | '))
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过；截图：${OUT}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
