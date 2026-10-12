#!/usr/bin/env node
/**
 * 引擎热更新在「打包后的真实运行时」上走一遍(build-desktop 各平台 runner 上、出完安装包之后跑)。
 *
 * 找到 dist 下解开的安装包,用里面的 Electron(ELECTRON_RUN_AS_NODE)和 resources/tangu-server 跑
 * tangu-agent/scripts/engine-overlay.e2e.mjs:启动器选不选签好名的新版、原生依赖是不是从安装包那份解析、改一个字节后退不退回。
 * 本机的端到端核对只覆盖 macOS + 系统 Node;Windows 的盘符路径 / file URL、Electron 自带的 Node 只有这里测得出。
 *
 *   node scripts/engine-overlay-packaged.check.cjs [resources 目录]
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const desktop = path.resolve(__dirname, '..')
function findResources(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'app.asar'))) return [dir]
  if (depth > 5 || !fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !['node_modules', 'app.asar.unpacked', 'tangu-server', 'bundled-plugins'].includes(e.name)
      ? findResources(path.join(dir, e.name), depth + 1) : [])
}
/** 安装包的主程序 = 那个目录里最大的普通文件(Electron 本体一百多 MB,旁边的 helper / 动态库都小一个量级)。 */
function largestFile(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ file: path.join(dir, e.name), size: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => b.size - a.size)[0]?.file
}

const resources = process.argv[2] ? path.resolve(process.argv[2]) : findResources(path.join(desktop, 'dist'))[0]
if (!resources) {
  console.error('::error::No packaged app found under desktop/dist (run electron-builder first).')
  process.exit(1)
}
const engine = path.join(resources, 'tangu-server')
if (!fs.existsSync(engine)) {
  console.log(`This distribution ships no agent engine (${resources}); nothing to check.`)
  process.exit(0)
}
// macOS:<App>.app/Contents/Resources ↔ Contents/MacOS/<主程序>;Windows / Linux:resources 的上一层就是主程序所在目录。
const exeDir = path.basename(resources) === 'Resources' ? path.join(resources, '..', 'MacOS') : path.dirname(resources)
const exe = largestFile(exeDir)
if (!exe) {
  console.error(`::error::No executable found in ${exeDir}`)
  process.exit(1)
}
console.log(`engine: ${engine}\nexe:    ${exe}`)
const r = spawnSync(process.execPath, [path.join(desktop, '..', 'tangu-agent', 'scripts', 'engine-overlay.e2e.mjs'), '--root', engine, '--exe', exe], { stdio: 'inherit' })
process.exit(r.status ?? 1)
