import { describe, expect, it } from 'vitest'
import { parseAppRefInner, pickWindow, windowTitleScore } from './appRefs'

// 笔记落盘时 Markdown 序列化会给下划线、星号这些加反斜杠:在编辑器里打 `[[window://com.x.y_z|my_file_name]]`,
// 文件里存的是 `[[window://com.x.y\\_z|my\\_file\\_name]]`(实测;编辑器读回来会还原)。直接读文件原文的地方(Tangu 读笔记后照抄、
// 用户把原文贴进输入框)拿到的是带反斜杠的那份,不能因此认不出这条引用、或者对不上那扇窗口。
describe('落盘时被转义的引用', () => {
  it('标识里的反斜杠去掉后照样认', () => {
    expect(parseAppRefInner('window://com.x.y\\_z|my\\_file\\_name')).toEqual({ kind: 'window', id: 'com.x.y_z', name: 'my\\_file\\_name' })
    expect(parseAppRefInner('app://com.x.y\\_z|N\\_a')?.id).toBe('com.x.y_z')
    expect(parseAppRefInner('app://com.x/y|N')).toBeNull() // 别的非法字符照旧不认
  })
  it('标题带着转义的反斜杠也对得上真窗口', () => {
    expect(windowTitleScore('my\\_file\\_name \\*草稿\\*', 'my_file_name *草稿*')).toBe(2)
    expect(pickWindow('my\\_file\\_name', [{ title: 'other' }, { title: 'my_file_name' }])?.title).toBe('my_file_name')
  })
  it('标题里真的有反斜杠(Windows 路径)不受影响:名字原样留着,和真窗口照样相同', () => {
    const ref = parseAppRefInner('window://notepad|C:\\_work\\notes.txt - Notepad')!
    expect(ref.name).toBe('C:\\_work\\notes.txt - Notepad')
    expect(windowTitleScore(ref.name, 'C:\\_work\\notes.txt - Notepad')).toBe(2)
  })
})
