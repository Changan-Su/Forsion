/**
 * 工作区 → 聊天「拖进来即引用」的载荷与文本契约。
 * 这三条文本形态是跨层约定:气泡渲染(wikiChat/ChatWikiLink)按它解析,引擎 read_session 按它取 id,
 * 文件路径按它交给 run_bash/read_file。写歪一个字符,链路就断在别处而不是这里,故钉死。
 */
import { describe, it, expect } from 'vitest'
import { REF_MIME, PATHS_MIME, hasChatRef, readChatRefs, refToText, sessionIdOfTarget, type ChatRef } from './chatDragRef'

const dt = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (k: string) => data[k] ?? '',
})

describe('拖拽载荷', () => {
  it('dragover 阶段靠 types 认出引用(读不到数据)', () => {
    expect(hasChatRef(dt({ [REF_MIME]: '[]' }))).toBe(true)
    expect(hasChatRef(dt({ [PATHS_MIME]: '[]' }))).toBe(true)
    expect(hasChatRef(dt({ 'text/plain': 'x' }))).toBe(false)
    expect(hasChatRef(null)).toBe(false)
  })

  it('文件面板既有的纯路径数组当作文件引用(文件侧零改动)', () => {
    expect(readChatRefs(dt({ [PATHS_MIME]: '["/a/b.md","/c d.txt"]' })))
      .toEqual([{ kind: 'file', path: '/a/b.md' }, { kind: 'file', path: '/c d.txt' }])
  })

  it('坏载荷/异形条目不炸,过滤掉', () => {
    expect(readChatRefs(dt({ [REF_MIME]: '{oops' }))).toEqual([])
    expect(readChatRefs(dt({ [REF_MIME]: '[{"kind":"note"},{"kind":"note","path":"a.md"}]' })))
      .toEqual([{ kind: 'note', path: 'a.md' }])
    expect(readChatRefs(null)).toEqual([])
  })
})

describe('refToText', () => {
  const root = '/Users/me/Vault'

  it('笔记 → [[绝对路径|名字]](与 [[ 选择器同契约)', () => {
    expect(refToText({ kind: 'note', path: 'proj/设计.md' }, root)).toBe('[[/Users/me/Vault/proj/设计.md|设计]] ')
  })

  it('文件含空格加引号,否则原样', () => {
    expect(refToText({ kind: 'file', path: '/a/b.ts' }, root)).toBe('/a/b.ts ')
    expect(refToText({ kind: 'file', path: '/a/my notes.txt' }, root)).toBe('"/a/my notes.txt" ')
  })

  it('会话 → [[session:id|标题]]', () => {
    expect(refToText({ kind: 'session', id: 'sess-1', title: '重构计划' }, root)).toBe('[[session:sess-1|重构计划]] ')
  })

  it('⚠️标题里的 ] | 换行会拆坏 [[..]] → 一律换空格', () => {
    const out = refToText({ kind: 'session', id: 's1', title: 'a]] | b\nc' }, root)
    expect(out).toBe('[[session:s1|a b c]] ')
    expect(out.match(/\]\]/g)).toHaveLength(1) // 只剩收尾那一对
  })

  it('空标题不产生空标签', () => {
    expect(refToText({ kind: 'session', id: 's1', title: '' }, root)).toBe('[[session:s1|Chat]] ')
  })

  it('每条自带尾空格(连引多条时不粘在一起)', () => {
    const refs: ChatRef[] = [{ kind: 'file', path: '/a.ts' }, { kind: 'session', id: 's1', title: 'T' }]
    expect(refs.map((r) => refToText(r, root)).join('')).toBe('/a.ts [[session:s1|T]] ')
  })
})

describe('sessionIdOfTarget', () => {
  it('只认 session: 前缀,普通笔记名不误判', () => {
    expect(sessionIdOfTarget('session:abc')).toBe('abc')
    expect(sessionIdOfTarget('  session:abc  ')).toBe('abc')
    expect(sessionIdOfTarget('我的笔记')).toBeNull()
    expect(sessionIdOfTarget('session:')).toBeNull()
  })
})
