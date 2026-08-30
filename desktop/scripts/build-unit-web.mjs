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
import { existsSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ Windows:npm/npx 是 `.cmd` 批处理,而 **Node 自 18 起不再允许直接 spawn `.cmd`**
// (CVE-2024-27980 的修复),写成 'npm.cmd' 照样起不来 —— 症状是 spawnSync 瞬间返回、
// 一行 npm 输出都没有(2026-08-30 在 CI 上实翻:194 行刚打印「先 npm ci」,0.3 秒后就跳到下一条命令)。
// 走 `cmd /c npm ci`:由 cmd 去解析 .cmd,参数仍由 Node 按 Windows 规则加引号,
// 不像 shell:true 那样把整条命令行交给 shell 二次解析。
const IS_WIN = process.platform === 'win32'
const runTool = (tool, args, opts) =>
  spawnSync(IS_WIN ? 'cmd' : tool, IS_WIN ? ['/c', tool, ...args] : args, opts)

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
  const i = runTool('npm', ['ci'], { cwd: webRoot, stdio: 'inherit' })
  if (i.status !== 0) process.exit(i.status ?? 1)
}

// ⚠️ **仓根临时软链**:web 镜像把依赖装在公共祖先 `/app`,所以被复用的 mobile/src、
// desktop/frontend 里的**裸包** import(framer-motion 等)能一路向上解析到。真仓库里依赖只在
// `web/node_modules`,而 `mobile/` 与它是兄弟不是后代 → Rollup 当场
// `failed to resolve import "framer-motion" from mobile/src/MobileRoot.tsx`。
// 本机之所以从来不报,是仓根碰巧躺着一个历史遗留的 node_modules 顶着 —— CI 的干净 checkout 没有,
// 所以这支脚本一接进 CI 就红(2026-08-30 实翻)。构建期补一份、构建完拆掉 = 等价镜像里的 /app 布局。
const rootNodeModules = resolve(desktopRoot, '..', 'node_modules')
let linkedRoot = false
if (!existsSync(rootNodeModules)) {
  symlinkSync(resolve(webRoot, 'node_modules'), rootNodeModules, 'junction') // posix 忽略 type
  linkedRoot = true
  console.log(`[build-unit-web] 仓根临时软链 node_modules → web/node_modules(构建后拆除)`)
}

console.log(`[build-unit-web] vite build --base=./ → ${outDir}`)
const r = runTool('npx', ['vite', 'build', '--base=./', '--outDir', outDir, '--emptyOutDir'], {
  cwd: webRoot,
  stdio: 'inherit',
})
if (linkedRoot) {
  try { unlinkSync(rootNodeModules) } catch { try { rmSync(rootNodeModules, { recursive: false }) } catch { /* 留着也不致命 */ } }
}
if (r.status !== 0) process.exit(r.status ?? 1)

console.log(`
[build-unit-web] 完成。dev 下 unitWeb 会直接读到 ${outDir};
打包(npm run dist / pack)会把它捆进安装包;也可显式 export TANGU_UNIT_WEB_DIST=${outDir}。`)
