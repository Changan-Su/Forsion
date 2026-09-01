/**
 * 待办视图端到端契约(真 Electron,隔离 vault,不碰用户数据)。
 *
 * 钉的是 2026-08-29 那轮改造 + 2026-08-31 `@` 标记闸门的判据 —— 全都**不是**几何断言能覆盖的:
 *  1 ⚠️**带 `@` 标记的笔记正文 `- [ ]` 必须出现在待办栏**,并按标记的日期落桶。
 *  2 ⚠️**没有 `@` 标记的 `- [ ]` 一条都不许进**(2026-08-31 用户实报「只要有勾选框就识别进去」
 *    的误报,`@` 是显式闸门);**没有勾选框的 `@` 行也不进待办**(那是日程,归日历)。
 *  15 那条同轮验收:日程行必须真的出现在日历网格上。
 *  3 ⚠️**空桶不渲染**。没有明天到期的东西就不该有「明天」段头。
 *  4 桶序硬编码:逾期段的 DOM 位置必须在今天段之前(单测钉 ORDER 数组,这里钉真实渲染)。
 *  5 围栏代码块里的 `- [ ]` 不算任务(解析口径,与 shared/amadeus/mdMarks.test.ts 互锁)。
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
/** n 分钟前的 calDate 串(用来种一条「该响了」的提醒)。 */
const hmAgo = (n) => { const t = new Date(Date.now() - n * 60_000); return `${ymd(t)}T${pad(t.getHours())}:${pad(t.getMinutes())}` }

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

  // 笔记正文:带 `@` 标记的任务(落各自的桶)+ 三条负对照(裸勾选框 / 无勾选框的日程行 / 代码块)。
  fs.writeFileSync(path.join(vault, '开发计划.md'), [
    '# 开发计划',
    '',
    '## 平台与产品',
    '',
    `* [ ] 考虑微信小程序 @${dm1}`,
    `* [ ] 给 Tangu 增加命令输入 @${d0}`,
    `* [x] 已经发布的东西 @${d0}`,
    '* [ ] 没打标记的勾选框',
    '',
    '## 模型与体验',
    '',
    `- [ ] 给流式输出增加渐隐效果 @${d0}`,
    `- 产品评审会 @${d0}T11:00/${d0}T12:00`,
    `* [ ] 吃药 @remind:${hmAgo(2)}`,
    '',
    '```md',
    `- [ ] 代码块里的假任务 @${d0}`,
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

    check('1 带 @ 标记的正文 `- [ ]` 出现在待办栏', shown.includes('考虑微信小程序') && shown.includes('给流式输出增加渐隐效果'), JSON.stringify(shown))

    // 标记文本本身不许留在待办名里(解析器摘干净了才对)。
    check('1b 待办名里不含 `@` 标记原文', shown.every((n) => !n.includes('@')), JSON.stringify(shown))

    // ⚠️ 本轮核心验收:两条负对照。任一变绿都说明闸门没生效。
    check('2 没有 @ 标记的 `- [ ]` 不进待办', !shown.includes('没打标记的勾选框'), JSON.stringify(shown))
    check('2b 没有勾选框的 @ 行不进待办(它是日程)', !shown.includes('产品评审会'), JSON.stringify(shown))

    // 按 @ 的日期落桶:昨天的进逾期、今天的进今天。
    const bucketOfName = (name) => win.evaluate((n) => {
      const g = [...document.querySelectorAll('.amx-todo-group')]
        .find((x) => [...x.querySelectorAll('.amx-todo-name')].some((e) => e.textContent.trim() === n))
      return g?.querySelector('.amx-todo-gname')?.textContent?.trim() ?? ''
    }, name)
    const bOverdue = await bucketOfName('考虑微信小程序')
    const bToday = await bucketOfName('给 Tangu 增加命令输入')
    check('2c 正文待办按 @ 的日期落桶(昨天→逾期、今天→今天)', bOverdue === '逾期' && bToday === '今天', `${bOverdue}/${bToday}`)

    // 15 无勾选框的 `@` 行 = 日程:必须出现在日历网格上(mdCalDbs 合成只读源)。
    // ⚠️ 必须在浅色这一趟量:后面那趟 reload 之后主区还在重挂,量到的是空数组(假红)。
    const evTitles = await win.evaluate(() => [...document.querySelectorAll('.amx-cal-event-title')].map((e) => e.textContent.trim()))
    check('15 无勾选框的 @ 行出现在日历网格上', evTitles.includes('产品评审会'), JSON.stringify(evTitles.slice(0, 8)))

    // 16 `@remind:` 到点真的弹出通知卡(整条链:装配 → listMarks → pendingReminders → notifyApp)。
    //    ⚠️ 必须在浅色这一趟量:①后面那趟 reload 会清掉内存里的卡;②已弹记录落 localStorage,
    //       reload 后同一条被去重压掉 —— 在那边量是**必然假红**。
    const ntf = await win.evaluate(() => ({
      cards: [...document.querySelectorAll('.ntf')].map((e) => e.textContent.trim()),
      more: document.querySelector('.ntf-more')?.textContent ?? '',
    }))
    check('16 `@remind:` 到点弹出通知卡', ntf.cards.some((t) => t.includes('吃药')), JSON.stringify(ntf))

    // 19 日历侧可编辑投影。⚠️ 必须在 8「点待办打开笔记」**之前**跑:那一步把主区换成笔记 tab,
    //    日历网格就不在 DOM 里了(实测踩过,`.amx-cal-event` 等 30s 超时)。
    // 19 日历侧可编辑投影:点开笔记事件的卡片 → 有「打开笔记」且时间可改 → 改期回写 `@` 串。
    // ⚠️ 必须真鼠标点:合成 MouseEvent(clientX/Y=0)进不了拖拽层的落点判定,卡片不会开(实测)。
    await win.locator('.amx-cal-event', { hasText: '产品评审会' }).first().click()
    await win.waitForTimeout(700)
    const cardFoot = await win.evaluate(() => document.querySelector('.amx-cal-card-open')?.textContent?.trim() ?? '')
    check('19 笔记事件的卡片指向「打开笔记」而不是假的数据库路径', cardFoot.includes('打开笔记'), JSON.stringify(cardFoot))
    const timeBtn = win.locator('.amx-cal-card-timebtn')
    if (await timeBtn.count()) await timeBtn.first().click()
    await win.waitForTimeout(300)
    const dateIn = win.locator('.amx-cal-card-timeedit input[type="date"]').first()
    const editable = await dateIn.count()
    const d1 = ymd(addDays(today, 3))
    if (editable) { await dateIn.fill(d1); await win.waitForTimeout(2200) }
    const afterCal = fs.readFileSync(path.join(vault, '开发计划.md'), 'utf8')
    check('19b 日历上改期 → 笔记里那个 `@` 串被回写', editable > 0 && afterCal.includes(`产品评审会 @${d1}T11:00`),
      JSON.stringify(afterCal.split('\n').find((l) => l.includes('产品评审会'))))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

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

    // 8 点正文任务的**名字** = 只打开那篇笔记,一个字节都不写(写盘只发生在勾选框上,见 17)。
    const before = fs.readFileSync(path.join(vault, '开发计划.md'), 'utf8')
    await win.locator('.amx-todo-name', { hasText: '考虑微信小程序' }).first().click()
    await win.waitForTimeout(2200)
    const opened = await win.evaluate(() => [...document.querySelectorAll('.wb-tab, .dv-tab, [role="tab"]')].map((e) => e.textContent.trim()).join('|'))
    const afterText = fs.readFileSync(path.join(vault, '开发计划.md'), 'utf8')
    check('8 点正文任务打开那篇笔记,且一个字节都没往正文里写', opened.includes('开发计划') && afterText === before, opened.slice(0, 120))

    // 17 ⚠️ 本轮核心:待办列表里**就地勾** → 按内容回写笔记那一行(`- [ ]`→`- [x]`)。
    //    此刻「开发计划」已被 8 打开在编辑器里 —— 顺带把「主进程写盘 → externalChange 回灌」那一段也走到。
    const planPath = path.join(vault, '开发计划.md')
    await win.evaluate(() => {
      const li = [...document.querySelectorAll('.amx-todo-item')]
        .find((e) => e.querySelector('.amx-todo-name')?.textContent?.trim() === '考虑微信小程序')
      li?.querySelector('input[type="checkbox"]')?.click()
    })
    await win.waitForTimeout(2000) // 覆盖 400ms 防抖 + IPC 往返 + 重拉
    const patched = fs.readFileSync(planPath, 'utf8')
    // ⚠️ 不比行数:这篇此刻正开在 v4 编辑器里,回灌之后它自己那发保存会把散装 .md 转成 unified 结构
    //    (加 frontmatter 与块注释)。那是编辑器本来的生命周期,不是本轮的写入 —— 要钉的是
    //    「那一行被改成 [x]、别的行一字不丢」。
    const keep = ['给 Tangu 增加命令输入', '给流式输出增加渐隐效果', '没打标记的勾选框', '产品评审会', '吃药']
    check('17 待办就地勾 → 笔记那一行被改写成 `- [x]`',
      /\[x\] 考虑微信小程序 @/.test(patched),
      `line=${JSON.stringify(patched.split('\n').find((l) => l.includes('考虑微信小程序')))}`)
    check('17b 只改了那一行:同篇别的行一字不丢、别的任务仍未勾',
      keep.every((k) => patched.includes(k)) && /\[ \] 给 Tangu 增加命令输入 @/.test(patched),
      JSON.stringify(keep.filter((k) => !patched.includes(k))))

    // 18 负对照:raw 对不上(行已被改)→ patchMark 返回 false,**绝不模糊匹配**、一个字节不写。
    const beforeNc = fs.readFileSync(planPath, 'utf8')
    const bad = await win.evaluate(() => window.amadeus.patchMark('开发计划.md', '- [ ] 这一行不存在 @2026-01-01', 0, '被改坏了'))
    check('18 负对照:raw 对不上时 patchMark=false 且文件一个字节不变',
      bad === false && fs.readFileSync(planPath, 'utf8') === beforeNc, `ret=${bad}`)



    // 多维表行与正文任务行现在都是 astryx CheckboxInput(2026-09-01 就地勾之后不再有自绘方框),
    // 但两类行仍出自不同分支 —— 左缘/宽度错开一眼看得出,几何断言才说得清差多少。
    const boxes = await win.evaluate(() => {
      const els = [...document.querySelectorAll('.amx-todo-reveal.is-open .amx-todo-item input[type="checkbox"]')]
        .map((cb) => (cb.offsetWidth ? cb : cb.parentElement))
        .filter(Boolean)
        .map((e) => e.getBoundingClientRect())
      if (els.length < 2) return null
      const lefts = els.map((r) => Math.round(r.left))
      const widths = els.map((r) => Math.round(r.width))
      return { n: els.length, dx: Math.max(...lefts) - Math.min(...lefts), dw: Math.max(...widths) - Math.min(...widths) }
    })
    check('11 全部勾选框(表行 + 正文任务)宽度与左缘对齐(差 ≤2px)', boxes && boxes.dx <= 2 && boxes.dw <= 2, JSON.stringify(boxes))

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
