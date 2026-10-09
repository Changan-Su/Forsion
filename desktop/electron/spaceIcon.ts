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
import path from 'node:path'
import { readSmallFile } from './pluginIcon'
import { SPACE_ICON_SVG_MAX_BYTES, spaceIconFileOf, spaceIconMaxBytes, spaceIconMime } from '../shared/spaceIcon'

// 文件名 / 体积 / 内容三道规则在 shared/spaceIcon.ts(Android App 的插件宿主共用);这里只管读盘。
export { SPACE_ICON_SVG_MAX_BYTES, spaceIconFileOf }

/** 文件内容 → renderer 可直接消费的 data URL;不合规 → undefined。 */
export function spaceIconDataUrl(name: string, buf: Buffer): string | undefined {
  const mime = spaceIconMime(name, buf)
  return mime && `data:${mime};base64,${buf.toString('base64')}`
}

/** 按 `dirs` 次序找 `iconFile`,第一枚合规的胜出。 */
export async function readSpaceIconDataUrl(json: string, dirs: string[]): Promise<string | undefined> {
  const name = spaceIconFileOf(json)
  if (!name) return undefined
  for (const dir of dirs) {
    try {
      const buf = await readSmallFile(path.join(dir, name), spaceIconMaxBytes(name))
      const url = buf && spaceIconDataUrl(name, buf)
      if (url) return url
    } catch { /* 这一层没有(或是软链)→ 试下一层 */ }
  }
  return undefined
}
