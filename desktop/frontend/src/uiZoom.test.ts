import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateUiZoomDefault } from './uiZoom'

describe('migrateUiZoomDefault', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } as Storage

  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('本版本首次启动时清掉历史缩放，回到端默认', () => {
    localStorage.setItem('forsion_ui_zoom', '1.4')
    expect(migrateUiZoomDefault()).toBe(true)
    expect(localStorage.getItem('forsion_ui_zoom')).toBeNull()
  })

  it('迁移只执行一次，之后用户重新设置的比例会保留', () => {
    expect(migrateUiZoomDefault()).toBe(true)
    localStorage.setItem('forsion_ui_zoom', '0.8')
    expect(migrateUiZoomDefault()).toBe(false)
    expect(localStorage.getItem('forsion_ui_zoom')).toBe('0.8')
  })
})
