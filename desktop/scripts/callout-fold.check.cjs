// Amadeus callout 折叠(`> [!note]-`)交互回归。
// 2026-07-30:折叠区只是 display:none,ProseMirror 照样把光标放进去 —— 点标题行空白 / 点箭头折叠 /
// 折叠态回车,三条路都会让光标掉进看不见的地方(打字进虚空)。修法 = 折叠区设为光标不可达区
// (appendTransaction 拉回标题末)+ 折叠态回车先展开。纯推演看不出来,必须真浏览器驱动。
//
// 用法:1) desktop 仓 `npm run web`  2) `npm run check:callout`
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
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 光标是否落在看得见的地方(折叠区 display:none → 高度 0) */
const caret = (p) =>
  p.evaluate(() => {
    const s = window.getSelection()
    if (!s || !s.rangeCount) return null
    const r = s.getRangeAt(0)
    const host = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer
    return { txt: (r.startContainer.textContent || '').slice(0, 16), visible: !!host && host.getBoundingClientRect().height > 0 }
  })

const state = (p) =>
  p.evaluate(() => {
    const bq = document.querySelector('.md-block .ProseMirror > blockquote')
    const c = bq && bq.querySelector('.callout-chevron')
    const br = bq && bq.getBoundingClientRect()
    const cr = c && c.getBoundingClientRect()
    return {
      cls: bq ? bq.className : null,
      // 折叠 = 高度归零(现在走 height 过渡,不再是 display:none)
      hiddenKids: bq ? [...bq.children].slice(1).filter((k) => k.getBoundingClientRect().height === 0).length : 0,
      kids: bq ? bq.children.length : 0,
      // 箭头视觉中心(相对块左缘):折叠/展开两态必须一致,否则每次点都横向跳一下
      chevronCx: cr ? Math.round(cr.left + cr.width / 2 - br.left) : null,
      md: window.__harness.blocks[0].content,
    }
  })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const fresh = async (seed) => {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(400)
    return p
  }
  const SEED = '> [!note]- 标题很长很长\n> 内容一\n> 内容二'
  const HEAD = '.md-block .ProseMirror > blockquote > p:first-child'
  /** 点在标题**文字**上放光标。⚠️ 不能用 click(HEAD) —— 那点的是元素中心,
   *  即文字右侧的空白,现在那片是折叠开关。 */
  const clickTitleText = async (pg) => {
    const b = await pg.evaluate((sel) => {
      const r = document.createRange()
      r.selectNodeContents(document.querySelector(sel))
      const box = r.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, HEAD)
    await pg.mouse.click(b.x, b.y)
    await pg.waitForTimeout(200)
  }
  /** 双击标题 = 进源码态(顺带切一次折叠,刻意不抵消)。这是**唯一**能把光标放进标题行的鼠标操作。 */
  const dblTitle = async (pg) => {
    const b = await pg.evaluate((sel) => {
      const r = document.createRange()
      r.selectNodeContents(document.querySelector(sel))
      const box = r.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, HEAD)
    await pg.mouse.dblclick(b.x, b.y)
    await pg.waitForTimeout(300)
  }
  const tokenW = (pg) =>
    pg.evaluate(() => {
      const t = document.querySelector('.md-block .ProseMirror .callout-token')
      return t ? Math.round(t.getBoundingClientRect().width) : -1
    })

  // C1 折叠真的藏住内容(折叠机制本身)
  let p = await fresh(SEED)
  let s = await state(p)
  check('C1 折叠态首段之外全部隐藏', /callout-collapsed/.test(s.cls) && s.hiddenKids === s.kids - 1, JSON.stringify(s))
  await p.close()

  // C2 标题行**整行**单击 = 切折叠(空白处 与 文字上 都算);光标不能掉进隐藏区
  for (const [where, click] of [
    ['文字右侧空白', async (pg) => pg.click(HEAD)], // playwright 点元素中心 = 文字右侧的大片空白
    ['标题文字上', clickTitleText],
  ]) {
    p = await fresh(SEED)
    await click(p)
    await p.waitForTimeout(350)
    const c0 = await caret(p)
    s = await state(p)
    check(`C2 单击${where} → 切换折叠态`, !/callout-collapsed/.test(s.cls), JSON.stringify(s.cls))
    check(`C2 单击${where} → 光标可见`, !!c0 && c0.visible, JSON.stringify(c0))
    await p.close()
  }
  let c

  // C3 点箭头折叠时,原本在内容里的光标要被收回标题(原 bug:光标消失在虚空)
  p = await fresh('> [!note] 标题\n> 内容一\n> 内容二') // 无标记 = 展开态,光标默认在文末
  await p.click('.callout-chevron')
  await p.waitForTimeout(350)
  c = await caret(p)
  s = await state(p)
  const cxA = s.chevronCx
  check('C3 折叠后光标可见', !!c && c.visible, JSON.stringify(c))
  check('C3 折叠态写进 md(跨端一致)', s.md.includes('[!note]-'), JSON.stringify(s.md))
  // 再点开:`-`↔`+` 等长,标题没变 → 箭头一步都不能挪(否则每次折叠都跳一下)
  await p.click('.callout-chevron')
  await p.waitForTimeout(350)
  s = await state(p)
  check('C3 箭头两态位置不跳', Math.abs(s.chevronCx - cxA) <= 1, `折叠=${cxA} 展开=${s.chevronCx}`)
  await p.close()

  // C3b 箭头紧跟标题文字之后(Obsidian 同款):标题越长,箭头越靠右
  const cxOf = async (title) => {
    const q = await fresh(`> [!note]- ${title}\n> 内容一`)
    const v = (await state(q)).chevronCx
    await q.close()
    return v
  }
  const [cxShort, cxLong] = [await cxOf('短'), await cxOf('很长很长很长的标题')]
  check('C3b 箭头跟着标题文字走', cxLong > cxShort + 40, `短=${cxShort} 长=${cxLong}`)

  // C3c 箭头挂在行尾 → ProseMirror 会补一个 img.ProseMirror-separator;它若被当成块级元素,
  // 标题行会凭空高一倍(实测 24→60)。量「标题行高 == 正文行高」把这条钉死。
  p = await fresh('> [!note]+ 标题\n> 正文一行')
  const hs = await p.evaluate(() => {
    const ks = [...document.querySelectorAll('.md-block .ProseMirror > blockquote > p')]
    return { head: Math.round(ks[0].getBoundingClientRect().height), body: Math.round(ks[1].getBoundingClientRect().height) }
  })
  check('C3c 标题行不被行尾 widget 撑高', hs.head === hs.body, JSON.stringify(hs))
  await p.close()

  // C4 折叠态回车 → 先展开(原 bug:新段落被藏,继续打字全在虚空)
  // 种展开态,双击一次 → 切成折叠 + 光标进标题行(新契约下这是唯一的鼠标入口)
  p = await fresh('> [!note]+ 标题很长很长\n> 内容一\n> 内容二')
  await dblTitle(p)
  await p.keyboard.press('Enter')
  await p.waitForTimeout(400)
  c = await caret(p)
  s = await state(p)
  check('C4 折叠态回车自动展开', !/callout-collapsed/.test(s.cls), JSON.stringify(s.cls))
  check('C4 回车后光标可见', !!c && c.visible, JSON.stringify(c))
  await p.close()

  // C5 删掉折叠符 `-` → 立刻展开(状态就是 md,别脱钩)
  p = await fresh('> [!note]+ 标题\n> 内容一')
  await dblTitle(p) // 双击:切成折叠 + 进源码态,令牌浮现
  const tk = await p.evaluate(() => {
    const b = document.querySelector('.md-block .ProseMirror .callout-token').getBoundingClientRect()
    return { x: b.right - 1, y: b.top + b.height / 2 }
  })
  await p.mouse.click(tk.x, tk.y) // 光标落到令牌末尾 = `-` 之后(键盘定位在 mac 上不可靠)
  await p.waitForTimeout(150)
  await p.keyboard.press('Backspace')
  await p.waitForTimeout(400)
  s = await state(p)
  check('C5 删掉 `-` 即展开', !/callout-collapsed/.test(s.cls) && s.hiddenKids === 0, JSON.stringify(s))
  await p.close()

  // C6 折叠态复制:隐藏内容照样带走,且不混入箭头字符
  p = await fresh('> [!note]- 标题\n> 内容一\n\n后面一段')
  await p.click('.md-block .ProseMirror > p:last-child') // 焦点给编辑器,但别碰 callout(单击它=折叠)
  await p.keyboard.press('Meta+a')
  await p.waitForTimeout(200)
  const txt = await p.evaluate(() => {
    const pm = document.querySelector('.md-block .ProseMirror')
    const dt = new DataTransfer()
    pm.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return dt.getData('text/plain')
  })
  check('C6 复制含隐藏内容且不带箭头 ›', txt.includes('内容一') && !txt.includes('›'), JSON.stringify(txt))
  await p.close()

  // C7 callout 左边一条竖线都不留;普通 `>` 引用的细竖条照旧
  p = await fresh('> [!note]- 标题\n> 内容一\n\n> 普通引用')
  const bars = await p.evaluate(() => {
    const q = [...document.querySelectorAll('.md-block .ProseMirror > blockquote')]
    const read = (el) => ({
      before: getComputedStyle(el, '::before').content,
      borderLeft: parseFloat(getComputedStyle(el).borderLeftWidth) || 0,
    })
    return { callout: read(q[0]), plain: read(q[q.length - 1]) }
  })
  check(
    'C7 callout 无竖线(::before + border-left 都没有)',
    bars.callout.before === 'none' && bars.callout.borderLeft === 0,
    JSON.stringify(bars.callout)
  )
  check('C7 普通引用的竖条保留', bars.plain.before !== 'none' && bars.plain.before !== 'normal', JSON.stringify(bars.plain))
  await p.close()

  // C8 令牌只由**双击**决定露不露(与光标位置无关)。
  // ⚠️ 两种 callout 都要测:`[!fold]` 的令牌有自己的一条 CSS,特异性压不住就藏不掉。
  for (const [label, seed] of [
    ['有色标注 [!note]', '> [!note]+ 标题\n> 内容一'],
    ['折叠块 [!fold]', '> [!fold]+ 标题\n> 内容一'],
  ]) {
    p = await fresh(seed)
    check(`C8 ${label} 默认不露令牌`, (await tokenW(p)) === 0, `w=${await tokenW(p)}`)
    await dblTitle(p)
    check(`C8 ${label} 双击 → 令牌浮现`, (await tokenW(p)) > 10, `w=${await tokenW(p)}`)
    await p.close()
  }

  // C8b 露源码的**唯一**触发是双击 —— 2026-07-31 两次实报都栽在「光标在标题行就露」上:
  //   ① 折叠 callout 的光标守卫会把光标送进/送离标题行 → 从没点过就把令牌亮出来。
  //   ② ProseMirror 的 selection 失焦后原地不动 → 点过一次就永远亮着。
  p = await fresh('123\n\n> [!note]- 可是\n> 藏起来的正文\n\n后面一段')
  check('C8b 加载后没点过 → 令牌不露', (await tokenW(p)) === 0, `w=${await tokenW(p)}`)
  await clickTitleText(p) // 单击 = 切折叠,**不**该露源码
  check('C8b 单击标题 → 仍不露(单击只管折叠)', (await tokenW(p)) === 0, `w=${await tokenW(p)}`)
  await dblTitle(p)
  check('C8b 双击 → 令牌浮现(要能改)', (await tokenW(p)) > 10, `w=${await tokenW(p)}`)
  await p.mouse.click(5, 5) // 点到编辑器外 = 本块失焦
  await p.waitForTimeout(400)
  check('C8b 失焦 → 收回源码态', (await tokenW(p)) === 0, `w=${await tokenW(p)}`)
  await p.close()

  // C8c 键盘走进标题行:不露源码,且 ←/→ 把藏起来的语法段整段跳过(别停在看不见的字里)
  p = await fresh('> [!note]+ 标题\n> 内容一')
  await p.click('.md-block .ProseMirror > blockquote > p:nth-child(2)') // 光标进正文
  await p.keyboard.press('ArrowUp')
  await p.waitForTimeout(250)
  check('C8c 键盘进标题行 → 不露源码', (await tokenW(p)) === 0, `w=${await tokenW(p)}`)
  // 走到标题行首(此时光标在隐藏的 `[!note]+ ` 之前),按一次 → 应**整段跨过**它落到可见标题上,
  // 而不是一格一格在看不见的字里挪(那样要按 9 次才出得来)。量「距段首的字符数」最直白。
  const caretOff = () =>
    p.evaluate((sel) => {
      const host = document.querySelector(sel)
      const s = window.getSelection()
      if (!s || !s.rangeCount) return -1
      const r = s.getRangeAt(0)
      const m = document.createRange()
      m.setStart(host, 0)
      m.setEnd(r.startContainer, r.startOffset)
      return m.toString().length
    }, HEAD)
  await p.keyboard.press('Meta+ArrowLeft')
  await p.waitForTimeout(150)
  const off0 = await caretOff()
  await p.keyboard.press('ArrowRight')
  await p.waitForTimeout(200)
  const off1 = await caretOff()
  // `[!note]+ ` = 9 个字符;跳过了就该直接落到 9,没跳就是 1
  check('C8c → 整段跨过隐藏语法(不是一格一格挪)', off0 === 0 && off1 >= 9, `行首=${off0} 按一次→=${off1}`)
  await p.close()

  // C9 标题里的 `## ` → 按 H2 排版,`##` 本身不显示
  p = await fresh('> [!fold]+ ## 今日总结\n> 正文')
  const h = await p.evaluate(() => {
    const head = document.querySelector('.md-block .ProseMirror > blockquote > p:first-child')
    const mark = document.querySelector('.md-block .ProseMirror .callout-syntax-h2')
    const body = document.querySelector('.md-block .ProseMirror > blockquote > p:nth-child(2)')
    return {
      cls: head.className,
      headFs: parseFloat(getComputedStyle(head).fontSize),
      bodyFs: parseFloat(getComputedStyle(body).fontSize),
      markW: mark ? Math.round(mark.getBoundingClientRect().width) : -1,
      text: head.textContent,
    }
  })
  check('C9 `## ` → 标题按 H2 放大', /callout-title-h2/.test(h.cls) && h.headFs > h.bodyFs + 3, JSON.stringify(h))
  check('C9 `##` 本身不占宽度', h.markW === 0, `w=${h.markW}`)
  await p.close()

  // C10 标题里的 `- ` → 项目符号
  p = await fresh('> [!fold]+ - 一条清单\n> 正文')
  const bullet = await p.evaluate(() => {
    const head = document.querySelector('.md-block .ProseMirror > blockquote > p:first-child')
    const mark = document.querySelector('.md-block .ProseMirror .callout-syntax-bullet')
    return { cls: head.className, before: mark ? getComputedStyle(mark, '::before').content : null }
  })
  check('C10 `- ` → 标题渲染成项目符号', /callout-title-bullet/.test(bullet.cls) && bullet.before === '"•"', JSON.stringify(bullet))
  await p.close()

  // C11 折叠/展开有高度过渡(不是硬切)
  p = await fresh('> [!note]- 标题\n> 内容一')
  const anim = await p.evaluate(() => {
    const kid = document.querySelector('.md-block .ProseMirror > blockquote > p:nth-child(2)')
    const cs = getComputedStyle(kid)
    return { prop: cs.transitionProperty, dur: cs.transitionDuration, display: cs.display }
  })
  check(
    'C11 折叠走 height 过渡而非 display:none',
    anim.display !== 'none' && /height/.test(anim.prop) && /0\.\d+s/.test(anim.dur),
    JSON.stringify(anim)
  )
  // 光挂 transition 不算数:`height: auto → 0` 要真能插值(靠 interpolate-size)。
  // 点开后立刻连采几帧,中途必须出现「既不是 0 也不是终值」的高度,否则就是硬切。
  const frames = await p.evaluate(
    () =>
      new Promise((done) => {
        const bq = document.querySelector('.md-block .ProseMirror > blockquote')
        const kid = bq.children[1]
        const out = []
        bq.querySelector('.callout-chevron').click()
        const t0 = performance.now()
        const tick = () => {
          out.push(Math.round(kid.getBoundingClientRect().height))
          if (performance.now() - t0 < 260) requestAnimationFrame(tick)
          else done(out)
        }
        requestAnimationFrame(tick)
      })
  )
  const full = frames[frames.length - 1]
  check(
    'C11 展开高度真的逐帧插值(不是硬切)',
    full > 0 && frames.some((h) => h > 0 && h < full),
    `frames=${JSON.stringify(frames.filter((_, i) => i % 3 === 0))} 终值=${full}`
  )
  await p.close()

  const fails = results.filter((r) => !r).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
