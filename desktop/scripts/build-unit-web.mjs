#!/usr/bin/env node
/**
 * 构建「设备页」用的 web 渲染层(方案 §11.5:本轮不捆进桌面包,手动构建 + 环境变量指路)。
 *
 * 做三件事:
 *   1. 在 ../web 里跑 `vite build --base=./ --outDir <desktop>/unit-web-dist`
 *      —— **必须相对 base**:设备页既在局域网根路径(`http://ip:port/`)也在 server 隧道
 *      子路径(`…/api/units/<id>/proxy/`)下打开,绝对 /assets 在后者必炸。
 *   2. 提示把 TANGU_UNIT_WEB_DIST 指到产物(unitWeb.webDistDir 读它;缺席出提示页)。
 *   3. v2.1 捆包时把产物改进 electron-builder extraResources(落 process.resourcesPath/unit-web)。
 *
 * 跑:node scripts/build-unit-web.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const webRoot = resolve(desktopRoot, '../web')
const outDir = resolve(desktopRoot, 'unit-web-dist')

if (!existsSync(resolve(webRoot, 'package.json'))) {
  console.error(`[build-unit-web] 找不到 web 包:${webRoot}`)
  process.exit(1)
}

console.log(`[build-unit-web] vite build --base=./ → ${outDir}`)
const r = spawnSync('npx', ['vite', 'build', '--base=./', '--outDir', outDir, '--emptyOutDir'], {
  cwd: webRoot,
  stdio: 'inherit',
})
if (r.status !== 0) process.exit(r.status ?? 1)

console.log(`
[build-unit-web] 完成。让 unitWeb 用上它:
  export TANGU_UNIT_WEB_DIST=${outDir}
然后重启 Forsion Desktop 并打开「允许其他设备连接本机」。`)
