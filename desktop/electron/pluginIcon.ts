/**
 * 插件身份图标契约：包根 `icon.png`，与 Market 投稿读取同一真源。
 *
 * 设置页会把图标随插件元数据发给 renderer / Unit 设备页，因此这里先做与市场同口径的
 *  PNG 头门禁，再编码成 data URL。缺失或坏图只回落默认字形，绝不拖垮插件发现。
 *  门禁本体在 shared/pluginIcon.ts(Android App 的插件宿主共用)。
 */
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MIN_PX, PLUGIN_ICON_MAX_PX, isValidPluginIconPng } from '../shared/pluginIcon'

export { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MIN_PX, PLUGIN_ICON_MAX_PX }

/** 合规 PNG → renderer 可直接消费的 data URL；不合规 → undefined。 */
export function pluginIconDataUrl(buf: Buffer): string | undefined {
  return isValidPluginIconPng(buf) ? `data:image/png;base64,${buf.toString('base64')}` : undefined
}

/** 只读「就在这个目录里的普通小文件」。图标随清单发给渲染层和设备页,所以:
 *  O_NOFOLLOW —— 文件名本身是软链就不读(否则一枚指向别处的软链能把目录外的图带出去);只管路径最后一段,
 *  插件目录自己是软链不受影响;
 *  O_NONBLOCK + isFile —— FIFO / 设备不挂住整份清单;先看体积再读,超限的不进内存;
 *  按 stat 到的体积有界读 —— fh.readFile() 会自己再 stat 一次、按新体积分配,stat 之后被写大的文件就绕过了上限。
 *  读着读着变大的一律不要(多读到的那 1 字节就是证据)。
 *  Windows 没有这两个常量(取 0),靠 isFile 与体积两道。 */
export async function readSmallFile(file: string, max: number): Promise<Buffer | undefined> {
  const fh = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > max) return undefined
    const buf = Buffer.alloc(st.size + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null)
      if (!bytesRead) break
      n += bytesRead
    }
    return n <= st.size ? buf.subarray(0, n) : undefined
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
