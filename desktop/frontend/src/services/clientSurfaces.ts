/**
 * 客户端能力面(client surface)注册表 —— 引擎发来的 `client_cmd` 由哪个端上的执行者接手。
 * 契约见 tangu-agent/docs/phone-control.md §5。
 *
 * 为什么是注册表而不是 `window.tangu?.X` 门控:能力面只有移动端注册(`mobile/src/phoneControl.ts`),
 * desktop/web 什么都不注册 → startRun 发 `client_capabilities: []`、`client_cmd` 在 appStore 里
 * 找不到 surface 就丢弃。共享渲染层里不出现任何平台判断,也就不给 check:parity 添新门控。
 *
 * ⚠️ `exec` 只做转交,**JS 不回执**:回执(claim / result)由原生自己发,token 与 apiBase 也由原生
 *    自取。JS 在这条链上只是一个不受信的搬运工(Capacitor 桥对主 frame 的任意脚本可见)。
 */
import type { ComponentType } from 'react'

export interface ClientSurface {
  /** 本端当前能声明的能力(同步;移动端读原生 status 的缓存)。 */
  capabilities(): string[]
  /** 转交一条 client_cmd。body 是引擎签发的原样 JSON 字符串,原生据此 claim。 */
  exec(req: { runId: string; ackId: string; body: string }): void | Promise<void>
  /** run 终结(尽力而为:登出 / reload / 进程被杀都不会走到这里)。 */
  onRunEnd?(runId: string): void
  /** 登出 / 鉴权重置 —— 那条路径不走 endRun。 */
  onReset?(): void
  /** 设置 → 高级 页里渲染的一行。 */
  SettingsRow?: ComponentType
}

const surfaces = new Map<string, ClientSurface>()

/** 注册一个能力面;返回注销函数。同 ns 重复注册 = 后者覆盖(HMR 友好)。 */
export function registerClientSurface(ns: string, surface: ClientSurface): () => void {
  surfaces.set(ns, surface)
  return () => {
    if (surfaces.get(ns) === surface) surfaces.delete(ns)
  }
}

export function getClientSurface(ns: string): ClientSurface | undefined {
  return surfaces.get(ns)
}

export function listClientSurfaces(): Array<{ ns: string; surface: ClientSurface }> {
  return [...surfaces.entries()].map(([ns, surface]) => ({ ns, surface }))
}

/** startRun 请求体用:所有已注册面的能力并集(去重排序;单个面抛错不连累别的面)。 */
export function collectClientCapabilities(): string[] {
  const out = new Set<string>()
  for (const s of surfaces.values()) {
    try {
      for (const c of s.capabilities()) if (typeof c === 'string' && c) out.add(c)
    } catch { /* 该面不可用就不声明 */ }
  }
  return [...out].sort()
}

/** 广播给所有面(onRunEnd / onReset);单个面抛错不连累别的面。 */
export function notifyClientSurfaces(event: 'runEnd', runId: string): void
export function notifyClientSurfaces(event: 'reset'): void
export function notifyClientSurfaces(event: 'runEnd' | 'reset', runId?: string): void {
  for (const s of surfaces.values()) {
    try {
      if (event === 'runEnd' && runId) s.onRunEnd?.(runId)
      else if (event === 'reset') s.onReset?.()
    } catch { /* ignore */ }
  }
}

/** 仅测试用。 */
export function __resetClientSurfacesForTest(): void {
  surfaces.clear()
}
