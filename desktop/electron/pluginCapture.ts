import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { outputSize, sanitizeCaptureRequest, toDipRect, type CaptureRegionReply } from '../shared/pluginCapture'

/** 插件出图 / 录屏的主进程半边(ctx.ui.capture / record,2026-11-19)。归属判定在渲染层(只有它看得见 DOM),
 *  这里只抓「发请求那扇窗」自己的一块视口:不碰 desktopCapturer(要系统屏幕录制权限,且会和插件屏幕共享的
 *  一次性预选抢同一个 webContents 槽),不落盘。原生像素密度,不压尺寸 —— Desk 那条 `ui:captureRect` 的 1024 上限不在这里。
 *  录屏没有主进程循环:渲染层按帧率逐帧要 bgra 位图,窗口关了 / 重载了循环自然就停。 */
export function installPluginCapture(trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('ui:captureRegion', async (event, raw: unknown): Promise<CaptureRegionReply> => {
    if (!trusted(event)) return { ok: false, code: 'untrusted' }
    const req = sanitizeCaptureRequest(raw)
    if (!req) return { ok: false, code: 'bad-request' }
    const sender = event.sender
    const win = BrowserWindow.fromWebContents(sender)
    // 最小化 / 隐藏的窗口 capturePage 给空图或旧帧:明说,别交一张假图
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return { ok: false, code: 'window-hidden' }
    const [width, height] = win.getContentSize()
    const rect = toDipRect(req.rect, sender.getZoomFactor(), { width, height })
    if (!rect) return { ok: false, code: 'failed' }
    try {
      let img = await sender.capturePage(rect)
      if (img.isEmpty()) return { ok: false, code: 'failed' }
      const native = img.getSize()
      if (req.format === 'bgra') {
        // 录屏画幅比原生小(scale < 原生密度、或塞进 4K 框)时先缩:序列化 / 跨进程搬的是缩后的位图
        // 只差一两像素(奇数宽、小数尺寸、125% / 150% 缩放)不缩:渲染层 drawImage 顺手吸收,省得每帧在主线程 resize
        if (req.size && (req.size.width < native.width - 2 || req.size.height < native.height - 2)) img = img.resize({ ...req.size, quality: 'good' })
        const out = img.getSize()
        const data = img.toBitmap()
        // 紧排 BGRA 才能直接当 VideoFrame 用;有行填充(没见过)就算失败,不交一帧错位的画面
        if (data.length !== out.width * out.height * 4) return { ok: false, code: 'failed' }
        return { ok: true, data, width: out.width, height: out.height }
      }
      const size = outputSize(native, req.rect, req.scale)
      if (size.width !== native.width || size.height !== native.height) img = img.resize({ ...size, quality: 'best' })
      const out = img.getSize()
      return { ok: true, data: img.toPNG(), width: out.width, height: out.height }
    } catch {
      return { ok: false, code: 'failed' }
    }
  })
}
