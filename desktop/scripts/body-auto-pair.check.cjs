// 正文括号 / 引号自动成对 + 选中后敲 Markdown 符号包裹(Obsidian 手感对齐「成对」那一簇)的页面级检查。
// 全部跑生产 UnifiedPage(台架 `?upage`):真按键、CDP 模拟输入法(Input.imeSetComposition + Input.insertText)。
// 每条比对编辑器准备写盘的 Markdown(serializeNow)逐字,再把结果当一篇新笔记打开、不编辑再取一次,必须逐字不变。
// 「透明」那组(链接 / 脚注 / 待办 / callout / 双链 / 表格)比的是「开着配对打」与「关掉配对打同一串键」两边落盘相同 ——
// 成对只改中间过程,不许改掉这些输入规则成形的结果。
// 实现:frontend/src/amadeus/blocks/markdown/bodyAutoPair.ts、autoPairPrefs.ts、bracketEscape.ts;unified/keyboard.ts 的 wrapSelectionPlugin。
// 用法:npm run check:autopair(由 e2e-editor 自起 / 复用 Vite;worktree 里设 HARNESS_URL)。`--only=A,D` 只跑这几组。
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
const BRACKETS_KEY = 'amadeus.notes.codeAutoPair'
const MARKDOWN_KEY = 'amadeus.notes.markdownAutoPair'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail == null ? '' : `  | ${detail}`}`)
}

async function open(browser, md, { brackets = true, markdown = true, pages } = {}) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&useed=${encodeURIComponent(md + '\n')}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForSelector(PM, { timeout: 180000 })
  await page.waitForFunction(() => typeof window.__upage?.probe?.serializeNow === 'function' && !!window.__upage.probe.view?.(), null, { timeout: 60000 })
  await page.evaluate(([bk, mk, b, m]) => {
    if (b) localStorage.removeItem(bk); else localStorage.setItem(bk, '0')
    if (m) localStorage.removeItem(mk); else localStorage.setItem(mk, '0')
  }, [BRACKETS_KEY, MARKDOWN_KEY, brackets, markdown])
  if (pages) await page.evaluate((p) => window.__pageStore.setState({ pages: p, files: [] }), pages)
  await sleep(300)
  return page
}
const serialize = (page) => page.evaluate(() => window.__upage.probe.serializeNow())
/** 把这次的结果当一篇新笔记打开,不编辑再取一次(obsidian-feel.check 的「重开稳定」同法)。 */
async function reopen(page, md, tag) {
  await page.evaluate(([p, m]) => { window.__apOld = window.__upage.probe.view(); window.__upage.switchFile(p, m) }, [`Reopen-${tag}.md`, md])
  await page.waitForFunction(() => { const v = window.__upage.probe.view?.(); return !!v && v !== window.__apOld && typeof window.__upage.probe.serializeNow() === 'string' }, null, { timeout: 60000 })
  await sleep(300)
  return serialize(page)
}
const caretTo = (page, spec) => page.evaluate((spec) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  let sel
  if (spec.end) sel = st.selection.constructor.atEnd(st.doc)
  else {
    const k = spec.after ?? spec.before
    let hit = null
    st.doc.descendants((node, pos) => {
      if (hit) return false
      if (!node.isTextblock) return true
      const i = node.textBetween(0, node.content.size, '', '\ufffc').indexOf(k)
      if (i >= 0) hit = { start: pos + 1 + i, end: pos + 1 + i + k.length }
      return false
    })
    if (!hit) throw new Error('锚点没找到: ' + k)
    sel = TS.create(st.doc, spec.after != null ? hit.end : hit.start)
  }
  v.focus(); v.dispatch(st.tr.setSelection(sel).scrollIntoView())
}, spec)
const select = (page, text) => page.evaluate((text) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  let hit = null
  st.doc.descendants((node, pos) => {
    if (hit) return false
    if (!node.isTextblock) return true
    const i = node.textBetween(0, node.content.size, '', '\ufffc').indexOf(text)
    if (i >= 0) hit = { start: pos + 1 + i, end: pos + 1 + i + text.length }
    return false
  })
  if (!hit) throw new Error('锚点没找到: ' + text)
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit.start, hit.end)).scrollIntoView())
}, text)
const selected = (page) => page.evaluate(() => { const s = window.__upage.probe.view().state; return s.doc.textBetween(s.selection.from, s.selection.to) })
const caretInfo = (page) => page.evaluate(() => {
  const $h = window.__upage.probe.view().state.selection.$head
  return { text: $h.parent.textBetween(0, $h.parent.content.size, '', '\ufffc'), off: $h.parentOffset }
})
const markNames = (page) => page.evaluate(() => {
  const out = new Set()
  window.__upage.probe.view().state.doc.descendants((n) => { for (const m of n.marks) out.add(m.type.name); return true })
  return [...out].sort()
})
const nodeNames = (page) => page.evaluate(() => {
  const out = new Set()
  window.__upage.probe.view().state.doc.descendants((n) => { out.add(n.type.name + (n.attrs?.checked != null ? `[${n.attrs.checked}]` : '')); return true })
  return [...out].sort()
})
const type = async (page, s) => { await page.keyboard.type(s, { delay: 25 }); await sleep(80) }
/** 「空行上开始」:起始文档最后一段只有一个 q,选中它退格(obsidian-feel 的 BLANK 同法)。 */
async function blank(page) { await select(page, 'q'); await page.keyboard.press('Backspace'); await sleep(80) }

/** 跑一条:开 seed → act → 比 md(exact)→ 重开再取逐字不变。返回 md。 */
async function caseMd(browser, name, seed, act, wantMd, opts) {
  const page = await open(browser, seed, opts)
  try {
    const mid = await act(page)
    const md = await serialize(page)
    if (wantMd != null) check(`${name}`, md === wantMd, `got ${JSON.stringify(md)} want ${JSON.stringify(wantMd)}${mid ? ' ' + JSON.stringify(mid) : ''}`)
    const again = await reopen(page, md, name.replace(/\W+/g, '_').slice(0, 40))
    check(`${name} · 重开再存不变`, again === md, `${JSON.stringify(md)} → ${JSON.stringify(again)}`)
    return { md, mid }
  } catch (e) {
    check(`${name}(异常)`, false, String(e && e.message || e).split('\n')[0])
    return { md: null }
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // ── A 正文配对:补闭合 / 跨过 / 成对退格,各种正文块 ──
    if (want('A')) {
      await caseMd(browser, 'A1 段落:( 补闭合、敲 ) 跨过、空的一对退格两个一起删', 'ab', async (p) => {
        await caretTo(p, { end: true })
        await type(p, ' (')
        const opened = await serialize(p)
        const c1 = await caretInfo(p)
        await type(p, 'a)')
        const closed = await serialize(p)
        await type(p, ' (')
        await p.keyboard.press('Backspace'); await sleep(80)
        check('A1 敲 ( 之后 = "ab ()",光标在中间', opened === 'ab ()\n' && c1.off === 4, JSON.stringify({ opened, c1 }))
        check('A1 敲 a) 之后 = "ab (a)"(跨过,不多一个)', closed === 'ab (a)\n', JSON.stringify(closed))
      }, 'ab (a) \n')
      for (const [label, seq, mid, end] of [
        ['A2 双引号', ' "', 'ab ""\n', 'ab "x"\n'],
        ['A2 方括号 + 花括号', ' [{', 'ab [{}]\n', 'ab [{x}]\n'],
        ['A2 双方括号', ' [[', 'ab [[]]\n', 'ab [[x]]\n'],
        ['A2 单引号', " '", "ab ''\n", "ab 'x'\n"],
      ]) {
        await caseMd(browser, label, 'ab', async (p) => {
          await caretTo(p, { end: true })
          await type(p, seq)
          const m = await serialize(p)
          check(`${label} 敲下后`, m === mid, JSON.stringify(m))
          await type(p, 'x')
        }, end)
      }
      await caseMd(browser, "A3 引号挨着字母不配:don't、a\"b", 'ab', async (p) => {
        await caretTo(p, { end: true }); await type(p, " don't a\"b")
      }, 'ab don\'t a"b\n')
      await caseMd(browser, 'A4 标题里', '# Title', async (p) => { await caretTo(p, { end: true }); await type(p, ' (h') }, '# Title (h)\n')
      await caseMd(browser, 'A5 列表项里', '- item', async (p) => { await caretTo(p, { end: true }); await type(p, ' "q') }, '- item "q"\n')
      await caseMd(browser, 'A6 引用里', '> quote', async (p) => { await caretTo(p, { end: true }); await type(p, ' [y') }, '> quote [y]\n')
      // callout 标题与正文是两段,正文一经编辑存盘两段之间多一行 `>`(与配对无关,K07 同因),所以这里比开 / 关两边。
      {
        const act = async (p) => { await caretTo(p, { after: 'body' }); await type(p, ' (z') }
        const on = await caseMd(browser, 'A7 callout 正文里(开)', '> [!note] Title\n> body', act, null)
        const off = await caseMd(browser, 'A7 callout 正文里(关,手打闭合)', '> [!note] Title\n> body', async (p) => { await act(p); await type(p, ')') }, null, { brackets: false })
        check('A7 callout 正文里:自动补的 ) 与手打的落盘相同,且是 body (z)', on.md != null && on.md === off.md && on.md.includes('> body (z)'), JSON.stringify([on.md, off.md]))
      }
      await caseMd(browser, 'A8 行内代码里不配', '`code`', async (p) => { await caretTo(p, { after: 'co' }); await type(p, '(') }, '`co(de`\n')
      await caseMd(browser, 'A9 公式里引号不配', '$f$', async (p) => { await caretTo(p, { after: 'f' }); await type(p, "'") }, "$f'$\n")
      await caseMd(browser, 'A10 代码块里仍由代码块配对(开关共用)', '```js\nlet x\n```', async (p) => { await caretTo(p, { after: 'let x' }); await type(p, ' = f(') }, '```js\nlet x = f()\n```\n')
      await caseMd(browser, 'A11 全角括号不配', 'ab', async (p) => { await caretTo(p, { end: true }); await p.keyboard.insertText('（'); await sleep(80) }, 'ab（\n')
      await caseMd(browser, 'A12 紧贴在字前面不配', 'ab cd', async (p) => { await caretTo(p, { before: 'cd' }); await type(p, '(') }, 'ab (cd\n')
    }

    // ── B 透明:开着配对打、关掉配对打同一串键,两边落盘必须相同(输入规则照常成形)──
    if (want('B')) {
      const transparent = async (label, seed, act, verify) => {
        const on = await caseMd(browser, `${label}(开)`, seed, async (p) => { await act(p); return verify ? verify(p) : null }, null)
        const off = await caseMd(browser, `${label}(关)`, seed, async (p) => { await act(p); return verify ? verify(p) : null }, null, { brackets: false })
        check(`${label}:开着配对和关掉配对落盘相同`, on.md != null && on.md === off.md, `on ${JSON.stringify(on.md)} off ${JSON.stringify(off.md)}`)
        return on
      }
      let r = await transparent('B1 行内链接 [site](地址)', 'start\n\nq', async (p) => { await blank(p); await type(p, 'go [site](https://example.com) end') }, markNames)
      check('B1 链接成形(link mark)', Array.isArray(r.mid) && r.mid.includes('link'), JSON.stringify(r.mid))
      r = await transparent('B2 脚注 [^a]', 'start\n\nq', async (p) => { await blank(p); await type(p, 'x[^a] y') }, null)
      check('B2 脚注引用成形', r.md != null && r.md.includes('x[^a]') && !r.md.includes('\\['), JSON.stringify(r.md))
      r = await transparent('B3 待办 - [ ] 空格', 'start\n\nq', async (p) => { await blank(p); await type(p, '- [ ] d') }, nodeNames)
      check('B3 成了待办', Array.isArray(r.mid) && r.mid.some((n) => /\[false\]/.test(n)), JSON.stringify(r.mid))
      r = await transparent('B4 callout > [!note] 标题(K-13)', 'start\n\nq', async (p) => { await blank(p); await type(p, '> [!note] T') }, null)
      check('B4 callout 令牌被替换', r.md != null && r.md.includes('[!note] T') && !r.md.includes('[!fold]'), JSON.stringify(r.md))
      r = await transparent('B5 双链打完 ]](R14)', 'see x', async (p) => { await caretTo(p, { after: 'see ' }); await type(p, '[[Note]]') }, caretInfo)
      check('B5 落盘 see [[Note]]x,光标在 ]] 后', r.md === 'see [[Note]]x\n' && r.mid && r.mid.off === 12, JSON.stringify(r))
      r = await transparent('B6 表格单元格', '| a | b |\n| --- | --- |\n| c | d |', async (p) => { await caretTo(p, { after: 'c' }); await type(p, ' (e) "f" [g]') }, null)
      check('B6 单元格里是 c (e) "f" [g]', r.md != null && r.md.includes('c (e) "f" [g]'), JSON.stringify(r.md))
      r = await transparent('B7 跨过已有的方括号', 'start\n\nq', async (p) => { await blank(p); await type(p, 'a [b] c') }, null)
      check('B7 落盘 a [b] c', r.md === 'start\n\na [b] c\n', JSON.stringify(r.md))
      // 单元格里配对过程本身:敲 ( 之后就是一对
      await caseMd(browser, 'B8 表格单元格里敲 ( 补上 )', '| a | b |\n| --- | --- |\n| c | d |', async (p) => {
        await caretTo(p, { after: 'c' }); await type(p, ' (')
        const ci = await caretInfo(p)
        check('B8 单元格文字 "c ()",光标在中间', ci.text === 'c ()' && ci.off === 3, JSON.stringify(ci))
        await type(p, 'e)')
      }, null)
    }

    // ── C 双链补全:自动补上的 ]] 与候选面板一起用 ──
    if (want('C')) {
      await caseMd(browser, 'C1 [[ 补成 [[]] 后面板照弹,回车选中只换名字、光标落在 ]] 后', 'see x', async (p) => {
        await caretTo(p, { after: 'see ' })
        await type(p, '[[Al')
        const shown = await p.evaluate(() => [...document.querySelectorAll('.wiki-suggest .wiki-item')].map((e) => e.textContent))
        check('C1 面板弹出且有 Alpha', shown.some((s) => s.includes('Alpha')), JSON.stringify(shown))
        await p.keyboard.press('Enter'); await sleep(150)
        await type(p, 'Z')
      }, 'see [[Alpha]]Zx\n', { pages: ['Alpha.md', 'Beta.md', 'Unified.md'] })
      await caseMd(browser, 'C2 全角【【 照旧换成 [[ 并弹面板', 'see x', async (p) => {
        await caretTo(p, { after: 'see ' })
        await p.keyboard.insertText('【'); await sleep(60)
        await p.keyboard.insertText('【'); await sleep(200)
        const n = await p.locator('.wiki-suggest').count()
        check('C2 面板弹出', n > 0, String(n))
        await p.keyboard.press('Escape'); await sleep(100)
      }, 'see [[x\n', { pages: ['Alpha.md', 'Beta.md', 'Unified.md'] })
    }

    // ── D 输入法:组字期间绝不配对;组字提交上来的字不吞不重 ──
    if (want('D')) {
      const ime = async (p, steps, commit) => {
        const cdp = await p.context().newCDPSession(p)
        for (const t of steps) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(70) }
        await cdp.send('Input.insertText', { text: commit }); await sleep(200)
        await cdp.detach()
      }
      await caseMd(browser, 'D1 组字打出 ( 提交:只有一个 (,不配不吞', 'ab', async (p) => {
        await caretTo(p, { end: true }); await ime(p, ['('], '('); await type(p, 'x')
      }, 'ab(x\n')
      await caseMd(browser, 'D2 一对里组字 ni → 你,再敲 ) 跨过', 'ab', async (p) => {
        await caretTo(p, { end: true }); await type(p, '(')
        await ime(p, ['n', 'ni'], '你')
        const mid = await caretInfo(p)
        check('D2 组字提交后 = "ab(你)",光标在 你 后', mid.text === 'ab(你)' && mid.off === 4, JSON.stringify(mid))
        await type(p, ')')
      }, 'ab(你)\n')
      await caseMd(browser, 'D3 组字提交全角(:不配', 'ab', async (p) => { await caretTo(p, { end: true }); await ime(p, ['（'], '（') }, 'ab（\n')
      await caseMd(browser, 'D4 紧挨自动补的 ) 组字提交 ):照原样落字,不吞', 'ab', async (p) => {
        await caretTo(p, { end: true }); await type(p, '(')
        await ime(p, [')'], ')')
      }, 'ab())\n')
      await caseMd(browser, 'D5 空格后组字打出 " 提交:不配', 'ab', async (p) => { await caretTo(p, { end: true }); await type(p, ' '); await sleep(100); await ime(p, ['"'], '"') }, 'ab "\n')
      await caseMd(browser, 'D8 组字进行中(还没提交)文档里不出现补上的 )', 'ab', async (p) => {
        await caretTo(p, { end: true })
        const cdp = await p.context().newCDPSession(p)
        await cdp.send('Input.imeSetComposition', { text: '(', selectionStart: 1, selectionEnd: 1 }); await sleep(150)
        const mid = await p.evaluate(() => window.__upage.probe.view().state.doc.textContent)
        check('D8 组字中 doc 里没有 )', !mid.includes(')'), JSON.stringify(mid))
        await cdp.send('Input.insertText', { text: '(' }); await sleep(200)
        await cdp.detach()
      }, 'ab(\n')
      await caseMd(browser, 'D6 组字中途的字含 (、最后提交成别的:不残留括号', 'ab', async (p) => {
        await caretTo(p, { end: true }); await ime(p, ['(', '(n'], '你')
      }, 'ab你\n')
      await caseMd(browser, 'D7 输入法直接上屏的 (( 不经组字)= 普通打字,照常配', 'ab', async (p) => {
        await caretTo(p, { end: true }); await p.keyboard.insertText('('); await sleep(100); await type(p, 'x')
      }, 'ab(x)\n')
    }

    // ── E 开关「自动补全括号和引号」关掉 ──
    if (want('E')) {
      const off = { brackets: false }
      await caseMd(browser, 'E1 关:( 不补', 'ab', async (p) => { await caretTo(p, { end: true }); await type(p, ' (a') }, 'ab (a\n', off)
      await caseMd(browser, 'E2 关:" 不补', 'ab', async (p) => { await caretTo(p, { end: true }); await type(p, ' "x') }, 'ab "x\n', off)
      await caseMd(browser, 'E3 关:[[ 不补', 'ab', async (p) => { await caretTo(p, { end: true }); await type(p, ' [[x') }, 'ab [[x\n', off)
      await caseMd(browser, 'E4 关:) 不跨,照常多一个', 'ab ()', async (p) => { await caretTo(p, { after: 'ab (' }); await type(p, ')') }, 'ab ())\n', off)
      await caseMd(browser, 'E5 关:空的一对里退格只删左半', 'ab ()', async (p) => { await caretTo(p, { after: 'ab (' }); await p.keyboard.press('Backspace'); await sleep(80) }, 'ab )\n', off)
      await caseMd(browser, 'E6 关:代码块也不补', '```js\nlet x\n```', async (p) => { await caretTo(p, { after: 'let x' }); await type(p, ' = f(') }, '```js\nlet x = f(\n```\n', off)
    }

    // ── F 选中后敲 Markdown 符号(开关「自动补全 Markdown 符号」)──
    if (want('F')) {
      const sel = async (p, text, ch) => { await select(p, text); await type(p, ch) }
      await caseMd(browser, 'F1 选中 world 敲 * → *world*(K13),选区保持', 'hello world', async (p) => {
        await sel(p, 'world', '*')
        check('F1 选区仍是 world', (await selected(p)) === 'world', await selected(p))
      }, 'hello *world*\n')
      await caseMd(browser, 'F2 再敲一次 * → 粗体', 'hello world', async (p) => { await sel(p, 'world', '*'); await type(p, '*') }, 'hello **world**\n')
      await caseMd(browser, 'F3 _ 同斜体', 'hello world', async (p) => { await sel(p, 'world', '_') }, 'hello *world*\n')
      await caseMd(browser, 'F4 ~ 字面包一层,再敲变删除线', 'hello world', async (p) => {
        await sel(p, 'world', '~')
        const one = await serialize(p)
        check('F4 一次 ~ = hello ~world~', one === 'hello ~world~\n', JSON.stringify(one))
        await type(p, '~')
      }, 'hello ~~world~~\n')
      await caseMd(browser, 'F5 = $ % [ 字面包裹(K13b / K13c)', 'hello world there more', async (p) => {
        await sel(p, 'hello', '='); await sel(p, 'world', '$'); await sel(p, 'there', '['); await sel(p, 'more', '%')
      }, '=hello= $world$ [there] %more%\n')
      await caseMd(browser, 'F6 再敲一次 = 成高亮,$ 成块公式', 'hello world', async (p) => {
        await sel(p, 'hello', '='); await type(p, '=')
      }, '==hello== world\n')
      await caseMd(browser, 'F7 括号 / 引号 / 反引号 / 全角包裹照旧', 'a b c d', async (p) => {
        await sel(p, 'a', '('); await sel(p, 'b', '"'); await sel(p, 'c', '`'); await select(p, 'd'); await p.keyboard.insertText('【'); await sleep(80)
      }, '(a) "b" `c` 【d】\n')
      await caseMd(browser, 'F8 Markdown 符号开关关掉:* 照旧替换选区', 'hello world', async (p) => { await sel(p, 'world', '*') }, 'hello \\*\n', { markdown: false })
      await caseMd(browser, 'F9 Markdown 符号开关关掉:括号包裹不受影响', 'hello world', async (p) => { await sel(p, 'world', '(') }, 'hello (world)\n', { markdown: false })
      await caseMd(browser, 'F10 括号开关关掉:Markdown 符号包裹不受影响', 'hello world', async (p) => { await sel(p, 'world', '*') }, 'hello *world*\n', { brackets: false })
    }
  } finally {
    await browser.close()
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
