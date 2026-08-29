import { describe, it, expect } from 'vitest'
import { rowDropTarget, parentOf, takesHostPaths } from './treeDrop'
import { PATHS_MIME, REF_MIME } from './chat2/chatDragRef'

describe('rowDropTarget', () => {
  it('普通笔记行 = 进这篇笔记', () => {
    expect(rowDropTarget('工作/周报.md')).toEqual({ page: '工作/周报.md' })
    expect(rowDropTarget('顶层.md')).toEqual({ page: '顶层.md' })
  })
  it('⚠️毁档防线:白板/仪表盘/插件文件类型磁盘上也是 .md,绝不能当笔记收正文', () => {
    expect(rowDropTarget('画/草图.excalidraw.md')).toEqual({ folder: '画' })
    expect(rowDropTarget('面板/首页.dashboard.md')).toEqual({ folder: '面板' })
    expect(rowDropTarget('图/脑图.mindmap.md', { pluginFile: true })).toEqual({ folder: '图' })
  })
  it('附件行归它所在的文件夹(顶层 → 库根)', () => {
    expect(rowDropTarget('素材/图.png')).toEqual({ folder: '素材' })
    expect(rowDropTarget('图.png')).toEqual({ folder: '' })
  })
  it('合并笔记(.fd)保持既有语义:落进它的 .fd', () => {
    expect(rowDropTarget('工作/周报.md', { mergedFd: '工作/周报.fd' })).toEqual({ folder: '工作/周报.fd' })
  })
  it('parentOf 吃两种分隔符', () => {
    expect(parentOf('a\\b\\c.md')).toBe('a/b')
    expect(parentOf('c.md')).toBe('')
  })
})

describe('takesHostPaths', () => {
  const M = { paths: PATHS_MIME, ref: REF_MIME }
  it('文件面板的行拖(只带路径)= 外来复制', () => {
    expect(takesHostPaths([PATHS_MIME], true, M)).toBe(true)
  })
  it('⚠️库里的行同时带 REF_MIME + 路径(为了能拖进文件面板)→ 对笔记树是内部拖拽,不能当外来的', () => {
    expect(takesHostPaths([REF_MIME, PATHS_MIME], true, M)).toBe(false)
  })
  it('云侧库 / 没有 copyHostFiles → 一律不接', () => {
    expect(takesHostPaths([PATHS_MIME], false, M)).toBe(false)
  })
  it('OS 文件(只有 Files)不走这条', () => {
    expect(takesHostPaths(['Files'], true, M)).toBe(false)
  })
})
