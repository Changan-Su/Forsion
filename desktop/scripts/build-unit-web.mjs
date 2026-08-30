#!/usr/bin/env node
/**
 * 构建「设备页」用的 web 渲染层。产物三种消费路径(unitWeb.webDistDir 依此序解析):
 *   1. TANGU_UNIT_WEB_DIST 环境变量(显式指路);
 *   2. 打进桌面包:electron-builder extraResources 把 unit-web-dist 落到
 *      process.resourcesPath/unit-web(v2.1 起;全家桶 dist/pack 前置本脚本,缺产物构建即失败);
 *   3. dev:desktop/unit-web-dist 原地被读到(免设环境变量)。
 *
 * **必须相对 base**:设备页既在局域网根路径(`http://ip:port/`)也在 server 隧道
 * 子路径(`…/api/units/<id>/proxy/`)下打开,绝对 /assets 在后者必炸。
 *
 * 跑:node scripts/build-unit-web.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ Windows 上 npm/npx 是 `.cmd` 批处理,spawnSync 不走 shell → ENOENT。用带扩展名的真身
// (而不是 shell:true——那样参数要自己转义,路径带空格就炸)。CI 的 windows-2022 job 跑这支。
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const webRoot = resolve(desktopRoot, '../web')
const outDir = resolve(desktopRoot, 'unit-web-dist')

if (!existsSync(resolve(webRoot, 'package.json'))) {
  console.error(`[build-unit-web] 找不到 web 包:${webRoot}`)
  process.exit(1)
}

// 发布机可能没装过 web 的依赖(dist 链会走到这):缺 node_modules 先装,别让 vite 直接炸。
if (!existsSync(resolve(webRoot, 'node_modules'))) {
  console.log('[build-unit-web] web/node_modules 缺席,先 npm ci …')
  const i = spawnSync(NPM, ['ci'], { cwd: webRoot, stdio: 'inherit' })
  if (i.status !== 0) process.exit(i.status ?? 1)
}

console.log(`[build-unit-web] vite build --base=./ → ${outDir}`)
const r = spawnSync(NPX, ['vite', 'build', '--base=./', '--outDir', outDir, '--emptyOutDir'], {
  cwd: webRoot,
  stdio: 'inherit',
})
if (r.status !== 0) process.exit(r.status ?? 1)

console.log(`
[build-unit-web] 完成。dev 下 unitWeb 会直接读到 ${outDir};
打包(npm run dist / pack)会把它捆进安装包;也可显式 export TANGU_UNIT_WEB_DIST=${outDir}。`)
