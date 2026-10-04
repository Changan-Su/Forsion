/**
 * Space 自绘图标契约:space.json 的 `iconFile`(裸文件名,`.png` / `.svg`)。
 *
 * 查找次序:Space 自己的目录 → 所属插件的包根。所以插件 Space 写 `"iconFile": "icon.png"` 且自己目录里
 * 没放图 = 直接用插件图标;放了 = 用自绘的那枚。读不到 / 不合规一律安静降级 —— 渲染层回落 `icon` 词表名,
 * 老宿主压根不认这个键也是同一条退路(所以 `icon` 仍然要写)。
 *
 * PNG 走插件图标同一道门禁(正方形 / 64~512px / ≤256KB);SVG 只当**图片**消费(渲染层 <img> / CSS mask,
 * 绝不注入宿主 DOM),因此不做清洗,只卡体积与文件头。
 * ponytail: SVG 不验能否解码 —— 残缺的 SVG 会画成空白图标,作者自己一眼可见;要兜底就在渲染层先 decode 再决定回落。
 */
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ICON_MAX_BYTES, pluginIconDataUrl } from './pluginIcon'

export const SPACE_ICON_SVG_MAX_BYTES = 64 * 1024

/** 只认裸文件名:字符集里没有路径分隔符,也就没有目录穿越可审。 */
const ICON_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|svg)$/i

/** space.json → 合规的 `iconFile`;没写 / 不合规 / 坏 JSON → undefined。 */
export function spaceIconFileOf(json: string): string | undefined {
  try {
    const f = (JSON.parse(json) as { iconFile?: unknown } | null)?.iconFile
    return typeof f === 'string' && ICON_FILE_RE.test(f) ? f : undefined
  } catch {
    return undefined
  }
}

/** 文件内容 → renderer 可直接消费的 data URL;不合规 → undefined。 */
export function spaceIconDataUrl(name: string, buf: Buffer): string | undefined {
  if (/\.png$/i.test(name)) return pluginIconDataUrl(buf)
  if (buf.length > SPACE_ICON_SVG_MAX_BYTES || !/<svg[\s>]/i.test(buf.toString('utf8', 0, 2048))) return undefined
  return `data:image/svg+xml;base64,${buf.toString('base64')}`
}

/** 只读「就在这个目录里的普通小文件」。图标随清单发给渲染层和设备页,所以:
 *  O_NOFOLLOW —— 文件名本身是软链就不读(否则一枚指向别处的软链能把目录外的图带出去);
 *  O_NONBLOCK + isFile —— FIFO / 设备不挂住整份清单;先看体积再读,超限的不进内存。
 *  Windows 没有这两个常量(取 0),靠 isFile 与体积两道。 */
async function readSmallFile(file: string, max: number): Promise<Buffer | undefined> {
  const fh = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await fh.stat()
    return st.isFile() && st.size <= max ? await fh.readFile() : undefined
  } finally {
    await fh.close()
  }
}

/** 按 `dirs` 次序找 `iconFile`,第一枚合规的胜出。 */
export async function readSpaceIconDataUrl(json: string, dirs: string[]): Promise<string | undefined> {
  const name = spaceIconFileOf(json)
  if (!name) return undefined
  const max = /\.png$/i.test(name) ? PLUGIN_ICON_MAX_BYTES : SPACE_ICON_SVG_MAX_BYTES
  for (const dir of dirs) {
    try {
      const buf = await readSmallFile(path.join(dir, name), max)
      const url = buf && spaceIconDataUrl(name, buf)
      if (url) return url
    } catch { /* 这一层没有(或是软链)→ 试下一层 */ }
  }
  return undefined
}
