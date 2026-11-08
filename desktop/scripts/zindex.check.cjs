/**
 * 层级(z-index)棘轮(LCL 表面规范 2026-11-07,方案页 docs/ToBeImproved/LCL表面规范方案_2026-11-07/ 第 5 节)。
 *
 * 钉两件事:
 *  1. base.css :root 里那张 --z-* 表都在(浮层宿主 lcl/engine/floatLayer.css 读它们)。
 *  2. 棘轮:托管样式(frontend/src、lcl)与 TS / TSX 里**写死的** z-index 数字不许变多(变少了提示收紧基线)。
 *     `var(--z-x, 100)` 的兜底与 `calc(var(--z-hint) + 1)` 不算;0 / 1 / -1 / auto 不算(局部叠放顺序,不是层级)。
 *     新代码请用 --z-* token;要在别人的浮层上面就挂进它的容器,别比数字。
 *
 * 跑:npm run check:zindex;收紧基线:npm run check:zindex -- --update
 */
const fs = require('fs')
const path = require('path')

const DESKTOP = path.resolve(__dirname, '..')
const ROOTS = [path.join(DESKTOP, 'frontend/src'), path.join(DESKTOP, '../lcl')]
const BASELINE = path.join(__dirname, 'zindex-baseline.json')
const BASE_CSS = path.join(DESKTOP, 'frontend/src/styles/base.css')
const TOKENS = ['--z-view-float', '--z-space-float', '--z-window-float', '--z-menu', '--z-hint', '--z-dialog', '--z-palette']

const rel = (file) => path.relative(DESKTOP, file).replace(/\\/g, '/')
function walk(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const f = path.join(dir, e.name)
    return e.isDirectory() ? walk(f, exts) : exts.has(path.extname(e.name)) && !/\.test\.tsx?$/.test(e.name) ? [f] : []
  })
}
const SMALL = new Set(['0', '1', '-1', '2', '3'])
const fails = []
const notes = []

// 1. token 表
const base = fs.readFileSync(BASE_CSS, 'utf8')
for (const t of TOKENS) if (!new RegExp(`^\\s*${t}\\s*:`, 'm').test(base)) fails.push(`base.css :root 少了 ${t}(层级表,见文件里「层级表」那段)`)

// 2. 棘轮
const counts = {}
for (const root of ROOTS) {
  for (const f of walk(root, new Set(['.css', '.ts', '.tsx']))) {
    let src = fs.readFileSync(f, 'utf8')
    let n = 0
    if (f.endsWith('.css')) {
      src = src.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of src.matchAll(/z-index\s*:\s*(-?\d+)\s*(?:!important)?\s*[;}]/g)) if (!SMALL.has(m[1])) n++
    } else {
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of src.matchAll(/zIndex\s*[:=]\s*['"]?(-?\d+)['"]?/g)) if (!SMALL.has(m[1])) n++
      for (const m of src.matchAll(/z-index\s*:\s*(-?\d+)/g)) if (!SMALL.has(m[1])) n++ // 模板字符串里的 CSS
    }
    if (n) counts[rel(f)] = n
  }
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`zindex: 基线已写入(${Object.keys(sorted).length} 个文件,${Object.values(sorted).reduce((a, b) => a + b, 0)} 处)`)
  process.exit(fails.length ? 1 : 0)
}
const was = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {}
for (const [f, now] of Object.entries(sorted)) {
  const b = was[f] ?? 0
  if (now > b) fails.push(`${f}:写死的 z-index ${b} → ${now}。用 base.css :root 的 --z-* token(或挂进对方的容器),别再加数字`)
  else if (now < b) notes.push(`${f}:${b} → ${now},可以收紧基线(-- --update)`)
}
for (const f of Object.keys(was)) if (!(f in sorted)) notes.push(`${f}:已经没有写死的 z-index,可以收紧基线(-- --update)`)
for (const n of notes) console.log('  · ' + n)
if (fails.length) { console.error('check:zindex 失败:\n  ✗ ' + fails.join('\n  ✗ ')); process.exit(1) }
console.log(`check:zindex ok(${Object.values(sorted).reduce((a, b) => a + b, 0)} 处写死的 z-index,不多于基线)`)
