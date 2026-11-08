// 贴着元素开的浮层,锚点在窗口最底下时也要整张留在窗口里、不盖住锚点(2026-11-08 把存量手写落位迁到 menuAnchor 的
// followAnchor / useClampedMenu 之后留下的仪器)。场景是真组件 + 内存数据:frontend/anchored-overlays.html。
// 起因:这几处原来按固定高度估(选项菜单 260、议程卡 356、模型菜单 330…)或只量一次,内容一多、窗口一矮、端级 zoom 一放大就掉出窗口。
//
// 用法:npm run check:anchoredoverlay(需要 5173 上的 vite;没起会自己起)
//   ANCHORED_SHOTS=<目录> 每个场景存一张截图(交付前自查观感)
//   负对照:把 7 处换回迁移前的写法(harness 与本脚本不动)再跑,必须红 —— 结果见 PR 描述。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
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

const ORIGIN = process.env.HARNESS_ORIGIN || 'http://localhost:5173'
const SHOTS = process.env.ANCHORED_SHOTS
// 720 = 任务要求的自查尺寸;520 = 矮窗口,旧的固定高度估算(议程卡 356、选项菜单 260…)在这里压住锚点
const HEIGHTS = (process.env.ANCHORED_HEIGHTS || '720,520').split(',').map(Number)
const ZOOMS = (process.env.ANCHORED_ZOOMS || '1.1,1').split(',').map(Number)
const TOL = 1

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const ping = (url) => new Promise((res) => {
  const req = http.get(url, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false))
  req.setTimeout(1500, () => { req.destroy(); res(false) })
})

/** 场景:open 打开浮层,返回锚点元素的选择器;pop = 浮层选择器;side = 侧卡(只要求横向不压锚点)。 */
const CASES = [
  { id: 'model', pop: '.composer-menu', open: async (p) => { await p.click('.model-select-btn'); return '.model-select-btn' } },
  { id: 'bg', pop: '.t2-bgpop', open: async (p) => { await p.click('.t2-bgstrip-main'); return '.t2-bgstrip-main' } },
  { id: 'wiki', pop: '.amx-hoverprev', open: async (p) => { await p.hover('.wikilink'); await p.waitForTimeout(700); return '.wikilink' } },
  {
    id: 'db-form', pop: '.amx-db-pop',
    open: async (p) => {
      const cell = '.amx-db-form-field[data-col="status"] .amx-db-form-cell'
      await p.waitForSelector(cell)
      // 把选项字段滚到窗口底边:选项菜单往下放不下
      await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'end' }), cell)
      await p.click(`${cell} >> nth=0`)
      return cell
    },
  },
  {
    id: 'db-row', pop: '.amx-db-pop',
    open: async (p) => {
      await p.click('.amx-db-rowopen', { force: true })
      const cell = '.amx-db-rowed-cell[data-db-cell="status"]'
      await p.waitForSelector(cell)
      await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'end' }), cell)
      await p.click(cell)
      return cell
    },
  },
  {
    id: 'cal-agenda', pop: '.amx-cal-agenda',
    open: async (p) => {
      const more = p.locator('.amx-cal-more').last()
      await more.evaluate((el) => { el.setAttribute('data-anchor-test', ''); el.scrollIntoView({ block: 'end' }) })
      await p.waitForTimeout(300)
      await more.click()
      return '[data-anchor-test]'
    },
  },
  {
    id: 'cal-card', pop: '.amx-cal-cardwrap', side: true,
    open: async (p) => {
      // 当天格子里最后一条可见事件(紧挨「还有 N 项」),格子滚到窗口底边
      const chip = p.locator('.amx-cal-more').last().locator('xpath=..').locator('button:not(.amx-cal-more)').last()
      await chip.evaluate((el) => { el.setAttribute('data-anchor-test', ''); el.parentElement.querySelector('.amx-cal-more').scrollIntoView({ block: 'end' }) })
      await p.waitForTimeout(300)
      await chip.click()
      return '[data-anchor-test]'
    },
  },
]

async function run(browser, c, z, height) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height } })
  page.on('pageerror', (e) => console.log(`[pageerror ${c.id}]`, e.message))
  await page.goto(`${ORIGIN}/anchored-overlays.html?case=${c.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root > *', { timeout: 30000 })
  await page.evaluate((v) => {
    document.body.style.zoom = v === 1 ? '' : String(v)
    if (v === 1) document.documentElement.style.removeProperty('--uiz')
    else document.documentElement.style.setProperty('--uiz', String(v))
    window.dispatchEvent(new Event('forsion:uizoom'))
  }, z)
  await page.waitForTimeout(800)
  let anchorSel
  try { anchorSel = await c.open(page) } catch (e) { check(`${c.id} @${z} h${height}: 打开浮层`, false, e.message.split('\n')[0]); await page.close(); return }
  await page.waitForTimeout(500) // 内容异步长高 / 入场动画放完
  const m = await page.evaluate(({ pop, anchor }) => {
    const p = [...document.querySelectorAll(pop)].find((n) => !n.hasAttribute('data-lcl-exit'))
    const a = document.querySelector(anchor)
    if (!p || !a) return null
    const r = p.getBoundingClientRect(), b = a.getBoundingClientRect()
    return { pop: { l: r.left, t: r.top, r: r.right, b: r.bottom }, anchor: { l: b.left, t: b.top, r: b.right, b: b.bottom }, vw: innerWidth, vh: innerHeight, scrolls: p.scrollHeight > p.clientHeight + 1 }
  }, { pop: c.pop, anchor: anchorSel })
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${c.id}@${z}-h${height}.png`) }) }
  if (!m) { check(`${c.id} @${z} h${height}: 浮层出现`, false, '没找到浮层或锚点'); await page.close(); return }
  const { pop: p, anchor: a } = m
  const fmt = (r) => `${r.l.toFixed(0)},${r.t.toFixed(0)}–${r.r.toFixed(0)},${r.b.toFixed(0)}`
  const detail = `pop ${fmt(p)} anchor ${fmt(a)} of ${m.vw}×${m.vh}`
  check(`${c.id} @${z} h${height}: 整张在窗口里`, p.t >= -TOL && p.l >= -TOL && p.b <= m.vh + TOL && p.r <= m.vw + TOL, detail)
  const overlapV = Math.min(p.b, a.b) - Math.max(p.t, a.t) > TOL
  const overlapH = Math.min(p.r, a.r) - Math.max(p.l, a.l) > TOL
  check(`${c.id} @${z} h${height}: 不盖住锚点`, !(overlapV && overlapH), detail)
  if (!c.side) check(`${c.id} @${z} h${height}: 锚点在底部 → 开在锚点上方`, p.b <= a.t + TOL, detail)
  await page.close()
}

async function main() {
  let vite = null
  if (!(await ping(`${ORIGIN}/anchored-overlays.html`))) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping(`${ORIGIN}/anchored-overlays.html`) }
    if (!up) { console.error('vite 没起来'); vite.kill(); process.exit(1) }
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const only = process.env.ANCHORED_ONLY?.split(',')
  try {
    for (const height of HEIGHTS) for (const z of ZOOMS) for (const c of CASES) if (!only || only.includes(c.id)) await run(browser, c, z, height)
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const bad = results.filter((ok) => !ok).length
  console.log(`\n${results.length - bad}/${results.length} passed`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
