/**
 * 急停 / 远程锁定的 IPC(设备能力 MCP 方案 P1 · K2 §3.8;R-01 改名 remoteSafety:*)。全部只收本机可信发送方(主窗 / 设置浮窗);
 * setHotkeyRecording:设置页录制新快捷键期间挂起全局热键(主进程另有 60s 兜底恢复,渲染层崩了也不会一直没有急停键)。
 * unitWeb 不转发 IPC,设备页 / web / 手机没有这组通道(preload 按 agentBackend 删键,渲染层 remoteSafetyApi 另按端门控)。
 * 事件 remoteSafety:changed 由 main 订阅 rs.onChange 广播。
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { RemoteSafety } from './remoteSafety'

export function registerRemoteSafetyIpc(
  ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void },
  rs: RemoteSafety,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
): void {
  const guard = (e: IpcMainInvokeEvent): void => { if (!isTrustedSender(e)) throw new Error('forbidden') }
  ipc.handle('remoteSafety:get', async (e) => { guard(e); return rs.state() })
  ipc.handle('remoteSafety:estop', async (e) => { guard(e); return rs.estop('settings') })
  ipc.handle('remoteSafety:unlock', async (e) => { guard(e); return rs.unlock() })
  ipc.handle('remoteSafety:setHotkey', async (e, acc: unknown) => { guard(e); return rs.setHotkey(acc) })
  ipc.handle('remoteSafety:setHotkeyRecording', async (e, on: unknown) => { guard(e); rs.setHotkeyRecording(on === true) })
}
