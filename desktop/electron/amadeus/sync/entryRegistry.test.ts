import { describe, expect, it } from 'vitest'
import { conflictCopyPath } from './reconcile'
import {
  applyRemoteOpToEntries,
  buildScope,
  rewriteEntriesForMove,
  scopeMatches,
  stripConflictSuffix,
  validateCloudName,
  type EntrySyncEntry,
} from './entryRegistry'

const entries: EntrySyncEntry[] = [
  { path: 'Notes/Plan.md', kind: 'page' },
  { path: 'Projects/Alpha', kind: 'folder' },
  { path: 'assets/logo.png', kind: 'asset' },
]

describe('buildScope + scopeMatches', () => {
  const scope = buildScope(entries)

  it('page:.md 本身与 .fd 子树命中,同名兄弟不误伤', () => {
    expect(scopeMatches(scope, 'Notes/Plan.md')).toBe(true)
    expect(scopeMatches(scope, 'Notes/Plan.fd/sub.md')).toBe(true)
    expect(scopeMatches(scope, 'Notes/Plan.fd/deep/x.md')).toBe(true)
    expect(scopeMatches(scope, 'Notes/Plan2.md')).toBe(false)
    expect(scopeMatches(scope, 'Notes/Plan.md.bak')).toBe(false)
  })

  it('folder:子树全部命中', () => {
    expect(scopeMatches(scope, 'Projects/Alpha')).toBe(true)
    expect(scopeMatches(scope, 'Projects/Alpha/a.md')).toBe(true)
    expect(scopeMatches(scope, 'Projects/Alpha/x/y/z.png')).toBe(true)
    expect(scopeMatches(scope, 'Projects/Alphabet/a.md')).toBe(false)
    expect(scopeMatches(scope, 'Projects/Beta/a.md')).toBe(false)
  })

  it('asset:精确命中', () => {
    expect(scopeMatches(scope, 'assets/logo.png')).toBe(true)
    expect(scopeMatches(scope, 'assets/logo2.png')).toBe(false)
  })

  it('祖先目录命中(folder move/mkdir 事件过闸)', () => {
    expect(scopeMatches(scope, 'Notes')).toBe(true)
    expect(scopeMatches(scope, 'Projects')).toBe(true)
    expect(scopeMatches(scope, 'assets')).toBe(true)
    expect(scopeMatches(scope, 'Other')).toBe(false)
  })

  it('冲突副本按原名归一命中(引擎物化的副本必须能推上云)', () => {
    const copy = conflictCopyPath('Notes/Plan.md', new Date(2026, 6, 16, 3, 12))
    expect(copy).toBe('Notes/Plan (conflict 2026-07-16 0312).md')
    expect(scopeMatches(scope, copy)).toBe(true)
    const inFolder = conflictCopyPath('Projects/Alpha/a.md', new Date(2026, 6, 16, 3, 12))
    expect(scopeMatches(scope, inFolder)).toBe(true)
    // 无扩展名副本
    expect(stripConflictSuffix('assets/logo.png').endsWith('logo.png')).toBe(true)
    expect(scopeMatches(scope, 'assets/logo (conflict 2026-07-16 0312).png')).toBe(true)
  })

  it('NFC 归一(mac 磁盘 NFD 文件名)', () => {
    const nfd = 'Notes/Plan.md'.normalize('NFD')
    expect(scopeMatches(scope, nfd)).toBe(true)
  })

  it('空 scope 全部不命中(缩小 scope 后旧路径干净解绑)', () => {
    const empty = buildScope([])
    expect(scopeMatches(empty, 'Notes/Plan.md')).toBe(false)
  })

  it('exclude:被剔除的子页面(含其冲突副本与子树)不过闸,同侪不受影响', () => {
    const s = buildScope(entries, ['Notes/Plan.fd/私密.md', 'Projects/Alpha/草稿'])
    expect(scopeMatches(s, 'Notes/Plan.fd/私密.md')).toBe(false)
    expect(scopeMatches(s, 'Notes/Plan.fd/私密.fd/更深.md')).toBe(false)
    expect(scopeMatches(s, conflictCopyPath('Notes/Plan.fd/私密.md', new Date(2026, 6, 16, 3, 12)))).toBe(false)
    expect(scopeMatches(s, 'Notes/Plan.fd/公开.md')).toBe(true)
    expect(scopeMatches(s, 'Projects/Alpha/草稿/x.md')).toBe(false)
    expect(scopeMatches(s, 'Projects/Alpha/正式/x.md')).toBe(true)
    // 祖先目录仍放行:folder move/mkdir 事件不能因为里面有排除项就被挡死。
    expect(scopeMatches(s, 'Notes')).toBe(true)
  })
})

describe('rewriteEntriesForMove', () => {
  it('精确条目改名', () => {
    const r = rewriteEntriesForMove(entries, 'Notes/Plan.md', 'Notes/Plan2.md')
    expect(r.changed).toBe(true)
    expect(r.next[0].path).toBe('Notes/Plan2.md')
    expect(r.next[1].path).toBe('Projects/Alpha')
  })

  it('祖先目录改名 → 前缀重写', () => {
    const r = rewriteEntriesForMove(entries, 'Projects', 'Work')
    expect(r.changed).toBe(true)
    expect(r.next[1].path).toBe('Work/Alpha')
    expect(r.next[0].path).toBe('Notes/Plan.md')
  })

  it('无关路径不动', () => {
    const r = rewriteEntriesForMove(entries, 'Other/x.md', 'Other/y.md')
    expect(r.changed).toBe(false)
  })
})

describe('applyRemoteOpToEntries', () => {
  it('delete 精确剪除', () => {
    const r = applyRemoteOpToEntries(entries, 'delete', 'assets/logo.png', null)
    expect(r.changed).toBe(true)
    expect(r.next.some((e) => e.path === 'assets/logo.png')).toBe(false)
  })

  it('delete-folder 前缀剪除', () => {
    const r = applyRemoteOpToEntries(entries, 'delete-folder', 'Projects/Alpha', null)
    expect(r.changed).toBe(true)
    expect(r.next.length).toBe(2)
  })

  it('move/rename-folder 重写', () => {
    const r = applyRemoteOpToEntries(entries, 'rename-folder', 'Projects/Alpha', 'Projects/Beta')
    expect(r.next[1].path).toBe('Projects/Beta')
  })
})

describe('validateCloudName', () => {
  it('合法单段', () => {
    expect(validateCloudName('MyVault', [])).toBeNull()
    expect(validateCloudName('我的库', [])).toBeNull()
  })
  it('非法/多段/保留/占用', () => {
    expect(validateCloudName('a/b', [])).not.toBeNull()
    expect(validateCloudName('..', [])).not.toBeNull()
    expect(validateCloudName('', [])).not.toBeNull()
    expect(validateCloudName('与我共享', [])).not.toBeNull()
    expect(validateCloudName('Taken', ['Taken'])).not.toBeNull()
  })
})
