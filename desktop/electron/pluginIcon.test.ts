import { describe, expect, it } from 'vitest'
import {
  PLUGIN_ICON_MAX_BYTES,
  pluginIconDataUrl,
} from './pluginIcon'

function png(width: number, height: number, bytes = 24): Buffer {
  const b = Buffer.alloc(bytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

describe('plugin icon.png', () => {
  it('接受市场契约内的方形 PNG 并编码 data URL', () => {
    expect(pluginIconDataUrl(png(64, 64))).toMatch(/^data:image\/png;base64,/)
    expect(pluginIconDataUrl(png(512, 512))).toMatch(/^data:image\/png;base64,/)
  })

  it('拒绝非 PNG、非正方形、越界尺寸与超重文件', () => {
    expect(pluginIconDataUrl(Buffer.alloc(24))).toBeUndefined()
    expect(pluginIconDataUrl(png(128, 64))).toBeUndefined()
    expect(pluginIconDataUrl(png(63, 63))).toBeUndefined()
    expect(pluginIconDataUrl(png(513, 513))).toBeUndefined()
    expect(pluginIconDataUrl(png(128, 128, PLUGIN_ICON_MAX_BYTES + 1))).toBeUndefined()
  })
})
