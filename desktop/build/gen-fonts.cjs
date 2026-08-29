/** 内置 UI 字体的自托管副本(设置 → 外观 → 字体的预设项)。
 *
 *  为什么内置:预设过去是**系统字体名**(PingFang SC / Microsoft YaHei / Menlo …),装没装全看用户机器,
 *  同一个预设在两台电脑上能长得完全不一样;主题侧的 `manifest.fonts.google` 更是直接连 fonts.googleapis.com,
 *  跟 excalidraw 当初一个毛病 —— CSP 是 default-src 'self'、桌面端还得离线可用。所以字体随包走。
 *
 *  两条省体积的纪律(不照做体积翻倍甚至十倍):
 *  ① **只取 woff2**。fontsource 的 CSS 每条 src 都是 `woff2, woff` 双写,原样 import 会让 vite 把两份
 *     都打进产物。这里把 .woff 那半从 src 里剥掉,只拷 woff2(Chromium 全版本支持 woff2)。
 *  ② **只取用得上的字重/轴**。整包 import 是陷阱:noto-sans-sc 全量 74M(9 个字重)、inter 全量 1.9M
 *     (含 italic + opsz 轴)。按 CSS 文件粒度挑 → 实测 ~14.5M。
 *
 *  Noto Sans SC 按 unicode-range 切成 101 片,运行时只下命中的片;霞鹜文楷 fontsource 侧没切片,
 *  是单个 6.9M 文件(名字叫 latin 但其实是整份字体),整体加载 —— 本地磁盘读,可接受。
 *
 *  许可:四款全是 SIL OFL 1.1,允许随应用分发;每个包的 LICENSE 一并拷进去(OFL 要求保留)。
 *
 *  照 excalidraw/python 的先例:体积大、可从 node_modules 再生 → 不入库。postinstall 跑,按 spec 指纹
 *  戳幂等,没变就跳过这十几 M 的拷贝。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// web 也调这支(自己 npm ci、自己的 public/):`--out <相对 cwd 的目录>`。
const argOut = process.argv.indexOf('--out')
const outDir = argOut > 0 && process.argv[argOut + 1]
  ? path.resolve(process.cwd(), process.argv[argOut + 1])
  : path.join(__dirname, '..', 'frontend', 'public', 'fonts')

/** 每项 = 一个字族要落盘的那几个 CSS。family 必须与 fontsource 声明的 font-family 逐字一致
 *  —— fontPresets.ts 的字体栈按这个名字点名,对不上就静默回落到系统字体。 */
const SPECS = [
  { pkg: '@fontsource-variable/inter', css: ['wght.css'], family: 'Inter Variable' },
  { pkg: '@fontsource-variable/jetbrains-mono', css: ['wght.css'], family: 'JetBrains Mono Variable' },
  { pkg: '@fontsource/noto-sans-sc', css: ['400.css', '700.css'], family: 'Noto Sans SC' },
  { pkg: '@fontsource/lxgw-wenkai', css: ['500.css'], family: 'LXGW WenKai' },
]

const STAMP = path.join(outDir, '.stamp')

/** 改了生成逻辑(剥 woff 的正则、落盘布局…)就 +1,老产物才会被判过期。 */
const GEN_VERSION = 2

/** 逐级上找 node_modules。**cwd 与 __dirname 两处都要找**(照 copy-excalidraw-assets.cjs 的房规):
 *  web 自己 npm ci、自己的 node_modules,只从 __dirname 找会永远看不见它;
 *  容器里依赖又可能提升到公共祖先,所以两处都得往上走(codex 评审 2026-08-28 第二轮)。 */
function findPkg(name) {
  for (const start of [process.cwd(), __dirname]) {
    let dir = start
    for (;;) {
      const p = path.join(dir, 'node_modules', name)
      if (fs.existsSync(path.join(p, 'package.json'))) return p
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

// 剥掉 `, url(....woff) format('woff')` 这半个 src。woff2 那半原样留着。
const WOFF_FALLBACK = /,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g

/** 读齐所有源 CSS(已剥 woff)+ 各包版本。指纹与产物都由它算,保证两者同源。 */
function collect() {
  const units = []
  for (const spec of SPECS) {
    const pkgDir = findPkg(spec.pkg)
    // 硬失败:静默少字体 = 预设选了没反应,比构建红更难查。
    if (!pkgDir) throw new Error(`[gen-fonts] 找不到 ${spec.pkg},先 npm i`)
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
    for (const cssName of spec.css) {
      const cssPath = path.join(pkgDir, cssName)
      if (!fs.existsSync(cssPath)) throw new Error(`[gen-fonts] ${spec.pkg}/${cssName} 不存在`)
      const css = fs.readFileSync(cssPath, 'utf8').replace(WOFF_FALLBACK, '')
      const woff2 = [...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((m) => m[1])
      units.push({ spec, pkgDir, version, cssName, css, woff2 })
    }
  }
  return units
}

/** 指纹要盖住**所有会改变产物的东西**:生成器版本、spec、各包版本、以及 CSS 正文本身。
 *  只序列化 SPECS 是不够的 —— 依赖升级后内容变了指纹却没变,会一直打包旧副本(codex 评审 2026-08-28)。 */
function fingerprintOf(units) {
  const h = crypto.createHash('sha256')
  h.update(`v${GEN_VERSION}\n${JSON.stringify(SPECS)}\n`)
  for (const u of units) h.update(`${u.spec.pkg}@${u.version}/${u.cssName}\n${u.css}\n`)
  return h.digest('hex')
}

/** 戳只说明「上次按这个指纹生成过」,不代表产物还在。命中前把引用到的文件逐个核一遍。 */
function outputsIntact(units) {
  if (!fs.existsSync(path.join(outDir, 'fonts.css'))) return false
  for (const u of units) {
    for (const name of u.woff2) {
      if (!fs.existsSync(path.join(outDir, 'files', name))) return false
    }
  }
  return true
}

function main() {
  const units = collect()
  const fingerprint = fingerprintOf(units)

  if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8') === fingerprint && outputsIntact(units)) return

  // 先在**独占临时目录**里做全套,做完再整体换过去。
  // 原地「删掉再逐文件写」在并发下会交出坏产物:A 拷到一半,B 把目录删了随后自己被 kill,
  // A 继续拷完并写下完整的戳 —— 本次构建就打包了一份缺文件却「成功」的副本(codex 评审第二轮)。
  // SIGKILL 会跳过 finally,留下孤儿 tmp/old 目录(每个十几 M)。开工前顺手扫掉同级残骸。
  const parent = path.dirname(outDir)
  const base = path.basename(outDir)
  if (fs.existsSync(parent)) {
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.old-`)) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true })
      }
    }
  }

  const tmpDir = `${outDir}.tmp-${process.pid}`
  const filesDir = path.join(tmpDir, 'files')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(filesDir, { recursive: true })

  try {
    const chunks = []
    const licensed = new Set()
    let copied = 0
    let bytes = 0

    for (const u of units) {
      for (const name of u.woff2) {
        const dest = path.join(filesDir, name)
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(u.pkgDir, 'files', name), dest)
          copied++
          bytes += fs.statSync(dest).size
        }
      }
      // fonts.css 与 files/ 同级 → 相对路径原样成立。
      chunks.push(`/* ${u.spec.pkg}@${u.version}/${u.cssName} — ${u.spec.family} */\n${u.css.trim()}`)
      if (!licensed.has(u.spec.pkg)) {
        licensed.add(u.spec.pkg)
        const lic = path.join(u.pkgDir, 'LICENSE')
        if (fs.existsSync(lic)) {
          fs.copyFileSync(lic, path.join(tmpDir, `LICENSE-${u.spec.pkg.replace(/[@/]/g, '_')}.txt`))
        }
      }
    }

    fs.writeFileSync(path.join(tmpDir, 'fonts.css'), chunks.join('\n\n') + '\n')

    // 换过去之前先自查一遍:引用到的 woff2 一个都不能少。
    for (const u of units) {
      for (const name of u.woff2) {
        if (!fs.existsSync(path.join(filesDir, name))) throw new Error(`[gen-fonts] 产物缺 ${name}`)
      }
    }
    // 戳写在临时目录里,跟着一起换 —— 绝不会出现「戳已落地而内容没落地」。
    fs.writeFileSync(path.join(tmpDir, '.stamp'), fingerprint)

    // rename 是原子的;先把旧的挪走再换入,失败也不会留下空目录。
    const trash = `${outDir}.old-${process.pid}`
    if (fs.existsSync(outDir)) fs.renameSync(outDir, trash)
    fs.renameSync(tmpDir, outDir)
    fs.rmSync(trash, { recursive: true, force: true })

    console.log(`[gen-fonts] ${copied} 个 woff2,${(bytes / 1048576).toFixed(1)}M → ${path.relative(process.cwd(), outDir)}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

main()
