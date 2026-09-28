/**
 * 设备凭据(P1-K5):Electron 适配 + 从明文 shell 配置一次性迁移 + 状态面 IPC + 远程会话门控。
 *
 * 守护的不变量:只有 forsion_token 拿不到本机设备身份。token + unitHostSecret 两者齐了就能以本机身份开设备通道(新通道**顶掉**
 * 旧通道,手机发往这台电脑的远程会话流量全流到对方),还能给本机 unit id 换发调用方凭据 —— 已被信任的 unit id 直接被继承,
 * 「首次本机确认」形同虚设。所以 unitHostId + unitHostSecret(合成一个槽 unitPairing)与 external 模式的 token 迁出
 * userData/tangu-desktop-config.json(明文、经 config:get 整份泄给渲染层、config:set 还能写),进 device-secrets.json(safeStorage)。
 *
 * 边界如实写:Windows DPAPI 与 Linux libsecret 不按应用隔离;macOS 的钥匙串 ACL 信任 Forsion 二进制,而引擎与 CLI 本身就以这个
 * 二进制运行(ELECTRON_RUN_AS_NODE)、包是 ad-hoc 签名。safeStorage 挡住的是明文 cat / grep、userData 的备份与同步拷贝、渲染层泄露;
 * 同用户的代码执行仍可取得,属残余风险(方案 §6.8)。
 *
 * 规矩:
 *   - locked ≠ absent。读不出来时 **绝不自动重新登记**(会铸新 unit id,别的设备对本机的信任全部作废,名册里还多一台重复设备);
 *     unitHost 不启动(unitHostStartPlan → web-only-locked),等用户在本机点「重试」(解密失败)/「重启 Forsion」(restartRequired)
 *     或「重新登记本机」(只在配对锁定时可用,主进程原生确认框)。
 *   - macOS / Windows 这次运行拿不到系统加密(level=unavailable):配对即使为空也按锁定处理 —— 新登记出来的配对存不下,
 *     UnitHost 却会拿内存里那份一直连着,下次启动再铸一个新 unit id(名册里的孤儿)。
 *   - 迁移校验没通过:shell 原样保留(下次启动 / 重试再来),期间配对按锁定处理,external token 回落 shell 里那份。
 *   - 远程会话 fail-closed:remoteSessionsPermitted() 只在 level=os、配对没锁定、配对不是明文条目时为真。
 *   - IPC 四个通道都只给本机可信发送方(unitWeb 不转发 IPC)。
 */
import { app, BrowserWindow, dialog, safeStorage, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateJson } from './configWrite'
import { defineMainMessages, mt } from './mainI18n'
import { createSecretStore, type CryptoProvider, type SecretSlot, type SecretStorageStatus, type SecretStore, type SlotRead } from './secretStore'

export type { SecretStorageStatus, SlotRead } from './secretStore'
export { SecretStoreInsecureError } from './secretStore'

/** 同 unitHost.ts 的 UnitPairing。 */
export type UnitPairing = { unitId: string; secret: string }
export type PairingRead = { state: 'ok'; value: UnitPairing | null } | { state: 'locked' }

export interface ShellDeps {
  /** 读 shell 配置(main.ts readShellConfig,含旧目录播种)。 */
  readShell(): Promise<Record<string, any>>
  /** 直接写 shell 配置(已在 configQueue 内调用;不能再走 saveConfig,否则自等死锁)。 */
  writeShell(s: Record<string, any>): Promise<void>
  /** main.ts 的 configQueue:迁移与重新登记都要改 shell 文件,与 config:set 的写入排同一条队。 */
  queue<T>(fn: () => Promise<T>): Promise<T>
}

/** 旧 shell 配置里要迁走的键。 */
const SHELL_SECRET_KEYS = ['unitHostId', 'unitHostSecret', 'token'] as const
/** 渲染层能看到的锁定槽(P2 的调用方凭据只有主进程用)。 */
const PUBLIC_SLOTS: readonly SecretSlot[] = ['unitPairing', 'externalToken']

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parsePairing(v: string): UnitPairing | null {
  try {
    const j = JSON.parse(v) as Partial<UnitPairing>
    return typeof j?.unitId === 'string' && j.unitId && typeof j.secret === 'string' && j.secret ? { unitId: j.unitId, secret: j.secret } : null
  } catch { return null }
}
const encodePairing = (p: UnitPairing): string => JSON.stringify({ unitId: p.unitId, secret: p.secret })

/** unitHost 起不起:关着 = off;配对读不出来 = 只起局域网面(unitWeb 不依赖这把钥),**不建 UnitHost**;其余照常。 */
export function unitHostStartPlan(i: { enabled: boolean; pairing: 'ok' | 'locked' }): 'off' | 'start' | 'web-only-locked' {
  if (!i.enabled) return 'off'
  return i.pairing === 'locked' ? 'web-only-locked' : 'start'
}

export interface DeviceSecrets {
  init(d: ShellDeps): Promise<void>
  /** 等 init 做完(还没开始就立即返回)。 */
  whenReady(): Promise<void>
  status(): SecretStorageStatus
  /** 渲染层看到的状态:locked 只报 unitPairing | externalToken。 */
  publicStatus(): SecretStorageStatus
  onStatusChange(cb: (s: SecretStorageStatus) => void): () => void
  unitPairing(): Promise<PairingRead>
  setUnitPairing(p: UnitPairing | null): Promise<void>
  externalToken(): Promise<string>
  setExternalToken(v: string): Promise<void>
  callerSecret(): Promise<SlotRead>
  setCallerSecret(v: string | null): Promise<void>
  remoteSessionsPermitted(): boolean
  retry(): Promise<SecretStorageStatus>
  /** 重新登记本机(清空配对槽)。只在配对锁定时可用(否则抛 not-locked:任何可信渲染层代码都不许随手换掉本机身份);
   *  这次运行拿不到系统加密时抛 restart-required(新配对存不下)。confirm 回 false = 用户取消,什么都不动。 */
  resetUnitPairing(o?: { confirm?: () => Promise<boolean> }): Promise<SecretStorageStatus>
  wipe(): Promise<void>
}

export function createDeviceSecrets(o: { store: SecretStore; warn?: (m: string) => void }): DeviceSecrets {
  const { store } = o
  const warn = o.warn ?? ((m: string) => console.warn(m))
  let shellDeps: ShellDeps | null = null
  let initP: Promise<void> | null = null
  let done = false
  /** 迁移校验没通过:shell 里还有配对,store 不是权威 → 按锁定处理(绝不当成空去重新登记)。 */
  let pendingPairing = false
  /** 同上,external token 回落 shell 里那份(瞬时的钥匙串故障不该让外部连接断掉)。 */
  let pendingToken: string | null = null
  let migrateError: string | null = null
  const listeners = new Set<(s: SecretStorageStatus) => void>()

  const emit = (): void => {
    if (!listeners.size) return
    const st = status()
    for (const cb of [...listeners]) { try { cb(st) } catch { /* 订阅方的错不影响凭据 */ } }
  }
  store.onChange(() => emit())

  /** init 开始了就等它;还没开始(调用顺序错了)就按「不可用」处理并出声,而不是去等一个可能永远不来的 promise。 */
  async function ready(what: string): Promise<boolean> {
    if (initP) { await initP; return true }
    warn(`[device-secrets] ${what} 在 init 之前被调用:按锁定 / 空处理`)
    return false
  }

  function status(): SecretStorageStatus {
    const st = store.status()
    const locked = new Set(st.locked)
    if (pendingPairing) locked.add('unitPairing')
    return { ...st, locked: [...locked], lastError: st.lastError ?? migrateError }
  }

  /** 一次性、幂等的迁移:shell 里的三键 → store(读回校验)→ 从 shell 删掉。调用方已在 configQueue 内。 */
  async function migrateInner(d: ShellDeps): Promise<void> {
    const before = JSON.stringify([pendingPairing, pendingToken, migrateError])
    pendingPairing = false
    pendingToken = null
    migrateError = null
    try {
      const shell = await d.readShell()
      if (!SHELL_SECRET_KEYS.some((k) => k in shell)) return // 第二次运行:什么都不写
      let ok = true
      const id = str(shell.unitHostId), secret = str(shell.unitHostSecret)
      if (id && secret) {
        const want = encodePairing({ unitId: id, secret })
        const cur = await store.get('unitPairing')
        const same = cur.state === 'ok' && cur.value !== null && parsePairing(cur.value) && encodePairing(parsePairing(cur.value)!) === want
        // 值相同只删 shell;值不同以 shell 为准(新代码不再往 shell 写秘密,shell 里出现新值只可能来自降级后跑过的旧版本)
        if (!same && !(await store.setVerified('unitPairing', want))) { ok = false; pendingPairing = true }
      }
      const token = str(shell.token)
      if (token) {
        const cur = await store.get('externalToken')
        if (!(cur.state === 'ok' && cur.value === token) && !(await store.setVerified('externalToken', token))) { ok = false; pendingToken = token }
      }
      if (!ok) { migrateError = 'migrate-verify-failed'; return } // shell 保持原样,下次启动 / 重试再来
      for (const k of SHELL_SECRET_KEYS) delete shell[k]
      await d.writeShell(shell) // 这里崩了:下次启动值相同 → 只删 shell
    } catch (e) {
      migrateError = 'migrate-failed'
      warn(`[device-secrets] 迁移失败(shell 原样保留,下次启动再试):${(e as Error)?.message || e}`)
    } finally {
      if (JSON.stringify([pendingPairing, pendingToken, migrateError]) !== before) emit()
    }
  }

  const api: DeviceSecrets = {
    init(d) {
      if (initP) return initP
      shellDeps = d
      initP = d.queue(async () => {
        await store.init()
        await migrateInner(d)
      }).catch((e) => {
        // 绝不让 init 以拒绝收场:loadConfig 等高频读者都在等它,拒绝 = 整个应用读不了配置
        migrateError = 'init-failed'
        warn(`[device-secrets] 初始化失败(按锁定处理):${(e as Error)?.message || e}`)
      }).finally(() => { done = true })
      return initP
    },
    async whenReady() { if (initP) await initP },
    status: () => status(),
    publicStatus() {
      const st = status()
      return { ...st, locked: st.locked.filter((s) => PUBLIC_SLOTS.includes(s)) }
    },
    onStatusChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    async unitPairing() {
      if (!(await ready('unitPairing()'))) return { state: 'locked' }
      if (pendingPairing) return { state: 'locked' }
      const r = await store.get('unitPairing')
      if (r.state !== 'ok') return { state: 'locked' }
      if (r.value === null) {
        // 空槽但这次运行存不下新配对(macOS / Windows 加密不可用):当成空 = UnitHost 去入册、存盘失败、下次启动再铸新 id。
        // 只在互联开着时才会问到这里(doRefreshUnitHost),判定 level 就是入册前本来要做的事。
        return store.status().level === 'unavailable' ? { state: 'locked' } : { state: 'ok', value: null }
      }
      const p = parsePairing(r.value)
      return p ? { state: 'ok', value: p } : { state: 'locked' } // 解出来是坏的:同样不当成空
    },
    async setUnitPairing(p) {
      if (!(await ready('setUnitPairing()'))) throw new Error('device-secrets-not-ready')
      await store.set('unitPairing', p ? encodePairing(p) : null)
    },
    async externalToken() {
      if (!(await ready('externalToken()'))) return ''
      if (pendingToken !== null) return pendingToken
      const r = await store.get('externalToken')
      return r.state === 'ok' ? r.value ?? '' : ''
    },
    async setExternalToken(v) {
      if (!(await ready('setExternalToken()'))) throw new Error('device-secrets-not-ready')
      const next = v ? v : null
      const cur = await store.get('externalToken')
      if (pendingToken === null && cur.state === 'ok' && cur.value === next) return // 同值不重写(不为此碰钥匙串)
      await store.set('externalToken', next)
      pendingToken = null
      // shell 里残留的旧原件(迁移校验没过 / 降级旧版本写回)一并删掉:否则下次启动迁移按「shell 为准」把旧值盖回用户刚填的新值。
      // 调用方(main.ts writeConfigPatch)已在 configQueue 内 → 直接读写 shell,不能再排队(自等死锁)。
      if (shellDeps) {
        const shell = await shellDeps.readShell()
        if ('token' in shell) {
          delete shell.token
          await shellDeps.writeShell(shell)
        }
      }
    },
    async callerSecret() {
      if (!(await ready('callerSecret()'))) return { state: 'locked' }
      return store.get('unitCallerSecret')
    },
    async setCallerSecret(v) {
      if (!(await ready('setCallerSecret()'))) throw new Error('device-secrets-not-ready')
      await store.set('unitCallerSecret', v) // level ≠ os → SecretStoreInsecureError,不落盘
    },
    remoteSessionsPermitted() {
      if (!done) return false // 没初始化完:fail closed
      const st = status()
      const enc = store.describe('unitPairing')
      return st.level === 'os' && !st.locked.includes('unitPairing') && enc !== 'plain' && enc !== 'unreadable'
    },
    async retry() {
      if (!(await ready('retry()')) || !shellDeps) return status()
      const d = shellDeps
      await d.queue(async () => {
        await store.retry()
        await migrateInner(d)
      })
      return status()
    },
    async resetUnitPairing(o) {
      if (!(await ready('resetUnitPairing()')) || !shellDeps) throw new Error('device-secrets-not-ready')
      const d = shellDeps
      const gate = (): void => {
        const st = status()
        if (!st.locked.includes('unitPairing')) throw new Error('not-locked')
        if (st.level === 'unavailable') throw new Error('restart-required')
      }
      gate() // 先判再问:没锁定时连确认框都不弹
      if (o?.confirm && !(await o.confirm())) return status()
      await d.queue(async () => {
        gate() // 确认框开着的期间状态可能变了(另一个窗口点了重试)
        await store.set('unitPairing', null, { force: true })
        // 迁移没做完时 shell 里还躺着旧配对:一并删掉,否则下次启动又把旧身份迁回来
        const shell = await d.readShell()
        if ('unitHostId' in shell || 'unitHostSecret' in shell) {
          delete shell.unitHostId
          delete shell.unitHostSecret
          await d.writeShell(shell)
        }
        if (pendingPairing) { pendingPairing = false; emit() }
      })
      return status()
    },
    async wipe() {
      await store.wipe()
      pendingPairing = false
      pendingToken = null
      migrateError = null
    },
  }
  return api
}

// ── 隔离 dev 实例不碰真钥匙串 ───────────────────────────────────────────────────────────────────
/** 未打包 + 显式 --user-data-dir(= 台架的隔离实例;`npm run dev` 不带它)→ macOS 用 Chromium 的 MockKeychain、Linux 用
 *  basic 后端,不读写开发者真钥匙串里的「forsion-desktop Safe Storage」(与 dev 实例同名共用;钥匙串锁着 / ACL 失配时的
 *  模态框会把主线程挂住,台架 firstWindow 超时)。OSCrypt 在第一次用钥匙串时才查 use-mock-keychain(os_crypt_mac.mm),
 *  所以本模块被 main.ts 顶部 import 时(ready 之前)追加开关即可。FORSION_REAL_KEYCHAIN=1 关掉(要在隔离实例里测真钥匙串时)。
 *  打包版永不生效。 */
function isolateDevKeychain(): void {
  try {
    if (app.isPackaged || process.env.FORSION_REAL_KEYCHAIN === '1' || !app.commandLine.hasSwitch('user-data-dir')) return
    if (process.platform === 'darwin') {
      if (!app.commandLine.hasSwitch('use-mock-keychain')) app.commandLine.appendSwitch('use-mock-keychain')
      console.log('[device-secrets] 隔离的 dev 实例(--user-data-dir):safeStorage 用 MockKeychain,不碰真钥匙串')
    } else if (process.platform === 'linux') {
      if (!app.commandLine.hasSwitch('password-store')) app.commandLine.appendSwitch('password-store', 'basic')
      console.log('[device-secrets] 隔离的 dev 实例(--user-data-dir):safeStorage 用 basic 后端,不碰真钥匙串')
    }
  } catch { /* 单测里的 electron 桩没有 commandLine */ }
}
isolateDevKeychain()

// ── 主进程原生确认框(重新登记本机)─────────────────────────────────────────────────────────────
defineMainMessages({
  'main.secrets.resetTitle': { zh: '重新登记本机？', en: 'Re-register this device?' },
  'main.secrets.resetDetail': {
    zh: '将为本机生成新的设备 ID，其他设备需要重新确认对本机的信任。',
    en: 'This gives the device a new ID. Your other devices will need to trust it again.',
  },
  'main.secrets.resetConfirm': { zh: '重新登记', en: 'Re-register' },
  'main.secrets.cancel': { zh: '取消', en: 'Cancel' },
})

/** 确认框在主进程弹(挂发起窗口):渲染层的 window.confirm 挡不住插件之类的可信渲染层代码直接调 IPC。 */
async function confirmResetNative(e: IpcMainInvokeEvent): Promise<boolean> {
  const opts = {
    type: 'warning' as const,
    message: mt('main.secrets.resetTitle'),
    detail: mt('main.secrets.resetDetail'),
    buttons: [mt('main.secrets.resetConfirm'), mt('main.secrets.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}

// ── Electron 单例 ─────────────────────────────────────────────────────────────────────────────
function electronCrypto(): CryptoProvider {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'none'),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  }
}

/** 设备凭据文件:userData 里(引擎 C4 凭据读拒绝整目录收录,无需改引擎)。 */
export const DEVICE_SECRETS_FILE = 'device-secrets.json'

let singleton: DeviceSecrets | null = null
function defaultImpl(): DeviceSecrets { return impl() }
function impl(): DeviceSecrets {
  return (singleton ??= createDeviceSecrets({
    store: createSecretStore({
      file: join(app.getPath('userData'), DEVICE_SECRETS_FILE),
      crypto: electronCrypto(),
      platform: process.platform,
      read: async (f) => {
        try { return await readFile(f, 'utf8') } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw e
        }
      },
      write: writePrivateJson,
      rm: (f) => rm(f, { force: true }),
    }),
  }))
}

/** whenReady 之后、任何读配置的 IPC 与 refreshUnitHost 之前 await(Linux 在 ready 前后端是 unknown)。 */
export const init = (d: ShellDeps): Promise<void> => impl().init(d)
export const status = (): SecretStorageStatus => impl().status()
export const onStatusChange = (cb: (s: SecretStorageStatus) => void): (() => void) => impl().onStatusChange(cb)
export const unitPairing = (): Promise<PairingRead> => impl().unitPairing()
export const setUnitPairing = (p: UnitPairing | null): Promise<void> => impl().setUnitPairing(p)
export const externalToken = (): Promise<string> => impl().externalToken()
export const setExternalToken = (v: string): Promise<void> => impl().setExternalToken(v)
/** P2 桌面作调用方:/units/:id/caller-secret 的结果只能经它落盘;insecure 时不铸票。 */
export const callerSecret = (): Promise<SlotRead> => impl().callerSecret()
export const setCallerSecret = (v: string | null): Promise<void> => impl().setCallerSecret(v)
/** 「允许远程会话」开关的门控(K4:isEnabled = 存档 enabled && 这里;false 时 setEnabled(true) 抛 secret-store-insecure)。 */
export const remoteSessionsPermitted = (): boolean => impl().remoteSessionsPermitted()
export const wipe = (): Promise<void> => impl().wipe()

/** secrets:status / retry / resetUnitPairing / relaunch —— 只给本机可信发送方;重试与重新登记之后刷新 unitHost。
 *  relaunch 只在 restartRequired 时放行(进程内救不回的那一类);重新登记只在配对锁定时放行,并由主进程弹原生确认框。
 *  impl / confirmReset / relaunch 可注入(单测);缺省走 Electron。 */
export function registerSecretsIpc(ipc: IpcMain, d: {
  isTrustedSender(e: IpcMainInvokeEvent): boolean
  refreshUnitHost(): Promise<void>
  confirmReset?(e: IpcMainInvokeEvent): Promise<boolean>
  relaunch?(): void
  impl?: () => DeviceSecrets
}): void {
  const impl = d.impl ?? defaultImpl
  const confirmReset = d.confirmReset ?? confirmResetNative
  // app.quit 而不是 app.exit:before-quit 里优雅停引擎、落盘电脑历史;relaunch 标记在退出时生效
  const relaunch = d.relaunch ?? (() => { app.relaunch(); app.quit() })
  const guard = (e: IpcMainInvokeEvent): void => { if (!d.isTrustedSender(e)) throw new Error('forbidden') }
  ipc.handle('secrets:status', async (e) => {
    guard(e)
    await impl().whenReady() // 只等 init,不为了报状态去解密(解密 = macOS 可能弹钥匙串);锁定由 doRefreshUnitHost 那次读取反映
    return impl().publicStatus()
  })
  ipc.handle('secrets:retry', async (e) => {
    guard(e)
    await impl().retry()
    await d.refreshUnitHost()
    return impl().publicStatus()
  })
  ipc.handle('secrets:resetUnitPairing', async (e) => {
    guard(e)
    let confirmed = false
    await impl().resetUnitPairing({ confirm: async () => (confirmed = await confirmReset(e)) }) // 没锁定 / 要重启 → 抛错,不弹框
    if (confirmed) await d.refreshUnitHost() // 用户取消:什么都不动
    return impl().publicStatus()
  })
  ipc.handle('secrets:relaunch', async (e) => {
    guard(e)
    await impl().whenReady()
    if (!impl().status().restartRequired) throw new Error('not-restart-required')
    relaunch()
    return impl().publicStatus()
  })
}
