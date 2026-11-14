/**
 * 委托管理员的存储前缀(web/src/scopedStorage.ts):页面里各种写法(getItem / 下标 / Object.keys / key(i) 遍历 / clear)
 * 都只看见、只改动本前缀下的键,别的键原样不动。
 * 跑:cd desktop && npx vitest run frontend/src/unitScopedStorage.test.ts
 */
import { describe, expect, it } from 'vitest'
import { scopedStorage } from '../../../web/src/scopedStorage'

const memory = (): Storage => {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  } as Storage
}

describe('scopedStorage', () => {
  it('读写都落在前缀下;主人的键读不到、写不着、清不掉', () => {
    const raw = memory()
    raw.setItem('tangu2_layout_v4', 'OWNER')
    raw.setItem('forsion_home_slot_space', 'amadeus')
    const s = scopedStorage(raw, 'p:')
    expect(s.getItem('tangu2_layout_v4')).toBeNull()
    expect((s as unknown as Record<string, unknown>).forsion_home_slot_space).toBeUndefined()
    expect('tangu2_layout_v4' in s).toBe(false)
    s.setItem('tangu2_layout_v4', 'ADMIN')
    ;(s as unknown as Record<string, unknown>).theme = 'dark'
    expect(s.getItem('tangu2_layout_v4')).toBe('ADMIN')
    expect(s.getItem('theme')).toBe('dark')
    expect(Object.keys(s).sort()).toEqual(['tangu2_layout_v4', 'theme'])
    expect(s.length).toBe(2)
    expect([s.key(0), s.key(1)].sort()).toEqual(['tangu2_layout_v4', 'theme'])
    s.removeItem('theme')
    delete (s as unknown as Record<string, unknown>).nothing
    s.clear()
    expect(s.length).toBe(0)
    expect(raw.getItem('tangu2_layout_v4')).toBe('OWNER')
    expect(raw.getItem('forsion_home_slot_space')).toBe('amadeus')
    expect(raw.length).toBe(2)
  })
})
