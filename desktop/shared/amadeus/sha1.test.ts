import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha1Hex } from './sha1'

const node = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex')

describe('sha1Hex', () => {
  it('matches Node crypto on ASCII, CJK, emoji and block-boundary lengths', () => {
    const samples = [
      '', 'abc', 'sync|color|任务.db', 'sync|hidden|human://CALENDAR.db', 'sync|default|', '日历/工作|日程.db', '😀 emoji',
      'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), '中'.repeat(200),
    ]
    for (const s of samples) expect(sha1Hex(s)).toBe(node(s))
  })
})
