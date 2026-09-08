// 共享/发布的对象是云端文件:本地侧路径必须翻成 `<云名>/<path>`,没同步的页没有云端对象。
// 2026-09-06 用户实报「本地文件能点发布,链接没权限」:拿本地路径建 share,服务端不校验存在性 → 404。
import { afterEach, describe, expect, it } from 'vitest'
import { cloudPathFor } from './entrySyncStore'
import type { AmadeusEntrySyncVault } from '../types'

const ROOT = '/Users/me/Documents/WMOSv11'
const vaults: AmadeusEntrySyncVault[] = [{
  vaultRoot: ROOT,
  cloudName: 'WMOSv11',
  entries: [{ path: 'Forsion-Dev 1.md', kind: 'page' }, { path: 'Projects', kind: 'folder' }],
  exclude: ['Projects/private.md'],
}]
// vitest 全局 environment=node:cloudPathFor 只读 window.amadeusSync 一个键,垫一个最小 window 即可。
const g = globalThis as unknown as { window?: { amadeusSync?: unknown } }
g.window ??= {}
const w = g.window

afterEach(() => { delete w.amadeusSync })

describe('cloudPathFor', () => {
  it('桌面本地侧:同步范围内的页 → 加云名前缀;子页面按 .fd 覆盖判定同源', () => {
    w.amadeusSync = {}
    expect(cloudPathFor(vaults, ROOT, 'local', 'Forsion-Dev 1.md')).toBe('WMOSv11/Forsion-Dev 1.md')
    expect(cloudPathFor(vaults, ROOT, 'local', 'Forsion-Dev 1.fd/子页.md')).toBe('WMOSv11/Forsion-Dev 1.fd/子页.md')
    expect(cloudPathFor(vaults, ROOT, 'local', 'Projects/a.md')).toBe('WMOSv11/Projects/a.md')
  })

  it('桌面本地侧:没开同步 / 被排除 / 别的 vault → null(不许拿本地路径去建 share)', () => {
    w.amadeusSync = {}
    expect(cloudPathFor(vaults, ROOT, 'local', 'Test.md')).toBeNull()
    expect(cloudPathFor(vaults, ROOT, 'local', 'Projects/private.md')).toBeNull()
    expect(cloudPathFor(vaults, '/elsewhere', 'local', 'Forsion-Dev 1.md')).toBeNull()
    expect(cloudPathFor(vaults, null, 'local', 'Forsion-Dev 1.md')).toBeNull()
  })

  it('桌面云侧 / web(无 amadeusSync):路径本来就是云端路径,原样返回', () => {
    w.amadeusSync = {}
    expect(cloudPathFor(vaults, ROOT, 'cloud', 'WMOSv11/Forsion-Dev 1.md')).toBe('WMOSv11/Forsion-Dev 1.md')
    delete w.amadeusSync
    expect(cloudPathFor([], null, 'local', 'anything.md')).toBe('anything.md')
  })
})
