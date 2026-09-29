// 编辑区的拼写检查与右键(评审 2026-09-27 波次 1:G4-07 / G4-08 / B-09),台架 `?upage`(生产 UnifiedPage)。
//
//  S 组(G4-07 拼写检查):
//   S1 缺省开:正文 / 标题框查;代码块、行内代码、公式源码不查(代码类节点 spellcheck=false)
//   S2 设置里关掉 → 正文、标题框、源码 textarea 一起不查;再打开 → 源码 textarea 也跟着查(两种编辑模式同一口径)
//  C 组(G4-08 / B-09 右键,渲染层那一半;系统菜单本身由 Electron 主进程 editContextMenu 出,见 editContextMenu.test.ts):
//   C1 拖选几个字后右键选区 → 不吞原生菜单、选区不被换成整块、不出块菜单
//   C2 光标在段落里右键 → 同上(交给系统菜单)
//   C3 右键 ⠿ 把手 → 块菜单 + 选中该块(接管原生菜单)
//   C4 块已选中时右键这一块 → 块菜单;右键别的(没选中的)段落 → 交还系统菜单
//   C5 Mod+Shift+V → 粘贴剪贴板的纯文本(不走 HTML、不带格式)
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

const selInfo = (p) => p.evaluate(() => {
  const s = window.__upage.probe.view().state.selection
  return { type: s.toJSON().type, from: s.from, to: s.to }
})

/** 右键 (x,y) 并记下这次 contextmenu 在冒泡末端是否被 preventDefault(= 原生菜单被吞)。 */
async function rightClick(p, x, y) {
  await p.evaluate(() => {
    window.__ctx = null
    document.addEventListener('contextmenu', (e) => { window.__ctx = e.defaultPrevented }, { once: true })
  })
  await p.mouse.click(x, y, { button: 'right' })
  await wait(250)
  return p.evaluate(() => ({ prevented: window.__ctx, menu: document.querySelectorAll('.unified-block-menu').length }))
}

async function groupS(ctx) {
  const p = await open(ctx)
  const s1 = {
    root: await p.evaluate((s) => document.querySelector(s).spellcheck, PM),
    para: await spellOf(p, 'quikc'),
    inlineCode: await spellOf(p, 'constt'),
    math: await spellOf(p, '$E=mc^2$'), // 公式源码那段(KaTeX 渲染件里的 annotation 也含 mc^2,带定界符才认得准)
    codeBlock: await spellOf(p, 'mispeled'),
    title: await p.evaluate(() => document.querySelector('.amx-title-input').spellcheck),
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
    title: await p.evaluate(() => document.querySelector('.amx-title-input').spellcheck),
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

async function groupC(ctx) {
  const p = await open(ctx)
  // C1:拖选「一二三」后右键选区
  const pos = await p.evaluate(() => {
    const v = window.__upage.probe.view()
    let at = -1
    v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('一二三')) at = pos + n.text.indexOf('一二三'); return at < 0 })
    const a = v.coordsAtPos(at), z = v.coordsAtPos(at + 3)
    return { at, ax: a.left + 1, ay: (a.top + a.bottom) / 2, zx: z.left - 1, zy: (z.top + z.bottom) / 2 }
  })
  await p.mouse.move(pos.ax, pos.ay)
  await p.mouse.down()
  await p.mouse.move(pos.zx, pos.zy, { steps: 8 })
  await p.mouse.up()
  await wait(300)
  const before = await selInfo(p)
  const r1 = await rightClick(p, (pos.ax + pos.zx) / 2, pos.ay)
  const after = await selInfo(p)
  record('C1 拖选文字后右键:不吞原生菜单、选区原样、不出块菜单',
    before.type === 'text' && before.to - before.from === 3 && r1.prevented === false && r1.menu === 0 && after.type === 'text' && after.from === before.from && after.to === before.to,
    JSON.stringify({ before, r1, after }))

  // C2:光标在段落里右键
  const para2 = await p.evaluate((s) => {
    const el = [...document.querySelectorAll(`${s} p`)].find((x) => x.textContent.includes('第二段'))
    const r = el.getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  }, PM)
  await p.mouse.click(para2.x, para2.y)
  await wait(150)
  const r2 = await rightClick(p, para2.x, para2.y)
  const s2 = await selInfo(p)
  record('C2 光标在段落里右键:交给系统菜单(不吞、不出块菜单、不改成整块)', r2.prevented === false && r2.menu === 0 && s2.type === 'text', JSON.stringify({ r2, s2 }))

  // C3:右键 ⠿ 把手
  const q = await p.evaluate((s) => {
    const el = [...document.querySelectorAll(`${s} p`)].find((x) => x.textContent.includes('甲乙丙'))
    const r = el.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + r.height / 2 }
  }, PM)
  await p.mouse.move(q.x, q.y)
  await wait(250)
  const h = await p.evaluate(() => {
    const el = document.querySelector('.unified-gutter[data-show="true"] .drag-handle')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const r3 = h ? await rightClick(p, h.x, h.y) : null
  const s3 = await p.evaluate(() => {
    const s = window.__upage.probe.view().state.selection
    return { type: s.toJSON().type, text: s.node?.textContent ?? null }
  })
  record('C3 右键 ⠿ 把手:块菜单 + 选中该块', !!r3 && r3.prevented === true && r3.menu === 1 && s3.type === 'node' && (s3.text ?? '').includes('甲乙丙'), JSON.stringify({ h, r3, s3 }))

  // C4:块还选着(Esc 关菜单,块选保留)→ 右键这一块出菜单;右键别的段落交还系统菜单
  await p.keyboard.press('Escape')
  await wait(150)
  const kept = await selInfo(p)
  const r4a = await rightClick(p, q.x, q.y)
  await p.keyboard.press('Escape')
  await wait(150)
  const r4b = await rightClick(p, para2.x, para2.y)
  record('C4 块已选中时右键这一块 → 块菜单;右键没选中的段落 → 交还系统菜单',
    kept.type === 'node' && r4a.prevented === true && r4a.menu === 1 && r4b.prevented === false && r4b.menu === 0, JSON.stringify({ kept, r4a, r4b }))

  // C5:Mod+Shift+V 粘贴纯文本(剪贴板同时有 HTML 与纯文本)
  await p.mouse.click(para2.x, para2.y)
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await wait(100)
  const wrote = await p.evaluate(async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob(['<p><b>HTML粗体</b></p>'], { type: 'text/html' }),
        'text/plain': new Blob(['纯文本 **不解析**'], { type: 'text/plain' }),
      })])
      return true
    } catch (e) { return String(e) }
  })
  await p.keyboard.press('ControlOrMeta+Shift+KeyV')
  await wait(400)
  const c5 = await p.evaluate(() => {
    const v = window.__upage.probe.view()
    let strong = false
    v.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'strong')) strong = true })
    return { text: v.state.doc.textContent, strong }
  })
  record('C5 Mod+Shift+V:粘进剪贴板的纯文本(不走 HTML、不带格式)',
    wrote === true && c5.text.includes('纯文本 **不解析**') && !c5.text.includes('HTML粗体') && !c5.strong, JSON.stringify({ wrote, c5 }))
  record('C6 全程无运行时异常', p.errs.length === 0, p.errs.slice(0, 2).join(' | '))
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
    await groupS(ctx)
    await groupC(ctx)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
