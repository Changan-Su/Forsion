import { describe, expect, it } from 'vitest'
import {
  CLOUD_VAULT_MARKER,
  cloudVaultMarkerPath,
  cloudVaultNamesFrom,
  coversPath,
  rewritePathList,
  type EntrySyncEntry,
} from './entrySync'

/** 服务端 microserver/amadeus/lib/paths.ts 的 kindForPath 判据(镜像;改那边要改这里)。 */
const serverKind = (p: string): 'page' | 'db' | 'binary' =>
  /\.md$/i.test(p) ? 'page' : /\.db$/i.test(p) ? 'db' : 'binary'

describe('云端 Vault 标记文件', () => {
  it('必须是服务端文本类扩展名 —— binary 路径会被 PUT /file 400 BINARY_PATH 挡掉,标记写不上去', () => {
    expect(serverKind(CLOUD_VAULT_MARKER)).not.toBe('binary')
  })

  it('点开头(三端树/搜索隐身)', () => {
    expect(CLOUD_VAULT_MARKER.startsWith('.')).toBe(true)
  })

  it('从 tree 路径清单推导同步 Vault 名', () => {
    const names = cloudVaultNamesFrom([
      cloudVaultMarkerPath('我的库'),
      cloudVaultMarkerPath('Work'),
      'Work/a.md',
      `deep/nested/${CLOUD_VAULT_MARKER}`, // 非根级:不算
      CLOUD_VAULT_MARKER, // 库根自身:不算
    ])
    expect(names).toEqual(['Work', '我的库'])
  })
})

describe('coversPath', () => {
  const entries: EntrySyncEntry[] = [
    { path: 'Notes/Plan.md', kind: 'page' },
    { path: 'Projects/Alpha', kind: 'folder' },
    { path: 'assets/logo.png', kind: 'asset' },
  ]

  it('精确条目 / 子页面(.fd) / 文件夹子树', () => {
    expect(coversPath(entries, [], 'Notes/Plan.md')).toBe(true)
    expect(coversPath(entries, [], 'Notes/Plan.fd/子页.md')).toBe(true)
    expect(coversPath(entries, [], 'Notes/Plan.fd/deep/x.md')).toBe(true)
    expect(coversPath(entries, [], 'Projects/Alpha/a.md')).toBe(true)
    expect(coversPath(entries, [], 'assets/logo.png')).toBe(true)
  })

  it('范围外不误伤(同名兄弟/祖先目录都不算已同步)', () => {
    expect(coversPath(entries, [], 'Notes/Plan2.md')).toBe(false)
    expect(coversPath(entries, [], 'Projects/Alphabet/a.md')).toBe(false)
    expect(coversPath(entries, [], 'Notes')).toBe(false) // UI 面:仅含同步条目的上级目录 ≠ 已同步
  })

  it('exclude 剔除整棵子树(取消勾选的子页面)', () => {
    const ex = ['Notes/Plan.fd/私密.md']
    expect(coversPath(entries, ex, 'Notes/Plan.fd/私密.md')).toBe(false)
    expect(coversPath(entries, ex, 'Notes/Plan.fd/私密.fd/更深.md')).toBe(false)
    expect(coversPath(entries, ex, 'Notes/Plan.fd/公开.md')).toBe(true)
    expect(coversPath(entries, ex, 'Notes/Plan.md')).toBe(true)
  })

  it('exclude 连 `.fd` 目录本身一起挡(否则云端凭空多出空文件夹)', () => {
    const ex = ['Notes/Plan.fd/私密.md']
    expect(coversPath(entries, ex, 'Notes/Plan.fd/私密.fd')).toBe(false)
    expect(coversPath(entries, ex, 'Notes/Plan.fd/公开.fd')).toBe(true)
  })

  it('显式条目压过继承来的 exclude', () => {
    const ex = ['Projects/Alpha/sub']
    expect(coversPath(entries, ex, 'Projects/Alpha/sub/a.md')).toBe(false)
    const withExplicit = [...entries, { path: 'Projects/Alpha/sub/a.md', kind: 'page' as const }]
    expect(coversPath(withExplicit, ex, 'Projects/Alpha/sub/a.md')).toBe(true)
  })

  it('NFC 归一(mac 磁盘 NFD 文件名)', () => {
    expect(coversPath([{ path: '笔记/计划.md', kind: 'page' }], [], '笔记/计划.md'.normalize('NFD'))).toBe(true)
    expect(coversPath([{ path: '笔记/计划.md'.normalize('NFD'), kind: 'page' }], ['笔记/计划.fd/私.md'.normalize('NFD')], '笔记/计划.fd/私.md')).toBe(false)
  })
})

describe('rewritePathList(exclude 跟随改名)', () => {
  it('精确与前缀都跟走', () => {
    const r = rewritePathList(['A/x.md', 'A/sub/y.md', 'B/z.md'], 'A', 'C')
    expect(r.changed).toBe(true)
    expect(r.next).toEqual(['C/x.md', 'C/sub/y.md', 'B/z.md'])
  })

  it('无关路径不动', () => {
    expect(rewritePathList(['A/x.md'], 'B', 'C').changed).toBe(false)
  })
})
