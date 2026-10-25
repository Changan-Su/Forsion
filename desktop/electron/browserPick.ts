/**
 * 内置浏览器「点选元素发进对话」的主进程半边。安全边界与契约见 shared/browserPick.ts 文件头:
 * 点选脚本由这里注入 guest 的独立 JS 世界,guest 的唯一回路是那次注入的返回值;guest 本身没有 preload、没有 IPC。
 *
 * 渲染层只能对**自己宿主的** <webview> guest 发起(guest.hostWebContents === 发送者),不能拿个 id 去注入别的窗口 / 别的 webContents。
 */
import { BrowserWindow, ipcMain, screen, session, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { BROWSER_PARTITION } from '../shared/browser'
import { PICK_WORLD_ID, pickControlSource, pickerSource, sanitizePick, type PickResponse } from '../shared/browserPick'

/** 截图最长边(超了等比缩)。整块 hero 区按 2× 截出来动辄几 MB,输入框附件上限 5 MB。 */
const SHOT_MAX = 1600

/** 每个 guest 至多一场进行中的点选:id → 让它以「取消」收场。 */
const active = new Map<number, () => void>()

/** 发送者自己宿主的内置浏览器 guest;不是就 null。 */
function ownGuest(e: IpcMainInvokeEvent, raw: unknown): WebContents | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  const guest = webContents.fromId(raw)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
  if (guest.hostWebContents !== e.sender) return null
  if (guest.session !== session.fromPartition(BROWSER_PARTITION)) return null
  return guest
}

async function shoot(guest: WebContents, pick: NonNullable<ReturnType<typeof sanitizePick>>): Promise<PickResponse['image']> {
  if (pick.rect.w < 1 || pick.rect.h < 1) return null
  // capturePage(rect) 收的是 guest 视图的 DIP。CSS 像素 → DIP 的比例不去猜缩放链(页面缩放、宿主 body 上的 CSS zoom
  // 传不传给 guest 都说不准),拿整页截图自校准:那张是物理像素,除以所在屏的缩放比 = DIP 宽。
  // ⚠️ 别把整页的 getSize() 直接当 DIP 用:Retina 上会截出两倍大的一块(台架 P6b 第一轮实测)。
  const whole = await guest.capturePage()
  const px = whole.getSize()
  const hostWin = guest.hostWebContents ? BrowserWindow.fromWebContents(guest.hostWebContents) : null
  const sf = hostWin ? screen.getDisplayMatching(hostWin.getBounds()).scaleFactor : screen.getPrimaryDisplay().scaleFactor
  if (!px.width || !px.height || !sf) return null
  const kx = px.width / sf / pick.vw, ky = px.height / sf / pick.vh
  const view = { width: Math.round(px.width / sf), height: Math.round(px.height / sf) }
  const rect = {
    x: Math.floor(pick.rect.x * kx), y: Math.floor(pick.rect.y * ky),
    width: Math.max(1, Math.ceil(pick.rect.w * kx)), height: Math.max(1, Math.ceil(pick.rect.h * ky)),
  }
  rect.width = Math.min(rect.width, view.width - rect.x)
  rect.height = Math.min(rect.height, view.height - rect.y)
  if (rect.width < 1 || rect.height < 1) return null
  let img = await guest.capturePage(rect)
  if (img.isEmpty()) return null
  const s = img.getSize()
  const long = Math.max(s.width, s.height)
  if (long > SHOT_MAX) img = img.resize(s.width >= s.height ? { width: SHOT_MAX } : { height: SHOT_MAX })
  const png = img.toPNG()
  const final = img.getSize()
  // 界面截图 PNG 最清楚;照片类大块超过 1.5 MB 就换 JPEG
  if (png.length <= 1_500_000) return { mimeType: 'image/png', data: png.toString('base64'), width: final.width, height: final.height }
  return { mimeType: 'image/jpeg', data: img.toJPEG(82).toString('base64'), width: final.width, height: final.height }
}

/** 一场点选:从注入到截完图,导航 / 销毁 / 取消守卫一直挂着(截图途中页面跳走,也不能把 A 页的元素配上 B 页的图,Codex P2)。
 *  result 在点下 / 取消时兑现;stale() = 这场已作废;release() 收掉监听。 */
interface PickRun { result: Promise<unknown>; stale: () => boolean; release: () => void }

function startPick(guest: WebContents): PickRun {
  const id = guest.id
  active.get(id)?.()
  let dead = false
  let settle: (v: unknown) => void = () => {}
  const result = new Promise<unknown>((r) => { settle = r })
  // 作废:guest 里那场也收掉(导航被中止时旧文档还在,不收的话罩子和监听留在页面上,Codex P2)
  const cancel = (): void => {
    if (dead) return
    dead = true
    if (!guest.isDestroyed()) void guest.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: pickControlSource('cancel') }]).catch(() => {})
    settle(null)
  }
  const onNav = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
    if (details?.isMainFrame !== false && !details?.isSameDocument) cancel()
  }
  const onGone = (): void => { dead = true; settle(null) }
  const release = (): void => {
    guest.removeListener('did-start-navigation', onNav)
    guest.removeListener('destroyed', onGone)
    guest.removeListener('render-process-gone', onGone)
    if (active.get(id) === cancel) active.delete(id)
  }
  active.set(id, cancel)
  guest.on('did-start-navigation', onNav)
  guest.once('destroyed', onGone)
  guest.once('render-process-gone', onGone)
  guest.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: pickerSource() }]).then((v) => settle(v), () => settle(null))
  return { result, stale: () => dead || guest.isDestroyed(), release }
}

export function registerBrowserPickIpc(isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('browserPick:start', async (e, raw: unknown): Promise<PickResponse> => {
    if (!isTrusted(e)) return { ok: false, error: 'untrusted' }
    const guest = ownGuest(e, raw)
    if (!guest) return { ok: false, error: 'no-guest' }
    const run = startPick(guest)
    try {
      const picked = sanitizePick(await run.result)
      if (!picked || run.stale()) return { ok: true, cancelled: true }
      // 同文档换 hash / pushState 不打断点选,URL 取点下这一刻的;跨文档跳转会让 run 作废
      const url = guest.getURL()
      const title = guest.getTitle().slice(0, 200)
      const image = await shoot(guest, picked).catch(() => null)
      if (run.stale()) return { ok: true, cancelled: true }
      return { ok: true, pick: { ...picked, url, title }, image }
    } finally {
      run.release()
    }
  })
  ipcMain.handle('browserPick:control', async (e, raw: unknown, action: unknown): Promise<boolean> => {
    if (!isTrusted(e)) return false
    const guest = ownGuest(e, raw)
    if (!guest || !active.has(guest.id)) return false
    if (action === 'cancel') { active.get(guest.id)?.(); return true }
    if (action === 'parent') {
      return guest.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: pickControlSource('parent') }]).then(() => true, () => false)
    }
    return false
  })
}
