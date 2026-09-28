// 编辑区的拼写检查(评审 2026-09-27 波次 1:G4-07),台架 `?upage`(生产 UnifiedPage)。
//
//  S 组(G4-07 拼写检查):
//   S1 缺省开:正文 / 标题框查;代码块、行内代码、公式源码不查(代码类节点 spellcheck=false)
//   S2 设置里关掉 → 正文、标题框、源码 textarea 一起不查;再打开 → 源码 textarea 也跟着查(两种编辑模式同一口径)
//
// 用法:npm run check:spellctx(= node scripts/e2e-editor.cjs --check=spellctx;worktree 里设 HARNESS_URL)
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
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SEED = [
  '# 拼写',
  '',
  'Teh quikc brown fox `constt fooo` and $E=mc^2$ here.',
  '',
  '```js',
  'const mispeled = 1',
  '```',
  '',
  '甲乙丙一二三丁戊己。',
  '',
  '第二段文字。',
  '',
].join('\n')

async function open(ctx) {
  const p = await ctx.newPage()
  p.errs = []
  p.on('pageerror', (e) => { p.errs.push(e.message); console.log('[pageerror]', e.message) })
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(`${PM} pre`, { timeout: 60000 })
  await p.waitForTimeout(500)
  return p
}

/** 含 text 的文本节点所在元素的**有效**拼写检查状态(HTMLElement.spellcheck 按祖先继承求值)。 */
const spellOf = (p, text) => p.evaluate(([s, text]) => {
  const root = document.querySelector(s)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(text)) return n.parentElement.spellcheck
  return null
}, [PM, text])

async function groupS(ctx) {
  const p = await open(ctx)
  const s1 = {
    root: await p.evaluate((s) => document.querySelector(s).spellcheck, PM),
    para: await spellOf(p, 'quikc'),
    inlineCode: await spellOf(p, 'constt'),
    math: await spellOf(p, '$E=mc^2$'), // 公式源码那段(KaTeX 渲染件里的 annotation 也含 mc^2,带定界符才认得准)
    codeBlock: await spellOf(p, 'mispeled'),
    title: await p.evaluate(() => document.querySelector('input.amx-title-input').spellcheck),
  }
  record('S1 缺省开:正文 / 标题查,代码块 / 行内代码 / 公式源码不查',
    s1.root === true && s1.para === true && s1.title === true && s1.inlineCode === false && s1.math === false && s1.codeBlock === false, JSON.stringify(s1))

  const toggle = (on) => p.evaluate((on) => {
    localStorage.setItem('amadeus.notes.spellcheck', on ? '1' : '0')
    window.dispatchEvent(new Event('amadeus:notes-spellcheck')) // 设置页的写口(setNotesSpellcheckEnabled)就是这两步
  }, on)
  await toggle(false)
  await wait(200)
  const off = {
    para: await spellOf(p, 'quikc'),
    title: await p.evaluate(() => document.querySelector('input.amx-title-input').spellcheck),
  }
  await p.evaluate(() => window.__upage.setEditorMode('source'))
  await p.waitForSelector('textarea.amx-source', { timeout: 5000 })
  off.source = await p.evaluate(() => document.querySelector('textarea.amx-source').spellcheck)
  await toggle(true)
  await wait(200)
  const onSrc = await p.evaluate(() => document.querySelector('textarea.amx-source').spellcheck)
  await p.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
  await p.waitForSelector(`${PM} pre`, { timeout: 5000 })
  await wait(300)
  const back = await spellOf(p, 'quikc')
  record('S2 关掉 → 正文 / 标题 / 源码都不查;再打开 → 源码与正文都查(两种模式同一个开关)',
    off.para === false && off.title === false && off.source === false && onSrc === true && back === true, JSON.stringify({ off, onSrc, back }))
  record('S3 全程无运行时异常', p.errs.length === 0, p.errs.slice(0, 2).join(' | '))
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
    await groupS(ctx)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
