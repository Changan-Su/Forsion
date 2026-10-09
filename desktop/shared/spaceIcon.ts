/**
 * Space 自绘图标契约(space.json 的 `iconFile`)的纯规则:文件名、体积上限、内容门禁。
 * 桌面主进程(electron/spaceIcon.ts,Buffer + 读盘)与 Android App 的插件宿主(mobile/src/plugins/pluginHost.ts,
 * Uint8Array)共用。PNG 走插件图标同一道门禁(shared/pluginIcon.ts);SVG 只当**图片**消费(渲染层 <img> / CSS mask,
 * 绝不注入宿主 DOM),因此不做清洗,只卡体积与文件头。
 */
import { PLUGIN_ICON_MAX_BYTES, isValidPluginIconPng } from './pluginIcon'

export const SPACE_ICON_SVG_MAX_BYTES = 64 * 1024

/** 只认裸文件名:字符集里没有路径分隔符,也就没有目录穿越可审。 */
const ICON_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|svg)$/i

const isPng = (name: string): boolean => /\.png$/i.test(name)

/** space.json → 合规的 `iconFile`;没写 / 不合规 / 坏 JSON → undefined。 */
export function spaceIconFileOf(json: string): string | undefined {
  try {
    const f = (JSON.parse(json) as { iconFile?: unknown } | null)?.iconFile
    return typeof f === 'string' && ICON_FILE_RE.test(f) ? f : undefined
  } catch {
    return undefined
  }
}

/** 这枚图标文件最多读多少字节(先看体积,超限的不读进内存)。 */
export const spaceIconMaxBytes = (name: string): number => (isPng(name) ? PLUGIN_ICON_MAX_BYTES : SPACE_ICON_SVG_MAX_BYTES)

/** 文件内容合规 → data URL 用的 MIME;不合规 → undefined。 */
export function spaceIconMime(name: string, bytes: Uint8Array): 'image/png' | 'image/svg+xml' | undefined {
  if (isPng(name)) return isValidPluginIconPng(bytes) ? 'image/png' : undefined
  if (bytes.length > SPACE_ICON_SVG_MAX_BYTES) return undefined
  return /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 2048))) ? 'image/svg+xml' : undefined
}
