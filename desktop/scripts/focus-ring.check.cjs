/**
 * 选中/聚焦圈的**线宽单点**守卫(2026-08-13 用户拍板 2px → 1px)。
 *
 * 两段:
 *  A 静态扫描:仓内源码 CSS 里,凡是 :focus / .active / [data-active] / .selected / :checked 这类
 *    **选中语境**的 `outline: Npx` 或 `box-shadow: 0 0 0 Npx` 圈,线宽一律得写 `var(--focus-ring)`,
 *    不许再硬编码 —— 硬编码就是下一次「怎么只改了一半」的来源。
 *  B 渲染实测:真 base.css + amadeus/styles.css 起一个聚焦输入框,量 outline-width 真是 1px
 *    (token 有没有解析成功,静态扫描看不出来:var() 写错名字照样"通过")。
 *
 * 跑:npm run check:focusring
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const GENESIS = path.resolve(__dirname, '../..')
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── A. 静态扫描 ──────────────────────────────────────────────────────────
// 只扫源码目录;public/ 与 vendor 里那些第三方 bundle(excalidraw 等)不归我们管。
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src']
const SEL_CTX = /:focus|\[data-active\]|\.active\b|\.selected\b|aria-selected|:checked/i
// 圈:outline 简写(**不含 outline-offset/-color/-style**)或 0-偏移 0-模糊的 box-shadow(那就是"描一圈")。
// ⚠️ 比对前先把 var(--x, 1px) 的**兜底值**摘掉,否则合规写法自己会把自己报成违规。
const RING = /(?:(?<![-\w])outline:[^;]*?|box-shadow:\s*0\s+0\s+0\s+)(\d*\.?\d+)px/g
const stripVarFallback = (s) => s.replace(/var\(\s*--[\w-]+\s*,[^()]*\)/g, 'var(--x)')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'public') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

const offenders = []
for (const root of ROOTS) {
  const abs = path.join(GENESIS, root)
  if (!fs.existsSync(abs)) continue
  for (const file of walk(abs)) {
    // 注释里也会出现 `box-shadow: 0 0 0 1px …`(base.css 就有一条「别再叠」的警告)——
    // 换成等长空白抹掉,保住后面按偏移量算行号。
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    // ⚠️ 必须按**规则块**切,不能按行:要守的那条主规则选择器与声明分居两行
    // (`.am-app :focus-visible {` / `  outline: …`),逐行扫的话选择器那行没有 px、声明那行没有
    // :focus —— 两边都不命中,守卫等于没写。以 `}` 切块,每块 = 选择器 + 它的声明。
    let at = 0
    for (const chunk of src.split('}')) {
      const start = at
      at += chunk.length + 1
      if (!SEL_CTX.test(chunk)) continue
      const body = stripVarFallback(chunk)
      for (const m of body.matchAll(RING)) {
        // ≤1px 放行:0.5px 是卡片发丝边,1px 既是当前 --focus-ring 的值、也可能是色块那种「留白半径」——
        // 都不构成「圈太粗」。守的是**别再出现比 token 更粗的硬编码**(改回 2px 立刻红)。
        if (parseFloat(m[1]) <= 1) continue
        const line = src.slice(0, start + m.index).split('\n').length
        offenders.push(`${path.relative(GENESIS, file)}:${line}  ${m[0].trim().slice(0, 100)}`)
      }
    }
  }
}
check(
  'A 选中语境里没有比 --focus-ring 更粗的硬编码圈宽(按规则块扫,不是逐行)',
  offenders.length === 0,
  offenders.length ? `\n    ${offenders.join('\n    ')}` : `扫了 ${ROOTS.join(' / ')}`,
)

// ── B. 渲染实测 ──────────────────────────────────────────────────────────
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium(设 CHROMIUM_EXE 指一个)')
}

// ⚠️ 必须带上一份主题包:--primary / --surface-2 / --text-sec 都住在那儿。缺了它们,
//    `outline: 1px solid var(--primary)` 是 invalid-at-computed-value-time → 整条变 unset →
//    量出来是 `3px none`(UA 默认),看着像"改没生效",其实是复刻页缺 token。origin 是默认主题。
const CSS = [
  'desktop/frontend/src/amadeus/theme/themes/origin/theme.css',
  'desktop/frontend/src/styles/base.css',
  'desktop/frontend/src/amadeus/styles.css',
]
  .map((p) => fs.readFileSync(path.join(GENESIS, p), 'utf8'))
  .join('\n')

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage()
  await page.setContent(
    `<!doctype html><style>${CSS}</style>
     <div class="am-app"><div class="amx-coverpick-search"><input id="q"></div>
     <button class="switch" id="sw"></button>
     <button class="swatch" data-active id="sk"></button></div>`,
  )
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'))
  await page.focus('#q')
  const m = await page.evaluate(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s))
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim(),
      inputRing: cs('#q').outlineWidth,
      inputStyle: cs('#q').outlineStyle,
      swatch: cs('#sk').boxShadow,
    }
  })
  check('B1 --focus-ring token 解析得到(不是空/无效)', /^\d/.test(m.token), `--focus-ring: ${m.token || '(空)'}`)
  check(
    'B2 聚焦输入框的 outline 真是 1px 实心(截图里图库搜索框那圈)',
    parseFloat(m.inputRing) === 1 && m.inputStyle === 'solid',
    `${m.inputRing} ${m.inputStyle}`,
  )
  // 选中色块:内圈 1px 留白 + 外圈线,总半径应为 1px + --focus-ring = 2px
  check('B3 选中色块的圈同步减半(外半径 2px:1px 留白 + 1px 线)', /\b2px\b/.test(m.swatch) && !/\b3px\b/.test(m.swatch), m.swatch.slice(0, 120))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
