/**
 * 电脑历史(Computer History)主进程侧:订阅 CU helper 的 `recordSubscribe` 事件流 → 落盘 / 保留 / 清除 / 暂停。
 *
 * 分工(契约见 shared/computerHistory.ts 顶注):helper **只观测**,经一条专用长连接把事件逐行推过来;
 * 策略、落盘、保留、清除、暂停全在这里。引擎 read_computer_history 只读 `<forsionHome>/computer-history/`。
 *
 * 纪律:
 *  1. **功能关着绝不连 socket、绝不拉起 helper**(拉起会顺带把权限框带出来);只支持 darwin / win32,其余平台恒 unsupported。
 *     win32:helper 是 CU 包里的 windows-bridge.exe,拷成私有副本后以常驻服务(命名管道)跑,线协议与 macOS 逐字节相同;
 *     找源 / 拷贝 / 探协议 / 管道名 / 拉起见 computerHistoryWin.ts。Windows 没有要授的系统权限(axTrusted 恒真)。
 *  2. **单写者**:事件追加 / 清除重写 / 保留删除 / state.json 全排进同一条串行队列,清除的原子重写
 *     (tmp + rename)才不会吞掉并发追加、也不会把刚清掉的事件写回来。
 *  3. 清除 / 改排除表 = 关掉订阅再重开:连接一断,旧连接上迟到的事件按代号(gen)丢弃;
 *     helper 随之丢掉文本差分基线,下一条差分不会以被清掉的文本为底。
 *  4. helper 已按策略在读 AX 之前过滤;这里按同一份策略再过一遍(防御纵深 + 改表到重订阅之间的缝):
 *     排除 App / 域名、只记标题的 App 丢 text / click / key;text / click / key 不带 url 时按最近一条
 *     app / window 事件的情境补判。匹配口径与 helper 的 recorderBundleMatches 一致(不分大小写、`.*` 前缀通配)。
 *  5. 写盘失败不吞:整批退回缓冲(封顶)重试,连续失败把状态降级,别让托盘 / 设置 / 引擎继续说「记录中」。
 */
import net from 'node:net'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { appIconDataUrls } from './appIcons'
import { launchWindowsRecorder, type WindowsRecorderTarget } from './computerHistoryWin'
import { createSerialQueue } from './configWrite'
import {
  COMPUTER_HISTORY_KEEP_DAYS, COMPUTER_HISTORY_PROTOCOL,
  type ComputerHistoryEvent, type ComputerHistoryExclude, type ComputerHistorySession,
  type ComputerHistoryState, type ComputerHistoryStatus, type ComputerHistoryView,
} from '../shared/computerHistory'

const execFileP = promisify(execFile)

const DAY_MS = 86_400_000
const FLUSH_MS = 1_000
const PRUNE_EVERY_MS = 3_600_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** 订阅活过这么久才算「健康」,断开后退避从头来;否则一连上就被踢的 helper 会把我们拖进 1s 重连死循环。 */
const HEALTHY_MS = 30_000
/** 首条回包的等待上限(helper 回订阅结果不涉及截图 / AX 树,几百毫秒足够)。 */
const SUBSCRIBE_TIMEOUT_MS = 5_000
/** `open -n` 的节流:helper 靠 flock 让多余实例自行退出,但也别每次重试都起一个进程。 */
const LAUNCH_THROTTLE_MS = 30_000
/** 单行上限:helper 侧文本已封顶 500 字,远超此值 = 对端不是我们的 helper,直接断。 */
const MAX_LINE_BYTES = 1024 * 1024
const PAUSE_MAX_MS = 7 * DAY_MS
const EXCLUDE_CAP = 200
/** 写盘失败时缓冲最多攒这么多条(保新丢旧);单条 ≤ ~1.3KB,封顶约 2.6MB。 */
const BUFFER_CAP = 2_000
/** 写盘失败后的重试间隔;连续失败这么多次 → 状态降级。 */
const RETRY_FLUSH_MS = 5_000
const FAILS_BEFORE_DEGRADE = 2
/** 「排除 App」选择器:最多列这么多;首次查询时从盘上补旧的,每个日文件只读尾部、总量封顶(整读七天会卡主进程)。 */
const RECENT_APPS_LIMIT = 60
const RECENT_APPS_TAIL_BYTES = 256 * 1024
const RECENT_APPS_SCAN_BYTES = 1024 * 1024
/** 「关闭 / 暂停 / 收紧排除表」落配置失败后的后台重试:5s 起、翻倍、封顶 60s,直到写成(或意愿被新的操作取代)。 */
const PERSIST_RETRY_MIN_MS = 5_000
const PERSIST_RETRY_MAX_MS = 60_000
/** state.json 写失败后的重试:1s 起、翻倍、封顶 60s,直到盘上跟上最新一份。 */
const STATE_RETRY_MIN_MS = 1_000
const STATE_RETRY_MAX_MS = 60_000
/** 应用内「清空数据」等在途写落定的上限(每段);见 stopComputerHistoryForWipe。 */
const WIPE_CAP_MS = 10_000

/** 默认「只记切换与标题」:Forsion 自己(应用内动作归活动日志)+ 终端(命令行里常有密钥)。
 *  Windows 的 App 标识是小写 exe 文件名(见 shared 契约);两套并列下发,在另一个平台上匹配不到任何东西,无害。 */
export const DEFAULT_TITLE_ONLY_BUNDLE_IDS: readonly string[] = [
  'com.forsion.*',
  'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty', 'com.mitchellh.ghostty', 'io.alacritty',
  'forsion.exe',
  'windowsterminal.exe', 'openconsole.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'wezterm-gui.exe', 'alacritty.exe', 'mintty.exe', 'wt.exe',
]

const KINDS = new Set(['app', 'window', 'text', 'click', 'key', 'system'])
const STATES = new Set(['locked', 'unlocked', 'sleep', 'wake', 'dropped'])

const pad = (n: number): string => String(n).padStart(2, '0')
/** 本地日期 YYYY-MM-DD(按事件 t 分文件;引擎读端同口径)。 */
export const localDay = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/
/** 日文件覆盖的本地时间区间 [start, end)(走 Date 构造,夏令时那天不是 24h 也对)。 */
function dayRange(file: string): [number, number] | null {
  const m = DAY_FILE_RE.exec(file)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  return [new Date(y, mo, d).getTime(), new Date(y, mo, d + 1).getTime()]
}
/** 下一个本地 00:00(「暂停到明天」)。 */
export const nextLocalMidnight = (now: number): number => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

const errCode = (err: unknown): string => String((err as { code?: unknown })?.code ?? '')
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || 'unknown error'
const codeError = (code: string, message = code): Error => Object.assign(new Error(message), { code })

// ── 输入收敛 ─────────────────────────────────────────────────────────────────

const str = (v: unknown, cap: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, cap) : undefined)
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : undefined)

/** helper 推来的一条事件 → 白名单字段 + 长度封顶。形状不对 / 时间离谱(> 当前 5 分钟后或 1 天前)一律丢:
 *  t 决定落哪个日文件,一个假时间戳能造出一个永远不被保留期删掉的未来文件。 */
export function sanitizeEvent(raw: unknown, now: number): ComputerHistoryEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.t !== 'number' || !Number.isFinite(r.t) || r.t > now + 5 * 60_000 || r.t < now - DAY_MS) return null
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null
  const ev: ComputerHistoryEvent = { t: Math.trunc(r.t), kind: r.kind as ComputerHistoryEvent['kind'] }
  const a = r.app as Record<string, unknown> | undefined
  if (a && typeof a === 'object' && typeof a.name === 'string') {
    ev.app = { name: a.name.slice(0, 120) }
    const bid = str(a.bundleId, 255)
    if (bid) ev.app.bundleId = bid
    if (a.excluded === true) ev.app.excluded = true
  }
  // 断点标(无痕 / 排除时段之后的第一条情境事件):只认 app / window;不带时间与内容,排除标记上也留(折叠器靠它切段)
  if (r.resumed === true && (ev.kind === 'app' || ev.kind === 'window')) ev.resumed = true
  if (ev.app?.excluded) return ev // 被排除的 App 只留「切到了它」这一个事实,标题 / 文本一概不收
  const title = str(r.title, 200); if (title) ev.title = title
  const url = str(r.url, 300); if (url) ev.url = url
  const el = r.el as Record<string, unknown> | undefined
  if (el && typeof el === 'object' && typeof el.role === 'string') {
    ev.el = { role: el.role.slice(0, 64) }
    const label = str(el.label, 80); if (label) ev.el.label = label
  }
  const text = str(r.text, 500); if (text) ev.text = text
  if (r.truncated === true) ev.truncated = true
  const deleted = int(r.deleted); if (deleted !== undefined) ev.deleted = deleted
  if (r.bigEdit === true) ev.bigEdit = true
  const keys = str(r.keys, 32); if (keys) ev.keys = keys
  if (typeof r.state === 'string' && STATES.has(r.state)) ev.state = r.state as ComputerHistoryEvent['state']
  const count = int(r.count); if (count !== undefined) ev.count = count
  if (r.origin === 'agent') ev.origin = 'agent'
  return ev
}

// Windows 的 App 标识是 exe 文件名,能带空格、逗号、括号、非 ASCII(`Code - Insiders.exe`、`Acme, Inc.exe`)——按 Windows
// 文件名规则收(只拒路径分隔与保留字符、控制字符):收窄就会把用户排除的 App 悄悄丢掉、照样被记录。macOS bundle id 是它的子集。
const BUNDLE_ID_RE = /^[^\s<>:"/\\|?\u0000-\u001f][^<>:"/\\|?\u0000-\u001f]{0,254}$/u
/** 用户排除表收敛(渲染层来的,当不可信输入):bundle id 字符集 + 域名规整成 punycode 主机名,去重封顶。 */
export function normalizeExclude(raw: unknown): ComputerHistoryExclude {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { apps?: unknown; domains?: unknown }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const apps = [...new Set(list(r.apps).map((s) => s.trim()).filter((s) => BUNDLE_ID_RE.test(s)))].slice(0, EXCLUDE_CAP)
  const domains: string[] = []
  for (const s of list(r.domains)) {
    const host = normalizeDomain(s)
    if (host && !domains.includes(host)) domains.push(host)
    if (domains.length >= EXCLUDE_CAP) break
  }
  return { apps, domains }
}
function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '')
  if (!s || s.length > 253) return null
  try { s = new URL(s.includes('://') ? s : `http://${s}`).hostname } catch { return null }
  s = s.replace(/^\.+|\.+$/g, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) ? s : null
}

/** next 里有 cur 没有的排除项(App 不分大小写,与 bundleMatches 同口径;域名已规整成小写)→ 返回 cur ∪ next(只加不减);
 *  没有新增 → null。setExclude 用它让收紧当场生效。 */
export function tightenExclude(cur: ComputerHistoryExclude, next: ComputerHistoryExclude): ComputerHistoryExclude | null {
  const haveApps = new Set(cur.apps.map((a) => a.toLowerCase()))
  const addApps = next.apps.filter((a) => !haveApps.has(a.toLowerCase()))
  const addDomains = next.domains.filter((d) => !cur.domains.includes(d))
  if (!addApps.length && !addDomains.length) return null
  return { apps: [...cur.apps, ...addApps], domains: [...cur.domains, ...addDomains] }
}

/** URL 主机名命中排除域名(自身或子域)。 */
export function hostExcluded(url: string, domains: readonly string[]): boolean {
  if (!domains.length) return false
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** 下发给 helper 的策略:用户排除表 + 默认 titleOnly(Forsion 自己、终端)。排除优先于 titleOnly。 */
export interface RecordPolicy {
  excludeBundleIds: string[]
  titleOnlyBundleIds: string[]
  excludeDomains: string[]
  text: boolean
  clicks: boolean
  keys: boolean
}
export function buildPolicy(exclude: ComputerHistoryExclude, selfBundleId?: string): RecordPolicy {
  const excluded = new Set(exclude.apps)
  const titleOnly = [...new Set([...DEFAULT_TITLE_ONLY_BUNDLE_IDS, ...(selfBundleId ? [selfBundleId] : [])])].filter((b) => !excluded.has(b))
  return { excludeBundleIds: [...exclude.apps], titleOnlyBundleIds: titleOnly, excludeDomains: [...exclude.domains], text: true, clicks: true, keys: true }
}

/** bundle id 匹配,与 helper 的 recorderBundleMatches 同口径:不分大小写;精确,或以「.*」结尾的前缀通配。 */
export function bundleMatches(bundleId: string, pattern: string): boolean {
  const id = bundleId.toLowerCase(), rule = pattern.toLowerCase()
  return rule.endsWith('.*') ? id.startsWith(rule.slice(0, -1)) : id === rule
}

/** 最近一条 app / window 事件的情境(过滤后):text / click / key 自己不带 url / bundleId 时按它补判。 */
export interface FilterContext {
  bundleId?: string
  url?: string
  /** 那条情境事件被排除了(helper 标的或这里判的)。 */
  excluded: boolean
}

const sameBundle = (a?: string, b?: string): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

/**
 * 落盘前按策略再过一遍(helper 已按同一份策略过滤过,这里是防御纵深):
 *  - 排除的 App:只留一条不带标题的 `app` 切换事实;它里面的 `window` 事件(换窗口 / 改标题)整条丢 —— 哪怕去掉了标题,
 *    落盘的时间与次数也在泄露被排除对象内部的活动;text / click / key 整条丢。
 *  - 排除的站点(含子域)与 helper 标了 excluded 的:窗口事件降成一条不带内容的标记,且同一 App 连续只留一条
 *    (切进去那一下要留:否则折叠会把这段时间记到上一个页面头上;之后在站内的标题 / 网址变化不再记)。
 *  - 只记标题的 App(终端 / Forsion 自己):text / click / key 整条丢;
 *  - text / click / key 属于当前情境(同 App 或没带 bundleId)时:情境被排除 → 丢(不看自己带的 url:helper 标的 excluded
 *    分不清是 App 还是站点,宁可多丢);自己没带 url 而情境 url 命中排除域名 → 丢。
 */
export function applyExclude(
  ev: ComputerHistoryEvent,
  exclude: ComputerHistoryExclude,
  opts: { titleOnly?: readonly string[]; context?: FilterContext | null } = {},
): ComputerHistoryEvent | null {
  const appHit = (b?: string): boolean => !!b && exclude.apps.some((p) => bundleMatches(b, p))
  const windowish = ev.kind === 'app' || ev.kind === 'window'
  const c = opts.context
  // 排除标记只带时间 + App + 断点标(resumed 不含任何内容,但丢了它折叠器就会把无痕时段并进排除段)
  const marker = (kind: 'app' | 'window', app: NonNullable<ComputerHistoryEvent['app']>): ComputerHistoryEvent =>
    ({ t: ev.t, kind, app: { ...app, excluded: true }, ...(ev.resumed ? { resumed: true as const } : {}) })
  if (appHit(ev.app?.bundleId)) {
    return ev.kind === 'app' && ev.app ? marker('app', ev.app) : null
  }
  if (ev.app?.excluded || (!!ev.url && hostExcluded(ev.url, exclude.domains))) {
    if (!windowish || !ev.app) return null
    // 已经标过了 —— 除非带断点标(「排除站点 → 无痕 → 回到同一排除站点」:中间那段不能算进前一个排除段)
    if (ev.kind === 'window' && !ev.resumed && c?.excluded && sameBundle(c.bundleId, ev.app.bundleId)) return null
    return marker(ev.kind as 'app' | 'window', ev.app)
  }
  if (windowish || ev.kind === 'system') return ev
  const sameApp = !!c && (!ev.app?.bundleId || !c.bundleId || ev.app.bundleId.toLowerCase() === c.bundleId.toLowerCase())
  const bid = ev.app?.bundleId ?? (sameApp ? c?.bundleId : undefined)
  if (bid && opts.titleOnly?.some((p) => bundleMatches(bid, p))) return null
  if (c && sameApp && (c.excluded || appHit(c.bundleId) || (!ev.url && !!c.url && hostExcluded(c.url, exclude.domains)))) return null
  return ev
}

/** 本 App 的 bundle id(packaged:Forsion 的 appId;dev:com.github.Electron)。读 execPath 旁的 Info.plist,
 *  二进制 plist / 读不到就 undefined(还有 `com.forsion.*` 兜着)。
 *  win32:App 标识 = 小写 exe 文件名(打包版 forsion.exe,dev electron.exe),与 helper 事件里的 app.bundleId 同口径。 */
export function readSelfBundleId(execPath: string, platform: string = process.platform): string | undefined {
  if (platform === 'win32') return path.win32.basename(execPath).toLowerCase() || undefined
  if (platform !== 'darwin') return undefined
  try {
    const plist = readFileSync(path.join(path.dirname(execPath), '..', 'Info.plist'), 'utf8')
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch { return undefined }
}

// ── 折叠(设置页预览;引擎工具与 Muse 摘要有自己的一份,同口径) ─────────────────

const snippet = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 80)

/** 情境键:与 helper 的 recorderContextKey(activity_recorder.swift)同口径 —— App(bundleId,没有就名字)+ 排除标 + 标题 + 网址,
 *  不看 kind / origin。helper 按它对连着的情境事件去重,所以落盘里连着两条同键 = 中间有被压掉的东西(见 foldSessions)。 */
const contextKey = (ev: ComputerHistoryEvent): string =>
  [ev.app?.bundleId || ev.app?.name || '', ev.app?.excluded ? 'x' : '', ev.title ?? '', ev.url ?? ''].join('\u001F')

/**
 * 连续同 App + 同标题的事件合成一段。app / window 事件定义「当前窗口」;text / click / key 归入当前段
 * (同 App 时沿用当前标题)。锁屏 / 睡眠收尾当前段;两条事件间隔超 gapMs 视作中断(Forsion 没开 = 没记录,
 * 不能把整段空白算给上一个窗口)。同键段之间只夹着短段(总缝隙 ≤ 60s)的并回一段;最后丢掉短于 minMs 且没打字的段。
 * 排除标记(app.excluded)自成一段:键里带排除状态(无标题的正常页面与紧随的无标题排除标记不同键),往回并段也绝不
 * 跨过它 —— 哪怕它短于 minMs 最后被丢掉,边界照留,否则排除期间的时长会算到前一个页面(及其网址)头上。
 * 排除段不收网址、不收打字。输入须按 t 升序;输出按时间升序。
 *
 * 重复的相同情境事件 = 会话边界:helper 对同一订阅者连着的同键 app / window 事件去重(键 = contextKey,与 helper 的
 * recorderContextKey 同口径,不看 kind / origin),所以落盘里连着两条同键情境事件只可能是中间有被压掉的东西 —— 无痕窗口
 * (进出都不发 window 事件:「普通窗口 A → 无痕 → 回到 A」到这里就是两条一模一样的 A),或(重)订阅补拍的快照。
 * 中间那段时长未知:当前段收在它自己最后一条事件(不延到重复那条),重复那条另起一段且标 gapBefore;往回并段绝不跨过它,
 * 否则两段 ≤ 60s 的并段会把无痕期间重新算回 A。锁屏 / 睡眠 / 解锁 / 唤醒清掉「上一条情境」:helper 解锁后会重拍一次前台,
 * 锁屏本身已经收尾了当前段,那条重拍不另算边界。
 * 新 helper 在这类时段之后的第一条情境事件上打 `resumed`(见 shared 契约):见到它同样切段、标 gapBefore —— 连前后
 * 不同键的情况也覆盖(「A → 无痕 → 同标题换网址的 B」)。重复同键的判法留着兜老 helper。
 */
export function foldSessions(events: readonly ComputerHistoryEvent[], opts: { minMs?: number; gapMs?: number } = {}): ComputerHistorySession[] {
  const minMs = opts.minMs ?? 10_000
  const gapMs = opts.gapMs ?? 30 * 60_000
  type Span = ComputerHistorySession & { key: string; appKey: string; last: number; hasText: boolean; excluded: boolean; gapBefore: boolean }
  const spans: Span[] = []
  let cur: Span | null = null
  let lastCtx: string | null = null
  const close = (at: number): void => { if (cur) { cur.end = Math.max(cur.start, at); cur = null } }
  // 排除段遇断点:只有断点属于别的 App 才延到断点那一刻 —— App 切换一定被观察到(切进无痕也会发一条无标题切换),
  // 那是确切的结束边界;同 App 内的断点(排除站点 → 同浏览器无痕 → 普通页)结束时刻不明,收在最后一条已知事件。
  // 这一判断先于 30 分钟空档规则,否则在排除 App 里待久了会被空档规则收在起点(creview4 P2)。
  const endsExcludedAt = (ev: ComputerHistoryEvent): boolean =>
    !!cur && cur.excluded && ev.resumed === true && (ev.kind === 'app' || ev.kind === 'window') &&
    !!ev.app && (ev.app.bundleId || ev.app.name) !== cur.appKey
  for (const ev of events) {
    if (cur && ev.t - cur.last > gapMs && !endsExcludedAt(ev)) close(cur.last)
    if (ev.kind === 'system') {
      if (ev.state === 'locked' || ev.state === 'sleep') close(ev.t)
      if (ev.state !== 'dropped') lastCtx = null
      continue
    }
    if (!ev.app) continue
    let gapBefore = false
    if (ev.kind === 'app' || ev.kind === 'window') {
      const ctx = contextKey(ev)
      // helper 的断点标(resumed)与「重复的相同情境」同待:之前有一段没被记录的时长,不归前后任何一段
      if (ctx === lastCtx || ev.resumed) {
        gapBefore = true
        // 收在它自己最后一条事件,中间那段不归它;排除段遇别的 App 的断点例外(见 endsExcludedAt)
        if (cur) close(endsExcludedAt(ev) ? ev.t : cur.last)
      }
      lastCtx = ctx
    }
    const appKey = ev.app.bundleId || ev.app.name
    // text / click / key 同 App 时归入当前段:标题与排除状态都沿用当前段的
    const inherit = ev.kind !== 'app' && ev.kind !== 'window' && !!cur && cur.appKey === appKey
    const title = inherit ? cur!.title : ev.title
    const excluded = inherit ? cur!.excluded : ev.app.excluded === true
    const key = `${appKey}\u0000${excluded ? 'x' : ''}\u0000${title ?? ''}`
    if (!cur || cur.key !== key) {
      close(ev.t)
      const span: Span = { start: ev.t, end: ev.t, app: ev.app.name, typed: [], key, appKey, last: ev.t, hasText: false, excluded, gapBefore }
      if (ev.app.bundleId) span.bundleId = ev.app.bundleId
      if (title) span.title = title
      spans.push(span)
      cur = span
    }
    cur.last = ev.t
    if (cur.excluded) continue
    if (ev.url) cur.url = ev.url
    if (ev.kind === 'text' && ev.text && ev.origin !== 'agent') {
      cur.hasText = true
      if (cur.typed.length < 3) cur.typed.push(snippet(ev.text))
    }
  }
  close((cur as Span | null)?.last ?? 0)
  const short = (s: Span): boolean => s.end - s.start < minMs && !s.hasText
  const out: Span[] = []
  for (const s of spans) {
    // 往回跳过夹在中间的短段(切出去瞄一眼又切回来),同键且总缝隙 ≤ 60s → 并回前一段,短段一并吞掉;
    // 排除标记与 gapBefore 段不跳过,gapBefore 段自己也不往回并(它前面是一段时长未知的空白)
    let j = out.length - 1
    while (j >= 0 && short(out[j]) && !out[j].excluded && !out[j].gapBefore && out[j].key !== s.key) j--
    const prev = s.gapBefore ? undefined : out[j]
    if (prev && prev.key === s.key && s.start - prev.end <= 60_000) {
      prev.end = s.end
      if (s.url) prev.url = s.url
      prev.hasText ||= s.hasText
      for (const t of s.typed) if (prev.typed.length < 3) prev.typed.push(t)
      out.length = j + 1
      continue
    }
    out.push(s)
  }
  return out.filter((s) => !short(s)).map(({ key: _k, appKey: _a, last: _l, hasText: _h, excluded: _x, gapBefore: _g, ...s }) => s)
}

// ── 落盘 ─────────────────────────────────────────────────────────────────────

/** `<root>/events/YYYY-MM-DD.jsonl` + `<root>/state.json`。目录 0700、文件 0600。调用方负责串行(单写者)。 */
export class ComputerHistoryStore {
  private rootReady = false
  /** 关门(「清空数据」的 dispose discard):在途那笔写的后续步骤不再建目录 / 写文件,免得把马上要整删的目录建回来。 */
  private closed = false

  constructor(readonly root: string, private readonly tmExclude?: (root: string) => Promise<unknown>) {}

  get eventsDir(): string { return path.join(this.root, 'events') }
  get statePath(): string { return path.join(this.root, 'state.json') }

  close(): void { this.closed = true }

  /** 建目录;首次建出根目录时打一次 Time Machine 排除(粘性,best-effort):7 天保留期管不住进了备份的副本。 */
  async ensureRoot(): Promise<void> {
    if (this.closed) throw codeError('store_closed')
    if (this.rootReady && existsSync(this.eventsDir)) return
    const created = !existsSync(this.root)
    await mkdir(this.eventsDir, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700).catch(() => {})
    await chmod(this.eventsDir, 0o700).catch(() => {})
    if (created && this.tmExclude) void this.tmExclude(this.root).catch(() => {})
    this.rootReady = true
  }

  async append(events: readonly ComputerHistoryEvent[]): Promise<void> {
    if (!events.length) return
    await this.ensureRoot()
    for (const [day, lines] of groupByDay(events)) {
      if (this.closed) throw codeError('store_closed') // ensureRoot 慢了一拍、期间关了门:别再写(会建出日文件)
      await appendFile(path.join(this.eventsDir, `${day}.jsonl`), lines, { encoding: 'utf8', mode: 0o600 })
    }
  }

  /** 退出时的同步兜底(before-quit 等不了异步)。 */
  appendSync(events: readonly ComputerHistoryEvent[]): void {
    if (!events.length || !existsSync(this.eventsDir)) return
    for (const [day, lines] of groupByDay(events)) {
      appendFileSync(path.join(this.eventsDir, `${day}.jsonl`), lines, { encoding: 'utf8', mode: 0o600 })
    }
  }

  private async dayFiles(): Promise<string[]> {
    try { return (await readdir(this.eventsDir)).filter((f) => DAY_FILE_RE.test(f)).sort() } catch { return [] }
  }

  /** 盘上有事件的日子(YYYY-MM-DD);清除后剩下的空文件不算。 */
  async days(): Promise<string[]> {
    const out: string[] = []
    for (const f of await this.dayFiles()) {
      const size = await stat(path.join(this.eventsDir, f)).then((s) => s.size, () => 0)
      if (size > 0) out.push(f.slice(0, 10))
    }
    return out
  }

  /** 保留期:删整天都早于 now - keepDays 的日文件 + 崩溃留下的重写临时文件;截止时刻落在其中的那天按事件时间原子重写,
   *  只留 t >= now - keepDays 的行(否则那天凌晨的事件要多留近一天)。返回删掉的文件名(重写的不算)。
   *  不需要像清除那样挡 dispose 的同步追加:截止那天至少是 6 天前,sanitizeEvent 不收早于 1 天的事件,追加落不到它头上。 */
  async prune(now: number, keepDays = COMPUTER_HISTORY_KEEP_DAYS): Promise<string[]> {
    const cutoffT = now - keepDays * DAY_MS
    const cutoff = localDay(cutoffT)
    let names: string[] = []
    try { names = await readdir(this.eventsDir) } catch { return [] }
    const removed: string[] = []
    for (const f of names) {
      if ((DAY_FILE_RE.test(f) && f.slice(0, 10) < cutoff) || f.endsWith('.tmp')) {
        await rm(path.join(this.eventsDir, f), { force: true })
        removed.push(f)
      } else if (DAY_FILE_RE.test(f) && f.slice(0, 10) === cutoff) {
        const file = path.join(this.eventsDir, f)
        // 每小时都逐行过一遍(流式 + 前缀正则,便宜;一行没丢就不动文件)。⚠️不能凭首行跳过:文本事件带的是最后一次编辑的
        // 时间,却在去抖之后才写入,日文件里的 t 不严格递增 —— 首行在期内不代表后面没有过期行(creview4 P1)。
        if (await this.rewriteKeeping(file, (t) => t >= cutoffT)) removed.push(f)
      }
    }
    return removed
  }

  /** 日文件只留 keep(t) 为真的行(解析不了的残行一并删),原子重写(tmp + rename);一行不剩就删文件,一行没丢就不动。
   *  返回文件是否被删。调用方负责串行(单写者)。
   *  跑在主进程上:流式按 64KB 分块读(块与块之间让出事件循环),每行只用前缀正则取 t(不逐行 JSON.parse),
   *  重度用户一天几十 MB 的日文件也不会把主进程 / 同一写队列里的追加卡住。 */
  private async rewriteKeeping(file: string, keep: (t: number) => boolean): Promise<boolean> {
    const kept: string[] = []
    let total = 0
    let carry = ''
    const take = (line: string): void => {
      if (!line) return
      total++
      const t = eventT(line)
      if (t !== null && keep(t)) kept.push(line)
    }
    for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
      const parts = (carry + (chunk as string)).split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) take(line)
    }
    take(carry)
    if (!kept.length) { await rm(file, { force: true }); return true }
    if (kept.length === total) return false
    const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(tmp, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    return false
  }

  /** all:删全部日文件;sinceMs:删 t >= sinceMs 的事件(整天落在范围内的直接删,跨界那天原子重写)。 */
  async clear(opts: { sinceMs?: number; all?: boolean }): Promise<void> {
    let names: string[] = []
    try { names = await readdir(this.eventsDir) } catch { return }
    for (const f of names) {
      const file = path.join(this.eventsDir, f)
      if (opts.all) { if (DAY_FILE_RE.test(f) || f.endsWith('.tmp')) await rm(file, { force: true }); continue }
      const range = dayRange(f)
      const since = opts.sinceMs as number
      if (!range || range[1] <= since) continue
      if (range[0] >= since) { await rm(file, { force: true }); continue }
      await this.rewriteKeeping(file, (t) => t < since) // 解析不了的残行一并删(可能正是范围内事件的半截)
    }
  }

  /** [from, to] 内的事件,按 t 升序。 */
  async readRange(from: number, to: number): Promise<ComputerHistoryEvent[]> {
    const out: ComputerHistoryEvent[] = []
    for (const f of await this.dayFiles()) {
      const range = dayRange(f)
      if (!range || range[1] <= from || range[0] > to) continue
      let text = ''
      try { text = await readFile(path.join(this.eventsDir, f), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        const ev = parseLine(line)
        if (ev && ev.t >= from && ev.t <= to) out.push(ev)
      }
    }
    return out.sort((a, b) => a.t - b.t)
  }

  /** 最近出现过的 App(新的在前,去重,跳过被排除的)。只解析 kind:"app" 行;有界:每个日文件只读尾部 tailBytes、
   *  总共不超过 maxBytes —— 重度用户一天几 MB,整读七天再逐行正则会把主进程卡上百毫秒。 */
  async recentApps(limit: number, maxBytes = RECENT_APPS_SCAN_BYTES, tailBytes = RECENT_APPS_TAIL_BYTES): Promise<Array<{ name: string; bundleId: string }>> {
    const out: Array<{ name: string; bundleId: string }> = []
    const seen = new Set<string>()
    let budget = maxBytes
    for (const f of (await this.dayFiles()).reverse()) {
      if (budget <= 0) break
      let text = ''
      try {
        const tail = await readTail(path.join(this.eventsDir, f), Math.min(tailBytes, budget))
        text = tail.text
        budget -= Math.max(1, tail.bytes)
      } catch { continue }
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/"kind"\s*:\s*"app"/.test(lines[i])) continue
        const app = parseLine(lines[i])?.app
        if (!app?.bundleId || app.excluded || seen.has(app.bundleId)) continue
        seen.add(app.bundleId)
        out.push({ name: app.name, bundleId: app.bundleId })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /** commit:rename 前最后问一次还要不要落(退出时 dispose 已同步写过非录制态,在途的旧状态不能再盖回去)。 */
  async writeState(state: ComputerHistoryState, commit: () => boolean = () => true): Promise<void> {
    await this.ensureRoot()
    const tmp = `${this.statePath}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
      if (!commit() || this.closed) { await rm(tmp, { force: true }); return }
      await rename(tmp, this.statePath)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  writeStateSync(state: ComputerHistoryState): void {
    if (!existsSync(this.root)) return
    const tmp = `${this.statePath}.${process.pid}-${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.statePath)
  }
}

function groupByDay(events: readonly ComputerHistoryEvent[]): Map<string, string> {
  const byDay = new Map<string, string>()
  for (const ev of events) {
    const day = localDay(ev.t)
    byDay.set(day, (byDay.get(day) ?? '') + JSON.stringify(ev) + '\n')
  }
  return byDay
}

/** 读文件最后 maxBytes 字节;没从头读时第一行多半是半截(可能还切在多字节字符中间),丢掉。 */
async function readTail(file: string, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.max(0, Math.min(size, maxBytes))
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, size - len)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return { text: len < size ? text.slice(text.indexOf('\n') + 1) : text, bytes: bytesRead }
  } finally {
    await fh.close()
  }
}

/** state.json 里的 dataGen(读不到 / 老文件没有 = 0)。 */
function readDataGen(file: string): number {
  try {
    const g = (JSON.parse(readFileSync(file, 'utf8')) as { dataGen?: unknown })?.dataGen
    return typeof g === 'number' && Number.isSafeInteger(g) && g >= 0 ? g : 0
  } catch { return 0 }
}

function parseLine(line: string): ComputerHistoryEvent | null {
  if (!line) return null
  try {
    const ev = JSON.parse(line) as ComputerHistoryEvent
    return ev && typeof ev.t === 'number' ? ev : null
  } catch { return null }
}

/** 落盘的每行都是 `{"t":<整数>,…}`(sanitizeEvent / applyExclude 都先放 t,JSON.stringify 按插入序)。 */
const T_PREFIX_RE = /^\{"t":(-?\d{1,16})[,}]/
/** 一行的 t:前缀正则 + 结尾是 `}`(整行没被截断)就不必 JSON.parse;形状不符(手改过 / 键序不同)才退回完整解析。
 *  解析不了 = null(残行)。 */
export function eventT(line: string | null): number | null {
  if (!line) return null
  const m = T_PREFIX_RE.exec(line)
  if (m && line.endsWith('}')) return Number(m[1])
  const t = parseLine(line)?.t
  return typeof t === 'number' ? t : null
}


// ── 订阅连接 ─────────────────────────────────────────────────────────────────

export interface RecorderSubscription {
  /** 首条回包:ok 且协议 ≥ 13 → 解析;否则 reject,err.code ∈ helper 错误码 / helper_outdated / ENOENT… */
  ready: Promise<{ protocolVersion: number; axTrusted: boolean }>
  /** 连接结束(对端关 / 出错 / 我方 close)后 resolve,永不 reject。 */
  closed: Promise<void>
  close(): void
}

let subSeq = 0

/** 开一条专用长连接:发一行 recordSubscribe,读首条回包,之后每行一个 `{"ev":{…}}`。 */
export function openRecorderSubscription(
  socketPath: string,
  policy: RecordPolicy,
  onEvent: (raw: unknown) => void,
  timeoutMs = SUBSCRIBE_TIMEOUT_MS,
): RecorderSubscription {
  let replied = false
  let resolveReady!: (v: { protocolVersion: number; axTrusted: boolean }) => void
  let rejectReady!: (e: Error) => void
  let resolveClosed!: () => void
  const ready = new Promise<{ protocolVersion: number; axTrusted: boolean }>((res, rej) => { resolveReady = res; rejectReady = rej })
  ready.catch(() => {}) // 调用方可能只 await closed
  const closed = new Promise<void>((res) => { resolveClosed = res })
  const socket = net.createConnection(socketPath)
  const reject = (err: Error): void => { if (!replied) { replied = true; clearTimeout(timer); rejectReady(err) } }
  const timer = setTimeout(() => { reject(codeError('client_timeout')); socket.destroy() }, timeoutMs)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(`${JSON.stringify({ id: `ch_${++subSeq}`, cmd: 'recordSubscribe', policy })}\n`))
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    if (buffer.length > MAX_LINE_BYTES) { reject(codeError('line_too_long')); socket.destroy(); return }
    for (const line of lines) {
      if (socket.destroyed) return
      if (!line.trim()) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (!replied) {
        replied = true
        clearTimeout(timer)
        if (msg?.ok !== true) {
          rejectReady(codeError(String(msg?.error?.code || 'helper_error'), String(msg?.error?.message || 'helper error')))
          socket.destroy()
          return
        }
        const pv = typeof msg.result?.protocolVersion === 'number' ? msg.result.protocolVersion : 0
        if (pv < COMPUTER_HISTORY_PROTOCOL) { rejectReady(codeError('helper_outdated')); socket.destroy(); return }
        resolveReady({ protocolVersion: pv, axTrusted: msg.result?.axTrusted !== false })
        continue
      }
      if (msg && typeof msg === 'object' && msg.ev !== undefined) onEvent(msg.ev)
    }
  })
  socket.on('error', (err) => reject(Object.assign(err, { code: errCode(err) || 'socket_error' })))
  socket.on('close', () => { reject(codeError('closed')); resolveClosed() })
  return { ready, closed, close: () => socket.destroy() }
}

/** 探一下 socket 有没有人在听(拉起 helper 后等它 bind)。 */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath)
    const done = (ok: boolean): void => { s.destroy(); resolve(ok) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), 500).unref?.()
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 连接失败码 → 状态。 */
export function statusForError(err: unknown): ComputerHistoryStatus {
  const code = errCode(err)
  if (code === 'accessibility_denied') return 'no_permission'
  if (code === 'unknown_command' || code === 'helper_outdated') return 'helper_outdated'
  if (code === 'helper_missing') return 'helper_missing'
  return 'disconnected'
}

// ── 控制器 ───────────────────────────────────────────────────────────────────

export interface ComputerHistoryConfig {
  computerHistoryEnabled?: boolean
  computerHistoryPausedUntil?: number | null
  computerHistoryExclude?: Partial<ComputerHistoryExclude>
}

/** 写回配置的补丁(排除表总是整份、已收敛)。 */
export interface ComputerHistoryPersistPatch {
  computerHistoryEnabled?: boolean
  computerHistoryPausedUntil?: number | null
  computerHistoryExclude?: ComputerHistoryExclude
}

/** 这一次连接的 helper 端点 + 拉起参数(launchHelper 的入参)。 */
export interface HelperLaunchTarget {
  /** darwin:unix socket 路径;win32:命名管道名。 */
  socketPath: string
  /** win32:要拉起的私有副本 exe。 */
  exe?: string
}

export interface ComputerHistoryDeps {
  root: string
  platform: string
  /** darwin 的 helper socket(win32 不用:管道名每次连接由 windowsRecorder 现给)。 */
  socketPath: string
  /** PI_CU_SOCKET_PATH 指向外部 helper:不替它拉起(同 desktopPermissions.prepareHelper)。只对 darwin 有意义。 */
  externalSocket: boolean
  /** 每次现取:helper 可能在运行中才被权限页装进 /Applications 或 ~/Applications。darwin 专用。 */
  helperAppPath: () => string
  /** win32:每次连接现取录制服务(找源 → 私有副本 → 探协议 → 管道名,见 computerHistoryWin.createWindowsRecorderResolver)。
   *  null / 缺省 = 没有源(helper_missing);protocol 为 null 或 < 13 = helper_outdated;reject = 一时失败(disconnected + 退避)。 */
  windowsRecorder?(): Promise<WindowsRecorderTarget | null>
  selfBundleId?: string
  /** 写回桌面配置(SHELL_KEYS)。函数形态 = 在配置写队列里、紧挨写盘前才求值(main 的 saveConfig 原生支持;后台补落用它
   *  在写盘那一刻复核代号,见 persistOwed)。 */
  persist(patch: ComputerHistoryPersistPatch | (() => ComputerHistoryPersistPatch)): Promise<unknown>
  /** 缺省:darwin = `open -n -g <helper.app> --args serve --socket <sock>`(与 CU 插件 / 权限页同一条拉起路径);
   *  win32 = 分离拉起 `<exe> serve --pipe <pipe>`(computerHistoryWin.launchWindowsRecorder)。 */
  launchHelper?(target: HelperLaunchTarget): Promise<void>
  /** 权限页正在关停 / 重装 helper(DesktopPermissions.helperBusy)。为真时绝不 `open -n`:关停→装新之间拉起的是
   *  **旧包**,它占住 helper 的锁,随后新包一启动就退,helper 永远停在旧协议(状态卡死在 helper_outdated)。
   *  只管 darwin(Windows 跑的是自己的私有副本,权限页碰不到它)。 */
  helperBusy?(): boolean
  /** 上面那段忙完时回调(DesktopPermissions.onHelperIdle),返回取消订阅:忙完立刻重连一次,不干等退避。 */
  onHelperIdle?(cb: () => void): () => void
  /** 缺省:`tmutil addexclusion <root>`(仅 darwin)。 */
  tmExclude?(root: string): Promise<unknown>
  openFolder?(dir: string): Promise<unknown>
  now?(): number
  onChanged?(view: ComputerHistoryView): void
}

export class ComputerHistory {
  readonly store: ComputerHistoryStore
  readonly ready: Promise<void>
  private markReady!: () => void
  private readonly now: () => number
  private readonly queue = createSerialQueue()
  /** 意愿操作队列:开关 / 暂停 / 恢复 / 改排除表 / 清除的**落配置**(和清除本身)按调用顺序一个个来,后台补落「关」也排这里 ——
   *  盘上最后留下的永远是最后发出的那个意愿,补落也插不进别的操作的落盘中间。 */
  private readonly ops = createSerialQueue()
  /** 意愿代号(按字段分):每个改 enabled / pausedUntil / 排除表的操作发出时 +1。「开始录」的操作(开 / 恢复)先落配置、
   *  回来再改内存 —— 期间有更新的操作发出过(代号变了)就不再改那个字段,否则旧的「开」会把之后的「关 / 暂停」冲掉。
   *  「停录」的操作(关 / 暂停)当场改内存,所以只能靠这个代号挡住在途的「开」,光把落盘排成队挡不住。 */
  private enableSeq = 0
  private pauseSeq = 0
  private excludeSeq = 0
  /** 数据代次(state.json dataGen):清除(前后各一次)/ 改排除表 / 关闭时 +1,读者据此丢掉与之交错的读取结果。 */
  private dataGen: number
  /** View 版本:每拍一张快照 +1(主进程单线程,快照先后 = 状态先后),设置页只收更大的。 */
  private rev = 0
  /** >0 = 有操作按住连接(清除进行中):任何 refresh 都不重连,免得清除途中新事件落进来又被这次清除删掉。 */
  private holds = 0
  /** 欠着没落进配置的字段:「停录」侧的操作(关 / 暂停 / 收紧排除表)先改内存再落配置,落失败就记在这里,后台按退避
   *  把这些字段的**当前内存值**补落(内存永远是最新的意愿,所以之后的操作天然取代之前的)。任何一次成功落了某字段 = 盘上
   *  已跟上(之后再改内存的操作各自排着自己的落盘),从这里删掉;删空才算还清。 */
  private readonly owed = new Set<keyof ComputerHistoryPersistPatch>()
  /** 最近一次欠账落配置失败的错误原文(非空 = 有欠账,后台在重试;设置页据此提示重启可能恢复记录 / 丢掉新排除)。 */
  private persistError: string | null = null
  private persistRetryTimer?: ReturnType<typeof setTimeout>
  private persistRetryDelay = PERSIST_RETRY_MIN_MS
  /** 清除的原子重写进行中(dispose 的同步追加会被它的 rename 吞掉,此时不插)。 */
  private rewriting = false

  private enabled = false
  private pausedUntil: number | null = null
  private exclude: ComputerHistoryExclude = { apps: [], domains: [] }
  private policyMemo: { exclude: ComputerHistoryExclude; policy: RecordPolicy } | null = null
  /** 连接层结论(recording / disconnected / no_permission / helper_*);对外 status 还要叠加开关 / 暂停 / 平台。 */
  private connStatus: ComputerHistoryStatus = 'disconnected'
  /** 连续写盘失败:连着 helper 也不算「记录中」(对外降成 disconnected;没有专门的状态值)。 */
  private storeFailing = false
  private appendFailures = 0
  /** 最近一条 app / window 事件的情境(applyExclude 给 text / click / key 补判用);每条新订阅从空开始。 */
  private current: FilterContext | null = null
  /** 最近见过的 App:bundleId → name,Map 插入序 = 旧→新。事件流实时喂;首次查询时从盘上有界地补一次旧的。 */
  private seenApps = new Map<string, string>()
  private seenAppsSeeded = false
  private seenAppsEpoch = 0
  private state: ComputerHistoryState
  /** 最新一份状态的签名(去重 + 推送用;refresh 算出来就记)。 */
  private lastSig = ''
  /** 盘上 state.json 确认写成的那份签名 —— **写成才记**:写失败时它落后于 lastSig,重试计时器据此补写。 */
  private lastWritten = ''
  /** 盘上 state.json 的 dataGen(写成才更新;失败关门删掉之后 = null)。关闭 / 代次变化的那份写不进去时据此判断要不要删。 */
  private diskDataGen: number | null
  private stateRetryTimer?: ReturnType<typeof setTimeout>
  private stateRetryDelay = STATE_RETRY_MIN_MS
  /** state.json 没写成的错误原文(要关门的那份连删也失败时两段都在);盘上跟上最新一份即清(设置页据此提示)。 */
  private stateError: string | null = null

  /** 连接代号:每次主动断开 +1;旧代号的连接尝试 / 迟到事件一律作废。 */
  private gen = 0
  private sub: RecorderSubscription | null = null
  private subSince = 0
  private connecting = false
  private lastAttemptAt = 0
  private backoff = BACKOFF_MIN_MS
  private lastLaunchAt = 0

  private buffer: ComputerHistoryEvent[] = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private pauseTimer?: ReturnType<typeof setTimeout>
  private pruneTimer?: ReturnType<typeof setInterval>
  private offHelperIdle?: () => void
  private started = false
  private disposed = false

  constructor(private readonly d: ComputerHistoryDeps) {
    this.now = d.now ?? Date.now
    this.store = new ComputerHistoryStore(d.root, d.tmExclude ?? (d.platform === 'darwin'
      ? (root) => execFileP('/usr/bin/tmutil', ['addexclusion', root], { timeout: 10_000 })
      : undefined))
    this.ready = new Promise((r) => { this.markReady = r })
    const t = this.now()
    // 代次跨重启单调:接着盘上 state.json 的往下数(老文件没有这个字段 = 0)
    this.dataGen = readDataGen(this.store.statePath)
    this.diskDataGen = this.dataGen
    this.state = { v: 1, enabled: false, pausedUntil: null, status: this.supported() ? 'off' : 'unsupported', since: t, updatedAt: t, platform: d.platform, dataGen: this.dataGen }
  }

  private isDarwin(): boolean { return this.d.platform === 'darwin' }
  /** 有采集端的平台:macOS(helper.app)与 Windows(windows-bridge.exe 常驻服务)。 */
  private supported(): boolean { return this.d.platform === 'darwin' || this.d.platform === 'win32' }
  private isPaused(): boolean { return this.pausedUntil !== null && this.pausedUntil > this.now() }
  private wantRecording(): boolean { return this.supported() && this.enabled && !this.isPaused() && this.started && !this.disposed }
  /** 下发给 helper 的策略(排除表一换就是新对象,按引用缓存;onRaw 每条事件都要用 titleOnly)。 */
  private policy(): RecordPolicy {
    if (this.policyMemo?.exclude !== this.exclude) this.policyMemo = { exclude: this.exclude, policy: buildPolicy(this.exclude, this.d.selfBundleId) }
    return this.policyMemo.policy
  }

  /** 串行写:事件追加 / 清除 / 保留 / state.json 共用一条队列(单写者)。dispose 之后才轮到的任务一律不执行:
   *  退出路径已同步落过盘(「清空数据」则是目录马上要整删),迟到的异步写只会盖回旧状态 / 把目录建回来。 */
  private enqueue(task: () => Promise<unknown>): Promise<void> {
    return this.queue(async () => { if (!this.disposed) await task() })
  }

  async start(cfg: ComputerHistoryConfig): Promise<void> {
    if (this.started) return
    this.readConfig(cfg)
    if (this.pausedUntil !== null && this.pausedUntil <= this.now()) {
      this.pausedUntil = null
      void this.ops(() => this.persistIntent({ computerHistoryPausedUntil: null }, false)).catch(() => {})
    }
    this.started = true
    this.armPauseTimer()
    if (existsSync(this.d.root)) await this.enqueue(() => this.store.prune(this.now())).catch(() => {})
    this.pruneTimer = setInterval(() => {
      void this.enqueue(() => this.store.prune(this.now())).catch(() => {})
      this.recheck() // 睡眠会让暂停计时器迟到;每小时兜一次
    }, PRUNE_EVERY_MS)
    this.pruneTimer.unref?.()
    this.offHelperIdle = this.d.onHelperIdle?.(() => this.helperIdle())
    this.refresh()
    this.markReady()
  }

  /** 权限页据此把「运行中的 helper 协议太老」也判成需要更新(→「更新并重启助手」)。只在功能开着时要求:
   *  没开电脑历史的 CU 用户不会为一个用不上的协议被提示重启。只对 darwin:权限页那条流程管的是 mac 的 helper.app,
   *  Windows 的录制服务是私有副本,协议在拉起前就探过了。 */
  requiredHelperProtocol(): number | undefined {
    return this.isDarwin() && this.enabled && !this.disposed ? COMPUTER_HISTORY_PROTOCOL : undefined
  }

  /** 权限页的请求 / 安装做完了(helper 可能刚被换成新版):没连着就立刻重连一次。 */
  private helperIdle(): void {
    if (this.disposed || !this.wantRecording() || this.sub) return
    this.backoff = BACKOFF_MIN_MS
    if (this.connecting) return // 在途那次若失败,按刚重置的 1s 退避重来
    this.clearRetry()
    this.refresh()
  }

  private readConfig(cfg: ComputerHistoryConfig): boolean {
    let excludeChanged = false
    if ('computerHistoryEnabled' in cfg) this.enabled = cfg.computerHistoryEnabled === true
    if ('computerHistoryPausedUntil' in cfg) {
      const p = cfg.computerHistoryPausedUntil
      this.pausedUntil = typeof p === 'number' && Number.isFinite(p) ? p : null
    }
    if ('computerHistoryExclude' in cfg) {
      const next = normalizeExclude(cfg.computerHistoryExclude)
      excludeChanged = JSON.stringify(next) !== JSON.stringify(this.exclude)
      this.exclude = next
    }
    return excludeChanged
  }

  /** 字段的意愿代号。 */
  private seqOf(k: keyof ComputerHistoryPersistPatch): number {
    return k === 'computerHistoryEnabled' ? this.enableSeq : k === 'computerHistoryPausedUntil' ? this.pauseSeq : this.excludeSeq
  }

  /** cfg 里带的字段各推进一次意愿代号,返回推进后的值(发出这次操作时的代号)。 */
  private bumpConfigSeqs(cfg: ComputerHistoryConfig): Map<keyof ComputerHistoryPersistPatch, number> {
    const seqs = new Map<keyof ComputerHistoryPersistPatch, number>()
    if ('computerHistoryEnabled' in cfg) seqs.set('computerHistoryEnabled', ++this.enableSeq)
    if ('computerHistoryPausedUntil' in cfg) seqs.set('computerHistoryPausedUntil', ++this.pauseSeq)
    if ('computerHistoryExclude' in cfg) seqs.set('computerHistoryExclude', ++this.excludeSeq)
    return seqs
  }

  /**
   * config:set 带了电脑历史的键(渲染层直接改配置;正路是 window.tangu.computerHistory.*)。与开关 / 暂停 / 改排除表是
   * 同一套意愿机制:**发出即**推进字段代号(在途的「开 / 恢复」与欠账补落据此让位),落盘(save = main 的 saveConfig)
   * 排进 ops,与其他意愿操作、后台补落串行 —— 补落插不进「config:set 落盘 → 同步内存」之间,拿旧的内存值把刚落的盖掉。
   * 落成后只同步仍是最新意愿的字段(之后又发出过操作的字段由那个操作说了算);save 失败 = 内存不动,错误照抛。
   * 返回 save 的结果(main 拿它判「变没变」)。
   */
  async configSet<T>(cfg: ComputerHistoryConfig, save: () => Promise<T>): Promise<T> {
    const seqs = this.bumpConfigSeqs(cfg)
    return this.ops(async () => {
      let r: T
      try {
        r = await save()
      } catch (e) {
        // 没落成:内存不动。但它发出时作废过的更早的「开 / 恢复」若已落盘,那几个字段正欠着(landedSuperseded)→ 挂提示
        if (!this.disposed && [...seqs.keys()].some((k) => this.seqOf(k) === seqs.get(k) && this.owed.has(k))) this.persistFailed(e)
        throw e
      }
      const current: ComputerHistoryConfig = {}
      for (const [k, s] of seqs) {
        if (this.seqOf(k) === s) (current as Record<string, unknown>)[k] = cfg[k]
        else this.landedSuperseded(k)
      }
      if (Object.keys(current).length) this.syncConfig(current)
      return r
    })
  }

  /** 配置已落盘的电脑历史键 → 同步内存态(推进代号 + 同步)。只收这三个键。测试与老调用方用;main 的 config:set 走 configSet。 */
  applyConfig(cfg: ComputerHistoryConfig): void {
    this.bumpConfigSeqs(cfg)
    this.syncConfig(cfg)
  }

  /** cfg 里的字段盘上已写定 → 内存跟上;这些字段欠着的不必再补。 */
  private syncConfig(cfg: ComputerHistoryConfig): void {
    const wasEnabled = this.enabled
    for (const k of ['computerHistoryEnabled', 'computerHistoryPausedUntil', 'computerHistoryExclude'] as const) if (k in cfg) this.owed.delete(k)
    const repaid = !this.owed.size && this.clearPersistRetry()
    const excludeChanged = this.readConfig(cfg)
    if (wasEnabled && !this.enabled) this.dataGen++
    if (excludeChanged) {
      this.dataGen++
      this.resubscribe()
    }
    this.armPauseTimer()
    this.refresh()
    if (repaid) this.emit()
  }

  view(): ComputerHistoryView {
    const v: ComputerHistoryView = {
      state: { ...this.state }, exclude: { apps: [...this.exclude.apps], domains: [...this.exclude.domains] },
      root: this.d.root, keepDays: COMPUTER_HISTORY_KEEP_DAYS, rev: ++this.rev,
    }
    if (this.persistError !== null) v.persistError = this.persistError
    if (this.stateError !== null) v.stateError = this.stateError
    return v
  }

  /** 设置页读状态。处在失败态时顺手立即重试一次(用户多半刚授完权 / 装完 helper 回来),别让他干等 60s 退避。 */
  get(): ComputerHistoryView {
    this.recheck()
    const failing = ['disconnected', 'no_permission', 'helper_missing', 'helper_outdated'].includes(this.state.status)
    if (failing && this.wantRecording() && !this.sub && !this.connecting && this.now() - this.lastAttemptAt > 2_000) {
      this.backoff = BACKOFF_MIN_MS
      this.clearRetry()
      this.refresh()
    }
    return this.view()
  }

  /**
   * 开关与暂停对「落配置失败」的处理不对称,按隐私取向:
   *  - 开 / 恢复(要开始录):先落配置,成功了才改内存 —— 失败 = 什么都没变,错误抛给设置页;落配置期间有更新的
   *    意愿操作发出过(代号变了),回来时就不再改那个字段(见 enableSeq 注释);
   *  - 关 / 暂停(要停录):先改内存并立刻断订阅,再落配置 —— 用户要的是马上停,不能被一次配置写失败挡住;
   *    落盘失败照样抛错,本次运行保持已停,并在后台一直补(见 persistIntent / armPersistRetry),补成之前设置页挂着提示:
   *    盘上还是旧值,这时重启会恢复记录。收紧排除表同理(见 setExclude)。
   * 落配置一律排进 ops,按发出顺序一个个落:盘上最后留下的是最后发出的意愿。
   */
  async setEnabled(on: boolean): Promise<ComputerHistoryView> {
    if (on && !this.supported()) return this.view() // 采集只有 mac / Windows 的 helper 能做;别让引擎看到 enabled:true 却永远没事件
    const eop = ++this.enableSeq
    const pop = ++this.pauseSeq // 开关一拨,旧的暂停作废(关了再开不该还停在上次的暂停里)
    const patch = { computerHistoryEnabled: on, computerHistoryPausedUntil: null }
    if (!on) {
      this.enabled = false
      this.pausedUntil = null
      this.armPauseTimer()
      this.backoff = BACKOFF_MIN_MS
      this.dataGen++ // 读者:读到一半被关了,结果作废
      this.refresh()
      // 失败不看代号一律记欠账:之后排着的操作成功了自会还清;若之后那个「开」也落失败,内存仍是关,照补
      await this.ops(() => this.persistIntent(patch, true))
      await this.flush()
      return this.view()
    }
    try {
      await this.ops(() => this.persistIntent(patch, false))
    } catch (e) {
      this.refresh()
      throw e // 什么都没变;欠着的(若有)照旧在后台补
    }
    if (eop === this.enableSeq) this.enabled = true
    else this.landedSuperseded('computerHistoryEnabled')
    if (pop === this.pauseSeq) {
      this.pausedUntil = null
      this.armPauseTimer()
    } else this.landedSuperseded('computerHistoryPausedUntil')
    this.backoff = BACKOFF_MIN_MS
    try {
      if (this.enabled) await this.enqueue(() => this.store.ensureRoot())
    } finally {
      this.refresh()
    }
    return this.view()
  }

  async pause(until: number | 'tomorrow'): Promise<ComputerHistoryView> {
    const now = this.now()
    let untilMs: number
    if (until === 'tomorrow') untilMs = nextLocalMidnight(now)
    else if (typeof until === 'number' && Number.isFinite(until) && until > 0) untilMs = now + Math.min(PAUSE_MAX_MS, Math.max(60_000, until))
    else throw new Error('invalid pause duration')
    this.pauseSeq++
    this.pausedUntil = untilMs
    this.armPauseTimer()
    this.refresh() // 先断订阅,再落配置:暂停要立刻生效(落盘失败也保持已暂停并在后台补,见 setEnabled 注释)
    await this.ops(() => this.persistIntent({ computerHistoryPausedUntil: untilMs }, true))
    await this.flush()
    return this.view()
  }

  async resume(): Promise<ComputerHistoryView> {
    const pop = ++this.pauseSeq
    // 先落配置:失败 = 仍在暂停,错误抛给调用方(欠着的暂停若有,照旧在后台补)
    await this.ops(() => this.persistIntent({ computerHistoryPausedUntil: null }, false))
    if (pop === this.pauseSeq) { // 落配置期间又暂停 / 开关过:那个更新的意愿说了算
      this.pausedUntil = null
      this.armPauseTimer()
      this.backoff = BACKOFF_MIN_MS
      this.refresh()
    } else this.landedSuperseded('computerHistoryPausedUntil')
    return this.view()
  }

  /**
   * 落配置(**只在 ops 里调**,欠账的记 / 还与落盘同在一个串行任务里,不会被下一笔插到中间)。
   *  - 成功:这几个字段盘上已跟上 —— 之后再改内存的操作各自排着自己的落盘 —— 从欠账里删掉;删空即还清(提示消失)。
   *  - 失败且 owe(「停录」侧:关 / 暂停 / 收紧排除表,内存已先改):记欠账,后台按退避补落这些字段的当前内存值。
   *    「开始录」侧(开 / 恢复 / 放宽排除表)失败 = 什么都没变,不欠。
   */
  private async persistIntent(patch: ComputerHistoryPersistPatch, owe: boolean): Promise<void> {
    const keys = Object.keys(patch) as Array<keyof ComputerHistoryPersistPatch>
    try {
      await this.d.persist(patch)
    } catch (e) {
      // 「开始录」侧失败本身不欠;但这个字段若已欠着(之前被它取代的写已落盘,见 landedSuperseded),盘上仍与内存不一致 → 挂提示
      if (!this.disposed && (owe || keys.some((k) => this.owed.has(k)))) {
        if (owe) for (const k of keys) this.owed.add(k)
        this.persistFailed(e)
      }
      throw e
    }
    for (const k of keys) this.owed.delete(k)
    if (!this.owed.size && this.clearPersistRetry()) this.emit()
  }

  /**
   * 一笔落盘已经写到盘上,回来时这个字段却已被之后发出的意愿取代(内存没跟它走):盘上与内存可能不一致 —— 记欠账并悄悄排一次
   * 补落(不挂提示)。取代它的操作各自排着自己的落盘:落成即还清;落失败(或 config:set 没落成)转成挂提示的欠账。
   * 典型:「开」的落盘排在前面、随后发出的 config:set 关把它作废,而 config:set 自己没落成 —— 不补的话盘上留着「开」,重启就恢复记录。
   */
  private landedSuperseded(k: keyof ComputerHistoryPersistPatch): void {
    if (this.disposed) return
    this.owed.add(k)
    this.armPersistRetry()
  }

  /** 这些字段的当前内存值(内存永远是最新的意愿:补落的永远是最后发出的那个)。 */
  private patchFor(keys: Iterable<keyof ComputerHistoryPersistPatch>): ComputerHistoryPersistPatch {
    const p: ComputerHistoryPersistPatch = {}
    for (const k of keys) {
      if (k === 'computerHistoryEnabled') p.computerHistoryEnabled = this.enabled
      else if (k === 'computerHistoryPausedUntil') p.computerHistoryPausedUntil = this.pausedUntil
      else p.computerHistoryExclude = { apps: [...this.exclude.apps], domains: [...this.exclude.domains] }
    }
    return p
  }

  /**
   * 后台补落欠账(只在 ops 里调)。补丁以**函数**交给 persist,在配置写队列里、紧挨写盘前才求值,逐字段复核:
   * 已不欠(被别的写还清)或代号变了(之后又发出过这个字段的意愿 —— config:set / 开关 / 暂停 / 改排除表,各自排着自己
   * 的落盘)→ 这回不写它,免得拿旧值盖掉更新的那份。复核后仍欠着(那个更新的操作没落成)→ 接着按退避补。
   */
  private async persistOwed(): Promise<void> {
    const seqs = new Map([...this.owed].map((k) => [k, this.seqOf(k)] as const))
    let wrote: Array<keyof ComputerHistoryPersistPatch> = []
    const build = (): ComputerHistoryPersistPatch => {
      wrote = [...seqs].filter(([k, s]) => this.owed.has(k) && this.seqOf(k) === s).map(([k]) => k)
      return this.patchFor(wrote)
    }
    try {
      await this.d.persist(build)
    } catch (e) {
      if (!this.disposed) this.persistFailed(e)
      throw e
    }
    for (const k of wrote) this.owed.delete(k)
    if (!this.owed.size) { if (this.clearPersistRetry()) this.emit() } else this.armPersistRetry()
  }

  /** 欠账落配置失败:记下错误(设置页据此提示),后台按退避一直补,直到写成或被新的意愿取代。 */
  private persistFailed(err: unknown): void {
    this.persistError = (err instanceof Error ? err.message : String(err)) || 'persist failed'
    this.armPersistRetry()
    this.emit()
  }

  private armPersistRetry(): void {
    if (this.persistRetryTimer || this.disposed) return
    const delay = this.persistRetryDelay
    this.persistRetryDelay = Math.min(PERSIST_RETRY_MAX_MS, delay * 2)
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = undefined
      // 排进 ops:在它前面发出的操作先落完 —— 落成了会还掉对应字段(轮到这里时就不再写它们);写盘前再逐字段复核(见 persistOwed)
      void this.ops(async () => {
        if (this.disposed || !this.owed.size) return
        await this.persistOwed()
      }).catch(() => {})
    }, delay)
    this.persistRetryTimer.unref?.()
  }

  /** 清掉提示与重试计时器(欠账已还清时调);返回之前是否挂着提示(调用方据此决定要不要推一次 View)。 */
  private clearPersistRetry(): boolean {
    clearTimeout(this.persistRetryTimer)
    this.persistRetryTimer = undefined
    this.persistRetryDelay = PERSIST_RETRY_MIN_MS
    const had = this.persistError !== null
    this.persistError = null
    return had
  }

  /** 暂停到点了没(计时器 / 每小时巡检 / 唤醒 / get 都会来问)。 */
  recheck(): void {
    if (this.disposed) return
    if (this.pausedUntil !== null && this.pausedUntil <= this.now()) {
      this.pausedUntil = null
      void this.ops(() => this.persistIntent({ computerHistoryPausedUntil: null }, false)).catch(() => {})
      this.backoff = BACKOFF_MIN_MS
      this.refresh()
    }
    this.armPauseTimer()
  }

  private armPauseTimer(): void {
    clearTimeout(this.pauseTimer)
    this.pauseTimer = undefined
    if (this.pausedUntil === null || this.disposed) return
    const ms = Math.min(2 ** 31 - 1, Math.max(0, this.pausedUntil - this.now()))
    this.pauseTimer = setTimeout(() => this.recheck(), ms)
    this.pauseTimer.unref?.()
  }

  async clear(opts: { sinceMs?: number; all?: boolean }): Promise<ComputerHistoryView> {
    const all = opts?.all === true
    const sinceMs = Number(opts?.sinceMs)
    if (!all && !Number.isFinite(sinceMs)) throw new Error('invalid clear range')
    return this.ops(async () => {
      // 先断并按住:旧连接上的迟到事件按代号作废,helper 见 EOF 丢掉差分基线;清完之前任何 refresh 都不重连
      this.disconnect()
      this.holds++
      // 数据代次前后各 +1,两次 state.json 写与删除排在同一条写队列里、夹住删除:读到一半的读者复核时必然看见变化
      this.dataGen++
      this.refresh()
      try {
        await this.enqueue(async () => {
          // 轮到这里时前面在途的追加已落定(写失败退回缓冲的那批也回来了),缓冲此刻才滤得全
          this.buffer = all ? [] : this.buffer.filter((e) => e.t < sinceMs)
          await this.writeBuffer()
          this.rewriting = true
          try {
            await this.store.clear(all ? { all: true } : { sinceMs })
          } finally {
            this.rewriting = false
          }
        })
      } finally {
        this.holds--
        this.dataGen++
        this.resetSeenApps() // 选择器里别再列出刚清掉的那段时间用过的 App;下次查询从盘上重补
        // 想录就重开(退避等待中被 disconnect 清掉的重试也在这里接上)。重写失败也得重开:
        // 否则订阅已断、没有重试,状态却还写着「记录中」
        this.refresh()
      }
      return this.view()
    })
  }

  /**
   * 改排除表。**收紧当场生效**:落配置可能排在配置锁 / 慢盘后面,这段时间里刚排除的 App / 站点不能照旧被记 ——
   * 有新增项就先把内存过滤换成「旧 ∪ 新」,断掉按旧策略的订阅、按收紧后的策略重订,再落配置;
   * 移除(放宽)等落配置成功才生效。落配置失败:错误抛给设置页;有收紧的,已收紧的部分本次运行保留,并像「关 / 暂停」
   * 一样在后台一直补落(补的是内存里的「旧 ∪ 新」:放宽那半没生效,不替用户落),否则重启后刚排除的又会被记。
   */
  async setExclude(raw: unknown): Promise<ComputerHistoryView> {
    const next = normalizeExclude(raw)
    const op = ++this.excludeSeq
    const tightened = tightenExclude(this.exclude, next)
    if (tightened) this.replaceExclude(tightened)
    await this.ops(() => this.persistIntent({ computerHistoryExclude: next }, tightened !== null))
    if (op !== this.excludeSeq) this.landedSuperseded('computerHistoryExclude')
    else if (JSON.stringify(next) !== JSON.stringify(this.exclude)) this.replaceExclude(next)
    return this.view()
  }

  /** 换排除表(新对象:策略缓存按引用失效)→ 代次 +1、按新策略重订、写 state.json + 推送。 */
  private replaceExclude(next: ComputerHistoryExclude): void {
    this.exclude = next
    this.dataGen++
    this.resubscribe()
    this.refresh()
  }

  /** end 之前 hours 小时的折叠会话,新的在前(end 缺省 = 现在,不许超过现在;设置页按天回看传当天的次日零点)。 */
  async recent(hours: number, end?: number): Promise<ComputerHistorySession[]> {
    const h = Number.isFinite(hours) ? Math.min(COMPUTER_HISTORY_KEEP_DAYS * 24, Math.max(1 / 60, hours)) : 24
    const now = this.now()
    const to = end !== undefined && Number.isFinite(end) ? Math.min(now, end) : now, from = to - h * 3_600_000
    const events = [...await this.store.readRange(from, to), ...this.buffer.filter((e) => e.t >= from && e.t <= to)]
    events.sort((a, b) => a.t - b.t)
    return foldSessions(events).reverse().slice(0, 500)
  }

  /** 有记录的日子(本地日期 YYYY-MM-DD,新的在前):盘上的 + 缓冲里还没落盘的。设置页的日期下拉只列这些。 */
  async days(): Promise<string[]> {
    const set = new Set(await this.store.days())
    for (const e of this.buffer) set.add(localDay(e.t))
    return [...set].sort().reverse()
  }

  /** 最近见过的 App(新的在前)。事件流喂内存表;盘上只在首次(或清除后)有界地补一次,设置页反复打开不再扫盘。 */
  async recentApps(): Promise<Array<{ name: string; bundleId: string }>> {
    if (!this.seenAppsSeeded) {
      const epoch = this.seenAppsEpoch
      const fromDisk = await this.store.recentApps(RECENT_APPS_LIMIT).catch(() => [])
      if (epoch === this.seenAppsEpoch && !this.seenAppsSeeded) {
        // 盘上的(新→旧)倒过来先放,事件流里见到的更新,挪到后面
        const merged = new Map<string, string>()
        for (let i = fromDisk.length - 1; i >= 0; i--) merged.set(fromDisk[i].bundleId, fromDisk[i].name)
        for (const [bundleId, name] of this.seenApps) { merged.delete(bundleId); merged.set(bundleId, name) }
        this.seenApps = merged
        this.seenAppsSeeded = true
      }
    }
    return [...this.seenApps].reverse().slice(0, RECENT_APPS_LIMIT).map(([bundleId, name]) => ({ name, bundleId }))
  }

  private noteApp(ev: ComputerHistoryEvent): void {
    const a = ev.app
    if (!a?.bundleId || a.excluded) return
    this.seenApps.delete(a.bundleId)
    this.seenApps.set(a.bundleId, a.name)
    if (this.seenApps.size > RECENT_APPS_LIMIT * 2) this.seenApps.delete(this.seenApps.keys().next().value as string)
  }

  private resetSeenApps(): void {
    this.seenApps.clear()
    this.seenAppsSeeded = false
    this.seenAppsEpoch++
  }

  async reveal(): Promise<void> {
    await this.enqueue(() => this.store.ensureRoot())
    await this.d.openFolder?.(this.d.root)
  }

  // ── 事件 ──

  private onRaw(raw: unknown, gen: number): void {
    if (gen !== this.gen || !this.wantRecording()) return
    const ev = sanitizeEvent(raw, this.now())
    if (!ev) return
    const kept = applyExclude(ev, this.exclude, { titleOnly: this.policy().titleOnlyBundleIds, context: this.current })
    if (ev.kind === 'app' || ev.kind === 'window') this.current = { bundleId: ev.app?.bundleId, url: ev.url, excluded: !kept || kept.app?.excluded === true }
    if (!kept) return
    this.noteApp(kept)
    this.buffer.push(kept)
    this.armFlush(FLUSH_MS)
  }

  private armFlush(ms: number): void {
    if (this.flushTimer || this.disposed) return
    this.flushTimer = setTimeout(() => { void this.flush() }, ms)
    this.flushTimer.unref?.()
  }

  /** 把缓冲写盘(测试 / 暂停 / 关闭前也会直接调)。缓冲在任务**轮到时**才取走:排队期间退出,dispose 的同步兜底仍拿得到。 */
  flush(): Promise<void> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    return this.enqueue(() => this.writeBuffer())
  }

  /** 只在队列内调。失败:整批退回缓冲头部(封顶保新)、过一会儿重试;连续失败 → 状态降级,别让各处继续显示「记录中」。
   *  ponytail: 跨午夜那批若前一天写成、后一天失败,重试会让前一天多出重复行(读端按 t 排序,不影响折叠)。 */
  private async writeBuffer(): Promise<void> {
    if (!this.buffer.length) return
    const batch = this.buffer
    this.buffer = []
    try {
      await this.store.append(batch)
    } catch (e) {
      if (this.disposed) return
      console.warn('[computer-history] append failed', errCode(e) || e)
      this.buffer = [...batch, ...this.buffer].slice(-BUFFER_CAP)
      this.armFlush(RETRY_FLUSH_MS)
      if (++this.appendFailures >= FAILS_BEFORE_DEGRADE && !this.storeFailing) {
        this.storeFailing = true
        this.refresh()
      }
      return
    }
    this.appendFailures = 0
    if (this.storeFailing) {
      this.storeFailing = false
      this.refresh()
    }
  }

  // ── 状态 ──

  private computeStatus(): ComputerHistoryStatus {
    if (!this.supported()) return 'unsupported'
    if (!this.enabled) return 'off'
    if (this.isPaused()) return 'paused'
    if (this.connStatus === 'recording' && this.storeFailing) return 'disconnected' // 连着但写不进盘:不能说「记录中」
    return this.connStatus
  }

  /** 重算状态 → 有变化就写 state.json + 推送;再按「想不想录」开 / 断连接。 */
  private refresh(): void {
    if (!this.started || this.disposed) return
    if (this.wantRecording()) { if (!this.holds) this.ensureConnected() }
    else {
      this.disconnect()
      this.connStatus = 'disconnected' // 下次开录从「未连上」起算,别把上一轮的 recording 带过去
    }
    const status = this.computeStatus()
    const now = this.now()
    const next: ComputerHistoryState = {
      v: 1, enabled: this.enabled && this.supported(), pausedUntil: this.isPaused() ? this.pausedUntil : null, status,
      since: status === this.state.status ? this.state.since : now, updatedAt: now, platform: this.d.platform, dataGen: this.dataGen,
    }
    const sig = JSON.stringify([next.enabled, next.pausedUntil, next.status, next.dataGen])
    this.state = next
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.writeStateFile(next, sig)
    this.emit()
  }

  /**
   * state.json 排进写队列(next 在入队时定下:清除靠「前后两次写夹住删除」,不能让后一份抢到删除前面去)。
   * **写成才记 lastWritten**;写失败按退避重试最新一份。关闭(enabled:false)或代次变了(清除 / 改排除表 / 关闭)的
   * 那份写不进去 → 同一个队列任务里删掉盘上的 state.json,失败关门:引擎把「没有 state.json」当关、读到一半的也整份作废,
   * 不能让它照旧按盘上的 enabled:true / 旧代次放行。删在同一任务里,所以排在后面的清除执行时 state.json 已经不在了。
   */
  private writeStateFile(next: ComputerHistoryState, sig: string): void {
    if (!next.enabled && !existsSync(this.d.root)) { // 功能从没开过的机器不建目录:引擎把「没有 state.json」当关
      this.setStateError(null) // 目录都没了(关着)= 盘上就是「关」,没什么可补的
      return
    }
    void this.enqueue(async () => {
      try {
        await this.store.writeState(next, () => !this.disposed)
      } catch (e) {
        if (this.disposed) return
        console.warn('[computer-history] state write failed', errCode(e) || e)
        let err = errText(e)
        if (!next.enabled || next.dataGen !== this.diskDataGen) {
          try {
            await rm(this.store.statePath, { force: true })
            this.diskDataGen = null
          } catch (re) {
            console.warn('[computer-history] state remove failed', errCode(re) || re)
            err = `${err}; ${errText(re)}` // 写不进也删不掉:引擎只剩第二道闸(桌面配置)
          }
        }
        this.setStateError(err)
        this.armStateRetry()
        return
      }
      if (this.disposed) return // commit 被否决 = 没写
      this.lastWritten = sig
      this.diskDataGen = next.dataGen
      if (sig === this.lastSig) {
        clearTimeout(this.stateRetryTimer)
        this.stateRetryTimer = undefined
        this.stateRetryDelay = STATE_RETRY_MIN_MS
        this.setStateError(null) // 盘上跟上了最新一份
      }
    })
  }

  /** state.json 没写成的提示(设置页页顶):变了才推。 */
  private setStateError(err: string | null): void {
    if (err === this.stateError || this.disposed) return
    this.stateError = err
    this.emit()
  }

  private armStateRetry(): void {
    if (this.stateRetryTimer || this.disposed) return
    const delay = this.stateRetryDelay
    this.stateRetryDelay = Math.min(STATE_RETRY_MAX_MS, delay * 2)
    this.stateRetryTimer = setTimeout(() => {
      this.stateRetryTimer = undefined
      if (!this.disposed && this.lastWritten !== this.lastSig) this.writeStateFile(this.state, this.lastSig)
    }, delay)
    this.stateRetryTimer.unref?.()
  }

  private emit(): void {
    try { this.d.onChanged?.(this.view()) } catch { /* 推送失败不影响录制 */ }
  }

  // ── 连接 ──

  private disconnect(): void {
    this.gen++
    this.current = null
    this.clearRetry()
    const sub = this.sub
    this.sub = null
    sub?.close()
  }

  /** 关掉重开(清除 / 改排除表):helper 丢基线、拿新策略。 */
  private resubscribe(): void {
    if (!this.sub && !this.connecting) return
    this.disconnect()
    this.refresh()
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private ensureConnected(): void {
    if (this.sub || this.connecting || this.retryTimer) return
    void this.connect()
  }

  private scheduleRetry(): void {
    if (!this.wantRecording() || this.retryTimer) return
    const delay = this.backoff
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2)
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.refresh() }, delay)
    this.retryTimer.unref?.()
  }

  /** 这一次连接的端点。darwin:固定的 socket;win32:现取录制服务(源 / 私有副本 / 协议 / 管道名),没源 → helper_missing,
   *  协议不够(老 helper 没有常驻录制服务)→ helper_outdated —— 都在连之前就判掉,不去拉起一个注定不行的 exe。 */
  private async helperTarget(): Promise<HelperLaunchTarget> {
    if (this.d.platform !== 'win32') return { socketPath: this.d.socketPath }
    const rec = await this.d.windowsRecorder?.()
    if (!rec) throw codeError('helper_missing')
    if (rec.protocol === null || rec.protocol < COMPUTER_HISTORY_PROTOCOL) throw codeError('helper_outdated')
    return { socketPath: rec.pipe, exe: rec.exe }
  }

  private async connect(): Promise<void> {
    const gen = this.gen
    this.connecting = true
    this.lastAttemptAt = this.now()
    let sub: RecorderSubscription | null = null
    try {
      const target = await this.helperTarget()
      if (gen !== this.gen) return // 现取途中被断开(暂停 / 清除 / 改表):finally 按最新意愿重来
      const open = (): RecorderSubscription => openRecorderSubscription(target.socketPath, this.policy(), (raw) => this.onRaw(raw, gen))
      sub = open()
      let info: { protocolVersion: number; axTrusted: boolean }
      try {
        info = await sub.ready
      } catch (err) {
        const code = errCode(err)
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw err
        // socket 不在 / 没人听 = helper 没跑:装了就拉起(功能开着才走到这里),没装就如实报
        if (!await this.launchHelper(gen, target)) throw codeError(this.isDarwin() && this.d.externalSocket ? 'external_unavailable' : 'helper_missing')
        if (gen !== this.gen) return
        sub = open()
        info = await sub.ready
      }
      if (gen !== this.gen) { sub.close(); return }
      if (!info.axTrusted && this.isDarwin()) { sub.close(); throw codeError('accessibility_denied') } // Windows 没有这项授权
      this.sub = sub
      this.subSince = this.now()
      this.connStatus = 'recording'
      const mine = sub
      void mine.closed.then(() => this.onSubClosed(mine))
    } catch (err) {
      sub?.close()
      if (gen !== this.gen) return
      this.connStatus = statusForError(err)
      if (this.connStatus === 'disconnected') console.warn('[computer-history] subscribe failed:', errCode(err) || err)
      this.scheduleRetry()
    } finally {
      this.connecting = false
      // 连接途中被断开(暂停 / 清除 / 改表)→ 按最新意愿重来;否则把结论落进状态
      this.refresh()
    }
  }

  private onSubClosed(sub: RecorderSubscription): void {
    if (this.sub !== sub) return // 我们主动关的
    this.sub = null
    if (this.now() - this.subSince >= HEALTHY_MS) this.backoff = BACKOFF_MIN_MS
    this.connStatus = 'disconnected'
    this.scheduleRetry()
    this.refresh()
  }

  /** 拉起 helper 并等它 bind。返回 false = 没装(或外部 socket 不归我们拉起);权限页正忙 → 抛 helper_busy。 */
  private async launchHelper(gen: number, target: HelperLaunchTarget): Promise<boolean> {
    let launch: (t: HelperLaunchTarget) => Promise<void>
    if (this.isDarwin()) {
      if (this.d.externalSocket) return false
      const appPath = this.d.helperAppPath()
      if (!existsSync(path.join(appPath, 'Contents', 'MacOS', 'bridge'))) return false
      // 权限页正在关停 / 重装 helper:这会儿拉起的是旧包(见 deps.helperBusy)。不拉、也不占节流窗口
      // (否则忙完那次重连拉不起来);落 disconnected + 退避,忙完由 helperIdle 立刻重连
      if (this.d.helperBusy?.()) throw codeError('helper_busy')
      launch = this.d.launchHelper ?? (async (t) => {
        await mkdir(path.dirname(t.socketPath), { recursive: true })
        await execFileP('/usr/bin/open', ['-n', '-g', appPath, '--args', 'serve', '--socket', t.socketPath], { timeout: 10_000 })
      })
    } else {
      const exe = target.exe
      if (!exe || !existsSync(exe)) return false
      launch = this.d.launchHelper ?? ((t) => launchWindowsRecorder(exe, t.socketPath))
    }
    // 节流窗口内不再拉、也不干等:直接让下一次连接失败落到 disconnected + 退避
    if (this.now() - this.lastLaunchAt < LAUNCH_THROTTLE_MS) return true
    this.lastLaunchAt = this.now()
    await launch(target).catch((e) => console.warn('[computer-history] helper launch failed', e))
    for (let i = 0; i < 30 && gen === this.gen; i++) {
      if (await canConnect(target.socketPath)) return true
      await sleep(150)
    }
    return true // 装了但没起来:交给下一次连接失败去报 disconnected
  }

  /**
   * 停计时器、断订阅;之后队列里才轮到的写一律跳过(见 enqueue)。
   *  - 缺省(before-quit):缓冲同步落盘(等不了异步);state 改写成非录制态,免得引擎以为还在录。
   *  - discard(应用内「清空数据」):缓冲直接丢、state 不写 —— 目录马上被整删,任何一笔写都会把它建回来
   *    (app.exit 不发 before-quit,不在这里停,1s 批量落盘会在删目录途中重建 events/)。
   * 同步部分在第一个 await 之前做完(before-quit 不等返回值);返回的 promise = 队列里在途那一笔落定。
   */
  dispose(opts: { discard?: boolean } = {}): Promise<void> {
    if (!this.disposed) {
      const wasRecording = this.state.status === 'recording'
      this.disposed = true
      this.gen++
      this.clearRetry()
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      clearTimeout(this.pauseTimer)
      clearInterval(this.pruneTimer)
      clearTimeout(this.persistRetryTimer)
      this.persistRetryTimer = undefined
      clearTimeout(this.stateRetryTimer)
      this.stateRetryTimer = undefined
      this.offHelperIdle?.()
      this.offHelperIdle = undefined
      this.sub?.close()
      this.sub = null
      const buffer = this.buffer
      this.buffer = []
      if (opts.discard) this.store.close() // 在途那笔的后续步骤也别再建目录 / 写文件
      else {
        try {
          // 清除的原子重写进行中不插同步写:重写的 rename 会吞掉它,宁可丢最后 ≤1s
          if (!this.rewriting) this.store.appendSync(buffer)
          if (wasRecording) this.store.writeStateSync({ ...this.state, status: 'disconnected', since: this.now(), updatedAt: this.now() })
        } catch { /* 退出路径,尽力而为 */ }
      }
    }
    return this.queue(async () => {})
  }
}

/**
 * 应用内「清空数据」(main 的 app:clearData)专用的两段式停写,保证删完不留电脑历史:
 *  1. dispose({ discard }):断订阅、丢缓冲,之后才轮到的写一律跳过,store 关门(在途那笔的后续步骤不再建目录 / 写文件);
 *  2. 等在途那笔落定,封顶 capMs(一次卡住的磁盘操作不能拖住整个清空)。
 * 返回的 afterWipe 由调用方在整删目录**之后、仍在配置写队列里**调用(删完同一拍退出的约束不破):删掉电脑历史根目录
 * (显式 TANGU_HOME 时它不在被删的目录里);第 2 步超时的,再等在途那笔落定(再封顶)后把根目录再删一次 ——
 * 已经派发出去的那笔写取消不了,落定前可能已把 events/ 建了回来。
 */
export async function stopComputerHistoryForWipe(ch: ComputerHistory, capMs = WIPE_CAP_MS): Promise<{ drained: boolean; afterWipe(): Promise<void> }> {
  const drained = ch.dispose({ discard: true }).then(() => true, () => true)
  const capped = (): Promise<boolean> => Promise.race([drained, new Promise<boolean>((r) => { setTimeout(() => r(false), capMs).unref?.() })])
  const early = await capped()
  const removeRoot = (): Promise<void> => rm(ch.store.root, { recursive: true, force: true }).catch(() => {})
  return {
    drained: early,
    async afterWipe() {
      await removeRoot()
      if (early) return
      if (!await capped()) console.warn('[computer-history] in-flight write still pending after wipe')
      await removeRoot()
    },
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** `window.tangu.computerHistory` 的主进程端(见 preload.ts / shared ComputerHistoryApi)。 */
export function registerComputerHistoryIpc(ch: ComputerHistory, isTrustedSender: (e: IpcMainInvokeEvent) => boolean): void {
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`computerHistory:${name}`, async (e, ...args: unknown[]) => {
      if (!isTrustedSender(e)) throw new Error('forbidden')
      await ch.ready
      return fn(...args)
    })
  }
  handle('get', () => ch.get())
  handle('setEnabled', (on) => ch.setEnabled(on === true))
  handle('pause', (until) => ch.pause(until === 'tomorrow' ? 'tomorrow' : Number(until)))
  handle('resume', () => ch.resume())
  handle('clear', (opts) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { sinceMs?: unknown; all?: unknown }
    return ch.clear(o.all === true ? { all: true } : { sinceMs: Number(o.sinceMs) })
  })
  handle('setExclude', (ex) => ch.setExclude(ex))
  handle('recent', (hours, end) => ch.recent(Number(hours), end == null ? undefined : Number(end)))
  handle('recentApps', () => ch.recentApps())
  handle('days', () => ch.days())
  handle('appIcons', (ids) => appIconDataUrls(ids))
  handle('reveal', () => ch.reveal())
}
