/**
 * 圆角契约棘轮(DESIGN §3「圆角契约」,2026-11-23 控件档回到 8px 时立的)。
 *
 * 契约:组件只消费 token —— xs 小件(短边 ≤ 18px)· sm 控件 · md 浮层与普通卡 · lg 大面板 · pill 胶囊;圆用 50%。
 * 本脚本在托管样式(desktop 渲染层、lcl、mobile、web 的 CSS 与 TS / TSX)里钉这些事:
 *  1. 定义只有一处:--radius-sm / md / lg(及 chat 别名)只许在 base.css 的 :root 与随包主题里声明;
 *     --radius-xs(= calc(var(--radius-sm) / 2))、--radius-pill、--radius-xl(给老插件留的弃用别名 = lg)只许在 base.css :root,
 *     且 xs / xl 必须是原样那一句。
 *  2. 不写数字:border-*-radius(含逻辑属性、多行简写、TS 样式对象里的三元)不许写 > 3px 的数字(≤ 3px 算笔画几何);
 *     成对几何写成 calc(token ± n),运算符后的偏移不算。999px 一类用 pill。
 *  3. 兜底等于缺省:var(--radius-sm, X) 的 X 必须等于 base.css 的缺省值;嵌套兜底逐层查,chat 别名按它指向的档位算。
 *  4. 小件用 xs:同一条规则里能算出外框短边 ≤ 18px(声明的宽高 + 内边距 + 描边,按 box-sizing)却用 sm → 红。
 *  5. 不认识的圆角变量(var(--radius)、var(--radius-xl)…)→ 红;本地桥接变量要进 BRIDGE_VARS,它们的定义也按同一套查。
 * 例外进 radius-ledger.json:按文件记每一处例外(选择器 + 问题)和理由。出现台账里没有的一处就红,换掉一处也算新的;
 * 变少了提示收紧。-- --update 按现状重写:删掉已经消失的,有新增的文件理由改成 TODO(必须重写理由才过)。
 * 范围外:desktop/electron 主进程自绘的独立小页(权限引导等)不加载 base.css,没有 token 可用。
 *
 * 跑:npm run check:radius
 */
const fs = require('fs')
const path = require('path')

const DESKTOP = path.resolve(__dirname, '..')
const REPO = path.resolve(DESKTOP, '..')
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src'].map((r) => path.join(REPO, r))
const LEDGER = path.join(__dirname, 'radius-ledger.json')
const BASE_REL = 'desktop/frontend/src/styles/base.css'
// 整个文件不在契约里(写明理由)
const EXCLUDE = {
  'desktop/frontend/src/amadeus/theme/lcl/tangu.css': '未被引用的 LCL 早期快照(研究页 #/tangu 的词表),产品不加载',
}
// 能声明 sm / md / lg 的主题文件(作用域都在 <html> 上,xs / xl 跟着派生)
const isThemeFile = (r) => /^desktop\/frontend\/src\/theme\/themes\/[^/]+\/theme\.css$/.test(r) || r === 'desktop/frontend/src/amadeus/theme/themes/dreamer/theme.css'
const SKIP_FILE = /(\.test\.tsx?$|[Hh]arness[^/]*\.tsx?$|\/harness\/|\/fixtures\/)/
const TOKENS = new Set(['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill', '--radius-chat-surface', '--radius-chat-card'])
// 桥接变量:可以出现在 border-radius 里,它们的定义本身也按同一套规则查(只许由 token 派生)
const BRIDGE_VARS = new Set([
  '--fs-radius', // 草图 iframe 的桥接变量,sketchWrapper.ts 映射到 --radius-sm
  '--border-radius-lg', '--border-radius-md', // Excalidraw 自己的变量,excalidrawTheme.css 映射到 md / lg
  '--t2-card-r', // 工具摘要卡按高程切换的圆角,chat2.css 里由 --radius-md 给值
])
const GEOMETRY_VARS = new Set(['--border-width']) // 同心内圆角 calc(token - 描边)
const DEF_SHARED = new Set(['--radius-sm', '--radius-md', '--radius-lg', '--radius-chat-surface', '--radius-chat-card'])
const DEF_BASE_ONLY = new Set(['--radius-xs', '--radius-pill', '--radius-xl'])

const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/')
function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'out' || e.name.startsWith('.')) return []
    const f = path.join(dir, e.name)
    if (e.isDirectory()) return walk(f)
    return /\.(css|ts|tsx)$/.test(e.name) && !SKIP_FILE.test(rel(f)) ? [f] : []
  })
}
const blank = (s) => s.replace(/[^\n]/g, ' ')

// ── 缺省值从 base.css :root 读(脚本里不再写第二份)
const fails = []
const baseSrc = fs.readFileSync(path.join(REPO, BASE_REL), 'utf8').replace(/\/\*[\s\S]*?\*\//g, blank)
const rootStart = baseSrc.search(/(^|\n)\s*:root\s*\{/)
const rootEnd = baseSrc.indexOf('}', rootStart)
const rootBlock = baseSrc.slice(rootStart, rootEnd)
const def = (name) => (rootBlock.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*([^;]+);`)) || [])[1]?.trim()
const DEFAULTS = { sm: def('--radius-sm'), md: def('--radius-md'), lg: def('--radius-lg'), pill: def('--radius-pill') }
for (const [k, v] of Object.entries(DEFAULTS)) if (!v || !/^\d+px$/.test(v)) fails.push(`base.css :root 的 --radius-${k} 读不到或不是 px 数值:${v}`)
if (def('--radius-xs') !== 'calc(var(--radius-sm) / 2)') fails.push(`base.css :root 的 --radius-xs 必须是 calc(var(--radius-sm) / 2),现在是 ${def('--radius-xs')}`)
if (def('--radius-xl') !== 'var(--radius-lg)') fails.push(`base.css :root 的 --radius-xl(插件契约的弃用别名)必须是 var(--radius-lg),现在是 ${def('--radius-xl')}`)
DEFAULTS.xs = `${parseFloat(DEFAULTS.sm) / 2}px`
const alias = (name) => (def(name) || '').match(/^var\(--radius-(\w+)\)$/)?.[1]
DEFAULTS['chat-surface'] = DEFAULTS[alias('--radius-chat-surface')]
DEFAULTS['chat-card'] = DEFAULTS[alias('--radius-chat-card')]

/** 值里顶层的 var(…):[{ name, fallback, start, end }],括号配平 */
function vars(val) {
  const out = []
  for (let i = val.indexOf('var('); i >= 0; i = val.indexOf('var(', i + 1)) {
    let depth = 0, j = i + 3, comma = -1
    for (; j < val.length; j++) {
      if (val[j] === '(') depth++
      else if (val[j] === ')' && --depth === 0) break
      else if (val[j] === ',' && depth === 1 && comma < 0) comma = j
    }
    out.push({ name: val.slice(i + 4, comma > 0 ? comma : j).trim(), fallback: comma > 0 ? val.slice(comma + 1, j).trim() : undefined, start: i, end: j + 1 })
    i = j
  }
  return out
}
function checkValue(v, push) {
  const val = v.replace(/!important/, '').trim()
  const vs = vars(val)
  for (const { name, fallback } of vs) {
    if (TOKENS.has(name)) {
      const want = DEFAULTS[name.replace('--radius-', '')]
      if (fallback !== undefined && fallback !== want) {
        if (/^var\(/.test(fallback)) checkValue(fallback, push) // 嵌套兜底逐层查
        else push(`兜底 var(${name}, ${fallback}) ≠ 缺省 ${want}`)
      }
    } else if (BRIDGE_VARS.has(name)) {
      if (fallback !== undefined) checkValue(fallback, push)
    } else if (!GEOMETRY_VARS.has(name)) push(`不认识的圆角变量 ${name}(用 --radius-xs/sm/md/lg/pill)`)
  }
  let bare = val
  for (const { start, end } of [...vs].reverse()) bare = bare.slice(0, start) + ' ' + bare.slice(end)
  // 成对几何写成 calc(token ± n):运算符后面的数字是偏移 / 除数,不算写死
  if (/calc\(/.test(bare)) bare = bare.replace(/calc\(/g, ' ').replace(/[+\-*/]\s*\d*\.?\d+(px|em|rem)?/g, ' ')
  for (const m of bare.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)(px|em|rem|%)?(?![\w-])/g)) {
    const n = parseFloat(m[1]), unit = m[2] || ''
    if (unit === '%' && n === 50) continue
    if ((unit === 'px' || unit === '') && n <= 3) continue // 0–3px:笔画几何
    if (/^(9999|999|99)px$/.test(m[0])) { push(`写死胶囊 ${m[0]}(用 var(--radius-pill))`); continue }
    push(`写死 ${m[0]}(用 token)`)
  }
}

// ── 小件:从一条规则的声明里算外框短边(算不出就不判)
function outerShortSide(body) {
  const d = {}
  for (const m of body.matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;]+)/g)) d[m[1]] = m[2].trim()
  const px = (v) => (/^-?\d*\.?\d+px$/.test(v || '') ? parseFloat(v) : v === '0' ? 0 : null)
  const sides = (v) => { const p = (v || '0').split(/\s+/).map(px); return p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p }
  const pad = sides(d.padding)
  if (d['padding-top']) pad[0] = px(d['padding-top']); if (d['padding-bottom']) pad[2] = px(d['padding-bottom'])
  if (d['padding-left']) pad[3] = px(d['padding-left']); if (d['padding-right']) pad[1] = px(d['padding-right'])
  const bw = d.border === undefined || d.border === 'none' || d.border === '0' ? 0 : px((d.border.match(/-?\d*\.?\d+px/) || [])[0])
  const borderBox = d['box-sizing'] === 'border-box'
  const side = (size, a, b) => {
    const s = px(d[size]); if (s === null) return null
    const min = px(d[`min-${size}`]); if (d[`min-${size}`] !== undefined && min === null) return null
    if (borderBox) return Math.max(s, min || 0)
    if (pad[a] === null || pad[b] === null || bw === null) return null
    return Math.max(s, min || 0) + pad[a] + pad[b] + 2 * bw
  }
  const vals = [side('height', 0, 2), side('width', 1, 3)].filter((x) => x !== null)
  return vals.length ? Math.min(...vals) : null
}

// ── 扫描
const sites = {} // file → [签名]
const samples = {}
const hit = (file, line, sig) => { (sites[file] ||= []).push(sig); (samples[file] ||= []).push(`${line}: ${sig}`) }
const selectorAt = (src, idx) => {
  const open = src.lastIndexOf('{', idx), close = src.lastIndexOf('}', open)
  return src.slice(close + 1, open).trim().split('\n').pop().replace(/\s+/g, ' ').slice(-70) || '(顶层)'
}
for (const root of ROOTS) for (const f of walk(root)) {
  const r = rel(f)
  if (EXCLUDE[r]) continue
  const isCss = f.endsWith('.css')
  let src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, blank)
  if (!isCss) src = src.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)))
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const where = (i) => (isCss ? selectorAt(src, i) : src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i)).trim().slice(0, 70))
  // 1. 定义
  for (const m of src.matchAll(/(?<![\w-])(--radius-[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const name = m[1]
    if (!isCss && !/^\s*['"`]?$/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).replace(/.*[{;'"`]\s*/, ''))) continue
    const inRoot = r === BASE_REL && m.index > rootStart && m.index < rootEnd
    const ok = DEF_BASE_ONLY.has(name) ? inRoot : DEF_SHARED.has(name) ? inRoot || isThemeFile(r) : false
    if (!ok) hit(r, lineOf(m.index), `${where(m.index)} | 声明 ${name}(圆角只在 base.css :root / 随包主题声明)`)
  }
  // 桥接变量的定义:值也要由 token 派生
  if (isCss) for (const m of src.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (BRIDGE_VARS.has(m[1])) checkValue(m[2], (msg) => hit(r, lineOf(m.index), `${where(m.index)} | ${m[1]} ${msg}`))
  }
  // 2/3/5. CSS 声明(含逻辑属性与多行简写;TS 里的 CSS 串到引号为止)
  const declRe = isCss ? /(?<![\w-])border(?:-[a-z]+)*-radius\s*:\s*([^;{}]+)/g : /(?<![\w-])border(?:-[a-z]+)*-radius\s*:\s*([^;{}"'`\n]+)/g
  for (const m of src.matchAll(declRe)) checkValue(m[1].replace(/\$\{[^}]*\}(px|%)?/g, ' '), (msg) => hit(r, lineOf(m.index), `${where(m.index)} | ${msg}`))
  // 2/5. TS 样式对象:字符串字面量按 CSS 查;表达式里的数字字面量(三元等)按 px 查;模板串里 ${…} 是算出来的几何
  if (!isCss) for (const m of src.matchAll(/(?<![\w$])borderRadius\s*:\s*('[^'\n]*'|"[^"\n]*"|`[^`\n]*`|[^,}\n]+)/g)) {
    const expr = m[1].trim()
    const push = (msg) => hit(r, lineOf(m.index), `${where(m.index)} | ${msg}`)
    let rest = expr
    for (const s of expr.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
      checkValue((s[1] ?? s[2] ?? s[3]).replace(/\$\{[^}]*\}(px|%)?/g, ' '), push)
      rest = rest.replace(s[0], ' ')
    }
    if (/^[\w$.]+$/.test(rest.trim()) && !/^\d/.test(rest.trim())) continue // 纯变量 / 常量名:算出来的几何
    for (const n of rest.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w.%])/g)) if (parseFloat(n[1]) > 3) push(`borderRadius 写死 ${n[1]}(用 'var(--radius-…)')`)
  }
  // 4. 小件用 sm
  if (isCss) for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/border-radius\s*:\s*var\(--radius-sm\b/.test(m[2])) continue
    const s = outerShortSide(m[2])
    if (s !== null && s <= 18) hit(r, lineOf(m.index + m[1].length), `${m[1].trim().split('\n').pop().replace(/\s+/g, ' ').slice(-70)} | 外框短边 ${s}px ≤ 18 却用 sm(用 xs)`)
  }
}

// ── 台账
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {}
const files = Object.keys(sites).sort()
const diff = (now, was) => { const left = [...was]; const extra = []; for (const s of now) { const i = left.indexOf(s); if (i >= 0) left.splice(i, 1); else extra.push(s) } return { extra, gone: left } }
if (process.argv.includes('--update')) {
  const next = {}
  for (const f of files) {
    const was = ledger[f] || { why: '', items: [] }
    const { extra } = diff(sites[f], was.items || [])
    const why = extra.length || !was.why ? `TODO: 写明为什么不能走 token${was.why ? `(原理由:${was.why.replace(/^TODO[^:]*:\s*/, '')})` : ''}` : was.why
    next[f] = { why, items: [...sites[f]].sort() }
  }
  fs.writeFileSync(LEDGER, JSON.stringify(next, null, 2) + '\n')
  console.log(`radius: 台账已写入(${files.length} 个文件,${files.reduce((a, f) => a + sites[f].length, 0)} 处)`)
  for (const [f, e] of Object.entries(next)) if (e.why.startsWith('TODO')) console.log(`  ! ${f} 有新增例外或没写理由:重写 why 才能过`)
  process.exit(fails.length ? 1 : 0)
}
const notes = []
for (const f of files) {
  const { extra, gone } = diff(sites[f], ledger[f]?.items || [])
  if (extra.length) fails.push(`${f}:台账外的 ${extra.length} 处\n      ${samples[f].filter((s) => extra.some((e) => s.endsWith(e))).slice(0, 8).join('\n      ')}`)
  if (gone.length) notes.push(`${f}:${gone.length} 处例外已经没了,可以收紧台账(-- --update)`)
  if (ledger[f] && (!ledger[f].why || ledger[f].why.startsWith('TODO'))) fails.push(`${f}:台账里没写理由`)
}
for (const f of Object.keys(ledger)) if (!(f in sites)) notes.push(`${f}:已经没有例外,可以从台账删掉(-- --update)`)
for (const n of notes) console.log('  · ' + n)
if (fails.length) { console.error('check:radius 失败(圆角契约见 DESIGN §3):\n  ✗ ' + fails.join('\n  ✗ ')); process.exit(1) }
console.log(`check:radius ok(缺省 xs ${DEFAULTS.xs} / sm ${DEFAULTS.sm} / md ${DEFAULTS.md} / lg ${DEFAULTS.lg};台账 ${files.reduce((a, f) => a + sites[f].length, 0)} 处例外都在册)`)
