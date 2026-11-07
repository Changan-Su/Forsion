// Amadeus 正文网页链接观感(2026-11-04):强调色 + 末尾 ↗ 外链图标;相对路径链接、双链不挂图标;
// 图标是 ::after,光标停在链接末尾照常打字。
// 用法:node scripts/e2e-editor.cjs --check=unified-extlink(SHOT=<目录> 顺手截一张)
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.evaluate(() => window.__upage.switchFile('Links.md', '# 链接\n\n看 [官网](https://forsion.net) 和 [本地](notes/a.md) 还有 [[另一篇]] 结尾。\n'))
  await p.waitForSelector(`${PM} a[href^="https"]`, { timeout: 10000 })
  await p.waitForTimeout(300)

  const look = await p.evaluate((pm) => {
    const root = document.querySelector(pm)
    const after = (el) => el && getComputedStyle(el, '::after')
    const web = root.querySelector('a[href^="https"]')
    const rel = root.querySelector('a[href="notes/a.md"]')
    const wiki = root.querySelector('.wikilink')
    const probe = document.createElement('span')
    probe.style.color = 'var(--signal)'
    web.parentElement.appendChild(probe)
    const signal = getComputedStyle(probe).color
    probe.remove()
    return {
      webIcon: after(web).content === '""' && after(web).maskImage.startsWith('url('),
      relIcon: !!rel && after(rel).content !== 'none' && after(rel).content !== 'normal',
      wikiIcon: !!wiki && after(wiki).content !== 'none' && after(wiki).content !== 'normal',
      hasRel: !!rel, hasWiki: !!wiki,
      color: getComputedStyle(web).color, signal,
    }
  }, PM)
  record('E1 网页链接末尾挂 ↗(::after mask)', look.webIcon, JSON.stringify(look))
  record('E2 相对路径链接 / 双链不挂 ↗', look.hasRel && !look.relIcon && !look.wikiIcon, `rel=${look.hasRel}/${look.relIcon} wiki=${look.hasWiki}/${look.wikiIcon}`)
  record('E3 网页链接颜色 = --signal', look.color === look.signal, `${look.color} vs ${look.signal}`)

  // 光标落到链接文字末尾再打字:字要进文档(图标是伪元素,不该挡光标)。
  const at = await p.evaluate((pm) => {
    const t = document.querySelector(`${pm} a[href^="https"]`).firstChild
    const r = document.createRange()
    r.setStart(t, t.textContent.length - 1); r.setEnd(t, t.textContent.length)
    const b = r.getBoundingClientRect()
    return { x: b.right - 1, y: b.top + b.height / 2 }
  }, PM)
  await p.mouse.click(at.x, at.y)
  await p.keyboard.type('XY')
  await p.waitForTimeout(200)
  const text = await p.evaluate((pm) => document.querySelector(pm).textContent, PM)
  record('E4 链接末尾打字照常落进正文', text.includes('官网XY') || text.includes('XY 和'), text.slice(0, 60))

  if (process.env.SHOT) await p.locator('.unified-body').first().screenshot({ path: path.join(process.env.SHOT, 'amadeus-extlink.png') })
  await browser.close()
  const ok = results.every(Boolean)
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
