/**
 * 云端资源 URL:把渲染层的 toAssetUrl(BlockHost 的 `![[pic.png]]` 图片/PDF/音视频嵌入)接到
 * GET /vaults/:v/asset。<img>/<video> 标签带不了 Authorization 头 → 用短时 asset token(?at=)。
 * ref 可能是裸 basename 或页面相对路径;带上 &page=(当前笔记路径)让服务端做与桌面
 * resolveAttachment 同款的「页面目录拼接 + basename 兜底搜索」。
 * Range/MIME 全在服务端(镜像桌面 assetProtocol 的行为)。
 */
import { setAssetUrlBuilder } from '@amadeus-shared/assets'
import { normalizePosix } from './cloudPaths'

export interface CloudAssetState {
  apiBase: string
  vaultId(): string
  assetToken(): string
  /** 当前打开的笔记(vault 相对路径;未知 = null)—— 服务端解析页面相对 ref 的基准。 */
  activePage(): string | null
}

let state: CloudAssetState | null = null

/** 构建单个资源 URL;page 缺省取当前笔记(openAttachment 等有明确 pagePath 时显式传)。
 *  lit = 折叠之前的原样写法(只有接缝的构建器传,见 seamAssetUrl);服务端不认识这个参数。 */
export function buildAssetUrl(ref: string, page?: string | null, lit?: string): string {
  if (!state) return ref
  const params = new URLSearchParams()
  params.set('ref', ref)
  const p = page === undefined ? state.activePage() : page
  if (p) params.set('page', p)
  if (lit) params.set('lit', lit)
  const at = state.assetToken()
  if (at) params.set('at', at)
  return `${state.apiBase}/amadeus/vaults/${encodeURIComponent(state.vaultId())}/asset?${params.toString()}`
}

/** buildAssetUrl 的逆:`…/amadeus/vaults/<当前库>/asset?…ref=<库内路径>…` → 库内路径;别的一律 null。
 *  结果会被写回笔记正文(存盘时把显示地址换回页相对路径),所以只认**当前这个库**的资源端点:
 *    · 路径必须以 `/amadeus/vaults/<当前库 id>/asset` 结尾(库 id 现取,不在装的时候捕获);
 *    · 源不比 —— 网页版与手机连的是同一个库,接口的源却可能不同(一个是页面同源的 /api,一个是网关),
 *      被另一端改写过的存量笔记也要认得回来。库 id 是服务端随机生成的 UUID,路径里带着它就只可能是这个库的资源;
 *    · 带片段(`#…`)的不认 —— 构建时从不带;不挡的话 `https://别处/logo.png#/amadeus/vaults/<id>/asset?ref=x`
 *      这种外链会被片段里的字样骗过去(评审 2026-10-09);
 *    · page / at 两个参数不看(令牌过没过期都认:要的只是 ref)。ref 一律按**库内路径**认:编辑器里会被序列化的
 *      图片地址都是 toAssetUrl(库内路径) 构建出来的,page 只是给服务端「先按页目录找」用的提示(它取的是当时的
 *      活动页,分栏 / 后台页签下未必是这张图所在的笔记,拿它来校验会把好地址拒掉)。手写的「页相对 ref + 别的 page」
 *      地址因此会被认成库内路径 —— 没有任何产品路径会生成这种地址。
 *    · 带着 lit(折叠之前的原样写法,见 seamAssetUrl)时取它,盘上本来的 `../x.png`、`./x.png` 才能逐字换回去;
 *      只在它折叠后确实等于 ref 时才认 —— 对不上的 lit 不是我们构建的,不许拿来写进正文。 */
export function parseAssetUrl(url: string): string | null {
  if (!state || url.includes('#')) return null
  const q = url.indexOf('?')
  if (q < 0 || !/^(https?:\/\/|\/)/.test(url)) return null
  if (!url.slice(0, q).endsWith(`/amadeus/vaults/${encodeURIComponent(state.vaultId())}/asset`)) return null
  const params = new URLSearchParams(url.slice(q + 1))
  const ref = params.get('ref') || null
  const lit = params.get('lit')
  return ref && lit && normalizePosix(lit) === ref ? lit : ref
}

/** 接缝的构建器(渲染层的 toAssetUrl 走这里)。和直接调 buildAssetUrl 有两处不同(2026-10-10,页目录之外的引用):
 *    · 服务端见到 `.` / `..` 段一律**拒收**(server 的 lib/paths.ts normalizePath,不是折叠)—— 盘上的 `![](../assets/x.png)`
 *      (附件放固定文件夹时产品自己写的)此前在云端库一直显示不出。这里先折叠再送;折叠之前的原样写法带在 lit 里,
 *      供存盘时逐字换回。折叠后逃出库根的原样送(服务端拒收,显示不出;存盘往返照样逐字)。
 *    · exact(笔记正文里的 `![](…)`:ref 已经是完整的库内路径)不带 page。带着的话服务端先按「页目录 + ref」再拼一遍,
 *      那里恰好有同路径的文件就显示成它(子夹/attachments/x.png 顶替库根的 attachments/x.png)。
 *      `![[裸文件名]]` 这类嵌入照旧带 page:同文件夹的那张优先。
 *  仪器:desktop 的 frontend/src/services/cloudAssetsRoundtrip.test.ts「页目录之外的引用」(服务端的找法在那里有一份镜像)。 */
function seamAssetUrl(ref: string, exact?: boolean): string {
  const folded = normalizePosix(ref)
  return buildAssetUrl(folded || ref, exact ? null : undefined, folded && folded !== ref ? ref : undefined)
}

/** 装进共享 assets.ts 的接缝(成对:构建 + 解析):此后渲染层所有 toAssetUrl 都产出云端 HTTP URL,
 *  存盘时 fromAssetUrl 再把它换回库内路径。 */
export function installCloudAssetUrls(s: CloudAssetState): void {
  state = s
  setAssetUrlBuilder(seamAssetUrl, parseAssetUrl)
}
