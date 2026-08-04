// 「查看源码」`</>` 按钮回归(2026-07-31)。
// 契约:渲染出来的块(公式 / 图片·PDF·文件嵌入 / 插件嵌入)悬停浮现一颗 `</>`;点它 → 露出该处的
// 字面源码可编辑;光标离开那片区域 → 复渲染。不悬停时按钮必须**不吃点击**(pointer-events:none),
// 否则会盖住下面的内容 —— 这条纯 CSS,只有真浏览器量得到。
//
// 用法:1) desktop 仓 `npm run web`  2) `npm run check:srcbtn`
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const btnState = (p, sel) =>
  p.evaluate((s) => {
    const b = document.querySelector(s)
    if (!b) return null
    const cs = getComputedStyle(b)
    const r = b.getBoundingClientRect()
    return { opacity: +cs.opacity, pe: cs.pointerEvents, w: Math.round(r.width), text: b.textContent }
  }, sel)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (query) => {
    const p = await browser.newPage({ viewport: { width: 900, height: 600 } })
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?${query}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror, .block-host', { timeout: 20000 })
    await p.waitForTimeout(600)
    return p
  }

  // ── 行内:块级公式 $$…$$ ──
  let p = await open(`seed=${encodeURIComponent('前面一句\n\n$$\\frac{1}{2}$$\n\n后面一句')}`)
  check('S1 块级公式渲染出 KaTeX', (await p.locator('.math-rendered--block .katex').count()) > 0)
  let b = await btnState(p, '.math-rendered--block .amx-src-btn')
  check('S1 公式上挂了 `</>` 按钮', !!b && b.text === '</>', JSON.stringify(b))
  check('S1 不悬停时透明且不吃点击', !!b && b.opacity === 0 && b.pe === 'none', JSON.stringify(b))
  await p.hover('.math-rendered--block')
  await p.waitForTimeout(300)
  b = await btnState(p, '.math-rendered--block .amx-src-btn')
  check('S1 悬停后浮现且可点', !!b && b.opacity === 1 && b.pe === 'auto', JSON.stringify(b))

  // 点它 → 源码露出(该行的公式装饰撤掉,字面 $$…$$ 可见),且光标落在源码里
  await p.click('.math-rendered--block .amx-src-btn')
  await p.waitForTimeout(350)
  const after = await p.evaluate(() => {
    const s = window.getSelection()
    const r = s && s.rangeCount ? s.getRangeAt(0) : null
    return {
      stillRendered: document.querySelectorAll('.math-rendered--block').length,
      caretText: r ? (r.startContainer.textContent || '').slice(0, 24) : null,
      text: document.querySelector('.md-block .ProseMirror').textContent,
    }
  })
  check('S2 点 `</>` 后公式回到源码态', after.stillRendered === 0, JSON.stringify(after))
  check('S2 光标落在公式源码里', !!after.caretText && after.caretText.includes('frac'), JSON.stringify(after.caretText))

  // 光标离开这一行 → 复渲染(「离开才复渲染」是这条特性的后半句)。
  // ⚠️ 必须点到**别的段落**:实况预览是按「光标所在行」判的,点回同一行等于没走。
  await p.locator('.md-block .ProseMirror > p').last().click()
  await p.waitForTimeout(400)
  check(
    'S3 光标离开该行 → 自动复渲染',
    (await p.locator('.math-rendered--block .katex').count()) > 0,
    `rendered=${await p.locator('.math-rendered--block').count()}`
  )
  await p.close()

  // ── 行内:混在文字里的图片嵌入 `![[pic.png]]` ──
  // ⚠️ 图片行不能是最后一行:harness 默认把光标放在文末,同一行会露源码而不渲染(设计如此)。
  p = await open(`seed=${encodeURIComponent('文字 ![[pic.png]] 更多文字\n\n最后一行')}`)
  check('S4 行内图片渲染成 <img>', (await p.locator('.wiki-inline-img').count()) === 1)
  b = await btnState(p, '.wiki-inline-img-wrap .amx-src-btn')
  check('S4 行内图片挂了 `</>`', !!b && b.text === '</>', JSON.stringify(b))
  check('S4 不悬停时不吃点击', !!b && b.pe === 'none', JSON.stringify(b))
  await p.close()

  // ── 块级:整块嵌入(图片 / PDF)由 BlockHost 画按钮 ──
  p = await open('embed')
  const blocks = await p.evaluate(() =>
    [...document.querySelectorAll('.block-host')].map((h) => ({
      embed: h.hasAttribute('data-embed'),
      btn: !!h.querySelector(':scope > .amx-src-btn:not(.amx-open-btn)'),
    }))
  )
  check('S5 嵌入块都有 `</>`,普通文字块没有', blocks.length >= 3 && blocks.filter((x) => x.embed).every((x) => x.btn) && blocks.filter((x) => !x.embed).every((x) => !x.btn), JSON.stringify(blocks))
  const first = '.block-host[data-embed]'
  b = await btnState(p, `${first} > .amx-src-btn:not(.amx-open-btn)`)
  check('S5 不悬停时透明且不吃点击', !!b && b.opacity === 0 && b.pe === 'none', JSON.stringify(b))
  await p.hover(first)
  await p.waitForTimeout(300)
  b = await btnState(p, `${first} > .amx-src-btn:not(.amx-open-btn)`)
  check('S5 悬停后浮现(.block-host[data-embed]:hover 选择器真的命中)', !!b && b.opacity === 1 && b.pe === 'auto', JSON.stringify(b))

  // 点它 → 进源码行(可编辑 input),失焦 → 退出
  await p.click(`${first} > .amx-src-btn:not(.amx-open-btn)`)
  await p.waitForTimeout(350)
  check('S6 点 `</>` 进源码编辑行', (await p.locator('.embed-src-input').count()) === 1, `count=${await p.locator('.embed-src-input').count()}`)
  const val = await p.locator('.embed-src-input').inputValue()
  check('S6 源码行内容 = 该块原文', val.includes('![['), JSON.stringify(val))
  await p.keyboard.press('Escape')
  await p.waitForTimeout(350)
  check('S6 离开后退出源码态(复渲染)', (await p.locator('.embed-src-input').count()) === 0)
  await p.close()

  const fails = results.filter((r) => !r).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
