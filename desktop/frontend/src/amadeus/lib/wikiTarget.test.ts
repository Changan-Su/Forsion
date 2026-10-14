import { describe, it, expect } from 'vitest'
import { resolveWikiTarget } from './wikiTarget'

const pages = ['a/Note.md', 'b/Note.md', 'b/Src.md', 'C# 日记.md']
const files = ['docs/paper.pdf', 'data/tasks.db', 'boards/flow.excalidraw.md', 'maps/idea.mindmap.md', 'img/photo.png', 'media/lecture.mp4']
const at = (inner: string, src = 'b/Src.md') => resolveWikiTarget(inner, pages, files, src)

describe('resolveWikiTarget(双链右键菜单的目标;口径同 openWikiLink)', () => {
  it('笔记:就近解析,别名已由调用方剥掉', () => {
    expect(at('Note')).toEqual({ kind: 'note', path: 'b/Note.md' })
    expect(at('Note', 'a/X.md')).toEqual({ kind: 'note', path: 'a/Note.md' })
  })
  it('笔记锚点:拆出 subpath;本页锚点指来源页;文件名里带 # 的整串命中时不拆', () => {
    expect(at('Note#Sec')).toEqual({ kind: 'note', path: 'b/Note.md', subpath: 'Sec' })
    expect(at('Note#^blk1')).toEqual({ kind: 'note', path: 'b/Note.md', subpath: '^blk1' })
    expect(at('#Sec')).toEqual({ kind: 'note', path: 'b/Src.md', subpath: 'Sec' })
    expect(at('C# 日记')).toEqual({ kind: 'note', path: 'C# 日记.md' })
  })
  it('文件:PDF(带不带页码)、多维表、白板(省 .md)、插件复合后缀、图片、带时刻的媒体', () => {
    expect(at('paper.pdf')).toEqual({ kind: 'file', path: 'docs/paper.pdf' })
    expect(at('paper.pdf#page=3')).toEqual({ kind: 'file', path: 'docs/paper.pdf' })
    expect(at('tasks.db')).toEqual({ kind: 'file', path: 'data/tasks.db' })
    expect(at('flow.excalidraw')).toEqual({ kind: 'file', path: 'boards/flow.excalidraw.md' })
    expect(at('idea.mindmap')).toEqual({ kind: 'file', path: 'maps/idea.mindmap.md' })
    expect(at('photo.png')).toEqual({ kind: 'file', path: 'img/photo.png' })
    expect(at('lecture.mp4#t=95')).toEqual({ kind: 'file', path: 'media/lecture.mp4' })
  })
  it('库里没有 → missing(带着询问创建用的名字);外链 → external', () => {
    expect(at('Nope')).toEqual({ kind: 'missing', name: 'Nope' })
    expect(at('Nope#Sec')).toEqual({ kind: 'missing', name: 'Nope' })
    expect(at('gone.pdf#page=2')).toEqual({ kind: 'missing', name: 'gone.pdf' })
    expect(at('https://example.com/a.pdf')).toEqual({ kind: 'external' })
  })
})
