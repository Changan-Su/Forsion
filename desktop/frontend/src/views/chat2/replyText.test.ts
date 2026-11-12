import { describe, expect, it } from 'vitest'
import { replyText } from './replyText'

describe('replyText', () => {
  it('copies all visible paragraphs across tools without duplicating the final content', () => {
    expect(replyText({ content: 'Conclusion', status: 'done', segments: [
      { t: 'text', text: 'First paragraph\n\nSecond paragraph' },
      { t: 'tools', ids: ['tool'] }, { t: 'text', text: 'Conclusion' },
    ] })).toBe('First paragraph\n\nSecond paragraph\n\nConclusion')
  })
  it('preserves old messages and strips rendered suggestion cards across segments', () => {
    expect(replyText({ content: 'Old reply', status: 'done' })).toBe('Old reply')
    expect(replyText({ content: 'Last', status: 'done', segments: [
      { t: 'text', text: 'First\n```forsion-suggest\n' },
      { t: 'tools', ids: ['tool'] }, { t: 'text', text: 'Explain this further\n```\nLast' },
    ] })).toBe('First\n\nLast')
  })
})
