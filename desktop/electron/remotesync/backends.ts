/**
 * 远程同步的**外置后端注册点**(2026-09-28,Forsion Extend 第三刀):Forsion 云端后端(penzor)搬进 Extend 主进程半身,
 * 宿主只留 folder / S3 / WebDAV / Dropbox。Extend 装载时(cloudHost.ts,早于 registerRemoteSync)按 kind 注册一个工厂,
 * remotesyncIpc 的 buildRemote 遇到不认识的 backend 就来这里查;`remotesync:get` 把已注册的 kind 报给渲染层,
 * RemoteSyncSection 据此显示 / 隐藏对应选项 —— 没装 Extend 就没有「Forsion 云端」这一项。
 *
 * 隔离约定(同目录 README):不 import electron。
 */
import type { RemoteFs } from './types'

export interface BuiltRemote {
  remote: RemoteFs
  /** 基线指纹(改一个字节 = 基线作废、按首次合流走),由后端自己拼。 */
  fingerprint: string
  /** 后端硬上限(字节):用户单文件上限会被夹到它之下(缺省 / 0 = 无硬上限)。 */
  maxFileBytes?: number
}
/** 工厂拿到的是配置里该后端自己那一段(如 cfg.penzor),可能为 undefined。 */
export type RemoteBackendFactory = (section: unknown) => Promise<BuiltRemote | { error: string }>

const factories = new Map<string, RemoteBackendFactory>()

/** 同 kind 重复注册以后者为准(Extend 只装一次,这里不会发生;测试里会)。 */
export function registerRemoteSyncBackend(kind: string, factory: RemoteBackendFactory): void {
  factories.set(kind, factory)
}
export const extraBackend = (kind: string): RemoteBackendFactory | undefined => factories.get(kind)
export const extraBackendKinds = (): string[] => [...factories.keys()]
/** 测试用。 */
export const clearRemoteSyncBackends = (): void => { factories.clear() }

/** 用户单文件上限(字节;0 = 不限)夹到后端硬上限之下:用户不限 → 取硬上限;否则取二者较小。 */
export function clampMaxFile(userBytes: number, cap?: number): number {
  if (!cap) return userBytes
  return userBytes === 0 ? cap : Math.min(userBytes, cap)
}
