import { describe, expect, it } from 'vitest'
import { initialFor, initialOf, initialsFor } from './agentInitial'

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
  it('assigns the whole group at once so two collision-resolved names never land on the same glyph (Codex round 3 H1-4)', () => {
    // 逐个算时两位都跳过被占的 A、都落到 D
    const names = ['Alice Adams', 'Alice Dixon']
    const glyphs = names.map((n) => initialFor(n, names))
    expect(new Set(glyphs).size).toBe(2)
    expect(initialsFor(names)).toEqual(glyphs)
    // 首字本就不同的,不许被「整组」算法误伤成别的字
    expect(initialsFor(['Xa Bc', 'Ya Bc'])).toEqual(['X', 'Y'])
    // 与传入顺序无关:同一组在不同组件里顺序不同,也得是同一套字
    const a = initialsFor(['Alice', 'Alice Adams', 'Alice Dixon', 'Dan'])
    const b = initialsFor(['Dan', 'Alice Dixon', 'Alice Adams', 'Alice'])
    expect(new Set(a).size).toBe(4)
    expect(b).toEqual([a[3], a[2], a[1], a[0]])
    // siblings 不含自己时按「自己 + siblings」成组
    expect(initialFor('Alice Dixon', ['Alice Adams'])).not.toBe(initialFor('Alice Adams', ['Alice Dixon']))
  })
  it('identical names cannot be told apart and keep the first character', () => {
    expect(initialFor('Research', ['Research', 'Research'])).toBe('R')
  })
})
