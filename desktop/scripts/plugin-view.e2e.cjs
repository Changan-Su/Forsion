// 外置插件视图的**真机 UIUX 台架**(真浏览器 + 真插件宿主 + 真 UI 壳,harness.html?plugview)。
// 与各插件自己的 check.mjs 分工:check.mjs 用 mock ctx 验逻辑/契约(node 跑得动的那半),
// 本脚本验**只有真 DOM 才看得见的那半**:视图挂得起来吗、深色模式下字还看得见吗、切成英文真的变英文吗。
//
// 用法:
//   node scripts/plugin-view.e2e.cjs <插件目录|main.js 路径> [--view <viewId>] [--id <pluginId>]
//                                    [--expect-views a,b] [--expect-commands x,y] [--shots <dir>] [--companion]
// 例:node scripts/plugin-view.e2e.cjs ../../Forsion-Instrumentality-Project/forsion-plugin-memoflow
//
// --companion(opt-in,2026-09-19+):验 Agent Desk 伴随面(ctx.desk.registerCompanion)。装插件**之前**先装台架的
// 假 Tangu 探针(__pv.fakeTangu,agent 状态由 __pv.setAgentStatus 驱动),然后断言:注册了伴随面;经真
// DeskCompanionHost 挂进卡片(278×394)与侧板(640×820)两种盒子都画出了非零尺寸的 <canvas>;7 个 phase
// 轮一遍不抛页面错误、宿主不报 [desk-companion] 回调失败;切会话(草稿 null → 真 id → 另一个)不重挂。
// 每个 phase 一张截图:<shots>/companion-<surface>-<phase>.png。插件没注册视图时跳过视图那组(伴随面插件可以只有伴随面)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const TARGET = `${BASE}?plugview`

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const target = process.argv[2]
if (!target || target.startsWith('--')) {
  console.error('用法: node scripts/plugin-view.e2e.cjs <插件目录|main.js> [--view id] [--expect-views a,b]')
  process.exit(1)
}
const pluginDir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
const mainPath = fs.statSync(target).isDirectory() ? path.join(target, 'main.js') : target
if (!fs.existsSync(mainPath)) { console.error(`找不到 ${mainPath}`); process.exit(1) }
let manifest = {}
try { manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')) } catch { /* 允许无 manifest */ }
const pluginId = arg('id', manifest.id || path.basename(pluginDir))
const COMPANION = process.argv.includes('--companion')
const PHASES = ['idle', 'thinking', 'speaking', 'tool', 'waiting', 'error', 'done']
/** 每个 phase 配一份像样的附加字段(tool 名、等什么),插件按真宿主的口径拿得到。 */
const PHASE_EXTRA = {
  thinking: { reasoningChars: 120 },
  speaking: { textChars: 240, messageId: 'pv-msg-1' },
  tool: { tool: 'read_file', toolStage: 'exec' },
  waiting: { tool: 'run_bash', waitingFor: 'approval' },
}
const SHOTS = arg('shots', path.join(os.tmpdir(), 'plugview-shots', pluginId))

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`)
}

/** 视口里所有「自己直接带文字」的元素,量它与最近不透明祖先底色的对比度。
 *  漏网的经典 bug:强调色按钮上写死 #fff、深色模式下沿用浅色文字 —— 单测永远看不见。 */
const CONTRAST_PROBE = `(() => {
  const lum = (c) => {
    const s = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
  }
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null
    const p = m[1].split(',').map((x) => parseFloat(x)); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 } }
  const bgOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const b = parse(getComputedStyle(n).backgroundColor)
      if (b && b.a > 0.5) return b.rgb
      n = n.parentElement
    }
    return [255, 255, 255]
  }
  const host = document.querySelector('[data-tag="pv-host"]')
  const bad = []
  if (!host) return { bad, total: 0 }
  let total = 0
  for (const el of host.querySelectorAll('*')) {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
    if (!own) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.3) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const fg = parse(cs.color)
    if (!fg || fg.a < 0.5) continue
    total++
    const bg = bgOf(el)
    const l1 = lum(fg.rgb), l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    if (ratio < 2.5) bad.push({ tag: el.tagName + '.' + (el.className || '').toString().slice(0, 30), text: (el.textContent || '').trim().slice(0, 24), ratio: Math.round(ratio * 100) / 100, fg: cs.color, bg: 'rgb(' + bg.join(',') + ')' })
  }
  return { bad: bad.slice(0, 8), total }
})()`

const CJK = /[一-鿿]/g

async function viewChecks(page, contrib) {
  const viewId = arg('view', contrib.views[0] && contrib.views[0].id)
  if (!viewId) { throw new Error('插件没有视图可开') }
  await page.evaluate((v) => window.__pv.open(v), viewId)
  await page.waitForTimeout(900)

  const shot = async (tag) => { await page.screenshot({ path: path.join(SHOTS, `${tag}.png`) }) }
  const probe = async () => page.evaluate(CONTRAST_PROBE)
  const bodyText = async () => page.locator('[data-tag="pv-host"]').innerText().catch(() => '')

  // ① 中文 + 浅色:视图真的画出东西了
  const zhLight = await bodyText()
  check('视图挂载后有可见内容', zhLight.trim().length > 0, `${zhLight.replace(/\s+/g, ' ').slice(0, 80)}`)
  const c1 = await probe()
  check('浅色模式无低对比文字', c1.bad.length === 0, JSON.stringify(c1.bad))
  await shot('zh-light')

  // ② 深色
  await page.evaluate(() => window.__pv.setMode('dark'))
  await page.waitForTimeout(500)
  const c2 = await probe()
  check('深色模式无低对比文字', c2.bad.length === 0, JSON.stringify(c2.bad))
  const darkText = await bodyText()
  check('深色模式内容仍在', darkText.trim().length > 0)
  await shot('zh-dark')

  // ③ 英文(仍深色 → 再回浅色)
  await page.evaluate(() => window.__pv.setLocale('en'))
  await page.waitForTimeout(800)
  const enDark = await bodyText()
  await shot('en-dark')
  await page.evaluate(() => window.__pv.setMode('light'))
  await page.waitForTimeout(400)
  const enLight = await bodyText()
  await shot('en-light')
  check('切英文后界面文案变了(真读了 locale)', enDark.trim() !== zhLight.trim() && enDark.trim().length > 0,
    `zh="${zhLight.replace(/\s+/g, ' ').slice(0, 40)}" en="${enDark.replace(/\s+/g, ' ').slice(0, 40)}"`)
  const cjk = (enLight.match(CJK) || []).length
  const ratio = enLight.length ? cjk / enLight.length : 0
  check('英文界面基本无残留中文 (<5%)', ratio < 0.05, `${cjk}/${enLight.length} 个中文字符`)
  const c3 = await probe()
  check('英文+浅色无低对比文字', c3.bad.length === 0, JSON.stringify(c3.bad))
}

/** --companion:伴随面两种挂载点 × 7 个 phase。 */
async function companionChecks(page, errors, consoleErrors) {
  const comp = await page.evaluate(() => window.__pv.companion())
  check('注册了 Desk 伴随面(ctx.desk.registerCompanion)', !!comp, JSON.stringify(comp))
  if (!comp) return
  const box = page.locator('[data-tag="pv-companion"]')
  const canvasOf = () => page.evaluate(() => {
    const host = document.querySelector('[data-tag="pv-companion"] .agent-desk-companion-slot')
    const cv = host && host.querySelector('canvas')
    const r = cv ? cv.getBoundingClientRect() : null
    return {
      children: host ? host.childElementCount : -1,
      canvas: cv ? { w: r.width, h: r.height, bw: cv.width, bh: cv.height } : null,
    }
  })
  const hostErrors = () => consoleErrors.filter((t) => t.includes('[desk-companion]'))
  for (const surface of ['desk-card', 'desk-panel']) {
    const errBefore = errors.length
    await page.evaluate(() => window.__pv.setAgentStatus('idle'))
    await page.evaluate((s) => window.__pv.mountCompanion(s), surface)
    await page.waitForTimeout(1200)
    const m = await canvasOf()
    check(`[${surface}] 挂载后有 DOM`, m.children > 0, JSON.stringify(m))
    check(`[${surface}] 画出非零尺寸的 <canvas>`, !!m.canvas && m.canvas.w > 0 && m.canvas.h > 0 && m.canvas.bw > 0 && m.canvas.bh > 0,
      JSON.stringify(m.canvas))
    for (const phase of PHASES) {
      // done / error 带余韵到期时刻(真探针的口径),到点回 idle 由插件自己不管 —— 台架只验它画得出来
      const extra = { ...(PHASE_EXTRA[phase] || {}), ...(phase === 'done' || phase === 'error' ? { until: Date.now() + 5000 } : {}) }
      await page.evaluate(([ph, ex]) => window.__pv.setAgentStatus(ph, ex), [phase, extra])
      await page.waitForTimeout(450)
      await box.screenshot({ path: path.join(SHOTS, `companion-${surface}-${phase}.png`) })
    }
    check(`[${surface}] 7 个 phase 轮一遍无页面错误`, errors.length === errBefore, errors.slice(errBefore, errBefore + 3).join(' | '))
    // 切会话:草稿(null)→ 真 id → 另一个会话,伴随面只换状态不重挂
    const before = await page.evaluate(() => window.__pv.companionMounts())
    for (const sid of [null, 'pv-session-a', 'pv-session-b']) {
      await page.evaluate(([s, id]) => window.__pv.mountCompanion(s, id), [surface, sid])
      await page.waitForTimeout(250)
    }
    const after = await page.evaluate(() => window.__pv.companionMounts())
    check(`[${surface}] 切会话(草稿→真 id→另一个)不重挂`, after === before, `mount 次数 ${before} → ${after}`)
    await page.evaluate(() => window.__pv.unmountCompanion())
    await page.waitForTimeout(300)
    check(`[${surface}] 卸载后挂载盒清空`, (await box.count()) === 0)
  }
  check('宿主没报伴随面回调失败([desk-companion])', hostErrors().length === 0, hostErrors().slice(0, 3).join(' | '))
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) { console.error('vite 没起来(5173 被占用或 vite.config 有问题)'); vite.kill(); process.exit(1) }
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const code = fs.readFileSync(mainPath, 'utf8')
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 860 } })
  const errors = []
  const consoleErrors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  try {
    await page.goto(TARGET)
    await page.waitForFunction(() => !!window.__pv, null, { timeout: 20000 })
    // 语言先钉成中文,免得上一轮跑剩的 localStorage 污染
    await page.evaluate(() => window.__pv.setLocale('zh'))
    // 伴随面要 ctx.tangu 的 agent 状态:假探针必须早于 loadPlugin(ctx.tangu 的有无在建 context 那一刻定)
    if (COMPANION) await page.evaluate(() => window.__pv.fakeTangu())
    let setupErr = null
    try {
      await page.evaluate(([c, id, name]) => window.__pv.loadPlugin(c, { id, name }), [code, pluginId, manifest.name || pluginId])
    } catch (e) { setupErr = String(e) }
    check('setup(ctx) 不抛', !setupErr, setupErr)

    await page.waitForTimeout(300)
    const contrib = await page.evaluate(() => window.__pv.contributions())
    console.log('   贡献点:', JSON.stringify(contrib))
    const skipViews = COMPANION && contrib.views.length === 0 && !arg('view', '')
    if (skipViews) console.log('   (--companion 且插件没注册视图:跳过视图那组)')
    else check('至少注册一个视图', contrib.views.length > 0, JSON.stringify(contrib.views))

    const expectViews = arg('expect-views', '')
    if (expectViews) {
      const want = expectViews.split(',').map((s) => s.trim()).filter(Boolean)
      const got = contrib.views.map((v) => v.id)
      const miss = want.filter((w) => !got.includes(w))
      check(`SPEC 点名的视图齐全 (${want.join(',')})`, miss.length === 0, `缺 ${miss.join(',')}`)
    }
    const expectCmds = arg('expect-commands', '')
    if (expectCmds) {
      const want = expectCmds.split(',').map((s) => s.trim()).filter(Boolean)
      const got = contrib.commands.map((c) => c.id)
      const miss = want.filter((w) => !got.includes(w))
      check(`SPEC 点名的命令齐全 (${want.join(',')})`, miss.length === 0, `缺 ${miss.join(',')}`)
    }

    if (!skipViews) await viewChecks(page, contrib)
    if (COMPANION) await companionChecks(page, errors, consoleErrors)

    // ④ 页面级错误
    check('无未捕获页面错误', errors.length === 0, errors.slice(0, 3).join(' | '))
    const noisy = consoleErrors.filter((t) => !/Failed to load resource|favicon/i.test(t))
    check('无 console.error', noisy.length === 0, noisy.slice(0, 3).join(' | '))
  } catch (e) {
    check('台架跑完', false, String(e))
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n截图: ${SHOTS}`)
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.error('失败:', failed.map((f) => f.name).join('; ')); process.exit(1) }
}

main()
