/**
 * 圆角契约棘轮(DESIGN §3「全局界面字号与圆角」,2026-11-23 控件档回到 8px 时立的)。
 *
 * 契约:组件只消费五个 token —— xs 小件(短边 ≤ 18px)· sm 控件 · md 浮层与普通卡 · lg 大面板 · pill 胶囊;圆用 50%。
 * 本脚本钉五件事,托管样式(desktop 渲染层、lcl、mobile、web 的 CSS 与 TS / TSX)里:
 *  1. 定义只有一处:--radius-sm / md / lg(及 chat 别名)只许在 base.css 与随包主题 theme/themes/<id>/theme.css 里声明;
 *     --radius-xs、--radius-pill 只许在 base.css(xs 由 sm 派生,主题别另写);--radius-xl 是给老插件留的弃用别名,也只在 base.css。
 *  2. 不写数字:border-radius 不许写 > 3px 的数字(≤ 3px 算笔画几何,如细条、复选框内的勾),999px 一类用 pill。
 *  3. 兜底等于缺省:var(--radius-sm, X) 的 X 必须等于 base.css 的缺省值(xs 的缺省 = sm / 2)。
 *  4. 小件用 xs:同一条规则里声明了 ≤ 18px 的宽或高,却用 sm → 红。
 *  5. 不认识的圆角变量(var(--radius)、var(--radius-xl)…)→ 红;本地桥接变量要进 ALLOW_VARS。
 * 范围外:desktop/electron 主进程自绘的独立小页(权限引导等)不加载 base.css,没有 token 可用。
 * 例外进 radius-ledger.json:按文件计数 + 理由。计数只许变少(变少了提示收紧,-- --update 重写计数、保留理由)。
 *
 * 跑:npm run check:radius
 */
const fs = require('fs')
const path = require('path')

const DESKTOP = path.resolve(__dirname, '..')
const REPO = path.resolve(DESKTOP, '..')
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src'].map((r) => path.join(REPO, r))
const LEDGER = path.join(__dirname, 'radius-ledger.json')
const BASE_CSS = path.join(DESKTOP, 'frontend/src/styles/base.css')
// 整个文件不在契约里(写明理由)
const EXCLUDE = {
  'desktop/frontend/src/amadeus/theme/lcl/tangu.css': '未被引用的 LCL 早期快照(研究页 #/tangu 的词表),产品不加载',
  'desktop/frontend/src/amadeus/theme/themes/dreamer/theme.css': 'Amadeus 旧主题,作用域 [data-theme=dreamer],Genesis 不可选',
}
const SKIP_FILE = /(\.test\.tsx?$|[Hh]arness[^/]*\.tsx?$|\/harness\/|\/fixtures\/)/
// 允许出现在 border-radius 里的变量:token + 本地桥接
const TOKENS = new Set(['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill', '--radius-chat-surface', '--radius-chat-card'])
// 桥接变量的定义本身也按同一套规则查(只许由 token 派生)
const BRIDGE_VARS = new Set([
  '--fs-radius', // 草图 iframe 的桥接变量,sketchWrapper.ts 映射到 --radius-sm
  '--border-radius-lg', '--border-radius-md', // Excalidraw 自己的变量,excalidrawTheme.css 映射到 md / lg
  '--t2-card-r', // 工具摘要卡按高程切换的圆角,chat2.css 里由 --radius-md 给值
])
const ALLOW_VARS = new Set([...BRIDGE_VARS, '--border-width']) // --border-width:同心内圆角 calc(token - 描边)
const DEF_SHARED = new Set(['--radius-sm', '--radius-md', '--radius-lg', '--radius-chat-surface', '--radius-chat-card'])
const DEF_BASE_ONLY = new Set(['--radius-xs', '--radius-pill', '--radius-xl']) // xl:已弃用的插件契约别名(= lg),宿主不消费

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

// 缺省值从 base.css 读(脚本里不再写第二份)
const base = fs.readFileSync(BASE_CSS, 'utf8')
const rootBlock = base.slice(base.indexOf(':root'), base.indexOf('}', base.indexOf(':root')))
const def = (name) => (rootBlock.match(new RegExp(`${name}\\s*:\\s*([^;]+);`)) || [])[1]?.trim()
const DEFAULTS = { sm: def('--radius-sm'), md: def('--radius-md'), lg: def('--radius-lg'), pill: def('--radius-pill') }
const fails = []
for (const [k, v] of Object.entries(DEFAULTS)) if (!v || !/^\d+px$/.test(v)) fails.push(`base.css :root 的 --radius-${k} 读不到或不是 px 数值:${v}`)
if (!/calc\(\s*var\(--radius-sm\)\s*\/\s*2\s*\)/.test(def('--radius-xs') || '')) fails.push('base.css :root 的 --radius-xs 应是 calc(var(--radius-sm) / 2)')
DEFAULTS.xs = `${parseFloat(DEFAULTS.sm) / 2}px`

function checkValue(v, push) {
  const val = v.replace(/!important/, '').trim()
  for (const m of val.matchAll(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+?|[^()]*\([^()]*\)[^()]*?))?\)/g)) {
    const [, name, fb] = m
    if (TOKENS.has(name)) {
      const tier = name.replace('--radius-', '')
      if (fb !== undefined && DEFAULTS[tier] && fb.trim() !== DEFAULTS[tier]) push(`兜底 ${m[0]} ≠ 缺省 ${DEFAULTS[tier]}`)
    } else if (!ALLOW_VARS.has(name)) push(`不认识的圆角变量 ${name}(用 --radius-xs/sm/md/lg/pill)`)
  }
  // 成对几何写成 calc(token ± n):运算符后面的数字是偏移,不算写死
  let bare = val.replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, ' ')
  if (/calc\(/.test(bare)) bare = bare.replace(/calc\(/g, ' ').replace(/[+\-*/]\s*\d*\.?\d+(px|em|rem)?/g, ' ')
  for (const m of bare.matchAll(/(-?\d*\.?\d+)(px|em|rem|%)?/g)) {
    const n = parseFloat(m[1]), unit = m[2] || ''
    if (unit === '%' && n === 50) continue
    if ((unit === 'px' || unit === '') && n <= 3) continue // 0–3px:笔画几何;calc 里的 +2px 偏移也落在这里
    if (/\b(9999|999|99)px\b/.test(m[0])) { push(`写死胶囊 ${m[0]}(用 var(--radius-pill))`); continue }
    push(`写死 ${m[0]}(用 token)`)
  }
}

const counts = {}, samples = {}
const hit = (file, msg) => { counts[file] = (counts[file] || 0) + 1; (samples[file] ||= []).push(msg) }
for (const root of ROOTS) for (const f of walk(root)) {
  const r = rel(f)
  if (EXCLUDE[r]) continue
  let src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const isCss = f.endsWith('.css')
  if (!isCss) src = src.replace(/^\s*\/\/.*$/gm, '')
  const lineOf = (i) => src.slice(0, i).split('\n').length
  // 1. 定义
  for (const m of src.matchAll(/(--radius-[\w-]+)\s*:\s*[^;{}]+/g)) {
    const name = m[1]
    const isBase = r === 'desktop/frontend/src/styles/base.css'
    const isTheme = /^desktop\/frontend\/src\/theme\/themes\/[^/]+\/theme\.css$/.test(r)
    if (DEF_BASE_ONLY.has(name) ? !isBase : DEF_SHARED.has(name) ? !(isBase || isTheme) : true) {
      if (!isCss && !/^\s*['"`]?--radius/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index + 1))) continue
      hit(r, `${lineOf(m.index)}: 在这里声明 ${name}(圆角只在 base.css / 随包主题声明)`)
    }
  }
  // 桥接变量的定义:值也要由 token 派生
  if (isCss) for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (BRIDGE_VARS.has(m[1])) checkValue(m[2], (msg) => hit(r, `${lineOf(m.index)}: ${m[1]} ${msg}`))
  }
  // 2/3/5. CSS 声明(含 TS 里的 CSS 串)
  for (const m of src.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;}{\n"'`]+)/g)) {
    checkValue(m[1], (msg) => hit(r, `${lineOf(m.index)}: ${msg}`))
  }
  // 2/5. TS 样式对象
  if (!isCss) for (const m of src.matchAll(/borderRadius\s*:\s*('[^'\n]*'|"[^"\n]*"|`[^`\n]*`|[^,}\n]+)/g)) {
    const v = m[1].trim()
    if (/^\d+(\.\d+)?$/.test(v)) { if (parseFloat(v) > 3) hit(r, `${lineOf(m.index)}: borderRadius: ${v}(用 'var(--radius-…)')`); continue }
    const s = v.match(/^['"`](.*)['"`]$/)
    // 模板串里 ${…} 是算出来的几何(图标 squircle 比例、液滴等),只查剩下的部分
    if (s) checkValue(s[1].replace(/\$\{[^}]*\}(px|%)?/g, ' '), (msg) => hit(r, `${lineOf(m.index)}: ${msg}`))
  }
  // 4. 小件用 sm
  if (isCss) for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]
    if (!/border-radius\s*:\s*var\(--radius-sm\b/.test(body)) continue
    const small = [...body.matchAll(/(?<![-\w])(height|width|max-height)\s*:\s*(\d+(?:\.\d+)?)px/g)].some((d) => parseFloat(d[2]) <= 18)
    if (small) hit(r, `${lineOf(m.index + m[1].length)}: ${m[1].trim().split('\n').pop().slice(-50)} 短边 ≤ 18px 却用 sm(用 xs)`)
  }
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {}
if (process.argv.includes('--update')) {
  const next = {}
  for (const [f, n] of Object.entries(sorted)) next[f] = { n, why: ledger[f]?.why || 'TODO: 写明为什么不能走 token' }
  fs.writeFileSync(LEDGER, JSON.stringify(next, null, 2) + '\n')
  console.log(`radius: 台账已写入(${Object.keys(next).length} 个文件)`)
  for (const [f, e] of Object.entries(next)) if (e.why.startsWith('TODO')) console.log(`  ! ${f} 还没写理由`)
  process.exit(fails.length ? 1 : 0)
}
const notes = []
for (const [f, n] of Object.entries(sorted)) {
  const b = ledger[f]?.n ?? 0
  if (n > b) fails.push(`${f}:${b} → ${n}\n      ${samples[f].slice(0, 6).join('\n      ')}`)
  else if (n < b) notes.push(`${f}:${b} → ${n},可以收紧台账(-- --update)`)
}
for (const f of Object.keys(ledger)) {
  if (!(f in sorted)) notes.push(`${f}:已经没有例外,可以从台账删掉(-- --update)`)
  else if (!ledger[f].why || ledger[f].why.startsWith('TODO')) fails.push(`${f}:台账里没写理由`)
}
for (const n of notes) console.log('  · ' + n)
if (fails.length) { console.error('check:radius 失败(圆角契约见 DESIGN §3):\n  ✗ ' + fails.join('\n  ✗ ')); process.exit(1) }
console.log(`check:radius ok(缺省 xs ${DEFAULTS.xs} / sm ${DEFAULTS.sm} / md ${DEFAULTS.md} / lg ${DEFAULTS.lg};台账 ${Object.values(sorted).reduce((a, b) => a + b, 0)} 处例外,不多于记录)`)
