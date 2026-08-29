// 图片选中 / 缩放 / 复制剪切 / 双击看源码(2026-08-27 用户实报「点击图片应该能选中、能改尺寸」)。
// 契约:
//   · 单击图片 → 图片**不让位给源码**,进选中态(PM 选区精确铺在 `![[…]]` 那段上,wrap 带 data-selected)。
//   · 选中态挂右缘缩放把手,拖它 → 松手一次性把 `|宽度` 写回源码并落盘。
//   · 复制 / 剪切 = PM 原生:剪贴板拿到的必须是**字面** `![[pic.png|200]]`(remark 转义过就废了)。
//   · **双击 = 看大图**(UnifiedPage 的灯箱,既存功能;用户 2026-08-28 拍板),源码入口只留悬停的 `</>`。
//     ⚠️ 这条依赖「widget 的 DOM 全程不换」:装饰 key 一旦带上选中位,点一下就换一份 DOM,
//     Chromium 会把第二次 mousedown 派给幸存的 `<p>` —— 双击当场失灵。别把 picked 写回 key。
//   · 图片被选中时**不许**弹行内格式工具栏(B/I/U 对图片无意义,浮条还盖住上一段正文)。
//   · **两种形态都得有 `</>`**:`![](path)` 那条是 image 节点、文档里没有字面源码,由 mdImage.ts
//     弹一行源码输入框顶上(2026-08-28 用户实报「它的源码显示按钮没了」)。
//   · 只点一下把手(零位移)/ 拖到一半被取消 → **一个字节都不许写盘**(空写会给用户的 md 平白添 `|宽度`)。
//   · 视觉缩放(端级 CSS zoom 或画布舞台的 `translate() scale(z)`)下,拖 N 视口 px 要换算成 N/scale 布局 px。
// **四**条渲染路径都得验:
//   v4 统一编辑器 / v3 行内(混在文字里)/ v3 块级(整块一张图,BlockHost)—— 以上是 `![[x.png]]` 形态;
//   外加 `![](path)` 标准 markdown 形态(**粘贴/上传**走这条,是 PM 的 image 节点,走 NodeView)。
//   ⚠️ 2026-08-27 用户实报「点击图片还是没有调整 size」,病根就是头一轮只做了 `![[…]]` 那三条。
//
// 用法:1) desktop 仓 `npm run web`  2) `npm run check:imgsel`
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
/** 台架里必须用**能真加载**的图:`amadeus-asset://` 在浏览器解析不了,坏图 + 空 alt 会塌成
 *  0×0,点击压根落不到元素上(排查时被它骗过一次)。120×80 的 SVG data URL,isExternal 放行。 */
const IMG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iODAiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iODAiIGZpbGw9IiM2YzVjZTciLz48L3N2Zz4='
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 元素几何(视口 px);没这个元素 → null。 */
const rectOf = (p, sel) =>
  p.evaluate((s) => {
    const e = document.querySelector(s)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
  }, sel)

/** 剪贴板走**合成 ClipboardEvent**:headless 里 Meta+C 不一定触发原生 copy,而我们要验的
 *  正是 PM 的序列化结果,不是 OS 剪贴板本身。dt 拿到什么,用户按 Cmd+C 就得到什么。 */
const clip = (p, editorSel, type) =>
  p.evaluate(
    ([s, t]) => {
      const dt = new DataTransfer()
      document.querySelector(s).dispatchEvent(new ClipboardEvent(t, { clipboardData: dt, bubbles: true, cancelable: true }))
      return dt.getData('text/plain')
    },
    [editorSel, type],
  )

/** 从 x0 拖到 x0+dx(把手拖拽:pointer capture 全程同一枚元素)。
 *  from=null(把手根本没挂出来)→ 记一条 FAIL 就走,别让整支脚本崩掉:改坏时要看到全部红点。 */
async function dragX(p, from, dx) {
  if (!from) {
    check('(前置)缩放把手存在', false)
    return
  }
  await p.mouse.move(from.cx, from.cy)
  await p.mouse.down()
  await p.mouse.move(from.cx + dx, from.cy, { steps: 6 })
  await p.mouse.up()
}

/** 前置几何拿不到(改坏时最常见)→ 把依赖它的断言逐条记红再往下走,别让整支脚本崩掉:
 *  改坏时要看到**完整**的红点清单,而不是第一处异常。 */
const skipRest = (names) => names.forEach((n) => check(n, false, '前置元素缺失'))

/** ?embed 台架里 e1 块的当前内容(块被删掉 → undefined)。 */
const blockE1 = (p) => p.evaluate(() => window.__pageStore.getState().blocks.e1?.content)

/** 顶掉 navigator.clipboard:块选中态的复制/剪切走的是 `navigator.clipboard.writeText`,
 *  headless 里没有真剪贴板权限,而我们要验的正是**它打算写什么**。 */
const stubClipboard = (p) =>
  p.evaluate(() => {
    window.__clip = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__clip = t; return Promise.resolve() }, readText: () => Promise.resolve('') },
    })
  })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (query, ready) => {
    const p = await browser.newPage({ viewport: { width: 900, height: 700 } })
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?${query}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector(ready, { timeout: 20000 })
    await p.waitForTimeout(900)
    return p
  }
  const UBODY = '.unified-body .ProseMirror'
  const U4 = `upage&useed=${encodeURIComponent('前言。\n\n![[pic.png|200]]\n\n后语。\n')}`
  const vault = (p) => p.evaluate(() => window.__upage.vault.get('Unified.md'))

  // ── I1 v4:单击 → 选中(不露源码) ───────────────────────────────────────────
  let p = await open(U4, '.unified-body')
  let r = await rectOf(p, '.wiki-inline-img-wrap')
  check('I1 图片先渲染出来', !!r && r.w === 200, JSON.stringify(r))
  await p.mouse.click(r.x + 40, r.cy)
  await p.waitForTimeout(350)
  let st = await p.evaluate((s) => ({
    sel: document.querySelector('.wiki-inline-img-wrap')?.hasAttribute('data-selected') ?? null,
    imgs: document.querySelectorAll('.wiki-inline-img').length,
    handle: !!document.querySelector('.amx-img-resize'),
    text: document.querySelector(s).innerText,
  }), UBODY)
  check('I1 单击进选中态,图片仍在(没让位给源码)', st.sel === true && st.imgs === 1 && !st.text.includes('[['), JSON.stringify(st))
  check('I1 选中态挂出缩放把手', st.handle === true, JSON.stringify(st))

  // ── I2 v4:复制 = 字面源码 ────────────────────────────────────────────────
  check('I2 Cmd+C 拿到字面 `![[pic.png|200]]`', (await clip(p, UBODY, 'copy')) === '![[pic.png|200]]', JSON.stringify(await clip(p, UBODY, 'copy')))

  // ── I3 v4:拖把手 → 宽度写回源码并落盘 ─────────────────────────────────────
  const h = await rectOf(p, '.amx-img-resize')
  await dragX(p, h, 60)
  await p.waitForTimeout(1500) // UnifiedPage 防抖落盘
  const md = await vault(p)
  check('I3 拖 +60px → 源码宽度 200→260', /!\[\[pic\.png\|260\]\]/.test(md), JSON.stringify(md))
  check('I3 拖完仍选中(把手不跑掉)', (await rectOf(p, '.amx-img-resize')) !== null)

  // ── I4 v4:双击 = 看大图(灯箱),图片**不**让位给源码;`</>` 才是源码入口 ──────────────
  r = await rectOf(p, '.wiki-inline-img-wrap')
  await p.mouse.dblclick(r.x + 40, r.cy)
  await p.waitForTimeout(600)
  st = await p.evaluate((s) => ({
    lightbox: !!document.querySelector('.amx-lightbox'),
    imgs: document.querySelectorAll('.wiki-inline-img').length,
    text: document.querySelector(s).innerText,
  }), UBODY)
  check('I4 双击弹灯箱,图片仍在、没让位给源码', st.lightbox === true && st.imgs === 1 && !st.text.includes('[['), JSON.stringify(st))
  await p.click('.amx-lightbox') // 点遮罩关灯箱(Esc 会连带清掉编辑器里的选中态,实测 wrap 会没)
  await p.waitForTimeout(400)
  r = await rectOf(p, '.wiki-inline-img-wrap')
  await p.mouse.move(r.x + 40, r.cy)
  await p.waitForTimeout(300)
  await p.click('.wiki-inline-img-wrap .amx-src-btn')
  await p.waitForTimeout(400)
  const txt = await p.evaluate((s) => document.querySelector(s).innerText, UBODY)
  check('I4 点 `</>` 才露出字面源码可编辑', txt.includes('![[pic.png|260]]'), JSON.stringify(txt))
  await p.close()

  // ── I5 v4:剪切 → 源码从盘上消失,剪贴板留着字面源码 ─────────────────────────
  p = await open(U4, '.unified-body')
  r = await rectOf(p, '.wiki-inline-img-wrap')
  await p.mouse.click(r.x + 40, r.cy)
  await p.waitForTimeout(350)
  const cutText = await clip(p, UBODY, 'cut')
  await p.waitForTimeout(1500)
  check('I5 剪切:剪贴板 = 字面源码', cutText === '![[pic.png|200]]', JSON.stringify(cutText))
  check('I5 剪切:图片从文档里没了', !(await vault(p)).includes('![['), JSON.stringify(await vault(p)))
  await p.close()

  // ── I6 v3 行内(混在文字里):同一套 widget ────────────────────────────────
  //    ⚠️ 图片行不能是最后一行:harness 默认把光标放文末,同一行会露源码(设计如此)。
  p = await open(`seed=${encodeURIComponent('文字 ![[pic.png|120]] 更多文字\n\n最后一行')}`, '.md-block .ProseMirror')
  r = await rectOf(p, '.wiki-inline-img-wrap')
  await p.mouse.click(r.x + 30, r.cy)
  await p.waitForTimeout(400)
  st = await p.evaluate(() => ({
    sel: document.querySelector('.wiki-inline-img-wrap')?.hasAttribute('data-selected') ?? null,
    handle: !!document.querySelector('.amx-img-resize'),
    text: document.querySelector('.md-block .ProseMirror').innerText,
  }))
  check('I6 v3 行内:单击进选中态且不露源码', st.sel === true && st.handle === true && !st.text.includes('[['), JSON.stringify(st))
  await dragX(p, await rectOf(p, '.amx-img-resize'), 50)
  await p.waitForTimeout(700)
  const b0 = (await p.evaluate(() => window.__harness.blocks.map((b) => b.content)))[0]
  check('I6 v3 行内:拖 +50px → 120→170,块里其余文字不动', /文字 !\[\[pic\.png\|170\]\] 更多文字/.test(b0), JSON.stringify(b0))
  // v3 没有 UnifiedPage、也就没有灯箱;源码入口同样只认 `</>`。
  r = await rectOf(p, '.wiki-inline-img-wrap')
  await p.mouse.move(r.x + 20, r.cy)
  await p.waitForTimeout(300)
  await p.click('.wiki-inline-img-wrap .amx-src-btn')
  await p.waitForTimeout(400)
  check('I6 v3 行内:点 `</>` 露源码', (await p.evaluate(() => document.querySelector('.md-block .ProseMirror').innerText)).includes('![[pic.png|170]]'))
  await p.close()

  // ── I7 v3 块级(整块一张图,BlockHost):单击选中块 + 精确宽度 + 双击源码 ────────────
  //    ⚠️ 起始宽度必须**自己钉死**:harness 里图片是坏图(amadeus-asset:// 在浏览器解析不了),
  //    自然宽度随 alt 文字和字体浮动 —— 只断言 `\d+` 的话,commit 写死任何数字都能骗过去(Codex)。
  p = await open('embed', '.block-host')
  await p.evaluate(() => window.__pageStore.getState().setBlockContent('e1', '![[pic.png|200]]'))
  await p.waitForTimeout(300)
  r = await rectOf(p, '.embed-image')
  check('I7 v3 块级:起始宽度 = 200', r.w === 200, JSON.stringify(r))
  await p.mouse.click(r.x + 20, r.cy)
  await p.waitForTimeout(400)
  check('I7 v3 块级:单击选中该块', (await p.evaluate(() => document.querySelector('.block-host[data-selected]')?.dataset.blockId ?? null)) === 'e1')
  let h2 = await rectOf(p, '.amx-img-resize')
  check('I7 v3 块级:选中后挂出把手', h2 !== null)
  await dragX(p, h2, 45)
  await p.waitForTimeout(600)
  check('I7 v3 块级:拖 +45px → 200→245(精确)', (await blockE1(p)) === '![[pic.png|245]]', JSON.stringify(await blockE1(p)))
  r = await rectOf(p, '.embed-image')
  await p.mouse.dblclick(r.x + 20, r.cy)
  await p.waitForTimeout(400)
  check('I7 v3 块级:双击进源码行(v3 没有灯箱,双击维持原有语义)', (await p.locator('.embed-src-input').count()) === 1)
  await p.close()

  // ── I8 v3 块级:复制 / 剪切(走既有块选中态 —— 与 v4 的 PM 剪贴板是两条独立通道,不能互相顶) ──
  for (const [key, label] of [['c', '复制'], ['x', '剪切']]) {
    p = await open('embed', '.block-host')
    await stubClipboard(p)
    r = await rectOf(p, '.embed-image')
    await p.mouse.click(r.x + 20, r.cy)
    await p.waitForTimeout(350)
    await p.keyboard.press(`Meta+${key}`)
    await p.waitForTimeout(700)
    const wrote = await p.evaluate(() => window.__clip)
    check(`I8 v3 块级:Cmd+${key.toUpperCase()} ${label} → 剪贴板 = 字面块源码`, wrote === '![[pic.png]]', JSON.stringify(wrote))
    if (key === 'x') check('I8 v3 块级:剪切后该块从页面上没了', (await blockE1(p)) === undefined, JSON.stringify(await blockE1(p)))
    else check('I8 v3 块级:复制不动原块', (await blockE1(p)) === '![[pic.png]]', JSON.stringify(await blockE1(p)))
    await p.close()
  }

  // ── I9 零位移 / 取消:一个字节都不许写盘 ────────────────────────────────────
  p = await open('embed', '.block-host')
  await p.evaluate(() => window.__pageStore.getState().setBlockContent('e1', '![[pic.png]]'))
  await p.waitForTimeout(300)
  r = await rectOf(p, '.embed-image')
  await p.mouse.click(r.x + 20, r.cy)
  await p.waitForTimeout(350)
  h2 = await rectOf(p, '.amx-img-resize')
  await p.mouse.move(h2.cx, h2.cy)
  await p.mouse.down()
  await p.mouse.up() // 只点一下把手,零位移
  await p.waitForTimeout(500)
  check('I9 只点把手(零位移)→ 源码原样,不平白添 `|宽度`', (await blockE1(p)) === '![[pic.png]]', JSON.stringify(await blockE1(p)))
  await p.close()

  // ── I10 视觉缩放:拖 N 视口 px = N/scale 布局 px ───────────────────────────────
  //    这里用注入的 `transform: scale(.5)` 顶替画布舞台(canvasStage 的 stage-inner 就是
  //    `translate() scale(z)` 裹住同一个编辑器)。验的是坐标换算本身,与缩放由谁施加无关。
  //    ⚠️ 必须是 transform 而不是 CSS zoom:`currentCSSZoom` 不含 transform,只有 transform
  //    这一档能钉住「别退回 zoomOf()」这条约束。
  p = await open(U4, '.unified-body')
  await p.evaluate(() => {
    const el = document.getElementById('root')
    el.style.transformOrigin = '0 0'
    el.style.transform = 'scale(0.5)'
  })
  await p.waitForTimeout(300)
  r = await rectOf(p, '.wiki-inline-img-wrap')
  check('I10 0.5× 下图片的视口宽 = 100(布局仍是 200)', r.w === 100, JSON.stringify(r))
  await p.mouse.click(r.x + 20, r.cy)
  await p.waitForTimeout(350)
  await dragX(p, await rectOf(p, '.amx-img-resize'), 60)
  await p.waitForTimeout(1500)
  const md2 = await vault(p)
  check('I10 0.5× 下拖 60 视口 px → 布局 +120,200→320', /!\[\[pic\.png\|320\]\]/.test(md2), JSON.stringify(md2))
  await p.close()

  // ── I11 `![](path)` 标准 markdown 图片:点击选中 + 把手 + 复制拿到字面 markdown ────────
  p = await open(`upage&useed=${encodeURIComponent(`前言。\n\n![](${IMG})\n\n后语。\n`)}`, '.unified-body')
  r = await rectOf(p, '.wiki-inline-img-wrap')
  check('I11 md 图片渲染出来(与 `![[…]]` 复用同一层 wrap)', !!r && r.w === 120, JSON.stringify(r))
  if (!r) {
    skipRest(['I11 单击进选中态并挂出把手', 'I11 复制的纯文本 = 字面 markdown', 'I12 拖 +60px → alt 变成 `|180`', 'I12 图片真按新宽度显示', 'I12 再拖一次是替换不是叠加'])
    await p.close()
    p = null
  }
  if (p) {
  await p.mouse.click(r.x + 20, r.cy)
  await p.waitForTimeout(400)
  st = await p.evaluate(() => ({
    sel: document.querySelector('.wiki-inline-img-wrap')?.hasAttribute('data-selected') ?? null,
    handle: !!document.querySelector('.amx-img-resize'),
  }))
  check('I11 单击进选中态并挂出把手', st.sel === true && st.handle === true, JSON.stringify(st))
  const plainCopy = await clip(p, UBODY, 'copy')
  check('I11 复制的纯文本 = 字面 markdown(默认 textBetween 对图片给空串)', plainCopy === `![](${IMG})`, JSON.stringify(plainCopy.slice(0, 40)))

  // ── I12 拖把手 → 宽度写进 alt(`![|180](…)`,Obsidian 口径);再拖一次不许叠加 ──────────
  await dragX(p, await rectOf(p, '.amx-img-resize'), 60)
  await p.waitForTimeout(1500)
  const altOf = async () => ((await vault(p)).match(/!\[([^\]]*)\]/) || [])[1]
  check('I12 拖 +60px → alt 变成 `|180`', (await altOf()) === '|180', JSON.stringify(await altOf()))
  check('I12 图片真按新宽度显示', (await rectOf(p, '.wiki-inline-img')).w === 180)
  await dragX(p, await rectOf(p, '.amx-img-resize'), -40)
  await p.waitForTimeout(1500)
  check('I12 再拖一次是替换不是叠加(`|140`)', (await altOf()) === '|140', JSON.stringify(await altOf()))
  await p.close()
  }

  // ── I13 alt 里本来就有说明文字:缩放只动宽度,说明必须原样留着 ────────────────────────
  p = await open(`upage&useed=${encodeURIComponent(`前言。\n\n![封面|200](${IMG})\n\n后语。\n`)}`, '.unified-body')
  r = await rectOf(p, '.wiki-inline-img')
  check('I13 `![封面|200]` 开局就按 200px 显示', !!r && r.w === 200, JSON.stringify(r))
  if (!r) {
    skipRest(['I13 alt 只显示说明文字,不带 `|200`', 'I13 缩放后说明文字还在', 'I13 选中态下 Backspace 删掉图片'])
    await p.close()
    p = null
  }
  if (p) {
  check('I13 alt 只显示说明文字,不带 `|200`', (await p.evaluate(() => document.querySelector('.wiki-inline-img')?.getAttribute('alt'))) === '封面')
  await p.mouse.click(r.x + 20, r.cy)
  await p.waitForTimeout(400)
  await dragX(p, await rectOf(p, '.amx-img-resize'), 45)
  await p.waitForTimeout(1500)
  const md3 = await vault(p)
  check('I13 缩放后说明文字还在(`![封面|245]`),`|` 没被 remark 转义', md3.includes('![封面|245]'), JSON.stringify(md3.slice(0, 60)))
  await p.keyboard.press('Backspace')
  await p.waitForTimeout(1500)
  check('I13 选中态下 Backspace 删掉图片', !(await vault(p)).includes('!['), JSON.stringify((await vault(p)).slice(0, 40)))
  await p.close()
  }

  // ── I14 落盘编码:名字带空格/括号的附件必须写成 %20/%28(否则整条图片语法作废,盘上变死字) ──
  //    2026-08-27 用户实报「原来的图片文件都无法被引用了」就是这条。纯函数那半在
  //    shared/amadeus/assets.test.ts,这里钉的是**真编辑器往返**后落盘仍然合法。
  p = await open(`upage&useed=${encodeURIComponent('前言。\n\n![](attachments/a%20b%20%281%29.png)\n\n后语。\n')}`, '.unified-body')
  check('I14 编码路径渲染成真 <img>(不是一行字面文本)', (await p.locator('.wiki-inline-img').count()) === 1)
  await p.evaluate(() => { const q = document.querySelector('.unified-body .ProseMirror > p'); const b = q.getBoundingClientRect(); window.__c = { x: b.x + 20, y: b.y + b.height / 2 } })
  const cc = await p.evaluate(() => window.__c)
  await p.mouse.click(cc.x, cc.y)
  await p.keyboard.type('X')
  await p.waitForTimeout(1500)
  const md4 = await vault(p)
  check('I14 编辑一次后落盘字节稳定,目标里无裸空格', md4.includes('![](attachments/a%20b%20%281%29.png)') && !/\]\([^)]* /.test(md4), JSON.stringify(md4))
  await p.close()

  // ── I15 选中图片不许弹行内格式工具栏(两种形态都验;2026-08-27 观感自查揪出来的) ────────
  for (const [label, seed] of [
    ['md 图片节点', `前言。\n\n![](${IMG})\n\n后语。\n`],
    ['`![[…]]` 形态', '前言。\n\n![[pic.png|200]]\n\n后语。\n'],
  ]) {
    p = await open(`upage&useed=${encodeURIComponent(seed)}`, '.unified-body')
    r = await rectOf(p, '.wiki-inline-img-wrap')
    if (!r) { skipRest([`I15 ${label}:选中图片不弹格式工具栏`]); await p.close(); continue }
    await p.mouse.click(r.x + 20, r.cy)
    await p.waitForTimeout(600)
    const tb = await p.evaluate(() => document.querySelector('.inline-toolbar') !== null)
    check(`I15 ${label}:选中图片不弹格式工具栏`, tb === false, `toolbar=${tb}`)
    await p.close()
  }

  // ── I16 `![](path)` 的源码入口:`</>` + 双击都弹源码行,提交/取消都对 ──────────────────
  //    ⚠️ 框里给的是**解码后**的库相对路径(可读),提交后由保存管线重新编码回 `%20` ——
  //    自己拼落盘字节的下场见 assets.ts 的长注释。
  p = await open(`upage&useed=${encodeURIComponent('前言。\n\n![封面|200](attachments/a%20b.png)\n\n后语。\n')}`, '.unified-body')
  r = await rectOf(p, '.wiki-inline-img-wrap')
  if (!r) {
    skipRest(['I16 `![](path)` 挂了 `</>`', 'I16 双击弹源码行', 'I16 提交后落盘重新编码', 'I16 Esc 取消不落盘'])
  } else {
    let bs = await p.evaluate(() => { const b = document.querySelector('.wiki-inline-img-wrap .amx-src-btn'); if (!b) return null; const cs = getComputedStyle(b); return { text: b.textContent, opacity: +cs.opacity, pe: cs.pointerEvents } })
    check('I16 `![](path)` 挂了 `</>` 且不悬停时不吃点击', !!bs && bs.text === '</>' && bs.opacity === 0 && bs.pe === 'none', JSON.stringify(bs))
    await p.mouse.dblclick(r.x + 20, r.cy)
    await p.waitForTimeout(600)
    check('I16 双击 = 看大图(灯箱),不弹源码行', await p.evaluate(() => !!document.querySelector('.amx-lightbox') && !document.querySelector('.amx-img-srcline')))
    await p.click('.amx-lightbox')
    await p.waitForTimeout(400)
    await p.mouse.move(r.x + 20, r.cy)
    await p.waitForTimeout(300)
    await p.click('.wiki-inline-img-wrap .amx-src-btn')
    await p.waitForTimeout(500)
    const line = await p.evaluate(() => { const i = document.querySelector('.amx-img-srcline'); return i ? { value: i.value, focused: document.activeElement === i } : null })
    check('I16 点 `</>` 弹出源码行,路径是解码后的可读形态且已聚焦', !!line && line.value === '![封面|200](attachments/a b.png)' && line.focused, JSON.stringify(line))
    if (!line) {
      // 源码行没弹出来还往下敲键,那些字会直接打进正文、把后面几格搅成噪音(负对照实测)。
      skipRest(['I16 提交后落盘重新编码成 %20', 'I16 新宽度立刻生效', 'I16 Esc 取消:一个字节都不落盘'])
      await p.close()
    } else {
    await p.keyboard.press('Meta+a') // ⚠️ mac 上 Control+a 是「回到行首」不是全选(踩过)
    await p.keyboard.type('![新说明|150](attachments/x y.png)')
    await p.keyboard.press('Enter')
    await p.waitForTimeout(1600)
    const md5 = await vault(p)
    check('I16 提交后落盘重新编码成 %20(没让裸空格写进盘)', md5.includes('![新说明|150](attachments/x%20y.png)'), JSON.stringify(md5))
    check('I16 新宽度立刻生效', (await rectOf(p, '.wiki-inline-img')).w === 150)
    const rr = await rectOf(p, '.wiki-inline-img-wrap')
    await p.mouse.move(rr.x + 20, rr.cy) // 源码入口是 `</>`,不是双击(双击已归灯箱)
    await p.waitForTimeout(300)
    await p.click('.wiki-inline-img-wrap .amx-src-btn')
    await p.waitForTimeout(400)
    check('I16 Esc 前置:源码行开着(不然下面敲的字会打进正文)', await p.evaluate(() => !!document.querySelector('.amx-img-srcline')))
    await p.keyboard.press('Meta+a')
    await p.keyboard.type('![乱改](zzz.png)')
    await p.keyboard.press('Escape')
    await p.waitForTimeout(1400)
    check('I16 Esc 取消:一个字节都不落盘', (await vault(p)) === md5, JSON.stringify(await vault(p)))
    await p.close()
    }
  }

  const fails = results.filter((x) => !x).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
