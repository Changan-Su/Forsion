/**
 * 电脑历史的读写与开关逻辑,设置页(ComputerHistorySettings)和首次引导(OnboardingComputerHistory)共用这一份。
 * 落盘 / 保留 / 清除 / 暂停 / 连 helper 全在主进程(electron/computerHistory.ts),这里经 window.tangu.computerHistory
 * (shared/computerHistory.ts 的 ComputerHistoryApi)读写,每个写操作回最新 View 直接替换。
 * 状态实时性:onChanged 推送 + 窗口回到前台时 get() 一次(从系统设置授权回来,不必等主进程的重试)。
 * 三路来的 View(get 回包 / 写操作结果 / 推送)一律按主进程的 rev 取最新:旧的 get() 回包晚到不能把新推送盖回去。
 * ⚠️ 主进程的 get() 在失败态会立刻重连(连不上就拉起 helper)。权限卡正在「更新并重启助手」时别触发它:
 * 旧助手 shutdown 到新字节落盘之间一重连,就会把旧版拉起来占住 socket,新版随即作为多余实例退出。
 * 所以同屏的每一张 DesktopPermissions 都要把 onBusyChange 接到这里的 onPermissionBusy(引导里「操作电脑」那一页也算)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerHistoryApi, ComputerHistoryView } from '../../../shared/computerHistory'
import { ipcErrorText } from '../ipcError'
import { isSupportedPlatform } from './computerHistoryModel'

/** 本端有主进程 API 才列这一页(不支持的平台也列,页内写「目前仅支持 macOS 和 Windows」);云端 Web / 移动端 / 设备页没有。 */
export function computerHistoryApi(): ComputerHistoryApi | undefined {
  const tangu = window.tangu
  if (!tangu || tangu.cloudWeb || tangu.mobile || tangu.unitPage) return undefined
  return typeof tangu.computerHistory?.get === 'function' ? tangu.computerHistory : undefined
}

export function useComputerHistory() {
  const api = computerHistoryApi()
  const hostPlatform = window.tangu?.platform
  const [view, setView] = useState<ComputerHistoryView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 从关到开先确认(复述同意说明要点):不能一点就开录。 */
  const [confirmEnable, setConfirmEnable] = useState(false)
  /** 权限卡正在授权 / 安装 / 更新助手:期间不因回到前台去 get()(见文件头 ⚠️),卡片也别因状态跳变被卸掉。 */
  const [permissionBusy, setPermissionBusy] = useState(false)
  const permissionBusyRef = useRef(false)
  /** 状态行「刷新状态」:重读电脑历史状态 + 让权限卡重读快照(卡自己的工具条在嵌入时不画)。 */
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const [permissionRefresh, setPermissionRefresh] = useState(0)
  const alive = useRef(true)
  const busyRef = useRef<string | null>(null)
  /** 手上 View 的 rev:只收更大的(见文件头)。 */
  const revRef = useRef(-Infinity)
  // 平台已知不支持(不是 darwin / win32)就不去读(主进程那边只会回 unsupported)。
  const hostUnsupported = !!hostPlatform && !isSupportedPlatform(hostPlatform)

  /** 收一份 View:比手上的旧(或一样)就丢。 */
  const accept = useCallback((next: ComputerHistoryView): void => {
    if (!alive.current || next.rev <= revRef.current) return
    revRef.current = next.rev
    setView(next)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const next = await api.get()
      if (!alive.current) return
      accept(next)
      setLoadError(null)
    } catch (error) {
      if (alive.current) setLoadError(ipcErrorText(error))
    }
  }, [api, accept])

  const onPermissionBusy = useCallback((next: boolean): void => {
    const was = permissionBusyRef.current
    permissionBusyRef.current = next
    if (!alive.current) return
    setPermissionBusy(next)
    // 动作结束(新助手已起,或用户选了「稍后设置」)→ 现在再读一次,让主进程按新情况立即重连。
    if (was && !next) void load()
  }, [load])

  useEffect(() => {
    alive.current = true
    if (!api || hostUnsupported) return
    void load()
    const off = api.onChanged(accept)
    const refreshVisible = (): void => { if (document.visibilityState === 'visible' && !permissionBusyRef.current) void load() }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      alive.current = false
      off()
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [api, hostUnsupported, load, accept])

  /** 写操作统一入口:同一时刻只跑一个(ref 防连点),成功用回来的 View 替换,失败就地报。 */
  const act = async (key: string, run: (a: ComputerHistoryApi) => Promise<ComputerHistoryView>): Promise<boolean> => {
    if (!api || busyRef.current) return false
    busyRef.current = key
    setBusy(key)
    setActionError(null)
    try {
      accept(await run(api))
      return true
    } catch (error) {
      if (alive.current) setActionError(ipcErrorText(error))
      return false
    } finally {
      busyRef.current = null
      if (alive.current) setBusy(null)
    }
  }

  const toggleEnabled = (on: boolean): void => {
    if (on && !view?.state.enabled) { setConfirmEnable(true); return }
    setConfirmEnable(false)
    void act('enable', (a) => a.setEnabled(on))
  }
  const enable = async (): Promise<void> => {
    if (await act('enable', (a) => a.setEnabled(true))) setConfirmEnable(false)
  }
  /** 刷新状态:get() 在失败态会让主进程立刻重连 —— 助手更新 / 重启进行中不许点(见文件头 ⚠️)。 */
  const refreshStatus = async (): Promise<void> => {
    if (permissionBusyRef.current) return
    setPermissionRefresh((n) => n + 1)
    setStatusRefreshing(true)
    try { await load() } finally { if (alive.current) setStatusRefreshing(false) }
  }

  return {
    api, view, loadError, busy, actionError, setActionError, alive, load, act,
    /** 这台电脑没有采集端:平台不对,或主进程回了 unsupported。 */
    unsupported: hostUnsupported || view?.state.status === 'unsupported' || (!!view && !isSupportedPlatform(view.state.platform)),
    hostUnsupported,
    confirmEnable, setConfirmEnable, toggleEnabled, enable,
    permissionBusy, permissionBusyRef, onPermissionBusy,
    statusRefreshing, permissionRefresh, refreshStatus,
  }
}
export type ComputerHistoryHandle = ReturnType<typeof useComputerHistory>
