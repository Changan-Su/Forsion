/**
 * 账号编排(宿主侧,2026-09-28 从 main.ts 抽出):凭据文件 auth.json + 渲染层握手(auth:will-change / auth:ready)
 * + 停 / 起 Amadeus 云同步 + managed 引擎重启(token 走 env 快照,重启是唯一传播手段)+ 设备互联通道重建 + 广播 auth:changed。
 *
 * Forsion 云端那半 —— device flow / whoami / 滑动续期 / 多账号记忆(auth-accounts.json)/ 服务端吊销 / auth:* 通道 —— 住在
 * Forsion Extend 的主进程半身,经 CloudHost 的 account* 接缝调进这里:
 *   · commit(creds) = 换成这份凭据(切号 / 设备码登录成功):同今天的 activateAccount;
 *   · clear() = 清掉 token(登出 / 服务端 401 转登出):同今天登出链里宿主那几步;
 *   · writeCreds(patch) = 只换文件不重启(滑动续期);
 *   · onExternalChange(cb) = auth.json 被别的来源(终端 tangu login / logout、手改文件)改了,watcher 先调它再走同一条传播链;
 *   · setRefresher(fn) = Extend 登记续期实现,宿主启动时 / 每 24h 调 refresh()。
 * 五条入口(切号 / 设备码登录 / 登出 / 401 失效 / 外部变化)的宿主侧顺序与抽出前逐字一致;Extend 缺席 = 没有前四条,只剩 watcher。
 */
import { waitForAccountRenderers } from './accountTransition'
import type { TanguCreds } from './forsionAuth'

export interface Creds { cloudUrl: string; token: string }
export interface ExternalCredsChange { previous: TanguCreds; current: TanguCreds }

interface Renderer {
  id: number
  send(channel: string, payload: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
interface AckEvents {
  on(channel: string, listener: (event: { sender: { id: number } }, requestId: string, error?: string) => void): unknown
  removeListener(channel: string, listener: (event: { sender: { id: number } }, requestId: string, error?: string) => void): unknown
}

export interface AccountCoreDeps {
  loadCreds(): TanguCreds
  /** 只写 auth.json(多账号记忆归 Extend)。 */
  saveCreds(c: TanguCreds): void
  saveConfig(patch: { cloudUrl?: string }): Promise<unknown>
  loadConfig(): Promise<{ mode?: string }>
  ensureBackend(): Promise<void>
  refreshUnitHost(): Promise<void> | void
  /** 活着、已装载页面的渲染进程(主窗 / mini / 独立窗),握手对象。 */
  renderers(): Renderer[]
  events: AckEvents
  broadcast(channel: string, payload: unknown): void
  /** 迟绑定:registerAmadeusIpc 之后才有;没有就跳过(null)。 */
  stopSync(): Promise<void> | null | undefined
  restartSync(): Promise<void> | null | undefined
  log(message: string): void
}

export interface AccountCore {
  /** 串行队列:同一时刻只跑一条账号变更链。 */
  transition<T>(fn: () => Promise<T>): Promise<T>
  /** 换成这份凭据(握手 → 停同步 → 写 cloudUrl → 写 auth.json → 引擎重启 → 设备互联 → 起同步 → 广播)。assertCurrent 在三处关口调用,抛错即中止;
   *  onCommitPoint 在最后一次 assertCurrent 通过、写 auth.json 之前同步调一次 —— Extend 把「记多账号 / 忘账号 / 取消在途登录 / 清缓存 / 发吊销」
   *  放在这里,与搬迁前 withPreparedAccount 回调里的位置相同:握手失败就一样都不发生。 */
  commit(creds: Creds, assertCurrent?: () => void, onCommitPoint?: () => void): Promise<void>
  /** 清 token(保留 cloudUrl / model),链同上。 */
  clear(assertCurrent?: () => void, onCommitPoint?: () => void): Promise<void>
  /** 只换文件不重启(滑动续期),并同步 watcher 的去重快照。 */
  writeCreds(patch: Partial<Creds>): void
  onExternalChange(cb: (change: ExternalCredsChange) => void): void
  setRefresher(fn: (timeoutMs?: number) => Promise<void>): void
  /** Extend 登记了续期就跑,没有 = 立即完成(启动那次 4s 封顶,由调用点排在 ensureBackend 之前)。 */
  refresh(timeoutMs?: number): Promise<void>
  /** auth.json 目录 watcher 的入口(300ms 防抖)。 */
  onAuthFileMaybeChanged(): void
  /** 当前 auth.json 的去重键(`cloudUrl\u0000token`);测试与 Extend 的竞态复核用。 */
  currentAuthKey(): string
}

export const credKey = (url: string, tok: string): string => `${url.replace(/\/+$/, '')}\u0000${tok}`

export function createAccountCore(d: AccountCoreDeps): AccountCore {
  // 登录态变更处理的去重锚:桌面登录/登出 IPC 与 auth.json watcher 都会触发「广播 + 重启后端」,
  // 以「上次已处理的 token 值」判重,IPC 路径先行更新它 → watcher 随后触发时识别为已处理。
  const currentAuthKey = (): string => { const c = d.loadCreds(); return credKey(c.cloudUrl || '', c.token || '') }
  let lastAuthCreds = d.loadCreds()
  let lastAuthKey = currentAuthKey()
  const updateLastAuth = (): void => {
    lastAuthCreds = d.loadCreds()
    lastAuthKey = credKey(lastAuthCreds.cloudUrl || '', lastAuthCreds.token || '')
  }
  let authTransitions: Promise<unknown> = Promise.resolve()
  const runAuthTransition = <T,>(fn: () => Promise<T>): Promise<T> => {
    const task = authTransitions.then(fn, fn)
    authTransitions = task.catch(() => {})
    return task
  }
  const prepareAccountTransition = async (): Promise<void> => {
    try { await waitForAccountRenderers(d.renderers(), d.events) } catch (error) {
      d.broadcast('auth:changed', { loggedIn: !!d.loadCreds().token })
      throw error
    }
  }
  const withPreparedAccount = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await prepareAccountTransition()
    try {
      await d.stopSync()
      return await fn()
    } finally {
      try { await d.restartSync() } finally {
        d.broadcast('auth:changed', { loggedIn: !!d.loadCreds().token })
      }
    }
  }
  const hooks: Array<(change: ExternalCredsChange) => void> = []
  let refresher: ((timeoutMs?: number) => Promise<void>) | null = null
  let authWatchTimer: ReturnType<typeof setTimeout> | null = null

  return {
    transition: runAuthTransition,
    currentAuthKey,
    async commit(creds, assertCurrent = () => {}, onCommitPoint?: () => void) {
      assertCurrent()
      await withPreparedAccount(async () => {
        assertCurrent()
        // Finish endpoint persistence before committing the new credential. loadConfig
        // keeps using the old active credential's endpoint while this write is pending.
        await d.saveConfig({ cloudUrl: creds.cloudUrl })
        assertCurrent()
        onCommitPoint?.()
        d.saveCreds({ ...d.loadCreds(), ...creds })
        updateLastAuth()
        const stored = await d.loadConfig()
        if (stored.mode === 'managed') await d.ensureBackend()
        void d.refreshUnitHost()
      })
    },
    async clear(assertCurrent = () => {}, onCommitPoint?: () => void) {
      assertCurrent()
      await withPreparedAccount(async () => {
        assertCurrent()
        onCommitPoint?.()
        const c = d.loadCreds()
        delete c.token // 登出:只清 token(保留 cloudUrl/model 记忆)
        d.saveCreds(c)
        updateLastAuth()
        const stored = await d.loadConfig()
        if (stored.mode === 'managed') await d.ensureBackend()
        void d.refreshUnitHost() // 登出即重建互联通道(未登录态下 unitWeb 局域网面照常,云通道退避等登录)
      })
    },
    writeCreds(patch) {
      d.saveCreds({ ...d.loadCreds(), ...patch })
      updateLastAuth() // 同步更新凭据快照:watcher 随后识别相同即跳过。
    },
    onExternalChange(cb) { hooks.push(cb) },
    setRefresher(fn) { refresher = fn },
    refresh: (timeoutMs) => (refresher ? refresher(timeoutMs) : Promise.resolve()),
    onAuthFileMaybeChanged() {
      if (authWatchTimer) clearTimeout(authWatchTimer)
      authWatchTimer = setTimeout(() => {
        void runAuthTransition(async () => {
          if (currentAuthKey() === lastAuthKey) return
          const change: ExternalCredsChange = { previous: lastAuthCreds, current: d.loadCreds() }
          // Extend 那半(取消在途登录、清资料缓存、记 / 忘多账号)先做:都是纯文件 / 内存动作,不依赖握手
          for (const cb of hooks) cb(change)
          // Old clients are bound to their original account and root. Editors must
          // flush before stopSync moves a cloud vault back to the local folder.
          await withPreparedAccount(async () => {
            updateLastAuth()
            const stored = await d.loadConfig()
            if (stored.mode === 'managed') await d.ensureBackend()
            void d.refreshUnitHost()
          })
        }).catch((e) => d.log(`[auth] external account change failed: ${(e as Error)?.message || e}`))
      }, 300) // 防抖:登录流程对 auth.json 的连续写只触发一次
    },
  }
}
