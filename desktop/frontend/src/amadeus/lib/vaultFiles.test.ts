import { describe, expect, it } from 'vitest'
import { isFileRef, resolveFileName, resolveVaultPath } from './vaultFiles'

const FILES = ['打卡记录.db', 'a/打卡记录.db', 'a/photo.PNG', 'b/photo.png', 'Diary.fd/清单.db']

describe('vaultFiles 文件命名空间解析', () => {
  it('isFileRef:带非 .md 扩展名才算文件引用', () => {
    expect(isFileRef('打卡记录.db')).toBe(true)
    expect(isFileRef('photo.png')).toBe(true)
    expect(isFileRef('Note')).toBe(false)
    expect(isFileRef('Note.md')).toBe(false)
    expect(isFileRef('v2.0 计划')).toBe(false) // 空格挡住伪扩展名
    expect(isFileRef('v2.0')).toBe(false) // 版本号笔记名:扩展名须含字母
    expect(isFileRef('a.mp3')).toBe(true)
  })

  it('裸名:源同目录优先,再全库字典序首个;大小写不敏感', () => {
    expect(resolveFileName('打卡记录.db', FILES, 'a/Src.md')).toBe('a/打卡记录.db')
    expect(resolveFileName('打卡记录.db', FILES)).toBe('a/打卡记录.db') // sort 后 'a/…' < '打卡记录.db'
    expect(resolveFileName('photo.png', FILES, 'b/Src.md')).toBe('b/photo.png')
    expect(resolveFileName('PHOTO.png', FILES, 'a/Src.md')).toBe('a/photo.PNG')
  })

  it('带路径:精确匹配或 null(不回落 basename)', () => {
    expect(resolveFileName('a/打卡记录.db', FILES)).toBe('a/打卡记录.db')
    expect(resolveFileName('c/打卡记录.db', FILES)).toBeNull()
    expect(resolveFileName('Diary.fd/清单.db', FILES)).toBe('Diary.fd/清单.db')
  })

  it('非文件引用与未命中返回 null', () => {
    expect(resolveFileName('Note', FILES)).toBeNull()
    expect(resolveFileName('不存在.db', FILES)).toBeNull()
  })
})

// resolveVaultPath = 去掉「文件命名空间」闸的解析。内置的复合后缀类型(.mindmap.md / .excalidraw.md)
// 以 .md 结尾,被 isFileRef 一律挡下 → 只能走这条,否则 [[图.mindmap.md]] 永远解析不到(Codex)。
describe('resolveVaultPath(复合 .md 后缀)', () => {
  const FILES = ['Project.fd/脑图.mindmap.md', '别处/脑图.mindmap.md', 'a/打卡记录.db']

  it('resolveFileName 挡下 .md 结尾的名字(这正是要绕开它的原因)', () => {
    expect(resolveFileName('脑图.mindmap.md', FILES)).toBeNull()
  })

  it('裸名命中,且源同目录优先', () => {
    expect(resolveVaultPath('脑图.mindmap.md', FILES, 'Project.md')).toBe('Project.fd/脑图.mindmap.md')
    expect(resolveVaultPath('脑图.mindmap.md', FILES, '别处/x.md')).toBe('别处/脑图.mindmap.md')
  })

  it('带路径要精确匹配;未命中返回 null(调用方据此退回裸名)', () => {
    expect(resolveVaultPath('Project.fd/脑图.mindmap.md', FILES)).toBe('Project.fd/脑图.mindmap.md')
    expect(resolveVaultPath('无此.mindmap.md', FILES)).toBeNull()
  })

  it('普通文件引用行为与 resolveFileName 一致', () => {
    expect(resolveVaultPath('a/打卡记录.db', FILES)).toBe('a/打卡记录.db')
  })
})
