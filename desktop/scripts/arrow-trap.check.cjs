// 「特殊行把光标困死」的回归仪器(npm run check:arrowtrap)。
//
// 由来:用户实报「标题 / 序号 / 双链引用行,上下箭头上不去」。纯推演修了两轮都没修中 ——
// 真正的成因有两个,且都只在真浏览器里量得出来:
//   ① 光标一落进**已经写完**的 [[双链]] 里,[[ 补全面板就弹出来吃掉 ↑/↓(wikiAutocomplete);
//   ② 含 KaTeX 公式的单行,getClientRects() 会炸出十几个子盒,任何「量元素矩形」的
//      首行判定都会把单行块判成「上面还有一行」,于是 ↑ 既不出块、块内又无处可去(atBlockEdge)。
// 所以本脚本按「每按一次箭头,光标落在第几块、什么 y」逐格记录,卡住即报错。
// ↑ 与 ↓ **两个方向都要跑**:atBlockEdge 的 up/down 是两条独立分支(coordsAtPos(1) vs
// coordsAtPos(size-1)),只测一边等于放过另一半(Codex 评审指出)。
const fs = require('fs'); const os = require('os'); const path = require('path')
const { chromium } = require('playwright-core')
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('no chromium')
}
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'

const SETS = [["标题块",["正文甲","# 一级标题","正文乙"]],["三级标题块",["正文甲","### 三级标题","正文乙"]],["有序列表块",["正文甲","1. 第一项","正文乙"]],["多项有序列表",["正文甲","1. 一\n2. 二\n3. 三","正文乙"]],["双链块",["正文甲","看 [[某笔记]] 这里","正文乙"]],["双链在行首",["正文甲","[[某笔记]] 开头","正文乙"]],["双链在行尾",["正文甲","结尾是 [[某笔记]]","正文乙"]],["图片双链",["正文甲","![[pic.png|120]] 文字","正文乙"]],["待办块",["正文甲","- [ ] 待办一条","正文乙"]],["引用块",["正文甲","> 引用一行","正文乙"]],["公式行",["正文甲","看 $x_i^2$ 这里","正文乙"]],["行内代码",["正文甲","看 `code` 这里","正文乙"]],["callout",["正文甲","> [!note] 标注\n> 内容","正文乙"]],["块内标题+正文",["正文甲","# 标题\n\n正文","正文乙"]],["表格块",["正文甲","| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |","正文乙"]],["代码块",["正文甲","```js\nconst a = 1\nconst b = 2\n```","正文乙"]],["块级公式",["正文甲","$\nx^2 + y^2\n$","正文乙"]],["全正文(对照组)",["正文甲","正文乙","正文丙"]]]

const results = []
async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  for (const [name, contents] of SETS) {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    await p.goto(`${URL}?fold`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.evaluate((cs) => {
      const iso = '2026-01-01T00:00:00.000Z'
      const refs = cs.map((_, i) => `a${i + 1}`)
      window.__pageStore.setState({
        activePage: 'Probe.md', vaultRoot: '/harness', status: 'ready',
        manifest: {
          schema: 1, id: 'probe', title: 'Probe', createdAt: iso, updatedAt: iso, compiler: { version: 'p' },
          root: { type: 'stack', children: refs.map((ref, i) => ({ type: 'row', id: `r${i}`, columns: [{ id: `c${i}`, width: 1, children: [{ ref }] }] })) },
          blocks: Object.fromEntries(refs.map((r) => [r, { type: 'markdown' }])),
        },
        blocks: Object.fromEntries(refs.map((r, i) => [r, { id: r, type: 'markdown', content: cs[i] }])),
      })
    }, contents)
    await p.waitForTimeout(800)

    // 页面异常一律算失败:块没挂上时脚本会退化成「只有一个编辑器,三次都停在 blk0」而假绿。
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    const editorCount = await p.locator('.md-block .ProseMirror').count()

    const snap = () => p.evaluate(() => {
      const sel = getSelection()
      const pms = [...document.querySelectorAll('.md-block .ProseMirror')]
      if (!sel || !sel.rangeCount) return { blk: -1, y: -1, tag: 'NO-SEL', text: '' }
      const r = sel.getRangeAt(0)
      let rect = r.getBoundingClientRect()
      if (!rect.height) { const rs = r.getClientRects(); if (rs.length) rect = rs[0] }
      let el = r.startContainer
      while (el && el.nodeType !== 1) el = el.parentNode
      const pm = el && el.closest ? el.closest('.ProseMirror') : null
      const host = el && el.closest ? el.closest('h1,h2,h3,h4,h5,h6,li,p,blockquote') : null
      let edge = null
      if (pm) {
        let caret = r.getBoundingClientRect()
        if (!caret.height) { const rs = r.getClientRects(); if (rs.length) caret = rs[0] }
        const content = document.createRange(); content.selectNodeContents(pm)
        const tol = Math.max(4, caret.height * 0.5)
        let above = null, below = null
        const minLine = Math.max(2, caret.height * 0.5)
        const all = []
        for (const x of content.getClientRects()) {
          all.push({t:Math.round(x.top),b:Math.round(x.bottom),h:Math.round(x.height),w:Math.round(x.width)})
          if (x.height < minLine) continue
          if (x.bottom <= caret.top + tol) above = { t: Math.round(x.top), b: Math.round(x.bottom), w: Math.round(x.width) }
          if (x.top >= caret.bottom - tol) below = below || { t: Math.round(x.top), b: Math.round(x.bottom), w: Math.round(x.width) }
        }
        edge = { collapsed: sel.isCollapsed, ct: Math.round(caret.top), cb: Math.round(caret.bottom), ch: Math.round(caret.height), tol: Math.round(tol), up: !above, down: !below, above: JSON.stringify(above), below: JSON.stringify(below), all: JSON.stringify(all) }
      }
      return {
        edge,
        html: pm ? pm.innerHTML.slice(0, 90) : '',
        popups: [...document.querySelectorAll('[class*=suggest],[class*=wiki-],.slash-menu,.inline-toolbar')].map((e) => e.className).join('|'),
        blk: pm ? pms.indexOf(pm) : -1,
        y: Math.round(rect.top),
        tag: host ? host.tagName : '?',
        text: (host ? host.textContent : '').slice(0, 14),
      }
    })

    // 一趟:从 `from` 块的指定端出发,朝 dir 连按,直到抵达 `goal` 块或用完步数。
    // 步数**自适应**(上限 8):多行块本来就要在块内多走几步,固定三步会让「恰好卡在首行」假绿。
    const walk = async (dir, fromIdx, goalIdx, edgeKey) => {
      await p.locator('.md-block .ProseMirror').nth(fromIdx).click()
      await p.keyboard.press(edgeKey)
      await p.waitForTimeout(250)
      const seq = [await snap()]
      let stall = -1
      for (let i = 0; i < 8; i++) {
        await p.keyboard.press(dir)
        await p.waitForTimeout(200)
        const cur = await snap()
        const prev = seq[seq.length - 1]
        seq.push(cur)
        if (cur.blk === goalIdx) break
        // 原地不动 = 被困(终点块除外:到了页首/页尾停住是对的)
        if (prev.blk === cur.blk && prev.y === cur.y && cur.blk !== goalIdx) { stall = seq.length - 1; break }
      }
      return { seq, stall, reached: seq[seq.length - 1].blk === goalIdx }
    }

    const up = await walk('ArrowUp', 2, 0, 'End')
    const down = await walk('ArrowDown', 0, 2, 'Home')
    // 必须**真的经过**中间那个特殊块,否则等于没测到被测对象
    const passedMid = up.seq.some((s) => s.blk === 1) && down.seq.some((s) => s.blk === 1)
    const ok = editorCount === 3 && errs.length === 0 && up.stall < 0 && down.stall < 0 && up.reached && down.reached && passedMid
    results.push(ok)
    const fmt = (w) => w.seq.map((s) => 'blk' + s.blk).join('>')
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ↑ ${fmt(up)}   ↓ ${fmt(down)}`)
    if (!ok) {
      if (editorCount !== 3) console.log(`        ← 只挂了 ${editorCount} 个编辑器(期望 3),用例根本没成立`)
      if (errs.length) console.log('        ← 页面异常: ' + errs.join(' | '))
      if (up.stall >= 0) console.log(`        ← ↑ 第 ${up.stall} 步原地不动: ` + up.seq.map((s) => s.blk + '@' + s.y).join(' > '))
      if (down.stall >= 0) console.log(`        ← ↓ 第 ${down.stall} 步原地不动: ` + down.seq.map((s) => s.blk + '@' + s.y).join(' > '))
      if (!up.reached) console.log('        ← ↑ 走不到页首块')
      if (!down.reached) console.log('        ← ↓ 走不到页尾块')
      if (!passedMid) console.log('        ← 没有经过中间那个特殊块(用例失效)')
    }
    await p.close()
  }
  await browser.close()
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} passed, ${bad} failed`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1) })
