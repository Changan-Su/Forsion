/**
 * preload 侧:Extend 实际注册的 IPC 通道集合(主进程开窗前答好 `cloud:present`)。三份 preload(tangu / amadeus / remotesync)共用,
 * 同步问一次即缓存 —— 窗口生命期内通道集合不变。没装载 Extend = 空集,各桥按「它的通道有人接」决定暴露与否。
 */
import { ipcRenderer } from 'electron'

let cached: Set<string> | null = null
export function cloudPresent(): Set<string> {
  if (!cached) {
    const raw: unknown = ipcRenderer.sendSync('cloud:present')
    cached = new Set<string>(Array.isArray(raw) ? (raw as string[]) : [])
  }
  return cached
}
