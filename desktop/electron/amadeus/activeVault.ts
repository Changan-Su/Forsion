/**
 * 在线库的宿主接缝(智库同步第 3 步 H3 12a;契约 step34「H3 接口定稿」第 2 节)。
 * - 渲染层:amadeus:active-vault:get / set、amadeus:active-vault:changed 广播、amadeus:open-online(主窗收)、
 *   amadeus:online-capable(主窗装好转发壳后发)、amadeus:open-online:result(主窗报失败);
 * - Extend:CloudHost.openLibrary / canOpenOnline。宿主不查服务器,ref 由 E3 用自己的库清单解析好。
 * 落盘在 settings.ts(readActiveVault / writeActiveVault);切本机库清 activeVault 在 amadeus/ipc.ts 的 switchLocalVault。
 * 依赖全由 main.ts 递进来(isTrustedSender、主窗、showMainWindow),这里不 import main。
 */
import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ActiveVaultRead, OnlineVaultRef } from '@amadeus-shared/ipc'
import { ACTIVE_VAULT_IPC } from './activeVaultKeys'
import { cloudAccountNamespace, migrateMirrorActiveVault, onActiveVaultCleared, parseOnlineVaultRef, readActiveVault, writeActiveVault } from './settings'
import { cloudVaultDir, isManagedCloudVault } from './cloudPaths'

export const OPEN_LIBRARY_TIMEOUT_MS = 30_000

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
export interface ActiveVaultDeps {
  isTrusted(e: Sender): boolean
  /** 主窗的 webContents;没有主窗 / 已销毁 = null。 */
  mainContents(): WebContents | null
  /** 显示并聚焦主窗(main.ts 的 showMainWindow)。 */
  focusMain(): void
  accountId(): string | null
  broadcast(channel: string, payload: unknown): void
  timeoutMs?: number
}
interface IpcLike {
  handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, fn: (e: IpcMainEvent, ...args: any[]) => void): void
}
interface Pending { ref: OnlineVaultRef; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const sameRef = (a: OnlineVaultRef, b: OnlineVaultRef): boolean =>
  a.account === b.account && a.libraryId === b.libraryId && a.vaultId === b.vaultId && a.prefix === b.prefix && a.name === b.name

export function createActiveVaultHost(deps: ActiveVaultDeps): {
  register(ipc: IpcLike): void
  get(): Promise<ActiveVaultRead>
  openLibrary(ref: OnlineVaultRef): Promise<void>
  canOpenOnline(): boolean
} {
  const timeoutMs = deps.timeoutMs ?? OPEN_LIBRARY_TIMEOUT_MS
  const pending = new Map<string, Pending>()
  let capable: WebContents | null = null
  const watched = new WeakSet<WebContents>()

  // 没登录时 cloudAccountNamespace(null) = 'signed-out',直接比会放过 account:'signed-out' 的 ref:先要有账号
  const accountOk = (ref: OnlineVaultRef): boolean => {
    const id = deps.accountId()
    return !!id && cloudAccountNamespace(id) === ref.account
  }
  const settle = (ref: OnlineVaultRef, error: Error | null): void => {
    for (const [id, p] of [...pending]) {
      if (!sameRef(p.ref, ref)) continue
      clearTimeout(p.timer)
      pending.delete(id)
      if (error) p.reject(error)
      else p.resolve()
    }
  }
  // 转发壳只活在那一个文档里:主框架换文档(重载)/ 渲染进程没了,都要等新页面重新报。
  // 主窗重建 / 销毁不用另听:canOpenOnline 比的是「报过的那个 wc === 现在的主窗 wc」
  const watch = (wc: WebContents): void => {
    if (watched.has(wc)) return
    watched.add(wc)
    const drop = (): void => { if (capable === wc) capable = null }
    wc.on('render-process-gone', drop)
    wc.on('did-start-navigation', (d: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (d?.isMainFrame && !d.isSameDocument) drop()
    })
  }

  const get = async (): Promise<ActiveVaultRead> => {
    const ref = await readActiveVault() // 读不了 / 形状不对 → 抛,渲染层按「不知道」开 lastVault
    if (!ref) return { ref: null, fallback: null }
    return accountOk(ref) ? { ref, fallback: null } : { ref: null, fallback: { reason: 'account', name: ref.name } }
  }

  const set = async (e: IpcMainInvokeEvent, raw: unknown): Promise<void> => {
    if (!deps.isTrusted(e)) throw new Error('forbidden')
    const ref = raw === null ? null : parseOnlineVaultRef(raw)
    if (raw !== null && !ref) throw new Error('invalid_ref')
    const fromMain = !!ref && e.sender === deps.mainContents()
    const assertAccount = (): void => { if (ref && !accountOk(ref)) throw new Error('account_changed') }
    try {
      assertAccount()
      await writeActiveVault(ref, assertAccount)
    } catch (err) {
      // 主窗正为 openLibrary 换库、这一写失败:等着的那次当场失败,不干等 30 秒
      if (fromMain) settle(ref!, new Error((err as Error)?.message === 'account_changed' ? 'account_changed' : 'switch_failed'))
      throw err
    }
    deps.broadcast(ACTIVE_VAULT_IPC.changed, { ref })
    if (fromMain) settle(ref!, null)
  }

  return {
    register(ipc) {
      // 普通配置写改了 lastVault(Extend 的胶囊切本机等)顺带清掉了在线库:照样告诉各窗口
      onActiveVaultCleared(() => deps.broadcast(ACTIVE_VAULT_IPC.changed, { ref: null }))
      ipc.handle(ACTIVE_VAULT_IPC.get, async (e) => {
        if (!deps.isTrusted(e)) throw new Error('forbidden')
        return get()
      })
      ipc.handle(ACTIVE_VAULT_IPC.set, (e, raw: unknown) => set(e, raw))
      ipc.on(ACTIVE_VAULT_IPC.onlineCapable, (e) => {
        if (!deps.isTrusted(e) || !e.senderFrame) return // senderFrame 为空 = 旧文档导航后才到的迟到上报
        const wc = deps.mainContents()
        if (!wc || e.sender !== wc) return // 只认主窗
        watch(wc)
        capable = wc
      })
      ipc.on(ACTIVE_VAULT_IPC.openOnlineResult, (e, r: unknown) => {
        if (!deps.isTrusted(e) || e.sender !== deps.mainContents()) return
        const o = r as { requestId?: unknown; ok?: unknown } | null
        if (!o || typeof o.requestId !== 'string' || o.ok !== false) return // 成功只认 set
        const p = pending.get(o.requestId)
        if (!p) return
        clearTimeout(p.timer)
        pending.delete(o.requestId)
        p.reject(new Error('switch_failed')) // 渲染层的 code 不往外带,固定码
      })
    },
    get,
    async openLibrary(raw) {
      const ref = parseOnlineVaultRef(raw)
      if (!ref) throw new Error('invalid_ref')
      if (!accountOk(ref)) throw new Error('account_changed')
      const wc = deps.mainContents()
      if (!wc) throw new Error('no_main_window')
      if (capable !== wc) throw new Error('renderer_unsupported')
      deps.focusMain()
      const requestId = randomUUID()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('switch_timeout'))
        }, timeoutMs)
        pending.set(requestId, { ref, resolve, reject, timer })
        try { wc.send(ACTIVE_VAULT_IPC.openOnline, { ref, requestId }) } catch {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(new Error('no_main_window'))
        }
      })
    },
    canOpenOnline() {
      const wc = deps.mainContents()
      return !!wc && capable === wc
    },
  }
}

/** 老配置迁移(lastVault = 这个账号的云镜像 → activeVault = 默认库)。 */
export function migrateLegacyMirrorVault(accountId: string | null): Promise<boolean> {
  return migrateMirrorActiveVault(accountId, (id) => cloudVaultDir(id), isManagedCloudVault)
}

/** 启动时跑不跑老配置迁移。U3a 装好转发壳、渲染层能按 activeVault 打开在线库的那个版本里改成 true。
 *  在那之前迁移会把停在云端那一侧的用户落到本机库(没人读 activeVault),所以先关着。 */
export const MIRROR_MIGRATION_ENABLED = false

/** 启动接线(main.ts 开窗之前 await):开关关着就什么都不做,不读不写配置。 */
export function migrateOnStartup(accountId: string | null, enabled: boolean = MIRROR_MIGRATION_ENABLED): Promise<boolean> {
  return enabled ? migrateLegacyMirrorVault(accountId) : Promise.resolve(false)
}
