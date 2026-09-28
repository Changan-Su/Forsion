// v4 统一编辑器的三件菜单:选区工具栏 / 块菜单(⠿)/ slash 菜单 —— 「哪个上下文显示哪些项、点了做什么」
// (Amadeus 评审 2026-09-27 波次 2 · menus 包)。全部跑生产 UnifiedPage(台架 `?upage`),落盘以 window.__upage.writes 为准。
//   I9   ⌘E = 行内代码(对齐改 ⌘⇧L/E/R);选区上敲反引号 = 行内代码,不是两个字面反引号(I-09 / K-18b)
//   I10  ⌘K 碰到已有链接 = 扩到整条、预填原地址、可「移除链接」;空选区 = 插一条新链接(I-10)
//   I12  选区工具栏在鼠标按住(拖选)期间不出、松手才出;向上拖选不被它挡住;键盘选区照旧即时出(I-12)
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
