/**
 * 云端资源 URL:把渲染层的 toAssetUrl(BlockHost 的 `![[pic.png]]` 图片/PDF/音视频嵌入)接到
 * GET /vaults/:v/asset。<img>/<video> 标签带不了 Authorization 头 → 用短时 asset token(?at=)。
 * ref 可能是裸 basename 或页面相对路径;带上 &page=(当前笔记路径)让服务端做与桌面
 * resolveAttachment 同款的「页面目录拼接 + basename 兜底搜索」。
 * Range/MIME 全在服务端(镜像桌面 assetProtocol 的行为)。
 */
import { setAssetUrlBuilder } from '@amadeus-shared/assets'

export interface CloudAssetState {
  apiBase: string
  vaultId(): string
  assetToken(): string
  /** 当前打开的笔记(vault 相对路径;未知 = null)—— 服务端解析页面相对 ref 的基准。 */
  activePage(): string | null
}

let state: CloudAssetState | null = null

/** 构建单个资源 URL;page 缺省取当前笔记(openAttachment 等有明确 pagePath 时显式传)。 */
export function buildAssetUrl(ref: string, page?: string | null): string {
  if (!state) return ref
  const params = new URLSearchParams()
  params.set('ref', ref)
  const p = page === undefined ? state.activePage() : page
  if (p) params.set('page', p)
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
 *      地址因此会被认成库内路径 —— 没有任何产品路径会生成这种地址。 */
export function parseAssetUrl(url: string): string | null {
  if (!state || url.includes('#')) return null
  const q = url.indexOf('?')
  if (q < 0 || !/^(https?:\/\/|\/)/.test(url)) return null
  if (!url.slice(0, q).endsWith(`/amadeus/vaults/${encodeURIComponent(state.vaultId())}/asset`)) return null
  return new URLSearchParams(url.slice(q + 1)).get('ref') || null
}

/** 装进共享 assets.ts 的接缝(成对:构建 + 解析):此后渲染层所有 toAssetUrl 都产出云端 HTTP URL,
 *  存盘时 fromAssetUrl 再把它换回库内路径。 */
export function installCloudAssetUrls(s: CloudAssetState): void {
  state = s
  setAssetUrlBuilder((ref) => buildAssetUrl(ref), parseAssetUrl)
}
