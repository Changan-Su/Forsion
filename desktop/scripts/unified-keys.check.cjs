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

    // ── K-04:上一节折叠时,在下一个标题行首退格 / `### ` 降级;折叠标题行尾 Delete。──
    if (want('K04')) {
      /** 顶层块可见性:text(HIDDEN) 标出 display:none 的块。 */
      const visible = (page) => page.evaluate((PM) => [...document.querySelectorAll(PM + ' > *')]
        .filter((e) => !e.classList.contains('ProseMirror-trailingBreak'))
        .map((e) => `${e.textContent.replace('▸', '')}${getComputedStyle(e).display === 'none' ? '(HIDDEN)' : ''}`).join(' | '), PM)
      // 走真 UI(悬停标题 → 把手折叠钮):动态 import 模块在 HMR 后可能拿到另一份实例(PluginKey 不同)。
      const fold = async (page, name) => {
        const h = await page.evaluate(({ PM, name }) => {
          const el = [...document.querySelectorAll(PM + ' > h1, ' + PM + ' > h2, ' + PM + ' > h3')].find((e) => e.textContent.includes(name))
          const r = el.getBoundingClientRect()
          return { x: r.left + 15, y: r.top + r.height / 2 }
        }, { PM, name })
        await page.mouse.move(h.x, h.y, { steps: 3 })
        await page.waitForTimeout(300)
        const ok = await page.evaluate(() => {
          const f = document.querySelector('.unified-gutter .block-fold')
          if (!f || f.style.display === 'none') return false
          f.click()
          return true
        })
        await page.waitForTimeout(150)
        if (!ok) throw new Error('折叠钮没出现:' + name)
        // 前置条件:确实折起来了(否则下面的断言会在不折叠的对照态下空转成绿)。
        const v = await visible(page)
        if (!v.includes('(HIDDEN)')) throw new Error('折叠没生效:' + v)
      }
      const SEED = '## 第一章\n\n正文一。\n\n## 第二章\n\n正文二。\n'
      {
        const page = await open(browser, SEED)
        await fold(page, '第一章')
        await page.waitForTimeout(120)
        await caretIn(page, 'heading', { nth: 1, atStart: true })
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(1300)
        const s = await shape(page), v = await visible(page), w = await lastWrite(page)
        check('K04 折叠节后的标题行首退格:`##` 字面还原在本行,不写进上一个标题', s === 'heading2:"第一章" / paragraph:"正文一。" / paragraph:"##第二章" / paragraph:"正文二。"', s)
        check('K04 同上:本行没有被藏进折叠区(上一节随之展开)', !v.includes('HIDDEN'), v)
        check('K04 同上:落盘与不折叠时的字面还原一致', w === '## 第一章\n\n正文一。\n\n\\##第二章\n\n正文二。\n', JSON.stringify(w))
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(200)
        const u = await shape(page)
        check('K04 同上:撤销一次即恢复', u === 'heading2:"第一章" / paragraph:"正文一。" / heading2:"第二章" / paragraph:"正文二。"', u)
        await page.close()
      }
      {
        const page = await open(browser, SEED)
        await fold(page, '第一章')
        await page.waitForTimeout(120)
        await caretIn(page, 'heading', { nth: 1, atStart: true })
        await page.keyboard.type('### ')
        await page.waitForTimeout(200)
        const s = await shape(page), v = await visible(page), sl = await selInfo(page)
        check('K04 折叠节后的标题敲 `### ` 降成子级:光标留在本行,本行可见', s.includes('heading3:"第二章"') && !v.includes('HIDDEN') && sl.parent === 'heading' && s.split(' / ')[0] === 'heading2:"第一章"', `${s} | ${v} | ${JSON.stringify(sl)}`)
        await page.close()
      }
      {
        const page = await open(browser, '## A标题\n\n隐藏一。\n\n隐藏二。\n\n## B\n\n乙内容。\n')
        await fold(page, 'A标题')
        await page.waitForTimeout(120)
        await caretIn(page, 'heading', { nth: 0 })
        await page.keyboard.press('Delete')
        await page.waitForTimeout(200)
        const s1 = await shape(page), v1 = await visible(page)
        check('K04 折叠标题行尾 Delete 第一下:只展开,不把隐藏内容拉进标题', s1.startsWith('heading2:"A标题" / paragraph:"隐藏一。"') && !v1.includes('HIDDEN'), `${s1} | ${v1}`)
        await page.keyboard.press('Delete')
        await page.waitForTimeout(200)
        const s2 = await shape(page)
        check('K04 同上第二下:展开后走通常的合并', s2.startsWith('heading2:"A标题隐藏一。"'), s2)
        await page.close()
      }
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
