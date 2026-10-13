import { describe, expect, it } from 'vitest'
import { peekShouldClose, peekViews } from './spacePeekRules'

const v = (type: string) => ({ type, params: {} })
const known = (t: string): boolean => t !== 'gone'

describe('peekViews', () => {
  it('当前 Space 用收起时暂存的那份', () => {
    expect(peekViews({ active: true, stash: [v('a'), v('b')], defaults: [v('d')], known }).map((x) => x.type)).toEqual(['a', 'b'])
  })
  it('暂存空了(或全是已注销的类型)回落默认', () => {
    expect(peekViews({ active: true, stash: [], defaults: [v('d')], known }).map((x) => x.type)).toEqual(['d'])
    expect(peekViews({ active: true, stash: [v('gone')], defaults: [v('d')], known }).map((x) => x.type)).toEqual(['d'])
  })
  it('别的 Space 只认它的默认左栏,不拿当前 Space 的暂存', () => {
    expect(peekViews({ active: false, stash: [v('a')], defaults: [v('d'), v('gone')], known }).map((x) => x.type)).toEqual(['d'])
  })
  it('没有可放的 View = 空(不弹)', () => {
    expect(peekViews({ active: false, stash: [], defaults: [], known })).toEqual([])
    expect(peekViews({ active: true, stash: [v('gone')], defaults: [v('gone')], known })).toEqual([])
  })
})

describe('peekShouldClose', () => {
  const at = (zone: 'card' | 'trigger' | 'shell' | 'overlay', buttons = 0, typing = false): boolean => peekShouldClose({ zone, buttons, typing })
  it('指针回到应用界面别处才收', () => {
    expect(at('shell')).toBe(true)
    expect(at('card')).toBe(false)
    expect(at('trigger')).toBe(false)
  })
  it('外壳之外的浮层(卡里弹出的菜单 / 弹窗)上不收', () => expect(at('overlay')).toBe(false))
  it('按着键拖出去不收', () => expect(at('shell', 1)).toBe(false))
  it('卡里的输入框拿着焦点不收', () => expect(at('shell', 0, true)).toBe(false))
})
