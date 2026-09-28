// 大纲 / 标题锚 / 块锚跳转的落点(评审 2026-09-27 C-03;G4-01、L-05 复用同一实现 revealBlockAtTop)。
//
//  旧病:reveal 先 dispatch(scrollIntoView) 再 focus —— PM 只在 DOM 选区已在编辑器里时才滚,所以刚打开笔记 /
//  焦点在标题框里时**首击不动**;而且那是最小滚动:往下跳标题贴视口底边,往上跳停在 top:0 被 sticky 顶栏盖住。
//  现在:先 focus、只放选区,再显式把块顶滚到「滚动容器顶 + 顶栏高 + 12」。
//
//  用**真** lifecycle.unifiedRevealHeading / unifiedRevealBlock(与 UnifiedPage 同一模块实例),接一排仿右栏大纲
//  按钮(编辑器外的真按钮,真鼠标点击 = 焦点离开编辑器,与侧栏点击同形)。&upane = 生产壳(.amx-pane 滚动 + sticky 顶栏)。
//  O1 新开笔记、从没点过正文 → 首击往下跳即生效,标题顶落在顶栏下 12px
//  O2 同一条再点一次 → 幂等(scrollTop 不变)
//  O3 往上跳 → 标题不被顶栏盖住,同样落在顶栏下 12px
//  O4 焦点在标题输入框里 → 首击即生效
//  O5 先在正文点过(常规路径)→ 往下跳不再贴视口底边
//  O6 块锚 `^id`(unifiedRevealBlock)新开笔记首击即生效、贴顶
//  O7 端级 zoom 1.25 下落点不按比例过冲;引用条闪片(flash)正落在标题上
//
// 用法:npm run check:outlinereveal(= node scripts/e2e-editor.cjs --check=outline-reveal;worktree 里设 HARNESS_URL)
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
const GAP = 12
const TOL = 3
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const sec = (n) => `## 小节 ${n}\n\n` + Array.from({ length: 12 }, (_, i) => `第 ${n}-${i} 段填充文字填充文字。${n === 4 && i === 5 ? ' ^blk4' : ''}`).join('\n\n')
const MD = `# 文首\n\n${[1, 2, 3, 4, 5, 6].map(sec).join('\n\n')}\n`

async function open(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(MD)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction(() => !!(window.__upage && window.__upage.lifecycle), null, { timeout: 20000 })
  await p.waitForTimeout(400)
  // 仿右栏大纲:编辑器外的一排真按钮,点击走生产 lifecycle 接缝。
  await p.evaluate(() => {
    const lc = window.__upage.lifecycle
    const hs = lc.unifiedHeadings('Unified.md')
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;right:0;top:120px;width:150px;z-index:99;background:#eee;display:flex;flex-direction:column'
    hs.forEach((h, i) => {
      const b = document.createElement('button')
      b.className = 'fake-ol'
      b.dataset.t = h.text
      b.textContent = h.text
      b.onclick = () => { window.__ret = lc.unifiedRevealHeading('Unified.md', i, h.text) }
      box.appendChild(b)
    })
    document.body.appendChild(box)
  })
  return p
}

/** 目标块与顶栏的视口几何 + 滚动量。 */
const measure = (p, sel, text) => p.evaluate(([sel, text]) => {
  const pane = document.querySelector('.amx-pane')
  const el = [...document.querySelectorAll(sel)].find((x) => x.textContent.includes(text))
  const r = el.getBoundingClientRect()
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    bar: Math.round(document.querySelector('.amx-pane > .amx-toolbar').getBoundingClientRect().bottom),
    scroll: Math.round(pane.scrollTop), paneH: Math.round(pane.getBoundingClientRect().height),
  }
}, [sel, text])
const H = `${PM} h2`
const landed = (m) => Math.abs(m.top - (m.bar + GAP)) <= TOL
const clickOl = async (p, text) => { await p.click(`.fake-ol[data-t="${text}"]`); await p.waitForTimeout(250) }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    let p = await open(browser)
    await clickOl(p, '小节 4')
    const m1 = await measure(p, H, '小节 4')
    record('O1 新开笔记首击往下跳即生效,标题落在顶栏下 12px', m1.scroll > 0 && landed(m1), JSON.stringify(m1))
    await clickOl(p, '小节 4')
    const m2 = await measure(p, H, '小节 4')
    record('O2 同一条再点 → 幂等', Math.abs(m2.scroll - m1.scroll) <= 1 && landed(m2), JSON.stringify(m2))
    await clickOl(p, '小节 2')
    const m3 = await measure(p, H, '小节 2')
    record('O3 往上跳 → 不被顶栏盖住,落在顶栏下 12px', m3.top >= m3.bar && landed(m3), JSON.stringify(m3))
    await p.close()

    p = await open(browser)
    await p.click('.amx-title-input')
    await clickOl(p, '小节 3')
    const m4 = await measure(p, H, '小节 3')
    record('O4 焦点在标题输入框 → 首击即生效', m4.scroll > 0 && landed(m4), JSON.stringify(m4))
    await p.close()

    p = await open(browser)
    const at = await p.evaluate((s) => { const r = document.querySelector(s + ' p').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } }, PM)
    await p.mouse.click(at.x, at.y)
    await clickOl(p, '小节 5')
    const m5 = await measure(p, H, '小节 5')
    record('O5 先点过正文 → 往下跳不贴视口底边', landed(m5) && m5.bottom < m5.paneH - 100, JSON.stringify(m5))
    await p.close()

    p = await open(browser)
    const ok6 = await p.evaluate(() => window.__upage.lifecycle.unifiedRevealBlock('Unified.md', 'blk4'))
    await p.waitForTimeout(250)
    const m6 = await measure(p, `${PM} p`, '^blk4')
    record('O6 块锚 ^id 新开笔记首击即生效、贴顶', ok6 === true && m6.scroll > 0 && landed(m6), JSON.stringify({ ok6, ...m6 }))
    await p.close()

    p = await open(browser)
    await p.evaluate(() => { document.body.style.zoom = '1.25' })
    await p.waitForTimeout(200)
    await p.evaluate(() => {
      const lc = window.__upage.lifecycle
      const hs = lc.unifiedHeadings('Unified.md')
      const i = hs.findIndex((h) => h.text === '小节 5')
      lc.unifiedRevealHeading('Unified.md', i, hs[i].text, true)
    })
    await p.waitForTimeout(100)
    const m7 = await measure(p, H, '小节 5')
    const flash = await p.evaluate((s) => {
      const f = document.querySelectorAll('.am-citeflash')
      const h = [...document.querySelectorAll(s)].find((x) => x.textContent.includes('小节 5')).getBoundingClientRect()
      if (f.length !== 1) return { n: f.length }
      const r = f[0].getBoundingClientRect()
      return { n: 1, dTop: Math.round(r.top - h.top), dLeft: Math.round(r.left - h.left) }
    }, H)
    record('O7 端级 zoom 1.25:落点不过冲、闪片正落在标题上',
      landed(m7) && flash.n === 1 && Math.abs(flash.dTop + 2) <= TOL && Math.abs(flash.dLeft + 4) <= TOL,
      JSON.stringify({ ...m7, flash }))
    await p.close()
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
