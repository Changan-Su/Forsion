import { describe, expect, it } from 'vitest'
import { mainReferenceKey } from './mainReference'

describe('mainReferenceKey', () => {
  it('keeps a visible Amadeus companion when focus is on a fileless plugin pane', () => {
    expect(mainReferenceKey([
      { type: 'plugin:bluebird:folder', active: true, front: true },
      { type: 'amadeus-editor', active: false, front: true, filePath: '青鸟收藏夹/视频总结.md' },
      { type: 'chat-panel', active: false, front: true },
    ])).toBe('note:青鸟收藏夹/视频总结.md')
  })

  it('prefers the focused file when the active pane owns one', () => {
    expect(mainReferenceKey([
      { type: 'amadeus-editor', active: false, front: true, filePath: 'Notes/background.md' },
      { type: 'wsfile', active: true, front: true, filePath: '/project/README.md' },
    ])).toBe('file:/project/README.md')
  })

  it('references the PDF in front, as a vault path, instead of a note in a background tab', () => {
    // 焦点在侧栏对话时主区没有 active;眼前是 PDF,后台标签里还开着一篇笔记。
    expect(mainReferenceKey([
      { type: 'amadeus-editor', active: false, front: false, filePath: 'Notes/background.md' },
      { type: 'amadeus-pdf', active: false, front: true, filePath: 'Papers/attention.pdf' },
    ])).toBe('note:Papers/attention.pdf')
    // 插件接管了 .pdf 时是另一个视图类型,口径相同。
    expect(mainReferenceKey([
      { type: 'amadeus-plugin-file', active: true, front: true, filePath: 'Papers/attention.pdf' },
    ])).toBe('note:Papers/attention.pdf')
  })

  it('keeps an absolute path as a file reference even in an Amadeus view (a PDF outside the vault)', () => {
    expect(mainReferenceKey([
      { type: 'amadeus-pdf', active: true, front: true, filePath: '/Users/u/Downloads/book.pdf' },
    ])).toBe('file:/Users/u/Downloads/book.pdf')
  })

  it('skips a non-vault view whose path is not absolute (the agent cannot open it)', () => {
    expect(mainReferenceKey([
      { type: 'plugin:demo:board', active: true, front: true, filePath: 'boards/main' },
      { type: 'amadeus-editor', active: false, front: true, filePath: 'Notes/a.md' },
    ])).toBe('note:Notes/a.md')
    expect(mainReferenceKey([{ type: 'wsfile', active: true, front: true, filePath: 'C:\\proj\\a.ts' }])).toBe('file:C:\\proj\\a.ts')
  })

  it('returns empty when no visible main pane owns a file', () => {
    expect(mainReferenceKey([
      { type: 'plugin:bluebird:folder', active: true, front: true },
      { type: 'chat-panel', active: false, front: true },
    ])).toBe('')
  })
})
