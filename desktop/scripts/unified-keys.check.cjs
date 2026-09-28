// v4 统一编辑器键盘层回归(Amadeus 评审 2026-09-27 波次 0b · keys 包):K-02 / K-03 / K-04 / R-04。
// 全部跑生产 UnifiedPage(台架 `?upage`),不走 v3 `.md-block` 台架 —— unified/keyboard.ts、headingFold
// 只挂在 v4 实例上。用法:npm run check:unifiedkeys(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL)。
// `--only=K03,R04` 只跑指定组。
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
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function open(browser, md) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  return page
}
/** 文档结构摘要:顶层块 type:text(heading 带级别),嵌套容器递归。 */
const shape = (page) => page.evaluate(() => {
  const v = window.__upage.probe.view()
  const out = []
  const walk = (n, depth) => n.forEach((c) => {
    let label = c.type.name + (c.type.name === 'heading' ? c.attrs.level : '')
    if (c.isTextblock) out.push('  '.repeat(depth) + label + ':' + JSON.stringify(c.textContent))
    else if (c.isLeaf) out.push('  '.repeat(depth) + label)
    else { out.push('  '.repeat(depth) + label); walk(c, depth + 1) }
  })
  walk(v.state.doc, 0)
  return out.join(' / ')
})
const selInfo = (page) => page.evaluate(() => {
  const s = window.__upage.probe.view().state.selection
  return { json: s.toJSON().type, from: s.from, to: s.to, parent: s.$from.parent.type.name, node: s.node ? s.node.type.name : null }
})
/** 光标放进第 n 个 type 节点的内容末尾(或开头);不用鼠标,免得混进点击落点的变量。 */
const caretIn = (page, type, { nth = 0, atStart = false } = {}) => page.evaluate(({ type, nth, atStart }) => {
  const v = window.__upage.probe.view()
  let hit = null, k = 0
  v.state.doc.descendants((n, p) => {
    if (hit != null) return false
    if (n.type.name === type) { if (k++ === nth) { hit = atStart ? p + 1 : p + n.nodeSize - 1; return false } }
    return true
  })
  const S = v.state.selection.constructor
  v.dispatch(v.state.tr.setSelection(S.near(v.state.doc.resolve(hit), atStart ? 1 : -1)))
  v.focus()
  return hit
}, { type, nth, atStart })
const lastWrite = (page) => page.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
async function typeSeq(page, seq) {
  for (const ch of seq) {
    if (ch === '\n') await page.keyboard.press('Enter')
    else await page.keyboard.type(ch)
    await page.waitForTimeout(40)
  }
}
const want = (g) => !ONLY.length || ONLY.includes(g)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // ── K-03:代码块首行不触发块级 markdown 规则(空格入口 + 回车入口)。──
    if (want('K03')) {
      for (const [label, typed, lit] of [
        ['# ', '# x', '# x'], ['> ', '> q', '> q'], ['| ', '| q', '| q'], ['$$ ', '$$ m', '$$ m'],
        ['#⏎', '#\nx', '#\nx'], ['- ', '- i', '- i'],
      ]) {
        const page = await open(browser, '前段。\n\n```sh\n\n```\n\n后段。\n')
        await caretIn(page, 'code_block', { atStart: true })
        await typeSeq(page, typed)
        await page.waitForTimeout(150)
        const s = await shape(page)
        check(`K03 空代码块首行敲 ${JSON.stringify(label)} 仍是代码字面`, s === `paragraph:"前段。" / code_block:${JSON.stringify(lit)} / paragraph:"后段。"`, s)
        await page.close()
      }
      // 键盘新建围栏后首行立即打注释(评审原始路径)。
      const page = await open(browser, '前段。\n')
      await caretIn(page, 'paragraph')
      await page.keyboard.press('Enter')
      await page.keyboard.type('```py ')
      await page.waitForTimeout(120)
      await typeSeq(page, '# comment')
      await page.waitForTimeout(1300)
      const s = await shape(page)
      check('K03 键盘建 ```py 后首行 "# comment" 留在代码块', /code_block:"# comment"/.test(s) && !/heading/.test(s), s)
      check('K03 落盘是围栏代码', /```py\n# comment\n```/.test(await lastWrite(page) || ''), JSON.stringify(await lastWrite(page)))
      await page.close()
    }
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
