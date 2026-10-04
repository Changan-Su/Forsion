/**
 * 插件身份图标契约：包根 `icon.png`，与 Market 投稿读取同一真源。
 *
 * 设置页会把图标随插件元数据发给 renderer / Unit 设备页，因此这里先做与市场同口径的
 *  PNG 头门禁，再编码成 data URL。缺失或坏图只回落默认字形，绝不拖垮插件发现。
 */
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

export const PLUGIN_ICON_MAX_BYTES = 256 * 1024
export const PLUGIN_ICON_MIN_PX = 64
export const PLUGIN_ICON_MAX_PX = 512

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 合规 PNG → renderer 可直接消费的 data URL；不合规 → undefined。 */
export function pluginIconDataUrl(buf: Buffer): string | undefined {
  if (buf.length < 24 || buf.length > PLUGIN_ICON_MAX_BYTES) return undefined
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width !== height || width < PLUGIN_ICON_MIN_PX || width > PLUGIN_ICON_MAX_PX) return undefined
  return `data:image/png;base64,${buf.toString('base64')}`
}

/** 只读「就在这个目录里的普通小文件」。图标随清单发给渲染层和设备页,所以:
 *  O_NOFOLLOW —— 文件名本身是软链就不读(否则一枚指向别处的软链能把目录外的图带出去);只管路径最后一段,
 *  插件目录自己是软链不受影响;
 *  O_NONBLOCK + isFile —— FIFO / 设备不挂住整份清单;先看体积再读,超限的不进内存。
 *  Windows 没有这两个常量(取 0),靠 isFile 与体积两道。 */
export async function readSmallFile(file: string, max: number): Promise<Buffer | undefined> {
  const fh = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await fh.stat()
    return st.isFile() && st.size <= max ? await fh.readFile() : undefined
  } finally {
    await fh.close()
  }
}

/** 读取包根 icon.png。没有或不合规(含软链 / 非普通文件 / 超限)都安静降级；调用方无需再包 try/catch。 */
export async function readPluginIconDataUrl(pluginDir: string): Promise<string | undefined> {
  try {
    const buf = await readSmallFile(path.join(pluginDir, 'icon.png'), PLUGIN_ICON_MAX_BYTES)
    return buf && pluginIconDataUrl(buf)
  } catch {
    return undefined
  }
}
