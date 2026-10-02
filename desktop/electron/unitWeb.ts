/**
 * unitWeb —— 扶桑根 B 端渲染的本机 web 服务(方案 §11.3)。
 *
 * 把本机 Forsion 曝成一个网页:静态 web 构建 + /engine 反代本机引擎 + 配对流 + 插件清单 + 元数据。
 * 双层通路共用这一个面:
 *   T1 局域网直连(无需 Forsion 登录):Bearer 配对令牌(6 位码双侧比对后发放,库存 hash,可回收);
 *   T2 server 隧道(unitHost 转发):per-boot 随机内部密钥头 + 仅接受 loopback 来源(server 已验 owner)。
 *   P2P 直连(unitP2p 执行器转发):**另一把** per-boot 密钥头(x-unit-p2p),同样只认 loopback —— 与隧道分钥,
 *   否则 unitWeb 分不清请求走的是哪条通路(设备能力 MCP 方案 §6.2-8)。
 * 安全铁律:引擎永远只听 127.0.0.1,本服务反代时盖引擎 token;配对令牌绝不进引擎。
 * /engine/* 是 **default-deny 允许清单**(方案 §6.6):表由 scripts/gen-engine-routes.mjs 从引擎源码生成
 * (engineRoutes.generated.ts),只放行 allow 行;其余一律 403 LOCAL_ONLY。放行的请求盖远端来源标记
 * `x-forsion-remote: tunnel|p2p|lan` + `x-forsion-remote-mark`(per-boot 密钥,引擎据 TANGU_REMOTE_MARK_SECRET 验),
 * 入站同名头一律不透传(契约 C1)。
 * 调用方身份(P1 · K1):隧道来路带 unitHost 签的 x-unit-caller → resolveCaller 验签(每请求只调一次、一次性消费),
 * 通过才在从零重建的头表里盖 x-forsion-remote-caller;验不过 403 BAD_CALLER_ASSERTION(不降级);局域网 / P2P 来路的该头一律无视。
 *
 * ⚠️ 刻意零 electron 依赖(deps 注入):vitest 直接跑真 HTTP 全链(scripts 之外的脊柱测试
 * electron/unitWeb.test.ts —— 配对/鉴权/反代盖章/SSE 直通都在那里钉)。
 */
import http from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { extname, normalize, sep } from 'node:path'
import { readFile, realpath, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { IPC } from '../shared/amadeus/ipc'
import type { VaultFace } from './amadeus/ipc'
import { PRODUCT, type ProductProfile } from './product'
import { ENGINE_ROUTES } from './engineRoutes.generated'
import { callerOf, encodeEngineCaller, ENGINE_CALLER_HEADER, gcSeenCallers, UNIT_CALLER_HEADER, verifyProxyCaller, type ProxyCaller, type UnitCaller } from './unitCaller'
import { baseTierOnly } from './remoteSessionGate' // P1-K4
import { lockedEngineAllowed, lockedRequestAllowed, REMOTE_LOCKED_BODY, VAULT_RPC_READ } from './remoteLockGate' // P1-K2
import type { GateResult, RemoteAccessStatus } from '../shared/remoteSessions' // P1-K4

export interface PairedDevice { id: string; name: string; tokenHash: string; createdAt: number }

/**
 * /vault/rpc 可远程调用的通道白名单(default-deny,同 sketch 工具的 GUI 门禁范式)。
 * 排除项都是「在 B 的机器上弹对话框/开 shell」类桌面 UX 通道:openVault(目录选择框)、
 * openAttachment/openVaultFile(shell.openPath)、exportPdf / exportCsv(保存框 + 往库外落盘)、
 * revealInFileManager、插件管理(listPlugins 走 /unit/plugins;scaffold/uninstall/open-folder 不给远端)。
 * 文件类通道全部经 VaultManager.resolveInVault 钳制在库根内,越界即抛。
 */
export const VAULT_RPC_ALLOW: ReadonlySet<string> = new Set([
  IPC.restoreVault, IPC.listPages, IPC.listFiles, IPC.loadPage, IPC.readPage, IPC.newPage,
  IPC.savePage, IPC.renamePage, IPC.reconcilePage, IPC.saveAsset, IPC.saveVaultBytes,
  IPC.readVaultBytes, IPC.saveAttachment, IPC.search, IPC.backlinks, IPC.exclusiveAssets,
  IPC.reindex, IPC.listTags, IPC.pagesByTag, IPC.deletePage, IPC.movePage, IPC.resolveEmbed,
  IPC.blockBacklinks, IPC.listFolders, IPC.createFolder, IPC.renameFolder, IPC.deleteFolder,
  IPC.moveFolder, IPC.trashEntry, IPC.listTrash, IPC.restoreTrash, IPC.deleteTrashEntry,
  IPC.emptyTrash, IPC.pageIcons, IPC.fetchLinkMeta, IPC.searchImages, IPC.dbRead, IPC.dbWrite,
  IPC.dbWriteCas, IPC.drawingRead, IPC.drawingWrite, IPC.readTextFile, IPC.writeTextFile,
  IPC.listPageProps, IPC.setPageFrontmatter, IPC.renamePageFile, IPC.renameDbFile,
  IPC.pluginDataRead, IPC.pluginDataWrite, IPC.patchMark,
])

/** VAULT_RPC_ALLOW 里**只许本机**的子集:不可逆删除(清空废纸篓 / 彻底删除条目)。远端来路回 403 LOCAL_ONLY;
 *  便携 Unit 的工作区主人(projection local)不受限(见 ownerProjection)。 */
export const VAULT_RPC_LOCAL_ONLY: ReadonlySet<string> = new Set([IPC.emptyTrash, IPC.deleteTrashEntry])

/** 进入本机 unitWeb 的三条远端通路(契约 C1 的 x-forsion-remote 取值)。 */
export type UnitIngress = 'tunnel' | 'p2p' | 'lan'

/** 隧道(unitHost)与 P2P 执行器(unitP2p)各自盖的内部密钥头。 */
export const UNIT_INTERNAL_HEADER = 'x-unit-internal'
export const UNIT_P2P_HEADER = 'x-unit-p2p'

/** 引擎路由里远端不许用的回包(设备页据 code 出本地化提示,见 frontend services/localOnly.ts)。 */
const LOCAL_ONLY_BODY = { code: 'LOCAL_ONLY', detail: 'This action is only available on the device itself' }
/** 隧道上的调用方断言验不过(R-08):403 不是 401(渲染层 401 = 重新登录),也不降级成「未识别」放行(INV-MONO)。 */
const BAD_CALLER_BODY = { code: 'BAD_CALLER_ASSERTION', detail: 'Invalid caller assertion' }

/**
 * 路径里**只认** RFC 3986 的 pchar(未保留字符 + sub-delims + `:` `@`)和 `/`,百分号必须带两位十六进制。
 * 白名单而不是黑名单:匹配器与引擎 Express(parseurl)对同一串理解不同的来源都在白名单之外 ——
 * `#`(parseurl 遇到它退回 url.parse,把 `#` 之后截成 hash,路由看到的是更短的路径)、空白 / 0xA0 / 0xFEFF
 * (同样触发 url.parse,还会被 trim)、反斜杠(url.parse 改写成 `/`)、非 ASCII、控制字符。
 */
const ENGINE_PATH_CHARS = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/
/** query 不参与路由、原样转发,但它和 path 一起进 http.request,再被引擎的 parseurl 解析:只许可见 ASCII
 *  (`#` 另行整串拒)—— 空白 / 0xA0 / 0xFEFF / 非 ASCII 会让 parseurl 退回 url.parse 分支。比 path 宽:
 *  浏览器的 WHATWG URL 不转义 query 里的 `{}|^[]` 等,收成 pchar 会误伤正常请求。 */
const ENGINE_QUERY_CHARS = /^[\x21-\x7e]*$/

/**
 * /engine 之后的路径规整(匹配与转发**用同一份**,引擎看到的就是我们判过的):
 * 折叠重复斜杠、去尾斜杠;保守字符集之外的任何字符(含 `#`)、编码斜杠 / 编码反斜杠 / 编码点、`.` `..` 段
 * 一律拒(null)—— 这些是「匹配器与 Express 路由对同一串理解不同」的来源。大小写保留(参数里的 id 区分
 * 大小写),匹配时再降。
 */
export function normalizeEnginePath(raw: string): string | null {
  if (!ENGINE_PATH_CHARS.test(raw)) return null
  if (/%(?:2f|5c|2e)/i.test(raw)) return null
  const segs = raw.split('/').filter((x) => x !== '')
  if (segs.some((x) => x === '.' || x === '..')) return null
  return '/' + segs.join('/')
}

/**
 * 远端 /engine 请求目标(`/engine` 之后、含 query)→ 转给引擎的那一串,或 null(400 BAD_PATH)。
 * `#` 出现在请求目标的**任何位置**都拒:浏览器 / fetch 从不把片段发上线,只有手搓的原始 HTTP 客户端会,
 * 而它正是 Express 与我们分歧的那个口子(评审 A-desktop#0:三条 deny 路由经 `#` 被打穿)。
 * 返回值 = 被 engineRouteAccess 判过的 path + 原样 query;调用方只转发它,不再从 req.url 另取。
 */
export function engineTarget(rawAfterEngine: string): { path: string; query: string } | null {
  if (rawAfterEngine.includes('#')) return null
  const q = rawAfterEngine.indexOf('?')
  const rawPath = q >= 0 ? rawAfterEngine.slice(0, q) : rawAfterEngine
  const query = q >= 0 ? rawAfterEngine.slice(q) : ''
  if (query && !ENGINE_QUERY_CHARS.test(query.slice(1))) return null
  const path = normalizeEnginePath(rawPath)
  return path ? { path, query } : null
}

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COMPILED_ROUTES = ENGINE_ROUTES.map((r) => ({
  method: r.method,
  access: r.access,
  re: new RegExp('^' + r.path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg.toLowerCase()))).join('/') + '$'),
}))

/**
 * 规整后路径的远端可达性。HEAD 按 GET 行判(Express 同样把 HEAD 交给 GET 处理器)。
 * 同一请求命中多行(字面段 vs :param)时**任一行是 deny 即拒** —— 不去复刻 Express 的注册顺序。
 * unknown = 表里没有(拼错的路径、运行期插件贡献的路由):调用方同样按拒绝处理。
 */
export function engineRouteAccess(method: string, normPath: string): 'allow' | 'deny' | 'unknown' {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const p = normPath.toLowerCase()
  let allowed = false
  for (const r of COMPILED_ROUTES) {
    if (r.method !== m || !r.re.test(p)) continue
    if (r.access !== 'allow') return 'deny'
    allowed = true
  }
  return allowed ? 'allow' : 'unknown'
}

/** RPC 里字节参数/返回值的 JSON 包裹形态(Uint8Array ↔ base64)。 */
const decodeRpcArgs = (args: unknown[]): unknown[] =>
  args.map((a) => (a && typeof a === 'object' && typeof (a as { __u8?: unknown }).__u8 === 'string')
    ? Buffer.from((a as { __u8: string }).__u8, 'base64')
    : a)
const encodeRpcResult = (r: unknown): unknown =>
  r instanceof Uint8Array ? { __u8: Buffer.from(r).toString('base64') } : r

export interface UnitWebDeps {
  account?: {
    metadata: () => { apiBase: string; loginPath: string } | undefined
    handle: (path: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
  }
  /** Optional generic backend contributions. true means the request was accepted. */
  routeRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>
  routeUpgrade?: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean
  /** 本机 managed 引擎(未就绪 url=null → /engine 回 503)。token = 本机引擎令牌(TANGU_LOCAL_TOKEN,契约 C2);
   *  remoteMark = 远端来源标记密钥(TANGU_REMOTE_MARK_SECRET,契约 C1),缺省则只盖来源不盖标记。 */
  getEngine: () => { url: string | null; token: string; remoteMark?: string }
  /** B 侧原生确认框:展示设备名+6 位码,用户点允许=true。 */
  confirmPair: (info: { name: string; code: string; ip: string }) => Promise<boolean>
  pairedDevices: {
    list: () => PairedDevice[]
    add: (d: PairedDevice) => Promise<void>
  }
  readPlugins: () => Promise<unknown[]>
  /** Space 配方清单(与 spaces:list IPC 同源):设备页没有它装不出插件 Space,Ribbon 上就没有插件图标。 */
  readSpaces: () => Promise<Array<{ slug: string; json: string; plugin?: string }>>
  /** UI 偏好配置面(白名单裁剪后的子集,绝不含 token/连接键):设备页据此长出 Agent Desk 等
   *  按 desktopConfig 门控的功能;写回同一张白名单(体验跟随本机设置,双向)。 */
  readConfig: () => Promise<Record<string, unknown>>
  writeConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 直连 provider 元数据(剥 apiKey/baseUrl):模型选择器认出直连模型;密钥绝不下发。 */
  readProviders: () => Promise<unknown[]>
  /** 主机文件只读(Desk/文件卡数据源):deps 层 realpath 钳制工作区根∪vault 根∪host 会话根;
   *  越界/不存在=null。maxBytes:隧道路径信封余量(b64 双重膨胀),超限回 tooLarge 而非撑爆信封。 */
  readHostFile: (p: string, maxBytes?: number) => Promise<{ mimeType: string; content: string; size: number; mtimeMs?: number; tooLarge?: boolean } | null>
  /** 主机文件下载(P1-DL,/unit/hostfile/download):与 readHostFile **同一个解析**(main.ts openUnitScopedFile ——
   *  realpath 钳制 + 凭据硬拒 + 校验与读取绑同一 FileHandle,只认普通文件);越界 / 不存在 / 不可读 = null(统一 404)。
   *  返回已打开的句柄,unitWeb 流式写出并负责关闭。缺省 = 这台不提供下载(501)。 */
  openHostFile?: (p: string) => Promise<{ fh: FileHandle; real: string; size: number } | null>
  /** 主机目录列表/条目 stat(工作台文件面板/悬停提示):钳制同上,目录类可指根本身;越界=null。 */
  readHostDir: (p: string) => Promise<Array<{ name: string; isDir: boolean; size: number; path: string }> | null>
  readHostStat: (p: string) => Promise<{ isDir: boolean; mtimeMs: number; birthtimeMs: number | null; files?: number; folders?: number } | null>
  meta: { instanceId: string; name: string; version: string }
  /** Explicit web publishing only exposes code/layout. Host data keeps the pairing boundary. */
  projection?: { mode: 'public' | 'local'; basePath: string; product: ProductProfile; capabilities?: () => object; localCapabilities?: () => { vault: boolean; engine: boolean; host: boolean } }
  /** P2P 应答(方案 §12,可缺省):收 offer SDP 出 answer SDP,DataChannel 开门后由主进程把
   *  信道接到本机 unitWeb(attachHostChannel)。缺省 = 本端不支持 P2P,路由回 501。 */
  p2pAnswer?: (offerSdp: string) => Promise<string>
  /** web 构建目录(TANGU_UNIT_WEB_DIST / 捆包路径);null = 出「未捆构建」提示页。 */
  webDistDir: () => string | null
  /** 本地 vault 面(registerAmadeusIpc 返回;懒取 —— unitWeb 可能先于它起)。null = /vault/* 回 503。 */
  vault: () => VaultFace | null
  log: (m: string) => void
  // P1-K4 ── 「允许远程会话」会话档闸(remoteSessions.ts 的 gate;INTEGRATION R-07:同步,绝不等弹框)。
  //   缺省且非 ownerProjection → /engine 只放基础档(fail closed),/unit/remote-access 回「未开启」。
  //   只管 /engine(G9):/unit/host*、/vault/* 维持 P0 现状。
  remoteAccess?: {
    gateEngine: (q: { method: string; path: string; via: UnitIngress | null; caller: UnitCaller }) => GateResult
    status: (caller: UnitCaller) => RemoteAccessStatus
    request: (caller: UnitCaller) => Promise<RemoteAccessStatus>
  }
  // P1-K2 ── 急停后的远程锁定(remoteSafety.isLocked,同步内存镜像;每请求现查)。缺省 = 未锁(便携 Unit 不传)。
  //   锁定时非本机入口只剩读 + 中止(remoteLockGate.ts);工作区主人(projection local)不受影响。
  remoteLock?: () => boolean
}

export interface UnitWebHandle {
  port: number
  /** 隧道(unitHost)豁免鉴权用的 per-boot 内部密钥;仅 loopback 来源有效。 */
  internalSecret: string
  /** P2P 执行器(attachHostChannel)专用的 per-boot 密钥(x-unit-p2p);与隧道分钥,仅 loopback 有效。 */
  p2pSecret: string
  /** unitHost 签调用方断言(x-unit-caller)用的 per-boot 钥(P1 · K1);与上面两把、将来 /unit/mcp 的钥都不同。 */
  proxyCallerKey: string
  close: () => Promise<void>
}

interface PendingPair { id: string; name: string; code: string; ip: string; expires: number; status: 'pending' | 'approved' | 'denied'; token?: string }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const PAIR_TTL_MS = 2 * 60_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  // vault 资源面(/vault/asset)常见附件类型
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.md': 'text/markdown; charset=utf-8',
}

/** 远程下载主机文件的单文件上限(与手机原生中继 UnitRelay.MAX_RESPONSE_BYTES 同档)。超了回 413,不开流。 */
export const HOST_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024

/** 下载的 Content-Type:按扩展名(静态资产表 + 常见办公 / 归档类型),认不出 = octet-stream。 */
const DOWNLOAD_MIME: Record<string, string> = {
  ...MIME,
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
}

/** RFC 6266 / 5987:ASCII 兜底名(非 ASCII、引号、反斜杠换成 _)+ filename* 原名(UTF-8 百分号编码)。
 *  中文文件名(`介绍….docx`)只放在 filename* 里 —— 头值必须是 latin1,原样塞进去 Node 直接抛。 */
export function attachmentDisposition(name: string): string {
  const safe = name.replace(/[\r\n]/g, '') || 'download'
  const ascii = safe.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

/** 内部密钥头比对(定长比较;缺头 / 多值头 / 长度不符一律不等)。 */
const secretEq = (got: string | string[] | undefined, want: string): boolean => {
  if (typeof got !== 'string' || !want) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 缺 web 构建时的提示页(只会出现在 dev:打包链前置构建 + builder 缺产物即失败)。 */
const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Forsion Unit</title>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.7">
<h2>本机未捆 web 构建</h2>
<p>这台 Forsion 的互联服务已在运行,但缺少网页渲染层构建产物。</p>
<p>在这台设备上执行:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:8px">cd Forsion-Genesis/desktop && node scripts/build-unit-web.mjs</pre>
<p>或设置环境变量 <code>TANGU_UNIT_WEB_DIST</code> 指向已有的 web 构建目录后重启 Forsion。</p></body>`

export function startUnitWeb(deps: UnitWebDeps, opts: { port: number; bindHost?: string }): Promise<UnitWebHandle> {
  if (deps.projection && !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(deps.projection.basePath)) {
    throw new Error('Projection basePath must be an absolute path ending in /')
  }
  const internalSecret = randomUUID()
  const p2pSecret = randomBytes(32).toString('hex')
  const proxyCallerKey = randomBytes(32).toString('hex')
  /** 调用方断言的重放表:派发 id → 过期时刻(gc() 清理)。只记验签全过的,表长 ≤ 合法请求速率 × 120s。 */
  const seenCallerDispatch = new Map<string, number>()
  /** 便携 Unit 的本地投影(projection local)里,唯一能过鉴权的是工作区主人的访问密钥 —— 那是主人自己的界面,
   *  不是「另一台设备」:/engine 维持直通、不盖远端标记,不可逆 vault 删除照常可用。桌面(main.ts)从不传 projection,
   *  所以桌面的三条远端通路恒走允许清单(unitWeb.test 两个方向都钉住)。 */
  const ownerProjection = deps.projection?.mode === 'local'
  const pending = new Map<string, PendingPair>()
  const pendingByIp = new Map<string, string>()
  // 短时资源令牌(<img>/EventSource 带不了 Authorization → ?at= 查询串;照 amadeus-cloud 先例)。
  // 记发行者的配对 hash:配对被回收后,它签发过的资源令牌立即失效(Codex P2——否则被回收设备
  // 还能凭手里的 at 继续收 10 分钟的库活动)。internal(隧道)签发的 pairHash=null,不受回收影响。
  const assetTokens = new Map<string, { exp: number; pairHash: string | null }>()
  const ASSET_TTL_MS = 10 * 60_000

  const gc = (): void => {
    const now = Date.now()
    for (const [id, p] of pending) {
      if (p.expires < now) {
        pending.delete(id)
        if (pendingByIp.get(p.ip) === id) pendingByIp.delete(p.ip)
      }
    }
    for (const [t, rec] of assetTokens) if (rec.exp < now) assetTokens.delete(t)
    gcSeenCallers(seenCallerDispatch, now)
  }

  /** 鉴权:配对令牌(hash 比对)或「loopback + 内部密钥」(隧道 / P2P 各一把,server 已验 owner / 信令来路背书)。
   *  返回来路:via=哪条通路;pairHash=命中的配对记录(回收后再验即失败;隧道与 P2P 为 null)。 */
  const authInfo = (req: http.IncomingMessage): { ok: boolean; pairHash: string | null; via: UnitIngress | null } => {
    if (isLoopback(req.socket.remoteAddress)) {
      if (secretEq(req.headers[UNIT_INTERNAL_HEADER], internalSecret)) return { ok: true, pairHash: null, via: 'tunnel' }
      if (secretEq(req.headers[UNIT_P2P_HEADER], p2pSecret)) return { ok: true, pairHash: null, via: 'p2p' }
    }
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))
    if (!m) return { ok: false, pairHash: null, via: null }
    const h = sha256(m[1])
    const hit = deps.pairedDevices.list().some((d) => d.tokenHash === h)
    return { ok: hit, pairHash: hit ? h : null, via: hit ? 'lan' : null }
  }
  const authed = (req: http.IncomingMessage): boolean => authInfo(req).ok
  /** 局域网来路命中的配对记录(K4:paired 调用方的 pairId / 名字);隧道 / P2P 恒 null。 */
  const pairInfo = (info: { pairHash: string | null }): { pairId: string; name: string } | null => {
    if (!info.pairHash) return null
    const d = deps.pairedDevices.list().find((x) => x.tokenHash === info.pairHash)
    return d ? { pairId: d.id, name: d.name } : null
  }

  /**
   * 调用方断言(P1 · K1,INTEGRATION §1.2):**每个请求只调一次** —— 验过即消费重放表,第二次调必回失败。
   * 只对隧道来路验;局域网 / P2P 来路的 x-unit-caller 一律无视(不验、不转):那两条路没有 hub 盖章,
   * 就算带着用正确钥签出的断言也不作数(K1 S5)。隧道上缺头 = 账号级未识别(caller:null);在场却验不过 → ok:false
   * (调用方回 403 BAD_CALLER_ASSERTION,不降级)。/engine 分支与 K4 的 /unit/remote-access* 共用。
   */
  const resolveCaller = (req: http.IncomingMessage, info: { via: UnitIngress | null }): { ok: true; caller: ProxyCaller | null } | { ok: false } => {
    if (info.via !== 'tunnel') return { ok: true, caller: null }
    const raw = req.headers[UNIT_CALLER_HEADER]
    if (raw === undefined) return { ok: true, caller: null }
    if (typeof raw !== 'string') return { ok: false }
    const r = verifyProxyCaller(proxyCallerKey, raw, { method: req.method || 'GET', url: req.url || '' }, seenCallerDispatch)
    if (!r.ok) { deps.log(`[unit-web] 调用方断言无效(${r.reason}),已拒绝`); return { ok: false } }
    return { ok: true, caller: r.caller }
  }

  /** 资源令牌活性:未过期 + 发行者(若为配对设备)仍在已配对列表里。 */
  const assetTokenLive = (at: string): boolean => {
    const rec = assetTokens.get(at)
    if (!rec || rec.exp < Date.now()) return false
    return rec.pairHash === null || deps.pairedDevices.list().some((d) => d.tokenHash === rec.pairHash)
  }

  /** 远程 asset 面的真实路径边界:软链能把词法钳制过的路径带出库根(Codex P2)——
   *  realpath 后必须仍在 realpath(库根) 之下才许伺服。 */
  const underVaultReal = async (abs: string, rootRaw: string | null): Promise<string | null> => {
    if (!rootRaw) return null
    try {
      const [real, rootReal] = await Promise.all([realpath(abs), realpath(rootRaw)])
      return real === rootReal || real.startsWith(rootReal + sep) ? real : null
    } catch {
      return null // 不存在/不可达一律 404
    }
  }

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const buf = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length })
    res.end(buf)
  }

  const readBody = (req: http.IncomingMessage, limit = 64 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      let n = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        n += c.length
        if (n > limit) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  /** /engine/* 反代:剥外来身份、盖本机引擎 token,请求/响应双向原始管道(SSE 天然直通)。 */
  const isLocalOnlyEnginePath = (path: string): boolean => {
    let p = path
    try { p = decodeURIComponent(new URL(path, 'http://x').pathname) } catch { /* 解不开就按原样比 */ }
    return p.toLowerCase().replace(/\/{2,}/g, '/').startsWith('/engine/agent/browser-extension')
  }

  /** /engine/* 反代:剥外来身份、盖本机引擎 token,请求/响应双向原始管道(SSE 天然直通)。
   *  via 非空 = 远端来路:盖 x-forsion-remote(+ 标记密钥)。头是**白名单拷贝**,入站的 x-forsion-remote* / x-unit-caller
   *  (以及一切别的头)根本不会被带过去 —— 远端没法把自己伪装成别的通路或本机。
   *  caller = resolveCaller 验过的调用方:只在隧道来路盖 x-forsion-remote-caller(引擎在 marked && tunnel 时才读)。 */
  const proxyEngine = (req: http.IncomingMessage, res: http.ServerResponse, path: string, via: UnitIngress | null, caller: ProxyCaller | null): void => {
    const engine = deps.getEngine()
    if (!engine.url) { json(res, 503, { detail: '本机引擎未就绪', code: 'ENGINE_NOT_READY' }); return }
    const target = new URL(engine.url)
    // x-forsion-remote:设备页自报的 client 也是 desktop/,引擎靠这个头区分本机与远程(电脑历史等本机专属工具据此拒绝)。
    // 头表从零重建,远端页剥不掉;只有便携 Unit 的工作区主人(via=null)不盖。
    const headers: Record<string, string> = { Authorization: `Bearer ${engine.token}` }
    for (const k of ['content-type', 'accept', 'content-length'] as const) {
      const v = req.headers[k]
      if (typeof v === 'string') headers[k] = v
    }
    if (via) {
      headers['x-forsion-remote'] = via
      if (engine.remoteMark) headers['x-forsion-remote-mark'] = engine.remoteMark
      if (via === 'tunnel' && caller) headers[ENGINE_CALLER_HEADER] = encodeEngineCaller(caller)
    }
    const up = http.request({
      host: target.hostname,
      port: target.port,
      path,
      method: req.method,
      headers,
    }, (upRes) => {
      const h: Record<string, string> = {}
      for (const k of ['content-type', 'cache-control'] as const) {
        const v = upRes.headers[k]
        if (typeof v === 'string') h[k] = v
      }
      if (String(upRes.headers['content-type'] || '').includes('text/event-stream')) h['X-Accel-Buffering'] = 'no'
      res.writeHead(upRes.statusCode || 502, h)
      upRes.pipe(res)
      res.on('close', () => upRes.destroy())
    })
    up.on('error', (e) => { if (!res.headersSent) json(res, 502, { detail: `本机引擎不可达: ${e.message}` }) })
    req.pipe(up)
  }

  const serveStatic = async (res: http.ServerResponse, urlPath: string): Promise<void> => {
    const dist = deps.webDistDir()
    if (!dist) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(PLACEHOLDER)
      return
    }
    // SPA:无扩展名的路径一律回 index.html;路径穿越一律拒。
    let rel = decodeURIComponent(urlPath.split('?')[0])
    if (!extname(rel)) rel = '/index.html'
    const norm = normalize(rel).replace(/^([/\\])+/, '')
    if (norm.startsWith('..')) { json(res, 400, { detail: 'bad path' }); return }
    try {
      const [rootReal, fileReal] = await Promise.all([realpath(dist), realpath(`${dist}/${norm}`)])
      if (!fileReal.startsWith(rootReal + sep)) { json(res, 404, { detail: 'not found' }); return }
      let buf = await readFile(fileReal)
      const ext = extname(norm)
      if (norm === 'index.html') {
        // 注入 unit 标记 + 元数据:同一份 web 构建两用,web/src/main.tsx 据此在登录跳转之前改装 unitShim。
        const encode = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')
        const meta = { ...deps.meta, ...(deps.projection ? { projection: deps.projection.mode, browserStorage: deps.projection.mode === 'public', account: deps.account?.metadata(), capabilities: deps.projection.capabilities?.(), localCapabilities: deps.projection.mode === 'local' ? deps.projection.localCapabilities?.() : undefined } : {}) }
        const baseTag = deps.projection ? `<base href="${deps.projection.basePath}">` : ''
        const inject = `${baseTag}<script>window.__FORSION_UNIT_PAGE__=${encode(meta)};window.__FORSION_PRODUCT_RUNTIME__=${encode(deps.projection?.product ?? PRODUCT)}</script>`
        let html = buf.toString('utf8').replace(/<head>/i, `<head>${inject}`)
        // ⚠️ 设备页必须放行 'unsafe-eval':插件宿主用 new Function 求值插件代码,而 web 构建的
        // CSP(script-src 'self' 'unsafe-inline')没它 —— 19 个插件会**全部** setup 失败,页面看起来
        // 就是「插件和视图都没了」(2026-08-24 真机实测)。云端 web 那份 index 不动(它本就不装插件)。
        // 信任面:这里跑的是 B 自己装的插件,与 B 桌面端同一信任级;附件的惰化另走 /vault/asset 的 CSP sandbox。
        // 两步走(别塞一个巨型正则:CSP 值自带单引号 'self'/'unsafe-inline',一步匹配会在那里断掉):
        // ① 揪出 CSP meta 标签 ② 只在它的 script-src 指令尾部补 'unsafe-eval',其余指令原样。
        html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i, (tag) =>
          tag.replace(/(content=(["']))([\s\S]*?)\2/i, (_m, head: string, quote: string, csp: string) => {
            const next = csp.includes("'unsafe-eval'")
              ? csp
              : csp.replace(/script-src([^;]*)/i, (_d, srcs: string) => `script-src${srcs} 'unsafe-eval'`)
            return `${head}${next}${quote}`
          }))
        buf = Buffer.from(html)
      }
      const h: Record<string, string | number> = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length }
      // index(含 SPA 回退)必须每次回源验新:CSP 修复等都烙在注入后的 HTML 里,复用旧页面=修复永不生效。
      // assets/* 带内容 hash,放心长缓存。
      if (norm === 'index.html') h['Cache-Control'] = 'no-cache'
      else if (/^assets[\\/]/.test(norm)) h['Cache-Control'] = 'public, max-age=31536000, immutable'
      res.writeHead(200, h)
      res.end(buf)
    } catch {
      json(res, 404, { detail: 'not found' })
    }
  }

  /**
   * /unit/hostfile 与 /unit/hostfile/download 共用的请求闸(P1-DL,两条永不分叉):鉴权(配对令牌 / 隧道 / P2P 内部密钥)→ 取 path。
   * 急停锁定(K2)在 handler 顶层对二者同判(GET = 读,放行);K4 会话档闸按 G9 只管 /engine,/unit/host* 都不过它。
   * 文件解析(realpath 钳制 / 凭据硬拒 / fd 绑定)在 deps 层同一个函数里(main.ts openUnitScopedFile)。
   */
  const hostFileRequest = (req: http.IncomingMessage, res: http.ServerResponse, url: string): { p: string; via: UnitIngress | null } | null => {
    const info = authInfo(req)
    if (!info.ok) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return null }
    return { p: String(new URL(url, 'http://x').searchParams.get('path') || ''), via: info.via }
  }

  /** 把主机文件原样流出去(下载)。句柄来自 deps.openHostFile,这里负责关(流结束 / 出错 / 客户端断开都关)。 */
  const sendHostDownload = async (res: http.ServerResponse, p: string): Promise<void> => {
    if (!deps.openHostFile) { json(res, 501, { detail: 'Host file download is not available on this device', code: 'HOST_DOWNLOAD_UNSUPPORTED' }); return }
    const f = await deps.openHostFile(p)
    if (!f) { json(res, 404, { detail: 'not readable' }); return }
    if (f.size > HOST_DOWNLOAD_MAX_BYTES) {
      await f.fh.close().catch(() => {})
      json(res, 413, { detail: `File is larger than the ${HOST_DOWNLOAD_MAX_BYTES / 1048576} MB remote download limit`, code: 'HOST_DOWNLOAD_TOO_LARGE', size: f.size, limit: HOST_DOWNLOAD_MAX_BYTES })
      return
    }
    const name = p.split(/[\\/]/).filter(Boolean).pop() || 'download'
    res.writeHead(200, {
      'Content-Type': DOWNLOAD_MIME[extname(f.real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': attachmentDisposition(name),
      // 同 /vault/asset:主机文件是不受信内容。隧道的 /stream 面不转 Content-Disposition,有人把下载链接当页面直开时,
      // HTML / SVG 会在鉴权过的 proxy origin 上执行 —— nosniff + CSP sandbox 惰化(网关宣告 stream-sec-headers 才走流式,见 unitHost.streamWorthy)。
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'no-store',
    })
    if (f.size === 0) { await f.fh.close().catch(() => {}); res.end(); return }
    // 读到 stat 时的长度为止:文件还在写也不会多出 Content-Length 之外的字节(少了 = 连接提前断,客户端当失败)。
    const stream = f.fh.createReadStream({ start: 0, end: f.size - 1 }) // autoClose:结束 / destroy 即关句柄
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  /** 请求路径(剥掉 projection 前缀、去 query)—— 顶层锁定闸用;不做 308 之类的副作用,那些仍在下面原位。 */
  const plainPath = (req: http.IncomingMessage): string => {
    let u = req.url || '/'
    if (deps.projection) {
      const prefix = deps.projection.basePath.replace(/\/$/, '')
      if (u.startsWith(prefix + '/')) u = u.slice(prefix.length)
    }
    return u.split('?')[0]
  }
  /** P1-K2:锁状态读不出按锁定(fail closed)。 */
  const lockedNow = (): boolean => {
    if (!deps.remoteLock) return false
    try { return deps.remoteLock() } catch { return true }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // P1-K2 顶层锁定闸(routeRequest 之前,INTEGRATION §2.3):/engine 与 /vault/rpc 各在分支里按更细的表判,工作区主人不受影响。
    if (!ownerProjection && lockedNow()) {
      const p = plainPath(req)
      if (!(p === '/engine' || p.startsWith('/engine/')) && p !== '/vault/rpc' && !lockedRequestAllowed(req.method || 'GET', p)) {
        json(res, 423, REMOTE_LOCKED_BODY)
        return
      }
    }
    if (await deps.routeRequest?.(req, res)) return
    gc()
    let url = req.url || '/'
    if (deps.projection) {
      const prefix = deps.projection.basePath.replace(/\/$/, '')
      if (url === prefix || url.startsWith(prefix + '?')) {
        res.writeHead(308, { Location: prefix + '/' + url.slice(prefix.length) }); res.end(); return
      }
      if (url.startsWith(prefix + '/')) url = url.slice(prefix.length)
    }
    const path = url.split('?')[0]
    const ip = req.socket.remoteAddress || 'unknown'

    // A published shell is a website. It publishes installed plugin code and layouts,
    // never the publisher's vault, engine, credentials, settings, or pairing endpoints.
    if (deps.projection?.mode === 'public') {
      if (await deps.account?.handle(path, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { detail: 'Read-only projection' }); return }
      if (path === '/unit/whoami') { json(res, 200, { ok: true, scope: 'shell' }); return }
      if (path === '/unit/plugins') { json(res, 200, { appVersion: deps.meta.version, plugins: await deps.readPlugins() }); return }
      if (path === '/unit/spaces') { json(res, 200, { spaces: await deps.readSpaces() }); return }
      if (path === '/unit/config') { json(res, 200, { config: {} }); return }
      if (path === '/unit/providers') { json(res, 200, { providers: [] }); return }
      if (path === '/unit/meta') { json(res, 200, { ...deps.meta, pair: false, projection: 'public', account: deps.account?.metadata(), capabilities: deps.projection?.capabilities?.() }); return }
      if (/^\/(?:unit|vault|engine)(?:\/|$)/.test(path)) { json(res, 403, { detail: 'Host capability is not published' }); return }
    }

    // ── 公开面(无鉴权):元数据 / 配对流 / 静态壳(壳只是代码,数据面全在鉴权后) ──
    if (path === '/unit/meta' && req.method === 'GET') {
      json(res, 200, { ...deps.meta, pair: !deps.projection, ...(deps.projection?.mode === 'local' ? { projection: 'local', localCapabilities: deps.projection.localCapabilities?.() } : {}) })
      return
    }
    if (deps.projection?.mode === 'local' && path.startsWith('/unit/pair/')) { json(res, 403, { detail: 'Use the workspace owner access key' }); return }
    if (path === '/unit/pair/request' && req.method === 'POST') {
      const prevId = pendingByIp.get(ip)
      if (prevId && pending.get(prevId)?.status === 'pending') { json(res, 429, { detail: '已有待确认的配对请求', code: 'PAIR_PENDING' }); return }
      let name = '未命名设备'
      try { name = String(JSON.parse(await readBody(req))?.name || name).slice(0, 60) } catch { /* 缺 body 用默认名 */ }
      const p: PendingPair = {
        id: randomUUID(),
        name,
        code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
        ip,
        expires: Date.now() + PAIR_TTL_MS,
        status: 'pending',
      }
      pending.set(p.id, p)
      pendingByIp.set(ip, p.id)
      json(res, 200, { requestId: p.id, code: p.code, ttlMs: PAIR_TTL_MS })
      // 弹 B 侧原生确认框(异步;poll 端点回传结果)。
      void deps.confirmPair({ name: p.name, code: p.code, ip }).then(async (ok) => {
        const live = pending.get(p.id)
        if (!live || live.status !== 'pending' || live.expires < Date.now()) return
        if (!ok) { live.status = 'denied'; return }
        const token = randomBytes(32).toString('hex')
        await deps.pairedDevices.add({ id: randomUUID(), name: live.name, tokenHash: sha256(token), createdAt: Date.now() })
        live.status = 'approved'
        live.token = token
        deps.log(`[unit-web] 已配对设备「${live.name}」(${ip})`)
      }).catch((e) => deps.log(`[unit-web] 配对确认失败: ${e?.message || e}`))
      return
    }
    if (path === '/unit/pair/poll' && req.method === 'GET') {
      const id = String(new URL(url, 'http://x').searchParams.get('id') || '')
      const p = pending.get(id)
      if (!p || p.expires < Date.now()) { json(res, 200, { status: 'expired' }); return }
      if (p.status === 'approved' && p.token) {
        const token = p.token
        pending.delete(id)
        pendingByIp.delete(p.ip)
        json(res, 200, { status: 'approved', token }) // 令牌只下发一次
        return
      }
      json(res, 200, { status: p.status })
      return
    }

    // ── 鉴权面 ──
    if (path === '/unit/whoami' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { ok: true })
      return
    }
    // P2P 信令(方案 §12):A 经隧道/配对面送 offer,这端出 answer。**信任裁决 = T2 权限等价体**:
    // 同账号(隧道 owner 已验)或已配对设备即许,无 B 侧确认框——T1 的 6 位码是给无账号 LAN 配对的,
    // P2P 的身份已由信令来路背书;连上之后的能力面与该来路完全一致(同一个 unitWeb)。
    if (path === '/unit/p2p/offer' && req.method === 'POST') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      if (!deps.p2pAnswer) { json(res, 501, { detail: '本端不支持 P2P 直连', code: 'P2P_UNSUPPORTED' }); return }
      let offer = ''
      try { offer = String(JSON.parse(await readBody(req))?.sdp || '') } catch { /* 落空走下面的 400 */ }
      if (!offer) { json(res, 400, { detail: '缺 offer SDP' }); return }
      try {
        json(res, 200, { sdp: await deps.p2pAnswer(offer) })
      } catch (e: any) {
        json(res, 500, { detail: `P2P 应答失败: ${e?.message || e}` })
      }
      return
    }
    if (path === '/unit/plugins' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { appVersion: deps.meta.version, plugins: await deps.readPlugins() })
      return
    }
    // 只读 Space 配方面(纯数据布局,无 shell 面):设备页 loadUserSpaces 的数据源,缺了它插件 view 无入口。
    if (path === '/unit/spaces' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { spaces: await deps.readSpaces() })
      return
    }
    // 直连 provider 元数据(剥密):模型选择器数据源。
    if (path === '/unit/providers' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { providers: await deps.readProviders() })
      return
    }
    // 主机文件只读(钳制在 deps 层):越界与不存在同样 404,不泄露存在性。
    //   /unit/hostfile          = 预览(base64 JSON,隧道上 4MB 封顶走 tooLarge);
    //   /unit/hostfile/download = 下载原文件(P1-DL:流式;隧道上 > 256KB 的走 unitHost 的 stream 回包,不进 10MB 信封)。
    // 两条共用同一道请求闸(hostFileRequest)与 deps 层同一个文件解析(openUnitScopedFile),判据永不分叉。
    if ((path === '/unit/hostfile' || path === '/unit/hostfile/download') && req.method === 'GET') {
      const q = hostFileRequest(req, res, url)
      if (!q) return
      if (path === '/unit/hostfile/download') { await sendHostDownload(res, q.p); return }
      // 隧道来的请求(unitHost 带内部密钥):响应还要整体再 base64 进 10MB 信封,原文超 ~4MB 就撑爆
      // → 传更小上限,超限走 tooLarge(渲染层有兜底 UI)而不是超时(Codex P2)。
      const f = await deps.readHostFile(q.p, q.via === 'tunnel' ? 4 * 1024 * 1024 : undefined)
      if (!f) { json(res, 404, { detail: 'not readable' }); return }
      json(res, 200, f)
      return
    }
    // 主机目录列表 / 条目 stat(只读;钳制同 hostfile,目录类可指根本身)。
    if ((path === '/unit/hostdir' || path === '/unit/hoststat') && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      const p = String(new URL(url, 'http://x').searchParams.get('path') || '')
      const r = path === '/unit/hostdir' ? await deps.readHostDir(p) : await deps.readHostStat(p)
      if (!r) { json(res, 404, { detail: 'not readable' }); return }
      json(res, 200, path === '/unit/hostdir' ? { entries: r } : r)
      return
    }
    // UI 偏好配置面(白名单子集,读写对称;deps 负责裁剪 —— 这里绝不直接碰 config 全量)。
    if (path === '/unit/config' && (req.method === 'GET' || req.method === 'PUT')) {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      if (req.method === 'GET') { json(res, 200, { config: await deps.readConfig() }); return }
      let patch: Record<string, unknown>
      try { patch = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { json(res, 400, { detail: 'bad body' }); return }
      json(res, 200, { config: await deps.writeConfig(patch && typeof patch === 'object' ? patch : {}) })
      return
    }
    // P1-K4 ── 调用方看自己的远程会话状态 / 主动请求本机确认(手机「选在这台电脑上运行」先拿到「等待确认」)。
    // 只回调用方自己的状态,永不回信任列表;同 /engine 的 authInfo → resolveCaller → callerOf(断言验不过 403,不降级)。
    if ((path === '/unit/remote-access' && req.method === 'GET') || (path === '/unit/remote-access/request' && req.method === 'POST')) {
      const info = authInfo(req)
      if (!info.ok) { json(res, 401, { detail: 'Not paired', code: 'UNPAIRED' }); return }
      const rc = resolveCaller(req, info)
      if (!rc.ok) { json(res, 403, BAD_CALLER_BODY); return }
      const caller = callerOf(info.via, pairInfo(info), rc.caller)
      const ra = deps.remoteAccess
      if (!ra) { // 没有闸 = 只有基础档(fail closed),如实报「未开启」
        json(res, 200, { remoteSessions: false, principal: caller.kind === 'paired' ? 'lan' : caller.kind, caller: caller.kind === 'paired' ? 'paired' : 'unconfirmed', maxApprovalMode: 'auto-edit' } satisfies RemoteAccessStatus)
        return
      }
      json(res, 200, path === '/unit/remote-access' ? ra.status(caller) : await ra.request(caller))
      return
    }
    // /engine 分支的次序由 INTEGRATION §2.3 钉死(K1 → K4 → K2 按此插入,不自行调序):
    // 鉴权 → 投影主人直通 → 路径规整 → 允许清单 → 调用方断言(K1)→ 急停锁定(K2)→ 会话档闸(K4)→ 反代。
    if (path === '/engine' || path.startsWith('/engine/')) {
      const method = req.method || 'GET'
      const info = authInfo(req)
      if (!info.ok) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      if (isLocalOnlyEnginePath(url)) {
        if (!engineTarget(url.slice('/engine'.length))) { json(res, 400, { detail: 'Ambiguous engine path', code: 'BAD_PATH' }); return }
        json(res, 403, LOCAL_ONLY_BODY); return
      }
      if (ownerProjection) { proxyEngine(req, res, url.slice('/engine'.length) || '/', null, null); return }
      // default-deny 允许清单:规整后的路径既用来判,也原样转给引擎(query 不动)。判的是**整个请求目标**
      // (url,不是按 `?` 切过的 path):`#` 可能藏在 query 之后,也可能藏在路径里。
      const target = engineTarget(url.slice('/engine'.length))
      if (!target) { json(res, 400, { detail: 'Ambiguous engine path', code: 'BAD_PATH' }); return }
      if (engineRouteAccess(method, target.path) !== 'allow') { json(res, 403, LOCAL_ONLY_BODY); return }
      const rc = resolveCaller(req, info) // K1:每请求只调一次(重放表一次性消费)
      if (!rc.ok) { json(res, 403, BAD_CALLER_BODY); return }
      if (lockedNow() && !lockedEngineAllowed(method, target.path)) { json(res, 423, REMOTE_LOCKED_BODY); return } // K2:锁定只剩读 + 中止(先于 K4 闸,R-26)
      const caller = callerOf(info.via, pairInfo(info), rc.caller) // K4:会话档闸(同步;缺省只放基础档)
      const g = deps.remoteAccess ? deps.remoteAccess.gateEngine({ method, path: target.path, via: info.via, caller }) : baseTierOnly(method, target.path)
      if (!g.ok) { json(res, g.status, g.body); return }
      proxyEngine(req, res, target.path + target.query, info.via, rc.caller)
      return
    }

    // ── 本地 vault 面(v2.1):设备页里的 Amadeus 显示/编辑本机笔记库 ──
    if (path.startsWith('/vault/')) {
      const vault = deps.vault()
      if (!vault) { json(res, 503, { detail: '本机智库面未就绪', code: 'VAULT_NOT_READY' }); return }
      const q = new URL(url, 'http://x').searchParams
      const at = String(q.get('at') || '')
      const assetAuthed = (): boolean => (at !== '' && assetTokenLive(at)) || authed(req)

      if (path === '/vault/rpc' && req.method === 'POST') {
        if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
        let body: { ch?: string; args?: unknown[]; client?: unknown }
        // 32MB:附件上传按 b64 膨胀 ~4/3;隧道路径另受 server 信封 10MB 顶(见方案 §9,LAN 不受限)。
        try { body = JSON.parse(await readBody(req, 32 * 1024 * 1024)) } catch { json(res, 400, { detail: 'bad body' }); return }
        const ch = String(body.ch || '')
        if (!VAULT_RPC_ALLOW.has(ch)) { json(res, 400, { detail: `通道不可远程调用: ${ch}`, code: 'VAULT_CH_DENIED' }); return }
        if (!ownerProjection && VAULT_RPC_LOCAL_ONLY.has(ch)) { json(res, 403, LOCAL_ONLY_BODY); return }
        if (!ownerProjection && lockedNow() && !VAULT_RPC_READ.has(ch)) { json(res, 423, REMOTE_LOCKED_BODY); return } // P1-K2:锁定只剩只读通道
        // 远端客户端自报 clientId → 事件 origin(回声按 origin 判);走 body 因为隧道信封不带自定义头;限长防注水。
        const origin = String(body.client || '').slice(0, 64) || null
        try {
          const result = await vault.call(ch, decodeRpcArgs(Array.isArray(body.args) ? body.args : []), origin)
          json(res, 200, { ok: true, result: encodeRpcResult(result) ?? null })
        } catch (e) {
          json(res, 200, { ok: false, error: String((e as Error)?.message || e) })
        }
        return
      }

      if (path === '/vault/asset-token' && req.method === 'POST') {
        const info = authInfo(req)
        if (!info.ok) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
        const token = randomBytes(16).toString('hex')
        assetTokens.set(token, { exp: Date.now() + ASSET_TTL_MS, pairHash: info.pairHash })
        json(res, 200, { token, ttlSec: ASSET_TTL_MS / 1000 })
        return
      }

      if (path === '/vault/asset' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!assetAuthed()) { json(res, 401, { detail: '资源令牌无效', code: 'ASSET_TOKEN' }); return }
        const exact = q.get('path')
        let abs: string | null = null
        try {
          abs = exact != null
            ? vault.absPath(exact) // 树/侧栏点开:路径精确,不走 ref 的 basename 兜底
            : await vault.assetAbs(q.get('page'), String(q.get('ref') || ''))
        } catch { /* 越界/无库 → 404 */ }
        // 词法钳制挡不住库内软链指向库外(Codex P2):realpath 后仍须在库根之下。
        const real = abs ? await underVaultReal(abs, vault.root()) : null
        if (!real) { json(res, 404, { detail: 'not found' }); return }
        const stream = createReadStream(real) // ponytail: 无 Range;远程视频拖进度条要 Range 再加
        stream.on('error', () => { if (!res.headersSent) json(res, 404, { detail: 'not found' }); else res.destroy() })
        stream.once('open', () => {
          const mime = MIME[extname(real).toLowerCase()] || 'application/octet-stream'
          const h: Record<string, string> = { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' }
          // 库内附件是不受信内容:HTML/SVG 直开会在本应用 origin 执行脚本(可读配对令牌+打 RPC)。
          // CSP sandbox 让文档落进 opaque origin 且禁脚本;<img>/媒体子资源解码不受此头影响。
          // PDF 豁免:Chromium 的 PDF 查看器在 sandbox 下拒渲,且它本身跑在独立扩展 origin。
          if (mime !== 'application/pdf') h['Content-Security-Policy'] = 'sandbox'
          res.writeHead(200, h)
          stream.pipe(res)
        })
        res.on('close', () => stream.destroy())
        return
      }

      if (path === '/vault/events' && req.method === 'GET') {
        if (!assetAuthed()) { json(res, 401, { detail: '资源令牌无效', code: 'ASSET_TOKEN' }); return }
        // 记住开流时的授权形态,事件与心跳逐次复验:配对被回收的设备不许继续收库活动(Codex P2)。
        const viaAt = at !== '' && assetTokenLive(at)
        const bearerInfo = viaAt ? null : authInfo(req)
        const stillAuthed = (): boolean => (viaAt ? assetTokenLive(at)
          : bearerInfo?.pairHash != null ? deps.pairedDevices.list().some((d) => d.tokenHash === bearerInfo.pairHash)
          : true) // 内部密钥(隧道 / P2P):per-boot 常量,server 已验 owner / 信令来路背书
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        const unsub = vault.onEvent((ch, payload, origin) => {
          if (!stillAuthed()) { res.end(); return }
          res.write(`data: ${JSON.stringify({ ch, payload, origin })}\n\n`)
        })
        const hb = setInterval(() => {
          if (!stillAuthed()) { res.end(); return }
          res.write(': hb\n\n')
        }, 25_000)
        res.on('close', () => { unsub(); clearInterval(hb) })
        return
      }

      json(res, 404, { detail: 'not found' })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { detail: 'method not allowed' }); return }
    await serveStatic(res, path)
  }

  const server = http.createServer((req, res) => {
    void handler(req, res).catch((e) => {
      deps.log(`[unit-web] 请求处理失败: ${e?.message || e}`)
      if (!res.headersSent) json(res, 500, { detail: 'internal error' })
    })
  })
  // 整段请求时限:云同步单文件随会员档位可到 500MB,生产反代对 /api/ 关了请求体缓冲(server/DEPLOYMENT.md),
  // 慢速上传的全程都落在这一层;Node 缺省 requestTimeout 300s 会把它掐断(客户端按 ≈250KB/s 保底给到 ~37 分钟)。
  // ponytail: 全局放宽到 1h;慢速拖请求头仍由 headersTimeout(缺省 60s)挡。
  server.requestTimeout = 60 * 60 * 1000

  return new Promise((resolve, reject) => {
    if (deps.routeUpgrade) server.on('upgrade', (req, socket, head) => {
      if (!deps.routeUpgrade!(req, socket, head)) socket.destroy()
    })
    const sockets = new Set<Duplex>()
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.once('error', reject)
    server.listen(opts.port, opts.bindHost ?? '0.0.0.0', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        internalSecret,
        p2pSecret,
        proxyCallerKey,
        close: () => new Promise<void>((r) => { server.close(() => r()); for (const socket of sockets) socket.destroy() }),
      })
    })
  })
}
