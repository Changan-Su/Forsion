/**
 * Genesis 主题色契约：设计语言 × 配色 × 明暗的正文、弱信息、强调色和关键按钮都必须可读。
 * 这不是像素快照；它在 Chromium 中让 CSS 真正层叠/解析，再按 WCAG 2.x 相对亮度量最终 computed color。
 *
 * 跑：npm run check:themecontrast
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const d of dirs) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const executable = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(executable)) return executable
    }
  }
  throw new Error('找不到 chromium，设 CHROMIUM_EXE 环境变量')
}

const SRC = path.join(__dirname, '../frontend/src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
require('sucrase/register/ts')
const { SEED_THEMES } = require(path.join(__dirname, '../electron/seedThemes.ts'))
const SOFT_CSS = SEED_THEMES.find((theme) => theme.id === 'soft')?.css
if (!SOFT_CSS) throw new Error('缺少第一方 soft 磁盘种子主题')
const LANGS = ['lovable', 'genesis-glass', 'soft', 'zhi']
const SKINS = ['cream', 'coral', 'teal', 'lavender', 'zhi']
const COLOR_TOKENS = [
  'bg', 'bg-card', 'bg-glass', 'sidebar-bg', 'text', 'text-light', 'text-muted', 'text-faint', 'text-ghost',
  'border', 'shadow', 'accent', 'accent-ink', 'accent-hover', 'accent-light', 'accent-rgb', 'on-accent',
  'on-accent-ink', 'action-fill', 'action-fill-hover', 'on-action', 'green', 'danger', 'on-danger', 'danger-light', 'warning', 'warning-light', 'overlay-subtle', 'overlay-light', 'overlay-medium',
  'overlay-strong', 'overlay-scrim', 'user-bg', 'tool-bg', 'tool-text', 'glow',
]

// Origin 故意最后放：它的裸 [data-mode] 是实际串色来源。Genesis host bridge 必须靠更精确的 scope 赢回来。
const CSS = [
  read('styles/base.css'),
  read('theme/skins.css'),
  ...LANGS.map((id) => id === 'soft' ? SOFT_CSS : read(`theme/themes/${id}/theme.css`)),
  read('views/chat2/chat2.css'),
  fs.readFileSync(path.join(__dirname, '../../lcl/engine/singleColumn.css'), 'utf8'),
  read('amadeus-host.css'),
  read('amadeus/styles.css'),
  read('amadeus/theme/themes/origin/theme.css'),
].join('\n')

const { customAccentVars, customBgVars } = require(path.join(SRC, 'theme/lcl/lovableData.ts'))

const CUSTOM_ACCENTS = [
  { label: 'custom:purple', seed: '#8b7fd6' },
  { label: 'custom:white', seed: '#ffffff' },
  { label: 'custom:black', seed: '#000000' },
  { label: 'custom:red', seed: '#ff0000' },
  { label: 'custom:lime', seed: '#00ff00' },
]
const CUSTOM_BACKGROUNDS = [
  { label: 'custom:black', seed: '#000000' },
  { label: 'custom:white', seed: '#ffffff' },
]

function rgbChannels(value) {
  const values = String(value).match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!values || values.length !== 3) throw new Error(`无法解析颜色: ${value}`)
  return values.map((channel) => channel / 255)
}

function okLab(value) {
  const [r, g, blue] = rgbChannels(value).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * blue)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLab 欧氏距离 ×100；3 左右已明显超过并排色块的刚可辨差异。 */
function perceptualDistance(a, b) {
  const x = okLab(a)
  const y = okLab(b)
  return Math.hypot(...x.map((channel, index) => (channel - y[index]) * 100))
}

function perceptualChroma(value) {
  const [, a, b] = okLab(value)
  return Math.hypot(a, b) * 100
}

function perceptualLightness(value) {
  return okLab(value)[0] * 100
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
* { transition: none !important; animation: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); }
.matrix { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 20px; }
.surface { min-height: 110px; padding: 14px; border: 1px solid var(--border); }
.surface-bg { background: var(--bg); }
.surface-card { background: var(--bg-card); }
.surface-sidebar { background: var(--sidebar-bg); }
.probe { display: block; font: 14px/1.5 sans-serif; }
.text { color: var(--text); } .text-light { color: var(--text-light); }
.text-muted { color: var(--text-muted); } .text-faint { color: var(--text-faint); }
.accent-ink { color: var(--accent-ink); } .green { color: var(--green); } .danger { color: var(--danger); }
.tool { margin-top: 8px; padding: 5px; background: var(--tool-bg); color: var(--tool-text); }
.buttons { display: flex; gap: 8px; align-items: center; padding: 0 20px 20px; }
.buttons > * { position: static !important; width: auto !important; min-width: 44px; min-height: 32px; }
.accent-hover-fill { background: var(--accent-hover); color: var(--on-accent); }
.danger-solid { background: var(--danger); color: var(--on-danger); }
.am-contract { margin: 0 20px 20px; padding: 10px; }
.am-contract .am-bg { background: var(--bg); color: var(--text); }
.am-contract .am-muted { color: var(--text-muted); }
.am-contract .am-primary { background: var(--primary); color: var(--on-primary); }
</style></head><body>
<main class="matrix">
  <section class="surface surface-bg"><span class="probe text">正文</span><span class="probe text-light">次要正文</span><span class="probe text-muted">辅助信息</span><span class="probe text-faint">弱信息</span><span class="probe accent-ink">强调文字</span><span class="probe green">成功</span><span class="probe danger">危险</span></section>
  <section class="surface surface-card"><span class="probe text">正文</span><span class="probe text-light">次要正文</span><span class="probe text-muted">辅助信息</span><span class="probe text-faint">弱信息</span><span class="probe accent-ink">强调文字</span><span class="probe green">成功</span><span class="probe danger">危险</span><div class="tool">工具信息</div></section>
  <aside class="surface surface-sidebar"><span class="probe text">正文</span><span class="probe text-light">次要正文</span><span class="probe text-muted">辅助信息</span><span class="probe text-faint">弱信息</span><span class="probe accent-ink">强调文字</span><span class="probe green">成功</span><span class="probe danger">危险</span></aside>
</main>
<div class="buttons surface-card">
  <button class="t2-btn primary">主要操作</button><button class="accent-hover-fill">悬停填充</button><button class="danger-solid">危险操作</button><button class="t2-send">发送</button><button class="t2-voice-play">播放</button><button class="sc-size on">字号</button>
</div>
<div class="am-app tangu-lovable amx-pane am-contract" data-mode="light"><div class="am-bg">编辑器正文 <span class="am-muted">编辑器辅助</span>
  <div class="highlight-fg"><span data-hlc="red" style="color:#c62222">红</span><span data-hlc="orange" style="color:#d34f0b">橙</span><span data-hlc="yellow" style="color:#b67c04">黄</span><span data-hlc="green" style="color:#149343">绿</span><span data-hlc="teal" style="color:#0782a0">青</span><span data-hlc="blue" style="color:#2159d3">蓝</span><span data-hlc="purple" style="color:#842ed3">紫</span><span data-hlc="magenta" style="color:#941555">品红</span><span data-hlc="grey" style="color:#7a7a7a">灰</span></div>
  <div class="highlight-bg"><mark data-hl="red" style="background:#fed5d5">红</mark><mark data-hl="orange" style="background:#fedfbb">橙</mark><mark data-hl="yellow" style="background:#fef3a1">黄</mark><mark data-hl="green" style="background:#e1fab1">绿</mark><mark data-hl="teal" style="background:#adf8e9">青</mark><mark data-hl="blue" style="background:#cce2fe">蓝</mark><mark data-hl="purple" style="background:#edddff">紫</mark><mark data-hl="magenta" style="background:#ffcece">粉</mark><mark data-hl="grey" style="background:#eaecef">灰</mark></div>
</div><button class="am-primary">编辑器主操作</button></div>
</body></html>`

const COLOR_UTILS = `
function parseColor(value) {
  const s = String(value)
  const values = s.match(/-?[\\d.]+/g) || []
  const scale = /^color\\(/.test(s) ? 255 : 1
  return { r: (+values[0] || 0) * scale, g: (+values[1] || 0) * scale, b: (+values[2] || 0) * scale, a: values.length > 3 ? +values[3] : 1 }
}
function composite(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg
  const b = typeof bg === 'string' ? parseColor(bg) : bg
  return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 }
}
function luminance(c) {
  const channel = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function surfaceUnder(el) {
  const layers = []
  for (let node = el; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (color.a > 0.001) layers.push(color)
    if (color.a > 0.999) break
  }
  let result = layers.pop() || { r: 255, g: 255, b: 255, a: 1 }
  while (layers.length) result = composite(layers.pop(), result)
  return result
}
function textRatio(el) {
  const bg = surfaceUnder(el)
  return contrast(composite(getComputedStyle(el).color, bg), bg)
}
`

function pass(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
  return ok
}

function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(file, out)
    else if (/\.(css|tsx?|jsx?)$/.test(entry.name)) out.push(file)
  }
  return out
}

;(async () => {
  // lovable/soft/zhi 是纯结构语言。genesis-glass 另有从 skin token 派生的材质别名(--bg-glass),故在浏览器矩阵验。
  const axisLeaks = []
  for (const lang of ['lovable', 'soft', 'zhi']) {
    const source = (lang === 'soft' ? SOFT_CSS : read(`theme/themes/${lang}/theme.css`)).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const token of COLOR_TOKENS) {
      if (new RegExp(`--${token.replace(/-/g, '\\-')}\\s*:`).test(source)) axisLeaks.push(`${lang}/--${token}`)
    }
  }
  const axisOk = pass('双轴纪律：结构语言不声明配色 token', axisLeaks.length === 0, axisLeaks.join(', '))

  // 颜色轴又拆成 主题色([data-skin]) × 背景色([data-bg]),两轴自由组合的**前提**是各管各的 token。
  // 一旦同一个 --var 两边都声明,后写的那块就会按源码顺序压过另一块 —— 组合出来的颜色随文件排版漂移,
  // 而且不会有任何东西变红(值仍然是合法颜色)。所以这条只能静态钉:两轴的键集必须不相交。
  const skinsCss = read('theme/skins.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const axisKeys = { skin: new Set(), bg: new Set() }
  for (const m of skinsCss.matchAll(/:root(?:\.dark)?\[data-(skin|bg)='[a-z]+'\]\s*\{([^}]*)\}/g)) {
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:/g)) axisKeys[m[1]].add(d[1])
  }
  const overlap = [...axisKeys.skin].filter((k) => axisKeys.bg.has(k)).sort()
  const bothPopulated = axisKeys.skin.size > 0 && axisKeys.bg.size > 0
  const disjointOk = pass('颜色两轴纪律：主题色与背景色的 token 集不相交',
    bothPopulated && overlap.length === 0,
    overlap.length ? `重复声明: ${overlap.join(', ')}` : `主题色 ${axisKeys.skin.size} 个 / 背景色 ${axisKeys.bg.size} 个`)

  // raw accent 是按钮填充色；文字/细线必须走 accent-ink。否则珊瑚、薰衣草、白色 custom 等会直接掉到 2–4:1。
  const rawForegrounds = []
  for (const file of filesUnder(SRC).concat(filesUnder(path.join(__dirname, '../../lcl')))) {
    const source = fs.readFileSync(file, 'utf8')
    const patterns = [
      /(?:^|[;{])\s*color\s*:\s*var\(--accent(?:-hover)?(?:,|\))/gm,
      /\bcolor\s*:\s*['"]var\(--accent(?:-hover)?(?:,|\))/gm,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length
        rawForegrounds.push(`${path.relative(path.join(__dirname, '..'), file)}:${line}`)
      }
    }
  }
  const semanticOk = pass('语义纪律：raw accent 不直接充当文字色', rawForegrounds.length === 0, rawForegrounds.join(', '))

  // raw accent 也不能给“带内容的实心面”上色；否则只能配黑字勉强过线，珊瑚/柔青/薰衣草都会像搭反。
  // 纯装饰点、进度条、下划线仍可使用 raw accent。
  const rawContentFills = []
  for (const file of filesUnder(SRC).concat(filesUnder(path.join(__dirname, '../../lcl'))).filter((p) => p.endsWith('.css'))) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2]
      const rawFill = /background(?:-color)?\s*:\s*(?:linear-gradient\([^;]*?)?var\(--accent(?:\)|,)/.test(body)
      const contentInk = /color\s*:\s*var\(--(?:on-accent|on-primary|bg)(?:\)|,)/.test(body)
      if (rawFill && contentInk) {
        const line = source.slice(0, match.index).split('\n').length
        rawContentFills.push(`${path.relative(path.join(__dirname, '..'), file)}:${line}`)
      }
    }
  }
  const fillSemanticOk = pass('语义纪律：带内容的实心交互使用 action-fill 配对', rawContentFills.length === 0, rawContentFills.join(', '))

  const mismatchedSurfaceInks = []
  for (const file of filesUnder(SRC).concat(filesUnder(path.join(__dirname, '../../lcl'))).filter((p) => p.endsWith('.css'))) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2]
      const primaryWhite = /background(?:-color)?\s*:\s*var\(--primary\)/.test(body) && /color\s*:\s*(?:#fff(?:fff)?|white)\b/i.test(body)
      const dangerWrong = /background(?:-color)?\s*:\s*var\(--danger(?:\)|,)/.test(body)
        && /color\s*:\s*(?:#fff(?:fff)?|white|var\(--(?:on-accent|on-primary)(?:\)|,))/i.test(body)
      if (primaryWhite || dangerWrong) {
        const line = source.slice(0, match.index).split('\n').length
        mismatchedSurfaceInks.push(`${path.relative(path.join(__dirname, '..'), file)}:${line}`)
      }
    }
  }
  const surfaceInkOk = pass('语义纪律：primary / danger 实心面使用各自配对前景', mismatchedSurfaceInks.length === 0, mismatchedSurfaceInks.join(', '))

  const themeCardSource = read('components/ThemeCard.tsx')
  const previewOk = pass('主题卡只预览结构，颜色跟随当前 skin',
    themeCardSource.includes("'--theme-preview-accent': 'var(--accent-ink)'")
      && !themeCardSource.includes('preview.background')
      && !themeCardSource.includes('preview.swatches'))

  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 960, height: 520 } })
  await page.setContent(PAGE)
  await page.addScriptTag({ content: COLOR_UTILS })

  // 浅色大面积表面可以直接表达色相，仍要求彼此明显可辨。
  // 暗色相反：大面积底必须回到同一组炭黑中性色，只留轻微色温；颜色身份由设置页完整种子色点表达。
  // 这里量最终 computed surface，避免再次为了“可辨”把整页推成棕、绿、紫、蓝色房间。
  const backgroundSamples = {}
  for (const mode of ['light', 'dark']) {
    backgroundSamples[mode] = {}
    for (const bg of SKINS) {
      backgroundSamples[mode][bg] = await page.evaluate(({ bg, mode }) => {
        const root = document.documentElement
        root.dataset.theme = 'lovable'
        root.dataset.skin = 'cream'
        root.dataset.bg = bg
        root.dataset.mode = mode
        root.classList.toggle('dark', mode === 'dark')
        root.style.cssText = ''
        return {
          bg: getComputedStyle(document.querySelector('.surface-bg')).backgroundColor,
          card: getComputedStyle(document.querySelector('.surface-card')).backgroundColor,
          sidebar: getComputedStyle(document.querySelector('.surface-sidebar')).backgroundColor,
        }
      }, { bg, mode })
    }
  }
  const backgroundAestheticFailures = []
  let closestLightBackgrounds = { distance: Infinity, id: '' }
  for (let i = 0; i < SKINS.length; i++) {
    for (let j = i + 1; j < SKINS.length; j++) {
      const a = SKINS[i]
      const b = SKINS[j]
      const distance = perceptualDistance(backgroundSamples.light[a].bg, backgroundSamples.light[b].bg)
      if (distance < closestLightBackgrounds.distance) closestLightBackgrounds = { distance, id: `${a}-${b}` }
      if (distance < 3) backgroundAestheticFailures.push(`light/${a}-${b} distance=${distance.toFixed(2)}`)
    }
  }
  let darkestMaxChroma = { value: 0, id: '' }
  for (const bg of SKINS) {
    const sample = backgroundSamples.dark[bg]
    for (const surface of ['bg', 'card', 'sidebar']) {
      const chroma = perceptualChroma(sample[surface])
      if (chroma > darkestMaxChroma.value) darkestMaxChroma = { value: chroma, id: `${bg}/${surface}` }
      if (chroma > 1.5) backgroundAestheticFailures.push(`dark/${bg}/${surface} chroma=${chroma.toFixed(2)}`)
    }
    const baseL = perceptualLightness(sample.bg)
    const cardLift = perceptualLightness(sample.card) - baseL
    const sidebarLift = perceptualLightness(sample.sidebar) - baseL
    if (baseL < 26 || baseL > 30) backgroundAestheticFailures.push(`dark/${bg}/base L=${baseL.toFixed(2)}`)
    if (cardLift < 3 || cardLift > 7) backgroundAestheticFailures.push(`dark/${bg}/card lift=${cardLift.toFixed(2)}`)
    if (sidebarLift < 1.5 || sidebarLift > 5) backgroundAestheticFailures.push(`dark/${bg}/sidebar lift=${sidebarLift.toFixed(2)}`)
  }
  const backgroundAestheticOk = pass('背景观感：浅色可辨，暗色保持低彩度炭黑层级', backgroundAestheticFailures.length === 0,
    backgroundAestheticFailures.length ? backgroundAestheticFailures.join(' ; ')
      : `浅色最近 ${closestLightBackgrounds.distance.toFixed(2)} @ ${closestLightBackgrounds.id}；暗色最高 C ${darkestMaxChroma.value.toFixed(2)} @ ${darkestMaxChroma.id}`)

  const accentCombos = [
    ...SKINS.map((skin) => ({ skin, label: skin })),
    ...CUSTOM_ACCENTS.map((item) => ({ skin: 'custom', ...item })),
  ]
  const backgroundCombos = [
    ...SKINS.map((bg) => ({ bg, label: bg })),
    ...CUSTOM_BACKGROUNDS.map((item) => ({ bg: 'custom', ...item })),
  ]
  const failures = []
  let worst = { ratio: Infinity, id: '' }

  for (const lang of LANGS) {
    for (const accentCombo of accentCombos) {
      for (const backgroundCombo of backgroundCombos) {
        for (const mode of ['light', 'dark']) {
          const dark = mode === 'dark'
          const inlineVars = {
            ...(accentCombo.seed ? customAccentVars(accentCombo.seed, dark) : {}),
            ...(backgroundCombo.seed ? customBgVars(backgroundCombo.seed, dark, true) : {}),
          }
          await page.evaluate(({ lang, skin, bg, mode, inlineVars }) => {
          const root = document.documentElement
          root.dataset.theme = lang
          root.dataset.skin = skin
          root.dataset.bg = bg
          root.dataset.mode = mode
          root.classList.toggle('dark', mode === 'dark')
          root.style.cssText = ''
          for (const [key, value] of Object.entries(inlineVars || {})) root.style.setProperty(key, value)
          document.querySelector('.am-app').dataset.mode = mode
          }, { lang, skin: accentCombo.skin, bg: backgroundCombo.bg, mode, inlineVars })

          const probes = await page.evaluate(() => {
          const out = []
          for (const surface of ['surface-bg', 'surface-card', 'surface-sidebar']) {
            for (const token of ['text', 'text-light', 'text-muted', 'text-faint', 'accent-ink', 'green', 'danger']) {
              const el = document.querySelector(`.${surface} .${token}`)
              out.push({ id: `${surface}/${token}`, ratio: textRatio(el) })
            }
          }
          out.push({ id: 'tool/tool-text', ratio: textRatio(document.querySelector('.tool')) })
          for (const selector of ['.t2-btn.primary', '.accent-hover-fill', '.danger-solid', '.t2-send', '.t2-voice-play', '.sc-size.on', '.am-primary']) {
            out.push({ id: selector, ratio: textRatio(document.querySelector(selector)) })
          }
          for (const el of document.querySelectorAll('.highlight-fg [data-hlc], .highlight-bg [data-hl]')) {
            out.push({ id: `rich-text/${el.dataset.hlc || `mark-${el.dataset.hl}`}`, ratio: textRatio(el) })
          }

          // Amadeus 内层必须和 Genesis 根契约一致；否则数字可能都过 AA，却还是串成另一套配色。
          const colorOf = (selector) => getComputedStyle(document.querySelector(selector)).color
          const backgroundOf = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor
          const rootText = colorOf('.surface-bg .text')
          const rootMuted = colorOf('.surface-bg .text-muted')
          const rootBg = backgroundOf('.surface-bg')
          return {
            out,
            bridge: {
              text: colorOf('.am-bg') === rootText,
              muted: colorOf('.am-muted') === rootMuted,
              bg: backgroundOf('.am-bg') === rootBg,
            },
          }
        })

          const prefix = `${lang}/${accentCombo.label}+${backgroundCombo.label}/${mode}`
          for (const probe of probes.out) {
            if (probe.ratio < worst.ratio) worst = { ratio: probe.ratio, id: `${prefix}/${probe.id}` }
            if (probe.ratio < 4.5) failures.push(`${prefix}/${probe.id}=${probe.ratio.toFixed(2)}`)
          }
          for (const [key, ok] of Object.entries(probes.bridge)) {
            if (!ok) failures.push(`${prefix}/amadeus-${key}=串色`)
          }
        }
      }
    }
  }

  await browser.close()
  const total = LANGS.length * accentCombos.length * backgroundCombos.length * 2
  const matrixOk = pass(`主题可读性矩阵：${total} 个语言×主题色×背景色×明暗组合`, failures.length === 0,
    failures.length ? failures.slice(0, 10).join(' ; ') + (failures.length > 10 ? ` …共 ${failures.length} 条` : '')
      : `最低 ${worst.ratio.toFixed(2)}:1 @ ${worst.id}`)
  process.exit(axisOk && disjointOk && semanticOk && fillSemanticOk && surfaceInkOk && previewOk && backgroundAestheticOk && matrixOk ? 0 : 1)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
