#!/usr/bin/env node
/**
 * Tangu 界面半身的构建(界面热更新第 4 步 4a;施工图:仓根 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §2、§3、§6 P3)。
 *
 * 产物 tangu-agent/ui/main.js:esbuild 单个 iife,入口 = features/tangu.tsx(activateTangu)。哪些算 Tangu 文件
 * 与 check:tanguboundary 同一份划分(scripts/tangu-boundary.json):
 *   · Tangu 文件、契约目录(纯 TS,各带一份没问题)→ 打进包;
 *   · 包外的仓内文件(宿主模块)→ 不打进包,改写成 require('host:<仓内路径>'),拿宿主自己那一份;
 *   · react / react-dom / zustand / framer-motion(含子路径与 JSX 自动注入的 react/jsx-runtime)→ require('<原名>');
 *   · 其余第三方包(lucide-react、react-markdown、remark-*、diff…)→ 打进包;
 *   · Tangu 的 CSS 以文本打进包,收进 css 字段,由加载器在宿主样式之后整块注入。
 * 产物的函数体约定(4b 的加载器照此求值):`new Function('require', code)`;require 由 coreTangu/hostRequire.ts 按
 * 共享表给;返回 { exports: features/tangu 的导出, css: 全部 Tangu CSS 按 import 顺序拼好 }。
 *
 * 共享表 frontend/src/coreTangu/sharedModules.generated.ts = 这次构建实际 require 的全部模块(type-only 的 import 已被
 * esbuild 摘掉,所以比边界基线小),宿主侧逐个 `import * as`,打包版没有静态引 Tangu 时这些模块也还在宿主产物里。
 * 宿主模块那几条必须 ⊆ 边界基线 tanguHostDeps(只许减)—— 想加只能先过 check:tanguboundary 的 --allow-grow。
 *
 * 用法(cd desktop):
 *   node scripts/build-tangu-ui.mjs                构建 + 核对(共享表过期 / 包里混进宿主文件 = 红)
 *   node scripts/build-tangu-ui.mjs --write-table  构建 + 按结果重写共享表
 *   node scripts/build-tangu-ui.mjs --out <文件>    产物写到别处(默认 ../tangu-agent/ui/main.js)
 * 仪器:frontend/src/coreTangu/bundle.test.ts(核对规则的负对照 + 求值约定的小样)。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const boundary = require('./tangu-boundary.check.cjs')
const { GENESIS, ALIAS, SRC } = boundary
export const ENTRY = `${SRC}/features/tangu.tsx`
export const TABLE = `${SRC}/coreTangu/sharedModules.generated.ts`
export const DEFAULT_OUT = 'tangu-agent/ui/main.js'
/** 必须和宿主同一份的第三方包(§3.1):两份 React 直接崩 hooks;zustand / framer-motion 是怕两份 store / context。 */
export const SHARED_PACKAGES = ['react', 'react-dom', 'zustand', 'framer-motion']
export const SOURCE_URL = 'forsion-core://tangu/main.js'
const HOST = 'host:'

const posix = (p) => p.split(path.sep).join('/')
export const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2) : spec.split('/').slice(0, 1)).join('/')
const isShared = (spec) => SHARED_PACKAGES.includes(packageOf(spec))
const bare = (spec) => !spec.startsWith('.') && !spec.startsWith('/') && !ALIAS.some(([k]) => spec === k || spec.startsWith(k + '/'))

/** 仓内路径 → 归哪一类。cfg = tangu-boundary.json。 */
export function classifier(cfg) {
  const contracts = cfg.contracts?.dirs || []
  return (rel) => cfg.tangu.dirs.some((d) => rel.startsWith(d)) || cfg.tangu.files.includes(rel) ? 'tangu'
    : contracts.some((d) => rel.startsWith(d)) ? 'contract'
    : 'host'
}

/** esbuild 插件:把 import 分成「打进包 / 宿主那份 / 共享第三方」,Tangu 的 CSS 改成文本。
 *  root = 仓根(绝对路径);classify(rel) → 'tangu' | 'contract' | 'host'。 */
export function tanguUiPlugin({ root, classify, entry, alias = ALIAS }) {
  return {
    name: 'tangu-ui',
    setup(b) {
      // 虚拟入口 = 真入口的全部导出 + 一个取 CSS 的函数;CSS 收在虚拟模块 tangu-ui:css 里(不用 banner 定义全局:
      // 那样 "use strict" 就不在函数体第一句,整包变成非严格模式)
      b.onResolve({ filter: /^tangu-ui:(entry|css)$/ }, (args) => ({ path: args.path, namespace: 'tangu-ui' }))
      b.onLoad({ filter: /.*/, namespace: 'tangu-ui' }, (args) => args.path === 'tangu-ui:css'
        ? { contents: 'export const sheets = []', loader: 'js' }
        : { contents: `export * from ${JSON.stringify(entry)}\nimport { sheets } from 'tangu-ui:css'\nexport const __css = () => sheets.join('\\n')`, loader: 'js', resolveDir: path.dirname(entry) })
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'tangu-ui:inner') return undefined
        const spec = args.path
        if (isShared(spec) && bare(spec)) return { path: spec, external: true }
        if (bare(spec)) return undefined // 其余第三方包照常解析、打进包
        const a = alias.find(([k]) => spec === k || spec.startsWith(k + '/'))
        const target = a ? path.join(root, a[1] + spec.slice(a[0].length)) : spec
        const r = await b.resolve(target, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: 'tangu-ui:inner' })
        if (r.errors.length) return { errors: r.errors }
        if (r.external || r.path.includes(`${path.sep}node_modules${path.sep}`)) return { path: r.path, external: r.external }
        const rel = posix(path.relative(root, r.path))
        if (rel.startsWith('../')) return { errors: [{ text: `${spec} resolves outside the repository (${r.path})` }] }
        const kind = classify(rel)
        if (kind === 'host') return { path: HOST + rel, external: true }
        return { path: r.path, sideEffects: r.sideEffects }
      })
      b.onLoad({ filter: /\.css$/ }, (args) => ({
        contents: `import { sheets } from 'tangu-ui:css'\nsheets.push(${JSON.stringify(readFileSync(args.path, 'utf8'))})`,
        loader: 'js',
      }))
    },
  }
}

/** 构建选项(bundle.test.ts 的小样用同一份,只换 entry / plugin)。 */
export const buildOptions = ({ plugin, outfile }) => ({
  entryPoints: ['tangu-ui:entry'],
  bundle: true,
  write: false,
  outfile,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130', // Electron 40;不为老浏览器降级
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // 外部模块的动态 import() 在 iife 里会原样留成 import("host:…"),浏览器认不出这种地址:
  // 关掉这项支持,esbuild 改写成 Promise.resolve().then(() => require(…)),到调用时才向宿主要。
  supported: { 'dynamic-import': false },
  globalName: '__tanguUi',
  // 函数体第一句 = 严格模式指令(Tangu 源码是 ESM,本来就是严格模式;入口是虚拟 JS 文件,esbuild 不会自己加)
  banner: { js: '"use strict";' },
  footer: { js: `return { exports: __tanguUi, css: __tanguUi.__css() };\n//# sourceURL=${SOURCE_URL}` },
  // 标识符不混淆:崩溃栈和诊断快照里要看得懂函数名
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'silent',
  plugins: [plugin],
})

/**
 * 核对一次构建(纯函数,bundle.test.ts 直接喂它):
 *  · 包里的仓内文件只能是 Tangu / 契约(P3:混进一个宿主文件 = 两份 store,症状是「状态不同步」不报错);
 *  · 包里不许打进共享第三方包(两份 React);
 *  · 外部模块 = 共享表的键,一条不多一条不少;宿主那几条 ⊆ 边界基线;
 *  · 产物里不许留 import("host:…") / import("react…")。
 * 返回 { errors, externals }。
 */
export function analyzeBuild({ metafile, code, cwd = process.cwd(), root, classify, baseline, table }) {
  const errors = []
  for (const input of Object.keys(metafile.inputs)) {
    if (/^[a-z-]+:/.test(input) && !input.startsWith('/')) continue // esbuild 的虚拟命名空间
    const abs = path.resolve(cwd, input) // metafile 的路径相对 esbuild 的工作目录
    const nm = posix(abs).lastIndexOf('/node_modules/')
    if (nm >= 0) {
      const pkg = packageOf(posix(abs).slice(nm + '/node_modules/'.length))
      if (SHARED_PACKAGES.includes(pkg)) errors.push(`shared package ${pkg} was bundled (${input}); it must come from the host`)
      continue
    }
    const rel = posix(path.relative(root, abs))
    const kind = rel.startsWith('../') ? 'outside' : classify(rel)
    if (kind !== 'tangu' && kind !== 'contract') errors.push(`host file bundled into the Tangu UI: ${rel} — it must be required from the host (shared module table)`)
  }
  const externals = [...new Set(Object.values(metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))].sort()
  for (const e of externals) {
    if (e.startsWith(HOST) && !baseline.includes(e.slice(HOST.length))) errors.push(`${e} is not in the boundary baseline tanguHostDeps (check:tanguboundary); the shared table may only shrink`)
    else if (!e.startsWith(HOST) && !isShared(e)) errors.push(`${e} is external but not a shared package`)
  }
  if (table) {
    const keys = [...table].sort()
    const missing = externals.filter((e) => !keys.includes(e)), stale = keys.filter((k) => !externals.includes(k))
    if (missing.length || stale.length) errors.push(`shared module table is out of date (missing: ${missing.join(', ') || '-'}; stale: ${stale.join(', ') || '-'}). Run node scripts/build-tangu-ui.mjs --write-table`)
  }
  const raw = code.match(/\bimport\s*\(\s*["'`](?:host:|react|zustand|framer-motion)[^"'`]*/)
  if (raw) errors.push(`dynamic ${raw[0]}…) survived the build; the host cannot serve it`)
  return { errors, externals }
}

/** 共享表源码。键与 require 的参数一字不差;CSS 只要宿主产物里有它,值是空对象。 */
export function renderTable(externals) {
  const lines = [], rows = []
  externals.forEach((e, i) => {
    let spec = e
    if (e.startsWith(HOST)) {
      const rel = e.slice(HOST.length)
      // @tangu/ui 只给宿主指 Tangu 文件用(check:tanguboundary),表里的宿主模块走它们平常的写法
      const a = ALIAS.filter(([k, to]) => k !== '@tangu/ui' && rel.startsWith(to + '/')).sort((x, y) => y[1].length - x[1].length)[0]
      spec = a ? a[0] + rel.slice(a[1].length) : posix(path.relative(path.posix.dirname(TABLE), rel))
      if (!spec.startsWith('@') && !spec.startsWith('.')) spec = './' + spec
      spec = spec.replace(/\.(tsx?)$/, '')
    }
    if (/\.css$/.test(e)) { lines.push(`import '${spec}'`); rows.push(`  '${e}': {},`) }
    else { lines.push(`import * as m${i} from '${spec}'`); rows.push(`  '${e}': m${i},`) }
  })
  return [
    '// 生成文件,别手改:cd desktop && node scripts/build-tangu-ui.mjs --write-table(界面热更新 4a)。',
    '// Tangu 界面包在打包版里向宿主要的全部模块(键 = 包里 require 的参数);宿主这里逐个 import,',
    '// 不静态引 Tangu 时它们也还在宿主产物里。共享规则见 scripts/build-tangu-ui.mjs 文件头。',
    '/* eslint-disable */',
    ...lines,
    '',
    'export const SHARED_MODULES: Record<string, object> = {',
    ...rows,
    '}',
    '',
  ].join('\n')
}

const tableKeys = (src) => [...src.matchAll(/^  '([^']+)': /gm)].map((m) => m[1])

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  const { build } = await import('esbuild')
  const cfg = boundary.readConfig()
  const classify = classifier(cfg)
  const outfile = path.resolve(arg('--out') || path.join(GENESIS, DEFAULT_OUT))
  const root = realpathSync(GENESIS) // esbuild 交回来的是真实路径(检出路径里有软链时对得上)
  const result = await build(buildOptions({ plugin: tanguUiPlugin({ root, classify, entry: path.join(root, ENTRY) }), outfile }))
    .catch((e) => { for (const m of e.errors || []) console.error(`✗ ${m.text}${m.location ? ` (${m.location.file}:${m.location.line})` : ''}`); process.exit(1) })
  const code = result.outputFiles[0].text
  const write = process.argv.includes('--write-table')
  const tablePath = path.join(GENESIS, TABLE)
  let table = null
  try { table = tableKeys(readFileSync(tablePath, 'utf8')) } catch { /* 第一次生成 */ }
  const { errors, externals } = analyzeBuild({ metafile: result.metafile, code, root, classify, baseline: cfg.baseline.tanguHostDeps, table: write ? null : table ?? [] })
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`)
    console.error(`\ntangu-ui: ${errors.length} problem(s); see scripts/build-tangu-ui.mjs`)
    process.exit(1)
  }
  if (write) writeFileSync(tablePath, renderTable(externals))
  mkdirSync(path.dirname(outfile), { recursive: true })
  writeFileSync(outfile, code)
  const host = externals.filter((e) => e.startsWith(HOST)).length
  console.log(`tangu-ui OK —— ${posix(path.relative(GENESIS, outfile))} ${(code.length / 1024).toFixed(0)} KB;共享表 ${externals.length} 条(宿主模块 ${host} / 基线 ${cfg.baseline.tanguHostDeps.length},第三方 ${externals.length - host})${write ? ',已重写' : ''}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
