/**
 * Forsion Clip(Chrome 扩展)手动安装的底座(方案页 docs/ToBeImproved/Clip安装引导方案_2026-10-20,用户选 C):
 * - 随包那份在 .app 里,mac「加载已解压」的选择框进不去 → 复制到用户找得到的位置,版本号变了才覆盖;
 * - 替用户打开 Chrome 扩展页:mac 走 `open -b com.google.Chrome chrome://extensions`(LaunchServices 送 GURL,实测
 *   Chrome 已开 / 冷启动都能开)。shell.openExternal 不行(系统里没有 chrome: 的处理者),命令行参数里的 chrome://
 *   会被 Chrome 拦成新标签页 → 别的系统只能复制地址让用户粘贴。
 * 拖拽把手复用 fs:startDrag(原生拖出,文件夹也行)。拖进扩展页只在 Chrome 开发者模式下生效(扩展页 drag-enabled = inDevMode)。
 */
import { app, clipboard, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { forsionHomeDir } from './forsionHome'

export const CHROME_EXTENSIONS_URL = 'chrome://extensions'
const CHROME_BUNDLE_ID = 'com.google.Chrome'

/** 随包的扩展:安装包在 tangu-server/browser-extension,dev 用依赖里那份(npm @forsion/clip)。 */
export function clipSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tangu-server', 'browser-extension')
    : join(__dirname, '..', '..', 'node_modules', '@forsion', 'clip', 'chrome-mv3')
}

/** 复制出来的位置:mac ~/Library/Application Support/Forsion/Forsion Clip,Windows %APPDATA%\Forsion\Forsion Clip;dev 落 ~/.forsion-dev。 */
export function clipCopyDir(): string {
  return app.isPackaged ? join(app.getPath('appData'), 'Forsion', 'Forsion Clip') : join(forsionHomeDir(), 'Forsion Clip')
}

const versionOf = (dir: string): string | null => {
  try { return String(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version || '') || null } catch { return null }
}

/**
 * 版本号一样就不动(Chrome 正从这里加载);不一样整份换掉:先拷进旁边的临时目录再换名,拷到一半失败不会留下半个扩展。
 * ponytail: 换掉时 Chrome 若正开着旧版,要重启 Chrome 才整份用上新版(扩展页按需从磁盘读文件)。
 */
export function ensureClipCopy(src: string, dst: string): { dir: string; version: string } | { error: string } {
  const version = versionOf(src)
  if (!version) return { error: 'bundled extension not found' }
  if (versionOf(dst) === version) return { dir: dst, version }
  const tmp = `${dst}.tmp-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, tmp, { recursive: true, dereference: true })
    rmSync(dst, { recursive: true, force: true })
    renameSync(tmp, dst)
    return { dir: dst, version }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    return { error: (e as Error).message }
  }
}

export type OpenChromeResult = { ok: true } | { ok: false; copied: true; reason: 'no-chrome' | 'unsupported' }

/** mac:让 Chrome 打开扩展页。没装 Chrome、或不是 mac → 把地址复制到剪贴板,由界面请用户粘贴进 Chrome 地址栏。 */
export function openChromeExtensions(): Promise<OpenChromeResult> {
  const copy = (reason: 'no-chrome' | 'unsupported'): OpenChromeResult => {
    clipboard.writeText(CHROME_EXTENSIONS_URL)
    return { ok: false, copied: true, reason }
  }
  if (process.platform !== 'darwin') return Promise.resolve(copy('unsupported'))
  return new Promise((resolve) => {
    execFile('open', ['-b', CHROME_BUNDLE_ID, CHROME_EXTENSIONS_URL], (err) => resolve(err ? copy('no-chrome') : { ok: true }))
  })
}

export function registerClipExtensionIpc(): void {
  ipcMain.handle('clipExt:prepare', () => ensureClipCopy(clipSourceDir(), clipCopyDir()))
  ipcMain.handle('clipExt:openChrome', () => openChromeExtensions())
}
