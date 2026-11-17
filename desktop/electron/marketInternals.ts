/**
 * 官方商店装 / 自动更新插件时的兜底闸(2026-11-16+,插件内部接口开放方案第 3 件 c):
 * 包里的 manifest 声明了 `internals-raw`(直接操作 Forsion 内部对象),就要求商店条目记着「这一版过了第二级审核」
 * (服务端 `rawApprovedVersion` 等于包里的 version),否则不装。
 *
 * 服务端审核时会读包里的 manifest,但 npm 包从不拆开看,github 源也可能没锁版本 —— 这一道在客户端按「实际下下来的那个包」
 * 再核一次,哪条路漏了都在这里拦住。只管官方商店:第三方来源、手动安装、开发副本照旧(那些不经过商店审核)。
 */
export const RAW_UNAPPROVED = 'install: internals-raw-unapproved'

export function declaresInternalsRaw(manifest: Record<string, unknown> | null): boolean {
  const caps = manifest?.capabilities
  return Array.isArray(caps) && caps.includes('internals-raw')
}

/** 声明了 internals-raw 时,`approvedVersion` 必须和包里的 version 一字不差;否则抛 `RAW_UNAPPROVED`。
 *  条目详情拿不到(网络 / 旧服务端)按没过审处理:读失败 ≠ 放行。 */
export async function assertInternalsRawApproved(
  manifest: Record<string, unknown> | null,
  approvedVersion: () => Promise<string | null | undefined>,
): Promise<void> {
  if (!declaresInternalsRaw(manifest)) return
  const version = typeof manifest?.version === 'string' ? manifest.version.trim() : ''
  let approved: string | null | undefined
  try { approved = await approvedVersion() } catch { approved = null }
  if (!version || typeof approved !== 'string' || approved.trim() !== version) throw new Error(RAW_UNAPPROVED)
}
