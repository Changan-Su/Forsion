// 文件类双链的类型图标按名字认种类(2026-10-14 方案 A):笔记一律不带图标,文件按种类各一枚。
import { describe, expect, it } from 'vitest'
import { fileIconKind } from './wikilink'

describe('fileIconKind', () => {
  it('笔记(裸名 / .md / 版本号式的名字)不带图标', () => {
    expect(fileIconKind('Note', 'Note')).toBeNull()
    expect(fileIconKind('dir/Note.md', 'dir/Note.md')).toBeNull()
    expect(fileIconKind('Release v2.0', 'Release v2.0')).toBeNull()
  })
  it('文件按种类', () => {
    expect(fileIconKind('book.pdf#page=3', 'book.pdf')).toBe('pdf')
    expect(fileIconKind('flow.excalidraw', 'flow.excalidraw')).toBe('draw')
    expect(fileIconKind('flow.excalidraw.md', 'flow.excalidraw.md')).toBe('draw')
    expect(fileIconKind('tasks.db|表格', 'tasks.db')).toBe('db')
    expect(fileIconKind('talk.mp4#t=95', 'talk.mp4')).toBe('media')
    expect(fileIconKind('pic.png', 'pic.png')).toBe('image')
    expect(fileIconKind('report.docx', 'report.docx')).toBe('file')
  })
})
