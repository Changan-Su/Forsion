/**
 * 在线库的宿主接缝(智库同步第 3 步 H3 12a;契约 step34「H3 接口定稿」第 2 节)。
 * - 渲染层:amadeus:active-vault:get / set、amadeus:active-vault:changed 广播、amadeus:open-online(主窗收)、
 *   amadeus:online-capable(主窗装好转发壳后发)、amadeus:open-online:result(主窗报失败)、
 *   amadeus:online-opened(主窗报转发壳实际换好的库,U3a)、amadeus:active-vault:migrate(主窗按需迁老镜像配置,U3a);
 * - 插件数据(pluginStorage.ts):「在线」只认 online-opened 的报告(currentOnlineRoot),不看盘上的 activeVault ——
 *   离线 / 账号回落时盘上那条还在,渲染层开的却是 lastVault 那个本机库。
 * - Extend:CloudHost.openLibrary / canOpenOnline。宿主不查服务器,ref 由 E3 用自己的库清单解析好。
 * 落盘在 settings.ts(readActiveVault / writeActiveVault);切本机库清 activeVault 在 amadeus/ipc.ts 的 switchLocalVault。
 * 依赖全由 main.ts 递进来(isTrustedSender、主窗、showMainWindow),这里不 import main。
 */
import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ActiveVaultRead, OnlineVaultRef } from '@amadeus-shared/ipc'
import { ACTIVE_VAULT_IPC } from './activeVaultKeys'
import { onlineVaultRoot } from '@amadeus-shared/ipc'
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
/** 一次 openLibrary:绑定发请求时的主窗和它的文档代次(主框架换了文档就作废)。 */
interface Pending { ref: OnlineVaultRef; wc: WebContents; gen: number; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const sameRef = (a: OnlineVaultRef, b: OnlineVaultRef): boolean =>
  a.account === b.account && a.libraryId === b.libraryId && a.vaultId === b.vaultId && a.prefix === b.prefix && a.name === b.name

export interface ActiveVaultHost {
  register(ipc: IpcLike): void
  get(): Promise<ActiveVaultRead>
  openLibrary(ref: OnlineVaultRef): Promise<void>
  canOpenOnline(): boolean
  /** 主窗当前文档报的「转发壳换好的在线库」;本机库 / 没报过 / 换了文档 / 主窗换了 / 账号对不上 = null。 */
  onlineOpened(): OnlineVaultRef | null
}

/** 接上 ipcMain 的那一个宿主(main.ts 只建一个);currentOnlineOpened 读它。 */
let registered: ActiveVaultHost | null = null
/** 测试用:换掉 / 清掉模块级读数指向的宿主。 */
export function setRegisteredActiveVaultHostForTest(host: ActiveVaultHost | null): void { registered = host }
/** 主窗渲染层实际打开的在线库(见 ActiveVaultHost.onlineOpened);宿主没注册 = null。 */
export function currentOnlineOpened(): OnlineVaultRef | null { return registered?.onlineOpened() ?? null }
/** pluginStorage 的 onlineRoot:在线库的根身份 `cloud://<vaultId>/<libraryId>`,本机库 = null。只认渲染层的报告,不读盘。 */
export function currentOnlineRoot(): string | null {
  const ref = currentOnlineOpened()
  return ref ? onlineVaultRoot(ref) : null
}

export function createActiveVaultHost(deps: ActiveVaultDeps): ActiveVaultHost {
  const timeoutMs = deps.timeoutMs ?? OPEN_LIBRARY_TIMEOUT_MS
  const pending = new Map<string, Pending>()
  let capable: WebContents | null = null
  /** 主窗某份文档报过的「换好了」:绑那个 wc 和它当时的文档代次,换文档 / 渲染进程没了就作废。 */
  let opened: { wc: WebContents; gen: number; ref: OnlineVaultRef | null } | null = null
  const watched = new WeakSet<WebContents>()
  const docGen = new WeakMap<WebContents, number>() // 主框架每换一次文档 +1
  const genOf = (wc: WebContents): number => docGen.get(wc) ?? 0

  // 这几个新入口只认「可信 + 发送帧还在 + 就是这个 wc 现在的顶层文档」:isTrustedSender 放过 senderFrame 为 null(迟到的旧文档消息),这里不放
  const liveTop = (e: Sender): boolean => deps.isTrusted(e) && !!e.senderFrame && e.senderFrame === e.sender.mainFrame
  /** 只认主窗的当前顶层文档(online-opened / migrate)。 */
  const mainTop = (e: Sender): WebContents | null => {
    const wc = deps.mainContents()
    return liveTop(e) && !!wc && e.sender === wc ? wc : null
  }

  // 没登录时 cloudAccountNamespace(null) = 'signed-out',直接比会放过 account:'signed-out' 的 ref:先要有账号
  const accountOk = (ref: OnlineVaultRef): boolean => {
    const id = deps.accountId()
    return !!id && cloudAccountNamespace(id) === ref.account
  }
  const finish = (requestId: string, error: Error | null): void => {
    const p = pending.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(requestId)
    if (error) p.reject(error)
    else p.resolve()
  }
  // 转发壳只活在那一个文档里:主框架换文档(重载)/ 渲染进程没了,都要等新页面重新报。
  // 主窗重建 / 销毁不用另听:canOpenOnline 比的是「报过的那个 wc === 现在的主窗 wc」
  const watch = (wc: WebContents): void => {
    if (watched.has(wc)) return
    watched.add(wc)
    const drop = (): void => {
      docGen.set(wc, genOf(wc) + 1)
      if (capable === wc) capable = null
      if (opened?.wc === wc) opened = null // 新文档的转发壳还没换库:当本机,等它自己再报
      // 发请求时那份文档没了:等着的那次当场失败(新文档不认得旧 requestId)
      for (const [id, p] of [...pending]) if (p.wc === wc) finish(id, new Error('switch_failed'))
    }
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

  /** requestId = 渲染层收到 amadeus:open-online 时拿到的那个;不带 = 普通的切换,不确认任何 openLibrary。 */
  const set = async (e: IpcMainInvokeEvent, raw: unknown, requestId?: unknown): Promise<void> => {
    if (!liveTop(e)) throw new Error('forbidden')
    const ref = raw === null ? null : parseOnlineVaultRef(raw)
    if (raw !== null && !ref) throw new Error('invalid_ref')
    // 确认 openLibrary 只认:主窗 + 同一个 requestId + 同一个 ref + 发请求时的那份文档
    const p = ref && typeof requestId === 'string' ? pending.get(requestId) : undefined
    const mine = p && p.wc === e.sender && e.sender === deps.mainContents() && p.gen === genOf(p.wc) && sameRef(p.ref, ref!) ? requestId as string : null
    const assertAccount = (): void => { if (ref && !accountOk(ref)) throw new Error('account_changed') }
    try {
      assertAccount()
      await writeActiveVault(ref, assertAccount)
    } catch (err) {
      // 主窗正为 openLibrary 换库、这一写失败:等着的那次当场失败,不干等 30 秒
      if (mine) finish(mine, new Error((err as Error)?.message === 'account_changed' ? 'account_changed' : 'switch_failed'))
      throw err
    }
    // 落盘途中换了账号:不广播上一个账号的 ref、不确认(盘上那条留着,get 按账号回 fallback)
    if (ref && !accountOk(ref)) {
      if (mine) finish(mine, new Error('account_changed'))
      throw new Error('account_changed')
    }
    deps.broadcast(ACTIVE_VAULT_IPC.changed, { ref })
    if (mine) finish(mine, null)
  }

  /** 老镜像配置按需迁移(契约「H3 回 U3a / U4 摸底」第 1 条):跑的就是启动接线 migrateOnStartup 开着时那一段
   *  (migrateLegacyMirrorVault),只是改由主窗渲染层在「当下能在线开」时调。不广播:渲染层换完 impl 再 set,广播在 set。 */
  const migrate = async (e: IpcMainInvokeEvent): Promise<OnlineVaultRef | null> => {
    if (!mainTop(e)) throw new Error('forbidden')
    // 宿主自己核「当下能在线开」:这份文档报过 online-capable(只在 Extend 的代发通道在时才报)。
    // 渲染层哪天提早调,也不会把停在云端那一侧的人落到本机库(H 评 #958)
    if (capable !== e.sender) throw new Error('renderer_unsupported')
    const id = deps.accountId()
    if (!id) return null // 没登录:没有「这个账号的镜像」可迁
    if (!await migrateLegacyMirrorVault(id)) return null // 读不了配置 → 抛(什么都没写);别的不迁的情形 → 没迁
    const ref = await readActiveVault()
    // 迁移途中换了账号:盘上那条留着(get 按账号回 fallback),这次不交出去
    if (!ref || !accountOk(ref)) throw new Error('account_changed')
    return ref
  }

  const api: ActiveVaultHost = {
    register(ipc) {
      registered = api
      // 普通配置写改了 lastVault(Extend 的胶囊切本机等)顺带清掉了在线库:照样告诉各窗口
      onActiveVaultCleared(() => deps.broadcast(ACTIVE_VAULT_IPC.changed, { ref: null }))
      ipc.handle(ACTIVE_VAULT_IPC.get, async (e) => {
        if (!liveTop(e)) throw new Error('forbidden')
        return get()
      })
      ipc.handle(ACTIVE_VAULT_IPC.set, (e, raw: unknown, requestId?: unknown) => set(e, raw, requestId))
      ipc.on(ACTIVE_VAULT_IPC.onlineCapable, (e) => {
        if (!liveTop(e)) return // senderFrame 为空 = 旧文档导航后才到的迟到上报
        const wc = deps.mainContents()
        if (!wc || e.sender !== wc) return // 只认主窗
        watch(wc)
        capable = wc
      })
      ipc.handle(ACTIVE_VAULT_IPC.onlineOpened, async (e, raw: unknown) => {
        const wc = mainTop(e)
        if (!wc) throw new Error('forbidden') // 别的窗口 / 旧文档导航后才到的迟到报告都不认
        const ref = raw === null ? null : parseOnlineVaultRef(raw)
        if (raw !== null && !ref) throw new Error('invalid_ref')
        watch(wc)
        opened = { wc, gen: genOf(wc), ref } // 账号在读数时核:报告之后换了号同样当本机
      })
      ipc.handle(ACTIVE_VAULT_IPC.migrate, (e) => migrate(e))
      ipc.on(ACTIVE_VAULT_IPC.openOnlineResult, (e, r: unknown) => {
        if (!liveTop(e) || e.sender !== deps.mainContents()) return
        const o = r as { requestId?: unknown; ok?: unknown } | null
        if (!o || typeof o.requestId !== 'string' || o.ok !== false) return // 成功只认 set
        const p = pending.get(o.requestId)
        if (!p || p.wc !== e.sender || p.gen !== genOf(p.wc)) return // 只认发请求时那份文档
        finish(o.requestId, new Error('switch_failed')) // 渲染层的 code 不往外带,固定码
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
        pending.set(requestId, { ref, wc, gen: genOf(wc), resolve, reject, timer })
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
    onlineOpened() {
      const o = opened
      if (!o?.ref || o.wc !== deps.mainContents() || o.gen !== genOf(o.wc)) return null
      return accountOk(o.ref) ? o.ref : null // 换了号:不给上一个账号的在线库开插件数据的库那一层
    },
  }
  return api
}

/** 老配置迁移(lastVault = 这个账号的云镜像 → activeVault = 默认库)。 */
export function migrateLegacyMirrorVault(accountId: string | null): Promise<boolean> {
  return migrateMirrorActiveVault(accountId, (id) => cloudVaultDir(id), isManagedCloudVault)
}

/** 启动时跑不跑老配置迁移。一直关着:改由渲染层按需调 amadeus:active-vault:migrate(契约「H3 回 U3a / U4 摸底」第 1 条),
 *  启动时迁会在 Extend 装载之前把停在云端那一侧的用户落到本机库。常量和 migrateOnStartup 等渲染层真调 migrate 的那一包再删。 */
export const MIRROR_MIGRATION_ENABLED = false

/** 启动接线(main.ts 开窗之前 await):开关关着就什么都不做,不读不写配置。 */
export function migrateOnStartup(accountId: string | null, enabled: boolean = MIRROR_MIGRATION_ENABLED): Promise<boolean> {
  return enabled ? migrateLegacyMirrorVault(accountId) : Promise.resolve(false)
}
