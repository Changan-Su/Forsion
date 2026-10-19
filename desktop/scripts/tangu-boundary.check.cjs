#!/usr/bin/env node
/**
 * Tangu 界面边界(check:tanguboundary)—— Tangu 核心插件化第 1 步「仓内划边界」的仪器。
 * 方案:仓根 docs/ToBeImproved/Tangu核心插件化方案_2026-10-17.md 第 9 节。
 *
 * 哪些文件算 Tangu 界面:scripts/tangu-boundary.json 的 `tangu`(目录前缀 + 逐个文件)。
 * 规则(纯正则解析 import,不引 TS parser):
 *   1. 宿主 → Tangu 一律写成 `@tangu/ui/<相对 frontend/src 的路径>`(alias 指向 frontend/src,所以指到的模块和原来一样,
 *      不聚合成一个大出口 —— 聚合会让只用一个小函数的宿主文件和它的单测连带拉起整棵聊天界面)。
 *      宿主能碰的 Tangu 模块 = baseline.hostImports(公开面,第 2 步逐个换成 ctx 接缝,只许减)。
 *      用 `@/`、相对路径直连 Tangu 文件 = 红;`@tangu/ui/` 指到不是 Tangu 的文件 = 红。
 *   2. Tangu 文件之间用相对路径,不许写 `@tangu/ui/`(这个前缀只标宿主一侧的越界)。
 *   3. Tangu → 宿主:Tangu 文件用到的宿主模块集合 = 将来要补的 ctx 接缝面,只许减不许增(baseline.tanguHostDeps)。
 * 测试文件与 dev 台架页(*.test.* / harness.tsx / *Harness.tsx)不查:它们随被测对象走。
 *
 * 红了怎么办:
 *   - 宿主要用 Tangu 的新模块 → 先想能不能走 ctx;确需直用,写成 `@tangu/ui/...` 再跑 --update(公开面变大,提交说明写理由);
 *   - 被判成 Tangu 的文件其实是通用件 → 从 tangu-boundary.json 的 files 里拿掉,它就归宿主;
 *   - Tangu 确需一个新的宿主依赖 → `npm run check:tanguboundary -- --update` 重写基线,提交说明里写清理由。
 * 基线变小(拆掉了依赖)时也跑一次 --update,把收紧固定下来。
 *
 * 用法:cd desktop && npm run check:tanguboundary [-- --update | --selftest]
 */
const fs = require('fs')
const path = require('path')

const GENESIS = path.resolve(__dirname, '../..')
const CONFIG = path.join(__dirname, 'tangu-boundary.json')
const PREFIX = '@tangu/ui/'
const SCAN = ['desktop/frontend/src', 'desktop/shared', 'desktop/electron', 'lcl', 'mobile/src', 'web/src']
const SRC = 'desktop/frontend/src'
const ALIAS = [ // 与各 vite.config 的 alias 同表;长前缀在前
  ['@tangu/ui', SRC],
  ['@amadeus-shared', 'desktop/shared/amadeus'],
  ['@amadeus', `${SRC}/amadeus`],
  ['@webamadeus', 'web/src/amadeus'],
  ['@lcl', 'lcl'],
  ['@mobile', 'mobile/src'],
  ['@web', 'web/src'],
  ['@', SRC],
]
const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '/index.ts', '/index.tsx', '/index.js']
const EXEMPT = /\.(test|spec)\.[cm]?[tj]sx?$|\/__tests__\/|(^|\/)harness\.tsx$|Harness\.tsx$|\.typecheck\.ts$|\.d\.ts$/
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|@import\s+['"]([^'"]+)['"]/g

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** files: Map<rel path, source>。返回 { errors, notes, current }。纯函数,--selftest 直接喂它。 */
function analyze(files, cfg) {
  const isTangu = (f) => cfg.tangu.dirs.some((d) => f.startsWith(d)) || cfg.tangu.files.includes(f)
  const resolve = (from, spec) => {
    let base
    if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec)
    else {
      const a = ALIAS.find(([k]) => spec === k || spec.startsWith(k + '/'))
      if (!a) return null
      base = a[1] + spec.slice(a[0].length)
    }
    base = base.replace(/\?.*$/, '')
    for (const e of EXT) if (files.has(base + e)) return base + e
    if (/\.js$/.test(base)) for (const e of ['.ts', '.tsx']) if (files.has(base.replace(/\.js$/, e))) return base.replace(/\.js$/, e)
    return null
  }
  const errors = [], notes = []
  const used = new Set(), hostDeps = new Set()
  const known = new Set(cfg.baseline.hostImports)
  for (const [f, src] of files) {
    if (EXEMPT.test(f)) continue
    const tangu = isTangu(f)
    for (const m of stripComments(src).matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4]
      const to = resolve(f, spec)
      if (!to || to === f) continue
      if (!tangu && isTangu(to)) {
        used.add(to)
        if (!spec.startsWith(PREFIX)) errors.push(`宿主直连 Tangu 文件没走 @tangu/ui/ 前缀:${f} import '${spec}'(→ ${to})。写成 '${PREFIX}${to.slice(SRC.length + 1).replace(/\.(tsx?|jsx?)$/, '')}';它若其实是通用件,从 tangu-boundary.json 的 files 拿掉`)
        else if (!known.has(to)) errors.push(`宿主开始用一个新的 Tangu 模块:${f} → ${to}(公开面只许减)。能走 ctx 就别加;确需直用,跑 --update 并在提交说明写理由`)
      } else if (!tangu && spec.startsWith(PREFIX)) {
        errors.push(`${f} import '${spec}' 指到的不是 Tangu 文件(→ ${to}),宿主自己的文件用 @/ 或相对路径`)
      } else if (tangu && spec.startsWith(PREFIX)) {
        errors.push(`Tangu 文件之间用相对路径:${f} import '${spec}'`)
      } else if (tangu && !isTangu(to)) {
        hostDeps.add(to)
      }
    }
  }
  const knownDeps = new Set(cfg.baseline.tanguHostDeps)
  for (const d of [...hostDeps].sort()) if (!knownDeps.has(d)) errors.push(`Tangu 新增了宿主依赖:${d}(接缝面只许减)。能走现有出口 / ctx 就别加;确需新增,跑 --update 并在提交说明写理由`)
  const gone = [...knownDeps].filter((d) => !hostDeps.has(d)).length + [...known].filter((e) => !used.has(e)).length
  if (gone) notes.push(`基线里有 ${gone} 条已经不存在了 —— 跑 npm run check:tanguboundary -- --update 把收紧固定下来`)
  return { errors, notes, current: { hostImports: [...used].sort(), tanguHostDeps: [...hostDeps].sort() } }
}

function readRepo() {
  const files = new Map()
  const walk = (rel) => {
    const abs = path.join(GENESIS, rel)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'out' || e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (/\.(tsx?|jsx?|mjs|css)$/.test(e.name)) files.set(r, fs.readFileSync(path.join(GENESIS, r), 'utf8'))
    }
  }
  SCAN.forEach(walk)
  return files
}

function selftest() {
  const assert = require('node:assert/strict')
  const A = `${SRC}/views/chat2/A.tsx`
  const cfg = { tangu: { dirs: [`${SRC}/views/chat2/`], files: [] }, baseline: { hostImports: [A], tanguHostDeps: [`${SRC}/i18n.tsx`] } }
  const base = {
    [`${SRC}/i18n.tsx`]: 'export const t = 1',
    [`${SRC}/stores/x.ts`]: 'export const x = 1',
    [A]: "import { t } from '../../i18n'\nexport const A = 1",
    [`${SRC}/views/chat2/B.tsx`]: 'export const B = 1',
    [`${SRC}/Root.tsx`]: "import { A } from '@tangu/ui/views/chat2/A'\n// import { A } from './views/chat2/A'",
  }
  const run = (extra) => analyze(new Map(Object.entries({ ...base, ...extra })), cfg)
  assert.deepEqual(run({}).errors, [], '干净的树应当是绿的(注释里的 import 不算)')
  assert.match(run({ [`${SRC}/Other.tsx`]: "import { A } from './views/chat2/A'" }).errors.join(), /没走 @tangu\/ui\/ 前缀/)
  assert.match(run({ [`${SRC}/Other.tsx`]: "import { B } from '@tangu/ui/views/chat2/B'" }).errors.join(), /新的 Tangu 模块/)
  assert.match(run({ [`${SRC}/Other.tsx`]: "import { x } from '@tangu/ui/stores/x'" }).errors.join(), /不是 Tangu 文件/)
  assert.match(run({ [`${SRC}/views/chat2/C.tsx`]: "import { A } from '@tangu/ui/views/chat2/A'" }).errors.join(), /用相对路径/)
  assert.match(run({ [`${SRC}/views/chat2/C.tsx`]: "import { x } from '../../stores/x'" }).errors.join(), /新增了宿主依赖/)
  assert.deepEqual(run({ [`${SRC}/Root.test.tsx`]: "import { B } from './views/chat2/B'" }).errors, [], '测试文件不查')
  assert.match(run({ [A]: 'export const A = 1' }).notes.join(), /--update/)
  console.log('tangu-boundary selftest: 8/8 PASS')
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0) }
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const { errors, notes, current } = analyze(readRepo(), cfg)
if (process.argv.includes('--update')) {
  cfg.baseline = current
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
  console.log(`tangu-boundary: 基线已重写 —— 宿主在用的 Tangu 模块 ${current.hostImports.length} 个,Tangu → 宿主依赖 ${current.tanguHostDeps.length} 个`)
  process.exit(0)
}
for (const n of notes) console.log(`note: ${n}`)
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  console.error(`\ntangu-boundary: ${errors.length} 处越界(说明见 scripts/tangu-boundary.check.cjs 文件头)`)
  process.exit(1)
}
console.log(`tangu-boundary OK —— 宿主在用的 Tangu 模块 ${current.hostImports.length} 个,Tangu → 宿主依赖 ${current.tanguHostDeps.length} 个(只许减)`)
