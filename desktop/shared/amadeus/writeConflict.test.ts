import { describe, expect, it } from 'vitest'
import { conflictCopyPath, conflictCopyVariant, textFingerprint } from './writeConflict'
// 云同步引擎住在 @forsion/extend(0.4 起):读 node_modules 里钉住的那份 dist,钉「编辑器与云同步的冲突副本命名同口径」
// @ts-expect-error 私有包不带类型;这里只用运行时导出
import { conflictCopyPath as syncConflictCopyPath, conflictCopyVariant as syncVariant, stripConflictSuffix } from '@forsion/extend/dist/desktop.mjs'

describe('writeConflict 共享口径', () => {
  it('编辑器与云同步是同一个 conflictCopyPath(entryRegistry 靠这个尾缀归一)', () => {
    const now = new Date(2026, 8, 27, 9, 5)
    const copy = conflictCopyPath('Notes/Plan.md', now)
    expect(syncConflictCopyPath('Notes/Plan.md', now)).toBe(copy) // 两份拷贝逐字同构
    expect(copy).toBe('Notes/Plan (conflict 2026-09-27 0905).md')
    expect(stripConflictSuffix(copy)).toBe('Notes/Plan.md')
  })

  it('同分钟撞名的递增候选与引擎 -2/-3 同口径', () => {
    const first = conflictCopyPath('a.b/Note.md', new Date(2026, 0, 2, 3, 4))
    expect(conflictCopyVariant(first, 1)).toBe(first)
    expect(conflictCopyVariant(first, 2)).toBe('a.b/Note (conflict 2026-01-02 0304)-2.md')
    expect(syncVariant(first, 2)).toBe(conflictCopyVariant(first, 2))
    expect(conflictCopyVariant('a.b/README (conflict 2026-01-02 0304)', 3)).toBe('a.b/README (conflict 2026-01-02 0304)-3')
  })

  it('textFingerprint:确定、区分长度与内容、认 UTF-16(emoji / 中文 / BOM)', () => {
    expect(textFingerprint('abc')).toBe(textFingerprint('abc'))
    expect(textFingerprint('abc')).not.toBe(textFingerprint('abd'))
    expect(textFingerprint('')).not.toBe(textFingerprint('\n'))
    expect(textFingerprint('﻿# 标题')).not.toBe(textFingerprint('# 标题'))
    expect(textFingerprint('😀 中文')).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
  })
})
