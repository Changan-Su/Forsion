/**
 * Amadeus 云同步 + collab 的宿主接缝(2026-09-28,Forsion Extend 0.4):引擎(主镜像 / 与我共享 / 按条目)、collab HTTP 面与
 * 11 个 amadeus:sync|entry-sync|collab 通道住在 Extend 的主进程半身;宿主留 vault / watcher / index、amadeus-config.json、云目录助手。
 * 装载分两拍:Extend 装载时(开窗前)把通道 handle 上并登记工厂;宿主在 registerAmadeusIpc 里 vault 建好后调工厂,递进这份 deps,
 * 拿回 { start, stopAllSync, restartAllSync }(登录态变化时由 accountCore 调)。Forsion-Extend 仓 src/desktop/host.d.ts 是它的镜像,两边同改。
 */
import type { AmadeusConfig } from './settings'

export type { AmadeusConfig }
export interface AmadeusActivatedRoot { root: string; pages: string[]; folders: string[]; lastPage?: string }

export interface AmadeusSyncHostDeps {
  // 凭据 / 身份 / 路径
  readCreds(): { cloudUrl: string; token: string }
  accountId(): string | null
  homeDir(): string
  workspaceDir(): string
  userDataDir(): string
  isDevMode(): boolean
  // 配置(宿主的写队列)
  readConfig(accountId?: string | null): Promise<AmadeusConfig>
  writeConfig(patch: Partial<AmadeusConfig>, accountId?: string | null): Promise<void>
  updateConfig(update: (config: AmadeusConfig) => boolean | void | Promise<boolean | void>, accountId?: string | null): Promise<AmadeusConfig>
  /** 收养 2.9.9 前无主绑定;renameShadow 由 Extend 提供(shadow 文件住在 Extend)。 */
  adoptLegacyCloudState(accountId: string | null, renameShadow: (from: string, to: string) => Promise<unknown>): Promise<boolean>
  // 云目录(与宿主 restoreVault / 远程同步根校验同一份实现:cloudPaths.ts)
  cloudVaultDir(accountId?: string | null): string
  isManagedCloudVault(root: string): boolean
  // vault 面(VaultManager / watcher / index)
  vaultRoot(): string | null
  setMutationHooks(
    onMutate: (rel: string, kind: 'write' | 'remove') => void,
    onMove: (from: string, to: string, kind?: 'file' | 'folder') => void | Promise<void>,
    onBeforeMove: (from: string, to: string) => (() => void) | undefined,
  ): void
  activateRoot(root: string, keepLastPage: boolean): Promise<AmadeusActivatedRoot>
  ensureDefaultVault(): Promise<AmadeusActivatedRoot>
  /** 渲染进程 ↔ 它当前绑定的根(switchSide 后登记,老根的迟到写会被 handle() 拒掉)。 */
  bindRenderer(senderId: number, root: string): void
  /** 等所有在飞的 vault 写对着原根落定(stopAllSync 挪根之前)。 */
  awaitPendingVaultWrites(): Promise<void>
  relatedClosure(rootRel: string, kind: 'page' | 'folder'): Promise<unknown>
  /** 全部窗口 + Unit SSE 订阅者。 */
  notifyAll(channel: string, payload?: unknown): void
  /** app.once('before-quit', cb);返回退订。 */
  onBeforeQuit(cb: () => void): () => void
  log(message: string): void
}
export interface AmadeusSyncInstance {
  /** 启动即拉起主镜像 + 共享 + 按条目引擎(未登录 / 显式停用时安静待命)。 */
  start(): void
  stopAllSync(): Promise<void>
  restartAllSync(): Promise<void>
}
export type AmadeusSyncFactory = (deps: AmadeusSyncHostDeps) => AmadeusSyncInstance
