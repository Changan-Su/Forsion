/**
 * 待办视图端到端契约(真 Electron,隔离 vault,不碰用户数据)。
 *
 * 钉的是 2026-08-29 那轮改造的判据 —— 它们全都**不是**几何断言能覆盖的:
 *  1 ⚠️**笔记正文 `- [ ]` 必须出现在待办栏**。这是整轮改造的验收判据:改造前生产库里
 *    一个合格日历成员库都没有(4 张 .db 全无日期列),待办栏渲染的是空态引导文案,
 *    而用户真实的 89 条待办躺在两篇笔记正文里,系统完全看不见。
 *  2 未排期桶按「笔记 › 标题」二级分组 —— 正文任务天然全部无日期,时间语义桶对它们
 *    不组织任何东西,来源笔记是唯一可用的维度。
 *  3 ⚠️**空桶不渲染**。没有明天到期的东西就不该有「明天」段头。
 *  4 桶序硬编码:逾期段的 DOM 位置必须在今天段之前(单测钉 ORDER 数组,这里钉真实渲染)。
 *  5 围栏代码块里的 `- [ ]` 不算任务(解析口径,与 shared/amadeus/mdTasks.test.ts 互锁)。
 *  6 已完成收进底部默认折叠的段,不是消失。
 *  7 快速添加:回车即落进「今天」桶(写路径 = createAggEvent,目标库须可写)。
 *  8 点正文任务 = 打开那篇笔记(**不在这里回写正文**,勾在编辑器里勾)。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:todo
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先把它关掉。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.TODO_VIEW_ARTIFACT_DIR || path.join(os.tmpdir(), 'forsion-todo-view')
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
  if (!clicked) throw new Error(`找不到 Space:${names.join('/')}`)
}

/** 侧栏当前渲染出来的分段标题(按 DOM 顺序)。 */
const sections = (win) => win.evaluate(() => [...document.querySelectorAll('.amx-todo-gname')].map((e) => e.textContent.trim()))
/** 侧栏当前**看得见**的待办名(按 DOM 顺序)。
 *  ⚠️ 折叠改成 CSS grid 0fr↔1fr 之后内容恒在 DOM 里,只是被收成 0 高 —— 这里必须限定
 *  `.amx-todo-reveal.is-open`,否则「已完成默认折叠」那条会假绿(折起来的行照样被 querySelectorAll 拿到)。 */
const names = (win) => win.evaluate(() => [...document.querySelectorAll('.amx-todo-reveal.is-open .amx-todo-name')].map((e) => e.textContent.trim()))

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先跑 npm run build')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-todo-view-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  const userDataDev = `${userData}-dev`
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(userDataDev, { recursive: true })

  const today = new Date()
  const d0 = ymd(today)
  const dm1 = ymd(addDays(today, -1))

  // 多维表来源:一条逾期、一条今天、一条无日期、一条已完成。刻意**没有明天的**(验空桶不渲染)。
  fs.writeFileSync(path.join(vault, 'calendar-demo.db'), `${JSON.stringify({
    version: 1,
    name: '产品日历',
    columns: [
      { id: 'name', name: '名称', type: 'text' },
      { id: 'date', name: '日期', type: 'calendarDate' },
      { id: 'done', name: '完成', type: 'checkbox' },
    ],
    rows: [
      { id: 'r-overdue', cells: { name: '补交上周总结', date: dm1 } },
      { id: 'r-today', cells: { name: '周度复盘', date: `${d0}T15:00/${d0}T16:00` } },
      { id: 'r-undated', cells: { name: '没有日期的表行' } },
      { id: 'r-done', cells: { name: '已经做完的事', date: d0, done: true } },
    ],
  }, null, 2)}\n`)

  // 笔记正文任务:两个标题各带任务,外加一条围栏代码块里的假任务 + 一条已完成。
  fs.writeFileSync(path.join(vault, '开发计划.md'), [
    '# 开发计划',
    '',
    '## 平台与产品',
    '',
    '* [ ] 考虑微信小程序',
    '* [ ] 给 Tangu 增加命令输入',
    '* [x] 已经发布的东西',
    '',
    '## 模型与体验',
    '',
    '- [ ] 给流式输出增加渐隐效果',
    '',
    '```md',
    '- [ ] 代码块里的假任务',
    '```',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 待办视图检查\n')
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

    // 先进 Amadeus 让 vaultRoot 与全库扫描就绪(同 calendar-ui.check.cjs)。
    await clickSpace(win, ['Amadeus'])
    await win.waitForSelector('.am-app', { timeout: 30_000 })
    await win.waitForTimeout(2400)
    await clickSpace(win, ['日历', 'Calendar'])
    await win.waitForSelector('.amx-todo', { timeout: 30_000 })
    // 正文任务经一次 IPC 拉回来(store 里有 250ms 防抖),给足时间。
    await win.waitForTimeout(2500)

    const shown = await names(win)
    const secs = await sections(win)

    check('1 笔记正文的 `- [ ]` 出现在待办栏', shown.includes('考虑微信小程序') && shown.includes('给流式输出增加渐隐效果'), JSON.stringify(shown))

    const srcs = await win.evaluate(() => [...document.querySelectorAll('.amx-todo-reveal.is-open .amx-todo-src')].map((e) => e.firstChild?.textContent?.trim() ?? ''))
    check('2 未排期桶按「笔记 › 标题」二级分组', srcs.includes('开发计划 › 平台与产品') && srcs.includes('开发计划 › 模型与体验'), JSON.stringify(srcs))

    check('3 空桶不渲染(没有明天到期的东西 → 没有「明天」段)', !secs.includes('明天') && secs.includes('逾期') && secs.includes('今天'), JSON.stringify(secs))
    check('4 桶序硬编码:逾期段在今天段之前', secs.indexOf('逾期') >= 0 && secs.indexOf('逾期') < secs.indexOf('今天'), JSON.stringify(secs))
    check('5 围栏代码块里的任务不算待办', !shown.includes('代码块里的假任务'))

    const doneIdx = secs.indexOf('已完成')
    const doneCount = await win.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-todo-ghead')]
      const hit = heads.find((h) => h.querySelector('.amx-todo-gname')?.textContent?.trim() === '已完成')
      return hit ? Number(hit.querySelector('.amx-todo-gcount')?.textContent ?? '-1') : -1
    })
    check('6 已完成收进底部默认折叠的段(不是消失),计数含表行与正文任务', doneIdx === secs.length - 1 && doneCount === 2 && !shown.includes('已经做完的事'), `idx=${doneIdx}/${secs.length} count=${doneCount}`)

    // 13 折叠动画:收起态高度必须真的是 0,且 grid-template-rows 与 caret 都带过渡
    //    (条件渲染没有可插值的中间态 = 瞬跳;这条就是钉住「别改回条件渲染」)。
    const fold = await win.evaluate(() => {
      const shut = [...document.querySelectorAll('.amx-todo-reveal')].find((e) => !e.classList.contains('is-open'))
      const open = document.querySelector('.amx-todo-reveal.is-open')
      const caret = document.querySelector('.amx-todo-caret')
      const dur = (e) => (e ? parseFloat(getComputedStyle(e).transitionDuration) || 0 : 0)
      return {
        shutH: shut ? Math.round(shut.getBoundingClientRect().height) : -1,
        openH: open ? Math.round(open.getBoundingClientRect().height) : -1,
        revealDur: dur(shut || open),
        prop: shut ? getComputedStyle(shut).transitionProperty : '',
        caretDur: dur(caret),
      }
    })
    check('13 折叠有过渡:收起态高度为 0,reveal 与 caret 都带 transition', fold.shutH === 0 && fold.openH > 0 && fold.revealDur > 0 && fold.caretDur > 0 && fold.prop.includes('grid-template-rows'), JSON.stringify(fold))

    // 14 展开一个默认折叠的段,内容真的出现(动画结束后)
    await win.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-todo-ghead')]
      const hit = heads.find((h) => h.querySelector('.amx-todo-gname')?.textContent?.trim() === '已完成')
      hit?.click()
    })
    await win.waitForTimeout(600)
    const afterOpen = await names(win)
    check('14 展开「已完成」后其内容真的出现', afterOpen.includes('已经做完的事'), JSON.stringify(afterOpen.slice(0, 8)))
    await win.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-todo-ghead')]
      const hit = heads.find((h) => h.querySelector('.amx-todo-gname')?.textContent?.trim() === '已完成')
      hit?.click()
    })
    await win.waitForTimeout(600)

    // 7 快速添加 → 落进「今天」桶。
    const input = win.locator('.amx-todo-addinput')
    await input.waitFor({ timeout: 5000 })
    await input.fill('临时加一条')
    await input.press('Enter')
    await win.waitForTimeout(900)
    const after = await names(win)
    const todayNames = await win.evaluate(() => {
      const groups = [...document.querySelectorAll('.amx-todo-group')]
      const hit = groups.find((g) => g.querySelector('.amx-todo-gname')?.textContent?.trim() === '今天')
      return hit ? [...hit.querySelectorAll('.amx-todo-reveal.is-open .amx-todo-name')].map((e) => e.textContent.trim()) : []
    })
    check('7 快速添加回车即落进「今天」桶', after.includes('临时加一条') && todayNames.includes('临时加一条'), JSON.stringify(todayNames))

    // 8 点正文任务 = 打开那篇笔记(不回写正文)。
    const before = fs.readFileSync(path.join(vault, '开发计划.md'), 'utf8')
    await win.locator('.amx-todo-name', { hasText: '考虑微信小程序' }).first().click()
    await win.waitForTimeout(2200)
    const opened = await win.evaluate(() => [...document.querySelectorAll('.wb-tab, .dv-tab, [role="tab"]')].map((e) => e.textContent.trim()).join('|'))
    const afterText = fs.readFileSync(path.join(vault, '开发计划.md'), 'utf8')
    check('8 点正文任务打开那篇笔记,且一个字节都没往正文里写', opened.includes('开发计划') && afterText === before, opened.slice(0, 120))

    // 两种勾选框(多维表行走 astryx CheckboxInput,正文任务是自绘方框)几何必须对得上,
    // 否则同一列表里两类行的左边距会错开 —— 截图一眼看得出,几何断言才说得清差多少。
    const boxes = await win.evaluate(() => {
      const cb = document.querySelector('.amx-todo-item input[type="checkbox"]')
      const el = cb ? (cb.offsetWidth ? cb : cb.parentElement) : null
      const own = document.querySelector('.amx-todo-box')
      const r = (e) => (e ? e.getBoundingClientRect() : null)
      const a = r(el)
      const b = r(own)
      return a && b ? { aw: Math.round(a.width), bw: Math.round(b.width), dx: Math.round(Math.abs(a.left - b.left)) } : null
    })
    check('11 两种勾选框宽度与左缘对齐(差 ≤2px)', boxes && Math.abs(boxes.aw - boxes.bw) <= 2 && boxes.dx <= 2, JSON.stringify(boxes))

    await win.screenshot({ path: path.join(OUT, 'todo-view-light.png') })
    // ⚠️ 暗色必须**重载**切,不能只改 localStorage + DOM 属性。
    //    AstryxScope 读的是 themeStore 的 zustand `mode`(theme/astryxBridge.tsx),外部改属性它不跟 →
    //    astryx 子树停在 data-theme="light" → `color-scheme: light` → 暗底上一排**实心白**原生勾选框。
    //    那是台架假象,不是产品回归;实测走过这个坑,别把这段改回去省那几秒。
    await win.evaluate(() => {
      localStorage.setItem('forsion_theme_pref', 'dark')
      localStorage.setItem('forsion_theme', 'dark')
    })
    await win.reload()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    await clickSpace(win, ['日历', 'Calendar'])
    await win.waitForSelector('.amx-todo', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    const darkOk = await win.evaluate(() => {
      const cb = document.querySelector('.amx-todo-item input[type="checkbox"]')
      return { mode: document.documentElement.dataset.mode, cs: cb ? getComputedStyle(cb).colorScheme : null }
    })
    check('12 暗色下 astryx 子树也是暗的(原生勾选框不会变成实心白)', darkOk.mode === 'dark' && darkOk.cs === 'dark', JSON.stringify(darkOk))
    await win.screenshot({ path: path.join(OUT, 'todo-view-dark.png') })
    check('9 明暗主题截图均已产出', fs.existsSync(path.join(OUT, 'todo-view-light.png')) && fs.existsSync(path.join(OUT, 'todo-view-dark.png')), OUT)

    check('10 待办链路无渲染异常', errors.length === 0, errors.slice(0, 2).join(' / '))
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过;截图:${OUT}`)
  if (bad.length) process.exit(1)
}

main().catch((e) => {
  console.error('检查失败:', e)
  process.exit(1)
})
