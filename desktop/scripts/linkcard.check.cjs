// 链接悬停卡 / 编辑面板的**几何 + 真指针**回归仪器(评审 2026-09-27 I-05,合并 P-06)。
//
// 病:`.amx-linkcard` / `.amx-linkedit` 两个类没写 position。OverlayAt(lcl/engine/menuAnchor.tsx)只给视口坐标
// left/top,定位方式归浮层自己的类 —— 漏了 fixed,卡片按静态流排到 `.am-app` 末尾(视口之外,鼠标一挪过去就收),
// 编辑面板的 z-index 不生效、被自己 z119 的遮罩盖住(一点输入框就关)。unified-page.check 那条只用 DOM click,
// 不看几何,所以一直绿着漏过去。这里全部走**真鼠标 / 真键盘 + elementFromPoint**。
//
// 断言(?upage 短文 与 &upane 长文 两套壳):
//   LC1 卡片 computed position=fixed、落在视口内、贴着链接下沿、elementFromPoint 命中卡片自己
//   LC2 真指针从链接挪进卡片,卡片不收
//   LC3 真鼠标点「编辑」→ 面板 fixed;链接输入框中心 elementFromPoint 命中输入框本身(不是遮罩);真点击后面板还在
//   LC4 改地址按 Enter 即保存(form 提交)→ 落盘带新地址;Esc 关闭面板且不写盘
//   LC5 页面滚动 → 卡片收起(fixed 坐标是悬停那一刻的,滚走了不能钉在原处)
//   L1~L5 链接末尾接着输入不并进链接(I-04):键盘 / 输入规则现场成链 / 交界处 / CDP 输入法 / 粘贴
//   M1~M3 本地 md 链接(L-07):点击走库内打开(不补 https)、悬停卡「打开」同路、键入落盘逐字
//   LK1~LK5 卡片动作作用于整条链接(I-07):`[**粗**普通](url)` 悬停半条也改 / 摘 / 删整条;只改地址不丢 code / 斜体 / 粗体
//   HP1 双链悬停预览按链接所在笔记就近解析同名笔记(L-10):预览的就是点击会打开的那篇
//   NT1~NT5 双链 / 库内 md 链接按鼠标键分流(L-11):右键不跳转不弹块菜单;中键、⌘(非 mac 为 Ctrl)+点击 → 新标签页
//   FL1~FL6 打开光标处链接(L-20):Alt+Enter 跟随 / Alt+Shift+Enter 新标签页;不在链接上不吞键;命令面板那条作用于最近聚焦的编辑器
//   LI1~LI3 卡片 / 编辑面板文案跟界面语言(C-14):英文界面全英文,切中文当场跟上
//   AU1~AU5 手打裸 URL(I-13):空格收尾成链且落盘裸 URL;空段里键入 URL 不抢跑成书签卡、离开才成卡;
//          全角标点收尾成链、落盘 `<url>`(裸写会把 `。后` 吞进地址);ASCII 句末标点留在链接外;行内代码 / 字母后不成链
//
// 用法:node scripts/e2e-editor.cjs --check=linkcard(或 npm run check:linkcard)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html;ONLY=LK 只跑某几组
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
const SHOT = process.env.LINKCARD_SHOT_DIR || ''
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, md, flags, locale = 'zh-CN') {
  const p = await browser.newPage({ locale, viewport: { width: 1200, height: 900 } })
  p.__errs = []
  p.on('pageerror', (e) => p.__errs.push(e.message))
  await p.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForTimeout(500)
  return p
}
const linkRect = (p) => p.evaluate((s) => {
  const r = document.querySelector(s + ' a[href]').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom }
}, PM)
const cardInfo = (p) => p.evaluate(() => {
  const c = document.querySelector('.amx-linkcard')
  if (!c) return null
  const r = c.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return { pos: getComputedStyle(c).position, x: r.left, y: r.top, w: r.width, h: r.height, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, hitSelf: !!hit?.closest('.amx-linkcard') }
})
const lastWrite = (p) => p.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
const writeCount = (p) => p.evaluate(() => window.__upage.writes.length)

/** 真鼠标悬停链接,等 500ms 出卡。 */
async function hoverLink(p) {
  const a = await linkRect(p)
  await p.mouse.move(a.x + a.w / 2, a.y + a.h / 2, { steps: 4 })
  await p.waitForTimeout(900)
  return a
}

async function shell(browser, label, md, flags) {
  const p = await open(browser, md, flags)
  const a = await hoverLink(p)
  const c = await cardInfo(p)
  check(`LC1 ${label} 卡片出现且 position=fixed`, !!c && c.pos === 'fixed', JSON.stringify(c))
  check(`LC1 ${label} 卡片在视口内、贴链接下沿`, !!c && c.inView && c.y >= a.bottom - 1 && c.y <= a.bottom + 24 && Math.abs(c.x - a.x) <= 24,
    JSON.stringify({ link: a, card: c && { x: c.x, y: c.y } }))
  check(`LC1 ${label} elementFromPoint 命中卡片自己`, !!c && c.hitSelf)
  if (SHOT && c) await p.screenshot({ path: path.join(SHOT, `linkcard-hover${flags.replace(/&/g, '_')}.png`) })
  if (!c) { await p.close(); return }
  // LC2 真指针挪进卡片
  await p.mouse.move(c.x + 20, c.y + c.h / 2, { steps: 12 })
  await p.waitForTimeout(450)
  check(`LC2 ${label} 真指针从链接挪进卡片,卡片不收`, !!(await cardInfo(p)))
  // LC3 真鼠标点「编辑」
  const btn = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '编辑')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!btn) { check(`LC3 ${label} 卡片上有「编辑」`, false); await p.close(); return }
  await p.mouse.click(btn.x, btn.y)
  await p.waitForTimeout(300)
  const ed = await p.evaluate(() => {
    const d = document.querySelector('.amx-linkedit')
    if (!d) return null
    const inp = d.querySelectorAll('input')[1]
    const r = inp.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    return { pos: getComputedStyle(d).position, cx, cy, hitInput: document.elementFromPoint(cx, cy) === inp }
  })
  check(`LC3 ${label} 编辑面板 position=fixed 且链接输入框没被遮罩盖住`, !!ed && ed.pos === 'fixed' && ed.hitInput, JSON.stringify(ed))
  if (SHOT && ed) await p.screenshot({ path: path.join(SHOT, `linkcard-edit${flags.replace(/&/g, '_')}.png`) })
  if (!ed) { await p.close(); return }
  await p.mouse.click(ed.cx, ed.cy)
  await p.waitForTimeout(200)
  check(`LC3 ${label} 真点击链接输入框后面板还在`, !!(await p.$('.amx-linkedit')))
  // LC4 改地址 + Enter
  const before = await writeCount(p)
  await p.keyboard.press('Meta+a')
  await p.keyboard.type('https://new.example/x', { delay: 10 })
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1400)
  const md1 = await lastWrite(p)
  check(`LC4 ${label} Enter 提交:面板关闭、落盘带新地址`, !(await p.$('.amx-linkedit')) && (await writeCount(p)) > before && /\]\(https:\/\/new\.example\/x\)/.test(md1 || ''),
    JSON.stringify((md1 || '').slice(0, 120)))
  // Esc:再开一次面板,按 Esc
  await p.mouse.move(5, 5)
  await p.waitForTimeout(400)
  await hoverLink(p)
  const btn2 = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '编辑')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (btn2) {
    const card = await cardInfo(p)
    await p.mouse.move(card.x + 20, card.y + card.h / 2, { steps: 8 })
    await p.mouse.click(btn2.x, btn2.y)
    await p.waitForTimeout(250)
    const opened = !!(await p.$('.amx-linkedit'))
    const n0 = await writeCount(p)
    await p.keyboard.type('zz')
    await p.keyboard.press('Escape')
    await p.waitForTimeout(1300)
    check(`LC4 ${label} Esc 关闭面板且不写盘`, opened && !(await p.$('.amx-linkedit')) && (await writeCount(p)) === n0, `opened=${opened}`)
  } else check(`LC4 ${label} Esc 关闭面板且不写盘`, false, '第二次悬停没出卡')
  check(`LC ${label} pageerror=0`, p.__errs.length === 0, p.__errs.join(' | ').slice(0, 200))
  await p.close()
}

async function scrollCloses(browser) {
  const long = Array.from({ length: 40 }, (_, i) => `填充段 ${i}。`)
  // &upane = 生产壳(滚动盒是 .amx-pane);?upage 台架页本身滚不动,测不出。
  const p = await open(browser, ['# 标题', '段乙,带一个 [链接](https://example.com) 在这。', ...long].join('\n\n') + '\n', '&upane')
  const a = await hoverLink(p)
  const had = !!(await cardInfo(p))
  await p.mouse.wheel(0, 300)
  await p.waitForTimeout(400)
  check('LC5 &upane 滚动 → 卡片收起', had && !(await cardInfo(p)), `had=${had} link=${JSON.stringify(a)}`)
  await p.close()
}

// ── L 组(I-04):链接末尾接着输入,新字不许并进链接 —— 键盘 / 输入规则现场成链 / 交界处 / CDP 输入法 / 粘贴 ──
// 药在 refDefinitions.ts 的 linkWithRefSchema `inclusive: false`(+ linkInputRule 清 stored mark)。
async function typingAfterLink(browser) {
  // 「光标到首段末尾」要等 **PM 自己**认了再往下走(驱动竞态,不是产品病):点击与 Cmd+→ 都是浏览器原生移光标,
  // PM 要等 Chrome 派发 selectionchange 才读到新选区(headless 下常晚一帧);紧跟着的 Enter 走 PM keymap、
  // 用的是 state.selection —— 没等这一拍,Enter 就在旧位置劈段:Cmd+→ 丢失 → 新字挤到「起始」前面
  // (`# T\n\n\n\nx … y起始`),点击也没同步时甚至劈在标题前。L2 在引入它的包里就有 2~4 成红率,
  // 合包 bisect 单跑撞上才像「fidelity 包弄坏的」;与 e2e:editor 的 T42(Home 紧跟 Tab)同一机理。
  // 只等不改断言;等不到 = 光标真没到位,记一条 FAIL 讲清楚,不让它落成一条莫名其妙的落盘断言。
  const pmCaretInFirstPara = (p, atEnd) => p.waitForFunction(([s, atEnd]) => {
    const v = window.__upage?.probe?.view?.()
    if (!v) return false
    const $h = v.state.selection.$head
    if ($h.depth < 1 || v.nodeDOM($h.before()) !== document.querySelector(s + ' > p')) return false
    return !atEnd || $h.parentOffset === $h.parent.content.size
  }, [PM, atEnd], { timeout: 3000 }).then(() => true, () => false)
  const clickEndOfPara = async (p) => {
    const b = await (await p.$(`${PM} > p`)).boundingBox()
    await p.mouse.click(b.x + 3, b.y + b.height / 2)
    if (!(await pmCaretInFirstPara(p, false))) check('L 前置 点击后 PM 选区进了首段', false)
    await p.keyboard.press('Meta+ArrowRight')
    if (!(await pmCaretInFirstPara(p, true))) check('L 前置 Cmd+→ 后 PM 选区在首段末尾', false)
  }
  const firstPara = (p) => p.evaluate((s) => document.querySelector(s + ' > p').innerHTML, PM)
  const saved = async (p) => { await p.waitForTimeout(1400); return (await lastWrite(p)) || '' }
  // L1 已有链接在行末,End 后打字
  let p = await open(browser, '# T\n\nx [文字](https://example.com)\n', '')
  await clickEndOfPara(p)
  await p.keyboard.type(' 后', { delay: 40 })
  let md = await saved(p)
  check('L1 行末链接后键入:新字不进链接', md.includes('x [文字](https://example.com) 后\n'), JSON.stringify(md))
  await p.close()
  // L2 输入规则现场生成链接后继续打字
  p = await open(browser, '# T\n\n起始\n', '')
  await clickEndOfPara(p)
  await p.keyboard.press('Enter')
  await p.keyboard.type('x [文字](example.com) y', { delay: 40 })
  md = await saved(p)
  check('L2 `[文字](地址)` 现场成链后接着打字:不进链接', md.includes('x [文字](https://example.com) y\n'), JSON.stringify(md))
  await p.close()
  // L3「链接|后文」交界处打字
  p = await open(browser, '# T\n\n[文字](https://example.com)尾\n', '')
  await clickEndOfPara(p)
  await p.keyboard.press('ArrowLeft')
  await p.keyboard.type('X', { delay: 40 })
  md = await saved(p)
  check('L3 链接与后文交界处打字:不进链接', md.includes('[文字](https://example.com)X尾\n'), JSON.stringify(md))
  await p.close()
  // L4 输入法(CDP 真组合;合成键的 isComposing 到不了 React)
  p = await open(browser, '# T\n\nx [文字](https://example.com)\n', '')
  await clickEndOfPara(p)
  await p.waitForTimeout(150)
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.imeSetComposition', { text: 'hou', selectionStart: 3, selectionEnd: 3 })
  await p.waitForTimeout(120)
  await cdp.send('Input.insertText', { text: '后面' })
  md = await saved(p)
  check('L4 链接末尾用输入法上屏:不进链接', md.includes('x [文字](https://example.com)后面\n'), JSON.stringify(md) + ' dom=' + (await firstPara(p)))
  await p.close()
  // L5 粘贴纯文本到链接末尾
  p = await open(browser, '# T\n\nx [文字](https://example.com)\n', '')
  await clickEndOfPara(p)
  await p.waitForTimeout(150)
  await p.evaluate((s) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '粘贴')
    document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, PM)
  md = await saved(p)
  check('L5 链接末尾粘贴纯文本:不进链接', md.includes('x [文字](https://example.com)粘贴\n'), JSON.stringify(md))
  await p.close()
}

// ── M 组(L-07):本地 md 链接 `[t](笔记.md)` —— 不补成 `https://笔记.md`,点击走与 `[[ ]]` 同一条打开路径 ──
// 药在 linkHref.ts(normalizeHref 认单段文件名 + hrefKind / noteLinkTarget)与 MarkdownBlock.handleLinkClick 的分流。
// 附件(report.pdf)归容器 amadeusViews 的 openAttachment 开,台架没有那层容器 —— 这里只证编辑器**不再**把它当外链开。
/** 拿 app 自己那份 pageStore 模块:vite HMR 后 app 用的是带 `?t=` 的 URL,裸路径 import 会得到另一个实例(spy 装不上)。 */
const spyWiki = (p) => p.evaluate(async () => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/amadeus\/store\/pageStore\.ts/.test(n)) || '/src/amadeus/store/pageStore.ts'
  const m = await import(url)
  m.usePageStore.setState({ pages: ['Note.md', 'sub/Other.md', 'My Note.md', 'Unified.md'] })
  window.__opened = []
  m.usePageStore.setState({ openWikiLink: (n, src) => { window.__opened.push({ n, src }) } })
  window.__wopen = []
  window.open = (u) => { window.__wopen.push(u); return null }
})
async function mdLinks(browser) {
  const md = '# T\n\n见 [读我](Note.md) 和 [子](./sub/Other.md) 和 [外](https://example.com) 和 [空格](My%20Note.md) 和 [附](report.pdf)\n'
  let p = await open(browser, md, '')
  await spyWiki(p)
  const anchors = await p.evaluate((s) => [...document.querySelectorAll(s + ' a[href]')].map((a) => {
    const r = a.getBoundingClientRect()
    return { href: a.getAttribute('href'), x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }), PM)
  const got = {}
  for (const a of anchors) {
    const [o0, w0] = await p.evaluate(() => [window.__opened.length, window.__wopen.length])
    await p.mouse.click(a.x, a.y)
    await p.waitForTimeout(250)
    got[a.href] = await p.evaluate(([o0, w0]) => ({ wiki: window.__opened.slice(o0).map((x) => x.n), open: window.__wopen.slice(w0) }), [o0, w0])
  }
  const want = {
    'Note.md': { wiki: ['Note.md'], open: [] },
    './sub/Other.md': { wiki: ['sub/Other.md'], open: [] },
    'https://example.com': { wiki: [], open: ['https://example.com'] },
    'My%20Note.md': { wiki: ['My Note.md'], open: [] },
    'report.pdf': { wiki: [], open: [] },
  }
  for (const [href, w] of Object.entries(want))
    check(`M1 点击 [..](${href}) → ${w.wiki.length ? '库内打开 ' + w.wiki[0] : w.open.length ? '外链 ' + w.open[0] : '编辑器不开(附件归容器)'}`, JSON.stringify(got[href]) === JSON.stringify(w), JSON.stringify(got[href]))
  check('M1 点击本地链接零写盘', (await writeCount(p)) === 0)
  // 悬停卡的「打开」(host 按钮)同路
  await p.mouse.move(5, 5)
  await p.waitForTimeout(300)
  const a0 = anchors[0]
  await p.mouse.move(a0.x, a0.y, { steps: 4 })
  await p.waitForTimeout(900)
  const hostBtn = await p.evaluate(() => { const b = document.querySelector('.amx-linkcard .amx-linkcard-host'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  if (hostBtn) {
    const [o0, w0] = await p.evaluate(() => [window.__opened.length, window.__wopen.length])
    await p.mouse.move(hostBtn.x, hostBtn.y, { steps: 8 })
    await p.mouse.click(hostBtn.x, hostBtn.y)
    await p.waitForTimeout(250)
    const r = await p.evaluate(([o0, w0]) => ({ wiki: window.__opened.slice(o0).map((x) => x.n), open: window.__wopen.slice(w0) }), [o0, w0])
    check('M2 悬停卡「打开」库内笔记链接 → 库内打开,不当外链', JSON.stringify(r) === JSON.stringify({ wiki: ['Note.md'], open: [] }), JSON.stringify(r))
  } else check('M2 悬停卡「打开」库内笔记链接 → 库内打开,不当外链', false, '没出卡')
  await p.close()
  // M3 键入即落盘:地址逐字保留,不补 https://
  p = await open(browser, '# T\n\nx\n', '')
  const b = await (await p.$(`${PM} > p`)).boundingBox()
  await p.mouse.click(b.x + b.width - 2, b.y + b.height / 2)
  await p.keyboard.press('Meta+ArrowRight')
  await p.keyboard.type(' [读我](Note.md) 与 [附](report.pdf) ', { delay: 20 })
  await p.waitForTimeout(1400)
  const saved = (await lastWrite(p)) || ''
  check('M3 键入 `[读我](Note.md)` / `[附](report.pdf)`:落盘逐字,不补 https://', saved.includes('[读我](Note.md)') && saved.includes('[附](report.pdf)') && !saved.includes('https://'), JSON.stringify(saved))
  await p.close()
}

// ── AU 组(I-13):手打裸 URL。药在 blocks/markdown/autolink.ts(输入规则 + link 落盘 handler)与
// unified/embedLayer.tsx 的 pendingPos(键入中的「整段一个 URL」不交给书签卡)。
async function bareUrlTyping(browser) {
  /** 光标放到含 needle 的段末(直接设 PM 选区,再等一帧让 DOM 选区跟上 —— 别撞 selectionchange 竞态)。 */
  const caretEnd = (p, needle) => p.evaluate((needle) => {
    const view = window.__upage.probe.view()
    let at = -1
    view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.textContent.includes(needle)) at = pos + n.nodeSize - 1
      return at < 0
    })
    let proto = Object.getPrototypeOf(view.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    view.focus()
    view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(at))))
    return at >= 0
  }, needle).then(async (ok) => { await p.waitForTimeout(80); return ok })
  const links = (p) => p.evaluate((s) => [...document.querySelectorAll(s + ' a[href]')].map((a) => `${a.getAttribute('href')}|${a.textContent}`), PM)
  const saved = async (p) => { await p.waitForTimeout(1400); return (await lastWrite(p)) || '' }
  const headPara = (p) => p.evaluate(() => { const v = window.__upage.probe.view(); return v.state.selection.$head.parent.textContent })
  const cards = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-bm')].map((a) => a.getAttribute('href')))

  // AU1 句中键入,空格收尾成链;落盘裸 URL(不是 `<url>`)
  let p = await open(browser, '# T\n\n起始\n', '')
  await caretEnd(p, '起始')
  await p.keyboard.press('Enter')
  await p.keyboard.type('see https://example.com/a now', { delay: 15 })
  let md = await saved(p)
  let ls = await links(p)
  check('AU1 句中键入裸 URL + 空格:成链,落盘仍是裸 URL', ls.includes('https://example.com/a|https://example.com/a') && md.includes('\nsee https://example.com/a now\n') && !md.includes('<https'),
    JSON.stringify({ ls, md }))
  await p.close()

  // AU2 空段里键入 URL:打到一半不成书签卡、光标不被弹走;回车离开后才成卡
  p = await open(browser, '# T\n\n起始\n', '')
  await caretEnd(p, '起始')
  await p.keyboard.press('Enter')
  await p.keyboard.type('https://f', { delay: 15 })
  const mid = { cards: await cards(p), head: await headPara(p) }
  await p.keyboard.type('oo.com/b', { delay: 15 })
  const full = { cards: await cards(p), head: await headPara(p) }
  await p.keyboard.press('Enter')
  await p.waitForTimeout(300)
  const after = await cards(p)
  md = await saved(p)
  check('AU2 空段键入 URL:打到 https://f 不成卡、光标还在该段', mid.cards.length === 0 && mid.head === 'https://f', JSON.stringify(mid))
  check('AU2 空段键入 URL:写完也不抢跑成卡', full.cards.length === 0 && full.head === 'https://foo.com/b', JSON.stringify(full))
  check('AU2 回车离开后该段落成书签卡,落盘整行裸 URL', after.includes('https://foo.com/b') && md.includes('\nhttps://foo.com/b\n'), JSON.stringify({ after, md }))
  await p.close()

  // AU3 全角标点收尾:成链(不含「。」);落盘 `<url>` —— 裸写的话 gfm 会把 `。后` 吞进地址
  p = await open(browser, '# T\n\n起始\n', '')
  await caretEnd(p, '起始')
  await p.keyboard.type('见 https://x.com/p。后', { delay: 15 })
  md = await saved(p)
  ls = await links(p)
  check('AU3 全角标点收尾成链,落盘 `<url>`。', ls.includes('https://x.com/p|https://x.com/p') && md.includes('起始见 <https://x.com/p>。后\n'), JSON.stringify({ ls, md }))
  await p.close()

  // AU4 句末 ASCII 标点留在链接外(与重开时 gfm 认出的边界一致);落盘裸 URL
  p = await open(browser, '# T\n\n起始\n', '')
  await caretEnd(p, '起始')
  await p.keyboard.type(' go https://x.com/q. ok', { delay: 15 })
  md = await saved(p)
  ls = await links(p)
  check('AU4 URL 后的句号不进链接,落盘裸 URL', ls.includes('https://x.com/q|https://x.com/q') && md.includes('起始 go https://x.com/q. ok\n'), JSON.stringify({ ls, md }))
  await p.close()

  // AU5 不该成链的:行内代码里(未闭合的反引号之后)、紧贴 ASCII 字母(gfm 同样不认)
  p = await open(browser, '# T\n\n起始\n', '')
  await caretEnd(p, '起始')
  await p.keyboard.type(' `https://x.com/c ok` abchttps://x.com/d ok', { delay: 15 })
  md = await saved(p)
  ls = await links(p)
  check('AU5 行内代码里 / 紧贴字母的 URL 不成链', ls.length === 0 && md.includes('`https://x.com/c ok`'), JSON.stringify({ ls, md }))
  await p.close()
}

// ── LK 组(I-07):卡片的「编辑 / 移除 / 删除」作用于**整条**链接,不是悬停到的那一段;只改地址不丢 code / 斜体 / 粗体 ──
// 药在 unified/linkCard.tsx 的 linkRangeAt(沿同一个 link mark 扩到相邻行内节点)与 rewrite(只改地址 = removeMark/addMark)。
async function wholeLink(browser) {
  /** 真鼠标悬停到 needle 那几个字上(DOM Range 取真实矩形),等 500ms 出卡。 */
  const hoverOn = async (p, needle) => {
    const pt = await p.evaluate(({ PM, needle }) => {
      const w = document.createTreeWalker(document.querySelector(PM), NodeFilter.SHOW_TEXT)
      while (w.nextNode()) {
        const n = w.currentNode
        const i = n.data.indexOf(needle)
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }
      }
      return null
    }, { PM, needle })
    await p.mouse.move(5, 5)
    await p.waitForTimeout(100)
    await p.mouse.move(pt.x, pt.y, { steps: 3 })
    await p.waitForTimeout(900)
  }
  const cardBtn = (p, label) => p.evaluate((label) => { const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === label); if (!b) return false; b.click(); return true }, label)
  const body = async (p) => { await p.waitForTimeout(1400); return ((await lastWrite(p)) || '').split('\n').filter(Boolean).slice(1).join(' | ') }
  /** 首段文档模型:每个文本节点 `文字[mark,…]`,link 带地址。断言看模型而不是 md 串 —— 序列化器把外层格式
   *  放在链接外面(`[**粗**普通](u)` 重写成 `**[粗](u)**[普通](u)`,同一个 link mark、语义不变),那是另一回事。 */
  const para = (p) => p.evaluate(() => {
    const out = []
    const v = window.__upage.probe.view()
    let first = null
    v.state.doc.forEach((n) => { if (!first && n.type.name === 'paragraph') first = n })
    first.forEach((n) => { if (n.isText) out.push(`${n.text}[${n.marks.map((m) => m.type.name === 'link' ? `link:${m.attrs.href}` : m.type.name).join(',')}]`) })
    return out.join(' ')
  })
  /** 开编辑面板 → (可选)改文字 / 改地址 → 保存,返回 [面板里初始的两个值, 落盘正文, 首段模型]。 */
  const editVia = async (md, needle, { text, href }) => {
    const p = await open(browser, md, '')
    await hoverOn(p, needle)
    await cardBtn(p, '编辑')
    await p.waitForTimeout(250)
    const ins = await p.$$('.amx-linkedit input')
    const init = ins.length === 2 ? [await ins[0].inputValue(), await ins[1].inputValue()] : null
    if (init && text != null) await ins[0].fill(text)
    if (init && href != null) await ins[1].fill(href)
    await p.evaluate(() => document.querySelector('.amx-linkedit button.primary')?.click())
    const out = await body(p)
    const doc = await para(p)
    await p.close()
    return { init, out, doc }
  }
  const MIX = '# T\n\nalpha [**粗**普通](https://example.com) omega\n'
  let r = await editVia(MIX, '普通', { href: 'https://new.com' })
  check('LK1 悬停半条:编辑框里是整条链接的文字', JSON.stringify(r.init) === JSON.stringify(['粗普通', 'https://example.com']), JSON.stringify(r.init))
  check('LK2 悬停半条只改地址:整条换地址(不劈成新旧两条)、粗体留着',
    r.doc === 'alpha [] 粗[strong,link:https://new.com] 普通[link:https://new.com]  omega[]' && !r.out.includes('example.com'), JSON.stringify(r))
  for (const [needle, label, want] of [['普通', '移除链接', 'alpha **粗**普通 omega'], ['粗', '删除', 'alpha  omega']]) {
    const p = await open(browser, MIX, '')
    await hoverOn(p, needle)
    await cardBtn(p, label)
    const out = await body(p)
    check(`LK3 悬停「${needle}」点「${label}」:作用于整条`, out === want, JSON.stringify(out))
    await p.close()
  }
  r = await editVia('# T\n\nsee [`useEffect`](https://a.dev/x) now\n', 'useEffect', { href: 'https://b.dev/y' })
  check('LK4 只改地址不丢行内代码', r.out === 'see [`useEffect`](https://b.dev/y) now', JSON.stringify(r))
  r = await editVia('# T\n\nsee [*斜体链接*](https://a.dev/x) now\n', '斜体链接', { href: 'https://b.dev/y' })
  check('LK4 只改地址不丢斜体', r.doc.includes('斜体链接[emphasis,link:https://b.dev/y]') && !r.out.includes('a.dev'), JSON.stringify(r))
  r = await editVia('# T\n\nsee [**全粗**](https://a.dev/x) now\n', '全粗', { text: '新名' })
  check('LK5 改文字:整条都有的格式(粗体)留着', r.doc.includes('新名[strong,link:https://a.dev/x]'), JSON.stringify(r))
}

// ── HP 组(L-10):双链悬停预览按**链接所在笔记**就近解析 —— 同名笔记 a/Note、b/Note,在 b/Src 里悬停 [[Note]]
// 预览的必须是 b/Note(= 点击打开的那篇)。药在 MarkdownBlock 钉的 data-amx-src 与 WikiHoverPreview 的读法。
// 台架没挂 AmadeusOverlays:照生产把 WikiHoverPreview 挂进页面(用 app 自己那份 react / react-dom 模块)。
async function hoverPreview(browser) {
  const p = await open(browser, '# T\n\nx\n', '')
  await p.evaluate(() => window.__upage.switchFile('b/Src.md', '# Src\n\n链接 [[Note]] 结束\n\n尾\n'))
  await p.waitForTimeout(800)
  await p.evaluate(async () => {
    window.__pageStore.setState({ pages: ['a/Note.md', 'b/Note.md', 'b/Src.md'], files: [] })
    window.__readReq = []
    window.amadeus.readPage = (path) => {
      window.__readReq.push(path)
      return Promise.resolve({ manifest: { root: { children: [{ columns: [{ children: [{ ref: 'b1' }] }] }] } }, blocks: { b1: { content: 'PREVIEW OF ' + path } } })
    }
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
    const React = await import(urls.find((n) => /deps\/react\.js/.test(n)))
    const RDC = await import(urls.find((n) => /deps\/react-dom_client\.js/.test(n)))
    const hoverUrl = urls.find((n) => /\/src\/amadeus\/components\/WikiHoverPreview\.tsx/.test(n)) || '/src/amadeus/components/WikiHoverPreview.tsx'
    const { WikiHoverPreview } = await import(hoverUrl)
    const host = document.createElement('div')
    host.className = 'amadeus-root am-app'
    document.body.appendChild(host)
    ;(RDC.createRoot || RDC.default.createRoot)(host).render((React.createElement || React.default.createElement)(WikiHoverPreview))
  })
  // 光标挪到别的段,让链接那行渲染成双链部件
  const tail = await (await p.$(`${PM} > p:last-of-type`)).boundingBox()
  await p.mouse.click(tail.x + tail.width - 2, tail.y + tail.height / 2)
  await p.waitForTimeout(300)
  const w = await p.evaluate((s) => { const e = document.querySelector(s + ' .wikilink[data-wiki]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }, PM)
  if (!w) { check('HP 前置 [[Note]] 渲染成双链部件', false); await p.close(); return }
  await p.mouse.move(5, 5)
  await p.mouse.move(w.x, w.y, { steps: 3 })
  await p.waitForTimeout(1000)
  const got = await p.evaluate(() => ({ req: window.__readReq, body: document.querySelector('.amx-hoverprev-body')?.textContent ?? null }))
  check('HP1 同名笔记:悬停预览读的是链接所在目录那篇(b/Note.md)', JSON.stringify(got.req) === '["b/Note.md"]' && /PREVIEW OF b\/Note\.md/.test(got.body || ''), JSON.stringify(got))
  await p.close()
}

// ── NT 组(L-11):链接按鼠标键分流 —— 无修饰左键原地开;⌘(非 mac 为 Ctrl)+左键、中键 → 新标签页(openWikiLink 第三参
// {newTab:true});右键(含 mac 的 Ctrl+点击)不跳转、不弹块菜单、不吞系统菜单。双链部件与库内 md 链接两种都测。
// 药在 wikilink.ts 部件的 mousedown / contextmenu 与 MarkdownBlock.handleLinkClick;store 那半在 pageStore.wikiNewTab.test。
async function newTabClicks(browser) {
  const p = await open(browser, '# T\n\n链接 [[Alpha]] 与 [读我](Note.md) 结束\n\n尾段\n', '')
  await p.evaluate(() => {
    window.__pageStore.setState({ pages: ['Alpha.md', 'Note.md', 'Unified.md'], files: [] })
    window.__opened = []
    window.__pageStore.setState({ openWikiLink: (n, src, o) => { window.__opened.push({ n, newTab: !!(o && o.newTab) }) } })
    window.__wopen = []
    window.open = (u) => { window.__wopen.push(u); return null }
    window.addEventListener('contextmenu', (e) => { window.__ctxEv = e }, true)
  })
  const isMac = await p.evaluate(() => /Mac/.test(navigator.platform))
  const tail = await (await p.$(`${PM} > p:last-of-type`)).boundingBox()
  const at = async (sel) => {
    await p.mouse.click(tail.x + tail.width - 2, tail.y + tail.height / 2) // 光标离开链接那行:双链渲染成部件
    await p.waitForTimeout(200)
    return p.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }, sel)
  }
  const got = async (fn) => {
    const [o0, w0] = await p.evaluate(() => [window.__opened.length, window.__wopen.length])
    await p.evaluate(() => { window.__ctxEv = null })
    await fn()
    await p.waitForTimeout(250)
    const r = await p.evaluate(([o0, w0]) => ({
      opened: window.__opened.slice(o0), wopen: window.__wopen.slice(w0),
      ctxPrevented: window.__ctxEv ? window.__ctxEv.defaultPrevented : null,
      menu: document.querySelectorAll('.unified-block-menu').length,
      nodeSel: window.__upage.probe.view().state.selection.toJSON().type === 'node',
    }), [o0, w0])
    await p.keyboard.press('Escape')
    return r
  }
  for (const [label, sel, name] of [['双链', `${PM} .wikilink[data-wiki]`, 'Alpha'], ['md 笔记链接', `${PM} a[href="Note.md"]`, 'Note.md']]) {
    let pt = await at(sel)
    if (!pt) { check(`NT 前置 ${label} 可点`, false); continue }
    let r = await got(() => p.mouse.click(pt.x, pt.y, { button: 'right' }))
    check(`NT1 ${label} 右键:不跳转、不弹块菜单、系统菜单不被吞`, r.opened.length === 0 && r.wopen.length === 0 && r.menu === 0 && !r.nodeSel && r.ctxPrevented === false, JSON.stringify(r))
    pt = await at(sel)
    r = await got(() => p.mouse.click(pt.x, pt.y, { button: 'middle' }))
    check(`NT2 ${label} 中键 → 新标签页`, JSON.stringify(r.opened) === JSON.stringify([{ n: name, newTab: true }]), JSON.stringify(r))
    pt = await at(sel)
    r = await got(async () => { await p.keyboard.down('Meta'); await p.mouse.click(pt.x, pt.y); await p.keyboard.up('Meta') })
    check(`NT3 ${label} ⌘+点击 → ${isMac ? '新标签页' : '(非 mac:不是 Mod,原地开)'}`, JSON.stringify(r.opened) === JSON.stringify([{ n: name, newTab: isMac }]), JSON.stringify(r))
    pt = await at(sel)
    r = await got(async () => { await p.keyboard.down('Control'); await p.mouse.click(pt.x, pt.y); await p.keyboard.up('Control') })
    check(`NT4 ${label} Ctrl+点击 → ${isMac ? '(mac 右键手势)不跳转' : '新标签页'}`, JSON.stringify(r.opened) === JSON.stringify(isMac ? [] : [{ n: name, newTab: true }]), JSON.stringify(r))
    pt = await at(sel)
    r = await got(() => p.mouse.click(pt.x, pt.y))
    check(`NT5 ${label} 无修饰左键 → 原地开(不带 newTab)`, JSON.stringify(r.opened) === JSON.stringify([{ n: name, newTab: false }]), JSON.stringify(r))
  }
  check('NT 零写盘', (await writeCount(p)) === 0)
  await p.close()
}

// ── FL 组(L-20):「打开光标处链接」—— 光标在 `[[…]]` / md 链接上按 Alt+Enter 跟随、Alt+Shift+Enter 新标签页;
// 不在链接上不吞键、不改文档;命令面板那条(焦点已离开正文)作用在最近聚焦的编辑器上。
// 药在 blocks/markdown/linkFollow.ts + MarkdownBlock.handleKeyDown;命令定义在 unified/linkCommands.ts。
async function followAtCursor(browser) {
  const seed = '# T\n\nsee [[Alpha#Sec|al]] and [ext](https://example.com) and [读我](Note.md) end\n\nplain line\n'
  const p = await open(browser, seed, '')
  await p.evaluate(() => {
    window.__pageStore.setState({ pages: ['Alpha.md', 'Note.md', 'Unified.md'], files: [] })
    window.__opened = []
    window.__pageStore.setState({ openWikiLink: (n, src, o) => { window.__opened.push({ n, newTab: !!(o && o.newTab) }) } })
    window.__wopen = []
    window.open = (u) => { window.__wopen.push(u); return null }
  })
  /** 光标放进含 needle 的文字里(needle 之后第 k 个字),直接设 PM 选区再等一帧(别撞 selectionchange 竞态)。 */
  const caretIn = (needle, k) => p.evaluate(([needle, k]) => {
    const view = window.__upage.probe.view()
    let at = -1
    view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text.includes(needle)) at = pos + n.text.indexOf(needle) + k
      return at < 0
    })
    let proto = Object.getPrototypeOf(view.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    view.focus()
    view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(at))))
    return at >= 0
  }, [needle, k]).then(async (ok) => { await p.waitForTimeout(120); return ok })
  const got = async (fn) => {
    const [o0, w0, d0] = await p.evaluate(() => [window.__opened.length, window.__wopen.length, window.__upage.probe.view().state.doc.textContent])
    await fn()
    await p.waitForTimeout(250)
    return p.evaluate(([o0, w0, d0]) => ({ opened: window.__opened.slice(o0), wopen: window.__wopen.slice(w0), docSame: window.__upage.probe.view().state.doc.textContent === d0 }), [o0, w0, d0])
  }
  let ok = await caretIn('Alpha', 2)
  let r = await got(() => p.keyboard.press('Alt+Enter'))
  check('FL1 光标在 [[Alpha#Sec|al]] 里 Alt+Enter → 跟随(带锚点、剥别名)', ok && JSON.stringify(r.opened) === '[{"n":"Alpha#Sec","newTab":false}]' && r.docSame, JSON.stringify(r))
  ok = await caretIn('Alpha', 2)
  r = await got(() => p.keyboard.press('Alt+Shift+Enter'))
  check('FL2 Alt+Shift+Enter → 新标签页', ok && JSON.stringify(r.opened) === '[{"n":"Alpha#Sec","newTab":true}]' && r.docSame, JSON.stringify(r))
  ok = await caretIn('ext', 1)
  r = await got(() => p.keyboard.press('Alt+Enter'))
  check('FL3 光标在外链 [ext](…) 上 Alt+Enter → 开外链', ok && JSON.stringify(r.wopen) === '["https://example.com"]' && r.opened.length === 0, JSON.stringify(r))
  ok = await caretIn('读我', 1)
  r = await got(() => p.keyboard.press('Alt+Enter'))
  check('FL4 光标在库内 md 链接 [读我](Note.md) 上 Alt+Enter → 库内打开', ok && JSON.stringify(r.opened) === '[{"n":"Note.md","newTab":false}]', JSON.stringify(r))
  ok = await caretIn('plain', 2)
  r = await got(() => p.keyboard.press('Alt+Enter'))
  check('FL5 光标不在链接上:什么都不开、文档不变', ok && r.opened.length === 0 && r.wopen.length === 0 && r.docSame, JSON.stringify(r))
  // 命令面板那条:焦点离开正文(点标题框)后执行命令,作用在最近聚焦的编辑器光标处
  ok = await caretIn('Alpha', 2)
  await p.click('.amx-title-input')
  await p.waitForTimeout(150)
  r = await got(() => p.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/amadeus\/unified\/linkCommands\.ts/.test(n)) || '/src/amadeus/unified/linkCommands.ts'
    const { LINK_COMMANDS } = await import(url)
    window.__titles = LINK_COMMANDS.map((c) => (typeof c.title === 'function' ? c.title() : c.title))
    await LINK_COMMANDS.find((c) => c.id === 'amadeus-follow-link').run()
  }))
  const titles = await p.evaluate(() => window.__titles)
  check('FL6 命令面板执行「打开光标处链接」(焦点不在正文)→ 最近聚焦编辑器的光标处', ok && JSON.stringify(r.opened) === '[{"n":"Alpha#Sec","newTab":false}]', JSON.stringify({ r, titles }))
  check('FL6 命令标题按语言求值(title 是函数)', JSON.stringify(titles) === JSON.stringify(['打开光标处链接', '在新标签页打开光标处链接']), JSON.stringify(titles))
  check('FL 零写盘', (await writeCount(p)) === 0)
  await p.close()
}

/** LI1–LI3 卡片与编辑面板的文案跟界面语言(C-14):以前是 JSX 裸中文,英文界面照样「复制链接 / 编辑 / 移除链接 / 删除」。 */
async function cardLocale(browser) {
  const HAN = /[\u4e00-\u9fa5]/
  const texts = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-linkcard button:not(.amx-linkcard-host), .amx-linkedit label, .amx-linkedit button')]
    .map((b) => (b.childNodes[0]?.nodeType === 3 ? b.childNodes[0].textContent : b.textContent).trim()))
  const p = await open(browser, '# T\n\nSee [example](https://example.com) here.\n', '', 'en-US')
  await hoverLink(p)
  const card = await texts(p)
  check('LI1 英文界面:悬停卡按钮是英文', card.join('|') === 'Copy link|Edit|Remove link|Delete', JSON.stringify(card))
  await p.evaluate(() => [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === 'Edit')?.click())
  await p.waitForTimeout(250)
  const panel = await texts(p)
  check('LI2 英文界面:编辑面板的标签与按钮是英文', panel.join('|') === 'Text|Link|Cancel|Save', JSON.stringify(panel))
  await p.evaluate(() => window.__upage.setLocale('zh'))
  await p.waitForTimeout(250)
  const zh = await texts(p)
  check('LI3 切到中文 → 开着的面板当场跟上', zh.join('|') === '文字|链接|取消|保存' && !panel.some((t) => HAN.test(t)), JSON.stringify(zh))
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const short = '# T\n\n' + Array.from({ length: 3 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  const long = '# T\n\n' + Array.from({ length: 40 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  // ONLY=LC,LK 只跑某几组(负对照时省时间):LC(两套壳 + 滚动收卡)/ L / M / AU / LK / HP / NT / FL / LI
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null
  const want = (g) => !only || only.includes(g)
  if (want('LC')) {
    await shell(browser, '?upage 短文', short, '')
    await shell(browser, '&upane 长文', long, '&upane')
    await scrollCloses(browser)
  }
  if (want('L')) await typingAfterLink(browser)
  if (want('M')) await mdLinks(browser)
  if (want('AU')) await bareUrlTyping(browser)
  if (want('LK')) await wholeLink(browser)
  if (want('HP')) await hoverPreview(browser)
  if (want('NT')) await newTabClicks(browser)
  if (want('FL')) await followAtCursor(browser)
  if (want('LI')) await cardLocale(browser)
  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
