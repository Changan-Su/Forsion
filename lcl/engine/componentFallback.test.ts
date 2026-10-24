import { describe, it, expect } from 'vitest'
import { withComponentFallback } from './componentFallback'

describe('withComponentFallback', () => {
  const real = { chat: 'Chat', __frame: 'Frame', __extend: 'Extend' }
  const map = withComponentFallback(real, 'Fallback')

  it('注册过的名字(含 __frame / __extend)拿原组件', () => {
    expect(map.chat).toBe('Chat')
    expect(map.__frame).toBe('Frame')
    expect(map.__extend).toBe('Extend')
  })

  it('没注册的名字落到 fallback(dockview-react 读 components[name] 不会拿到 undefined)', () => {
    expect(map['plugin:late:view']).toBe('Fallback')
    expect(map['calendar-config']).toBe('Fallback')
  })

  it('原型上的属性不被兜底吞掉', () => {
    expect(typeof (map as unknown as { toString: unknown }).toString).toBe('function')
  })
})
