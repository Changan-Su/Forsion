/**
 * macOS 安装版自愈:清除 App 自身包内的 com.apple.quarantine 隔离属性。
 *
 * 背景:未公证(notarize)的 App 经浏览器下载后整包带隔离属性;用户「右键 → 打开」只豁免
 * App 本体的启动,运行时 dlopen 的原生库(sherpa-onnx、better-sqlite3、内置 Python)仍被
 * Gatekeeper 逐文件拦下——v2.6.0~v2.6.8 的 macOS 安装版因此在主进程启动期加载 sherpa 时
 * 整个崩死(错误被上游 addon.js 吞成误导性的 "Could not find sherpa-onnx-node")。
 * 此处在模块加载期(早于 app ready / 引擎子进程 spawn)把自家包的隔离属性整棵清掉:
 * 整包 xattr -dr 实测 <1s,只在检测到属性时才执行;之后每次启动仅两次 ~10ms 存在性检查。
 * 失败(如无写权限)只告警不阻断——sherpa 侧已懒加载兜底,App 照常启动。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'

const XATTR = '/usr/bin/xattr'

function hasQuarantine(path: string): boolean {
  try {
    execFileSync(XATTR, ['-p', 'com.apple.quarantine', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function healMacQuarantine(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const bundle = resolve(process.resourcesPath, '..', '..') // …/Forsion.app
  if (!bundle.endsWith('.app')) return
  // 除根之外再探一个包内 dylib:网上流传的手动解法常是不带 -r 的 xattr -d,只清根、留一树。
  const probe = join(
    process.resourcesPath,
    'app.asar.unpacked/node_modules',
    `sherpa-onnx-${process.platform}-${process.arch}`,
    'libsherpa-onnx-c-api.dylib',
  )
  if (!hasQuarantine(bundle) && !(existsSync(probe) && hasQuarantine(probe))) return
  try {
    const t0 = Date.now()
    execFileSync(XATTR, ['-dr', 'com.apple.quarantine', bundle], { stdio: 'ignore', timeout: 60_000 })
    console.log(`[macQuarantine] 已清除包内隔离属性(${Date.now() - t0}ms)`)
  } catch (e) {
    console.warn(`[macQuarantine] 清除失败,可手动执行:xattr -dr com.apple.quarantine "${bundle}"`, e)
  }
}
