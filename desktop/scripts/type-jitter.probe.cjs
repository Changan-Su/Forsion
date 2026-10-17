// Amadeus 打字 / 删除时页面上下抽动、折叠块抽动的观测探针(10-17 用户报)。
// 真 Chromium + 生产 UnifiedPage(harness ?upage&upane),逐帧采样:滚动容器 scrollTop、每个折叠块的
// top/height、光标所在行的 top。打字不换行时这几样都不该动;动了就打印哪一帧、谁动、动了多少。
// 跑:npm run check:typejitter   (HARNESS_URL 指向自己起的 vite;缺省 5173;IME=1 拼音组合输入,ZOOM=1.1 界面缩放)
// 负对照:10-17 修复前 = 折叠块上方每敲一字下方按钮整颗重建(10 字 60 次)+ 展开折叠块里回车时正文从 0 补间长回(必红)。
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const IME = !!process.env.IME // IME=1:中文拼音组合输入
const ZOOM = process.env.ZOOM || '' // ZOOM=1.1:body CSS zoom(用户 dev 是 110%)

function chromiumPath() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing', 'Chromium']) {
      const p = path.join(root, dir, 'chrome-mac-arm64', `${app}.app/Contents/MacOS/${app}`)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 Chromium')
}

const para = (i) => `第 ${i} 段 lorem ipsum dolor sit amet filler`
function seed() {
  const out = ['# 抽动探针', '']
  for (let i = 1; i <= 30; i++) out.push(para(i), '')
  out.push('> [!fold]- 收起的折叠块', '> 里面第一行', '> 里面第二行', '')
  out.push('紧跟折叠块的段落 A', '')
  out.push('> [!fold]+ 展开的折叠块', '> 展开正文一', '> 展开正文二', '')
  out.push('紧跟折叠块的段落 B', '')
  out.push('## 小标题', '', '- 列表一', '- 列表二', '', '```js', 'const x = 1', '```', '')
  for (let i = 31; i <= 60; i++) out.push(para(i), '')
  return out.join('\n')
}

async function install(page) {
  await page.evaluate((PM) => {
    const pm = document.querySelector(PM)
    let sc = pm.parentElement
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
    const w = window
    w.__jit = { frames: [], scrolls: [], muts: 0, sc: sc ? (sc.className || sc.tagName) : null, on: true }
    if (sc) sc.addEventListener('scroll', () => w.__jit.on && w.__jit.scrolls.push({ t: performance.now(), top: sc.scrollTop }), { passive: true })
    w.__jit.widgets = 0
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of [...m.removedNodes]) {
        if (n.nodeType !== 1) continue
        if (n.matches?.('blockquote.callout-fold') || n.querySelector?.('blockquote.callout-fold')) w.__jit.muts++
        if (n.matches?.('.callout-chevron,.callout-source,.callout-title-anchor')) w.__jit.widgets++
      }
    }).observe(pm, { childList: true, subtree: true })
    const tick = () => {
      if (!w.__jit.on) return
      const folds = [...pm.querySelectorAll('blockquote.callout-fold')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10] })
      const sel = getSelection()
      let caret = null
      if (sel && sel.rangeCount) { const rs = sel.getRangeAt(0).getClientRects(); const r = rs[rs.length - 1] || sel.getRangeAt(0).getBoundingClientRect(); caret = Math.round(r.top * 10) / 10 }
      w.__jit.frames.push({ t: performance.now(), top: sc ? sc.scrollTop : 0, folds, caret, h: pm.getBoundingClientRect().height })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, PM)
}

function analyze(label, data) {
  const { frames, scrolls, muts, sc, widgets } = data
  const issues = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i]
    if (Math.abs(b.top - a.top) > 0.5) issues.push(`帧${i} scrollTop ${a.top}→${b.top}`)
    if (a.caret != null && b.caret != null && Math.abs(b.caret - a.caret) > 0.5 && Math.abs(b.caret - a.caret) < 60) issues.push(`帧${i} 光标行 top ${a.caret}→${b.caret}`)
    b.folds.forEach((f, k) => {
      const g = a.folds[k]
      if (!g) return
      if (Math.abs(f[1] - g[1]) > 0.5) issues.push(`帧${i} 折叠块#${k} 高 ${g[1]}→${f[1]}`)
      else if (Math.abs(f[0] - g[0]) > 0.5 && Math.abs(b.top - a.top) <= 0.5) issues.push(`帧${i} 折叠块#${k} top ${g[0]}→${f[0]}`)
    })
  }
  // 连续 3 帧以上高度在变 = 有补间在跑(合法的一次性增减只占 1 帧)
  let anim = 0
  const n = frames[0]?.folds.length ?? 0
  for (let k = 0; k < n; k++) {
    let run = 0
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].folds[k], b = frames[i].folds[k]
      if (a && b && Math.abs(a[1] - b[1]) > 0.5) { if (++run === 3) { anim++; issues.push(`帧${i} 折叠块#${k} 高度在补间(连续 3 帧变化)`) } } else run = 0
    }
  }
  console.log(`\n== ${label} ==  滚动容器=${sc}  帧=${frames.length}  scroll事件=${scrolls.length}  折叠块节点被换=${muts}  折叠块按钮被重建=${widgets}`)
  console.log(issues.length ? issues.slice(0, 40).join('\n') + (issues.length > 40 ? `\n… 共 ${issues.length} 条` : '') : '(无抽动)')
  if (animOnly) return anim
  return issues.length + scrolls.length + muts + widgets
}
let animOnly = false

async function clickEnd(page, text) {
  const pt = await page.evaluate(([PM, text]) => {
    const p = [...document.querySelectorAll(`${PM} p`)].find((x) => x.textContent.includes(text))
    p.scrollIntoView({ block: 'center' })
    const r = document.createRange(); r.selectNodeContents(p); const rs = r.getClientRects(); const b = rs[rs.length - 1]
    return { x: b.right - 2, y: b.top + b.height / 2 }
  }, [PM, text])
  await page.waitForTimeout(400)
  await page.mouse.click(pt.x, pt.y)
}

async function run(page, label, text, keys) {
  await clickEnd(page, text)
  await page.waitForTimeout(500)
  await install(page)
  await page.waitForTimeout(200)
  const cdp = IME ? await page.context().newCDPSession(page) : null
  for (const k of keys) {
    if (cdp && k.length === 1) {
      // 拼音输入法:先组合(带下划线的拼音),再上屏一个汉字 —— 走浏览器 composition 那条路
      for (const part of ['n', 'ni']) {
        await cdp.send('Input.imeSetComposition', { text: part, selectionStart: part.length, selectionEnd: part.length })
        await page.waitForTimeout(30)
      }
      await cdp.send('Input.insertText', { text: '你' })
    } else if (k.length === 1) await page.keyboard.type(k)
    else await page.keyboard.press(k)
    await page.waitForTimeout(45)
  }
  await page.waitForTimeout(1500) // 写盘 / 防抖重算后的余震也收进来
  const data = await page.evaluate(() => { window.__jit.on = false; return window.__jit })
  return analyze(label, data)
}

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  let total = 0
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 860 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed())}`)
    await page.waitForSelector(`${PM} blockquote.callout-fold`, { timeout: 20000 })
    if (ZOOM) await page.evaluate((z) => { document.body.style.zoom = z }, ZOOM)
    await page.waitForTimeout(1500)
    const type = [...'abcdefghij']
    const del = Array(10).fill('Backspace')
    total += await run(page, '中段正文:打字', '第 20 段', type)
    total += await run(page, '中段正文:删除', '第 20 段', del)
    total += await run(page, '折叠块后段落:打字', '紧跟折叠块的段落 A', type)
    total += await run(page, '折叠块后段落:删除', '紧跟折叠块的段落 A', del)
    total += await run(page, '展开折叠块后:打字', '紧跟折叠块的段落 B', type)
    total += await run(page, '展开折叠块正文内:打字', '展开正文二', type)
    total += await run(page, '展开折叠块正文内:删除', '展开正文二', del)
    total += await run(page, '后段正文:打字', '第 50 段', type)
    // 在展开的折叠块正文里回车 / 合并段落:PM 会往折叠块里插新段落节点。只数「补间」:合法的高度一次性增减不算抽动。
    animOnly = true
    total += await run(page, '展开折叠块正文内:回车再合并', '展开正文一', ['Enter', 'Backspace', 'Enter', 'Backspace'])
    animOnly = false
  } finally {
    await browser.close()
  }
  console.log(total ? `\n❌ 观测到 ${total} 处抽动` : '\n✅ 未观测到抽动')
  process.exit(total ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
