import { describe, expect, it } from 'vitest'
import { rankTags } from './TagSuggest'

describe('rankTags', () => {
  it('skips rows that exist only as a parent of nested tags', () => {
    expect(rankTags([{ tag: 'work', count: 0, total: 3 }, { tag: 'work/urgent', count: 3, total: 3 }], 'work').map((t) => t.tag)).toEqual(['work/urgent'])
  })
})
