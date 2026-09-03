// ⌘P 快切「分类胶囊」的出口门(2026-08-20)。用法:npm run check:quickfind
//
// 心智模型(用户原话):**分类就像正文后面那几个字** —— 光标是一条线 `1 2 3 |笔记 文件 会话`。
//   Q1 默认「全部」= 光标在正文里;胶囊四格,滑块在第 0 格、宽约 1/4(格数走 --seg-n)
//   Q2 正文末尾 →→ = 「文件」,滑块滑到第 2 格;列表只剩文件类
//   Q3 ⚠️ 打过字之后按 ←:仍在分类里往回走(文件→笔记)。第一版要求「光标先回到正文最前面」才肯
//      切回来 —— 而按 ← 的时机恰恰是刚按过 →、光标停在最右,左右不对称,用户实报
//   Q4 第一格再按 ← = 退回正文(全部);右端到头再按 → 停住,不绕圈
//   Q5 光标在正文中间时 ←/→ 只移光标,分类不动(改错字的路不能被抢)
//   Q6 滑块有 transform 过渡(= 用户要的切换动画,来自共用的 .t2s-vaultseg)
const fs = require('fs')
const os = require('os')
const path = require('path')
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

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
/** 四格的文字 + 谁高亮 + 滑块几何(相对轨道:left 比例与宽度比例)。 */
const seg = (p) => p.evaluate(() => {
  const bar = document.querySelector('.amx-qf-seg')
  const thumb = bar?.querySelector('.t2s-vaultseg-thumb')
  const btns = [...(bar?.querySelectorAll('button') ?? [])]
  if (!bar || !thumb) return null
  const br = bar.getBoundingClientRect()
  const tr = thumb.getBoundingClientRect()
  return {
    labels: btns.map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
    x: Math.round(((tr.left - br.left) / br.width) * 100) / 100,
    w: Math.round((tr.width / br.width) * 100) / 100,
  }
})
const rows = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-qf-row .amx-qf-title')].map((r) => r.textContent ?? ''))
const caret = (p) => p.evaluate(() => { const i = document.querySelector('.amx-qf-input'); return { s: i.selectionStart, e: i.selectionEnd, v: i.value } })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 620 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${BASE}?qf`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.amx-qf-seg', { timeout: 20000 })
  await p.waitForTimeout(400)

  const s1 = await seg(p)
  record('Q1 默认「全部」;四格 + 滑块在第 0 格、宽约 1/4',
    JSON.stringify(s1.labels) === JSON.stringify(['全部*', '笔记', '文件', '会话']) && Math.abs(s1.x) < 0.02 && Math.abs(s1.w - 0.25) < 0.03,
    JSON.stringify(s1))

  await p.keyboard.press('ArrowRight')
  await p.waitForTimeout(120)
  await p.keyboard.press('ArrowRight')
  await p.waitForTimeout(420) // 等滑块动画落定
  const s2 = await seg(p)
  const r2 = await rows(p)
  record('Q2 正文末尾 →→ = 「文件」,滑块滑到第 2 格,列表只剩文件类',
    s2.labels[2] === '文件*' && Math.abs(s2.x - 0.5) < 0.04 && r2.length > 0 && r2.every((t) => /\.(pdf|png|md)$/i.test(t)),
    JSON.stringify({ s2, r2 }))

  await p.keyboard.type('照片')
  await p.waitForTimeout(250)
  await p.keyboard.press('ArrowLeft')
  await p.waitForTimeout(420)
  const s3 = await seg(p)
  const c3 = await caret(p)
  record('Q3 打过字后按 ← 仍在分类里回走(文件→笔记),光标一步没动',
    s3.labels[1] === '笔记*' && c3.s === 2 && c3.e === 2 && c3.v === '照片', JSON.stringify({ s3, c3 }))

  await p.keyboard.press('ArrowLeft') // 第一格再按 ← → 退回正文
  await p.waitForTimeout(420)
  const s4a = await seg(p)
  await p.keyboard.press('ArrowLeft') // 已在正文:这一下只移光标
  await p.waitForTimeout(150)
  const c4 = await caret(p)
  for (let i = 0; i < 6; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(110) }
  const s4b = await seg(p)
  record('Q4 第一格 ← 退回正文(全部);右端到头停住不绕圈',
    s4a.labels[0] === '全部*' && Math.abs(s4a.x) < 0.02 && c4.s === 1 && s4b.labels[3] === '会话*' && Math.abs(s4b.x - 0.75) < 0.04,
    JSON.stringify({ s4a, c4, s4b }))

  // Q5:光标挪回文字中间(点一下输入框最左),←/→ 只移光标
  await p.click('.amx-qf-input')
  await p.waitForTimeout(150)
  await p.keyboard.press('ArrowLeft')
  await p.waitForTimeout(200)
  const s5 = await seg(p)
  const c5 = await caret(p)
  record('Q5 光标回正文后 ← 只移光标,分类停在「全部」', s5.labels[0] === '全部*' && c5.s < c5.v.length, JSON.stringify({ s5, c5 }))

  const anim = await p.evaluate(() => {
    const t = document.querySelector('.amx-qf-seg .t2s-vaultseg-thumb')
    const cs = getComputedStyle(t)
    return { prop: cs.transitionProperty, dur: cs.transitionDuration, timing: cs.transitionTimingFunction }
  })
  record('Q6 滑块有 transform 过渡(切换动画)',
    /transform/.test(anim.prop) && parseFloat(anim.dur) > 0, JSON.stringify(anim))

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  真机(Electron)里 ⌘P 唤起 + 真实库内容:harness 用的是内存表')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
