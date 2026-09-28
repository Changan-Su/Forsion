// v4 统一编辑器的三件菜单:选区工具栏 / 块菜单(⠿)/ slash 菜单 —— 「哪个上下文显示哪些项、点了做什么」
// (Amadeus 评审 2026-09-27 波次 2 · menus 包)。全部跑生产 UnifiedPage(台架 `?upage`),落盘以 window.__upage.writes 为准。
//   I9   ⌘E = 行内代码(对齐改 ⌘⇧L/E/R);选区上敲反引号 = 行内代码,不是两个字面反引号(I-09 / K-18b)
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
