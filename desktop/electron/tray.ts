/**
 * 系统托盘 / macOS 菜单栏图标。App 运行期常驻:关闭主窗只是隐藏到托盘(见 main.ts 的 close 拦截),
 * 由此处菜单「退出」或 before-quit 才真正退出。
 * 图标复用打包用的 build/icon.png(彩色品牌图);缩到 18px 适配托盘/菜单栏。
 * ponytail: 用彩色 App 图标而非 mac 模板图(不随明暗反色),要更贴 HIG 再画一张单色模板图换上。
 * ponytail: 菜单文案硬编码中文(与 main.ts 现有原生弹窗一致),主进程不接 i18n;要多语再从 config 读 locale。
 */
import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

function trayIcon(): Electron.NativeImage {
  // 打包态:icon.png 经 extraResources 复制为 resources/tray.png;dev 态直接读 build/icon.png。
  const path = app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(__dirname, '../../build/icon.png')
  const img = nativeImage.createFromPath(path)
  return img.isEmpty() ? img : img.resize({ width: 18, height: 18 })
}

export function createTray(h: { show: () => void; checkUpdates: () => void; quit: () => void }): void {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('Forsion')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Forsion', click: () => h.show() },
    { label: '检查更新', click: () => h.checkUpdates() },
    { type: 'separator' },
    { label: '退出 Forsion', click: () => h.quit() },
  ]))
  // win/linux:左键单击直接召回主窗(mac 单击默认弹菜单,遵循平台习惯不额外绑定)。
  if (process.platform !== 'darwin') tray.on('click', () => h.show())
}
