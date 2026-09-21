/**
 * Forsion Sandbox 的**渲染层对外面**(2026-09-21):Coding Studio 的「在 Forsion 中运行」面板只认这一个文件。
 *
 * 沙箱是**开发态加载器,不是隔离边界** —— 开发副本跑在真应用、真笔记库里,权限与已安装插件完全相同。
 * 这里给的只有三件事:它现在什么状态(装没装上 / 激活没 / 被闸在哪 / 报了什么错)、它说了什么(console)、
 * 以及一次「重新加载」。
 *
 * 两条易踩的纪律:
 *  ① **热重载必须把预览标签页开回来**:teardown 会先关掉该插件全部视图的 leaf 再反注册(见 pluginViews 的
 *     closeLeafsOfType 注释),不记住就等于「每改一行代码,开发者正看着的预览就被关掉一次」;
 *  ② 工作台接口**不在这里 import**:本目录是插件宿主(平台中立,mobile / unit 也吃这份),`@lcl/engine` 由
 *     桌面壳在 syncPluginViews 里经 setDevViewBridge 注入 —— 与 pluginStore.setViewOpener 同款接缝纪律。
 */
import { useMemo } from 'react'
import { usePluginStore } from './pluginStore'
import { clearDevLogs, getDevRecord, useDevRecords, EMPTY_DEV_RECORD, type DevPluginRecord } from './devRecords'
import type { AmadeusPlugin } from './types'

/** 开发副本自己说的一行话(console 转发时按插件记的账)。 */
export interface DevPluginLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  at: number
}

/** 插件视图挂载失败一次。message 后面接着栈顶一帧(`new Function` 的帧名是 <anonymous>,给多了只是噪音)。 */
export interface DevPluginMountError {
  viewId: string
  message: string
  at: number
}

export interface DevPluginState {
  /** 插件宿主现在装着这个 id 的**开发态来源**。 */
  loaded: boolean
  /** setup 跑过且插件处于激活态。 */
  active: boolean
  /** 宿主给的闸码('dev-fileext' / 'invalid' / 'api' / 'minApp'),没被闸则 null。 */
  blocked: string | null
  blockedReason: string | null
  setupError: string | null
  mountErrors: DevPluginMountError[]
  logs: DevPluginLog[]
  /** 同 id 还存在一份**安装版**,正被开发副本遮蔽(撤下开发副本它就回来)。 */
  shadowsInstalled: boolean
}

/** 没有插件 id 时返回的定值:引用恒定,拿去做 deps / 比较都不会把面板抖成无限重渲。 */
const EMPTY_STATE: DevPluginState = Object.freeze({
  loaded: false,
  active: false,
  blocked: null,
  blockedReason: null,
  setupError: null,
  mountErrors: EMPTY_DEV_RECORD.mountErrors,
  logs: EMPTY_DEV_RECORD.logs,
  shadowsInstalled: false,
})

/** 记账(logs / mountErrors)**不随卸载清空**:让开发者撤下开发副本之后,还看得见当初把它逼下来的那条错。 */
function compose(plugin: AmadeusPlugin | undefined, active: boolean, setupError: string | undefined, record: DevPluginRecord | undefined): DevPluginState {
  const loaded = !!plugin?.dev
  const rec = record ?? EMPTY_DEV_RECORD
  return {
    loaded,
    active: loaded && active,
    blocked: loaded ? plugin!.blocked ?? null : null,
    blockedReason: loaded ? plugin!.blockedReason ?? null : null,
    setupError: loaded ? setupError || null : null,
    mountErrors: rec.mountErrors,
    logs: rec.logs,
    shadowsInstalled: loaded ? !!plugin!.shadowsInstalled : false,
  }
}

/** React 侧(zustand 选择器)。⚠️四个选择器各自返回**稳定引用**再 useMemo 合成 ——
 *  直接在一个选择器里 return {…} 会每次求值造新对象,zustand v5 当成「快照变了」→ 无限重渲。 */
export function useDevPluginState(pluginId: string | null | undefined): DevPluginState {
  const id = pluginId || ''
  const plugin = usePluginStore((s) => (id ? s.plugins.find((p) => p.id === id) : undefined))
  const active = usePluginStore((s) => (id ? s.activeIds.includes(id) : false))
  const setupError = usePluginStore((s) => (id ? s.lastSetupError[id] : undefined))
  const record = useDevRecords((s) => (id ? s.byId[id] : undefined))
  return useMemo(() => (id ? compose(plugin, active, setupError, record) : EMPTY_STATE), [id, plugin, active, setupError, record])
}

/** 非 React 读(命令、事件回调)。 */
export function getDevPluginState(pluginId: string): DevPluginState {
  if (!pluginId) return EMPTY_STATE
  const s = usePluginStore.getState()
  return compose(s.plugins.find((p) => p.id === pluginId), s.activeIds.includes(pluginId), s.lastSetupError[pluginId], getDevRecord(pluginId))
}

/** Studio 的「清空控制台」。挂载错误是故障史,不跟着清。 */
export function clearDevPluginLogs(pluginId: string): void {
  clearDevLogs(pluginId)
}

/** 工作台接缝(桌面壳注入,见文件头纪律②)。缺位(mobile / unit / 台架)时热重载照跑,只是不恢复标签页。 */
export interface DevViewBridge {
  /** 现在开着的、类型以 `prefix` 打头的视图(含收起侧栏里暂存的那些)。 */
  snapshot(prefix: string): Array<{ type: string; params: Record<string, unknown>; loc: 'main' | 'left' | 'right' }>
  /** 这个视图类型此刻还注册着吗(插件重载后可能已经不提供它了)。 */
  isRegistered(type: string): boolean
  open(type: string, params: Record<string, unknown>, loc: 'main' | 'left' | 'right'): void
  /** 记住现在的焦点,返回一个「放回去」的闭包(没有可记的返回 null)。重开的标签页会自动前置,
   *  不还回去的话每次热重载都把开发者从 Studio 抢到预览上。 */
  captureFocus?(): (() => void) | null
}

let bridge: DevViewBridge | null = null
export function setDevViewBridge(next: DevViewBridge | null): void { bridge = next }

/**
 * 重新加载一个开发副本,并把开发者正开着的预览标签页开回来。
 * 对「从没装过的 id」(第一次打开开关)与「刚被撤下的 id」都安全:reloadOne 自己处理来源缺失。
 *
 * ⚠️重载**后**要再拍一次快照:收起侧栏里的视图存在 stash 里,不是活 leaf —— teardown 的 closeViewsOfType
 * 碰不到它们,重载后它们自己就回来了。不比对就会给它们在主区再开一份(重复标签页,还挪了位置)。
 */
export async function reloadDevPlugin(pluginId: string): Promise<void> {
  if (!pluginId) return
  const prefix = `plugin:${pluginId}:`
  const before = bridge ? bridge.snapshot(prefix) : []
  const restoreFocus = bridge?.captureFocus?.() ?? null
  await usePluginStore.getState().reloadOne(pluginId)
  if (!bridge || !before.length) return
  const stillOpen = new Set(bridge.snapshot(prefix).map((v) => v.type))
  for (const view of before) {
    if (stillOpen.has(view.type)) continue // 压根没被关掉(stash 里的)→ 再开就是开重
    if (!bridge.isRegistered(view.type)) continue // 新版本不再提供这个视图 → 开不出来,别去撞注册表
    try { bridge.open(view.type, view.params, view.loc) } catch (e) { console.warn(`[dev-sandbox] 恢复视图 ${view.type} 失败`, e) }
  }
  try { restoreFocus?.() } catch (e) { console.warn('[dev-sandbox] 恢复焦点失败', e) }
}
