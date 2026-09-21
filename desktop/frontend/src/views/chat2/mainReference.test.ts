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

  it('returns empty when no visible main pane owns a file', () => {
    expect(mainReferenceKey([
      { type: 'plugin:bluebird:folder', active: true, front: true },
      { type: 'chat-panel', active: false, front: true },
    ])).toBe('')
  })
})
