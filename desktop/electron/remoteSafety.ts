/**
 * 急停 + 远程锁定 + 远程活动指示的主进程控制器(设备能力 MCP 方案 P1 · K2 §3.8;INTEGRATION R-01 改名 remoteSafety*)。
 *
 * 两个操作分开:
 *   - **急停(estop)**= 一次性动作:中止远程 / 通道 / 无人值守 run、杀其后台进程、撤回远端批准的 Muse 条目,并**顺带上锁**;
 *   - **远程锁定(lock)**= 持久布尔,本模块独占、落 <userData>/remote-lock.json;unitWeb 同步读内存镜像(isLocked),
 *     引擎经 FORSION_REMOTE_LOCK_FILE 每次现读同一个文件。只有本机 + 系统认证能解(D13,§6.1 执行设备专属类)。
 *
 * 急停顺序(每步失败都不阻断后续,失败可见):① 内存锁 + 刷托盘(unitWeb 此刻起 423)② 写锁文件(失败记 lockPersistFailed)
 * ③ POST /agent/remote/estop(本机令牌,5s 超时;不可达 → pendingEstop,引擎 ready 时补发)④ keepAwake 放掉 ⑤ 通知。
 * 断网照样生效:① ② 不碰网络;引擎是本机进程。跨重启:启动读到 lock.locked → 直接锁定;文件读错 → 锁定(fail closed)。
 *
 * 解锁:systemAuth ≠ ok → 保持锁定;ok → 先写文件 lock:null(写失败 → 保持锁定,不做半解锁)→ 内存解锁 → POST /agent/remote/unlock
 * 清引擎的进程内闩。
 * 对账(每份快照;引擎重连 / 重启后连上的第一帧也是快照):
 *   - 待补发的急停:活动流一直健康时也补(POST 超时而引擎其实活着,不能只等下一次重连);
 *   - 本机锁着、引擎说没锁(锁文件没写成 / 被本机进程删改,引擎重启后闩随之丢失)→ 重写锁文件 + 静默补发 estop;
 *     本机锁着但上次写盘失败 → 重试写盘;
 *   - 本机没锁、引擎报锁:锁早于本机最近一次解锁 = 解锁没送到 → 先写回 lock:null 再重发解锁(节流,409 不刷屏);
 *     否则 = 本机不知道的急停(持本机令牌者直接打了引擎)→ 本机接过这把锁(fail closed,解锁照样要系统认证)。
 *
 * 活动流:订引擎 GET /agent/remote/activity/events(SSE 全量快照),算托盘「远程会话运行中 · 设备名」、keepAwake 强制通道
 * (远程 run 在跑就阻止闲置休眠,不看「有会话运行时不休眠」开关 —— 远端没法把电脑唤醒,K2 U2)、新调用方开始远程会话的通知。
 *
 * 刻意零 electron 运行期依赖(deps 注入):vitest 直测(electron/remoteSafety.test.ts)。文案一律 mt / mtFor('main.remoteSafety.*')。
 */
import { readFile } from 'node:fs/promises'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { defineMainMessages, mainLocale, mtFor, type MainLocale } from './mainI18n'
import {
  DEFAULT_ESTOP_HOTKEY, formatAccelerator, HOTKEY_MAX,
  type EstopSource, type RemoteSafetyHotkey, type RemoteSafetyRun, type RemoteSafetyState, type UnlockResult,
} from '../shared/remoteSafety'
import { parseActivitySnapshot, type ActivityRun, type ActivitySnapshot, type EstopReport } from '../shared/remoteActivity'

export const REMOTE_SAFETY_MESSAGES = defineMainMessages({
  // 托盘段(tray.ts 按 trayLang() 用 mtFor 取;不往 tray.ts 的 COPY 表加键,R-23)
  'main.remoteSafety.tray.running': { zh: '远程会话运行中 · {name}', en: 'Remote session running · {name}' },
  'main.remoteSafety.tray.runningMore': { zh: '远程会话运行中 · {name} 等 {n} 个', en: 'Remote session running · {name} and {n} more' },
  'main.remoteSafety.tray.waiting': { zh: '（等你处理）', en: ' (waiting for you)' },
  'main.remoteSafety.tray.stopAll': { zh: '停止全部远程任务', en: 'Stop all remote tasks' },
  'main.remoteSafety.tray.locked': { zh: '远程访问已锁定', en: 'Remote access locked' },
  'main.remoteSafety.tray.unlock': { zh: '解锁远程访问…', en: 'Unlock remote access…' },
  'main.remoteSafety.tray.hotkeyUnavailable': { zh: '急停快捷键不可用', en: 'Emergency stop shortcut unavailable' },
  'main.remoteSafety.tray.changeHotkey': { zh: '更改快捷键…', en: 'Change shortcut…' },
  'main.remoteSafety.tray.titleRunning': { zh: ' 远程', en: ' Remote' },
  'main.remoteSafety.tray.titleLocked': { zh: ' 已锁定', en: ' Locked' },
  'main.remoteSafety.tray.tooltipRunning': { zh: 'Forsion · 远程会话运行中', en: 'Forsion · Remote session running' },
  'main.remoteSafety.tray.tooltipLocked': { zh: 'Forsion · 远程访问已锁定', en: 'Forsion · Remote access locked' },
  // 来源名(托盘 / 面板 / 通知)
  'main.remoteSafety.via.tunnel': { zh: '远程设备', en: 'Remote device' },
  'main.remoteSafety.via.p2p': { zh: '直连设备', en: 'Direct-connected device' },
  'main.remoteSafety.via.lan': { zh: '局域网配对设备', en: 'Paired LAN device' },
  'main.remoteSafety.via.unknown': { zh: '未标记的远程来源', en: 'Unmarked remote source' },
  'main.remoteSafety.channel.wechat': { zh: '微信', en: 'WeChat' },
  'main.remoteSafety.channel.telegram': { zh: 'Telegram', en: 'Telegram' },
  'main.remoteSafety.channel.qq': { zh: 'QQ', en: 'QQ' },
  'main.remoteSafety.channel.other': { zh: '消息通道', en: 'Messaging channel' },
  'main.remoteSafety.unattended.muse': { zh: 'Muse', en: 'Muse' },
  'main.remoteSafety.unattended.automation': { zh: '自动化', en: 'Automation' },
  // 通知
  'main.remoteSafety.notify.estopTitle': { zh: '已急停', en: 'Emergency stop' },
  'main.remoteSafety.notify.estopBody': {
    zh: '中止 {runs} 个远程任务、结束 {procs} 个后台进程、撤回 {entries} 个远端批准的 Muse 待办。远程访问已锁定，需在本机解锁。',
    en: 'Stopped {runs} remote tasks, ended {procs} background processes and withdrew {entries} Muse to-dos approved remotely. Remote access stays locked until you unlock it on this computer.',
  },
  'main.remoteSafety.notify.estopOffline': {
    zh: '远程访问已锁定；引擎暂不可达，重启后远程任务不会再运行。',
    en: 'Remote access is locked. The engine is unreachable right now; remote tasks won’t run again after it restarts.',
  },
  'main.remoteSafety.notify.persistFailed': {
    zh: '锁定状态没能写入磁盘：退出 Forsion 前请保持它运行，或再急停一次。',
    en: 'The lock couldn’t be saved to disk. Keep Forsion running, or press emergency stop again.',
  },
  'main.remoteSafety.notify.unlocked': { zh: '远程访问已解锁', en: 'Remote access unlocked' },
  'main.remoteSafety.notify.sessionStartedTitle': { zh: '远程会话已在这台电脑上开始', en: 'A remote session started on this computer' },
  'main.remoteSafety.notify.sessionStartedBody': { zh: '来自 {name}。可在菜单栏随时停止。', en: 'From {name}. You can stop it from the menu bar at any time.' },
  'main.remoteSafety.notify.sessionStartedBodyHotkey': { zh: '来自 {name}。按 {hotkey} 或在菜单栏随时停止。', en: 'From {name}. Press {hotkey} or use the menu bar to stop it at any time.' },
  // 解锁认证(remoteSafetyAuth.ts)
  'main.remoteSafety.auth.reason': { zh: '解锁这台电脑的远程访问', en: 'unlock remote access to this computer' },
  'main.remoteSafety.auth.dialogTitle': { zh: '解锁远程访问', en: 'Unlock remote access' },
  'main.remoteSafety.auth.dialogMessage': { zh: '要解锁这台电脑的远程访问吗？', en: 'Unlock remote access to this computer?' },
  'main.remoteSafety.auth.dialogDetail': { zh: '解锁后，已允许的设备可以重新在这台电脑上运行任务。', en: 'Once unlocked, allowed devices can run tasks on this computer again.' },
  'main.remoteSafety.auth.unlock': { zh: '解锁', en: 'Unlock' },
  'main.remoteSafety.auth.cancel': { zh: '取消', en: 'Cancel' },
  'main.remoteSafety.settingsTitle': { zh: '设置', en: 'Settings' },
})

// ── 锁文件 ─────────────────────────────────────────────────────────────────────────────────
export interface LockFileState {
  lock: { locked: true; at: number; source: EstopSource } | null
  /** '' = 用户关掉;缺省 = DEFAULT_ESTOP_HOTKEY。 */
  hotkey: string
  /** 读的时候文件坏了(按锁定处理)。 */
  corrupt?: true
}
const SOURCES = new Set<EstopSource>(['hotkey', 'tray', 'settings'])

/** 解析锁文件(与引擎 remoteLock.ts 同口径 fail closed:只有字面 lock:null 才算没锁)。null 原文(ENOENT)= 从未急停。 */
export function parseLockFile(raw: string | null): LockFileState {
  if (raw === null) return { lock: null, hotkey: DEFAULT_ESTOP_HOTKEY }
  let o: any
  try { o = JSON.parse(raw) } catch { o = null }
  const hotkey = o && typeof o.hotkey === 'string' && o.hotkey.length <= HOTKEY_MAX ? o.hotkey : DEFAULT_ESTOP_HOTKEY
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, 'lock')) {
    return { lock: { locked: true, at: 0, source: 'settings' }, hotkey, corrupt: true }
  }
  if (o.lock === null) return { lock: null, hotkey }
  const l = o.lock
  if (l && typeof l === 'object' && l.locked === true) {
    return { lock: { locked: true, at: Number.isFinite(l.at) ? Number(l.at) : 0, source: SOURCES.has(l.source) ? l.source : 'settings' }, hotkey }
  }
  return { lock: { locked: true, at: 0, source: 'settings' }, hotkey, corrupt: true }
}

// ── 来源名 ─────────────────────────────────────────────────────────────────────────────────
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
const INVISIBLE_CHARS = /[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/** 不可信设备名(K1 callerName / 名册名):去控制符、零宽、双向覆写,截 40。空了 = null。 */
export function sanitizeLabel(s: unknown, max = 40): string | null {
  if (typeof s !== 'string') return null
  const t = s.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── 控制器 ─────────────────────────────────────────────────────────────────────────────────
export interface RemoteSafetyDeps {
  /** join(app.getPath('userData'), REMOTE_LOCK_FILE)(惰性取)。 */
  file: () => string
  /** 托管引擎 ready 才给 url,否则 null;token = 本机引擎令牌。 */
  engine: () => { url: string | null; token: string }
  shortcuts: { register(acc: string, cb: () => void): boolean; unregister(acc: string): void }
  notify: (title: string, body: string) => void
  /** 重建托盘菜单 + 同步菜单栏标题 / tooltip(main 里包 refreshTrayMenu + setTrayIndicator)。 */
  refreshTray: (indicator: { title: string; tooltip: string }) => void
  keepAwake: { force(key: string, on: boolean): boolean }
  /** 本机系统认证(remoteSafetyAuth.ts)。 */
  systemAuth: (reason: string) => Promise<'ok' | 'cancelled' | 'unavailable' | 'failed'>
  /** 托盘语言(tray.trayLang);缺省跟 mainLocale。 */
  lang?: () => MainLocale
  /** 同步:「允许远程会话」开着(K4 remoteSessions.isEnabled,R-11)—— 决定空闲时托盘是否常驻「停止全部远程任务」。 */
  remoteCapable: () => boolean
  /** K4 的本机记录名(trustedCaller(id)?.name);'account' = 「本账号的浏览器与网页版」。 */
  trustedCallerLabel?: (unitId: string) => string | null
  /** 平台(mac 上热键显示成 ⌃⌥⇧.)。 */
  mac?: boolean
  /** 录制快捷键时挂起全局热键的兜底时长(渲染层没来得及说「录完了」—— 崩溃 / 关窗)。缺省 60s。 */
  hotkeyRecordingTimeoutMs?: number
  log: (m: string) => void
  now?: () => number
  fetch?: typeof fetch
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
  readFile?: (f: string) => Promise<string | null>
  writeFile?: (f: string, data: unknown) => Promise<void>
}

export interface RemoteTrayView {
  capable: boolean
  locked: boolean
  activeLabel: string | null
  activeCount: number
  waitingApproval: boolean
  hotkey: { accelerator: string; registered: boolean }
}

export interface RemoteSafety {
  /** 读锁文件 → 注册热键 → 连引擎活动流。幂等。返回的 promise 在读盘与注册做完后兑现。 */
  start(): Promise<void>
  dispose(): void
  /** backend.onStatus → 立即重连;有待补发的急停 / 解锁就补。 */
  engineStatusChanged(): void
  state(): RemoteSafetyState
  /** 同步内存镜像(unitWeb 门禁 / K4 R-26)。start 读盘之前 = 锁定(fail closed)。 */
  isLocked(): boolean
  estop(source: EstopSource): Promise<RemoteSafetyState>
  unlock(): Promise<UnlockResult>
  setHotkey(acc: unknown): Promise<RemoteSafetyHotkey>
  /**
   * 设置页录制新快捷键期间挂起全局热键:macOS 上已注册的 globalShortcut 先于窗口拿到按键,不挂起的话在录制框里按当前组合键
   * 会直接触发急停,录制框什么也收不到(独立评审 P2)。只动注册,不动热键状态(托盘不闪「不可用」);setHotkey / false / 超时都会恢复。
   */
  setHotkeyRecording(on: boolean): void
  onChange(cb: (s: RemoteSafetyState) => void): () => void
  /** 引擎活动快照(给别的包:审批送达等)。 */
  onActivity(cb: (snap: ActivitySnapshot) => void): () => void
  trayView(): RemoteTrayView
  trayHandlers(openSettings: () => void): { view: () => RemoteTrayView; stopAll: () => void; unlock: () => void; openSettings: () => void }
}

/** 急停路由要等被中止 run 落定(≤3s)+ 撤回台账 IO,负载高时 5s 不够(POST 超时而引擎其实做完了);锁在发 POST 之前已生效,这里只拖通知。 */
const ESTOP_TIMEOUT_MS = 15_000
const POST_TIMEOUT_MS = 5_000
/** 对账重发(补锁 / 重发解锁)在同一次引擎启动内的最小间隔。 */
const RECONCILE_MIN_INTERVAL_MS = 10_000
const STREAM_IDLE_MS = 45_000
const BACKOFF_MAX_MS = 10_000
const CALLER_NOTIFY_EVERY_MS = 10 * 60_000

export function createRemoteSafety(d: RemoteSafetyDeps): RemoteSafety {
  const now = d.now ?? Date.now
  const doFetch = d.fetch ?? fetch
  const setT = d.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearT = d.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
  const read = d.readFile ?? (async (f: string): Promise<string | null> => {
    try { return await readFile(f, 'utf8') } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e }
  })
  const write = d.writeFile ?? writePrivateJson
  const queue = createSerialQueue()
  const lang = (): MainLocale => { try { return d.lang?.() ?? mainLocale() } catch { return mainLocale() } }
  const t = (key: string, vars?: Record<string, string | number>): string => mtFor(lang(), key, vars)

  // 启动读盘之前按锁定:unitWeb 可能先于 start() 起来(fail closed)
  let loaded = false
  /** start() 读完盘之前就急停了(理论上热键 / 托盘都在 start 之后才有;兜底):读盘结果不许把这把锁覆盖掉。 */
  let estopBeforeLoad = false
  let started = false
  let disposed = false
  let lock: LockFileState['lock'] = { locked: true, at: 0, source: 'settings' }
  let lockPersistFailed = false
  let hotkey: RemoteSafetyHotkey = { accelerator: DEFAULT_ESTOP_HOTKEY, registered: false, error: null }
  let snapshot: ActivitySnapshot | null = null
  let engineReachable = false
  let pendingEstop: EstopSource | null = null
  let lastEstop: RemoteSafetyState['lastEstop'] = null
  let unlocking: Promise<UnlockResult> | null = null
  let unlockResendInFlight = false
  /** 本机最近一次认证解锁写好 lock:null 的时刻:引擎报的锁早于它 = 旧闩(解锁没送到),晚于它 = 本机不知道的急停。 */
  let lastUnlockAt: number | null = null
  /** 正在飞的 estop POST(estop() / 补发 / 补锁);解锁前等它落地,免得它在解锁之后才把引擎闩上。 */
  let estopFlight: Promise<unknown> | null = null
  let estopsInFlight = 0
  /** estop() 整段在途(含它自己的写盘):对账不插手,免得在「内存已锁、引擎还没收到」的窗口里重复补发。 */
  let estopBusy = 0
  let relockInFlight = false
  let lastRelock = { boot: '', at: -Infinity }
  let lastUnlockResend = { boot: '', at: -Infinity }
  let unlock409Logged = false
  let hotkeyRecording = false
  let recordingTimer: unknown = null
  const listeners = new Set<(s: RemoteSafetyState) => void>()
  const activityListeners = new Set<(s: ActivitySnapshot) => void>()
  /** 调用方 key → 上次提示时刻。 */
  const callerNotifiedAt = new Map<string, number>()
  /** 本次引擎启动里见过的远程 run(只对新 run 提示)。 */
  let seenRuns = new Set<string>()
  let seenBoot = ''

  // ── 状态 ──
  const labelOf = (r: ActivityRun): string => {
    if (r.category === 'channel') {
      const k = r.channel && ['wechat', 'telegram', 'qq'].includes(r.channel) ? r.channel : 'other'
      return t(`main.remoteSafety.channel.${k}`)
    }
    if (r.category === 'unattended') return t(r.unattended === 'muse' ? 'main.remoteSafety.unattended.muse' : 'main.remoteSafety.unattended.automation')
    const rem = r.remote
    const trusted = (id: string): string | null => { try { return sanitizeLabel(d.trustedCallerLabel?.(id) ?? null) } catch { return null } }
    if (rem?.callerUnit) return trusted(rem.callerUnit) ?? sanitizeLabel(rem.callerName) ?? t('main.remoteSafety.via.tunnel')
    // 没有设备断言的隧道 / 直连来路 = 账号级调用方(浏览器设备页 / 网页版;P2P 按它判,R-09)
    if (rem?.via === 'tunnel' || rem?.via === 'p2p') return trusted('account') ?? t(`main.remoteSafety.via.${rem.via}`)
    if (rem?.via === 'lan') return t('main.remoteSafety.via.lan')
    return t('main.remoteSafety.via.unknown')
  }
  const remoteRuns = (): RemoteSafetyRun[] => (snapshot?.runs ?? [])
    .filter((r): r is ActivityRun & { category: RemoteSafetyRun['category'] } => r.category !== 'local')
    .map((r) => ({ runId: r.runId, sessionId: r.sessionId, category: r.category, label: labelOf(r), pendingApprovals: r.pendingApprovals || 0, pendingInquiries: r.pendingInquiries || 0, startedAt: r.startedAt }))
  const state = (): RemoteSafetyState => ({
    locked: !!lock,
    lockedAt: lock ? lock.at || null : null,
    lockSource: lock ? lock.source : null,
    lockPersistFailed,
    hotkey: { ...hotkey },
    engine: engineReachable ? 'connected' : 'unavailable',
    pendingEstop: pendingEstop !== null,
    remoteRuns: remoteRuns(),
    lastEstop,
  })
  const safeCapable = (): boolean => { try { return d.remoteCapable() } catch { return false } }
  const trayView = (): RemoteTrayView => {
    const runs = remoteRuns()
    return {
      capable: safeCapable(), locked: !!lock,
      activeLabel: runs[0]?.label ?? null, activeCount: runs.length,
      waitingApproval: runs.some((r) => r.pendingApprovals + r.pendingInquiries > 0),
      hotkey: { accelerator: hotkey.accelerator, registered: hotkey.registered },
    }
  }
  const indicator = (): { title: string; tooltip: string } => {
    if (lock) return { title: t('main.remoteSafety.tray.titleLocked'), tooltip: t('main.remoteSafety.tray.tooltipLocked') }
    if (remoteRuns().length) return { title: t('main.remoteSafety.tray.titleRunning'), tooltip: t('main.remoteSafety.tray.tooltipRunning') }
    return { title: '', tooltip: 'Forsion' }
  }
  const emit = (): void => {
    try { d.refreshTray(indicator()) } catch (e) { d.log(`[remote-safety] refreshTray failed: ${(e as Error)?.message || e}`) }
    const s = state()
    for (const cb of [...listeners]) { try { cb(s) } catch { /* 订阅者的错误不影响控制器 */ } }
  }
  const syncKeepAwake = (): void => {
    const on = !lock && (snapshot?.runs ?? []).some((r) => r.category === 'remote')
    try { d.keepAwake.force('remote', on) } catch { /* 电源管理不可用 */ }
  }
  const notify = (title: string, body: string): void => { try { d.notify(title, body) } catch (e) { d.log(`[remote-safety] notify failed: ${(e as Error)?.message || e}`) } }

  // ── 落盘 ──
  const persist = (): Promise<void> => queue(() => write(d.file(), { v: 1, lock, hotkey: hotkey.error === 'disabled' ? '' : hotkey.accelerator }))

  // ── 引擎 HTTP ──
  const post = async (path: string, body: unknown, timeoutMs = POST_TIMEOUT_MS): Promise<{ status: number; json: any } | null> => {
    const { url, token } = d.engine()
    if (!url) return null
    const ac = new AbortController()
    const timer = setT(() => ac.abort(), timeoutMs)
    try {
      const r = await doFetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
      return { status: r.status, json: await r.json().catch(() => null) }
    } catch (e) {
      d.log(`[remote-safety] POST ${path} failed: ${(e as Error)?.message || e}`)
      return null
    } finally { clearT(timer) }
  }
  const sendEstop = (source: EstopSource): Promise<EstopReport | null> => {
    estopsInFlight++
    const p = post('/agent/remote/estop', { source }, ESTOP_TIMEOUT_MS)
      .then((r) => (r && r.status === 200 && r.json?.ok ? (r.json as EstopReport) : null))
      .finally(() => { estopsInFlight-- })
    estopFlight = p
    void p.finally(() => { if (estopFlight === p) estopFlight = null })
    return p
  }
  const sendUnlock = async (): Promise<{ ok: boolean; status: number | null }> => {
    const r = await post('/agent/remote/unlock', {})
    return { ok: !!r && r.status === 200, status: r ? r.status : null }
  }
  const reportOf = (rep: EstopReport): NonNullable<RemoteSafetyState['lastEstop']> =>
    ({ at: now(), aborted: rep.aborted.length, killedProcesses: rep.killedProcesses, revertedEntries: rep.revertedEntries, engineReached: true })
  /**
   * 本机没锁、引擎报锁(闩或锁文件)。
   *   旧锁(at ≤ 本机最近一次解锁)= 解锁没送到 / 文件被删改:经串行队列写回 lock:null,再重发解锁;同一 boot 10s 一发,409 只记一次日志。
   *   新锁 = 本机不知道的急停(持本机令牌者直接打了引擎 estop、或锁文件被写成锁定):本机接过这把锁并落盘 —— 否则面板显示未锁、
   *   没有解锁按钮,unitWeb 放行而引擎一直 423 到重启(独立评审 P2)。接过来之后照常只能本机认证解锁。
   */
  const reconcileEngineLock = (snap: ActivitySnapshot): void => {
    if (lock || !loaded || unlocking || !snap.lock?.locked) return
    const at = typeof snap.lock.at === 'number' && Number.isFinite(snap.lock.at) ? snap.lock.at : 0
    if (lastUnlockAt !== null && at <= lastUnlockAt) {
      if (unlockResendInFlight) return
      if (lastUnlockResend.boot === snap.bootId && now() - lastUnlockResend.at < RECONCILE_MIN_INTERVAL_MS) return
      lastUnlockResend = { boot: snap.bootId, at: now() }
      unlockResendInFlight = true
      void (async () => {
        try { await persist() } catch (e) { d.log(`[remote-safety] rewriting the unlocked lock file failed: ${(e as Error)?.message || e}`); return }
        const r = await sendUnlock()
        if (r.ok) { unlock409Logged = false; return }
        if (r.status === 409 && unlock409Logged) return
        if (r.status === 409) unlock409Logged = true
        d.log(`[remote-safety] engine unlock not confirmed (${r.status ?? 'unreachable'}); will retry on a later snapshot`)
      })().finally(() => { unlockResendInFlight = false })
      return
    }
    lock = { locked: true, at: at || now(), source: 'settings' }
    d.log(`[remote-safety] engine reports a lock (${snap.lock.source}) this computer didn't set; adopting it (unlock needs local authentication)`)
    void persist().then(() => { lockPersistFailed = false }, (e) => {
      lockPersistFailed = true
      d.log(`[remote-safety] adopted lock write failed: ${(e as Error)?.message || e}`)
    }).finally(emit)
  }
  /**
   * 本机锁着:引擎说没锁(锁文件没写成 / 被删改后引擎重启,闩没了)→ 重写锁文件 + 静默补发 estop(恒上闩,并停掉锁定期间溜进来的非本机 run);
   * 引擎锁着但上次写盘失败 → 只重试写盘。同一 boot 10s 一发;本机的急停 / 解锁在途时不插手。
   */
  const reconcileLocalLock = (snap: ActivitySnapshot): void => {
    if (!lock || relockInFlight || unlocking || estopBusy > 0 || estopsInFlight > 0) return
    const engineUnlocked = snap.lock?.locked === false
    if (!engineUnlocked && !lockPersistFailed) return
    if (lastRelock.boot === snap.bootId && now() - lastRelock.at < RECONCILE_MIN_INTERVAL_MS) return
    lastRelock = { boot: snap.bootId, at: now() }
    relockInFlight = true
    if (engineUnlocked) d.log('[remote-safety] engine reports unlocked while this computer is locked; rewriting the lock file and re-sending emergency stop')
    void (async () => {
      try { await persist(); lockPersistFailed = false } catch (e) {
        lockPersistFailed = true
        d.log(`[remote-safety] lock file write retry failed: ${(e as Error)?.message || e}`)
      }
      if (!engineUnlocked || !lock) return
      // 静默:不通知、不改 lastEstop(那是用户那次急停的结果;引擎重启后的累计从零算,覆盖上去反而失真)
      if (!(await sendEstop(lock.source))) d.log('[remote-safety] re-sent emergency stop not confirmed; will retry on a later snapshot')
    })().finally(() => { relockInFlight = false; emit() })
  }
  /** 补发没送到的急停:引擎 ready(重连)时,以及活动流一直健康时的每份快照(POST 超时而引擎其实活着)。同一时刻至多一发。 */
  const flushPendingEstop = (): void => {
    const src = pendingEstop
    if (!src || estopsInFlight > 0 || estopBusy > 0 || unlocking || !d.engine().url) return
    void sendEstop(src).then((rep) => {
      if (!rep || pendingEstop !== src || !lock) return
      pendingEstop = null
      lastEstop = reportOf(rep) // 引擎按锁定期累计,补发回的是整段结果(含第一发其实已经停掉的)
      emit()
    })
  }

  // ── 活动流 ──
  let conn: AbortController | null = null
  let retryTimer: unknown = null
  let idleTimer: unknown = null
  let attempt = 0
  const onSnapshot = (snap: ActivitySnapshot): void => {
    if (snap.bootId !== seenBoot) { seenBoot = snap.bootId; seenRuns = new Set() }
    snapshot = snap
    engineReachable = true
    attempt = 0
    reconcileEngineLock(snap)
    // 新调用方开始远程会话 → 提示一次(按调用方 10 分钟限一次)
    for (const r of snap.runs) {
      if (r.category !== 'remote' || seenRuns.has(r.runId)) continue
      seenRuns.add(r.runId)
      if (lock) continue
      const key = r.remote?.callerUnit ?? `via:${r.remote?.via ?? '?'}`
      const last = callerNotifiedAt.get(key)
      if (last !== undefined && now() - last < CALLER_NOTIFY_EVERY_MS) continue
      callerNotifiedAt.set(key, now())
      const name = labelOf(r)
      const hk = hotkey.registered ? formatAccelerator(hotkey.accelerator, !!d.mac) : ''
      notify(t('main.remoteSafety.notify.sessionStartedTitle'), hk
        ? t('main.remoteSafety.notify.sessionStartedBodyHotkey', { name, hotkey: hk })
        : t('main.remoteSafety.notify.sessionStartedBody', { name }))
    }
    for (const r of [...seenRuns]) if (!snap.runs.some((x) => x.runId === r)) seenRuns.delete(r)
    flushPendingEstop()
    reconcileLocalLock(snap)
    syncKeepAwake()
    emit()
    for (const cb of [...activityListeners]) { try { cb(snap) } catch { /* 订阅者的错误不影响控制器 */ } }
  }
  const armIdle = (c: AbortController): void => {
    if (idleTimer) clearT(idleTimer)
    idleTimer = setT(() => { d.log('[remote-safety] activity stream idle 45s, reconnecting'); c.abort() }, STREAM_IDLE_MS)
  }
  const disconnect = (): void => {
    conn?.abort()
    conn = null
    if (idleTimer) clearT(idleTimer)
    idleTimer = null
    if (retryTimer) clearT(retryTimer)
    retryTimer = null
  }
  const scheduleRetry = (): void => {
    if (!started || disposed || retryTimer) return
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt)
    attempt++
    retryTimer = setT(() => { retryTimer = null; void connect() }, delay)
  }
  const connect = async (): Promise<void> => {
    if (!started || disposed || conn) return
    const { url, token } = d.engine()
    if (!url) { if (engineReachable) { engineReachable = false; emit() } return }
    const c = new AbortController()
    conn = c
    try {
      const r = await doFetch(`${url}/agent/remote/activity/events`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: c.signal })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      armIdle(c)
      flushPendingEstop()
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || c.signal.aborted) break
        armIdle(c)
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = block.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          let f: unknown
          try { f = JSON.parse(line.slice(6)) } catch { continue }
          const snap = parseActivitySnapshot(f)
          if (snap) onSnapshot(snap)
        }
      }
    } catch (e) {
      if (!c.signal.aborted) d.log(`[remote-safety] activity stream: ${(e as Error)?.message || e}`)
    } finally {
      if (conn === c) {
        conn = null
        if (idleTimer) clearT(idleTimer)
        idleTimer = null
        if (engineReachable) { engineReachable = false; emit() }
        scheduleRetry()
      }
    }
  }

  // ── 热键 ──
  const onHotkey = (): void => { void api.estop('hotkey') }
  const tryRegister = (acc: string): RemoteSafetyHotkey['error'] => {
    try { return d.shortcuts.register(acc, onHotkey) ? null : 'in_use' } catch { return 'invalid' }
  }
  const safeUnregister = (acc: string): void => { try { d.shortcuts.unregister(acc) } catch { /* 早已注销 */ } }
  /** 结束录制:把挂起的热键注册回去(重新注册失败 = 如实报进热键状态)。 */
  const endRecording = (): void => {
    if (!hotkeyRecording) return
    hotkeyRecording = false
    if (recordingTimer) { clearT(recordingTimer); recordingTimer = null }
    if (disposed || !hotkey.registered) return
    const err = tryRegister(hotkey.accelerator)
    if (err) {
      hotkey = { ...hotkey, registered: false, error: err }
      d.log(`[remote-safety] emergency stop shortcut ${hotkey.accelerator} could not be re-registered after recording: ${err}`)
      emit()
    }
  }

  const doEstop = async (source: EstopSource): Promise<RemoteSafetyState> => {
    const src: EstopSource = SOURCES.has(source) ? source : 'settings'
    // ① 内存锁 + 刷托盘:unitWeb 此刻起 423(不等盘、不等引擎)
    if (!loaded) estopBeforeLoad = true
    lock = { locked: true, at: now(), source: src }
    syncKeepAwake()
    emit()
    // ② 落盘(失败可见;引擎那边还有进程内闩兜底)
    try { await persist(); lockPersistFailed = false } catch (e) {
      lockPersistFailed = true
      d.log(`[remote-safety] lock file write failed: ${(e as Error)?.message || e}`)
    }
    // ③ 引擎:中止 + 杀进程 + 撤回条目 + 上闩
    const rep = await sendEstop(src)
    if (rep) {
      pendingEstop = null
      lastEstop = reportOf(rep)
    } else {
      pendingEstop = src
      lastEstop = { at: now(), aborted: 0, killedProcesses: 0, revertedEntries: 0, engineReached: false }
    }
    // ④ keepAwake 放掉(锁定时不再强制)
    syncKeepAwake()
    // ⑤ 通知
    const body = rep
      ? t('main.remoteSafety.notify.estopBody', { runs: rep.aborted.length, procs: rep.killedProcesses, entries: rep.revertedEntries })
      : t('main.remoteSafety.notify.estopOffline')
    notify(t('main.remoteSafety.notify.estopTitle'), lockPersistFailed ? `${body}\n${t('main.remoteSafety.notify.persistFailed')}` : body)
    d.log(`[remote-safety] estop(${src}) engine=${rep ? 'ok' : 'unreachable'} persisted=${!lockPersistFailed}`)
    emit()
    return state()
  }

  const api: RemoteSafety = {
    async start() {
      if (started || disposed) return
      started = true
      let parsed: LockFileState
      try { parsed = parseLockFile(await read(d.file())) } catch (e) {
        d.log(`[remote-safety] lock file unreadable, staying locked: ${(e as Error)?.message || e}`)
        parsed = { lock: { locked: true, at: 0, source: 'settings' }, hotkey: DEFAULT_ESTOP_HOTKEY, corrupt: true }
      }
      if (parsed.corrupt) d.log('[remote-safety] lock file corrupt → locked (fail closed)')
      if (!estopBeforeLoad) lock = parsed.lock
      loaded = true
      if (parsed.hotkey === '') hotkey = { accelerator: '', registered: false, error: 'disabled' }
      else {
        const err = tryRegister(parsed.hotkey)
        hotkey = { accelerator: parsed.hotkey, registered: err === null, error: err }
        if (err) d.log(`[remote-safety] emergency stop shortcut ${parsed.hotkey} not registered: ${err}`)
      }
      emit()
      void connect()
    },
    dispose() {
      if (disposed) return
      disposed = true
      disconnect()
      if (recordingTimer) { clearT(recordingTimer); recordingTimer = null }
      if (hotkey.registered && !hotkeyRecording) safeUnregister(hotkey.accelerator)
      try { d.keepAwake.force('remote', false) } catch { /* ignore */ }
    },
    engineStatusChanged() {
      if (!started || disposed) return
      disconnect()
      attempt = 0
      if (!d.engine().url) { if (engineReachable) { engineReachable = false; emit() } return }
      void connect()
    },
    state,
    isLocked: () => !loaded || !!lock,
    async estop(source) {
      estopBusy++
      try { return await doEstop(source) } finally { estopBusy-- }
    },
    unlock() {
      if (unlocking) return unlocking
      unlocking = (async (): Promise<UnlockResult> => {
        if (!loaded) return { ok: false, reason: 'failed' }
        if (!lock) return { ok: true }
        let auth: Awaited<ReturnType<RemoteSafetyDeps['systemAuth']>>
        try { auth = await d.systemAuth(t('main.remoteSafety.auth.reason')) } catch { auth = 'failed' }
        if (auth !== 'ok') return { ok: false, reason: auth }
        // 在飞的 estop(补发 / 补锁)先落地:否则它可能在解锁之后才到引擎、把刚清的闩又上上
        if (estopFlight) await estopFlight.catch(() => {})
        const prev = lock
        lock = null
        try { await persist() } catch (e) {
          lock = prev // 写不进去 → 保持锁定,不做半解锁(引擎读的是文件)
          d.log(`[remote-safety] unlock write failed: ${(e as Error)?.message || e}`)
          emit()
          return { ok: false, reason: 'failed' }
        }
        lockPersistFailed = false
        pendingEstop = null
        lastUnlockAt = now()
        syncKeepAwake()
        emit()
        if (!(await sendUnlock()).ok) d.log('[remote-safety] engine unlock not confirmed; will retry on next snapshot')
        notify(t('main.remoteSafety.notify.unlocked'), '')
        return { ok: true }
      })().finally(() => { unlocking = null })
      return unlocking
    },
    async setHotkey(raw) {
      endRecording() // 录完了:先把旧键挂回去,下面照常「先注册新键、成功再注销旧键」
      const acc = typeof raw === 'string' ? raw.trim() : null
      if (acc === null || acc.length > HOTKEY_MAX) return { ...hotkey, error: 'invalid' }
      if (acc === '') {
        if (hotkey.registered) safeUnregister(hotkey.accelerator)
        hotkey = { accelerator: '', registered: false, error: 'disabled' }
      } else if (acc === hotkey.accelerator && hotkey.registered) {
        return { ...hotkey }
      } else {
        // 先注册新键,成功再注销旧键;失败保留旧键(回包里带这次尝试的错误,状态不变)
        if (acc === hotkey.accelerator) safeUnregister(acc) // 同键重试(上次失败):先清掉再注册
        const err = tryRegister(acc)
        if (err) {
          emit()
          return { accelerator: hotkey.accelerator, registered: hotkey.registered, error: err }
        }
        if (hotkey.registered && hotkey.accelerator !== acc) safeUnregister(hotkey.accelerator)
        hotkey = { accelerator: acc, registered: true, error: null }
      }
      try { await persist() } catch (e) { d.log(`[remote-safety] hotkey write failed: ${(e as Error)?.message || e}`) }
      emit()
      return { ...hotkey }
    },
    setHotkeyRecording(on) {
      if (!on) { endRecording(); return }
      if (hotkeyRecording || disposed) return
      hotkeyRecording = true
      if (hotkey.registered) safeUnregister(hotkey.accelerator)
      recordingTimer = setT(() => { recordingTimer = null; d.log('[remote-safety] shortcut recording timed out; restoring the emergency stop shortcut'); endRecording() }, d.hotkeyRecordingTimeoutMs ?? 60_000)
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    onActivity(cb) { activityListeners.add(cb); return () => { activityListeners.delete(cb) } },
    trayView,
    trayHandlers(openSettings) {
      return {
        view: trayView,
        stopAll: () => { void api.estop('tray') },
        unlock: () => { void api.unlock() },
        openSettings,
      }
    },
  }
  return api
}
