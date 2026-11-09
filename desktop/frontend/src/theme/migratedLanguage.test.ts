/**
 * 迁移出来的磁盘主题(改过的旧 Soft → soft-custom)接管旧选择:只在真看到标记时动;同时启动的几个窗口都切对;
 * 用户自己换过语言之后不再切。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { adoptMigratedLanguage, markLanguageChosen, MIGRATED_FLAG_PREFIX } from './migratedLanguage'

const g = globalThis as unknown as { localStorage?: unknown }
let ls: Record<string, string>
const has = (ids: string[]) => (id: string) => ids.includes(id)
const FLAG = MIGRATED_FLAG_PREFIX + 'soft-custom'
const migrated = [{ id: 'soft-custom', migratedFrom: 'soft' }, { id: 'other' }]
const both = has(['soft', 'soft-custom', 'other'])

beforeEach(() => {
  ls = {}
  g.localStorage = {
    getItem: (k: string) => (k in ls ? ls[k] : null),
    setItem: (k: string, v: string) => { ls[k] = v },
    removeItem: (k: string) => { delete ls[k] },
    key: (i: number) => Object.keys(ls)[i] ?? null,
    get length() { return Object.keys(ls).length },
  }
})
afterEach(() => { delete g.localStorage })

describe('adoptMigratedLanguage', () => {
  it('正用 soft 的人切到 soft-custom,单独设了 soft 的 Space 一起切,记成 adopted', () => {
    const r = adoptMigratedLanguage(migrated, 'soft', { a: { lang: 'soft', skin: 'sage' }, b: { lang: 'lovable' }, c: {} }, both)
    expect(r.lang).toBe('soft-custom')
    expect(r.spaces).toEqual([{ id: 'a', appearance: { lang: 'soft-custom', skin: 'sage' } }])
    expect(ls[FLAG]).toBe('adopted')
  })

  it('同时启动的第二个窗口拿着旧值 soft 进来:照样切到 soft-custom(不把旧值写回去);Space 交给第一个窗口', () => {
    adoptMigratedLanguage(migrated, 'soft', { a: { lang: 'soft' } }, both)
    const second = adoptMigratedLanguage(migrated, 'soft', { a: { lang: 'soft' } }, both)
    expect(second).toEqual({ lang: 'soft-custom', spaces: [] })
  })

  it('用户自己换过语言之后(done),选回内置 Soft 不再被切走;Space 也不动', () => {
    adoptMigratedLanguage(migrated, 'soft', {}, both)
    markLanguageChosen()
    expect(ls[FLAG]).toBe('done')
    expect(adoptMigratedLanguage(migrated, 'soft', { a: { lang: 'soft' } }, both)).toEqual({ lang: 'soft', spaces: [] })
  })

  it('没在用 soft 的人不动语言', () => {
    const r = adoptMigratedLanguage(migrated, 'genesis-glass', {}, both)
    expect(r.lang).toBe('genesis-glass')
    expect(ls[FLAG]).toBe('adopted')
  })

  it('列表为空(读失败)或迁移后的主题没进注册表 → 不切、也不记', () => {
    expect(adoptMigratedLanguage([], 'soft', {}, has(['soft']))).toEqual({ lang: 'soft', spaces: [] })
    expect(adoptMigratedLanguage(migrated, 'soft', {}, has(['soft']))).toEqual({ lang: 'soft', spaces: [] })
    expect(ls[FLAG]).toBeUndefined()
  })

  it('存不下标记就不切(否则以后每次启动都会把用户的选择改回去)', () => {
    g.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(adoptMigratedLanguage(migrated, 'soft', { a: { lang: 'soft' } }, both)).toEqual({ lang: 'soft', spaces: [] })
  })

  it('markLanguageChosen 只把 adopted 改成 done,不碰别的键', () => {
    ls['forsion_theme_lang'] = 'soft-custom'
    markLanguageChosen()
    expect(ls).toEqual({ forsion_theme_lang: 'soft-custom' })
  })
})
