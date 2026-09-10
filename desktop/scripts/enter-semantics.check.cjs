// 空行往返仪器:**用户敲出来的空行,切走再切回来还在不在**(用户 2026-09-05 实报「回车空行莫名消失」)。
//
// 与 blank-line-br.check.cjs 的分工:那份钉 v3 块世界的**落盘形态**(不写 `<br />`);
// 这份钉 v4 统一编辑器(?upage,生产组件全链)的**闭合性** —— 编辑 → 防抖落盘 → 切走 → 切回 → 结构一致。
// 病根在 softBreak.ts 的读侧 `blankGap`:序列化时段↔段之间 0 空行、段↔非段之间 1 空行(remark 默认 join),
// 而还原空段落的规则只认「段↔段」→ 空行只要挨着标题/列表/代码块就无人还原,重开即消失。
//
// 用法:npm run check:blankline(自带起停 vite);或 npm run web 后 node scripts/blank-line-persist.check.cjs
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
const PM = '.unified-body .ProseMirror'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 顶层子元素的「标签 + 文字」骨架 —— 空段落也算一格(正是被弄丢的那一格)。 */
const skeleton = (page) => page.evaluate((s) => {
  const pm = document.querySelector(s)
  return [...pm.children].map((el) => `${el.tagName.toLowerCase()}:${(el.innerText || '').trim()}`)
}, PM)

async function open(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 切走再切回(整实例按 key 重挂,initial 取自内存 vault = 盘上那份)。 */
async function cycle(page) {
  await page.evaluate(() => window.__upage.switchFile('Other.md', '# 别处\n'))
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__upage.switchFile('Unified.md'))
  await page.waitForTimeout(900)
  return {
    skel: await skeleton(page),
    disk: await page.evaluate(() => window.__upage.vault.get('Unified.md') ?? ''),
  }
}

/** 起手(空文档或给定 seed)→ 打字 → 等落盘 → **切走切回两轮** → 返回三次快照。
 *  两轮是要点:一轮只能证明「没丢」,证明不了「不振荡/不累积」(反解公式错了会每轮多长一个空段)。 */
async function roundTrip(browser, keys, seed = '') {
  const page = await open(browser, seed)
  await page.locator(PM).click()
  await page.waitForTimeout(150)
  if (seed) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  for (const k of keys) {
    if (k === '\n') await page.keyboard.press('Enter')
    else await page.keyboard.type(k, { delay: 15 })
  }
  await page.waitForTimeout(1500) // 过防抖窗
  const before = await skeleton(page)
  const disk = await page.evaluate(() => window.__upage.vault.get('Unified.md') ?? '')
  const c1 = await cycle(page)
  const c2 = await cycle(page)
  await page.close()
  return { before, disk, c1, c2 }
}

const CASES = [
  ['C1 段⏎⏎段(对照:今天就该过)', ['alpha', '\n', '\n', 'beta']],
  ['C2 段⏎⏎标题', ['alpha', '\n', '\n', '## bee']],
  ['C3 标题⏎⏎段', ['## bee', '\n', '\n', 'alpha']],
  ['C4 段⏎⏎列表', ['alpha', '\n', '\n', '- x']],
  ['C5 列表⏎⏎段', ['- x', '\n', '\n', 'alpha']],
  ['C6 段⏎⏎⏎段(两条空行)', ['alpha', '\n', '\n', '\n', 'beta']],
  ['C7 末尾空行', ['alpha', '\n', '\n']],
  ['C8 开头空行', ['\n', '\n', 'alpha']],
  ['C9 标题⏎⏎标题', ['## bee', '\n', '\n', '## cee']],
  ['C10 段⏎⏎引用', ['alpha', '\n', '\n', '> q']],
  // 外来 md:CRLF 与「整篇只有空行」两种脏输入不许把公式带崩(Codex 评审 F3)。
  ['C11 CRLF 外来文件', ['尾'], 'alpha\r\n\r\n\r\n\r\nbeta\r\n'],
  ['C12 整篇只有空行', ['x'], '\n\n\n\n'],
]

/** 光标落到顶层第 i 个子元素里第一个文本节点的第 off 个字符(按键序列在 headless 下不可靠)。 */
async function caretAt(page, i, off) {
  await page.locator(PM).click()
  await page.evaluate(([s, idx, o]) => {
    const el = document.querySelector(s).children[idx]
    const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    const r = document.createRange()
    if (t) r.setStart(t, Math.min(o, t.length))
    else r.setStart(el, 0)
    r.collapse(true)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  }, [PM, i, off])
  await page.waitForTimeout(150)
}

const shape = (page) => page.evaluate((s) => ({
  li: document.querySelectorAll(`${s} li`).length,
  kids: [...document.querySelector(s).children].map((el) => el.tagName.toLowerCase()),
  inPrefix: !!document.activeElement?.classList?.contains('amx-struct-prefix'),
}), PM)

/** B 组:结构前缀源码 input 里的回车 —— 必须与「光标停在正文行首按回车」等价。 */
async function prefixEnter(browser) {
  // B1 对照:不进前缀,行首直接回车 → 上方多一个空列表项(共 2 个 li)
  {
    const page = await open(browser, '1. abc\n')
    await caretAt(page, 0, 0)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const s = await shape(page)
    record('B1 对照:列表行首回车 = 上方新空项', s.li === 2, JSON.stringify(s))
    await page.close()
  }
  // B2 病灶:← 进「1. 」源码 input 后回车
  {
    const page = await open(browser, '1. abc\n')
    await caretAt(page, 0, 0)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(250)
    const inside = await shape(page)
    record('B2 前置:← 确实进了前缀 input(病因取证)', inside.inPrefix, JSON.stringify(inside))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const s = await shape(page)
    record('B2 前缀 input 里回车 = 照样换行', s.li === 2, JSON.stringify(s))
    await page.close()
  }
  // B3 标题:← 进「## 」后回车 → 上方一个空段落
  {
    const page = await open(browser, '## bee\n')
    await caretAt(page, 0, 0)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(250)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const s = await shape(page)
    record('B3 标题前缀里回车 = 上方新空段', s.kids.join(',') === 'p,h2', JSON.stringify(s))
    await page.close()
  }
  // B4 回归:前缀被改坏(删掉渲染边界空格)时,回车不许再顺手劈一刀 —— 那一下是「脱壳」
  {
    const page = await open(browser, '- x\n')
    await caretAt(page, 0, 0)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(250)
    await page.keyboard.press('Backspace') // `- ` → `-` = 非法前缀,当场脱壳成正文
    await page.waitForTimeout(400)
    const s = await shape(page)
    record('B4 前缀删坏 → 脱壳成正文(不多劈一行)', s.li === 0 && s.kids.length === 1, JSON.stringify(s))
    await page.close()
  }
}

/** D 组:标题回车与列表续项必须是两套语义。标题右半段降为正文；列表仍续同类列表项。 */
async function headingEnter(browser) {
  {
    const page = await open(browser, '### abcd\n')
    await caretAt(page, 0, 2) // ab|cd
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const s = await skeleton(page)
    record('D1 标题中间回车:左半保留标题、右半变正文', s.join('|') === 'h3:ab|p:cd', JSON.stringify(s))
    await page.close()
  }
  {
    const page = await open(browser, '### abcd\n')
    await caretAt(page, 0, 0)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const s = await skeleton(page)
    record('D2 标题行首回车:上方插正文、原标题不降级', s.join('|') === 'p:|h3:abcd', JSON.stringify(s))
    await page.close()
  }
  {
    const page = await open(browser, '- abcd\n')
    await caretAt(page, 0, 2) // ab|cd (首个顶层元素是 ul,caretAt 会找到 li 里的文本)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const s = await page.evaluate((pm) => [...document.querySelectorAll(`${pm} li`)].map((el) => (el.textContent || '').trim()), PM)
    record('D3 列表中间回车:仍续两个列表项', s.join('|') === 'ab|cd', JSON.stringify(s))
    await page.close()
  }
  {
    const page = await open(browser, '# 甲\n\n甲一。\n\n# 乙\n')
    const heading = await page.evaluate((pm) => {
      const el = document.querySelector(`${pm} h1`)
      const r = el.getBoundingClientRect()
      return { x: r.left + 15, y: r.top + r.height / 2 }
    }, PM)
    await page.mouse.move(heading.x, heading.y, { steps: 3 })
    await page.waitForTimeout(300)
    await page.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
    await page.evaluate(() => {
      const view = window.__upage.probe.view()
      let at = -1
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && node.textContent === '甲') at = pos + 1 + node.content.size
      })
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, at)))
      view.focus()
    })
    await page.keyboard.press('Enter')
    await page.keyboard.type('新正文')
    await page.waitForTimeout(400)
    const s = await page.evaluate((pm) => {
      const root = document.querySelector(pm)
      const el = [...root.querySelectorAll('p')].find((node) => node.textContent.includes('新正文'))
      return {
        order: [...root.children].map((node) => node.textContent.trim()),
        tag: el?.tagName ?? '',
        visible: el ? el.offsetParent !== null : false,
      }
    }, PM)
    const at = s.order.indexOf('新正文')
    record('D4 折叠标题回车:先展开，右半正文紧跟标题且可见',
      s.tag === 'P' && s.visible && at === s.order.indexOf('甲一。') - 1, JSON.stringify(s))
    await page.close()
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  for (const [name, keys, seed] of CASES) {
    const { before, disk, c1, c2 } = await roundTrip(browser, keys, seed)
    const same = JSON.stringify(before) === JSON.stringify(c1.skel) && JSON.stringify(c1.skel) === JSON.stringify(c2.skel)
    // 盘上那份也要逐字不变 —— 光看 DOM 会放过「每轮多写一条空行」这种慢性累积。
    record(name, same && c1.disk === c2.disk,
      `before=${JSON.stringify(before)} c1=${JSON.stringify(c1.skel)} c2=${JSON.stringify(c2.skel)} disk=${JSON.stringify(disk)} disk2=${JSON.stringify(c2.disk)}`)
  }
  await prefixEnter(browser)
  await headingEnter(browser)
  await browser.close()
  const bad = results.filter((r) => !r).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
