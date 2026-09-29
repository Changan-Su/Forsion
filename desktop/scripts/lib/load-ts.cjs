/**
 * 在纯 Node 台架里装载桌面主进程 / 共享层的 TS 模块(desktop 的 node_modules/.bin 里没有 tsx):esbuild 现打一个 CJS 包再求值。
 * 只给不依赖 electron 运行时的模块用(unitHost / unitWeb / remoteSessions / unitCaller …);`electron` 标成 external,
 * 类型导入被 esbuild 擦掉,真在运行时 require('electron') 会直接抛 —— 那说明模块选错了,不该兜。
 * 同 mobile/scripts/unit-relay.test.cjs 的做法。
 */
'use strict'
const path = require('node:path')
const { buildSync } = require('esbuild')

const cache = new Map()
function loadTs(file) {
  const abs = path.resolve(file)
  if (cache.has(abs)) return cache.get(abs)
  const src = buildSync({
    entryPoints: [abs], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
    target: 'node20', external: ['electron'],
  }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', '__filename', '__dirname', src)(mod, mod.exports, require, abs, path.dirname(abs))
  cache.set(abs, mod.exports)
  return mod.exports
}

module.exports = { loadTs }
