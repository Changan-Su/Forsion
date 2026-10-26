/**
 * 动效静态闸门(DESIGN §3「动效」,2026-10-23 借鉴 Comma 方案 §4)。
 *
 * 钉三件事:
 *  1. 菜单进场名单 == 退场名单(base.css 里 `ui-menu-enter` 与 `[data-lcl-exit]` 那两张 :is() 表,含减少动态效果的两份)。
 *     进场加了一种菜单、退场忘了加 → 它在 OverlayAt 里关掉也是一下子没了。
 *  2. 命令面板 / ⌘P / 确认框有退场:遮罩有 `[data-lcl-exit]` 规则,组件里接了 useExitGhost。
 *     2b. 替身缺省不动画那条的 :not() 表盖住所有写了 `[data-lcl-exit]` 退场规则的类(走查续八 8.1)。
 *  3. 棘轮(不许变多,变少了提示收紧基线):
 *     - 托管样式(frontend/src、lcl)里 transition / animation 写死的时长(`var(--x, 150ms)` 的兜底不算,0 不算);
 *     - TSX 里不经 OverlayAt 直接画的菜单(className 带进场名单里的类、却不是 <OverlayAt>):这些关掉没有退场。
 *     新代码请用 base.css :root 的动效 token,菜单走 OverlayAt。
 *
 * 跑:npm run check:motion;收紧基线:npm run check:motion -- --update
 */
const fs = require('fs')
const path = require('path')
const postcss = require('postcss')

const DESKTOP = path.resolve(__dirname, '..')
const ROOTS = [path.join(DESKTOP, 'frontend/src'), path.join(DESKTOP, '../lcl')]
const BASELINE = path.join(__dirname, 'motion-baseline.json')
const BASE_CSS = path.join(DESKTOP, 'frontend/src/styles/base.css')
const SCRIMS = [
  { cls: 'cmd-overlay', css: '../lcl/engine/engine.css', tsx: '../lcl/engine/CommandPalette.tsx' },
  { cls: 'amx-qf-scrim', css: 'frontend/src/quickFind.css', tsx: 'frontend/src/quickFind.tsx' },
  { cls: 'dialog-overlay', css: 'frontend/src/amadeus/styles.css', tsx: 'frontend/src/amadeus/components/DialogOverlay.tsx' },
]

const rel = (file) => path.relative(DESKTOP, file).replace(/\\/g, '/')
function walk(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const f = path.join(dir, e.name)
    return e.isDirectory() ? walk(f, exts) : exts.has(path.extname(e.name)) ? [f] : []
  })
}

const fails = []
const notes = []

// ---- 1. 进场名单 == 退场名单 ----
const isList = (sel) => (sel.match(/:is\(([^)]*)\)/) || [])[1]?.split(',').map((s) => s.trim()).filter(Boolean).sort().join(' ')
const lists = { enter: [], exit: [] }
postcss.parse(fs.readFileSync(BASE_CSS, 'utf8')).walkRules((rule) => {
  if (!rule.selector.startsWith('html:root :is(')) return
  const list = isList(rule.selector)
  if (!list) return
  rule.walkDecls(/^animation(-name)?$/, (d) => {
    if (rule.selector.includes('[data-lcl-exit]')) lists.exit.push(list)
    else if (/ui-menu-enter|^none$/.test(d.value)) lists.enter.push(list)
  })
})
const all = [...lists.enter, ...lists.exit]
if (lists.enter.length < 2 || lists.exit.length < 2) fails.push(`base.css:进场 / 退场名单没找全(进场 ${lists.enter.length} 份、退场 ${lists.exit.length} 份,各应有常规 + 减少动态效果两份)`)
else if (new Set(all).size !== 1) fails.push(`base.css:菜单进场与退场名单不一致\n    ${[...new Set(all)].join('\n    ')}`)
const menuClasses = (lists.enter[0] || '').split(' ').map((s) => s.replace(/^\./, ''))

// ---- 2. 遮罩类浮层有退场 ----
for (const s of SCRIMS) {
  const css = fs.readFileSync(path.join(DESKTOP, s.css), 'utf8')
  if (!new RegExp(`\\.${s.cls}\\[data-lcl-exit\\]`).test(css)) fails.push(`${s.css}:.${s.cls} 没有 [data-lcl-exit] 退场规则`)
  const tsx = fs.readFileSync(path.join(DESKTOP, s.tsx), 'utf8')
  if (!/useExitGhost\(/.test(tsx)) fails.push(`${s.tsx}:.${s.cls} 没接 useExitGhost,关掉没有退场`)
}

// ---- 2b. 替身缺省不动画(走查续八 8.1):base.css 那条 `[data-lcl-exit]:not(…) { animation: none !important }` 的 :not() 表
//      必须盖住所有写了 `[data-lcl-exit]` 退场规则的类 —— 漏一个,它的退场就被那条 !important 吃掉,关掉又是一下子没了。 ----
const noneList = new Set()
postcss.parse(fs.readFileSync(BASE_CSS, 'utf8')).walkRules((rule) => {
  const m = rule.selector.match(/^\[data-lcl-exit\]:not\(([^)]*)\)$/)
  if (m) m[1].split(',').forEach((s) => noneList.add(s.trim().replace(/"/g, "'")))
})
if (!noneList.size) fails.push('base.css:找不到替身缺省不动画那条 `[data-lcl-exit]:not(…) { animation: none !important }`')
const missingExit = new Set()
for (const file of ROOTS.flatMap((r) => walk(r, new Set(['.css'])))) {
  let root
  try { root = postcss.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
  root.walkRules((rule) => {
    if (!rule.selector.includes('[data-lcl-exit]') || rule.selector.startsWith('[data-lcl-exit]')) return
    let animated = false
    rule.walkDecls(/^animation(-name)?$/, (d) => { if (d.value.trim() !== 'none') animated = true })
    if (!animated) return
    for (const part of rule.selectors) {
      const m = part.match(/((?:\.[\w-]+)+|:is\([^)]*\)|\[data-motion~=['"]?\w+['"]?\])\[data-lcl-exit\]/)
      if (!m) continue
      const keys = m[1].startsWith(':is(') ? m[1].slice(4, -1).split(',').map((s) => s.trim()) : m[1].startsWith('[') ? [m[1].replace(/"/g, "'")] : m[1].match(/\.[\w-]+/g)
      if (noneList.size && !keys.some((k) => noneList.has(k))) missingExit.add(`${rel(file)} ${keys.join('')}`)
    }
  })
}
for (const k of missingExit) fails.push(`${k}:写了 [data-lcl-exit] 退场,却不在 base.css 替身缺省不动画那条的 :not() 表里(退场会被吃掉)`)

// ---- 3. 棘轮 ----
const counts = { durations: {}, menusWithoutExit: {} }
const stripVars = (v) => {
  let out = ''
  let depth = 0
  for (let i = 0; i < v.length; i++) {
    if (depth === 0 && v.startsWith('var(', i)) { depth = 1; i += 3; continue }
    if (depth > 0) { if (v[i] === '(') depth++; else if (v[i] === ')') depth--; continue }
    out += v[i]
  }
  return out
}
const hardDurations = (v) => (stripVars(v).match(/(?<![\w.-])(?:\d+\.?\d*|\.\d+)m?s\b/g) || []).filter((t) => parseFloat(t) !== 0)
for (const file of ROOTS.flatMap((r) => walk(r, new Set(['.css'])))) {
  let root
  try { root = postcss.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
  let n = 0
  root.walkDecls(/^(transition|animation)(-duration|-delay)?$/, (d) => { n += hardDurations(d.value).length })
  if (n) counts.durations[rel(file)] = n
}
if (menuClasses.length) {
  const re = new RegExp(`<(?!OverlayAt\\b)[a-z][\\w.]*\\b[^<>]*?className=(?:"|'|\\{\`?)[^"'\`}]*(?<![\\w-])(?:${menuClasses.join('|')})(?![\\w-])`, 'g')
  for (const file of ROOTS.flatMap((r) => walk(r, new Set(['.tsx'])))) {
    if (/\.test\.tsx$/.test(file)) continue
    const n = (fs.readFileSync(file, 'utf8').match(re) || []).length
    if (n) counts.menusWithoutExit[rel(file)] = n
  }
}

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n')
  console.log(`check:motion 基线已写入 ${rel(BASELINE)}`)
} else {
  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { durations: {}, menusWithoutExit: {} }
  const label = { durations: '写死的动效时长', menusWithoutExit: '不经 OverlayAt 的菜单(关掉没有退场)' }
  for (const kind of Object.keys(counts)) {
    const files = new Set([...Object.keys(counts[kind]), ...Object.keys(base[kind] || {})])
    for (const f of files) {
      const now = counts[kind][f] || 0
      const was = (base[kind] || {})[f] || 0
      if (now > was) fails.push(`${f}:${label[kind]} ${was} → ${now}(用 base.css :root 的动效 token${kind === 'menusWithoutExit' ? ' / 改用 OverlayAt' : ''})`)
      else if (now < was) notes.push(`${f}:${label[kind]} ${was} → ${now},可以收紧基线(-- --update)`)
    }
  }
}

for (const n of notes) console.log(`  · ${n}`)
if (fails.length) {
  console.error(`✗ check:motion ${fails.length} 处\n  - ${fails.join('\n  - ')}`)
  process.exit(1)
}
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0)
console.log(`✓ check:motion 进退名单一致(${menuClasses.length} 类)· 遮罩退场 ${SCRIMS.length} 处 · 写死时长 ${total(counts.durations)} 处 / 无退场菜单 ${total(counts.menusWithoutExit)} 处(均不超基线)`)
