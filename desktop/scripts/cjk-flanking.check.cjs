// 磁盘上「CJK 标点贴定界符」的 attention 串在真编辑器里的往返(真浏览器 × 真 MarkdownBlock,harness)。
//
// 病:`**注意：**后面` / `~~（备注）~~继续`(闭合定界符内侧标点、外侧汉字)CommonMark 判不成立 → 显示字面 `**`,
// 下次保存被转义成 `\*\*注意：\*\*后面`,不可逆。药 = 解析侧挂 CJK 友好扩展(blocks/markdown/cjkFriendly.ts),
// 落盘侧 attentionFlanking 照旧编外侧汉字 → `**注意：**&#x540E;面`(CommonMark / Obsidian 也认)。
// 顺带钉与自定义 remark 插件的共存:下划线 HTML 桥、callout、块内软换行、双链。
//
// 用法:npm run check:cjk(= npm run e2e:editor -- --check=cjk-flanking,自带起停 vite)
// 负对照:CJK_NEGATIVE=1 npm run check:cjk —— 在浏览器里把 cjkFriendly.ts 换成空插件(不碰源码),
//         K 系列应当整排 FAIL,且落盘串 = 用户实报的 `\*\*…`。
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
const NEGATIVE = !!process.env.CJK_NEGATIVE
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed) {
  const page = await browser.newPage({ locale: 'zh-CN' })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // milkdown 的 .use() 收数组,空数组 = 什么都不挂。
  if (NEGATIVE) await page.route(/\/cjkFriendly\.ts(\?.*)?$/, (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const cjkFriendlyRemark = []; export function remarkCjkFriendlyParse() {}' }))
  await page.goto(`${BASE}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(500)
  return page
}

/** 在最后一个顶层元素末尾打一个字,逼编辑器序列化一次(不碰 mark 所在那段),返回落盘串。 */
async function touchAndDump(page) {
  await page.locator('.md-block .ProseMirror').first().click()
  await page.evaluate(() => {
    const el = document.querySelector('.md-block .ProseMirror').lastElementChild
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let t = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) t = n
    const range = document.createRange()
    if (t) range.setStart(t, t.length)
    else range.setStart(el, 0)
    range.collapse(true)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.waitForTimeout(120)
  await page.keyboard.type('x', { delay: 20 })
  await page.waitForTimeout(600)
  return page.evaluate(() => window.__harness.blocks[0].content)
}

const count = (page, tag) => page.evaluate((tag) => document.querySelector('.md-block .ProseMirror').querySelectorAll(tag).length, tag)
const literal = (page, lit) => page.evaluate((lit) => document.querySelector('.md-block .ProseMirror').innerText.includes(lit), lit)

// 落盘形取决于 MarkdownBlock 挂没挂 attentionSerializer(09-18 另一条线在途):挂了 = 外侧汉字编成字符引用
// (CommonMark / Obsidian 也认);没挂 = 原样落盘(本插件下照样是 mark,只是 Obsidian 仍判字面)。按源码现状取期望,两态都严格。
const ENCODES = /\.use\(attentionSerializer\)/.test(fs.readFileSync(path.join(__dirname, '../frontend/src/amadeus/blocks/markdown/MarkdownBlock.tsx'), 'utf8'))
const savedForm = (s) => (ENCODES ? s : s.replace(/&#x([0-9A-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))))

// [id, 名, 磁盘原文, mark 标签, mark 个数, 落盘必须含的片段(按挂了 attentionSerializer 写)…]。结尾的「尾」段专供 touchAndDump 打字。
const CASES = [
  ['K1', '加粗:全角冒号贴闭合', '**注意：**后面\n\n尾', 'strong', '**', 1, ['**注意：**&#x540E;面']],
  ['K2', '加粗:引号贴闭合', '**「引号」**后面\n\n尾', 'strong', '**', 1, ['**「引号」**&#x540E;面']],
  ['K3', '斜体:括号贴闭合', '*（备注）*继续\n\n尾', 'em', '*', 1, ['*（备注）*&#x7EE7;续']],
  ['K4', '删除线:括号贴闭合', '~~（备注）~~继续\n\n尾', 'del', '~~', 1, ['~~（备注）~~&#x7EE7;续']],
  ['K5', '列表项(AI 输出最常见)', '- **注意：**后面\n- **步骤一：**打开\n\n尾', 'strong', '**', 2, ['**注意：**&#x540E;面', '**步骤一：**&#x6253;开']],
  ['K6', '同段下划线 HTML 桥', '**注意：**后面<u>下划线</u>\n\n尾', 'strong', '**', 1, ['**注意：**&#x540E;面', '<u>下划线</u>']],
  ['K7', 'callout 里', '> [!note] 提示\n> **注意：**后面\n\n尾', 'strong', '**', 1, ['[!note]', '**注意：**&#x540E;面']],
  ['K8', '块内软换行', '**注意：**后面\n第二行\n\n尾', 'strong', '**', 1, ['**注意：**&#x540E;面\n第二行']],
  ['K9', '双链贴闭合', '**[[页面]]**后面\n\n尾', 'strong', '**', 1, ['**[[页面]]**&#x540E;面']],
]

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  for (const [id, name, seed, tag, lit, want, parts] of CASES) {
    const p1 = await open(browser, seed)
    const n1 = await count(p1, tag)
    check(`${id} ${name}:打开即是 <${tag}>×${want}、不露字面 ${lit}`, n1 === want && !(await literal(p1, lit)), `n=${n1}`)
    const md = await touchAndDump(p1)
    await p1.close()
    check(`${id} ${name}:保存不转义定界符`, !/\\[*~]/.test(md), JSON.stringify(md))
    const miss = parts.map(savedForm).filter((s) => !md.includes(s))
    check(`${id} ${name}:落盘形`, miss.length === 0, miss.length ? `缺 ${JSON.stringify(miss)} ← ${JSON.stringify(md)}` : '')
    // 重开 = 下一次从磁盘重解析(切笔记 / 外部回灌 / 同步拉回)。
    const p2 = await open(browser, md)
    const n2 = await count(p2, tag)
    check(`${id} ${name}:重开仍是 <${tag}>×${want}`, n2 === want && !(await literal(p2, lit)), `n=${n2}`)
    await p2.close()
  }
  // 本来就成立的写法:打开→存→字不改(只多打的那个 x)。
  {
    const seed = '这是**加粗**文字，*斜体*与~~删除~~。\n\n尾'
    const p = await open(browser, seed)
    const md = await touchAndDump(p)
    await p.close()
    check('U1 普通 CJK 加粗/斜体/删除线原样往返', md.trimEnd() === seed + 'x', JSON.stringify(md))
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过(落盘形按${ENCODES ? '已挂 attentionSerializer:字符引用' : '未挂 attentionSerializer:原样'})${NEGATIVE ? '(负对照模式:K 系列应当 FAIL)' : ''}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
