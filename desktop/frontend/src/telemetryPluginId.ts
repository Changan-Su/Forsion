/**
 * 遥测里插件 id 的规则(契约 §9):装自商店的(不管目录是 market-<UUID> 还是作者自起名的老条目)一律发**商店条目 id**,
 * 内置 / 预装的发插件 id,开发副本 / 沙箱 / 本地路径一律 `local`。主进程(telemetryHost.publicPluginId)再按形状核一遍。
 *
 * 「这个目录是哪个商店条目」只问本机:主进程商店更新器的状态(market:updateStatus 的 items,{ id, type, slug })。
 * 不为遥测去拉商店目录。作者自起名、又从没进过更新器状态的老安装照旧记 local,等更新器把它认领进状态(#491 的 catalog 认领)。
 * 零运行期依赖(除了 shared/products 的正则),pluginStore 等可以直接 import。
 */
import { MARKET_ITEM_ID } from '../../shared/products'
import { telemetryOn } from './telemetrySend'

/** `<type>:<目录名>` → 商店条目 id。null = 还没订阅。 */
let marketIds: Map<string, string> | null = null
function ensureMarketIds(): Map<string, string> {
  if (marketIds) return marketIds
  marketIds = new Map()
  try {
    window.tangu?.onMarketUpdateStatus?.((state) => {
      const next = new Map<string, string>()
      for (const x of state?.items ?? []) {
        if (x && typeof x.id === 'string' && typeof x.slug === 'string' && typeof x.type === 'string') next.set(`${x.type}:${x.slug}`, x.id)
      }
      marketIds = next
    })
  } catch { /* 拿不到就只认 market-<UUID> 与内置 */ }
  return marketIds
}

/** 测试用:直接给一张表(不走 IPC)。 */
export function setMarketIdsForTest(entries: Array<{ id: string; type: string; slug: string }> | null): void {
  marketIds = entries ? new Map(entries.map((x) => [`${x.type}:${x.slug}`, x.id])) : null
}

export interface TelemetryPluginLike { id: string; dir?: string; builtin?: boolean; preinstalled?: boolean; dev?: boolean; bundle?: { dir?: string } }
export interface TelemetryPluginRef { pluginId: string; pluginOfficial: boolean }
const LOCAL: TelemetryPluginRef = { pluginId: 'local', pluginOfficial: false }

/** 一个插件 → 遥测里的 { pluginId, pluginOfficial }。type = 它装在哪个插件目录(Forsion 插件 / 引擎插件)。 */
export function telemetryPluginRef(p: TelemetryPluginLike | undefined, type: 'amadeus-plugin' | 'plugin' = 'amadeus-plugin'): TelemetryPluginRef {
  if (!p || p.dev) return LOCAL
  const dir = p.dir || p.bundle?.dir || p.id // 安装目录名(老商店条目按 install_slug 落目录,可以和插件 id 不同)
  const mapped = (telemetryOn() || marketIds ? ensureMarketIds() : null)?.get(`${type}:${dir}`)
  if (mapped) return { pluginId: mapped, pluginOfficial: true }
  const marketDir = [dir, p.id].find((x) => MARKET_ITEM_ID.test(x))
  if (marketDir) return { pluginId: marketDir.slice('market-'.length), pluginOfficial: true } // market-<UUID> 的 UUID 就是商店条目 id
  if (p.builtin || p.preinstalled) return { pluginId: p.id, pluginOfficial: true }
  return LOCAL
}

/** 命令 id 的白名单上限(telemetry-schema.json command_use.id max)。 */
export const COMMAND_ID_MAX = 80
/** 插件自起的命令名能不能原样带:字符集合规、不撞密钥样式(≥40 位连续 [A-Za-z0-9_-] 会被 Extend / server 的 base64url 规则整条丢掉)。 */
const CMD_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const cleanCmdPart = (v: string): boolean => CMD_PART.test(v) && !/[A-Za-z0-9_-]{40,}/.test(v) && !/[0-9a-f]{32,}/i.test(v)

/**
 * 命令 id → 能发的样子(契约 §9;11-07 与 server / Extend 对齐):
 *  - 插件命令 `amadeus:<插件 id>:<命令>`:插件 id 换成公开 id —— 商店插件是**裸 UUID**(不带 market- 前缀:嵌在长串里的
 *    market-<UUID> 有 43 位连续 [A-Za-z0-9_-],会被密钥规则整条丢掉),内置插件是插件 id;
 *    命令名不合规或拼起来超过 80 字符 → 命令名记成 `other`(`amadeus:<id>:other`);
 *  - 侧载 / 开发 / 认不出的插件:整条 `plugin:local`;
 *  - `amadeus:` 开头的一律当插件命令(amadeusPlugins.ts 桥接的就是 `amadeus:<插件 id>:<命令>`;命令名空着 / 缺段也照此判,
 *    绝不原样放过去 —— 原样就把侧载插件的名字带出去了);
 *  - `view-mode:<值>`(viewModes.tsx 的「切到某个视图模式」)的值由视图 / 插件自己起名 → 收成 `view-mode:pick`;
 *  - 其余(宿主内置命令)原样(静态 id)。
 */
export function telemetryCommandId(id: string, pluginOf: (pluginId: string) => TelemetryPluginLike | undefined): string {
  if (id.startsWith('view-mode:')) return 'view-mode:pick'
  if (!id.startsWith('amadeus:')) return id
  const rest = id.slice('amadeus:'.length)
  const cut = rest.indexOf(':')
  const pluginId = cut < 0 ? rest : rest.slice(0, cut)
  const cmd = cut < 0 ? '' : rest.slice(cut + 1)
  const ref = telemetryPluginRef(pluginId ? pluginOf(pluginId) : undefined)
  if (!ref.pluginOfficial) return 'plugin:local'
  const full = `amadeus:${ref.pluginId}:${cmd}`
  return full.length <= COMMAND_ID_MAX && cleanCmdPart(cmd) ? full : `amadeus:${ref.pluginId}:other`
}
