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

/** 装进共享 assets.ts 的接缝:此后渲染层所有 toAssetUrl 都产出云端 HTTP URL。 */
export function installCloudAssetUrls(s: CloudAssetState): void {
  state = s
  setAssetUrlBuilder((ref) => buildAssetUrl(ref))
}
