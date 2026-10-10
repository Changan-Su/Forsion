#!/usr/bin/env node
/** 只为看一眼 macOS 安装窗口长什么样:用真的 build/dmg-layout.cjs + 背景图 + 说明文件,套一个空壳 .app 打出
 *  一个几百 KB 的 DMG(十几秒),不跑整套打包。改了背景 / 图标位置后跑它,挂载后在 Finder 里核对:
 *    node scripts/dmg-layout-preview.cjs && open "/Volumes/Forsion layout preview"
 *  要看两种情况:Finder「显示」菜单里路径栏、状态栏都开着(底部少约 56px)和都关着。
 *  卷名固定叫「Forsion layout preview」:Finder 按「卷名:路径」找背景图,和本机挂着的正式安装包同名会串图。 */
const { execFileSync } = require('child_process')
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readdirSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

if (process.platform !== 'darwin') {
  console.error('[dmg-layout-preview] 只能在 macOS 上跑')
  process.exit(1)
}
const root = join(__dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'forsion-dmg-preview-'))
const app = join(tmp, 'Forsion.app', 'Contents')
mkdirSync(join(app, 'MacOS'), { recursive: true })
mkdirSync(join(app, 'Resources'), { recursive: true })
copyFileSync(join(root, 'build', 'icon.icns'), join(app, 'Resources', 'icon.icns'))
writeFileSync(join(app, 'MacOS', 'Forsion'), '#!/bin/sh\nexit 0\n')
chmodSync(join(app, 'MacOS', 'Forsion'), 0o755)
writeFileSync(
  join(app, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Forsion</string>
<key>CFBundleIdentifier</key><string>net.forsion.dmg-layout-preview</string>
<key>CFBundleName</key><string>Forsion</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
</dict></plist>
`,
)
const config = join(tmp, 'config.cjs')
writeFileSync(
  config,
  `module.exports = {
  appId: 'net.forsion.dmg-layout-preview',
  productName: 'Forsion',
  directories: { output: ${JSON.stringify(join(tmp, 'out'))}, buildResources: 'build' },
  mac: { target: 'dmg', identity: null, icon: 'build/icon.icns' },
  dmg: { title: 'Forsion layout preview', ...require(${JSON.stringify(join(root, 'build', 'dmg-layout.cjs'))}) },
}
`,
)
execFileSync(
  join(root, 'node_modules', '.bin', 'electron-builder'),
  ['--mac', 'dmg', '--prepackaged', join(tmp, 'Forsion.app'), '--projectDir', root, '--config', config, '--publish', 'never'],
  { stdio: 'inherit' },
)
const dmg = join(tmp, 'out', readdirSync(join(tmp, 'out')).find((f) => f.endsWith('.dmg')))
execFileSync('hdiutil', ['attach', '-noautoopen', dmg], { stdio: 'inherit' })
console.log(`[dmg-layout-preview] 已挂载:/Volumes/Forsion layout preview(看完在 Finder 里推出即可)\n  ${dmg}`)
