/** 白板引擎(zsviczian fork)+ 字体的自托管副本。拷进 renderer 的 publicDir(vite 原样带进 out/renderer),
 *  运行时经 EXCALIDRAW_ASSET_PATH / forkRuntime.ts 从这里取(见 ExcalidrawEmbed.tsx)。
 *
 *  - fonts:excalidraw 默认从 CDN(esm.sh)现拉,而本 App 的 CSP 是 default-src 'self' 且桌面端得离线可用。
 *  - excalidraw.js/.css:**fork 的 dist/prod 对外是坏的** —— 里面留着 `@excalidraw/element` 这类
 *    没发布到 npm 的内部裸 import,vite/esbuild 一律解析不了。fork 唯一自包含的产物是 dist/obsidian
 *    那份 IIFE(挂 self.ExcalidrawLib,React 走全局),所以走 <script> 装载而不进打包管道,详见 forkRuntime.ts。
 *
 *  照 build/python 的先例:体积大、可从 node_modules 再生 → 不入库(仓根 .gitignore 已挡)。
 *  postinstall 跑;按版本号戳幂等,版本没变就跳过这 20M 的拷贝。 */
const fs = require('fs')
const path = require('path')

// web 也调这支(它自己 npm ci、自己的 public/):`--out <相对 cwd 的目录>`。
// 包位置一律用 require.resolve 的**逐级上找**,不写死 desktop/node_modules —— 容器里 web 的依赖装在
// 公共祖先 /app/node_modules,写死路径就找不到。
const argOut = process.argv.indexOf('--out')
const outDir = argOut > 0 && process.argv[argOut + 1]
  ? path.resolve(process.cwd(), process.argv[argOut + 1])
  : path.join(__dirname, '..', 'frontend', 'public', 'excalidraw')
const stamp = path.join(outDir, '.version')

/** 自己走 node_modules 上找,不用 require.resolve:fork 的 exports 表只声明了 types 条件,
 *  `require.resolve('@excalidraw/excalidraw/package.json')` 会被 exports 挡掉。 */
function findPkg() {
  for (const start of [process.cwd(), __dirname]) {
    let dir = start
    for (;;) {
      const p = path.join(dir, 'node_modules', '@excalidraw', 'excalidraw', 'package.json')
      if (fs.existsSync(p)) return path.dirname(p)
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

const pkgDir = findPkg()
let version
try {
  version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
} catch {
  console.warn('[excalidraw-assets] 未安装 @excalidraw/excalidraw,跳过')
  process.exit(0)
}

// ⚠️ CSS 取 dist/prod 那份而**不是** dist/obsidian 的同名文件:两份是同一套类名(同源构建),但 obsidian
//    档里 --editor-container-padding 之类的值写成了 Obsidian 的设计 token(var(--size-4-2)/--text-color)。
//    在我们这儿解析不出来 → 整条 FixedSideContainer 的 inset 塌成 0,汉堡菜单与工具栏叠在左上角。
const SRC = {
  'excalidraw.js': path.join(pkgDir, 'dist', 'obsidian', 'excalidraw.production.min.js'),
  'excalidraw.css': path.join(pkgDir, 'dist', 'prod', 'index.css'),
}
const FONTS = path.join(pkgDir, 'dist', 'prod', 'fonts')
const nonEmpty = (p) => {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

// 幂等戳:版本号 + **产物真的还在**。只看版本号的话,产物被清掉/拷坏时这里会直接跳过,
// 留下一个「装过了但白板 404」的坑(而 404 要到用户点开画板才暴露)。
const complete = Object.keys(SRC).every((f) => nonEmpty(path.join(outDir, f))) && fs.existsSync(path.join(outDir, 'fonts'))
try {
  if (complete && fs.readFileSync(stamp, 'utf8') === version) process.exit(0)
} catch {
  /* 无戳 / 读不动 → 重拷 */
}

// ⚠️ 先验源、再删旧:反过来的话源缺失时会先把上一份能用的副本清空再抛错,
//    把「装不上」升级成「本来能跑的也跑不了了」。
for (const [name, src] of Object.entries(SRC)) {
  if (!nonEmpty(src)) throw new Error(`[excalidraw-assets] 源文件缺失或为空:${src}(${name});fork 的产物布局变了?`)
}
if (!fs.existsSync(FONTS)) throw new Error(`[excalidraw-assets] 字体目录缺失:${FONTS}`)

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.cpSync(FONTS, path.join(outDir, 'fonts'), { recursive: true })
for (const [name, src] of Object.entries(SRC)) fs.copyFileSync(src, path.join(outDir, name))
fs.writeFileSync(stamp, version)
console.log('[excalidraw-assets] engine + fonts', version, '->', outDir)
