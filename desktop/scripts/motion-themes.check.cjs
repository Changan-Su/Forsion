/**
 * 动效主题逐帧台架(动效主题方案 A2,2026-11-06;theme/motionTheme.tsx、lcl/engine/panelMotion.ts / segFlow.ts、base.css 按属性分派)。
 * 用法:HARNESS_URL=http://localhost:5197/harness.html node scripts/e2e-editor.cjs --check=motion-themes [--shot=<目录>]
 *       (经 e2e-editor.cjs 自起 vite;worktree 里换端口,5173 上可能是别的检出的 vite)。
 *
 * harness.html?motionthemes:真 LCL 看法胶囊(四格)、真 SettingsSwitch、按钮 + 真 openPanel 长出的面板、真「动效主题」一节。
 * 四套逐个切(window.__mt.setMotionTheme,真偏好模块),每套逐帧(rAF)量三处:
 *  M1 分段胶囊 0↔2:
 *     Genesis / 拉伸 = 后沿晚出发(前沿走了 ≥ 2px 后沿还没动)、中途拉长 ≥ 一格 × 1.1、不过冲、落点准、没有融球层
 *     平移 = 两条边一起走(看不到后沿晚)、宽度始终 ≤ 一格 + 1px、中途有过渡帧、不过冲、落点准
 *     水滴 = 滑块一换格就在终点且藏着、身后融球层(≥ 3 块)流过去、流完滑块露出来、融球层撤掉
 *  M2 开关旋钮:Genesis / 拉伸 = 中途拉长(宽 > 静止 + 1.5px);平移 = 宽度不变;水滴 = 开关里有融球层、旋钮藏过
 *  M3 面板:Genesis / 水滴 = 液滴(lcl-droplet 层);拉伸 = lcl-stretch 层 + 远端先走(某帧高度已露出 ≥ 50%、宽度 ≤ 85%);
 *     平移 = 只有透明度 + 缩放动画,没有液滴 / 拉伸层
 *  F 只淡入淡出(拉伸主题下打开):胶囊 / 旋钮点了下一帧就在终点、没有中间帧;面板只有透明度动画、没有液滴 / 拉伸层
 *  S 设置一节:四张卡;点「平移」卡 → <html data-motion-theme="glide">、那张卡 aria-checked;「只淡入淡出」开关写 data-motion-fade;
 *    系统减少动态效果时开关打开且灰掉
 * 负对照(必须真的变红,否则上面的断言在骗人):
 *  N1 拉伸主题下把 --seg-edge-lag 设 0 → M1 的「后沿晚出发 + 中途拉长」判定为假
 *  N2 水滴主题下把 data-motion-theme 临时去掉再点 → 没有融球层(M1 水滴那条判定为假)
 * --shot:设置一节亮 / 暗各一张。
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
const SHOT = (process.argv.find((a) => a.startsWith('--shot')) || '').replace(/^--shot=?/, '') || (process.argv.includes('--shot') ? path.join(os.tmpdir(), 'motion-themes') : '')
let fails = 0
const record = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  | ' + JSON.stringify(detail)}`) }
const r1 = (x) => Math.round(x * 10) / 10

/** 页内:点分段胶囊的另一格(0 ↔ 2),逐帧记滑块两条边、可见性、融球层块数。 */
const SEG = async ({ duration }) => {
  const pill = document.querySelector('[data-testid="mt-seg"] .lcl-vmode-pill')
  const thumb = pill.querySelector('.lcl-vmode-thumb')
  const btns = [...pill.querySelectorAll(':scope > button')]
  const from = btns.findIndex((b) => b.classList.contains('on'))
  const to = from === 0 ? 2 : 0
  const tr = pill.getBoundingClientRect()
  const box = () => {
    const r = thumb.getBoundingClientRect()
    const flow = pill.querySelector('.lcl-flow')
    return { l: r.left - tr.left, r: r.right - tr.left, hidden: getComputedStyle(thumb).visibility === 'hidden', flow: flow ? flow.querySelectorAll('i').length : 0 }
  }
  const frames = [{ t: 0, ...box() }]
  const t0 = performance.now()
  btns[to].click()
  await new Promise((res) => {
    const tick = () => { const t = performance.now() - t0; frames.push({ t, ...box() }); if (t < duration) requestAnimationFrame(tick); else res() }
    requestAnimationFrame(tick)
  })
  return { frames, W: tr.width, n: btns.length, from, to }
}

function assessSeg(s) {
  const cell = (s.W - 4) / s.n
  const tl = 2 + s.to * cell, trr = 2 + (s.to + 1) * cell
  const right = s.to > s.from
  const over = Math.max(0, ...s.frames.map((f) => (right ? Math.max(f.l - tl, f.r - trr) : Math.max(tl - f.l, trr - f.r))))
  const lead = right ? 'r' : 'l', trail = right ? 'l' : 'r'
  const f0 = s.frames[0]
  const lagSeen = s.frames.some((f) => Math.abs(f[lead] - f0[lead]) >= 2 && Math.abs(f[trail] - f0[trail]) < 0.5)
  const maxW = Math.max(...s.frames.map((f) => f.r - f.l))
  const last = s.frames[s.frames.length - 1]
  const endErr = Math.max(Math.abs(last.l - tl), Math.abs(last.r - trr))
  const atEnd = (f) => Math.max(Math.abs(f.l - tl), Math.abs(f.r - trr)) <= 0.5
  const mid = s.frames.slice(1).filter((f) => !atEnd(f)).length
  const firstAfter = s.frames[1]
  return {
    cell: r1(cell), over: r1(over), lagSeen, maxW: r1(maxW), endErr: r1(endErr), mid,
    jumped: !!firstAfter && atEnd(firstAfter),
    hiddenSeen: s.frames.some((f) => f.hidden), flowMax: Math.max(...s.frames.map((f) => f.flow)),
    lastHidden: last.hidden, lastFlow: last.flow,
  }
}

/** 页内:拨一下开关,逐帧记旋钮宽度、可见性、融球层块数。 */
const KNOB = async ({ duration }) => {
  const btn = document.querySelector('[data-testid="mt-switch"]')
  const knob = btn.querySelector(':scope > span')
  const box = () => {
    const r = knob.getBoundingClientRect()
    const flow = btn.querySelector('.lcl-flow')
    return { l: r.left, w: r.width, hidden: getComputedStyle(knob).visibility === 'hidden', flow: flow ? flow.querySelectorAll('i').length : 0 }
  }
  const frames = [{ t: 0, ...box() }]
  const t0 = performance.now()
  btn.click()
  await new Promise((res) => {
    const tick = () => { const t = performance.now() - t0; frames.push({ t, ...box() }); if (t < duration) requestAnimationFrame(tick); else res() }
    requestAnimationFrame(tick)
  })
  const w0 = frames[0].w, last = frames[frames.length - 1]
  return {
    w0, maxW: Math.max(...frames.map((f) => f.w)), moved: Math.abs(last.l - frames[0].l),
    mid: frames.slice(1).filter((f) => Math.abs(f.l - last.l) > 0.5 && Math.abs(f.l - frames[0].l) > 0.5).length,
    jumped: Math.abs(frames[1].l - last.l) <= 0.5 || frames[1].hidden,
    hiddenSeen: frames.some((f) => f.hidden), flowMax: Math.max(...frames.map((f) => f.flow)), lastHidden: last.hidden, lastFlow: last.flow,
  }
}

/** 页内:点按钮开面板,逐帧记液滴 / 拉伸层、pouring、面板动画动的属性、裁切露出的比例;再点一下收起,等它卸载。 */
const PANEL = async ({ duration }) => {
  const btn = document.querySelector('[data-testid="mt-btn"]')
  const frames = []
  const props = new Set()
  const t0 = performance.now()
  btn.click()
  await new Promise((res) => {
    const tick = () => {
      const t = performance.now() - t0
      const panel = document.querySelector('[data-testid="mt-panel"]')
      const f = { t, droplet: !!document.querySelector('.lcl-droplet'), stretch: !!document.querySelector('.lcl-stretch'), pouring: !!panel?.classList.contains('lcl-droplet-pouring') }
      if (panel) {
        for (const a of panel.getAnimations()) for (const k of a.effect?.getKeyframes?.() ?? []) for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p)
        const cp = getComputedStyle(panel).clipPath
        const m = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/.exec(cp)
        if (m) {
          const [top, right, bottom, left] = m.slice(1).map(Number)
          const pr = panel.getBoundingClientRect()
          f.shownH = (pr.height - top - bottom) / pr.height
          f.shownW = (pr.width - left - right) / pr.width
        }
      }
      frames.push(f)
      if (t < duration) requestAnimationFrame(tick); else res()
    }
    requestAnimationFrame(tick)
  })
  btn.click()
  for (let i = 0; i < 60 && document.querySelector('[data-testid="mt-panel"]'); i++) await new Promise((r) => setTimeout(r, 25))
  return {
    // pouring(去底色 / 描边)液滴和拉伸都会挂,判液滴只认 .lcl-droplet 层
    droplet: frames.some((f) => f.droplet), pouring: frames.some((f) => f.pouring), stretchLayer: frames.some((f) => f.stretch),
    farLeads: frames.some((f) => f.shownH != null && f.shownH >= 0.5 && f.shownW <= 0.85),
    props: [...props].sort(), closed: !document.querySelector('[data-testid="mt-panel"]'),
    layersLeft: !!document.querySelector('.lcl-droplet, .lcl-stretch'),
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (q, opts = {}) => {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2, ...opts })
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${BASE}?${q}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('[data-testid="mt-seg"] .lcl-vmode-pill', { timeout: 20000 })
    await p.waitForFunction(() => !!window.__mt)
    await p.waitForTimeout(300)
    return p
  }
  const setTheme = (p, id) => p.evaluate((x) => window.__mt.setMotionTheme(x), id)

  const p = await open('motionthemes')
  for (const id of ['genesis', 'droplet', 'stretch', 'glide']) {
    await setTheme(p, id)
    await p.waitForTimeout(80)
    const s = assessSeg(await p.evaluate(SEG, { duration: 620 }))
    const k = await p.evaluate(KNOB, { duration: 420 })
    const pn = await p.evaluate(PANEL, { duration: 560 })
    await p.waitForTimeout(120)
    const segClean = s.over <= 0.5 && s.endErr <= 0.5
    if (id === 'genesis' || id === 'stretch') {
      record(`M1 ${id} 胶囊:后沿晚出发、中途拉长、不过冲、落点准、没有融球层`, segClean && s.lagSeen && s.maxW >= s.cell * 1.1 && s.flowMax === 0, s)
      record(`M2 ${id} 开关:旋钮中途拉长`, k.maxW > k.w0 + 1.5 && k.flowMax === 0, k)
    } else if (id === 'glide') {
      record('M1 glide 胶囊:两条边一起走、宽度不变、有过渡帧、不过冲、落点准', segClean && !s.lagSeen && s.maxW <= s.cell + 1 && s.mid >= 3 && s.flowMax === 0, s)
      record('M2 glide 开关:旋钮宽度不变、有过渡帧', k.maxW <= k.w0 + 0.75 && k.mid >= 2 && k.flowMax === 0, k)
    } else {
      record('M1 droplet 胶囊:滑块一换格就到终点并藏着、融球层流过去、流完滑块露出来', s.endErr <= 0.5 && s.jumped && s.hiddenSeen && s.flowMax >= 3 && !s.lastHidden && s.lastFlow === 0, s)
      record('M2 droplet 开关:融球层流过去、旋钮藏过又露出来', k.flowMax >= 3 && k.hiddenSeen && !k.lastHidden && k.lastFlow === 0, k)
    }
    if (id === 'stretch') record('M3 stretch 面板:拉伸层 + 远端先走,没有液滴', pn.stretchLayer && pn.farLeads && !pn.droplet && pn.closed && !pn.layersLeft, pn)
    else if (id === 'glide') record('M3 glide 面板:只有透明度 + 缩放,没有液滴 / 拉伸层', !pn.droplet && !pn.stretchLayer && pn.props.includes('opacity') && pn.props.includes('scale') && !pn.props.includes('clipPath') && pn.closed, pn)
    else record(`M3 ${id} 面板:液滴流出,没有拉伸层`, pn.droplet && !pn.stretchLayer && pn.closed && !pn.layersLeft, pn)
  }

  // ── N1:拉伸主题下后沿延迟设 0 → 「后沿晚出发 + 中途拉长」必须判假 ──
  await setTheme(p, 'stretch')
  await p.evaluate(() => document.documentElement.style.setProperty('--seg-edge-lag', '0ms'))
  await p.waitForTimeout(50)
  const n1 = assessSeg(await p.evaluate(SEG, { duration: 620 }))
  await p.evaluate(() => document.documentElement.style.removeProperty('--seg-edge-lag'))
  record('N1 负对照:后沿延迟设 0 时「后沿晚出发 + 中途拉长」判定为假(断言确实能红)', !(n1.lagSeen && n1.maxW >= n1.cell * 1.1), n1)

  // ── N2:水滴主题下临时去掉属性(segFlow 认不出水滴)→ 没有融球层 ──
  await setTheme(p, 'droplet')
  await p.evaluate(() => { delete document.documentElement.dataset.motionTheme })
  const n2 = assessSeg(await p.evaluate(SEG, { duration: 620 }))
  await setTheme(p, 'droplet')
  record('N2 负对照:不认水滴时没有融球层(M1 droplet 判定为假)', !(n2.jumped && n2.hiddenSeen && n2.flowMax >= 3), n2)

  // ── F:只淡入淡出(拉伸主题下) ──
  await setTheme(p, 'stretch')
  await p.evaluate(() => window.__mt.setFadeOnly(true))
  await p.waitForTimeout(80)
  {
    const fa = await p.evaluate(() => document.documentElement.dataset.motionFade)
    const s = assessSeg(await p.evaluate(SEG, { duration: 300 }))
    const k = await p.evaluate(KNOB, { duration: 250 })
    const pn = await p.evaluate(PANEL, { duration: 300 })
    record('F 只淡入淡出:写 data-motion-fade="on"', fa === 'on', fa)
    record('F 胶囊点了下一帧就在终点、没有中间帧、没有融球层', s.jumped && s.mid === 0 && s.flowMax === 0, s)
    record('F 开关旋钮直接到位、宽度不变', k.jumped && k.mid === 0 && k.maxW <= k.w0 + 0.75, k)
    record('F 面板只淡入:只有透明度动画,没有液滴 / 拉伸层', !pn.droplet && !pn.stretchLayer && pn.props.length > 0 && pn.props.every((x) => x === 'opacity') && pn.closed, pn)
  }
  await p.evaluate(() => window.__mt.setFadeOnly(false))

  // ── S:设置一节 ──
  {
    const cards = await p.$$eval('[data-motion-card]', (els) => els.map((e) => e.getAttribute('data-motion-card')))
    record('S 四张卡:Genesis / 水滴 / 拉伸 / 平移', JSON.stringify(cards) === JSON.stringify(['genesis', 'droplet', 'stretch', 'glide']), cards)
    await p.click('[data-motion-card="glide"]')
    await p.waitForTimeout(50)
    const st = await p.evaluate(() => ({ attr: document.documentElement.dataset.motionTheme, checked: document.querySelector('[data-motion-card="glide"]').getAttribute('aria-checked'), stored: localStorage.getItem('forsion_motion_theme') }))
    record('S 点「平移」卡:<html data-motion-theme="glide">、卡片选中、存进本机', st.attr === 'glide' && st.checked === 'true' && st.stored === 'glide', st)
    await p.click('[data-setting-anchor="motion-fade"] button[role="switch"]')
    await p.waitForTimeout(50)
    const fd = await p.evaluate(() => document.documentElement.dataset.motionFade ?? null)
    await p.click('[data-setting-anchor="motion-fade"] button[role="switch"]')
    record('S「只淡入淡出」开关写 data-motion-fade', fd === 'on', fd)
    if (SHOT) {
      fs.mkdirSync(SHOT, { recursive: true })
      await (await p.$('.settings-motion-theme')).screenshot({ path: path.join(SHOT, 'settings-light.png') })
    }
  }
  await p.close()

  // 系统减少动态效果:开关打开且灰掉(新页面,带 reducedMotion 起)
  {
    const q = await open('motionthemes', { reducedMotion: 'reduce' })
    const sw = await q.evaluate(() => { const b = document.querySelector('[data-setting-anchor="motion-fade"] button[role="switch"]'); return { checked: b.getAttribute('aria-checked'), disabled: b.disabled, hint: b.closest('.settings-control-row').querySelector('small').textContent } })
    record('S 系统减少动态效果:「只淡入淡出」打开且灰掉、小字说明', sw.checked === 'true' && sw.disabled && /减少动态效果/.test(sw.hint), sw)
    await q.close()
  }
  if (SHOT) {
    const d = await open('motionthemes&dark')
    await (await d.$('.settings-motion-theme')).screenshot({ path: path.join(SHOT, 'settings-dark.png') })
    await d.close()
    console.log(`截图:${SHOT}`)
  }
  await browser.close()
  console.log(fails ? `\n${fails} 项没过` : '\n全部通过')
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
