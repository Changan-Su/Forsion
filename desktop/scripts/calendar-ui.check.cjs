/** Calendar Space UIUX 真 Electron 回归：隔离 Vault，不碰用户数据。
 *  2026-10-16 方案 B + 方向 1(docs/ToBeImproved/Calendar交互与待办右栏方案_2026-10-16/):左栏小月历 + 日历列表、右栏待办;
 *  同日用户改口:编辑事件在事件旁的浮卡、草稿的选日历 / 保存在草稿块旁的草稿卡,右栏不再换成详情 / 草稿面板;
 *  单击空白 = 草稿(不落盘)、按住拖 = 时长、全天行横拖 = 多天;拖动吸附 + ⌘Z;待办拖进时间格;快速添加认自然语言日期。
 *  夹具拆成两张表:「产品日历」只有日期列(日程),「待办」带勾选列(待办来源)—— 只有日期的待办不进全天行。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

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
const readRows = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).rows
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** 某天某刻在屏幕上的点(含页面 CSS zoom);min 落在那一刻往下 4px 的格子里,免得浮点误差落到上一格。 */
async function slotPoint(win, iso, min) {
  return win.evaluate(({ iso, min }) => {
    const cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
    const timerow = document.querySelector('.amx-cal-timerow')
    if (!cell || !timerow) return null
    const r = cell.getBoundingClientRect()
    const zoom = cell.currentCSSZoom || 1
    const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
    return { x: r.left + r.width / 2, y: r.top + ((min / 60) * hourPx + 4) * zoom, top: r.top, zoom, hourPx }
  }, { iso, min })
}
const hasDraft = (win) => win.evaluate(() => !!document.querySelector('.amx-cal-draft'))

async function clickSpace(win, names) {
  const clicked = await win.evaluate((labels) => {
    const buttons = [...document.querySelectorAll('button.rb-space')]
    const hit = buttons.find((b) => labels.includes((b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()))
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

async function forceZoom(win, zoom) {
  await win.evaluate((next) => {
    if (next === 1) localStorage.removeItem('forsion_ui_zoom')
    else localStorage.setItem('forsion_ui_zoom', String(next))
    document.body.style.zoom = next === 1 ? '' : String(next)
    if (next === 1) document.documentElement.style.removeProperty('--uiz')
    else document.documentElement.style.setProperty('--uiz', String(next))
    window.dispatchEvent(new Event('forsion:uizoom'))
  }, zoom)
  await win.waitForTimeout(700)
}

async function alignWeekGrid(win, startHour) {
  await win.evaluate((hour) => {
    const sc = document.querySelector('.amx-cal-tscroll')
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
    const timerow = document.querySelector('.amx-cal-timerow')
    if (!sc || !cell || !timerow) throw new Error('日历周网格尚未就绪')
    const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
    sc.scrollLeft = Math.max(0, cell.offsetLeft - (sc.clientWidth - cell.clientWidth) / 2)
    sc.scrollTop = Math.max(0, cell.offsetTop + hour * hourPx)
    sc.dispatchEvent(new Event('scroll'))
  }, startHour)
  await win.waitForTimeout(350)
}

// ── Astryx 重置作用域(theme/astryxReset.css)──────────────────────────────────────
// 原版全局重置的原文:往页里再注入一份,日历内一切计算样式与盒子都不该变 = 作用域版对日历而言与全局版等价。
const GLOBAL_RESET = fs.readFileSync(require.resolve('@astryxdesign/core/reset.css'), 'utf8')
/** 注入原版全局重置前后,对日历三栏 + 打开的弹层逐元素比计算样式与盒子。
 *  Astryx 包裹层(div[data-astryx-theme])的子孙逐属性全等;包裹层本身(display:contents,@scope 的根不被 `*` 命中)和包裹层外
 *  只比看得见的:宽 0 边框的 style、tab-size、appearance、点按高亮看不出来;vertical-align 只对行内级盒子起作用
 *  (flex 子项的计算值已被块化成 block)。盒子(rect)始终逐个比。 */
async function resetParity(win, label) {
  const r = await win.evaluate((css) => {
    const PROPS = ['box-sizing', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-left-style', 'border-top-color',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'display', 'position', 'top', 'bottom',
      'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'color', 'background-color', 'background-image', 'text-decoration-line', 'text-indent',
      'list-style-type', 'vertical-align', 'max-width', 'cursor', 'opacity', 'outline-style', 'resize', 'border-collapse', 'tab-size', 'appearance', 'color-scheme',
      '-webkit-tap-highlight-color', '-webkit-font-smoothing']
    const PSEUDO = { '::before': ['box-sizing', 'border-top-width', 'border-top-style', 'width', 'height'], '::after': ['box-sizing', 'border-top-width', 'border-top-style', 'width', 'height'] }
    const roots = [...document.querySelectorAll('.amx-cal, .amx-todo, .amx-calside, .amx-calside2, [popover], [role="dialog"], .amx-cal-cardwrap')]
    const els = [...new Set(roots.flatMap((x) => [x, ...x.querySelectorAll('*')]))]
    const snap = () => els.map((el) => {
      const cs = getComputedStyle(el)
      const b = el.getBoundingClientRect()
      const o = { rect: [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(',') }
      for (const p of PROPS) o[p] = cs.getPropertyValue(p)
      for (const [pe, ps] of Object.entries(PSEUDO)) {
        const pcs = getComputedStyle(el, pe)
        if (pcs.content && pcs.content !== 'none') for (const p of ps) o[pe + p] = pcs.getPropertyValue(p)
      }
      if (el.matches('input, textarea')) { const ph = getComputedStyle(el, '::placeholder'); o.ph = ph.color + '|' + ph.opacity }
      return o
    })
    const a = snap()
    const st = document.createElement('style')
    st.textContent = css
    document.head.appendChild(st)
    const b = snap()
    st.remove()
    const quiet = (o, k) => k === 'tab-size' || k === 'appearance' || k === '-webkit-tap-highlight-color' ||
      (/border-\w+-style$/.test(k) && o[k.replace('-style', '-width')] === '0px') ||
      (k === 'vertical-align' && !/^inline|^table-cell$/.test(o.display))
    const diffs = []
    els.forEach((el, i) => {
      const inWrap = !!el.parentElement?.closest('div[data-astryx-theme]')
      const keys = Object.keys(a[i]).filter((k) => a[i][k] !== b[i][k] && (inWrap || !quiet(a[i], k)))
      if (keys.length) diffs.push(`${inWrap ? 'wrap' : 'out'} ${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).trim().split(/\s+/)[0]} ${keys.map((k) => `${k}: ${a[i][k]} → ${b[i][k]}`).join('; ')}`)
    })
    return { n: els.length, inWrap: els.filter((el) => el.closest('div[data-astryx-theme]')).length, open: document.querySelectorAll(':popover-open, [role="dialog"]').length, diffs }
  }, GLOBAL_RESET)
  check(`Astryx 重置作用域 ≡ 全局版(${label}):${r.n} 个元素(包裹层内 ${r.inWrap}、弹层 ${r.open})注入原版全局重置后样式与盒子不变`,
    r.n > 0 && r.inWrap > 0 && r.diffs.length === 0, r.diffs.length ? `${r.diffs.length} 处:${r.diffs.slice(0, 6).join(' ‖ ')}` : '')
  return r
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
  const d2 = ymd(addDays(today, 2))
  const rows = [
    ['focus-a', '产品深度工作', `${d0}T09:00/${d0}T10:30`],
    ['focus-b', '设计评审', `${d0}T09:30/${d0}T11:00`],
    ['all-day', '版本发布', d0],
    ['roadmap', '路线图工作坊', `${dm1}/${d1}`],
    ['lunch', '团队午餐', `${d0}T12:30/${d0}T13:30`],
    ['review', '周度复盘', `${d0}T15:00/${d0}T16:00`],
    ['wrap', '整理会议纪要', `${d0}T17:00/${d0}T17:30`],
    ['tomorrow', '准备明日议程', `${d1}T10:00/${d1}T10:45`],
  ].map(([id, name, date]) => ({ id, cells: { name, date } }))
  const EVENTS_DB = path.join(vault, 'calendar-demo.db')
  const TASKS_DB = path.join(vault, 'tasks-demo.db')
  fs.writeFileSync(EVENTS_DB, `${JSON.stringify({
    version: 1,
    name: '产品日历',
    columns: [
      { id: 'name', name: '名称', type: 'text' },
      { id: 'date', name: '日期', type: 'calendarDate' },
    ],
    rows,
  }, null, 2)}\n`)
  const tasks = [
    ['overdue', '补交上周总结', dm1],
    ['today-task', '回复设计稿反馈', d0],
    ['sched', '订会议室', `${d1}T16:00/${d1}T16:30`],
    ['undated', '买牛奶', ''],
    ['long', '读完《设计心理学》第三章并整理一篇读书笔记', d1], // 长标题:钉住「最长那条撑宽整列、日期出界」(走查截图 70)
  ].map(([id, name, date]) => ({ id, cells: date ? { name, date } : { name } }))
  fs.writeFileSync(TASKS_DB, `${JSON.stringify({
    version: 1,
    name: '待办',
    columns: [
      { id: 'name', name: '名称', type: 'text' },
      { id: 'date', name: '日期', type: 'calendarDate' },
      { id: 'done', name: '完成', type: 'checkbox' },
    ],
    rows: tasks,
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# Calendar UI 检查\n')
  fs.writeFileSync(path.join(userDataDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
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
    await clickSpace(win, ['笔记', 'Note'])
    await win.waitForSelector('.am-app', { timeout: 30_000 })
    await win.waitForTimeout(2200)
    await clickSpace(win, ['日历', 'Calendar'])
    await win.waitForSelector('.amx-cal', { timeout: 30_000 })
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 30_000 })
    await win.waitForTimeout(1200)

    // 方案 B 摆法:左 = 小月历 + 日历列表,右 = 待办(选中事件换成详情);头部左边「月份 第 N 周」。
    const sides = await win.evaluate(() => {
      const x = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? r.left : null }
      return { mini: x('.amx-mini'), cal: x('.amx-cal'), side: x('.amx-calside2'), todo: !!document.querySelector('.amx-calside2 .amx-todo'), week: document.querySelector('.amx-cal-title')?.dataset.week || '' }
    })
    check('方案 B:左栏小月历、右栏待办,标题带周数', sides.mini !== null && sides.cal !== null && sides.side !== null && sides.mini < sides.cal && sides.side > sides.cal && sides.todo && /^第 \d+ 周$/.test(sides.week), JSON.stringify(sides))
    // 新建落点钉成「产品日历」(⋯ → 设为默认日历):下面建出来的都应落在这张表里。
    const evRow = win.locator('.amx-calcfg-row', { hasText: '产品日历' })
    await evRow.hover()
    await evRow.locator('.amx-calcfg-more').click()
    await win.getByRole('button', { name: '设为默认日历', exact: true }).click()
    await win.waitForTimeout(300)
    check('日历列表:「默认」淡字跟着 ⋯ 里的设为默认日历走', (await evRow.locator('.amx-calcfg-default').count()) === 1 && (await win.locator('.amx-calcfg-default').count()) === 1)
    // 颜色方块就是显隐开关
    await evRow.locator('.amx-calcfg-swatch').click()
    await win.waitForTimeout(300)
    const hiddenCount = await win.locator('.amx-cal-event[aria-label^="产品深度工作"]').count()
    await evRow.locator('.amx-calcfg-swatch').click()
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 5000 })
    check('日历列表:点颜色方块 = 显隐这张日历', hiddenCount === 0)

    // W-74:「周」首列跟「一周开始于」(zh 缺省周一),不再从今天起排;今天落在这一周里。
    const weekCols = await win.evaluate(() => {
      const s = document.querySelector('.amx-cal-tscroll')?.getBoundingClientRect()
      if (!s) return []
      return [...document.querySelectorAll('.amx-cal-daycol2[data-date]')]
        .filter((c) => { const r = c.getBoundingClientRect(); return r.right > s.left + 2 && r.left < s.right - 2 })
        .map((c) => c.getAttribute('data-date'))
    })
    const now = new Date()
    check('W-74 周视图首列=本周一且含今天', weekCols.length === 7 && weekCols[0] === ymd(addDays(now, -((now.getDay() + 6) % 7))) && weekCols.includes(ymd(now)), JSON.stringify(weekCols))
    // 横向自由滚到周中后,只拉宽窗口(仍 7 列)不许被拽回周首日(Codex w7x-1)。
    const firstCol = () => win.evaluate(() => {
      const s = document.querySelector('.amx-cal-tscroll').getBoundingClientRect()
      return [...document.querySelectorAll('.amx-cal-daycol2[data-date]')].find((c) => c.getBoundingClientRect().right > s.left + 2)?.getAttribute('data-date')
    })
    const nudge = (k) => win.evaluate((k) => {
      const sc = document.querySelector('.amx-cal-tscroll')
      sc.scrollLeft += k * document.querySelector('.amx-cal-daycol2').getBoundingClientRect().width
      sc.dispatchEvent(new Event('scroll'))
    }, k)
    await nudge(2); await win.waitForTimeout(300)
    const midBefore = await firstCol()
    await win.setViewportSize({ width: 1520, height: 900 }); await win.waitForTimeout(700)
    const midAfter = await firstCol()
    await win.setViewportSize({ width: 1440, height: 900 }); await win.waitForTimeout(700)
    await nudge(-2); await win.waitForTimeout(300)
    check('W-74 周中自由滚动后拉宽窗口不被拽回周首日', midBefore === weekCols[2] && midAfter === midBefore, `${midBefore} → ${midAfter}`)

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
      return a && b && cal && ev ? { ax: a.left, bx: b.left, aw: a.width, bw: b.width, color: getComputedStyle(ev).color, text: getComputedStyle(cal).color, border: getComputedStyle(ev).borderTopWidth } : null
    })
    check('重叠事件并排分栏，不再互相覆盖', overlaps && Math.abs(overlaps.ax - overlaps.bx) > 20 && overlaps.aw < 100 && overlaps.bw < 100, JSON.stringify(overlaps))
    check('方向 1:事件块不描边,字是事件色压深(不是白字,也不是正文色)', overlaps && overlaps.border === '0px' && overlaps.color !== 'rgb(255, 255, 255)' && overlaps.color !== overlaps.text, overlaps && `${overlaps.border} ${overlaps.color} / ${overlaps.text}`)
    check('跨日事件使用连续条首尾样式', (await win.locator('.amx-cal-allday2 .continues-left.continues-right').count()) >= 1)
    const allDayNames = await win.evaluate(() => [...new Set([...document.querySelectorAll('.amx-cal-allday2 .amx-cal-chip-ev')].map((e) => e.textContent.trim()))])
    check('只有日期的待办不进全天行(住右栏),日程照旧', !allDayNames.includes('补交上周总结') && !allDayNames.includes('回复设计稿反馈') && allDayNames.includes('版本发布'), JSON.stringify(allDayNames))

    await resetParity(win, '周视图 + 待办 + 右栏')
    const leak = await win.evaluate(() => {
      const probe = (parent) => { const d = parent.appendChild(document.createElement('div')); const v = getComputedStyle(d).borderTopStyle; d.remove(); return v }
      const wrap = document.querySelector('div[data-astryx-theme]')
      return { outside: probe(document.body), inside: wrap ? probe(wrap) : null }
    })
    check('Astryx 重置只罩包裹层:日历开着时 body 下新 div 不受影响、包裹层里的新 div 受重置', leak.outside === 'none' && leak.inside === 'solid', JSON.stringify(leak))
    await win.locator('.amx-cal-modes').getByRole('button', { name: '周', exact: true }).click()
    await win.waitForFunction(() => document.querySelectorAll(':popover-open').length > 0, null, { timeout: 5000 })
    const menuInWrap = await win.evaluate(() => [...document.querySelectorAll(':popover-open')].every((p) => !!p.closest('div[data-astryx-theme]')))
    check('Astryx 下拉菜单走原生 popover,DOM 仍在包裹层里(作用域罩得到)', menuInWrap)
    await resetParity(win, '视图下拉菜单打开')
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => document.querySelectorAll(':popover-open').length === 0, null, { timeout: 5000 })

    const event = win.locator('.amx-cal-event[aria-label^="产品深度工作"]').first()
    await event.click()
    const card = win.locator('.amx-cal-cardwrap[role="dialog"]')
    await card.waitFor({ timeout: 5000 })
    await win.waitForTimeout(150) // 卡片下一帧才把焦点放进标题框
    await resetParity(win, '事件浮卡')
    // 卡片贴在事件旁(右侧或翻到左侧),不进右栏、不盖右栏:右栏照旧是待办
    const evCard = await win.evaluate(() => {
      const c = document.querySelector('.amx-cal-cardwrap[role="dialog"]')?.getBoundingClientRect()
      const e = document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')?.getBoundingClientRect()
      const main = document.querySelector('.amx-cal')?.getBoundingClientRect()
      return c && e && main ? { beside: Math.abs(c.left - e.right) < 24 || Math.abs(e.left - c.right) < 24, inMain: c.right <= main.right + 1, todo: !!document.querySelector('.amx-calside2 .amx-todo'), sidePanel: !!document.querySelector('.amx-calside2 .amx-cal-card-title') } : null
    })
    check('点开事件 → 事件旁浮卡,右栏照旧是待办(10-16 用户:不要在 right panel)', !!evCard && evCard.beside && evCard.inMain && evCard.todo && !evCard.sidePanel && (await card.locator('input.amx-cal-card-title').inputValue()) === '产品深度工作', JSON.stringify(evCard))
    check('浮卡标题框自动聚焦,直接能改名', await win.evaluate(() => document.activeElement?.matches('.amx-cal-cardwrap input.amx-cal-card-title') === true))
    check('事件浮卡提供打开数据库入口', (await card.getByRole('button', { name: /打开多维表/ }).count()) === 1)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    check('Esc 收起浮卡', (await card.count()) === 0 && (await win.locator('.amx-calside2 .amx-todo').count()) === 1)

    await event.click()
    await card.waitFor({ timeout: 5000 })
    const beforeDelete = await win.locator('.amx-cal-event').count()
    await win.getByRole('button', { name: '删除', exact: true }).click()
    await win.getByRole('button', { name: '撤销', exact: true }).waitFor({ timeout: 5000 })
    await win.getByRole('button', { name: '撤销', exact: true }).click()
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 5000 })
    check('删除事件后可从通知条一键撤销', (await win.locator('.amx-cal-event').count()) === beforeDelete)

    const dueLabels = await win.locator('.amx-todo-due').allTextContents()
    check('待办行显示今天/逾期等日期状态', dueLabels.some((x) => x.startsWith('今天')) && dueLabels.some((x) => x.startsWith('逾期')), JSON.stringify(dueLabels))
    check('来源配置只保留一个主“添加日历”入口', (await win.getByRole('button', { name: /添加日历/ }).count()) === 1)

    // ── 新建:单击 = 草稿(不落盘);Esc / 没写标题就点别处 = 丢弃;按住拖 = 时长;全天行横拖 = 多天 ──
    await win.keyboard.press('Escape')
    await alignWeekGrid(win, 7)
    await win.waitForTimeout(1200) // 上一步「删除 → 撤销」的写盘落地后再取基线
    const eventsBefore = readRows(EVENTS_DB).length
    const p13 = await slotPoint(win, d1, 13 * 60)
    await win.mouse.click(p13.x, p13.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 })
    const draftGeo = () => win.evaluate(() => {
      const c = document.querySelector('.amx-cal-draftcard')?.getBoundingClientRect()
      const b = document.querySelector('.amx-cal-event.amx-cal-draft')?.getBoundingClientRect()
      const main = document.querySelector('.amx-cal')?.getBoundingClientRect()
      return { focus: document.activeElement?.matches('.amx-cal-draft-input') === true, card: !!c, beside: !!c && !!b && (Math.abs(c.left - b.right) < 24 || Math.abs(b.left - c.right) < 24), inMain: !!c && !!main && c.right <= main.right + 1, dy: c && b ? Math.round(c.top - b.top) : null, todo: !!document.querySelector('.amx-calside2 .amx-todo') }
    })
    await win.waitForTimeout(250) // 卡片的弹出动画(0.16s,自上方 6px 落下)走完再量
    const draftUi = await draftGeo()
    check('单击空白 = 草稿:标题光标在格子里,草稿块旁弹出草稿卡,右栏照旧是待办', draftUi.focus && draftUi.card && draftUi.beside && draftUi.inMain && draftUi.todo, JSON.stringify(draftUi))
    // 草稿卡跟着草稿块走:时间格竖着滚一段,卡片与块的相对位置不变
    // 往能滚的方向滚 40(滚到底时 += 40 是空操作),量完原样还回去 —— 后面的落点是滚动前取的
    const scrolled = await win.evaluate(() => { const sc = document.querySelector('.amx-cal-tscroll'); const st0 = sc.scrollTop; sc.scrollTop = st0 > 60 ? st0 - 40 : st0 + 40; return { st0, d: sc.scrollTop - st0 } })
    await win.waitForTimeout(150)
    const draftScrolled = await draftGeo()
    check('时间格滚动时草稿卡跟着草稿块走', scrolled.d !== 0 && draftScrolled.card && draftScrolled.dy === draftUi.dy && draftScrolled.focus, JSON.stringify({ scrolled, before: draftUi.dy, after: draftScrolled.dy }))
    await win.evaluate((st0) => { document.querySelector('.amx-cal-tscroll').scrollTop = st0 }, scrolled.st0)
    await win.waitForTimeout(100)
    // 在草稿卡里点另一个日历:焦点留在格子里的标题框,草稿不丢
    const otherCal = win.locator('.amx-cal-draftcard .amx-cal-draft-cal:not(.on)').first()
    const chosenCal = (await win.locator('.amx-cal-draftcard .amx-cal-draft-cal.on').textContent())?.trim()
    if (await otherCal.count()) {
      await otherCal.click()
      await win.waitForTimeout(150)
      check('草稿卡里换日历:草稿还在,焦点留在标题框', (await hasDraft(win)) && await win.evaluate(() => document.activeElement?.matches('.amx-cal-draft-input') === true) && (await win.locator('.amx-cal-draftcard .amx-cal-draft-cal.on').count()) === 1)
      await win.locator('.amx-cal-draftcard .amx-cal-draft-cal', { hasText: chosenCal }).click() // 换回原来的日历,后面的断言按默认库读
    }
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    const afterEsc = { draft: await hasDraft(win), rows: readRows(EVENTS_DB).length, before: eventsBefore }
    check('草稿 Esc 丢弃,表里不多一行', !afterEsc.draft && afterEsc.rows === eventsBefore, JSON.stringify(afterEsc))
    await win.mouse.click(p13.x, p13.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 })
    const p18 = await slotPoint(win, d1, 18 * 60)
    await win.mouse.click(p18.x, p18.y)
    await win.waitForTimeout(400)
    const afterAway = { draft: await hasDraft(win), rows: readRows(EVENTS_DB).length, before: eventsBefore }
    check('没写标题就点到别处 = 丢弃;这一下只用来退出,不另起草稿', !afterAway.draft && afterAway.rows === eventsBefore, JSON.stringify(afterAway))
    await win.mouse.click(p13.x, p13.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 })
    await win.keyboard.press('Enter')
    await win.waitForTimeout(500)
    const afterEnter = { draft: await hasDraft(win), rows: readRows(EVENTS_DB).length, before: eventsBefore }
    check('没写标题直接回车 = 不建(10-16 走查:误回车留下了「新事件」)', !afterEnter.draft && afterEnter.rows === eventsBefore, JSON.stringify(afterEnter))
    // 最右一列的草稿:卡片放不下就翻到块左边,不盖右栏的待办
    const lastDay = await win.evaluate(() => {
      const v = document.querySelector('.amx-cal-tscroll').getBoundingClientRect()
      return [...document.querySelectorAll('.amx-cal-daycol2')].filter((c) => { const r = c.getBoundingClientRect(); return r.left >= v.left - 1 && r.right <= v.right + 1 }).at(-1)?.dataset.date ?? null
    })
    const pEdge = await slotPoint(win, lastDay, 18 * 60)
    await win.mouse.click(pEdge.x, pEdge.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(250)
    const edgeUi = await draftGeo()
    check('最右一列的草稿:草稿卡翻到块左边,不盖右栏', edgeUi.card && edgeUi.beside && edgeUi.inMain, JSON.stringify({ lastDay, ...edgeUi }))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    const p1415 = await slotPoint(win, d1, 14 * 60 + 15)
    await win.mouse.move(p13.x, p13.y)
    await win.mouse.down()
    await win.mouse.move(p1415.x, p1415.y, { steps: 8 })
    await win.mouse.up()
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 })
    await win.keyboard.type('拖出来的会')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.amx-cal-event[aria-label="拖出来的会，13:00 至 14:30"]', { timeout: 5000 }).catch(() => {})
    await win.waitForTimeout(700)
    const dragged = readRows(EVENTS_DB).find((r) => r.cells?.name === '拖出来的会')
    check('按住拖 = 拖出时长(含指针所在那一格),Enter 写进默认日历', dragged?.cells?.date === `${d1}T13:00/${d1}T14:30`, JSON.stringify(dragged?.cells))
    const savedSel = await win.evaluate(() => ({ sel: document.querySelector('.amx-cal-event.selected')?.getAttribute('aria-label') ?? '', cards: document.querySelectorAll('.amx-cal-cardwrap').length }))
    check('保存后新事件高亮,不弹卡', /^拖出来的会/.test(savedSel.sel) && savedSel.cards === 0, JSON.stringify(savedSel))
    // 高亮着一条事件时打开右栏待办的卡:焦点在卡里按 Delete / C,不许删主区那条、不许在卡下面起草稿(Codex 评审)
    await win.locator('.amx-calside2 .amx-todo-item', { hasText: '回复设计稿反馈' }).locator('.amx-todo-main').click()
    await card.waitFor({ timeout: 3000 })
    await win.waitForTimeout(150)
    await card.locator('.amx-cal-card-x').focus()
    await win.keyboard.press('Delete')
    await win.keyboard.press('c')
    await win.waitForTimeout(400)
    const guard = { kept: await win.locator('.amx-cal-event[aria-label^="拖出来的会"]').count(), draft: await hasDraft(win), card: await card.count() }
    check('待办卡开着时 Delete / C 不动主区:高亮的事件还在、不起草稿', guard.kept === 1 && !guard.draft && guard.card === 1, JSON.stringify(guard))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    // 卡片关掉后焦点回到那条待办的按钮上(再按 Enter = 再开那条待办,按钮的正常行为);把焦点还给日历再测高亮的 Enter
    await win.evaluate(() => document.querySelector('.amx-cal')?.focus({ preventScroll: true }))
    await win.keyboard.press('Enter')
    await card.waitFor({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(150)
    check('高亮着按 Enter = 在它旁边开卡,标题框聚焦', (await card.count()) === 1 && (await card.locator('input.amx-cal-card-title').inputValue()) === '拖出来的会' && await win.evaluate(() => document.activeElement?.matches('.amx-cal-cardwrap input.amx-cal-card-title') === true))
    await win.keyboard.press('Escape')
    const allPts = await win.evaluate(({ a, b }) => {
      const r1 = document.querySelector(`.amx-cal-allday2[data-date="${a}"]`)?.getBoundingClientRect()
      const r2 = document.querySelector(`.amx-cal-allday2[data-date="${b}"]`)?.getBoundingClientRect()
      return r1 && r2 ? { x1: r1.left + r1.width / 2, x2: r2.left + r2.width / 2, y: r1.bottom - 5 } : null
    }, { a: d1, b: d2 })
    await win.mouse.move(allPts.x1, allPts.y)
    await win.mouse.down()
    await win.mouse.move(allPts.x2, allPts.y, { steps: 6 })
    await win.mouse.up()
    await win.waitForSelector('.amx-cal-allday2 .amx-cal-draft', { timeout: 3000 }).catch(() => {})
    await win.keyboard.type('出差')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(900)
    const trip = readRows(EVENTS_DB).find((r) => r.cells?.name === '出差')
    check('全天行横拖 = 多天全天草稿,Enter 写成区间', trip?.cells?.date === `${d1}/${d2}`, JSON.stringify(trip?.cells))
    await win.keyboard.press('Escape')

    // ── 待办与日历:排了时段的待办块里能勾;右栏的待办拖进时间格 = 排 30 分钟;N 聚焦快速添加并认自然语言日期 ──
    const sched = win.locator('.amx-cal-event.todo[aria-label^="订会议室"] .amx-cal-event-check')
    check('排了时段的待办上网格,块里带方框', (await sched.count()) === 1)
    await sched.click()
    await win.waitForTimeout(900)
    check('在日历里勾掉待办 = 写回勾选列', readRows(TASKS_DB).find((r) => r.id === 'sched')?.cells?.done === true)
    const p9 = await slotPoint(win, d1, 9 * 60)
    const dropped = await win.evaluate(({ x, y }) => {
      const li = [...document.querySelectorAll('.amx-calside2 .amx-todo-item')].find((e) => e.textContent.includes('买牛奶'))
      const target = document.elementFromPoint(x, y)
      if (!li || !target) return false
      const dt = new DataTransfer()
      li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
      li.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      return true
    }, p9)
    await win.waitForTimeout(900)
    const milk = readRows(TASKS_DB).find((r) => r.id === 'undated')
    check('从右栏把待办拖进时间格 = 排 30 分钟的时段', dropped && milk?.cells?.date === `${d1}T09:00/${d1}T09:30`, JSON.stringify(milk?.cells))
    await win.keyboard.press('n')
    check('N 聚焦右栏的快速添加', await win.evaluate(() => document.activeElement?.matches('.amx-calside2 .amx-todo-addinput') === true))
    await win.keyboard.type('明天下午3点 交周报')
    const qprev = await win.locator('.amx-todo-addprev').textContent().catch(() => '')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(900)
    const report = readRows(TASKS_DB).find((r) => r.cells?.name === '交周报')
    check('快速添加认「明天下午3点」,打字时就显示解析结果,加进待办表', report?.cells?.date === `${d1}T15:00` && /明天/.test(qprev) && /待办/.test(qprev), JSON.stringify({ qprev, cells: report?.cells }))
    await win.keyboard.press('Escape')

    await win.keyboard.press('m')
    await win.waitForSelector('.amx-cal-mscroll', { timeout: 5000 })
    const more = win.locator('.amx-cal-more').first()
    await more.waitFor({ timeout: 5000 })
    await more.click()
    check('月视图溢出入口可打开当日完整日程', (await win.locator('.amx-cal-agenda[role="dialog"]').count()) === 1 && (await win.locator('.amx-cal-agenda-list > button').count()) >= 4)
    await resetParity(win, '月视图 + 当日日程')
    await win.keyboard.press('Escape')
    check('当日日程列表支持 Esc 关闭', (await win.locator('.amx-cal-agenda').count()) === 0)
    const mcell = await win.evaluate((iso) => { const c = document.querySelector(`.amx-cal-mcell[data-date="${iso}"]`)?.getBoundingClientRect(); return c ? { x: c.left + c.width / 2, y: c.bottom - 6 } : null }, d2)
    await win.mouse.click(mcell.x, mcell.y)
    check('月视图单击空白格 = 当天全天草稿', await win.waitForSelector('.amx-cal-mcell .amx-cal-draft', { timeout: 3000 }).then(() => true, () => false))
    await win.keyboard.press('Escape')
    await win.keyboard.press('w')
    await win.waitForSelector('.amx-cal-tscroll', { timeout: 5000 })

    // 页面级 CSS zoom 会让 getBoundingClientRect/clientX 使用视口像素，而事件 top/hourPx 仍是局部 CSS 像素。
    // 125% 下分别覆盖双击建事件与跨列拖拽，直接断言最终事件矩形和鼠标目标重合。
    await forceZoom(win, 1.25)
    await alignWeekGrid(win, 7)
    const createPoint = await win.evaluate(() => {
      const today = new Date()
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
      const timerow = document.querySelector('.amx-cal-timerow')
      if (!cell || !timerow) return null
      const rect = cell.getBoundingClientRect()
      const zoom = cell.currentCSSZoom || 1
      const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
      const min = 14 * 60 + 15
      return { x: rect.left + rect.width / 2, y: rect.top + ((min / 60) * hourPx + 4) * zoom, zoom }
    })
    if (!createPoint) throw new Error('无法计算 125% 缩放下的创建落点')
    await win.mouse.click(createPoint.x, createPoint.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 5000 })
    const draftDelta = await win.evaluate(({ zoom }) => {
      const d = document.querySelector('.amx-cal-event.amx-cal-draft')
      const cell = d?.closest('.amx-cal-daycol2')
      const timerow = document.querySelector('.amx-cal-timerow')
      const hourPx = timerow ? parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44 : 44
      return d && cell ? Math.abs(d.getBoundingClientRect().top - (cell.getBoundingClientRect().top + 14.25 * hourPx * zoom)) : null
    }, createPoint)
    await win.keyboard.type('缩放下建的')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.amx-cal-event[aria-label^="缩放下建的，14:15"]', { timeout: 5000 }).catch(() => {})
    const createLanding = await win.evaluate(({ zoom }) => {
      const event = document.querySelector('.amx-cal-event[aria-label^="缩放下建的，14:15"]')
      const er = event?.getBoundingClientRect()
      const cr = event?.closest('.amx-cal-daycol2')?.getBoundingClientRect()
      const timerow = document.querySelector('.amx-cal-timerow')
      const hourPx = timerow ? parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44 : 44
      return er && cr ? { eventDelta: Math.abs(er.top - (cr.top + 14.25 * hourPx * zoom)) } : null
    }, createPoint)
    check('125% 缩放下单击建的草稿与保存后的事件都命中鼠标所在的刻', draftDelta !== null && draftDelta <= 2.5 && createLanding && createLanding.eventDelta <= 2.5, JSON.stringify({ draftDelta, ...createLanding }))
    await win.keyboard.press('Escape')

    await alignWeekGrid(win, 7)
    const dragPoints = await win.evaluate(() => {
      const source = document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')
      const today = new Date()
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
      const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
      const target = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
      const timerow = document.querySelector('.amx-cal-timerow')
      if (!source || !target || !timerow) return null
      const sr = source.getBoundingClientRect()
      const tr = target.getBoundingClientRect()
      const zoom = target.currentCSSZoom || 1
      const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
      const grab = sr.height / 2
      return {
        from: { x: sr.left + sr.width / 2, y: sr.top + grab },
        to: { x: tr.left + tr.width / 2, y: tr.top + 14 * hourPx * zoom + grab },
      }
    })
    if (!dragPoints) throw new Error('无法计算 125% 缩放下的拖拽落点')
    await win.mouse.move(dragPoints.from.x, dragPoints.from.y)
    await win.mouse.down()
    await win.mouse.move(dragPoints.to.x, dragPoints.to.y, { steps: 12 })
    await win.mouse.up()
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作，14:00"]', { timeout: 5000 })
    const dragLanding = await win.evaluate(() => {
      const event = document.querySelector('.amx-cal-event[aria-label^="产品深度工作，14:00"]')
      const cell = event?.closest('.amx-cal-daycol2')
      const timerow = document.querySelector('.amx-cal-timerow')
      const er = event?.getBoundingClientRect()
      const cr = cell?.getBoundingClientRect()
      if (!er || !cr || !cell || !timerow) return null
      const zoom = cell.currentCSSZoom || 1
      const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
      return { yDelta: Math.abs(er.top - (cr.top + 14 * hourPx * zoom)), xInside: er.left >= cr.left && er.right <= cr.right }
    })
    check('125% 缩放下拖拽事件命中目标日期与时刻', dragLanding && dragLanding.yDelta <= 2.5 && dragLanding.xInside, JSON.stringify(dragLanding))
    await win.keyboard.press(`${MOD}+z`)
    check('⌘Z 撤销刚才的拖动(回到原来的时刻)', await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作，09:00"]', { timeout: 5000 }).then(() => true, () => false))
    await forceZoom(win, 1)

    // ── 10-16 Codex computer use 走查找到的几处 ──
    // ① 松手那一下没送到(之后的移动报「没按键」):按松手收尾,不留淡影 / 浮着的块
    const lost = await win.evaluate(() => {
      const s = document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')?.getBoundingClientRect()
      return s ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : null
    })
    const lostTo = await slotPoint(win, d1, 14 * 60)
    await win.mouse.move(lost.x, lost.y)
    await win.mouse.down()
    await win.mouse.move(lostTo.x, lostTo.y + 10, { steps: 10 })
    await win.evaluate(({ x, y }) => {
      const el = document.querySelector('.amx-cal-event.dragging')
      el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, clientX: x, clientY: y }))
    }, { x: lostTo.x, y: lostTo.y + 30 })
    await win.waitForTimeout(400)
    const lostState = await win.evaluate(() => ({
      leftovers: document.querySelectorAll('.amx-cal-event.dragging, .amx-cal-event.drag-shadow, .amx-cal-event.dup-src').length,
      label: document.querySelector('.amx-cal-event[aria-label^="产品深度工作"]')?.getAttribute('aria-label') ?? '',
    }))
    await win.mouse.up()
    check('拖动中松手丢了:下一次移动按松手收尾,不留淡影 / 浮块(走查截图 67 的样子)', lostState.leftovers === 0 && !/，09:00/.test(lostState.label), JSON.stringify(lostState))
    await win.keyboard.press(`${MOD}+z`)
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作，09:00"]', { timeout: 5000 }).catch(() => {})
    // ② 1200 宽的窗口(两侧栏都开着):「周」仍是 7 列,按钮写「周」;右栏待办不横向溢出(日期没被截)
    await win.setViewportSize({ width: 1200, height: 820 })
    await win.waitForTimeout(900)
    const w1200 = await win.evaluate(() => {
      const todo = document.querySelector('.amx-calside2 .amx-todo')
      const side = document.querySelector('.amx-calside2')?.getBoundingClientRect()
      const dues = [...document.querySelectorAll('.amx-calside2 .amx-todo-due')].map((e) => e.getBoundingClientRect().right)
      return {
        // 时间格是一条连续横向滚动的长带(几百天都在 DOM 里):数「完整落在可视区里的」列
        cols: (() => { const v = document.querySelector('.amx-cal-tscroll')?.getBoundingClientRect(); return v ? [...document.querySelectorAll('.amx-cal-daycol2')].filter((c) => { const r = c.getBoundingClientRect(); return r.left >= v.left - 1 && r.right <= v.right + 1 }).length : -1 })(),
        colW: Math.round(document.querySelector('.amx-cal-daycol2')?.getBoundingClientRect().width ?? 0),
        modeBtn: [...document.querySelectorAll('.amx-cal-bar button')].map((b) => b.textContent?.trim() ?? '').find((x) => /^(周|3 日|日|月)$/.test(x)) ?? '',
        todoOverflow: todo ? todo.scrollWidth - todo.clientWidth : -1,
        dueOut: side ? dues.filter((r) => r > side.right - 4).length : -1,
      }
    })
    check('1200 宽:「周」显示 7 列且列宽 ≥ 84,按钮写「周」', w1200.cols === 7 && w1200.colW >= 84 && w1200.modeBtn.startsWith('周'), JSON.stringify(w1200))
    check('1200 宽:右栏待办不横向溢出,日期不被截', w1200.todoOverflow <= 1 && w1200.dueOut === 0, JSON.stringify(w1200))
    // ③ 左栏 ⋯ 菜单 Esc 能收起
    await win.locator('.amx-calcfg-row', { hasText: '产品日历' }).locator('.amx-calcfg-more').click()
    const menuOpen = await win.locator('.amx-calcfg-menu').count()
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    check('日历列表 ⋯ 菜单按 Esc 收起', menuOpen === 1 && (await win.locator('.amx-calcfg-menu').count()) === 0, `open=${menuOpen}`)
    // ④ 点过小月历(焦点在左栏)后,T 照样回今天
    await win.locator('.amx-mini-nav').nth(1).click()
    await win.locator('.amx-mini-day:not(.out)').nth(14).click()
    await win.waitForTimeout(500)
    const todayVisible = (iso) => win.evaluate((iso) => {
      const v = document.querySelector('.amx-cal-tscroll')?.getBoundingClientRect()
      const c = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)?.getBoundingClientRect()
      return !!v && !!c && c.left >= v.left - 1 && c.right <= v.right + 1
    }, iso)
    const awayToday = !(await todayVisible(d0))
    await win.keyboard.press('t')
    await win.waitForTimeout(600)
    const backToday = await todayVisible(d0)
    check('点过小月历后按 T 回到今天(不用先点一下日历)', awayToday && backToday, JSON.stringify({ awayToday, backToday }))

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
    await win.waitForTimeout(200)
    // 草稿卡观感:最右一列(卡片翻到块左边、不盖右栏)
    const edgeDay = await win.evaluate(() => {
      const v = document.querySelector('.amx-cal-tscroll').getBoundingClientRect()
      return [...document.querySelectorAll('.amx-cal-daycol2')].filter((c) => { const r = c.getBoundingClientRect(); return r.left >= v.left - 1 && r.right <= v.right + 1 }).at(-1)?.dataset.date ?? null
    })
    const pShot = await slotPoint(win, edgeDay, 11 * 60)
    await win.mouse.click(pShot.x, pShot.y)
    await win.waitForSelector('.amx-cal-draftcard', { timeout: 3000 }).catch(() => {})
    await win.keyboard.type('评审会')
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, 'calendar-ui-draft.png') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    await forceMode(win, 'dark')
    await win.locator('.amx-cal-event[aria-label^="产品深度工作"]').click()
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(OUT, 'calendar-ui-dark.png') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await resetParity(win, '深色')
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
