/**
 * 插件身份图标契约(包根 `icon.png`)的纯校验:与市场投稿同口径的 PNG 头门禁。
 * 桌面主进程(electron/pluginIcon.ts,Buffer)与 Android App 的插件宿主(mobile/src/plugins,Uint8Array)共用。
 * 缺失或坏图只回落默认字形,绝不拖垮插件发现。
 */
export const PLUGIN_ICON_MAX_BYTES = 256 * 1024
export const PLUGIN_ICON_MIN_PX = 64
export const PLUGIN_ICON_MAX_PX = 512

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const u32be = (b: Uint8Array, off: number): number => ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3]

/** 合规 = PNG 签名 + 正方形 + 64~512px + ≤256KB。 */
export function isValidPluginIconPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24 || bytes.length > PLUGIN_ICON_MAX_BYTES) return false
  if (PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) return false
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width === height && width >= PLUGIN_ICON_MIN_PX && width <= PLUGIN_ICON_MAX_PX
}
