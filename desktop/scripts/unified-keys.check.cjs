// v4 统一编辑器键盘层回归(Amadeus 评审 2026-09-27 波次 0b · keys 包):K-02 / K-03 / K-04 / R-04;
// 波次 1 keys 包:B-12(Mod+D 复制块,四种选区 + Ctrl+D 平台归属);B-13(折叠命令 / 热键 / 本机记忆)。
// 波次 2 serial 包:K-19(标题里 Shift+Enter 同回车,不再落盘丢换行)。
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
    let label = c.type.name + (c.type.name === 'heading' ? c.attrs.level : '') + (c.attrs.checked != null ? (c.attrs.checked ? '[x]' : '[ ]') : '')
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
/** 光标放进第一个含 text 的文本块:偏移 = text 在块内的起点 + off(缺省 = text 末尾)。 */
const caretAtText = (page, text, off = null) => page.evaluate(({ text, off }) => {
  const v = window.__upage.probe.view()
  let hit = null
  v.state.doc.descendants((n, p) => {
    if (hit != null) return false
    if (n.isTextblock && n.textContent.includes(text)) {
      const i = n.textContent.indexOf(text)
      hit = p + 1 + i + (off == null ? text.length : off)
      return false
    }
    return true
  })
  const S = v.state.selection.constructor
  v.dispatch(v.state.tr.setSelection(S.near(v.state.doc.resolve(hit))))
  v.focus()
  return hit
}, { text, off })
/** 落盘 → 切走 → 切回(整实例按 key 重挂,initial = 盘上那份),返回重开后的结构(enter-semantics cycle() 同法)。 */
async function reopenShape(page) {
  await page.evaluate(() => window.__upage.probe.flush?.())
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__upage.switchFile('Other.md', '# 别处\n'))
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__upage.switchFile('Unified.md'))
  await page.waitForTimeout(900)
  return shape(page)
}
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

    // ── K-02:整块选中(NodeSelection)后打字不再把整块换掉。──
    if (want('K02')) {
      const cases = [
        // [名, 种子, 光标所在 {type,nth,atStart}, 选块按键, 期望块选中的节点, 打的字, 期望结构]
        // 代码块/表格的块选中入口:块尾 Delete / 行首退格(K-09 起 ↑↓ 直接进块内,不再整块选中)。
        ['块尾 Delete 撞代码块', '上段。\n\n```js\nline1\n```\n\n下段。\n', { type: 'paragraph' }, 'Delete', 'code_block', 'kk',
          'paragraph:"上段。" / code_block:"line1kk" / paragraph:"下段。"'],
        ['行首退格撞代码块', '上段。\n\n```js\nline1\n```\n\n下段。\n', { type: 'paragraph', nth: 1, atStart: true }, 'Backspace', 'code_block', 'k',
          'paragraph:"上段。" / code_block:"line1k" / paragraph:"下段。"'],
        ['块尾 Delete 撞表格', '上段。\n\n| a | b |\n| --- | --- |\n| c | d |\n\n下段。\n', { type: 'paragraph' }, 'Delete', 'table', 'k', null],
        ['↓ 撞嵌入', '上段。\n\n![[Embedded]]\n\n下段。\n', { type: 'paragraph' }, 'ArrowDown', 'paragraph', 'k',
          'paragraph:"上段。" / paragraph:"![[Embedded]]" / paragraph:"k" / paragraph:"下段。"'],
        ['Esc 选段', '甲段很长的一段内容。\n\n乙段。\n', { type: 'paragraph' }, 'Escape', 'paragraph', 'k',
          'paragraph:"甲段很长的一段内容。k" / paragraph:"乙段。"'],
        ['Esc 选标题', '## 标题\n\n乙段。\n', { type: 'heading' }, 'Escape', 'heading', 'k',
          'heading2:"标题k" / paragraph:"乙段。"'],
      ]
      for (const [name, md, at, key, selNode, typed, expect] of cases) {
        const page = await open(browser, md)
        await caretIn(page, at.type, at)
        await page.keyboard.press(key)
        await page.waitForTimeout(120)
        const s0 = await selInfo(page)
        await page.keyboard.type(typed)
        await page.waitForTimeout(1300)
        const s = await shape(page)
        const ok = expect ? s === expect : /table/.test(s) && s.includes(`"a${typed}"`) && s.includes('paragraph:"上段。"') && s.includes('paragraph:"下段。"')
        check(`K02 ${name} → 块选中后打字:原块仍在,字落进合理位置`, s0.json === 'node' && s0.node === selNode && ok, `sel=${s0.json}:${s0.node} | ${s}`)
        await page.close()
      }
      // 文末 `---` 生成分割线(输入规则把 hr 设成块选中)后接着打字 = 在 hr 之后起新段。
      for (const rule of ['---', '*** ']) {
        const page = await open(browser, '前段。\n')
        await caretIn(page, 'paragraph')
        await page.keyboard.press('Enter')
        await page.keyboard.type(rule)
        await page.waitForTimeout(120)
        const s0 = await selInfo(page)
        await page.keyboard.type('X')
        await page.waitForTimeout(1300)
        const s = await shape(page)
        check(`K02 文末 ${JSON.stringify(rule)} 生成分割线后打字:hr 仍在,字落在其后新段`, s === 'paragraph:"前段。" / hr / paragraph:"X"', `sel=${s0.json}:${s0.node} | ${s} | ${JSON.stringify(await lastWrite(page))}`)
        await page.close()
      }
      // 不经 keydown 的插字(全角标点直出/表情面板/听写)与输入法组字:CDP 起真事件。
      for (const [name, act] of [
        ['insertText 全角标点', async (cdp) => { await cdp.send('Input.insertText', { text: '，' }) }],
        ['输入法组字提交', async (cdp) => {
          await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
          await new Promise((r) => setTimeout(r, 80))
          await cdp.send('Input.insertText', { text: '你' })
        }],
      ]) {
        const page = await open(browser, '上段。\n\n```js\nline1\n```\n\n下段。\n')
        const cdp = await page.context().newCDPSession(page)
        await caretIn(page, 'paragraph')
        await page.keyboard.press('Delete')
        await page.waitForTimeout(120)
        const s0 = await selInfo(page)
        await act(cdp)
        await page.waitForTimeout(1300)
        const s = await shape(page)
        check(`K02 块选中代码块后 ${name}:代码块仍在,字进块尾,下一块不被拼进来`, s0.json === 'node' && /^paragraph:"上段。" \/ code_block:"line1(，|你)" \/ paragraph:"下段。"$/.test(s), `sel=${s0.json}:${s0.node} | ${s}`)
        await page.close()
      }
    }

    // ── R-04:空代码块里打完首个关键字,光标不再跳回块首(五种语言)。──
    if (want('R04')) {
      const codeText = (page) => page.evaluate(() => {
        let t = null
        window.__upage.probe.view().state.doc.descendants((n) => { if (n.type.name === 'code_block') t = n.textContent })
        return t
      })
      for (const [lang, typed] of [['js', 'const a = (1)'], ['python', 'def main():'], ['sql', 'SELECT 1'], ['python', 'import os'], ['bash', 'echo hi']]) {
        const page = await open(browser, '段一\n\n```' + lang + '\n\n```\n')
        await caretIn(page, 'code_block', { atStart: true })
        const kw = typed.split(' ')[0]
        await page.keyboard.type(kw, { delay: 40 })
        await page.waitForTimeout(120)
        // 机理:关键字被高亮包进 span 之后,DOM 光标必须仍在文本节点里,而不是 <code> 的元素边界上。
        const mech = await page.evaluate((PM) => {
          const code = document.querySelector(PM + ' pre code')
          const s = getSelection()
          return { token: !!code.querySelector('[class^="hljs-"]'), anchorIsText: s.anchorNode && s.anchorNode.nodeType === 3, nonContent: [...code.children].filter((c) => !/^hljs-/.test(c.className) && c.tagName !== 'BR').length }
        }, PM)
        await page.keyboard.type(typed.slice(kw.length), { delay: 40 })
        await page.waitForTimeout(150)
        const got = await codeText(page)
        check(`R04 \`\`\`${lang} 首行打 ${JSON.stringify(typed)} 不乱序`, got === typed && mech.token && mech.anchorIsText && mech.nonContent === 0, `got=${JSON.stringify(got)} ${JSON.stringify(mech)}`)
        await page.close()
      }
      // 真实入口:键盘敲 ```js + 回车起代码块,接着打字。
      {
        const page = await open(browser, '段一\n')
        await caretIn(page, 'paragraph')
        await page.keyboard.press('Enter')
        await page.keyboard.type('```js', { delay: 30 })
        await page.keyboard.press('Enter')
        await page.waitForTimeout(150)
        await page.keyboard.type('const a = (1)', { delay: 40 })
        await page.waitForTimeout(1300)
        const got = await codeText(page)
        check('R04 键盘 ```js⏎ 新建后打 "const a = (1)" 不乱序,落盘一致', got === 'const a = (1)' && /```js\nconst a = \(1\)\n```/.test(await lastWrite(page) || ''), `got=${JSON.stringify(got)} saved=${JSON.stringify(await lastWrite(page))}`)
        await page.close()
      }
      // NodeView 工具条仍可用:改语言写回 fence info、行号栏与代码行对齐。
      {
        const page = await open(browser, '段一\n\n```js\nconst a = 1\nlet b = 2\n```\n')
        await page.hover(PM + ' pre')
        await page.waitForTimeout(200)
        await page.selectOption(PM + ' .amx-code-tools select.amx-code-lang', 'python')
        await page.waitForTimeout(1300)
        const saved = await lastWrite(page)
        const toolsOutsideCode = await page.evaluate((PM) => !document.querySelector(PM + ' pre code .amx-code-tools') && !!document.querySelector(PM + ' pre > .amx-code-tools'), PM)
        check('R04 工具条在 <code> 之外,改语言写回 fence info', toolsOutsideCode && /```python\nconst a = 1\nlet b = 2\n```/.test(saved || ''), JSON.stringify({ toolsOutsideCode, saved }))
        await page.evaluate(() => [...document.querySelectorAll('.amx-code-tools .amx-code-btn')].find((x) => /行号|Numbers/.test(x.textContent)).click())
        await page.waitForTimeout(200)
        const geo = await page.evaluate((PM) => {
          const pre = document.querySelector(PM + ' pre')
          const nums = pre.querySelector('.amx-code-nums')
          const code = pre.querySelector('code')
          const n = document.createRange(); n.selectNodeContents(nums)
          const c = document.createRange(); c.selectNodeContents(code)
          const nr = n.getClientRects(), cr = c.getClientRects()
          return { text: nums.textContent, dy: Math.abs(nr[0].top - cr[0].top), outside: !code.contains(nums) }
        }, PM)
        check('R04 行号栏在 <code> 之外、首行与代码首行对齐', geo.text === '1\n2' && geo.outside && geo.dy <= 2, JSON.stringify(geo))
        await page.close()
      }
    }

    // ── B-12:Mod+D 复制块(光标 / Esc 块选 / ⠿ 选中 / 跨块选区四种),与 ⠿ 菜单「复制块」同一份;
    //    拍板 #8:Ctrl+D 各平台都作复制块(非 mac 上 Ctrl 即 Mod),向前删除只留在 mac。──
    if (want('B12')) {
      /** 光标放到文字恰为 text 的文本块里第 off 个字符处(off 省略 = 末尾),再等一帧。 */
      const placeAt = async (page, text, off) => {
        await page.evaluate(({ text, off }) => {
          const v = window.__upage.probe.view()
          let at = null
          v.state.doc.descendants((n, p) => {
            if (at != null) return false
            if (n.isTextblock && n.textContent === text) { at = p + 1 + (off ?? n.content.size); return false }
            return true
          })
          v.focus()
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
        }, { text, off })
        await page.waitForTimeout(120)
      }
      /** 选区落在第几个顶层块(列表则再报第几项)+ 块内偏移。 */
      const where = (page) => page.evaluate(() => {
        const s = window.__upage.probe.view().state.selection
        const $f = s.$from
        const node = s.node ? s.node.type.name : null
        return { type: s.toJSON().type, node, top: $f.index(0), item: $f.depth >= 2 ? $f.index(1) : null, off: s.node ? null : $f.parentOffset }
      })
      const SEED = '段甲。\n\n段乙。\n\n- 项一\n- 项二\n\n段丙。\n'
      const page = await open(browser, SEED)
      // ① 光标态:复制光标所在段,光标跟到副本同一偏移。
      await placeAt(page, '段乙。', 1)
      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(1300)
      let s = await shape(page)
      let w = await where(page)
      check('B12 光标态 Mod+D:复制所在段,光标进副本同一偏移并落盘',
        s === 'paragraph:"段甲。" / paragraph:"段乙。" / paragraph:"段乙。" / bullet_list /   list_item /     paragraph:"项一" /   list_item /     paragraph:"项二" / paragraph:"段丙。"'
          && w.top === 2 && w.off === 1 && /段乙。\n\n段乙。/.test(await lastWrite(page) || ''), `${s} | ${JSON.stringify(w)}`)
      // ② 列表项里:只复制这一项,留在同一只列表里。
      await placeAt(page, '项一')
      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(150)
      s = await shape(page)
      w = await where(page)
      check('B12 列表项里 Mod+D:同一列表里复制该项', /bullet_list \/   list_item \/     paragraph:"项一" \/   list_item \/     paragraph:"项一" \/   list_item \/     paragraph:"项二"/.test(s) && w.item === 1, `${s} | ${JSON.stringify(w)}`)
      // ③ Esc 块选中:复制该块,副本成为新的块选中。
      await placeAt(page, '段甲。')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(120)
      const w0 = await where(page)
      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(150)
      s = await shape(page)
      w = await where(page)
      check('B12 Esc 块选 Mod+D:复制该块,选中跟到副本', w0.type === 'node' && s.startsWith('paragraph:"段甲。" / paragraph:"段甲。" / paragraph:"段乙。"') && w.type === 'node' && w.top === 1,
        `${s} | before=${JSON.stringify(w0)} after=${JSON.stringify(w)}`)
      // ④ ⠿ 选中:点把手(开菜单 + 块选中)→ Esc 关菜单 → Mod+D。
      const r = await page.evaluate((PM) => {
        const el = [...document.querySelectorAll(PM + ' > p')].find((e) => e.textContent === '段丙。')
        const b = el.getBoundingClientRect()
        return { x: b.left + 20, y: b.top + b.height / 2 }
      }, PM)
      await page.mouse.move(r.x, r.y, { steps: 4 })
      await page.waitForTimeout(300)
      const h = await page.evaluate(() => {
        const g = document.querySelector('.unified-gutter')
        const el = g && g.querySelector('.drag-handle')
        if (!el || g.dataset.show !== 'true') return null
        const b = el.getBoundingClientRect()
        return { x: b.x + b.width / 2, y: b.y + Math.min(10, b.height / 2) }
      })
      if (h) {
        await page.mouse.click(h.x, h.y)
        await page.waitForTimeout(250)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
      const wh = await where(page)
      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(150)
      s = await shape(page)
      check('B12 ⠿ 选中 Mod+D:复制该块', !!h && wh.type === 'node' && s.endsWith('paragraph:"段丙。" / paragraph:"段丙。"'), `${s} | handle=${JSON.stringify(h)} sel=${JSON.stringify(wh)}`)
      await page.close()
      // ⑤ 跨块选区:整批复制到范围之后(与 ⠿ 菜单 M3 同一判定)。
      {
        const pg = await open(browser, '段甲。\n\n段乙。\n\n段丙。\n')
        await pg.evaluate(() => {
          const v = window.__upage.probe.view()
          v.focus()
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 2, 7)))
        })
        await pg.waitForTimeout(120)
        await pg.keyboard.press('Meta+d')
        await pg.waitForTimeout(150)
        const t = await pg.evaluate((PM) => [...document.querySelectorAll(PM + ' > p')].map((e) => e.textContent).join('|'), PM)
        check('B12 跨块选区 Mod+D:整批复制到范围之后', t === '段甲。|段乙。|段甲。|段乙。|段丙。', t)
        await pg.close()
      }
      // ⑥ mac 上 Ctrl+D 仍是向前删除那一支(块尾撞代码块 = 选中不吞),不复制。
      const DEL_SEED = '前段。\n\n```js\ncode\n```\n'
      {
        const pg = await open(browser, DEL_SEED)
        await placeAt(pg, '前段。')
        await pg.keyboard.press('Control+d')
        await pg.waitForTimeout(150)
        const st = await selInfo(pg)
        const t = await shape(pg)
        check('B12 mac:Ctrl+D 仍是向前删除(块尾撞代码块 = 选中),不复制', st.node === 'code_block' && t === 'paragraph:"前段。" / code_block:"code"', `${t} | ${JSON.stringify(st)}`)
        await pg.close()
      }
      // ⑦ 非 mac(navigator.platform=Win32,prosemirror-keymap 据此把 Mod 解成 Ctrl):Ctrl+D = 复制块。
      {
        const pg = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
        await pg.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }))
        pg.on('pageerror', (e) => console.log('  [pageerror]', e.message))
        await pg.goto(`${URL}?upage&useed=${encodeURIComponent(DEL_SEED)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
        await pg.waitForSelector(PM, { timeout: 120000 })
        await pg.waitForTimeout(400)
        await placeAt(pg, '前段。')
        await pg.keyboard.press('Control+d')
        await pg.waitForTimeout(150)
        const t = await shape(pg)
        check('B12 Windows:Ctrl+D = 复制块,不再是向前删除', t === 'paragraph:"前段。" / paragraph:"前段。" / code_block:"code"', t)
        await pg.close()
      }
    }

    // ── B-13:折叠的键盘入口(引擎命令 + 缺省热键 mod+alt+enter)与本机记忆(拍板 #4:不写 md)。
    //    `&ucmds` = 台架按生产装上 FOLD_COMMANDS + 引擎全局热键分发(amadeusCommands 在台架里不跑)。──
    if (want('B13')) {
      const SEED = '# 甲\n\n段一。\n\n## 乙\n\n段二。\n\n- 父项\n    - 子项\n\n尾段。\n'
      const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
      const openIn = async (md) => {
        const pg = await ctx.newPage()
        pg.on('pageerror', (e) => console.log('  [pageerror]', e.message))
        await pg.goto(`${URL}?upage&ucmds&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
        await pg.waitForSelector(PM, { timeout: 120000 })
        await pg.waitForFunction(() => Array.isArray(window.__upage.foldCommands), null, { timeout: 30000 })
        await pg.waitForTimeout(400)
        return pg
      }
      /** 被藏起来的文本块(display:none 祖先)的文字,按文档序。 */
      const hidden = (pg) => pg.evaluate((PM) => [...document.querySelectorAll(PM + ' p, ' + PM + ' h1, ' + PM + ' h2')]
        .filter((e) => e.offsetParent === null).map((e) => e.textContent.replace('▸', '')).join('|'), PM)
      const placeAt = async (pg, text) => {
        await pg.evaluate((text) => {
          const v = window.__upage.probe.view()
          let at = null
          v.state.doc.descendants((n, p) => {
            if (at != null) return false
            if (n.isTextblock && n.textContent === text) { at = p + 1 + Math.min(1, n.content.size); return false }
            return true
          })
          v.focus()
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
        }, text)
        await pg.waitForTimeout(120)
      }
      const caretText = (pg) => pg.evaluate(() => window.__upage.probe.view().state.selection.$from.parent.textContent)
      const runCmd = (pg, id) => pg.evaluate((id) => window.__upage.foldCommands.find((c) => c.id === id).run(), id)
      const pg = await openIn(SEED)
      const meta = await pg.evaluate(() => window.__upage.foldCommands.map((c) => `${c.id}=${typeof c.title === 'function' ? c.title() : 'STATIC'}@${c.hotkey || ''}`).join(' '))
      check('B13 三条命令注册(title 渲染期求值);切换折叠缺省 mod+alt+enter',
        meta === 'amadeus-fold-toggle=切换折叠@mod+alt+enter amadeus-fold-all=全部折叠@ amadeus-unfold-all=全部展开@', meta)
      const w0 = await pg.evaluate(() => window.__upage.writes.length)
      // ① 标题上热键:折 / 再按展开
      await placeAt(pg, '乙')
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      const h1 = await hidden(pg)
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      const h1b = await hidden(pg)
      check('B13 标题上 ⌘⌥↵ 折叠小节,再按展开', h1 === '段二。|父项|子项|尾段。' && h1b === '', `${h1} → ${JSON.stringify(h1b)}`)
      // ② 正文里:收起所在小节,光标停在该小节标题末尾(看得见)
      await placeAt(pg, '段一。')
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      const h2 = await hidden(pg)
      const c2 = await caretText(pg)
      check('B13 正文里 ⌘⌥↵ 收起所在小节,光标回到标题', h2 === '段一。|乙|段二。|父项|子项|尾段。' && c2 === '甲', `${h2} caret=${c2}`)
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      // ③ 列表项:只收子项
      await placeAt(pg, '父项')
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      const h3 = await hidden(pg)
      check('B13 有子项的列表项上 ⌘⌥↵ 收起子项', h3 === '子项', h3)
      // ④ 焦点不在正文(面板输入框抢走):热键走引擎全局分发、命令面板直调 run(),都作用在最近聚焦的那篇
      await pg.evaluate(() => { const i = document.createElement('input'); i.id = 'steal'; document.body.appendChild(i); i.focus() })
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(150)
      const h4 = await hidden(pg)
      check('B13 焦点不在正文时 ⌘⌥↵ 经引擎热键作用在最近那篇(展开刚折的列表项)', h4 === '', JSON.stringify(h4))
      await pg.evaluate(() => document.getElementById('steal').focus())
      await runCmd(pg, 'amadeus-unfold-all')
      await pg.waitForTimeout(150)
      const h4a = await hidden(pg)
      await pg.evaluate(() => document.getElementById('steal').focus())
      await runCmd(pg, 'amadeus-fold-all')
      await pg.waitForTimeout(150)
      const h4b = await hidden(pg)
      check('B13 命令面板:全部展开 / 全部折叠(焦点不在编辑器也作用在最近那篇)', h4a === '' && h4b === '段一。|乙|段二。|父项|子项|尾段。', `${JSON.stringify(h4a)} → ${h4b}`)
      await runCmd(pg, 'amadeus-unfold-all')
      await pg.waitForTimeout(150)
      // ⑤ 折叠只是视图态:整段操作零写盘
      await pg.waitForTimeout(1200)
      const w1 = await pg.evaluate(() => window.__upage.writes.length)
      check('B13 折叠 / 展开不写 md(零写盘)', w1 === w0, `writes ${w0} → ${w1}`)
      // ⑥ 本机记忆:折「乙」与「父项」→ 切源码再切回 / 切走再切回 / 整页重开,都复原
      await placeAt(pg, '父项')
      await pg.keyboard.press('Meta+Alt+Enter')
      await placeAt(pg, '乙')
      await pg.keyboard.press('Meta+Alt+Enter')
      await pg.waitForTimeout(600)
      const want6 = '段二。|父项|子项|尾段。'
      const before6 = await hidden(pg)
      await pg.evaluate(() => window.__upage.setEditorMode('source'))
      await pg.waitForTimeout(600)
      await pg.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
      await pg.waitForSelector(PM)
      await pg.waitForTimeout(700)
      const src6 = await hidden(pg)
      await pg.evaluate(() => window.__upage.switchFile('Other.md', '别的。\n'))
      await pg.waitForTimeout(800)
      await pg.evaluate(() => window.__upage.switchFile('Unified.md'))
      await pg.waitForTimeout(900)
      const sw6 = await hidden(pg)
      await pg.close()
      const pg2 = await openIn(SEED)
      await pg2.waitForTimeout(300)
      const re6 = await hidden(pg2)
      check('B13 折叠记在本机:切源码回来 / 切走再回 / 整页重开都复原', before6 === want6 && src6 === want6 && sw6 === want6 && re6 === want6,
        JSON.stringify({ before6, src6, sw6, re6 }))
      await pg2.close()
      // ⑦ 指纹对不上(外部把「乙」改名)就不折,宁少勿错
      const pg3 = await openIn(SEED.replace('## 乙', '## 丙'))
      const h7 = await hidden(pg3)
      check('B13 标题被外部改名 → 该处记忆作废、不误折别处;列表项记忆照旧', h7 === '子项', h7)
      await pg3.close()
      await ctx.close()
    }

    // ── 波次 2 keys 包 ──────────────────────────────────────────────────────────────
    // K-07:已勾选待办上回车,新项一律未勾选(行尾 / 行中 / 嵌套);行首回车时文字随光标下移,
    //       已完成的那条仍勾着,上面空出的新项不勾。
    if (want('K07')) {
      for (const [name, md, text, off, expect, disk] of [
        ['行尾', '- [x] 已完成\n- [ ] 未完成\n', '已完成', null,
          'bullet_list / list_item[x] / paragraph:"已完成" / list_item[ ] / paragraph:"X" / list_item[ ] / paragraph:"未完成"',
          /^- \[x\] 已完成\n- \[ \] X\n- \[ \] 未完成\n$/],
        ['行中拆分', '- [x] 甲乙\n', '甲乙', 1, 'bullet_list / list_item[x] / paragraph:"甲" / list_item[ ] / paragraph:"X乙"',
          /^- \[x\] 甲\n- \[ \] X乙\n$/],
        ['嵌套项行尾', '- [ ] 父\n    - [x] 子已完成\n', '子已完成', null,
          'bullet_list / list_item[ ] / paragraph:"父" / bullet_list / list_item[x] / paragraph:"子已完成" / list_item[ ] / paragraph:"X"',
          /^- \[ \] 父\n {2}- \[x\] 子已完成\n {2}- \[ \] X\n$/],
        // 行首回车 = 上方新空项(enter-semantics B1),光标随文字留在原项;已完成的内容仍勾着。
        // 同时钉住「紧接着打的字落在原项」—— Chrome 在光标节点前插兄弟后会把字插进上面的空项(见 enterTaskItem)。
        ['行首', '- [x] 甲乙\n', '甲乙', 0, 'bullet_list / list_item[ ] / paragraph:"" / list_item[x] / paragraph:"X甲乙"',
          /^- \[ \][^\n]*\n- \[x\] X甲乙\n$/],
        ['未勾选对照', '- [ ] 未完\n', '未完', null, 'bullet_list / list_item[ ] / paragraph:"未完" / list_item[ ] / paragraph:"X"',
          /^- \[ \] 未完\n- \[ \] X\n$/],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, text, off)
        await page.waitForTimeout(120)
        await page.keyboard.press('Enter')
        await page.keyboard.type('X')
        await page.waitForTimeout(1300)
        const s = (await shape(page)).replace(/ \/ +/g, ' / ')
        const w = await lastWrite(page)
        check(`K07 已勾选待办${name}回车:新项未勾选`, s === expect && disk.test(w || ''), `${s} | ${JSON.stringify(w)}`)
        await page.close()
      }
    }

    // K-09:↑/↓ 纵向直接进代码块、表格(首行/首格或末行/末格,保持列位置);分割线与嵌入仍整块选中。
    if (want('K09')) {
      const CODE = '上段文字很长一些。\n\n```js\nline1 abc\nline2 def\n```\n\n下段文字。\n'
      const TABLE = '上段文字很长一些。\n\n| a | b |\n| --- | --- |\n| c | d |\n\n下段文字。\n'
      for (const [name, md, at, key, want09] of [
        ['↓ 进代码块首行且保持列', CODE, { text: '上段文字很长一些。', off: 2 }, 'ArrowDown', (s) => s.json === 'text' && s.parent === 'code_block' && s.col === 2 && s.line === 0],
        ['↑ 进代码块末行', CODE, { text: '下段文字。', off: 2 }, 'ArrowUp', (s) => s.json === 'text' && s.parent === 'code_block' && s.line === 1],
        ['↓ 进表格首格', TABLE, { text: '上段文字很长一些。', off: 1 }, 'ArrowDown', (s) => s.json === 'text' && s.cell === 'a'],
        ['↑ 进表格末行', TABLE, { text: '下段文字。', off: 1 }, 'ArrowUp', (s) => s.json === 'text' && (s.cell === 'c' || s.cell === 'd')],
        ['↓ 撞分割线仍整块选中', '上段。\n\n***\n\n下段。\n', { text: '上段。', off: 1 }, 'ArrowDown', (s) => s.json === 'node' && /^(hr|horizontal_rule)$/.test(s.node)],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, at.text, at.off)
        await page.waitForTimeout(150)
        await page.keyboard.press(key)
        await page.waitForTimeout(200)
        const s = await page.evaluate(() => {
          const sel = window.__upage.probe.view().state.selection
          const $f = sel.$from
          let cell = null
          for (let d = $f.depth; d > 0; d--) if (/^table_(cell|header)$/.test($f.node(d).type.name)) { cell = $f.node(d).textContent; break }
          const before = $f.parent.textContent.slice(0, $f.parentOffset)
          return { json: sel.toJSON().type, node: sel.node ? sel.node.type.name : null, parent: $f.parent.type.name, cell,
            line: before.split('\n').length - 1, col: before.length - before.lastIndexOf('\n') - 1 }
        })
        const doc = await shape(page)
        check(`K09 ${name}`, want09(s) && doc === (await shape(page)), JSON.stringify(s))
        await page.close()
      }
    }

    // K-08:结构前缀 input 不再是键盘陷阱 —— 第 0 位 ←/退格、任意位置 ↑/↓ 都能离开。
    if (want('K08')) {
      const where = (page) => page.evaluate(() => {
        const a = document.activeElement
        const s = window.__upage.probe.view().state.selection
        return a && a.classList.contains('amx-struct-prefix') ? `INPUT@${a.selectionStart}` : `PM ${s.$from.parent.type.name}:${s.$from.parent.textContent}@${s.$from.parentOffset}`
      })
      for (const [kind, line, text, bsExpect] of [
        ['标题', '## 标题', '标题', 'paragraph:"前段。" / paragraph:"标题" / paragraph:"后段。"'],
        ['列表', '- 列表项', '列表项', 'paragraph:"前段。" / paragraph:"列表项" / paragraph:"后段。"'],
        ['待办', '- [ ] 待办', '待办', 'paragraph:"前段。" / paragraph:"待办" / paragraph:"后段。"'],
        ['引用', '> 引用', '引用', null],
      ]) {
        const md = `前段。\n\n${line}\n\n后段。\n`
        const got = {}
        for (const [label, keys] of [['←', ['ArrowLeft', 'Meta+ArrowLeft', 'ArrowLeft']], ['↑', ['ArrowLeft', 'ArrowUp']], ['↓', ['ArrowLeft', 'Meta+ArrowLeft', 'ArrowDown']], ['退格', ['ArrowLeft', 'Meta+ArrowLeft', 'Backspace']]]) {
          const page = await open(browser, md)
          await caretAtText(page, text, 0)
          await page.waitForTimeout(150)
          const trail = []
          for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(90); trail.push(await where(page)) }
          got[label] = { trail, doc: await shape(page) }
          await page.close()
        }
        const inPrefix = (t) => t.startsWith('INPUT')
        check(`K08 ${kind}前缀第 0 位 ← 回到上一段末`, inPrefix(got['←'].trail[1]) && got['←'].trail[2] === 'PM paragraph:前段。@3', JSON.stringify(got['←'].trail))
        check(`K08 ${kind}前缀里 ↑ 回到上一段`, inPrefix(got['↑'].trail[0]) && got['↑'].trail[1].startsWith('PM paragraph:前段。@'), JSON.stringify(got['↑'].trail))
        check(`K08 ${kind}前缀里 ↓ 去下一段行首`, got['↓'].trail[2] === 'PM paragraph:后段。@0', JSON.stringify(got['↓'].trail))
        if (bsExpect) check(`K08 ${kind}前缀第 0 位退格 = 一步转正文(不困在 input)`, got['退格'].doc === bsExpect && !inPrefix(got['退格'].trail[2]), `${got['退格'].doc} | ${JSON.stringify(got['退格'].trail)}`)
        else check(`K08 ${kind}前缀第 0 位退格离开 input`, !inPrefix(got['退格'].trail[2]), `${got['退格'].doc} | ${JSON.stringify(got['退格'].trail)}`)
      }
    }

    // K-12 / K-12d(拍板 #5:不回退 K11,只修可逆性):callout / 引用首段行首退格得到字面 `>…`(K11 钉住),
    // 补回空格 = 按引用处理并与紧邻的 blockquote 合回一只 —— 回到原样,盘上逐字不变。空行 `> ` 仍是折叠。
    if (want('K12')) {
      const bqInfo = (page) => page.evaluate((PM) => [...document.querySelectorAll(PM + ' > blockquote')].map((b) => b.className || '(plain)').join(','), PM)
      for (const [name, md, text, expect, cls] of [
        ['callout 首段', '前段。\n\n> [!note] 标题\n>\n> 内容\n\n丙段。\n', '[!note] 标题',
          'paragraph:"前段。" / blockquote / paragraph:"[!note] 标题" / paragraph:"内容" / paragraph:"丙段。"', /callout-note/],
        ['两段普通引用首段(K-12d)', '前段。\n\n> 甲\n>\n> 乙\n\n丙段。\n', '甲',
          'paragraph:"前段。" / blockquote / paragraph:"甲" / paragraph:"乙" / paragraph:"丙段。"', /^\(plain\)$/],
        ['两段普通引用次段', '前段。\n\n> 甲\n>\n> 乙\n\n丙段。\n', '乙',
          'paragraph:"前段。" / blockquote / paragraph:"甲" / paragraph:"乙" / paragraph:"丙段。"', /^\(plain\)$/],
        ['单段普通引用(K-12d)', '前段。\n\n> 引用甲\n\n丙段。\n', '引用甲',
          'paragraph:"前段。" / blockquote / paragraph:"引用甲" / paragraph:"丙段。"', /^\(plain\)$/],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, text, 0)
        await page.waitForTimeout(150)
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(150)
        const lit = (await shape(page)).replace(/ \/ +/g, ' / ')
        await page.keyboard.type(' ')
        await page.waitForTimeout(1300)
        const s = (await shape(page)).replace(/ \/ +/g, ' / ')
        const c = await bqInfo(page)
        await page.evaluate(() => window.__upage.probe.flush?.())
        await page.waitForTimeout(300)
        const disk = await page.evaluate(() => window.__upage.vault.get('Unified.md'))
        check(`K12 ${name}:行首退格字面化后补空格 = 原样合回`, lit.includes(`paragraph:">${text}"`) && s === expect && cls.test(c) && disk === md,
          `${lit} → ${s} | bq=${c} | disk=${JSON.stringify(disk)}`)
        await page.close()
      }
      // 07-29 键位不变:空行敲 `> ` 仍是折叠块。
      const page = await open(browser, '前段。\n')
      await caretAtText(page, '前段。')
      await page.keyboard.press('Enter')
      await typeSeq(page, '> X')
      await page.waitForTimeout(300)
      const s = await shape(page)
      check('K12 空行 `> ` 仍是折叠(07-29 键位)', /blockquote \/ +paragraph:"\[!fold\]-X"/.test(s), s)
      await page.close()
    }

    // K-13:按 Obsidian 习惯逐字敲 `> [!note] 标题` 得到 note callout,不是 `[!fold]-\[!note] 标题`。
    if (want('K13')) {
      for (const [name, typed, expect, disk, viaCdp] of [
        ['`> [!note] 标题`', '> [!note] 标题', 'paragraph:"[!note] 标题"', '> [!note] 标题\n', false],
        ['`> [!note]- 标题`(收起)', '> [!note]- 标题', 'paragraph:"[!note]- 标题"', '> [!note]- 标题\n', false],
        ['输入法逐字提交 `> [!tip] 甲`', '> [!tip] 甲', 'paragraph:"[!tip] 甲"', '> [!tip] 甲\n', true],
        ['`> 标题` 对照(仍是折叠)', '> 标题', 'paragraph:"[!fold]-标题"', '> [!fold]-标题\n', false],
      ]) {
        const page = await open(browser, '前段。\n')
        const cdp = viaCdp ? await page.context().newCDPSession(page) : null
        await caretAtText(page, '前段。')
        await page.keyboard.press('Enter')
        for (const ch of typed) {
          if (cdp && ch !== ' ' && ch !== '>') await cdp.send('Input.insertText', { text: ch })
          else await page.keyboard.type(ch)
          await page.waitForTimeout(40)
        }
        await page.waitForTimeout(1300)
        const s = (await shape(page)).replace(/ \/ +/g, ' / ')
        const w = await lastWrite(page)
        check(`K13 ${name}`, s === `paragraph:"前段。" / blockquote / ${expect}` && w === `前段。\n\n${disk}`, `${s} | ${JSON.stringify(w)}`)
        await page.close()
      }
    }

    // K-14:中文输入法直出的全角标点(逐字 insertText,不经组字)整行恰好是触发符时,空格 / 回车照样触发。
    if (want('K14')) {
      for (const [chars, key, expect] of [
        [['【', '】'], ' ', /^paragraph:"前段。" \/ bullet_list \/ +list_item\[ \] \/ +paragraph:"X"$/],
        [['＃', '＃'], ' ', /^paragraph:"前段。" \/ heading2:"X"$/],
        [['1', '。'], ' ', /^paragraph:"前段。" \/ ordered_list \/ +list_item \/ +paragraph:"X"$/],
        [['·', '·', '·'], 'Enter', /^paragraph:"前段。" \/ code_block:"X"$/],
        [['、'], ' ', /^paragraph:"前段。" \/ paragraph:"、 X"$/], // 顿号不映射(对照)
      ]) {
        const page = await open(browser, '前段。\n')
        const cdp = await page.context().newCDPSession(page)
        await caretAtText(page, '前段。')
        await page.keyboard.press('Enter')
        for (const ch of chars) await cdp.send('Input.insertText', { text: ch })
        await page.waitForTimeout(60)
        await page.keyboard.press(key === ' ' ? 'Space' : key)
        await page.keyboard.type('X')
        await page.waitForTimeout(200)
        const s = await shape(page)
        check(`K14 全角 ${JSON.stringify(chars.join(''))} + ${key === ' ' ? '空格' : '回车'}`, expect.test(s), s)
        await page.close()
      }
    }

    // K-20:空的待办 / 编号 / 列表 / 标题 / 引用,退格一下就脱壳成正文,第二下与上一块合并(Notion 同)。
    //       非空块仍是 T28 的字面还原(对照)。
    if (want('K20')) {
      for (const [name, md, typed, one] of [
        ['空列表项', '- 甲\n', '\n', 'bullet_list / list_item / paragraph:"甲" / paragraph:""'],
        ['空待办', '- [ ] 甲\n', '\n', 'bullet_list / list_item[ ] / paragraph:"甲" / paragraph:""'],
        ['空编号', '1. 甲\n', '\n', 'ordered_list / list_item / paragraph:"甲" / paragraph:""'],
        ['空 H2', '甲\n', '\n## ', 'paragraph:"甲" / paragraph:""'],
        ['空引用', '甲\n', '\n| ', 'paragraph:"甲" / paragraph:""'],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, '甲')
        await typeSeq(page, typed)
        await page.waitForTimeout(150)
        const s0 = (await shape(page)).replace(/ \/ +/g, ' / ')
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(150)
        const s1 = (await shape(page)).replace(/ \/ +/g, ' / ')
        const a1 = await page.evaluate(() => document.activeElement?.classList.contains('amx-struct-prefix'))
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(150)
        const s2 = (await shape(page)).replace(/ \/ +/g, ' / ')
        check(`K20 ${name}:退格一下转正文、两下并回上一块`, s1 === one && !a1 && s2 === one.replace(/ \/ paragraph:""$/, ''), `${s0} → ${s1} → ${s2}`)
        await page.close()
      }
      const page = await open(browser, '前段。\n\n- 乙项\n')
      await caretAtText(page, '乙项', 0)
      await page.waitForTimeout(150)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(150)
      const s = await shape(page)
      check('K20 非空列表项行首退格仍是字面还原(T28 对照)', s === 'paragraph:"前段。" / paragraph:"-乙项"', s)
      await page.close()
    }

    // K-20b:段落里的字面 `- ` / `1. ` 等(删字符删出来的)落盘必须转义,重开仍是段落,不变成空列表。
    //        根因在 milkdown 的 text handler(以空白结尾的文本整段跳过转义),修在 textSafe.ts。
    if (want('K20b')) {
      for (const [name, md, text, want20b] of [
        ['`\\- ab` 退两格', '甲段。\n\n\\- ab\n', '- ab', /^paragraph:"甲段。" \/ paragraph:"-"$/],
        ['`1\\. ab` 退两格', '甲段。\n\n1\\. ab\n', '1. ab', /^paragraph:"甲段。" \/ paragraph:"1\."$/],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, text)
        await page.waitForTimeout(150)
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(300)
        const s0 = await shape(page)
        const s1 = await reopenShape(page)
        check(`K20b ${name}:编辑器里是段落,重开仍是段落`, /paragraph:"(-|1\.) "$/.test(s0) && want20b.test(s1), `${s0} → 重开 ${s1}`)
        await page.close()
      }
    }

    // K-21:撤销自动格式回到字面触发符(Notion 同):快打 `# ` 撤一下 = `# `、再撤 = 空行;回车入口 `#⏎` 撤一下 = `#`。
    //       撤回来的字面 `# ` 落盘后重开仍是段落(依赖 K-20b 的 textSafe)。
    if (want('K21')) {
      const last = async (page) => (await shape(page)).split(' / ').slice(1).join(' / ')
      for (const [name, typed, lit] of [['`# `', '# ', 'paragraph:"# "'], ['`- `', '- ', 'paragraph:"- "'], ['`1. `', '1. ', 'paragraph:"1. "']]) {
        const page = await open(browser, '前段。\n')
        await caretAtText(page, '前段。')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(700) // 与回车那组隔开
        await page.keyboard.type(typed)
        await page.waitForTimeout(100)
        const after = await last(page)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(150)
        const u1 = await last(page)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(150)
        const u2 = await last(page)
        check(`K21 快打 ${name} 后撤销:一下回到字面、两下回到空行`, !/^paragraph/.test(after) && u1 === lit && u2 === 'paragraph:""', `${after} → ${u1} → ${u2}`)
        await page.close()
      }
      {
        const page = await open(browser, '前段。\n')
        await caretAtText(page, '前段。')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(700)
        await page.keyboard.type('#')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(100)
        const after = await last(page)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(150)
        const u1 = await last(page)
        check('K21 回车入口 `#⏎` 后撤销一下 = 字面 `#`', after === 'heading1:""' && u1 === 'paragraph:"#"', `${after} → ${u1}`)
        await page.close()
      }
      {
        const page = await open(browser, '前段。\n')
        await caretAtText(page, '前段。')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(700)
        await page.keyboard.type('# ')
        await page.waitForTimeout(100)
        await page.keyboard.press('Meta+z')
        await page.waitForTimeout(200)
        const s = await reopenShape(page)
        check('K21 撤回来的字面 `# ` 落盘重开仍是段落', s === 'paragraph:"前段。" / paragraph:"#"', s)
        await page.close()
      }
    }

    // K-22:块尾 Delete = 把下一块的文字并到本块末尾(Notion 同),被掏空的列表项 / 引用随之消失;
    //       下一块是 callout 标题 → 整块选中不合并;同层段↔段仍走 base 的合并(对照)。
    if (want('K22')) {
      for (const [name, md, text, expect, selWant] of [
        ['段尾撞列表首项', '甲段。\n\n- 乙\n- 丙\n', '甲段。', 'paragraph:"甲段。X乙" / bullet_list / list_item / paragraph:"丙"', null],
        ['列表末项尾撞段落', '- 甲\n\n乙段。\n', '甲', 'bullet_list / list_item / paragraph:"甲X乙段。"', null],
        ['段尾撞引用', '甲段。\n\n> 乙\n', '甲段。', 'paragraph:"甲段。X乙"', null],
        ['列表项尾撞子项', '- 甲\n    - 子\n', '甲', 'bullet_list / list_item / paragraph:"甲X子"', null],
        ['段尾撞 callout 标题 = 整块选中', '甲段。\n\n> [!note] 标题\n> 内容\n', '甲段。', 'paragraph:"甲段。" / blockquote / paragraph:"[!note] 标题" / paragraph:"内容"', 'blockquote'],
        ['段↔段对照', '甲段。\n\n乙段。\n', '甲段。', 'paragraph:"甲段。X乙段。"', null],
      ]) {
        const page = await open(browser, md)
        await caretAtText(page, text)
        await page.waitForTimeout(150)
        await page.keyboard.press('Delete')
        await page.waitForTimeout(150)
        const sel = await selInfo(page)
        if (!selWant) await page.keyboard.type('X')
        await page.waitForTimeout(200)
        const s = (await shape(page)).replace(/ \/ +/g, ' / ')
        check(`K22 ${name}`, s === expect && (selWant ? sel.node === selWant : sel.json === 'text'), `${s} | sel=${JSON.stringify(sel)}`)
    if (want('K19')) {
      // K19(评审 K-19):标题里 Shift+Enter 同回车 —— ATX 标题容不下换行,放行硬换行时 H3 及以下落盘成 `### 甲 乙`
      //   (所见非所存),H1/H2 落 setext。现在:行中 = 从光标切出正文;行首 = 上方插空正文、标题整条保留;正文里仍是硬换行。
      const at = (page, type, off) => page.evaluate(({ type, off }) => {
        const v = window.__upage.probe.view()
        let hit = null
        v.state.doc.descendants((n, p) => { if (hit == null && n.type.name === type) { hit = p + 1 + off; return false } return hit == null })
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(hit))))
        v.focus()
      }, { type, off })
      for (const level of [3, 2]) {
        const page = await open(browser, `${'#'.repeat(level)} 甲乙\n\n正文。\n`)
        await at(page, 'heading', 1)
        await page.waitForTimeout(80)
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(1300)
        const s = await shape(page)
        const w = await lastWrite(page)
        check(`K19 H${level} 行中 Shift+Enter:切出正文,落盘不丢换行`, s === `heading${level}:"甲" / paragraph:"乙" / paragraph:"正文。"` && w === `${'#'.repeat(level)} 甲\n\n乙\n\n正文。\n`, `${s} | ${JSON.stringify(w)}`)
        await page.close()
      }
      {
        const page = await open(browser, '### 甲乙\n\n正文。\n')
        await at(page, 'heading', 0)
        await page.waitForTimeout(80)
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(200)
        const s = await shape(page)
        check('K19 标题行首 Shift+Enter:上方插空正文,标题整条保留', s === 'paragraph:"" / heading3:"甲乙" / paragraph:"正文。"', s)
        const para = await page.evaluate(() => {
          const v = window.__upage.probe.view()
          let hit = null
          v.state.doc.descendants((n, p) => { if (hit == null && n.type.name === 'paragraph' && n.textContent === '正文。') hit = p + 2; return hit == null })
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(hit))))
          return hit
        })
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(200)
        const br = await page.evaluate(() => {
          let n = 0
          window.__upage.probe.view().state.doc.descendants((c) => { if (c.type.name === 'hardbreak') n++; return true })
          return n
        })
        check('K19 对照:正文里 Shift+Enter 仍是段内硬换行', br === 1 && para != null, `hardbreaks=${br}`)
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
