/**
 * 远程锁定时 unitWeb 放行什么(设备能力 MCP 方案 P1 · K2 §3.9,方案 §6.5):纯函数,unitWeb 三处接入(顶层 / /engine / /vault/rpc)。
 *
 * 锁定 = 这台电脑急停过、还没在本机经系统认证解锁。非本机入口(隧道 / P2P / 局域网配对)此时**只剩读 + 中止**:
 *   - 顶层(非 /engine、非 /vault/rpc):GET / HEAD / OPTIONS 放行;POST /vault/asset-token 放行(只为读附件);其余一律 423 ——
 *     含 /unit/pair/request(新设备配对)、/unit/p2p/offer(开直连信道)、PUT /unit/config、POST /unit/remote-access/request
 *     (锁定时不弹首次确认,R-26)、以及将来的 /unit/mcp*(按前缀预先拦)。
 *   - /engine:GET / HEAD / OPTIONS 放行(手机看得见「已中止」、事件流不断);POST /agent/runs/:id/abort 放行(只会停);其余 423。
 *   - /vault/rpc 读写都是 POST,**不能按 method 判**:只放 VAULT_RPC_READ 里的只读通道。
 * 所有匹配都是白名单:大小写 / 尾斜杠之类的变体落在名单外 = 拒(fail closed)。隧道本身不断开、P2P 不关。
 */
import { IPC } from '../shared/amadeus/ipc'
import { REMOTE_LOCKED } from '../shared/remoteSafety'

export const REMOTE_LOCKED_BODY = { code: REMOTE_LOCKED, detail: 'Remote access to this computer is locked. Unlock it on the computer itself.' } as const

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ABORT_PATH = /^\/agent\/runs\/[^/]+\/abort$/i

/** 非 /engine、非 /vault/rpc 的请求在锁定时是否放行。 */
export function lockedRequestAllowed(method: string, path: string): boolean {
  const m = String(method || 'GET').toUpperCase()
  if (READ_METHODS.has(m)) return true
  return m === 'POST' && path === '/vault/asset-token'
}

/** 规整后的引擎路径(engineTarget().path)在锁定时是否放行。 */
export function lockedEngineAllowed(method: string, normPath: string): boolean {
  const m = String(method || 'GET').toUpperCase()
  if (READ_METHODS.has(m)) return true
  return m === 'POST' && ABORT_PATH.test(normPath)
}

/**
 * 锁定时 /vault/rpc 仍可远程调用的通道:必须 ⊆ VAULT_RPC_ALLOW(测试断言),且逐个核过实现无写副作用(electron/amadeus/fs/vaultHandlers.ts)。
 * 刻意**不收**(与 K2 规格 §3.9 所列相比的更正):
 *   - loadPage:vaultHandlers.ts:79-83 每次都 rememberPage(改本机「上次打开的笔记」),且与 readPage 同走 compiler loadPage
 *     (v1/v2 迁移、旧 id 重编号会 savePage 落盘)—— 远端「打开」笔记改的是本机状态;锁定期间远端改用 readPage 读内容;
 *   - fetchLinkMeta / searchImages:linkMeta.ts 由**本机**向外网发请求(读链接元数据 / openverse 搜图)—— 不是读库,锁定期间不替远端出网;
 *   - restoreVault:切换本机当前库。
 * readPage 留着:只读语义(不 rememberPage、缺文件不建),唯一的写是同一份内容的格式自愈(旧版迁移 / 重编号),本机打开同一篇也会做。
 */
export const VAULT_RPC_READ: ReadonlySet<string> = new Set([
  IPC.listPages, IPC.listFiles, IPC.readPage, IPC.readVaultBytes, IPC.search, IPC.backlinks, IPC.exclusiveAssets,
  IPC.listTags, IPC.pagesByTag, IPC.resolveEmbed, IPC.blockBacklinks, IPC.listFolders, IPC.listTrash, IPC.pageIcons,
  IPC.dbRead, IPC.drawingRead, IPC.readTextFile, IPC.listPageProps, IPC.pluginDataRead,
])
