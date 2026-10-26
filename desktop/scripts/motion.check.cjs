/**
 * 动效静态闸门(DESIGN §3「动效」,2026-10-23 借鉴 Comma 方案 §4)。
 *
 * 钉三件事:
 *  1. 菜单进场名单 == 退场名单(base.css 里 `ui-menu-enter` 与 `[data-lcl-exit]` 那两张 :is() 表,含减少动态效果的两份)。
 *     进场加了一种菜单、退场忘了加 → 它在 OverlayAt 里关掉也是一下子没了。
 *  2. 命令面板 / ⌘P 有退场:遮罩有 `[data-lcl-exit]` 规则,组件里接了 useExitGhost。
 *  3. 棘轮(不许变多,变少了提示收紧基线):
 *     - 托管样式(frontend/src、lcl)里 transition / animation 写死的时长(`var(--x, 150ms)` 的兜底不算,0 不算);
 *     - TSX 里不经 OverlayAt 直接画的菜单(className 带进场名单里的类、却不是 <OverlayAt>):这些关掉没有退场。
 *     - TS / TSX 里 el.animate(…) / framer transition 的字面量时长、曲线(tsLiterals;改读 frontend/src/theme/motionTokens.ts);
 *     - 补间布局属性(宽高 / 内外边距 / flex-basis)的 transition(layoutTweens;尺寸请用 data-motion="collapse" 或 transform);
 *     - 弃用的 token 名 --ease-spring / --ease-out / --ease-apple / --dur-*(deprecatedTokens;别名表见 base.css :root)。
 *     新代码请用 base.css :root 的动效 token,菜单走 OverlayAt。
 *  4. transition: all 与不写属性的 transition(等于 all)直接报错(2026-10-26 走查续八 8.11)。
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

// ---- 3. 棘轮 ----
const counts = { durations: {}, menusWithoutExit: {}, tsLiterals: {}, layoutTweens: {}, deprecatedTokens: {} }
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
// 按顶层逗号 / 空白切(括号里的不切)
const splitTop = (v, sep) => {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of v) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && sep.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const NOT_PROP = /^(?:(?:\d+\.?\d*|\.\d+)m?s|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|allow-discrete|normal|(?:cubic-bezier|steps|linear|var)\(.*\))$/
// transition 每一段里的属性名;没写属性 = all。整段只有 var() 的认不出,跳过
const transitionProps = (d) => splitTop(d.value, /,/).flatMap((seg) => {
  if (d.prop === 'transition-property') return [seg]
  const toks = splitTop(seg, /\s/)
  if (toks.every((t) => /^var\(/.test(t))) return []
  const props = toks.filter((t) => !NOT_PROP.test(t))
  return props.length ? props : ['all']
})
const LAYOUT_PROP = /^(?:(?:min-|max-)?(?:width|height)|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|flex-basis)$/
const DEPRECATED = /var\(\s*--(?:ease-(?:spring|out|apple)|dur-[a-z]+)(?![\w-])/g
const allTransitions = []
for (const file of ROOTS.flatMap((r) => walk(r, new Set(['.css'])))) {
  const src = fs.readFileSync(file, 'utf8')
  let root
  try { root = postcss.parse(src) } catch { continue }
  let n = 0
  let layout = 0
  root.walkDecls(/^(transition|animation)(-duration|-delay)?$/, (d) => { n += hardDurations(d.value).length })
  root.walkDecls(/^transition(-property)?$/, (d) => {
    const props = transitionProps(d)
    if (props.includes('all')) allTransitions.push(`${rel(file)}:${d.source.start.line} ${d.prop}: ${d.value}`)
    layout += props.filter((p) => LAYOUT_PROP.test(p)).length
  })
  if (n) counts.durations[rel(file)] = n
  if (layout) counts.layoutTweens[rel(file)] = layout
}
if (allTransitions.length) fails.push(`transition: all(或不写属性)${allTransitions.length} 处 —— 写明要过渡的属性(如 background-color, color, border-color, box-shadow)\n    ${allTransitions.join('\n    ')}`)
// TS / TSX:el.animate(…) 与 framer transition 里的字面量;motionTokens.ts 本身就是 token 的出口,带兜底值,不算
const TS_MOTION = /\.animate\(|\btransition(?:=\{|:\s*)\{/g
const TS_LITERAL = /\b(?:duration|delay):\s*\d|\bease:\s*\[|\beasing:\s*['"`]|\bstiffness:\s*\d/g
const spanFrom = (src, i) => {
  const open = src.indexOf(src[i] === '.' ? '(' : '{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if ('({['.includes(src[j])) depth++
    else if (')}]'.includes(src[j]) && --depth === 0) return src.slice(open, j + 1)
  }
  return src.slice(open)
}
for (const file of ROOTS.flatMap((r) => walk(r, new Set(['.ts', '.tsx', '.css'])))) {
  if (/\.test\.tsx?$/.test(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  const dep = (src.match(DEPRECATED) || []).length
  if (dep) counts.deprecatedTokens[rel(file)] = dep
  if (file.endsWith('.css') || rel(file) === 'frontend/src/theme/motionTokens.ts') continue
  let lit = 0
  for (const m of src.matchAll(TS_MOTION)) lit += (spanFrom(src, m.index).match(TS_LITERAL) || []).length
  if (lit) counts.tsLiterals[rel(file)] = lit
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
  const label = {
    durations: '写死的动效时长',
    menusWithoutExit: '不经 OverlayAt 的菜单(关掉没有退场)',
    tsLiterals: 'TS 里写死的动效时长 / 曲线',
    layoutTweens: '补间布局属性',
    deprecatedTokens: '弃用的动效 token 名',
  }
  const fix = {
    durations: '用 base.css :root 的动效 token',
    menusWithoutExit: '用 base.css :root 的动效 token / 改用 OverlayAt',
    tsLiterals: '改读 theme/motionTokens.ts',
    layoutTweens: '尺寸请用 data-motion="collapse" 或 transform',
    deprecatedTokens: '换成别名表里的新名:--ease-surface / --ease-calm / --duration-*',
  }
  for (const kind of Object.keys(counts)) {
    const files = new Set([...Object.keys(counts[kind]), ...Object.keys(base[kind] || {})])
    for (const f of files) {
      const now = counts[kind][f] || 0
      const was = (base[kind] || {})[f] || 0
      if (now > was) fails.push(`${f}:${label[kind]} ${was} → ${now}(${fix[kind]})`)
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
console.log(`✓ check:motion 进退名单一致(${menuClasses.length} 类)· 遮罩退场 ${SCRIMS.length} 处 · 无 transition: all · 写死时长 ${total(counts.durations)} / 无退场菜单 ${total(counts.menusWithoutExit)} / TS 字面量 ${total(counts.tsLiterals)} / 补间布局 ${total(counts.layoutTweens)} / 弃用 token ${total(counts.deprecatedTokens)} 处(均不超基线)`)
