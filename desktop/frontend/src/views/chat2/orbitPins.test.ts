import { describe, expect, it } from 'vitest'
import { isOrbitPinned, orderOrbitEntries, readOrbitPins, toggleOrbitPin, touchOrbitPin, writeOrbitPins } from './orbitPins'

describe('Orbits 一级 Pin 排序', () => {
  const entries = [
    { key: 'row:agent:latest', at: 300 },
    { key: 'ws:project', at: 200 },
    { key: 'row:team:older', at: 100 },
  ]

  it('Pin 区置顶,区内按最近激活时间;未 Pin 区仍按消息时间', () => {
    const pins = { 'ws:project': 10, 'row:team:older': 20 }
    expect(orderOrbitEntries(entries, pins).map((x) => x.key)).toEqual([
      'row:team:older', 'ws:project', 'row:agent:latest',
    ])
  })

  it('激活已 Pin 条目只更新 Pin 时间;未 Pin 条目保持同一份状态', () => {
    const pins = { 'ws:project': 10, 'row:team:older': 20 }
    const next = touchOrbitPin(pins, 'ws:project', 15)
    expect(next['ws:project']).toBe(21)
    expect(orderOrbitEntries(entries, next)[0].key).toBe('ws:project')
    expect(touchOrbitPin(next, 'row:agent:latest', 99)).toBe(next)
  })

  it('toggle 可 Pin / Unpin,读盘会丢弃损坏值', () => {
    const pinned = toggleOrbitPin({}, 'row:agent:latest', 5)
    expect(isOrbitPinned(pinned, 'row:agent:latest')).toBe(true)
    expect(toggleOrbitPin(pinned, 'row:agent:latest')).toEqual({})

    let saved = ''
    writeOrbitPins(pinned, { setItem: (_key, value) => { saved = value } })
    expect(readOrbitPins({ getItem: () => saved })).toEqual(pinned)
    expect(readOrbitPins({ getItem: () => '{"ok":12,"bad":"x","zero":0}' })).toEqual({ ok: 12 })
  })
})
