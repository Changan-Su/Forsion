/**
 * Forsion Clip(Chrome 扩展)手动安装的底座(方案页 docs/ToBeImproved/Clip安装引导方案_2026-10-20,用户选 C):
 * - 随包那份在 .app 里,mac「加载已解压」的选择框进不去 → 复制到用户找得到的位置;
 * - 替用户打开 Chrome 扩展页:mac 走 `open -b com.google.Chrome chrome://extensions`(LaunchServices 送 GURL,实测
 *   Chrome 已开 / 冷启动都能开)。shell.openExternal 不行(系统里没有 chrome: 的处理者),命令行参数里的 chrome://
 *   会被 Chrome 拦成新标签页 → 别的系统只能复制地址让用户粘贴。
 * 拖拽把手复用 fs:startDrag(原生拖出,文件夹也行)。拖进扩展页只在 Chrome 开发者模式下生效(扩展页 drag-enabled = inDevMode)。
 */
import { app, clipboard, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
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

export type ClipCopy = { dir: string; version: string; bundled: string }

/**
 * 保证副本存在。已有副本时只在 `update` 为真才换成随包版本:Chrome 正从副本加载,静默换掉会让还在跑的旧版读到新文件
 * (Codex 10-20)。所以只在用户要(重新)装的那一下换 —— 拖进去 / 走「加载已解压」时 Chrome 会整份重新加载。
 * 换的时候旧副本先改名留作备份,新副本就位后才删;中途失败放回原处,上次换到一半(只剩备份)开头先恢复。
 */
export function ensureClipCopy(src: string, dst: string, update = false): ClipCopy | { error: string } {
  const bundled = versionOf(src)
  if (!bundled) return { error: 'bundled extension not found' }
  const tmp = `${dst}.tmp`
  const bak = `${dst}.old`
  try {
    if (!existsSync(dst) && existsSync(bak)) renameSync(bak, dst)
    const current = versionOf(dst)
    if (current && (current === bundled || !update)) return { dir: dst, version: current, bundled }
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, tmp, { recursive: true, dereference: true })
    rmSync(bak, { recursive: true, force: true })
    if (existsSync(dst)) renameSync(dst, bak)
    try { renameSync(tmp, dst) } catch (e) { if (existsSync(bak)) renameSync(bak, dst); throw e }
    rmSync(bak, { recursive: true, force: true })
    return { dir: dst, version: bundled, bundled }
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

type EngineRef = () => { url: string | null; token: string }

async function engineJson(engine: EngineRef, path: string, method = 'GET'): Promise<any> {
  const { url, token } = engine()
  if (!url) return null
  const res = await fetch(`${url.replace(/\/$/, '')}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  return res.ok ? res.json() : null
}

/** 一次配对(方案 C 第二步):同一台电脑上已配对的 Forsion Clip 来领 Tangu 浏览器控制的连接码(unitWeb /unit/browser-control)。
 *  桥没在听(端口被占 / 关了)就不给,Clip 留着手动粘码那条路。 */
export async function browserControlCode(engine: EngineRef): Promise<string | null> {
  const s = await engineJson(engine, '/agent/browser-extension').catch(() => null)
  return s?.listening && typeof s.code === 'string' ? s.code : null
}

const older = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  return false
}
let syncedFor = ''

/**
 * Forsion 更新后:连着的 Clip 比随包的旧 → 副本换成随包版本,再叫它重新加载(已解压的扩展不会自己重读磁盘)。
 * 只在有 Clip 连着时换、换完立刻重载:不留「Chrome 还在跑旧版、文件已是新版」的空档(Codex 10-20 的顾虑)。
 * 每个随包版本只试一次:Chrome 若是从别处加载的(比如老用户选的 .app 里那份),重载后还是旧版也不会反复折腾。
 * 已知边界(实测):开发者模式关着时,Chrome 会以 unsupportedDeveloperExtension 停掉重载后的已解压扩展;
 * 用户本来就是开着开发者模式拖进去的,事后关掉的再打开即自动恢复 —— 这是 Chrome 自己的闸,重载只是让它早一点生效。
 */
export async function syncClipVersion(engine: EngineRef, src = clipSourceDir(), dst = clipCopyDir()): Promise<'reloaded' | 'skip'> {
  const bundled = versionOf(src)
  if (!bundled || syncedFor === bundled) return 'skip'
  const s = await engineJson(engine, '/agent/browser-extension').catch(() => null)
  const running: string[] = Array.isArray(s?.clients) ? s.clients.map((c: { version?: unknown }) => String(c.version || '')) : []
  if (!running.some((v) => v && older(v, bundled))) return 'skip'
  syncedFor = bundled
  if (existsSync(join(dst, 'manifest.json')) && 'error' in ensureClipCopy(src, dst, true)) return 'skip'
  await engineJson(engine, '/agent/browser-extension/reload-clients', 'POST').catch(() => null)
  return 'reloaded'
}

/** ponytail: 每 5 分钟问一次本机引擎(回环、很便宜)。Chrome 常常比 Forsion 晚开,只在启动时看会漏;真要省就改成引擎在扩展连上时推一声。 */
export function startClipVersionSync(engine: EngineRef): void {
  const tick = (): void => { void syncClipVersion(engine).catch(() => {}) }
  setTimeout(tick, 60_000).unref?.()
  setInterval(tick, 5 * 60_000).unref?.()
}

export function registerClipExtensionIpc(): void {
  ipcMain.handle('clipExt:prepare', (_e, update?: boolean) => ensureClipCopy(clipSourceDir(), clipCopyDir(), update === true))
  ipcMain.handle('clipExt:openChrome', () => openChromeExtensions())
}
