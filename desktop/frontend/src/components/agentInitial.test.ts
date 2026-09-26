import { describe, expect, it } from 'vitest'
import { initialFor, initialOf } from './agentInitial'

describe('agent initials (U-09: neutral avatars, collisions resolved by picking a different character)', () => {
  it('uses the first character when nothing collides', () => {
    expect(initialFor('秦彻', ['秦彻', 'Xyra'])).toBe('秦')
    expect(initialFor('xyra', [])).toBe('X')
    expect(initialOf('')).toBe('?')
    expect(initialFor('   ', ['a'])).toBe('?')
  })
  it('skips the shared prefix when first characters collide', () => {
    const names = ['秦彻', '秦老大', 'Xyra']
    expect(initialFor('秦彻', names)).toBe('彻')
    expect(initialFor('秦老大', names)).toBe('老')
    expect(initialFor('Xyra', names)).toBe('X')
  })
  it('falls back to the first character when the name is the shared prefix itself', () => {
    expect(initialFor('秦', ['秦', '秦彻'])).toBe('秦')
    expect(initialFor('秦彻', ['秦', '秦彻'])).toBe('彻')
  })
  it('skips whitespace after the shared prefix and splits by code point', () => {
    expect(initialFor('Code Bot', ['Code Bot', 'Code Helper'])).toBe('B')
    expect(initialFor('🦊 Fox', ['🦊 Fox', '🦊 Fern'])).toBe('O')
    expect(initialFor('🦊 Fox', [])).toBe('🦊')
  })
  it('never lands on a character a sibling already shows (Codex round 1 B2-3)', () => {
    const names = ['Alice', 'Alice Adams']
    expect(initialFor('Alice', names)).toBe('A')
    expect(initialFor('Alice Adams', names)).toBe('D')
    // 跳过公共前缀后遇到的字恰是另一位兄弟的首字 → 继续往后找
    const trio = ['秦彻', '秦老大', '彻夜']
    expect(new Set(trio.map((n) => initialFor(n, trio))).size).toBe(3)
  })
  it('identical names cannot be told apart and keep the first character', () => {
    expect(initialFor('Research', ['Research', 'Research'])).toBe('R')
  })
})
