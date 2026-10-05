/**
 * 插件身份图标契约：包根 `icon.png`，与 Market 投稿读取同一真源。
 *
 * 设置页会把图标随插件元数据发给 renderer / Unit 设备页，因此这里先做与市场同口径的
 *  PNG 头门禁，再编码成 data URL。缺失或坏图只回落默认字形，绝不拖垮插件发现。
 *  门禁本体在 shared/pluginIcon.ts(Android App 的插件宿主共用)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MIN_PX, PLUGIN_ICON_MAX_PX, isValidPluginIconPng } from '../shared/pluginIcon'

export { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MIN_PX, PLUGIN_ICON_MAX_PX }

/** 合规 PNG → renderer 可直接消费的 data URL；不合规 → undefined。 */
export function pluginIconDataUrl(buf: Buffer): string | undefined {
  return isValidPluginIconPng(buf) ? `data:image/png;base64,${buf.toString('base64')}` : undefined
}

/** 读取包根 icon.png。没有或不合规都安静降级；调用方无需再包 try/catch。 */
export async function readPluginIconDataUrl(pluginDir: string): Promise<string | undefined> {
  try {
    return pluginIconDataUrl(await fs.readFile(path.join(pluginDir, 'icon.png')))
  } catch {
    return undefined
  }
}
