// v4 统一编辑器的三件菜单:选区工具栏 / 块菜单(⠿)/ slash 菜单 —— 「哪个上下文显示哪些项、点了做什么」
// (Amadeus 评审 2026-09-27 波次 2 · menus 包)。全部跑生产 UnifiedPage(台架 `?upage`),落盘以 window.__upage.writes 为准。
//   I9   ⌘E = 行内代码(对齐改 ⌘⇧L/E/R);选区上敲反引号 = 行内代码,不是两个字面反引号(I-09 / K-18b)
//   I10  ⌘K 碰到已有链接 = 扩到整条、预填原地址、可「移除链接」;空选区 = 插一条新链接(I-10)
//   I12  选区工具栏在鼠标按住(拖选)期间不出、松手才出;向上拖选不被它挡住;键盘选区照旧即时出(I-12)
//   I19  选区工具栏看上下文:代码块里只留「转换为 / 清除」;单元格里不列「转换为」与对齐;链接 / 下划线 / 颜色显示当前状态;
//        转换做不成要么真转了、要么给提示,不许静默(I-19)
//   I20  选区工具栏键盘可达 + ARIA:Alt+F10 进工具栏(焦点进去工具栏不被卸载)、←→ 移动、Enter 触发、子面板键盘开 +
//        ↓ 选项、Esc 退回编辑器;格式钮有 aria-pressed / aria-label(I-20)
//   B4   块菜单对折起的标题:「复制块」「移动到…」以整节为单位(B-04)
//   B5   块菜单作用于多块选区:「转换为」逐块生效(列表并成一只,一次撤销全回)、「移到新列」置灰并说明(B-05)
//   B7   列表 / 引用(callout)空行里 slash 插整块 = 原地换掉这一行,不留空项残渣,callout 里的代码块不跑出去(B-07)
//   B10  块菜单开着时:方向键不挪编辑器选区(在菜单项间移动)、Enter 执行聚焦项、动作落在打开时的那一块;
//        role=menu / menuitem;键盘打开把焦点送进菜单(B-10)
//   B11  对 callout「转换为」先摘 `[!type]` 令牌再整只转(正文 / 标题 / 列表 / 引用 / 折叠 / 代码块)(B-11)
//   B14  块菜单「转换为」有代码块(按原文造,不把文字挪到空代码块下面)与标注(`[!note]`)(B-14)
//   B15  块菜单「复制标题链接」(`[[笔记#标题]]`)/「复制块链接」(只给已有 `^id` 的块)/「移动到…」(追加到目标末尾再删源);
//        /embed 说明不再指向 v4 没有的「复制嵌入引用」(B-15)
//   B17  为触发 slash 补的那个空格不留在转换结果里(`段甲内容 /h2` → `## 段甲内容`)(B-17 只修这半)
//   B18  不适用就不列:单元格里 `/` 不开菜单(一项都做不成);列表项里 slash 不列「分栏 / 卡片」;
//        块菜单「移到新列」只对顶层单块列出(B-18)
//   B19  ＋ 插新块并当场开 slash 菜单,Esc 把 ＋ 敲的 `/` 删干净;Alt+点 = 插到上方;列表项上点 = 同级新项、列表不劈(B-19 / B-19b)
// 用法:npm run check:menus(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL)。`--only=I9,B10` 只跑指定组。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)).split(',').filter(Boolean)
const want = (g) => !ONLY.length || ONLY.includes(g)
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function open(browser) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&useed=${encodeURIComponent('# t\n\nx\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  return page
}
let seq = 0
/** 同一页换一篇新笔记(比整页重开快);返回文件名,落盘按它过滤。 */
async function load(page, md, name = `Menus${++seq}.md`) {
  await page.evaluate(({ name, md }) => window.__upage.switchFile(name, md), { name, md })
  await page.waitForFunction((name) => {
    const v = window.__upage.probe.view && window.__upage.probe.view()
    return v && !v.isDestroyed && document.querySelector('.unified-body .ProseMirror') && v.state.doc.textContent.length >= 0
  }, name, { timeout: 30000 })
  await page.waitForTimeout(350)
  return name
}
/** 该文件最后一次落盘(等过防抖)。 */
async function mdOf(page, name) {
  await page.waitForTimeout(1100)
  return page.evaluate((name) => {
    const w = window.__upage.writes.filter((x) => x.path === name)
    return w.length ? w[w.length - 1].text : null
  }, name)
}
/** 选中正文里第 nth 处 text(PM 选区直派;不赌点击后的异步 selectionchange)。 */
const selectText = (page, text, nth = 0) => page.evaluate(({ text, nth }) => {
  const v = window.__upage.probe.view()
  let hit = null
  let k = 0
  v.state.doc.descendants((n, p) => {
    if (hit || !n.isText) return !hit
    let i = n.text.indexOf(text)
    while (i >= 0 && !hit) {
      if (k++ === nth) hit = { from: p + i, to: p + i + text.length }
      i = n.text.indexOf(text, i + 1)
    }
    return false
  })
  if (!hit) return false
  v.focus()
  const S = v.state.selection.constructor
  v.dispatch(v.state.tr.setSelection(S.create(v.state.doc, hit.from, hit.to)))
  return true
}, { text, nth })
/** 光标放到第 nth 处 text 之后(atStart:之前)。 */
const caretAt = (page, text, atStart = false) => page.evaluate(({ text, atStart }) => {
  const v = window.__upage.probe.view()
  let hit = null
  v.state.doc.descendants((n, p) => {
    if (hit != null || !n.isText) return hit == null
    const i = n.text.indexOf(text)
    if (i >= 0) hit = p + i + (atStart ? 0 : text.length)
    return false
  })
  if (hit == null) return false
  v.focus()
  const S = v.state.selection.constructor
  v.dispatch(v.state.tr.setSelection(S.create(v.state.doc, hit, hit)))
  return true
}, { text, atStart })
/** 等一个选择器出现;超时返回 false(不抛:一格红不该中断后面的组)。 */
const waitSel = (page, sel, timeout = 3000) => page.waitForSelector(sel, { timeout }).then(() => true, () => false)
/** 工具栏现状:露了哪些 data-act、哪些亮着、有没有「转换为」/ 颜色钮。 */
const toolbar = (page) => page.evaluate(() => {
  const tb = document.querySelector('[data-testid=inline-toolbar]')
  if (!tb) return null
  const acts = [...tb.querySelectorAll('.itb-row [data-act]')]
  return {
    acts: acts.map((b) => b.dataset.act),
    on: acts.filter((b) => b.classList.contains('on')).map((b) => b.dataset.act),
    turn: !!tb.querySelector('.itb-turn'),
    kind: tb.querySelector('.itb-turn')?.textContent.trim() ?? null,
    color: !!tb.querySelector('.itb-color'),
    fg: tb.querySelector('.itb-color')?.dataset.fg ?? null,
  }
})
/** 顶层块里文字以 prefix 开头的那一块的矩形。 */
const rectOf = (page, prefix, sel = ':scope > *') => page.evaluate(({ PM, prefix, sel }) => {
  const el = [...document.querySelector(PM).querySelectorAll(sel)].find((x) => x.textContent.trim().startsWith(prefix))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}, { PM, prefix, sel })
/** 真鼠标拖选:从 a 块开头拖到 b 块末尾之外。 */
async function dragSelect(page, a, b) {
  const ra = await rectOf(page, a)
  const rb = await rectOf(page, b)
  await page.mouse.move(ra.x + 1, ra.y + ra.h / 2)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.w - 2, rb.y + rb.h / 2, { steps: 8 })
  await page.mouse.move(rb.x + rb.w + 60, rb.y + rb.h / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(200)
}
/** 悬停 prefix 那一块 → 点它的 ⠿,等块菜单出来。 */
async function openHandleMenu(page, prefix) {
  const r = await rectOf(page, prefix)
  if (!r) return false
  await page.mouse.move(r.x + 10, r.y + Math.min(10, r.h / 2), { steps: 4 })
  await page.waitForTimeout(260)
  const h = await page.evaluate(() => {
    const g = document.querySelector('.unified-gutter')
    const el = g?.querySelector('.drag-handle')
    if (!el || g.dataset.show !== 'true') return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
  })
  if (!h) return false
  await page.mouse.click(h.x, h.y)
  return waitSel(page, '.unified-block-menu')
}
/** 块菜单里文字以 label 结尾的那一项。 */
const menuItem = (page, label) => page.locator('.unified-block-menu button').filter({ hasText: label }).first()
/** 点块菜单项;没有这一项 → false(不抛,一格红不中断后面的组)。 */
const clickItem = (page, label, opts = {}) => menuItem(page, label).click({ timeout: 2000, ...opts }).then(() => true, () => false)
const shape = (page) => page.evaluate(() => {
  const o = []
  window.__upage.probe.view().state.doc.forEach((n) => {
    if (/_list$/.test(n.type.name)) { const it = []; n.forEach((li) => it.push(li.textContent)); o.push(`${n.type.name}[${it.join('|')}]`) }
    else o.push(`${n.type.name === 'paragraph' ? '' : n.type.name + (n.attrs.level ? n.attrs.level : '') + ':'}${n.textContent}`)
  })
  return o
})
/** 收集 amadeus:toast(台架不挂宿主的 toast 浮层,直接听事件)。 */
const listenToasts = (page) => page.evaluate(() => {
  if (window.__toasts) return
  window.__toasts = []
  window.addEventListener('amadeus:toast', (e) => window.__toasts.push(e.detail?.text ?? ''))
})
const toasts = (page) => page.evaluate(() => (window.__toasts || []).splice(0))
const topBlocks = (page) => page.evaluate(() => {
  const o = []
  window.__upage.probe.view().state.doc.forEach((n) => o.push(`${n.type.name}:${JSON.stringify(n.textContent)}`))
  return o.join(' / ')
})

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await open(browser)

    if (want('I9')) {
      // I9a ⌘E = 行内代码,不居中。
      {
        const nm = await load(page, '调用 fetchData 函数\n')
        await selectText(page, 'fetchData')
        await page.waitForTimeout(150)
        await page.keyboard.press('Meta+e')
        const md = await mdOf(page, nm)
        check('I9a ⌘E = 行内代码(不写对齐标记)', /调用 `fetchData` 函数/.test(md || '') && !/data-amadeus-align/.test(md || ''), JSON.stringify(md))
      }
      // I9b ⌘⇧E / ⌘⇧R / ⌘⇧L = 对齐。
      {
        const nm = await load(page, '需要对齐的正文\n')
        await selectText(page, '对齐')
        await page.keyboard.press('Meta+Shift+e')
        const c = await mdOf(page, nm)
        await page.keyboard.press('Meta+Shift+l')
        const l = await mdOf(page, nm)
        check('I9b ⌘⇧E 居中、⌘⇧L 回左对齐', /data-amadeus-align="center"/.test(c || '') && !/data-amadeus-align/.test(l || ''), JSON.stringify({ c, l }))
      }
      // I9c 选中文字敲反引号 = 行内代码(K-18b):不是两个字面反引号(落盘成 \`转义\`)。
      {
        const nm = await load(page, '甲乙丙丁。\n')
        await selectText(page, '乙丙')
        await page.keyboard.type('`')
        const md = await mdOf(page, nm)
        const sel = await page.evaluate(() => { const s = window.__upage.probe.view().state.selection; return s.to - s.from })
        check('I9c 选区敲 ` = 行内代码,选区保持', (md || '').trim() === '甲`乙丙`丁。' && sel === 2, JSON.stringify({ md, sel }))
      }
    }

    if (want('I10')) {
      const LINKED = 'alpha [甲乙丙](https://example.com/a) omega\n'
      // I10a 光标在链接中间按 ⌘K → 弹框预填原地址;改地址 → 整条链接换新地址(文字不丢、不只改一段)。
      {
        const nm = await load(page, LINKED)
        await caretAt(page, '甲乙')
        await page.keyboard.press('Meta+k')
        await waitSel(page, '.dialog-input')
        const pre = await page.inputValue('.dialog-input')
        const alt = await page.locator('.dialog-btn[data-alt]').count()
        await page.fill('.dialog-input', 'forsion.net/x')
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        check('I10a 光标在链接里 ⌘K:预填原地址 + 有「移除链接」,改地址作用于整条', pre === 'https://example.com/a' && alt === 1 && (md || '').trim() === 'alpha [甲乙丙](https://forsion.net/x) omega', JSON.stringify({ pre, alt, md }))
      }
      // I10b 只选中链接的一部分 → 「移除链接」去掉整条(不是只去选中的那段)。
      {
        const nm = await load(page, LINKED)
        await selectText(page, '乙')
        await page.keyboard.press('Meta+k')
        if (await waitSel(page, '.dialog-btn[data-alt]')) await page.click('.dialog-btn[data-alt]')
        else await page.keyboard.press('Escape')
        const md = await mdOf(page, nm)
        check('I10b 部分选中链接 →「移除链接」去掉整条', (md || '').trim() === 'alpha 甲乙丙 omega', JSON.stringify(md))
      }
      // I10c 空选区、不在链接里 → 弹「插入链接」,确认后在光标处插一条链接(文字 = 主机名)。
      {
        const nm = await load(page, 'alpha omega\n')
        await caretAt(page, 'alpha ')
        await page.keyboard.press('Meta+k')
        await waitSel(page, '.dialog-input')
        const alt = await page.locator('.dialog-btn[data-alt]').count()
        await page.fill('.dialog-input', 'forsion.net')
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        check('I10c 空选区 ⌘K → 插入新链接', alt === 0 && (md || '').trim() === 'alpha [forsion.net](https://forsion.net)omega', JSON.stringify({ alt, md }))
      }
    }

    if (want('I12')) {
      const MD = '# T\n\n第一段第一段第一段第一段第一段第一段第一段第一段\n\n第二段第二段第二段第二段第二段第二段第二段第二段\n\n第三段第三段第三段第三段第三段第三段第三段第三段\n\n第四段第四段第四段\n'
      await load(page, MD)
      const bb = await page.evaluate((PM) => [...document.querySelectorAll(`${PM} > p`)].map((p) => { const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height } }), PM)
      const start = { x: bb[3].x + 100, y: bb[3].y + bb[3].h / 2 }
      const target = { x: bb[0].x + 60, y: bb[0].y + bb[0].h / 2 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      let during = 0
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(start.x + (target.x - start.x) * i / 20, start.y + (target.y - start.y) * i / 20)
        await page.waitForTimeout(25)
        during += await page.locator('[data-testid=inline-toolbar]').count()
      }
      await page.mouse.up()
      await page.waitForTimeout(250)
      const after = await page.locator('[data-testid=inline-toolbar]').count()
      const sel = await page.evaluate(() => getSelection().toString())
      check('I12a 向上拖选:按住期间工具栏不出、第一段选得进来、松手后工具栏出现', during === 0 && sel.includes('第一段') && after === 1, JSON.stringify({ during, after, sel: sel.slice(0, 8) }))
      // I12b 键盘选区即时出。
      await caretAt(page, '第四段第四段第四段')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.waitForTimeout(200)
      check('I12b Shift+← 选区:工具栏即时出现', (await page.locator('[data-testid=inline-toolbar]').count()) === 1)
    }

    if (want('I19')) {
      await listenToasts(page)
      // I19a 代码块里:只留「转换为」+「清除」。
      {
        await load(page, '```js\nconst a = 1\n```\n\n后段\n')
        await selectText(page, 'const')
        await page.waitForTimeout(200)
        const tb = await toolbar(page)
        check('I19a 代码块里只露「转换为」与「清除」', tb && tb.turn && tb.acts.join(',') === 'clear' && !tb.color, JSON.stringify(tb))
        // 转换做不成(代码块 → 无序列表,list_item 首子不收代码块)要么真转了,要么给一句提示 —— 不许静默无效。
        await toasts(page)
        const before = await topBlocks(page)
        await page.locator('.inline-toolbar .itb-turn').dispatchEvent('mousedown')
        await page.waitForTimeout(150)
        await page.locator('.inline-toolbar .itb-menu-item', { hasText: '无序列表' }).dispatchEvent('mousedown')
        await page.waitForTimeout(300)
        const after = await topBlocks(page)
        const ts = await toasts(page)
        check('I19a 转换做不成不静默(文档变了,或有提示)', after !== before || ts.some((x) => /不能转换为/.test(x)), JSON.stringify({ changed: after !== before, ts }))
      }
      // I19b 单元格里:不列「转换为」和段落对齐,格式与链接照常。
      {
        await load(page, '| h1 | h2 |\n| --- | --- |\n| 单元 | 格子 |\n')
        await selectText(page, '单元')
        await page.waitForTimeout(200)
        const tb = await toolbar(page)
        check('I19b 单元格里不列「转换为」与对齐', tb && !tb.turn && !tb.acts.some((a) => /^align/.test(a)) && tb.acts.includes('bold') && tb.acts.includes('link'), JSON.stringify(tb))
      }
      // I19c 当前状态:链接 🔗 亮、下划线 U 亮、文字色显示在 A▾ 上。
      {
        await load(page, '[链接](https://a.com) 与 <u>下划</u> 和 <span style="color:#c62222">红字</span>\n')
        await selectText(page, '链接')
        await page.waitForTimeout(200)
        const a = await toolbar(page)
        await selectText(page, '下划')
        await page.waitForTimeout(200)
        const b = await toolbar(page)
        await selectText(page, '红字')
        await page.waitForTimeout(200)
        const c = await toolbar(page)
        check('I19c 链接 / 下划线亮、A▾ 显示当前文字色', a?.on.includes('link') && b?.on.includes('underline') && c?.fg === '#c62222', JSON.stringify({ a: a?.on, b: b?.on, fg: c?.fg }))
      }
    }

    if (want('I20')) {
      const focusIn = () => page.evaluate(() => {
        const a = document.activeElement
        return { tb: !!a?.closest('[data-testid=inline-toolbar]'), act: a?.dataset?.act ?? a?.className ?? null, editor: window.__upage.probe.view().hasFocus(), mounted: !!document.querySelector('[data-testid=inline-toolbar]') }
      })
      // I20a Alt+F10 → 焦点进工具栏,工具栏不因编辑器失焦被卸载;→ 到 B,Enter 加粗。
      {
        const nm = await load(page, 'alpha beta gamma\n')
        await selectText(page, 'beta')
        await page.waitForTimeout(200)
        await page.keyboard.press('Alt+F10')
        await page.waitForTimeout(300)
        const f1 = await focusIn()
        // 首钮是「转换为」,→ 一格到 B。
        await page.keyboard.press('ArrowRight')
        const f2 = await focusIn()
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        check('I20a Alt+F10 进工具栏且不被卸载,→ 移到 B,Enter 加粗', f1.tb && f1.mounted && f2.act === 'bold' && (md || '').trim() === 'alpha **beta** gamma', JSON.stringify({ f1, f2, md }))
        const aria = await page.evaluate(() => {
          const tb = document.querySelector('[data-testid=inline-toolbar]')
          const b = tb?.querySelector('[data-act=bold]')
          return { label: tb?.getAttribute('aria-label'), pressed: b?.getAttribute('aria-pressed'), bl: b?.getAttribute('aria-label'), popup: tb?.querySelector('.itb-turn')?.getAttribute('aria-haspopup') }
        })
        check('I20b ARIA:toolbar 有名字,B 有 aria-label / aria-pressed=true,「转换为」标 aria-haspopup', !!aria.label && aria.pressed === 'true' && !!aria.bl && aria.popup === 'menu', JSON.stringify(aria))
      }
      // I20c 键盘开「转换为」子面板 → 焦点进首项,↓ 到「标题 1」,Enter 转换。
      {
        const nm = await load(page, 'alpha beta gamma\n')
        await selectText(page, 'beta')
        await page.waitForTimeout(200)
        await page.keyboard.press('Alt+F10')
        await page.waitForTimeout(200)
        await page.keyboard.press('Enter') // 首钮 = 「转换为 ▾」
        await page.waitForTimeout(200)
        const inPanel = await page.evaluate(() => !!document.activeElement?.closest('.itb-panel'))
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        check('I20c 键盘开子面板焦点进首项,↓ + Enter = 转为标题 1', inPanel && (md || '').trim() === '# alpha beta gamma', JSON.stringify({ inPanel, md }))
      }
      // I20d 焦点在工具栏里按 Esc → 工具栏关、焦点回编辑器。
      {
        await load(page, 'alpha beta gamma\n')
        await selectText(page, 'beta')
        await page.waitForTimeout(200)
        await page.keyboard.press('Alt+F10')
        await page.waitForTimeout(200)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
        const f = await focusIn()
        check('I20d 工具栏里 Esc → 关工具栏、焦点回编辑器', !f.mounted && f.editor, JSON.stringify(f))
      }
    }

    if (want('B5')) {
      await listenToasts(page)
      const SEED = '段甲。\n\n段乙。\n\n段丙。\n'
      // B5a 多块 → 标题 2:两块都变。
      {
        await load(page, SEED)
        await dragSelect(page, '段甲', '段乙')
        const open = await openHandleMenu(page, '段甲')
        if (open) await clickItem(page, '标题 2')
        await page.waitForTimeout(250)
        const sh = await shape(page)
        check('B5a 多块选中 → 转换为标题 2:每块都转', open && sh.join(' / ') === 'heading2:段甲。 / heading2:段乙。 / 段丙。', JSON.stringify(sh))
      }
      // B5b 多块 → 无序列表:并成一只列表;一次撤销全部回来。
      {
        await load(page, SEED)
        await dragSelect(page, '段甲', '段乙')
        const open = await openHandleMenu(page, '段甲')
        if (open) await clickItem(page, '无序列表')
        await page.waitForTimeout(250)
        const sh = await shape(page)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(250)
        const undone = await shape(page)
        check('B5b 多块 → 无序列表 = 一只列表;一次 ⌘Z 全回', open && sh.join(' / ') === 'bullet_list[段甲。|段乙。] / 段丙。' && undone.join(' / ') === '段甲。 / 段乙。 / 段丙。', JSON.stringify({ sh, undone }))
      }
      // B5c 多块时「移到新列」置灰(aria-disabled + 说明),点了给提示、文档不动。
      {
        await load(page, SEED)
        await dragSelect(page, '段甲', '段乙')
        const open = await openHandleMenu(page, '段甲')
        const dis = open ? await menuItem(page, '移到新列').getAttribute('aria-disabled') : null
        const title = open ? await menuItem(page, '移到新列').getAttribute('title') : null
        await toasts(page)
        if (open) await clickItem(page, '移到新列', { force: true })
        await page.waitForTimeout(200)
        const ts = await toasts(page)
        const sh = await shape(page)
        check('B5c 多块时「移到新列」置灰 + 说明 + 点了有提示', dis === 'true' && !!title && ts.length === 1 && sh.join(' / ') === '段甲。 / 段乙。 / 段丙。', JSON.stringify({ dis, title, ts, sh }))
        await page.keyboard.press('Escape')
      }
    }

    if (want('B10')) {
      const SEED = '段甲。\n\n段乙。\n\n---\n\n段丙。\n'
      const selNow = () => page.evaluate(() => { const s = window.__upage.probe.view().state.selection; return `${s.toJSON().type}:${s.from}-${s.to}` })
      // B10a 鼠标开菜单 → ↓↓ 不动编辑器选区;再点「删除」删的是打开时那一块(不是 hr)。
      {
        await load(page, SEED)
        const open = await openHandleMenu(page, '段乙')
        const s0 = await selNow()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        const s1 = await selNow()
        const inMenu = await page.evaluate(() => !!document.activeElement?.closest('.unified-block-menu'))
        if (open) await clickItem(page, '删除')
        await page.waitForTimeout(250)
        const sh = await shape(page)
        check('B10a 菜单开着 ↓↓ 不挪编辑器选区(焦点进菜单),删除落在打开时那一块', open && s0 === s1 && inMenu && sh.join(' / ') === '段甲。 / hr: / 段丙。', JSON.stringify({ s0, s1, inMenu, sh }))
      }
      // B10b End → 末项「删除」,Enter 执行。
      {
        await load(page, SEED)
        const open = await openHandleMenu(page, '段乙')
        await page.keyboard.press('End')
        const focused = await page.evaluate(() => document.activeElement?.textContent.trim())
        await page.keyboard.press('Enter')
        await page.waitForTimeout(250)
        const sh = await shape(page)
        check('B10b End 到末项、Enter 执行(删的是段乙)', open && /删除$/.test(focused || '') && sh.join(' / ') === '段甲。 / hr: / 段丙。', JSON.stringify({ focused, sh }))
      }
      // B10c ARIA。
      {
        await load(page, SEED)
        await openHandleMenu(page, '段乙')
        const aria = await page.evaluate(() => {
          const m = document.querySelector('.unified-block-menu')
          const btns = [...m.querySelectorAll('button')]
          return { role: m.getAttribute('role'), label: m.getAttribute('aria-label'), items: btns.length, withRole: btns.filter((b) => /^menuitem/.test(b.getAttribute('role') || '')).length }
        })
        check('B10c 菜单 role=menu + 名字,每项 role=menuitem', aria.role === 'menu' && !!aria.label && aria.items > 0 && aria.withRole === aria.items, JSON.stringify(aria))
        await page.keyboard.press('Escape')
      }
      // B10d 键盘打开(聚焦 ⠿ 按 Enter):块被选上、焦点进首项。
      {
        await load(page, SEED)
        const r = await rectOf(page, '段乙')
        await page.mouse.move(r.x + 10, r.y + Math.min(10, r.h / 2), { steps: 4 })
        await page.waitForTimeout(260)
        await page.evaluate(() => document.querySelector('.unified-gutter .drag-handle')?.focus())
        await page.keyboard.press('Enter')
        const open = await waitSel(page, '.unified-block-menu')
        await page.waitForTimeout(150)
        const st = await page.evaluate(() => ({ inMenu: !!document.activeElement?.closest('.unified-block-menu'), sel: window.__upage.probe.view().state.selection.toJSON().type }))
        check('B10d 键盘打开:块已选上、焦点进菜单首项', open && st.inMenu && st.sel === 'node', JSON.stringify(st))
        await page.keyboard.press('Escape')
      }
    }

    if (want('B11')) {
      // B-11:对 callout「转换为」= 先摘 `[!type]` 令牌再整只转;落盘里不许出现字面 `[!note]` / `\[!`。
      const SEED = '段首。\n\n> [!note] 标题\n> 第一行\n\n段尾。\n'
      for (const [label, want] of [
        ['正文', '段首。\n\n标题\n\n第一行\n\n段尾。\n'],
        ['标题 2', '段首。\n\n## 标题\n\n第一行\n\n段尾。\n'],
        ['无序列表', /^段首。\n\n[-*] 标题\n[-*] 第一行\n\n段尾。\n$/],
        ['引用', '段首。\n\n> 标题\n>\n> 第一行\n\n段尾。\n'],
        ['折叠', '段首。\n\n> [!fold]- 标题\n>\n> 第一行\n\n段尾。\n'],
        ['代码块', '段首。\n\n```\n标题\n第一行\n```\n\n段尾。\n'],
      ]) {
        const nm = await load(page, SEED)
        const open = await openHandleMenu(page, '[!note]') // callout 的 textContent 以(藏着的)令牌开头
        const ok = open && await clickItem(page, label)
        const md = await mdOf(page, nm)
        const hit = typeof want === 'string' ? md === want : want.test(md || '')
        check(`B11 callout → ${label}:令牌不漏进正文`, ok && hit && !/\\\[!|\[!note\]/.test(md || ''), JSON.stringify(md))
      }
      {
        const nm = await load(page, '> [!tip]- 折起的\n> 藏着的内容\n\n段尾。\n')
        const open = await openHandleMenu(page, '[!tip]')
        const ok = open && await clickItem(page, '正文')
        const md = await mdOf(page, nm)
        check('B11 折起的 callout → 正文:内容全部提出、令牌不留', ok && md === '折起的\n\n藏着的内容\n\n段尾。\n', JSON.stringify(md))
      }
    }

    if (want('B14')) {
      // B14a 段落 → 代码块:原文进代码块,不另起空块。
      {
        const nm = await load(page, '段甲。\n\nconst a = 1\n\n段丙。\n')
        const open = await openHandleMenu(page, 'const a')
        if (open) await clickItem(page, '代码块')
        const md = await mdOf(page, nm)
        check('B14a 转换为 → 代码块:原文进代码块', open && (md || '') === '段甲。\n\n```\nconst a = 1\n```\n\n段丙。\n', JSON.stringify(md))
      }
      // B14b 段落 → 标注:`> [!note] 原文`。
      {
        const nm = await load(page, '段甲。\n\n注意这里。\n\n段丙。\n')
        const open = await openHandleMenu(page, '注意这里')
        if (open) await clickItem(page, '标注')
        const md = await mdOf(page, nm)
        check('B14b 转换为 → 标注 = `> [!note] 原文`', open && /\n> \[!note\] 注意这里。\n/.test(md || ''), JSON.stringify(md))
      }
    }

    if (want('B15')) {
      await page.evaluate(() => {
        window.__clip = []
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__clip.push(t); return Promise.resolve() }, readText: () => Promise.resolve('') } })
      })
      const clip = () => page.evaluate(() => window.__clip.splice(0))
      // B15a 标题 → 复制标题链接。
      {
        const nm = await load(page, '# 大标题\n\n## 小节 A\n\n正文。\n')
        const open = await openHandleMenu(page, '小节 A')
        const ok = open && await clickItem(page, '复制标题链接')
        await page.waitForTimeout(200)
        const c = await clip()
        check('B15a 标题块「复制标题链接」= [[笔记#标题]]', ok && c[0] === `[[${nm.replace(/\.md$/, '')}#小节 A]]`, JSON.stringify(c))
      }
      // B15b 已有 ^id 的块 → 复制块链接;没有 ^id 的段落不列链接项。
      {
        const nm = await load(page, '有锚的段 ^abc123\n\n普通段。\n')
        const open = await openHandleMenu(page, '有锚的段')
        const ok = open && await clickItem(page, '复制块链接')
        await page.waitForTimeout(200)
        const c = await clip()
        const open2 = await openHandleMenu(page, '普通段')
        const labels = open2 ? await page.evaluate(() => [...document.querySelectorAll('.unified-block-menu button')].map((b) => b.textContent.trim())) : []
        await page.keyboard.press('Escape')
        check('B15b 有 ^id 的块给「复制块链接」,普通段不给(不铸 ID)', ok && c[0] === `[[${nm.replace(/\.md$/, '')}#^abc123]]` && !labels.some((l) => /复制.*链接/.test(l)), JSON.stringify({ c, labels }))
      }
      // B15c 移动到 → 追加到目标笔记末尾,再从本篇删掉。
      {
        await page.evaluate(() => {
          window.__upage.vault.set('搬家目标.md', '# 目标\n\n已有内容。\n')
          const st = window.__upage.pageStore.getState()
          window.__upage.pageStore.setState({ pages: [...new Set([...(st.pages || []), '搬家目标.md'])] })
        })
        const nm = await load(page, '留下。\n\n搬走我。\n\n也留下。\n')
        const open = await openHandleMenu(page, '搬走我')
        const ok = open && await clickItem(page, '移动到')
        const picker = await waitSel(page, '[data-testid=note-picker]')
        await page.keyboard.type('搬家目标')
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        const target = await page.evaluate(() => window.__upage.vault.get('搬家目标.md'))
        check('B15c 移动到:目标末尾多了这块、本篇删掉了', ok && picker && target === '# 目标\n\n已有内容。\n\n搬走我。\n' && (md || '') === '留下。\n\n也留下。\n', JSON.stringify({ target, md }))
      }
      // B15d /embed 的说明指向 v4 真有的菜单项。
      {
        await load(page, '段\n')
        await caretAt(page, '段')
        await page.keyboard.type(' /embed')
        await waitSel(page, '.slash-menu')
        await page.keyboard.press('Enter')
        await waitSel(page, '.dialog-msg')
        const msg = await page.evaluate(() => document.querySelector('.dialog-msg')?.textContent ?? '')
        await page.keyboard.press('Escape')
        check('B15d /embed 说明指向「复制标题链接 / 复制块链接」,不再提「复制嵌入引用」', /复制标题链接/.test(msg) && !/复制嵌入引用/.test(msg), JSON.stringify(msg))
      }
    }

    if (want('B4')) {
      // B-04:块菜单对折起的标题 = 标题 + 藏着的小节一个整体。「复制块」复制整节(副本同样折着);
      //       「移动到…」把整节搬去目标笔记,本篇删干净,下一枚标题不「继承」折叠。
      const foldVia = async (page, name) => {
        const r = await rectOf(page, name)
        await page.mouse.move(r.x + 10, r.y + Math.min(10, r.h / 2), { steps: 4 })
        await page.waitForTimeout(260)
        await page.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
        await page.waitForTimeout(200)
        await page.mouse.move(5, 5)
        await page.waitForTimeout(150)
      }
      const foldedNames = (page) => page.evaluate(() => [...document.querySelectorAll('.amx-heading-folded')].map((e) => e.textContent.replace('▸', '')))
      const SEED = '前段。\n\n## 小节\n\n节内一。\n\n节内二。\n\n## 下节\n\n下节正文。\n'
      {
        await load(page, SEED)
        await foldVia(page, '小节')
        const open = await openHandleMenu(page, '▸小节') // 折起的标题行首挂着展开钮 ▸
        const ok = open && await clickItem(page, '复制块')
        await page.waitForTimeout(200)
        const s = await shape(page)
        check('B4a 「复制块」折起的标题:复制整节,副本同样折着', ok && JSON.stringify(s) === JSON.stringify(['前段。', 'heading2:小节', '节内一。', '节内二。', 'heading2:小节', '节内一。', '节内二。', 'heading2:下节', '下节正文。']) && JSON.stringify(await foldedNames(page)) === JSON.stringify(['小节', '小节']), JSON.stringify({ s, f: await foldedNames(page) }))
      }
      {
        await page.evaluate(() => {
          window.__upage.vault.set('小节去处.md', '# 去处\n')
          const st = window.__upage.pageStore.getState()
          window.__upage.pageStore.setState({ pages: [...new Set([...(st.pages || []), '小节去处.md'])] })
        })
        const nm = await load(page, SEED)
        await foldVia(page, '小节')
        const open = await openHandleMenu(page, '▸小节') // 折起的标题行首挂着展开钮 ▸
        const ok = open && await clickItem(page, '移动到')
        const picker = await waitSel(page, '[data-testid=note-picker]')
        await page.keyboard.type('小节去处')
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        const target = await page.evaluate(() => window.__upage.vault.get('小节去处.md'))
        const f = await foldedNames(page)
        check('B4b 「移动到…」折起的标题:整节搬走,本篇删干净,下节不继承折叠', ok && picker && target === '# 去处\n\n## 小节\n\n节内一。\n\n节内二。\n' && md === '前段。\n\n## 下节\n\n下节正文。\n' && f.length === 0, JSON.stringify({ target, md, f }))
      }
    }

    if (want('B7')) {
      // B-07:列表 / 引用(callout)的**空行**里 slash 插整块 = 原地换掉这一行:不留 `-` / `- [ ] <br />` / `>` 空项残渣,
      //       callout 里的代码块留在 callout 里;列表被劈成前后两只(与手打 ``` 同一结果)。非空行照旧插到整块之后。
      const run = async (md, after, cmd) => {
        const nm = await load(page, md)
        await caretAt(page, after)
        await page.keyboard.press('Enter')
        await page.keyboard.type(`/${cmd}`)
        const open = await waitSel(page, '.slash-menu')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(200)
        return { open, md: await mdOf(page, nm), shape: await topBlocks(page) }
      }
      const a = await run('- 项一\n- 项二\n- 项三\n\n段尾。\n', '项二', 'code')
      check('B7a 列表空项 /code:代码块原地劈开列表,不留空项', a.open && a.md === '- 项一\n- 项二\n\n```\n```\n\n- 项三\n\n段尾。\n', JSON.stringify(a))
      const b = await run('- [ ] 任务一\n- [ ] 任务二\n\n段尾。\n', '任务一', 'divider')
      check('B7b 待办空项 /divider:原地成分割线,不留 `- [ ] <br />`', b.open && !/<br \/>|\[ \] *\n/.test(b.md || '') && /^- \[ \] 任务一\n\n---\n/.test(b.md || '') && /- \[ \] 任务二\n/.test(b.md || ''), JSON.stringify(b))
      const c = await run('> [!note] 标题\n> 第一行\n\n段尾。\n', '第一行', 'code')
      check('B7c callout 空行 /code:代码块留在 callout 里,不留空 `>` 行', c.open && c.md === '> [!note] 标题\n>\n> 第一行\n>\n> ```\n> ```\n\n段尾。\n', JSON.stringify(c))
      const d = await run('> [!note] 标题\n> - 项一\n\n段尾。\n', '项一', 'table')
      check('B7d callout 里的列表空项 /table:只脱出列表、表格留在 callout 里', d.open && /^blockquote:/.test(d.shape) && /^> \[!note\] 标题\n>\n> [-*] 项一\n>\n> \| 列 1/.test(d.md || '') && !/>\s*[-*]\s*\n/.test(d.md || ''), JSON.stringify(d))
      const e = await run('- 项一\n- 项二\n\n段尾。\n', '项一', 'math')
      check('B7e 列表空项 /math:公式骨架留在这一项里(段落放得进列表项)', e.open && e.md === '- 项一\n- $$  $$\n- 项二\n\n段尾。\n', JSON.stringify(e))
    }

    if (want('B17')) {
      const run = async (cmd, pick) => {
        const nm = await load(page, '段甲内容\n\n段乙。\n')
        await caretAt(page, '段甲内容')
        await page.keyboard.type(` /${cmd}`)
        const open = await waitSel(page, '.slash-menu')
        if (pick) await page.locator('.slash-item').filter({ hasText: pick }).first().dispatchEvent('mousedown')
        else await page.keyboard.press('Enter')
        return { open, md: await mdOf(page, nm) }
      }
      const h2 = await run('h2')
      const todo = await run('todo')
      const code = await run('code', '代码块')
      check('B17 slash 转换 / 插入后不留尾空格', h2.open && h2.md === '## 段甲内容\n\n段乙。\n' && /^\* \[ \] 段甲内容\n/.test(todo.md || '') && /^段甲内容\n\n```/.test(code.md || ''), JSON.stringify({ h2: h2.md, todo: todo.md, code: code.md }))
    }

    if (want('B18')) {
      const slashLabels = () => page.evaluate(() => [...document.querySelectorAll('.slash-menu .slash-item .slash-label')].map((x) => x.textContent.trim()))
      // B18a 单元格里 `/h1`:不开菜单,留成字面(此前列出来点了静默无效 / 插到表外)。
      {
        await load(page, '| a | b |\n| --- | --- |\n| 格一 | 格二 |\n\n段尾。\n')
        await caretAt(page, '格一')
        await page.keyboard.type(' /h1')
        await page.waitForTimeout(300)
        const menu = await page.locator('.slash-menu').count()
        check('B18a 单元格里 `/` 不开 slash 菜单', menu === 0, JSON.stringify({ menu }))
      }
      // B18b 列表项里 slash 不列「分栏 / 卡片」;顶层段落照常列。
      {
        await load(page, '- 项一\n- 项二\n\n顶层段\n')
        await caretAt(page, '项二')
        await page.keyboard.type(' /')
        await waitSel(page, '.slash-menu')
        const inList = await slashLabels()
        await page.keyboard.press('Escape')
        await caretAt(page, '顶层段')
        await page.keyboard.type(' /')
        await waitSel(page, '.slash-menu')
        const top = await slashLabels()
        await page.keyboard.press('Escape')
        check('B18b 列表项里不列「分栏 / 卡片」,顶层段落列', !inList.includes('分栏') && !inList.includes('卡片') && inList.includes('标题 1') && top.includes('分栏') && top.includes('卡片'), JSON.stringify({ inList: inList.length, top: top.length, listHas: inList.filter((x) => /分栏|卡片/.test(x)) }))
      }
      // B18c 块菜单:列表项(非首项)不列「移到新列」,顶层段落列。
      {
        await load(page, '- 项一\n- 项二\n- 项三\n\n顶层段\n')
        const r = await page.evaluate((PM) => { const li = [...document.querySelectorAll(`${PM} li`)].find((x) => x.textContent.trim() === '项二'); const b = li.getBoundingClientRect(); return { x: b.x, y: b.y, h: b.height } }, PM)
        await page.mouse.move(r.x + 10, r.y + Math.min(10, r.h / 2), { steps: 4 })
        await page.waitForTimeout(260)
        const h = await page.evaluate(() => { const el = document.querySelector('.unified-gutter[data-show="true"] .drag-handle'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(10, b.height / 2) } })
        if (h) await page.mouse.click(h.x, h.y)
        const open1 = await waitSel(page, '.unified-block-menu')
        const li = await page.evaluate(() => [...document.querySelectorAll('.unified-block-menu button')].map((b) => b.textContent.trim()))
        await page.keyboard.press('Escape')
        const open2 = await openHandleMenu(page, '顶层段')
        const para = await page.evaluate(() => [...document.querySelectorAll('.unified-block-menu button')].map((b) => b.textContent.trim()))
        await page.keyboard.press('Escape')
        check('B18c 列表项不列「移到新列」,顶层段落列', open1 && open2 && !li.includes('移到新列') && li.includes('删除') && para.includes('移到新列'), JSON.stringify({ li: li.includes('移到新列'), para: para.includes('移到新列') }))
      }
    }

    if (want('B19')) {
      /** 悬停 prefix 那一块(sel 缺省 = 顶层块;列表项传 'li')→ 点 ＋(可带 Alt)。 */
      const clickPlus = async (prefix, { alt = false, sel = ':scope > *' } = {}) => {
        const r = await page.evaluate(({ PM, prefix, sel }) => {
          const el = [...document.querySelector(PM).querySelectorAll(sel)].find((x) => x.firstElementChild ? x.firstElementChild.textContent.trim().startsWith(prefix) : x.textContent.trim().startsWith(prefix))
          if (!el) return null
          const b = el.getBoundingClientRect()
          return { x: b.x, y: b.y, h: b.height }
        }, { PM, prefix, sel })
        if (!r) return false
        await page.mouse.move(r.x + 10, r.y + Math.min(10, r.h / 2), { steps: 4 })
        await page.waitForTimeout(260)
        const a = await page.evaluate(() => { const el = document.querySelector('.unified-gutter[data-show="true"] .block-add'); if (!el || getComputedStyle(el).display === 'none') return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })
        if (!a) return false
        if (alt) await page.keyboard.down('Alt') // mouse.click 不收 modifiers,修饰键得真按住
        await page.mouse.click(a.x, a.y)
        if (alt) await page.keyboard.up('Alt')
        await page.waitForTimeout(250)
        return true
      }
      // B19a ＋ → 下方新块 + slash 菜单开;Esc → `/` 删掉,留一个空段,接着打字落在新段。
      {
        const nm = await load(page, '段甲。\n\n段乙。\n')
        const ok = await clickPlus('段甲')
        const menu = await waitSel(page, '.slash-menu', 1500)
        const mid = await shape(page)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
        const after = await shape(page)
        await page.keyboard.type('新段')
        const md = await mdOf(page, nm)
        check('B19a ＋ 开 slash 菜单;Esc 清掉 `/`;接着打字进新段', ok && menu && mid.join(' / ') === '段甲。 / / / 段乙。' && after.join(' / ') === '段甲。 /  / 段乙。' && md === '段甲。\n\n新段\n\n段乙。\n', JSON.stringify({ mid, after, md }))
      }
      // B19b ＋ 后直接选 slash 项 = 新块就是那一类(标题 1)。
      {
        const nm = await load(page, '段甲。\n\n段乙。\n')
        await clickPlus('段甲')
        await waitSel(page, '.slash-menu', 1500)
        await page.keyboard.type('h1')
        await page.keyboard.press('Enter')
        await page.keyboard.type('新标题')
        const md = await mdOf(page, nm)
        check('B19b ＋ → 选「标题 1」→ 新块是标题', md === '段甲。\n\n# 新标题\n\n段乙。\n', JSON.stringify(md))
      }
      // B19c Alt+＋ = 插到上方。
      {
        const nm = await load(page, '段甲。\n\n段乙。\n')
        await clickPlus('段乙', { alt: true })
        await waitSel(page, '.slash-menu', 1500)
        await page.keyboard.press('Escape')
        await page.keyboard.type('上方')
        const md = await mdOf(page, nm)
        check('B19c Alt+点 ＋ = 插到上方', md === '段甲。\n\n上方\n\n段乙。\n', JSON.stringify(md))
      }
      // B19d 有序列表非末项上点 ＋ → 同级新项,列表不劈、编号连续。
      {
        const nm = await load(page, '1. 项一\n2. 项二\n3. 项三\n\n段尾。\n')
        const ok = await clickPlus('项二', { sel: 'li' })
        await waitSel(page, '.slash-menu', 1500)
        await page.keyboard.press('Escape')
        await page.keyboard.type('新项')
        const md = await mdOf(page, nm)
        check('B19d 列表项上 ＋ = 同级新项(不劈列表)', ok && md === '1. 项一\n2. 项二\n3. 新项\n4. 项三\n\n段尾。\n', JSON.stringify(md))
      }
    }

    await page.close()
  } finally {
    await browser.close()
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
