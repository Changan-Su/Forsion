// 空行 / 块中间 Shift+Enter 的**落盘形态**回归实测(真浏览器,harness)。
//
// 病(用户实报):① 文件里到处是莫名其妙的 `<br />` —— 空段落被 Milkdown 的 preserve-empty-line
// 序列化成了 `<br />`;② 块中间 Shift+Enter 切出的新块开头凭空多一个 `<br />`(切片以空段落打头)。
// 药在 softBreak.ts:写端 stripEmptyLineBr 抹平成真空行,读端 expand 按 position 行距还原空段落。
// 纯函数那一半由 softBreak.test.ts 钉;这里钉的是**真编辑器 → 真 markdown** 那一段。
//
// 光标一律用 DOM Selection 精确落点(按键序列在 headless 下不可靠,曾把 3 次运行跑出 3 种结果)。
// 用法:desktop 仓 `npm run web` 起 5173,然后 node scripts/blank-line-br.check.cjs
//      (或 npm run check:br —— 自带起停 vite)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const dump = (page) => page.evaluate(() => window.__harness.blocks.map((b) => b.content))

/** 光标落到首块第 li 个顶层子元素(段落/列表…)的第 off 个字符处;off<0 = 该元素末尾。 */
async function caretAt(page, li, off) {
  await page.locator('.md-block .ProseMirror').first().click()
  await page.evaluate(([i, o]) => {
    const pm = document.querySelector('.md-block .ProseMirror')
    const el = pm.children[i]
    // 取该元素里第一个文本节点(列表项要往里钻一层);没有文本节点就落在元素自身。
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const t = walker.nextNode()
    const range = document.createRange()
    if (t) range.setStart(t, o < 0 ? t.length : Math.min(o, t.length))
    else range.setStart(el, 0)
    range.collapse(true)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }, [li, off])
  await page.waitForTimeout(120)
}

async function open(browser, seed) {
  const page = await browser.newPage({ locale: 'zh-CN' })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(seed ? `${BASE}?seed=${encodeURIComponent(seed)}` : BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(500)
  return page
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // B1 空行落盘 = 真空行,不是 <br />
  {
    const page = await open(browser, '')
    await page.locator('.md-block .ProseMirror').first().click()
    await page.keyboard.type('alpha', { delay: 20 })
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('beta', { delay: 20 })
    await page.waitForTimeout(600)
    const md = (await dump(page))[0]
    check('B1 空行落盘成真空行', md.trim() === 'alpha\n\nbeta', JSON.stringify(md))
    check('B1 不写 <br />', !md.includes('<br'), JSON.stringify(md))
    await page.close()
  }

  // B2 读回:真空行还原成空段落(round-trip 闭合,重开不会把两段贴到一起)
  {
    const page = await open(browser, 'alpha\n\nbeta')
    const n = await page.evaluate(() => document.querySelector('.md-block .ProseMirror').children.length)
    check('B2 空行读回成空段落(3 个段落)', n === 3, `paragraphs=${n}`)
    const md = (await dump(page))[0]
    check('B2 原文不被改写', md === 'alpha\n\nbeta', JSON.stringify(md))
    await page.close()
  }

  // B3 块中间 Shift+Enter:光标在第 1 行行尾 → 头留第 1 行,尾拿后两行,且不带 <br />
  {
    const page = await open(browser, '一行\n二行\n三行')
    await caretAt(page, 0, -1)
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(700)
    const b = await dump(page)
    check('B3 切成两块', b.length === 2, JSON.stringify(b))
    check('B3 头块只剩第 1 行', (b[0] || '').trim() === '一行', JSON.stringify(b[0]))
    check('B3 尾块无 <br /> 开头', !(b[1] || '').includes('<br'), JSON.stringify(b[1]))
    check('B3 尾块保住两行', (b[1] || '').trim() === '二行\n三行', JSON.stringify(b[1]))
    await page.close()
  }

  // B4 列表里的空项落盘成空列表项,而不是 `* <br />`
  {
    const page = await open(browser, '- 甲\n- 乙')
    await caretAt(page, 0, -1) // 第一个列表项末尾
    await page.keyboard.press('Enter') // 新建空列表项
    await page.waitForTimeout(600)
    const md = (await dump(page))[0]
    check('B4 空列表项不落 <br />', !md.includes('<br'), JSON.stringify(md))
    await page.close()
  }

  // B5 尾部带格式(标题 + 列表)时 Shift+Enter:格式必须跟着走,不能塌成一行纯文本
  {
    const page = await open(browser, '开头\n\n## 小标题\n\n- 甲\n- 乙')
    await caretAt(page, 0, -1) // 「开头」这一段末尾
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(700)
    const b = await dump(page)
    check('B5 头块只剩「开头」', (b[0] || '').trim() === '开头', JSON.stringify(b[0]))
    check('B5 尾块保住标题', (b[1] || '').includes('## 小标题'), JSON.stringify(b[1]))
    check('B5 尾块保住列表两项', /[-*]\s+甲/.test(b[1] || '') && /[-*]\s+乙/.test(b[1] || ''), JSON.stringify(b[1]))
    check('B5 尾块无 <br />', !(b[1] || '').includes('<br'), JSON.stringify(b[1]))
    await page.close()
  }

  // B6 行内 `![[pic.png]]`:混在文字里也要渲染成 <img>,不能只当双链文字
  //    (用户实报「图片竟然必须单独一个块才能渲染」)。光标回到那一行则露源码可编辑。
  {
    const page = await open(browser, '前面 ![[风景.png]] 后面')
    await page.locator('body').click({ position: { x: 5, y: 5 } }) // 失焦 → 全渲染
    await page.waitForTimeout(400)
    const img = await page.evaluate(() => {
      const el = document.querySelector('.md-block .ProseMirror img.wiki-inline-img')
      return el ? { alt: el.getAttribute('alt'), src: el.getAttribute('src') } : null
    })
    check('B6 行内图片渲染成 <img>', !!img && img.alt === '风景.png', JSON.stringify(img))
    check('B6 src 走 vault 资源协议', !!img && /(^amadeus-asset:|asset\?ref=)/.test(img.src || ''), JSON.stringify(img && img.src))
    // ⚠️ 必须用 innerText:textContent 连 display:none 的源码一起返回,断言会假绿。
    const txt = await page.evaluate(() => document.querySelector('.md-block .ProseMirror').innerText)
    check('B6 源码被藏起(不再显示字面 ![[…]])', !(txt || '').includes('[['), JSON.stringify(txt))
    await caretAt(page, 0, 0)
    await page.waitForTimeout(300)
    const txt2 = await page.evaluate(() => document.querySelector('.md-block .ProseMirror').innerText)
    check('B6 光标回到该行 → 露源码可编辑', (txt2 || '').includes('![[风景.png]]'), JSON.stringify(txt2))
    const md = (await dump(page))[0]
    check('B6 落盘原文不变', md.includes('![[风景.png]]'), JSON.stringify(md))
    await page.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
