/**
 * Genesis 阴影契约静态闸门。
 *
 * 空间高程只能消费 --card-shadow / --btn-shadow / --icon-shadow（Amadeus 内部可经
 * --shadow-panel 桥接）；html[data-flat='1'] 会一次清空前三者。零模糊描边、focus/drop
 * 反馈及少量有明确语义的动效不属于空间高程，可保留，但必须落在下面的精确例外中。
 *
 * 跑：npm run check:shadowcontract
 */
const fs = require('fs')
const path = require('path')
const postcss = require('postcss')

const DESKTOP = path.resolve(__dirname, '..')
const ROOTS = [path.join(DESKTOP, 'frontend/src'), path.join(DESKTOP, '../lcl/engine')]
const CANONICAL = /^var\(--(?:card-shadow|btn-shadow|icon-shadow|shadow-panel)\b[\s\S]*\)$/

const norm = (value) => String(value).replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
const rel = (file) => norm(path.relative(DESKTOP, file))

function walk(dir, extensions) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file, extensions) : extensions.has(path.extname(entry.name)) ? [file] : []
  })
}

function splitLayers(value) {
  const layers = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1
    else if (value[i] === ')') depth = Math.max(0, depth - 1)
    else if (value[i] === ',' && depth === 0) {
      layers.push(value.slice(start, i))
      start = i + 1
    }
  }
  layers.push(value.slice(start))
  return layers
}

function stripFunctions(value) {
  let out = ''
  let depth = 0
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += char
  }
  return out
}

/** 0 blur 的 shadow 是描边/分隔线，不制造高程。 */
function isZeroBlurShadow(value) {
  return splitLayers(value).every((layer) => {
    const outsideFunctions = stripFunctions(layer)
    const lengths = [...outsideFunctions.matchAll(/(?:^|\s)(-?(?:\d+\.?\d*|\.\d+))(?:px|rem|em|pt)?(?=\s|$)/g)]
      .map((match) => Number(match[1]))
    return lengths.length >= 3 && lengths[2] === 0
  })
}

const EFFECT_EXCEPTIONS = new Map([
  ['frontend/src/styles/base.css|.cm-row-v.is-max, .cm-effort.is-max .cm-effort-value|text-shadow', 'Max 档位文字辉光'],
  ['frontend/src/styles/base.css|.cm-effort.is-max .cm-effort-range|box-shadow', 'Max 档位轨道辉光'],
  ['frontend/src/styles/base.css|.cm-effort.is-max .cm-effort-thumb|box-shadow', 'Max 档位滑块辉光'],
  ['frontend/src/styles/base.css|.cm-effort-sparkles i|box-shadow', 'Max 档位星点辉光'],
])

const INTERACTION_EXCEPTIONS = new Map([
  ['frontend/src/amadeus/styles.css|.am-app .amx-stage.amx-dropzone:not(.amx-stage-off)::after|box-shadow', '画布投放目标反馈'],
  ['frontend/src/amadeus/styles.css|.am-app .amx-el-selbox.is-editing|box-shadow', '画布编辑中卡片抬起反馈'],
  ['frontend/src/amadeus-host.css|.amx-cal-event.dragging|box-shadow', '日历事件拖拽反馈'],
  ['frontend/src/amadeus-host.css|.dash-card[data-dragging]|box-shadow', '旧仪表盘拖拽反馈'],
  ['frontend/src/views/dashCanvas.css|.dash2-card[data-interact]|box-shadow', '仪表盘交互期间抬起反馈'],
  ['frontend/src/views/dashCanvas.css|.dash2-card[data-dragging]|box-shadow', '仪表盘拖拽反馈'],
  ['frontend/src/views/dashGrid.css|.dash3-card--lift|box-shadow', '网格仪表盘 DragOverlay 跟手壳抬起反馈(只在浮层这一层,不落到格子里的卡)'],
])

/* LCL 展示页保留旧 token，但其自身 data-flat 规则会清空这些 token。 */
const LEGACY_CONTROLLED = new Set([
  'frontend/src/amadeus/lcl/shell.css',
  'frontend/src/amadeus/theme/lcl/recipes.css',
  'frontend/src/amadeus/theme/lcl/tangu.css',
  'frontend/src/amadeus/theme/lcl/tanguSoft.css',
])

function exceptionReason(file, selector, prop, value) {
  const key = `${rel(file)}|${norm(selector)}|${prop}`
  if (EFFECT_EXCEPTIONS.has(key)) return EFFECT_EXCEPTIONS.get(key)
  if (INTERACTION_EXCEPTIONS.has(key)) return INTERACTION_EXCEPTIONS.get(key)
  if (LEGACY_CONTROLLED.has(rel(file)) && (/^var\(--(?:shadow|shadow-sm|focus|stage-shadow)\b/.test(value) || /var\(--stage-shadow\b/.test(value))) {
    return 'LCL 旧展示页自带 data-flat 清零规则'
  }
  return ''
}

function classifyShadow(file, selector, prop, value) {
  const clean = value.trim()
  if (clean === 'none') return { ok: true, kind: 'none' }
  if (prop === 'box-shadow' && CANONICAL.test(clean)) return { ok: true, kind: 'token' }
  if (prop === 'box-shadow' && isZeroBlurShadow(clean)) return { ok: true, kind: 'line' }
  const reason = exceptionReason(file, selector, prop, clean)
  if (reason) return { ok: true, kind: 'exception', reason }
  return { ok: false, reason: '空间阴影必须改用统一高程 token；若是交互/特效，添加精确例外并写明原因' }
}

const violations = []
const stats = { css: 0, source: 0, token: 0, line: 0, exception: 0 }
const cssFiles = ROOTS.flatMap((root) => walk(root, new Set(['.css'])))

for (const file of cssFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const root = postcss.parse(source, { from: file })
  stats.css += 1
  root.walkDecls((decl) => {
    const relevant = decl.prop === 'box-shadow' || decl.prop === 'text-shadow' || (decl.prop === 'filter' && decl.value.includes('drop-shadow'))
    if (!relevant) return
    const selector = decl.parent.selector || decl.parent.name || '<unknown>'
    const result = classifyShadow(file, selector, decl.prop, decl.value)
    if (result.ok) {
      if (result.kind in stats) stats[result.kind] += 1
      return
    }
    violations.push({ file: rel(file), line: decl.source.start.line, selector: norm(selector), prop: decl.prop, value: norm(decl.value), reason: result.reason })
  })
}

/* TS/TSX 中的 WAAPI / inline style 也会绕过 CSS，非 token 值必须同行标注用途。 */
const sourceFiles = walk(path.join(DESKTOP, 'frontend/src'), new Set(['.ts', '.tsx', '.js', '.jsx']))
for (const file of sourceFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  stats.source += 1
  lines.forEach((line, index) => {
    if (!/(?:boxShadow\s*:|box-shadow\s*:)/.test(line)) return
    if (/var\(--(?:card-shadow|btn-shadow|icon-shadow|shadow-panel)\b/.test(line) || /(?:boxShadow\s*:|box-shadow\s*:)\s*['"]?none\b/.test(line)) return
    if (/shadow-contract:\s*(?:interaction|effect)\b/.test(line)) {
      stats.exception += 1
      return
    }
    violations.push({
      file: rel(file), line: index + 1, selector: '<inline>', prop: 'boxShadow', value: norm(line),
      reason: 'inline/WAAPI 阴影必须用统一 token，或同行标注 shadow-contract: interaction/effect',
    })
  })
}

/* 契约自身也要被钉住，避免扫描通过但 flat 开关不再清 token。 */
const baseFile = path.join(DESKTOP, 'frontend/src/styles/base.css')
const baseRoot = postcss.parse(fs.readFileSync(baseFile, 'utf8'), { from: baseFile })
const cleared = new Set()
baseRoot.walkRules("html[data-flat='1'][data-mode]", (rule) => rule.walkDecls((decl) => {
  if (decl.value.trim() === 'none') cleared.add(decl.prop)
}))
for (const token of ['--card-shadow', '--btn-shadow', '--icon-shadow', '--shadow-panel']) {
  if (!cleared.has(token)) violations.push({ file: rel(baseFile), line: 1, selector: "html[data-flat='1'][data-mode]", prop: token, value: '<missing>', reason: 'flat 契约必须把该 token 置为 none' })
}

/* 负控件：防止未来误改扫描器，让明显的硬编码阴影也被放过。 */
const negative = classifyShadow(baseFile, '.shadow-contract-negative-control', 'box-shadow', '0 24px 64px rgba(0, 0, 0, 0.32)')
if (negative.ok) violations.push({ file: rel(__filename), line: 1, selector: '.shadow-contract-negative-control', prop: 'box-shadow', value: '0 24px 64px rgba(0, 0, 0, 0.32)', reason: '扫描器负控件失效' })

if (violations.length) {
  console.error(`FAIL  shadow contract (${violations.length} 项)`) // eslint-disable-line no-console
  for (const item of violations) {
    console.error(`  ${item.file}:${item.line}  ${item.selector}\n    ${item.prop}: ${item.value}\n    ${item.reason}`) // eslint-disable-line no-console
  }
  process.exitCode = 1
} else {
  console.log(`PASS  shadow contract | CSS ${stats.css} 个，源码 ${stats.source} 个，token ${stats.token} 处，零模糊描边 ${stats.line} 处，显式例外 ${stats.exception} 处`) // eslint-disable-line no-console
}
