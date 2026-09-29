/**
 * window.tangu.remoteSessions 的门控(P1 · K4):只有执行设备本机(桌面主窗,带主进程 API)有;
 * 云端 Web / 移动端 / 设备页一律没有 —— 开关、信任、审批档上限只能在本机改(方案 §6.1)。
 * 独立成小模块:设备切换器用它不必把整张设置页拖进来。
 */
import type { RemoteSessionsApi } from '../../../shared/remoteSessions'

export function remoteSessionsApi(): RemoteSessionsApi | undefined {
  const tangu = window.tangu
  if (!tangu || tangu.cloudWeb || tangu.mobile || tangu.unitPage) return undefined
  return typeof tangu.remoteSessions?.get === 'function' ? tangu.remoteSessions : undefined
}
