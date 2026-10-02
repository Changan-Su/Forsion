import { describe, expect, it } from 'vitest'
import { defaultSlashCategory, moveSlash, moveSlashCategory, slashCategory } from './slashNavigation'

describe('slash categories and ordinary command rows', () => {
  it('uses left and right for the three categories, including an empty plugin category', () => {
    expect(moveSlashCategory('basic', 'ArrowRight')).toBe('ai')
    expect(moveSlashCategory('ai', 'ArrowRight')).toBe('plugin')
    expect(moveSlashCategory('plugin', 'ArrowRight')).toBe('basic')
    expect(moveSlashCategory('basic', 'ArrowLeft')).toBe('plugin')
    expect(moveSlashCategory('ai', 'ArrowUp')).toBeNull()
  })
  it('keeps AI commands as independent rows selected by up and down', () => {
    expect(moveSlash(4, 0, 'ArrowDown')).toBe(1)
    expect(moveSlash(4, 2, 'ArrowUp')).toBe(1)
    expect(moveSlash(4, 3, 'ArrowDown')).toBe(3)
    expect(moveSlash(4, 0, 'ArrowUp')).toBe(0)
    expect(moveSlash(4, 0, 'ArrowRight')).toBeNull()
    expect(moveSlash(0, 0, 'ArrowDown')).toBeNull()
  })
  it('opens basic by default and discovers AI or plugin commands through global search', () => {
    expect(slashCategory({})).toBe('basic')
    expect(defaultSlashCategory([{ category: 'ai' }], '')).toBe('basic')
    expect(defaultSlashCategory([{ category: 'ai' }], 'ai')).toBe('ai')
    expect(defaultSlashCategory([{ category: 'plugin' }, {}], 'plugin')).toBe('plugin')
    expect(defaultSlashCategory([], 'missing')).toBe('basic')
  })
})
