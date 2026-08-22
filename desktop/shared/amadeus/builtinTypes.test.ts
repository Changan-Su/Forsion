import { describe, it, expect } from 'vitest'
import { isBuiltinFileType, isPlainNoteRef } from './builtinTypes'

describe('isBuiltinFileType', () => {
  it('认领内置类型的确切后缀', () => {
    for (const p of ['a/b/画板.excalidraw.md', '[[图.excalidraw]]'.slice(2, -2), '库.db', '论文.pdf', '照片.PNG']) {
      expect(isBuiltinFileType(p), p).toBe(true)
    }
  })

  it('裸 .md 不算 —— 插件的 `.<子类型>.md` 复合后缀该赢过笔记编辑器', () => {
    expect(isBuiltinFileType('日记.md')).toBe(false)
    expect(isBuiltinFileType('看板.kanban.md')).toBe(false)
  })

  it('搬去外置捆绑包的类型必须离开这张表,否则宿主会拒掉它自己的插件', () => {
    // `.mindmap.md` 2026-07-26 从内置迁成外置 bundle(能力靠 ctx.app 块表面 seam)。
    // 忘了从表里删 → registerFileType 返回 false → 插件整体退让 → 导图彻底打不开。
    expect(isBuiltinFileType('图.mindmap.md')).toBe(false)
    expect(isBuiltinFileType('.mindmap.md')).toBe(false)
  })

  it('扩展名声明本身也能判(registerFileType 的入参就是这种形态)', () => {
    expect(isBuiltinFileType('.excalidraw.md')).toBe(true)
    expect(isBuiltinFileType('.kanban.md')).toBe(false)
  })

  it('只看后缀,不被路径中段的同名片段骗到', () => {
    expect(isBuiltinFileType('excalidraw.md 的备份.txt')).toBe(false)
    expect(isBuiltinFileType('.db 目录/说明.md')).toBe(false)
  })
})

describe('isPlainNoteRef', () => {
  it('裸 .md 与「名字里带点」的笔记都是笔记', () => {
    expect(isPlainNoteRef('某笔记.md')).toBe(true)
    expect(isPlainNoteRef('子夹/另一篇.md')).toBe(true)
    expect(isPlainNoteRef('X.fd.md')).toBe(true) // 子笔记夹里的笔记,仓内到处都是
    expect(isPlainNoteRef('ADR.001.md')).toBe(true) // 带版本号的名字 ≠ 文件类型(Codex 评审)
    expect(isPlainNoteRef('某笔记.md|别名')).toBe(true)
    expect(isPlainNoteRef('某笔记.md#块')).toBe(true)
  })

  it('内置文件类型不是笔记', () => {
    expect(isPlainNoteRef('图.excalidraw.md')).toBe(false)
    expect(isPlainNoteRef('图.excalidraw')).toBe(false)
  })

  it('非 .md 一律不是笔记', () => {
    expect(isPlainNoteRef('report.pdf')).toBe(false)
    expect(isPlainNoteRef('tasks.db')).toBe(false)
  })
})
