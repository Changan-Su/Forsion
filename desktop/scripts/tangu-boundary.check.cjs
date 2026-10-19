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
 *   4. 契约(`contracts.dirs`,第 2b 步起;方案里包的 contracts/ 子路径):引擎、Tangu 界面、宿主三方共用的纯 TS。
 *      扫描范围里的文件(宿主和 Tangu 界面都算)直引 tangu-agent/src 里契约之外的文件 = 红(第 2d 步起)。
 *      两边引它都不计数;契约文件自己只许用相对路径引契约目录里的文件(不许引宿主 / Tangu / 引擎内部,也不许引第三方包)。
 * 测试文件与 dev 台架页(*.test.* / harness.tsx / *Harness.tsx)不查:它们随被测对象走。
 *
 * 红了怎么办:
 *   - 宿主要用 Tangu 的新模块 → 先想能不能走 ctx;确需直用,写成 `@tangu/ui/...` 再跑 --update --allow-grow(公开面变大,提交说明写理由);
 *   - 被判成 Tangu 的文件其实是通用件 → 从 tangu-boundary.json 的 files 里拿掉,它就归宿主;
 *   - Tangu 确需一个新的宿主依赖 → `node scripts/tangu-boundary.check.cjs --update --allow-grow` 重写基线,提交说明里写清理由。
 * 基线变小(拆掉了依赖)时也跑一次 --update,把收紧固定下来。
 *
 * 用法:cd desktop && npm run check:tanguboundary;收紧基线 node scripts/tangu-boundary.check.cjs --update(放宽要再加 --allow-grow);自测 --selftest
 */
const fs = require('fs')
const path = require('path')

const GENESIS = path.resolve(__dirname, '../..')
const CONFIG = path.join(__dirname, 'tangu-boundary.json')
const PREFIX = '@tangu/ui/'
const SCAN = ['desktop/frontend/src', 'desktop/shared', 'desktop/electron', 'lcl', 'mobile/src', 'web/src', 'tangu-agent/src/contracts']
const SRC = 'desktop/frontend/src'
const ENGINE_SRC = 'tangu-agent/src/' // 第 2d 步起:宿主 / 界面只许经契约目录用引擎的代码
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
const IMPORT_RE = /(?:import|export)(?=[\s{*])[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*(['"`])([^'"`$]+)\2\s*[,)]|import\s*['"]([^'"]+)['"]|@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** 把注释换成空格,字符串原样留着(这样字符串里的 '/*'、'//' 不会被当成注释)。
 * ponytail: 不认正则字面量 —— /['"]/ 里的引号会被当成字符串开头;import 都在文件头,正文里的正则吞不到它们。 */
function stripComments(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n' }
    else if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; out += ' ' }
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1); i = j
    } else out += c
  }
  return out
}

/** files: Map<rel path, source>。返回 { errors, notes, current }。纯函数,--selftest 直接喂它。 */
function analyze(files, cfg) {
  const isTangu = (f) => cfg.tangu.dirs.some((d) => f.startsWith(d)) || cfg.tangu.files.includes(f)
  const contractDirs = cfg.contracts?.dirs || []
  const isContract = (f) => contractDirs.some((d) => f.startsWith(d))
  /** import 指到的仓内路径(不管文件在不在扫描范围里);第三方包 → null。 */
  const baseOf = (from, spec) => {
    if (spec.startsWith('.')) return path.posix.join(path.posix.dirname(from), spec).replace(/\?.*$/, '')
    const a = ALIAS.find(([k]) => spec === k || spec.startsWith(k + '/'))
    return a ? path.posix.normalize(a[1] + spec.slice(a[0].length)).replace(/\?.*$/, '') : null
  }
  const resolve = (from, spec) => {
    const base = baseOf(from, spec)
    if (!base) return null
    for (const e of EXT) if (files.has(base + e)) return base + e
    if (/\.js$/.test(base)) for (const e of ['.ts', '.tsx']) if (files.has(base.replace(/\.js$/, e))) return base.replace(/\.js$/, e)
    return null
  }
  const errors = [], notes = []
  const used = new Set(), hostDeps = new Set()
  const known = new Set(cfg.baseline.hostImports)
  for (const [f, src] of files) {
    if (isContract(f) ? /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) : EXEMPT.test(f)) continue // 契约里的 .d.ts 也要查(Codex 2b 评审)
    const tangu = isTangu(f)
    for (const m of stripComments(src).matchAll(IMPORT_RE)) {
      const spec = m[1] || m[3] || m[4] || m[5] || m[6]
      if (isContract(f)) {
        const base = spec.startsWith('.') ? path.posix.join(path.posix.dirname(f), spec) : null
        if (!base || !isContract(base + '/') && !isContract(base)) errors.push(`契约文件只许用相对路径引契约目录:${f} import '${spec}'`)
        continue
      }
      const base = baseOf(f, spec)
      if (base && base.startsWith(ENGINE_SRC) && !isContract(base) && !isContract(base + '/')) {
        errors.push(`直接引了引擎源码:${f} import '${spec}'。引擎与宿主 / 界面共用的纯 TS 放进 tangu-agent/src/contracts/,从那里引`)
        continue
      }
      const to = resolve(f, spec)
      if (!to && spec.startsWith(PREFIX)) { errors.push(`${f} import '${spec}' 解析不到文件`); continue }
      if (!to || to === f || isContract(to)) continue
      if (!tangu && isTangu(to)) {
        used.add(to)
        if (!spec.startsWith(PREFIX)) errors.push(`宿主直连 Tangu 文件没走 @tangu/ui/ 前缀:${f} import '${spec}'(→ ${to})。写成 '${PREFIX}${to.slice(SRC.length + 1).replace(/\.(tsx?|jsx?)$/, '')}';它若其实是通用件,从 tangu-boundary.json 的 files 拿掉`)
        else if (!known.has(to)) errors.push(`宿主开始用一个新的 Tangu 模块:${f} → ${to}(公开面只许减)。能走 ctx 就别加;确需直用,跑 --update --allow-grow 并在提交说明写理由`)
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
  for (const d of [...hostDeps].sort()) if (!knownDeps.has(d)) errors.push(`Tangu 新增了宿主依赖:${d}(接缝面只许减)。能走现有出口 / ctx 就别加;确需新增,跑 --update --allow-grow 并在提交说明写理由`)
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

/** current 比 baseline 多出来的条目(--update 默认拒绝扩大基线)。 */
const grownBy = (baseline, current) => Object.keys(current).flatMap((k) => current[k].filter((x) => !baseline[k].includes(x)).map((x) => `${k}: ${x}`))

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
  // 以下几条来自 10-19 Codex 评审:各种写法都不许漏判 / 误判
  assert.match(run({ [`${SRC}/Other.tsx`]: 'const m = import(`./views/chat2/B`)' }).errors.join(), /没走 @tangu\/ui\/ 前缀/, '模板字符串动态 import')
  assert.match(run({ [`${SRC}/views/chat2/s.css`]: "@import url('../../host.css');", [`${SRC}/host.css`]: '' }).errors.join(), /新增了宿主依赖/, 'CSS @import url()')
  assert.match(run({ [`${SRC}/Other.tsx`]: "const g = './views/*'\nimport { B } from './views/chat2/B'\n/* x */" }).errors.join(), /没走/, '字符串里的 /* 不许吞掉后面的代码')
  assert.deepEqual(run({ [`${SRC}/Other.tsx`]: "const u = 1 // import { B } from './views/chat2/B'" }).errors, [], '行尾注释里的 import 不算')
  assert.match(run({ [`${SRC}/Other.tsx`]: "import { B } from '@/views/x/../chat2/B'" }).errors.join(), /没走/, 'alias 路径里的 .. 要规范化')
  assert.match(run({ [`${SRC}/Other.tsx`]: "import { Z } from '@tangu/ui/views/chat2/Nope'" }).errors.join(), /解析不到/)
  assert.deepEqual(grownBy({ hostImports: ['a'], tanguHostDeps: ['b'] }, { hostImports: [], tanguHostDeps: ['b', 'c'] }), ['tanguHostDeps: c'])
  // 契约(第 2b 步):两边引都不计数;契约只许引契约
  const K = 'tangu-agent/src/contracts/'
  const cfgK = { ...cfg, contracts: { dirs: [K] } }
  const runK = (extra) => analyze(new Map(Object.entries({ ...base, [`${K}a.ts`]: "import { b } from './b.js'\nexport const a = 1", [`${K}b.ts`]: 'export const b = 1', ...extra })), cfgK)
  const k1 = runK({ [`${SRC}/Other.tsx`]: "import { a } from '../../../tangu-agent/src/contracts/a'", [`${SRC}/views/chat2/C.tsx`]: "import { a } from '../../../../../tangu-agent/src/contracts/a.js'" })
  assert.deepEqual([k1.errors, k1.current.tanguHostDeps], [[], [`${SRC}/i18n.tsx`]], '宿主 / Tangu 引契约都不计数')
  const k0 = analyze(new Map(Object.entries({ ...base, [`${K}a.ts`]: 'export const a = 1', [`${SRC}/views/chat2/C.tsx`]: "import { a } from '../../../../../tangu-agent/src/contracts/a'" })), cfg)
  assert.match(k0.errors.join(), /直接引了引擎源码:.*contracts\/a'/, '负对照:不配契约时同一条引用要红(2d 起由「直引引擎源码」那条拦)')
  assert.match(runK({ [`${K}c.ts`]: "import { x } from '../../../desktop/frontend/src/stores/x'" }).errors.join(), /契约文件只许/, '契约引宿主')
  assert.match(runK({ [`${K}c.ts`]: "import { y } from '../core/y.js'" }).errors.join(), /契约文件只许/, '契约引引擎内部(不在扫描范围里也要拦)')
  assert.match(runK({ [`${K}c.ts`]: "import { z } from 'zod'" }).errors.join(), /契约文件只许/, '契约引第三方包')
  // Codex 2b 评审:这些写法也要进契约检查
  for (const [code, why] of [["import{z}from'zod'", '无空格的静态 import'], ["import fs = require('node:fs')", 'import = require'], ["const m = import('node:fs', {})", '带第二个参数的动态 import'], ["import'node:fs'", '无空格的副作用 import']]) {
    assert.match(runK({ [`${K}c.ts`]: code }).errors.join(), /契约文件只许/, why)
  }
  assert.match(runK({ [`${K}t.d.ts`]: "export type { Stats } from 'node:fs'" }).errors.join(), /契约文件只许/, '契约里的 .d.ts 不豁免')
  assert.deepEqual(runK({ [`${K}c.test.ts`]: "import { x } from '../../../desktop/frontend/src/stores/x'" }).errors, [], '契约的测试文件照旧不查')
  // 第 2d 步:直引引擎源码(契约之外)= 红,不管写法;引契约照旧放行
  assert.match(runK({ [`${SRC}/views/chat2/C.tsx`]: "import { k } from '../../../../../tangu-agent/src/core/keyLock'" }).errors.join(), /直接引了引擎源码/, 'Tangu 直引引擎内部')
  assert.match(runK({ [`${SRC}/Other.tsx`]: "import { k } from '@/../../../tangu-agent/src/core/keyLock.js'" }).errors.join(), /直接引了引擎源码/, '经 alias 绕过去也要拦')
  assert.match(runK({ ['desktop/shared/m.ts']: "export * from '../../tangu-agent/src/shared/marketplace'" }).errors.join(), /直接引了引擎源码/, 'export * from 也算')
  assert.deepEqual(runK({ [`${SRC}/Other.tsx`]: "import { a } from '../../../tangu-agent/src/contracts/a'" }).errors, [], '引契约放行')
  console.log('tangu-boundary selftest: 30/30 PASS')
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0) }
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const { errors, notes, current } = analyze(readRepo(), cfg)
if (process.argv.includes('--update')) {
  const grown = grownBy(cfg.baseline, current)
  if (grown.length && !process.argv.includes('--allow-grow')) {
    for (const g of grown) console.error(`+ ${g}`)
    console.error(`\ntangu-boundary: 这次会让基线变大 ${grown.length} 条(上面)。--update 默认只收紧;确需放宽,加 --allow-grow 并在提交说明写理由`)
    process.exit(1)
  }
  for (const g of grown) console.log(`+ ${g}`)
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
