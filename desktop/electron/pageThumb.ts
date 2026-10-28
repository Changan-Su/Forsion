/**
 * 网页卡片的缩略图(网页卡片方案 A + D、第二轮 1,10-28):主进程开一个不显示的窗口加载 http(s) 页面、截一张,按 url + version 缓存。
 * 为什么在主进程:线上 Connect 页面全站带 X-Frame-Options: SAMEORIGIN,渲染层 iframe 嵌不进来;本机令牌根 / localhost 一并走这里。
 * 窗口:没有 preload、沙箱、独立的非持久分区(不带内置浏览器里的登录态)、静音、不许弹窗、不许跳到 http(s) 以外。
 * 插件和宿主同在一个渲染进程,window.tangu 对插件本来可见,所以这里只把关「是不是 http(s)」,不按来源区分。
 * ponytail: 内存缓存 60 张、同时最多 2 个、排队最多 8 个、单张 10 秒;要跨重启再落盘。
 * 能拍 localhost:渲染层插件本来就拿得到 window.tangu(读本机文件都行),这里不比它多给。
 */
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron'

const MAX_CACHE = 60
const MAX_RUNNING = 2
const MAX_WAITING = 8 // 排不上的直接回 null(卡上画占位图标),别让一堆请求攒着
const TIMEOUT_MS = 10_000
const SETTLE_MS = 700 // 首帧之后等字体 / 图片落定
const OUT_W = 480

export type PageThumb = { dataUrl: string; title: string } | null

export function thumbUrlAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return false
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

let running = 0
const waiting: (() => void)[] = []
async function slot(): Promise<(() => void) | null> {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) return null
    await new Promise<void>((r) => waiting.push(r))
  }
  running++
  return () => { running--; waiting.shift()?.() }
}

async function shoot(url: string): Promise<PageThumb> {
  const release = await slot()
  if (!release) return null
  denyPermissions()
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'pagethumb', backgroundThrottling: false },
  })
  try {
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e, to) => { if (!thumbUrlAllowed(to)) e.preventDefault() })
    const loaded = await Promise.race([
      win.loadURL(url).then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), TIMEOUT_MS)),
    ])
    if (!loaded || win.isDestroyed()) return null
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    if (win.isDestroyed()) return null
    const img = await win.webContents.capturePage()
    if (img.isEmpty()) return null
    const title = win.webContents.getTitle()
    return {
      dataUrl: `data:image/jpeg;base64,${img.resize({ width: OUT_W, quality: 'good' }).toJPEG(80).toString('base64')}`,
      // 没有 <title> 时 Chromium 回的是地址本身:那不算标题
      title: title && title !== url && !/^https?:\/\//.test(title) ? title : '',
    }
  } catch {
    return null
  } finally {
    if (!win.isDestroyed()) win.destroy()
    release()
  }
}

let denied = false
/** 截图窗口里的页面一律拿不到麦克风 / 摄像头 / 定位 / 通知这些权限(Electron 缺省是放行)。 */
function denyPermissions(): void {
  if (denied) return
  denied = true
  const ses = session.fromPartition('pagethumb')
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

const cache = new Map<string, Promise<PageThumb>>()

/** 同一 url + version 只拍一次(在途的也复用);拍失败不留缓存,下次再试。 */
export function pageThumb(url: string, version = ''): Promise<PageThumb> {
  const key = `${version}\n${url}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit } // 挪到最新
  const p = shoot(url).then((r) => { if (!r) cache.delete(key); return r })
  cache.set(key, p)
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!)
  return p
}

export function registerPageThumbIpc(isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('pageThumb:capture', (e, url: unknown, version: unknown) => {
    if (!isTrusted(e)) throw new Error('forbidden')
    if (!thumbUrlAllowed(url)) return null
    return pageThumb(url, typeof version === 'string' ? version.slice(0, 200) : '')
  })
}
