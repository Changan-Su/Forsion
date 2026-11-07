import { describe, expect, it } from 'vitest'
import { findTokens, leadingCommand, tokenTouching } from './composerTokens'

const CMDS = new Set(['/btw', '/loop'])

describe('composer tokens', () => {
  it('认命令表里的命令,不认手打的、半截的、路径', () => {
    expect(findTokens('/btw 看下', CMDS, [])).toEqual([{ start: 0, end: 4 }])
    expect(findTokens('先 /loop 5', CMDS, [])).toEqual([{ start: 2, end: 7 }])
    expect(findTokens('/foo 看下', CMDS, [])).toEqual([])
    expect(findTokens('/bt', CMDS, [])).toEqual([])
    expect(findTokens('/btwx', CMDS, [])).toEqual([])
    expect(findTokens('a/btw', CMDS, [])).toEqual([])
    expect(findTokens('/btw/x', CMDS, [])).toEqual([])
  })
  it('认选过的提及,长名字优先,和行内引用段重叠的不算', () => {
    expect(findTokens('@Orbit One 看下', CMDS, ['Orbit', 'Orbit One'])).toEqual([{ start: 0, end: 10 }])
    expect(findTokens('@Xyra 和 @Xyra', CMDS, ['Xyra'])).toEqual([{ start: 0, end: 5 }, { start: 8, end: 13 }])
    expect(findTokens('@Xyraa', CMDS, ['Xyra'])).toEqual([])
    expect(findTokens('/btw 看', CMDS, [], [{ start: 0, end: 3 }])).toEqual([])
  })
  it('退格整枚删(连后面的空格),光标在中间是在改字', () => {
    const text = '/btw 看下'
    const marks = findTokens(text, CMDS, [])
    expect(tokenTouching(marks, text, 5, 'back')).toEqual({ start: 0, end: 5 })
    expect(tokenTouching(marks, text, 4, 'back')).toEqual({ start: 0, end: 5 })
    expect(tokenTouching(marks, text, 2, 'back')).toBeUndefined()
    expect(tokenTouching(marks, text, 0, 'fwd')).toEqual({ start: 0, end: 5 })
    expect(tokenTouching(marks, text, 1, 'fwd')).toBeUndefined()
    expect(tokenTouching(findTokens('/btw', CMDS, []), '/btw', 4, 'back')).toEqual({ start: 0, end: 4 })
  })
  it('气泡开头的命令', () => {
    expect(leadingCommand('/btw 看下')).toEqual({ cmd: '/btw', rest: ' 看下' })
    expect(leadingCommand('/周报')).toEqual({ cmd: '/周报', rest: '' })
    expect(leadingCommand('/Users/me/a.md 是什么')).toBeNull()
    expect(leadingCommand('看下 /btw')).toBeNull()
  })
})
