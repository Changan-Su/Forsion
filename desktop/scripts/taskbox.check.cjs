// 块内留白上的鼠标按下必须原样交给浏览器与 PM(P-01,评审 2026-09-27):09-26 的框选改动在
// pointerdown 上 preventDefault,浏览器不再派发兼容 mousedown —— 待办方框点不动、短行右侧点击
// 光标落到段首、Shift+点击塌成光标、三击选不中整段。现在:按下不拦,拖动 >4px 才转成框选;
// 块矩形之外的留白(块间缝/两侧余白)维持立即起框。「从行尾留白拉框选」(selection-display.check
// 钉住的设计)照旧成立,这里另外验框完之后 Backspace 删的就是框住的块(PM 与 DOM 选区一致)。
// K8b(K-11):待办上 Mod+Enter 翻转勾选,普通列表仍拆项。
// R10b / R10:Obsidian 空待办 `- [ ]` 读成空待办;空待办落盘 `- [ ] ` 而不是 `- [ ] <br />`。
// G2-15:触屏(粗指针)上编辑器未聚焦时点方框 = 只翻转,焦点不进正文(真机不弹软键盘);只翻一次;点正文照常聚焦。
// 用法:npm run check:taskbox(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL)。
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
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function open(browser, md, flags) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  return page
}
const sel = (page) => page.evaluate(() => {
  const s = window.__upage.probe.view().state.selection
  return { type: s.toJSON().type, from: s.from, to: s.to }
})
/** 第 i 个顶层段落:首字/末字的横坐标、行中线、块盒与段落在文档里的内容区间。 */
const para = (page, i) => page.evaluate(({ PM, i }) => {
  const el = document.querySelectorAll(PM + ' > p')[i]
  const r = document.createRange()
  r.selectNodeContents(el)
  const g = r.getClientRects()[0]
  const b = el.getBoundingClientRect()
  const v = window.__upage.probe.view()
  const at = v.posAtDOM(el, 0)
  return { x0: g.left, x1: g.right, y: g.top + g.height / 2, top: b.top, bottom: b.bottom, left: b.left, right: b.right, from: at, to: at + el.textContent.length }
}, { PM, i })
/** 把光标放到文末,免得上一步的选区影响这一步。 */
const reset = (page) => page.evaluate(() => {
  const v = window.__upage.probe.view()
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc)))
})

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const flags of ['', '&upane']) {
      const shell = flags || '默认壳'
      // ① 待办方框:鼠标点 ::before 即勾选并落盘(按事件 target 判定,不被框选吞掉)。
      {
        const page = await open(browser, '# T\n\n段落。\n\n- [ ] 待办一\n- [ ] 待办二\n', flags)
        const box = await page.evaluate((PM) => {
          const li = document.querySelector(PM + ' li[data-item-type="task"]')
          const r = li.getBoundingClientRect(), s = getComputedStyle(li, '::before')
          return { x: r.left + parseFloat(s.left) + parseFloat(s.width) / 2, y: r.top + parseFloat(s.top) + parseFloat(s.height) / 2 }
        }, PM)
        await page.mouse.click(box.x, box.y)
        await page.waitForTimeout(1300)
        const st = await page.evaluate((PM) => ({
          checked: document.querySelector(PM + ' li[data-item-type="task"]').dataset.checked,
          marquee: !!document.querySelector('.amx-marquee'),
          saved: (window.__upage.writes.at(-1) || {}).text || '',
        }), PM)
        // 列表标记 `-`/`*` 不在本检查范围(D-05 另修),只认勾选态落盘。
        check(`[${shell}] 鼠标点待办方框即勾选并落盘`, st.checked === 'true' && !st.marquee && /[-*] \[x\] 待办一/.test(st.saved), JSON.stringify(st))
        await page.close()
      }
      const page = await open(browser, '# T\n\n第一段文字比较短。\n\n第二段。\n\n第三段也短。\n', flags)
      // ② 短行右侧留白点击 → 光标到行尾,接着打的字落在末尾。
      for (const dx of [20, 120]) {
        await reset(page)
        const a = await para(page, 0)
        await page.mouse.click(a.x1 + dx, a.y)
        await page.waitForTimeout(150)
        const s = await sel(page)
        await page.keyboard.type('X')
        await page.waitForTimeout(100)
        const text = await page.evaluate((PM) => document.querySelector(PM + ' > p').textContent, PM)
        check(`[${shell}] 短行右侧 +${dx}px 点击:光标到行尾,字落在末尾`, s.type === 'text' && s.from === a.to && text === '第一段文字比较短。X', `${JSON.stringify(s)} → ${text}`)
        await page.keyboard.press('Backspace')
      }
      // ②b 点完即落定:PM 对原生点按不自己设选区,只等浏览器异步派发的 selectionchange(晚 mouseup 约一帧)
      //    读 DOM 选区 —— 点完紧跟的按键按旧光标办(点完 Tab 缩进到首块、回车在文首插空段;tab-indent /
      //    caret-merge / toggle-block 三处台架都撞过)。这里把 selectionchange 挡在 PM 之外,确定性地验
      //    「松手那一刻 PM 状态已经落到点击处」,不赌时序。
      {
        await reset(page)
        const a = await para(page, 0)
        await page.evaluate(() => {
          window.__holdSC = (e) => e.stopImmediatePropagation()
          window.addEventListener('selectionchange', window.__holdSC, true)
        })
        await page.mouse.click(a.x1 + 60, a.y)
        const s = await sel(page)
        await page.evaluate(() => window.removeEventListener('selectionchange', window.__holdSC, true))
        check(`[${shell}] 行尾留白点按:松手即同步进 PM,不等迟到的 selectionchange`, s.type === 'text' && s.from === a.to && s.to === a.to, `${JSON.stringify(s)} 期望 ${a.to}`)
      }
      // ③ Shift+点击另一段右侧留白 → 从原光标扩选到那一行尾。
      {
        await reset(page)
        const a = await para(page, 0), c = await para(page, 2)
        await page.mouse.click(a.x0 + 30, a.y)
        await page.waitForTimeout(120)
        const s0 = await sel(page)
        await page.keyboard.down('Shift')
        await page.mouse.click(c.x1 + 60, c.y)
        await page.keyboard.up('Shift')
        await page.waitForTimeout(150)
        const s1 = await sel(page)
        check(`[${shell}] Shift+点击行尾留白:扩选而不是塌成光标`, s1.from === s0.from && s1.to === c.to, `${JSON.stringify(s0)} → ${JSON.stringify(s1)}`)
      }
      // ④ 三击行尾留白 → 选中整段。
      {
        await reset(page)
        const c = await para(page, 2)
        await page.mouse.click(c.x1 + 60, c.y, { clickCount: 3 })
        await page.waitForTimeout(150)
        const s = await sel(page)
        check(`[${shell}] 三击行尾留白:选中整段`, s.from <= c.from && s.to >= c.to && s.to > s.from, `${JSON.stringify(s)} para=${c.from}-${c.to}`)
      }
      // ⑤ 从行尾留白拖过两段 = 框选(设计保留);框完 Backspace 删的正是这两块。
      {
        await reset(page)
        const a = await para(page, 0), b = await para(page, 1)
        await page.mouse.move(a.x1 + 40, a.y)
        await page.mouse.down()
        await page.mouse.move(a.left + 8, b.bottom - 2, { steps: 10 })
        const during = await page.evaluate(() => !!document.querySelector('.amx-marquee'))
        await page.mouse.up()
        await page.waitForTimeout(200)
        const mode = await page.evaluate((PM) => document.querySelector(PM).getAttribute('data-blocksel'), PM)
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(150)
        const left = await page.evaluate((PM) => [...document.querySelectorAll(PM + ' > p')].map((p) => p.textContent), PM)
        check(`[${shell}] 行尾留白拖过两段仍是框选,Backspace 删掉的正是框住的两块`, during && mode === 'true' && left.join('|') === '第三段也短。', JSON.stringify({ during, mode, left }))
      }
      await page.close()
      // ⑥ 块矩形之外(块间缝)按下:维持立即起框,松手不动 = 光标落进最近的块(现状)。
      {
        const pg = await open(browser, '第一段。\n\n第二段。\n', flags)
        const a = await para(pg, 0), b = await para(pg, 1)
        const gapY = (a.bottom + b.top) / 2
        const inGap = await pg.evaluate(({ PM, y, x }) => [...document.querySelectorAll(PM + ' > *')].every((el) => { const r = el.getBoundingClientRect(); return y < r.top || y > r.bottom || x < r.left || x > r.right }), { PM, y: gapY, x: a.left + 40 })
        await pg.mouse.move(a.left + 40, gapY)
        await pg.mouse.down()
        const immediate = await pg.evaluate(() => !!document.querySelector('.amx-marquee'))
        await pg.mouse.up()
        await pg.waitForTimeout(150)
        const s = await sel(pg)
        check(`[${shell}] 块间缝按下仍立即起框,点一下落光标`, inGap && immediate && s.type === 'text' && s.from === s.to, JSON.stringify({ inGap, immediate, s }))
        await pg.close()
      }
    }
    // K8b(K-11,拍板 #3):待办上 Mod+Enter = 翻转勾选(与点方框同一个 toggleTaskTr),不新建项;
    //   普通列表仍拆项;普通子项在待办下面时只认最内层(不越级翻外层待办)。光标经 PM 放好再等一帧按键。
    {
      const place = (pg, text, off) => pg.evaluate(({ text, off }) => {
        const v = window.__upage.probe.view()
        let at = null
        v.state.doc.descendants((n, p) => {
          if (at != null) return false
          if (n.isTextblock && n.textContent === text) { at = p + 1 + off; return false }
          return true
        })
        v.focus()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
      }, { text, off })
      const items = (pg) => pg.evaluate(() => {
        const out = []
        window.__upage.probe.view().state.doc.descendants((n) => {
          if (n.type.name === 'list_item') out.push(`${n.attrs.checked == null ? '-' : n.attrs.checked ? 'x' : ' '}:${n.firstChild.textContent}`)
          return true
        })
        return out.join(' | ')
      })
      const pg = await open(browser, '# T\n\n- [ ] 待办一\n- [ ] 待办二\n\n- 普通项\n\n- [ ] 父待办\n    - 子项\n', '')
      await place(pg, '待办一', 1)
      await pg.waitForTimeout(150)
      const sel0 = await sel(pg)
      await pg.keyboard.press('Meta+Enter')
      await pg.waitForTimeout(1300)
      const a = await items(pg)
      const savedA = await pg.evaluate(() => (window.__upage.writes.at(-1) || {}).text || '')
      const selA = await sel(pg)
      check('K8b 待办上 Mod+Enter 翻转勾选并落盘,不新建项、光标不动',
        a.startsWith('x:待办一 |  :待办二 | -:普通项') && /[-*] \[x\] 待办一/.test(savedA) && selA.type === 'text' && selA.from === sel0.from, `${a}  sel=${JSON.stringify(selA)}`)
      await pg.keyboard.press('Meta+Enter')
      await pg.waitForTimeout(200)
      const b = await items(pg)
      check('K8b 再按一次 Mod+Enter 取消勾选', b.startsWith(' :待办一 |  :待办二'), b)
      await place(pg, '普通项', 1)
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Meta+Enter')
      await pg.waitForTimeout(200)
      const c = await items(pg)
      check('K8b 普通列表 Mod+Enter 仍拆项', c.includes('-:普 | -:通项'), c)
      await place(pg, '子项', 2)
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Meta+Enter')
      await pg.waitForTimeout(200)
      const d = await items(pg)
      check('K8b 待办下的普通子项:只拆子项,外层待办勾选态不动', d.endsWith(' :父待办 | -:子项 | -:'), d)
      await pg.close()

      // R10b / R10(评审 2026-09-27):Obsidian 的空待办 `- [ ]` / `- [x]`(`[ ]` 后没字)GFM 读成字面 `[ ]`;
      //   回车新建的空待办落盘成 `- [ ] <br />`。现在:读成空待办;空待办落盘 `- [ ] `,重开仍是空待办。
      const last = (p) => p.evaluate(() => (window.__upage.writes.at(-1) || {}).text || '')
      const p1 = await open(browser, '# T\n\n- [ ]\n- [x]\n- [ ] 有字\n\n尾段\n', '')
      const e = await items(p1)
      await place(p1, '有字', 2)
      await p1.waitForTimeout(150)
      await p1.keyboard.type('Q')
      await p1.waitForTimeout(1300)
      const savedE = await last(p1)
      await p1.close()
      check('R10b Obsidian 空待办 `- [ ]` / `- [x]` 读成空待办;编辑同一只列表落盘不带 `\\[`',
        e === ' : | x: |  :有字' && savedE.includes('- [ ] \n- [x] \n- [ ] 有字Q\n') && !savedE.includes('\\['), `${e}  saved=${JSON.stringify(savedE)}`)
      const p2 = await open(browser, '# T\n\n- [ ] 待办一\n\n尾段\n', '')
      await place(p2, '待办一', 3)
      await p2.waitForTimeout(150)
      await p2.keyboard.press('Enter')
      await p2.waitForTimeout(1300)
      const savedF = await last(p2)
      await p2.close()
      const p3 = await open(browser, savedF, '')
      const f = await items(p3)
      await p3.close()
      check('R10 回车新建的空待办落盘 `- [ ] `(不是 `<br />`),重开仍是空待办',
        savedF.includes('- [ ] 待办一\n- [ ] \n') && !/<br/i.test(savedF) && f === ' :待办一 |  :', `${f}  saved=${JSON.stringify(savedF)}`)
    }
    // G2-15 触屏点方框:移动视口 + 触屏(isMobile/hasTouch → pointer:coarse),真 touchscreen.tap。
    {
      const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      const pg = await ctx.newPage()
      pg.on('pageerror', (e) => console.log('  [pageerror]', e.message))
      await pg.goto(`${URL}?upage&upane&useed=${encodeURIComponent('# T\n\n- [ ] 一\n- [ ] 二\n\n正文段。\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await pg.waitForSelector(PM, { timeout: 120000 })
      await pg.waitForTimeout(500)
      const boxAt = (i) => pg.evaluate(({ PM, i }) => {
        const li = document.querySelectorAll(PM + ' li[data-item-type="task"]')[i]
        const r = li.getBoundingClientRect(), s = getComputedStyle(li, '::before')
        return { x: r.left + parseFloat(s.left) + parseFloat(s.width) / 2, y: r.top + parseFloat(s.top) + parseFloat(s.height) / 2 }
      }, { PM, i })
      const st = () => pg.evaluate((PM) => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        checked: [...document.querySelectorAll(PM + ' li[data-item-type="task"]')].map((l) => l.dataset.checked).join(','),
        focused: window.__upage.probe.view().hasFocus(),
      }), PM)
      await pg.evaluate(() => document.activeElement?.blur?.())
      const b0 = await boxAt(0)
      await pg.touchscreen.tap(b0.x, b0.y)
      await pg.waitForTimeout(300)
      const s1 = await st()
      check('G2-15 触屏未聚焦点方框:翻转一次,焦点不进正文(不弹软键盘)', s1.coarse && s1.checked === 'true,false' && !s1.focused, JSON.stringify(s1))
      const b1 = await boxAt(1)
      await pg.touchscreen.tap(b1.x, b1.y)
      await pg.waitForTimeout(1300)
      const s2 = await st()
      const saved = await pg.evaluate(() => (window.__upage.writes.at(-1) || {}).text || '')
      check('G2-15 连点第二个方框同样只翻它、落盘', s2.checked === 'true,true' && !s2.focused && /- \[x\] 一\n- \[x\] 二/.test(saved), JSON.stringify({ ...s2, saved }))
      const pp = await pg.evaluate((PM) => { const p = [...document.querySelectorAll(PM + ' > p')].find((x) => x.textContent.includes('正文段')); const r = p.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } }, PM)
      await pg.touchscreen.tap(pp.x, pp.y)
      await pg.waitForTimeout(300)
      const s3 = await st()
      check('G2-15 对照:触屏点正文照常聚焦(编辑意图)', s3.focused && s3.checked === 'true,true', JSON.stringify(s3))
      await ctx.close()
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
