/**
 * 自动化建议芯片的明暗/主题色契约检查(真 Chromium 断言)。
 *
 * 为什么存在:上一轮 Amadeus 按钮就是栽在这上面 —— 用了宿主里根本没定义的 token
 * (`var(--on-accent, #fff)`),回退成写死的白色,浅色主题下白字配浅底,肉眼在暗色下
 * 完全看不出问题。单测测不出「颜色是不是跟着主题走」,只有把真 CSS 丢进真浏览器、
 * 在浅/深两套 token 下各量一次才能钉住。
 *
 * 注入的是仓里**真实的** base.css(:root = 浅色 / :root.dark = 深色)+ chat2.css,
 * 不复制任何样式值,所以改了主题 token 这里会跟着变,不会与源码漂移。
 *
 * ⚠️**这是 CSS token 检查,不是功能检查**:页面是手写 DOM,不挂 EditorialMessage。
 * 组件不渲染、类名写错、onClick 失效,这里照样全绿 —— 那些由 suggest.test.ts + typecheck 管。
 *
 * 跑:node scripts/suggest-chip.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
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

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
const BASE_CSS = read('../frontend/src/styles/base.css')
const CHAT_CSS = read('../frontend/src/views/chat2/chat2.css')

// lucide-react 出的就是这形状:表现属性 width/height=24,颜色靠 currentColor / CSS。
const ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${BASE_CSS}
${CHAT_CSS}
body { margin: 0; background: var(--bg); }
/* 明暗切换在 body/芯片上都是有过渡的(base.css transition: color/background)。切完立刻量,
   getComputedStyle 拿到的是**插值中的中间色** —— 会稳定地读回上一套主题的值,看着像 bug 其实是量错了。
   这里只关心稳态,直接把过渡关掉。 */
* { transition: none !important; }
</style></head><body>
<div class="t2-stream"><div class="t2-stream-inner">
  <div class="t2-asst"><div class="t2-avatar">T</div><div class="t2-asst-col">
    <div class="t2-content"><p>那最稳妥的是给今天 12:00 的会议设两次提醒。</p></div>
    <div class="t2-suggest">
      <button class="t2-suggest-chip" id="chip">${ICON} 提醒我今天 11:30 准备 12 点的会议</button>
    </div>
  </div></div>
</div></div>
</body></html>`

/** 半透明 → 直接判不合格:alpha 被忽略的话,`rgba(28,28,28,.01)` 这种几乎看不见的文字会假绿。 */
const opaque = (c) => {
  const m = String(c).match(/[\d.]+/g)
  return !!m && (m.length < 4 || Number(m[3]) === 1)
}

/** "rgb(r, g, b)" → 相对亮度(WCAG)。 */
function luminance(rgb) {
  const m = String(rgb).match(/\d+(\.\d+)?/g)
  if (!m || m.length < 3 || !opaque(rgb)) return null
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  if (x === null || y === null) return 0
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN' })
  await page.setContent(PAGE)

  for (const mode of ['light', 'dark']) {
    await page.evaluate((m) => { document.documentElement.className = m === 'dark' ? 'dark' : '' }, mode)
    const m = await page.evaluate(() => {
      const chip = document.getElementById('chip')
      const svg = chip.querySelector('svg')
      const root = getComputedStyle(document.documentElement)
      const cs = getComputedStyle(chip)
      return {
        color: cs.color,
        border: cs.borderTopColor,
        borderWidth: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        icon: getComputedStyle(svg).color,
        pageBg: getComputedStyle(document.body).backgroundColor,
        token: {
          text: root.getPropertyValue('--text').trim(),
          border: root.getPropertyValue('--border').trim(),
          accentInk: root.getPropertyValue('--accent-ink').trim(),
        },
        // token 解析成实际颜色:塞进探针元素量 computed,免得手动解析 var 链。
        resolved: (() => {
          const p = document.createElement('span')
          document.body.appendChild(p)
          const out = {}
          for (const k of ['--text', '--border', '--accent-ink']) {
            p.style.color = `var(${k})`
            out[k] = getComputedStyle(p).color
          }
          p.remove()
          return out
        })(),
      }
    })

    check(`[${mode}] 芯片文字 = --text(没写死颜色)`, m.color === m.resolved['--text'], `${m.color} vs ${m.resolved['--text']}`)
    check(`[${mode}] 图标 = --accent-ink(主题强调色)`, m.icon === m.resolved['--accent-ink'], `${m.icon} vs ${m.resolved['--accent-ink']}`)
    check(`[${mode}] 描边 = --border、不透明、有宽度`, m.border === m.resolved['--border'] && opaque(m.border) && parseFloat(m.borderWidth) > 0, `${m.border} / ${m.borderWidth}`)
    check(`[${mode}] 底色透明(不抢正文)`, /rgba\(0, 0, 0, 0\)|transparent/.test(m.bg), m.bg)
    check(`[${mode}] 药丸形`, parseFloat(m.radius) >= 999 || m.radius === '50%', m.radius)
    // 真正的失败模式:某个 token 不存在 → 回退成写死的白/黑,一种模式下就糊了。
    const ct = contrast(m.color, m.pageBg)
    check(`[${mode}] 文字对底 ≥ 4.5:1`, ct >= 4.5, `${ct.toFixed(2)}:1  文字 ${m.color} 底 ${m.pageBg}`)
    const ci = contrast(m.icon, m.pageBg)
    check(`[${mode}] 图标对底 ≥ 3:1`, ci >= 3, `${ci.toFixed(2)}:1`)
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
