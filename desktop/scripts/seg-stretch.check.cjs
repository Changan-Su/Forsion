/**
 * 分段胶囊滑块「拉伸」逐帧仪器(水滴复用方案第 4 条,2026-11-05;DESIGN §3 动效 token --seg-edge-duration / --seg-edge-lag)。
 * 用法:npm run check:segstretch [-- --shot=<目录>](经 e2e-editor.cjs 自起 vite;worktree 里设 HARNESS_URL 换端口,
 *       如 HARNESS_URL=http://localhost:5199/harness.html —— 5173 上可能是别的检出的 vite,测的就不是这份代码)。
 *
 * 两颗真胶囊、真点击、真 React(useSegDir 写 data-dir):
 *   ?segs  LCL 看法胶囊(.lcl-vmode-thumb,插件拿到的就是这一颗)四格 + 两格
 *   ?qf    ⌘P 分类胶囊(.t2s-vaultseg-thumb,侧栏本地|云端、Chat|Work、Tangu 四格筛选同一份 CSS)
 *
 * 钉:
 *  S1 每一次切格逐帧(rAF)采样滑块左右两条边:
 *     a 滑块写了 data-dir,方向对(往右 r、往左 l)
 *     b 不过冲:任何一帧两条边都不越过目标位置(容差 0.5px),且各自单调
 *     c 后沿晚出发:有一帧前沿已走 ≥ 2px、后沿还没动(< 0.5px)
 *     d 中途拉长:最大宽度 ≥ 一格 × 1.1
 *     e 落定:与改之前那套(left:2px + width:(100%−4px)/n + translateX(i·100%))的落点逐像素相同(容差 0.5px),
 *       且 ≤ 480ms 到位(280 + 80 = 360ms,留余量)
 *  S2 中途反悔(120ms 时点回原格):收敛回原格,两条边不越出两格并起来的范围
 *  S3 减少动态效果:点了之后第一帧就在目标位置
 *  S4 负对照:同一套采样量旧写法(transform 0.3s cubic-bezier(0.32, 1.25, 0.5, 1))跨三格必须量出过冲 > 2px —— 证明 S1b 抓得住
 *     (那条曲线冲过头约为行程的 2%:一格 57px 只有 1.2px,所以拿三格量;方案页实测侧栏筛选 3.5–3.9px 同一量级)
 *  S5 --shot:亮 / 暗各一张中途帧(170ms 冻住)+ 落定帧,两颗胶囊都拍
 */
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
const SHOT = (process.argv.find((a) => a.startsWith('--shot')) || '').replace(/^--shot=?/, '') || (process.argv.includes('--shot') ? path.join(os.tmpdir(), 'seg-stretch') : '')
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 页内:点第 idx 格,逐帧记滑块两条边(相对轨道左沿)。reverseAt = 多少 ms 后点回原格。 */
const SAMPLE = async ({ pillSel, idx, reverseAt, duration }) => {
  const pill = document.querySelector(pillSel)
  const thumb = pill.querySelector('.t2s-vaultseg-thumb, .lcl-vmode-thumb')
  const btns = [...pill.querySelectorAll(':scope > button')]
  const from = btns.findIndex((b) => b.classList.contains('on'))
  const tr = pill.getBoundingClientRect()
  const box = () => { const r = thumb.getBoundingClientRect(); return { l: r.left - tr.left, r: r.right - tr.left } }
  const frames = [{ t: 0, ...box() }]
  const t0 = performance.now()
  btns[idx].click()
  let reversed = false
  await new Promise((res) => {
    const tick = () => {
      const t = performance.now() - t0
      frames.push({ t, ...box() })
      if (reverseAt != null && !reversed && t >= reverseAt) { reversed = true; btns[from].click() }
      if (t < duration) requestAnimationFrame(tick)
      else res()
    }
    requestAnimationFrame(tick)
  })
  // 旧写法的落点:同一条轨道里摆一颗按原 CSS 定位的影子(无过渡),量它的盒子
  const end = reverseAt != null ? from : idx
  const ghost = document.createElement('div')
  ghost.style.cssText = `position:absolute;top:2px;bottom:2px;left:2px;width:calc((100% - 4px) / ${btns.length});transform:translateX(${end * 100}%);transition:none;visibility:hidden`
  pill.appendChild(ghost)
  const g = ghost.getBoundingClientRect()
  ghost.remove()
  return { frames, W: tr.width, n: btns.length, from, dir: thumb.dataset.dir ?? null, legacy: { l: g.left - tr.left, r: g.right - tr.left } }
}

/** 页内负对照:同一条轨道里摆一颗旧写法的滑块(transform 平移 + 过冲曲线),从 from 滑到 to,逐帧记。 */
const SAMPLE_LEGACY = async ({ pillSel, from, to, duration }) => {
  const pill = document.querySelector(pillSel)
  const n = pill.querySelectorAll(':scope > button').length
  const tr = pill.getBoundingClientRect()
  const el = document.createElement('div')
  el.style.cssText = `position:absolute;top:2px;bottom:2px;left:2px;width:calc((100% - 4px) / ${n});transform:translateX(${from * 100}%);transition:transform 0.3s cubic-bezier(0.32, 1.25, 0.5, 1);opacity:0;pointer-events:none`
  pill.appendChild(el)
  el.getBoundingClientRect()
  const box = () => { const r = el.getBoundingClientRect(); return { l: r.left - tr.left, r: r.right - tr.left } }
  const frames = [{ t: 0, ...box() }]
  const t0 = performance.now()
  el.style.transform = `translateX(${to * 100}%)`
  await new Promise((res) => {
    const tick = () => { const t = performance.now() - t0; frames.push({ t, ...box() }); if (t < duration) requestAnimationFrame(tick); else res() }
    requestAnimationFrame(tick)
  })
  el.remove()
  return { frames, W: tr.width, n, from }
}

/** 一次切格的判定量。 */
function assess(s, to) {
  const cell = (s.W - 4) / s.n
  const L = (i) => 2 + i * cell
  const R = (i) => 2 + (i + 1) * cell
  const right = to > s.from
  const tl = L(to)
  const trr = R(to)
  const over = Math.max(0, ...s.frames.map((f) => (right ? Math.max(f.l - tl, f.r - trr) : Math.max(tl - f.l, trr - f.r))))
  let mono = true
  for (let k = 1; k < s.frames.length; k++) {
    const dl = s.frames[k].l - s.frames[k - 1].l
    const dr = s.frames[k].r - s.frames[k - 1].r
    if (right ? dl < -0.3 || dr < -0.3 : dl > 0.3 || dr > 0.3) mono = false
  }
  const lead = right ? 'r' : 'l'
  const trail = right ? 'l' : 'r'
  const f0 = s.frames[0]
  const lagSeen = s.frames.some((f) => Math.abs(f[lead] - f0[lead]) >= 2 && Math.abs(f[trail] - f0[trail]) < 0.5)
  const maxW = Math.max(...s.frames.map((f) => f.r - f.l))
  const last = s.frames[s.frames.length - 1]
  const endErr = Math.max(Math.abs(last.l - tl), Math.abs(last.r - trr))
  const legacyErr = s.legacy ? Math.max(Math.abs(last.l - s.legacy.l), Math.abs(last.r - s.legacy.r)) : null
  let settle = 0
  for (const f of s.frames) if (Math.max(Math.abs(f.l - tl), Math.abs(f.r - trr)) > 0.5) settle = f.t
  const r1 = (x) => Math.round(x * 10) / 10
  return { right, over: r1(over), mono, lagSeen, maxW: r1(maxW), cell: r1(cell), endErr: r1(endErr), legacyErr: legacyErr == null ? null : r1(legacyErr), settle: Math.round(settle), frames: s.frames.length }
}

async function runSteps(p, tag, pillSel, steps) {
  for (const to of steps) {
    const s = await p.evaluate(SAMPLE, { pillSel, idx: to, reverseAt: null, duration: 560 })
    const a = assess(s, to)
    const want = to > s.from ? 'r' : 'l'
    const ok = s.dir === want && a.over <= 0.5 && a.mono && a.lagSeen && a.maxW >= a.cell * 1.1 && a.endErr <= 0.5 && a.legacyErr <= 0.5 && a.settle <= 480
    record(`S1 ${tag} ${s.from}→${to}:data-dir=${want}、不过冲、后沿晚出发、中途拉长、落点同旧写法`, ok, JSON.stringify({ dir: s.dir, ...a }))
  }
}

async function shoot(p, file, pillSel, clipSel, idx) {
  // 冻在 170ms:前沿走了约六成,后沿刚出发 —— 拉长最明显的那一帧
  await p.evaluate(async ({ pillSel, idx }) => {
    const pill = document.querySelector(pillSel)
    pill.querySelectorAll(':scope > button')[idx].click()
    await new Promise((r) => requestAnimationFrame(() => r()))
    // 整颗胶囊一起冻(含格子字色的过渡),否则字色按真实时间走、滑块停在 170ms,拍出来对不上同一刻
    pill.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 170 })
  }, { pillSel, idx })
  const box = await p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } }, clipSel)
  const clip = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 12), width: box.width + 32, height: box.height + 24 }
  await p.screenshot({ path: path.join(SHOT, `${file}-mid.png`), clip })
  await p.evaluate((sel) => document.querySelector(sel).getAnimations({ subtree: true }).forEach((a) => a.finish()), pillSel)
  await p.waitForTimeout(60)
  await p.screenshot({ path: path.join(SHOT, `${file}-end.png`), clip })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (q, opts = {}) => {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 620 }, deviceScaleFactor: 2, ...opts })
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${BASE}?${q}`, { waitUntil: 'domcontentloaded' })
    return p
  }
  const LCL4 = '[data-testid="seg4"] .lcl-vmode-pill'
  const LCL2 = '[data-testid="seg2"] .lcl-vmode-pill'
  const QF = '.amx-qf-seg'

  // ── S1 / S2 / S4:LCL 看法胶囊 ──
  {
    const p = await open('segs')
    await p.waitForSelector(LCL4, { timeout: 20000 })
    await p.waitForTimeout(300)
    await runSteps(p, 'LCL 四格', LCL4, [1, 3, 2, 0])
    await runSteps(p, 'LCL 两格', LCL2, [1, 0])

    const rv = await p.evaluate(SAMPLE, { pillSel: LCL4, idx: 2, reverseAt: 120, duration: 760 })
    const cell = (rv.W - 4) / rv.n
    const lo = Math.min(...rv.frames.map((f) => f.l))
    const hi = Math.max(...rv.frames.map((f) => f.r))
    const last = rv.frames[rv.frames.length - 1]
    record('S2 中途反悔(0→2,120ms 点回 0):收敛回 0,两边不越出 0..2 格',
      lo >= 2 - 0.5 && hi <= 2 + 3 * cell + 0.5 && Math.abs(last.l - 2) <= 0.5 && Math.abs(last.r - (2 + cell)) <= 0.5 && rv.dir === 'l',
      JSON.stringify({ lo: Math.round(lo * 10) / 10, hi: Math.round(hi * 10) / 10, end: [Math.round(last.l * 10) / 10, Math.round(last.r * 10) / 10], cell: Math.round(cell * 10) / 10, dir: rv.dir }))

    const neg = await p.evaluate(SAMPLE_LEGACY, { pillSel: LCL4, from: 0, to: 3, duration: 520 })
    const na = assess(neg, 3)
    record('S4 负对照:旧写法(transform + 过冲曲线)0→3 同一套采样量得出过冲 > 2px、没有拉长', na.over > 2 && !na.lagSeen && na.maxW <= na.cell + 0.5, JSON.stringify({ over: na.over, lagSeen: na.lagSeen, maxW: na.maxW, cell: na.cell }))
    await p.close()
  }

  // ── S1:⌘P 分类胶囊(.t2s-vaultseg 那一份 CSS)──
  {
    const p = await open('qf')
    await p.waitForSelector(QF, { timeout: 20000 })
    await p.waitForTimeout(400)
    await runSteps(p, '⌘P 四格', QF, [1, 3, 2, 0])
    await p.close()
  }

  // ── S3:减少动态效果 ──
  for (const [q, sel, tag] of [['segs', LCL4, 'LCL'], ['qf', QF, '⌘P']]) {
    const p = await open(q, { reducedMotion: 'reduce' })
    await p.waitForSelector(sel, { timeout: 20000 })
    await p.waitForTimeout(400)
    const s = await p.evaluate(SAMPLE, { pillSel: sel, idx: 2, reverseAt: null, duration: 200 })
    const cell = (s.W - 4) / s.n
    const f1 = s.frames[1]
    record(`S3 ${tag} 减少动态效果:第一帧就到第 2 格`, Math.abs(f1.l - (2 + 2 * cell)) <= 0.5 && Math.abs(f1.r - (2 + 3 * cell)) <= 0.5,
      JSON.stringify({ t: Math.round(f1.t), l: Math.round(f1.l * 10) / 10, r: Math.round(f1.r * 10) / 10, want: [Math.round((2 + 2 * cell) * 10) / 10, Math.round((2 + 3 * cell) * 10) / 10] }))
    await p.close()
  }

  // ── S5:截图 ──
  if (SHOT) {
    fs.mkdirSync(SHOT, { recursive: true })
    for (const dark of [false, true]) {
      const m = dark ? 'dark' : 'light'
      const p1 = await open(`segs${dark ? '&dark' : ''}`)
      await p1.waitForSelector(LCL4, { timeout: 20000 })
      await p1.waitForTimeout(300)
      await shoot(p1, `lcl-${m}`, LCL4, '[data-testid="seg4"]', 2)
      await p1.close()
      const p2 = await open(`qf${dark ? '&dark' : ''}`)
      await p2.waitForSelector(QF, { timeout: 20000 })
      await p2.waitForTimeout(400)
      await shoot(p2, `qf-${m}`, QF, QF, 3)
      await p2.close()
    }
    console.log(`截图:${SHOT}`)
  }

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
