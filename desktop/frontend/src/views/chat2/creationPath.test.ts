import { describe, expect, it } from 'vitest'
import { resolveInside } from './creationPath'

describe('resolveInside:作品卡的 path 只能落在会话工作目录之内', () => {
  it('相对路径拼到工作目录下;. 与多余斜杠规整', () => {
    expect(resolveInside('/Users/me/Notes/Sessions', 'pomodoro', false)).toBe('/Users/me/Notes/Sessions/pomodoro')
    expect(resolveInside('/Users/me/Notes/Sessions/', './games//snake/', false)).toBe('/Users/me/Notes/Sessions/games/snake')
  })

  it('.. 爬出去、别处的绝对路径、空串 → null', () => {
    expect(resolveInside('/Users/me/proj', '../secrets', false)).toBeNull()
    expect(resolveInside('/Users/me/proj', 'a/../../x', false)).toBeNull()
    expect(resolveInside('/Users/me/proj', '/Users/me/.ssh', false)).toBeNull()
    expect(resolveInside('/Users/me/proj', '/Users/me/project-other', false)).toBeNull() // 前缀相同但不是子目录
    expect(resolveInside('/Users/me/proj', '  ', false)).toBeNull()
    expect(resolveInside('', 'x', false)).toBeNull()
  })

  it('就是工作目录本身:只有 allowSelf 才放行(默认工作区传 false)', () => {
    expect(resolveInside('/Users/me/proj', '.', false)).toBeNull()
    expect(resolveInside('/Users/me/proj', '.', true)).toBe('/Users/me/proj')
    expect(resolveInside('/Users/me/proj', '/Users/me/proj/sub', false)).toBe('/Users/me/proj/sub')
  })

  it('Windows:反斜杠规整成正斜杠,盘符路径大小写不敏感', () => {
    expect(resolveInside('C:\\Users\\me\\proj', 'app\\web', false)).toBe('C:/Users/me/proj/app/web')
    expect(resolveInside('C:\\Users\\me\\proj', 'c:/users/ME/proj/x', false)).toBe('c:/users/ME/proj/x')
    expect(resolveInside('C:\\Users\\me\\proj', 'D:\\other', false)).toBeNull()
  })
})
