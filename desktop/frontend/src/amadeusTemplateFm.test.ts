// G4-09(评审 2026-09-27):插模板时模板 frontmatter 并进目标笔记 —— 已有键不覆盖,tags / aliases 取并集。
// 真浏览器那一半(真 insertTemplate × 真 UnifiedPage 写盘):scripts/template-fm.check.cjs(check:templatefm)。
import { describe, expect, it } from 'vitest'
import { templateFmPatch } from './amadeusTemplateFm'

describe('templateFmPatch(G4-09)', () => {
  it('目标没有 fm:模板的键全部进来', () => {
    expect(templateFmPatch({ tags: ['daily'], type: 'journal' }, {})).toEqual({ tags: ['daily'], type: 'journal' })
  })
  it('已有的键不覆盖;tags / aliases 取并集(目标原序在前,# 与大小写不计)', () => {
    expect(templateFmPatch(
      { tags: ['daily', '#X', 'new'], aliases: 'A2', type: 'journal', status: 'draft' },
      { tags: ['x'], aliases: ['a1'], status: 'done' },
    )).toEqual({ tags: ['x', 'daily', 'new'], aliases: ['a1', 'A2'], type: 'journal' })
  })
  it('没有要改的 → null(不打空补丁、不写盘)', () => {
    expect(templateFmPatch({ tags: ['x'], status: 'draft' }, { tags: ['X'], status: 'done' })).toBeNull()
    expect(templateFmPatch({}, { a: 1 })).toBeNull()
  })
})
