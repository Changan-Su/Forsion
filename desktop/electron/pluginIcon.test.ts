import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PLUGIN_ICON_MAX_BYTES,
  pluginIconDataUrl,
  readPluginIconDataUrl,
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

  const roots: string[] = []
  afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })
  /** 新建一个插件目录,`icon.png` 由调用方摆。 */
  const pluginDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'plugin-icon-'))
    roots.push(d)
    return d
  }
  const posix = process.platform !== 'win32' // Windows 建软链要特权、也没有 mkfifo

  it('读包根 icon.png;没有 → undefined', async () => {
    const dir = await pluginDir()
    expect(await readPluginIconDataUrl(dir)).toBeUndefined()
    await writeFile(join(dir, 'icon.png'), png(128, 128))
    expect(await readPluginIconDataUrl(dir)).toBe(pluginIconDataUrl(png(128, 128)))
  })

  it.runIf(posix)('icon.png 是软链 → 不读,哪怕指向一枚合规的图;插件目录自己是软链照常', async () => {
    const outside = await pluginDir()
    await writeFile(join(outside, 'icon.png'), png(128, 128))
    // 文件名本身是软链:目录外的图不能随插件元数据带出去
    const dir = await pluginDir()
    await symlink(join(outside, 'icon.png'), join(dir, 'icon.png'))
    expect(await readPluginIconDataUrl(dir)).toBeUndefined()
    // O_NOFOLLOW 只管路径最后一段:软链进来的插件目录(开发态常见)里的普通 icon.png 照读
    const linked = join(await pluginDir(), 'linked-plugin')
    await symlink(outside, linked)
    expect(await readPluginIconDataUrl(linked)).toBe(pluginIconDataUrl(png(128, 128)))
  })

  it('超限 / 目录 → undefined', async () => {
    // 头合规、只有体积超限(读之前按 stat 卡掉这一点单测分辨不出来,只钉结果)
    const big = await pluginDir()
    await writeFile(join(big, 'icon.png'), png(128, 128, PLUGIN_ICON_MAX_BYTES + 1))
    expect(await readPluginIconDataUrl(big)).toBeUndefined()
    const dir = await pluginDir()
    await mkdir(join(dir, 'icon.png'))
    expect(await readPluginIconDataUrl(dir)).toBeUndefined()
  })

  it.runIf(posix)('FIFO 不挂住插件发现', async () => {
    const dir = await pluginDir()
    execFileSync('mkfifo', [join(dir, 'icon.png')])
    expect(await readPluginIconDataUrl(dir)).toBeUndefined()
  })
})
