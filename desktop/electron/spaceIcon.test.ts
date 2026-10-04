import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SPACE_ICON_SVG_MAX_BYTES, readSpaceIconDataUrl, spaceIconDataUrl, spaceIconFileOf } from './spaceIcon'

function png(side: number): Buffer {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(side, 16)
  b.writeUInt32BE(side, 20)
  return b
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>')
const spec = (iconFile: unknown): string => JSON.stringify({ id: 'x', icon: 'video', iconFile })

describe('space.json iconFile', () => {
  it('只认裸文件名 + png/svg 后缀', () => {
    expect(spaceIconFileOf(spec('icon.png'))).toBe('icon.png')
    expect(spaceIconFileOf(spec('space-icon.SVG'))).toBe('space-icon.SVG')
    for (const bad of ['../icon.png', 'a/icon.png', 'a\\icon.png', '/etc/icon.png', '.icon.png', 'icon.jpg', 'icon', '', 7, null]) {
      expect(spaceIconFileOf(spec(bad)), String(bad)).toBeUndefined()
    }
    expect(spaceIconFileOf('{ 坏 JSON')).toBeUndefined()
    expect(spaceIconFileOf('null')).toBeUndefined()
  })

  it('PNG 走插件图标门禁,SVG 卡体积与文件头', () => {
    expect(spaceIconDataUrl('icon.png', png(128))).toMatch(/^data:image\/png;base64,/)
    expect(spaceIconDataUrl('icon.png', png(32))).toBeUndefined()
    expect(spaceIconDataUrl('icon.png', SVG)).toBeUndefined()
    expect(spaceIconDataUrl('icon.svg', SVG)).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(spaceIconDataUrl('icon.svg', Buffer.from('<html></html>'))).toBeUndefined()
    expect(spaceIconDataUrl('icon.svg', Buffer.concat([SVG, Buffer.alloc(SPACE_ICON_SVG_MAX_BYTES)]))).toBeUndefined()
  })

  const roots: string[] = []
  afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

  it('Space 目录优先,其次插件包根;都没有 → undefined', async () => {
    const plugin = await mkdtemp(join(tmpdir(), 'space-icon-'))
    roots.push(plugin)
    const space = join(plugin, 'spaces', 'demo')
    await mkdir(space, { recursive: true })
    await writeFile(join(plugin, 'icon.png'), png(256))

    // 自己目录里没放 → 落到插件图标
    expect(await readSpaceIconDataUrl(spec('icon.png'), [space, plugin])).toBe(spaceIconDataUrl('icon.png', png(256)))
    // 自己目录里放了 → 自绘的胜出
    await writeFile(join(space, 'icon.png'), png(64))
    expect(await readSpaceIconDataUrl(spec('icon.png'), [space, plugin])).toBe(spaceIconDataUrl('icon.png', png(64)))
    // 自己那枚不合规 → 仍退到插件图标,不是直接放弃
    await writeFile(join(space, 'icon.png'), png(32))
    expect(await readSpaceIconDataUrl(spec('icon.png'), [space, plugin])).toBe(spaceIconDataUrl('icon.png', png(256)))

    // 软链不跟:哪怕指向一枚合规的图(否则目录外的图能随清单带出去)。Windows 建软链要特权,跳过。
    if (process.platform !== 'win32') {
      const outside = await mkdtemp(join(tmpdir(), 'space-icon-out-'))
      roots.push(outside)
      await writeFile(join(outside, 'secret.png'), png(128))
      await symlink(join(outside, 'secret.png'), join(space, 'link.png'))
      expect(await readSpaceIconDataUrl(spec('link.png'), [space])).toBeUndefined()
    }
    // 超限 → 不出图(读之前按 stat 体积卡掉这一点单测分辨不出来,只钉结果)
    await writeFile(join(space, 'big.svg'), Buffer.concat([SVG, Buffer.alloc(SPACE_ICON_SVG_MAX_BYTES)]))
    expect(await readSpaceIconDataUrl(spec('big.svg'), [space])).toBeUndefined()
    // 目录不是文件
    await mkdir(join(space, 'dir.png'))
    expect(await readSpaceIconDataUrl(spec('dir.png'), [space])).toBeUndefined()

    expect(await readSpaceIconDataUrl(spec('missing.svg'), [space, plugin])).toBeUndefined()
    expect(await readSpaceIconDataUrl(spec('../icon.png'), [space, plugin])).toBeUndefined()
    expect(await readSpaceIconDataUrl(JSON.stringify({ id: 'x' }), [space, plugin])).toBeUndefined()
  })
})
