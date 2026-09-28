// 真鼠标拖选跨块文字 → 退格 / Delete 的回归仪器(评审 2026-09-27 B-16b,P0)。
//
// 病灶:blockLayer.ts 把手插件的 view.update 拿删除前的旧 pos 去 `doc.nodeAt()`;跨块删除让文档变短、
// 旧 pos 越界 → RangeError 从 updatePluginViews 逃出 keydown 处理链 → PM 没来得及 preventDefault →
// 浏览器在已更新的 contenteditable 上再跑一次原生退格/Delete:退格把两段原生合并并写出
// `<span style="color:">`,Delete 多吃一个字(「戊」丢失)。只有「悬停块旧位置 > 删后文档长度」才撞上,
// 所以悬停组才是真靶子,不悬停组是对照。
//
// 矩阵:悬停/不悬停 × 退格/Delete × 跨 3/4/5 块(6 段种子,从「段乙」开头拖到第 n 块第一个字后)。
// 每格断言:前置条件(悬停组把手确实出现 `.unified-gutter[data-show=true]`、不悬停组已藏)、
// 删后块形状、落盘纯 md 与期望逐字一致(无 `<span`)、pageerror = 0。
// ⚠️ 6 段种子下 n=3 悬停的旧 pos 仍在界内(走 hide 不走越界),负对照(摘掉修复)只会让 n=4/5 × 悬停变红。
//
// 用法:node scripts/e2e-editor.cjs --check=unified-dragdelete(或 npm run check:dragdel)
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
const PARAS = ['段甲。', '段乙。', '段丙。', '段丁。', '段戊。', '段己。']
const SEED = PARAS.join('\n\n') + '\n'
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 第 i 段第 k 个字符左缘(真鼠标落点)
const charPt = (p, i, k) => p.evaluate(([s, i, k]) => {
  const el = document.querySelectorAll(s + ' > p')[i]
  const t = el.firstChild
  const r = document.createRange()
  r.setStart(t, k)
  r.setEnd(t, k + 1)
  const b = r.getBoundingClientRect()
  return { x: b.left + 0.5, y: b.top + b.height / 2 }
}, [PM, i, k])

async function runCase(browser, { hover, key, n }) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForTimeout(500)
  const endIdx = n // 从第 1 段(段乙)起跨 n 块 → 落在第 n 段
  const a = await charPt(p, 1, 0)
  const z = await charPt(p, endIdx, 1)
  await p.mouse.move(a.x, a.y)
  await p.mouse.down()
  await p.mouse.move(z.x, z.y, { steps: 12 })
  await p.mouse.up()
  await p.waitForTimeout(300)
  if (!hover) {
    // 移出 pane(.unified-body)外 → onLeave 藏把手。坐标现量,别硬编码。
    const out = await p.evaluate(() => {
      const r = document.querySelector('.unified-body').getBoundingClientRect()
      const x = r.right + 20 < innerWidth ? r.right + 20 : Math.max(2, r.left - 20)
      return { x, y: Math.min(innerHeight - 2, r.bottom + 20) }
    })
    await p.mouse.move(out.x, out.y, { steps: 4 })
    await p.waitForTimeout(250)
  }
  const pre = await p.evaluate(() => ({
    gutter: document.querySelector('.unified-gutter')?.dataset.show ?? null,
    sel: window.getSelection().toString(),
  }))
  await p.keyboard.press(key)
  await p.waitForTimeout(1300)
  const shape = await p.evaluate((s) => [...document.querySelector(s).children].map((e) => e.textContent), PM)
  const md = await p.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
  await p.close()
  return { pre, shape, md, errs }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  for (const hover of [true, false]) {
    for (const key of ['Backspace', 'Delete']) {
      for (const n of [3, 4, 5]) {
        const r = await runCase(browser, { hover, key, n })
        const wantShape = ['段甲。', PARAS[n].slice(1), ...PARAS.slice(n + 1)]
        const wantMd = wantShape.join('\n\n') + '\n'
        const preOk = r.pre.gutter === (hover ? 'true' : 'false') && r.pre.sel.startsWith('段乙。')
        const ok = preOk
          && JSON.stringify(r.shape) === JSON.stringify(wantShape)
          && r.md === wantMd
          && r.errs.length === 0
        check(
          `DD ${hover ? '悬停' : '不悬停'} × ${key === 'Backspace' ? '退格' : 'Delete'} × 跨 ${n} 块 → 两端拼接、零吃字、零 span、pageerror=0`,
          ok,
          JSON.stringify({ pre: r.pre.gutter, shape: r.shape, md: r.md, errs: r.errs.map((m) => m.slice(0, 90)) }),
        )
      }
    }
  }
  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
