/** Intelligent UI HTML 卡的随包库(three / d3 / chart.js / gsap)。拷进 renderer 的 publicDir:
 *  桌面经 forsion-iui:// 协议取(electron/iuiLibProtocol.ts),网页经同站 /iui-lib/ 取;卡里的 importmap
 *  在 frontend/src/components/sketchWrapper.ts(IUI_LIB_IMPORTS),目录名两边逐字一致。
 *  方案页:docs/ToBeImproved/IntelligentUI卡内库方案_2026-10-27(仓根)。
 *
 *  照 copy-excalidraw-assets.cjs 的先例:从 node_modules 再生、不入库,postinstall / web prepare-assets 跑,
 *  按版本戳幂等。目录只带大版本(three 是 0.x,带到次版本):小版本原地替换,大版本换目录 ——
 *  装到的版本跟目录名对不上就直接失败,别让卡里 import 一个不存在的路径(那只会是一块空白)。 */
const fs = require('fs')
const path = require('path')

const argOut = process.argv.indexOf('--out')
const outDir = argOut > 0 && process.argv[argOut + 1]
  ? path.resolve(process.cwd(), process.argv[argOut + 1])
  : path.join(__dirname, '..', 'frontend', 'public', 'iui-lib')
const stamp = path.join(outDir, '.version')

// web 容器里依赖装在公共祖先 /app/node_modules:逐级上找,不写死 desktop/node_modules
function findNodeModules(name) {
  for (const start of [process.cwd(), __dirname]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return path.join(dir, 'node_modules')
      if (path.dirname(dir) === dir) break
    }
  }
  return null
}

// [包名, 目录, 要求的版本前缀]
const LIBS = [['three', 'three@0.186', '0.186.'], ['d3', 'd3@7', '7.'], ['chart.js', 'chart.js@4', '4.'], ['gsap', 'gsap@3', '3.']]
const nm = findNodeModules('three')
if (!nm) { console.warn('[iui-libs] 未安装 three 等随包库,跳过'); process.exit(0) }
const versions = LIBS.map(([name, dir, want]) => {
  const v = JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8')).version
  if (!v.startsWith(want)) throw new Error(`[iui-libs] ${name}@${v} 对不上目录 ${dir}:升大版本要新开目录并改 sketchWrapper.ts 的 importmap`)
  return `${name}@${v}`
}).join(' ')
const SCRIPT_REV = 3 // 改了下面的产物清单就加一,老副本才会重生成
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${versions} r${SCRIPT_REV}`) process.exit(0)

const esbuild = require(require.resolve('esbuild', { paths: [nm, __dirname] }))
const common = { minify: true, format: 'esm', logLevel: 'warning', write: false, legalComments: 'eof' } // 许可声明随副本留着(MIT / ISC 要求;gsap 是它自己的免费标准许可)
// 先写进临时目录,全部成功才换上去:中途失败不会留下半套库、也不弄坏上一份能用的
const stage = `${outDir}.tmp-${process.pid}`
// 每个文件头放上该包的 LICENSE 原文:d3 子包的版权行是普通注释,打包时会被去掉,MIT / ISC 要求副本里带着许可
const licenseOf = (name) => {
  const f = fs.readdirSync(path.join(nm, name)).find((x) => /^licen[cs]e/i.test(x))
  return f ? `/*! ${name} — ${f}\n${fs.readFileSync(path.join(nm, name, f), 'utf8').replace(/\*\//g, '* /').trim()}\n*/\n` : ''
}
const out = (rel, code) => {
  const p = path.join(stage, rel); fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, licenseOf(rel.slice(0, rel.indexOf('@'))) + Buffer.from(code).toString('utf8'))
}
const three = path.join(nm, 'three')
// three 的核心与附加件各自压缩、不打包:附加件里的 import 'three' 交给卡里的 importmap 解析成同一份核心
const copies = [
  ['three@0.186/three.module.js', 'build/three.module.js'],
  ['three@0.186/three.core.js', 'build/three.core.js'],
  ['three@0.186/addons/controls/OrbitControls.js', 'examples/jsm/controls/OrbitControls.js'],
  ['three@0.186/addons/controls/TrackballControls.js', 'examples/jsm/controls/TrackballControls.js'],
]
// 其余三个是一堆子包 / 带依赖的入口,打成单文件
const bundles = [
  ['d3@7/d3.js', "export * from 'd3'"],
  ['chart.js@4/auto.js', "export * from 'chart.js'\nexport { default } from 'chart.js/auto'"],
  ['gsap@3/gsap.js', "export * from 'gsap'\nexport { default } from 'gsap'"],
]
try {
  for (const [rel, src] of copies) out(rel, esbuild.buildSync({ ...common, entryPoints: [path.join(three, src)] }).outputFiles[0].contents)
  for (const [rel, contents] of bundles) out(rel, esbuild.buildSync({ ...common, bundle: true, stdin: { contents, resolveDir: path.dirname(nm) } }).outputFiles[0].contents)
  fs.writeFileSync(path.join(stage, '.version'), `${versions} r${SCRIPT_REV}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.renameSync(stage, outDir)
} finally { fs.rmSync(stage, { recursive: true, force: true }) }
console.log(`[iui-libs] ${versions} → ${path.relative(process.cwd(), outDir) || outDir}`)
