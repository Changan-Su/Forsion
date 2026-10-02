// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { readSketchState, saveSketchState, serializeSketchState, sketchStateKey } from './sketchState'

describe('sketch local presentation snapshots', () => {
  beforeEach(() => localStorage.clear())
  it('isolates sessions, calls and regenerated source, including false and zero', () => {
    const key = sketchStateKey('session-a:message', 'call', '<div>old</div>')
    saveSketchState(key, { selected: false, value: 0 })
    expect(readSketchState(key)).toEqual({ selected: false, value: 0 })
    expect(readSketchState(sketchStateKey('session-b:message', 'call', '<div>old</div>'))).toBeNull()
    expect(readSketchState(sketchStateKey('session-a:message', 'other-call', '<div>old</div>'))).toBeNull()
    expect(readSketchState(sketchStateKey('session-a:message', 'call', '<div>new</div>'))).toBeNull()
    saveSketchState(key, null)
    expect(readSketchState(key)).toBeNull()
  })
  it('bounds UTF-8 bytes and rejects cycles without erasing the previous snapshot', () => {
    saveSketchState('one', { value: 42 })
    saveSketchState('one', { text: '图'.repeat(6000) })
    expect(readSketchState('one')).toEqual({ value: 42 })
    const cycle: any = {}; cycle.self = cycle
    expect(serializeSketchState(cycle)).toBeUndefined()
    expect(serializeSketchState(undefined)).toBeUndefined()
  })
  it('bounds total storage and retains most recently saved cards', () => {
    for (let i = 0; i < 60; i++) saveSketchState(`key-${i}`, i)
    expect(readSketchState('key-0')).toBeNull()
    expect(readSketchState('key-59')).toBe(59)
    expect(JSON.parse(localStorage.getItem('forsion_sketch_state_v1')!)).toHaveLength(48)
  })
  it('tolerates corrupt local storage', () => {
    localStorage.setItem('forsion_sketch_state_v1', '{bad')
    expect(readSketchState('a')).toBeNull()
  })
})
