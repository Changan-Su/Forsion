// 加粗字面化(隐藏开关 `?litbold=1`)的页面级检查:生产 UnifiedPage(台架 `?upage`),真按键、CDP 模拟输入法、合成剪贴板事件。
// Page-level check of literal bold (hidden switch): real keys, CDP IME, synthetic clipboard events, on the production page.
// 覆盖:光标走进 / 离开时定界符露出 / 藏起;加粗后退格删一个 `*`;后面接着打字不加粗;手打 `**字**`;⌘B 有 / 无选区;
// 工具条 B;选中敲 `*` 递进(斜体 → 字面加粗);复制(网页格式 <strong>、纯文本星号)/ 粘贴 <b>;源码模式往返;外部回灌;
// 加粗左 / 中 / 右紧挨着组字(组字中两个定界符同显同隐,不露半边);打开不编辑零写盘、不编辑时回灌零副本。每条比对 serializeNow 逐字,能重开的再重开取一次不变。
// ⚠️ 自己在网址上加 `litbold=1`,并断言编辑器根上真有 data-literal-bold(没有 = 测到了别的服务 / 旧代码,直接红)。
// 实现:frontend/src/amadeus/blocks/markdown/literalBold.ts、literalBoldFlag.ts、textSafe.ts;unified/keyboard.ts。
// 用法:npm run check:litbold(由 e2e-editor 自起 / 复用 Vite;worktree 里设 HARNESS_URL 指到自己的端口)。`--only=A,D` 只跑这几组。
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
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail == null ? '' : `  | ${detail}`}`)
}

async function open(browser, md) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&litbold=1&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForSelector(PM, { timeout: 180000 })
  await page.waitForFunction(() => typeof window.__upage?.probe?.serializeNow === 'function' && !!window.__upage.probe.view?.(), null, { timeout: 60000 })
  const on = await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-literal-bold'), PM)
  if (on !== '1') {
    console.log(`FAIL  开关没开着:编辑器根上没有 data-literal-bold(${URL} 是不是别人的服务 / 旧代码?)`)
    process.exit(1)
  }
  await sleep(300)
  return page
}
const serialize = (page) => page.evaluate(() => window.__upage.probe.serializeNow())
async function reopen(page, md, tag) {
  await page.evaluate(([p, m]) => { window.__lbOld = window.__upage.probe.view(); window.__upage.switchFile(p, m) }, [`Reopen-${tag}.md`, md])
  await page.waitForFunction(() => { const v = window.__upage.probe.view?.(); return !!v && v !== window.__lbOld && typeof window.__upage.probe.serializeNow() === 'string' }, null, { timeout: 60000 })
  await sleep(300)
  return serialize(page)
}
/** 光标放到某段文字之后(before:之前)。 */
const caretTo = (page, k, before = false) => page.evaluate(([k, before]) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  let hit = null
  st.doc.descendants((node, pos) => {
    if (hit != null) return false
    if (!node.isTextblock) return true
    const i = node.textBetween(0, node.content.size, '', '￼').indexOf(k)
    if (i >= 0) hit = pos + 1 + i + (before ? 0 : k.length)
    return false
  })
  if (hit == null) throw new Error('锚点没找到: ' + k)
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)).scrollIntoView())
}, [k, before])
const select = (page, text) => page.evaluate((text) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  let hit = null
  st.doc.descendants((node, pos) => {
    if (hit) return false
    if (!node.isTextblock) return true
    const i = node.textBetween(0, node.content.size, '', '￼').indexOf(text)
    if (i >= 0) hit = { start: pos + 1 + i, end: pos + 1 + i + text.length }
    return false
  })
  if (!hit) throw new Error('锚点没找到: ' + text)
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit.start, hit.end)).scrollIntoView())
}, text)
const selected = (page) => page.evaluate(() => { const s = window.__upage.probe.view().state; return s.doc.textBetween(s.selection.from, s.selection.to) })
/** 第一段:文档文字、看得见的文字、粗体那几段、定界符各自显没显。 */
const look = (page, nth = 0) => page.evaluate(([sel, nth]) => {
  const v = window.__upage.probe.view()
  const p = v.dom.querySelectorAll(':scope > *')[nth]
  const delims = [...p.querySelectorAll('.amx-obs-delim, .amx-obs-hidden')].filter((e) => /^(\*\*|__)$/.test(e.textContent))
    .map((e) => (getComputedStyle(e).display === 'none' ? 'hidden' : 'shown'))
  let strong = 0
  v.state.doc.descendants((n) => { strong += n.marks.filter((m) => m.type.name === 'strong').length })
  return {
    doc: v.state.doc.child(nth).textContent,
    visible: p.innerText.replace(/\n/g, ''),
    bold: [...p.querySelectorAll('.amx-lit-bold')].map((e) => e.textContent).join('|'),
    delims: delims.join(','),
    strongMarks: strong,
  }
}, [PM, nth])
const type = async (page, s) => { await page.keyboard.type(s, { delay: 25 }); await sleep(120) }

async function caseMd(browser, name, seed, act, wantMd) {
  const page = await open(browser, seed)
  try {
    await act(page)
    await sleep(150)
    const md = await serialize(page)
    if (wantMd != null) check(name, md === wantMd, `got ${JSON.stringify(md)} want ${JSON.stringify(wantMd)}`)
    const again = await reopen(page, md, name.replace(/\W+/g, '_').slice(0, 40))
    check(`${name} · 重开再存不变`, again === md, `${JSON.stringify(md)} → ${JSON.stringify(again)}`)
  } catch (e) {
    check(`${name}(异常)`, false, String((e && e.message) || e).split('\n')[0])
  } finally {
    await page.close().catch(() => {})
  }
}

const SEED = 'plain **bold** tail\n\nnext __two__ end\n'

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    if (want('G')) {
      // G:打开不编辑 = 不算改动、不写盘;不编辑的回灌 = 采用、零副本(unifiedcas / unified-sync 的口径,这里用带加粗的文)
      const md = 'plain **bold** tail\n\n__u__ x\n\n5 * 3 snake_case a_b_c\n\n- **item** *it*\n'
      const p = await open(browser, md)
      try {
        await sleep(1500) // 越过 800ms 防抖
        const w = await p.evaluate(() => window.__upage.writes.length)
        check('G1 打开不编辑:零写盘、serializeNow 逐字', w === 0 && (await serialize(p)) === md, JSON.stringify({ writes: w }))
        await caretTo(p, 'tail'); await sleep(1300)
        const w2 = await p.evaluate(() => window.__upage.writes.length)
        check('G2 光标进出加粗(露出 / 藏起)不算改动:零写盘', w2 === 0, JSON.stringify({ writes: w2 }))
        const ext = md.replace('__u__ x', '__u__ x 外部')
        await p.evaluate((t) => window.__upage.fire('Unified.md', t), ext); await sleep(1800)
        const c = await p.evaluate(() => [...window.__upage.vault.keys()].filter((k) => /conflict/.test(k)))
        const disk = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
        check('G3 不编辑时外部改动:采用、零冲突副本、盘上 = 外部内容', c.length === 0 && disk === ext && (await serialize(p)) === ext, JSON.stringify({ c, disk }))
      } finally { await p.close() }
    }

    if (want('A')) {
      // A:光标走进 / 离开
      const p = await open(browser, SEED)
      try {
        await caretTo(p, 'end')
        let s = await look(p)
        check('A1 光标在别段:定界符藏起、bold 粗体、文档里是 `**` 文字、没有加粗属性',
          s.delims === 'hidden,hidden' && s.bold === 'bold' && s.doc === 'plain **bold** tail' && s.visible === 'plain bold tail' && s.strongMarks === 0, JSON.stringify(s))
        await caretTo(p, 'bo')
        s = await look(p)
        check('A2 光标进到加粗里面:两边露出', s.delims === 'shown,shown' && s.visible === 'plain **bold** tail', JSON.stringify(s))
        await caretTo(p, '**bold', true)
        s = await look(p)
        check('A3 光标贴着左边外侧:露出', s.delims === 'shown,shown', JSON.stringify(s))
        await caretTo(p, 'bold**')
        s = await look(p)
        check('A4 光标贴着右边外侧:露出', s.delims === 'shown,shown', JSON.stringify(s))
        await caretTo(p, 'tai')
        s = await look(p)
        check('A5 光标在同段不相邻:藏起', s.delims === 'hidden,hidden', JSON.stringify(s))
        const two = await look(p, 1)
        check('A6 `__two__` 同样是文字 + 粗体', two.doc === 'next __two__ end' && two.bold === 'two' && two.delims === 'hidden,hidden', JSON.stringify(two))
        // 方向键一格一格走:从 `plain` 末尾右移穿过加粗,每一步都在文字上(不跳过定界符)
        await caretTo(p, 'plain ')
        const offs = []
        for (let i = 0; i < 4; i++) {
          await p.keyboard.press('ArrowRight'); await sleep(40)
          offs.push(await p.evaluate(() => window.__upage.probe.view().state.selection.$head.parentOffset))
        }
        check('A7 右方向键逐个走过 `**`', offs.join(',') === '7,8,9,10', offs.join(','))
      } finally { await p.close() }
    }

    if (want('B')) {
      await caseMd(browser, 'B1 加粗右边外侧退格:删掉一个 `*`', 'a **bold** z', async (p) => {
        await caretTo(p, 'bold**'); await p.keyboard.press('Backspace')
      }, 'a **bold* z\n')
      await caseMd(browser, 'B2 加粗后面接着打字:不加粗', 'a **bold** b', async (p) => {
        await caretTo(p, 'bold'); await type(p, 'X')
        await caretTo(p, 'boldX**'); await type(p, 'Y')
        const s = await look(p)
        check('B2 X 在粗体里、Y 不在', s.bold === 'boldX' && s.doc === 'a **boldX**Y b', JSON.stringify(s))
      }, 'a **boldX**Y b\n')
      await caseMd(browser, 'B3 手打 `**字**`:保持文字、显示粗体、没有加粗属性', 'x', async (p) => {
        await caretTo(p, 'x'); await type(p, ' ab **字** ef')
        await caretTo(p, ' ef')
        const s = await look(p)
        check('B3 粗体 = 字、没有加粗属性', s.bold === '字' && s.strongMarks === 0 && s.doc === 'x ab **字** ef', JSON.stringify(s))
      }, 'x ab **字** ef\n')
      await caseMd(browser, 'B4 行首手打 `* item` 仍成列表', 'x', async (p) => {
        await caretTo(p, 'x'); await p.keyboard.press('Enter'); await type(p, '* item')
      }, 'x\n\n* item\n')
      await caseMd(browser, 'B5 打 `5 * 3` 与 `snake_case`:原样落盘', 'x', async (p) => {
        await caretTo(p, 'x'); await type(p, ' 5 * 3 snake_case')
      }, 'x 5 * 3 snake_case\n')
    }

    if (want('C')) {
      await caseMd(browser, 'C1 ⌘B 有选区:两边加 `**`,选区仍在字上', 'hello world', async (p) => {
        await select(p, 'world'); await p.keyboard.press(`${MOD}+b`); await sleep(100)
        check('C1 选区仍是 world', (await selected(p)) === 'world', await selected(p))
      }, 'hello **world**\n')
      await caseMd(browser, 'C2 ⌘B 再按一次:去掉', 'hello world', async (p) => {
        await select(p, 'world'); await p.keyboard.press(`${MOD}+b`); await sleep(100); await p.keyboard.press(`${MOD}+b`)
      }, 'hello world\n')
      await caseMd(browser, 'C3 ⌘B 没选区:插 `****` 光标居中,接着打字', 'hello', async (p) => {
        await caretTo(p, 'hello'); await type(p, ' '); await p.keyboard.press(`${MOD}+b`); await type(p, 'x')
      }, 'hello **x**\n')
      await caseMd(browser, 'C4 工具条 B:同 ⌘B', 'hello world', async (p) => {
        await select(p, 'world')
        await p.waitForSelector('[data-testid="inline-toolbar"] [data-act="bold"]', { timeout: 5000 })
        await p.click('[data-testid="inline-toolbar"] [data-act="bold"]'); await sleep(150)
      }, 'hello **world**\n')
      await caseMd(browser, 'C5 选中敲 `*`:斜体 → 再敲变字面 `**`(不是加粗属性)', 'hello world', async (p) => {
        await select(p, 'world'); await type(p, '*')
        const s1 = await look(p)
        await type(p, '*')
        const s2 = await look(p)
        check('C5 第二下后:文档里是 `**world**`、没有加粗属性、选区仍在 world',
          s2.doc === 'hello **world**' && s2.strongMarks === 0 && (await selected(p)) === 'world', JSON.stringify({ s1, s2 }))
      }, 'hello **world**\n')
    }

    if (want('D')) {
      // 复制 / 粘贴(合成剪贴板事件,走编辑器自己的 copy / paste 处理)
      const p = await open(browser, SEED)
      try {
        const copy = () => p.evaluate(() => {
          const t = document.activeElement || document.body, dt = new DataTransfer()
          const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev)
          const data = {}; for (const k of dt.types) data[k] = dt.getData(k); return data
        })
        const paste = (data) => p.evaluate((data) => {
          const t = document.activeElement || document.body, dt = new DataTransfer()
          for (const [k, v] of Object.entries(data)) dt.setData(k, v)
          t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        }, data)
        await select(p, 'plain **bold** tail')
        const c = await copy()
        check('D1 复制整段:网页格式 <strong>bold</strong>、纯文本带星号',
          /<strong>bold<\/strong>/.test(c['text/html'] || '') && !/\*\*/.test(c['text/html'] || '') && c['text/plain'] === 'plain **bold** tail', JSON.stringify(c))
        await caretTo(p, 'end')
        await paste({ 'text/html': '<p> x <b>y</b> z</p>', 'text/plain': ' x y z' }); await sleep(300)
        let s = await look(p, 1)
        // 段首空白被 HTML 解析吃掉(与开关无关),只比结尾
        check('D2 粘贴网页 <b>y</b>:变成 `**y**` 文字,没有加粗属性', /^next __two__ end ?x \*\*y\*\* z$/.test(s.doc) && s.strongMarks === 0, JSON.stringify(s))
        await caretTo(p, 'z')
        await paste(c); await sleep(300)
        s = await look(p, 1)
        check('D3 粘贴自己复制的:`**bold**` 文字', s.doc.endsWith('plain **bold** tail') && s.strongMarks === 0, JSON.stringify(s))
        const md = await serialize(p)
        check('D4 粘贴后落盘不带反斜杠', !md.includes('\\*') && md.includes('x **y** z'), JSON.stringify(md))
      } finally { await p.close() }
    }

    if (want('E')) {
      // 源码模式往返 + 外部回灌
      const p = await open(browser, SEED)
      try {
        await caretTo(p, 'end')
        await p.evaluate(() => window.__upage.setEditorMode('source')); await sleep(1200)
        const src = await p.evaluate(() => { const t = document.querySelector('textarea.amx-source'); return t ? t.value : null })
        check('E1 源码框里是原文', src === SEED, JSON.stringify(src))
        await p.evaluate(() => window.__upage.setEditorMode('wysiwyg')); await sleep(1500)
        await p.waitForSelector(PM)
        await caretTo(p, 'end'); await sleep(200)
        let s = await look(p)
        check('E2 切回:仍是文字 + 粗体,存盘逐字', s.doc === 'plain **bold** tail' && s.bold === 'bold' && (await serialize(p)) === SEED, JSON.stringify(s))
        const ext = 'plain **bold** tail changed\n\nnext __two__ end\n'
        await p.evaluate((t) => window.__upage.fire('Unified.md', t), ext); await sleep(2000)
        await caretTo(p, 'end'); await sleep(200)
        s = await look(p)
        const disk = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
        const conflicts = await p.evaluate(() => [...window.__upage.vault.keys()].filter((k) => /conflict/.test(k)))
        check('E3 外部回灌:读成文字 + 粗体,不生冲突副本,存盘 = 外部内容',
          s.doc === 'plain **bold** tail changed' && s.bold === 'bold' && (await serialize(p)) === ext && disk === ext && conflicts.length === 0, JSON.stringify({ s, disk, conflicts }))
      } finally { await p.close() }
    }

    if (want('F')) {
      // 输入法:加粗左 / 中 / 右紧挨着组字。组字中两个定界符同显同隐(不露半边),上屏后结果对。
      const ime = async (p, steps, commit) => {
        const cdp = await p.context().newCDPSession(p)
        const seen = []
        for (const t of steps) {
          await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(120)
          seen.push(await look(p))
        }
        await cdp.send('Input.insertText', { text: commit }); await sleep(250)
        await cdp.detach()
        return seen
      }
      // 「露半边」看屏上的字:这段里看得见的 `*` 只能是 0 个(都藏)或 4 个(都露)。组字中的字可能和定界符进了同一个
      // 文字节点(浏览器不让编辑器改它的样式),只看装饰的 class 会漏掉 —— 探针当年看到的就是屏上 `中bold**wen`。
      const halves = (seen) => seen.filter((s) => ![0, 4].includes((s.visible.match(/\*/g) || []).length))
      for (const [name, anchor, before, commit, wantDoc] of [
        ['F1 左边紧挨', '**bold', true, '中', 'plain 中**bold** tail'],
        ['F2 里面', 'bo', false, '字', 'plain **bo字ld** tail'],
        ['F3 右边紧挨', 'bold**', false, '文', 'plain **bold**文 tail'],
      ]) {
        const p = await open(browser, SEED)
        try {
          await caretTo(p, anchor, before)
          const seen = await ime(p, ['w', 'wo', 'wen'], commit)
          const bad = halves(seen)
          check(`${name}组字:组字中不露半边定界符`, bad.length === 0, JSON.stringify(seen.map((s) => `${s.visible} [${s.delims}]`)))
          const s = await look(p)
          check(`${name}组字:上屏后文字对、粗体对`, s.doc === wantDoc, JSON.stringify(s))
          await caretTo(p, 'end'); await sleep(150)
          const s2 = await look(p)
          check(`${name}组字:光标离开后两边藏起`, s2.delims === 'hidden,hidden' && s2.bold.length > 0, JSON.stringify(s2))
          const md = await serialize(p)
          check(`${name}组字:落盘`, md === `${wantDoc}\n\nnext __two__ end\n`, JSON.stringify(md))
        } catch (e) {
          check(`${name}组字(异常)`, false, String((e && e.message) || e).split('\n')[0])
        } finally { await p.close() }
      }
    }
  } finally {
    await browser.close()
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed} PASS · ${failed} FAIL`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
