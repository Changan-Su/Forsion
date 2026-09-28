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
//
// 用法:node scripts/e2e-editor.cjs --check=linkcard(或 npm run check:linkcard)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
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

async function open(browser, md, flags) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
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
  const clickEndOfPara = async (p) => {
    const b = await (await p.$(`${PM} > p`)).boundingBox()
    await p.mouse.click(b.x + 3, b.y + b.height / 2)
    await p.keyboard.press('Meta+ArrowRight')
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

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const short = '# T\n\n' + Array.from({ length: 3 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  const long = '# T\n\n' + Array.from({ length: 40 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  await shell(browser, '?upage 短文', short, '')
  await shell(browser, '&upane 长文', long, '&upane')
  await scrollCloses(browser)
  await typingAfterLink(browser)
  await mdLinks(browser)
  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
